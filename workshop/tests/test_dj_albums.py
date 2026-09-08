"""Album reads — the Jazz thread's seed and its coverage input.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import unittest
import unittest.mock as mock
from typing import Any

from workshop.platform import OperationalError
from workshop.tools.dj import get_dj_album, get_dj_library_albums


class _Cfg:
    host_id = "surface"


class _Ctx:
    config = _Cfg()


class _Fake:
    def __init__(self, responses: dict):
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, host_id: str, method: str, **kwargs) -> Any:
        self.calls.append((method, kwargs))
        return self.responses.get(method)


def _run(fake: _Fake, fn, args: dict):
    with mock.patch("workshop.tools.dj._call", fake):
        return asyncio.run(fn(args, _Ctx()))


ALBUM = {
    "title": "Mingus Ah Um",
    "year": "1959",
    "audioPlaylistId": "OLAK5uy_queueable",
    "artists": [{"name": "Charles Mingus"}],
    "tracks": [
        {"videoId": "v1", "title": "Better Git It in Your Soul",
         "artists": [{"name": "Charles Mingus"}], "duration_seconds": 434},
        {"videoId": "v2", "title": "Goodbye Pork Pie Hat",
         "artists": [{"name": "Charles Mingus"}], "duration_seconds": 320},
    ],
}


class TrackListTests(unittest.TestCase):
    def test_tracks_come_back_ordered_and_1_indexed(self):
        out = _run(_Fake({"get_album": ALBUM}), get_dj_album, {"album_id": "MPREb_x"})
        d = out["data"]
        self.assertEqual([t["position"] for t in d["tracks"]], [1, 2])
        self.assertEqual(d["tracks"][1]["video_id"], "v2")
        self.assertEqual(d["track_count"], 2)

    def test_A_TRACK_WITH_NO_VIDEO_ID_IS_KEPT_AND_COUNTED(self):
        # 🛑 THE ONE THAT CORRUPTS COVERAGE SILENTLY. YouTube omits videoId for
        # tracks unavailable in the region. Dropping them SHORTENS the album, so
        # "3 of 9" becomes "3 of 7" and the album looks better covered than it
        # is — a wrong answer that reads as a right one, with no error anywhere.
        album = {**ALBUM, "tracks": ALBUM["tracks"] + [
            {"title": "Blocked Track", "artists": [{"name": "Charles Mingus"}]},
        ]}
        out = _run(_Fake({"get_album": album}), get_dj_album, {"album_id": "MPREb_x"})
        d = out["data"]
        self.assertEqual(d["track_count"], 3, "the album is 3 tracks long")
        self.assertIsNone(d["tracks"][2]["video_id"])
        self.assertEqual(d["tracks_without_video_id"], 1)
        self.assertIn("look better than it is", d["reading"])

    def test_the_queueable_id_is_returned_and_named_apart(self):
        # audioPlaylistId is what goes to replace_dj_playlist; browseId is what
        # identifies the album. Returning both, distinctly, is the whole point.
        out = _run(_Fake({"get_album": ALBUM}), get_dj_album, {"album_id": "MPREb_x"})
        self.assertEqual(out["data"]["album_id"], "MPREb_x")
        self.assertEqual(out["data"]["playlist_id"], "OLAK5uy_queueable")

    def test_artists_are_joined_into_one_string_like_dj_tracks(self):
        album = {**ALBUM, "artists": [{"name": "Miles Davis"}, {"name": "John Coltrane"}]}
        out = _run(_Fake({"get_album": album}), get_dj_album, {"album_id": "MPREb_x"})
        # ⚠️ ONE STRING, NOT SEVERAL — the same shape dj_tracks.artist has, so a
        # collaboration reads consistently across the system (§14.1).
        self.assertEqual(out["data"]["artist"], "Miles Davis, John Coltrane")


class RefusalTests(unittest.TestCase):
    def test_an_unresolvable_id_says_WHICH_ID_SHAPE_IS_WRONG(self):
        # 🛑 THE LIKELY MISTAKE IS PASSING THE playlistId. The error has to name
        # that, because "not found" sends someone looking for a missing album
        # when they are holding the right album under the wrong id.
        out = _Fake({"get_album": {}})
        with self.assertRaises(OperationalError) as cm:
            _run(out, get_dj_album, {"album_id": "OLAK5uy_wrong"})
        self.assertIn("browseId", str(cm.exception))
        self.assertIn("playlistId", str(cm.exception))

    def test_a_missing_album_id_is_refused_before_any_call(self):
        f = _Fake({})
        with self.assertRaises(OperationalError):
            _run(f, get_dj_album, {})
        self.assertEqual(f.calls, [])


class LibraryTests(unittest.TestCase):
    LIB = [
        {"browseId": "MPREb_a", "playlistId": "OLAK5uy_a", "title": "Bewitched",
         "artists": [{"name": "Eddie Higgins"}], "year": "1997", "type": "Album"},
        {"browseId": "MPREb_b", "playlistId": "OLAK5uy_b", "title": "Candy",
         "artists": [{"name": "Lee Morgan"}], "year": "1958", "type": "Album"},
    ]

    def test_bookmarks_come_back_with_BOTH_ids(self):
        out = _run(_Fake({"get_library_albums": self.LIB}), get_dj_library_albums, {})
        a = out["data"]["albums"][0]
        self.assertEqual(a["album_id"], "MPREb_a", "browseId is the album id")
        self.assertEqual(a["playlist_id"], "OLAK5uy_a", "playlistId is queueable")
        self.assertEqual(a["artist"], "Eddie Higgins")

    def test_the_full_library_is_read_so_total_is_REAL(self):
        # limit=None upstream, then sliced here — so `total` is the true count
        # rather than a guess from the page requested. A caller can tell it was
        # cut, which a page-limited read cannot support.
        f = _Fake({"get_library_albums": self.LIB})
        out = _run(f, get_dj_library_albums, {"limit": 1})
        self.assertEqual(out["data"]["returned"], 1)
        self.assertEqual(out["data"]["total"], 2)
        self.assertEqual(out["meta"]["truncated"], (1, 2))
        self.assertIsNone(f.calls[0][1]["limit"], "upstream must be unlimited")

    def test_the_reading_separates_BOOKMARKED_from_PLAYED(self):
        # ⚠️ Two different facts. An album here may never have been played, and
        # one played to death may not be here. This tool only knows the first,
        # and a Jazz thread reading it as listening would be wrong about both.
        out = _run(_Fake({"get_library_albums": self.LIB}), get_dj_library_albums, {})
        self.assertIn("BOOKMARKS, not listening", out["data"]["reading"])


if __name__ == "__main__":
    unittest.main()
