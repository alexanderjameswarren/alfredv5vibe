"""DJ read tools — YouTube Music, read-only, on-demand (spec §7 phase 1).

Two tools, both tier 1: ``get_dj_history`` and ``get_dj_playlists``. Neither
writes anything, anywhere. Workshop holds no Supabase credential by design —
Claude is the courier that carries what these tools return into the durable
record (spec §2).

Three structural decisions live in this module and are load-bearing:

1. ``ytmusicapi`` is imported LAZILY, inside the call path. ``tools/__init__``
   imports this module eagerly so the decorators fire, so a module-level
   ``import ytmusicapi`` would take the entire server down on a host where the
   pip install has not landed — and on the Surface, Workshop autostarts under
   ``pythonw.exe`` with no console, so that failure is completely silent
   (spec §7 phase 4). Lazy keeps it a clean per-call error on one tool.

2. The credential is RE-READ on every call, never cached. ``YTMusic()``
   construction does no network I/O, so this is cheap — and it means re-running
   ``scripts/dj_auth.py`` takes effect without restarting Workshop, which is
   the whole recovery path in phases 4 and 6.

3. Blocking ``ytmusicapi`` calls go through ``anyio.to_thread``. The library is
   synchronous httpx; called inline it would stall the event loop for the whole
   upstream round trip.
"""
from __future__ import annotations

import functools
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from anyio import to_thread

from ..platform import Ctx, OperationalError, clamp_limit, define_tool


# ---------------------------------------------------------------------------
# Credential
# ---------------------------------------------------------------------------

# workshop/workshop/tools/dj.py -> parents[2] == workshop/, mirroring run.py's
# DATA_DIR. Deliberately NOT a Config key: adding one would mean editing .env
# on both hosts before phase 4, and phase 4 has enough hazards already.
_WORKSHOP_ROOT = Path(__file__).resolve().parents[2]
DJ_DATA_DIR = _WORKSHOP_ROOT / "data" / "dj"
CREDENTIAL_PATH = DJ_DATA_DIR / "browser.json"


def credential_state() -> tuple[bool, str]:
    """Presence-and-readability check on the browser credential.

    This is NOT proof YouTube still accepts it — only a network call proves
    that, and ``get_workshop_status`` must stay fast and offline-safe. What it
    does catch is the phase-4 failure mode: the file never made it to the
    Surface, or it landed owned by ``rdpuser`` while Workshop runs as ``alexa``.

    Never returns any part of the file's contents — it holds a full Google
    session cookie, not merely a YouTube credential (spec §9).
    """
    if not CREDENTIAL_PATH.exists():
        return False, f"no credential file at {CREDENTIAL_PATH}"
    try:
        raw = CREDENTIAL_PATH.read_text(encoding="utf-8")
    except OSError as e:
        return False, (
            f"credential file exists at {CREDENTIAL_PATH} but this process "
            f"cannot read it (check file ownership): {e.__class__.__name__}"
        )
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return False, "credential file is not valid JSON — re-run scripts/dj_auth.py"
    if not isinstance(parsed, dict):
        return False, "credential file is valid JSON but not a header object"
    if not any(k.lower() == "cookie" for k in parsed):
        return False, "credential file carries no Cookie header — re-run scripts/dj_auth.py"
    return True, "credential file present, readable, and carries a Cookie header"


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

# OperationalError refuses these substrings at construction — that phrasing is
# reserved for GuardrailError. Upstream text gets interpolated into our
# messages, so scrub it rather than let a freak match turn a clean operational
# error into an opaque "Internal error".
_RESERVED_PHRASES = ("do not retry", "don't retry", "no retry", "not retry")

_AUTH_SIGNALS = (
    "401",
    "403",
    "unauthorized",
    "unauthenticated",
    "not authenticated",
    "please sign in",
    "sign in to continue",
    "login required",
    "authentication",
    "invalid credentials",
    "expired",
)


def _scrub(text: str) -> str:
    out = text
    for phrase in _RESERVED_PHRASES:
        out = re.sub(re.escape(phrase), "[phrase removed]", out, flags=re.IGNORECASE)
    return out


