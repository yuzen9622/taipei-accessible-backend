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
import urllib.error
import time

# Script to patch a GTFS static feed zip file with Taiwan City + InterCity bus
# GeneralTimetable (定期班表) data and shape geometry. The regular timetable
# carries per-trip ServiceDay week flags, so patched trips are written as weekly
# calendar.txt services valid for CALENDAR_VALID_DAYS. Some cities (Taichung,
# Taoyuan, …) publish origin-departure-only general timetables (a single StopTime
# per trip); for those the city's DailyTimetable is fetched as well and its
# per-stop travel-time profile is grafted onto the general timetable's origin
# time + ServiceDay to synthesise full stop_times. Also, shape geometry is fetched
# from the TDX Bus Shape API to populate shapes.txt for routes missing shapes.
# Preserves non-bus (TRA, THSR, Metro) schedules by matching route_type != 3.

CITIES = [
    "Taipei", "NewTaipei", "Tainan", "KinmenCounty", "LienchiangCounty",
    "Taichung", "Taoyuan", "Keelung", "Hsinchu", "HsinchuCounty", "MiaoliCounty",
    "ChanghuaCounty", "NantouCounty", "YunlinCounty", "ChiayiCounty", "Chiayi",
    "PingtungCounty", "YilanCounty", "HualienCounty", "TaitungCounty", "Kaohsiung",
    "PenghuCounty"
]

CALENDAR_VALID_DAYS = 180

# Socket timeout (seconds) for every TDX request, so a half-open connection
# cannot hang the batch indefinitely.
REQUEST_TIMEOUT = 60

# TDX ServiceDay keys in GTFS calendar.txt column order (monday..sunday).
WEEKDAY_KEYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
GTFS_WEEKDAY_COLS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

# Transport-layer exceptions that are transient and worth retrying (a socket
# timeout raised by urlopen()/read() surfaces as one of these).
TRANSPORT_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError, OSError)


class DailyTimetableUnavailable(Exception):
    """Business signal that a source has no usable per-stop daily timetable —
    either HTTP 400 on both v2 and v3, or a structurally valid response with no
    timetable carrying >=2 stops (empty / origin-only). This is the only signal
    that triggers the StopOfRoute synthesis fallback."""


class TdxFetchError(Exception):
    """Fatal, non-degradable fetch failure: 5xx after retries, transport error
    after retries, JSON parse failure, or v3 wrapper schema drift (missing key,
    wrong type, non-dict element). Propagates so the import exits non-zero
    rather than pretending success."""


class TdxHttpError(TdxFetchError):
    """A 4xx HTTP error (including 400) carrying the response body. e.read()
    consumes the stream and the default HTTPError string omits the body, so we
    capture status/reason/url/body for diagnostics. The version cascade branches
    on .status to detect 400; any TdxHttpError not interpreted by the cascade is
    fatal (subclass of TdxFetchError)."""

    def __init__(self, status, reason, url, body):
        self.status = status
        self.reason = reason
        self.url = url
        self.body = body or ""
        super().__init__(f"HTTP {status} {reason} @ {url} :: {self.body[:200]}")


def daily_records_usable(records):
    """True when at least one route carries a timetable with >=2 valid stops,
    i.e. the batch can graft a real per-stop profile onto an origin-only route.
    This is a batch-level check: a source that yields any usable profile is
    accepted, and routes lacking one are skipped as short_trip downstream."""
    for route in records or []:
        for tt in (route.get("Timetables") or route.get("TimeTables") or []):
            if len(valid_stop_entries(tt)) >= 2:
                return True
    return False


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
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
                res_data = json.loads(res.read().decode("utf-8"))
                return res_data["access_token"]
        except Exception as e:
            print(f"Error getting TDX token (attempt {retry+1}): {e}", file=sys.stderr)
            time.sleep(2)
    sys.exit(1)

