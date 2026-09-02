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
                # ⚠️ ADDED FOR diff_dj_setlists, which matches every search result
                # against the PERFORMING artist (spec §12.7). Taken from the
                # setlist rather than from the caller: a caller-supplied name
                # could disagree with the mbid it was looked up by, and then
                # every resolution would be matched against the wrong act.
                "artist": (entry.get("artist") or {}).get("name"),
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
_MEDLEY_SEP = " / "

# Two recordings within this many seconds of each other are the same master
# (spec §12.11 rule 3). Measured against the real case: Razor is 4:54 on
# In Your Honor and 4:53 on Catch And Release.
_SAME_MASTER_SECONDS = 2

# Variant markers. A live or acoustic cut is not the studio recording, and the
# setlist entry is never asking for one.
_VARIANT_RE = re.compile(
    r"\b(live|acoustic|remix|karaoke|instrumental|demo|radio edit|"
    r"session|cover|tribute|originally performed)\b",
    re.IGNORECASE,
)

_PAREN_RE = re.compile(
    r"\s*[\(\[](?:live|acoustic|remaster(?:ed)?|remix|mono|stereo|single|album)"
    r"[^\)\]]*[\)\]]",
    re.IGNORECASE,
)
_TAIL_RE = re.compile(r"\s*-\s*(?:live|acoustic|remaster(?:ed)?).*$", re.IGNORECASE)
_PUNCT_RE = re.compile(r"[^a-z0-9 ]+")


def _norm_title(title: str) -> str:
    """Fold a title to something two sources can be compared on.

    Deliberately conservative: it strips VARIANT decoration, not content. An
    aggressive normaliser would merge two genuinely different songs, and this
    feeds a diff whose false negatives cost one listen while its false positives
    cost a song Alex does not know when the lights go down (spec §12.2).
    """
    t = unicodedata.normalize("NFKD", title or "").lower()
    t = _PAREN_RE.sub(" ", t)
    t = _TAIL_RE.sub(" ", t)
    t = t.replace("&", " and ")
    t = _PUNCT_RE.sub(" ", t)
    return " ".join(t.split())


def _artist_matches(result_artists: list[str], performing: str) -> bool:
    """Is this search result BY the act that played it?

    ⚠️ MATCHED, NOT MERELY NOTICED (spec §12.7). A result whose artist does not
    match is a NON-match however well the title fits — that is the rule that
    kept the Takeout repair safe, and one search for "Happy Together" returned
    six different recordings.
    """
    want = _norm_title(performing)
    return any(_norm_title(a) == want for a in result_artists)