def _upstream_error(exc: Exception, host_id: str) -> OperationalError:
    """Classify a ytmusicapi failure into auth-expired vs. plain upstream.

    Spec §8 classes expired YouTube auth as OPERATIONAL, not a guardrail
    denial, so it carries no do-not-retry wording. The leading token is the
    stable discriminator Claude routes on when writing the phase-6 inbox item.

    Which exception ytmusicapi actually raises for a stale cookie is NOT
    verified — confirming it means invalidating a live credential, which is
    phase 6's job. So classify defensively on status code and message text, and
    let phase 6 tighten this against a real expiry.
    """
    detail = _scrub(f"{type(exc).__name__}: {exc}")
    status = getattr(getattr(exc, "response", None), "status_code", None)
    lowered = detail.lower()

    if status in (401, 403) or any(sig in lowered for sig in _AUTH_SIGNALS):
        return OperationalError(
            f"auth_expired: YouTube Music rejected the stored credential on host "
            f"{host_id!r}. Recovery is the reauth path — recopy Firefox request "
            f"headers into data\\dj\\headers.txt, then run scripts\\dj_auth.py. "
            f"DJ reads will keep failing until that happens. Upstream said: {detail}"
        )
    return OperationalError(
        f"upstream_error: YouTube Music read failed on host {host_id!r}. "
        f"This may be transient. Upstream said: {detail}"
    )


def _client(host_id: str):
    """Build a YTMusic client, or raise a classified operational error."""
    try:
        from ytmusicapi import YTMusic  # lazy — see module docstring, point 1
    except ImportError as e:
        raise OperationalError(
            f"dependency_missing: ytmusicapi is not installed on host {host_id!r}. "
            f"Install it into this host's venv (pip install -r requirements.txt). "
            f"Import said: {_scrub(str(e))}"
        ) from e

    ok, detail = credential_state()
    if not ok:
        raise OperationalError(
            f"auth_missing: no usable YouTube credential on host {host_id!r} — "
            f"{detail}. Capture headers into data\\dj\\headers.txt and run "
            f"scripts\\dj_auth.py on this host. The credential is per-host and is "
            f"never committed."
        )

    try:
        return YTMusic(str(CREDENTIAL_PATH))
    except Exception as e:
        raise _upstream_error(e, host_id) from e


async def _call(host_id: str, method: str, **kwargs) -> Any:
    """Run one blocking ytmusicapi method off the event loop, classified."""
    yt = _client(host_id)
    fn = functools.partial(getattr(yt, method), **kwargs)
    try:
        return await to_thread.run_sync(fn)
    except OperationalError:
        raise
    except Exception as e:
        raise _upstream_error(e, host_id) from e


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------

# YouTube's history feed returns day buckets, not timestamps (spec §4.2).
# These four are every value the probe has seen; anything else passes through
# verbatim rather than being silently dropped.
KNOWN_BUCKETS = ("Today", "Yesterday", "This week", "Last week")

# get_history() takes no limit — it returns one fixed page. The probe has
# returned exactly 200 every time. At or above this, assume older plays exist
# beyond the page edge.
PAGE_FULL_AT = 200


def _artists(item: dict) -> list[dict]:
    return [
        {"name": a.get("name"), "id": a.get("id")}
        for a in (item.get("artists") or [])
        if isinstance(a, dict)
    ]


def _album(item: dict) -> dict | None:
    album = item.get("album")
    if not isinstance(album, dict):
        return None
    return {"name": album.get("name"), "id": album.get("id")}


def _project_play(
    item: dict, position: int, occurrence: int, bucket_play_count: int
) -> dict:
    # Dropped deliberately: thumbnails (~4 URLs each — pure context tax on a
    # courier whose entire cost model is context), feedbackToken /
    # feedbackTokens / listenAgainFeedbackTokens (write handles; this tool is
    # read-only), views, communityVoteStatus, creditsBrowseId,
    # pinnedToListenAgain, and `duration` (the string form — duration_seconds
    # supersedes it).
    return {
        "video_id": item.get("videoId"),
        "title": item.get("title"),
        "artists": _artists(item),
        "album": _album(item),
        "duration_seconds": item.get("duration_seconds"),
        "played_bucket": item.get("played"),
        "video_type": item.get("videoType"),
        "like_status": item.get("likeStatus"),
        "position": position,
        "occurrence": occurrence,
        "bucket_play_count": bucket_play_count,
    }