def _unwrap_page(body, page_key, skip, strict):
    """Extract the record list from a decoded page body. v2 endpoints return a
    bare list; v3 endpoints wrap it as {..., <page_key>: [...]}. In strict mode
    a shape mismatch (schema drift) raises TdxFetchError; in legacy (non-strict)
    mode it degrades to an empty page as the original code did."""
    if page_key is None:
        if isinstance(body, list):
            records = body
        elif strict:
            raise TdxFetchError(f"expected top-level list at skip={skip}, got {type(body).__name__}")
        else:
            return []
    else:
        if not isinstance(body, dict):
            if strict:
                raise TdxFetchError(f"expected wrapper object for '{page_key}' at skip={skip}, got {type(body).__name__}")
            return []
        if page_key not in body:
            if strict:
                raise TdxFetchError(f"v3 wrapper missing key '{page_key}' at skip={skip} (schema drift)")
            return []
        inner = body[page_key]
        if not isinstance(inner, list):
            if strict:
                raise TdxFetchError(f"v3 wrapper '{page_key}' is {type(inner).__name__}, not list, at skip={skip}")
            return []
        records = inner

    if strict:
        for idx, rec in enumerate(records):
            if not isinstance(rec, dict):
                raise TdxFetchError(
                    f"non-dict element in '{page_key or 'list'}' at skip={skip}, index {idx}: {type(rec).__name__}")
    return records


def fetch_paginated_api(token, url_template, page_key=None, strict=False):
    records = []
    top = 1000
    skip = 0

    while True:
        parsed_url = urllib.parse.urlparse(url_template)
        encoded_path = urllib.parse.quote(parsed_url.path)
        query_parts = urllib.parse.parse_qsl(parsed_url.query)
        query_map = dict(query_parts)
        query_map["$top"] = str(top)
        query_map["$skip"] = str(skip)
        encoded_query = urllib.parse.urlencode(query_map, safe="=&?$")

        url = urllib.parse.urlunparse((
            parsed_url.scheme,
            parsed_url.netloc,
            encoded_path,
            parsed_url.params,
            encoded_query,
            parsed_url.fragment
        ))

        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "accept": "application/json"})

        success = False
        for retry in range(5):
            try:
                with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
                    raw = res.read().decode("utf-8")
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError as e:
                    if strict:
                        raise TdxFetchError(f"invalid JSON at skip={skip}: {e}") from e
                    body = []
                page_data = _unwrap_page(body, page_key, skip, strict)
                records.extend(page_data)
                page_size = len(page_data)
                success = True
                break
            except TdxFetchError:
                # Deterministic contract errors (parse / schema drift / re-raised
                # TdxHttpError) are never transient — surface immediately.
                raise
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    backoff = 2 * (retry + 1)
                    print(f"  Received 429 Too Many Requests. Backing off for {backoff}s...", file=sys.stderr)
                    time.sleep(backoff)
                elif 400 <= e.code < 500:
                    try:
                        body = e.read().decode("utf-8", errors="replace")
                    except TRANSPORT_ERRORS:
                        body = ""
                    print(f"  HTTP error {e.code}: {e.reason} :: {body[:200]}", file=sys.stderr)
                    raise TdxHttpError(e.code, e.reason, url, body) from e
                else:
                    print(f"  HTTP error {e.code}: {e.reason}", file=sys.stderr)
                    time.sleep(1)
            except TRANSPORT_ERRORS as e:
                print(f"  Network error: {e}", file=sys.stderr)
                time.sleep(1)

        if not success:
            if strict:
                raise TdxFetchError(f"failed to fetch page at skip={skip} after {5} retries (5xx/transport)")
            print(f"  Failed to fetch page at skip={skip} after multiple retries. Skipping remaining pages.", file=sys.stderr)
            break

        if page_size < top:
            break

        skip += top
        time.sleep(0.1)

    return records

_TDX_BASE = "https://tdx.transportdata.tw/api/basic"