def _resolve_one(results: list[dict], title: str, performing: str) -> dict:
    """Apply spec §12.11's tie-break to one song's search results.

    Returns a `resolution` the caller can act on WITHOUT re-deriving anything:
    resolved | not_found | ambiguous_same_artist | ambiguous_multi_artist.
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

    if not titled:
        return {
            "resolution": "not_found",
            "video_id": None,
            "why": (
                f"Nothing titled {title!r} came back. Search returned "
                f"{len(results)} result(s), all with other titles — YouTube "
                f"answers a query it cannot match with the artist's popular "
                f"tracks, so a long result list here means NO match rather than "
                f"a choice."
            ),
            "other_artists_found": [],
        }

    by_artist = [r for r in titled if _artist_matches(r.get("artists") or [], performing)]

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
        return {
            "resolution": "not_found",
            "video_id": None,
            "why": (
                f"{len(titled)} result(s) titled {title!r}, none by {performing}. "
                f"Found instead: {', '.join(names[:4])}. Their version is what "
                f"goes in the playlist (spec 12.4); if it does not exist, the "
                f"song does not."
            ),
            "other_artists_found": others,
        }

    studio = [r for r in by_artist if not _VARIANT_RE.search(r.get("title") or "")]
    if not studio:
        return {
            "resolution": "not_found",
            "video_id": None,
            "why": (
                f"{performing} has results for this title but every one is a live, "
                f"acoustic or otherwise variant cut. The setlist entry is not "
                f"asking for a variant."
            ),
            "other_artists_found": [],
        }

    if len(studio) == 1:
        r = studio[0]
        return {"resolution": "resolved", "video_id": r.get("video_id"),
                "album": r.get("album"), "duration_seconds": r.get("duration_seconds"),
                "why": "One studio recording by the performing artist."}

    # Several studio cuts by the right artist. Rule 3: within two seconds is the
    # same master, so the choice does not matter and must not be escalated.
    durs = [r.get("duration_seconds") for r in studio if r.get("duration_seconds")]
    if durs and (max(durs) - min(durs)) <= _SAME_MASTER_SECONDS:
        pick = studio[0]
        return {
            "resolution": "resolved",
            "video_id": pick.get("video_id"),
            "album": pick.get("album"),
            "duration_seconds": pick.get("duration_seconds"),
            "why": (
                f"{len(studio)} studio recordings within {_SAME_MASTER_SECONDS}s of "
                f"each other — the same master. Took "
                f"{pick.get('album') or 'the first'}; the choice does not change "
                f"what is heard, so it is not worth a question."
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
        "why": (
            f"{len(studio)} studio recordings by {performing}, differing by more "
            f"than {_SAME_MASTER_SECONDS}s — genuinely different recordings, so "
            f"this is a real choice rather than a tie to break."
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

    inner = await get_dj_setlists(
        {"mbid": args.get("mbid"), "limit": args.get("limit")}, ctx
    )
    sl = inner["data"]
    shows = sl["setlists"]

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

    body_titles = {_norm_title(t.get("title") or "") for t in body}
    body_titles.discard("")

    # --- Fold the window into one entry per distinct song ------------------
    songs: dict[str, dict[str, Any]] = {}
    for show in shows:
        seen_here: set[str] = set()
        for sg in show["songs"]:
            raw = sg["name"]
            parts = (
                [p.strip() for p in raw.split(_MEDLEY_SEP)]
                if _MEDLEY_SEP in raw else [raw]
            )
            for part in parts:
                key = _norm_title(part)
                if not key:
                    continue
                e = songs.setdefault(key, {
                    "title": part,
                    "cover_of": sg.get("cover_of"),
                    "medley": len(parts) > 1,
                    "encore": False,
                    "shows": [],
                })
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
                    })
                    seen_here.add(key)

    in_body = [e for k, e in songs.items() if k in body_titles]
    missing = [e for k, e in songs.items() if k not in body_titles]
    missing.sort(key=lambda e: (-len(e["shows"]), e["title"].lower()))

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
            e.update(_resolve_one(results, e["title"], performing))
    else:
        for e in missing:
            e.update({"resolution": "not_attempted", "video_id": None})

    counts: dict[str, int] = {}
    for e in missing:
        counts[e["resolution"]] = counts.get(e["resolution"], 0) + 1

    return {
        "data": {
            "artist": performing,
            "mbid": sl["mbid"],
            "window": [
                {"event_date": s["event_date"], "venue": s["venue"],
                 "song_count": s["song_count"], "tour": s.get("tour")}
                for s in shows
            ],
            "shows_read": sl["returned"],
            "empty_entries_skipped": sl["empty_entries_skipped"],
            "body_size": len(body),
            "distinct_setlist_songs": len(songs),
            "in_body": [
                {"title": e["title"], "shows": len(e["shows"])}
                for e in sorted(in_body, key=lambda e: -len(e["shows"]))
            ],
            "missing": missing,
            "resolution_counts": counts,
            "searches_made": searches,
            "reading": (
                "INCLUSIVE (12.2): a song in ANY show counts as missing if the "
                "body lacks it. Each entry's `shows` carries that show's "
                "`song_count`, because a bare 'N of 10' hides that a 15-song set "
                "and a 27-song set are different evidence (12.3) - quote the shape "
                "or say it in words: 'only at the Hollywood Bowl show' rather than "
                "'1 of 10'. "
                "`medley: true` means the entry was one ' / '-joined setlist.fm "
                "row split into parts; those parts frequently have no studio "
                "recording at all, and NOT FOUND is the correct answer for them "
                "rather than a gap to chase. "
                "`cover_of` is informational - resolution targets the PERFORMING "
                "artist's version (12.4), and if YouTube Music has not got it then "
                "it is not in the playlist."
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
