#!/usr/bin/env python3
"""Deterministic unit/integration tests for patch_gtfs.py.

Runs with the stdlib only (unittest + unittest.mock); no network, no new deps.
Run from the repo root:

    python3 src/scripts/test_patch_gtfs.py
"""
import csv
import datetime
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_gtfs  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patch_gtfs.py")


def _ok(payload):
    """A urlopen() context manager whose .read() yields json-encoded payload."""
    resp = mock.MagicMock()
    resp.read.return_value = json.dumps(payload).encode("utf-8")
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    cm.__exit__.return_value = False
    return cm


def _raw(raw_bytes):
    resp = mock.MagicMock()
    resp.read.return_value = raw_bytes
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    cm.__exit__.return_value = False
    return cm


def _http(code, body=""):
    """A transport-layer HTTPError (what a mocked urlopen raises)."""
    return urllib.error.HTTPError(
        "http://test/url", code, "Test Reason", {}, io.BytesIO(body.encode("utf-8")))


def _tdx_http(status, body=""):
    """A TdxHttpError (what the real fetch_paginated_api raises for 4xx)."""
    return patch_gtfs.TdxHttpError(status, "Test Reason", "http://test/url", body)


def _origin_only_route(route_uid="TEST01", direction=0, dep="06:00"):
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "RouteID": route_uid,
        "RouteName": {"Zh_tw": route_uid}, "Direction": direction,
        "Timetables": [{
            "TripID": f"{route_uid}-t1",
            "ServiceDay": {"Monday": 1},
            "StopTimes": [{"StopUID": "S1", "StopSequence": 1, "ArrivalTime": dep, "DepartureTime": dep}],
        }],
    }


def _usable_route(route_uid="TEST01", direction=0):
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "Direction": direction,
        "Timetables": [{"StopTimes": [
            {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "06:00", "DepartureTime": "06:00"},
            {"StopUID": "S2", "StopSequence": 2, "ArrivalTime": "06:10", "DepartureTime": "06:10"},
        ]}],
    }


def _sor_route(route_uid="TEST01", n_stops=2, direction=0):
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "Direction": direction,
        "Stops": [
            {"StopUID": f"S{i}", "StopSequence": i,
             "StopPosition": {"PositionLat": 25.0 + i * 0.001, "PositionLon": 121.5 + i * 0.001}}
            for i in range(1, n_stops + 1)
        ],
    }


def _freq_route(route_uid="FREQ01", direction=0, windows=None, service_day=None):
    """A headway-only Schedule record: Frequencys, no Timetables."""
    if windows is None:
        windows = [{"StartTime": "05:00", "EndTime": "22:00",
                    "MinHeadwayMins": 15, "MaxHeadwayMins": 20}]
    if service_day is None:
        service_day = {"Monday": 1, "Tuesday": 1, "Wednesday": 1,
                       "Thursday": 1, "Friday": 1}
    freqs = []
    for w in windows:
        entry = dict(w)
        entry.setdefault("ServiceDay", service_day)
        freqs.append(entry)
    return {
        "RouteUID": route_uid, "SubRouteUID": route_uid, "RouteID": route_uid,
        "RouteName": {"Zh_tw": route_uid}, "Direction": direction,
        "Frequencys": freqs,
    }


def _full_stats():
    return {"freq_only": 0, "no_service_day": 0, "dup_trip": 0, "short_trip": 0,
            "synthesized": 0, "missing_shape": 0, "freq_trips": 0, "freq_windows": 0,
            "freq_valhalla_fail": 0, "freq_no_stops": 0}


