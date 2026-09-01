"""setlist.fm reader — the Phase 7 body-of-work source (spec §7 phase 7).

One tool, tier 1, read-only: ``get_dj_setlists``. It reads what an artist has
actually been playing so the recorded body of a concert playlist can be diffed
against it. Nothing here writes anywhere, and nothing here touches YouTube.

FOUR THINGS THIS MODULE EXISTS TO GET RIGHT
-------------------------------------------

1. KEYED ON MBID, NEVER ON NAME. setlist.fm's name search matches the wrong
   band — there is more than one "Nirvana", more than one "Live". The MusicBrainz
   id is the identity, and ``dj_artists.mbid`` is where it lives. This tool
   REFUSES a name and takes only an mbid, so the failure mode is "you have not
   set the mbid yet" rather than "you have a setlist for a different band".

2. UPCOMING SHOWS COME BACK IN THE SAME FEED, WITH NO SONGS. setlist.fm lists
   scheduled concerts alongside played ones. As of 2026-09-01 the Weezer feed
   held sixteen future dates before a single played show. A window of "the last
   10 shows" taken naively would be mostly empty setlists — each consuming a
   slot and contributing nothing, so the diff would quietly compare against far
   less than it claimed. **Setlists with no songs are skipped and COUNTED**, and
   the count is returned, because "we looked at 10 shows" and "we looked at 10
   entries, 6 of which were empty" are different claims.

3. PAGINATION IS DRIVEN BY THE FILTERED COUNT, NOT THE RAW ONE. Because empties
   are skipped, one page of 20 entries can yield fewer than 10 usable shows. The
   loop keeps fetching until it has ``limit`` shows WITH songs or runs out of
   pages, with a hard cap so a pathological feed cannot spin.

4. COVERS CARRY THEIR ORIGINAL ARTIST, AND THAT IS INFORMATIONAL ONLY. The
   resolution rule (spec §7 phase 7) is to find the PERFORMING artist's version:
   Weezer's "Happy Together", not The Turtles'. The ``cover_of`` field is
   returned so a human can see what a song is, never so a caller can decide the
   cover "does not count".

THE API KEY
-----------
setlist.fm requires an ``x-api-key`` header. The key lives in
``workshop/data/dj/setlistfm.json`` as ``{"api_key": "..."}`` — the same shape
and the same rules as ``browser.json``:

  ⚠️ IT IS NEVER COMMITTED, NEVER PASTED INTO A CHAT, AND NEVER LOGGED. ``data/``
  is gitignored. Get one free from https://api.setlist.fm/docs/1.0/index.html
  and write it straight to that file.

Re-read on every call, never cached, for the same reason as the YouTube
credential: replacing the file takes effect without restarting Workshop.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from anyio import to_thread

from ..platform import Ctx, GuardrailError, OperationalError, clamp_limit, define_tool

_WORKSHOP_ROOT = Path(__file__).resolve().parents[2]
DJ_DATA_DIR = _WORKSHOP_ROOT / "data" / "dj"
API_KEY_PATH = DJ_DATA_DIR / "setlistfm.json"

API_ROOT = "https://api.setlist.fm/rest/1.0"

# setlist.fm serves 20 per page. Cap the pages so a feed that is entirely
# upcoming dates cannot loop forever hunting for songs that are not there.
PAGE_SIZE = 20
MAX_PAGES = 6

# MusicBrainz ids are 8-4-4-4-12 hex. Checked before the request so a truncated
# id fails here with a readable message rather than as a 404 from upstream.
_MBID_LEN = 36


def _read_api_key() -> str:
    """Read the key, or explain precisely which of the three failures happened."""
    try:
        raw = API_KEY_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise OperationalError(
            f"setlist.fm API key not found at {API_KEY_PATH}. Create it as "
            f'{{"api_key": "..."}} with a key from '
            f"https://api.setlist.fm/docs/1.0/index.html . It must never be "
            f"committed or pasted into a chat — data/ is gitignored for this reason."
        ) from None
    except PermissionError:
        raise OperationalError(
            f"The setlist.fm key at {API_KEY_PATH} EXISTS but cannot be read by "
            f"this process. That is a file ownership or ACL problem, not a missing "
            f"file — the same distinction that bit browser.json on the Surface."
        ) from None

    try:
        key = json.loads(raw).get("api_key")
    except json.JSONDecodeError as exc:
        raise OperationalError(
            f"The setlist.fm key file at {API_KEY_PATH} is not valid JSON: {exc}. "
            f'Expected {{"api_key": "..."}}.'
        ) from None
    if not key or not str(key).strip():
        raise OperationalError(
            f"The setlist.fm key file at {API_KEY_PATH} has no `api_key` value."
        )
    return str(key).strip()


def _fetch_page(mbid: str, page: int, api_key: str) -> dict[str, Any]:
    """One page of setlists. Synchronous; callers run it off the event loop."""
    import httpx  # lazy, for the same reason ytmusicapi is lazy in dj.py

    url = f"{API_ROOT}/artist/{mbid}/setlists"
    try:
        resp = httpx.get(
            url,
            params={"p": page},
            headers={"x-api-key": api_key, "Accept": "application/json"},
            timeout=20.0,
        )
    except httpx.HTTPError as exc:
        raise OperationalError(f"setlist.fm request failed: {exc}") from None

    if resp.status_code == 404:
        # Distinguished deliberately: 404 here means the mbid is wrong or the
        # artist has no setlists at all, and those need different responses.
        raise OperationalError(
            f"setlist.fm has no setlists for mbid {mbid} (HTTP 404). Either the "
            f"mbid is wrong — check it against MusicBrainz — or this artist has "
            f"no setlists recorded."
        )
    if resp.status_code == 403:
        raise OperationalError(
            "setlist.fm rejected the API key (HTTP 403). The key in "
            f"{API_KEY_PATH} is invalid or has been revoked."
        )
    if resp.status_code == 429:
        raise OperationalError(
            "setlist.fm rate limit hit (HTTP 429). Standard keys allow roughly 2 "
            "requests a second and 1440 a day. Wait and retry; do not loop."
        )
    if resp.status_code >= 400:
        raise OperationalError(
            f"setlist.fm returned HTTP {resp.status_code}: {resp.text[:300]}"
        )
    try:
        return resp.json()
    except ValueError:
        raise OperationalError(
            f"setlist.fm returned non-JSON (HTTP {resp.status_code}): {resp.text[:300]}"
        ) from None


def _songs_of(setlist: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the sets -> set -> song nesting into one ordered list."""
    out: list[dict[str, Any]] = []
    for chunk in (setlist.get("sets") or {}).get("set") or []:
        for song in chunk.get("song") or []:
            name = (song.get("name") or "").strip()
            if not name:
                # A tape/intro entry with no name. Not a song anyone can learn.
                continue
            cover = (song.get("cover") or {}).get("name")
            out.append({
                "name": name,
                # Informational ONLY. The resolution rule is to find the
                # PERFORMING artist's version, so this never gates inclusion.
                "cover_of": cover,
                "encore": bool(chunk.get("encore")),
            })
    return out


