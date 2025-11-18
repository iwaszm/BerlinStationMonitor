# src/save_csv.py

import csv
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import src.config as cfg

def init_csv():
    folder = os.path.dirname(cfg.CSV_FILE)
    os.makedirs(folder, exist_ok=True)

    if not os.path.exists(cfg.CSV_FILE):
        with open(cfg.CSV_FILE, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow([
                "timestamp",
                "tripId",
                "line",
                "direction",
                "lat",
                "lon",
                "next_stop",
                "arrival_time",
                "arrival_time_planned",
                "delay_sec"
            ])

def append_rows(rows):
    with open(cfg.CSV_FILE, "a", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        # now_utc = datetime.utcnow().replace(tzinfo=timezone.utc).isoformat()
        now_local = datetime.now(ZoneInfo("Europe/Berlin")).isoformat()

        for r in rows:
            writer.writerow([
                now_local,
                r["tripId"],
                r["line"],
                r["direction"],
                r["lat"],
                r["lon"],
                r["next_stop"],
                r["next_time"],
                r["next_time_planned"],    
                r["delay_sec"]
            ])