def _as_int(value: Any) -> int | None:
    """Coerce a ytmusicapi count to a real int, or None.

    ``get_library_playlists`` reports ``count`` as a STRING ('160') while
    ``get_playlist`` reports ``trackCount`` as an int (160). Same quantity, two
    types, and a text sort puts '95' above '160' — so normalise at the boundary
    rather than leaving it for every downstream consumer to rediscover.
    Separators are stripped because a large library could render '1,234'.
    """
    if isinstance(value, bool):  # bool is an int subclass; never a count
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        digits = re.sub(r"[^\d-]", "", value)
        if digits and digits.lstrip("-").isdigit():
            return int(digits)
    return None


def _project_playlist_summary(p: dict) -> dict:
    # `count` and `author` are absent on auto-generated playlists ("Liked
    # Music") and present on the other 42 — .get() rather than a branch.
    return {
        "playlist_id": p.get("playlistId"),
        "title": p.get("title"),
        "count": _as_int(p.get("count")),
        "owned": p.get("owned"),
        "description": p.get("description"),
    }


def _project_playlist_track(t: dict, position: int) -> dict:
    return {
        "video_id": t.get("videoId"),
        "set_video_id": t.get("setVideoId"),
        "title": t.get("title"),
        "artists": _artists(t),
        "album": _album(t),
        "duration_seconds": t.get("duration_seconds"),
        "like_status": t.get("likeStatus"),
        "is_available": t.get("isAvailable"),
        "video_type": t.get("videoType"),
        "position": position,
    }


def _truncation_hint(returned: int, total: int, cap: int) -> str | None:
    """The remedy, stated in the payload, when a result was cut by `limit`.

    The platform's own truncation note says "Narrow the query or request a
    specific subset" — correct for a database read, backwards for these tools.
    Nothing was narrowed: the caller asked for a playlist's contents and got
    part of it, and the fix is a HIGHER limit, not a tighter one. The platform
    note is shared by every tool and is not this module's to reword, so the
    accurate advice rides in the data instead.
    """
    if returned >= total:
        return None
    if total <= cap:
        return (
            f"Cut by `limit`, not by an upstream page boundary — all {total} are "
            f"reachable. Re-call with limit: {total} (cap {cap}) to get them in "
            f"one call."
        )
    return (
        f"{total} exist but this tool's cap is {cap}. Re-call with limit: {cap} "
        f"for the largest single page; the remainder is not reachable here."
    )


