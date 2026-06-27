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

# Script to patch a GTFS static feed zip file with Taiwan City + InterCity DailyTimetable data
# Preserves non-bus (TRA, THSR, Metro) schedules by matching route_type != 3.

CITIES = [
    "Taichung", "Taoyuan", "Keelung", "Hsinchu", "HsinchuCounty", "MiaoliCounty",
    "ChanghuaCounty", "NantouCounty", "YunlinCounty", "ChiayiCounty", "Chiayi",
    "PingtungCounty", "YilanCounty", "HualienCounty", "TaitungCounty", "Kaohsiung",
    "PenghuCounty"
]

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

def process_daily_records_to_gtfs(records, new_trips, new_stop_times, seen_trips, valid_route_ids):
    for route in records:
        route_id = route.get("RouteID")
        if not route_id:
            continue
        
        # Only inject if the RouteID exists in the static GTFS stops/routes mapping
        if route_id not in valid_route_ids:
            continue
            
        direction = route.get("Direction", 0)
        timetables = route.get("TimeTables", [])
        
        for tt in timetables:
            trip_id_raw = tt.get("TripID", "unknown")
            trip_id = f"patched_{route_id}_{direction}_{trip_id_raw}"
            
            if trip_id in seen_trips:
                continue
            seen_trips.add(trip_id)
            
            new_trips.append({
                "route_id": route_id,
                "service_id": "service_today",
                "trip_id": trip_id,
                "direction_id": str(direction)
            })
            
            stop_times = tt.get("StopTimes", [])
            for st in stop_times:
                arr = st.get("ArrivalTime")
                dep = st.get("DepartureTime")
                stop_id = st.get("StopID")
                
                if not arr or not dep or not stop_id:
                    continue
                
                arr_norm = f"{arr}:00" if len(arr) == 5 else arr
                dep_norm = f"{dep}:00" if len(dep) == 5 else dep
                
                new_stop_times.append({
                    "trip_id": trip_id,
                    "arrival_time": arr_norm,
                    "departure_time": dep_norm,
                    "stop_id": stop_id,
                    "stop_sequence": str(st.get("StopSequence"))
                })

def patch_gtfs_zip(zip_path, daily_records, date_str):
    gtfs_date = date_str.replace("-", "")
    
    # 1. Read existing routes to know which ones are bus (route_type == 3)
    route_types = {}
    valid_route_ids = set()
    
    temp_zip_path = zip_path + ".tmp"
    with zipfile.ZipFile(zip_path, "r") as zin:
        if "routes.txt" in zin.namelist():
            with zin.open("routes.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                for row in reader:
                    route_types[row["route_id"]] = row.get("route_type")
                    valid_route_ids.add(row["route_id"])
        
        # 2. Extract and preserve all non-bus (TRA, THSR, Metro) trips
        kept_trips = []
        kept_trip_ids = set()
        if "trips.txt" in zin.namelist():
            with zin.open("trips.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                for row in reader:
                    route_id = row["route_id"]
                    # If it's not a bus (type 3), keep it!
                    if route_types.get(route_id) != "3":
                        kept_trips.append(row)
                        kept_trip_ids.add(row["trip_id"])
                        
        # 3. Extract and preserve all non-bus stop times
        kept_stop_times = []
        if "stop_times.txt" in zin.namelist():
            with zin.open("stop_times.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                for row in reader:
                    if row["trip_id"] in kept_trip_ids:
                        kept_stop_times.append(row)
                        
        # 4. Extract all calendar dates
        kept_calendar_dates = []
        if "calendar_dates.txt" in zin.namelist():
            with zin.open("calendar_dates.txt") as f:
                text = io.TextIOWrapper(f, encoding="utf-8-sig")
                reader = csv.DictReader(text)
                for row in reader:
                    kept_calendar_dates.append(row)

    print(f"Preserved {len(kept_trips)} non-bus trips and {len(kept_stop_times)} non-bus stop times.")

    # 5. Parse daily bus records
    new_trips = []
    new_stop_times = []
    seen_trips = set()
    process_daily_records_to_gtfs(daily_records, new_trips, new_stop_times, seen_trips, valid_route_ids)
    print(f"Generated {len(new_trips)} new daily bus trips and {len(new_stop_times)} new stop times.")

    # 6. Combine kept non-bus + new daily bus data
    final_trips = kept_trips + new_trips
    final_stop_times = kept_stop_times + new_stop_times
    final_calendar_dates = kept_calendar_dates + [
        {"service_id": "service_today", "date": gtfs_date, "exception_type": "1"}
    ]

    # 7. Rewrite Zip
    with zipfile.ZipFile(zip_path, "r") as zin:
        with zipfile.ZipFile(temp_zip_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename in ("trips.txt", "stop_times.txt", "calendar_dates.txt"):
                    continue
                zout.writestr(item, zin.read(item.filename))
            
            # Write trips.txt
            trips_out = io.StringIO()
            trips_writer = csv.DictWriter(trips_out, fieldnames=["route_id", "service_id", "trip_id", "direction_id"])
            trips_writer.writeheader()
            trips_writer.writerows(final_trips)
            zout.writestr("trips.txt", trips_out.getvalue())
            
            # Write stop_times.txt
            st_out = io.StringIO()
            st_writer = csv.DictWriter(st_out, fieldnames=["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"])
            st_writer.writeheader()
            st_writer.writerows(final_stop_times)
            zout.writestr("stop_times.txt", st_out.getvalue())
            
            # Write calendar_dates.txt
            cd_out = io.StringIO()
            cd_writer = csv.DictWriter(cd_out, fieldnames=["service_id", "date", "exception_type"])
            cd_writer.writeheader()
            cd_writer.writerows(final_calendar_dates)
            zout.writestr("calendar_dates.txt", cd_out.getvalue())
            
    os.replace(temp_zip_path, zip_path)
    print("GTFS zip successfully patched with daily timetables!")

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
    
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    print(f"Targeting Daily Timetable date: {today_str}")
    
    daily_records = []
    
    # 1. Fetch InterCity (公路客運)
    print("\nStep 2: Fetching InterCity (公路客運) Daily Timetable...")
    intercity_url = "https://tdx.transportdata.tw/api/basic/v2/Bus/DailyTimeTable/InterCity?%24format=JSON"
    daily_records.extend(fetch_paginated_api(token, intercity_url))
    
    # 2. Fetch City Bus for all 22 cities
    print("\nStep 3: Fetching City Bus (各縣市市區公車) Daily Timetables...")
    for city in CITIES:
        print(f"  Fetching {city} Daily Timetable...")
        city_url = f"https://tdx.transportdata.tw/api/basic/v2/Bus/DailyTimeTable/City/{city}?%24format=JSON"
        daily_records.extend(fetch_paginated_api(token, city_url))
        time.sleep(0.5)
        
    print(f"\nStep 4: Patching {zip_path} with {len(daily_records)} total daily routes...")
    patch_gtfs_zip(zip_path, daily_records, today_str)

if __name__ == "__main__":
    main()
