"""Phase 6b bulk playlist import — YouTube membership into Supabase.

WHY A SCRIPT
------------
41 playlist rows were recorded with no membership. Filling ~1,500 tracks across
34 playlists through a conversation costs roughly a quarter of a million tokens
AND makes the model the transport — which is how a video_id gets corrupted into
a row that insert-only tables cannot take back. Same argument as the Takeout
import, same shape of answer.

WHAT IT DOES NOT DO
-------------------
⚠️ IT REIMPLEMENTS NOTHING. It calls Workshop's real ``read_playlist_contents``
for the read — the same function ``get_dj_playlists`` calls, so the projection
(video_id, set_video_id, position) is byte-identical to what every other caller
sees — and POSTs to ``/mcp/import-playlist``, which calls the real
``record_dj_playlist_bulk`` for the write. Only the CEILINGS differ between the
two paths, because a cap that bounds a model's context has no work to do here. A script that built its own track dicts would agree with the tools right
up until it didn't, and dj_tracks is insert-only.

THE FIVE RULES THIS ENFORCES
----------------------------
1. THE READ CAP IS SILENT. ``get_dj_playlists mode=contents`` has no offset
   and no cursor: a 223-track playlist returns 200 rows, reports no error, and
   looks exactly like a complete read. So the LIBRARY count is carried alongside
   the READ count and the server refuses any playlist where they disagree.
   Over-cap playlists are SKIPPED and reported as skipped — never recorded
   partially. A partial body is worse than no body: §12's weekly diff would
   compare setlists against a playlist that silently isn't the playlist.
   ⚠️ The 200 was OURS, not YouTube's — measured 2026-09-01. This path now reads
   at CONTENTS_BULK_CAP (400) and writes through record_dj_playlist_bulk (500).
   The cap still EXISTS on both, so a playlist above it is still skipped.

2. set_video_id IS NOT AN IDENTITY. Live data confirmed spec §5's warning — two
   playlists were found holding the SAME handle string for DIFFERENT songs. This
   script keys on nothing but POSITION, and passes set_video_id through as the
   opaque cache it is.

3. CONCERT LINKS ARE NEVER MENTIONED. concert_id is deliberately omitted from
   every payload, so record_dj_playlist leaves the stored link untouched. (Until
   2026-09-01 that would have NULLed all 19 of them — see step 0.)

4. EVERY PLAYLIST REPORTS library / read / written, and a mismatch is a STOP.

5. IT PACES ITSELF UNDER THE PLATFORM CALL BUDGET. The first confirm run died at
   playlist 23 of 35 because it did not. See the Pacing section below - the
   short version is that the budget is per-user and SHARED with any open Claude
   conversation, and the rolling window does not start empty.

THE ONE CREDENTIAL
------------------
A Supabase USER JWT, pasted as --token. Same token and same source as
scripts/dj-import-takeout.ps1 — there is no .env to fill in, no anon key, and no
service-role key anywhere near this. Copy it from the browser console with the
Alfred tab open and signed in:

    for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i);
      if(/^sb-.*-auth-token$/.test(k)){const v=JSON.parse(localStorage.getItem(k));
      copy(v.access_token||v.currentSession.access_token);console.log('copied');}}

⚠️ IT EXPIRES, TYPICALLY IN AN HOUR. An expired token surfaces as a 401 partway
through the run, which reads like a data problem and is not one — batches 30 and
32 of the Takeout import burned a day on exactly that. If a run fails partway,
re-copy the token before assuming anything about the data.

USAGE, from the workshop/ directory
-----------------------------------
    python scripts/dj_import_playlists.py --plan     --token "<paste>"
    python scripts/dj_import_playlists.py --dry-run  --token "<paste>"
    python scripts/dj_import_playlists.py --confirm  --token "<paste>"
    python scripts/dj_import_playlists.py --dry-run  --token "<paste>" --only PLxxxx
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workshop.tools.dj import (  # noqa: E402  (after sys.path)
    CONTENTS_BULK_CAP,
    get_dj_playlists,
    read_playlist_contents,
)

# ⚠️ EMPTY SINCE 2026-09-01, AND KEPT ANYWAY. General Running (223) and Elise's
# fun list (379) lived here while the 200 read cap was thought to be YouTube's.
# It was OURS: ytmusicapi paginates internally and returns 379 when asked for
# 400. Pagination was never needed.
#
# The mechanism stays because library sizes grow and CONTENTS_BULK_CAP is a real
# ceiling — a playlist above it must still be skipped rather than recorded in
# part, since a partial body is worse than no body.
OVER_CAP: dict[str, tuple[str, int]] = {}

# Already imported by hand in a Claude thread. Re-recording them would be
# harmless but would muddy the per-playlist report with rows nothing here wrote.
ALREADY_DONE = {
    "PLV2XoCH1Pv5xMG_EwhdEWQmtB8v2iSinb": "Smashing Pumpkins Concert",
    "PLV2XoCH1Pv5z8bOFAhklFLLcEctVkhzPY": "Motley Crue Concert",
    "PLV2XoCH1Pv5y4eryZrOdxG2XlSxfdW32l": "Foo Fighters Concert",
    "PLGhCMggoJnIc": "Weezer Concert 2026",
}

# ⚠️ A LEGITIMATE EMPTY IS A SUCCESS, NOT A SKIP. The Weeknd holds 0 tracks on
# YouTube — screening was started and abandoned, which is what `rejected` with
# no playlist body means. Recording it with zero tracks is the CORRECT outcome,
# and it must not be reported as a failure or quietly dropped: "0 because the
# playlist is empty" and "0 because something went wrong" are different answers
# and the report has to tell them apart.
KNOWN_EMPTY = {"PLV2XoCH1Pv5x7MvkG-37oG9P_NTAp1_TO": "The Weeknd Concert"}


# ---------------------------------------------------------------------------
# Pacing
# ---------------------------------------------------------------------------
#
# 🛑 THE FIRST CONFIRM RUN DIED AT PLAYLIST 23 OF 35 ON THE PLATFORM CALL BUDGET.
# 23 written cleanly, 12 blocked, nothing partial — the guard did exactly the
# right thing and named its own limit. The SCRIPT was wrong: a bulk importer
# that exceeds the platform's own rate limit by design can never complete a run.
#
# ⚠️ THE LIMIT IS NOT DEFINED HERE, AND MUST NOT BE. It lives in
# platform.check_call_budget in the database, which is the queryable authority
# (spec §11.17). What is written here is a TARGET BELOW IT, and the gap is
# deliberate for two reasons:
#
#   1. THE BUDGET IS PER-USER AND SHARED. Any Claude conversation open while
#      this runs spends from the same window. A script pacing at exactly the
#      limit would push interactive use over it — the import would succeed by
#      making everything else fail.
#   2. THE WINDOW IS ROLLING AND DOES NOT START EMPTY. The dry run minutes
#      earlier still occupies it. Starting a fresh process does not reset it,
#      which is why "sprint until refused" fails at an unpredictable playlist
#      rather than a calculable one.
#
# Observed 2026-09-01: 60 calls per 300 seconds, ~2 platform calls per playlist.
# The default below targets roughly two thirds of that and leaves the rest for
# whatever else is talking to Alfred.
DEFAULT_SECONDS_BETWEEN = 15.0


class Pacer:
    """Even spacing between calls, rather than a burst-then-block window.

    Even spacing is chosen over a token bucket on purpose: a bucket lets the
    script sprint through the first N playlists and then stall, which is both
    slower to diagnose and harder to reason about when the window was already
    partly consumed by something else. A steady interval means this script's
    contribution to the rolling window is the same no matter when it starts.
    """

    def __init__(self, seconds_between: float) -> None:
        self.interval = seconds_between
        self.last = 0.0
        self.slept = 0.0

    def wait(self) -> None:
        if self.interval <= 0:
            return
        gap = time.monotonic() - self.last
        if self.last and gap < self.interval:
            delay = self.interval - gap
            self.slept += delay
            time.sleep(delay)
        self.last = time.monotonic()


def is_budget_refusal(message: str) -> bool:
    """Did the platform guard refuse this, as opposed to the data failing?

    ⚠️ Matched on the guard's own load-bearing wording. The message is
    deliberately terminal — it says do NOT retry — so the script must STOP
    rather than skip and carry on. Continuing would spend the remaining budget
    on calls that are all going to be refused, and bury the one line that
    explains the run.
    """
    m = (message or "").lower()
    return "budget" in m or "loop detected" in m or "do not retry" in m


class Ctx:
    """Minimal stand-in for the dispatcher's Ctx — the handler reads host_id."""

    def __init__(self, host_id: str) -> None:
        self.host_id = host_id
        self.config = type("C", (), {"host_id": host_id})()
        self.jobs = None
        self.job_id = None
        self.claims = {}

    def __getattr__(self, _n):  # log, etc.
        return None