def _write_fixture_zip(path, with_frequencies=False):
    """A minimal GTFS feed: one preserved non-bus (metro) trip, one bus trip that
    patch_gtfs deletes, and the calendar/shapes scaffolding patch_gtfs_zip reads."""
    files = {
        "agency.txt": "agency_id,agency_name\nA,Test\n",
        "routes.txt": "route_id,route_type\nFREQ01_0,3\nM1,1\n",
        "trips.txt": ("route_id,service_id,trip_id,direction_id,shape_id\n"
                      "M1,svcM,mtrip1,0,mshape\n"
                      "FREQ01_0,svcOld,oldbus,0,\n"),
        "stop_times.txt": ("trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                           "mtrip1,08:00:00,08:00:00,MS1,1\n"
                           "mtrip1,08:05:00,08:05:00,MS2,2\n"
                           "oldbus,09:00:00,09:00:00,S1,1\n"),
        "calendar.txt": ("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                         "svcM,1,1,1,1,1,0,0,20260101,20261231\n"),
        "calendar_dates.txt": "service_id,date,exception_type\n",
        "shapes.txt": ("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                       "mshape,25.0,121.5,1\nmshape,25.01,121.51,2\n"),
    }
    if with_frequencies:
        files["frequencies.txt"] = ("trip_id,start_time,end_time,headway_secs,exact_times\n"
                                    "mtrip1,08:00:00,20:00:00,600,0\n")
    with zipfile.ZipFile(path, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class FetchPaginatedApiTests(unittest.TestCase):
    def test_400_fails_fast_with_body(self):
        body = '{"Message":"City: \'Taipei\' is not accepted but Taichung..."}'
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(400, body)]) as up:
            with self.assertRaises(patch_gtfs.TdxHttpError) as ctx:
                patch_gtfs.fetch_paginated_api("tok", "http://x?a=b", strict=True)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("not accepted", ctx.exception.body)
        self.assertEqual(up.call_count, 1)  # no retry on 4xx

    def test_403_is_fatal(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError) as ctx:
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(ctx.exception.status, 403)
        self.assertIsInstance(ctx.exception, patch_gtfs.TdxFetchError)

    def test_429_retries_then_succeeds(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen",
                        side_effect=[_http(429), _ok([{"x": 1}])]) as up:
            recs = patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(recs, [{"x": 1}])
        self.assertEqual(up.call_count, 2)

    def test_5xx_exhaust_strict_raises(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(503)] * 5):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)

    def test_5xx_exhaust_non_strict_returns_empty(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_http(503)] * 5):
            self.assertEqual(patch_gtfs.fetch_paginated_api("tok", "http://x"), [])

    def test_transport_exhaust_strict_raises(self):
        for exc in (urllib.error.URLError("down"), TimeoutError("read timed out")):
            with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[exc] * 5):
                with self.assertRaises(patch_gtfs.TdxFetchError):
                    patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)

    def test_invalid_json_strict_raises_once(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_raw(b"<html>oops")]) as up:
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        self.assertEqual(up.call_count, 1)  # deterministic error, not retried

    def test_v3_unwrap_and_pagination(self):
        page1 = _ok({"DailyTimeTables": [{"i": n} for n in range(1000)]})
        page2 = _ok({"DailyTimeTables": [{"i": 1}, {"i": 2}, {"i": 3}]})
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[page1, page2]):
            recs = patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables", strict=True)
        self.assertEqual(len(recs), 1003)

    def test_v3_missing_key_or_wrong_type_fatal(self):
        for payload in ({"WrongKey": []}, {"DailyTimeTables": "notalist"}):
            with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok(payload)]):
                with self.assertRaises(patch_gtfs.TdxFetchError):
                    patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables", strict=True)

    def test_non_dict_element_fatal_strict_only(self):
        payload = {"DailyTimeTables": [{"a": 1}, None, "s"]}
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok(payload)]):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables", strict=True)
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok(payload)]):
            recs = patch_gtfs.fetch_paginated_api("tok", "http://x", page_key="DailyTimeTables")
            self.assertEqual(len(recs), 3)  # non-strict does not validate elements

    def test_v2_top_level_non_list(self):
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok({"d": 1})]):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.fetch_paginated_api("tok", "http://x", strict=True)
        with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=[_ok({"d": 1})]):
            self.assertEqual(patch_gtfs.fetch_paginated_api("tok", "http://x"), [])


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class VersionCascadeTests(unittest.TestCase):
    def test_v2_usable_skips_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[[{"a": 1}]]) as f:
            recs, src = patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual((recs, src), ([{"a": 1}], "v2"))
        self.assertEqual(f.call_count, 1)

    def test_v2_400_falls_to_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400, "v2body"), [{"a": 1}]]):
            recs, src = patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual(src, "v3")

    def test_v2_non_400_fatal_no_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]) as f:
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual(f.call_count, 1)

    def test_both_400_keeps_v3_body(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400, "v2body"), _tdx_http(400, "v3body")]):
            with self.assertRaises(patch_gtfs.TdxHttpError) as ctx:
                patch_gtfs.fetch_with_version("t", "v2", "v3", "K")
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.body, "v3body")

    def test_schedule_both_400_fatal_with_body(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), _tdx_http(400, "v3body")]):
            with self.assertRaises(patch_gtfs.TdxFetchError) as ctx:
                patch_gtfs.fetch_city_schedule("t", "Ghost")
        self.assertNotIsInstance(ctx.exception, patch_gtfs.TdxHttpError)
        self.assertIn("v3body", str(ctx.exception))

    def test_schedule_403_propagates(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_city_schedule("t", "Taichung")

    def test_schedule_v2_usable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[[{"RouteUID": "X"}]]):
            recs, src = patch_gtfs.fetch_city_schedule("t", "Taichung")
        self.assertEqual(src, "v2")


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class DailyCascadeTests(unittest.TestCase):
    def test_v2_usable_skips_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[[_usable_route()]]) as f:
            recs, src = patch_gtfs.fetch_daily_timetable("t", "Taichung")
        self.assertEqual(src, "v2")
        self.assertEqual(f.call_count, 1)

    def test_v2_unusable_falls_to_v3_usable(self):
        # v2 returns a legal but origin-only batch -> must still try v3 (regression guard)
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[[_origin_only_route()], [_usable_route()]]) as f:
            recs, src = patch_gtfs.fetch_daily_timetable("t", "Tainan")
        self.assertEqual(src, "v3")
        self.assertEqual(f.call_count, 2)

    def test_v2_400_v3_usable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), [_usable_route()]]):
            recs, src = patch_gtfs.fetch_daily_timetable("t", "Tainan")
        self.assertEqual(src, "v3")

    def test_both_unusable_raises_unavailable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[[_origin_only_route()], []]):
            with self.assertRaises(patch_gtfs.DailyTimetableUnavailable):
                patch_gtfs.fetch_daily_timetable("t", "Taipei")

    def test_both_400_raises_unavailable(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), _tdx_http(400)]):
            with self.assertRaises(patch_gtfs.DailyTimetableUnavailable):
                patch_gtfs.fetch_daily_timetable("t", "Taipei")

    def test_v2_403_fatal_no_v3(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]) as f:
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_daily_timetable("t", "Taipei")
        self.assertEqual(f.call_count, 1)

    def test_v3_drift_propagates_not_degraded(self):
        with mock.patch("patch_gtfs.fetch_paginated_api",
                        side_effect=[_tdx_http(400), patch_gtfs.TdxFetchError("v3 drift")]):
            with self.assertRaises(patch_gtfs.TdxFetchError) as ctx:
                patch_gtfs.fetch_daily_timetable("t", "Tainan")
        self.assertNotIsInstance(ctx.exception, patch_gtfs.DailyTimetableUnavailable)

    def test_intercity_400_degrades(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(400)]):
            with self.assertRaises(patch_gtfs.DailyTimetableUnavailable):
                patch_gtfs.fetch_intercity_daily("t")

    def test_intercity_403_fatal(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_intercity_daily("t")


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class ShapeAndStopOfRouteTests(unittest.TestCase):
    def test_shape_400_tolerated(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(400)]):
            self.assertEqual(patch_gtfs.fetch_shape("t", "u"), [])

    def test_shape_403_fatal(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_shape("t", "u")

    def test_shape_5xx_and_transport_fatal(self):
        for exc in ([_http(503)] * 5, [urllib.error.URLError("x")] * 5):
            with mock.patch("patch_gtfs.urllib.request.urlopen", side_effect=exc):
                with self.assertRaises(patch_gtfs.TdxFetchError):
                    patch_gtfs.fetch_shape("t", "http://x")

    def test_stop_of_route_400_tolerated_else_fatal(self):
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(400)]):
            self.assertEqual(patch_gtfs.fetch_stop_of_route("t", "u"), [])
        with mock.patch("patch_gtfs.fetch_paginated_api", side_effect=[_tdx_http(403)]):
            with self.assertRaises(patch_gtfs.TdxHttpError):
                patch_gtfs.fetch_stop_of_route("t", "u")


