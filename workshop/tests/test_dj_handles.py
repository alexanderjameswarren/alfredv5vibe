"""set_video_id handle safety — the guard on the DESTRUCTIVE tool.

🛑 WHY THIS FILE EXISTS. `_verify_entries` is the only thing standing between a
reused handle and a removal from the wrong entry, and until 2026-09-09 it had NO
TESTS AT ALL. The envelope suite drives `remove_from_dj_playlist` once, with a
fixture whose single pair matches — the HAPPY PATH. Every rejection branch was
unexercised: the guard looked like it worked because nothing had ever asked it
to work. That is §14.42's shape on the tool where it costs the most.

⚠️ THE MEASUREMENT THAT MOTIVATES IT, twice now. 2026-08-28: of twelve handles on
a freshly created playlist, eleven already existed in another playlist and three
denoted a DIFFERENT song there. 2026-09-09: all FIVE handles on a minutes-old
QOTSA playlist were byte-identical to five in the Foo Fighters playlist —
No One Knows/Everlong, Go With The Flow/The Pretender. Handle reuse is not a
theoretical hazard, it is the normal case.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import unittest
import unittest.mock as mock
from typing import Any

from workshop.platform import OperationalError
from workshop.tools import dj_write


class _Cfg:
    host_id = "surface"


class _Ctx:
    config = _Cfg()


# The real collision, as measured. The same handle denotes a different song in
# each playlist.
FOO = {
    "id": "PL_foo", "title": "Foo Fighters Concert", "owned": True,
    "privacy": "PRIVATE", "trackCount": 2,
    "tracks": [
        {"videoId": "vid_everlong", "setVideoId": "HANDLE_A"},
        {"videoId": "vid_pretender", "setVideoId": "HANDLE_B"},
    ],
}
QOTSA = {
    "id": "PL_qotsa", "title": "Queens of the Stone Age Concert", "owned": True,
    "privacy": "PRIVATE", "trackCount": 2,
    "tracks": [
        {"videoId": "vid_nooneknows", "setVideoId": "HANDLE_A"},
        {"videoId": "vid_gowiththeflow", "setVideoId": "HANDLE_B"},
    ],
}


class _Fake:
    """Records every upstream call so a mutation that should not have happened
    can be asserted ABSENT rather than merely unobserved."""

    def __init__(self, playlists: dict, **extra):
        self.playlists = playlists
        self.extra = extra
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, host_id: str, method: str, **kwargs) -> Any:
        self.calls.append((method, kwargs))
        if method == "get_playlist":
            return self.playlists.get(kwargs.get("playlistId")) or {}
        return self.extra.get(method, "STATUS_SUCCEEDED")

    def removals(self):
        return [k for m, k in self.calls if m == "remove_playlist_items"]


def _remove(fake, **args):
    args.setdefault("confirmed", True)
    with mock.patch.object(dj_write, "_call", fake):
        return asyncio.run(dj_write.remove_from_dj_playlist(args, _Ctx()))


class RemoveVerifiesTheSameWayMoveDoesTests(unittest.TestCase):
    """The question asked directly: does the DESTRUCTIVE tool check the pair?"""

    def test_a_correct_pair_removes(self):
        fake = _Fake({"PL_qotsa": QOTSA})
        out = _remove(fake, playlist_id="PL_qotsa", mode="remove_items",
                      entries=[{"video_id": "vid_nooneknows",
                                "set_video_id": "HANDLE_A"}])
        self.assertEqual(out["data"]["removed"], 1)
        self.assertEqual(len(fake.removals()), 1)

    def test_A_FOREIGN_HANDLE_THAT_EXISTS_HERE_IS_REFUSED(self):
        """🛑 THE ACTUAL DEFECT, REPRODUCED — §11.16.

        HANDLE_A is Everlong's handle in the Foo Fighters playlist and No One
        Knows' handle in QOTSA. Carrying it over with Everlong's video_id is the
        exact mistake handle reuse invites.

        ⚠️ A set_video_id-ONLY check would have found HANDLE_A present in QOTSA
        and REMOVED NO ONE KNOWS — a real, wrong entry, reported as success.
        The PAIR is what makes that impossible: the pair is not in this playlist
        even though the handle is.
        """
        fake = _Fake({"PL_qotsa": QOTSA})
        with self.assertRaises(OperationalError) as cm:
            _remove(fake, playlist_id="PL_qotsa", mode="remove_items",
                    entries=[{"video_id": "vid_everlong",
                              "set_video_id": "HANDLE_A"}])
        self.assertIn("stale_or_foreign_handle", str(cm.exception))
        self.assertIn("NOTHING WAS CHANGED", str(cm.exception))

    def test_NOTHING_IS_REMOVED_when_verification_fails(self):
        # ⚠️ "It raised" is not the same claim as "it did not remove anything".
        # §11.15 — a success path that never verifies its effect. The upstream
        # mutation must be ABSENT from the call log, not merely unmentioned.
        fake = _Fake({"PL_qotsa": QOTSA})
        with self.assertRaises(OperationalError):
            _remove(fake, playlist_id="PL_qotsa", mode="remove_items",
                    entries=[{"video_id": "vid_everlong",
                              "set_video_id": "HANDLE_A"}])
        self.assertEqual(fake.removals(), [],
                         "remove_playlist_items was called despite a failed "
                         "verification")

    def test_ONE_BAD_PAIR_STOPS_THE_WHOLE_BATCH(self):
        # All-or-nothing. A partial removal would leave the caller unable to say
        # what happened without re-reading, and the good half is easy to redo.
        fake = _Fake({"PL_qotsa": QOTSA})
        with self.assertRaises(OperationalError):
            _remove(fake, playlist_id="PL_qotsa", mode="remove_items",
                    entries=[{"video_id": "vid_nooneknows", "set_video_id": "HANDLE_A"},
                             {"video_id": "vid_everlong", "set_video_id": "HANDLE_A"}])
        self.assertEqual(fake.removals(), [])

    def test_a_wholly_unknown_handle_is_refused(self):
        fake = _Fake({"PL_qotsa": QOTSA})
        with self.assertRaises(OperationalError) as cm:
            _remove(fake, playlist_id="PL_qotsa", mode="remove_items",
                    entries=[{"video_id": "vid_nooneknows", "set_video_id": "GONE"}])
        self.assertIn("stale_or_foreign_handle", str(cm.exception))

    def test_the_right_playlist_is_the_one_READ(self):
        # ⚠️ Verifying against the wrong playlist would pass every foreign
        # handle. The read must be scoped to the playlist being mutated.
        fake = _Fake({"PL_qotsa": QOTSA, "PL_foo": FOO})
        _remove(fake, playlist_id="PL_qotsa", mode="remove_items",
                entries=[{"video_id": "vid_nooneknows", "set_video_id": "HANDLE_A"}])
        reads = [k["playlistId"] for m, k in fake.calls if m == "get_playlist"]
        self.assertEqual(reads, ["PL_qotsa"])

    def test_move_and_remove_use_THE_SAME_verifier(self):
        # §14.6 — a rule in two places drifts. This asserts they are literally
        # one function rather than two implementations that agree today.
        import inspect
        src = inspect.getsource(dj_write)
        self.assertEqual(src.count("await _verify_entries("), 2,
                         "move and remove must both call the shared verifier")


class DuplicateRowTests(unittest.TestCase):
    """The pair is what lets one of two identical songs be removed."""

    TWO_SAME = {
        "id": "PL_dup", "title": "Dup", "owned": True, "privacy": "PRIVATE",
        "trackCount": 2,
        "tracks": [
            {"videoId": "vid_marigold", "setVideoId": "H1"},
            {"videoId": "vid_marigold", "setVideoId": "H2"},
        ],
    }

    def test_one_of_two_identical_rows_can_be_removed(self):
        fake = _Fake({"PL_dup": self.TWO_SAME})
        _remove(fake, playlist_id="PL_dup", mode="remove_items",
                entries=[{"video_id": "vid_marigold", "set_video_id": "H2"}])
        sent = fake.removals()[0]["videos"]
        self.assertEqual(sent, [{"videoId": "vid_marigold", "setVideoId": "H2"}],
                         "the handle must travel so the OTHER row survives")


class PartialReadTests(unittest.TestCase):
    """⚠️ §11.20 — A DIAGNOSTIC THAT INFERS THE WRONG CAUSE IS WORSE THAN NONE.

    The contents read is capped at ITEMS_CAP. On a longer playlist the live view
    is PARTIAL, so a perfectly good handle for entry 201 is absent from it. The
    old code reported that as `stale_or_foreign_handle` — sending the reader to
    re-read the playlist, get the same handle back, and try again forever.
    """

    LONG = {
        "id": "PL_long", "title": "Long", "owned": True, "privacy": "PRIVATE",
        # More entries than were returned: exactly the truncated-read shape.
        "trackCount": 500,
        "tracks": [{"videoId": f"v{i}", "setVideoId": f"h{i}"} for i in range(200)],
    }

    def test_an_unseen_handle_is_NOT_blamed_on_staleness(self):
        fake = _Fake({"PL_long": self.LONG})
        with self.assertRaises(OperationalError) as cm:
            _remove(fake, playlist_id="PL_long", mode="remove_items",
                    entries=[{"video_id": "v400", "set_video_id": "h400"}])
        msg = str(cm.exception)
        self.assertIn("playlist_too_large_to_verify", msg)
        self.assertIn("MAY BE PERFECTLY VALID", msg)
        self.assertNotIn("stale_or_foreign_handle", msg)

    def test_it_still_FAILS_CLOSED(self):
        # Only the reason changes. Refusing remains the behaviour, because a
        # handle that cannot be confirmed must not be acted on.
        fake = _Fake({"PL_long": self.LONG})
        with self.assertRaises(OperationalError):
            _remove(fake, playlist_id="PL_long", mode="remove_items",
                    entries=[{"video_id": "v400", "set_video_id": "h400"}])
        self.assertEqual(fake.removals(), [])

    def test_a_handle_INSIDE_the_window_still_works_on_a_long_playlist(self):
        # ⚠️ NEGATIVE CONTROL. A guard that refused every long playlist would
        # pass both tests above and break removal entirely.
        fake = _Fake({"PL_long": self.LONG})
        out = _remove(fake, playlist_id="PL_long", mode="remove_items",
                      entries=[{"video_id": "v5", "set_video_id": "h5"}])
        self.assertEqual(out["data"]["removed"], 1)

    def test_a_SHORT_playlist_still_reports_staleness_plainly(self):
        # The other negative control: the new branch must not swallow the case
        # it was carved out of.
        fake = _Fake({"PL_qotsa": QOTSA})
        with self.assertRaises(OperationalError) as cm:
            _remove(fake, playlist_id="PL_qotsa", mode="remove_items",
                    entries=[{"video_id": "vid_everlong", "set_video_id": "HANDLE_A"}])
        self.assertIn("stale_or_foreign_handle", str(cm.exception))


class PreviewIsAdvisoryTests(unittest.TestCase):
    """🛑 THE PREVIEW DOES NOT MITIGATE THIS, AND MUST NOT BE RELIED ON TO.

    Checked rather than assumed: `_build_tier_3_proposal` CATCHES a preview
    failure and reports it inside the proposal. Nothing then prevents a
    `confirmed: true` re-call — the gate is a re-call, not a lock. A preview is
    therefore a warning a human reads, and the execute-path verifier is the
    only thing that actually refuses.
    """

    def test_the_preview_reports_a_foreign_handle_as_UNMATCHED(self):
        fake = _Fake({"PL_qotsa": QOTSA})
        with mock.patch.object(dj_write, "_call", fake):
            found = asyncio.run(dj_write._preview_removal(
                {"playlist_id": "PL_qotsa", "mode": "remove_items",
                 "entries": [{"video_id": "vid_everlong",
                              "set_video_id": "HANDLE_A"}]}, _Ctx()))
        self.assertEqual(found["would_remove"], 0)
        self.assertEqual(found["would_not_match"], 1)

    def test_but_a_FAILED_PREVIEW_DOES_NOT_BLOCK_CONFIRMATION(self):
        """⚠️ THE REASON THE EXECUTE-PATH CHECK CANNOT BE DROPPED.

        The proposal swallows the exception and returns a warning. A caller that
        re-calls with confirmed:true reaches the tool regardless, so removing
        `_verify_entries` and leaning on the preview would leave NOTHING
        enforcing the pair.
        """
        from workshop import platform as plat

        async def boom(args, ctx):
            raise OperationalError("not_found: no playlist resolved")

        entry = plat.ToolEntry(
            name="t", tier=3, description="d", input_schema={}, handler=boom,
            preview=boom, long_running=False,
        )
        proposal = asyncio.run(plat._build_tier_3_proposal(entry, {}, _Ctx()))
        self.assertFalse(proposal["target"]["resolved"])
        self.assertIn("Do NOT confirm", proposal["target"]["warning"])
        # It is a WARNING in a payload — advisory text, not an enforced refusal.
        self.assertEqual(proposal["kind"], "tier_3_proposal")


if __name__ == "__main__":
    unittest.main()
