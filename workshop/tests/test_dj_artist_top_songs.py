"""get_dj_artist_top_songs — Drive Mix's artist seed, ranked by YouTube plays.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import time
import unittest
import unittest.mock as mock
from typing import Any

from workshop.platform import OperationalError
from workshop.tools.dj_write import (
    get_dj_artist_top_songs,
    normalise_title,
    parse_plays,
    variant_word,
)


class _Cfg:
    host_id = "surface"


class _Ctx:
    config = _Cfg()


class _Fake:
    """`search` answers by filter: artists -> list; songs -> dict of query -> hits."""

    def __init__(self, responses: dict):
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, host_id: str, method: str, **kwargs) -> Any:
        self.calls.append((method, kwargs))
        if method == "search" and kwargs.get("filter") == "songs":
            return self.responses.get("songs", {}).get(kwargs["query"], [])
        return self.responses.get(method)


def _run(fake: _Fake, args: dict):
    with mock.patch("workshop.tools.dj_write._call", fake):
        return asyncio.run(get_dj_artist_top_songs(args, _Ctx()))["data"]


def _item(vid: str, title: str, artist: str = "a-ha", aid: str = "UC_aha") -> dict:
    return {"videoId": vid, "title": title, "artists": [{"name": artist, "id": aid}],
            "album": {"name": "Album", "id": "MPREb_x"}}


def _hit(vid: str, title: str, views: str, artist: str = "a-ha") -> dict:
    return {"videoId": vid, "title": title, "views": views,
            "artists": [{"name": artist, "id": None}], "album": {"name": "Album", "id": None}}


def _page(name: str, items: list[dict], browse: str | None = None) -> dict:
    return {"name": name, "songs": {"browseId": browse, "results": items}}


class ParsingTests(unittest.TestCase):
    def test_plays_k_m_b(self):
        self.assertEqual(parse_plays("2.4K"), 2_400)
        self.assertEqual(parse_plays("133M"), 133_000_000)
        self.assertEqual(parse_plays("3.1B"), 3_100_000_000)
        self.assertEqual(parse_plays("1,234 plays"), 1_234)
        self.assertIsNone(parse_plays(None))
        self.assertIsNone(parse_plays("no plays"))

    def test_dedupe_collapses_bracket_dash_and_feat(self):
        base = normalise_title("Summer of '69")
        self.assertEqual(base, "summer of 69")
        for t in ("Summer Of 69 (Classic Version)", "Summer of 69 - Live At Wembley",
                  "Summer of '69 [2008 Remaster]", "Summer of 69 feat. Someone"):
            with self.subTest(t=t):
                self.assertEqual(normalise_title(t), base)

    def test_variant_flags_only_the_decoration(self):
        self.assertEqual(variant_word("Heaven (Live)"), "live")
        self.assertEqual(variant_word("Heaven (Classic Version)"), "version")
        self.assertEqual(variant_word("Take On Me - 2015 Remaster"), "remaster")
        self.assertEqual(variant_word("Take On Me (MTV Unplugged / Edit)"), "unplugged")
        self.assertIsNone(variant_word("Live Forever"))
        self.assertIsNone(variant_word("Heaven"))

    def test_taylors_version_is_not_a_variant(self):
        self.assertIsNone(variant_word("Love Story (Taylor's Version)"))
        self.assertIsNone(variant_word("Love Story (Taylor’s Version)"))
        self.assertEqual(variant_word("Love Story (Taylor's Version) (Live)"), "live")


class TopSongsTests(unittest.TestCase):
    def test_representative_is_the_original_and_plays_the_highest_version(self):
        page = _page("a-ha", [_item("v_live", "Take On Me (Live)"), _item("v_orig", "Take on Me")])
        fake = _Fake({"get_artist": page, "songs": {"a-ha take on me": [
            _hit("v_live", "Take On Me (Live)", "5M"),
            _hit("v_orig", "Take on Me", "3.1B"),
        ]}})
        d = _run(fake, {"channel_id": "UC_aha"})
        s = d["songs"][0]
        self.assertEqual((s["video_id"], s["variant"], s["plays"]), ("v_orig", False, 3_100_000_000))
        self.assertEqual(s["versions_merged"]["count"], 2)
        self.assertIsNone(s["original_candidate"])
        self.assertEqual(d["distinct_songs"], 1)

    def test_only_variants_most_played_represents_and_original_is_offered(self):
        page = _page("Bryan Adams", [
            _item("v_cl", "Heaven (Classic Version)", "Bryan Adams", "UC_ba"),
            _item("v_lv", "Heaven (Live)", "Bryan Adams", "UC_ba"),
        ])
        fake = _Fake({"get_artist": page, "songs": {"Bryan Adams heaven": [
            _hit("v_lv", "Heaven (Live)", "2M", "Bryan Adams"),
            _hit("v_cl", "Heaven (Classic Version)", "40M", "Bryan Adams"),
            _hit("v_og", "Heaven", "90M", "Bryan Adams"),
            _hit("v_cv", "Heaven", "500M", "Someone Else"),
        ]}})
        s = _run(fake, {"channel_id": "UC_ba"})["songs"][0]
        self.assertEqual((s["video_id"], s["variant_word"]), ("v_cl", "version"))
        self.assertEqual(s["plays"], 90_000_000, "the same-artist upload is a version of the song")
        self.assertEqual(s["original_candidate"]["video_id"], "v_og")
        self.assertEqual(s["original_candidate"]["plays"], 90_000_000)

    def test_unmatched_song_has_null_plays_and_is_never_suggested(self):
        page = _page("a-ha", [_item("v1", "Take on Me"), _item("v2", "Lifelines")])
        fake = _Fake({"get_artist": page, "songs": {
            "a-ha take on me": [_hit("v1", "Take on Me", "3.1B")],
            "a-ha lifelines": [_hit("vx", "Lifelines", "50M", "Other Band")],
        }})
        d = _run(fake, {"channel_id": "UC_aha", "suggest_floor": 0, "suggest_ratio": 0.0001})
        last = d["songs"][-1]
        self.assertEqual(last["title"], "Lifelines")
        self.assertIsNone(last["plays"])
        self.assertFalse(last["suggested"])

    def test_suggested_a_ha_style_one_hit(self):
        titles = {"Take on Me": "3.1B", "Stay on These Roads": "133M", "Hunting High and Low": "90M"}
        page = _page("a-ha", [_item(f"v{i}", t) for i, t in enumerate(titles)])
        fake = _Fake({"get_artist": page, "songs": {
            f"a-ha {normalise_title(t)}": [_hit(f"v{i}", t, p)] for i, (t, p) in enumerate(titles.items())}})
        d = _run(fake, {"channel_id": "UC_aha"})
        self.assertEqual([s["title"] for s in d["songs"] if s["suggested"]], ["Take on Me"])
        self.assertEqual(d["thresholds"]["plays_needed"], 310_000_000)
        self.assertEqual([s["position"] for s in d["songs"]], [1, 2, 3])

    def test_suggested_toto_style_two_hits_and_the_floor(self):
        titles = {"Africa": "2B", "Hold the Line": "400M", "Rosanna": "150M", "Georgy Porgy": "9M"}
        page = _page("TOTO", [_item(f"v{i}", t, "TOTO", "UC_toto") for i, t in enumerate(titles)])
        fake = _Fake({"get_artist": page, "songs": {
            f"TOTO {normalise_title(t)}": [_hit(f"v{i}", t, p, "TOTO")] for i, (t, p) in enumerate(titles.items())}})
        d = _run(fake, {"channel_id": "UC_toto"})
        self.assertEqual([s["title"] for s in d["songs"] if s["suggested"]], ["Africa", "Hold the Line"])
        low = _run(fake, {"channel_id": "UC_toto", "suggest_ratio": 0.001})
        self.assertNotIn("Georgy Porgy", [s["title"] for s in low["songs"] if s["suggested"]],
                         "9M is under the 10M floor whatever the ratio")

    def test_scan_cap_fills_from_the_songs_list_and_caps(self):
        page = _page("a-ha", [_item("v1", "Song 1")], browse="VLPL_all")
        full = {"tracks": [_item(f"v{i}", f"Song {i}") for i in range(1, 8)]}
        fake = _Fake({"get_artist": page, "get_playlist": full})
        d = _run(fake, {"channel_id": "UC_aha", "limit": 5})
        self.assertIn(("get_playlist", {"playlistId": "VLPL_all", "limit": 5}), fake.calls)
        self.assertEqual(d["scanned"], 5)
        self.assertEqual(_run(_Fake({"get_artist": page}), {"channel_id": "UC_aha", "limit": 500})["limit_applied"], 100)

    def test_ambiguous_name_returns_candidates_and_no_songs(self):
        fake = _Fake({
            "search": [
                {"artist": "Toto", "browseId": "UC_band"},
                {"artist": "toto", "browseId": "UC_other", "subscribers": "20"},
            ],
            "get_artist": {"subscribers": "1.51M", "songs": {"results": [_item("v1", "Africa")]}},
        })
        d = _run(fake, {"artist": "Toto"})
        self.assertFalse(d["resolved"])
        self.assertEqual(d["songs"], [])
        self.assertEqual([c["channel_id"] for c in d["candidates"]], ["UC_band", "UC_other"])
        self.assertEqual(d["candidates"][0]["subscribers"], "1.51M", "filled from the artist page")
        self.assertEqual(d["candidates"][1]["subscribers"], "20", "search's value is kept")
        self.assertEqual(d["candidates"][0]["top_songs"], ["Africa"])
        self.assertNotIn("songs", [c[1].get("filter") for c in fake.calls], "no play-count searches")

    def test_clean_name_resolves(self):
        fake = _Fake({"search": [{"artist": "a-ha", "browseId": "UC_aha"}],
                      "get_artist": _page("a-ha", [_item("v1", "Take on Me")])})
        d = _run(fake, {"artist": "A-HA"})
        self.assertTrue(d["resolved"])
        self.assertEqual(d["channel_id"], "UC_aha")

    def test_no_songs_section(self):
        d = _run(_Fake({"get_artist": {"name": "Obscure Act"}}), {"channel_id": "UC_ob"})
        self.assertEqual((d["songs"], d["distinct_songs"]), ([], 0))
        self.assertIn("no songs section", d["reading"])

    def test_bad_arguments(self):
        for args in ({}, {"artist": "A", "channel_id": "UC_a"}, {"channel_id": "UC_a", "suggest_ratio": 2},
                     {"channel_id": "UC_a", "suggest_floor": -1}, {"channel_id": "UC_a", "time_budget_seconds": 1}):
            with self.subTest(args=args):
                with self.assertRaises(OperationalError):
                    _run(_Fake({}), args)


TITLES = {f"Song {i}": f"{(20 - i) * 10}M" for i in range(12)}


def _many(delays: dict | None = None, fail: set | None = None) -> _Fake:
    """12 songs; each search can be delayed or made to fail, by normalised title."""
    page = _page("a-ha", [_item(f"v{i}", t) for i, t in enumerate(TITLES)])

    class _Slow(_Fake):
        async def __call__(self, host_id, method, **kwargs):
            if method == "search" and kwargs.get("filter") == "songs":
                norm = kwargs["query"].removeprefix("a-ha ")
                await asyncio.sleep((delays or {}).get(norm, 0))
                if norm in (fail or set()):
                    raise OperationalError("upstream_error: boom")
            return await super().__call__(host_id, method, **kwargs)

    return _Slow({"get_artist": page, "songs": {
        f"a-ha {normalise_title(t)}": [_hit(f"v{i}", t, p)] for i, (t, p) in enumerate(TITLES.items())}})


def _run_env(fake: _Fake, args: dict):
    with mock.patch("workshop.tools.dj_write._call", fake):
        return asyncio.run(get_dj_artist_top_songs(args, _Ctx()))


class ConcurrencyTests(unittest.TestCase):
    def test_completion_order_does_not_change_the_result(self):
        # Reverse the natural finish order: the first song finishes last.
        delays = {normalise_title(t): 0.01 * (12 - i) for i, t in enumerate(TITLES)}
        with mock.patch("workshop.tools.dj_write.LOOKUP_CONCURRENCY", 1):
            sequential = _run(_many(), {"channel_id": "UC_aha"})
        concurrent = _run(_many(delays), {"channel_id": "UC_aha"})
        strip = lambda d: [(s["title"], s["plays"], s["suggested"], s["position"]) for s in d["songs"]]
        self.assertEqual(strip(concurrent), strip(sequential))

    def test_lookups_overlap(self):
        delays = {normalise_title(t): 0.2 for t in TITLES}
        t0 = time.monotonic()
        _run(_many(delays), {"channel_id": "UC_aha"})
        self.assertLess(time.monotonic() - t0, 12 * 0.2 / 2, "12 x 0.2s lookups should overlap")

    def test_budget_stops_lookups_and_marks_truncated(self):
        delays = {normalise_title(t): 2.0 for t in TITLES}
        with mock.patch("workshop.tools.dj_write.BUDGET_MIN", 0.1), \
             mock.patch("workshop.tools.dj_write.BUDGET_GRACE", 0.1):
            t0 = time.monotonic()
            env = _run_env(_many(delays), {"channel_id": "UC_aha", "time_budget_seconds": 0.5})
            took = time.monotonic() - t0
        d = env["data"]
        self.assertLess(took, 1.5, "must return near budget + grace, not after every lookup")
        self.assertEqual(d["not_looked_up"], 12)
        self.assertEqual(env["meta"]["truncated"], (0, 12))
        self.assertTrue(all(s["plays"] is None and not s["suggested"] for s in d["songs"]))
        self.assertIn("smaller limit", d["reading"])

    def test_one_failed_lookup_does_not_fail_the_call(self):
        env = _run_env(_many(fail={"song 0"}), {"channel_id": "UC_aha"})
        d = env["data"]
        self.assertEqual(len(d["lookup_errors"]), 1)
        self.assertIn("song 0", d["lookup_errors"][0])
        self.assertIsNone(next(s for s in d["songs"] if s["title"] == "Song 0")["plays"])
        self.assertEqual(d["songs"][0]["title"], "Song 1")
        self.assertEqual(env["meta"], {})


class _SlowMethods(_Fake):
    def __init__(self, responses: dict, delays: dict):
        super().__init__(responses)
        self.delays = delays

    async def __call__(self, host_id, method, **kwargs):
        await asyncio.sleep(self.delays.get(method, 0))
        return await super().__call__(host_id, method, **kwargs)


class Step6Tests(unittest.TestCase):
    def test_new_defaults(self):
        import workshop.tools.dj_write as w
        self.assertEqual((w.SCAN_DEFAULT, w.BUDGET_DEFAULT, w.LOOKUP_CONCURRENCY), (30, 20, 8))
        d = _run(_Fake({"get_artist": _page("a-ha", [])}), {"channel_id": "UC_aha"})
        self.assertEqual((d["limit_applied"], d["time_budget_seconds"]), (30, 20))

    def test_guest_credit_is_listed_but_never_suggested(self):
        page = _page("Bryan Adams", [
            _item("v1", "Summer of 69", "Bryan Adams", "UC_ba"),
            {"videoId": "v2", "title": "'O Sole Mio", "album": None,
             "artists": [{"name": "Luciano Pavarotti", "id": "UC_lp"}, {"name": "Bryan Adams", "id": "UC_ba"}]},
        ])
        fake = _Fake({"get_artist": page, "songs": {
            "Bryan Adams summer of 69": [_hit("v1", "Summer of 69", "40M", "Bryan Adams")],
            "Bryan Adams o sole mio": [_hit("v2", "'O Sole Mio", "900M", "Luciano Pavarotti")],
        }})
        d = _run(fake, {"channel_id": "UC_ba"})
        guest = next(s for s in d["songs"] if s["video_id"] == "v2")
        own = next(s for s in d["songs"] if s["video_id"] == "v1")
        self.assertEqual((guest["guest"], guest["suggested"], guest["plays"]), (True, False, 900_000_000))
        self.assertEqual((own["guest"], own["suggested"]), (False, True))
        self.assertEqual(d["thresholds"]["top_plays"], 40_000_000, "a guest spot does not set the bar")

    def test_budget_covers_a_slow_artist_page(self):
        fake = _SlowMethods({"get_artist": _page("a-ha", [])}, {"get_artist": 2.0})
        with mock.patch("workshop.tools.dj_write.BUDGET_MIN", 0.1), \
             mock.patch("workshop.tools.dj_write.BUDGET_GRACE", 0.1):
            t0 = time.monotonic()
            with self.assertRaises(OperationalError) as cm:
                _run(fake, {"channel_id": "UC_aha", "time_budget_seconds": 0.3})
            self.assertLess(time.monotonic() - t0, 1.2)
        self.assertIn("upstream_timeout: the artist page", str(cm.exception))

    def test_budget_covers_a_slow_songs_list(self):
        page = _page("a-ha", [_item("v1", "Take on Me")], browse="VLPL_all")
        fake = _SlowMethods({"get_artist": page, "get_playlist": {"tracks": []}}, {"get_playlist": 2.0})
        with mock.patch("workshop.tools.dj_write.BUDGET_MIN", 0.1), \
             mock.patch("workshop.tools.dj_write.BUDGET_GRACE", 0.1):
            t0 = time.monotonic()
            d = _run(fake, {"channel_id": "UC_aha", "time_budget_seconds": 0.3})
            self.assertLess(time.monotonic() - t0, 1.2)
        self.assertEqual(d["songs_list_read"], "timed_out")
        self.assertEqual([s["title"] for s in d["songs"]], ["Take on Me"], "the page's songs are kept")


if __name__ == "__main__":
    unittest.main()
