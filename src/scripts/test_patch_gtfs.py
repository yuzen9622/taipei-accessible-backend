#!/usr/bin/env python3
"""Deterministic unit/integration tests for patch_gtfs.py.

Runs with the stdlib only (unittest + unittest.mock); no network, no new deps.
Run from the repo root:

    python3 src/scripts/test_patch_gtfs.py
"""
import io
import json
import os
import subprocess
import sys
import unittest
import urllib.error
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
        "Stops": [{"StopUID": f"S{i}", "StopSequence": i} for i in range(1, n_stops + 1)],
    }


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
        sched, daily, shape = [], [], []
        summary = patch_gtfs.fetch_source(
            "t", "City", sched, daily, shape,
            schedule_fetcher=lambda: (schedule, "v3"),
            daily_fetcher=daily_fetcher,
            stop_of_route_fetcher=sor_fetcher,
            shape_fetcher=shape_fetcher,
        )
        return summary, daily

    def test_daily_usable_no_stoproute(self):
        sor = mock.MagicMock()
        summary, daily = self._run([_origin_only_route()], lambda: ([_usable_route()], "v3"), sor)
        self.assertEqual(summary["daily_source"], "v3")
        self.assertEqual(summary["schedule"], 1)
        sor.assert_not_called()

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

    def test_frequency_only_skips_daily_and_stoproute(self):
        daily, sor = mock.MagicMock(), mock.MagicMock()
        freq_route = {"RouteUID": "F1", "Frequencys": [{"MinHeadwayMins": 10}]}
        summary, _ = self._run([freq_route], daily, sor)
        self.assertEqual(summary["daily_source"], "none")
        daily.assert_not_called()
        sor.assert_not_called()

    def test_empty_schedule_is_fatal_before_any_fetch(self):
        daily, sor, shape = mock.MagicMock(), mock.MagicMock(), mock.MagicMock()
        sched, drecs, shp = [], [], []
        with self.assertRaises(patch_gtfs.TdxFetchError):
            patch_gtfs.fetch_source(
                "t", "Ghost", sched, drecs, shp,
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
                "short_trip": 0, "synthesized": 0, "missing_shape": 0}

    def test_partial_coverage_short_trip_and_trip(self):
        schedule = [_origin_only_route("TEST01"), _origin_only_route("TEST02")]
        daily_profiles = patch_gtfs.build_daily_profiles(
            patch_gtfs._synthesize_from_stop_of_route([_sor_route("TEST01", 3)]))
        new_trips, new_stop_times, stats = [], [], self._base_stats()
        patch_gtfs.process_schedule_records_to_gtfs(
            schedule, new_trips, new_stop_times, set(),
            [{"route_id": "TEST01_0"}, {"route_id": "TEST02_0"}],
            {"TEST01_0", "TEST02_0"}, set(), stats, daily_profiles, {}, {}, {})
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
