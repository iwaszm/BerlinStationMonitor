# src/save_csv.py

import csv
import os
from datetime import datetime, timezone
import src.config as cfg

def init_csv():
    folder = os.path.dirname(cfg.CSV_FILE)
    os.makedirs(folder, exist_ok=True)

    if not os.path.exists(cfg.CSV_FILE):
        with open(cfg.CSV_FILE, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([
                "timestamp_utc",
                "tripId",
                "line",
                "direction",
                "lat",
                "lon",
                "next_stop",
                "next_time_utc",
                "delay_min"
            ])

def append_rows(rows):
    with open(cfg.CSV_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        now_utc = datetime.utcnow().replace(tzinfo=timezone.utc).isoformat()

        for r in rows:
            writer.writerow([
                now_utc,
                r["tripId"],
                r["line"],
                r["direction"],
                r["lat"],
                r["lon"],
                r["next_stop"],
                r["next_time"],   
                r["delay_min"]
            ])