@mock.patch("patch_gtfs.time.sleep", lambda *a, **k: None)
class FetchSourceTests(unittest.TestCase):
    def _run(self, schedule, daily_fetcher, sor_fetcher, shape_fetcher=lambda: []):
        sched, daily, shape, sor = [], [], [], []
        summary = patch_gtfs.fetch_source(
            "t", "City", sched, daily, shape, sor,
            schedule_fetcher=lambda: (schedule, "v3"),
            daily_fetcher=daily_fetcher,
            stop_of_route_fetcher=sor_fetcher,
            shape_fetcher=shape_fetcher,
        )
        return summary, daily

    def test_daily_usable_still_fetches_stoproute(self):
        # StopOfRoute is now always fetched (freq-only subroute stop index), even
        # when the daily timetable is usable and no synthesis fallback runs.
        sor = mock.MagicMock(return_value=[])
        summary, daily = self._run([_origin_only_route()], lambda: ([_usable_route()], "v3"), sor)
        self.assertEqual(summary["daily_source"], "v3")
        self.assertEqual(summary["schedule"], 1)
        sor.assert_called_once()

    def test_daily_unavailable_uses_stoproute(self):
        def daily():
            raise patch_gtfs.DailyTimetableUnavailable("x")
        summary, daily_recs = self._run([_origin_only_route()], daily, lambda: [_sor_route(n_stops=3)])
        self.assertEqual(summary["daily_source"], "stoproute")
        self.assertGreaterEqual(summary["synth_profiles"], 1)
        self.assertGreaterEqual(len(daily_recs), 1)

    def test_stoproute_fatal_propagates(self):
        def daily():
            raise patch_gtfs.DailyTimetableUnavailable("x")

        def sor():
            raise _tdx_http(403)
        with self.assertRaises(patch_gtfs.TdxHttpError):
            self._run([_origin_only_route()], daily, sor)

    def test_frequency_only_skips_daily_still_fetches_stoproute(self):
        daily = mock.MagicMock()
        sor = mock.MagicMock(return_value=[])
        freq_route = {"RouteUID": "F1", "Frequencys": [{"MinHeadwayMins": 10}]}
        summary, _ = self._run([freq_route], daily, sor)
        self.assertEqual(summary["daily_source"], "none")
        daily.assert_not_called()
        sor.assert_called_once()

    def test_empty_schedule_is_fatal_before_any_fetch(self):
        daily, sor, shape = mock.MagicMock(), mock.MagicMock(), mock.MagicMock()
        sched, drecs, shp, sorr = [], [], [], []
        with self.assertRaises(patch_gtfs.TdxFetchError):
            patch_gtfs.fetch_source(
                "t", "Ghost", sched, drecs, shp, sorr,
                schedule_fetcher=lambda: ([], "v2"),
                daily_fetcher=daily, stop_of_route_fetcher=sor, shape_fetcher=shape)
        daily.assert_not_called()
        sor.assert_not_called()
        shape.assert_not_called()


