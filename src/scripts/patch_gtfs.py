#!/usr/bin/env python3
import os
import sys
import csv
import io
import json
import zipfile
import datetime
import urllib.request
import urllib.parse
import time

# Script to patch a GTFS static feed zip file with Taiwan City + InterCity bus
# GeneralTimetable (定期班表) data. The regular timetable carries per-trip
# ServiceDay week flags, so patched trips are written as weekly calendar.txt
# services valid for CALENDAR_VALID_DAYS — unlike the former DailyTimetable
# patch whose single-date calendar expired the day after the graph was built.
# Some cities (Taichung, Taoyuan, …) publish origin-departure-only general
# timetables (a single StopTime per trip); for those the city's DailyTimetable
# is fetched as well and its per-stop travel-time profile is grafted onto the
# general timetable's origin time + ServiceDay to synthesise full stop_times.
# Preserves non-bus (TRA, THSR, Metro) schedules by matching route_type != 3.

CITIES = [
    "Taichung", "Taoyuan", "Keelung", "Hsinchu", "HsinchuCounty", "MiaoliCounty",
    "ChanghuaCounty", "NantouCounty", "YunlinCounty", "ChiayiCounty", "Chiayi",
    "PingtungCounty", "YilanCounty", "HualienCounty", "TaitungCounty", "Kaohsiung",
    "PenghuCounty"
]

CALENDAR_VALID_DAYS = 180

# TDX ServiceDay keys in GTFS calendar.txt column order (monday..sunday).
WEEKDAY_KEYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
GTFS_WEEKDAY_COLS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

def get_tdx_token(client_id, client_secret):
    url = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret
    }).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    for retry in range(3):
        try:
            with urllib.request.urlopen(req) as res:
                res_data = json.loads(res.read().decode("utf-8"))
                return res_data["access_token"]
        except Exception as e:
            print(f"Error getting TDX token (attempt {retry+1}): {e}")
            time.sleep(2)
    sys.exit(1)

def fetch_paginated_api(token, url_template):
    records = []
    top = 1000
    skip = 0

    while True:
        url = f"{url_template}&%24top={top}&%24skip={skip}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "accept": "application/json"})

        success = False
        for retry in range(5):
            try:
                with urllib.request.urlopen(req) as res:
                    page_data = json.loads(res.read().decode("utf-8"))
                    if not isinstance(page_data, list):
                        page_data = []
                    records.extend(page_data)
                    page_size = len(page_data)
                    success = True
                    break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    backoff = 2 * (retry + 1)
                    print(f"  Received 429 Too Many Requests. Backing off for {backoff}s...")
                    time.sleep(backoff)
                else:
                    print(f"  HTTP error {e.code}: {e.reason}")
                    time.sleep(1)
            except Exception as e:
                print(f"  Network error: {e}")
                time.sleep(1)

        if not success:
            print(f"  Failed to fetch page at skip={skip} after multiple retries. Skipping remaining pages.")
            break

        if page_size < top:
            break

        skip += top
        time.sleep(0.1)

    return records

def service_id_for_pattern(pattern):
    return "patched_" + "".join(str(d) for d in pattern)

def parse_hhmm(value):
    if not value:
        return None
    parts = value.split(":")
    if len(parts) < 2:
        return None
    try:
        return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return None

def fmt_gtfs_time(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}:00"

def valid_stop_entries(timetable):
    entries = []
    for st in timetable.get("StopTimes") or []:
        arr = st.get("ArrivalTime") or st.get("DepartureTime")
        dep = st.get("DepartureTime") or st.get("ArrivalTime")
        stop_id = st.get("StopUID") or st.get("StopID")
        if arr and dep and stop_id:
            entries.append((arr, dep, stop_id, st.get("StopSequence")))
    return entries

def needs_daily_fallback(records):
    for route in records:
        for tt in route.get("Timetables") or route.get("TimeTables") or []:
            if len(valid_stop_entries(tt)) == 1:
                return True
    return False

def normalize_stop_entries(entries):
    """Sorts by stop_sequence (GTFS ordering; TDX occasionally ships the array
    out of order), unrolls midnight wraps and clamps minute-level time jitter
    so times are monotonic. Returns [(stop_id, seq, arr_min, dep_min)] in
    absolute minutes, or None when any time is unparsable."""
    def seq_key(entry):
        try:
            return int(entry[3])
        except (TypeError, ValueError):
            return 0
    entries = sorted(entries, key=seq_key)
    prev = parse_hhmm(entries[0][0])
    if prev is None:
        return None
    out = []
    for arr_raw, dep_raw, stop_id, seq in entries:
        arr = parse_hhmm(arr_raw)
        dep = parse_hhmm(dep_raw)
        if arr is None or dep is None:
            return None
        # A large backwards jump is a midnight wrap; a small one is data
        # jitter and gets clamped.
        if arr < prev - 720:
            arr += 1440
        if dep < arr - 720:
            dep += 1440
        arr = max(arr, prev)
        dep = max(dep, arr)
        prev = dep
        out.append((stop_id, seq, arr, dep))
    return out

