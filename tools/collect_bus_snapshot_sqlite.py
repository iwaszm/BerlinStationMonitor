#!/usr/bin/env python3
import argparse, datetime as dt, json, pathlib, sqlite3, subprocess, time, urllib.parse

PROJECT = pathlib.Path(__file__).resolve().parents[1]
API = 'https://v6.bvg.transport.rest'
PROGNOSIS = {None: 0, 'prognosed': 1, 'calculated': 2, 'scheduled': 3}
META_LOG = PROJECT / 'log' / 'bvg_bus_meta.jsonl'


def local_now():
    return dt.datetime.now().astimezone()


def hm_to_min(s):
    if not s or ':' not in s:
        return None
    h, m = map(int, s.split(':')[:2])
    return h * 60 + m


def min_to_hm(m):
    return f'{(m // 60) % 24:02d}:{m % 60:02d}'


def parse_iso(s):
    if not s:
        return None
    return dt.datetime.fromisoformat(s)


def fetch_json(path, params=None, timeout=90, attempts=3):
    url = API + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    last = None
    for attempt in range(1, attempts + 1):
        try:
            out = subprocess.check_output(['curl', '-L', '--max-time', str(timeout), '-sS', url], stderr=subprocess.STDOUT)
            if not out.strip():
                raise RuntimeError(f'empty response from {url}')
            return json.loads(out)
        except Exception as e:
            last = e
            if attempt < attempts:
                time.sleep(5 * attempt)
    raise last


def pick_stop_time(stopover):
    planned = stopover.get('plannedArrival') or stopover.get('plannedDeparture')
    delay = stopover.get('arrivalDelay')
    prognosis = stopover.get('arrivalPrognosisType')
    if delay is None:
        delay = stopover.get('departureDelay')
        prognosis = stopover.get('departurePrognosisType')
    if prognosis is None:
        prognosis = stopover.get('departurePrognosisType') or stopover.get('arrivalPrognosisType')
    return planned, delay, prognosis


def delay_minutes(sec):
    if sec is None:
        return None
    return int(round(sec / 60))


def ensure_schema(con):
    con.executescript('''
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS snapshots(
  snapshot_id INTEGER PRIMARY KEY,
  snapshot_key TEXT UNIQUE NOT NULL,
  service_date TEXT NOT NULL,
  target_min INTEGER NOT NULL,
  observed_min INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lines(
  line_id INTEGER PRIMARY KEY,
  line_name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS stops(
  stop_id TEXT PRIMARY KEY,
  stop_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directions(
  direction_id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL,
  direction_name TEXT NOT NULL,
  UNIQUE(line_id, direction_name),
  FOREIGN KEY(line_id) REFERENCES lines(line_id)
);

CREATE TABLE IF NOT EXISTS observations(
  snapshot_id INTEGER NOT NULL,
  trip_id TEXT NOT NULL,
  line_id INTEGER NOT NULL,
  direction_id INTEGER NOT NULL,
  stop_id TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  planned_min INTEGER NOT NULL,
  delay_min INTEGER,
  prognosis_code INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(snapshot_id, trip_id, stop_sequence, stop_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id),
  FOREIGN KEY(line_id) REFERENCES lines(line_id),
  FOREIGN KEY(direction_id) REFERENCES directions(direction_id),
  FOREIGN KEY(stop_id) REFERENCES stops(stop_id)
);

CREATE INDEX IF NOT EXISTS idx_obs_snapshot_line ON observations(snapshot_id, line_id);
CREATE INDEX IF NOT EXISTS idx_obs_snapshot_dir_stop ON observations(snapshot_id, direction_id, stop_id);
CREATE INDEX IF NOT EXISTS idx_obs_trip ON observations(trip_id);
CREATE INDEX IF NOT EXISTS idx_obs_planned ON observations(planned_min);
''')