class SynthTests(unittest.TestCase):
    def test_only_ge2_stops_emitted(self):
        out = patch_gtfs._synthesize_from_stop_of_route([_sor_route("A", 2), _sor_route("B", 1)])
        uids = {r["RouteUID"] for r in out}
        self.assertIn("A", uids)
        self.assertNotIn("B", uids)


class NeedsDailyFallbackTests(unittest.TestCase):
    def test_all_full_false(self):
        self.assertFalse(patch_gtfs.needs_daily_fallback([_usable_route()]))

    def test_origin_only_true(self):
        self.assertTrue(patch_gtfs.needs_daily_fallback([_origin_only_route()]))

    def test_frequency_only_false(self):
        self.assertFalse(patch_gtfs.needs_daily_fallback([{"Frequencys": [{"x": 1}]}]))


class GtfsOutputTests(unittest.TestCase):
    """R4/R18: prove degraded profiles actually reach the public GTFS output, and
    that a route lacking a profile is skipped (short_trip) rather than aborting."""

    def _base_stats(self):
        return {"freq_only": 0, "no_service_day": 0, "dup_trip": 0,
                "short_trip": 0, "synthesized": 0, "missing_shape": 0,
                "freq_trips": 0, "freq_windows": 0, "freq_valhalla_fail": 0,
                "freq_no_stops": 0}

    def test_partial_coverage_short_trip_and_trip(self):
        schedule = [_origin_only_route("TEST01"), _origin_only_route("TEST02")]
        daily_profiles = patch_gtfs.build_daily_profiles(
            patch_gtfs._synthesize_from_stop_of_route([_sor_route("TEST01", 3)]))
        new_trips, new_stop_times, stats = [], [], self._base_stats()
        patch_gtfs.process_schedule_records_to_gtfs(
            schedule, new_trips, new_stop_times, [], set(),
            [{"route_id": "TEST01_0"}, {"route_id": "TEST02_0"}],
            {"TEST01_0", "TEST02_0"}, set(), stats, daily_profiles, {}, {}, {}, {})
        trip_routes = {t["route_id"] for t in new_trips}
        self.assertIn("TEST01_0", trip_routes)          # had a profile -> trip produced
        self.assertNotIn("TEST02_0", trip_routes)        # no profile -> skipped
        self.assertEqual(stats["short_trip"], 1)
        self.assertGreaterEqual(len(new_stop_times), 2)


