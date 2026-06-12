#!/usr/bin/env python3
"""Inject the TRA timetable into the TDX national GTFS zip (Phase 16.5).

TDX ships TRA stops/agency in the national feed but no timetable (routes/
trips/calendar are absent), and its rail GTFS endpoint only serves TRTC —
so OTP could never plan a TRA leg and every 台鐵 itinerary depended on the
rate-limited TDX MaaS API. This script converts the TRA v3
GeneralTrainTimetable JSON into GTFS rows referencing the feed's existing
`TRA_<StationID>` stops (all timetable stations are present, verified
2026-06-12).

Mapping notes:
  routes.txt    one route per TrainTypeCode (區間/自強/…), route_id TRA_<code>
                so systemFromId() yields "TRA" downstream
  calendar.txt  one service per distinct Mon–Sun pattern; the feed publishes
                EffectiveDate == ExpireDate (a "current version" snapshot),
                so validity runs EffectiveDate → +45 days and relies on the
                weekly rebuild to roll forward. NationalHolidays /
                DayBeforeHoliday flags are NOT expressible in calendar.txt
                and are ignored (same drift class as any static GTFS).
  trips.txt     trip_id TRA_<TrainNo> (unique; trainNoFromTripId() parses
                this), wheelchair_accessible=1 when WheelChairFlag=1, empty
                (unknown) otherwise — 0-flagged trains are NOT marked
                inaccessible, or router-config's 3600s inaccessibleCost
                would funnel wheelchair plans onto the 164 flagged trains.
  stop_times.txt cross-midnight stops emit GTFS 24+h times (25:10:00);
                the offset is detected from decreasing clock values.

Idempotent: re-running first drops previously injected TRA_ rows.

Usage: inject-tra-gtfs.py <feed.zip> <general-train-timetable.json>
"""
import csv
import io
import json
import os
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta

CALENDAR_DAYS = 45
DAY_KEYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
            "Saturday", "Sunday")


def read_rows(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        reader = csv.DictReader(text)
        return reader.fieldnames, list(reader)


def hms(value: str) -> str:
    return value if value.count(":") == 2 else value + ":00"


def minutes_of(value: str) -> int:
    h, m = value.split(":")[:2]
    return int(h) * 60 + int(m)


def plus24(value: str) -> str:
    h, rest = value.split(":", 1)
    return f"{int(h) + 24}:{rest}"


def main(zip_path: str, json_path: str) -> None:
    log = lambda *a: print("[inject-tra-gtfs]", *a)
    data = json.load(open(json_path, encoding="utf-8"))
    timetables = data["TrainTimetables"]

    start = datetime.fromisoformat(data["EffectiveDate"]).date()
    start_date = start.strftime("%Y%m%d")
    end_date = (start + timedelta(days=CALENDAR_DAYS)).strftime("%Y%m%d")

    with zipfile.ZipFile(zip_path) as zf:
        routes_fields, routes = read_rows(zf, "routes.txt")
        trips_fields, trips = read_rows(zf, "trips.txt")
        cal_fields, calendar = read_rows(zf, "calendar.txt")
        st_fields, stop_times = read_rows(zf, "stop_times.txt")
        stop_ids = {r["stop_id"] for r in read_rows(zf, "stops.txt")[1]}

        # Idempotency: strip rows from a previous injection.
        before = (len(routes), len(trips), len(calendar), len(stop_times))
        routes = [r for r in routes if not r["route_id"].startswith("TRA_")]
        trips = [r for r in trips if not r["trip_id"].startswith("TRA_")]
        calendar = [r for r in calendar
                    if not r["service_id"].startswith("TRA_SVC_")]
        stop_times = [r for r in stop_times
                      if not r["trip_id"].startswith("TRA_")]
        stripped = tuple(b - len(x) for b, x in zip(
            before, (routes, trips, calendar, stop_times)))
        if any(stripped):
            log(f"stripped previous injection: routes={stripped[0]} "
                f"trips={stripped[1]} calendar={stripped[2]} "
                f"stop_times={stripped[3]}")

        # trips.txt may lack the optional columns we populate.
        for col in ("trip_headsign", "wheelchair_accessible"):
            if col not in trips_fields:
                trips_fields = list(trips_fields) + [col]

        seen_routes, seen_services = {}, {}
        new_trips, new_st = [], []
        skipped_stations = 0

        for tt in timetables:
            info, days = tt["TrainInfo"], tt["ServiceDay"]
            stops = sorted(tt["StopTimes"], key=lambda s: s["StopSequence"])
            if any(f"TRA_{s['StationID']}" not in stop_ids for s in stops):
                skipped_stations += 1
                continue

            type_code = info["TrainTypeCode"] or info["TrainTypeID"]
            route_id = f"TRA_{type_code}"
            if route_id not in seen_routes:
                name = info["TrainTypeName"]["Zh_tw"]
                seen_routes[route_id] = {
                    "route_id": route_id, "agency_id": "TRA",
                    "route_short_name": name, "route_long_name": name,
                    "route_type": "2",
                }

            bits = "".join(str(days[k]) for k in DAY_KEYS)
            service_id = f"TRA_SVC_{bits}"
            if service_id not in seen_services:
                seen_services[service_id] = {
                    "service_id": service_id,
                    **{k.lower(): str(days[k]) for k in DAY_KEYS},
                    "start_date": start_date, "end_date": end_date,
                }

            trip_id = f"TRA_{info['TrainNo']}"
            new_trips.append({
                "route_id": route_id, "service_id": service_id,
                "trip_id": trip_id, "shape_id": "",
                "direction_id": str(info.get("Direction", 0)),
                "bikes_allowed": "",
                "trip_headsign": info.get("TripHeadSign", ""),
                "wheelchair_accessible":
                    "1" if info.get("WheelChairFlag") == 1 else "",
            })

            offset, prev = False, -1
            for s in stops:
                arr = hms(s.get("ArrivalTime") or s.get("DepartureTime"))
                dep = hms(s.get("DepartureTime") or s.get("ArrivalTime"))
                if minutes_of(arr) < prev:
                    offset = True
                prev = minutes_of(dep)
                if offset:
                    arr, dep = plus24(arr), plus24(dep)
                new_st.append({
                    "trip_id": trip_id, "arrival_time": arr,
                    "departure_time": dep,
                    "stop_id": f"TRA_{s['StationID']}",
                    "stop_sequence": str(s["StopSequence"]),
                })

        log(f"injecting: routes={len(seen_routes)} trips={len(new_trips)} "
            f"services={len(seen_services)} stop_times={len(new_st)} "
            f"calendar {start_date}–{end_date}"
            + (f" (skipped {skipped_stations} trains w/ unknown stations)"
               if skipped_stations else ""))

        rewritten = {
            "routes.txt": (routes_fields, routes + list(seen_routes.values())),
            "trips.txt": (trips_fields, trips + new_trips),
            "calendar.txt": (cal_fields,
                             calendar + list(seen_services.values())),
            "stop_times.txt": (st_fields, stop_times + new_st),
        }
        with tempfile.NamedTemporaryFile(dir=".", suffix=".zip",
                                         delete=False) as tmp:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
                for name in zf.namelist():
                    if name in rewritten:
                        fields, rows = rewritten[name]
                        buf = io.StringIO()
                        w = csv.DictWriter(buf, fieldnames=fields)
                        w.writeheader()
                        w.writerows(rows)
                        out.writestr(name, buf.getvalue())
                    else:
                        out.writestr(name, zf.read(name))
            tmp_path = tmp.name

    os.replace(tmp_path, zip_path)
    log(f"rewrote {zip_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
