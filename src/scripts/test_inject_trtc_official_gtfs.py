#!/usr/bin/env python3
"""Deterministic unit + integration tests for inject-trtc-official-gtfs.py.

Stdlib only (unittest); no network. Fixtures are built in a tmp dir with zipfile.
The integration test runs the real inject-metro-gtfs.py (a pure-Python offline
script) to prove ordering / gap-skip.

    python3 src/scripts/test_inject_trtc_official_gtfs.py
"""
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TRTC_SCRIPT = os.path.join(SCRIPT_DIR, "inject-trtc-official-gtfs.py")
METRO_SCRIPT = os.path.join(SCRIPT_DIR, "inject-metro-gtfs.py")

# Load the hyphenated module by path.
import importlib.util
_spec = importlib.util.spec_from_file_location("inject_trtc_official_gtfs", TRTC_SCRIPT)
inj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inj)


# ── fixture helpers ──────────────────────────────────────────────────────────
def write_gtfs(path, tables):
    """tables: {name: (fieldnames, [rowdict, ...])} → a GTFS zip at path."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, (fields, rows) in tables.items():
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
            z.writestr(name, buf.getvalue())


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def read_table(path, name):
    with zipfile.ZipFile(path) as z:
        if name not in z.namelist():
            return []
        with z.open(name) as f:
            return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def v3_brown(trips=("_UP", "_DN"), stops=("BR01", "BR02", "BR03", "BR04"),
             with_freq=True, dn_stops=None, service="brownN", pattern="1111100",
             cal_dates=(("brownN", "20260101", "2"), ("brownN", "20990101", "2"))):
    """Build a V3 TRTC GTFS zip content dict with a Brown route.

    UP goes stops[0]->stops[-1]; DN goes reversed (or dn_stops when overriding
    to force an unmappable direction)."""
    v3_stops_rows = []
    for code in set(stops) | set(dn_stops or ()):
        for suf in ("_UP", "_DN"):
            v3_stops_rows.append({"stop_id": f"{code}{suf}", "stop_code": code,
                                  "location_type": "0", "parent_station": code})
    trip_rows, st_rows, freq_rows = [], [], []
    for suf in trips:
        tid = f"brownTripN1{suf}"
        trip_rows.append({"route_id": "Brown", "trip_id": tid, "service_id": service,
                          "direction_id": "", "wheelchair_accessible": "1"})
        seq_stops = list(stops) if suf == "_UP" else list((dn_stops or stops)[::-1])
        for i, code in enumerate(seq_stops, start=1):
            t = f"06:{i:02d}:00"
            st_rows.append({"trip_id": tid, "arrival_time": t, "departure_time": t,
                            "stop_id": f"{code}{suf}", "stop_sequence": str(i)})
        if with_freq:
            freq_rows.append({"trip_id": tid, "start_time": "06:00:00", "end_time": "24:00:00",
                              "headway_secs": "600", "exact_times": ""})
    return {
        "routes.txt": (["route_id", "route_type"], [{"route_id": "Brown", "route_type": "1"}]),
        "stops.txt": (["stop_id", "stop_code", "location_type", "parent_station"], v3_stops_rows),
        "trips.txt": (["route_id", "trip_id", "service_id", "direction_id", "wheelchair_accessible"], trip_rows),
        "stop_times.txt": (["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], st_rows),
        "frequencies.txt": (["trip_id", "start_time", "end_time", "headway_secs", "exact_times"], freq_rows),
        "calendar.txt": (["service_id", "monday", "tuesday", "wednesday", "thursday", "friday",
                          "saturday", "sunday", "start_date", "end_date"],
                         [dict({"service_id": service, "start_date": "20250101", "end_date": "20991231"},
                               **dict(zip(("monday", "tuesday", "wednesday", "thursday", "friday",
                                           "saturday", "sunday"), pattern)))]),
        "calendar_dates.txt": (["service_id", "date", "exception_type"],
                               [{"service_id": s, "date": d, "exception_type": t} for s, d, t in cal_dates]),
    }


NAT_NAMES = {"TRTC_BR01": "動物園", "TRTC_BR02": "木柵", "TRTC_BR03": "萬芳社區", "TRTC_BR04": "萬芳醫院"}


def national_feed(extra_routes=(), extra_stops=(), extra_trips=(), extra_stop_times=(),
                  br_long=("動物園－萬芳醫院", "萬芳醫院－動物園"), br_count=2,
                  trtc_window=("20251201", "20260301"), with_freq=True):
    stops = [{"stop_id": sid, "stop_name": nm} for sid, nm in NAT_NAMES.items()]
    stops += [{"stop_id": s, "stop_name": s} for s in extra_stops]
    routes = []
    br_ids = ["TRTC_BR_BR-1_0", "TRTC_BR_BR-1_1"][:br_count]
    for rid, ln in zip(br_ids, br_long):
        routes.append({"route_id": rid, "route_type": "1", "route_long_name": ln, "route_short_name": ln})
    routes += list(extra_routes)
    calendar = [{"service_id": "TRTC_R_R-1_0_T_1111100", "monday": "1", "tuesday": "1",
                 "wednesday": "1", "thursday": "1", "friday": "1", "saturday": "0", "sunday": "0",
                 "start_date": trtc_window[0], "end_date": trtc_window[1]}]
    tables = {
        "routes.txt": (["route_id", "route_type", "route_long_name", "route_short_name"], routes),
        "stops.txt": (["stop_id", "stop_name"], stops),
        "trips.txt": (["route_id", "service_id", "trip_id", "shape_id", "direction_id"], list(extra_trips)),
        "stop_times.txt": (["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], list(extra_stop_times)),
        "calendar.txt": (["service_id", "monday", "tuesday", "wednesday", "thursday", "friday",
                          "saturday", "sunday", "start_date", "end_date"], calendar),
        "calendar_dates.txt": (["service_id", "date", "exception_type"], []),
    }
    if with_freq:
        tables["frequencies.txt"] = (["trip_id", "start_time", "end_time", "headway_secs"], [])
    return tables


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.feed = os.path.join(self.dir, "feed-1.gtfs.zip")
        self.v3 = os.path.join(self.dir, "trtc-v3.gtfs.zip")

    def run_inj(self, feed_tables=None, v3_tables=None):
        write_gtfs(self.feed, feed_tables if feed_tables is not None else national_feed())
        write_gtfs(self.v3, v3_tables if v3_tables is not None else v3_brown())
        inj.main(self.feed, self.v3)


class UnitTests(Base):
    def test_01_02_crosswalk_and_direction(self):
        self.run_inj()
        trips = read_table(self.feed, "trips.txt")
        off = [t for t in trips if t["trip_id"].startswith("TRTC_OFF_")]
        self.assertEqual(len(off), 2)
        up = next(t for t in off if t["trip_id"].endswith("_UP"))
        dn = next(t for t in off if t["trip_id"].endswith("_DN"))
        self.assertEqual(up["route_id"], "TRTC_BR_BR-1_0")   # 動物園→萬芳醫院
        self.assertEqual(up["direction_id"], "0")
        self.assertEqual(dn["route_id"], "TRTC_BR_BR-1_1")   # 萬芳醫院→動物園
        self.assertEqual(dn["direction_id"], "1")
        st = [r for r in read_table(self.feed, "stop_times.txt") if r["trip_id"].startswith("TRTC_OFF_")]
        self.assertTrue(all(r["stop_id"] in NAT_NAMES for r in st))
        self.assertIn("TRTC_BR01", {r["stop_id"] for r in st})

    def test_03_direction_fail_soft_no_terminals(self):
        self.run_inj(feed_tables=national_feed(br_long=("動物園之類", "萬芳醫院之類")))
        # route_long_name without a dash → no terminals → Part A no-op
        self.assertEqual([t for t in read_table(self.feed, "trips.txt")
                          if t["trip_id"].startswith("TRTC_OFF_")], [])

    def test_04_missing_stop_skips_trip_but_others_kept_when_complete(self):
        # DN uses BR04..BR01 which map fine; make UP reference an unmapped BR09.
        v3 = v3_brown(stops=("BR09", "BR02", "BR03", "BR04"))
        self.run_inj(v3_tables=v3)
        off = [t for t in read_table(self.feed, "trips.txt") if t["trip_id"].startswith("TRTC_OFF_")]
        # UP direction unmappable → all-or-nothing → nothing committed.
        self.assertEqual(off, [])

    def test_05_calendar_window_clamp(self):
        self.run_inj()
        cal = [c for c in read_table(self.feed, "calendar.txt") if c["service_id"].startswith("TRTC_OFF_")]
        self.assertTrue(cal)
        for c in cal:
            self.assertEqual((c["start_date"], c["end_date"]), ("20251201", "20260301"))
            self.assertEqual("".join(c[d] for d in inj.WEEK), "1111100")

    def test_06_calendar_dates_filtered_and_remapped(self):
        self.run_inj()
        cd = [r for r in read_table(self.feed, "calendar_dates.txt") if r["service_id"].startswith("TRTC_OFF_")]
        dates = {r["date"] for r in cd}
        self.assertIn("20260101", dates)      # within window, kept
        self.assertNotIn("20990101", dates)   # outside window, dropped
        self.assertTrue(all(r["service_id"] == "TRTC_OFF_brownN" for r in cd))

    def test_07_frequencies_created_when_absent(self):
        self.run_inj(feed_tables=national_feed(with_freq=False))
        freq = [r for r in read_table(self.feed, "frequencies.txt") if r["trip_id"].startswith("TRTC_OFF_")]
        self.assertEqual(len(freq), 2)

    def test_08_missing_national_window_no_op(self):
        # Rename the only TRTC calendar service so no TRTC_ window exists.
        tables = national_feed()
        tables["calendar.txt"][1][0]["service_id"] = "OTHER_svc"
        self.run_inj(feed_tables=tables)
        self.assertEqual([t for t in read_table(self.feed, "trips.txt")
                          if t["trip_id"].startswith("TRTC_OFF_")], [])

    def test_09_atomicity_write_failure_leaves_feed_unchanged(self):
        write_gtfs(self.feed, national_feed())
        write_gtfs(self.v3, v3_brown())
        original = read_bytes(self.feed)
        orig_rewrite = inj._rewrite

        def boom(zf, path, rewritten):
            # write a partial temp then fail, to prove cleanup + no clobber
            raise RuntimeError("simulated mid-write failure")
        inj._rewrite = boom
        try:
            with self.assertRaises(RuntimeError):
                inj.main(self.feed, self.v3)
        finally:
            inj._rewrite = orig_rewrite
        self.assertEqual(read_bytes(self.feed), original)
        # no stray temp zips left behind
        self.assertEqual([f for f in os.listdir(self.dir) if f.endswith(".zip")
                          and f not in ("feed-1.gtfs.zip", "trtc-v3.gtfs.zip")], [])

    def test_10_all_or_nothing_only_up_survives(self):
        # DN references an unmapped stop → DN incomplete → NO official rows at all.
        v3 = v3_brown(dn_stops=("BR04", "BR03", "BR02", "BR99"))
        self.run_inj(v3_tables=v3)
        self.assertEqual([t for t in read_table(self.feed, "trips.txt")
                          if t["trip_id"].startswith("TRTC_OFF_")], [])

    def test_10b_both_directions_complete_commits_both(self):
        self.run_inj()
        off = [t for t in read_table(self.feed, "trips.txt") if t["trip_id"].startswith("TRTC_OFF_")]
        self.assertEqual({t["route_id"] for t in off}, {"TRTC_BR_BR-1_0", "TRTC_BR_BR-1_1"})

    @staticmethod
    def _valid_validate_kwargs():
        """A fully-valid _validate() call; each invariant test perturbs one field."""
        return dict(
            new_trips=[{"route_id": "R", "service_id": "TRTC_OFF_s", "trip_id": "TRTC_OFF_x"}],
            new_st=[{"trip_id": "TRTC_OFF_x", "stop_id": "S1", "stop_sequence": "1"},
                    {"trip_id": "TRTC_OFF_x", "stop_id": "S2", "stop_sequence": "2"}],
            new_freq=[{"trip_id": "TRTC_OFF_x"}],
            new_cal=[{"service_id": "TRTC_OFF_s"}],
            new_cd=[{"service_id": "TRTC_OFF_s", "date": "20260101", "exception_type": "2"}],
            feed_stop_ids={"S1", "S2"}, feed_route_ids={"R"}, existing_services=set(),
            br_routes=[{"route_id": "R"}], complete_by_route={"R": 1})

    def test_11_baseline_valid_passes(self):
        inj._validate(**self._valid_validate_kwargs())  # must not raise

    def test_11a_invariant_stop_time_missing_stop(self):
        kw = self._valid_validate_kwargs()
        kw["new_st"][0]["stop_id"] = "NOPE"
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_11b_invariant_stop_time_dangling_trip(self):
        kw = self._valid_validate_kwargs()
        kw["new_st"].append({"trip_id": "TRTC_OFF_ghost", "stop_id": "S1", "stop_sequence": "3"})
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_11c_invariant_frequency_dangling_trip(self):
        kw = self._valid_validate_kwargs()
        kw["new_freq"] = [{"trip_id": "TRTC_OFF_ghost"}]
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_11d_invariant_trip_lt_two_stop_times(self):
        kw = self._valid_validate_kwargs()
        kw["new_st"] = kw["new_st"][:1]   # only one stop_time
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_11e_invariant_trip_missing_route(self):
        kw = self._valid_validate_kwargs()
        kw["feed_route_ids"] = set()   # route R no longer exists
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_11f_invariant_trip_missing_service(self):
        kw = self._valid_validate_kwargs()
        kw["new_cal"] = []   # service no longer emitted / existing
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_11g_invariant_duplicate_trip_id(self):
        kw = self._valid_validate_kwargs()
        kw["new_trips"].append(dict(kw["new_trips"][0]))   # duplicate trip_id
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_11h_invariant_dangling_calendar_dates(self):
        kw = self._valid_validate_kwargs()
        kw["new_cd"] = [{"service_id": "TRTC_OFF_other", "date": "20260101", "exception_type": "2"}]
        with self.assertRaises(inj.Fatal):
            inj._validate(**kw)

    def test_12_idempotent_byte_stable(self):
        write_gtfs(self.feed, national_feed())
        write_gtfs(self.v3, v3_brown())
        inj.main(self.feed, self.v3)
        first = read_bytes(self.feed)
        inj.main(self.feed, self.v3)
        second = read_bytes(self.feed)
        self.assertEqual(first, second)

    def test_13_no_op_total_leaves_feed_unchanged(self):
        # V3 with no Brown route → total no-op, feed byte-for-byte unchanged.
        write_gtfs(self.feed, national_feed())
        v3 = v3_brown()
        v3["routes.txt"] = (["route_id", "route_type"], [{"route_id": "Red", "route_type": "1"}])
        v3["trips.txt"] = (v3["trips.txt"][0], [])
        write_gtfs(self.v3, v3)
        original = read_bytes(self.feed)
        inj.main(self.feed, self.v3)
        self.assertEqual(read_bytes(self.feed), original)

    def test_14_corrupt_v3_zip_exits_fatal(self):
        write_gtfs(self.feed, national_feed())
        with open(self.v3, "wb") as f:
            f.write(b"not a zip")
        with self.assertRaises(inj.Fatal):
            inj.main(self.feed, self.v3)

    def test_15_cli_missing_args_nonzero(self):
        r = subprocess.run([sys.executable, TRTC_SCRIPT], capture_output=True)
        self.assertNotEqual(r.returncode, 0)


class IntegrationTest(Base):
    """Ordering / gap-skip: after inject-trtc then inject-metro, Brown is official,
    the other gap line is synthetic MRT_, and no MRT_ Brown trips exist."""

    def _metro_dir(self):
        d = os.path.join(self.dir, "metro")
        os.makedirs(d, exist_ok=True)
        # NTMC 環狀線 gap line with 3 stations.
        s2s = [{
            "RouteID": "Y-1", "LineID": "Y", "Direction": 0,
            "TravelTimes": [
                {"Sequence": 1, "FromStationID": "Y01", "ToStationID": "Y02",
                 "FromStationName": {"Zh_tw": "環A"}, "ToStationName": {"Zh_tw": "環B"},
                 "RunTime": 120, "StopTime": 30},
                {"Sequence": 2, "FromStationID": "Y02", "ToStationID": "Y03",
                 "FromStationName": {"Zh_tw": "環B"}, "ToStationName": {"Zh_tw": "環C"},
                 "RunTime": 120, "StopTime": 30},
            ],
        }]
        freq = [{"RouteID": "Y-1", "LineID": "Y",
                 "Headways": [{"MinHeadwayMins": 4, "MaxHeadwayMins": 6}],
                 "OperationTime": {"StartTime": "06:00", "EndTime": "24:00"}}]
        # TRTC S2S present too — proves BR is skipped because it HAS trips, not for lack of data.
        trtc = [{
            "RouteID": "BR-1", "LineID": "BR", "Direction": 0,
            "TravelTimes": [
                {"Sequence": 1, "FromStationID": "BR01", "ToStationID": "BR02",
                 "FromStationName": {"Zh_tw": "動物園"}, "ToStationName": {"Zh_tw": "木柵"},
                 "RunTime": 90, "StopTime": 30},
                {"Sequence": 2, "FromStationID": "BR02", "ToStationID": "BR03",
                 "FromStationName": {"Zh_tw": "木柵"}, "ToStationName": {"Zh_tw": "萬芳社區"},
                 "RunTime": 90, "StopTime": 30},
                {"Sequence": 3, "FromStationID": "BR03", "ToStationID": "BR04",
                 "FromStationName": {"Zh_tw": "萬芳社區"}, "ToStationName": {"Zh_tw": "萬芳醫院"},
                 "RunTime": 90, "StopTime": 30},
            ],
        }]
        def dump(name, obj):
            with open(os.path.join(d, name), "w") as f:
                json.dump(obj, f)

        dump("NTMC.s2s.json", s2s)
        dump("NTMC.freq.json", freq)
        dump("NTMC.shape.json", [])
        dump("TRTC.s2s.json", trtc)
        dump("TRTC.freq.json", [{"RouteID": "BR-1", "Headways": [{"MinHeadwayMins": 4, "MaxHeadwayMins": 6}],
                                 "OperationTime": {"StartTime": "06:00", "EndTime": "24:00"}}])
        dump("TRTC.shape.json", [])
        return d

    def test_ordering_gap_skip(self):
        ntmc_routes = ({"route_id": "NTMC_Y_Y-1_0", "route_type": "1",
                        "route_long_name": "環A－環C", "route_short_name": "環A－環C"},
                       {"route_id": "NTMC_Y_Y-1_1", "route_type": "1",
                        "route_long_name": "環C－環A", "route_short_name": "環C－環A"})
        ntmc_stops = ("NTMC_Y01", "NTMC_Y02", "NTMC_Y03")
        write_gtfs(self.feed, national_feed(extra_routes=ntmc_routes, extra_stops=ntmc_stops))
        write_gtfs(self.v3, v3_brown())
        metro_dir = self._metro_dir()

        inj.main(self.feed, self.v3)
        r = subprocess.run([sys.executable, METRO_SCRIPT, self.feed, metro_dir], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

        trips = read_table(self.feed, "trips.txt")
        off_br = [t for t in trips if t["trip_id"].startswith("TRTC_OFF_")]
        mrt = [t for t in trips if t["trip_id"].startswith("MRT_")]
        mrt_br = [t for t in mrt if t["route_id"].startswith("TRTC_BR")]
        mrt_ntmc = [t for t in mrt if t["route_id"].startswith("NTMC_")]
        self.assertTrue(off_br, "official Brown trips present")
        self.assertEqual(mrt_br, [], "no synthetic MRT_ Brown trips (metro injector skipped BR)")
        self.assertTrue(mrt_ntmc, "NTMC gap line still synthesized by metro injector")

        # idempotent across the full sequence
        inj.main(self.feed, self.v3)
        r2 = subprocess.run([sys.executable, METRO_SCRIPT, self.feed, metro_dir], capture_output=True, text=True)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        trips2 = read_table(self.feed, "trips.txt")
        self.assertEqual(len([t for t in trips2 if t["trip_id"].startswith("TRTC_OFF_")]), len(off_br))
        self.assertEqual(len([t for t in trips2 if t["route_id"].startswith("TRTC_BR") and t["trip_id"].startswith("MRT_")]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