def _unwrap(envelope):
    """Handlers return {'data': ..., 'meta': ...}. Take data, loudly.

    ⚠️ Not `envelope.get("data", envelope)`. A missing 'data' key meant a broken
    tool on 2026-09-01 and the fallback would have hidden it — the whole lesson
    of that day was a handler whose numbers were right and whose envelope was
    absent.
    """
    if not isinstance(envelope, dict) or "data" not in envelope:
        raise SystemExit(
            f"handler returned no 'data' envelope: {str(envelope)[:200]}"
        )
    return envelope["data"]


async def read_library(ctx: Ctx) -> list[dict]:
    data = _unwrap(await get_dj_playlists({"mode": "library", "limit": 50}, ctx))
    return [p for p in data["playlists"] if p.get("owned")]


async def read_contents(ctx: Ctx, playlist_id: str) -> dict:
    """Read via read_playlist_contents, NOT via the get_dj_playlists tool.

    ⚠️ THE TOOL CLAMPS TO 200 AND IT IS RIGHT TO. That cap bounds what enters a
    MODEL'S CONTEXT, and this path has no model in it — the script reads YouTube
    and POSTs to Supabase. Same projection either way: the tool calls this exact
    function, so video_id, set_video_id and position are identical. Only the
    ceiling differs, and each caller supplies its own.
    """
    return await read_playlist_contents(ctx.host_id, playlist_id, CONTENTS_BULK_CAP)


