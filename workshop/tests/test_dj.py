"""Unit tests for the pure logic in workshop.tools.dj. Stdlib ``unittest``, no
pytest dep on the Surface. NOTHING here touches the network or the credential —
these cover the parts that corrupt data silently when wrong.

Occurrence numbering gets the most attention because the live history page
frequently contains no repeated (video, bucket) pair at all, so real data can
pass while the rule is broken. It is also in the dj_plays dedupe key, which
means a bug here shows up as slowly accumulating duplicate rows rather than as
an error.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import unittest

import tempfile
import unittest.mock as mock
from pathlib import Path

import workshop.tools.dj as dj
from workshop.platform import OperationalError
from workshop.tools.dj import (
    KNOWN_BUCKETS,
    PAGE_FULL_AT,
    _album,
    _artists,
    _as_int,
    _occurrence_index,
    _project_play,
    _project_playlist_summary,
    _project_playlist_track,
    _scrub,
    _truncation_hint,
    _upstream_error,
)


def feed(*pairs):
    """Build a newest-first history page from (video_id, bucket) pairs."""
    return [{"videoId": v, "played": b} for v, b in pairs]


class TestOccurrenceIndex(unittest.TestCase):
    def test_counts_from_the_oldest_end(self):
        raw = feed(
            ("A", "This week"),  # 0 — newest
            ("B", "This week"),  # 1
            ("A", "This week"),  # 2
            ("C", "Today"),      # 3
            ("A", "This week"),  # 4 — oldest A
        )
        occ, cnt = _occurrence_index(raw)
        self.assertEqual([occ[0], occ[2], occ[4]], [3, 2, 1])
        self.assertTrue(all(cnt[i] == 3 for i in (0, 2, 4)))
        self.assertEqual((occ[1], cnt[1]), (1, 1))
        self.assertEqual((occ[3], cnt[3]), (1, 1))

    def test_new_play_does_not_renumber_existing_plays(self):
        """The reason numbering runs from the oldest end at all.

        Positional numbering over a newest-first feed would give yesterday's
        play a new number today, and occurrence is in the dedupe key — so the
        already-recorded play would be re-inserted under the new number.
        """
        day1 = feed(
            ("A", "This week"),
            ("B", "This week"),
            ("A", "This week"),
        )
        occ1, _ = _occurrence_index(day1)
        # Same plays, one index later, after a newer play of A arrives.
        day2 = feed(("A", "This week")) + day1
        occ2, cnt2 = _occurrence_index(day2)

        for i, item in enumerate(day1):
            self.assertEqual(
                occ1[i], occ2[i + 1],
                f"play at day-1 index {i} was renumbered by a newer arrival",
            )
        # day1 held two plays of A; the arrival makes three, and the newcomer
        # takes the next number up rather than displacing anyone.
        self.assertEqual(occ2[0], 3)
        self.assertEqual(cnt2[0], 3)

    def test_same_video_in_different_buckets_is_a_separate_group(self):
        raw = feed(("A", "Today"), ("A", "This week"), ("A", "This week"))
        occ, cnt = _occurrence_index(raw)
        self.assertEqual((occ[0], cnt[0]), (1, 1))
        self.assertEqual([occ[1], occ[2]], [2, 1])
        self.assertEqual(cnt[1], 2)

    def test_bucket_play_count_is_uniform_within_a_group(self):
        raw = feed(*[("A", "Last week")] * 5)
        occ, cnt = _occurrence_index(raw)
        self.assertEqual(sorted(occ.values()), [1, 2, 3, 4, 5])
        self.assertEqual(set(cnt.values()), {5})

    def test_empty_page(self):
        self.assertEqual(_occurrence_index([]), ({}, {}))


class TestProjection(unittest.TestCase):
    def test_play_drops_write_handles_and_bulk(self):
        item = {
            "videoId": "vid1",
            "title": "Song",
            "artists": [{"name": "Band", "id": "a1"}],
            "album": {"name": "Album", "id": "MPRE1"},
            "duration_seconds": 200,
            "duration": "3:20",
            "played": "Today",
            "videoType": "MUSIC_VIDEO_TYPE_ATV",
            "likeStatus": "LIKE",
            "thumbnails": [{"url": "x"}] * 4,
            "feedbackToken": "tok",
            "feedbackTokens": {"add": "a", "remove": "r"},
            "listenAgainFeedbackTokens": {"add": "a"},
            "views": "1.2M",
            "communityVoteStatus": "INDIFFERENT",
            "creditsBrowseId": "cb",
            "pinnedToListenAgain": False,
            "inLibrary": True,
            "isAvailable": True,
            "isExplicit": False,
        }
        out = _project_play(item, position=7, occurrence=2, bucket_play_count=3)
        self.assertEqual(out["like_status"], "LIKE")
        self.assertEqual(out["played_bucket"], "Today")
        self.assertEqual((out["position"], out["occurrence"], out["bucket_play_count"]), (7, 2, 3))
        for dropped in (
            "thumbnails", "feedbackToken", "feedbackTokens",
            "listenAgainFeedbackTokens", "views", "communityVoteStatus",
            "creditsBrowseId", "pinnedToListenAgain", "duration",
        ):
            self.assertNotIn(dropped, out)

    def test_missing_and_null_fields_do_not_raise(self):
        # "Liked Music" has no count/author; album is None on singles.
        self.assertEqual(_artists({}), [])
        self.assertEqual(_artists({"artists": None}), [])
        self.assertIsNone(_album({"album": None}))
        self.assertIsNone(_album({}))
        out = _project_play({}, position=0, occurrence=1, bucket_play_count=1)
        self.assertIsNone(out["video_id"])
        self.assertEqual(out["artists"], [])

    def test_playlist_track_carries_set_video_id(self):
        t = {
            "videoId": "v", "setVideoId": "SVID", "title": "T",
            "artists": [{"name": "W", "id": "i"}], "album": {"name": "A", "id": "m"},
            "duration_seconds": 205, "likeStatus": "INDIFFERENT",
            "isAvailable": True, "videoType": "MUSIC_VIDEO_TYPE_ATV",
            "thumbnails": [{"url": "x"}],
        }
        out = _project_playlist_track(t, position=3)
        self.assertEqual(out["set_video_id"], "SVID")
        self.assertEqual(out["position"], 3)
        self.assertNotIn("thumbnails", out)


class TestCountCoercion(unittest.TestCase):
    """get_library_playlists reports `count` as a STRING ('160'); get_playlist
    reports `trackCount` as an int (160). Same quantity, two types — and a text
    sort puts '95' above '160'. Normalise at the boundary."""

    def test_string_counts_become_ints(self):
        self.assertEqual(_as_int("160"), 160)
        self.assertEqual(_as_int("1"), 1)
        self.assertEqual(_as_int("1,234"), 1234)

    def test_passthrough_and_unparseable(self):
        self.assertEqual(_as_int(160), 160)
        self.assertIsNone(_as_int(None))
        self.assertIsNone(_as_int(""))
        self.assertIsNone(_as_int("Auto playlist"))
        # bool is an int subclass and is never a count
        self.assertIsNone(_as_int(True))

    def test_library_summary_emits_an_int(self):
        out = _project_playlist_summary(
            {"playlistId": "P1", "title": "Weezer Concert", "count": "160", "owned": True}
        )
        self.assertEqual(out["count"], 160)
        self.assertIsInstance(out["count"], int)

    def test_liked_music_has_no_count(self):
        out = _project_playlist_summary({"playlistId": "LM", "title": "Liked Music"})
        self.assertIsNone(out["count"])

    def test_sorting_by_count_is_numeric(self):
        rows = [
            _project_playlist_summary({"playlistId": "a", "count": "95"}),
            _project_playlist_summary({"playlistId": "b", "count": "160"}),
            _project_playlist_summary({"playlistId": "c", "count": "15"}),
        ]
        self.assertEqual(
            [r["playlist_id"] for r in sorted(rows, key=lambda r: r["count"])],
            ["c", "a", "b"],
        )


class TestTruncationHint(unittest.TestCase):
    def test_no_hint_when_nothing_was_cut(self):
        self.assertIsNone(_truncation_hint(160, 160, cap=200))
        self.assertIsNone(_truncation_hint(28, 28, cap=200))

    def test_cut_by_limit_advises_raising_it(self):
        # The platform note says "narrow the query"; for these tools that is
        # backwards, and the payload has to say so.
        hint = _truncation_hint(100, 160, cap=200)
        self.assertIn("limit: 160", hint)
        self.assertNotIn("Narrow", hint)

    def test_beyond_cap_says_so_plainly(self):
        hint = _truncation_hint(200, 500, cap=200)
        self.assertIn("limit: 200", hint)
        self.assertIn("not reachable", hint)


class TestErrorClassification(unittest.TestCase):
    def test_auth_signals_produce_auth_expired(self):
        class Resp:
            status_code = 401

        class Boom(Exception):
            response = Resp()

        err = _upstream_error(Boom("nope"), "desktop")
        self.assertTrue(str(err).startswith("auth_expired:"))
        self.assertIn("dj_auth.py", str(err))

    def test_plain_failure_is_not_labelled_auth(self):
        err = _upstream_error(TimeoutError("read timed out"), "desktop")
        self.assertTrue(str(err).startswith("upstream_error:"))

    def test_operational_errors_never_carry_terminal_wording(self):
        """OperationalError raises ValueError on do-not-retry phrasing at
        construction. Upstream text is interpolated into our messages, so a
        freak match would turn a clean error into an opaque crash."""
        for text in ("do not retry", "Don't retry this", "NO RETRY", "will not retry"):
            scrubbed = _scrub(text)
            for phrase in ("do not retry", "don't retry", "no retry", "not retry"):
                self.assertNotIn(phrase, scrubbed.lower())
            # Constructing with the scrubbed text must not raise.
            OperationalError(f"upstream_error: {scrubbed}")

    def test_scrubbed_upstream_text_survives_classification(self):
        err = _upstream_error(RuntimeError("server said do not retry"), "surface")
        self.assertIsInstance(err, OperationalError)
        self.assertNotIn("do not retry", str(err).lower())


class TestCredentialState(unittest.TestCase):
    """"Not copied" and "copied but invisible to this process" are different
    problems with different fixes, and Path.exists() cannot tell them apart —
    it swallows PermissionError and reports False. On the Surface the credential
    arrives over RDP written by one user while Workshop runs as another, so the
    ACL case is live rather than hypothetical (spec §7 phase 4)."""

    def _with_path(self, path):
        return mock.patch.object(dj, "CREDENTIAL_PATH", path)

    def test_missing_directory_says_nothing_was_copied(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "absent" / "browser.json"
            with self._with_path(p):
                ok, detail = dj.credential_state()
        self.assertFalse(ok)
        self.assertIn("no credential directory", detail)
        self.assertIn("nothing has been copied", detail)

    def test_readable_directory_without_the_file_is_a_FAILED_COPY(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "headers.txt").write_text("x", encoding="utf-8")
            p = Path(d) / "browser.json"
            with self._with_path(p):
                ok, detail = dj.credential_state()
        self.assertFalse(ok)
        self.assertIn("missing or failed copy", detail)
        self.assertIn("not a permissions problem", detail)
        # It names what IS there, which is the evidence for that conclusion.
        self.assertIn("headers.txt", detail)

    def test_unlistable_directory_is_reported_as_AN_ACL_PROBLEM(self):
        # The case the old code got wrong: it reported "no credential file",
        # sending the reader after a failed copy instead of a directory ACL.
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "browser.json"
            with self._with_path(p), mock.patch.object(
                Path, "iterdir", side_effect=PermissionError(13, "denied")
            ):
                ok, detail = dj.credential_state()
        self.assertFalse(ok)
        self.assertIn("EXISTS but this process cannot list it", detail)
        self.assertIn("NOT a failed copy", detail)
        self.assertNotIn("no credential file at", detail)

    def test_unstattable_file_is_reported_as_present_but_inaccessible(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "browser.json"
            p.write_text("{}", encoding="utf-8")
            with self._with_path(p), mock.patch.object(
                Path, "stat", side_effect=PermissionError(13, "denied")
            ):
                ok, detail = dj.credential_state()
        self.assertFalse(ok)
        self.assertIn("It EXISTS", detail)
        self.assertIn("not a missing file", detail)

    def test_a_good_credential_still_passes(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "browser.json"
            p.write_text('{"cookie": "redacted", "user-agent": "x"}', encoding="utf-8")
            with self._with_path(p):
                ok, detail = dj.credential_state()
        self.assertTrue(ok)
        self.assertIn("present, readable", detail)

    def test_no_cookie_header_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "browser.json"
            p.write_text('{"user-agent": "x"}', encoding="utf-8")
            with self._with_path(p):
                ok, detail = dj.credential_state()
        self.assertFalse(ok)
        self.assertIn("no Cookie header", detail)

    def test_detail_never_leaks_credential_contents(self):
        secret = "SAPISID=THIS_MUST_NEVER_APPEAR"
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "browser.json"
            p.write_text('{"cookie": "%s"}' % secret, encoding="utf-8")
            with self._with_path(p):
                _, detail = dj.credential_state()
        self.assertNotIn(secret, detail)
        self.assertNotIn("SAPISID", detail)


class TestConstants(unittest.TestCase):
    def test_known_buckets_match_the_precision_ladder(self):
        # spec §4.2 — exact/day from Today+Yesterday, week/fortnight from the
        # other two. A new label appearing upstream should fail loudly here.
        self.assertEqual(KNOWN_BUCKETS, ("Today", "Yesterday", "This week", "Last week"))

    def test_page_full_threshold(self):
        self.assertEqual(PAGE_FULL_AT, 200)


if __name__ == "__main__":
    unittest.main()
