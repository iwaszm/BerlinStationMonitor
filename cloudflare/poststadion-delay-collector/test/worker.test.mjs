import test from 'node:test';
import assert from 'node:assert/strict';

import {
  berlinScheduleDimensions,
  berlinServiceDate,
  buildDailyHistoryProfiles,
  normalizeBsmBoard,
  selectArrivalObservations,
} from '../src/worker.mjs';
import { classifyDirection } from '../src/lineDirections.mjs';

const nowSeconds = 1_790_679_120;
const config = {
  lineFilter: new Set(['123', '142']),
  pastWindowSeconds: 60,
  futureWindowSeconds: 120,
};

test('normalizes the BSM board and derives scheduled time from minute delays', () => {
  const rows = normalizeBsmBoard({
    fetchedAt: new Date(nowSeconds * 1000).toISOString(),
    departures: [
      { line: '142', destination: 'U Leopoldplatz', arrivalAt: nowSeconds + 60, delay: 0, cancelled: false },
      { line: '123', destination: 'S+U Hauptbahnhof', arrivalAt: nowSeconds + 60, delay: 3, cancelled: false },
      { line: '123', destination: 'Cancelled trip', arrivalAt: nowSeconds + 60, delay: 2, cancelled: true },
      { line: '142', destination: 'Schedule only', arrivalAt: nowSeconds + 60, delay: null, cancelled: false },
    ],
  }, nowSeconds, 150);

  assert.equal(rows[0].sched_datetime, nowSeconds + 60);
  assert.equal(rows[0].rt_datetime, nowSeconds + 60);
  assert.equal(rows[1].sched_datetime, nowSeconds - 120);
  assert.equal(rows[1].rt_datetime, nowSeconds + 60);
  assert.equal(rows[2].sched_datetime, nowSeconds - 60);
  assert.equal(rows[2].rt_datetime, null);
  assert.equal(rows[3].sched_datetime, nowSeconds + 60);
  assert.equal(rows[3].rt_datetime, null);
  assert.equal(rows[0].direction_key, '142_to_leopoldplatz');
  assert.equal(rows[0].platform, '2');
  assert.equal(rows[1].direction_key, '123_to_hauptbahnhof');
  assert.equal(rows[1].platform, '1');
});

test('maps terminal variations to one of the four Poststadion direction groups', () => {
  const ostbahnhof = classifyDirection('142', 'S Ostbahnhof via S+U Hauptbahnhof');
  assert.equal(ostbahnhof.key, '142_to_ostbahnhof');
  assert.equal(ostbahnhof.platform, '1');
  assert.equal(ostbahnhof.servicePattern, 'full_route');

  const shortTurn142 = classifyDirection('142', 'S+U Hauptbahnhof');
  assert.equal(shortTurn142.key, '142_to_ostbahnhof');
  assert.equal(shortTurn142.platform, '1');
  assert.equal(shortTurn142.servicePattern, 'short_turn');

  const shortTurn123 = classifyDirection('123', 'U Paulsternstr.');
  assert.equal(shortTurn123.key, '123_to_maeckeritzwiesen');
  assert.equal(shortTurn123.platform, '2');
  assert.equal(shortTurn123.servicePattern, 'short_turn');

  const saatwinkler = classifyDirection('123', 'Saatwinkler Damm/Mäckeritzwiesen');
  assert.equal(saatwinkler.key, '123_to_maeckeritzwiesen');
  assert.equal(saatwinkler.platform, '2');
  assert.equal(saatwinkler.servicePattern, 'full_route');

  const siemensdamm = classifyDirection('123', 'U Siemensdamm');
  assert.equal(siemensdamm.key, '123_to_maeckeritzwiesen');
  const amrumerStrasse = classifyDirection('142', 'U Amrumer Str.');
  assert.equal(amrumerStrasse.key, '142_to_leopoldplatz');
});

test('derives date and time features in Berlin local time', () => {
  const dimensions = berlinScheduleDimensions(Math.floor(Date.parse('2026-09-30T14:19:00Z') / 1000));
  assert.deepEqual(dimensions, {
    serviceDate: '2026-09-30',
    weekday: 3,
    scheduledMinute: 979,
    timeBin15m: 975,
  });
});

test('uses Berlin calendar dates for daily collector statistics', () => {
  assert.equal(
    berlinServiceDate(Math.floor(Date.parse('2026-09-30T22:30:00Z') / 1000)),
    '2026-10-01',
  );
});

