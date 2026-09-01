"""Envelope tests - the check that IMPORTING the module cannot perform.

WHY THIS FILE EXISTS
--------------------
On 2026-09-01 ``get_dj_setlists`` was verified by invoking its handler
directly::

    res = await get_dj_setlists({"mbid": ..., "limit": 10}, ctx)

That call returned the right ten setlists with the right ``song_count`` per
show, and those numbers were reported as check 3 passing. They were correct.
**The tool was still completely broken**, because the handler returned a bare
dict and ``platform.call_tool`` - the ONLY path a real MCP call takes - runs
``_validate_envelope`` on whatever comes back. Every real call failed with
"envelope is missing 'data'". A direct handler call skips that step entirely.

[!] **INVOKING THE HANDLER IS NOT MAKING THE CALL.** The handler is the middle
of the dispatch path, not the whole of it. Around it sit registration, the
tier gate, schema parity and envelope validation, and a handler can satisfy
every assertion you make about it while the call through it fails.

[!] **THIS IS THE THIRD TIME THE SAME SHAPE OF MISTAKE SHIPPED IN ONE TOOL:**

  1. ``ast.parse`` proved the module was SYNTACTICALLY VALID and was reported
     as "parses cleanly". It did not import - ``@define_tool`` was missing
     ``input_schema`` and raised ``TypeError`` at import. (Guarded now by
     ``test_tools_import.py``.)
  2. The handler was declared ``(ctx, mbid, limit)``. That made the schema
     parity assertion pass VACUOUSLY - it only inspects ``args[...]`` and
     ``args.get(...)``, and a typed signature reads neither, so the check
     inspected nothing and reported success.
  3. Direct invocation proved the handler COMPUTED THE RIGHT ANSWER. It
     skipped envelope validation, so a broken tool returned correct numbers.

Each verification tested one layer and reported on the whole tool. The common
repair is the one this file makes: **drive the call through the real
dispatcher**, because that is the only thing that exercises every layer at
once (spec §11.15 - an operation that reports success without verifying its
EFFECT is a check that cannot fail; §11.18 - a check that reads the SOURCE
cannot prove the module LOADS, and by the same argument importing the module
cannot prove a CALL through it works).

WHAT IS STUBBED, AND WHAT DELIBERATELY IS NOT
---------------------------------------------
Only the outermost I/O boundary is replaced: ``dj._call`` (every ytmusicapi
method funnels through it) and, for setlists, ``_read_api_key`` /
``_fetch_page``. Registration, the tier gate, argument handling, projection
and ``_validate_envelope`` all run for real. Stubbing anything further in
would start testing the stub.

Run: ``python -m unittest discover tests`` from the ``workshop/`` dir.
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import unittest
from typing import Any
from unittest import mock

from workshop import tools as _tools  # noqa: F401 - populates the registry
from workshop.platform import Ctx, call_tool, get_registry

# Snapshot taken AT IMPORT TIME, and that timing is the whole point.
#
# ``test_platform.py`` calls ``_reset_registry_for_tests()``, which empties the
# module-level registry. Under ``unittest discover`` every test module is
# IMPORTED before any test RUNS, so this line sees a fully populated registry;
# by the time the tests below execute, another module may have cleared it.
# Without restoring from this snapshot, these tests pass alone and fail under
# discover — i.e. they would pass or fail on TEST ORDER rather than on the
# code, which is the same trap ``test_tools_import.py`` avoids with
# subprocesses. Subprocesses are not usable here: these assertions need the
# real objects in-process to patch the I/O boundary.
_REGISTRY_SNAPSHOT = get_registry()
assert _REGISTRY_SNAPSHOT, (
    "the tool registry was already empty when test_tool_envelopes was "
    "imported, so every test below would run against nothing and report "
    "success. Something reset the registry at import time."
)


class _FakeConfig:
    host_id = "test-host"
    workshop_port = 0
    public_origin = "http://localhost"
    auth_mode = "off"


def _ctx() -> Ctx:
    return Ctx(
        host_id="test-host",
        config=_FakeConfig(),          # type: ignore[arg-type]
        log=logging.getLogger("envelope-test"),
    )


# One setlist.fm page holding a played show and an upcoming one, so the
# skip-empties branch runs rather than being bypassed.
_SETLIST_PAGE = {
    "total": 2,
    "setlist": [
        {
            "id": "abc1234",
            "eventDate": "22-08-2026",
            "venue": {
                "name": "Hollywood Bowl",
                "city": {"name": "Los Angeles", "country": {"code": "US"}},
            },
            "tour": {"name": "Take Cover 2026"},
            "sets": {"set": [{"song": [{"name": "Everlong"}, {"name": "Aurora"}]}]},
            "url": "https://www.setlist.fm/setlist/abc1234.html",
        },
        {
            # Upcoming: no songs. Must be skipped AND counted.
            "id": "def5678",
            "eventDate": "30-09-2026",
            "venue": {
                "name": "Sphere",
                "city": {"name": "Las Vegas", "country": {"code": "US"}},
            },
            "sets": {"set": []},
        },
    ],
}

_EMPTY_SETLIST_PAGE = {"total": 2, "setlist": []}

# Minimal upstream payloads per ytmusicapi method, keyed as `_call` dispatches.
_YT_RESPONSES: dict[str, Any] = {
    "get_history": [],
    "get_library_playlists": [],
    # One track, because remove_from_dj_playlist verifies each entry against a
    # live contents read before removing it. An empty playlist would make that
    # tool fail on "entry not found" and never reach its return.
    "get_playlist": {
        "id": "PL_test",
        "title": "Test",
        "privacy": "PRIVATE",
        "owned": True,
        "trackCount": 1,
        "tracks": [
            {
                "videoId": "v1",
                "setVideoId": "s1",
                "title": "Test Track",
                "artists": [{"name": "Test Artist", "id": "UC_test"}],
                "album": {"name": "Test Album", "id": "MPREb_test"},
                "duration_seconds": 200,
                "isAvailable": True,
            }
        ],
    },
    "search": [],
    "create_playlist": "PL_created",
    "edit_playlist": {"status": "STATUS_SUCCEEDED"},
    "add_playlist_items": {"status": "STATUS_SUCCEEDED"},
    "remove_playlist_items": {"status": "STATUS_SUCCEEDED"},
    "delete_playlist": {"status": "STATUS_SUCCEEDED"},
}

# Args that reach each handler's return statement. Tier 3 passes
# `confirmed: True` on purpose - without it `call_tool` short-circuits to a
# proposal and never runs the handler, so the envelope would go unexercised.
_CALLS: dict[str, dict] = {
    "get_dj_history": {"limit": 5},
    "get_dj_playlists": {"mode": "library"},
    "get_dj_setlists": {
        "mbid": "67f66c07-6e61-4026-ade5-7e782fad3a5d",
        "limit": 10,
    },
    "get_workshop_status": {},
    "get_job_status": {"job_id": "nope"},
    "list_jobs": {},
    "search_dj_music": {"query": "foo fighters"},
    "create_dj_playlist": {"title": "Test Playlist", "confirmed": True},
    "edit_dj_playlist": {
        "playlist_id": "PL_test",
        "mode": "add",
        "video_ids": ["v1"],
        "confirmed": True,
    },
    "remove_from_dj_playlist": {
        "playlist_id": "PL_test",
        "mode": "remove_items",
        "entries": [{"video_id": "v1", "set_video_id": "s1"}],
        "confirmed": True,
    },
}


async def _fake_call(host_id: str, method: str, **kwargs) -> Any:
    if method not in _YT_RESPONSES:
        raise AssertionError(
            f"the envelope test drove an unstubbed ytmusicapi method "
            f"{method!r}. Add it to _YT_RESPONSES rather than letting the "
            f"call reach the network."
        )
    return _YT_RESPONSES[method]


def _fake_fetch_page(mbid: str, page: int, api_key: str) -> dict:
    return _SETLIST_PAGE if page == 1 else _EMPTY_SETLIST_PAGE


class ToolEnvelopeTests(unittest.TestCase):
    """Every registered tool, driven through ``call_tool``."""

    def setUp(self) -> None:
        patches = [
            # Restore the registry another module may have reset. See the
            # note on _REGISTRY_SNAPSHOT.
            mock.patch.dict(
                "workshop.platform._REGISTRY",
                _REGISTRY_SNAPSHOT,
                clear=True,
            ),
            mock.patch("workshop.tools.dj._call", _fake_call),
            mock.patch("workshop.tools.dj_write._call", _fake_call),
            mock.patch(
                "workshop.tools.dj_setlists._read_api_key", lambda: "test-key"
            ),
            mock.patch(
                "workshop.tools.dj_setlists._fetch_page", _fake_fetch_page
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _drive(self, name: str, args: dict) -> tuple[Any, dict]:
        return asyncio.run(call_tool(name, args, _ctx()))

    def test_every_registered_tool_is_covered_here(self) -> None:
        """No tool may be added without an envelope case.

        Without this, a new tool with a bare-dict return would ship green -
        which is exactly how the defect this file exists for got out.
        """
        registered = set(get_registry())
        self.assertEqual(
            registered,
            set(_CALLS),
            "registered tools and envelope cases disagree.\n"
            f"  no envelope case: {sorted(registered - set(_CALLS))}\n"
            f"  case with no tool: {sorted(set(_CALLS) - registered)}\n"
            "Add the tool to _CALLS (and any upstream method it needs to "
            "_YT_RESPONSES). Do not delete a case to make this pass.",
        )

    def test_all_tools_return_a_valid_envelope(self) -> None:
        """The real assertion: dispatch succeeds and yields ``(data, meta)``.

        ``call_tool`` runs ``_validate_envelope`` itself, so a bare-dict
        return raises ValueError here and the test fails with the tool's name.
        """
        for name, args in sorted(_CALLS.items()):
            with self.subTest(tool=name):
                data, meta = self._drive(name, args)
                self.assertIsNotNone(
                    data, f"{name} dispatched but its envelope 'data' is None"
                )
                self.assertIsInstance(
                    meta, dict, f"{name} envelope 'meta' is not a dict"
                )

    def test_get_dj_setlists_envelope_carries_the_payload(self) -> None:
        """The specific tool that shipped broken, asserted on its contents.

        A tool could satisfy the loop above with a near-empty payload, so the
        one that failed gets its real fields checked: the played show is kept,
        the upcoming one is skipped AND COUNTED (the distinction the tool
        exists to preserve), and none of it leaks into ``meta``.
        """
        data, meta = self._drive("get_dj_setlists", _CALLS["get_dj_setlists"])
        self.assertEqual(data["returned"], 1)
        self.assertEqual(data["empty_entries_skipped"], 1)
        self.assertEqual(data["setlists"][0]["song_count"], 2)
        self.assertEqual(data["setlists"][0]["venue"], "Hollywood Bowl")
        self.assertEqual(meta, {})


class EnvelopeCheckIsNotVacuousTests(unittest.TestCase):
    """NEGATIVE CONTROL - proof the test above can actually fail.

    Per spec §11.16 the control must reproduce the ACTUAL defect, not a
    plausible neighbour. So it does not return a string or raise: it returns a
    BARE DICT holding correct-looking data, which is precisely what
    ``get_dj_setlists`` did while reporting the right ten setlists.
    """

    VALID_MBID = "67f66c07-6e61-4026-ade5-7e782fad3a5d"

    def setUp(self) -> None:
        # Same registry restore as above — see _REGISTRY_SNAPSHOT.
        p = mock.patch.dict(
            "workshop.platform._REGISTRY", _REGISTRY_SNAPSHOT, clear=True
        )
        p.start()
        self.addCleanup(p.stop)

    @staticmethod
    async def _bare_dict_handler(args: dict, ctx: Ctx) -> dict:
        # Correct-looking numbers, no envelope - the 2026-09-01 defect exactly.
        return {"mbid": args.get("mbid"), "setlists": [], "returned": 10}

    def test_a_bare_dict_return_fails_dispatch(self) -> None:
        # Two things this has to get right, both found the hard way:
        #   * ToolEntry is a FROZEN dataclass, so the handler is swapped by
        #     replacing the whole entry, not by setattr.
        #   * get_registry() returns a DEFENSIVE COPY. Patching that copy
        #     leaves dispatch running the real handler, and this control then
        #     reports "ValueError not raised" — a control that tests nothing.
        #     The live module-level registry is the thing to patch.
        broken = dataclasses.replace(
            get_registry()["get_dj_setlists"], handler=self._bare_dict_handler
        )
        with mock.patch.dict(
            "workshop.platform._REGISTRY", {"get_dj_setlists": broken}
        ):
            with self.assertRaises(ValueError) as caught:
                asyncio.run(
                    call_tool(
                        "get_dj_setlists", {"mbid": self.VALID_MBID}, _ctx()
                    )
                )
        self.assertIn(
            "missing 'data'",
            str(caught.exception),
            "dispatch failed for some reason OTHER than the missing envelope, "
            "so this control is not reproducing the real defect.",
        )

    def test_direct_invocation_would_have_passed(self) -> None:
        """THE LESSON, asserted rather than written in a comment.

        The bare-dict handler that ``call_tool`` rejects above is perfectly
        happy when invoked directly - returning data a caller would report as
        a passing check. That gap is why check 3 read as green.
        """
        result = asyncio.run(
            self._bare_dict_handler({"mbid": self.VALID_MBID}, _ctx())
        )
        self.assertEqual(result["returned"], 10)   # "the numbers were right"
        self.assertNotIn("data", result)           # "and the tool was broken"


if __name__ == "__main__":
    unittest.main()
