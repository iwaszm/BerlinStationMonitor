#!/usr/bin/env python3
import argparse
import datetime as dt
import glob
import json
import math
import pathlib
import sqlite3
from collections import defaultdict

PROJECT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_DB_GLOB = PROJECT / "log" / "data" / "bvg_delay_142_123_2026-05-*.sqlite"
DEFAULT_OUT = PROJECT / "models" / "bus142-poststadion-model.json"
LINE_NAME = "142"
POSTSTADION_STOP_ID = "900002256"
MIN_COUNT = 3


def delay_bucket(value):
    if value is None:
        return "missing"
    if value <= -2:
        return "early_2plus"
    if value <= 0:
        return "ontime_or_early"
    if value <= 2:
        return "late_1_2"
    if value <= 5:
        return "late_3_5"
    if value <= 9:
        return "late_6_9"
    return "late_10plus"


def mean(values):
    return sum(values) / len(values) if values else None


def rounded(value):
    if value is None:
        return None
    return round(value, 3)


def add_stat(stats, key, value):
    stats[key].append(float(value))


def finalize_stats(stats):
    out = {}
    for key, values in stats.items():
        if not values:
            continue
        out[key] = {
            "mean": rounded(mean(values)),
            "count": len(values),
        }
    return out


def read_examples(db_path):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT
          s.service_date,
          s.snapshot_key,
          s.target_min,
          s.observed_min,
          d.direction_name,
          target.trip_id,
          target.stop_sequence AS post_sequence,
          target.planned_min AS post_planned_min,
          target.delay_min AS target_delay_min,
          p1.delay_min AS prev1_delay_min,
          p2.delay_min AS prev2_delay_min,
          p3.delay_min AS prev3_delay_min
        FROM observations target
        JOIN snapshots s USING(snapshot_id)
        JOIN lines l ON target.line_id = l.line_id
        JOIN directions d ON target.direction_id = d.direction_id
        LEFT JOIN observations p1
          ON p1.snapshot_id = target.snapshot_id
         AND p1.trip_id = target.trip_id
         AND p1.stop_sequence = target.stop_sequence - 1
        LEFT JOIN observations p2
          ON p2.snapshot_id = target.snapshot_id
         AND p2.trip_id = target.trip_id
         AND p2.stop_sequence = target.stop_sequence - 2
        LEFT JOIN observations p3
          ON p3.snapshot_id = target.snapshot_id
         AND p3.trip_id = target.trip_id
         AND p3.stop_sequence = target.stop_sequence - 3
        WHERE l.line_name = ?
          AND target.stop_id = ?
          AND target.delay_min IS NOT NULL
        ORDER BY s.service_date, s.target_min, d.direction_name, target.trip_id
        """,
        (LINE_NAME, POSTSTADION_STOP_ID),
    ).fetchall()
    con.close()

    examples = []
    for row in rows:
        service_date = row["service_date"]
        if not service_date:
            continue
        date = dt.date.fromisoformat(service_date)
        prev_candidates = [
            row["prev1_delay_min"],
            row["prev2_delay_min"],
            row["prev3_delay_min"],
        ]
        first_prev = next((v for v in prev_candidates if v is not None), None)
        examples.append(
            {
                "service_date": service_date,
                "dow": date.weekday(),
                "hour": int(row["post_planned_min"]) // 60,
                "direction": row["direction_name"],
                "post_sequence": row["post_sequence"],
                "target": int(row["target_delay_min"]),
                "prev1": row["prev1_delay_min"],
                "prev2": row["prev2_delay_min"],
                "prev3": row["prev3_delay_min"],
                "prev_delay": first_prev,
                "prev_bucket": delay_bucket(first_prev),
            }
        )
    return examples


def predict_with_tables(model, ex):
    direction = ex["direction"]
    dow = str(ex["dow"])
    hour = str(ex["hour"])
    bucket = ex.get("prev_bucket") or delay_bucket(ex.get("prev_delay"))
    lookups = model["lookups"]

    if bucket != "missing":
        candidates = [
            ("prevDirectionDowHourBucket", f"{direction}|{dow}|{hour}|{bucket}"),
            ("prevDirectionHourBucket", f"{direction}|{hour}|{bucket}"),
            ("prevDirectionBucket", f"{direction}|{bucket}"),
        ]
        for table, key in candidates:
            entry = lookups[table].get(key)
            if entry and entry["count"] >= MIN_COUNT:
                return entry["mean"], table, entry["count"]

    candidates = [
        ("directionDowHour", f"{direction}|{dow}|{hour}"),
        ("directionHour", f"{direction}|{hour}"),
        ("direction", direction),
    ]
    for table, key in candidates:
        entry = lookups[table].get(key)
        if entry and entry["count"] >= MIN_COUNT:
            return entry["mean"], table, entry["count"]
    return model["globalMean"], "globalMean", model["trainingRows"]


def build_model(examples, validation_date=None):
    train = [ex for ex in examples if ex["service_date"] != validation_date]
    if not train:
        train = examples

    stats = {
        "direction": defaultdict(list),
        "directionHour": defaultdict(list),
        "directionDowHour": defaultdict(list),
        "prevDirectionBucket": defaultdict(list),
        "prevDirectionHourBucket": defaultdict(list),
        "prevDirectionDowHourBucket": defaultdict(list),
    }

    for ex in train:
        direction = ex["direction"]
        dow = str(ex["dow"])
        hour = str(ex["hour"])
        bucket = ex["prev_bucket"]
        target = ex["target"]
        add_stat(stats["direction"], direction, target)
        add_stat(stats["directionHour"], f"{direction}|{hour}", target)
        add_stat(stats["directionDowHour"], f"{direction}|{dow}|{hour}", target)
        if bucket != "missing":
            add_stat(stats["prevDirectionBucket"], f"{direction}|{bucket}", target)
            add_stat(stats["prevDirectionHourBucket"], f"{direction}|{hour}|{bucket}", target)
            add_stat(stats["prevDirectionDowHourBucket"], f"{direction}|{dow}|{hour}|{bucket}", target)

    directions = {}
    for ex in train:
        direction = ex["direction"]
        current = directions.setdefault(
            direction,
            {
                "count": 0,
                "postSequenceCounts": defaultdict(int),
                "usablePrevRows": 0,
            },
        )
        current["count"] += 1
        current["postSequenceCounts"][str(ex["post_sequence"])] += 1
        if ex["prev_delay"] is not None:
            current["usablePrevRows"] += 1

    model = {
        "modelVersion": "142-poststadion-v1",
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "lineName": LINE_NAME,
        "stationId": POSTSTADION_STOP_ID,
        "stationName": "Poststadion (Berlin)",
        "minCount": MIN_COUNT,
        "trainingRows": len(train),
        "excludedRows": len(examples) - len(train),
        "validationDate": validation_date,
        "globalMean": rounded(mean([ex["target"] for ex in train])),
        "directions": {
            name: {
                "count": item["count"],
                "postSequenceCounts": dict(item["postSequenceCounts"]),
                "usablePrevRows": item["usablePrevRows"],
            }
            for name, item in sorted(directions.items())
        },
        "lookups": {name: finalize_stats(table) for name, table in stats.items()},
        "notes": [
            "Prediction target is delay_min at Poststadion for bus 142.",
            "Inference uses the closest available upstream stop delay first, then historical direction/day/hour fallbacks.",
        ],
    }
    return model


def evaluate(model, examples):
    if not examples:
        return {"rows": 0}
    abs_errors = []
    baseline_errors = []
    direction_means = model["lookups"]["direction"]
    for ex in examples:
        pred, _, _ = predict_with_tables(model, ex)
        baseline = direction_means.get(ex["direction"], {}).get("mean", model["globalMean"])
        abs_errors.append(abs(pred - ex["target"]))
        baseline_errors.append(abs(baseline - ex["target"]))
    return {
        "rows": len(examples),
        "mae": rounded(mean(abs_errors)),
        "directionBaselineMae": rounded(mean(baseline_errors)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-glob", default=str(DEFAULT_DB_GLOB))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    paths = sorted(glob.glob(args.db_glob))
    examples = []
    for path in paths:
        examples.extend(read_examples(path))

    dates = sorted({ex["service_date"] for ex in examples})
    validation_date = dates[-1] if dates else None
    validation = [ex for ex in examples if ex["service_date"] == validation_date]
    model = build_model(examples, validation_date=validation_date)
    model["sourceFiles"] = [str(pathlib.Path(p).relative_to(PROJECT)) for p in paths]
    model["allRows"] = len(examples)
    model["validation"] = evaluate(model, validation)

    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "out": str(out_path),
        "sourceFiles": len(paths),
        "allRows": model["allRows"],
        "trainingRows": model["trainingRows"],
        "validation": model["validation"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
