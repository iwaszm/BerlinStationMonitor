import { classifyDirection, LINE_DIRECTIONS, normalizeRouteName } from './lineDirections.mjs';

const DEFAULT_SOURCE_URL = 'https://bsm.zhang-meng.com/api/vrrf/poststadion';
const DEFAULT_LINES = ['123', '142'];
const DEFAULT_RETENTION_DAYS = 28;
const DEFAULT_PAST_WINDOW_SECONDS = 60;
const DEFAULT_FUTURE_WINDOW_SECONDS = 120;
const DEFAULT_MAX_SOURCE_AGE_SECONDS = 150;
const PROFILE_MIN_SAMPLE_COUNT = 4;
const PROFILE_BIN_MINUTES = 15;
const PROFILE_TIME_WINDOW_MINUTES = 15;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getLineFilter(value) {
  if (value === '*') {
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return DEFAULT_LINES;
  }

  return value.split(',').map((line) => line.trim()).filter(Boolean);
}

function getConfig(env) {
  return {
    sourceUrl: env.SOURCE_URL || DEFAULT_SOURCE_URL,
    lineFilter: (() => {
      const lines = getLineFilter(env.LINE_FILTER);
      return lines ? new Set(lines) : null;
    })(),
    retentionDays: positiveInteger(env.RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    pastWindowSeconds: positiveInteger(env.PAST_WINDOW_SECONDS, DEFAULT_PAST_WINDOW_SECONDS),
    futureWindowSeconds: positiveInteger(env.FUTURE_WINDOW_SECONDS, DEFAULT_FUTURE_WINDOW_SECONDS),
    maxSourceAgeSeconds: positiveInteger(env.MAX_SOURCE_AGE_SECONDS, DEFAULT_MAX_SOURCE_AGE_SECONDS),
  };
}

function asEpochSeconds(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isCancelled(value) {
  return value === true || value === 1 || value === '1';
}

function delayMinutes(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

const BERLIN_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

const WEEKDAY_NUMBERS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function berlinScheduleDimensions(epochSeconds) {
  const parts = Object.fromEntries(BERLIN_TIME_FORMATTER.formatToParts(new Date(epochSeconds * 1000))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const scheduledMinute = Number(parts.hour) * 60 + Number(parts.minute);
  return {
    serviceDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAY_NUMBERS[parts.weekday],
    scheduledMinute,
    timeBin15m: Math.floor(scheduledMinute / 15) * 15,
  };
}

export function berlinServiceDate(epochSeconds) {
  return berlinScheduleDimensions(epochSeconds).serviceDate;
}

function isoDaysBefore(serviceDate, days) {
  const [year, month, day] = serviceDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}

function weekdayForServiceDate(serviceDate) {
  const [year, month, day] = serviceDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function clockDistanceMinutes(first, second) {
  const directDistance = Math.abs(first - second);
  return Math.min(directDistance, 1_440 - directDistance);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundToOne(value) {
  return Math.round(value * 10) / 10;
}

export function buildDailyHistoryProfiles(profileDate, historicalRows) {
  const profileWeekday = weekdayForServiceDate(profileDate);
  const rowsByDirection = new Map();
  for (const row of historicalRows) {
    if (!row?.direction_key || !Number.isFinite(Number(row.delay_seconds))) continue;
    const rows = rowsByDirection.get(row.direction_key) || [];
    rows.push({
      weekday: Number(row.weekday),
      timeBin15m: Number(row.time_bin_15m),
      delaySeconds: Number(row.delay_seconds),
    });
    rowsByDirection.set(row.direction_key, rows);
  }

  const profiles = [];
  for (const direction of LINE_DIRECTIONS) {
    const directionRows = rowsByDirection.get(direction.key) || [];
    for (let timeBin15m = 0; timeBin15m < 1_440; timeBin15m += PROFILE_BIN_MINUTES) {
      const nearbyRows = directionRows.filter((row) => (
        Number.isFinite(row.timeBin15m)
        && clockDistanceMinutes(row.timeBin15m, timeBin15m) <= PROFILE_TIME_WINDOW_MINUTES
      ));
      const weekdayRows = nearbyRows.filter((row) => row.weekday === profileWeekday);
      const selectedRows = weekdayRows.length >= PROFILE_MIN_SAMPLE_COUNT ? weekdayRows : nearbyRows;
      const delayMinutes = selectedRows.map((row) => row.delaySeconds / 60);
      const sampleCount = delayMinutes.length;
      profiles.push({
        profileDate,
        directionKey: direction.key,
        timeBin15m,
        typicalDelayMin: sampleCount ? roundToOne(median(delayMinutes)) : null,
        meanDelayMin: sampleCount
          ? roundToOne(delayMinutes.reduce((sum, value) => sum + value, 0) / sampleCount)
          : null,
        sampleCount,
        basis: weekdayRows.length >= PROFILE_MIN_SAMPLE_COUNT
          ? 'same_weekday_45min'
          : 'all_days_45min',
      });
    }
  }
  return profiles;
}

export function normalizeBsmBoard(body, nowSeconds, maxSourceAgeSeconds) {
  if (body?.error) {
    throw new Error(`Upstream returned an error: ${body.error}`);
  }
  if (!Array.isArray(body?.departures)) {
    throw new Error('Upstream response has no departure list');
  }

  const fetchedAtMs = Date.parse(body.fetchedAt);
  const fetchedAtSeconds = Math.floor(fetchedAtMs / 1000);
  if (!Number.isSafeInteger(fetchedAtSeconds) || fetchedAtSeconds <= 0) {
    throw new Error('Upstream response has no valid fetchedAt timestamp');
  }
  if (nowSeconds - fetchedAtSeconds > maxSourceAgeSeconds || fetchedAtSeconds - nowSeconds > 60) {
    throw new Error(`Upstream response is stale or has an invalid clock (${body.fetchedAt})`);
  }

  return body.departures.map((departure) => {
    const line = String(departure?.line || '').trim();
    const destination = String(departure?.destination || '').trim();
    const arrivalAt = asEpochSeconds(departure?.arrivalAt);
    const delay = delayMinutes(departure?.delay);
    const cancelled = isCancelled(departure?.cancelled);
    const scheduledAt = arrivalAt && delay !== null ? arrivalAt - delay * 60 : arrivalAt;
    const direction = classifyDirection(line, destination);

    return {
      id: `bsm|${line}|${direction?.key || normalizeRouteName(destination)}`,
      line,
      destination,
      sched_datetime: scheduledAt,
      rt_datetime: !cancelled && delay !== null ? arrivalAt : null,
      is_cancelled: cancelled,
      direction_key: direction?.key || null,
      direction_label: direction?.label || null,
      direction_confidence: direction?.confidence || 'unknown',
      service_pattern: direction?.servicePattern || 'unknown',
      platform: direction?.platform || null,
    };
  });
}

export function selectArrivalObservations(rows, nowSeconds, config) {
  const selected = [];

  for (const row of rows) {
    if (!row || (config.lineFilter && !config.lineFilter.has(String(row.line)))) {
      continue;
    }

    const scheduledAt = asEpochSeconds(row.sched_datetime);
    const realtimeAt = asEpochSeconds(row.rt_datetime);
    const sourceId = typeof row.id === 'string' ? row.id : null;
    if (!scheduledAt || !sourceId) {
      continue;
    }

    const cancelled = isCancelled(row.is_cancelled);
    const effectiveArrivalAt = realtimeAt || scheduledAt;
    const isNearArrival = effectiveArrivalAt >= nowSeconds - config.pastWindowSeconds
      && effectiveArrivalAt <= nowSeconds + config.futureWindowSeconds;

    if (!isNearArrival) {
      continue;
    }

    const observationStatus = cancelled ? 'cancelled' : (realtimeAt ? 'realtime' : 'schedule_only');
    const berlinTime = berlinScheduleDimensions(scheduledAt);
    const direction = row.direction_key ? null : classifyDirection(row.line, row.destination);

    selected.push({
      tripInstanceId: `${sourceId}|${scheduledAt}`,
      sourceId,
      observedAt: nowSeconds,
      scheduledAt,
      realtimeAt,
      effectiveArrivalAt,
      delaySeconds: observationStatus === 'realtime' ? realtimeAt - scheduledAt : null,
      observationStatus,
      isCancelled: cancelled ? 1 : 0,
      line: String(row.line),
      destination: row.destination || null,
      origin: row.origin || null,
      platform: row.platform || direction?.platform || null,
      directionKey: row.direction_key || direction?.key || null,
      directionLabel: row.direction_label || direction?.label || null,
      directionConfidence: row.direction_confidence || direction?.confidence || 'unknown',
      servicePattern: row.service_pattern || direction?.servicePattern || 'unknown',
      ...berlinTime,
    });
  }

  return selected;
}

function countRealtimeRows(rows, lineFilter) {
  return rows.filter((row) => row && (!lineFilter || lineFilter.has(String(row.line))) && asEpochSeconds(row.rt_datetime)).length;
}

async function fetchBoard(config, nowSeconds) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 10_000);

  try {
    const response = await fetch(config.sourceUrl, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`Upstream returned HTTP ${response.status}`);
    }

    const body = await response.json();
    return normalizeBsmBoard(body, nowSeconds, config.maxSourceAgeSeconds);
  } finally {
    clearTimeout(timeout);
  }
}

function observationStatement(observation) {
  return {
    sql: `INSERT INTO arrival_observations (
      trip_instance_id, source_id, first_seen_at, last_seen_at, seen_count,
      scheduled_at, realtime_at, effective_arrival_at, delay_seconds,
      observation_status, is_cancelled, line, destination, origin, platform,
      direction_key, direction_label, direction_confidence, service_pattern,
      service_date, weekday, scheduled_minute, time_bin_15m
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trip_instance_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      seen_count = seen_count + 1,
      realtime_at = COALESCE(excluded.realtime_at, realtime_at),
      effective_arrival_at = CASE
        WHEN excluded.observation_status = 'cancelled' THEN excluded.effective_arrival_at
        WHEN excluded.realtime_at IS NOT NULL THEN excluded.effective_arrival_at
        ELSE effective_arrival_at
      END,
      delay_seconds = COALESCE(excluded.delay_seconds, delay_seconds),
      observation_status = CASE
        WHEN excluded.observation_status = 'cancelled' THEN 'cancelled'
        WHEN excluded.observation_status = 'realtime' THEN 'realtime'
        ELSE observation_status
      END,
      is_cancelled = CASE
        WHEN excluded.observation_status = 'cancelled' THEN 1
        WHEN excluded.observation_status = 'realtime' THEN 0
        ELSE is_cancelled
      END,
      destination = COALESCE(excluded.destination, destination),
      origin = COALESCE(excluded.origin, origin),
      platform = COALESCE(excluded.platform, platform),
      direction_key = COALESCE(excluded.direction_key, direction_key),
      direction_label = COALESCE(excluded.direction_label, direction_label),
      direction_confidence = COALESCE(excluded.direction_confidence, direction_confidence),
      service_pattern = COALESCE(excluded.service_pattern, service_pattern),
      service_date = excluded.service_date,
      weekday = excluded.weekday,
      scheduled_minute = excluded.scheduled_minute,
      time_bin_15m = excluded.time_bin_15m`,
    params: [
      observation.tripInstanceId,
      observation.sourceId,
      observation.observedAt,
      observation.observedAt,
      observation.scheduledAt,
      observation.realtimeAt,
      observation.effectiveArrivalAt,
      observation.delaySeconds,
      observation.observationStatus,
      observation.isCancelled,
      observation.line,
      observation.destination,
      observation.origin,
      observation.platform,
      observation.directionKey,
      observation.directionLabel,
      observation.directionConfidence,
      observation.servicePattern,
      observation.serviceDate,
      observation.weekday,
      observation.scheduledMinute,
      observation.timeBin15m,
    ],
  };
}

async function writeDailyStats(db, values) {
  await db.prepare(`INSERT INTO collector_daily_stats (
      stat_date, last_run_at, polls, fetch_errors, source_rows,
      realtime_rows, schedule_only_rows, cancelled_rows, candidate_rows,
      written_observations
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stat_date) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      polls = polls + 1,
      fetch_errors = fetch_errors + excluded.fetch_errors,
      source_rows = source_rows + excluded.source_rows,
      realtime_rows = realtime_rows + excluded.realtime_rows,
      schedule_only_rows = schedule_only_rows + excluded.schedule_only_rows,
      cancelled_rows = cancelled_rows + excluded.cancelled_rows,
      candidate_rows = candidate_rows + excluded.candidate_rows,
      written_observations = written_observations + excluded.written_observations`
  ).bind(
    values.statDate,
    values.nowSeconds,
    values.fetchError ? 1 : 0,
    values.sourceRows,
    values.realtimeRows,
    values.scheduleOnlyRows,
    values.cancelledRows,
    values.candidateRows,
    values.writtenObservations,
  ).run();
}

async function pruneExpiredRows(db, nowSeconds, retentionDays) {
  const statDate = berlinServiceDate(nowSeconds);
  const lastPrune = await db.prepare('SELECT value FROM collector_state WHERE key = ?')
    .bind('last_prune_date')
    .first();
  if (lastPrune?.value === statDate) {
    return;
  }

  const cutoff = nowSeconds - retentionDays * 86_400;
  const earliestStatDate = isoDaysBefore(statDate, retentionDays);
  await db.batch([
    db.prepare('DELETE FROM arrival_observations WHERE last_seen_at < ?').bind(cutoff),
    db.prepare('DELETE FROM collector_daily_stats WHERE stat_date < ?').bind(earliestStatDate),
    db.prepare('DELETE FROM daily_history_profiles WHERE profile_date < ?').bind(earliestStatDate),
    db.prepare(`INSERT INTO collector_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind('last_prune_date', statDate),
  ]);
}

async function ensureDailyHistoryProfiles(db, nowSeconds, retentionDays) {
  const profileDate = berlinServiceDate(nowSeconds);
  const minuteOfDay = berlinScheduleDimensions(nowSeconds).scheduledMinute;
  if (minuteOfDay < 5) return;

  const profileState = await db.prepare('SELECT value FROM collector_state WHERE key = ?')
    .bind('last_history_profile_date')
    .first();
  if (profileState?.value === profileDate) return;

  const earliestSourceDate = isoDaysBefore(profileDate, retentionDays);
  const historicalRows = await db.prepare(`SELECT direction_key, weekday, time_bin_15m, delay_seconds
      FROM arrival_observations
      WHERE service_date >= ? AND service_date < ?
        AND observation_status = 'realtime'
        AND delay_seconds IS NOT NULL
        AND direction_key IS NOT NULL`)
    .bind(earliestSourceDate, profileDate)
    .all();
  const profiles = buildDailyHistoryProfiles(profileDate, historicalRows.results || []);
  const statements = profiles.map((profile) => db.prepare(`INSERT INTO daily_history_profiles (
      profile_date, direction_key, time_bin_15m, typical_delay_min, mean_delay_min,
      sample_count, basis, source_data_through, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_date, direction_key, time_bin_15m) DO UPDATE SET
      typical_delay_min = excluded.typical_delay_min,
      mean_delay_min = excluded.mean_delay_min,
      sample_count = excluded.sample_count,
      basis = excluded.basis,
      source_data_through = excluded.source_data_through,
      generated_at = excluded.generated_at`).bind(
    profile.profileDate,
    profile.directionKey,
    profile.timeBin15m,
    profile.typicalDelayMin,
    profile.meanDelayMin,
    profile.sampleCount,
    profile.basis,
    isoDaysBefore(profileDate, 1),
    nowSeconds,
  ));
  statements.push(db.prepare(`INSERT INTO collector_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind('last_history_profile_date', profileDate));
  await db.batch(statements);
}

function decodeLookupItems(encodedItems) {
  if (typeof encodedItems !== 'string' || encodedItems.length > 8_192) return null;
  try {
    const padded = encodedItems.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(encodedItems.length / 4) * 4,
      '=',
    );
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
    const items = JSON.parse(decoded);
    return Array.isArray(items) && items.length <= 8 ? items : null;
  } catch {
    return null;
  }
}

async function lookupDailyHistoryProfiles(db, encodedItems) {
  const inputItems = decodeLookupItems(encodedItems);
  if (!inputItems) return null;

  const lookupItems = inputItems.map((item, index) => {
    const line = String(item?.line || '').trim();
    const destination = String(item?.destination || '').trim();
    const arrivalAt = asEpochSeconds(item?.arrivalAt);
    const delay = delayMinutes(item?.delay);
    const direction = classifyDirection(line, destination);
    const scheduledAt = arrivalAt && delay !== null ? arrivalAt - delay * 60 : arrivalAt;
    if (!scheduledAt || !direction) return { id: String(item?.id || index), profileKey: null };
    const dimensions = berlinScheduleDimensions(scheduledAt);
    return {
      id: String(item?.id || index),
      profileKey: `${dimensions.serviceDate}|${direction.key}|${dimensions.timeBin15m}`,
    };
  });
  const profileKeys = [...new Set(lookupItems.map((item) => item.profileKey).filter(Boolean))];
  if (!profileKeys.length) return { items: lookupItems.map((item) => ({ id: item.id })) };

  const conditions = profileKeys.map(() => '(profile_date = ? AND direction_key = ? AND time_bin_15m = ?)').join(' OR ');
  const params = profileKeys.flatMap((key) => {
    const [profileDate, directionKey, timeBin15m] = key.split('|');
    return [profileDate, directionKey, Number(timeBin15m)];
  });
  const results = await db.prepare(`SELECT profile_date, direction_key, time_bin_15m,
      typical_delay_min, sample_count, basis
    FROM daily_history_profiles WHERE ${conditions}`)
    .bind(...params)
    .all();
  const profileByKey = new Map((results.results || []).map((profile) => [
    `${profile.profile_date}|${profile.direction_key}|${profile.time_bin_15m}`,
    profile,
  ]));
  return {
    items: lookupItems.map((item) => {
      const profile = item.profileKey && profileByKey.get(item.profileKey);
      if (!profile || Number(profile.sample_count) < PROFILE_MIN_SAMPLE_COUNT) return { id: item.id };
      return {
        id: item.id,
        typicalDelayMin: Number(profile.typical_delay_min),
        sampleCount: Number(profile.sample_count),
        basis: profile.basis,
      };
    }),
  };
}

async function collect(env, scheduledTime) {
  const config = getConfig(env);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const statDate = berlinServiceDate(nowSeconds);

  await pruneExpiredRows(env.DELAY_DB, nowSeconds, config.retentionDays);
  try {
    await ensureDailyHistoryProfiles(env.DELAY_DB, nowSeconds, config.retentionDays);
  } catch (error) {
    console.error('Poststadion history profile generation failed', error);
  }

  try {
    const rows = await fetchBoard(config, nowSeconds);
    const observations = selectArrivalObservations(rows, nowSeconds, config);
    const statements = observations.map((observation) => {
      const statement = observationStatement(observation);
      return env.DELAY_DB.prepare(statement.sql).bind(...statement.params);
    });
    const results = statements.length ? await env.DELAY_DB.batch(statements) : [];
    const statusCounts = observations.reduce((counts, observation) => {
      counts[observation.observationStatus] += 1;
      return counts;
    }, { realtime: 0, schedule_only: 0, cancelled: 0 });
    const changedObservations = results.reduce((count, result) => count + (result.meta?.changes || 0), 0);

    await writeDailyStats(env.DELAY_DB, {
      statDate,
      nowSeconds,
      fetchError: false,
      sourceRows: rows.length,
      realtimeRows: countRealtimeRows(rows, config.lineFilter),
      scheduleOnlyRows: statusCounts.schedule_only,
      cancelledRows: statusCounts.cancelled,
      candidateRows: observations.length,
      writtenObservations: changedObservations,
    });
  } catch (error) {
    console.error('Poststadion collection failed', error);
    await writeDailyStats(env.DELAY_DB, {
      statDate,
      nowSeconds,
      fetchError: true,
      sourceRows: 0,
      realtimeRows: 0,
      scheduleOnlyRows: 0,
      cancelledRows: 0,
      candidateRows: 0,
      writtenObservations: 0,
    });
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(collect(env, controller.scheduledTime));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/history/v1/poststadion') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const profiles = await lookupDailyHistoryProfiles(env.DELAY_DB, url.searchParams.get('items'));
      if (!profiles) return Response.json({ error: 'Invalid items' }, { status: 400 });
      return Response.json(profiles, {
        headers: { 'Cache-Control': 'public, max-age=300' },
      });
    }
    if (url.pathname !== '/healthz') {
      return new Response('Not found', { status: 404 });
    }

    const latest = await env.DELAY_DB.prepare(`SELECT * FROM collector_daily_stats
      ORDER BY stat_date DESC LIMIT 1`).first();
    return Response.json({ status: 'ok', latest });
  },
};
