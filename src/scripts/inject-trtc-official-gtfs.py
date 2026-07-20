#!/usr/bin/env python3
"""Graft the official TDX V3 Taipei-Metro (TRTC) 文湖線 / Brown schedule into the
national GTFS feed, replacing the synthetic Brown fill that inject-metro-gtfs.py
would otherwise produce.

Background (all verified by probing the live TDX endpoint):
  - `GET /api/gtfs/V3/Map/GTFS/Static/Rail/{OperatorCode}` serves an official GTFS
    only for TRTC; every other operator returns HTTP 400. So this touches TRTC only.
  - The national feed defines Brown's routes + stops but ships ZERO Brown trips
    (`TRTC_BR_BR-1_0`, `TRTC_BR_BR-1_1`), which inject-metro-gtfs.py fills with a
    headway-synthesised schedule. The official V3 feed models Brown as a
    frequency-based line too (~20 template trips + frequencies.txt), sharing the
    same underlying TDX S2STravelTime/Frequency data — but with the operator's own
    service calendar. This script substitutes that official data.
  - V3 Brown boarding stops are `BR{nn}_UP` / `BR{nn}_DN` (stop_code `BR{nn}`); the
    national boarding stops are `TRTC_{stop_code}` (= `TRTC_BR{nn}`). The crosswalk
    is exact (24/24).
  - Direction is derived semantically, never positionally: a V3 trip's first→last
    crosswalked station is matched against each national BR route_long_name
    (`origin－dest`), e.g. `TRTC_BR_BR-1_0` = `動物園－南港展覽館`.

Ordering: run this BEFORE inject-metro-gtfs.py. Once Brown has trips, that script's
`route_type==1 && 0 trips` gap-detection skips it — so Brown is official, every other
gap line is still synthesised.

Design guarantees:
  - Additive only. Never removes/alters national stops, pathways, levels, or any
    non-Brown line. TRTC station-internal accessible navigation (built from the
    national feed's pathway tree) is untouched.
  - All-or-nothing across BOTH Brown directions: official rows are committed only if
    each of the two national BR route_ids gets a complete trip; otherwise nothing is
    written and the metro injector fills both directions uniformly (never a mix).
  - One script-level transaction: changes are built in memory, written to a temp zip
    beside the feed, and swapped with os.replace only after passing reference-graph
    invariants. Any exception / no-op leaves the feed byte-for-byte unchanged (a prior
    injection is still retracted so re-runs are idempotent).
  - Fail-soft on data-shape gaps (exit 0, feed untouched apart from retraction); non-zero
    only on malformed args, unreadable/corrupt zips, write failure, or invariant violation.

Usage: inject-trtc-official-gtfs.py <feed.zip> <trtc-v3.gtfs.zip>
"""
import csv
import io
import os
import re
import sys
import tempfile
import zipfile

OFF_PREFIX = "TRTC_OFF_"
# National Brown route/boarding-stop id prefix in the national feed.
NAT_BR_ROUTE_PREFIX = "TRTC_BR"
WEEK = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
# Fullwidth/halfwidth dashes + tilde used between terminals in route_long_name.
DASH_SPLIT = re.compile(r"[－—–\-~～]")
# Deterministic ZIP member timestamp so idempotent re-runs are byte-stable (F3).
FIXED_ZIP_DATE = (1980, 1, 1, 0, 0, 0)

log = lambda *a: print("[inject-trtc-official-gtfs]", *a)

# Default fieldnames for GTFS members that may be absent from the feed.
DEFAULTS = {
    "trips.txt": ["route_id", "service_id", "trip_id", "shape_id", "direction_id"],
    "stop_times.txt": ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
    "frequencies.txt": ["trip_id", "start_time", "end_time", "headway_secs"],
    "calendar.txt": ["service_id", *WEEK, "start_date", "end_date"],
    "calendar_dates.txt": ["service_id", "date", "exception_type"],
}


class Fatal(Exception):
    """Non-recoverable failure: exit non-zero, leave feed unchanged."""


def read_rows(zf, name, default_fields):
    """Return (fieldnames, rows). Missing member → (default_fields, [])."""
    if name not in zf.namelist():
        return list(default_fields), []
    with zf.open(name) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        fields = reader.fieldnames or list(default_fields)
        return fields, list(reader)


def terminals(long_name):
    """route_long_name 'A－B' → (A, B) trimmed, or None when not two parts."""
    parts = [p.strip() for p in DASH_SPLIT.split(long_name or "") if p.strip()]
    return (parts[0], parts[-1]) if len(parts) >= 2 else None


def name_match(a, b):
    """Loose station-name equivalence (containment either way)."""
    return bool(a) and bool(b) and (a in b or b in a)


