"""DJ write tools — YouTube Music playlist mutation, plus search (spec §7 phase 3).

Workshop **never writes to Supabase** — Claude is the courier for that (§2). It
**does** write to YouTube Music, which is the only system it holds a credential
for. Phase 1's read-only framing was always scoped to Supabase; §2 now says so
explicitly, because read on its own reads as "Workshop mutates nothing" and that
was never the design.

Four tools, split by TIER rather than by convenience. Tier is a property of the
tool, not of the call (platform §4.2), so a single mode-based tool cannot span
tiers — that is what forces `remove_from_dj_playlist` to stand alone rather than
being another mode on `edit_dj_playlist`:

  search_dj_music         tier 1 — read; resolves titles to video ids
  create_dj_playlist      tier 2 — creates a real object in the user's account
  edit_dj_playlist        tier 2 — mode: add | move | rename. Non-destructive.
  remove_from_dj_playlist tier 3 — mode: remove_items | delete_playlist.
                                   Gates on confirmed: true.

Tier 3 on removals is a speed bump, not a blocker: a caller passes
`confirmed: true` on the second call, so phase 7's cram clearing stays
automatable while every destructive YouTube call has to state its intent.

The gate alone was not enough. It stops accidental EXECUTION but not accidental
WRONG TARGET — a proposal that echoed only its arguments read exactly as
reassuring for a mistyped playlist id as for the right one, and a human being
able to READ it is the entire point. `remove_from_dj_playlist` therefore supplies
a `preview` that resolves the playlist and reports its title, track count and the
concrete effect, plus how many of the requested entries actually match. The
platform now REQUIRES that hook on every tier-3 tool at registration time, so the
property is mechanical rather than a habit each destructive tool re-forms.

Credential handling, lazy imports, threading and error classification are all
shared with dj.py — see that module's header for why each is the way it is.
"""
from __future__ import annotations

from typing import Any

from ..platform import Ctx, OperationalError, clamp_limit, define_tool
from .dj import (
    _album,
    _artists,
    _call,
    KNOWN_BUCKETS,  # noqa: F401 — re-exported for callers that introspect dj tools
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# ytmusicapi's `limit` is a FETCH HINT, not a hard cap — asking for 3 search
# results returned 20, exactly as get_playlist(limit=100) returned 160 in
# phase 1. The cap is enforced by slicing here or it is not enforced at all.
SEARCH_DEFAULT = 10
SEARCH_CAP = 25

# One call should not be able to rewrite a library. A concert setlist is
# ~20 songs; the largest playlist in the library is 161.
ITEMS_CAP = 200

SEARCH_FILTERS = ("songs", "videos", "albums", "artists", "playlists")


# ---------------------------------------------------------------------------
# search_dj_music — tier 1
# ---------------------------------------------------------------------------


@define_tool(
    name="search_dj_music",
    tier=1,
    description=(
        "Search YouTube Music and return candidate tracks with their video ids. "
        "Read-only. This is how a title becomes a `video_id` before it can be "
        "added to a playlist. "
        "⚠️ SEARCH ALWAYS RETURNS SOMETHING — the risk is not failure, it is a "
        "confident WRONG match: a cover, a live cut, a karaoke version, a "
        "tribute band, or the wrong remaster. "
        "TITLE COLLISIONS ARE ROUTINE, NOT AN EDGE CASE — one search for "
        "'Happy Together' returned SIX different recordings under that exact "
        "title: Weezer, The Turtles, Gerard Way, Filter, Johnny Cash, and King "
        "Princess with Mark Ronson. Picking by title alone is roughly a "
        "one-in-six guess. "
        "THE ARTIST MUST BE MATCHED, NOT MERELY NOTICED: treat a result whose "
        "`artists` do not match the artist you want as a NON-match, however "
        "well the title fits. Where the top results disagree on artist, surface "
        "the alternatives to a human rather than choosing between them. Never "
        "write a resolved video_id anywhere durable without that confirmation. "
        "`filter` defaults to 'songs', which excludes the user-uploaded video "
        "results that are the most common wrong answer."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search text. Including the artist name sharply improves precision.",
            },
            "filter": {
                "type": "string",
                "enum": list(SEARCH_FILTERS),
                "description": "Result category. Defaults to 'songs'.",
            },
            "limit": {
                "type": "integer",
                "description": f"Max results (default {SEARCH_DEFAULT}, cap {SEARCH_CAP}).",
            },
        },
        "required": ["query"],
    },
)
async def search_dj_music(args: dict, ctx: Ctx) -> dict:
    query = args.get("query")
    if not query or not isinstance(query, str):
        raise OperationalError(
            "bad_argument: `query` is required and must be a string. "
            "Re-call with a corrected value."
        )
    filt = args.get("filter") or "songs"
    if filt not in SEARCH_FILTERS:
        raise OperationalError(
            f"bad_argument: `filter` must be one of {list(SEARCH_FILTERS)} "
            f"(got {filt!r}). Re-call with a corrected value."
        )
    limit = clamp_limit(args.get("limit"), default=SEARCH_DEFAULT, cap=SEARCH_CAP)

    raw = await _call(
        ctx.config.host_id, "search", query=query, filter=filt, limit=limit
    ) or []

    results = []
    for item in raw[:limit]:
        results.append({
            "video_id": item.get("videoId"),
            "title": item.get("title"),
            "artists": _artists(item),
            "album": _album(item),
            "duration_seconds": item.get("duration_seconds"),
            "duration": item.get("duration"),
            "year": item.get("year"),
            "result_type": item.get("resultType"),
            "video_type": item.get("videoType"),
            "in_library": item.get("inLibrary"),
            "is_explicit": item.get("isExplicit"),
        })

    return {
        "data": {
            "query": query,
            "filter": filt,
            "results": results,
            "returned": len(results),
            "fetched": len(raw),
            "limit_applied": limit,
            "review_required": (
                "Search cannot fail, only be wrong. Check artists and album on "
                "the chosen result before treating any video_id as resolved."
            ),
        },
        # Not meta.truncated: `fetched` is what one upstream page happened to
        # hand back, not a measured total, so "N of M" would state a total we
        # do not actually know.
        "meta": {},
    }