def build_daily_profiles(daily_records):
    profiles = {}
    for route in daily_records:
        key_uid = route.get("SubRouteUID") or route.get("RouteUID")
        direction = route.get("Direction", 0)
        if not key_uid:
            continue
        for tt in route.get("Timetables") or route.get("TimeTables") or []:
            entries = valid_stop_entries(tt)
            if len(entries) < 2:
                continue
            norm = normalize_stop_entries(entries)
            if not norm:
                continue
            origin = norm[0][3]
            stops = [(stop_id, seq, arr - origin, dep - origin) for stop_id, seq, arr, dep in norm]
            profiles.setdefault((key_uid, direction), []).append({"origin": origin, "stops": stops})
    return profiles

def synthesize_stop_rows(trip_id, timetable, key_uids, direction, daily_profiles):
    entries = valid_stop_entries(timetable)
    if len(entries) != 1:
        return None
    origin = parse_hhmm(entries[0][1])
    if origin is None:
        return None
    plist = None
    for key_uid in key_uids:
        if key_uid:
            plist = daily_profiles.get((key_uid, direction))
            if plist:
                break
    if not plist:
        return None
    profile = min(plist, key=lambda p: abs(p["origin"] - origin))
    rows = []
    for stop_id, seq, arr_off, dep_off in profile["stops"]:
        rows.append({
            "trip_id": trip_id,
            "arrival_time": fmt_gtfs_time(origin + arr_off),
            "departure_time": fmt_gtfs_time(origin + dep_off),
            "stop_id": stop_id,
            "stop_sequence": str(seq)
        })
    return rows

def process_schedule_records_to_gtfs(records, new_trips, new_stop_times, seen_trips, route_list, route_ids_set, service_patterns, stats, daily_profiles, route_shape_by_route):
    for route in records:
        route_uid = route.get("RouteUID")
        sub_route_uid = route.get("SubRouteUID")
        route_id_tdx = route.get("RouteID")
        name = route.get("RouteName", {}).get("Zh_tw")
        direction = route.get("Direction", 0)

        suffix = f"_{direction}"
        matched_id = None

        # 1. Match by RouteUID + Direction
        if route_uid:
            exact = f"{route_uid}{suffix}"
            if exact in route_ids_set:
                matched_id = exact
            else:
                for r_id in route_ids_set:
                    if r_id.startswith(route_uid) and r_id.endswith(suffix):
                        matched_id = r_id
                        break

        # 2. Match by SubRouteUID + Direction
        if not matched_id and sub_route_uid:
            exact = f"{sub_route_uid}{suffix}"
            if exact in route_ids_set:
                matched_id = exact
            else:
                for r_id in route_ids_set:
                    if r_id.startswith(sub_route_uid) and r_id.endswith(suffix):
                        matched_id = r_id
                        break

        # 3. Match by RouteName / RouteID
        if not matched_id:
            for r in route_list:
                r_id = r["route_id"]
                r_short = r.get("route_short_name")
                if r_short == name or r_short == route_id_tdx:
                    if r_id.endswith(suffix):
                        matched_id = r_id
                        break

        if not matched_id:
            continue

        timetables = route.get("Timetables") or route.get("TimeTables") or []
        if not timetables:
            # Headway-only subroutes carry no StopTimes, so no GTFS trip can be
            # synthesised from the Schedule API alone.
            if route.get("Frequencys"):
                stats["freq_only"] += 1
            continue

        record_key = sub_route_uid or route_uid or route_id_tdx or "unknown"
        operator_no = route.get("OperatorNo") or ""

        for tt in timetables:
            service_day = tt.get("ServiceDay") or {}
            pattern = tuple(1 if service_day.get(k) else 0 for k in WEEKDAY_KEYS)
            if not any(pattern):
                stats["no_service_day"] += 1
                continue

            trip_id_raw = tt.get("TripID", "unknown")
            trip_id = f"patched_{matched_id}_{record_key}_{operator_no}_{trip_id_raw}"

            if trip_id in seen_trips:
                stats["dup_trip"] += 1
                continue

            entries = valid_stop_entries(tt)
            norm = normalize_stop_entries(entries) if len(entries) >= 2 else None
            if norm:
                stop_rows = [{
                    "trip_id": trip_id,
                    "arrival_time": fmt_gtfs_time(arr),
                    "departure_time": fmt_gtfs_time(dep),
                    "stop_id": stop_id,
                    "stop_sequence": str(seq)
                } for stop_id, seq, arr, dep in norm]
            else:
                # OTP rejects 0/1-stop trips; origin-only timetables are
                # grafted onto the daily travel-time profile when one exists.
                synth = synthesize_stop_rows(trip_id, tt, (sub_route_uid, route_uid), direction, daily_profiles)
                if synth:
                    stop_rows = synth
                    stats["synthesized"] += 1
                else:
                    stats["short_trip"] += 1
                    continue

            seen_trips.add(trip_id)
            service_patterns.add(pattern)
            shape_id = route_shape_by_route.get(matched_id, "")
            if not shape_id:
                stats["missing_shape"] += 1
            new_trips.append({
                "route_id": matched_id,
                "service_id": service_id_for_pattern(pattern),
                "trip_id": trip_id,
                "shape_id": shape_id,
                "direction_id": str(direction)
            })
            new_stop_times.extend(stop_rows)