def main(feed_path, v3_path):
    # ── Read the official V3 Brown data ──
    try:
        v3 = zipfile.ZipFile(v3_path)
    except (OSError, zipfile.BadZipFile) as e:
        raise Fatal(f"cannot open V3 zip {v3_path}: {e}")
    with v3:
        _, v3_routes = read_rows(v3, "routes.txt", ["route_id"])
        _, v3_trips = read_rows(v3, "trips.txt", ["route_id", "trip_id", "service_id"])
        _, v3_stops = read_rows(v3, "stops.txt", ["stop_id", "stop_code"])
        _, v3_st = read_rows(v3, "stop_times.txt", DEFAULTS["stop_times.txt"])
        _, v3_freq = read_rows(v3, "frequencies.txt", ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"])
        _, v3_cal = read_rows(v3, "calendar.txt", ["service_id"])
        _, v3_cd = read_rows(v3, "calendar_dates.txt", DEFAULTS["calendar_dates.txt"])

    brown_present = any(r.get("route_id") == "Brown" for r in v3_routes)
    brown_trip_ids = {t["trip_id"] for t in v3_trips if t.get("route_id") == "Brown"}
    v3_code = {s["stop_id"]: (s.get("stop_code") or "") for s in v3_stops}
    v3_by_trip = {}
    for r in v3_st:
        if r["trip_id"] in brown_trip_ids:
            v3_by_trip.setdefault(r["trip_id"], []).append(r)
    for tid in v3_by_trip:
        v3_by_trip[tid].sort(key=lambda r: int(r.get("stop_sequence") or 0))
    v3_freq_by_trip = {}
    for fr in v3_freq:
        if fr.get("trip_id") in brown_trip_ids:
            v3_freq_by_trip.setdefault(fr["trip_id"], []).append(fr)
    v3_pat = {c["service_id"]: c for c in v3_cal}
    v3_trip_by_id = {t["trip_id"]: t for t in v3_trips if t.get("route_id") == "Brown"}

    # ── Read the national feed ──
    try:
        feed = zipfile.ZipFile(feed_path)
    except (OSError, zipfile.BadZipFile) as e:
        raise Fatal(f"cannot open feed zip {feed_path}: {e}")
    with feed:
        routes_fields, routes = read_rows(feed, "routes.txt", ["route_id"])
        trips_fields, trips = read_rows(feed, "trips.txt", DEFAULTS["trips.txt"])
        st_fields, stop_times = read_rows(feed, "stop_times.txt", DEFAULTS["stop_times.txt"])
        cal_fields, calendar = read_rows(feed, "calendar.txt", DEFAULTS["calendar.txt"])
        cd_fields, cal_dates = read_rows(feed, "calendar_dates.txt", DEFAULTS["calendar_dates.txt"])
        freq_fields, freqs = read_rows(feed, "frequencies.txt", DEFAULTS["frequencies.txt"])
        feed_stop_name = {s["stop_id"]: (s.get("stop_name") or "")
                          for s in read_rows(feed, "stops.txt", ["stop_id", "stop_name"])[1]}
        feed_stop_ids = set(feed_stop_name)

        # ── Idempotency: strip a prior injection (everything we add is TRTC_OFF_-keyed) ──
        before = (len(trips), len(stop_times), len(freqs), len(calendar), len(cal_dates))
        trips = [r for r in trips if not (r.get("trip_id") or "").startswith(OFF_PREFIX)]
        stop_times = [r for r in stop_times if not (r.get("trip_id") or "").startswith(OFF_PREFIX)]
        freqs = [r for r in freqs if not (r.get("trip_id") or "").startswith(OFF_PREFIX)]
        calendar = [r for r in calendar if not (r.get("service_id") or "").startswith(OFF_PREFIX)]
        cal_dates = [r for r in cal_dates if not (r.get("service_id") or "").startswith(OFF_PREFIX)]
        stripped = any(b - len(x) for b, x in zip(
            before, (trips, stop_times, freqs, calendar, cal_dates)))

        base = {
            "trips.txt": (trips_fields, trips),
            "stop_times.txt": (st_fields, stop_times),
            "frequencies.txt": (freq_fields, freqs),
            "calendar.txt": (cal_fields, calendar),
            "calendar_dates.txt": (cd_fields, cal_dates),
        }

        def noop(msg):
            """Data-shape gap: emit no Brown rows. Rewrite (retract-only) if a prior
            injection was stripped, else leave the feed byte-for-byte unchanged."""
            log(msg + (" — retracting prior injection" if stripped else " — feed unchanged"))
            if stripped:
                _rewrite(feed, feed_path, base)

        if not brown_present:
            return noop("V3 feed has no Brown route")
        if not brown_trip_ids:
            return noop("V3 Brown route has no trips")

        # ── National Brown routes (expect exactly two: one per direction) ──
        br_routes = [r for r in routes
                     if (r.get("route_id") or "").startswith(NAT_BR_ROUTE_PREFIX)
                     and (r.get("route_type") or "").strip() == "1"]
        if len(br_routes) != 2:
            return noop(f"expected 2 national Brown routes, found {len(br_routes)}")
        route_terms = {}
        for r in br_routes:
            t = terminals(r.get("route_long_name") or r.get("route_short_name") or "")
            if not t:
                return noop(f"Brown route {r['route_id']} has no parseable terminals")
            route_terms[r["route_id"]] = t

        # ── National TRTC calendar window (clamp target for injected Brown services) ──
        win_starts = [r["start_date"] for r in calendar
                      if (r.get("service_id") or "").startswith("TRTC_") and (r.get("start_date") or "").isdigit()]
        win_ends = [r["end_date"] for r in calendar
                    if (r.get("service_id") or "").startswith("TRTC_") and (r.get("end_date") or "").isdigit()]
        if not win_starts or not win_ends:
            return noop("no valid national TRTC calendar window")
        win_start, win_end = min(win_starts), max(win_ends)

        # ── Build candidate Brown trips, mapping each to a national BR route by terminals ──
        new_trips, new_st, new_freq = [], [], []
        used_services = {}   # off_svc -> v3_svc
        complete_by_route = {r["route_id"]: 0 for r in br_routes}
        skipped = 0
        for v3_tid in sorted(brown_trip_ids):
            seq_rows = v3_by_trip.get(v3_tid, [])
            if v3_tid not in v3_trip_by_id or len(seq_rows) < 2:
                skipped += 1
                continue
            mapped, ok = [], True
            for r in seq_rows:
                code = v3_code.get(r["stop_id"], "")
                nat_stop = f"TRTC_{code}" if code else ""
                if not nat_stop or nat_stop not in feed_stop_ids:
                    ok = False
                    break
                mapped.append((nat_stop, r))
            if not ok or len(mapped) < 2:
                skipped += 1
                continue
            first_name = feed_stop_name.get(mapped[0][0], "")
            last_name = feed_stop_name.get(mapped[-1][0], "")
            match_rid = next((rid for rid, (o, d) in route_terms.items()
                              if name_match(o, first_name) and name_match(d, last_name)), None)
            if not match_rid:
                skipped += 1
                continue
            tail = match_rid.rsplit("_", 1)[-1]
            direction_id = tail if tail in ("0", "1") else "0"
            suffix = "_UP" if v3_tid.endswith("_UP") else ("_DN" if v3_tid.endswith("_DN") else "")
            if suffix and ((suffix == "_UP") != (direction_id == "0")):
                log(f"WARN: direction cross-check mismatch for {v3_tid}: suffix={suffix} dir={direction_id}")
            v3_svc = v3_trip_by_id[v3_tid].get("service_id") or ""
            if not v3_svc:
                skipped += 1
                continue
            off_tid = f"{OFF_PREFIX}{v3_tid}"
            off_svc = f"{OFF_PREFIX}{v3_svc}"
            freq_rows = v3_freq_by_trip.get(v3_tid, [])
            # A "complete" trip (F1 all-or-nothing gate) is >=2 stops AND has a
            # frequency window — Brown is headway-based. A future fixed-schedule
            # Brown feed with no frequencies leaves directions incomplete and safely
            # no-ops (metro synth fills) rather than publishing a single daily run.
            if freq_rows:
                complete_by_route[match_rid] += 1
            new_trips.append({
                "route_id": match_rid, "service_id": off_svc, "trip_id": off_tid,
                "shape_id": "", "direction_id": direction_id,
                "wheelchair_accessible": (v3_trip_by_id[v3_tid].get("wheelchair_accessible") or ""),
                "bikes_allowed": "",
            })
            used_services[off_svc] = v3_svc
            for seq, (nat_stop, r) in enumerate(mapped, start=1):
                new_st.append({
                    "trip_id": off_tid,
                    "arrival_time": r.get("arrival_time") or r.get("departure_time"),
                    "departure_time": r.get("departure_time") or r.get("arrival_time"),
                    "stop_id": nat_stop, "stop_sequence": str(seq),
                })
            for fr in freq_rows:
                new_freq.append({
                    "trip_id": off_tid, "start_time": fr.get("start_time"),
                    "end_time": fr.get("end_time"), "headway_secs": fr.get("headway_secs"),
                    "exact_times": fr.get("exact_times") or "",
                })

        # ── All-or-nothing gate: BOTH directions need a complete trip ──
        if any(complete_by_route[r["route_id"]] < 1 for r in br_routes):
            return noop(f"incomplete Brown direction coverage {complete_by_route}; "
                        f"emitting NO official Brown rows so metro synth fills both (skipped {skipped})")

        # ── Injected calendar + calendar_dates for the used Brown services ──
        new_cal = []
        for off_svc, v3_svc in sorted(used_services.items()):
            pat = v3_pat.get(v3_svc, {})
            row = {"service_id": off_svc, "start_date": win_start, "end_date": win_end}
            for d in WEEK:
                row[d] = pat.get(d, "0")
            new_cal.append(row)
        off_by_v3 = {v3_svc: off_svc for off_svc, v3_svc in used_services.items()}
        new_cd = []
        for r in v3_cd:
            v3_svc, date = r.get("service_id"), (r.get("date") or "")
            if v3_svc in off_by_v3 and win_start <= date <= win_end:
                new_cd.append({"service_id": off_by_v3[v3_svc], "date": date,
                               "exception_type": r.get("exception_type")})

        # ── Pre-commit reference-graph invariants (any failure → abort, feed intact) ──
        _validate(new_trips, new_st, new_freq, new_cal, new_cd,
                  feed_stop_ids, {r["route_id"] for r in routes},
                  {r["service_id"] for r in calendar}, br_routes, complete_by_route)

        log(f"injecting official Brown: trips={len(new_trips)} stop_times={len(new_st)} "
            f"freq={len(new_freq)} calendar={len(new_cal)} calendar_dates={len(new_cd)} "
            f"window {win_start}–{win_end} (skipped {skipped}); coverage {complete_by_route}")

        _rewrite(feed, feed_path, {
            "trips.txt": (trips_fields, trips + sorted(new_trips, key=lambda r: r["trip_id"])),
            "stop_times.txt": (st_fields, stop_times + new_st),
            "frequencies.txt": (freq_fields, freqs + new_freq),
            "calendar.txt": (cal_fields, calendar + new_cal),
            "calendar_dates.txt": (cd_fields, cal_dates + new_cd),
        })
        log(f"rewrote {feed_path}")


def _validate(new_trips, new_st, new_freq, new_cal, new_cd,
              feed_stop_ids, feed_route_ids, existing_services, br_routes, complete_by_route):
    emitted = {t["trip_id"] for t in new_trips}
    if len(emitted) != len(new_trips):
        raise Fatal("duplicate emitted trip_id")
    svc_ids = existing_services | {c["service_id"] for c in new_cal}
    emitted_cal_svc = {c["service_id"] for c in new_cal}
    st_count = {}
    for r in new_st:
        if r["stop_id"] not in feed_stop_ids:
            raise Fatal(f"stop_time references missing stop {r['stop_id']}")
        if r["trip_id"] not in emitted:
            raise Fatal(f"stop_time references non-emitted trip {r['trip_id']}")
        st_count[r["trip_id"]] = st_count.get(r["trip_id"], 0) + 1
    for t in new_trips:
        if t["route_id"] not in feed_route_ids:
            raise Fatal(f"trip references missing route {t['route_id']}")
        if t["service_id"] not in svc_ids:
            raise Fatal(f"trip references missing service {t['service_id']}")
        if st_count.get(t["trip_id"], 0) < 2:
            raise Fatal(f"trip {t['trip_id']} has < 2 stop_times")
    for fr in new_freq:
        if fr["trip_id"] not in emitted:
            raise Fatal(f"frequency references non-emitted trip {fr['trip_id']}")
    for r in new_cd:
        if r["service_id"] not in emitted_cal_svc:
            raise Fatal(f"calendar_dates references non-emitted service {r['service_id']}")
    if any(complete_by_route[r["route_id"]] < 1 for r in br_routes):
        raise Fatal("direction-coverage invariant violated")


def _rewrite(zf, zip_path, rewritten):
    """Stream every entry through, replacing rewritten members; deterministic ZIP
    metadata so idempotent re-runs are byte-stable (F3). Atomic os.replace; temp
    removed on any failure so the original is never left truncated."""
    names = zf.namelist()

    def write_csv(out, name):
        fields, rows = rewritten[name]
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
        zi = zipfile.ZipInfo(name, date_time=FIXED_ZIP_DATE)
        zi.compress_type = zipfile.ZIP_DEFLATED
        out.writestr(zi, buf.getvalue())

    tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(zip_path) or ".", suffix=".zip")
    os.close(tmp_fd)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as out:
            for info in zf.infolist():
                if info.filename in rewritten:
                    write_csv(out, info.filename)
                else:
                    out.writestr(info, zf.read(info.filename))
            for name in rewritten:
                if name not in names:
                    write_csv(out, name)
        os.replace(tmp_path, zip_path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    try:
        main(sys.argv[1], sys.argv[2])
    except Fatal as e:
        print(f"[inject-trtc-official-gtfs] FATAL: {e}", file=sys.stderr)
        sys.exit(1)