def V2_SCHED(city):
    return f"{_TDX_BASE}/v2/Bus/Schedule/City/{city}?%24format=JSON"


def V3_SCHED(city):
    return f"{_TDX_BASE}/v3/Bus/Schedule/City/{city}?%24format=JSON"


def V2_DAILY(city):
    return f"{_TDX_BASE}/v2/Bus/DailyTimeTable/City/{city}?%24format=JSON"


def V3_DAILY(city):
    return f"{_TDX_BASE}/v3/Bus/DailyTimeTable/City/{city}?%24format=JSON"


def V2_SHAPE(city):
    return f"{_TDX_BASE}/v2/Bus/Shape/City/{city}?%24format=JSON"


def V2_STOP_OF_ROUTE(city):
    return f"{_TDX_BASE}/v2/Bus/StopOfRoute/City/{city}?%24format=JSON"


V2_SCHED_INTERCITY = f"{_TDX_BASE}/v2/Bus/Schedule/InterCity?%24format=JSON"
V2_DAILY_INTERCITY = f"{_TDX_BASE}/v2/Bus/DailyTimeTable/InterCity?%24format=JSON"
V2_SHAPE_INTERCITY = f"{_TDX_BASE}/v2/Bus/Shape/InterCity?%24format=JSON"
V2_STOP_OF_ROUTE_INTERCITY = f"{_TDX_BASE}/v2/Bus/StopOfRoute/InterCity?%24format=JSON"


def fetch_with_version(token, v2_url, v3_url, page_key):
    """Fetch a source, falling back v2 -> v3 on HTTP 400 only. Returns
    (records, source) where source is "v2" or "v3". A 400 from both versions
    re-raises the v3 TdxHttpError (carrying the v3 body); any non-400 HTTP
    error and every other TdxFetchError propagate as fatal. Suitable for
    sources with no usability concept (e.g. Schedule)."""
    try:
        return fetch_paginated_api(token, v2_url, strict=True), "v2"
    except TdxHttpError as e:
        if e.status != 400:
            raise
    return fetch_paginated_api(token, v3_url, page_key=page_key, strict=True), "v3"


def fetch_city_schedule(token, city):
    """Schedule for a city, v2 -> v3. Both versions 400 means the city has
    vanished from TDX entirely (the original incident), so it is fatal rather
    than a silent skip."""
    try:
        return fetch_with_version(token, V2_SCHED(city), V3_SCHED(city), "Schedules")
    except TdxHttpError as e:
        if e.status == 400:
            raise TdxFetchError(
                f"{city}: Schedule returned 400 on both v2 and v3 — the city may have been "
                f"removed from TDX; aborting so patch_gtfs_zip does not overwrite the feed "
                f"without it. TDX body: {e.body[:200]}") from e
        raise


def fetch_daily_timetable(token, city):
    """Daily timetable for a city with a usability-aware cascade: v2 -> v3 when
    v2 is 400 OR returns a structurally-valid but unusable batch (empty /
    origin-only). Returns (records, source). Raises DailyTimetableUnavailable
    (the only signal that triggers StopOfRoute synthesis) when neither version
    yields a usable batch; non-400 HTTP and schema-drift errors stay fatal."""
    try:
        recs = fetch_paginated_api(token, V2_DAILY(city), strict=True)
        if daily_records_usable(recs):
            return recs, "v2"
    except TdxHttpError as e:
        if e.status != 400:
            raise
    try:
        recs = fetch_paginated_api(token, V3_DAILY(city), page_key="DailyTimeTables", strict=True)
    except TdxHttpError as e:
        if e.status == 400:
            raise DailyTimetableUnavailable(f"{city}: DailyTimeTable unavailable (400 on v2 and v3)") from e
        raise
    if not daily_records_usable(recs):
        raise DailyTimetableUnavailable(
            f"{city}: DailyTimeTable structurally valid on v2/v3 but has no usable per-stop timetable (empty/origin-only)")
    return recs, "v3"