@define_tool(
    name="get_dj_setlists",
    tier=1,
    description=(
        "Read an artist's recent setlists from setlist.fm, for diffing against a "
        "recorded concert playlist. Read-only; writes nothing anywhere. "
        "⚠️ KEYED ON MBID ONLY — a name search matches the wrong band, so this "
        "tool refuses names entirely and the mbid comes from dj_artists.mbid. "
        "⚠️ UPCOMING SHOWS ARRIVE IN THE SAME FEED WITH NO SONGS and are SKIPPED, "
        "not counted toward the limit: `setlists` contains only shows that "
        "actually happened and have songs, while `empty_entries_skipped` reports "
        "how many were passed over. 'We read 10 shows' and 'we read 10 entries, 6 "
        "of them empty' are different claims and the caller must be able to tell "
        "them apart. Each song carries `cover_of` when setlist.fm marks it a "
        "cover — that is INFORMATIONAL: the resolution rule is to find the "
        "PERFORMING artist's version (Weezer's 'Happy Together', not The "
        "Turtles'), never to decide a cover does not count. `song_count` per show "
        "is returned because a 1-song TV appearance and a 24-song stadium set are "
        "not comparable evidence, and any 'appeared in N of 10' figure that hides "
        "that is misleading. Tier 1."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "mbid": {
                "type": "string",
                "description": (
                    "MusicBrainz id, 8-4-4-4-12 hex, from dj_artists.mbid. "
                    "REQUIRED and the only accepted identity — this tool does "
                    "not take an artist name, because setlist.fm's name search "
                    "matches the wrong band and a setlist for the wrong act is "
                    "worse than no setlist."
                ),
            },
            "limit": {
                "type": "integer",
                "description": (
                    "Max setlists WITH SONGS to return (default 10, cap 25). "
                    "Counts kept shows, not entries read: upcoming and empty "
                    "setlists are skipped without consuming a slot, and are "
                    "reported separately as `empty_entries_skipped`."
                ),
            },
        },
        "required": ["mbid"],
    },
)
async def get_dj_setlists(args: dict, ctx: Ctx) -> dict[str, Any]:
    mbid = args.get("mbid")
    limit = args.get("limit")

    if not mbid or not str(mbid).strip():
        raise GuardrailError(
            "get_dj_setlists: `mbid` is required. This tool does NOT accept an "
            "artist name: setlist.fm's name search matches the wrong band, and a "
            "setlist for the wrong act is worse than no setlist. Find the mbid on "
            "MusicBrainz and store it in dj_artists.mbid."
        )
    mbid = str(mbid).strip()
    if len(mbid) != _MBID_LEN or mbid.count("-") != 4:
        raise GuardrailError(
            f"get_dj_setlists: {mbid!r} is not a MusicBrainz id. Expected 36 "
            f"characters in 8-4-4-4-12 form. A truncated id would 404 upstream "
            f"and read as 'this artist has no setlists', which is a different "
            f"and much more misleading answer."
        )

    limit = clamp_limit(limit, default=10, cap=25)
    api_key = _read_api_key()

    kept: list[dict[str, Any]] = []
    skipped_empty = 0
    pages_read = 0
    total_upstream: int | None = None

    for page in range(1, MAX_PAGES + 1):
        payload = await to_thread.run_sync(_fetch_page, mbid, page, api_key)
        pages_read = page
        if total_upstream is None:
            total_upstream = payload.get("total")
        entries = payload.get("setlist") or []
        if not entries:
            break

        for entry in entries:
            songs = _songs_of(entry)
            if not songs:
                # An upcoming date, or a show nobody has filled in. Skipping is
                # the whole point — see the module docstring.
                skipped_empty += 1
                continue
            venue = entry.get("venue") or {}
            city = venue.get("city") or {}
            kept.append({
                "setlist_id": entry.get("id"),
                # setlist.fm serves dd-MM-yyyy. Left VERBATIM rather than
                # reformatted: a silent d/m vs m/d swap is exactly the class of
                # bug the Takeout timezone work spent a day on, and the caller
                # can be told the format instead of guessing it.
                "event_date": entry.get("eventDate"),
                "venue": venue.get("name"),
                "city": city.get("name"),
                "country": (city.get("country") or {}).get("code"),
                "tour": (entry.get("tour") or {}).get("name"),
                "song_count": len(songs),
                "songs": songs,
                "url": entry.get("url"),
            })
            if len(kept) >= limit:
                break
        if len(kept) >= limit:
            break

    if not kept:
        raise OperationalError(
            f"setlist.fm returned no setlists WITH SONGS for mbid {mbid} across "
            f"{pages_read} page(s); {skipped_empty} entr(ies) were upcoming or "
            f"empty. This is not necessarily an error — a band between tours has "
            f"only future dates listed — but nothing can be diffed against it."
        )

    data = {
        "mbid": mbid,
        "setlists": kept,
        "returned": len(kept),
        "limit_applied": limit,
        # The honest denominator. Reported separately so a caller cannot mistake
        # "10 shows read" for "10 entries examined".
        "empty_entries_skipped": skipped_empty,
        "pages_read": pages_read,
        "total_upstream": total_upstream,
        "date_format": "eventDate is dd-MM-yyyy as setlist.fm serves it, NOT ISO. "
                       "Parse it explicitly; do not assume month-first.",
        "reading": (
            "`setlists` holds only shows that happened AND have songs. Upcoming "
            "dates were skipped and counted in `empty_entries_skipped`. When "
            "reporting how often a song appears, give the denominator as the "
            "number of setlists here — and show `song_count` per show, because a "
            "1-song appearance and a 24-song set are not comparable evidence. "
            "`cover_of` is informational: resolve covers against the PERFORMING "
            "artist's version, never to exclude them."
        ),
    }

    # meta is DELIBERATELY EMPTY, and that is not an oversight.
    #
    # The house `meta["truncated"] = (shown, total)` makes the MCP layer prepend
    # "showing X of Y" — a claim about a result that was CUT SHORT. Nothing here
    # is cut short in that sense:
    #
    #   * Returning `limit` shows out of `total_upstream` 1614 is the tool doing
    #     its job, not truncating. Flagging it would fire on EVERY call, and a
    #     detector that fires on the normal case is worse than none (spec §11.7).
    #   * Returning FEWER than `limit` means the feed ran out of played shows
    #     within MAX_PAGES — "there are only 8" not "we are showing 8 of 10".
    #     `truncated` would state the second, which is false.
    #
    # The shortfall is already legible in the payload: `returned`,
    # `limit_applied`, `pages_read` and `empty_entries_skipped` together say
    # exactly what was read and what was passed over.
    meta: dict[str, Any] = {}
    return {"data": data, "meta": meta}
