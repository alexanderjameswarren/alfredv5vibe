"""Resolution rules for diff_dj_setlists — spec §12.7, §12.11, §12.4.

These are the pure functions: no network, no setlist.fm, no ytmusicapi. The
whole point of putting the diff in code rather than in the weekly prompt was
that a model recomputing it drifts in ways no diff shows, because a plausible
answer is indistinguishable from a correct one. That argument only holds if the
code is pinned.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import json
import re
import unittest
import unittest.mock as mock
from pathlib import Path

from workshop.platform import GuardrailError
from workshop.tools import dj_setlists
from workshop.tools.dj_setlists import (
    _FULL_SET_MIN_SONGS,
    _days_apart,
    _iso_to_setlistfm,
    _setlistfm_to_iso,
    _UNCLOSEABLE_CAUSES,
    _norm_title,
    _resolve_one,
    _VARIANT_RE,
)

class _Cfg:
    host_id = "surface"


class _Ctx:
    config = _Cfg()


FF = "Foo Fighters"
# The act as setlist.fm bills it, from the mbid. YouTube Music drops the article.
SP_EXACT = "The Smashing Pumpkins"


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



class SharedVocabularyTests(unittest.TestCase):
    """🛑 THE SAME FIXTURE THE TYPESCRIPT SUITE ASSERTS — shared/dj-title-cases.json.

    This rule lives twice and has to: dj-normalise.ts owns it for match_key,
    frozen at write (spec §4.1.2), and this module needs it at read time in
    another language on the other side of the courier boundary, over setlist.fm
    titles that never reach Alfred. Neither can call the other.

    On 2026-09-02 the two disagreed. This copy recognised "(Remastered 2012)" and
    missed "(2011 Remaster)", so the Smashing Pumpkins diff reported Today, Luna
    and Cherub Rock as MISSING while all three sat in the playlist body — and two
    then resolved to the exact video_id already recorded there.

    ⚠️ NEITHER SIDE IS CHECKED AGAINST THE OTHER'S SOURCE, WHICH DRIFTS. Both are
    checked against these CASES, so a vocabulary entry added on one side and not
    the other fails a test in the runtime nobody edited (spec §11.14).
    """

    @classmethod
    def setUpClass(cls):
        path = (Path(__file__).resolve().parents[2] / "shared" / "dj-title-cases.json")
        cls.cases = json.loads(path.read_text(encoding="utf-8"))

    def test_every_shared_case(self):
        self.assertGreaterEqual(
            len(self.cases["shared"]), 20,
            "fixture shrank; cases come out only with a reason",
        )
        for c in self.cases["shared"]:
            with self.subTest(title=c["input"]):
                self.assertEqual(_norm_title(c["input"]), c["expect"], c["why"])

    def test_variant_cut_vocabulary(self):
        # ⚠️ THE SAME CASES dj-normalise.test.mjs ASSERTS via isVariantCut().
        # This side refuses to resolve a setlist entry to a variant (§12.11 rule
        # 2); that side uses it for §12.10's cram tie-break. One vocabulary, two
        # callers, two runtimes — pinned rather than trusted (§14.6).
        for c in self.cases["variant_cuts"]["cases"]:
            with self.subTest(title=c["input"]):
                self.assertEqual(
                    bool(_VARIANT_RE.search(c["input"])), c["variant"], c["why"],
                )

    def test_the_documented_divergence_is_pinned(self):
        # ⚠️ A DIFFERENCE THAT IS ALLOWED MUST STILL BE ASSERTED, or "deliberate"
        # and "unnoticed" stop being distinguishable the first time either
        # normaliser is edited.
        for d in self.cases["divergences"]:
            with self.subTest(title=d["input"]):
                self.assertEqual(_norm_title(d["input"]), d["python"])


class ArticleFoldTests(unittest.TestCase):
    """§4.1.4's two-vocabularies problem, arriving in the resolver.

    setlist.fm bills the act as "The Smashing Pumpkins" — from the mbid, so it is
    the verified identity. YouTube Music's metadata says "Smashing Pumpkins". An
    exact compare called that a non-match and dropped three songs on 2026-09-02.
    """

    SP = "The Smashing Pumpkins"

    def test_the_live_case_resolves(self):
        # Disarm: genuinely absent from the body, played at 7 of 10 shows, and
        # silently discarded because of one definite article.
        results = [r("Disarm", ["Smashing Pumpkins"], "Siamese Dream (Deluxe Edition)",
                     197, vid="x5GG_fr8WyM")]
        out = _resolve_one(results, "Disarm", self.SP)
        self.assertEqual(out["resolution"], "resolved")
        self.assertEqual(out["video_id"], "x5GG_fr8WyM")

    def test_a_folded_match_SAYS_SO(self):
        # ⚠️ THE FOLD WIDENS THE COLLISION SURFACE §14.4 NAMES, so it may never be
        # silent. A widened rule that announces itself is checkable; the same rule
        # applied quietly is that failure arriving through the front door.
        results = [r("Disarm", ["Smashing Pumpkins"], "Siamese Dream", 197)]
        out = _resolve_one(results, "Disarm", self.SP)
        self.assertEqual(out["artist_match"], "article_insensitive")
        self.assertIn("LEADING ARTICLE", out["why"])

    def test_an_exact_match_is_reported_as_exact_and_carries_no_note(self):
        results = [r("Everlong", [FF], "The Colour And The Shape", 251)]
        out = _resolve_one(results, "Everlong", FF)
        self.assertEqual(out["artist_match"], "exact")
        self.assertNotIn("LEADING ARTICLE", out["why"])

    def test_exact_matches_WIN_over_folded_ones(self):
        # ⚠️ THE FOLD MUST ONLY EVER DECIDE A CASE THAT WOULD OTHERWISE BE NOT
        # FOUND. If it could displace a result the strict rule already accepted,
        # widening the rule would change answers that were previously right.
        results = [r("Song", ["Smashing Pumpkins"], "Wrong", 200, vid="folded"),
                   r("Song", [SP_EXACT], "Right", 260, vid="exact")]
        out = _resolve_one(results, "Song", SP_EXACT)
        self.assertEqual(out["video_id"], "exact")
        self.assertEqual(out["artist_match"], "exact")

    def test_a_different_band_is_still_not_found(self):
        # NEGATIVE CONTROL. Dropping an article must not reach past the article.
        results = [r("One Headlight", ["The Wallflowers"], "Bringing Down the Horse", 313)]
        self.assertEqual(_resolve_one(results, "One Headlight", FF)["resolution"], "not_found")


class MedleyCoverTests(unittest.TestCase):
    """A right answer reached wrongly is the one that breaks when the case changes.

    setlist.fm records ONE cover marker for a whole ' / '-joined medley row.
    Copying it onto every part invents an attribution; copying its absence
    asserts "not a cover" just as wrongly. On 2026-09-02 that made the resolver
    explain One Headlight — a Wallflowers song — as though Foo Fighters simply
    had no version of their own.
    """

    def test_a_medley_part_does_not_claim_a_cover_ruling(self):
        results = [r("One Headlight", ["The Wallflowers"], "Bringing Down the Horse", 313)]
        out = _resolve_one(results, "One Headlight", FF, cover_of_known=False)
        self.assertEqual(out["resolution"], "not_found", "the VERDICT is unchanged")
        self.assertIn("MEDLEY", out["why"])
        self.assertIn("NOT IN THE SOURCE", out["why"])
        self.assertNotIn("spec 12.4", out["why"],
                         "a medley part must not be justified by a cover rule")

    def test_a_standalone_song_still_gets_the_cover_ruling(self):
        # NEGATIVE CONTROL for the above: the §12.4 wording must survive where it
        # is actually true, or the fix has simply deleted a correct explanation.
        results = [r("London Calling", ["The Clash"], "London Calling", 201)]
        out = _resolve_one(results, "London Calling", FF, cover_of_known=True)
        self.assertEqual(out["resolution"], "not_found")
        self.assertIn("spec 12.4", out["why"])
        self.assertNotIn("MEDLEY", out["why"])


class NotFoundCauseTests(unittest.TestCase):
    """ADDED 2026-09-02: WHY a song was not found, as a field rather than prose.

    🛑 THE FIRST WEEKLY RUN CLASSIFIED THESE BY READING `why` STRINGS, AND GOT IT
    WRONG ON THE FIRST ATTEMPT. It reported five Foo Fighters medley parts where
    there were six — "Happy Birthday to You" appeared at a single show and was
    missed by eye — and that number went into a coverage figure. Prose parsing
    does not fail loudly; it fails by one.

    The four causes are not the same kind of answer. Three are structural and no
    decision can close them. The fourth is a question.
    """

    def test_nothing_titled_that_is_no_such_title(self):
        results = [r("Everlong", [FF], "The Colour and the Shape", 250)]
        out = _resolve_one(results, "Manimal", FF)
        self.assertEqual(out["resolution"], "not_found")
        self.assertEqual(out["not_found_cause"], "no_such_title")

    def test_right_title_wrong_artist_is_other_artists_only(self):
        results = [r("London Calling", ["The Clash"], "London Calling", 201)]
        out = _resolve_one(results, "London Calling", FF)
        self.assertEqual(out["not_found_cause"], "other_artists_only")

    def test_a_medley_part_is_classified_by_WHAT_IT_IS_not_by_its_branch(self):
        # 🛑 THE PRECEDENCE RULE, AND IT IS THE ONE THAT MATTERS.
        #
        # A medley part can fall out of EITHER not-found branch: "One Headlight"
        # finds The Wallflowers (the wrong-artist branch), "Seven" finds nothing
        # at all (the no-title branch). Both are structurally unavailable for the
        # SAME reason — a medley part rarely has a studio recording — and
        # classifying them by which branch they hit would split one cause across
        # two buckets and quietly shrink the uncloseable count.
        wrong_artist = [r("One Headlight", ["The Wallflowers"], "Bringing Down the Horse", 313)]
        out = _resolve_one(wrong_artist, "One Headlight", FF, cover_of_known=False)
        self.assertEqual(out["not_found_cause"], "medley_part")

        no_title = [r("Everlong", [FF], "The Colour and the Shape", 250)]
        out = _resolve_one(no_title, "Seven", FF, cover_of_known=False)
        self.assertEqual(out["not_found_cause"], "medley_part")

    def test_every_cause_is_either_uncloseable_or_variant_only(self):
        # A cause that is neither would be silently dropped from BOTH the
        # coverage subtraction and the escalation path — present in the payload
        # and counted by nothing.
        known = set(_UNCLOSEABLE_CAUSES) | {"variant_only"}
        self.assertEqual(
            known,
            {"medley_part", "other_artists_only", "no_such_title", "variant_only"},
        )

    def test_variant_only_is_NOT_subtracted_from_gettable(self):
        # 🛑 THE NEGATIVE CONTROL FOR THE COVERAGE DENOMINATOR.
        #
        # Mayonaise is a Smashing Pumpkins song played at 5 of the 10 shows read
        # on 2026-09-02, and it resolves to nothing only because every cut is
        # live. Folding it into "uncloseable" would improve the coverage number
        # by hiding the one gap he can actually do something about.
        self.assertNotIn("variant_only", _UNCLOSEABLE_CAUSES)


class VariantOnlyEscalationTests(unittest.TestCase):
    """🛑 A MAJOR SONG RETURNING NOT_FOUND MUST NOT LOOK LIKE A DEAD END.

    On 2026-09-02 Mayonaise (5 of 10 shows) and Muzzle both came back as
    not_found with `other_artists_found: []` and a sentence of prose — byte
    identical in SHAPE to A320, where piano covers genuinely are all that exists.
    One is a ten-second decision; the other is nothing. They printed the same.

    §12.11: never escalate an ambiguity without a recommendation and a way to
    resolve it. `duplicate_titles_in_cram` got that treatment. This did not.
    """

    MAYO = [
        r("Mayonaise (Live at the Riviera)", [SP_EXACT], None, 320, vid="live_loose"),
        r("Mayonaise - Live", [SP_EXACT], "Rotten Apples: Live", 300, vid="live_album_short"),
        r("Mayonaise (Live)", [SP_EXACT], "Earphoria", 355, vid="live_album_long"),
    ]

    def test_the_verdict_is_unchanged(self):
        # ⚠️ THE FIX IS THE PAYLOAD, NOT THE RULING. §12.11 rule 2 still drops
        # variant cuts and §12.7 is still exact-match-or-not-found. Promoting
        # this to `resolved` would put a live recording into a playlist by
        # machine, which is precisely what rule 2 exists to prevent.
        out = _resolve_one(self.MAYO, "Mayonaise", SP_EXACT)
        self.assertEqual(out["resolution"], "not_found")
        self.assertEqual(out["not_found_cause"], "variant_only")

    def test_it_carries_candidates_and_a_named_recommendation(self):
        out = _resolve_one(self.MAYO, "Mayonaise", SP_EXACT)
        self.assertEqual(len(out["variant_candidates"]), 3)
        self.assertTrue(out["recommended_video_id"])
        for c in out["variant_candidates"]:
            # Album and duration are what distinguish a released live album from
            # a loose upload, so they travel with the question (§12.11).
            self.assertIn("album", c)
            self.assertIn("duration_seconds", c)

    def test_the_pick_prefers_a_released_album_then_the_longest_cut(self):
        # The rule is stated in the `why`, so it must be the rule applied.
        # Earphoria (355s, on an album) beats the loose 320s upload and the
        # shorter album cut.
        out = _resolve_one(self.MAYO, "Mayonaise", SP_EXACT)
        self.assertEqual(out["recommended_video_id"], "live_album_long")

    def test_it_says_the_song_EXISTS_rather_than_reading_as_absent(self):
        out = _resolve_one(self.MAYO, "Mayonaise", SP_EXACT)
        self.assertIn("DECISION, NOT A DEAD END", out["why"])
        self.assertIn("live recording", out["why"])

    def test_a_playlist_holding_only_a_live_cut_is_a_DIFFERENT_shape_from_A320(self):
        # NEGATIVE CONTROL. The genuinely hopeless case must NOT acquire a
        # recommendation, or the distinction this class exists to draw is gone.
        a320 = [r("A320", ["Piano Project"], "Piano Renditions of Foo Fighters", 320)]
        out = _resolve_one(a320, "A320", FF)
        self.assertEqual(out["not_found_cause"], "other_artists_only")
        self.assertNotIn("variant_candidates", out)
        self.assertIsNone(out.get("recommended_video_id"))


class FullSetThresholdTests(unittest.TestCase):
    """§12.3 DECIDED PROMOS COUNT. This labels them; it excludes nothing.

    Six of ten Weezer shows in the 2026-09-02 window were 1-6 song television and
    radio spots, so "We Might as Well Be Strangers, 4 shows" was three TV
    appearances and one concert — a true number reading as four times the
    evidence it is.
    """

    # The real window, 2026-09-02.
    WEEZER = [5, 5, 2, 1, 24, 5, 12, 13, 6, 24]
    FOO = [15, 25, 26, 25, 26, 27, 27, 26, 24, 25]
    PUMPKINS = [17, 24, 7, 15, 13, 14, 21, 21, 13, 22]

    def full(self, counts):
        return sum(1 for c in counts if c >= _FULL_SET_MIN_SONGS)

    def test_it_separates_weezers_promos_from_its_concerts(self):
        # Halifax 24, Yellowstone 24, Allegiant 13, Amazon MGM 12. The other six
        # are Fallon, Today Show, SiriusXM, Apple Music, Snap and Hinano Cafe.
        self.assertEqual(self.full(self.WEEZER), 4)

    def test_it_does_not_misfire_on_an_act_that_only_plays_full_sets(self):
        # ⚠️ THE CONTROL FOR THE THRESHOLD ITSELF. A rule tuned on Weezer that
        # started discarding Foo Fighters shows would be worse than no rule —
        # the Hollywood Bowl show is 15 songs and is a real concert.
        self.assertEqual(self.full(self.FOO), 10)

    def test_the_boundary_case_is_the_one_that_moves(self):
        # Smashing Pumpkins played SEVEN songs at the LA Memorial Coliseum,
        # one under the line, and is classed a short set. That is intended — a
        # festival slot is weaker evidence than a 24-song headline show — but it
        # is the row that flips if anyone retunes this, so it is pinned.
        self.assertEqual(self.full(self.PUMPKINS), 9)
        self.assertEqual(min(self.PUMPKINS), _FULL_SET_MIN_SONGS - 1)

    def test_a_median_based_rule_would_have_certified_a_radio_session(self):
        # 🛑 WHY THE CONSTANT IS ABSOLUTE AND NOT A FRACTION OF THE WINDOW.
        # Weezer's median is 5.5 because the promos themselves drag it down, so
        # "half the median" is 2.75 and the five-song SiriusXM session passes.
        # A self-scaling threshold is the obvious idea and it is wrong here.
        ordered = sorted(self.WEEZER)
        median = (ordered[4] + ordered[5]) / 2
        self.assertLess(median / 2, 5, "the trap this constant avoids")


class TargetedLookupTests(unittest.TestCase):
    """🛑 THE ACCEPTANCE TEST'S SHARP EDGE (spec §13.2, corrected 2026-09-02).

    Adele 2023-10-13 and Katy Perry 2023-10-14 are ONE DAY APART. A lookup that
    matched on artist and year and then took the first result would return a
    perfectly plausible Adele setlist from a different night of the same
    residency — every song would resolve cleanly, and nothing downstream could
    tell. `date_match` is the assertion that makes a near miss visible.
    """

    def test_iso_to_setlistfm_is_written_out_not_formatted(self):
        # ⚠️ A d/m vs m/d SWAP IS THE FAILURE THIS PROJECT ALREADY SPENT A DAY ON
        # in the Takeout timezone work. Both acceptance dates are in October, so
        # a swap would produce "10-13-2023" — a 13th month, which setlist.fm
        # would simply never match, turning a wrong conversion into "not found".
        self.assertEqual(_iso_to_setlistfm("2023-10-13"), "13-10-2023")
        self.assertEqual(_iso_to_setlistfm("2024-06-25"), "25-06-2024")

    def test_the_round_trip_is_lossless(self):
        for iso in ("2023-10-13", "2023-10-14", "2024-06-25", "2026-01-01"):
            self.assertEqual(_setlistfm_to_iso(_iso_to_setlistfm(iso)), iso)

    def test_a_malformed_event_date_is_None_rather_than_a_guess(self):
        # setlist.fm has served odd values. None is an answer; a guessed date is
        # indistinguishable from a checked one once written.
        self.assertIsNone(_setlistfm_to_iso(""))
        self.assertIsNone(_setlistfm_to_iso("2023-10-13"))   # already ISO, wrong shape here
        self.assertIsNone(_setlistfm_to_iso("13-10-23"))

    def test_days_apart_measures_the_near_miss(self):
        # The Adele/Katy Perry gap, and the number that tells a human whether a
        # lookup missed by a night or by a year.
        self.assertEqual(_days_apart("2023-10-13", "2023-10-14"), 1)
        self.assertEqual(_days_apart("2023-10-13", "2023-10-13"), 0)
        self.assertEqual(_days_apart("2023-10-13", "2022-10-13"), 365)


class ResponseContractTests(unittest.TestCase):
    """🛑 BOTH PATHS MUST CARRY WHAT diff_dj_setlists READS.

    get_dj_setlists builds its response two ways — the newest-first artist feed,
    and _targeted_lookup for one specific show. diff_dj_setlists consumes
    whichever it is handed, so a key present on one and absent on the other is a
    crash waiting for the first caller who takes the other branch.

    That is exactly what happened: `empty_entries_skipped` existed only on the
    untargeted side, and a targeted diff died with
    `Internal error: 'empty_entries_skipped'`.

    ⚠️ NOTHING CAUGHT IT BECAUSE COVERAGE WAS PER-TOOL, NOT PER-PATH. The
    envelope suite drives every registered tool once, with one fixture each, and
    that fixture went down the untargeted branch. `on_date` appeared in NO test
    at all — the targeted tests covered only the pure date helpers, never the
    lookup or the assembly around it.
    """

    UNTARGETED = {
        "mbid": "x", "setlists": [], "returned": 0, "empty_entries_skipped": 3,
        "pages_read": 1, "total_upstream": 10, "limit_applied": 10,
        "date_format": "...", "reading": "...",
    }

    def _targeted(self, **over):
        """The targeted payload, built by the real code against fakes."""
        page = {"setlist": [{
            "id": "sl1", "eventDate": "08-12-2024",
            "artist": {"name": "Someone"},
            "venue": {"name": "A Hall", "city": {"name": "C", "country": {"code": "GB"}}},
            "sets": {"set": [{"song": [{"name": "A Song"}]}]},
        }], "total": 1}
        page.update(over.pop("page", {}))

        def fake_search(mbid, year, venue, p, key):
            return page if p == 1 else {"setlist": [], "total": 1}

        with mock.patch.object(dj_setlists, "_search_page", fake_search):
            out = asyncio.run(dj_setlists._targeted_lookup(
                "20244d07-534f-4eff-b4d4-930878889970", 2024, None,
                "2024-12-08", 10, "key"))
        return out["data"]

    def test_the_targeted_path_carries_every_key_the_diff_READS(self):
        data = self._targeted()
        missing = dj_setlists.DIFF_REQUIRED_KEYS - set(data)
        self.assertEqual(missing, set(),
                         f"targeted payload is missing {sorted(missing)} - a "
                         f"targeted diff will crash on the first caller")

    def test_the_untargeted_path_carries_them_too(self):
        missing = dj_setlists.DIFF_REQUIRED_KEYS - set(self.UNTARGETED)
        self.assertEqual(missing, set())

    def test_empty_entries_skipped_is_the_HONEST_ANALOGUE_not_a_zero(self):
        # ⚠️ A hardcoded 0 would satisfy the key and lie about the data. In a
        # targeted lookup the same fact exists: candidates in scope that have no
        # songs and therefore cannot be diffed.
        page = {"setlist": [
            {"id": "a", "eventDate": "08-12-2024", "artist": {"name": "S"},
             "venue": {"name": "H", "city": {"name": "C", "country": {"code": "GB"}}},
             "sets": {"set": [{"song": [{"name": "One"}]}]}},
            {"id": "b", "eventDate": "09-12-2024", "artist": {"name": "S"},
             "venue": {"name": "H", "city": {"name": "C", "country": {"code": "GB"}}},
             "sets": {"set": []}},
            {"id": "c", "eventDate": "10-12-2024", "artist": {"name": "S"},
             "venue": {"name": "H", "city": {"name": "C", "country": {"code": "GB"}}},
             "sets": {"set": []}},
        ], "total": 3}
        data = self._targeted(page=page)
        self.assertEqual(data["candidates_in_scope"], 3)
        self.assertEqual(data["candidates_with_songs"], 1)
        self.assertEqual(data["empty_entries_skipped"], 2,
                         "two candidates had no songs; that is the same fact "
                         "the untargeted count reports, reached another way")

    def test_the_exact_date_still_matches_after_the_fix(self):
        # The bug was in assembly, not in the lookup - so the thing the lookup
        # exists for must still hold.
        data = self._targeted()
        self.assertEqual(data["lookup"]["date_match"], "exact")
        self.assertEqual(data["lookup"]["matched_date"], "2024-12-08")


class TargetedDiffEndToEndTests(unittest.TestCase):
    """🛑 THE TEST THAT WOULD HAVE CAUGHT IT — the whole call, not the pieces.

    The unit tests above pin `_targeted_lookup`'s payload against a frozen key
    set, which is the cheap guard. This one is the expensive one: it drives
    `diff_dj_setlists` with `on_date` all the way through the real
    `get_dj_setlists` and the real assembly, stubbing only the network.

    ⚠️ THIS IS THE SHAPE THAT WAS MISSING. `on_date` shipped with tests, but they
    covered the pure date helpers only. Nothing ever ran the targeted branch INTO
    the response assembly, so the two halves were each correct and the join was
    never executed.

    ⚠️ THE ACCEPTANCE TEST DID NOT REACH IT EITHER, and that is not luck: a
    non-exact date match raises GuardrailError before assembly. Only an EXACT
    match gets far enough to crash, so the failure needed a real matching show.
    """

    MBID = "20244d07-534f-4eff-b4d4-930878889970"

    def _page(self, songs=("One", "Two", "Three")):
        return {"setlist": [{
            "id": "sl1", "eventDate": "08-12-2024",
            "artist": {"name": "Someone"},
            "venue": {"name": "A Hall",
                      "city": {"name": "London", "country": {"code": "GB"}}},
            "sets": {"set": [{"song": [{"name": n} for n in songs]}]},
        }], "total": 1}

    def _diff(self, args, page=None):
        page = page or self._page()

        def fake_search(mbid, year, venue, p, key):
            return page if p == 1 else {"setlist": [], "total": 1}

        with mock.patch.object(dj_setlists, "_search_page", fake_search),              mock.patch.object(dj_setlists, "_read_api_key", lambda: "k"):
            return asyncio.run(dj_setlists.diff_dj_setlists(args, _Ctx()))

    def test_a_targeted_diff_COMPLETES(self):
        # Reproduces the reported crash: Internal error: 'empty_entries_skipped'.
        out = self._diff({"mbid": self.MBID, "body": [], "on_date": "2024-12-08",
                          "resolve": False})
        data = out["data"]
        self.assertEqual(data["shows_read"], 1)
        self.assertEqual(data["empty_entries_skipped"], 0)
        self.assertEqual(data["distinct_setlist_songs"], 3)

    def test_an_EMPTY_BODY_is_supported_not_refused(self):
        # ⚠️ Alex diffed against nothing deliberately - "what does a date return".
        # `body: []` is a SUPPORTED case (the concert skill passes it for a new
        # playlist); only an OMITTED body is refused. The crash was unrelated.
        out = self._diff({"mbid": self.MBID, "body": [], "on_date": "2024-12-08",
                          "resolve": False})
        data = out["data"]
        self.assertEqual(data["body_size"], 0)
        self.assertEqual(data["coverage"]["in_body"], 0)
        self.assertEqual(data["coverage"]["total"], 3,
                         "an empty body means every setlist song is missing - "
                         "that is the answer, not an error")

    def test_an_OMITTED_body_is_still_refused(self):
        # The negative control for the case above: the guard must still fire on
        # the thing it was written for.
        with self.assertRaises(GuardrailError) as cm:
            self._diff({"mbid": self.MBID, "on_date": "2024-12-08"})
        self.assertIn("must be an array", str(cm.exception))

    def test_a_NON_EXACT_date_is_refused_cleanly_and_never_reaches_assembly(self):
        # ⚠️ WHY THE ACCEPTANCE TEST PASSED. This path raises before the response
        # is built, so it could not have hit the missing key however often it ran.
        page = self._page()
        page["setlist"][0]["eventDate"] = "10-12-2024"
        with self.assertRaises(GuardrailError) as cm:
            self._diff({"mbid": self.MBID, "body": [], "on_date": "2024-12-08",
                        "resolve": False}, page=page)
        self.assertIn("2024-12-08", str(cm.exception))


class TapeEntryTests(unittest.TestCase):
    """🛑 A STAGE SECTION IS NOT A SONG, AND THE SOURCE ALREADY SAYS SO.

    setlist.fm records act intros, video interludes and PA outros as rows in the
    set, because the set is what the audience experienced. The Taylor Swift show
    of 2024-12-08 carried three named ones. All three searched YouTube, found
    nothing, and were reported `no_such_title` — a cause meaning "the recording
    is missing" when NOTHING WAS MISSING. They inflated the song count 45 -> 48,
    so the playlist could never reach its own denominator.

    ⚠️ EVERY ROW BELOW IS REAL, taken from setlist.fm id 3baa40bc on 2026-09-09.
    `tape` was true for exactly four of the 49 rows: one unnamed and these three.
    ZERO false positives — which is why this is the medley case (a structural
    fact the source states) and not the §14.7 case (a pattern over titles).
    """

    # Verbatim from the API. Trimmed to the fields the parser reads.
    REAL_SET = {"sets": {"set": [{"song": [
        {"name": "", "tape": True,
         "info": "w/ elements of MA&tHP, The Alchemy, Fearless, EG, SN, gr, ..."},
        {"name": "Cruel Summer", "info": "extended outro"},
        {"name": "Fearless", "info": "shortened"},
        {"name": "Red - Intro", "tape": True,
         "info": 'contains elements of "State of Grace", "Holy Ground" and "Red"'},
        {"name": "I Knew You Were Trouble", "info": "shortened"},
        {"name": "Speak Now - Intro", "tape": True,
         "info": 'contains elements of "Castles Crumbling"'},
        {"name": "Female Rage: The Musical", "tape": True,
         "info": 'contains elements of "MBOBHFT", "WAOLOM?", "loml", ...'},
        {"name": "All Too Well", "info": "10 Minute Version; spoken intro"},
    ]}]}}

    def test_the_three_stage_sections_are_NOT_SONGS(self):
        names = [s["name"] for s in dj_setlists._songs_of(self.REAL_SET)]
        for section in ("Red - Intro", "Speak Now - Intro",
                        "Female Rage: The Musical"):
            self.assertNotIn(section, names)
        self.assertEqual(len(names), 4)

    def test_the_REAL_SONGS_SURVIVE(self):
        # ⚠️ THE NEGATIVE CONTROL. A filter that dropped everything would pass
        # the test above and destroy the tool.
        names = [s["name"] for s in dj_setlists._songs_of(self.REAL_SET)]
        self.assertEqual(names, ["Cruel Summer", "Fearless",
                                 "I Knew You Were Trouble", "All Too Well"])

    def test_a_song_TITLED_like_a_stage_section_is_kept_when_not_taped(self):
        """🛑 THE §14.7 GUARD, AND THE REASON NO TITLE PATTERN WAS ADDED.

        "Prefer the longer form" fixed Eddie Higgins and broke Red Garland. A
        `- Intro` pattern here would do the same thing: a song genuinely called
        "Intro" exists somewhere, and the pattern cannot tell it from an act
        break. `tape` can, because the source asserts it per row.
        """
        st = {"sets": {"set": [{"song": [
            {"name": "Intro"},                       # a real track so titled
            {"name": "Red - Intro", "tape": True},   # an act break
        ]}]}}
        self.assertEqual([s["name"] for s in dj_setlists._songs_of(st)], ["Intro"])

    def test_a_TAPED_REAL_TRACK_is_still_reported_not_erased(self):
        # ⚠️ An artist can play a recording of a real song over the PA, and that
        # row is marked tape too. Demoted, never discarded - a skip nobody can
        # inspect is a skip nobody can dispute.
        st = {"sets": {"set": [{"song": [
            {"name": "Fortnight", "tape": True, "info": "outro"},
        ]}]}}
        self.assertEqual(dj_setlists._songs_of(st), [])
        self.assertEqual(dj_setlists._tape_of(st),
                         [{"name": "Fortnight", "info": "outro"}])

    def test_tape_entries_ship_with_their_names(self):
        tape = dj_setlists._tape_of(self.REAL_SET)
        self.assertEqual([t["name"] for t in tape],
                         ["Red - Intro", "Speak Now - Intro",
                          "Female Rage: The Musical"])

    def test_an_UNNAMED_tape_row_appears_in_NEITHER(self):
        # There is nothing to show and nothing anyone could act on.
        self.assertEqual(len(dj_setlists._songs_of(self.REAL_SET)), 4)
        self.assertEqual(len(dj_setlists._tape_of(self.REAL_SET)), 3)

    def test_the_performance_note_is_carried_but_UNUSED(self):
        # ⚠️ A RECORDED GAP. "All Too Well - 10 Minute Version" names a DIFFERENT
        # RECORDING from the one the resolver will pick. Carried as data; acting
        # on it is a resolution rule and _songs_of is a parser.
        songs = {s["name"]: s for s in dj_setlists._songs_of(self.REAL_SET)}
        self.assertEqual(songs["All Too Well"]["info"],
                         "10 Minute Version; spoken intro")
        self.assertEqual(songs["Cruel Summer"]["info"], "extended outro")
        # A song with no note carries None rather than an empty string, so
        # "absent" and "recorded as blank" stay distinguishable.
        self.assertIsNone(dj_setlists._songs_of(
            {"sets": {"set": [{"song": [{"name": "X"}]}]}})[0]["info"])


class ShowKeyContractTests(unittest.TestCase):
    """§14.44 one level down: a show key added to one path and not the other.

    `tape_entries` is read off every show by the diff. It went into the
    untargeted assembly and the targeted one in the same change BECAUSE the
    2026-09-08 crash was exactly this, one level up.
    """

    def test_the_targeted_path_builds_shows_with_every_key_the_diff_reads(self):
        page = {"setlist": [{
            "id": "sl1", "eventDate": "08-12-2024",
            "artist": {"name": "Someone"},
            "venue": {"name": "H", "city": {"name": "C", "country": {"code": "GB"}}},
            "sets": {"set": [{"song": [{"name": "A"}, {"name": "B - Intro", "tape": True}]}]},
        }], "total": 1}

        def fake_search(mbid, year, venue, p, key):
            return page if p == 1 else {"setlist": [], "total": 1}

        with mock.patch.object(dj_setlists, "_search_page", fake_search):
            out = asyncio.run(dj_setlists._targeted_lookup(
                "20244d07-534f-4eff-b4d4-930878889970", 2024, None,
                "2024-12-08", 10, "key"))
        show = out["data"]["setlists"][0]
        missing = dj_setlists.DIFF_REQUIRED_SHOW_KEYS - set(show)
        self.assertEqual(missing, set(),
                         f"targeted shows are missing {sorted(missing)}")
        self.assertEqual(show["song_count"], 1, "the tape row is not a song")
        self.assertEqual([t["name"] for t in show["tape_entries"]], ["B - Intro"])


class BodySideOfTheDiffTests(unittest.TestCase):
    """🛑 35 ROWS IN, 32 OUT, AND NOTHING SAID WHERE THE OTHER THREE WENT.

    The setlist side was fully accounted for - every song was in_body or missing,
    with a cause. The body side had no accounting at all, so the gap was found by
    SUBTRACTING. For a tool whose job is diffing, one direction is half a diff.

    The three were real: Enough Space and Shame Shame matched no setlist song in
    the window, and a second Marigold row (the 2006 Pantages live cut) joined the
    same title as the studio one and vanished.
    """

    MBID = "20244d07-534f-4eff-b4d4-930878889970"

    def _run(self, body, setlist_songs=("Marigold", "Everlong")):
        page = {"setlist": [{
            "id": "sl1", "eventDate": "08-12-2024",
            "artist": {"name": FF},
            "venue": {"name": "H", "city": {"name": "C", "country": {"code": "GB"}}},
            "sets": {"set": [{"song": [{"name": n} for n in setlist_songs]}]},
        }], "total": 1}

        def fake_search(mbid, year, venue, p, key):
            return page if p == 1 else {"setlist": [], "total": 1}

        with mock.patch.object(dj_setlists, "_search_page", fake_search), \
             mock.patch.object(dj_setlists, "_read_api_key", lambda: "k"):
            out = asyncio.run(dj_setlists.diff_dj_setlists(
                {"mbid": self.MBID, "body": body, "on_date": "2024-12-08",
                 "resolve": False}, _Ctx()))
        return out["data"]

    # The live rows, with the two Marigolds and the two orphans.
    BODY = [
        {"title": "Marigold", "artist": FF, "video_id": "studio"},
        {"title": "Marigold", "artist": "Nirvana", "video_id": "live2006"},
        {"title": "Everlong", "artist": FF, "video_id": "ev"},
        {"title": "Enough Space", "artist": FF, "video_id": "es"},
        {"title": "Shame Shame", "artist": FF, "video_id": "ss"},
    ]

    def test_ORPHANS_ARE_NAMED_not_left_to_subtraction(self):
        data = self._run(self.BODY)
        self.assertEqual([o["title"] for o in data["orphans"]],
                         ["Enough Space", "Shame Shame"])

    def test_the_DUPLICATE_MARIGOLD_is_reported_instead_of_vanishing(self):
        data = self._run(self.BODY)
        self.assertEqual(len(data["body_duplicates"]), 1)
        dup = data["body_duplicates"][0]
        self.assertEqual(dup["title"], "Marigold")
        self.assertEqual([r["video_id"] for r in dup["body_rows"]],
                         ["studio", "live2006"])

    def test_THE_ARITHMETIC_CLOSES(self):
        """🛑 THE LOAD-BEARING ASSERTION. If these four ever fail to sum,
        a row has gone missing again and this is the test that says so."""
        for body in (self.BODY, [], self.BODY + [{"title": "", "artist": FF}]):
            data = self._run(body)
            r = data["body_reconciliation"]
            self.assertEqual(
                r["matched_titles"] + r["duplicate_rows"] + r["orphan_rows"]
                + r["untitled_rows"],
                r["body_size"],
                f"body_reconciliation does not sum: {r}")

    def test_a_row_with_no_title_is_counted_rather_than_dropped(self):
        data = self._run(self.BODY + [{"title": "", "artist": FF}])
        self.assertEqual(data["body_reconciliation"]["untitled_rows"], 1)

    def test_an_orphaned_title_held_twice_counts_BOTH_rows(self):
        # The bucket boundary. Duplicates are counted only on MATCHED titles; two
        # rows of an unmatched song are two orphans, not one plus a duplicate.
        data = self._run([{"title": "Shame Shame", "video_id": "a"},
                          {"title": "Shame Shame", "video_id": "b"}])
        self.assertEqual(data["body_reconciliation"]["orphan_rows"], 2)
        self.assertEqual(data["body_reconciliation"]["duplicate_rows"], 0)
        self.assertEqual(data["body_duplicates"], [])


class JoinRuleTests(unittest.TestCase):
    """🛑 TITLE JOINS. ARTIST ANNOTATES. ARTIST NEVER REJECTS.

    Emergent until 2026-09-09: a body row bylined "Nirvana" joined a Foo Fighters
    setlist entry for Marigold and nothing said so. The outcome was right - Grohl
    wrote it, the row is deliberate - but a rule that happens to be right is not
    a rule.

    12.2 says a false ACCEPT is the worse error, which argues for rejecting. It
    does not win here because dj_tracks.artist is a SCRAPED BYLINE (14.9), and
    because rejecting would put a deliberately-placed track into `missing` with
    no visible cause. THE DEFECT WAS THE SILENCE, NOT THE JOIN.
    """

    MBID = "20244d07-534f-4eff-b4d4-930878889970"

    def _run(self, body):
        return BodySideOfTheDiffTests._run(self, body, setlist_songs=("Marigold",))

    def test_a_DIFFERENT_ARTIST_still_joins(self):
        data = self._run([{"title": "Marigold", "artist": "Nirvana", "video_id": "x"}])
        self.assertEqual(data["coverage"]["in_body"], 1,
                         "rejecting would drop a deliberately-placed track into "
                         "`missing` with no visible cause")

    def test_but_it_is_REPORTED(self):
        # THE POINT OF THE WHOLE CHANGE. Without this the 12.2 false-accept risk
        # is invisible, which is what made it dangerous.
        data = self._run([{"title": "Marigold", "artist": "Nirvana", "video_id": "x"}])
        self.assertEqual(len(data["artist_disagreements"]), 1)
        d = data["artist_disagreements"][0]
        self.assertEqual(d["body_artist"], "Nirvana")
        self.assertEqual(d["performing"], FF)
        self.assertEqual(d["video_id"], "x")


    def test_AN_AGREEING_SIBLING_ROW_DOES_NOT_SILENCE_A_DISAGREEING_ONE(self):
        """🛑 THE REAL MARIGOLD SHAPE, and the quantifier bug it caught.

        The body holds TWO Marigolds: the studio cut, which is a Nirvana B-side
        (Grohl wrote and sang it) and is bylined "Nirvana", and the 2006 Pantages
        live cut, which is a Foo Fighters release.

        The first implementation asked `any(row agrees)`. The Foo Fighters row
        made that true, so the Nirvana row was SILENTLY SUPPRESSED - the flag
        went quiet on the one case it was built for. A title agrees only when
        EVERY named row agrees.
        """
        # ORDER MATTERS IN THIS FIXTURE: the AGREEING row comes first, so the
        # title's joined video_id is "live2006". If the disagreement reported the
        # title's id instead of the row's, the two would be indistinguishable -
        # which is exactly how the first version of this test passed against a
        # broken implementation.
        data = self._run([
            {"title": "Marigold", "artist": FF, "video_id": "live2006"},
            {"title": "Marigold", "artist": "Nirvana", "video_id": "studio"},
        ])
        self.assertEqual(data["in_body"][0]["video_id"], "live2006")
        self.assertEqual(len(data["artist_disagreements"]), 1)
        d = data["artist_disagreements"][0]
        self.assertEqual(d["body_artist"], "Nirvana")
        # The DISAGREEING row's own id - a caller told "Marigold disagrees" and
        # handed the other row's id cannot find what is being talked about.
        self.assertEqual(d["video_id"], "studio")
        self.assertFalse(data["in_body"][0]["body_artist_agrees"])
        # And it still JOINS - the rule is annotate, never reject.
        self.assertEqual(data["coverage"]["in_body"], 1)

    def test_every_disagreeing_row_is_listed_not_just_the_first(self):
        data = self._run([
            {"title": "Marigold", "artist": "Nirvana", "video_id": "a"},
            {"title": "Marigold", "artist": "Scream", "video_id": "b"},
        ])
        self.assertEqual([d["body_artist"] for d in data["artist_disagreements"]],
                         ["Nirvana", "Scream"])

    def test_the_MATCHING_artist_raises_NO_flag(self):
        # 11.7 - a flag that fires on the normal case gets ignored. One row in 32
        # fired on the live run; every other row must stay quiet.
        data = self._run([{"title": "Marigold", "artist": FF, "video_id": "x"}])
        self.assertEqual(data["artist_disagreements"], [])
        self.assertTrue(data["in_body"][0]["body_artist_agrees"])

    def test_NO_BYLINE_is_UNKNOWN_and_not_disagreement(self):
        # Saying "artist differs" about an absent field invents a conflict.
        data = self._run([{"title": "Marigold", "video_id": "x"}])
        self.assertIsNone(data["in_body"][0]["body_artist_agrees"])
        self.assertEqual(data["artist_disagreements"], [])

    def test_the_article_insensitive_case_is_not_a_disagreement(self):
        # "The Smashing Pumpkins" on setlist.fm, "Smashing Pumpkins" on YouTube.
        # Reusing _artist_matches means this join inherits that rule for free
        # rather than growing a second, subtly different one (14.6).
        page = {"setlist": [{"id": "s", "eventDate": "08-12-2024",
                             "artist": {"name": SP_EXACT},
                             "venue": {"name": "H", "city": {"name": "C",
                                       "country": {"code": "GB"}}},
                             "sets": {"set": [{"song": [{"name": "Today"}]}]}}],
                "total": 1}
        with mock.patch.object(dj_setlists, "_search_page", lambda *a, **k: page), \
             mock.patch.object(dj_setlists, "_read_api_key", lambda: "k"):
            out = asyncio.run(dj_setlists.diff_dj_setlists(
                {"mbid": self.MBID,
                 "body": [{"title": "Today", "artist": "Smashing Pumpkins",
                           "video_id": "t"}],
                 "on_date": "2024-12-08", "resolve": False}, _Ctx()))
        self.assertEqual(out["data"]["artist_disagreements"], [])
        self.assertTrue(out["data"]["in_body"][0]["body_artist_agrees"])


class ReadingBlobTests(unittest.TestCase):
    """A CONSTANT THAT DESCRIBES CHANGING DATA IS A STALE FACT WITH REACH.

    `reading` ships inside EVERY response. It carried "Foo Fighters read 27/40
    total and 27/32 gettable on 2026-09-02"; by 2026-09-09 the same playlist read
    32/40 and 32/32, because five tracks had been added. The wrong pair went out
    with every call.

    Same trap as the weekly prompt's Appendix A, fixed the same way: the
    operational half must be SELF-CHECKING rather than asserted.
    """

    def _reading(self):
        page = {"setlist": [{
            "id": "s", "eventDate": "08-12-2024", "artist": {"name": FF},
            "venue": {"name": "H", "city": {"name": "C", "country": {"code": "GB"}}},
            "sets": {"set": [{"song": [{"name": "Everlong"}]}]}}], "total": 1}
        with mock.patch.object(dj_setlists, "_search_page", lambda *a, **k: page), \
             mock.patch.object(dj_setlists, "_read_api_key", lambda: "k"):
            out = asyncio.run(dj_setlists.diff_dj_setlists(
                {"mbid": "20244d07-534f-4eff-b4d4-930878889970",
                 "body": [], "on_date": "2024-12-08", "resolve": False}, _Ctx()))
        return out["data"]["reading"]

    def test_no_coverage_pair_is_asserted_in_the_text(self):
        # The literal that shipped, and the shape of any replacement for it.
        txt = self._reading()
        for stale in ("27/40", "27/32", "32/40"):
            self.assertNotIn(stale, txt)
        self.assertIsNone(
            re.search(r"read \d+/\d+ total", txt),
            "a worked coverage pair is a number that goes stale in place")

    def test_it_points_at_THIS_RESPONSE_instead(self):
        self.assertIn("QUOTE THE `coverage` BLOCK IN THIS RESPONSE", self._reading())

    def test_surviving_historical_figures_are_marked_as_PAST(self):
        # Not every number had to go. The Weezer promo counts and Mayonaise are
        # the OBSERVATIONS THAT CAUSED the rules and are worth keeping - but in
        # the past tense, so neither reads as this run's data.
        txt = self._reading()
        self.assertIn("WAS that case on 2026-09-02", txt)
        self.assertIn("THE OBSERVATION THAT CAUSED THE RULE", txt)
        self.assertNotIn("Mayonaise, at 5 of 10", txt)


class SetShapeTests(unittest.TestCase):
    """🛑 THE UNION IS NOT THE SET, AND IT WAS THE DENOMINATOR.

    `coverage.total` is the INCLUSIVE union over the window (12.2) - right for
    "what might I hear", wrong for "is this playlist finished", because he
    attends ONE show. The QOTSA playlist read 5/28 and looked badly incomplete.
    It held FOUR OF THE FIVE songs played at every single show in the window.

    "4 of 5 certainties - add A Song for the Dead" is a proposal somebody can
    act on. "5 of 28, expect a gap" is not, and 12.12 says a number needing a
    caveat should be a different number.

    NOT A SUPPORT-SLOT DEFECT, which is how it was first read - the union of ten
    headline nights exceeds any one of them too. The support slot made it loud.
    """

    MBID = "7dc8f5bd-9d0b-4087-9f73-dc164950bbd8"
    QOTSA = "Queens of the Stone Age"

    # The measured shape, 2026-09-09. Five songs every night, one at 7 of 10,
    # two at 6, and a long tail that comes and goes.
    CORE = ["No One Knows", "Go With the Flow", "Little Sister",
            "My God Is the Sun", "A Song for the Dead"]

    def _shows(self, n=10):
        """n shows: CORE at every one, Make It Wit Chu at 70%, two at 60%,
        and a per-show unique so the union outruns any single night."""
        out = []
        for i in range(n):
            songs = list(self.CORE)
            if i < round(n * 0.7):
                songs.append("Make It Wit Chu")
            if i < round(n * 0.6):
                songs += ["The Lost Art of Keeping a Secret", "Paper Machete"]
            songs.append(f"Deep Cut {i}")
            out.append(songs)
        return out

    def _run(self, body, shows=None, limit=10):
        shows = shows or self._shows()
        pages = [{"setlist": [
            {"id": f"s{i}", "eventDate": f"{(i % 28) + 1:02d}-08-2026",
             "artist": {"name": self.QOTSA},
             "venue": {"name": f"Stadium {i}",
                       "city": {"name": "C", "country": {"code": "US"}}},
             "sets": {"set": [{"song": [{"name": t} for t in titles]}]}}
            for i, titles in enumerate(shows)], "total": len(shows)}]

        def fake_fetch(mbid, page, key):
            return pages[0] if page == 1 else {"setlist": [], "total": len(shows)}

        with mock.patch.object(dj_setlists, "_fetch_page", fake_fetch), \
             mock.patch.object(dj_setlists, "_read_api_key", lambda: "k"):
            out = asyncio.run(dj_setlists.diff_dj_setlists(
                {"mbid": self.MBID, "body": body, "limit": limit,
                 "resolve": False}, _Ctx()))
        return out["data"]

    def _body(self, *titles):
        return [{"title": t, "artist": self.QOTSA, "video_id": f"v{i}"}
                for i, t in enumerate(titles)]

    # -- the real case ----------------------------------------------------

    def test_THE_REAL_CASE_4_of_5_not_5_of_28(self):
        data = self._run(self._body(
            "No One Knows", "Go With The Flow", "The Lost Art Of Keeping A Secret",
            "Little Sister", "My God Is the Sun"))
        sh = data["set_shape"]
        # The union is still reported - it answers a different question.
        self.assertEqual(data["coverage"]["in_body"], 5)
        # The property, not a figure borrowed from the live window: the union is
        # several times the certainties, which is what makes it read as a hole.
        self.assertGreater(data["coverage"]["total"], 3 * sh["core_total"])
        # And the number worth quoting:
        self.assertEqual((sh["core_in_body"], sh["core_total"]), (4, 5))

    def test_the_ONE_REAL_GAP_sorts_to_the_top_of_the_proposal(self):
        # ⚠️ The whole point. 23 songs he will not hear must not bury the one
        # he certainly will.
        data = self._run(self._body(
            "No One Knows", "Go With The Flow", "The Lost Art Of Keeping A Secret",
            "Little Sister", "My God Is the Sun"))
        top = data["missing"][0]
        self.assertEqual(top["title"], "A Song for the Dead")
        self.assertEqual(top["certainty"], "core")
        self.assertEqual(top["plays_in_window"], 10)

    def test_the_typical_set_is_far_below_the_union(self):
        data = self._run([])
        sh = data["set_shape"]
        self.assertLess(sh["typical_set"], sh["union_total"],
                        "if these were equal there would be no defect to fix")

    # -- the classification ------------------------------------------------

    def test_core_is_EVERY_show_not_merely_most(self):
        data = self._run([])
        sh = data["set_shape"]
        self.assertEqual({c["title"] for c in sh["core"]}, set(self.CORE))
        for c in sh["core"]:
            self.assertEqual(c["plays_in_window"], sh["shows_in_window"])

    def test_a_song_missing_from_ONE_SHOW_is_not_core(self):
        """The discriminating case. Without a song at exactly n-1 plays, a
        `>= n - 1` core rule passes every other test in this class - which is
        what the mutation sweep caught."""
        shows = self._shows()
        shows[0] = [t for t in shows[0] if t != "Little Sister"]
        sh = self._run([], shows=shows)["set_shape"]
        names = {c["title"] for c in sh["core"]}
        self.assertNotIn("Little Sister", names,
                         "9 of 10 is not a certainty - he could go on the night "
                         "they drop it")
        self.assertEqual(names, set(self.CORE) - {"Little Sister"})
        # It is not discarded either - it lands in `likely`.
        self.assertIn("Little Sister", {c["title"] for c in sh["likely"]})

    def test_likely_and_rotating_are_SEPARATE_answers(self):
        # ⚠️ A two-way split would put a 7-of-10 song in the same bucket as a
        # 1-of-10 deep cut, which is the collapse this whole block exists to undo.
        data = self._run([])
        sh = data["set_shape"]
        self.assertEqual({c["title"] for c in sh["likely"]},
                         {"Make It Wit Chu", "The Lost Art of Keeping a Secret",
                          "Paper Machete"})
        self.assertGreater(sh["rotating_count"], 0)
        self.assertEqual(
            len(sh["core"]) + len(sh["likely"]) + sh["rotating_count"],
            sh["union_total"], "every song must land in exactly one bucket")

    def test_in_body_is_marked_on_each_named_song(self):
        data = self._run(self._body("No One Knows"))
        core = {c["title"]: c["in_body"] for c in data["set_shape"]["core"]}
        self.assertTrue(core["No One Knows"])
        self.assertFalse(core["A Song for the Dead"])

    # -- the too-thin guard -------------------------------------------------

    def test_a_THIN_WINDOW_REPORTS_NOTHING_rather_than_something_wrong(self):
        """🛑 A NUMBER THAT MEANS NOTHING MUST SAY SO RATHER THAN PRINT.

        With the observed shape - 12 songs a night from a pool of 28 - a randomly
        chosen song appears in all n shows with probability (12/28)^n, so at
        n=3 roughly TWO songs are certified `core` by chance alone.
        """
        data = self._run([], limit=3)
        sh = data["set_shape"]
        self.assertFalse(sh["usable"])
        self.assertNotIn("core", sh)
        self.assertNotIn("core_in_body", sh)
        self.assertIn("coincidence", sh["why_not"])
        self.assertIn("raise `limit`", sh["why_not"])

    def test_certainty_is_NULL_below_the_floor_not_rotating(self):
        # ⚠️ A default of "rotating" would be a verdict reached by having no
        # evidence, and EVERY song would silently carry it.
        data = self._run([], limit=3)
        self.assertTrue(all(e["certainty"] is None for e in data["missing"]))

    def test_the_floor_is_FIVE_shows_exactly(self):
        # The boundary, both sides. Four refuses; five reports.
        self.assertFalse(self._run([], shows=self._shows(4))["set_shape"]["usable"])
        self.assertTrue(self._run([], shows=self._shows(5))["set_shape"]["usable"])

    def test_the_thin_window_still_reports_what_it_CAN_stand_behind(self):
        # Refusing the shape is not refusing everything: the show count and the
        # typical set length need no frequency argument and still ship.
        sh = self._run([], limit=3)["set_shape"]
        self.assertEqual(sh["shows_in_window"], 3)
        self.assertIsNotNone(sh["typical_set"])
        self.assertIsNotNone(sh["union_total"])

    # -- the median ---------------------------------------------------------

    def test_typical_set_is_a_MEDIAN_so_one_radio_session_cannot_drag_it(self):
        # ⚠️ QOTSA's window carries a 4-song KEXP session beside eleven
        # 11-14 song stadium slots. A mean would report a set length no show has.
        shows = self._shows(9) + [["No One Knows", "Go With the Flow"]]
        sh = self._run([], shows=shows)["set_shape"]
        self.assertGreaterEqual(sh["typical_set"], 7,
                                "a single short session must not move the typical "
                                "set toward a length nobody played")

    def test_median_of_an_empty_window_is_None_not_zero(self):
        # Zero would read as "they played nothing", which is a claim.
        self.assertIsNone(dj_setlists._median([]))
        self.assertEqual(dj_setlists._median([11, 12, 13]), 12)
        self.assertEqual(dj_setlists._median([11, 13]), 12)
        # ⚠️ SKEWED, because symmetric inputs cannot tell a median from a mean -
        # [11,12,13] gives 12 either way, and that is how the first version of
        # this test passed against a mean.
        self.assertEqual(dj_setlists._median([4, 11, 12, 13, 14]), 12,
                         "the KEXP session shape: mean would say 10, and no "
                         "show in that window was 10 songs long")


class LooseTitleKeyTests(unittest.TestCase):
    """🛑 THE RULE, NOT A LIST OF CASES THAT MAKE TODAY'S BUG PASS (14.7).

    setlist.fm writes "A Song for the Dead"; YouTube Music titles the same
    recording "Song For The Dead". The diff reported a song already in the
    playlist as missing, then searched for the exact string, found nothing, and
    called it UNCLOSEABLE - two independent-looking confirmations of a false
    premise.

    A difference is folded when BOTH hold:
      (a) it is a FIXED, CLOSED transformation with exactly one expansion, and
      (b) it cannot distinguish two real recordings by the same artist.

    Every case below is the rule being applied, and the NOT-folded half matters
    as much as the folded half - it is what makes this a rule rather than a
    patch list.
    """

    def assertFolds(self, a, b, why):
        self.assertEqual(dj_setlists._loose_key(a), dj_setlists._loose_key(b), why)

    def assertDistinct(self, a, b, why):
        self.assertNotEqual(dj_setlists._loose_key(a), dj_setlists._loose_key(b), why)

    # -- folded: passes (a) and (b) ----------------------------------------

    def test_LEADING_ARTICLE_the_live_bug(self):
        self.assertFolds("Song For The Dead", "A Song for the Dead",
                         "the exact case that reported a held song as missing")

    def test_the_article_folds_in_EITHER_direction(self):
        self.assertFolds("The Way You Used to Do", "Way You Used To Do",
                         "neither vocabulary is the authority on the article")

    def test_ELIDED_G_marked_by_its_apostrophe(self):
        # Queens of the Stone Age's own recording is titled "Hanging Tree";
        # setlist.fm writes "Hangin' Tree".
        self.assertFolds("Hangin' Tree", "Hanging Tree", "elision")
        self.assertFolds("Nothin' Else Matters", "Nothing Else Matters", "elision")

    def test_the_curly_apostrophe_folds_too(self):
        # Two editorial systems, two apostrophe characters.
        self.assertFolds("Hangin\u2019 Tree", "Hanging Tree", "U+2019")

    # -- NOT folded: fails (a) or (b) ---------------------------------------

    def test_Pt_is_NOT_folded_because_it_has_TWO_expansions(self):
        # "Pt." is Part or Point. Fails (a) - not a single expansion.
        self.assertDistinct("Pt. 1", "Part 1", "ambiguous abbreviation")

    def test_roman_numerals_are_NOT_folded(self):
        # "I" is also a pronoun. Fails (a), and risks (b).
        self.assertDistinct("Song 2", "Song II", "ambiguous against real words")

    def test_honorifics_are_NOT_folded(self):
        # The head of an open vocabulary - Mr, Mrs, Dr, St. Fails (a).
        self.assertDistinct("Mr. Brightside", "Mister Brightside", "open vocabulary")

    def test_a_PLURAL_is_content_not_orthography(self):
        self.assertDistinct("A Song for the Dead", "Songs for the Dead",
                            "different songs, and the fold must not merge them")

    # -- the elision fold must not overreach --------------------------------

    def test_a_bare_word_ending_in_IN_is_untouched(self):
        """⚠️ WHY THE FOLD RUNS BEFORE THE APOSTROPHE IS STRIPPED.

        The apostrophe is the EVIDENCE that a letter was dropped. Folding a
        word-final "in" after _norm_title removed it would turn "again" into
        "againg" - a different word, silently.
        """
        self.assertEqual(dj_setlists._loose_key("Again"), "again")
        self.assertDistinct("Again", "Againg", "no apostrophe, no elision")

    def test_ain_t_is_not_mistaken_for_an_elision(self):
        # "Ain't" has only one word char before "in'", so the fold does not
        # reach it - while "Talkin'" in the same title does.
        self.assertEqual(dj_setlists._loose_key("Ain't Talkin'"), "aint talking")

    # -- it is a SECOND key, not a replacement -------------------------------

    def test_norm_title_is_UNCHANGED_because_match_key_is_frozen(self):
        """🛑 _norm_title is a PORT of dj-normalise.ts, which builds
        match_key, WRITTEN ONCE AND FROZEN (4.1.2). Loosening it would diverge
        from every match_key already in the table. The fold lives BESIDE it."""
        self.assertEqual(_norm_title("A Song for the Dead"), "a song for the dead")
        self.assertEqual(_norm_title("Hangin' Tree"), "hangin tree")

    def test_the_loose_key_is_STRICTLY_WEAKER(self):
        # Anything the exact key merges, the loose key must also merge. A fold
        # that disagreed with _norm_title on some pair would not be a fallback,
        # it would be a different question.
        for a, b in [("No Son of Mine", "No Son Of Mine"),
                     ("Salt & Pepper", "Salt and Pepper"),
                     ("Sick, Sick, Sick", "Sick Sick Sick"),
                     ("Alg\u00e9s", "Alges")]:
            if _norm_title(a) == _norm_title(b):
                self.assertFolds(a, b, f"loose must not un-merge {a!r}/{b!r}")


class LooseJoinTests(unittest.TestCase):
    """The fallback in the body join, and the label that keeps it honest."""

    MBID = "7dc8f5bd-9d0b-4087-9f73-dc164950bbd8"
    QOTSA = "Queens of the Stone Age"

    def _run(self, body, setlist_songs=("A Song for the Dead", "No One Knows")):
        # SIX shows, not one: set_shape withholds the core/likely/rotating
        # split below five (§14.51), so a one-show fixture cannot exercise it.
        page = {"setlist": [{
            "id": f"s{i}", "eventDate": f"0{i + 1}-12-2024",
            "artist": {"name": self.QOTSA},
            "venue": {"name": "H", "city": {"name": "C", "country": {"code": "US"}}},
            "sets": {"set": [{"song": [{"name": n} for n in setlist_songs]}]},
        } for i in range(6)], "total": 6}
        with mock.patch.object(dj_setlists, "_fetch_page",
                               lambda m, p, k: page if p == 1 else {"setlist": []}), \
             mock.patch.object(dj_setlists, "_read_api_key", lambda: "k"):
            return asyncio.run(dj_setlists.diff_dj_setlists(
                {"mbid": self.MBID, "body": body, "limit": 10,
                 "resolve": False}, _Ctx()))["data"]

    def _body(self, *titles):
        return [{"title": t, "artist": self.QOTSA, "video_id": f"v{i}"}
                for i, t in enumerate(titles)]

    def test_the_held_song_JOINS(self):
        data = self._run(self._body("Song For The Dead", "No One Knows"))
        self.assertEqual(data["coverage"]["in_body"], 2)
        self.assertEqual(data["missing"], [])

    def test_a_loose_match_is_NEVER_SILENT(self):
        # ⚠️ THE RESIDUAL RISK IS ACCEPTED BY REPORTING IT. The article fold
        # cannot tell "The Man" from "A Man"; both raw titles travel with the
        # match so a wrong join is auditable rather than invisible.
        data = self._run(self._body("Song For The Dead", "No One Knows"))
        self.assertEqual(len(data["loose_title_matches"]), 1)
        m = data["loose_title_matches"][0]
        self.assertEqual(m["setlist_title"], "A Song for the Dead")
        self.assertEqual(m["body_title"], "Song For The Dead")
        self.assertEqual(m["video_id"], "v0")

    def test_an_EXACT_match_reports_no_loose_join(self):
        # 11.7 - a flag that fires on the normal case gets ignored. An empty
        # list is the claim that every match was exact.
        data = self._run(self._body("A Song for the Dead", "No One Knows"))
        self.assertEqual(data["loose_title_matches"], [])
        self.assertTrue(all(r["title_match"] == "exact" for r in data["in_body"]))

    def test_set_shape_READS_THE_JOIN_rather_than_re_testing(self):
        """🛑 ONE QUESTION, ONE ANSWER. The first build had `_brief`
        re-test `title_key in body_titles` - the EXACT key - so a loose match
        showed as "not held" in set_shape while the join had already matched it.
        14.6 inside a single function."""
        data = self._run(self._body("Song For The Dead", "No One Knows"))
        sh = data["set_shape"]
        held = {c["title"]: c["in_body"] for c in sh["core"]}
        self.assertTrue(held["A Song for the Dead"],
                        "set_shape must not disagree with the join it is folded from")

    def test_core_in_body_COUNTS_the_loose_match_too(self):
        # ⚠️ `_brief` and `core_in_body` are two readers of the same fact, and
        # the mutation sweep found only one of them was pinned. Fixing `_brief`
        # while `core_in_body` still re-tested the exact key would report
        # "4 of 5" beside a list showing all five held.
        data = self._run(self._body("Song For The Dead", "No One Knows"))
        sh = data["set_shape"]
        self.assertEqual(sh["core_in_body"], sh["core_total"],
                         "the count must agree with the list beside it")

    def test_the_loose_pass_does_not_invent_matches(self):
        # A genuinely absent song stays missing.
        data = self._run(self._body("No One Knows"))
        self.assertEqual([e["title"] for e in data["missing"]],
                         ["A Song for the Dead"])
        self.assertEqual(data["loose_title_matches"], [])

    def test_one_body_row_cannot_be_claimed_TWICE(self):
        # Both setlist entries fold to the same loose key; only one body row
        # exists. Claiming it twice would make coverage exceed the body.
        data = self._run(self._body("Song For The Dead"),
                         setlist_songs=("A Song for the Dead", "The Song for the Dead"))
        self.assertLessEqual(data["coverage"]["in_body"],
                             data["body_reconciliation"]["body_size"])


class NearTitleTests(unittest.TestCase):
    """🛑 A VERDICT MUST CARRY WHAT WOULD CONTRADICT IT.

    "Hangin' Tree" was reported `other_artists_only` and NAMED Olivier Libaux
    and Vitamin String Quartet as evidence - both real covers under that exact
    title. Queens of the Stone Age's own "Hanging Tree" was in the same result
    list. The verdict was literally true of the string and entirely wrong about
    the song, and the named evidence made it look verified.
    """

    QOTSA = "Queens of the Stone Age"

    def test_the_artists_own_near_title_travels_with_a_NOT_FOUND(self):
        results = [
            r("Hangin' Tree", ["Olivier Libaux"], "Uncovered QOTSA", 190),
            r("Hangin' Tree", ["Vitamin String Quartet"], "Strings", 189),
            r("Hanging Tree", [self.QOTSA], "Songs For The Deaf", 187, vid="own"),
        ]
        out = _resolve_one(results, "Hangin' Tree", self.QOTSA)
        # The loose key now RESOLVES this one outright.
        self.assertEqual(out["resolution"], "resolved")
        self.assertEqual(out["video_id"], "own")
        self.assertEqual(out["title_match"], "loose")

    def test_a_TRUE_other_artists_only_still_says_so(self):
        # ⚠️ THE NEGATIVE CONTROL. If the loose key swallowed every case,
        # the cover ruling would be dead code that looks like caution.
        results = [r("One Headlight", ["The Wallflowers"], "Bringing Down", 313)]
        out = _resolve_one(results, "One Headlight", FF)
        self.assertEqual(out["not_found_cause"], "other_artists_only")
        self.assertEqual(out["near_titles_by_artist"], [])

    def test_a_not_found_carries_near_titles_when_the_artist_HAS_something_close(self):
        # Nothing folds these two, but they are close enough that "no such
        # title" is the wrong story.
        results = [r("Songs for the Deaf", [self.QOTSA], "SFTD", 400, vid="near")]
        out = _resolve_one(results, "Song for the Deaf II", self.QOTSA)
        self.assertEqual(out["resolution"], "not_found")
        self.assertEqual([n["title"] for n in out["near_titles_by_artist"]],
                         ["Songs for the Deaf"])

    def test_the_fallback_swaps_ONLY_when_the_loose_pass_does_BETTER(self):
        """⚠️ When NEITHER tier has the act's own version, the exact results are
        kept so the cover ruling names what it actually found under the title
        asked for. Swapping in the looser set would credit the verdict with
        evidence it did not have."""
        results = [
            r("A Hanging Tree", ["Cover Band A"], "Tributes", 190, vid="a"),
            r("Hanging Tree", ["Cover Band B"], "More Tributes", 191, vid="b"),
        ]
        out = _resolve_one(results, "A Hanging Tree", self.QOTSA)
        self.assertEqual(out["not_found_cause"], "other_artists_only")
        self.assertEqual([c["video_id"] for c in out["other_artists_found"]], ["a"],
                         "only the EXACT-title cover is evidence about the title "
                         "that was asked for")

    def test_near_titles_are_the_PERFORMING_artists_only(self):
        # A cover with a near title is not evidence the act has the song.
        results = [r("Hanging Tree", ["Some Tribute Band"], "Covers", 187)]
        out = _resolve_one(results, "Hangin Tree II", self.QOTSA)
        self.assertEqual(out["near_titles_by_artist"], [])

    def test_an_unrelated_track_from_the_same_album_is_NOT_near(self):
        # 11.7 - if every album-mate qualified, the field would be noise on
        # every not_found and get ignored.
        results = [r("Mosquito Song", [self.QOTSA], "Songs For The Deaf", 339)]
        out = _resolve_one(results, "Hangin Tree", self.QOTSA)
        self.assertEqual(out["near_titles_by_artist"], [])


if __name__ == "__main__":
    unittest.main()