# ---------------------------------------------------------------------------
# create_dj_playlist — tier 2
# ---------------------------------------------------------------------------


@define_tool(
    name="create_dj_playlist",
    tier=2,
    description=(
        "Create a new playlist in YouTube Music, optionally populated in one "
        "call. `video_ids` are added IN THE ORDER GIVEN, which is how a concert "
        "setlist gets its body order without a separate reorder step. Returns "
        "the new `playlist_id`. Privacy defaults to PRIVATE. "
        "Tier 2 — creates a real object in the user's account."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Playlist title."},
            "description": {"type": "string", "description": "Optional description."},
            "privacy": {
                "type": "string",
                "enum": ["PRIVATE", "UNLISTED", "PUBLIC"],
                "description": "Defaults to PRIVATE.",
            },
            "video_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Optional initial tracks, added in this exact order. "
                    f"Cap {ITEMS_CAP}."
                ),
            },
        },
        "required": ["title"],
    },
)
async def create_dj_playlist(args: dict, ctx: Ctx) -> dict:
    title = args.get("title")
    if not title or not isinstance(title, str):
        raise OperationalError(
            "bad_argument: `title` is required and must be a string. "
            "Re-call with a corrected value."
        )
    privacy = args.get("privacy") or "PRIVATE"
    video_ids = args.get("video_ids") or []
    if not isinstance(video_ids, list) or not all(isinstance(v, str) for v in video_ids):
        raise OperationalError(
            "bad_argument: `video_ids` must be a list of strings. "
            "Re-call with a corrected value."
        )
    if len(video_ids) > ITEMS_CAP:
        # Reject rather than truncate: a silently short playlist looks correct.
        raise OperationalError(
            f"bad_argument: {len(video_ids)} video_ids exceeds the cap of "
            f"{ITEMS_CAP}. Nothing was created. Create the playlist with the "
            f"first {ITEMS_CAP} and add the rest with edit_dj_playlist."
        )

    result = await _call(
        ctx.config.host_id,
        "create_playlist",
        title=title,
        description=args.get("description") or "",
        privacy_status=privacy,
        video_ids=video_ids or None,
    )

    # create_playlist returns the new id as a bare string on success, or a
    # dict when YouTube reports a problem. Do not assume the happy shape.
    if isinstance(result, str):
        playlist_id = result
    else:
        raise OperationalError(
            f"upstream_error: YouTube Music did not return a playlist id on "
            f"host {ctx.config.host_id!r}. Response: {result!r}"
        )

    return {
        "data": {
            "playlist_id": playlist_id,
            "title": title,
            "privacy": privacy,
            "tracks_added": len(video_ids),
            "next_step": (
                "Re-read with get_dj_playlists mode=contents to confirm order "
                "and to capture each entry's set_video_id, which any later move "
                "or remove requires."
            ),
        },
        "meta": {},
    }


