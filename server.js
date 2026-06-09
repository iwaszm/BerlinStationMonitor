const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;
const API_HOSTS = (process.env.API_HOSTS || 'v6.bvg.transport.rest,v6.vbb.transport.rest')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean);
const PUBLIC_ROOT = __dirname;
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

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
};

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
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

const proxyApi = (req, res, parsedUrl) => {
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

const server = http.createServer((req, res) => {
    console.log(`[Request] ${req.method} ${req.url}`);

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (parsedUrl.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // API Proxy: Forward requests starting with /api/ to BVG
    // Example: /api/locations?query=... -> https://v6.bvg.transport.rest/locations?query=...
    if (parsedUrl.pathname.startsWith('/api/')) {
        proxyApi(req, res, parsedUrl);
        return;
    }

    // Static File Serving
    const rawPath = req.url.split('?')[0].split('#')[0];
    let pathname;
    try {
        pathname = decodeURIComponent(rawPath);
    } catch (e) {
        res.writeHead(400);
        res.end('Bad request');
        return;
    }

    if (pathname === '/') {
        pathname = '/index.html';
    } else if (pathname === '/kindle' || pathname === '/kindle/') {
        pathname = '/kindle.html';
    }

    const filePath = path.resolve(PUBLIC_ROOT, `.${pathname}`);
    if (!filePath.startsWith(PUBLIC_ROOT + path.sep) && filePath !== PUBLIC_ROOT) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`- Index: http://localhost:${PORT}/index.html`);
    console.log(`- API upstreams: ${API_HOSTS.join(', ')}`);
    console.log(`- API Proxy: http://localhost:${PORT}/api/...`);
});