def to_payload(recorded: dict, contents: dict, library_count: int) -> dict:
    """Build the request body.

    Position comes from the READ ORDER, which is YouTube's order. Nothing is
    keyed on set_video_id (rule 2); it rides along as an opaque cache value.
    """
    tracks = []
    for t in contents["tracks"]:
        artists = [a["name"] for a in (t.get("artists") or []) if a.get("name")]
        album = (t.get("album") or {}).get("name")
        tracks.append({
            "video_id": t["video_id"],
            "title": t["title"],
            "artists": artists,
            "album": album,
            "duration_seconds": t.get("duration_seconds"),
            "role": "body",          # every imported row is body; cram is earned
            "position": t["position"],
            "yt_set_video_id": t.get("set_video_id"),
            "added_reason": "import",
        })
    return {
        "yt_playlist_id": recorded["yt_playlist_id"],
        "name": recorded["name"],
        "kind": recorded["kind"],
        # concert_id is DELIBERATELY ABSENT — see rule 3.
        "library_count": library_count,
        # ⚠️ THE CEILING THIS SCRIPT ACTUALLY READ WITH, sent rather than assumed
        # by the server. A guard holding its own copy of this number disagreed
        # with the reader the moment the reader changed, and reported a complete
        # 379-of-379 read as clipped.
        "read_cap": CONTENTS_BULK_CAP,
        "tracks": tracks,
    }