# ---------------------------------------------------------------------------
# edit_dj_playlist — tier 2
# ---------------------------------------------------------------------------


@define_tool(
    name="edit_dj_playlist",
    tier=2,
    description=(
        "Modify an existing playlist without removing anything. Two modes. "
        "`add` appends `video_ids` in the order given (set `allow_duplicates` "
        "true when the same track must legitimately appear twice — cram and "
        "body zones rely on that). `move` repositions one entry: it needs the "
        "entry's `set_video_id` and the `move_after_set_video_id` it should sit "
        "after, or null to move it to the top. "
        "⚠️ `set_video_id` is a per-playlist handle, re-read it from "
        "get_dj_playlists mode=contents immediately before each move. It is NOT "
        "unique to a song and NOT unique across playlists: the SAME handle is "
        "reused in other playlists for DIFFERENT songs. A stale handle fails "
        "loudly; a handle from another playlist can match a real but WRONG entry "
        "and succeed. `move` therefore requires `video_id` too and verifies the "
        "pair against this playlist first. Tier 2."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "playlist_id": {"type": "string", "description": "Target playlist."},
            "mode": {
                "type": "string",
                "enum": ["add", "move", "rename"],
                "description": (
                    "`add` appends tracks; `move` repositions one entry; "
                    "`rename` changes title/description only."
                ),
            },
            "video_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": f"mode=add: tracks to append, in order. Cap {ITEMS_CAP}.",
            },
            "allow_duplicates": {
                "type": "boolean",
                "description": (
                    "mode=add: permit a track already in the playlist to be added "
                    "again. Defaults false. Required for cram/body duplication."
                ),
            },
            "set_video_id": {
                "type": "string",
                "description": "mode=move: the entry to move, from a fresh contents read.",
            },
            "video_id": {
                "type": "string",
                "description": (
                    "mode=move: REQUIRED alongside set_video_id. The pair is "
                    "verified against this playlist before the move, because a "
                    "set_video_id from another playlist can match a different "
                    "song here and succeed."
                ),
            },
            "title": {
                "type": "string",
                "description": "mode=rename: the new playlist title.",
            },
            "new_description": {
                "type": "string",
                "description": "mode=rename: the new description. Optional.",
            },
            "move_after_set_video_id": {
                "type": "string",
                "description": (
                    "mode=move: place the entry immediately after this one. "
                    "Omit to move it to the top of the playlist."
                ),
            },
        },
        "required": ["playlist_id", "mode"],
    },
)
async def edit_dj_playlist(args: dict, ctx: Ctx) -> dict:
    playlist_id = args.get("playlist_id")
    mode = args.get("mode")
    if not playlist_id or not isinstance(playlist_id, str):
        raise OperationalError(
            "bad_argument: `playlist_id` is required and must be a string. "
            "Re-call with a corrected value."
        )
    if mode not in ("add", "move", "rename"):
        raise OperationalError(
            f"bad_argument: `mode` must be 'add', 'move' or 'rename' (got {mode!r}). "
            f"To remove entries or delete a playlist use "
            f"remove_from_dj_playlist, which is tier 3."
        )

    host_id = ctx.config.host_id

    if mode == "add":
        video_ids = args.get("video_ids") or []
        if not isinstance(video_ids, list) or not video_ids:
            raise OperationalError(
                "bad_argument: mode 'add' requires a non-empty `video_ids` list. "
                "Re-call with a corrected value."
            )
        if len(video_ids) > ITEMS_CAP:
            raise OperationalError(
                f"bad_argument: {len(video_ids)} video_ids exceeds the cap of "
                f"{ITEMS_CAP}. Nothing was added. Split into smaller calls."
            )
        result = await _call(
            host_id,
            "add_playlist_items",
            playlistId=playlist_id,
            videoIds=video_ids,
            duplicates=bool(args.get("allow_duplicates")),
        )
        return {
            "data": {
                "playlist_id": playlist_id,
                "mode": "add",
                "tracks_added": len(video_ids),
                "upstream": _status_of(result),
                "next_step": (
                    "Re-read with get_dj_playlists mode=contents to capture the "
                    "set_video_id of each new entry."
                ),
            },
            "meta": {},
        }

    if mode == "rename":
        # Renaming is how a playlist gets PARKED rather than deleted, staying
        # readable as a lookup table of already-resolved video ids.
        new_title = args.get("title")
        if not new_title or not isinstance(new_title, str):
            raise OperationalError(
                "bad_argument: mode 'rename' requires `title`. "
                "Re-call with a corrected value."
            )
        kwargs: dict = {"playlistId": playlist_id, "title": new_title}
        if args.get("new_description"):
            kwargs["description"] = args["new_description"]
        result = await _call(host_id, "edit_playlist", **kwargs)
        return {
            "data": {
                "playlist_id": playlist_id,
                "mode": "rename",
                "title": new_title,
                "upstream": _status_of(result),
            },
            "meta": {},
        }

    set_video_id = args.get("set_video_id")
    video_id = args.get("video_id")
    if not set_video_id or not isinstance(set_video_id, str):
        raise OperationalError(
            "bad_argument: mode 'move' requires `set_video_id` — the entry's "
            "per-playlist handle. Read it from get_dj_playlists mode=contents "
            "immediately before moving; it is a cache and can be stale."
        )
    if not video_id or not isinstance(video_id, str):
        raise OperationalError(
            "bad_argument: mode 'move' requires `video_id` as well as "
            "`set_video_id`. The handle alone does not identify a song: the same "
            "set_video_id is reused across playlists for DIFFERENT songs, so a "
            "handle carried in from elsewhere can match a real but wrong entry "
            "and succeed. Both ids together, scoped to this playlist, is the "
            "only combination that disambiguates."
        )

    # Verify BEFORE moving — see _verify_entries.
    await _verify_entries(host_id, playlist_id, [(video_id, set_video_id)], "move")

    after = args.get("move_after_set_video_id")
    move_item: Any = (set_video_id, after) if after else set_video_id

    result = await _call(
        host_id, "edit_playlist", playlistId=playlist_id, moveItem=move_item
    )
    return {
        "data": {
            "playlist_id": playlist_id,
            "mode": "move",
            "moved": set_video_id,
            "placed_after": after or "(top of playlist)",
            "upstream": _status_of(result),
            "next_step": (
                "Re-read contents to confirm the new order — a move that YouTube "
                "silently declines still returns a success status."
            ),
        },
        "meta": {},
    }