class MainExitTests(unittest.TestCase):
    def test_main_does_not_swallow_fatal(self):
        argv = ["patch_gtfs.py", "feed.zip"]
        env = {"TDX_CLIENT_ID": "x", "TDX_CLIENT_SECRET": "y"}
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.dict(os.environ, env, clear=False), \
             mock.patch("patch_gtfs.os.path.exists", return_value=True), \
             mock.patch("patch_gtfs.get_tdx_token", return_value="tok"), \
             mock.patch("patch_gtfs.fetch_source", side_effect=patch_gtfs.TdxFetchError("boom")):
            with self.assertRaises(patch_gtfs.TdxFetchError):
                patch_gtfs.main()

    def test_cli_missing_args_nonzero_exit(self):
        # No production test bypass: use the existing CLI error paths.
        r = subprocess.run([sys.executable, SCRIPT], capture_output=True, env={})
        self.assertNotEqual(r.returncode, 0)


class BuildTravelProfileTests(unittest.TestCase):
    """Chunk/stitch correctness for build_travel_profile with a mocked Valhalla
    leg-time source (constant 60s per consecutive pair)."""

    @staticmethod
    def _legs(seconds=60):
        def fake(locations):
            return [seconds] * (len(locations) - 1)
        return fake

    @staticmethod
    def _coords(n):
        return [(25.0 + i * 0.001, 121.5 + i * 0.001) for i in range(n)]

    def _assert_profile(self, profile, n):
        self.assertEqual(len(profile), n)
        self.assertEqual(profile[0], 0)
        self.assertTrue(all(profile[i] <= profile[i + 1] for i in range(n - 1)))
        # boundary counted exactly once => every step is one 60s leg, total = (n-1)*60
        self.assertEqual(profile[-1], (n - 1) * 60)
        self.assertTrue(all(profile[i + 1] - profile[i] == 60 for i in range(n - 1)))

    def test_single_call_at_limit(self):
        n = patch_gtfs.VALHALLA_MAX_LOCATIONS
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 1)
        self._assert_profile(profile, n)

    def test_two_chunks_limit_plus_one(self):
        n = patch_gtfs.VALHALLA_MAX_LOCATIONS + 1
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 2)
        self._assert_profile(profile, n)

    def test_67_stops(self):
        n = 67
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 2)  # [0:40] + [39:67]
        self._assert_profile(profile, n)

    def test_more_than_two_chunks(self):
        n = 100
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=self._legs()) as vt:
            profile = patch_gtfs.build_travel_profile(self._coords(n))
        self.assertEqual(vt.call_count, 3)  # [0:40] + [39:79] + [78:100]
        self._assert_profile(profile, n)

    def test_fallback_on_error_counts(self):
        counter = [0]
        with mock.patch("patch_gtfs._valhalla_route_times", side_effect=RuntimeError("down")):
            profile = patch_gtfs.build_travel_profile(self._coords(5), counter)
        self.assertEqual(profile, [0, 120, 240, 360, 480])  # 2-min/stop fallback
        self.assertEqual(counter[0], 1)


_FIXED_PROFILE = lambda coords, fc=None: [i * 120 for i in range(len(coords))]