def read_recorded(base: str, token: str) -> list[dict]:
    """The recorded playlist rows: yt_playlist_id, name, kind.

    Fetched from GET /mcp/import-playlist/targets, which calls
    get_dj_managed_playlists server-side.

    ⚠️ ONE CREDENTIAL, DELIBERATELY. Reading dj_playlists over PostgREST would
    also need an `apikey` header — a second secret to fetch and paste, for no
    gain. /import-takeout set the pattern: one user JWT from the browser
    console, nothing else.

    ⚠️ NAME AND KIND COME FROM SUPABASE, NEVER FROM THE YOUTUBE TITLE. They are
    Alex's classification and no title rule reproduces it: "Coldplay Opening
    Concert" is a WILLOW *artist* playlist, and both I Heart Radio playlists are
    festivals recorded as `artist` despite "Concert" in the name. Re-deriving
    kind here would silently undo the one part of Phase 6b a human did.
    """
    req = urllib.request.Request(
        f"{base.rstrip('/')}/functions/v1/mcp/import-playlist/targets",
        headers={"authorization": f"Bearer {token}", "accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        raise SystemExit(f"could not read import targets (HTTP {e.code}): {raw[:300]}")
    return [
        {"yt_playlist_id": p["yt_playlist_id"], "name": p["name"], "kind": p["kind"]}
        for p in data.get("playlists", [])
        if p.get("yt_playlist_id")
    ]


def post(base: str, token: str, mode: str, payload: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{base.rstrip('/')}/functions/v1/mcp/import-playlist?mode={mode}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"error": raw[:500]}


async def main() -> int:
    ap = argparse.ArgumentParser()
    # One of the three, always. There is no default: "what would you like me to
    # do with your library" is not a question with a safe implicit answer.
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true",
                   help="list what would be imported and skipped, then stop. "
                        "Reads both sides; contacts neither for a write.")
    g.add_argument("--dry-run", action="store_true",
                   help="per playlist, predict the write. Writes nothing.")
    g.add_argument("--confirm", action="store_true", help="write.")
    ap.add_argument("--only", help="a single yt_playlist_id")
    ap.add_argument("--seconds-between", type=float, default=DEFAULT_SECONDS_BETWEEN,
                    help=f"pace between playlists (default {DEFAULT_SECONDS_BETWEEN:g}s). "
                         "The platform call budget is per-user and SHARED with any "
                         "open Claude conversation; 0 disables pacing and will hit it.")
    ap.add_argument("--host-id", default=os.environ.get("WORKSHOP_HOST_ID", "surface"))
    ap.add_argument("--token", required=True,
                    help="Supabase user JWT - see the header of this file for the "
                         "browser-console snippet that copies it.")
    ap.add_argument("--url", default="https://zuqjyfqnvhddnchhpbcz.supabase.co",
                    help="Supabase project URL.")
    args = ap.parse_args()

    base, token = args.url, args.token
    mode = "confirm" if args.confirm else "dry_run"
    ctx = Ctx(args.host_id)

    library = await read_library(ctx)
    by_id = {p["playlist_id"]: p for p in library}

    recorded = read_recorded(base, token)
    if not recorded:
        print("no recorded playlists found - run the Phase 6b row creation first.",
              file=sys.stderr)
        return 2

    targets = [r for r in recorded if not args.only or r["yt_playlist_id"] == args.only]

    planned, skipped = [], []
    for r in targets:
        pid = r["yt_playlist_id"]
        if pid in OVER_CAP:
            skipped.append((r["name"],
                            f"OVER CAP ({OVER_CAP[pid][1]} > {CONTENTS_BULK_CAP}) "
                            f"- not readable in full"))
            continue
        if pid in ALREADY_DONE and not args.only:
            skipped.append((r["name"], "already imported by hand"))
            continue
        if pid not in by_id:
            skipped.append((r["name"], "not in the YouTube library any more"))
            continue
        planned.append(r)

    print(f"mode={mode}  planned={len(planned)}  skipped={len(skipped)}\n")
    for n, why in skipped:
        print(f"  SKIP  {n:<34} {why}")
    if skipped:
        print()
    if args.plan:
        for r in planned:
            print(f"  PLAN  {r['name']:<34} {by_id[r['yt_playlist_id']]['count']:>4} tracks  [{r['kind']}]")
        return 0

    stops, failures, ok = [], [], []
    budget_hit = None
    pacer = Pacer(args.seconds_between)
    eta = len(planned) * args.seconds_between
    print(f"  pacing: {args.seconds_between:g}s between playlists "
          f"(~{eta / 60:.0f} min for {len(planned)}). "
          f"--seconds-between 0 disables, and will hit the call budget.\n")
    print(f"  {'playlist':<34} {'lib':>4} {'read':>5} {'wrote':>6} {'stale':>6}")
    print(f"  {'-'*34} {'-'*4} {'-'*5} {'-'*6} {'-'*6}")
    for r in planned:
        pid = r["yt_playlist_id"]
        lib = by_id[pid]["count"] or 0
        contents = await read_contents(ctx, pid)
        payload = to_payload(r, contents, lib)
        read_n = len(payload["tracks"])

        pacer.wait()
        code, res = post(base, token, mode, payload)

        # ⚠️ CHECKED BEFORE THE GENERIC FAILURE BRANCH, AND IT STOPS THE RUN.
        # The guard's message is terminal - it says do NOT retry - so treating a
        # refusal as one more failed playlist and carrying on would spend the
        # rest of the window on calls that are all going to be refused, and bury
        # the single line that explains why the run ended.
        if is_budget_refusal(str(res.get("error", ""))):
            budget_hit = (r["name"], res.get("error", ""))
            print(f"  {r['name']:<34} {lib:>4} {read_n:>5} {'BUDGET':>6} {'-':>6}")
            break

        if res.get("stop"):
            stops.append((r["name"], res.get("error", "")))
            print(f"  {r['name']:<34} {lib:>4} {read_n:>5} {'STOP':>6} {'-':>6}")
            continue
        if code >= 400 or res.get("error"):
            failures.append((r["name"], res.get("error", f"HTTP {code}")))
            print(f"  {r['name']:<34} {lib:>4} {read_n:>5} {'FAIL':>6} {'-':>6}")
            continue

        # ⚠️ VERIFY WHICH TOOL RAN, do not assume. Nothing had exercised the
        # record_dj_playlist_bulk path — both large playlists stopped before the
        # write — and "the two tools behave identically" proves they do not
        # drift, not that this endpoint picks the right one.
        expected_tool = ("record_dj_playlist_bulk" if mode == "confirm"
                         else "dry_run_dj_playlist")
        used = res.get("tool_used")
        if used != expected_tool:
            failures.append((r["name"],
                             f"endpoint used {used!r}, expected {expected_tool!r} - "
                             f"the wrong write path would silently apply the wrong "
                             f"track ceiling"))
            print(f"  {r['name']:<34} {lib:>4} {read_n:>5} {'TOOL?':>6} {'-':>6}")
            continue

        wrote = res.get("membership_rows_written", res.get("tracks_in_payload", 0))
        stale = res.get("stale_rows", res.get("predicted_stale_rows", 0))
        note = res.get("shortfall_note")
        ok.append((r["name"], lib, read_n, wrote, stale, note))
        flag = "  <-- STALE" if stale else ""
        empty = "  (legitimately empty)" if pid in KNOWN_EMPTY and lib == 0 else ""
        short = "  <-- SHORT" if note else ""
        print(f"  {r['name']:<34} {lib:>4} {read_n:>5} {wrote:>6} {stale:>6}{flag}{short}{empty}")

    print()
    print(f"  ok={len(ok)}  stops={len(stops)}  failures={len(failures)}  "
          f"skipped={len(skipped)}  paced={pacer.slept / 60:.1f} min")
    if ok:
        print(f"  write path: {'record_dj_playlist_bulk' if mode == 'confirm' else 'dry_run_dj_playlist'}"
              f" (confirmed by the endpoint on every row, not assumed)")

    if budget_hit:
        done = len(ok)
        left = len(planned) - done - len(stops) - len(failures)
        print(f"\n  BUDGET REFUSED at '{budget_hit[0]}' - the run STOPPED, it did "
              f"not skip and continue.")
        print(f"  {done} written, {left} never attempted. Nothing partial: a refusal "
              f"happens before the handler runs.")
        print(f"  Wait 300s for the rolling window to clear, then re-run the SAME "
              f"command - re-recording an already-imported playlist is an upsert on "
              f"(playlist_id, role, position), so it rewrites the same rows and "
              f"reports stale_rows 0.")
        print(f"  If it refused again at this pace, raise --seconds-between: "
              f"something else is spending the same budget.")
        # ⚠️ VERBATIM. The guard's wording is load-bearing (platform.ts says so
        # explicitly) and must not be reworded, prefixed or summarised on its
        # way to a human any more than on its way to a model.
        print(f"\n  The guard said, verbatim:\n     {budget_hit[1]}")

    # ⚠️ Stale rows on a FIRST import is a real finding: a playlist recorded with
    # total: 0 has nothing to be stale against. Surfaced separately so it cannot
    # scroll past inside a 34-line table.
    with_stale = [o for o in ok if o[4]]
    if with_stale:
        print("\n  STALE ROWS ON IMPORT - investigate before trusting these bodies:")
        for n, _l, _r, _w, st, _note in with_stale:
            print(f"     {n}: {st} recorded row(s) absent from the YouTube read")

    # Recorded, but complete-as-possible rather than complete. Surfaced
    # separately because it is a PERMANENT property of the body, not a transient
    # import problem: re-running reports the same shortfall forever, and the
    # missing entry cannot be fetched by any call.
    with_short = [o for o in ok if o[5]]
    if with_short:
        print("\n  SHORT READS - recorded, and everything obtainable:")
        for n, _l, _r, _w, _st, note in with_short:
            print(f"     {n}: {note}")

    for n, why in stops:
        print(f"\n  STOP {n}: {why}")
    for n, why in failures:
        print(f"\n  FAIL {n}: {why}")

    return 1 if (stops or failures or budget_hit) else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
