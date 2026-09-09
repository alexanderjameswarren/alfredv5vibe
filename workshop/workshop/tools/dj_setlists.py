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
import re
from difflib import SequenceMatcher
from math import ceil
import unicodedata
from pathlib import Path
from typing import Any

from anyio import to_thread

from ..platform import Ctx, GuardrailError, OperationalError, clamp_limit, define_tool
# The shared ytmusicapi call path. diff_dj_setlists searches through the SAME
# function search_dj_music uses, so a resolution here and a resolution there
# cannot diverge in how they reach YouTube.
from .dj import _call

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


# ---------------------------------------------------------------------------
# ADDED 2026-09-02: finding ONE OLD SHOW, for the third phrasing (spec §13.2)
# ---------------------------------------------------------------------------
# "Make me a playlist of the Adele show I went to" needs a setlist from
# 2023-10-13. /artist/{mbid}/setlists is newest-first, so that show is hundreds
# of entries back — reachable only by paging through two years of gigs.
#
# /search/setlists takes artistMbid + year + venueName and goes straight to it.
#
# 🛑 A 404 FROM /search/setlists MEANS "NO RESULTS", NOT "BAD MBID", AND THE TWO
# NEED OPPOSITE RESPONSES. On /artist/{mbid}/setlists a 404 means the id is wrong
# or the act has nothing recorded. On search it is simply an empty result set.
# Reusing the artist-endpoint's error text here would tell the caller to go and
# check an mbid that is perfectly correct.
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _iso_to_setlistfm(iso: str) -> str:
    """YYYY-MM-DD -> dd-MM-yyyy.

    ⚠️ WRITTEN OUT RATHER THAN FORMATTED, and asserted by a test. setlist.fm
    serves dd-MM-yyyy and this project has already spent a day on a d/m vs m/d
    swap in the Takeout timezone work. The two acceptance-test shows are
    2023-10-13 and 2023-10-14 — a swap would silently turn October into the 13th
    month for one and produce a plausible wrong answer for the other.
    """
    y, m, d = iso.split("-")
    return f"{d}-{m}-{y}"


def _setlistfm_to_iso(ev: str) -> str | None:
    """dd-MM-yyyy -> YYYY-MM-DD. None if it is not that shape."""
    if not ev or ev.count("-") != 2:
        return None
    d, m, y = ev.split("-")
    if len(y) != 4 or len(m) != 2 or len(d) != 2:
        return None
    return f"{y}-{m}-{d}"


def _days_apart(iso_a: str, iso_b: str) -> int:
    from datetime import date
    a = date(*(int(x) for x in iso_a.split("-")))
    b = date(*(int(x) for x in iso_b.split("-")))
    return abs((a - b).days)


def _search_page(mbid: str, year: int | None, venue: str | None,
                 page: int, api_key: str) -> dict[str, Any]:
    """One page of /search/setlists. Synchronous; callers run it off the loop."""
    import httpx

    params: dict[str, Any] = {"artistMbid": mbid, "p": page}
    if year:
        params["year"] = year
    if venue:
        params["venueName"] = venue

    try:
        resp = httpx.get(
            f"{API_ROOT}/search/setlists",
            params=params,
            headers={"x-api-key": api_key, "Accept": "application/json"},
            timeout=20.0,
        )
    except httpx.HTTPError as exc:
        raise OperationalError(f"setlist.fm search failed: {exc}") from None

    # 🛑 EMPTY, NOT BROKEN. See the note above this function.
    if resp.status_code == 404:
        return {"setlist": [], "total": 0}
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
            f"setlist.fm search returned HTTP {resp.status_code}: {resp.text[:300]}"
        )
    try:
        return resp.json()
    except ValueError:
        raise OperationalError(
            f"setlist.fm search returned non-JSON (HTTP {resp.status_code}): "
            f"{resp.text[:300]}"
        ) from None