class FrequencyTripGenerationTests(unittest.TestCase):
    def _process(self, schedule, sor_index, route_ids=("FREQ01_0",), profile_ctx=None):
        new_trips, new_stop_times, new_freqs = [], [], []
        patterns = set()
        stats = _full_stats()
        ctx = profile_ctx or mock.patch("patch_gtfs.build_travel_profile", side_effect=_FIXED_PROFILE)
        with ctx:
            patch_gtfs.process_schedule_records_to_gtfs(
                schedule, new_trips, new_stop_times, new_freqs, set(),
                [{"route_id": r} for r in route_ids], set(route_ids), patterns, stats,
                {}, {}, {}, {}, sor_index)
        return new_trips, new_stop_times, new_freqs, patterns, stats

    def test_basic_frequency_trip_and_window(self):
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=4)])
        trips, stimes, freqs, patterns, stats = self._process([_freq_route("FREQ01")], sor_index)
        self.assertEqual(len(trips), 1)
        trip_id = trips[0]["trip_id"]
        self.assertTrue(trip_id.startswith("freqpatched_FREQ01_0_"))
        self.assertEqual(trips[0]["service_id"], patch_gtfs.service_id_for_pattern((1, 1, 1, 1, 1, 0, 0)))
        rows = [r for r in stimes if r["trip_id"] == trip_id]
        self.assertEqual(len(rows), 4)
        times = [r["departure_time"] for r in rows]
        self.assertTrue(all(times[i] < times[i + 1] for i in range(len(times) - 1)))
        self.assertEqual(times[0], "05:00:00")
        self.assertEqual(len(freqs), 1)
        self.assertEqual(freqs[0]["headway_secs"], round((15 + 20) / 2 * 60))
        self.assertEqual(freqs[0]["start_time"], "05:00:00")
        self.assertEqual(freqs[0]["end_time"], "22:00:00")
        self.assertEqual(freqs[0]["exact_times"], "0")
        self.assertIn((1, 1, 1, 1, 1, 0, 0), patterns)
        self.assertEqual((stats["freq_trips"], stats["freq_windows"]), (1, 1))

    def test_valhalla_fallback_still_plannable(self):
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=3)])
        ctx = mock.patch("patch_gtfs._valhalla_route_times", side_effect=RuntimeError("down"))
        trips, stimes, freqs, patterns, stats = self._process(
            [_freq_route("FREQ01")], sor_index, profile_ctx=ctx)
        self.assertEqual(len(trips), 1)
        self.assertEqual(stats["freq_valhalla_fail"], 1)
        rows = [r for r in stimes if r["trip_id"] == trips[0]["trip_id"]]
        self.assertEqual([r["departure_time"] for r in rows],
                         ["05:00:00", "05:02:00", "05:04:00"])

    def test_no_stoproute_skipped_counted(self):
        trips, stimes, freqs, patterns, stats = self._process([_freq_route("FREQ01")], {})
        self.assertEqual(trips, [])
        self.assertEqual(freqs, [])
        self.assertEqual(stats["freq_no_stops"], 1)

    def test_under_two_stops_not_indexed_and_skipped(self):
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=1)])
        self.assertEqual(sor_index, {})  # <2 resolvable stops are never indexed
        trips, _, freqs, _, stats = self._process([_freq_route("FREQ01")], sor_index)
        self.assertEqual(trips, [])
        self.assertEqual(stats["freq_no_stops"], 1)

    def test_fixed_and_frequency_both_survive_same_pattern(self):
        route = {
            "RouteUID": "MIX01", "SubRouteUID": "MIX01", "RouteID": "MIX01",
            "RouteName": {"Zh_tw": "MIX01"}, "Direction": 0,
            "Timetables": [
                {"TripID": "t-0600", "ServiceDay": {"Monday": 1}, "StopTimes": [
                    {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "06:00", "DepartureTime": "06:00"},
                    {"StopUID": "S2", "StopSequence": 2, "ArrivalTime": "06:10", "DepartureTime": "06:10"}]},
                {"TripID": "t-0700", "ServiceDay": {"Monday": 1}, "StopTimes": [
                    {"StopUID": "S1", "StopSequence": 1, "ArrivalTime": "07:00", "DepartureTime": "07:00"},
                    {"StopUID": "S2", "StopSequence": 2, "ArrivalTime": "07:10", "DepartureTime": "07:10"}]},
            ],
            "Frequencys": [
                {"StartTime": "16:00", "EndTime": "22:00", "MinHeadwayMins": 15,
                 "MaxHeadwayMins": 15, "ServiceDay": {"Monday": 1}}],
        }
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("MIX01", n_stops=2)])
        trips, _, freqs, _, _ = self._process([route], sor_index, route_ids=("MIX01_0",))
        fixed = [t for t in trips if t["trip_id"].startswith("patched_")]
        freq = [t for t in trips if t["trip_id"].startswith("freqpatched_")]
        self.assertEqual(len(fixed), 2)   # both fixed trips kept
        self.assertEqual(len(freq), 1)    # frequency template also emitted
        self.assertEqual(len(freqs), 1)   # window NOT dropped for sharing the pattern
        self.assertEqual((freqs[0]["start_time"], freqs[0]["end_time"]), ("16:00:00", "22:00:00"))

    def test_overlapping_frequency_windows_merged(self):
        route = _freq_route("FREQ01", windows=[
            {"StartTime": "06:00", "EndTime": "10:00", "MinHeadwayMins": 10, "MaxHeadwayMins": 10},
            {"StartTime": "09:00", "EndTime": "12:00", "MinHeadwayMins": 20, "MaxHeadwayMins": 20},
        ], service_day={"Monday": 1})
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=2)])
        _, _, freqs, _, _ = self._process([route], sor_index)
        self.assertEqual(len(freqs), 1)  # overlap merged within one trip_id
        self.assertEqual((freqs[0]["start_time"], freqs[0]["end_time"]), ("06:00:00", "12:00:00"))

    def test_disjoint_frequency_windows_both_kept(self):
        route = _freq_route("FREQ01", windows=[
            {"StartTime": "06:00", "EndTime": "09:00", "MinHeadwayMins": 10, "MaxHeadwayMins": 10},
            {"StartTime": "16:00", "EndTime": "20:00", "MinHeadwayMins": 20, "MaxHeadwayMins": 20},
        ], service_day={"Monday": 1})
        sor_index = patch_gtfs.build_stop_of_route_index([_sor_route("FREQ01", n_stops=2)])
        _, _, freqs, _, _ = self._process([route], sor_index)
        self.assertEqual(len(freqs), 2)  # disjoint windows both survive on one trip


