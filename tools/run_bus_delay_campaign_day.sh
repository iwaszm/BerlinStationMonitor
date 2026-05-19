#!/usr/bin/env bash
set -euo pipefail

PROJECT="/home/zm/.openclaw/workspace/bvgtracker"
cd "$PROJECT"

SERVICE_DATE="${1:-$(date +%F)}"
LINES="${LINES:-142,123}"
START_TIME="${START_TIME:-06:00}"
END_TIME="${END_TIME:-20:00}"
INTERVAL_MIN="${INTERVAL_MIN:-15}"

LOG_DIR="$PROJECT/log"
mkdir -p "$LOG_DIR"
RUN_LOG="$LOG_DIR/bvg_bus_${LINES//,/_}_${SERVICE_DATE}_runner.log"
PID_FILE="$LOG_DIR/bvg_bus_${LINES//,/_}_${SERVICE_DATE}_runner.pid"
META_LOG="$LOG_DIR/bvg_bus_meta.jsonl"
LOCK_FILE="$LOG_DIR/bvg_bus_${LINES//,/_}_${SERVICE_DATE}.lock"

python3 - <<PY
import datetime as dt, json, pathlib
meta = {
  "event": "campaign_day_start",
  "logged_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
  "service_date": "$SERVICE_DATE",
  "lines": "$LINES".split(","),
  "schedule": {"start": "$START_TIME", "end": "$END_TIME", "interval_min": int("$INTERVAL_MIN")},
  "runner_log": pathlib.Path("$RUN_LOG").name,
  "pid_file": pathlib.Path("$PID_FILE").name,
  "status": "starting"
}
path = pathlib.Path("$META_LOG")
path.parent.mkdir(parents=True, exist_ok=True)
with path.open("a", encoding="utf-8") as f:
    f.write(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n")
PY

(
  flock -n 9 || {
    python3 - <<PY
import datetime as dt, json, pathlib
meta = {
  "event": "campaign_day_skipped",
  "logged_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
  "service_date": "$SERVICE_DATE",
  "lines": "$LINES".split(","),
  "status": "already_running",
  "note": "Lock file already held; skipped to avoid duplicate collection."
}
with pathlib.Path("$META_LOG").open("a", encoding="utf-8") as f:
    f.write(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n")
PY
    exit 0
  }

  echo $$ > "$PID_FILE"
  echo "campaign day ${SERVICE_DATE}: start $(date -Is) lines=${LINES} ${START_TIME}-${END_TIME}/${INTERVAL_MIN}min" >> "$RUN_LOG"

  set +e
  python3 tools/run_bus_delay_pilot_day.py \
    --date "$SERVICE_DATE" \
    --lines "$LINES" \
    --start "$START_TIME" \
    --end "$END_TIME" \
    --interval-min "$INTERVAL_MIN" >> "$RUN_LOG" 2>&1
  code=$?
  set -e

  DB="$LOG_DIR/bvg_delay_${LINES//,/_}_${SERVICE_DATE}.sqlite"
  if [[ -f "$DB" ]]; then
    python3 tools/render_bus_heatmap_sqlite.py --db "$DB" --out "$LOG_DIR/bvg_bus_${LINES//,/_}_${SERVICE_DATE}_heatmap.png" --lines "$LINES" >> "$RUN_LOG" 2>&1 || true
    python3 tools/render_bus_hourly_avg_heatmap_sqlite.py --db "$DB" --out "$LOG_DIR/bvg_bus_${LINES//,/_}_${SERVICE_DATE}_hourly_avg_heatmap.png" --lines "$LINES" >> "$RUN_LOG" 2>&1 || true
  fi

  python3 - <<PY
import datetime as dt, json, pathlib, sqlite3
project = pathlib.Path("$PROJECT")
db = pathlib.Path("$DB")
meta = {
  "event": "campaign_day_finish",
  "logged_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
  "service_date": "$SERVICE_DATE",
  "lines": "$LINES".split(","),
  "db": db.name,
  "runner_log": pathlib.Path("$RUN_LOG").name,
  "exit_code": $code,
  "status": "ok" if $code == 0 else "runner_failed"
}
if db.exists():
    con = sqlite3.connect(db)
    stats = con.execute("""
      SELECT COUNT(DISTINCT s.snapshot_id), COUNT(o.trip_id), COUNT(o.delay_min), MIN(o.delay_min), MAX(o.delay_min)
      FROM snapshots s LEFT JOIN observations o USING(snapshot_id)
    """).fetchone()
    meta["day"] = {
      "snapshots": stats[0],
      "observations": stats[1],
      "observations_with_delay": stats[2],
      "delay_coverage": round(stats[2] / stats[1], 4) if stats[1] else None,
      "min_delay": stats[3],
      "max_delay": stats[4]
    }
    if stats[1] and stats[2] == 0:
        meta["status"] = "realtime_delay_unavailable"
        meta.setdefault("notes", []).append("Collected rows but no realtime delay values for the full day; treat null delay as unavailable, not no delay.")
    con.close()
else:
    meta["status"] = "missing_db"
with pathlib.Path("$META_LOG").open("a", encoding="utf-8") as f:
    f.write(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n")
PY

  echo "campaign day ${SERVICE_DATE}: finish $(date -Is) exit=${code}" >> "$RUN_LOG"
  exit "$code"
) 9>"$LOCK_FILE"