async def _verify_entries(
    host_id: str, playlist_id: str, pairs: list[tuple], label: str
) -> list[dict]:
    """Confirm each (video_id, set_video_id) pair is really IN this playlist.

    ⚠️ set_video_id IS NOT UNIQUE TO A SONG, AND NOT UNIQUE ACROSS PLAYLISTS.
    Measured 2026-08-28: of twelve handles on a freshly created playlist, ELEVEN
    already existed in a different playlist, and three of those denoted a
    DIFFERENT song there. Within one playlist the values are unique (0 duplicates
    across 160 entries), so a pair scoped to its playlist disambiguates — and
    nothing else does.

    Why this is a verifier rather than a comment: a STALE handle fails loudly,
    but a handle carried over from another playlist can match a real, different
    entry and succeed. That is an operation on the wrong song reported as
    success — the failure mode that survives longest. Re-reading the target
    playlist and matching the pair converts it into a clean error.
    """
    detail = await _call(
        host_id, "get_playlist", playlistId=playlist_id, limit=ITEMS_CAP
    ) or {}
    tracks = detail.get("tracks") or []
    if not tracks and not detail.get("title"):
        raise OperationalError(
            f"not_found: no playlist resolved for id {playlist_id!r} on host "
            f"{host_id!r}. Nothing was changed."
        )
    live = {
        (t.get("videoId"), t.get("setVideoId"))
        for t in tracks
        if isinstance(t, dict)
    }
    bad = [p for p in pairs if p not in live]
    if bad:
        examples = ", ".join(f"{{{v}, {sv}}}" for v, sv in bad[:3])
        raise OperationalError(
            f"stale_or_foreign_handle: {len(bad)} of {len(pairs)} "
            f"(video_id, set_video_id) pair(s) are not in playlist "
            f"{playlist_id!r} — e.g. {examples}. NOTHING WAS CHANGED. "
            f"set_video_id is scoped to one playlist and is reused across "
            f"playlists for different songs, so a handle from elsewhere can "
            f"match a real but WRONG entry. Re-read the playlist with "
            f"get_dj_playlists mode=contents and use the handles it returns."
        )
    return tracks


