const https = require('https');
const model = require('../models/bus142-poststadion-model.json');

const API_HOSTS = (process.env.API_HOSTS || 'v6.bvg.transport.rest,v6.vbb.transport.rest')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 10000);
const POSTSTADION_STOP_ID = '900002256';
const LINE_NAME = '142';

const toJson = (res, statusCode, data) => {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
};

const requestJsonFromHost = (host, path) => new Promise((resolve, reject) => {
    const req = https.request({
        hostname: host,
        port: 443,
        path,
        method: 'GET',
        timeout: API_TIMEOUT_MS,
        headers: {
            accept: 'application/json',
            host,
            'user-agent': 'BerlinStationMonitor/1.0 (+https://github.com/iwaszm/BerlinStationMonitor)',
        },
    }, proxyRes => {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if ((proxyRes.statusCode || 500) < 200 || (proxyRes.statusCode || 500) >= 300) {
                reject(new Error(`${host} returned ${proxyRes.statusCode}: ${body.slice(0, 160)}`));
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(e);
            }
        });
    });
    req.on('timeout', () => req.destroy(new Error(`${host} API timeout`)));
    req.on('error', reject);
    req.end();
});

const requestJson = async (path) => {
    let lastError;
    for (const host of API_HOSTS) {
        try {
            return await requestJsonFromHost(host, path);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('No upstream API hosts configured');
};

const delayMinutes = (seconds) => {
    if (typeof seconds !== 'number') return null;
    return Math.round(seconds / 60);
};

const pickStopDelay = (stopover) => {
    if (!stopover) return null;
    if (typeof stopover.arrivalDelay === 'number') return delayMinutes(stopover.arrivalDelay);
    if (typeof stopover.departureDelay === 'number') return delayMinutes(stopover.departureDelay);
    return null;
};

const plannedDate = (departure) => {
    const value = departure.plannedWhen || departure.when;
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const delayBucket = (value) => {
    if (typeof value !== 'number') return 'missing';
    if (value <= -2) return 'early_2plus';
    if (value <= 0) return 'ontime_or_early';
    if (value <= 2) return 'late_1_2';
    if (value <= 5) return 'late_3_5';
    if (value <= 9) return 'late_6_9';
    return 'late_10plus';
};

const lookupMean = (table, key) => {
    const entry = model.lookups[table] && model.lookups[table][key];
    if (!entry || entry.count < model.minCount) return null;
    return entry;
};

const directionMatches = (departureDirection, modelDirection) => {
    if (!departureDirection || !modelDirection) return false;
    return String(departureDirection).toLowerCase().includes(String(modelDirection).split(' via ')[0].toLowerCase());
};

const normalizeDirection = (departure, stopovers) => {
    const depDirection = departure.direction || '';
    if (model.directions[depDirection]) return depDirection;

    const modelDirections = Object.keys(model.directions);
    const direct = modelDirections.find(direction => directionMatches(depDirection, direction));
    if (direct) return direct;

    const lastStopName = stopovers.length ? ((stopovers[stopovers.length - 1].stop || {}).name || '') : '';
    return modelDirections.find(direction => directionMatches(lastStopName, direction)) || depDirection;
};

const poststadionIndex = (stopovers) => stopovers.findIndex(item => {
    const stop = item && item.stop;
    return stop && String(stop.id) === POSTSTADION_STOP_ID;
});

const upstreamDelays = (stopovers, index) => {
    const values = [];
    for (let offset = 1; offset <= 3; offset += 1) {
        values.push(index - offset >= 0 ? pickStopDelay(stopovers[index - offset]) : null);
    }
    return values;
};

const confidenceFor = (basis, count, hasPrevDelay) => {
    if (hasPrevDelay && basis.indexOf('prevDirectionDowHourBucket') === 0) return 'high';
    if (hasPrevDelay && basis.indexOf('prevDirection') === 0) return 'medium';
    if (basis === 'directionDowHour' || basis === 'directionHour') return 'medium';
    if (count >= 50) return 'medium';
    return 'low';
};

const predictDelay = ({ direction, dow, hour, prevDelay }) => {
    const bucket = delayBucket(prevDelay);
    const lookups = [];
    if (bucket !== 'missing') {
        lookups.push(['prevDirectionDowHourBucket', `${direction}|${dow}|${hour}|${bucket}`]);
        lookups.push(['prevDirectionHourBucket', `${direction}|${hour}|${bucket}`]);
        lookups.push(['prevDirectionBucket', `${direction}|${bucket}`]);
    }
    lookups.push(['directionDowHour', `${direction}|${dow}|${hour}`]);
    lookups.push(['directionHour', `${direction}|${hour}`]);
    lookups.push(['direction', direction]);

    for (const [basis, key] of lookups) {
        const entry = lookupMean(basis, key);
        if (entry) {
            return {
                predictedDelayMin: Math.round(entry.mean),
                rawPredictedDelayMin: entry.mean,
                basis,
                count: entry.count,
                confidence: confidenceFor(basis, entry.count, bucket !== 'missing'),
            };
        }
    }

    return {
        predictedDelayMin: Math.round(model.globalMean),
        rawPredictedDelayMin: model.globalMean,
        basis: 'globalMean',
        count: model.trainingRows,
        confidence: 'low',
    };
};

const buildPrediction = async (departure) => {
    let stopovers = [];
    let tripFetchError = null;
    try {
        const tripPath = `/trips/${encodeURIComponent(departure.tripId)}?stopovers=true&remarks=false&language=de`;
        const detail = await requestJson(tripPath);
        const trip = detail.trip || detail;
        stopovers = Array.isArray(trip.stopovers) ? trip.stopovers : [];
    } catch (e) {
        tripFetchError = e.message;
    }

    const index = poststadionIndex(stopovers);
    const prev = index >= 0 ? upstreamDelays(stopovers, index) : [null, null, null];
    const prevDelay = prev.find(value => typeof value === 'number');
    const direction = normalizeDirection(departure, stopovers);
    const planned = plannedDate(departure) || new Date();
    const features = {
        direction,
        dow: planned.getDay() === 0 ? 6 : planned.getDay() - 1,
        hour: planned.getHours(),
        prevDelay,
    };
    const prediction = predictDelay(features);
    const key = `${departure.tripId}_${POSTSTADION_STOP_ID}`;

    return [key, {
        tripId: departure.tripId,
        stationId: POSTSTADION_STOP_ID,
        predictedDelayMin: prediction.predictedDelayMin,
        rawPredictedDelayMin: prediction.rawPredictedDelayMin,
        basis: prediction.basis,
        confidence: prediction.confidence,
        modelVersion: model.modelVersion,
        featuresUsed: {
            direction,
            dayOfWeek: features.dow,
            hour: features.hour,
            prev1DelayMin: prev[0],
            prev2DelayMin: prev[1],
            prev3DelayMin: prev[2],
            selectedPrevDelayMin: prevDelay,
            stopoverMatched: index >= 0,
            sampleCount: prediction.count,
        },
        tripFetchError,
    }];
};

const handle142PoststadionPrediction = async (req, res, parsedUrl) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        toJson(res, 405, { error: 'Method not allowed' });
        return;
    }

    const duration = Math.max(1, Math.min(180, Number(parsedUrl.searchParams.get('duration') || 60) || 60));
    const departuresPath = `/stops/${POSTSTADION_STOP_ID}/departures?duration=${duration}&results=50&bus=true&suburban=false&subway=false&tram=false&ferry=false&express=false&regional=false&language=de`;

    try {
        const data = await requestJson(departuresPath);
        const departures = (data.departures || []).filter(item => item && item.line && item.line.name === LINE_NAME && item.tripId);
        const pairs = await Promise.all(departures.map(buildPrediction));
        const predictions = {};
        pairs.forEach(([key, value]) => {
            predictions[key] = value;
        });
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
        toJson(res, 200, {
            stationId: POSTSTADION_STOP_ID,
            lineName: LINE_NAME,
            modelVersion: model.modelVersion,
            generatedAt: new Date().toISOString(),
            predictions,
        });
    } catch (e) {
        toJson(res, 502, { error: 'Prediction upstream error', detail: e.message });
    }
};

module.exports = {
    handle142PoststadionPrediction,
};
