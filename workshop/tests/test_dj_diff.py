"""Resolution rules for diff_dj_setlists — spec §12.7, §12.11, §12.4.

These are the pure functions: no network, no setlist.fm, no ytmusicapi. The
whole point of putting the diff in code rather than in the weekly prompt was
that a model recomputing it drifts in ways no diff shows, because a plausible
answer is indistinguishable from a correct one. That argument only holds if the
code is pinned.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import unittest

from workshop.tools.dj_setlists import _norm_title, _resolve_one

FF = "Foo Fighters"


def r(title, artists, album=None, secs=None, vid=None):
    return {"video_id": vid or f"v_{title[:6]}_{album or ''}".replace(" ", ""),
            "title": title, "artists": artists, "album": album,
            "duration_seconds": secs, "duration": None}


class TitleMatchTests(unittest.TestCase):
    """🛑 THE BUG THE FIRST BUILD SHIPPED, AND WHY IT WAS INVISIBLE.

    The resolver filtered on ARTIST and never on TITLE. YouTube search answers a
    query it cannot match with the artist's POPULAR TRACKS, so "Foo Fighters
    A320" returns seventeen Foo Fighters songs, none of them A320 — and every
    one passed an artist-only filter. The first live run reported 13 of 13
    missing songs as "ambiguous", each with twenty alternatives.

    ⚠️ Doing this by hand, the title comparison happens by eye and is invisible.
    Encoding it, it is exactly the step that gets left out — and the failure
    LOOKS like a hard decision rather than a broken search.
    """

    def test_popular_tracks_are_not_candidates(self):
        results = [r("Everlong", [FF], "The Colour And The Shape", 251),
                   r("Monkey Wrench", [FF], "The Colour And The Shape", 232),
                   r("Big Me", [FF], "Foo Fighters", 133)]
        out = _resolve_one(results, "A320", FF)
        self.assertEqual(out["resolution"], "not_found")
        self.assertIsNone(out["video_id"])
        # The message must say the list means NO match, or a reader sees three
        # Foo Fighters songs and assumes a choice was available.
        self.assertIn("all with other titles", out["why"])

    def test_a_long_result_list_is_not_evidence_of_a_choice(self):
        results = [r(f"Song {i}", [FF], "Album", 200 + i) for i in range(20)]
        out = _resolve_one(results, "Tap Dancing in a Minefield", FF)
        self.assertEqual(out["resolution"], "not_found")


class ArtistMatchTests(unittest.TestCase):
    """§12.4 — the PERFORMING artist's version, or it is not in the playlist."""

    def test_right_title_wrong_artist_is_not_found(self):
        # One Headlight, live: the real case. It exists, as The Wallflowers'.
        results = [r("One Headlight", ["The Wallflowers"], "Bringing Down the Horse", 313)]
        out = _resolve_one(results, "One Headlight", FF)
        self.assertEqual(out["resolution"], "not_found")
        self.assertIn("The Wallflowers", out["why"])

    def test_the_other_artists_are_RETURNED_not_just_counted(self):
        # ⚠️ A bare "not found" hides that the song exists under another act.
        # The candidates travel with the verdict so a human can see what was
        # there without searching again.
        results = [r("London Calling", ["The Clash"], "London Calling", 201)]
        out = _resolve_one(results, "London Calling", FF)
        self.assertEqual(len(out["other_artists_found"]), 1)
        self.assertEqual(out["other_artists_found"][0]["artists"], ["The Clash"])

    def test_artist_match_is_case_and_punctuation_insensitive(self):
        results = [r("Everlong", ["foo fighters"], "The Colour And The Shape", 251)]
        self.assertEqual(_resolve_one(results, "Everlong", FF)["resolution"], "resolved")