def patch_gtfs_zip(zip_path, schedule_records, daily_records, start_date):
    cal_start = start_date.strftime("%Y%m%d")
    cal_end = (start_date + datetime.timedelta(days=CALENDAR_VALID_DAYS)).strftime("%Y%m%d")

    # 1. Read existing routes to know which ones are bus (route_type == 3)
    route_types = {}
    route_list = []
    route_ids_set = set()

    trips_fields = ["route_id", "service_id", "trip_id", "direction_id"]
    st_fields = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]
    cd_fields = ["service_id", "date", "exception_type"]
    cal_fields = ["service_id"] + GTFS_WEEKDAY_COLS + ["start_date", "end_date"]

    temp_zip_path = zip_path + ".tmp"
    with zipfile.ZipFile(zip_path, "r") as zin:
        if "routes.txt" in zin.namelist():
            with zin.open("routes.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                for row in reader:
                    route_types[row["route_id"]] = row.get("route_type")
                    route_list.append(row)
                    route_ids_set.add(row["route_id"])

        # 2. Extract and preserve all non-bus (TRA, THSR, Metro) trips
        kept_trips = []
        kept_trip_ids = set()
        route_shape_by_route = {}
        if "trips.txt" in zin.namelist():
            with zin.open("trips.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    trips_fields = reader.fieldnames
                for row in reader:
                    route_id = row["route_id"]
                    if route_types.get(route_id) != "3":
                        kept_trips.append(row)
                        kept_trip_ids.add(row["trip_id"])
                    elif row.get("shape_id") and route_id not in route_shape_by_route:
                        route_shape_by_route[route_id] = row["shape_id"]

        # 3. Extract and preserve all non-bus stop times
        kept_stop_times = []
        if "stop_times.txt" in zin.namelist():
            with zin.open("stop_times.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    st_fields = reader.fieldnames
                for row in reader:
                    if row["trip_id"] in kept_trip_ids:
                        kept_stop_times.append(row)

        # 4. Extract calendar dates, dropping the legacy single-day patch service
        kept_calendar_dates = []
        if "calendar_dates.txt" in zin.namelist():
            with zin.open("calendar_dates.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    cd_fields = reader.fieldnames
                for row in reader:
                    if row.get("service_id") == "service_today":
                        continue
                    kept_calendar_dates.append(row)

        # 5. Extract weekly calendar, dropping rows from a previous patch run
        kept_calendar = []
        if "calendar.txt" in zin.namelist():
            with zin.open("calendar.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                if reader.fieldnames:
                    cal_fields = reader.fieldnames
                for row in reader:
                    if (row.get("service_id") or "").startswith("patched_"):
                        continue
                    kept_calendar.append(row)

    print(f"Preserved {len(kept_trips)} non-bus trips and {len(kept_stop_times)} non-bus stop times.")

    # 6. Parse schedule records into weekly-service trips
    new_trips = []
    new_stop_times = []
    seen_trips = set()
    service_patterns = set()
    stats = {"freq_only": 0, "no_service_day": 0, "dup_trip": 0, "short_trip": 0, "synthesized": 0, "missing_shape": 0}
    daily_profiles = build_daily_profiles(daily_records)
    process_schedule_records_to_gtfs(schedule_records, new_trips, new_stop_times, seen_trips, route_list, route_ids_set, service_patterns, stats, daily_profiles, route_shape_by_route)
    print(f"Generated {len(new_trips)} new bus trips and {len(new_stop_times)} new stop times "
          f"({len(service_patterns)} weekly service patterns, valid {cal_start}–{cal_end}; "
          f"{stats['synthesized']} trips synthesized from daily travel-time profiles; "
          f"{stats['missing_shape']} trips without original shape_id).")
    print(f"Skipped: {stats['freq_only']} frequency-only subroutes (no StopTimes), "
          f"{stats['no_service_day']} timetables with no service day, "
          f"{stats['dup_trip']} duplicate trips, {stats['short_trip']} trips with < 2 stops and no daily profile.")

    # 7. Combine kept non-bus + new bus data
    final_trips = kept_trips + new_trips
    final_stop_times = kept_stop_times + new_stop_times

    final_calendar = kept_calendar
    for pattern in sorted(service_patterns):
        row = {"service_id": service_id_for_pattern(pattern), "start_date": cal_start, "end_date": cal_end}
        for col, active in zip(GTFS_WEEKDAY_COLS, pattern):
            row[col] = str(active)
        final_calendar.append(row)

    # 8. Rewrite Zip
    with zipfile.ZipFile(zip_path, "r") as zin:
        with zipfile.ZipFile(temp_zip_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename in ("trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"):
                    continue
                zout.writestr(item, zin.read(item.filename))

            # Write trips.txt
            trips_out = io.StringIO()
            trips_writer = csv.DictWriter(trips_out, fieldnames=trips_fields, extrasaction='ignore')
            trips_writer.writeheader()
            trips_writer.writerows(final_trips)
            zout.writestr("trips.txt", trips_out.getvalue())

            # Write stop_times.txt
            st_out = io.StringIO()
            st_writer = csv.DictWriter(st_out, fieldnames=st_fields, extrasaction='ignore')
            st_writer.writeheader()
            st_writer.writerows(final_stop_times)
            zout.writestr("stop_times.txt", st_out.getvalue())

            # Write calendar.txt
            cal_out = io.StringIO()
            cal_writer = csv.DictWriter(cal_out, fieldnames=cal_fields, extrasaction='ignore')
            cal_writer.writeheader()
            cal_writer.writerows(final_calendar)
            zout.writestr("calendar.txt", cal_out.getvalue())

            # Write calendar_dates.txt
            cd_out = io.StringIO()
            cd_writer = csv.DictWriter(cd_out, fieldnames=cd_fields, extrasaction='ignore')
            cd_writer.writeheader()
            cd_writer.writerows(kept_calendar_dates)
            zout.writestr("calendar_dates.txt", cd_out.getvalue())

    os.replace(temp_zip_path, zip_path)
    print("GTFS zip successfully patched with general (weekly) timetables!")

def main():
    client_id = os.environ.get("TDX_CLIENT_ID")
    client_secret = os.environ.get("TDX_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("Missing TDX credentials in env.")
        sys.exit(1)

    if len(sys.argv) < 2:
        print("Usage: patch_gtfs.py <gtfs_feed.zip>")
        sys.exit(1)

    zip_path = sys.argv[1]
    if not os.path.exists(zip_path):
        print(f"GTFS zip file {zip_path} not found.")
        sys.exit(1)

    print("Step 1: Obtaining TDX Access Token...")
    token = get_tdx_token(client_id, client_secret)

    today = datetime.date.today()
    print(f"Calendar validity: {today} + {CALENDAR_VALID_DAYS} days")

    schedule_records = []
    daily_records = []

    def fetch_source(label, schedule_url, daily_url):
        records = fetch_paginated_api(token, schedule_url)
        schedule_records.extend(records)
        if needs_daily_fallback(records):
            print(f"  {label}: origin-only general timetables detected — fetching Daily Timetable fallback...")
            daily_records.extend(fetch_paginated_api(token, daily_url))
            time.sleep(0.5)

    # 1. Fetch InterCity (公路客運)
    print("\nStep 2: Fetching InterCity (公路客運) General Timetable...")
    fetch_source(
        "InterCity",
        "https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/InterCity?%24format=JSON",
        "https://tdx.transportdata.tw/api/basic/v2/Bus/DailyTimeTable/InterCity?%24format=JSON",
    )

    # 2. Fetch City Bus for all 17 supported cities
    print("\nStep 3: Fetching City Bus (各縣市市區公車) General Timetables...")
    for city in CITIES:
        print(f"  Fetching {city} General Timetable...")
        fetch_source(
            city,
            f"https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/City/{city}?%24format=JSON",
            f"https://tdx.transportdata.tw/api/basic/v2/Bus/DailyTimeTable/City/{city}?%24format=JSON",
        )
        time.sleep(0.5)

    print(f"\nStep 4: Patching {zip_path} with {len(schedule_records)} schedule records "
          f"(+ {len(daily_records)} daily fallback records)...")
    patch_gtfs_zip(zip_path, schedule_records, daily_records, today)

if __name__ == "__main__":
    main()
