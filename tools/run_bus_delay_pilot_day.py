#!/usr/bin/env python3
import argparse, datetime as dt, json, pathlib, subprocess, time

PROJECT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = PROJECT / 'tools' / 'collect_bus_snapshot_sqlite.py'


def parse_date(s):
    return dt.date.fromisoformat(s)


def local_now():
    return dt.datetime.now().astimezone()


def min_to_hm(m):
    return f'{(m // 60) % 24:02d}:{m % 60:02d}'


def run_snapshot(db, lines, target_dt, target_min):
    out = subprocess.check_output([
        'python3', str(SCRIPT), '--db', str(db), '--lines', ','.join(lines), '--target-min', str(target_min)
    ], cwd=str(PROJECT), stderr=subprocess.STDOUT, text=True, timeout=900)
    return json.loads(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', required=True, help='service date YYYY-MM-DD')
    ap.add_argument('--lines', default='142,123')
    ap.add_argument('--start', default='06:00')
    ap.add_argument('--end', default='20:00')
    ap.add_argument('--interval-min', type=int, default=15)
    args = ap.parse_args()

    service_date = parse_date(args.date)
    lines = [x.strip() for x in args.lines.split(',') if x.strip()]
    start_h, start_m = map(int, args.start.split(':'))
    end_h, end_m = map(int, args.end.split(':'))
    start_min = start_h * 60 + start_m
    end_min = end_h * 60 + end_m
    db = PROJECT / 'log' / f'bvg_delay_{"_".join(lines)}_{service_date.isoformat()}.sqlite'
    log_prefix = f"bus pilot {','.join(lines)} {service_date.isoformat()}"

    targets = []
    m = start_min
    while m <= end_min:
        targets.append(m)
        m += args.interval_min
    print(f'{log_prefix}: schedule ' + ', '.join(min_to_hm(x) for x in targets), flush=True)

    for target_min in targets:
        target_dt = dt.datetime.combine(service_date, dt.time(target_min // 60, target_min % 60)).astimezone()
        sleep = (target_dt - local_now()).total_seconds()
        if sleep > 0:
            print(json.dumps({'target': min_to_hm(target_min), 'sleep_seconds': round(sleep, 1)}, ensure_ascii=False), flush=True)
            time.sleep(sleep)
        if target_dt < local_now() - dt.timedelta(minutes=args.interval_min):
            print(f'{log_prefix}: {min_to_hm(target_min)} skipped, already too old', flush=True)
            continue
        ok = False
        for attempt in range(1, 4):
            try:
                summary = run_snapshot(db, lines, target_dt, target_min)
                parts = []
                for item in summary['lines']:
                    parts.append(f"{item['line']}: trips {item['trips']}, rows {item['rows']}, delay {item['min_delay']}..{item['max_delay']}")
                action = 'saved' if summary.get('stored', True) else f"skipped ({summary.get('skip_reason')})"
                print(f"{log_prefix}: {summary['target_time']} {action} ({summary['observed_time']} observed) | " + ' | '.join(parts) + f" | db {db.name}", flush=True)
                ok = True
                break
            except Exception as e:
                print(f'{log_prefix}: {min_to_hm(target_min)} attempt {attempt} failed: {e}', flush=True)
                if attempt < 3:
                    time.sleep(120)
        if not ok:
            print(f'{log_prefix}: {min_to_hm(target_min)} failed after retries; continuing', flush=True)

    print(f'{log_prefix}: finished | db {db}', flush=True)

if __name__ == '__main__':
    main()