# ---------------------------------------------------------------------------
# Preview for the tier-3 gate
# ---------------------------------------------------------------------------


async def _preview_removal(args: dict, ctx: Ctx) -> dict:
    """Resolve what a removal WOULD act on, for the confirmation proposal.

    The gate stops accidental execution; this is what stops accidental WRONG
    TARGET. One mistyped character in a playlist id otherwise produces a
    proposal that reads exactly as reassuring as the correct one — and a human
    being able to read it is the entire point of the speed bump.

    Read-only. Raising is fine: the platform reports a failed preview inside the
    proposal, which is the right outcome — an unresolvable id is usually a wrong
    id, and "I could not find that playlist" is exactly what the reader needs.
    """
    playlist_id = args.get("playlist_id")
    mode = args.get("mode")
    detail = await _call(
        ctx.config.host_id, "get_playlist", playlistId=playlist_id, limit=ITEMS_CAP
    ) or {}
    tracks = detail.get("tracks") or []
    title = detail.get("title")
    if not title and not tracks:
        raise OperationalError(
            f"not_found: no playlist resolved for id {playlist_id!r} on host "
            f"{ctx.config.host_id!r}. Nothing was changed. Check the id — an "
            f"unresolvable id is usually a typo rather than a missing playlist."
        )

    count = detail.get("trackCount")
    found = {
        "resolved": True,
        "playlist_id": detail.get("id") or playlist_id,
        "title": title,
        "track_count": count,
        "owned": detail.get("owned"),
        "privacy": detail.get("privacy"),
    }

    if mode == "delete_playlist":
        found["effect"] = (
            f"DELETES the entire playlist {title!r} and all {count} entries. "
            f"Cannot be undone, and every video id resolved in it is lost too."
        )
        return found

    # remove_items: report how many requested entries actually match, so a stale
    # set_video_id surfaces HERE rather than as a silent no-op after confirming.
    entries = args.get("entries") or []
    live = {
        (t.get("videoId"), t.get("setVideoId"))
        for t in tracks
        if isinstance(t, dict)
    }
    requested = [
        (e.get("video_id"), e.get("set_video_id"))
        for e in entries
        if isinstance(e, dict)
    ]
    matched = [r for r in requested if r in live]
    unmatched = [r for r in requested if r not in live]
    found["requested"] = len(requested)
    found["would_remove"] = len(matched)
    found["would_not_match"] = len(unmatched)
    found["unmatched_examples"] = [
        {"video_id": v, "set_video_id": sv} for v, sv in unmatched[:5]
    ]
    found["effect"] = (
        f"Removes {len(matched)} of {len(requested)} requested entries from {title!r}."
    )
    if unmatched:
        found["warning"] = (
            f"{len(unmatched)} requested entr(ies) match nothing currently in this "
            f"playlist. set_video_id is a per-playlist cache that goes stale — "
            f"re-read contents with get_dj_playlists before confirming, or those "
            f"removals will silently do nothing."
        )
    return found


# ---------------------------------------------------------------------------
# remove_from_dj_playlist — tier 3
# ---------------------------------------------------------------------------