class FrequencyZipEmissionTests(unittest.TestCase):
    def _run_patch(self, with_frequencies):
        tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)
        zip_path = os.path.join(tmpdir, "feed.zip")
        _write_fixture_zip(zip_path, with_frequencies=with_frequencies)
        with mock.patch("patch_gtfs.build_travel_profile", side_effect=_FIXED_PROFILE):
            patch_gtfs.patch_gtfs_zip(
                zip_path,
                schedule_records=[_freq_route("FREQ01")],
                daily_records=[],
                tdx_shapes={},
                sor_records=[_sor_route("FREQ01", n_stops=3)],
                start_date=datetime.date(2026, 7, 20),
            )
        return zip_path

    @staticmethod
    def _read(zip_path, name):
        with zipfile.ZipFile(zip_path, "r") as z:
            with z.open(name) as f:
                return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))

    def test_emits_frequencies_when_input_has_none(self):
        zip_path = self._run_patch(with_frequencies=False)
        rows = self._read(zip_path, "frequencies.txt")
        bus = [r for r in rows if r["trip_id"].startswith("freqpatched_FREQ01_0_")]
        self.assertEqual(len(bus), 1)
        self.assertEqual(bus[0]["start_time"], "05:00:00")
        self.assertEqual(bus[0]["end_time"], "22:00:00")
        self.assertEqual(bus[0]["headway_secs"], str(round((15 + 20) / 2 * 60)))
        self.assertEqual(bus[0]["exact_times"], "0")

        trips = self._read(zip_path, "trips.txt")
        tids = {t["trip_id"] for t in trips}
        freq_trip = next((t for t in tids if t.startswith("freqpatched_FREQ01_0_")), None)
        self.assertIsNotNone(freq_trip)
        self.assertIn("mtrip1", tids)      # non-bus preserved
        self.assertNotIn("oldbus", tids)   # old bus trip deleted

        st = self._read(zip_path, "stop_times.txt")
        self.assertEqual(len([r for r in st if r["trip_id"] == freq_trip]), 3)

        cal = self._read(zip_path, "calendar.txt")
        svc_ids = {c["service_id"] for c in cal}
        self.assertIn(patch_gtfs.service_id_for_pattern((1, 1, 1, 1, 1, 0, 0)), svc_ids)

    def test_preserves_upstream_frequencies_and_appends_bus(self):
        zip_path = self._run_patch(with_frequencies=True)
        rows = self._read(zip_path, "frequencies.txt")
        tids = [r["trip_id"] for r in rows]
        self.assertIn("mtrip1", tids)  # upstream metro row preserved
        self.assertTrue(any(t.startswith("freqpatched_FREQ01_0_") for t in tids))  # bus appended


if __name__ == "__main__":
    unittest.main(verbosity=2)
