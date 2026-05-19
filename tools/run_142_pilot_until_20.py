#!/usr/bin/env python3
import datetime as dt, json, subprocess, time
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT / 'tools' / 'collect_142_snapshot.py'
LOG = PROJECT / 'log' / 'bvg_142_delay_pilot.jsonl'
TARGET = '8419342043'

def send(msg):
    # Use OpenClaw message tool is not available inside this plain script, so print.
    # The supervising agent can forward if needed; cron/subagent stdout is retained.
    print(msg, flush=True)

def run_snapshot():
    out = subprocess.check_output(['python3', str(SCRIPT)], cwd=str(PROJECT), stderr=subprocess.STDOUT, text=True, timeout=420)
    summary = json.loads(out)
    send(f"142 pilot：{summary['observed_time']} 已保存，trips {summary['trips']}，rows {summary['rows']}，delay 范围 {summary['min_delay']}..{summary['max_delay']} 分钟，文件 log/bvg_142_delay_pilot.jsonl")
    return summary

def next_boundaries(now):
    targets=[]
    day=now.date()
    for h in range(now.hour, 21):
        for m in (0,30):
            t=dt.datetime.combine(day, dt.time(h,m)).astimezone()
            if t > now and t.time() <= dt.time(20,0): targets.append(t)
    return targets

def main():
    now=dt.datetime.now().astimezone()
    targets=next_boundaries(now)
    send('schedule ' + ', '.join(t.strftime('%H:%M') for t in targets))
    for target in targets:
        sleep=(target-dt.datetime.now().astimezone()).total_seconds()
        if sleep>0:
            send(json.dumps({'target': target.strftime('%H:%M'), 'sleep_seconds': round(sleep,1)}))
            time.sleep(sleep)
        ok=False
        last=None
        for attempt in range(1,4):
            try:
                run_snapshot(); ok=True; break
            except Exception as e:
                last=e
                send(f"142 pilot：{target.strftime('%H:%M')} 第 {attempt} 次采集失败：{e}")
                if attempt<3: time.sleep(120)
        if not ok:
            send(f"142 pilot：{target.strftime('%H:%M')} 采集失败，跳过到下一次。")
    if LOG.exists():
        lines=sum(1 for _ in LOG.open(encoding='utf-8'))
        snaps=set()
        for line in LOG.open(encoding='utf-8'):
            try: snaps.add(json.loads(line).get('snapshot_id'))
            except Exception: pass
        send(f"142 pilot：到 20:00 结束。snapshot {len(snaps)}，rows {lines}，文件 log/bvg_142_delay_pilot.jsonl")

if __name__=='__main__': main()
