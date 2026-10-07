"""get_dj_artist_top_songs — Drive Mix's artist seed.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import unittest
import unittest.mock as mock
from typing import Any

from workshop.platform import OperationalError
from workshop.tools.dj_write import get_dj_artist_top_songs


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


def _run(fake: _Fake, args: dict):
    with mock.patch("workshop.tools.dj_write._call", fake):
        return asyncio.run(get_dj_artist_top_songs(args, _Ctx()))


def _song(n: int) -> dict:
    return {"videoId": f"v{n}", "title": f"Song {n}",
            "artists": [{"name": "Bryan Adams", "id": "UC_ba"}],
            "album": {"name": "Reckless", "id": "MPREb_r"}}


PAGE = {
    "name": "Bryan Adams",
    "channelId": "UC_ba",
    "songs": {"browseId": "VLPL_top", "results": [_song(1), _song(2), _song(3)]},
}


class TopSongsTests(unittest.TestCase):
    def test_clean_name_match(self):
        fake = _Fake({
            "search": [
                {"artist": "Bryan Adams", "browseId": "UC_ba", "subscribers": "3.1M"},
                {"artist": "Bryan Adams Tribute", "browseId": "UC_tr"},
            ],
            "get_artist": PAGE,
        })
        d = _run(fake, {"artist": "bryan adams", "limit": 2})["data"]
        self.assertEqual(fake.calls[0], ("search", {"query": "bryan adams", "filter": "artists", "limit": 10}))
        self.assertEqual(fake.calls[1], ("get_artist", {"channelId": "UC_ba"}))
        self.assertTrue(d["resolved"])
        self.assertEqual((d["artist"], d["channel_id"]), ("Bryan Adams", "UC_ba"))
        self.assertEqual([s["video_id"] for s in d["songs"]], ["v1", "v2"])
        self.assertEqual(d["songs"][0]["position"], 1)
        self.assertEqual(d["songs"][0]["album"], {"name": "Reckless", "id": "MPREb_r"})
        self.assertEqual(len(fake.calls), 2, "limit within the page needs no songs-list read")

    def test_ambiguous_name_returns_candidates_and_no_songs(self):
        fake = _Fake({"search": [
            {"artist": "Nirvana", "browseId": "UC_us", "subscribers": "9M"},
            {"artist": "Nirvana", "browseId": "UC_uk", "subscribers": "20K"},
        ]})
        d = _run(fake, {"artist": "Nirvana"})["data"]
        self.assertFalse(d["resolved"])
        self.assertEqual(d["songs"], [])
        self.assertEqual([c["channel_id"] for c in d["candidates"]], ["UC_us", "UC_uk"])
        self.assertEqual(d["candidates"][1]["subscribers"], "20K")
        self.assertEqual([c[0] for c in fake.calls], ["search"], "never reads an artist page")

    def test_no_exact_match_is_not_resolved_either(self):
        fake = _Fake({"search": [{"artist": "Bryan Adams Tribute", "browseId": "UC_tr"}]})
        d = _run(fake, {"artist": "Bryan Adams"})["data"]
        self.assertFalse(d["resolved"])
        self.assertEqual(d["candidates"][0]["channel_id"], "UC_tr")

    def test_channel_id_input_skips_search(self):
        fake = _Fake({"get_artist": PAGE})
        d = _run(fake, {"channel_id": " UC_ba ", "limit": 3})["data"]
        self.assertEqual(fake.calls, [("get_artist", {"channelId": "UC_ba"})])
        self.assertEqual(d["returned"], 3)
        self.assertEqual(d["source"], "artist_page")

    def test_limit_above_the_page_fills_from_the_songs_list_in_order(self):
        full = {"tracks": [_song(1), _song(2), _song(3), _song(4), _song(5), _song(6)]}
        fake = _Fake({"get_artist": PAGE, "get_playlist": full})
        d = _run(fake, {"channel_id": "UC_ba", "limit": 5})["data"]
        self.assertEqual(fake.calls[1], ("get_playlist", {"playlistId": "VLPL_top", "limit": 5}))
        self.assertEqual([s["video_id"] for s in d["songs"]], ["v1", "v2", "v3", "v4", "v5"])
        self.assertEqual([s["position"] for s in d["songs"]], [1, 2, 3, 4, 5])
        self.assertEqual(d["source"], "artist_page+full_songs_list")

    def test_artist_with_no_songs_section(self):
        fake = _Fake({"get_artist": {"name": "Obscure Act", "channelId": "UC_ob"}})
        d = _run(fake, {"channel_id": "UC_ob", "limit": 10})["data"]
        self.assertTrue(d["resolved"])
        self.assertEqual(d["songs"], [])
        self.assertEqual(d["source"], "none")
        self.assertIn("no songs section", d["reading"])

    def test_string_artist_and_album_are_projected(self):
        page = {"name": "Oasis", "songs": {"results": [
            {"videoId": "w1", "title": "Wonderwall", "artist": "Oasis", "album": "Morning Glory", "year": "1995"}]}}
        s = _run(_Fake({"get_artist": page}), {"channel_id": "UC_oa"})["data"]["songs"][0]
        self.assertEqual(s["artists"], [{"name": "Oasis", "id": None}])
        self.assertEqual(s["album"], {"name": "Morning Glory", "id": None})
        self.assertEqual(s["year"], "1995")

    def test_needs_exactly_one_of_artist_or_channel_id(self):
        for args in ({}, {"artist": "A", "channel_id": "UC_a"}, {"artist": "  "}):
            with self.subTest(args=args):
                with self.assertRaises(OperationalError):
                    _run(_Fake({}), args)

    def test_limit_is_capped(self):
        fake = _Fake({"get_artist": PAGE, "get_playlist": {"tracks": []}})
        d = _run(fake, {"channel_id": "UC_ba", "limit": 100})["data"]
        self.assertEqual(d["limit_applied"], 25)


if __name__ == "__main__":
    unittest.main()