def fetch_intercity_daily(token):
    """InterCity daily timetable (v2 only), symmetric with the City cascade: a
    400 or a valid-but-unusable batch degrades to StopOfRoute synthesis; other
    errors stay fatal."""
    try:
        recs = fetch_paginated_api(token, V2_DAILY_INTERCITY, strict=True)
    except TdxHttpError as e:
        if e.status == 400:
            raise DailyTimetableUnavailable("InterCity: DailyTimeTable unavailable (400)") from e
        raise
    if not daily_records_usable(recs):
        raise DailyTimetableUnavailable("InterCity: DailyTimeTable has no usable per-stop timetable")
    return recs, "v2"


def fetch_stop_of_route(token, url):
    """StopOfRoute for the DailyTimeTable degradation path. Tolerates a 400
    (source also unsupported) by returning []; every other error is fatal."""
    try:
        return fetch_paginated_api(token, url, strict=True)
    except TdxHttpError as e:
        if e.status == 400:
            print("  StopOfRoute unsupported (400) — skipping daily for this source", file=sys.stderr)
            return []
        raise


def fetch_shape(token, url):
    """Shape geometry (v2). Tolerates a 400 (missing geometry is non-fatal) by
    returning []; 5xx/transport/parse errors are fatal via strict mode."""
    try:
        return fetch_paginated_api(token, url, strict=True)
    except TdxHttpError as e:
        if e.status == 400:
            print("  Shape unsupported (400) — skipping geometry", file=sys.stderr)
            return []
        raise


def _synthesize_from_stop_of_route(sor_records):
    """Build v2-compatible daily records from StopOfRoute stop sequences, giving
    each stop a synthetic 2-min-per-stop travel-time profile. Only routes with
    >=2 usable stops are emitted (a 1-stop profile is never consumed by
    build_daily_profiles and would misreport as synthesized)."""
    synthetic = []
    for r in sor_records:
        ruid = r.get("RouteUID")
        sub_route_uid = r.get("SubRouteUID") or ruid
        direction = r.get("Direction", 0)
        stops = r.get("Stops", [])
        if not (ruid and stops):
            continue

        def seq_key(s):
            try:
                return int(s.get("StopSequence", 0))
            except (TypeError, ValueError):
                return 0

        sorted_stops = sorted(stops, key=seq_key)
        stop_times = []
        for i, s in enumerate(sorted_stops):
            stop_id = s.get("StopUID") or s.get("StopID")
            seq = s.get("StopSequence", i + 1)
            if stop_id:
                offset_min = i * 2
                time_str = f"{offset_min // 60:02d}:{offset_min % 60:02d}"
                stop_times.append({
                    "StopUID": stop_id,
                    "StopSequence": seq,
                    "ArrivalTime": time_str,
                    "DepartureTime": time_str
                })
        if len(stop_times) >= 2:
            synthetic.append({
                "RouteUID": ruid,
                "SubRouteUID": sub_route_uid,
                "Direction": direction,
                "TimeTables": [{"StopTimes": stop_times}]
            })
    return synthetic