class SameMasterTests(unittest.TestCase):
    """§12.11 rule 3 — within two seconds is the same master, so do not ask."""

    def test_razor_resolves_silently(self):
        # The live case, and the one that was escalated to a human by hand.
        # In Your Honor 4:54 against Catch And Release 4:53.
        results = [r("Razor", [FF], "In Your Honor", 294, vid="FBnH6sBvnl0"),
                   r("Razor", [FF], "Catch And Release", 293, vid="JSTGZqaEtkA")]
        out = _resolve_one(results, "Razor", FF)
        self.assertEqual(out["resolution"], "resolved")
        self.assertEqual(out["video_id"], "FBnH6sBvnl0")
        # The alternative is kept, so the choice is visible without being a
        # question — "it does not change what is heard" has to be checkable.
        self.assertEqual(len(out["same_master_alternatives"]), 1)

    def test_genuinely_different_recordings_ARE_escalated(self):
        # ⚠️ THE NEGATIVE CONTROL for the rule above. If the 2-second window
        # swallowed everything, nothing would ever be escalated and the
        # ambiguous path would be dead code that looks like caution.
        results = [r("Song", [FF], "Studio", 200, vid="a"),
                   r("Song", [FF], "Rerecorded", 260, vid="b")]
        out = _resolve_one(results, "Song", FF)
        self.assertEqual(out["resolution"], "ambiguous_same_artist")
        self.assertIsNone(out["video_id"])

    def test_an_escalation_carries_what_is_needed_to_decide_it(self):
        # Not a flag saying "ambiguous" — the data to choose from. Album and
        # duration are what distinguish two studio cuts, so they travel with
        # the question rather than requiring another search.
        results = [r("Song", [FF], "Studio", 200, vid="a"),
                   r("Song", [FF], "Rerecorded", 260, vid="b")]
        out = _resolve_one(results, "Song", FF)
        for c in out["candidates"]:
            self.assertIsNotNone(c["album"])
            self.assertIsNotNone(c["duration_seconds"])
            self.assertIsNotNone(c["video_id"])


class VariantTests(unittest.TestCase):
    """A live or acoustic cut is not what a setlist entry is asking for."""

    def test_variants_are_dropped_before_the_tie_break(self):
        results = [r("Razor (Live Acoustic)", [FF], "01050525", 288),
                   r("Razor", [FF], "In Your Honor", 294, vid="studio")]
        out = _resolve_one(results, "Razor", FF)
        self.assertEqual(out["resolution"], "resolved")
        self.assertEqual(out["video_id"], "studio")

    def test_a_karaoke_result_never_resolves(self):
        results = [r("Razor (Originally Performed By The Foo Fighters) {Karaoke}",
                     ["A* Karaoke"], "Karaoke Songbook", 258)]
        self.assertEqual(_resolve_one(results, "Razor", FF)["resolution"], "not_found")

    def test_only_variants_by_the_right_artist_is_still_not_found(self):
        results = [r("Marigold (Live at the Pantages Theatre)", [FF], "Skin And Bones", 200)]
        out = _resolve_one(results, "Marigold", FF)
        self.assertEqual(out["resolution"], "not_found")
        self.assertIn("variant", out["why"])


class NormaliseTests(unittest.TestCase):
    """Conservative by design: strip DECORATION, never content.

    An aggressive normaliser merges two genuinely different songs. This feeds a
    diff whose false negatives cost one listen and whose false positives cost a
    song Alex does not know when the lights go down (§12.2) — so it errs toward
    treating things as different.
    """

    def test_decoration_is_stripped(self):
        self.assertEqual(_norm_title("Everlong (Remastered 2011)"), "everlong")
        self.assertEqual(_norm_title("Rope - Live"), "rope")
        self.assertEqual(_norm_title("No Son Of Mine"), "no son of mine")

    def test_ampersand_and_case_fold_together(self):
        self.assertEqual(_norm_title("Echoes, Silence, Patience & Grace"),
                         _norm_title("echoes silence patience and grace"))

    def test_different_songs_do_not_collapse(self):
        self.assertNotEqual(_norm_title("The Pretender"), _norm_title("Pretender"))
        self.assertNotEqual(_norm_title("Home"), _norm_title("Homes"))


if __name__ == "__main__":
    unittest.main()
