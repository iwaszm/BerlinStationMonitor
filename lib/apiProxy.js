const https = require('https');
const { handlePoststadionPrediction } = require('./poststadionPrediction');

const API_HOSTS = (process.env.API_HOSTS || 'v6.bvg.transport.rest,v6.vbb.transport.rest')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean);
const VRRF_HOST = process.env.VRRF_HOST || 'vrrf.finalrewind.org';
const VRRF_BACKEND = process.env.VRRF_BACKEND || 'hafas.VBB';
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 10000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const DEFAULT_CACHE_TTL_MS = Number(process.env.DEFAULT_CACHE_TTL_MS || 30000);
const STALE_CACHE_TTL_MS = Number(process.env.STALE_CACHE_TTL_MS || 7200000);
const MAX_CACHE_ENTRIES = Number(process.env.MAX_CACHE_ENTRIES || 1000);
const MAX_CACHE_BODY_BYTES = Number(process.env.MAX_CACHE_BODY_BYTES || 1048576);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const apiCache = new Map();
const rateLimits = new Map();

const cacheRules = [
    { pattern: /^\/locations\/nearby\b/, freshTtl: 60000, staleTtl: 604800000 },
    { pattern: /^\/locations\b/, freshTtl: 300000, staleTtl: 604800000 },
    { pattern: /^\/stops\/[^/]+\/departures\b/, freshTtl: 20000, staleTtl: 21600000 },
    { pattern: /^\/radar\b/, freshTtl: 20000, staleTtl: 7200000 },
    { pattern: /^\/trips\//, freshTtl: 60000, staleTtl: 43200000 },
];

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
};

const getCacheRule = (pathname) => {
    return cacheRules.find(item => item.pattern.test(pathname)) || {
        freshTtl: DEFAULT_CACHE_TTL_MS,
        staleTtl: STALE_CACHE_TTL_MS,
    };
};

const isStaleCacheUsable = (entry, staleTtl) => {
    return entry && Date.now() - entry.fetchedAt <= staleTtl;
};

const setApiHeaders = (req, res, extra = {}) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'false');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    Object.entries(extra).forEach(([key, value]) => {
        if (value !== undefined && value !== null) res.setHeader(key, value);
    });
};

