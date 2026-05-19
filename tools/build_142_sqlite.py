#!/usr/bin/env python3
import json, pathlib, sqlite3, re

PROJECT = pathlib.Path(__file__).resolve().parents[1]
JSONL = PROJECT / 'log' / 'bvg_142_delay_pilot.jsonl'
DB = PROJECT / 'log' / 'bvg_142_delay_pilot.sqlite'

PROGNOSIS = {None: 0, 'prognosed': 1, 'calculated': 2, 'scheduled': 3}

def hm_to_min(s):
    if not s or ':' not in s:
        return None
    h, m = map(int, s.split(':')[:2])
    return h * 60 + m

def target_bucket_min(observed_min):
    # Keep the intended half-hour bucket. 16:02 -> 16:00; 20:03 -> 20:00.
    return round(observed_min / 30) * 30

rows = []
for line in JSONL.open(encoding='utf-8'):
    if not line.strip():
        continue
    rows.append(json.loads(line))

if DB.exists():
    DB.unlink()
con = sqlite3.connect(DB)
cur = con.cursor()
cur.executescript('''
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE snapshots(
  snapshot_id INTEGER PRIMARY KEY,
  snapshot_key TEXT UNIQUE NOT NULL,
  service_date TEXT NOT NULL,
  target_min INTEGER NOT NULL,
  observed_min INTEGER NOT NULL
);

CREATE TABLE stops(
  stop_id TEXT PRIMARY KEY,
  stop_name TEXT NOT NULL
);

CREATE TABLE directions(
  direction_id INTEGER PRIMARY KEY,
  line_name TEXT NOT NULL,
  direction_name TEXT NOT NULL,
  UNIQUE(line_name, direction_name)
);

CREATE TABLE observations(
  snapshot_id INTEGER NOT NULL,
  trip_id TEXT NOT NULL,
  direction_id INTEGER NOT NULL,
  stop_id TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  planned_min INTEGER NOT NULL,
  delay_min INTEGER,
  prognosis_code INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(snapshot_id, trip_id, stop_sequence, stop_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(snapshot_id),
  FOREIGN KEY(direction_id) REFERENCES directions(direction_id),
  FOREIGN KEY(stop_id) REFERENCES stops(stop_id)
);

CREATE INDEX idx_obs_snapshot_dir_stop ON observations(snapshot_id, direction_id, stop_id);
CREATE INDEX idx_obs_trip ON observations(trip_id);
CREATE INDEX idx_obs_planned ON observations(planned_min);
''')

snapshot_ids = {}
direction_ids = {}
for r in rows:
    observed_min = hm_to_min(r['observed_time'])
    target_min = target_bucket_min(observed_min)
    skey = r['snapshot_id']
    if skey not in snapshot_ids:
        cur.execute('INSERT INTO snapshots(snapshot_key, service_date, target_min, observed_min) VALUES (?,?,?,?)',
                    (skey, r['service_date'], target_min, observed_min))
        snapshot_ids[skey] = cur.lastrowid
    cur.execute('INSERT OR IGNORE INTO stops(stop_id, stop_name) VALUES (?,?)', (r['stop_id'], r['stop_name']))
    dkey = (r['line_name'], r['direction'])
    if dkey not in direction_ids:
        cur.execute('INSERT OR IGNORE INTO directions(line_name, direction_name) VALUES (?,?)', dkey)
        cur.execute('SELECT direction_id FROM directions WHERE line_name=? AND direction_name=?', dkey)
        direction_ids[dkey] = cur.fetchone()[0]
    cur.execute('''
        INSERT OR REPLACE INTO observations(
          snapshot_id, trip_id, direction_id, stop_id, stop_sequence, planned_min, delay_min, prognosis_code
        ) VALUES (?,?,?,?,?,?,?,?)
    ''', (
        snapshot_ids[skey], r['trip_id'], direction_ids[dkey], r['stop_id'], int(r['stop_sequence']),
        hm_to_min(r['planned_time']), r.get('delay_min'), PROGNOSIS.get(r.get('prognosis_type'), 0)
    ))

con.commit()
# Stats
for table in ['snapshots', 'stops', 'directions', 'observations']:
    cur.execute(f'SELECT COUNT(*) FROM {table}')
    print(f'{table}: {cur.fetchone()[0]}')
con.close()
print(DB)
