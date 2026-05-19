#!/usr/bin/env python3
import argparse, datetime as dt, json, subprocess, sys, time, urllib.parse
from pathlib import Path

API = 'https://v6.bvg.transport.rest'
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = PROJECT / 'log' / 'bvg_142_delay_pilot.jsonl'
LINE = '142'

def local_now():
    return dt.datetime.now().astimezone()

def parse_iso(s):
    if not s:
        return None
    return dt.datetime.fromisoformat(s)

def hhmm(x):
    d = parse_iso(x) if isinstance(x, str) else x
    return d.strftime('%H:%M') if d else None

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

def delay_minutes(sec):
    if sec is None:
        return None
    return int(round(sec / 60))

def pick_stop_time(stopover):
    planned = stopover.get('plannedArrival') or stopover.get('plannedDeparture')
    realtime = stopover.get('arrival') or stopover.get('departure')
    delay = stopover.get('arrivalDelay')
    prognosis = stopover.get('arrivalPrognosisType')
    if delay is None:
        delay = stopover.get('departureDelay')
        prognosis = stopover.get('departurePrognosisType')
    if prognosis is None:
        prognosis = stopover.get('departurePrognosisType') or stopover.get('arrivalPrognosisType')
    return planned, realtime, delay, prognosis

def status_for(planned_iso, delay_sec, observed_dt):
    planned = parse_iso(planned_iso)
    if not planned:
        return 'unknown'
    if delay_sec is None:
        estimate = planned
        basis = 'schedule'
    else:
        estimate = planned + dt.timedelta(seconds=delay_sec)
        basis = 'realtime'
    if estimate <= observed_dt:
        return 'passed' if basis == 'realtime' else 'planned_passed'
    return 'upcoming' if basis == 'realtime' else 'planned_upcoming'

def snapshot(observed_dt=None, out_path=DEFAULT_OUT):
    observed_dt = observed_dt or local_now()
    service_date = observed_dt.strftime('%Y-%m-%d')
    observed_time = observed_dt.strftime('%H:%M')
    snapshot_id = f'{service_date}T{observed_time.replace(":", "")}'

    trips_res = fetch_json('/trips', {
        'lineName': LINE,
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

    rows = []
    for tid in trip_ids:
        try:
            detail = fetch_json('/trips/' + urllib.parse.quote(tid, safe=''), {
                'stopovers': 'true',
                'remarks': 'false',
                'language': 'de',
            })
        except Exception as e:
            print(f'WARN trip fetch failed {tid}: {e}', file=sys.stderr)
            continue
        trip = detail.get('trip', detail)
        line_name = ((trip.get('line') or {}).get('name')) or LINE
        if line_name != LINE:
            continue
        stopovers = trip.get('stopovers') or []
        # Direction is more useful as final stop; API trip direction may be null.
        direction = trip.get('direction') or ((stopovers[-1].get('stop') or {}).get('name') if stopovers else None)
        for idx, so in enumerate(stopovers, start=1):
            stop = so.get('stop') or {}
            planned, realtime, delay_sec, prognosis = pick_stop_time(so)
            rows.append({
                'snapshot_id': snapshot_id,
                'service_date': service_date,
                'observed_time': observed_time,
                'line_name': LINE,
                'trip_id': tid,
                'direction': direction,
                'stop_sequence': idx,
                'stop_id': stop.get('id'),
                'stop_name': stop.get('name'),
                'planned_time': hhmm(planned),
                'delay_min': delay_minutes(delay_sec),
                'status': status_for(planned, delay_sec, observed_dt),
                'prognosis_type': prognosis,
            })
        time.sleep(0.15)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open('a', encoding='utf-8') as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')

    delays = [r['delay_min'] for r in rows if isinstance(r.get('delay_min'), int)]
    summary = {
        'snapshot_id': snapshot_id,
        'service_date': service_date,
        'observed_time': observed_time,
        'line_name': LINE,
        'trips': len(trip_ids),
        'rows': len(rows),
        'with_delay': len(delays),
        'min_delay': min(delays) if delays else None,
        'max_delay': max(delays) if delays else None,
        'avg_delay': round(sum(delays)/len(delays), 1) if delays else None,
        'file': str(out_path),
    }
    return summary

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    ap.add_argument('--at', help='ISO datetime for observed time; default now')
    args = ap.parse_args()
    observed = parse_iso(args.at) if args.at else None
    print(json.dumps(snapshot(observed, Path(args.out)), ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