test('precomputes a weekday profile and falls back to all days only when needed', () => {
  const rows = [
    { direction_key: '123_to_hauptbahnhof', weekday: 4, time_bin_15m: 480, delay_seconds: 60 },
    { direction_key: '123_to_hauptbahnhof', weekday: 4, time_bin_15m: 480, delay_seconds: 120 },
    { direction_key: '123_to_hauptbahnhof', weekday: 4, time_bin_15m: 495, delay_seconds: 180 },
    { direction_key: '123_to_hauptbahnhof', weekday: 4, time_bin_15m: 495, delay_seconds: 240 },
    { direction_key: '142_to_ostbahnhof', weekday: 1, time_bin_15m: 480, delay_seconds: 300 },
    { direction_key: '142_to_ostbahnhof', weekday: 2, time_bin_15m: 480, delay_seconds: 360 },
    { direction_key: '142_to_ostbahnhof', weekday: 3, time_bin_15m: 480, delay_seconds: 420 },
    { direction_key: '142_to_ostbahnhof', weekday: 5, time_bin_15m: 480, delay_seconds: 480 },
  ];
  const profiles = buildDailyHistoryProfiles('2026-10-08', rows);
  const weekdayProfile = profiles.find((profile) => (
    profile.directionKey === '123_to_hauptbahnhof' && profile.timeBin15m === 480
  ));
  const fallbackProfile = profiles.find((profile) => (
    profile.directionKey === '142_to_ostbahnhof' && profile.timeBin15m === 480
  ));

  assert.equal(profiles.length, 384);
  assert.equal(weekdayProfile.sampleCount, 4);
  assert.equal(weekdayProfile.typicalDelayMin, 2.5);
  assert.equal(weekdayProfile.basis, 'same_weekday_45min');
  assert.equal(fallbackProfile.sampleCount, 4);
  assert.equal(fallbackProfile.typicalDelayMin, 6.5);
  assert.equal(fallbackProfile.basis, 'all_days_45min');
});

test('rejects stale BSM board responses', () => {
  assert.throws(() => normalizeBsmBoard({
    fetchedAt: new Date((nowSeconds - 151) * 1000).toISOString(),
    departures: [],
  }, nowSeconds, 150), /stale/);
});

test('records realtime arrivals, including punctual and delayed predictions', () => {
  const observations = selectArrivalObservations([{
    id: 'vbb:punctual-trip',
    line: '142',
    sched_datetime: nowSeconds + 60,
    rt_datetime: nowSeconds + 60,
  }, {
    id: 'vbb:delayed-trip',
    line: '142',
    sched_datetime: nowSeconds - 30,
    rt_datetime: nowSeconds + 90,
    destination: 'S Ostbahnhof',
  }], nowSeconds, config);

  assert.equal(observations.length, 2);
  assert.equal(observations[0].observationStatus, 'realtime');
  assert.equal(observations[0].delaySeconds, 0);
  assert.equal(observations[1].delaySeconds, 120);
  assert.equal(observations[1].tripInstanceId, `vbb:delayed-trip|${nowSeconds - 30}`);
  assert.equal(observations[1].directionKey, '142_to_ostbahnhof');
  assert.equal(observations[1].platform, '1');
});

test('records schedule-only and cancelled arrivals using their scheduled time', () => {
  const observations = selectArrivalObservations([
    { id: 'scheduled', line: '142', sched_datetime: nowSeconds, rt_datetime: null },
    { id: 'cancelled', line: '123', sched_datetime: nowSeconds + 60, is_cancelled: 1 },
  ], nowSeconds, config);

  assert.deepEqual(observations.map((observation) => observation.observationStatus), ['schedule_only', 'cancelled']);
  assert.equal(observations[0].delaySeconds, null);
  assert.equal(observations[1].delaySeconds, null);
});

test('does not record distant arrivals or unrelated lines', () => {
  const observations = selectArrivalObservations([
    { id: 'distant', line: '142', sched_datetime: nowSeconds, rt_datetime: nowSeconds + 600 },
    { id: 'other-line', line: 'M27', sched_datetime: nowSeconds, rt_datetime: nowSeconds + 180 },
  ], nowSeconds, config);

  assert.equal(observations.length, 0);
});

test('does not mistake an upstream string zero for a cancellation', () => {
  const observations = selectArrivalObservations([{
    id: 'not-cancelled',
    line: '123',
    sched_datetime: nowSeconds - 30,
    rt_datetime: nowSeconds + 90,
    is_cancelled: '0',
  }], nowSeconds, config);

  assert.equal(observations.length, 1);
});