def fetch_source(token, label, schedule_records, daily_records, shape_records,
                 schedule_fetcher, daily_fetcher, stop_of_route_fetcher, shape_fetcher):
    """Fetch one source (a city or InterCity) and extend the shared record
    lists. Only DailyTimetableUnavailable triggers the StopOfRoute degradation;
    every other exception (TdxFetchError, TdxHttpError, transport) propagates so
    the import fails rather than silently producing a feed missing a source.
    Returns a per-source fetch summary for observability."""
    records, sched_source = schedule_fetcher()
    if not records:
        raise TdxFetchError(
            f"{label}: Schedule returned 0 records (HTTP 200 empty / upstream anomaly). "
            f"Aborting so patch_gtfs_zip does not delete every bus trip and atomically "
            f"overwrite the feed without {label} (the same whole-city disappearance as the incident).")
    schedule_records.extend(records)

    daily_source, synth_profiles = "none", 0
    if needs_daily_fallback(records):
        try:
            d_recs, daily_source = daily_fetcher()
            daily_records.extend(d_recs)
        except DailyTimetableUnavailable:
            print(f"  {label}: DailyTimeTable unavailable — synthesizing profiles from StopOfRoute", file=sys.stderr)
            synth = _synthesize_from_stop_of_route(stop_of_route_fetcher())
            daily_records.extend(synth)
            daily_source, synth_profiles = "stoproute", len(synth)
        time.sleep(0.5)

    shape_records.extend(shape_fetcher())
    time.sleep(0.5)

    summary = {"city": label, "schedule": len(records), "schedule_source": sched_source,
               "daily_source": daily_source, "synth_profiles": synth_profiles}
    print(f"  {label}: schedule={summary['schedule']}({sched_source}), "
          f"daily_source={daily_source}, synth_profiles={synth_profiles}")
    return summary


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

def parse_linestring(geom):
    """Parse LINESTRING (lon lat, lon lat, ...) into a list of (lat, lon) coordinates."""
    if not geom or not geom.startswith("LINESTRING"):
        return []
    try:
        start_idx = geom.find("(")
        end_idx = geom.rfind(")")
        if start_idx == -1 or end_idx == -1:
            return []
        content = geom[start_idx + 1:end_idx]
        pts = []
        for pair in content.split(","):
            pair = pair.strip()
            if not pair:
                continue
            parts = pair.split()
            if len(parts) >= 2:
                # TDX coordinates are [longitude, latitude]
                lon = float(parts[0])
                lat = float(parts[1])
                pts.append((lat, lon))
        return pts
    except Exception:
        return []

def build_shape_index(shape_records):
    """Index shape records by (RouteUID, Direction) -> [(lat, lon), ...]."""
    index = {}
    for r in shape_records:
        ruid = r.get("RouteUID")
        direction = r.get("Direction", 0)
        geom = r.get("Geometry")
        if ruid and geom:
            pts = parse_linestring(geom)
            if pts:
                index[(ruid, direction)] = pts
    return index

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

def process_schedule_records_to_gtfs(records, new_trips, new_stop_times, seen_trips, route_list, route_ids_set, service_patterns, stats, daily_profiles, route_shape_by_route, tdx_shapes, new_shapes):
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
            
            # Hybrid shape selection:
            # 1. Inherit from original static GTFS if it exists
            shape_id = route_shape_by_route.get(matched_id, "")
            
            # 2. Otherwise lookup in our newly fetched TDX shape index
            if not shape_id:
                pts = None
                for key_uid in (sub_route_uid, route_uid):
                    if key_uid:
                        # Direct match
                        if (key_uid, direction) in tdx_shapes:
                            pts = tdx_shapes[(key_uid, direction)]
                            break
                        # Opposite direction fallback (reversed)
                        opp_dir = 1 - direction
                        if (key_uid, opp_dir) in tdx_shapes:
                            pts = tdx_shapes[(key_uid, opp_dir)][::-1]
                            break
                if pts:
                    shape_id = f"patched_shp_{matched_id}"
                    new_shapes[shape_id] = pts
                else:
                    stats["missing_shape"] += 1

            new_trips.append({
                "route_id": matched_id,
                "service_id": service_id_for_pattern(pattern),
                "trip_id": trip_id,
                "shape_id": shape_id,
                "direction_id": str(direction)
            })
            new_stop_times.extend(stop_rows)

