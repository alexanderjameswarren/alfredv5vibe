"""The credential probe — does it keep the one fact that matters?

===========================================================================
🛑 THE POINT OF THE WHOLE THING IS THE LAST-SUCCESS TIMESTAMP SURVIVING A
   FAILURE. "The cookie is dead" is half the information; "dead, and it last
   worked on 12 September" is the whole of it.
===========================================================================

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import json
import tempfile
import unittest
import unittest.mock as mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

from workshop import credential_probe as cp


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


class _TempState:
    """Point the module at a scratch file and reset its throttle."""

    def __enter__(self):
        self._dir = tempfile.TemporaryDirectory()
        self._patch = mock.patch.object(
            cp, "PROBE_STATE_PATH", Path(self._dir.name) / "credential-probe.json")
        self._patch.start()
        cp._last_write_monotonic = None
        return self

    def __exit__(self, *exc):
        self._patch.stop()
        self._dir.cleanup()
        cp._last_write_monotonic = None


class SurvivalTests(unittest.TestCase):
    """🛑 A FAILURE MUST NOT ERASE THE SUCCESS."""

    def test_recording_a_failure_LEAVES_last_success_INTACT(self):
        with _TempState():
            cp.record_success(source="call:get_history")
            first = cp.read_state()["last_success"]

            cp.record_failure("auth_expired", "auth_expired: YouTube rejected it")

            st = cp.read_state()
            self.assertEqual(st["last_success"], first,
                             "the timestamp that says WHEN it last worked is the "
                             "information — a failure must not clear it")
            self.assertEqual(st["last_failure_kind"], "auth_expired")

    def test_a_MISSING_state_file_returns_empty_rather_than_raising(self):
        # ⚠️ An exception here would hide the very timestamp this exists to
        # report, at exactly the moment it matters.
        with _TempState():
            self.assertEqual(cp.read_state(), {})
            s = cp.summarise()
            self.assertIsNone(s["last_success"])
            self.assertTrue(s["never_recorded"])

    def test_a_CORRUPT_state_file_returns_empty_rather_than_raising(self):
        with _TempState():
            cp.PROBE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            cp.PROBE_STATE_PATH.write_text("{not json", encoding="utf-8")
            self.assertEqual(cp.read_state(), {})
            self.assertIsNone(cp.summarise()["last_success"])

    def test_an_UNWRITABLE_location_does_not_raise(self):
        # Bookkeeping that can break the tool it observes is worse than none.
        with mock.patch.object(cp, "PROBE_STATE_PATH",
                               Path("/nonexistent-root/x/credential-probe.json")):
            cp._last_write_monotonic = None
            cp.record_success()          # must not raise
            cp.record_failure("upstream_error", "boom")


class OrderAndAgeTests(unittest.TestCase):
    """🛑 THE SAME TWO TIMESTAMPS MEAN OPPOSITE THINGS DEPENDING WHICH IS NEWER."""

    def _write(self, **kw):
        cp.PROBE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        cp.PROBE_STATE_PATH.write_text(json.dumps(kw), encoding="utf-8")

    def test_a_failure_NEWER_than_the_success_is_failing(self):
        with _TempState():
            now = datetime.now(timezone.utc)
            self._write(last_success=_iso(now - timedelta(hours=5)),
                        last_failure=_iso(now - timedelta(minutes=5)),
                        last_failure_kind="auth_expired")
            self.assertTrue(cp.summarise()["failing"])

    def test_a_failure_OLDER_than_the_success_is_HISTORY_not_an_alarm(self):
        # ⚠️ The negative control. A stale failure from last week must not read
        # as a live fault, or the checker cries wolf until it is ignored.
        with _TempState():
            now = datetime.now(timezone.utc)
            self._write(last_success=_iso(now - timedelta(minutes=5)),
                        last_failure=_iso(now - timedelta(days=7)),
                        last_failure_kind="upstream_error")
            s = cp.summarise()
            self.assertFalse(s["failing"])
            self.assertFalse(s["stale"])

    def test_AGE_is_reported_not_just_a_date(self):
        # "6 hours ago" and "9 days ago" read completely differently, and the
        # script should not be doing date maths in PowerShell across timezones.
        with _TempState():
            now = datetime.now(timezone.utc)
            self._write(last_success=_iso(now - timedelta(hours=6)))
            age = cp.summarise()["last_success_age_seconds"]
            self.assertGreater(age, 6 * 3600 - 120)
            self.assertLess(age, 6 * 3600 + 120)

    def test_STALE_IS_A_SEPARATE_FAULT_FROM_FAILING(self):
        # 🛑 THE SECOND FAULT THE SAME NUMBER REVEALS. No failure recorded, and
        # no success for nine days: nothing is calling YouTube at all, so the
        # daily sync is not running. Silence is not health.
        with _TempState():
            now = datetime.now(timezone.utc)
            self._write(last_success=_iso(now - timedelta(days=9)))
            s = cp.summarise()
            self.assertTrue(s["stale"])
            self.assertFalse(s["failing"], "nothing FAILED — nothing ran")

    def test_a_recent_success_is_neither_stale_nor_failing(self):
        with _TempState():
            cp.record_success()
            s = cp.summarise()
            self.assertFalse(s["stale"])
            self.assertFalse(s["failing"])


class ClassificationTests(unittest.TestCase):
    """⚠️ A DEAD COOKIE AND A BAD NIGHT NEED OPPOSITE RESPONSES."""

    def test_auth_signals_classify_as_auth_expired(self):
        for detail, status in [
            ("HTTPError: 401 Unauthorized", 401),
            ("something about a cookie", None),
            ("Forbidden", 403),
        ]:
            self.assertEqual(cp.classify(detail, status), "auth_expired", detail)

    def test_a_transient_failure_is_NOT_a_dead_credential(self):
        # Recording a network blip as auth_expired would send Alex through a
        # twenty-minute reauth for nothing — and doing it needlessly teaches the
        # wrong lesson about when it is actually needed.
        for detail, status in [
            ("ReadTimeout: timed out", None),
            ("HTTPError: 503 Service Unavailable", 503),
        ]:
            self.assertEqual(cp.classify(detail, status), "upstream_error", detail)


class ThrottleTests(unittest.TestCase):
    def test_success_writes_are_throttled_on_the_hot_path(self):
        with _TempState():
            cp.record_success()
            first = cp.read_state()["last_success"]
            with mock.patch.object(cp, "_now_iso", return_value="2099-01-01T00:00:00Z"):
                cp.record_success()
            self.assertEqual(cp.read_state()["last_success"], first,
                             "a second write inside the throttle window is skipped")

    def test_a_FAILURE_is_never_throttled(self):
        # ⚠️ Failures are rare and each one matters. Throttling them could drop
        # the only record of a fault.
        with _TempState():
            cp.record_success()
            cp.record_failure("auth_expired", "one")
            cp.record_failure("upstream_error", "two")
            self.assertEqual(cp.read_state()["last_failure_kind"], "upstream_error")


class SummaryReadingTests(unittest.TestCase):
    def test_the_reading_separates_the_two_faults_and_the_two_kinds(self):
        with _TempState():
            r = cp.summarise()["reading"]
            self.assertIn("DIFFERENT FAULTS", r)
            self.assertIn("auth_expired", r)
            self.assertIn("upstream_error", r)


if __name__ == "__main__":
    unittest.main()