const checkRateLimit = (req) => {
    const now = Date.now();
    const ip = getClientIp(req);
    const current = rateLimits.get(ip);
    if (!current || now > current.resetAt) {
        rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return { limited: false };
    }
    current.count += 1;
    if (current.count > RATE_LIMIT_MAX) {
        return { limited: true, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
    }
    return { limited: false };
};

const pruneMaps = () => {
    const now = Date.now();
    for (const [key, entry] of apiCache.entries()) {
        if (now - entry.fetchedAt > (entry.staleTtl || STALE_CACHE_TTL_MS)) apiCache.delete(key);
    }
    while (apiCache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = apiCache.keys().next().value;
        if (!oldestKey) break;
        apiCache.delete(oldestKey);
    }
    for (const [key, entry] of rateLimits.entries()) {
        if (now > entry.resetAt) rateLimits.delete(key);
    }
};

const sendCachedResponse = (req, res, entry, state) => {
    setApiHeaders(req, res, {
        'Content-Type': entry.contentType || 'application/json',
        'Cache-Control': 'no-store',
        'X-Proxy-Cache': state,
        'X-Proxy-Fetched-At': new Date(entry.fetchedAt).toISOString(),
    });
    res.writeHead(entry.statusCode);
    if (req.method === 'HEAD') {
        res.end();
    } else {
        res.end(entry.body);
    }
};

const productFromVrrf = (item) => {
    const value = String((item.product && (item.product.type || item.product.type_long)) || item.type || '').trim().toLowerCase();
    if (value.includes('bus')) return 'bus';
    if (value.includes('tram')) return 'tram';
    if (value.includes('u-bahn') || value === 'u') return 'subway';
    if (value.includes('s-bahn') || value === 's') return 'suburban';
    if (value.includes('regional') || value === 're' || value === 'rb') return 'regional';
    return 'bus';
};

const isoFromUnixSeconds = (value) => {
    if (typeof value !== 'number') return null;
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const mapVrrfDeparture = (item) => {
    const lineName = String(item.line_no || item.line || item.name || '').trim();
    const plannedWhen = isoFromUnixSeconds(item.sched_datetime || item.datetime);
    const when = isoFromUnixSeconds(item.rt_datetime || item.datetime || item.sched_datetime) || plannedWhen;
    const product = productFromVrrf(item);

    return {
        tripId: item.id,
        direction: item.direction || item.destination || item.route_end || '',
        when,
        plannedWhen,
        delay: typeof item.delay === 'number' ? item.delay * 60 : null,
        platform: item.rt_platform || item.platform || null,
        plannedPlatform: item.sched_platform || null,
        cancelled: Boolean(item.is_cancelled || item.is_partially_cancelled),
        line: {
            type: 'line',
            id: (item.product && item.product.line_id) || lineName,
            name: lineName,
            product,
            operator: item.operator || (item.product && item.product.operator) || null,
        },
        stop: {
            type: 'stop',
            id: String(item.station_eva || ''),
            name: item.station || '',
        },
        remarks: Array.isArray(item.messages) ? item.messages : [],
    };
};

const buildVrrfResponse = (stopId, parsedUrl, data) => {
    if (!data || data.error || !Array.isArray(data.raw)) {
        throw new Error(data && data.error ? data.error : 'Invalid finalrewind response');
    }

    const durationParam = parsedUrl.searchParams.get('duration');
    const resultsParam = parsedUrl.searchParams.get('results');
    const duration = Math.max(1, Number(durationParam || 30));
    const results = resultsParam ? Math.max(1, Number(resultsParam)) : null;
    const now = Date.now();
    const until = now + duration * 60000;
    let departures = data.raw
        .map(mapVrrfDeparture)
        .filter(item => item.tripId && item.when && item.line && item.line.name)
        .filter(item => {
            const time = new Date(item.when || item.plannedWhen).getTime();
            return Number.isFinite(time) && time >= now - 30000 && time <= until;
        })
        .sort((a, b) => new Date(a.when || a.plannedWhen) - new Date(b.when || b.plannedWhen));

    if (results) departures = departures.slice(0, results);

    return {
        departures,
        realtimeDataUpdatedAt: Math.floor(Date.now() / 1000),
        source: {
            name: 'vrr-infoscreen',
            backend: VRRF_BACKEND,
            stopId: String(stopId),
            version: data.version || null,
        },
    };
};

const requestVrrfDepartures = (stopId, parsedUrl, callback) => {
    const noLines = Math.min(10, Math.max(1, Number(parsedUrl.searchParams.get('results') || 10)));
    const path = `/${encodeURIComponent(stopId)}.json?backend=${encodeURIComponent(VRRF_BACKEND)}&no_lines=${noLines}`;
    const options = {
        hostname: VRRF_HOST,
        port: 443,
        path,
        method: 'GET',
        timeout: API_TIMEOUT_MS,
        headers: {
            accept: 'application/json',
            host: VRRF_HOST,
            'user-agent': 'BerlinStationMonitor/1.0 (+https://github.com/zhangmeng43/bsm)',
        },
    };

    const vrrfReq = https.request(options, (vrrfRes) => {
        const chunks = [];
        vrrfRes.on('data', chunk => chunks.push(chunk));
        vrrfRes.on('end', () => {
            try {
                const body = Buffer.concat(chunks);
                const statusCode = vrrfRes.statusCode || 502;
                if (statusCode < 200 || statusCode >= 300) {
                    callback(new Error(`${VRRF_HOST} returned ${statusCode}`));
                    return;
                }
                const json = JSON.parse(body.toString('utf8'));
                callback(null, buildVrrfResponse(stopId, parsedUrl, json));
            } catch (e) {
                callback(e);
            }
        });
    });

    vrrfReq.on('timeout', () => {
        vrrfReq.destroy(new Error(`${VRRF_HOST} API timeout`));
    });
    vrrfReq.on('error', callback);
    vrrfReq.end();
};

const getDeparturesStopId = (proxyPathname) => {
    const match = proxyPathname.match(/^\/stops\/([^/]+)\/departures\b/);
    return match ? decodeURIComponent(match[1]) : null;
};

const handleHealthz = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
};

const handleApiProxy = (req, res, parsedUrl) => {
    if (req.method === 'OPTIONS') {
        setApiHeaders(req, res);
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        setApiHeaders(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const limited = checkRateLimit(req);
    if (limited.limited) {
        setApiHeaders(req, res, { 'Retry-After': String(limited.retryAfter) });
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
    }

    pruneMaps();

    const proxyPathname = parsedUrl.pathname.replace(/^\/api/, '') || '/';
    if (proxyPathname === '/predictions/poststadion' || proxyPathname === '/predictions/142-poststadion') {
        handlePoststadionPrediction(req, res, parsedUrl);
        return;
    }

    const proxyPath = proxyPathname + parsedUrl.search;
    const cacheKey = `${req.method}:${proxyPath}`;
    const cached = apiCache.get(cacheKey);
    const now = Date.now();
    const cacheRule = getCacheRule(proxyPathname);

    if (cached && now - cached.fetchedAt <= cacheRule.freshTtl) {
        sendCachedResponse(req, res, cached, 'HIT');
        return;
    }

    const sendProxyError = (message) => {
        console.error(`[Proxy Error] ${message}`);
        if (isStaleCacheUsable(cached, cacheRule.staleTtl)) {
            sendCachedResponse(req, res, cached, 'STALE');
            return;
        }

        const fallbackStopId = getDeparturesStopId(proxyPathname);
        if (fallbackStopId) {
            requestVrrfDepartures(fallbackStopId, parsedUrl, (fallbackError, fallbackData) => {
                if (fallbackError) {
                    console.error(`[Proxy Error] ${VRRF_HOST}: ${fallbackError.message}`);
                    setApiHeaders(req, res);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Proxy error' }));
                    return;
                }

                const body = Buffer.from(JSON.stringify(fallbackData));
                if (body.length <= MAX_CACHE_BODY_BYTES) {
                    apiCache.set(cacheKey, {
                        statusCode: 200,
                        contentType: 'application/json; charset=utf-8',
                        body,
                        fetchedAt: Date.now(),
                        staleTtl: cacheRule.staleTtl,
                    });
                }

                setApiHeaders(req, res, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Proxy-Cache': 'MISS',
                    'X-Proxy-Upstream': VRRF_HOST,
                    'X-Proxy-Fallback': 'finalrewind',
                    'X-Proxy-Fetched-At': new Date().toISOString(),
                });
                res.writeHead(200);
                if (req.method === 'HEAD') {
                    res.end();
                } else {
                    res.end(body);
                }
            });
            return;
        }

        setApiHeaders(req, res);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error' }));
    };

    const requestHost = (hostIndex) => {
        const upstreamHost = API_HOSTS[hostIndex];
        if (!upstreamHost) {
            sendProxyError('All upstream API hosts failed');
            return;
        }

        const options = {
            hostname: upstreamHost,
            port: 443,
            path: proxyPath,
            method: 'GET',
            timeout: API_TIMEOUT_MS,
            headers: {
                accept: 'application/json',
                host: upstreamHost,
                'user-agent': 'BerlinStationMonitor/1.0 (+https://github.com/iwaszm/BerlinStationMonitor)',
            },
        };

        const proxyReq = https.request(options, (proxyRes) => {
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                const body = Buffer.concat(chunks);
                const statusCode = proxyRes.statusCode || 502;
                const contentType = proxyRes.headers['content-type'] || 'application/json';

                if (statusCode >= 200 && statusCode < 300 && body.length <= MAX_CACHE_BODY_BYTES) {
                    apiCache.set(cacheKey, {
                        statusCode,
                        contentType,
                        body,
                        fetchedAt: Date.now(),
                        staleTtl: cacheRule.staleTtl,
                    });
                } else if (statusCode >= 500 && hostIndex < API_HOSTS.length - 1) {
                    console.warn(`[Proxy Warning] ${upstreamHost} returned ${statusCode}; trying fallback`);
                    requestHost(hostIndex + 1);
                    return;
                } else if (statusCode >= 500 && isStaleCacheUsable(cached, cacheRule.staleTtl)) {
                    sendCachedResponse(req, res, cached, 'STALE');
                    return;
                } else if (statusCode >= 500) {
                    sendProxyError(`${upstreamHost} returned ${statusCode}`);
                    return;
                }

                setApiHeaders(req, res, {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-store',
                    'X-Proxy-Cache': statusCode >= 200 && statusCode < 300 ? 'MISS' : 'BYPASS',
                    'X-Proxy-Upstream': upstreamHost,
                });
                res.writeHead(statusCode);
                if (req.method === 'HEAD') {
                    res.end();
                } else {
                    res.end(body);
                }
            });
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy(new Error(`${upstreamHost} API timeout`));
        });

        proxyReq.on('error', (e) => {
            console.error(`[Proxy Error] ${upstreamHost}: ${e.message}`);
            if (hostIndex < API_HOSTS.length - 1) {
                requestHost(hostIndex + 1);
                return;
            }
            sendProxyError(e.message);
        });

        proxyReq.end();
    };

    requestHost(0);
};

module.exports = {
    handleApiProxy,
    handleHealthz,
};