def _occurrence_index(raw: list[dict]) -> tuple[dict[int, int], dict[int, int]]:
    """Number each play within its ``(video_id, played_bucket)`` group, counting
    from the OLDEST end, over the FULL page before any filtering.

    Numbering positionally over a newest-first feed would be unstable: a song
    played once "This week" is occurrence 1 today, and playing it again
    tomorrow pushes the original to occurrence 2. Since occurrence sits in the
    dedupe key ``(user_id, track_id, played_bucket, occurrence, source)``, that
    would re-insert an already-recorded play under a fresh number — silent
    duplicates, accumulating daily, concentrated in the busiest bucket.

    Counting from the oldest end is stable as new plays arrive: a new play of
    the same song in the same bucket takes the next number up and leaves every
    existing number untouched.

    ``bucket_play_count`` rides along so the write side can work by count
    rather than by identity: this song has N plays in this bucket, we hold M
    rows, insert N-M. That is stable regardless of feed order or page churn.

    Computed before filtering and before the limit, so neither renumbers.

    Caveat the caller must respect: when ``page_full`` is true the oldest
    bucket in the page is partial, so counts for THAT bucket are floors rather
    than totals. Trust counts only for buckets wholly inside the page.
    """
    groups: dict[tuple, list[int]] = defaultdict(list)
    for i, item in enumerate(raw):  # raw is newest-first
        groups[(item.get("videoId"), item.get("played"))].append(i)

    occurrence: dict[int, int] = {}
    play_count: dict[int, int] = {}
    for indices in groups.values():
        n = len(indices)
        for rank_from_newest, i in enumerate(indices):
            occurrence[i] = n - rank_from_newest  # oldest -> 1
            play_count[i] = n
    return occurrence, play_count


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@define_tool(
    name="get_dj_history",
    tier=1,
    description=(
        "Read recent YouTube Music listening history for the DJ app. Read-only. "
        "Returns one object: `plays` plus page metadata. YouTube reports day "
        "BUCKETS, not timestamps ('Today' / 'Yesterday' / 'This week' / 'Last "
        "week'), so only the first two convert to a real date; aggregate the "
        "other two and never plot them as dates. Each play carries `occurrence` "
        "(its Nth play of that video within that bucket, counted from the oldest "
        "end) and `bucket_play_count` (total plays of that video in that bucket) "
        "— write by count, not by identity: insert bucket_play_count minus the "
        "rows already held. `page_full: true` means the upstream page came back "
        "at its limit and OLDER PLAYS EXIST BEYOND IT, so the oldest bucket is "
        "partial and must not be recorded as the covered floor. `page_full` is "
        "independent of truncation: filtering to one bucket cuts nothing and "
        "reports no truncation."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "buckets": {
                "type": "array",
                "items": {"type": "string", "enum": list(KNOWN_BUCKETS)},
                "description": (
                    "Optional filter on YouTube's day-bucket label. Omit for all "
                    "buckets. Filtering never changes occurrence numbering."
                ),
            },
            "limit": {
                "type": "integer",
                "description": (
                    "Max plays to return after filtering (default 50, cap 200). "
                    "The cap is one full upstream page — get_history() takes no "
                    "limit of its own."
                ),
            },
        },
    },
)
async def get_dj_history(args: dict, ctx: Ctx) -> dict:
    buckets = args.get("buckets")
    if buckets is not None:
        if not isinstance(buckets, list) or not all(isinstance(b, str) for b in buckets):
            raise OperationalError(
                "bad_argument: `buckets` must be a list of strings drawn from "
                f"{list(KNOWN_BUCKETS)}. Re-call with a corrected value."
            )
        unknown = [b for b in buckets if b not in KNOWN_BUCKETS]
        if unknown:
            raise OperationalError(
                f"bad_argument: unknown bucket(s) {unknown}. Valid buckets are "
                f"{list(KNOWN_BUCKETS)}. Re-call with a corrected value."
            )

    limit = clamp_limit(args.get("limit"), default=50, cap=200)
    raw = await _call(ctx.config.host_id, "get_history") or []

    occurrence, play_count = _occurrence_index(raw)

    wanted = set(buckets) if buckets else None
    selected = [
        i for i in range(len(raw)) if wanted is None or raw[i].get("played") in wanted
    ]
    matched = len(selected)
    shown = selected[:limit]

    plays = [
        _project_play(
            raw[i],
            position=i,
            occurrence=occurrence[i],
            bucket_play_count=play_count[i],
        )
        for i in shown
    ]

    bucket_tally = Counter(item.get("played") for item in raw)
    # Report in feed order (newest bucket first), with unfamiliar labels
    # appended rather than dropped — a new YouTube label should be visible.
    ordered = [b for b in KNOWN_BUCKETS if b in bucket_tally]
    ordered += [b for b in bucket_tally if b not in KNOWN_BUCKETS]

    page_full = len(raw) >= PAGE_FULL_AT
    data = {
        "plays": plays,
        "page_size": len(raw),
        "page_full": page_full,
        "buckets_in_page": {b: bucket_tally[b] for b in ordered},
        "oldest_bucket_in_page": raw[-1].get("played") if raw else None,
        "oldest_bucket_is_partial": page_full,
        "returned": len(plays),
        "matched": matched,
        "limit_applied": limit,
        "truncation_hint": _truncation_hint(len(plays), matched, cap=200),
    }

    meta: dict[str, Any] = {}
    if len(plays) < matched:
        meta["truncated"] = (len(plays), matched)
    return {"data": data, "meta": meta}