def get_id(cur, table, id_col, unique_cols, values):
    where = ' AND '.join(f'{c}=?' for c in unique_cols)
    cur.execute(f'SELECT {id_col} FROM {table} WHERE {where}', values)
    row = cur.fetchone()
    if row:
        return row[0]
    cols = ','.join(unique_cols)
    qs = ','.join('?' for _ in unique_cols)
    cur.execute(f'INSERT INTO {table}({cols}) VALUES ({qs})', values)
    return cur.lastrowid


def collect_line(cur, snapshot_id, line_name, observed_dt):
    trips_res = fetch_json('/trips', {
        'lineName': line_name,
        'when': observed_dt.isoformat(timespec='seconds'),
        'onlyCurrentlyRunning': 'true',
        'stopovers': 'false',
        'remarks': 'false',
        'language': 'de',
    })
    trips = trips_res.get('trips', []) if isinstance(trips_res, dict) else trips_res
    trip_ids = []
    for t in trips:
        tid = t.get('id') or t.get('tripId')
        if tid and tid not in trip_ids:
            trip_ids.append(tid)

    line_id = get_id(cur, 'lines', 'line_id', ['line_name'], (line_name,))
    row_count = 0
    delays = []

    for tid in trip_ids:
        detail = fetch_json('/trips/' + urllib.parse.quote(tid, safe=''), {
            'stopovers': 'true',
            'remarks': 'false',
            'language': 'de',
        })
        trip = detail.get('trip', detail)
        actual_line = ((trip.get('line') or {}).get('name')) or line_name
        if actual_line != line_name:
            continue
        stopovers = trip.get('stopovers') or []
        direction_name = trip.get('direction') or ((stopovers[-1].get('stop') or {}).get('name') if stopovers else 'unknown')
        direction_id = get_id(cur, 'directions', 'direction_id', ['line_id', 'direction_name'], (line_id, direction_name))

        for idx, so in enumerate(stopovers, start=1):
            stop = so.get('stop') or {}
            planned, delay_sec, prognosis = pick_stop_time(so)
            planned_dt = parse_iso(planned)
            if not planned_dt or not stop.get('id'):
                continue
            cur.execute('INSERT OR IGNORE INTO stops(stop_id, stop_name) VALUES (?,?)', (stop.get('id'), stop.get('name') or stop.get('id')))
            dmin = delay_minutes(delay_sec)
            if isinstance(dmin, int):
                delays.append(dmin)
            cur.execute('''
                INSERT OR REPLACE INTO observations(
                  snapshot_id, trip_id, line_id, direction_id, stop_id, stop_sequence, planned_min, delay_min, prognosis_code
                ) VALUES (?,?,?,?,?,?,?,?,?)
            ''', (
                snapshot_id, tid, line_id, direction_id, stop.get('id'), idx,
                planned_dt.hour * 60 + planned_dt.minute, dmin, PROGNOSIS.get(prognosis, 0)
            ))
            row_count += 1
        time.sleep(0.15)

    return {
        'line': line_name,
        'trips': len(trip_ids),
        'rows': row_count,
        'with_delay': len(delays),
        'min_delay': min(delays) if delays else None,
        'max_delay': max(delays) if delays else None,
        'avg_delay': round(sum(delays) / len(delays), 1) if delays else None,
    }