@define_tool(
    name="remove_from_dj_playlist",
    tier=3,
    preview=_preview_removal,
    description=(
        "DESTRUCTIVE. Two modes. `remove_items` deletes specific entries from a "
        "playlist — this is how a cram block is cleared. `delete_playlist` "
        "deletes the whole playlist from YouTube Music, which cannot be undone "
        "and takes every resolved video id in it with it. "
        "Tier 3: the first call returns a proposal describing what WOULD happen "
        "and writes nothing; re-call with `confirmed: true` to execute. "
        "Prefer renaming a playlist you might still want to mine for video ids "
        "over deleting it."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "playlist_id": {"type": "string", "description": "Target playlist."},
            "mode": {
                "type": "string",
                "enum": ["remove_items", "delete_playlist"],
                "description": "`remove_items` deletes entries; `delete_playlist` deletes everything.",
            },
            "entries": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "video_id": {"type": "string"},
                        "set_video_id": {"type": "string"},
                    },
                    "required": ["video_id", "set_video_id"],
                },
                "description": (
                    "mode=remove_items: the entries to delete. BOTH ids are "
                    "required per entry — YouTube identifies a playlist entry by "
                    "the pair, which is what lets one of two duplicate rows be "
                    "removed while the other survives. Read them from a fresh "
                    "get_dj_playlists mode=contents."
                ),
            },
            "confirmed": {
                "type": "boolean",
                "description": "Tier-3 gate. Omit to see a proposal; set true to execute.",
            },
        },
        "required": ["playlist_id", "mode"],
    },
)
async def remove_from_dj_playlist(args: dict, ctx: Ctx) -> dict:
    playlist_id = args.get("playlist_id")
    mode = args.get("mode")
    if not playlist_id or not isinstance(playlist_id, str):
        raise OperationalError(
            "bad_argument: `playlist_id` is required and must be a string. "
            "Re-call with a corrected value."
        )
    if mode not in ("remove_items", "delete_playlist"):
        raise OperationalError(
            f"bad_argument: `mode` must be 'remove_items' or 'delete_playlist' "
            f"(got {mode!r}). Re-call with a corrected value."
        )

    host_id = ctx.config.host_id

    if mode == "delete_playlist":
        result = await _call(host_id, "delete_playlist", playlistId=playlist_id)
        return {
            "data": {
                "playlist_id": playlist_id,
                "mode": "delete_playlist",
                "deleted": True,
                "upstream": _status_of(result),
            },
            "meta": {},
        }

    entries = args.get("entries") or []
    if not isinstance(entries, list) or not entries:
        raise OperationalError(
            "bad_argument: mode 'remove_items' requires a non-empty `entries` "
            "list. Re-call with a corrected value."
        )
    if len(entries) > ITEMS_CAP:
        raise OperationalError(
            f"bad_argument: {len(entries)} entries exceeds the cap of {ITEMS_CAP}. "
            f"Nothing was removed. Split into smaller calls."
        )
    videos = []
    for i, e in enumerate(entries):
        if not isinstance(e, dict) or not e.get("video_id") or not e.get("set_video_id"):
            raise OperationalError(
                f"bad_argument: entries[{i}] needs both `video_id` and "
                f"`set_video_id`. YouTube identifies a playlist entry by the "
                f"pair — that is what allows one of two duplicate rows to be "
                f"removed while the other survives. Nothing was removed."
            )
        videos.append({"videoId": e["video_id"], "setVideoId": e["set_video_id"]})

    # Verify BEFORE removing. The tier-3 preview already reports unmatched
    # entries, but the preview and the confirmed call are separate invocations
    # and the playlist can change between them — and a foreign handle that
    # matches here removes a real, wrong song.
    await _verify_entries(
        host_id,
        playlist_id,
        [(v["videoId"], v["setVideoId"]) for v in videos],
        "remove_items",
    )

    result = await _call(
        host_id, "remove_playlist_items", playlistId=playlist_id, videos=videos
    )
    return {
        "data": {
            "playlist_id": playlist_id,
            "mode": "remove_items",
            "removed": len(videos),
            "upstream": _status_of(result),
            "next_step": (
                "Re-read contents to confirm — a stale set_video_id makes a "
                "removal a no-op that still reports success."
            ),
        },
        "meta": {},
    }


def _status_of(result: Any) -> str:
    """ytmusicapi mutations return 'STATUS_SUCCEEDED' as a bare string, or a
    dict on anything else. Normalise to something a caller can read without
    having to know which."""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        return str(result.get("status") or result)
    return str(result)