@define_tool(
    name="get_dj_playlists",
    tier=1,
    description=(
        "Read YouTube Music playlists for the DJ app. Read-only. Two modes. "
        "`library` lists every playlist in the library (playlist_id, title, "
        "`count` as an integer, owned). `contents` reads one playlist's tracks "
        "and is the ONLY source of `set_video_id`, the per-entry handle YouTube "
        "requires before any future move or remove — treat it as a cache to "
        "re-read before each edit, never as durable. `contents` requires "
        "`playlist_id`. A `video_id` is NOT unique within a playlist: the same "
        "track legitimately appears more than once, each copy with its own "
        "distinct `set_video_id`. Key playlist entries on `set_video_id` or "
        "`position`, never on `video_id`. When a result is cut, read "
        "`truncation_hint` — the remedy is usually a HIGHER `limit`."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["library", "contents"],
                "description": (
                    "`library` for all playlists; `contents` for one playlist's "
                    "tracks."
                ),
            },
            "playlist_id": {
                "type": "string",
                "description": (
                    "Required when mode is `contents`. Obtained from `library` mode."
                ),
            },
            "limit": {
                "type": "integer",
                "description": (
                    "library: max playlists (default 50, cap 50). "
                    "contents: max tracks (default 200, cap 200 — the default "
                    "returns the whole playlist, which is almost always what "
                    "you want)."
                ),
            },
        },
        "required": ["mode"],
    },
)
async def get_dj_playlists(args: dict, ctx: Ctx) -> dict:
    mode = args.get("mode")
    if mode not in ("library", "contents"):
        raise OperationalError(
            f"bad_argument: `mode` must be 'library' or 'contents' (got {mode!r}). "
            f"Re-call with a corrected value."
        )

    host_id = ctx.config.host_id

    if mode == "library":
        limit = clamp_limit(args.get("limit"), default=50, cap=50)
        # limit=None fetches every playlist, so `total` below is the real total
        # rather than a guess derived from the page we asked for. The library is
        # ~43 rows — one or two continuation requests, not a scan.
        rows = await _call(host_id, "get_library_playlists", limit=None) or []
        total = len(rows)
        kept = [_project_playlist_summary(p) for p in rows[:limit]]

        data = {
            "mode": "library",
            "playlists": kept,
            "returned": len(kept),
            "total": total,
            "limit_applied": limit,
            "truncation_hint": _truncation_hint(len(kept), total, cap=50),
        }
        meta: dict[str, Any] = {}
        if len(kept) < total:
            meta["truncated"] = (len(kept), total)
        return {"data": data, "meta": meta}

    playlist_id = args.get("playlist_id")
    if not playlist_id or not isinstance(playlist_id, str):
        raise OperationalError(
            "bad_argument: mode 'contents' requires `playlist_id` (a string). "
            "Call this tool with mode 'library' first to find one, then re-call."
        )

    # Default is the cap, not a smaller convenience value. Every realistic use
    # of contents mode wants the WHOLE playlist — diffing a setlist, reading
    # back after a write — and the largest playlist in the library is 161, so
    # the full payload is rarely paid in practice. A silently partial setlist
    # is a worse failure than a large response.
    limit = clamp_limit(args.get("limit"), default=200, cap=200)
    detail = await _call(host_id, "get_playlist", playlistId=playlist_id, limit=limit) or {}
    raw_tracks = detail.get("tracks") or []
    # ytmusicapi's `limit` is a fetch hint, not a hard cap — asking for 100 of a
    # 160-track playlist returns all 160, because the first response already
    # held them. Verified against "Weezer Concert". So the cap is enforced here
    # or it is not enforced at all.
    tracks = [
        _project_playlist_track(t, position=i)
        for i, t in enumerate(raw_tracks[:limit])
    ]

    # YouTube reports trackCount for the whole playlist, so truncation is
    # measured against the real total rather than against what we asked for.
    # Fall back to what upstream actually handed us, NOT to len(tracks) — that
    # has already been sliced to `limit`, so it would report a truncated read
    # as complete.
    total = _as_int(detail.get("trackCount"))
    if total is None:
        total = len(raw_tracks)

    data = {
        "mode": "contents",
        "playlist_id": detail.get("id") or playlist_id,
        "title": detail.get("title"),
        "privacy": detail.get("privacy"),
        "owned": detail.get("owned"),
        "track_count": total,
        "tracks": tracks,
        "returned": len(tracks),
        "limit_applied": limit,
        "truncation_hint": _truncation_hint(len(tracks), total, cap=200),
    }
    meta: dict[str, Any] = {}
    if len(tracks) < total:
        meta["truncated"] = (len(tracks), total)
    return {"data": data, "meta": meta}