# ---------------------------------------------------------------------------
# ADDED 2026-09-09: A TAPE ENTRY IS NOT A SONG THE ARTIST PLAYED
# ---------------------------------------------------------------------------
# setlist.fm records stage sections — act intros, video interludes, PA outros —
# as ROWS IN THE SET, because the set is what the audience experienced. They are
# not performances and they are not tracks. The Taylor Swift show of 2024-12-08
# carried three named ones: "Red - Intro", "Speak Now - Intro" and "Female Rage:
# The Musical". All three searched YouTube, found nothing, and were reported as
# `no_such_title` — a cause that means "the recording is missing" when in fact
# NOTHING IS MISSING. They inflated `distinct_setlist_songs` from 45 to 48, so
# the playlist could never reach its own denominator.
#
# 🛑 THE SOURCE MARKS THEM AND WE WERE THROWING THE MARK AWAY. `song.tape` is a
# boolean in the setlist.fm schema and this parser never read it — it only used
# the SIDE EFFECT that such entries are often unnamed. On the real show, `tape`
# was true for exactly four rows: one unnamed, and precisely those three. Zero
# false positives across 49 entries.
#
# ⚠️ THIS IS THE MEDLEY CASE, NOT THE §14.7 CASE, AND THE DIFFERENCE IS THE WHOLE
# ARGUMENT. Medley parts are split on ' / ' — a STRUCTURAL fact the source
# states. "Prefer the longer form" was a PATTERN over titles, and it fixed Eddie
# Higgins and broke Red Garland. A title pattern here would have been the second
# kind: `- Intro` catches two of the three and CANNOT catch "Female Rage: The
# Musical", which has no lexical signal at all. A pattern was therefore both
# riskier and worse. `tape` is the source's own assertion, and it is complete.
#
# ⚠️ NO PATTERN ARM WAS ADDED AS A BACKSTOP for contributors who omit the flag.
# §11.1 — a check needs a failing case, and there is not one. If an unflagged
# stage section ever appears it will surface as `no_such_title` exactly as these
# did, which is the evidence that would justify building it.
#
# ⚠️ THE ENTRIES ARE NOT DISCARDED, ONLY DEMOTED. An artist could play a
# recording of a REAL track over the PA, and that row is marked tape too. So the
# names ship (`_tape_of`) rather than only a count: a skip nobody can inspect is
# a skip nobody can dispute.
def _songs_of(setlist: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the sets -> set -> song nesting into one ordered list.

    Tape entries are EXCLUDED — see `_tape_of`, which keeps them.
    """
    out: list[dict[str, Any]] = []
    for chunk in (setlist.get("sets") or {}).get("set") or []:
        for song in chunk.get("song") or []:
            name = (song.get("name") or "").strip()
            if not name:
                # An entry with no name. Not a song anyone can learn.
                continue
            if song.get("tape"):
                continue
            cover = (song.get("cover") or {}).get("name")
            out.append({
                "name": name,
                # Informational ONLY. The resolution rule is to find the
                # PERFORMING artist's version, so this never gates inclusion.
                "cover_of": cover,
                "encore": bool(chunk.get("encore")),
                # setlist.fm's per-performance note: "shortened", "spoken intro",
                # "10 Minute Version". ⚠️ INFORMATIONAL AND UNUSED — it is real
                # data about the performance that was being thrown away, and one
                # value of it ("All Too Well - 10 Minute Version") describes a
                # DIFFERENT RECORDING from the one the resolver will pick. That
                # is a known gap, recorded rather than acted on: acting on it is
                # a resolution rule, and this is a parser.
                "info": (song.get("info") or "").strip() or None,
            })
    return out


def _tape_of(setlist: dict[str, Any]) -> list[dict[str, Any]]:
    """The NAMED stage sections `_songs_of` dropped, so the skip is inspectable.

    Unnamed tape rows are omitted here too — there is nothing to show and
    nothing anyone could act on.
    """
    out: list[dict[str, Any]] = []
    for chunk in (setlist.get("sets") or {}).get("set") or []:
        for song in chunk.get("song") or []:
            name = (song.get("name") or "").strip()
            if name and song.get("tape"):
                out.append({
                    "name": name,
                    "info": (song.get("info") or "").strip() or None,
                })
    return out


async def _targeted_lookup(mbid: str, year: int | None, venue: str | None,
                           on_date: str | None, limit: int,
                           api_key: str) -> dict[str, Any]:
    """Find ONE specific show, for spec §13.2's third phrasing.

    🛑 EXACT MATCH OR ASK. The returned show's date is ASSERTED against the date
    that was asked for, and a near miss is reported as a near miss — never
    substituted.

    ⚠️ THE ACCEPTANCE TEST IS THE REASON THAT SENTENCE IS IN CAPITALS. Adele
    2023-10-13 and Katy Perry 2023-10-14 are one day apart. A lookup that matched
    on artist and year and then took the first result would return a perfectly
    plausible Adele setlist from a different night of the same residency, and
    nothing downstream could tell. `date_match` is what makes that visible.
    """
    candidates: list[dict[str, Any]] = []
    pages_read = 0
    total_upstream: int | None = None

    for page in range(1, MAX_PAGES + 1):
        payload = await to_thread.run_sync(
            _search_page, mbid, year, venue, page, api_key)
        pages_read = page
        if total_upstream is None:
            total_upstream = payload.get("total")
        entries = payload.get("setlist") or []
        if not entries:
            break
        for entry in entries:
            songs = _songs_of(entry)
            v = entry.get("venue") or {}
            city = v.get("city") or {}
            ev = entry.get("eventDate")
            candidates.append({
                "setlist_id": entry.get("id"),
                "event_date": ev,
                "event_date_iso": _setlistfm_to_iso(ev),
                "venue": v.get("name"),
                "city": city.get("name"),
                "country": (city.get("country") or {}).get("code"),
                "tour": (entry.get("tour") or {}).get("name"),
                "artist": (entry.get("artist") or {}).get("name"),
                "song_count": len(songs),
                "songs": songs,
                "tape_entries": _tape_of(entry),
                "url": entry.get("url"),
            })
        # A page short of the API's page size is the last one. Unlike the
        # artist feed there is no cap-shaped trap here: search returns what it
        # has, and an empty page above ends the loop either way.
        if len(entries) < 20:
            break

    # ⚠️ EMPTY SETLISTS ARE KEPT HERE, UNLIKE THE ARTIST FEED, AND THAT IS §13.2's
    # THIRD OUTCOME. "The show is listed but nobody filled it in" is a different
    # answer from "the show is not there", and skipping empties would collapse
    # them into one. The caller needs to be able to say "setlist.fm has your
    # night, it just has no songs" rather than "I could not find it".
    with_songs = [c for c in candidates if c["song_count"] > 0]

    matched: list[dict[str, Any]] = []
    nearest: list[dict[str, Any]] = []
    date_match = "not_requested"

    if on_date:
        want = _iso_to_setlistfm(on_date)
        matched = [c for c in candidates if c["event_date"] == want]

        if len(matched) == 1 and matched[0]["song_count"] == 0:
            date_match = "found_but_empty"
        elif len(matched) == 1:
            date_match = "exact"
        elif len(matched) > 1:
            # Two setlists filed under one date. Real — a festival with two
            # stages, or a duplicate entry. It is a judgement, not a tie.
            date_match = "ambiguous"
        else:
            date_match = "not_found"

        if date_match in ("not_found", "ambiguous"):
            # Nearest by actual date distance, so the caller can see whether it
            # missed by a day or by a year.
            scored = [
                (c, _days_apart(on_date, c["event_date_iso"]))
                for c in candidates if c.get("event_date_iso")
            ]
            scored.sort(key=lambda p: p[1])
            nearest = [{**c, "days_from_requested": d} for c, d in scored[:limit]]

    shown = matched if matched else with_songs[:limit]

    return {
        "data": {
            "mbid": mbid,
            "lookup": {
                "year": year,
                "venue": venue,
                "requested_date": on_date,
                # 🛑 THE ASSERTION, AS A FIELD. exact | found_but_empty |
                # not_found | ambiguous | not_requested.
                "date_match": date_match,
                "matched_date": matched[0]["event_date_iso"] if len(matched) == 1 else None,
            },
            "setlists": shown,
            "returned": len(shown),
            "candidates_in_scope": len(candidates),
            "candidates_with_songs": len(with_songs),
            # 🛑 THESE TWO EXIST FOR CONTRACT PARITY WITH THE UNTARGETED PATH,
            # AND THEIR ABSENCE WAS A CRASH.
            #
            # diff_dj_setlists reads `empty_entries_skipped` off whichever
            # payload get_dj_setlists returns. The untargeted path had it; this
            # one did not, so a targeted diff died with
            # `Internal error: 'empty_entries_skipped'` — a KeyError in response
            # assembly, surfacing as an opaque string that said nothing about
            # what failed.
            #
            # ⚠️ THE VALUE IS THE HONEST ANALOGUE, NOT A ZERO PLACATING THE KEY.
            # Untargeted, it counts entries passed over while paging because
            # they had no songs. Here it counts candidates in scope that had no
            # songs. Same fact — setlist.fm rows that exist and cannot be
            # diffed — reached a different way. A hardcoded 0 would satisfy the
            # caller and lie about the data.
            "empty_entries_skipped": len(candidates) - len(with_songs),
            "limit_applied": limit,
            "nearest": nearest,
            "pages_read": pages_read,
            "total_upstream": total_upstream,
            "date_format": "event_date is dd-MM-yyyy as setlist.fm serves it. "
                           "event_date_iso is the same date as YYYY-MM-DD, "
                           "converted here so no call site has to.",
            "reading": (
                "🛑 CHECK `lookup.date_match` BEFORE USING `setlists`. "
                "'exact' means the returned show's date EQUALS the date asked "
                "for. Anything else means it does not, and the entry is NOT a "
                "substitute: 'not_found' ships `nearest` with days_from_requested "
                "so a human can see whether it missed by a day or a year, and "
                "'ambiguous' means two setlists are filed under that date and it "
                "is a judgement rather than a tie to break. "
                "⚠️ 'found_but_empty' IS A THIRD OUTCOME AND NOT A FAILURE: "
                "setlist.fm has the show and nobody filled in the songs. Say that "
                "rather than 'not found' — they are different facts and only one "
                "of them can be fixed by looking somewhere else. "
                "⚠️ Adele 2023-10-13 and Katy Perry 2023-10-14 are one day apart; "
                "a lookup that matched on artist and year alone would return a "
                "plausible setlist from the wrong night and nothing downstream "
                "could tell. That is what date_match exists for."
            ),
        },
        "meta": {},
    }


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
        "that is misleading. STAGE SECTIONS (setlist.fm `tape` rows - act intros, "
        "video interludes) are NOT counted as songs and are returned separately "
        "as `tape_entries`. Tier 1."
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
            "on_date": {
                "type": "string",
                "description": (
                    "YYYY-MM-DD — the date on the concert row. Switches to a "
                    "TARGETED lookup of that one show via /search/setlists, "
                    "instead of the newest-first artist feed. Use it for an old "
                    "show: a 2023 date is hundreds of entries back in the feed. "
                    "🛑 THE RETURNED SHOW'S DATE IS ASSERTED AGAINST THIS ONE and "
                    "reported as `lookup.date_match` — exact | found_but_empty | "
                    "not_found | ambiguous. A near miss is NEVER substituted: "
                    "matching on artist and year alone would return a plausible "
                    "setlist from the wrong night of the same residency and "
                    "nothing downstream could tell. The dd-MM-yyyy conversion "
                    "happens inside the tool so no call site can get it backwards."
                ),
            },
            "year": {
                "type": "integer",
                "description": (
                    "Targeted lookup by year. Implied by `on_date`; pass it alone "
                    "to list a year's shows when the exact date is not known."
                ),
            },
            "venue": {
                "type": "string",
                "description": (
                    "Targeted lookup by venue name, as setlist.fm spells it. "
                    "⚠️ UNTESTABLE IN PRACTICE TODAY: every dj_concerts row has "
                    "venue_id null and create_dj_concert accepts no venue, so "
                    "nothing in this system can supply one. Prefer `on_date`, "
                    "which is recorded and exact (spec §13.2, corrected)."
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

    # -----------------------------------------------------------------------
    # TARGETED LOOKUP — one specific old show (spec §13.2)
    # -----------------------------------------------------------------------
    on_date = args.get("on_date")
    year = args.get("year")
    venue = args.get("venue")

    if on_date is not None:
        on_date = str(on_date).strip()
        if not _ISO_DATE_RE.match(on_date):
            raise GuardrailError(
                f"get_dj_setlists: `on_date` must be YYYY-MM-DD (got {on_date!r}). "
                f"It is the date stored on the concert row, and setlist.fm serves "
                f"dd-MM-yyyy — the conversion happens here precisely so a d/m vs "
                f"m/d swap cannot happen at a call site."
            )
        if year is None:
            year = int(on_date[:4])

    if year is not None or venue:
        return await _targeted_lookup(mbid, year, venue, on_date, limit, api_key)

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
                # ⚠️ ADDED FOR diff_dj_setlists, which matches every search result
                # against the PERFORMING artist (spec §12.7). Taken from the
                # setlist rather than from the caller: a caller-supplied name
                # could disagree with the mbid it was looked up by, and then
                # every resolution would be matched against the wrong act.
                "artist": (entry.get("artist") or {}).get("name"),
                "song_count": len(songs),
                "songs": songs,
                "tape_entries": _tape_of(entry),
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
            "artist's version, never to exclude them. `tape_entries` are STAGE "
            "SECTIONS - act intros and video interludes that setlist.fm records "
            "as set rows because the audience experienced them. They are NOT "
            "songs, they are excluded from `songs` and `song_count`, and they "
            "ship by name so the skip can be checked. `info` is setlist.fm's "
            "per-performance note ('shortened', '10 Minute Version') and is "
            "INFORMATIONAL - resolution does not read it."
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


# ---------------------------------------------------------------------------
# diff_dj_setlists — tier 1
# ---------------------------------------------------------------------------
#
# WHY THIS LIVES ON WORKSHOP AND NOT ON ALFRED
# --------------------------------------------
# The diff spans both hosts: setlists and YouTube search are here, the recorded
# body is in Supabase, and SUPABASE CANNOT CALL WORKSHOP. So the caller reads the
# body (about 30 titles — cheap) and passes it in, and everything deterministic
# happens here, on the host that can actually search.
#
# ⚠️ THAT PLACEMENT IS ALSO WHAT SOLVES THE CALL BUDGET. Resolving ten missing
# songs is ten ytmusicapi searches, and none of them crosses the Alfred
# boundary — so the whole diff costs ONE platform call rather than ten. Batching
# was the alternative and this is better: the searches never become somebody
# else's rate limit.
#
# WHAT IS DELIBERATELY IN CODE RATHER THAN IN THE WEEKLY PROMPT
# ------------------------------------------------------------
# Medley splitting, title normalisation, the diff itself, and the §12.11
# tie-break. A model recomputing these weekly drifts in ways no diff shows,
# because a plausible-looking answer is indistinguishable from a correct one —
# and §12.7's "each resolution is a place a wrong match enters" becomes a
# standing weekly risk rather than a one-off. The prose is the part only a model
# can do; the arithmetic is not.

# setlist.fm records a medley as ONE entry with " / " between the parts. Treating
# it as one song invents a title nobody played; splitting it is the honest read.
# ---------------------------------------------------------------------------
# 🛑 THE KEYS diff_dj_setlists READS OFF get_dj_setlists' PAYLOAD.
# ---------------------------------------------------------------------------
# get_dj_setlists has TWO response-assembly paths — the newest-first artist feed
# and _targeted_lookup — and diff_dj_setlists consumes whichever it is handed.
# The targeted one shipped without `empty_entries_skipped`, so a targeted diff
# died with `Internal error: 'empty_entries_skipped'`.
#
# ⚠️ NOTHING CAUGHT IT BECAUSE COVERAGE WAS PER-TOOL, NOT PER-PATH. The envelope
# suite drives every registered tool exactly once, with one fixture each; the
# targeted branch was never on the path it took. A tool with two ways of
# building a response had one of them untested and nothing noticed — the same
# shape as the envelope defect that suite exists for.
#
# Asserted by test_dj_diff.py against BOTH paths.
DIFF_REQUIRED_KEYS = frozenset({
    "mbid", "setlists", "returned", "empty_entries_skipped",
})

# The keys diff_dj_setlists reads off EACH SHOW in `setlists`. Same argument one
# level down, and the level `tape_entries` was added at on 2026-09-09 — a key
# added to the untargeted show dict and not the targeted one would reproduce the
# crash of 2026-09-08 exactly, just later.
DIFF_REQUIRED_SHOW_KEYS = frozenset({
    "event_date", "venue", "song_count", "songs", "tape_entries",
})

def _median(xs: list[int]) -> int | None:
    """Median, or None for an empty window. The TYPICAL set, not the mean —
    one 4-song radio session should not drag the figure a whole song down."""
    if not xs:
        return None
    ordered = sorted(xs)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) // 2


_MEDLEY_SEP = " / "

# Two recordings within this many seconds of each other are the same master
# (spec §12.11 rule 3). Measured against the real case: Razor is 4:54 on
# In Your Honor and 4:53 on Catch And Release.
_SAME_MASTER_SECONDS = 2

# ---------------------------------------------------------------------------
# ADDED 2026-09-02: A FULL SET AND A PROMO APPEARANCE ARE NOT COMPARABLE EVIDENCE
# ---------------------------------------------------------------------------
# §12.3 DECIDED that promo appearances COUNT as shows, and they still do — this
# constant excludes nothing. It LABELS.
#
# Six of the ten Weezer shows in the 2026-09-02 window were promo spots of one to
# six songs: Fallon (1), Today Show (2), SiriusXM (5), Apple Music (5), Snap (5),
# Hinano Cafe (6). The other four were real sets: Halifax (24), Yellowstone (24),
# Allegiant (13), Amazon MGM (12). So "We Might as Well Be Strangers, 4 shows"
# was three television appearances and one concert — a true number that reads as
# four times the evidence it is.
#
# ⚠️ THE TOOL ALREADY SHIPPED song_count PER SHOW AND THAT WAS NOT ENOUGH. It made
# the fact RECOVERABLE, which means every consumer re-derives it, differently, and
# §12.12 forbids explaining it in a paragraph. A number the report needs is a
# number the payload should carry.
#
# WHY 8, AND WHAT IT COSTS. A television spot is one to three songs and a radio
# session four to six; a concert is rarely under eight. Eight separates all three
# acts in the current window cleanly. It is an ABSOLUTE constant rather than a
# fraction of the window's median because the median is dragged down by the promos
# themselves — Weezer's is 5.5, so "half the median" would certify the five-song
# SiriusXM session as a full set.
#
# ⚠️ THE BOUNDARY CASE IS NAMED RATHER THAN HIDDEN: Smashing Pumpkins played SEVEN
# songs at the LA Memorial Coliseum on 2026-07-04 and is classed here as a short
# set. That is a festival or support slot, and treating it as weaker evidence than
# a 24-song headline show is the intended behaviour — but it sits one song under
# the line, and anyone retuning this should know that is the row that moves.
_FULL_SET_MIN_SONGS = 8

# ---------------------------------------------------------------------------
# ADDED 2026-09-02: WHY a song was not found, as a FIELD rather than as prose
# ---------------------------------------------------------------------------
# The first weekly run had to classify not-founds by READING the `why` strings to
# work out which gaps could ever be closed. That is prose parsing, it will break
# silently the first time a sentence is reworded, and it got the count wrong on
# the very first attempt — six Foo Fighters medley parts were reported as five,
# because "Happy Birthday to You" appeared at one show and was missed by eye.
#
# ⚠️ THE FOUR CAUSES ARE NOT THE SAME KIND OF ANSWER, WHICH IS THE WHOLE POINT:
#
#   medley_part        Structural. One part of a ' / '-joined setlist.fm row.
#                      Rarely has a studio recording at all. NEVER closeable.
#   other_artists_only The title exists, by somebody else. §12.4: the performing
#                      artist's version is what goes in, and it does not exist.
#                      NEVER closeable.
#   no_such_title      YouTube Music returned nothing under that title at all.
#                      NEVER closeable.
#   variant_only       The artist HAS this song; only a studio cut is missing.
#                      🛑 CLOSEABLE — it is a judgement for a human, and it
#                      carries candidates and a recommendation. See _resolve_one.
#
# The first three make a gap that no decision can close, and they are what
# `coverage.gettable` subtracts. The fourth is a question, and subtracting it
# would hide the only not-found worth reading.
_UNCLOSEABLE_CAUSES = ("medley_part", "other_artists_only", "no_such_title")

# ---------------------------------------------------------------------------
# ADDED 2026-09-09: THE UNION IS NOT THE SET. A DENOMINATOR NOBODY CAN REACH.
# ---------------------------------------------------------------------------
# `coverage.total` is the INCLUSIVE union over the window (§12.2) — every song
# played at ANY show. That is the right answer to "what might I hear" and the
# WRONG denominator for "is this playlist finished", because he attends ONE
# show.
#
# Measured on Queens of the Stone Age, 2026-09-09, 10-show window:
#
#     typical set                12 songs
#     union across the window    28      <- what coverage.total reported
#     songs at <=2 of 10 shows   12
#
# So the playlist read 5/28 and looked badly incomplete. It was not:
#
#     10/10  HAVE  My God Is the Sun          10/10   --   A Song for the Dead
#     10/10  HAVE  Little Sister               7/10   --   Make It Wit Chu
#     10/10  HAVE  Go With the Flow            6/10  HAVE  The Lost Art of...
#     10/10  HAVE  No One Knows                6/10   --   Paper Machete
#
# FOUR OF THE FIVE SONGS PLAYED AT EVERY SHOW WERE ALREADY THERE. The honest
# report is "4 of 5 certainties — add A Song for the Dead", which is a proposal
# somebody can act on. "5 of 28, expect a gap" is not, and §12.12 says a number
# that needs a caveat should be a different number.
#
# ⚠️ THIS IS NOT A SUPPORT-SLOT DEFECT, which is how it was first read. It is
# true of headline shows too — the union of ten Taylor Swift nights exceeds any
# one of them. The support slot only made it loud.
_SET_SHAPE_CORE = "core"          # played at EVERY show in the window
_SET_SHAPE_LIKELY = "likely"      # played at most of them
_SET_SHAPE_ROTATING = "rotating"  # comes and goes

# A song counts as `likely` at this share of the window.
_LIKELY_SHARE = 0.6

# ---------------------------------------------------------------------------
# 🛑 WHY 5, AND WHAT HAPPENS BELOW IT — a number that means nothing must SAY SO
# ---------------------------------------------------------------------------
# "Played at every show" is only evidence when there are enough shows for it to
# be hard. With the observed QOTSA shape — 12 songs a night drawn from a pool of
# 28 — a song that is chosen AT RANDOM appears in all n shows with probability
# (12/28)^n, so the number of songs falsely certified `core` by chance is:
#
#     n = 3   ->  28 x 0.079  =  2.2 songs      <- the core would be mostly noise
#     n = 4   ->  28 x 0.034  =  0.95
#     n = 5   ->  28 x 0.015  =  0.41           <- under half a song
#     n = 10  ->  28 x 0.0002 =  0.005
#
# Five is where the expected number of false certainties drops below one. Below
# it the shape is NOT REPORTED AT ALL rather than reported with a warning — a
# caveat next to a printed number is the thing §12.12 rejects, and `core: []`
# with an asterisk would be read as "this band has no fixed set".
_MIN_SHOWS_FOR_SET_SHAPE = 5

# Variant markers. A live or acoustic cut is not the studio recording, and the
# setlist entry is never asking for one.
_VARIANT_RE = re.compile(
    r"\b(live|acoustic|remix|karaoke|instrumental|demo|radio edit|"
    r"session|cover|tribute|originally performed)\b",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Title normalisation — A SECOND COPY OF A RULE TYPESCRIPT ALREADY OWNS
# ---------------------------------------------------------------------------
#
# 🛑 THE AUTHORITY IS `supabase/functions/_shared/tools/dj-normalise.ts`. What
# follows is a PORT of its vocabulary, not an independent design, and the port is
# the whole hazard: on 2026-09-02 this file recognised "(Remastered 2012)" and
# missed "(2011 Remaster)", so the Smashing Pumpkins diff reported Today, Luna
# and Cherub Rock as MISSING while all three sat in the playlist body. Two of
# them then resolved to the exact video_id already recorded there. The suffix
# list looked complete because the cases it missed had not appeared yet — and
# the complete list already existed, in the other language.
#
# ⚠️ WHY THERE CANNOT BE ONE IMPLEMENTATION. dj-normalise.ts feeds `match_key`,
# which is FROZEN AT WRITE and never updated (spec §4.1.2) — changing it is a
# backfill migration, not a deploy. This runs at read time, on a different host,
# in a different language, over titles that never pass through Alfred at all
# (setlist.fm's side of the diff). Neither can call the other across the courier
# boundary, so the duplication is structural rather than lazy.
#
# ⚠️ WHAT MAKES IT SAFE IS THE SHARED FIXTURE, NOT CARE.
# `shared/dj-title-cases.json` is asserted by BOTH suites — tests/test_dj_diff.py
# here and dj-normalise.test.mjs there. A rule added to one vocabulary and not
# the other fails a test in the runtime nobody edited, which is the only
# arrangement that survives a reader who does not know this comment exists.

# The ONLY tokens that trigger stripping. Anything unrecognised is KEPT.
# Mirrors QUALIFIER_RES in dj-normalise.ts, entry for entry.
_QUALIFIER_RES = [
    re.compile(r"^(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?$"),
    re.compile(r"^live(?:\s+(?:at|from|in)\b.*)?$"),
    re.compile(r"^(?:deluxe|anniversary|expanded)(?:\s+edition)?$"),
    re.compile(r"^(?:single|album)\s+version$"),
    re.compile(r"^radio\s+(?:edit|version)$"),
    re.compile(r"^extended(?:\s+(?:version|mix))?$"),
    re.compile(r"^(?:mono|stereo)$"),
    re.compile(r"^bonus\s+track$"),
    re.compile(r"^(?:explicit|clean|acoustic|demo)$"),
]

# `with` marks a feature ONLY inside a parenthetical — "Go Away (with Bethany
# Cosentino)". Bare, it is ordinary English ("Sitting With You"), and stripping
# on it would eat real titles.
_FEATURE_PAREN_RE = re.compile(r"^(?:feat\.?|ft\.?|featuring|with)\b", re.IGNORECASE)
_FEATURE_INLINE_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s+.*$", re.IGNORECASE)

_PAREN_GROUP_RE = re.compile(r"[(\[]([^)\]]*)[)\]]")
_DASH_TAIL_RE = re.compile(r"\s[-–—]\s*([^-–—]+)$")
_APOSTROPHE_RE = re.compile(r"['’`]")
_PUNCT_RE = re.compile(r"[\W_]+", re.UNICODE)


def _is_qualifier(inner: str) -> bool:
    return any(rx.match(inner) for rx in _QUALIFIER_RES)


def _strip_qualifier_groups(s: str) -> str:
    """Drop (…) and […] groups whose contents match the vocabulary. Others stay.

    ⚠️ BY VOCABULARY, NEVER BY POSITION. "Strip whatever is in the last bracket"
    would eat "(Reprise)", which is different music. "(feat. Best Coast)" goes
    because a feature marker is IN the vocabulary, not because of where it sits.
    """
    def repl(m):
        inner = (m.group(1) or "").strip()
        if _is_qualifier(inner) or _FEATURE_PAREN_RE.match(inner):
            return " "
        return m.group(0)
    return _PAREN_GROUP_RE.sub(repl, s)


def _strip_dash_qualifiers(s: str) -> str:
    """Drop a trailing " - <qualifier>", repeatedly: "Song - Live - Remaster 2011".

    ⚠️ A RULE LIKE "strip everything after a dash" DESTROYS "Undone - The Sweater
    Song", a real title in the Weezer playlist where the dashed half IS the song
    name. It matches nothing in the vocabulary, so it survives.
    """
    out = s
    while True:
        m = _DASH_TAIL_RE.search(out)
        if not m:
            return out
        inner = m.group(1).strip()
        if not _is_qualifier(inner) and not _FEATURE_PAREN_RE.match(inner):
            return out
        out = out[: m.start()]


def _norm_title(title: str) -> str:
    """Fold a title to something two sources can be compared on.

    Deliberately conservative: it strips VARIANT decoration, not content. An
    aggressive normaliser would merge two genuinely different songs, and this
    feeds a diff whose false negatives cost one listen while its false positives
    cost a song Alex does not know when the lights go down (spec §12.2).

    ⚠️ ONE DELIBERATE DIVERGENCE FROM dj-normalise.ts, AND IT IS NOT AN OVERSIGHT.
    This folds accents (NFKD, after which the combining marks fall to the
    punctuation rule) so "Algés" and "Alges" compare equal; the TypeScript keeps
    them distinct. That side compares YouTube against YouTube, where ONE
    vocabulary wrote both strings. This side compares SETLIST.FM against YOUTUBE
    MUSIC — two independent editorial systems that disagree about diacritics —
    and an unfolded compare there reports a song missing over an acute accent.
    The divergence is pinned in the shared fixture rather than left to be
    rediscovered as a bug.
    """
    # ⚠️ COMBINING MARKS ARE DROPPED EXPLICITLY, NOT LEFT TO THE PUNCTUATION RULE.
    # NFKD turns "é" into "e" + U+0301, and U+0301 is non-word, so `_PUNCT_RE`
    # would replace it with a SPACE — folding "Algés" to "alge s" rather than
    # "alges" and splitting the word it was meant to join. The fold has to be
    # stated to be right; getting there by side effect is how it silently was not.
    t = "".join(
        c for c in unicodedata.normalize("NFKD", title or "")
        if not unicodedata.combining(c)
    )
    t = t.lower().strip()
    t = _strip_qualifier_groups(t)
    t = _strip_dash_qualifiers(t)
    t = _FEATURE_INLINE_RE.sub("", t)
    t = t.replace("&", " and ")
    t = _APOSTROPHE_RE.sub("", t)      # ain't -> aint, closing up as tidy() does
    t = _PUNCT_RE.sub(" ", t)
    return " ".join(t.split())


# ---------------------------------------------------------------------------
# Artist matching — spec §4.1.4's two-vocabularies problem, in the resolver
# ---------------------------------------------------------------------------
#
# 🛑 SETLIST.FM AND YOUTUBE MUSIC DISAGREE ABOUT THE LEADING ARTICLE. setlist.fm
# bills the act as "The Smashing Pumpkins" — and that name comes from the mbid,
# so it is the verified identity. YouTube Music's artist metadata says "Smashing
# Pumpkins". An exact compare called that a non-match and dropped THREE songs on
# 2026-09-02: two resolved to video ids already sitting in the playlist body, and
# Disarm was genuinely absent and played at 7 of 10 shows.
#
# ⚠️ THIS IS NOT THE ALIAS MAP'S JOB, and reaching for it would be the wrong fix.
# ARTIST_ALIASES in dj-normalise.ts translates TAKEOUT channel names into the
# POLL's vocabulary, applied once at import, to a column frozen at write. This is
# a different boundary (setlist.fm to YouTube Music), evaluated at read time, on
# another host, about a systematic orthographic difference rather than a per-act
# fact. The map is explicit that it is hand-curated because rules like "prefer
# the longer form" break Red Garland the moment they fix Eddie Higgins. A leading
# article is precisely the case where a rule DOES hold, and the map has no entry
# that would help.
#
# ⚠️ IT WIDENS THE COLLISION SURFACE §14.4 ALREADY NAMES, SO IT IS REPORTED.
# "The Killers" and Paul Di'Anno's "Killers" are two real acts, and folding the
# article is what lets one stand in for the other. So the fold is never silent:
# every resolution carries WHICH kind of match it made, and a folded one says so
# in `why`. A widened rule that announces itself is checkable; the same rule
# applied quietly is the §14.4 failure arriving through the front door.
_LEADING_ARTICLE_RE = re.compile(r"^(?:the|a|an)\s+")

# ---------------------------------------------------------------------------
# 🛑 THE SECOND KEY — added 2026-09-09, and WHY IT IS NOT A CHANGE TO _norm_title
# ---------------------------------------------------------------------------
# `_norm_title` is a PORT of dj-normalise.ts, which builds `match_key`, which is
# WRITTEN ONCE AND FROZEN (§4.1.2). Loosening it would diverge from every
# match_key already in the table and from the TypeScript it is pinned to — a
# backfill migration, not an edit. So the fold that this diff needs lives BESIDE
# it as a strictly weaker key, exactly as `_artist_match_kind` already does for
# artist names.
#
# ⚠️ THE PROJECT HAD ALREADY DECIDED THIS RULE AND APPLIED IT TO ONE FIELD OF
# TWO. The note above _artist_match_kind says setlist.fm and YouTube Music
# disagree about the leading article, and that an exact compare dropped three
# Smashing Pumpkins songs over it. The identical disagreement applies to TITLES
# and nobody carried the rule across. This is §14.6 in a single file.
#
# WHAT IT COST, 2026-09-09: setlist.fm writes "A Song for the Dead"; YouTube
# Music titles the same recording "Song For The Dead". The diff reported a song
# already in the playlist as missing.
#
# ---------------------------------------------------------------------------
# 🛑 THE RULE, STATED — NOT A LIST OF CASES THAT MAKE TODAY'S BUG PASS (§14.7)
# ---------------------------------------------------------------------------
# A difference is folded when BOTH hold:
#
#   (a) it is a FIXED, CLOSED transformation with exactly one expansion, and
#   (b) it cannot distinguish two real recordings by the same artist.
#
# FOLDED, and why each qualifies:
#   leading article   {the, a, an} is a closed set, and cataloguing systems add
#                     and drop it by house style. Already folded for artists.
#   elided -in'       "Hangin'" -> "Hanging". THE APOSTROPHE IS THE MARKER and
#                     the fold is applied BEFORE it is stripped — which is what
#                     keeps "again" and "ain't" out of it. There is no pair of
#                     songs by one artist separated only by that g.
#
# NOT FOLDED, and why each fails the rule rather than merely being unlisted:
#   Pt. -> Part       NOT closed: "Pt." expands to Part or Point. Fails (a).
#   Vol. -> Volume    Head of an open abbreviation vocabulary. Fails (a).
#   Mr. -> Mister     Head of an open honorific vocabulary. Fails (a).
#   2 <-> II          "I" is also a pronoun, and roman numerals are ambiguous
#                     against real words. Fails (a) and risks (b).
#
# ⚠️ THE HONEST WRINKLE: "&" -> "and" is already inside `_norm_title` and is a
# substitution. It qualifies under (a) — an ampersand is a TYPOGRAPHIC GLYPH FOR
# ONE WORD, with exactly one expansion, unlike "Pt." which has two. The line is
# "one unambiguous expansion", not "never substitute".
#
# ⚠️ AND THE RESIDUAL RISK IS ACCEPTED BY REPORTING IT, NOT BY DENYING IT. The
# article fold cannot tell "The Man" from "A Man". That is why a loose match is
# NEVER SILENT: it is labelled `title_match: "loose"` and both raw titles travel
# with it, so a wrong join is auditable instead of invisible.
_ELIDED_G_RE = re.compile(r"(\w{2,})in['\u2019]", re.IGNORECASE)


def _loose_key(title: str) -> str:
    """A strictly weaker `_norm_title`. Never used to WRITE anything.

    ⚠️ THE ELISION FOLD RUNS FIRST, ON THE RAW TITLE, because the apostrophe is
    the evidence that a letter was dropped and `_norm_title` strips it. Folding
    a bare word-final "in" afterwards would turn "again" into "againg" and
    "Wanderin" into a different word — the marker has to be read before it is
    thrown away.
    """
    t = _ELIDED_G_RE.sub(r"\1ing", title or "")
    return _LEADING_ARTICLE_RE.sub("", _norm_title(t))


# How close a title has to be to the one asked for before it is worth showing as
# "the artist does have this". 0.75 admits "hangin tree"/"hanging tree" (0.96)
# and "song for the deaf"/"a song for the deaf" (0.90) while excluding unrelated
# tracks from the same album.
_NEAR_TITLE_RATIO = 0.75


def _near_titles(results, title: str, performing: str) -> list[dict]:
    """Tracks BY THE PERFORMING ARTIST whose titles are close but not equal.

    🛑 ITS SCOPE IS TITLES, AND ITS SILENCE IS NOT A CLEAN BILL OF HEALTH.
    It answers "does this act have a DIFFERENTLY TITLED version". It cannot see a
    row whose title is exactly right and whose BYLINE is wrong — A320 matched on
    title, so this returned empty and read as confirmation while never having
    examined the question. ⚠️ A CHECK CANNOT RULE OUT A FAILURE MODE IT DOES NOT
    COMPARE ON, and an empty list here means "no near titles", never "no problem".

    🛑 THIS IS THE ANTIDOTE TO A CONFIDENT WRONG VERDICT. On 2026-09-09 the diff
    decided "A Song for the Deaf" was missing, searched for that exact string,
    found nothing under it, and reported it UNCLOSEABLE — two independent-looking
    confirmations of a false premise. "Hangin' Tree" was worse: the search DID
    find that exact title, by Olivier Libaux and Vitamin String Quartet, so the
    verdict came back `other_artists_only` and NAMED TWO REAL COVER ARTISTS as
    evidence. Queens of the Stone Age's own recording was sitting in the same
    result list under "Hanging Tree".
    """
    want = _norm_title(title)
    out: list[dict] = []
    for r in results:
        rt = r.get("title") or ""
        k = _norm_title(rt)
        if not k or k == want or not _artist_matches(r.get("artists") or [], performing):
            continue
        wt, kt = set(want.split()), set(k.split())
        close = (SequenceMatcher(None, want, k).ratio() >= _NEAR_TITLE_RATIO
                 or wt <= kt or kt <= wt)
        if close:
            out.append({"title": rt, "video_id": r.get("video_id"),
                        "album": r.get("album"),
                        "duration_seconds": r.get("duration_seconds")})
    return out[:3]

EXACT = "exact"
ARTICLE_INSENSITIVE = "article_insensitive"
LOOSE = "loose"


def _artist_match_kind(result_artists, performing: str):
    """How this result's artist matches the performing act, or None for no match.

    Returns EXACT or ARTICLE_INSENSITIVE. Callers must carry the distinction into
    their answer rather than collapsing it to a boolean — see the note above.
    """
    want = _norm_title(performing)
    if not want:
        return None
    normed = [_norm_title(a) for a in (result_artists or [])]
    if any(a == want for a in normed):
        return EXACT
    bare = _LEADING_ARTICLE_RE.sub("", want)
    if bare and any(_LEADING_ARTICLE_RE.sub("", a) == bare for a in normed):
        return ARTICLE_INSENSITIVE
    return None


def _artist_matches(result_artists, performing: str) -> bool:
    """Is this search result BY the act that played it?

    ⚠️ MATCHED, NOT MERELY NOTICED (spec §12.7). A result whose artist does not
    match is a NON-match however well the title fits — that is the rule that
    kept the Takeout repair safe, and one search for "Happy Together" returned
    six different recordings.
    """
    return _artist_match_kind(result_artists, performing) is not None


def _fold_note(performing: str, matched_artists: list[str]) -> str:
    """The sentence that keeps an article-insensitive match honest."""
    shown = ", ".join(sorted({a for a in matched_artists if a})) or "the same name"
    return (
        f" ⚠️ ARTIST MATCHED ONLY AFTER DROPPING A LEADING ARTICLE: setlist.fm bills "
        f"this act as {performing!r} and YouTube Music returned {shown}. They are the "
        f"same act — but this is the one rule that could let two real bands sharing a "
        f"name stand in for each other (spec 14.4), so it is stated rather than assumed."
    )


def _resolve_one(
    results: list[dict],
    title: str,
    performing: str,
    cover_of_known: bool = True,
) -> dict:
    """Apply spec §12.11's tie-break to one song's search results.

    Returns a `resolution` the caller can act on WITHOUT re-deriving anything:
    resolved | not_found | ambiguous_same_artist | ambiguous_multi_artist.

    `cover_of_known` is False for a MEDLEY PART. setlist.fm records one cover
    marker for the whole medley row, so whether this particular part was the
    act's own song or somebody else's is not in the source. NOT FOUND is still
    the right verdict — but it must not be justified with a cover judgement the
    data cannot support (spec §12.4).
    """
    # 🛑 TITLE FIRST, AND THIS WAS MISSING ON THE FIRST BUILD.
    #
    # YOUTUBE SEARCH RETURNS AN ARTIST'S POPULAR TRACKS WHETHER OR NOT THEY MATCH
    # THE QUERY. Searching "Foo Fighters A320" returns seventeen Foo Fighters
    # songs and not one of them is A320. Filtering on artist alone therefore
    # accepted the whole catalogue as candidates: the first run reported 13 of
    # 13 songs "ambiguous", each with twenty alternatives — which is not a tie
    # to break, it is a search that found nothing.
    #
    # ⚠️ §12.7 IS "EXACT MATCH OR NOT FOUND", AND THE TITLE IS HALF THE MATCH.
    # Done by hand the title comparison happens by eye and is invisible; encoded,
    # it is the step that gets left out. Both halves, in this order.
    want = _norm_title(title)
    titled = [r for r in results if _norm_title(r.get("title") or "") == want]

    # -----------------------------------------------------------------------
    # TIER 2 — AND THE TRIGGER IS "NO USABLE MATCH", NOT "NO TITLE MATCH"
    # -----------------------------------------------------------------------
    # 🛑 THE FIRST VERSION OF THIS FELL BACK ONLY WHEN THE EXACT KEY FOUND
    # NOTHING AT ALL, AND THAT MISSES THE WORST CASE. "Hangin' Tree" matched two
    # results exactly — Olivier Libaux's covers album and a Vitamin String
    # Quartet tribute — so `titled` was non-empty, the fallback never ran, and
    # the verdict came back `other_artists_only` NAMING TWO REAL COVER ARTISTS
    # while Queens of the Stone Age's own "Hanging Tree" sat in the same list.
    #
    # A title match by the WRONG ARTIST is not a match (§12.7). So the question
    # that gates the fallback is the one the resolver actually needs answered:
    # is there anything here BY THE PERFORMING ARTIST?
    #
    # ⚠️ IT SWAPS ONLY IF THE LOOSE PASS DOES BETTER. When neither tier has the
    # act's own version — One Headlight, which really is only The Wallflowers' —
    # the exact results are kept so the cover ruling still names what it found.
    title_match = EXACT
    if not any(_artist_matches(r.get("artists") or [], performing) for r in titled):
        want_loose = _loose_key(title)
        loose = [r for r in results
                 if _loose_key(r.get("title") or "") == want_loose]
        if any(_artist_matches(r.get("artists") or [], performing) for r in loose):
            titled, title_match = loose, LOOSE

    if not titled:
        return {
            "resolution": "not_found",
            # ADDED 016: see the _NOT_FOUND_CAUSES note above. A medley part is
            # classified by WHAT IT IS, not by which branch it fell out of - the
            # structural fact that it has no studio recording is the same whether
            # the search found nothing or found somebody else.
            "not_found_cause": "medley_part" if not cover_of_known else "no_such_title",
            "video_id": None,
            "artist_match": None,
            "title_match": None,
            # ⚠️ THE VERDICT CARRIES WHAT WOULD CONTRADICT IT. If this is
            # non-empty the cause is almost certainly a title spelling rather
            # than a missing recording.
            "near_titles_by_artist": _near_titles(results, title, performing),
            "why": (
                f"Nothing titled {title!r} came back. Search returned "
                f"{len(results)} result(s), all with other titles — YouTube "
                f"answers a query it cannot match with the artist's popular "
                f"tracks, so a long result list here means NO match rather than "
                f"a choice."
            ),
            "other_artists_found": [],
        }

    # ⚠️ EXACT ARTIST MATCHES WIN OUTRIGHT. The article fold only ever decides a
    # case that would otherwise be NOT FOUND — it can never displace a result the
    # strict rule already accepted, so widening the rule cannot change an answer
    # that was previously right.
    kinds = [(r, _artist_match_kind(r.get("artists") or [], performing)) for r in titled]
    exact = [r for r, k in kinds if k == EXACT]
    folded = [r for r, k in kinds if k == ARTICLE_INSENSITIVE]
    by_artist = exact or folded
    match_kind = EXACT if exact else (ARTICLE_INSENSITIVE if folded else None)
    fold_note = ""
    if match_kind == ARTICLE_INSENSITIVE:
        fold_note = _fold_note(
            performing, [a for r in folded for a in (r.get("artists") or [])],
        )

    if not by_artist:
        # ⚠️ NOT FOUND IS AN ANSWER, NOT A FAILURE (spec §12.4). If YouTube Music
        # does not have the performing artist's version, it is not in the
        # playlist — no judgement about whether a cover "counts". The other
        # artists' results are returned so a human can see WHAT was there.
        # ⚠️ THE RIGHT TITLE BY THE WRONG ARTIST — exactly what a human needs to
        # see: "One Headlight exists, but only as The Wallflowers'". §12.4 — if
        # YouTube Music has not got the PERFORMING artist's version then it is
        # not in the playlist, and no judgement is made about whether a cover
        # "counts".
        others = [
            {"video_id": r.get("video_id"), "title": r.get("title"),
             "artists": r.get("artists"), "album": r.get("album"),
             "duration_seconds": r.get("duration_seconds")}
            for r in titled[:5]
        ]
        names = sorted({a for r in titled for a in (r.get("artists") or [])})
        # A COUNT, NOT A CAUSE (§11.20). If the search returned many rows under
        # this act's byline and none of them is the title asked for, "they do not
        # have it" is better supported than if the act appears nowhere at all.
        # The reader weighs it; the tool does not conclude from it.
        by_artist_count = sum(
            1 for r in results
            if _artist_matches(r.get("artists") or [], performing)
        )
        why = (
            f"{len(titled)} result(s) titled {title!r}, none by {performing}. "
            f"Found instead: {', '.join(names[:4])}. "
        )
        if cover_of_known:
            # 🛑 "IF IT DOES NOT EXIST, THE SONG DOES NOT" WAS AN OVERCLAIM, AND
            # IT IS THE ONE THIS VERDICT KEEPS INVITING. What was actually
            # observed is that NO RETURNED ROW CARRIES THIS ARTIST'S BYLINE. That
            # is two different worlds and the search cannot separate them:
            #
            #   * a genuine cover — the act really never recorded it;
            #   * a MIS-BYLINED ORIGINAL — the act's own recording is right there
            #     under somebody else's name.
            #
            # ⚠️ THE SECOND IS ORDINARY, NOT EXOTIC. A soundtrack compilation
            # carrying one orchestra's byline across every track is a routine
            # metadata error. Foo Fighters really do have "A320", on the 1998
            # Godzilla soundtrack. On 2026-09-09 the returned A320 was checked BY
            # EAR and was genuinely the orchestral cut — so the verdict was right,
            # and it was right by luck of the data rather than by having checked.
            why += (
                f"The PERFORMING artist's version is what goes in the playlist "
                f"(spec 12.4). "
                f"⚠️ WHAT WAS OBSERVED IS THAT NO RETURNED ROW IS BYLINED "
                f"{performing}, WHICH IS NOT THE SAME AS 'they never recorded "
                f"it'. This cannot distinguish a genuine cover from a MIS-BYLINED "
                f"ORIGINAL — a compilation stamping one artist across every track "
                f"is an ordinary metadata error. `other_artists_found` carries the "
                f"rows; the only way to settle it is to LISTEN to one. "
                f"{by_artist_count} of {len(results)} returned row(s) were bylined "
                f"{performing} under other titles."
            )
        else:
            # 🛑 THE VERDICT IS RIGHT AND THE OLD REASON WAS NOT. Reading "none by
            # Foo Fighters, found The Wallflowers" as a §12.4 cover ruling asserts
            # something the source never said: this is one part of a ' / '-joined
            # medley, and setlist.fm carries a single cover marker for the whole
            # row. A right answer reached wrongly is the one that breaks when the
            # case changes.
            why += (
                f"⚠️ THIS IS ONE PART OF A MEDLEY, and setlist.fm records a single "
                f"cover marker for the whole medley row — so whether {performing} "
                f"played their own song here or somebody else's is NOT IN THE SOURCE. "
                f"NOT FOUND is right either way, because a medley part rarely has a "
                f"studio recording at all; it is right for that reason, not because "
                f"a cover was ruled on."
            )
        return {
            "resolution": "not_found",
            "not_found_cause": (
                "medley_part" if not cover_of_known else "other_artists_only"
            ),
            "video_id": None,
            "artist_match": None,
            "title_match": None,
            "by_performing_artist_in_results": by_artist_count,
            # 🛑 THE CASE THIS WAS BUILT FOR. "Hangin' Tree" matched Olivier
            # Libaux and Vitamin String Quartet on the exact title, so the
            # verdict read "only other artists have it" WITH NAMED EVIDENCE —
            # while QOTSA's own "Hanging Tree" sat in the same result list.
            "near_titles_by_artist": _near_titles(results, title, performing),
            "why": why,
            "other_artists_found": others,
        }

    studio = [r for r in by_artist if not _VARIANT_RE.search(r.get("title") or "")]
    if not studio:
        # ----------------------------------------------------------------
        # 🛑 VARIANT-ONLY IS A JUDGEMENT, NOT A DEAD END, AND IT USED TO LOOK
        #    EXACTLY LIKE ONE.
        # ----------------------------------------------------------------
        # The verdict is unchanged and correct: §12.11 rule 2 drops variant cuts,
        # §12.7 is exact-match-or-NOT-FOUND, and nothing is written automatically.
        # What was wrong is that the payload was SHAPED like the hopeless cases.
        #
        # On 2026-09-02 this branch returned Mayonaise - a Smashing Pumpkins song
        # played at 5 of the 10 shows read - with `other_artists_found: []` and a
        # sentence of prose, byte-identical in shape to A320, where piano covers
        # genuinely are all that exists. One is a real decision Alex can make in
        # ten seconds; the other is nothing. They printed the same.
        #
        # ⚠️ §12.11's RULE IS THAT AN AMBIGUITY NEVER ESCALATES WITHOUT A
        # RECOMMENDATION AND A WAY TO RESOLVE IT. `duplicate_titles_in_cram` got
        # that treatment; this did not. So the candidates travel with the verdict,
        # carrying album and duration - the two fields that distinguish a released
        # live album from a phone recording - plus a named pick.
        #
        # ⚠️ IT REMAINS not_found. The recommendation is a SUGGESTION for a human,
        # never a resolution: taking it means learning the song from a live cut,
        # which is a real cost and his call to accept. Promoting this to
        # `resolved` would put a live recording into a playlist by machine, which
        # is the exact thing rule 2 exists to prevent.
        cands = sorted(
            by_artist,
            # A cut on a released album beats a loose upload; among those, the
            # longest is the complete performance rather than an excerpt. Stated
            # so the pick is checkable rather than "the first one".
            key=lambda r: (r.get("album") is None, -(r.get("duration_seconds") or 0)),
        )
        pick = cands[0]
        return {
            "resolution": "not_found",
            "not_found_cause": "variant_only",
            "video_id": None,
            "artist_match": match_kind,
            "title_match": title_match,
            "why": (
                f"{performing} has results for this title but every one is a live, "
                f"acoustic or otherwise variant cut, so nothing resolves "
                f"automatically (spec 12.11 rule 2). ⚠️ THIS IS A DECISION, NOT A "
                f"DEAD END: the song exists and only a studio recording is missing. "
                f"Recommend {pick.get('title')!r}"
                + (f" from {pick['album']}" if pick.get("album") else "")
                + " — the longest cut on a released album, which is the closest "
                  "thing to a studio version available. Taking it means learning "
                  "the song from a live recording." + fold_note
            ),
            "variant_candidates": [
                {"video_id": r.get("video_id"), "title": r.get("title"),
                 "album": r.get("album"),
                 "duration_seconds": r.get("duration_seconds")}
                for r in cands[:5]
            ],
            "recommended_video_id": pick.get("video_id"),
            "other_artists_found": [],
        }

    if len(studio) == 1:
        r = studio[0]
        return {"resolution": "resolved", "video_id": r.get("video_id"),
                "artist_match": match_kind,
            "title_match": title_match,
                "album": r.get("album"), "duration_seconds": r.get("duration_seconds"),
                "why": "One studio recording by the performing artist." + fold_note}

    # Several studio cuts by the right artist. Rule 3: within two seconds is the
    # same master, so the choice does not matter and must not be escalated.
    durs = [r.get("duration_seconds") for r in studio if r.get("duration_seconds")]
    if durs and (max(durs) - min(durs)) <= _SAME_MASTER_SECONDS:
        pick = studio[0]
        return {
            "resolution": "resolved",
            "video_id": pick.get("video_id"),
            "artist_match": match_kind,
            "title_match": title_match,
            "album": pick.get("album"),
            "duration_seconds": pick.get("duration_seconds"),
            "why": (
                f"{len(studio)} studio recordings within {_SAME_MASTER_SECONDS}s of "
                f"each other — the same master. Took "
                f"{pick.get('album') or 'the first'}; the choice does not change "
                f"what is heard, so it is not worth a question." + fold_note
            ),
            "same_master_alternatives": [
                {"video_id": r.get("video_id"), "album": r.get("album"),
                 "duration_seconds": r.get("duration_seconds")} for r in studio[1:]
            ],
        }

    # ⚠️ GENUINELY DIFFERENT RECORDINGS. Escalated WITH THE DATA TO DECIDE FROM,
    # never as a bare "ambiguous" — album and duration are what distinguishes
    # them, so they travel with the question.
    return {
        "resolution": "ambiguous_same_artist",
        "video_id": None,
        "artist_match": match_kind,
        "title_match": title_match,
        "why": (
            f"{len(studio)} studio recordings by {performing}, differing by more "
            f"than {_SAME_MASTER_SECONDS}s — genuinely different recordings, so "
            f"this is a real choice rather than a tie to break." + fold_note
        ),
        "candidates": [
            {"video_id": r.get("video_id"), "title": r.get("title"),
             "album": r.get("album"), "duration_seconds": r.get("duration_seconds"),
             "duration": r.get("duration")} for r in studio
        ],
    }



@define_tool(
    name="diff_dj_setlists",
    tier=1,
    description=(
        "Diff an artist's recent setlists against a recorded playlist body, and "
        "resolve what is missing to video ids. Read-only; writes nothing anywhere. "
        "The caller passes the RECORDED BODY (from Alfred's "
        "get_dj_managed_playlists mode=tracks) because Supabase cannot call "
        "Workshop - so the body travels to the host that can search, rather than "
        "the searches crossing a boundary. "
        "INCLUSIVE (spec 12.2): a song in ANY of the shows goes in. An extra song "
        "costs one listen; a missing song is one you do not know when the lights "
        "go down, and those are not comparable. "
        "MEDLEYS ARE SPLIT - setlist.fm records a medley as one entry joined by "
        "' / ', and treating it as a single song invents a title nobody played. "
        "RESOLUTION IS EXACT-OR-NOT-FOUND (spec 12.7) with 12.11's tie-break: the "
        "artist must MATCH, variants are dropped, two studio cuts within 2 seconds "
        "are the same master and resolve silently, and only a genuinely different "
        "recording is escalated - with album and duration attached so it can be "
        "settled without opening anything. "
        "IT REPORTS SET SHAPE, BECAUSE THE UNION IS NOT THE SET. `coverage."
        "total` unions every song across the window and no single night contains "
        "it; `set_shape.core` is what gets played EVERY night and is the "
        "denominator one show can be judged against. Below "
        "`set_shape.usable` the split is withheld rather than guessed. "
        "THE JOIN RULE, DECIDED 2026-09-09 AND STATED RATHER THAN EMERGENT: "
        "setlist songs are matched to the body BY TITLE, case- and "
        "punctuation-insensitively. The body's `artist` ANNOTATES the match and "
        "NEVER REJECTS it - dj_tracks.artist is a scraped byline (14.9), so "
        "rejecting on it would turn a data-quality problem into a wrong answer, "
        "and it would silently overrule deliberate inclusions (a Marigold bylined "
        "'Nirvana' belongs in a Foo Fighters playlist). Disagreements ship in "
        "`artist_disagreements` so the risk is visible instead of silent. Title "
        "is also the ONLY key available for this join: the setlist.fm side has no "
        "video_id, it is a name on a stage. "
        "THE BODY SIDE IS RECONCILED: `orphans` (body rows matching nothing - "
        "normal, not an error) and `body_duplicates` (one title held twice) are "
        "reported, and `body_reconciliation` sums to `body_size`. "
        "IT CANNOT SEE ARTIST-IDENTITY COLLISIONS (spec 14.4): it detects that a "
        "SEARCH returned several artists, not that two real-world acts share a "
        "name. That needs the MusicBrainz search API, and the gap is stated in "
        "every response rather than implied by silence. Tier 1."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "mbid": {
                "type": "string",
                "description": (
                    "MusicBrainz id, 8-4-4-4-12 hex, from dj_artists.mbid. "
                    "REQUIRED and the only accepted identity - a name search "
                    "matches the wrong band."
                ),
            },
            "body": {
                "type": "array",
                "description": (
                    "The RECORDED playlist body. Each entry needs `title`; "
                    "`video_id` and `artist` are carried through when present. "
                    "From Alfred's get_dj_managed_playlists mode=tracks."
                ),
                "items": {"type": "object"},
            },
            "limit": {
                "type": "integer",
                "description": (
                    "Max setlists WITH SONGS to diff against (default 10, cap 25). "
                    "Empty and upcoming setlists are skipped without consuming a "
                    "slot."
                ),
            },
            "on_date": {
                "type": "string",
                "description": (
                    "YYYY-MM-DD - diff against ONE specific show instead of the "
                    "last N. Passed straight through to get_dj_setlists' targeted "
                    "lookup; there is no second implementation here (spec 14.6). "
                    "REFUSES ANYTHING BUT AN EXACT DATE MATCH: the nearest night "
                    "of the same residency would resolve cleanly into a complete "
                    "and WRONG playlist, and nothing downstream could tell. On a "
                    "miss it raises with the nearest shows so a human can pick."
                ),
            },
            "year": {
                "type": "integer",
                "description": "Targeted lookup by year. Implied by `on_date`.",
            },
            "venue": {
                "type": "string",
                "description": (
                    "Targeted lookup by venue name. Untestable today - every "
                    "dj_concerts row has venue_id null and create_dj_concert "
                    "accepts no venue (spec 13.2, corrected)."
                ),
            },
            "resolve": {
                "type": "boolean",
                "description": (
                    "Resolve missing titles to video ids via search. Default true. "
                    "Set false for a diff-only pass that makes no search calls."
                ),
            },
        },
        "required": ["mbid", "body"],
    },
)
async def diff_dj_setlists(args: dict, ctx: Ctx) -> dict[str, Any]:
    body = args.get("body")
    if not isinstance(body, list):
        raise GuardrailError(
            "diff_dj_setlists: `body` must be an array of the RECORDED playlist's "
            "tracks. Pass an empty array only if the playlist genuinely has no "
            "recorded membership - an omitted body would make every setlist song "
            "look missing, which is a very confident wrong answer."
        )

    # ⚠️ ONE RESOLVER, ONE LOOKUP. The targeted params are PASSED THROUGH rather
    # than reimplemented here — §14.6 records a rule living in two runtimes and
    # drifting, and a second copy of the setlist fetch inside the diff would be
    # the same shape a layer down.
    inner = await get_dj_setlists(
        {
            "mbid": args.get("mbid"),
            "limit": args.get("limit"),
            "on_date": args.get("on_date"),
            "year": args.get("year"),
            "venue": args.get("venue"),
        },
        ctx,
    )
    sl = inner["data"]
    shows = sl["setlists"]

    # -----------------------------------------------------------------------
    # 🛑 A TARGETED DIFF REFUSES ANYTHING BUT AN EXACT DATE MATCH.
    # -----------------------------------------------------------------------
    # The whole point of asking for one show is that it is THAT show. Diffing
    # against the nearest night of the same residency would produce a complete,
    # plausible, wrong playlist — and every song in it would resolve cleanly, so
    # nothing further down could notice.
    lookup = sl.get("lookup") or {}
    if lookup.get("requested_date"):
        dm = lookup.get("date_match")
        if dm != "exact":
            nearest = sl.get("nearest") or []
            near_txt = "; ".join(
                f"{n.get('event_date_iso')} at {n.get('venue')} "
                f"({n.get('days_from_requested')} day(s) away, "
                f"{n.get('song_count')} songs)"
                for n in nearest[:5]
            ) or "no dated candidates in scope"
            if dm == "found_but_empty":
                raise GuardrailError(
                    f"diff_dj_setlists: setlist.fm HAS the show on "
                    f"{lookup['requested_date']} and it has NO SONGS recorded. "
                    f"That is not 'not found' and it is not something a different "
                    f"date can fix - nobody filled this one in. Nothing was "
                    f"diffed. Report it as an empty setlist and stop."
                )
            raise GuardrailError(
                f"diff_dj_setlists: no EXACT setlist for "
                f"{lookup['requested_date']} (date_match={dm}). Nothing was "
                f"diffed, deliberately: the nearest show would resolve cleanly "
                f"into a complete and wrong playlist, and nothing downstream "
                f"could tell. Nearest: {near_txt}. Show these and ask which - "
                f"do NOT pick one."
            )

    # The performing artist comes from the setlists themselves, not from the
    # caller. It is what every resolution is matched against, and a
    # caller-supplied name could disagree with the mbid it came from.
    performing = None
    for s in shows:
        if s.get("artist"):
            performing = s["artist"]
            break
    if not performing:
        raise OperationalError(
            "diff_dj_setlists: setlist.fm returned setlists carrying no artist "
            "name, so nothing can be matched against a performing artist. "
            "Resolving nothing is the safe answer here (spec 12.7)."
        )

    # -----------------------------------------------------------------------
    # 🛑 THE BODY IS INDEXED BY TITLE, KEEPING EVERY ROW — added 2026-09-09
    # -----------------------------------------------------------------------
    # The old index was a SET of titles plus a first-wins video_id map, and both
    # of those threw rows away. Three things went missing with them, all found in
    # one live Foo Fighters run: 35 body rows went in, 32 came back in `in_body`,
    # and NOTHING said what happened to the other three. They had to be found by
    # subtraction, which is not a report.
    #
    # ⚠️ FOR A TOOL WHOSE JOB IS DIFFING, ONE DIRECTION IS HALF A DIFF. The
    # setlist side was fully accounted for — every song was in_body or missing,
    # with a cause. The body side had no accounting at all.
    body_by_title: dict[str, list[dict[str, Any]]] = {}
    untitled_rows = 0
    for t in body:
        k = _norm_title(t.get("title") or "")
        if not k:
            untitled_rows += 1
            continue
        body_by_title.setdefault(k, []).append(t)
    body_titles = set(body_by_title)

    # ⚠️ THE LOOSE INDEX IS A FALLBACK, NEVER A REPLACEMENT. Exact keys win; a
    # loose key is consulted only for setlist songs the exact pass missed, and
    # first-wins so one body row cannot be claimed twice. See `_loose_key`.
    body_loose: dict[str, str] = {}
    for k in body_by_title:
        lk = _loose_key(body_by_title[k][0].get("title") or "")
        if lk and lk not in body_loose:
            body_loose[lk] = k

    # ⚠️ ADDED 2026-09-02: carry the body's video_id through to `in_body`, so
    # nothing downstream has to join these entries on TITLE.
    #
    # get_dj_managed_playlists mode=cram reports the raw dj_tracks title
    # ("Jellybelly (Remastered 2012)"); this tool reports the setlist.fm title
    # ("Jellybelly"). Both are correct for their source and they will never
    # match. §12.10 REQUIRES reading the two together — cram_complete may not be
    # printed without in_body/distinct_setlist_songs beside it — so the one join
    # the spec mandates is the one that would have failed silently on titles.
    # video_id is stable across both. Join on that, never on the title.
    body_video_by_title: dict[str, str] = {}
    for k, rows in body_by_title.items():
        for t in rows:
            if t.get("video_id"):
                body_video_by_title[k] = t["video_id"]
                break

    # Distinct across the window, first-seen order — the same show repeats its
    # act intros every night, and three names read better than ninety.
    stage_sections: list[dict[str, Any]] = []
    _seen_tape: set[str] = set()
    for show in shows:
        for t in show.get("tape_entries") or []:
            k = _norm_title(t.get("name") or "")
            if k and k not in _seen_tape:
                _seen_tape.add(k)
                stage_sections.append(t)

    # --- Fold the window into one entry per distinct song ------------------
    songs: dict[str, dict[str, Any]] = {}
    # Distinct songs at EACH show, in the same units as the union: after the
    # medley split and after tape rows are dropped. Comparing a raw song_count
    # against a normalised union would be two different countings of one set.
    distinct_per_show: list[int] = []
    for show in shows:
        seen_here: set[str] = set()
        for sg in show["songs"]:
            raw = sg["name"]
            is_medley = _MEDLEY_SEP in raw
            parts = (
                [p.strip() for p in raw.split(_MEDLEY_SEP)]
                if is_medley else [raw]
            )
            for part in parts:
                key = _norm_title(part)
                if not key:
                    continue
                # 🛑 A MEDLEY PART'S COVER STATUS IS UNKNOWN, NOT NULL, AND THE
                # DIFFERENCE IS NOT COSMETIC. setlist.fm carries ONE cover marker
                # for the whole ' / '-joined row. Copying it onto every part
                # invents an attribution for the parts it does not describe;
                # copying its absence asserts "not a cover" just as wrongly. On
                # 2026-09-02 that made the resolver explain One Headlight — a
                # Wallflowers song — as though Foo Fighters simply had no version
                # of their own. The verdict was right and the reason was invented,
                # which is the pairing that breaks when the case changes.
                e = songs.setdefault(key, {
                    "title": part,
                    # The normalised key, carried so the shape fold can test
                    # body membership without re-normalising and drifting.
                    "title_key": key,
                    "cover_of": None if is_medley else sg.get("cover_of"),
                    "cover_of_known": not is_medley,
                    "medley": is_medley,
                    # Informational: what the medley AS A WHOLE was billed as,
                    # kept because it is real data about the row even though it
                    # cannot be attributed to this part.
                    "medley_cover_marker": sg.get("cover_of") if is_medley else None,
                    "encore": False,
                    "shows": [],
                })
                if is_medley:
                    if sg.get("cover_of") and not e.get("medley_cover_marker"):
                        e["medley_cover_marker"] = sg["cover_of"]
                else:
                    # The same song standing ALONE somewhere in the window carries
                    # a real per-song marker. That is better evidence than a
                    # medley's silence, so it upgrades the entry — and the entry
                    # stops being a medley part at all.
                    e["medley"] = False
                    e["cover_of_known"] = True
                    if sg.get("cover_of") and not e["cover_of"]:
                        e["cover_of"] = sg["cover_of"]
                if sg.get("encore"):
                    e["encore"] = True
                if key not in seen_here:
                    # song_count travels WITH each appearance, because "N of 10"
                    # is not comparable across shows of different length (spec
                    # 12.3): a song in a 15-song set and one in a 27-song set are
                    # different evidence, and the denominator has to come along.
                    e["shows"].append({
                        "event_date": show["event_date"],
                        "venue": show["venue"],
                        "song_count": show["song_count"],
                        # Computed here, once, rather than left for every caller
                        # to re-derive from song_count differently.
                        "full_set": show["song_count"] >= _FULL_SET_MIN_SONGS,
                    })
                    seen_here.add(key)
        distinct_per_show.append(len(seen_here))

    # `full_set_shows` alongside the raw count, because they answer different
    # questions and only one of them is comparable across acts.
    for e in songs.values():
        e["full_set_shows"] = sum(1 for s in e["shows"] if s["full_set"])

    # -----------------------------------------------------------------------
    # SET SHAPE — how much of the union any ONE night actually contains
    # -----------------------------------------------------------------------
    n_shows = len(shows)
    typical_set = _median(distinct_per_show)
    shape_usable = n_shows >= _MIN_SHOWS_FOR_SET_SHAPE
    likely_floor = max(2, ceil(n_shows * _LIKELY_SHARE)) if shape_usable else None

    for e in songs.values():
        plays = len(e["shows"])
        e["plays_in_window"] = plays
        # ⚠️ None, NOT "rotating", when the window is too thin. A default of
        # "rotating" would be a verdict reached by having no evidence, and every
        # song would silently carry it.
        if not shape_usable:
            e["certainty"] = None
        elif plays == n_shows:
            e["certainty"] = _SET_SHAPE_CORE
        elif plays >= likely_floor:
            e["certainty"] = _SET_SHAPE_LIKELY
        else:
            e["certainty"] = _SET_SHAPE_ROTATING

    # -----------------------------------------------------------------------
    # THE JOIN — exact first, then the weaker key, and the tier is RECORDED
    # -----------------------------------------------------------------------
    # 🛑 A LOOSE MATCH IS NEVER SILENT. The article fold cannot tell "The Man"
    # from "A Man", and that residual risk is accepted by REPORTING it rather
    # than by pretending it is absent — both raw titles travel with the match so
    # a wrong join can be seen. Same contract as `artist_match`.
    in_body: list[tuple[str, dict[str, Any]]] = []
    missing: list[dict[str, Any]] = []
    loose_title_matches: list[dict[str, Any]] = []
    claimed_loose: set[str] = set()
    for k, e in songs.items():
        if k in body_titles:
            e["title_match"] = EXACT
            e["in_body"] = True
            in_body.append((k, e))
            continue
        bk = body_loose.get(_loose_key(e["title"]))
        # ⚠️ A BODY ROW IS CLAIMED ONCE. Two setlist entries can fold to the
        # same loose key ("A Song for the Dead" and "The Song for the Dead"),
        # and letting both match one row made `coverage.in_body` exceed
        # `body_size` — a playlist reported as holding more than it has.
        if bk is not None and bk not in claimed_loose and bk not in {
                kk for kk, _ in in_body}:
            claimed_loose.add(bk)
        elif bk is not None:
            bk = None
        if bk is not None:
            e["title_match"] = LOOSE
            e["in_body"] = True
            e["body_title"] = (body_by_title[bk][0].get("title") or "")
            loose_title_matches.append({
                "setlist_title": e["title"],
                "body_title": e["body_title"],
                "video_id": body_video_by_title.get(bk),
            })
            # Keyed on the BODY row's key from here on, so duplicates, artist
            # disagreement and video_id all resolve against the row that matched.
            in_body.append((bk, e))
            continue
        e["title_match"] = None
        e["in_body"] = False
        missing.append(e)

    # -----------------------------------------------------------------------
    # THE BODY SIDE OF THE DIFF — orphans, duplicates, and the artist question
    # -----------------------------------------------------------------------
    matched_keys = {k for k, _ in in_body}

    # ORPHANS: body rows matching nothing in the window. ⚠️ NOT AN ERROR AND THE
    # WORDING MUST NOT IMPLY ONE (§11.7 — a flag that fires on the normal case
    # gets ignored). A band drops songs; a playlist keeping one they have stopped
    # playing is a fine state, and for a window of recent shows it is the COMMON
    # state. Reported so it is visible rather than derived by subtraction.
    orphans = [
        {"title": (t.get("title") or ""), "video_id": t.get("video_id"),
         "artist": t.get("artist")}
        for k, rows in body_by_title.items() if k not in matched_keys
        for t in rows
    ]
    orphans.sort(key=lambda o: o["title"].lower())

    # DUPLICATES: a matched title the body holds MORE THAN ONCE. The live Foo
    # Fighters run held two Marigolds — the studio cut and the 2006 Pantages live
    # one. The setlist has a single entry, it joined the studio version, and the
    # live row simply VANISHED from the output. §12.10's duplicate-title problem,
    # in the diff rather than in cram.
    #
    # ⚠️ REPORTED, NOT JUDGED. A second cut of a song can be deliberate. This
    # says the body holds two rows under one title; it does not say remove one.
    body_duplicates = []
    duplicate_rows = 0
    for k, e in in_body:
        rows = body_by_title.get(k) or []
        if len(rows) > 1:
            duplicate_rows += len(rows) - 1
            body_duplicates.append({
                "title": e["title"],
                "body_rows": [{"title": t.get("title"), "artist": t.get("artist"),
                               "video_id": t.get("video_id")} for t in rows],
                "joined_video_id": body_video_by_title.get(k),
            })

    # -----------------------------------------------------------------------
    # 🛑 DECIDED 2026-09-09: TITLE JOINS. ARTIST ANNOTATES. ARTIST NEVER REJECTS.
    # -----------------------------------------------------------------------
    # This was EMERGENT rather than chosen, which is why it is written down here
    # and in the tool's own description. A body row attributed to "Nirvana"
    # joined a Foo Fighters setlist entry for Marigold and nothing said so. The
    # OUTCOME was right — Grohl wrote it and the row is there deliberately — but
    # a rule that happens to be right is not a rule.
    #
    # ⚠️ THERE IS NO ARTIST-FREE ALTERNATIVE KEY HERE. Elsewhere this tool insists
    # on joining by video_id and never by title; that is possible because both
    # sides are YouTube rows. The setlist.fm side has NO video_id — it is a name
    # on a stage. Title is the only key that exists for this particular join, and
    # saying so removes the apparent contradiction with the `in_body` note.
    #
    # WHY ARTIST DOES NOT REJECT, given §12.2 says a false ACCEPT is the worse
    # error (a song he does not know when the lights go down, against one extra
    # listen):
    #
    #   1. `dj_tracks.artist` IS A SCRAPED BYLINE (§14.9) — the weakest field in
    #      the body. Rejecting on the weakest available evidence converts a data
    #      quality problem into a wrong answer.
    #   2. REJECTING OVERRULES A DELIBERATE HUMAN CHOICE SILENTLY. The Marigold
    #      row would land in `missing` with no hint that a track already in the
    #      playlist had been called missing — a wrong answer with no visible
    #      cause, which is worse than either error §12.2 weighs.
    #   3. THE ACTUAL DEFECT WAS THE SILENCE, NOT THE JOIN. With the disagreement
    #      reported, §12.2's false-accept risk stops being invisible, which is
    #      the property that made it dangerous.
    #
    # ⚠️ IT IS A GOOD FLAG BECAUSE IT IS RARE: one row in 32 on the live run.
    # A per-row annotation that fired on every row would be §11.7 noise.
    # ⚠️ PER ROW, NOT PER TITLE — and `any` would have been the wrong quantifier.
    # The body holds TWO Marigolds. The studio cut is a Nirvana B-side (Grohl
    # wrote and sang it) and is bylined "Nirvana"; the 2006 Pantages live cut is
    # a Foo Fighters release. Under `any(agrees)` the Foo Fighters row would
    # SUPPRESS the flag on the Nirvana row — silencing the exact disagreement
    # this block exists to show. A title agrees only when EVERY named row does.
    artist_disagreements: list[dict[str, Any]] = []
    for k, e in in_body:
        rows = body_by_title.get(k) or []
        named = [t for t in rows if (t.get("artist") or "").strip()]
        if not named:
            # No byline at all is UNKNOWN, not disagreement. Saying "artist
            # differs" about an absent field invents a conflict.
            e["body_artist_agrees"] = None
            e["body_artist"] = None
            continue
        disagreeing = [t for t in named
                       if not _artist_matches([t.get("artist")], performing)]
        e["body_artist_agrees"] = not disagreeing
        e["body_artist"] = named[0].get("artist")
        for t in disagreeing:
            artist_disagreements.append({
                "title": e["title"],
                "body_artist": t.get("artist"),
                "performing": performing,
                # The DISAGREEING row's own id, not the title's joined id — the
                # caller needs to find the row being talked about.
                "video_id": t.get("video_id"),
            })

    # ⚠️ THE ARITHMETIC CLOSES IN THE PAYLOAD, so nobody subtracts to find out
    # what happened to a row. Asserted by test: these four sum to `body_size`.
    body_reconciliation = {
        "body_size": len(body),
        "matched_titles": len(in_body),
        "duplicate_rows": duplicate_rows,
        "orphan_rows": len(orphans),
        "untitled_rows": untitled_rows,
    }
    # Sort on FULL SETS first. A song at four promo spots outranking one played
    # at every stadium show is the ordering the raw count produced, and it put
    # the weakest evidence at the top of the list a human reads first.
    missing.sort(key=lambda e: (-e["full_set_shows"], -len(e["shows"]),
                                e["title"].lower()))

    # --- Resolve what is missing -------------------------------------------
    searches = 0
    if args.get("resolve", True):
        for e in missing:
            raw = await _call(
                ctx.config.host_id,
                "search",
                query=f"{performing} {e['title']}",
                filter="songs",
                limit=10,
            ) or []
            searches += 1
            results = [{
                "video_id": r.get("videoId"),
                "title": r.get("title"),
                "artists": [a.get("name") for a in (r.get("artists") or [])
                            if a.get("name")],
                "album": (r.get("album") or {}).get("name")
                         if isinstance(r.get("album"), dict) else r.get("album"),
                "duration_seconds": r.get("duration_seconds"),
                "duration": r.get("duration"),
            } for r in raw]
            e.update(_resolve_one(
                results, e["title"], performing,
                cover_of_known=e["cover_of_known"],
            ))
    else:
        for e in missing:
            e.update({"resolution": "not_attempted", "video_id": None})

    counts: dict[str, int] = {}
    cause_counts: dict[str, int] = {}
    for e in missing:
        counts[e["resolution"]] = counts.get(e["resolution"], 0) + 1
        cause = e.get("not_found_cause")
        if cause:
            cause_counts[cause] = cause_counts.get(cause, 0) + 1

    # ----------------------------------------------------------------------
    # COVERAGE, WITH THE UNCLOSEABLE GAPS TAKEN OUT OF THE DENOMINATOR
    # ----------------------------------------------------------------------
    # 🛑 `in_body / distinct_setlist_songs` IS THE FIGURE §12.10 REQUIRES BESIDE
    # EVERY `cram_complete`, AND ON ITS OWN IT UNDERSTATES. Foo Fighters read
    # 27/40 on 2026-09-02 while six of the thirteen gaps were medley parts with
    # no studio recording and two were songs only other artists have recorded.
    # Eight of those forty could never be in the playlist however much anyone
    # wanted them there.
    #
    # ⚠️ BOTH NUMBERS SHIP, AND NEITHER REPLACES THE OTHER. `total` is what he
    # will hear on the night — the honest denominator for "do I know this set".
    # `gettable` is what the playlist could ever contain — the honest denominator
    # for "is the playlist finished". Reporting only `gettable` would quietly
    # improve the number by redefining the show.
    #
    # ⚠️ variant_only IS DELIBERATELY NOT SUBTRACTED. Mayonaise is a real gap
    # with a real decision behind it; folding it into "unobtainable" would hide
    # the only kind of not_found that anyone can act on.
    uncloseable = sum(cause_counts.get(c, 0) for c in _UNCLOSEABLE_CAUSES)
    gettable = len(songs) - uncloseable

    # -----------------------------------------------------------------------
    # THE SET SHAPE BLOCK — the denominator a single night can actually reach
    # -----------------------------------------------------------------------
    core_entries = [e for e in songs.values() if e["certainty"] == _SET_SHAPE_CORE]
    likely_entries = [e for e in songs.values() if e["certainty"] == _SET_SHAPE_LIKELY]

    def _brief(entries):
        # ⚠️ READS THE JOIN'S OWN VERDICT (`e["in_body"]`), never re-tests
        # membership. Re-testing with `title_key in body_titles` is the EXACT
        # key, so a loose match reported "not held" while the join had already
        # matched it — one question answered two ways, §14.6 inside one function.
        return [
            {"title": e["title"], "plays_in_window": e["plays_in_window"],
             "in_body": e["in_body"]}
            for e in sorted(entries, key=lambda x: (-x["plays_in_window"],
                                                    x["title"].lower()))
        ]

    if shape_usable:
        core_in_body = sum(1 for e in core_entries if e["in_body"])
        set_shape = {
            "usable": True,
            "shows_in_window": n_shows,
            "typical_set": typical_set,
            "union_total": len(songs),
            # 🛑 THE NUMBER TO QUOTE. `core_in_body / core_total` is what one
            # night can be judged against; `in_body / union_total` is a score out
            # of a total no single show contains.
            "core_in_body": core_in_body,
            "core_total": len(core_entries),
            "core": _brief(core_entries),
            "likely": _brief(likely_entries),
            "likely_floor_plays": likely_floor,
            "rotating_count": len(songs) - len(core_entries) - len(likely_entries),
        }
    else:
        # ⚠️ NOT REPORTED, rather than reported with a caveat. See the note above
        # _MIN_SHOWS_FOR_SET_SHAPE: at three shows roughly two songs land in the
        # "core" by chance alone, and a wrong certainty is worse than none.
        set_shape = {
            "usable": False,
            "shows_in_window": n_shows,
            "typical_set": typical_set,
            "union_total": len(songs),
            "why_not": (
                f"{n_shows} show(s) in the window; {_MIN_SHOWS_FOR_SET_SHAPE} are "
                f"needed before 'played at every show' is evidence rather than "
                f"coincidence. At three shows roughly two songs qualify by chance. "
                f"NO core/likely/rotating split is reported and every song's "
                f"`certainty` is null - raise `limit` to get one."
            ),
        }

    return {
        "data": {
            "artist": performing,
            "mbid": sl["mbid"],
            "window": [
                {"event_date": s["event_date"], "venue": s["venue"],
                 "song_count": s["song_count"], "tour": s.get("tour"),
                 "full_set": s["song_count"] >= _FULL_SET_MIN_SONGS}
                for s in shows
            ],
            "shows_read": sl["returned"],
            # ⚠️ NOT A COUNT ALONE. `stage_sections` names what was demoted so
            # the reader can see the skip was right; `distinct_setlist_songs`
            # below no longer includes them, and without the names that drop
            # would be invisible arithmetic.
            "stage_sections": stage_sections,
            "stage_sections_skipped": len(stage_sections),
            "full_sets_read": sum(
                1 for s in shows if s["song_count"] >= _FULL_SET_MIN_SONGS),
            # In the payload, never in prose, and named so it can be argued with.
            "full_set_min_songs": _FULL_SET_MIN_SONGS,
            "empty_entries_skipped": sl["empty_entries_skipped"],
            "body_size": len(body),
            "distinct_setlist_songs": len(songs),
            "set_shape": set_shape,
            "coverage": {
                "in_body": len(in_body),
                "total": len(songs),
                "gettable": gettable,
                "uncloseable": uncloseable,
                "uncloseable_by_cause": {
                    c: cause_counts[c] for c in _UNCLOSEABLE_CAUSES
                    if c in cause_counts
                },
            },
            "in_body": [
                # video_id travels so callers join on it rather than on title.
                {"title": e["title"], "shows": len(e["shows"]),
                 "full_set_shows": e["full_set_shows"],
                 "video_id": body_video_by_title.get(k),
                 # null = the body row carried no byline, which is UNKNOWN and
                 # not disagreement. See the decision note above the join.
                 "body_artist_agrees": e.get("body_artist_agrees"),
                 "body_artist": e.get("body_artist"),
                 # "exact" or "loose" — see loose_title_matches.
                 "title_match": e.get("title_match"),
                 "body_title": e.get("body_title")}
                for k, e in sorted(
                    in_body, key=lambda kv: (-kv[1]["full_set_shows"],
                                             -len(kv[1]["shows"])))
            ],
            # THE BODY SIDE OF THE DIFF. Added 2026-09-09 — before this, 35 rows
            # in and 32 out, with the other three findable only by subtraction.
            "body_reconciliation": body_reconciliation,
            # ⚠️ EVERY WEAKER-KEY JOIN, NAMED. An empty list is the claim that
            # every match was exact; a non-empty one is where to look first if a
            # song was joined that should not have been.
            "loose_title_matches": loose_title_matches,
            "orphans": orphans,
            "body_duplicates": body_duplicates,
            "artist_disagreements": artist_disagreements,
            "missing": missing,
            "resolution_counts": counts,
            "not_found_causes": cause_counts,
            "searches_made": searches,
            "reading": (
                "INCLUSIVE (12.2): a song in ANY show counts as missing if the "
                "body lacks it. Each entry's `shows` carries that show's "
                "`song_count`, because a bare 'N of 10' hides that a 15-song set "
                "and a 27-song set are different evidence (12.3) - quote the shape "
                "or say it in words: 'only at the Hollywood Bowl show' rather than "
                "'1 of 10'. "
                "⚠️ QUOTE `full_set_shows`, NOT `shows`, WHEREVER ONE "
                "NUMBER HAS TO STAND ALONE. A show counts as a full set at "
                "`full_set_min_songs` songs or more. §12.3 decided promo "
                "appearances COUNT and they still do - this labels them, it "
                "excludes nothing. (THE OBSERVATION THAT CAUSED THE RULE, kept "
                "as history and not as a current figure: on 2026-09-02, six of "
                "ten Weezer shows in the window were 1-6 song television and "
                "radio spots, so 'We Might as Well Be Strangers, 4 shows' was "
                "three TV appearances and one concert.) `missing` is now sorted "
                "by full sets first for the same reason. "
                "🛑 QUOTE `set_shape.core_in_body / core_total`, NOT "
                "`coverage.in_body / total`, WHENEVER THE QUESTION IS WHETHER "
                "THE PLAYLIST IS READY FOR ONE NIGHT. `coverage.total` is the "
                "UNION over the whole window - every song played at ANY show - "
                "and NO SINGLE NIGHT CONTAINS IT. A QOTSA playlist read 5/28 and "
                "looked badly incomplete while holding FOUR OF THE FIVE songs "
                "played at every show in the window; the honest report was '4 of "
                "5 certainties, add A Song for the Dead'. ⚠️ THIS IS NOT A "
                "SUPPORT-SLOT PROBLEM - the union of ten headline nights exceeds "
                "any one of them too. "
                "`core` = played at EVERY show, so near-certain to be heard. "
                "`likely` = played at most of them. `rotating` is the rest, and "
                "adding it is a lottery rather than a gap. Each `missing` entry "
                "carries `certainty` and `plays_in_window` so a proposal can lead "
                "with the certainties. "
                "🛑 IF `set_shape.usable` IS FALSE THERE IS NO SPLIT AND YOU MUST "
                "NOT INVENT ONE - `why_not` says how many shows are needed and "
                "why. Below that floor 'played at every show' is coincidence, so "
                "`certainty` is null on every song. Raise `limit` or say the "
                "window is too thin; do NOT fall back to the union and call it "
                "coverage. "
                "🛑 `coverage` CARRIES TWO DENOMINATORS AND NEITHER "
                "REPLACES THE OTHER. `total` is every distinct song in the window "
                "- what he will actually hear, and the right denominator for 'do I "
                "know this set'. `gettable` subtracts the gaps NO decision can "
                "close (medley parts, songs only other artists have recorded, "
                "titles YouTube Music does not have) - the right denominator for "
                "'is this playlist finished'. 🛑 QUOTE THE `coverage` BLOCK IN "
                "THIS RESPONSE AND NOTHING ELSE - THIS TEXT DELIBERATELY CARRIES "
                "NO EXAMPLE NUMBERS. A worked pair was frozen here on 2026-09-02 "
                "and was WRONG BY 2026-09-09 because five tracks had been added "
                "to the playlist since, and it shipped inside every response the "
                "tool returned. A constant that describes changing data is a "
                "stale fact with a long reach. "
                "Report `total` beside any "
                "cram_complete (§12.10); report `gettable` when the question "
                "is whether to add anything. "
                "⚠️ `not_found_cause` CLASSIFIES EVERY not_found, so "
                "nobody has to parse `why` prose to tell a dead end from a "
                "decision: medley_part | other_artists_only | no_such_title are "
                "structural and uncloseable; variant_only is a JUDGEMENT - the "
                "artist has the song and only a studio cut is missing, so it "
                "ships `variant_candidates` and `recommended_video_id` (§12.11: "
                "never escalate without a recommendation and a way to resolve it). "
                "(Mayonaise WAS that case on 2026-09-02 - a past observation, not "
                "a current count; check this run's own numbers.) "
                "⚠️ `title_match: \"loose\"` MEANS THE TITLES DIFFER AND WERE "
                "FOLDED - setlist.fm's \"A Song for the Dead\" against YouTube "
                "Music's \"Song For The Dead\". Only the leading article and an "
                "apostrophe-marked elided -g are folded; both raw titles ship in "
                "`loose_title_matches` so a wrong join can be seen. It is not an "
                "error and does not need reporting unless one looks wrong. "
                "🛑 `other_artists_only` MEANS 'NO RETURNED ROW CARRIES THIS "
                "ARTIST'S BYLINE' - IT DOES NOT MEAN 'THEY NEVER RECORDED IT'. It "
                "CANNOT distinguish a genuine cover from a MIS-BYLINED ORIGINAL, "
                "and a compilation stamping one artist across every track is an "
                "ordinary metadata error. Report it as 'only other artists have "
                "this title - worth a listen before writing it off', never as "
                "settled. `other_artists_found` carries the rows and "
                "`by_performing_artist_in_results` says how many rows DID carry "
                "the act's byline under other titles - many makes 'they do not "
                "have it' better supported, none makes the byline hypothesis more "
                "live. ⚠️ ONLY LISTENING SETTLES IT. "
                "⚠️ `near_titles_by_artist` IS SCOPED TO TITLES AND ITS SILENCE IS "
                "NOT CLEARANCE - it cannot see a row whose title is right and "
                "whose byline is wrong, which is exactly the case above. "
                "🛑 `near_titles_by_artist` ON A not_found IS THE VERDICT'S OWN "
                "CONTRADICTION. It lists the PERFORMING artist's tracks with "
                "close-but-unequal titles. IF IT IS NON-EMPTY, DO NOT REPORT THE "
                "SONG AS UNOBTAINABLE - the cause is almost certainly a spelling, "
                "and a 'Hangin' Tree' once came back as covers-only while the "
                "act's own 'Hanging Tree' sat in the same result list. "
                "🛑 THE BODY SIDE IS REPORTED TOO, AND `body_reconciliation` "
                "MUST SUM: matched_titles + duplicate_rows + orphan_rows + "
                "untitled_rows = body_size. Nobody should ever subtract to find "
                "out what happened to a row. "
                "`orphans` are body rows matching NOTHING in the window - ⚠️ NOT "
                "AN ERROR, and do not report them as one: a band drops songs, and "
                "keeping one they have stopped playing is a normal state. State "
                "the count; name them only if asked. "
                "`body_duplicates` are titles the body holds MORE THAN ONCE - the "
                "join takes one row and the others would otherwise vanish. "
                "REPORTED, NOT JUDGED: a second cut can be deliberate. "
                "🛑 `artist_disagreements` - THE JOIN RULE IS: TITLE JOINS, "
                "ARTIST ANNOTATES, ARTIST NEVER REJECTS. A body row whose byline "
                "is a different act still counts as present, because "
                "dj_tracks.artist is a SCRAPED BYLINE (§14.9) and rejecting on "
                "the weakest field turns bad data into a wrong answer - a "
                "Marigold row bylined 'Nirvana' is in a Foo Fighters playlist "
                "deliberately. ⚠️ THE DISAGREEMENT IS REPORTED SO THE §12.2 "
                "FALSE-ACCEPT RISK IS NOT SILENT: if one of these really is a "
                "different act's song, the setlist song is NOT in the playlist "
                "and this list is the only place that shows it. "
                "`body_artist_agrees: null` means the row carried no byline - "
                "UNKNOWN, not disagreement. "
                "⚠️ `in_body` CARRIES `video_id`. JOIN ON IT, NEVER ON "
                "TITLE - get_dj_managed_playlists mode=cram reports the raw "
                "dj_tracks title ('Jellybelly (Remastered 2012)') and this tool "
                "reports setlist.fm's ('Jellybelly'). Both are right for their "
                "source and they will never match, and §12.10 requires reading "
                "the two together. "
                "`medley: true` means the entry was one ' / '-joined setlist.fm "
                "row split into parts; those parts frequently have no studio "
                "recording at all, and NOT FOUND is the correct answer for them "
                "rather than a gap to chase. "
                "⚠️ `cover_of_known: false` accompanies EVERY medley part and it is "
                "not a null cover - setlist.fm records ONE cover marker for the "
                "whole medley row, so whether a given part was the act's own song "
                "or somebody else's IS NOT IN THE SOURCE. Do not report a medley "
                "part as 'they have no version of it'; the honest line is that the "
                "part has no studio recording. `medley_cover_marker` carries what "
                "the medley as a whole was billed as, which is real data about the "
                "row and still not an attribution for the part. "
                "`cover_of` is informational - resolution targets the PERFORMING "
                "artist's version (12.4), and if YouTube Music has not got it then "
                "it is not in the playlist. "
                "⚠️ `artist_match` is 'exact' or 'article_insensitive'. The second "
                "means the act matched only after dropping a leading 'The' - "
                "setlist.fm and YouTube Music disagree about it - and it WIDENS the "
                "artist-identity collision surface named below. It is reported on "
                "every resolution rather than folded away silently."
            ),
            "limits": (
                "ARTIST-IDENTITY COLLISIONS ARE NOT DETECTABLE HERE (spec 14.4). "
                "This tool can tell that a search returned several ARTISTS; it "
                "cannot tell that two real-world acts share one name. The "
                "2026-09-01 mbid backfill caught three such near-misses - Paul "
                "Di'Anno's Killers, a Liverpool Ed Sheeran, Skellern's Oasis - by "
                "corroboration rather than by seeing candidates, and a "
                "verification that succeeds by corroboration cannot report how "
                "close it came to failing. A route to the MusicBrainz search API "
                "is needed before anything resolves an artist BY NAME."
            ),
        },
        "meta": {},
    }
