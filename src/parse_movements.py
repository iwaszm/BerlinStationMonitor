# src/parse_movements.py

import src.config as cfg

def extract_next_stopover(bus):
    
    stopovers = bus.get("nextStopovers", [])
    next_stop = None

    if stopovers:
        if len(stopovers) > 2:
            next_stop = stopovers[2]
        elif len(stopovers) > 1:
            next_stop = stopovers[1]
        else:
            next_stop = stopovers[0]

    if not next_stop:
        return None, None, None  # name, time_arr, time_parr, delay_minutes

    # ---- next stop ----
    stop_name = next_stop.get("stop", {}).get("name")

    # ---- arrival----
    time_arr = (
        next_stop.get("arrival")
        or ""
    )

    time_parr = (
        next_stop.get("plannedArrival")
        or ""
    )

    # ---- delay，second → minute ----
    delay_sec = (
        next_stop.get("arrivalDelay")
        if next_stop.get("arrivalDelay") is not None
        else next_stop.get("departureDelay")
    )
    #delay_min = round(delay_sec / 60) if delay_sec is not None else 0

    return stop_name, time_arr, time_parr, delay_sec


def extract_bus_movements(data):

    movements = data.get("movements", [])
    results = []

    for bus in movements:
        line = bus.get("line", {})

        if line.get("product") != cfg.LINE_PRODUCT:
            continue
        if line.get("name") != cfg.LINE_NAME:
            continue

        loc = bus.get("location", {})

        next_stop, next_time, next_time_planned, delay_sec = extract_next_stopover(bus)

        results.append({
            "tripId": bus.get("tripId"),
            "line": line.get("name"),
            "direction": bus.get("direction"),
            "lat": loc.get("latitude"),
            "lon": loc.get("longitude"),
            "next_stop": next_stop,
            "next_time": next_time,
            "next_time_planned": next_time_planned,         
            "delay_sec": delay_sec
        })

    return results