def collect(db_path, lines, observed_dt=None, target_min=None):
    observed_dt = observed_dt or local_now()
    service_date = observed_dt.strftime('%Y-%m-%d')
    observed_min = observed_dt.hour * 60 + observed_dt.minute
    if target_min is None:
        target_min = round(observed_min / 15) * 15
    snapshot_key = f'{service_date}T{min_to_hm(target_min).replace(":", "")}'

    con = sqlite3.connect(db_path)
    ensure_schema(con)
    cur = con.cursor()
    cur.execute('INSERT OR IGNORE INTO snapshots(snapshot_key, service_date, target_min, observed_min) VALUES (?,?,?,?)',
                (snapshot_key, service_date, target_min, observed_min))
    cur.execute('SELECT snapshot_id FROM snapshots WHERE snapshot_key=?', (snapshot_key,))
    snapshot_id = cur.fetchone()[0]

    summaries = []
    for line in lines:
        summaries.append(collect_line(cur, snapshot_id, line, observed_dt))

    snapshot_rows = sum(item.get('rows', 0) for item in summaries)
    snapshot_with_delay = sum(item.get('with_delay', 0) for item in summaries)
    stored = snapshot_with_delay > 0
    if stored:
        con.commit()
    else:
        # If the API returns no realtime delay values, the snapshot is not useful
        # for delay analysis. Roll back the snapshot/observation inserts so these
        # time slots do not pollute the campaign database with scheduled-only data.
        con.rollback()

    stats = con.execute('''
        SELECT
          COUNT(DISTINCT s.snapshot_id) AS snapshots,
          COUNT(o.trip_id) AS observations,
          COUNT(o.delay_min) AS observations_with_delay,
          MIN(o.delay_min) AS min_delay,
          MAX(o.delay_min) AS max_delay
        FROM snapshots s
        LEFT JOIN observations o USING(snapshot_id)
    ''').fetchone()
    con.close()

    result = {
        'snapshot_key': snapshot_key,
        'service_date': service_date,
        'target_time': min_to_hm(target_min),
        'observed_time': min_to_hm(observed_min),
        'lines': summaries,
        'db': str(db_path),
        'stored': stored,
        'skip_reason': None if stored else ('no_rows' if snapshot_rows == 0 else 'realtime_delay_unavailable'),
    }
    append_meta_log(result, stats)
    return result


def append_meta_log(result, stats):
    snapshots, observations, with_delay, min_delay, max_delay = stats
    delay_coverage = (with_delay / observations) if observations else None
    snapshot_rows = sum(item.get('rows', 0) for item in result['lines'])
    snapshot_with_delay = sum(item.get('with_delay', 0) for item in result['lines'])
    meta = {
        'event': 'snapshot_summary',
        'logged_at': local_now().isoformat(timespec='seconds'),
        'service_date': result['service_date'],
        'target_time': result['target_time'],
        'observed_time': result['observed_time'],
        'lines': [item['line'] for item in result['lines']],
        'db': pathlib.Path(result['db']).name,
        'snapshot': {
            'rows': snapshot_rows,
            'with_delay': snapshot_with_delay,
            'delay_available': snapshot_with_delay > 0,
        },
        'day_so_far': {
            'snapshots': snapshots,
            'observations': observations,
            'observations_with_delay': with_delay,
            'delay_coverage': round(delay_coverage, 4) if delay_coverage is not None else None,
            'min_delay': min_delay,
            'max_delay': max_delay,
        },
        'status': 'ok' if snapshot_rows else 'no_rows',
        'stored': bool(result.get('stored', True)),
        'skip_reason': result.get('skip_reason'),
        'notes': [],
    }
    if snapshot_rows and snapshot_with_delay == 0:
        meta['status'] = 'snapshot_delay_unavailable'
        meta['notes'].append('Skipped database storage: BVG API returned trips/stopovers, but arrivalDelay/departureDelay were null for this snapshot.')
    elif snapshot_rows == 0:
        meta['notes'].append('Skipped database storage: no trips/stopovers were returned for this snapshot.')
    META_LOG.parent.mkdir(parents=True, exist_ok=True)
    with META_LOG.open('a', encoding='utf-8') as f:
        f.write(json.dumps(meta, ensure_ascii=False, separators=(',', ':')) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--lines', default='142,123')
    ap.add_argument('--at', help='ISO observed datetime; default now')
    ap.add_argument('--target-min', type=int)
    args = ap.parse_args()
    observed = parse_iso(args.at) if args.at else None
    lines = [x.strip() for x in args.lines.split(',') if x.strip()]
    print(json.dumps(collect(pathlib.Path(args.db), lines, observed, args.target_min), ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
