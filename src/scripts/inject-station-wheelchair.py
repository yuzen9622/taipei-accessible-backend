#!/usr/bin/env python3
"""Inject stop-level wheelchair_boarding into the TDX national GTFS zip.

Sibling of inject-tra-gtfs.py / inject-metro-gtfs.py. The TDX national feed ships
NO wheelchair_boarding column at all, so OTP treats every one of the 160k+ stops
as unknown accessibility — router-config's stop.unknownCost applies flat to all of
them and the stop-level wheelchair model never differentiates anything. This sets
wheelchair_boarding=1 on the metro stations that TDX StationFacility reports an
elevator for, so OTP's wheelchair routing prefers the accessible stations.

Real TDX Metro StationFacility shape (verified live 2026-06-17 — the codebase's
TdxMetroStationFacility type is stale and does NOT match this):
  { "StationID": "O1", "StationName": {...},
    "Elevators": [ {"Description": "...", "FloorLevel": "1F"}, ... ],
    "Toilets": [...], "DrinkingFountains": [...], ... }
Facilities are TOP-LEVEL named lists, NOT a Facilities[] array with FacilityType,
and the key is StationID (NOT StationUID). Elevator presence == non-empty
Elevators list; that IS the GTFS "can a wheelchair board here" signal. Toilets are
not a boarding signal and OTP has no stop-toilet routing, so they are ignored here
(toilet data already reaches the API via the post-layer fetchMetroFacilities).

Coverage caveat: TRTC (Taipei Metro) returns 0 elevators on this endpoint (data
gap, long known) — TRTC stays unknown until backfilled from OSM. KRTC/TYMC/TMRT/
NTMC/KLRT do carry elevator data. The TRA/THSR StationFacility endpoints 404 (no
such API), so rail stations are not covered here; TRA trains already carry
trip-level wheelchair_accessible from inject-tra-gtfs.py.

Stations without elevator evidence are left blank (unknown), never set to 2
(inaccessible): marking unknown stations inaccessible would let router-config's
inaccessibleCost over-prune the network — the trap inject-tra-gtfs.py avoids.

Matching: the system code comes from the facility filename ({SYS}.facility.json);
the feed stops are "{SYS}_{StationID}" (e.g. KRTC_O1). Any derived stop_id absent
from stops.txt is skipped (no garbage written), mirroring the sibling injectors.

Idempotent: this script is the only writer of wheelchair_boarding (TDX provides
none natively), so a re-run blanks the column then re-sets it from current data.

Usage: inject-station-wheelchair.py <feed.zip> <facility-dir>
  where <facility-dir> holds {SYS}.facility.json files — raw TDX responses of
  /Rail/Metro/StationFacility/{SYS}.
"""
import csv
import io
import json
import os
import sys
import tempfile
import zipfile

FACILITY_SUFFIX = ".facility.json"

log = lambda *a: print("[inject-station-wheelchair]", *a)


def read_rows(zf, name):
    with zf.open(name) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        return reader.fieldnames, list(reader)


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def has_elevator(record):
    """Real schema: presence of a non-empty top-level Elevators list."""
    return bool(record.get("Elevators"))


def main(zip_path, facility_dir):
    # system -> set of feed stop_ids that TDX reports an elevator for
    accessible = {}
    for fname in sorted(os.listdir(facility_dir)):
        if not fname.endswith(FACILITY_SUFFIX):
            continue
        system = fname[: -len(FACILITY_SUFFIX)]
        for rec in load_json(os.path.join(facility_dir, fname)):
            station_id = rec.get("StationID")
            if station_id and has_elevator(rec):
                accessible.setdefault(system, set()).add(f"{system}_{station_id}")

    if not accessible:
        log("no StationFacility elevator data found — nothing to inject")
        return

    want = set().union(*accessible.values())

    with zipfile.ZipFile(zip_path) as zf:
        stops_fields, stops = read_rows(zf, "stops.txt")
        had_column = "wheelchair_boarding" in stops_fields
        if not had_column:
            stops_fields = list(stops_fields) + ["wheelchair_boarding"]

        matched = 0
        for r in stops:
            if r["stop_id"] in want:
                r["wheelchair_boarding"] = "1"
                matched += 1
            elif had_column:
                r["wheelchair_boarding"] = ""  # clear a prior injection (we own this column)

        reported = sum(len(v) for v in accessible.values())
        per_sys = ", ".join(f"{s}:{len(v)}" for s, v in sorted(accessible.items()))
        log(f"elevator stations reported by TDX — {per_sys}")
        log(f"set wheelchair_boarding=1 on {matched} feed stops "
            f"(of {reported} reported; unmatched = not present in this feed)")

        _rewrite(zip_path, zf, {"stops.txt": (stops_fields, stops)})
    log(f"rewrote {zip_path}")


def _rewrite(zip_path, zf, rewritten):
    """Stream every entry through, replacing the rewritten ones (sibling pattern)."""
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(zip_path) or ".",
                                     suffix=".zip", delete=False) as tmp:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
            for name in zf.namelist():
                if name in rewritten:
                    fields, rows = rewritten[name]
                    buf = io.StringIO()
                    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
                    w.writeheader()
                    w.writerows(rows)
                    out.writestr(name, buf.getvalue())
                else:
                    out.writestr(name, zf.read(name))
        tmp_path = tmp.name
    os.replace(tmp_path, zip_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
