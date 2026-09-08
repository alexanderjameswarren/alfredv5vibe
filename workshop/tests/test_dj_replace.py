"""replace_dj_playlist — the Jazz thread's write path.

The whole premise of the Jazz thread is that a suggestion is a WRITE rather than
a sentence: "it's in Today's Jazz" instead of "try Mingus Ah Um". Overwriting a
fixed working playlist used to be five calls — a contents read for the handles,
a tier-3 removal, an add, a second contents read, and a record. Five calls per
suggestion is the friction problem moved, not solved.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import unittest
import unittest.mock as mock
from typing import Any

from workshop.platform import OperationalError
from workshop.tools.dj_write import replace_dj_playlist, _preview_replace


class _Cfg:
    host_id = "surface"


class _Ctx:
    config = _Cfg()


def _playlist(n_tracks: int, *, with_handles: bool = True) -> dict:
    return {
        "id": "PL_today",
        "title": "Today's Jazz",
        "trackCount": n_tracks,
        "tracks": [
            {
                "videoId": f"old{i}",
                "title": f"Old {i}",
                **({"setVideoId": f"sv{i}"} if with_handles else {}),
            }
            for i in range(n_tracks)
        ],
    }


class _Recorder:
    """Records the ORDER of ytmusicapi calls, which is what is under test."""

    def __init__(self, playlist: dict, fail_on: str | None = None):
        self.playlist = playlist
        self.fail_on = fail_on
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, host_id: str, method: str, **kwargs) -> Any:
        self.calls.append((method, kwargs))
        if method == self.fail_on:
            raise OperationalError(f"upstream_error: {method} failed")
        if method == "get_playlist":
            return self.playlist
        return {"status": "STATUS_SUCCEEDED"}

    @property
    def order(self) -> list[str]:
        return [m for m, _ in self.calls]


def _run(rec: _Recorder, args: dict):
    with mock.patch("workshop.tools.dj_write._call", rec):
        return asyncio.run(replace_dj_playlist(args, _Ctx()))


class OrderingTests(unittest.TestCase):
    """🛑 ADDS RUN BEFORE REMOVALS, AND THAT IS THE DESIGN, NOT A DETAIL.

    Clear-then-fill has a failure mode worse than either end state: if the add
    fails after the remove succeeded, the playlist is EMPTY — and an empty
    Today's Jazz is precisely when YouTube autoplay takes over and the evening
    ends up somewhere random. That is the thing this playlist exists to prevent.

    Adding first means a partial failure leaves the old contents plus some new
    ones: untidy, still playable, and visibly wrong to a human.
    """

    def test_the_add_happens_BEFORE_the_remove(self):
        rec = _Recorder(_playlist(3))
        _run(rec, {"playlist_id": "PL_today", "video_ids": ["a", "b"]})
        self.assertEqual(
            rec.order,
            ["get_playlist", "add_playlist_items", "remove_playlist_items"],
            "clear-then-fill leaves the playlist empty when the add fails",
        )

    def test_a_FAILED_ADD_leaves_the_old_contents_alone(self):
        # 🛑 THE CASE THE ORDER EXISTS FOR. The add throws, so nothing is
        # removed and the playlist still plays what it played yesterday.
        rec = _Recorder(_playlist(3), fail_on="add_playlist_items")
        with self.assertRaises(OperationalError):
            _run(rec, {"playlist_id": "PL_today", "video_ids": ["a"]})
        self.assertNotIn(
            "remove_playlist_items", rec.order,
            "a failed add must never be followed by a removal",
        )

    def test_the_removal_targets_what_was_captured_BEFORE_the_add(self):
        # A new track duplicating an old one leaves both rows briefly; the OLD
        # row is the one removed, because it is the one whose handle we hold.
        rec = _Recorder(_playlist(2))
        _run(rec, {"playlist_id": "PL_today", "video_ids": ["old0", "new"]})
        removed = [k for m, k in rec.calls if m == "remove_playlist_items"][0]
        self.assertEqual(
            [v["setVideoId"] for v in removed["videos"]], ["sv0", "sv1"],
            "must remove the handles read before the add, not re-read after",
        )

    def test_adds_allow_duplicates_or_the_transient_overlap_would_fail(self):
        rec = _Recorder(_playlist(1))
        _run(rec, {"playlist_id": "PL_today", "video_ids": ["old0"]})
        add = [k for m, k in rec.calls if m == "add_playlist_items"][0]
        self.assertTrue(add["duplicates"])


class RefusalTests(unittest.TestCase):
    def test_AN_EMPTY_LIST_IS_REFUSED(self):
        # An empty working playlist is exactly when autoplay takes over, so
        # emptying one is deliberate work for remove_from_dj_playlist rather
        # than a side effect of a replace that was handed nothing.
        rec = _Recorder(_playlist(3))
        for bad in ([], None):
            with self.assertRaises(OperationalError) as cm:
                _run(rec, {"playlist_id": "PL_today", "video_ids": bad})
            self.assertIn("autoplay", str(cm.exception))
        self.assertEqual(rec.order, [], "nothing may be called on a refusal")

    def test_an_unresolvable_playlist_id_stops_before_writing(self):
        rec = _Recorder({"tracks": [], "title": None})
        with self.assertRaises(OperationalError) as cm:
            _run(rec, {"playlist_id": "PL_typo", "video_ids": ["a"]})
        self.assertIn("not_found", str(cm.exception))
        self.assertNotIn("add_playlist_items", rec.order)


class LeftoverTests(unittest.TestCase):
    """⚠️ A ROW WITH NO setVideoId CANNOT BE REMOVED, AND SURVIVES THE REPLACE."""

    def test_unremovable_rows_are_REPORTED_not_swallowed(self):
        # Silently leaving rows behind would look like it worked and drift a
        # little further every night — the playlist would slowly stop being
        # "today's" and nobody would know when it started.
        rec = _Recorder(_playlist(2, with_handles=False))
        out = _run(rec, {"playlist_id": "PL_today", "video_ids": ["a"]})
        self.assertEqual(len(out["data"]["unremovable_entries"]), 2)
        self.assertEqual(out["data"]["tracks_removed"], 0)
        self.assertIn("STILL IN THE PLAYLIST", out["data"]["reading"])


class PreviewTests(unittest.TestCase):
    """The tier-3 gate stops accidental execution; the preview stops a WRONG TARGET."""

    def test_the_preview_names_the_TITLE(self):
        # 🛑 "Today's Jazz" and a concert playlist are one keystroke apart in an
        # id and worlds apart in consequence. The title is the only field a
        # human can actually check against their intent.
        rec = _Recorder(_playlist(4))
        with mock.patch("workshop.tools.dj_write._call", rec):
            out = asyncio.run(
                _preview_replace(
                    {"playlist_id": "PL_today", "video_ids": ["a", "b"]}, _Ctx()
                )
            )
        self.assertEqual(out["title"], "Today's Jazz")
        self.assertEqual(out["tracks_now"], 4)
        self.assertEqual(out["tracks_after"], 2)

    def test_the_preview_writes_nothing(self):
        rec = _Recorder(_playlist(4))
        with mock.patch("workshop.tools.dj_write._call", rec):
            asyncio.run(
                _preview_replace({"playlist_id": "PL_today", "video_ids": ["a"]}, _Ctx())
            )
        self.assertEqual(rec.order, ["get_playlist"], "a preview is read-only")


if __name__ == "__main__":
    unittest.main()