def patch_gtfs_zip(zip_path, schedule_records, daily_records, tdx_shapes, start_date):
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

    # 6. Parse schedule records into weekly-service trips & map shape geometries
    new_trips = []
    new_stop_times = []
    seen_trips = set()
    service_patterns = set()
    stats = {"freq_only": 0, "no_service_day": 0, "dup_trip": 0, "short_trip": 0, "synthesized": 0, "missing_shape": 0}
    daily_profiles = build_daily_profiles(daily_records)
    new_shapes = {}
    
    process_schedule_records_to_gtfs(
        schedule_records, new_trips, new_stop_times, seen_trips,
        route_list, route_ids_set, service_patterns, stats, daily_profiles,
        route_shape_by_route, tdx_shapes, new_shapes
    )
    
    print(f"Generated {len(new_trips)} new bus trips and {len(new_stop_times)} new stop times "
          f"({len(service_patterns)} weekly service patterns, valid {cal_start}–{cal_end}; "
          f"{stats['synthesized']} trips synthesized from daily travel-time profiles; "
          f"{stats['missing_shape']} trips without original or fetched shape).")
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
            # Copy all entries except those we overwrite
            for item in zin.infolist():
                if item.filename in ("trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "shapes.txt"):
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

            # Overwrite shapes.txt with memory-efficient streaming copy + append
            print(f"Writing shapes.txt (injecting {len(new_shapes)} new bus route shapes)...")
            with zout.open("shapes.txt", "w") as f:
                wrapper = io.TextIOWrapper(f, encoding="utf-8")
                wrapper.write("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n")
                
                # Copy existing shapes
                if "shapes.txt" in zin.namelist():
                    with zin.open("shapes.txt") as in_f:
                        in_wrapper = io.TextIOWrapper(in_f, encoding="utf-8-sig")
                        in_wrapper.readline() # skip original header
                        for line in in_wrapper:
                            wrapper.write(line.strip() + "\n")
                
                # Append new shapes
                for shape_id, points in sorted(new_shapes.items()):
                    for seq, (lat, lon) in enumerate(points, start=1):
                        wrapper.write(f"{shape_id},{lat},{lon},{seq}\n")

    os.replace(temp_zip_path, zip_path)
    print("GTFS zip successfully patched with general timetables and shape geometry!")

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
    shape_records = []
    city_summaries = []

    # 1. Fetch InterCity (公路客運) — v2 only; symmetric daily -> StopOfRoute fallback.
    print("\nStep 2: Fetching InterCity (公路客運) Data...")
    city_summaries.append(fetch_source(
        token, "InterCity", schedule_records, daily_records, shape_records,
        schedule_fetcher=lambda: (fetch_paginated_api(token, V2_SCHED_INTERCITY, strict=True), "v2"),
        daily_fetcher=lambda: fetch_intercity_daily(token),
        stop_of_route_fetcher=lambda: fetch_stop_of_route(token, V2_STOP_OF_ROUTE_INTERCITY),
        shape_fetcher=lambda: fetch_shape(token, V2_SHAPE_INTERCITY),
    ))

    # 2. Fetch City Bus for all cities in CITIES (Schedule/Daily cascade v2 -> v3).
    print("\nStep 3: Fetching City Bus (各縣市市區公車) Data...")
    for city in CITIES:
        print(f"  Fetching {city} Data...")
        city_summaries.append(fetch_source(
            token, city, schedule_records, daily_records, shape_records,
            schedule_fetcher=lambda c=city: fetch_city_schedule(token, c),
            daily_fetcher=lambda c=city: fetch_daily_timetable(token, c),
            stop_of_route_fetcher=lambda c=city: fetch_stop_of_route(token, V2_STOP_OF_ROUTE(c)),
            shape_fetcher=lambda c=city: fetch_shape(token, V2_SHAPE(c)),
        ))
        time.sleep(0.5)

    print(f"\nStep 4: Parsing Shape records (downloaded {len(shape_records)} shapes)...")
    tdx_shapes = build_shape_index(shape_records)
    print(f"Parsed {len(tdx_shapes)} unique Route+Direction shape profiles.")

    print(f"\nStep 5: Patching {zip_path} with {len(schedule_records)} schedule records...")
    patch_gtfs_zip(zip_path, schedule_records, daily_records, tdx_shapes, today)

if __name__ == "__main__":
    main()
