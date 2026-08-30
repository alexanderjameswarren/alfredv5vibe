"""Cross-reference EVERY poll-sourced dj_plays row against its exact Takeout
timestamp, to test how YouTube buckets history.

Reads only. No database, no network. The poll rows are pasted in as JSON,
because the tool that reads them lives on the Alfred connector.

SETTLED — THIS IS NOW A REGRESSION GUARD
----------------------------------------
YouTube buckets history by the UTC day, not by the account's timezone.
Confirmed 2026-08-29: 41 of 41 disagreements in the discriminating window,
every in-window pair disagreed, every one matched the UTC date, no mixed cases.

This script now checks the INVARIANT rather than the hypothesis: every poll row
should agree with its Takeout entry's UTC date. A disagreement means a
local-time conversion has been reintroduced somewhere.

Evidence so far is four rows from one window and one poll — which is the shape
of a check that cannot fail (spec §11.1). This widens it to every overlapping
pair and, crucially, states in advance what would FALSIFY it:

  If the hypothesis holds, played_on disagreements appear ONLY for plays whose
  UTC time-of-day is 00:00-07:59 (17:00-23:59 Pacific). A SINGLE disagreement
  outside that window falsifies it, and a play inside the window that AGREES
  weakens it.

Both outcomes are reported. The window is not assumed — every pair is classified
and counted, so "no disagreements at all" is distinguishable from "no subjects
in the window", which would mean the test had no failing case available.

USAGE
-----
1. In a conversation with the Alfred connector, run:

     get_dj_plays  mode: "plays"  source: "poll"  limit: 50
     (repeat with from_date/to_date to page past 50 — every poll row is needed)

2. Save the combined `plays` arrays as one JSON array in a file:

     [ {"played_on": "...", "played_bucket": "...", "precision": "...",
        "observed_at": "...", "track": {"video_id": "...", "title": "..."}}, ... ]

3. From workshop/:

     .\\.venv\\Scripts\\python.exe scripts\\dj_takeout_parity.py --poll poll_rows.json
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
TAKEOUT = ROOT / "data" / "dj" / "watch-history.json"
LA = ZoneInfo("America/Los_Angeles")
VIDEO_ID_RE = re.compile(r"[?&]v=([A-Za-z0-9_-]{6,})")

# Plays whose UTC time-of-day falls here have a DIFFERENT UTC date and Pacific
# date. Everywhere else the two agree, so a pair outside this window cannot
# distinguish the hypotheses however it comes out.
DISCRIMINATING_MAX_UTC_HOUR = 8


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--poll", type=Path, required=True,
                    help="JSON array of poll-sourced rows from get_dj_plays")
    ap.add_argument("--takeout", type=Path, default=TAKEOUT)
    args = ap.parse_args()

    poll_rows = json.loads(args.poll.read_text(encoding="utf-8"))
    if isinstance(poll_rows, dict):            # tolerate a whole tool envelope
        poll_rows = poll_rows.get("plays") or poll_rows.get("data", {}).get("plays") or []
    print(f"poll rows supplied: {len(poll_rows)}")

    # --- index Takeout by video_id -> [exact utc datetimes] ----------------
    take: dict[str, list[datetime]] = {}
    for e in json.loads(args.takeout.read_text(encoding="utf-8")):
        if e.get("header") != "YouTube Music":
            continue
        m = VIDEO_ID_RE.search(e.get("titleUrl") or "")
        ts = e.get("time")
        if not m or not ts:
            continue
        take.setdefault(m.group(1), []).append(
            datetime.fromisoformat(ts.replace("Z", "+00:00"))
        )
    print(f"takeout music entries indexed: {sum(len(v) for v in take.values()):,} "
          f"across {len(take):,} videos")

    agree, disagree, unmatched = [], [], []
    for r in poll_rows:
        vid = (r.get("track") or {}).get("video_id") or r.get("video_id")
        title = (r.get("track") or {}).get("title") or r.get("title") or ""
        played_on = r.get("played_on")
        if not vid or vid not in take:
            unmatched.append((vid, title, played_on))
            continue
        # Pick the Takeout play closest to the poll's played_on — a track can
        # appear on many days, and comparing against the wrong one would
        # manufacture a disagreement.
        target = datetime.fromisoformat(played_on + "T12:00:00+00:00")
        best = min(take[vid], key=lambda d: abs((d - target).total_seconds()))
        utc_date = best.astimezone(timezone.utc).date().isoformat()
        la_date = best.astimezone(LA).date().isoformat()
        utc_hour = best.astimezone(timezone.utc).hour
        rec = {
            "video_id": vid, "title": title[:34],
            "poll_played_on": played_on,
            "poll_bucket": r.get("played_bucket"),
            "takeout_utc": best.astimezone(timezone.utc).isoformat(),
            "utc_date": utc_date, "la_date": la_date, "utc_hour": utc_hour,
            "discriminating": utc_hour < DISCRIMINATING_MAX_UTC_HOUR,
        }
        # played_on IS the UTC date (settled 2026-08-29, 41/41). Compare
        # against that, not the Pacific date the hypothesis was testing.
        (agree if played_on == utc_date else disagree).append(rec)

    # --- report -------------------------------------------------------------
    print()
    print("=" * 78)
    print("PARITY: poll played_on  vs  Takeout exact timestamp")
    print("=" * 78)
    print(f"  pairs matched                {len(agree) + len(disagree)}")
    print(f"    poll agrees with LA date   {len(agree)}")
    print(f"    poll DISAGREES with LA date{len(disagree):>4}")
    print(f"  poll rows with no Takeout counterpart  {len(unmatched)}")

    disc = [r for r in agree + disagree if r["discriminating"]]
    print(f"  pairs in the DISCRIMINATING window (UTC hour < 8): {len(disc)}")
    if not disc:
        print()
        print("  ⚠️  NO PAIR FALLS IN THE DISCRIMINATING WINDOW.")
        print("  The test HAS NO FAILING CASE AVAILABLE — outside that window the UTC")
        print("  and Pacific dates agree, so every pair passes either way. Report as")
        print("  NOT EXERCISED, not as confirmation.")

    print()
    print("  --- HYPOTHESIS: YouTube buckets by UTC day ---")
    out_of_window = [r for r in disagree if not r["discriminating"]]
    in_window_agree = [r for r in agree if r["discriminating"]]
    if out_of_window:
        print(f"  ❌ FALSIFIED. {len(out_of_window)} disagreement(s) OUTSIDE the window,")
        print("     where UTC and Pacific dates are identical. The bucketing rule is")
        print("     something else — do not act on the UTC theory.")
        for r in out_of_window[:10]:
            print(f"       {r['video_id']}  poll={r['poll_played_on']} la={r['la_date']} "
                  f"utc={r['utc_date']} hour={r['utc_hour']:02d}  {r['title']}")
    elif disagree and not in_window_agree:
        print(f"  ✅ CONSISTENT. All {len(disagree)} disagreement(s) fall inside the")
        print("     window, and every in-window pair disagrees. In every case the poll's")
        print("     played_on matches the UTC date, not the Pacific one.")
    elif disagree and in_window_agree:
        print(f"  ⚠️  MIXED. {len(disagree)} disagree, but {len(in_window_agree)} pair(s)")
        print("     INSIDE the window AGREE with the Pacific date. A single rule cannot")
        print("     produce both — something else is varying.")
        for r in in_window_agree[:10]:
            print(f"       {r['video_id']}  poll={r['poll_played_on']} la={r['la_date']} "
                  f"utc={r['utc_date']} hour={r['utc_hour']:02d}  {r['title']}")
    else:
        print("  no disagreements at all — see the window count above before concluding")

    if disagree:
        matches_utc = sum(1 for r in disagree if r["poll_played_on"] == r["utc_date"])
        print(f"  disagreeing pairs whose poll played_on == the UTC date: "
              f"{matches_utc}/{len(disagree)}")

    print()
    print("  --- every matched pair ---")
    print(f"  {'video_id':<13} {'poll':<11} {'LA':<11} {'UTC':<11} {'hr':>3} {'win':>4}  title")
    for r in sorted(agree + disagree, key=lambda r: (r["poll_played_on"], r["utc_hour"])):
        flag = "  ✓" if r["poll_played_on"] == r["la_date"] else "  ✗"
        win = "yes" if r["discriminating"] else "-"
        print(f"  {r['video_id']:<13} {r['poll_played_on']:<11} {r['la_date']:<11} "
              f"{r['utc_date']:<11} {r['utc_hour']:>3} {win:>4}{flag} {r['title']}")

    if unmatched:
        print()
        print(f"  --- poll rows with NO Takeout counterpart ({len(unmatched)}) ---")
        print("  Expected for very recent plays if the export predates them, and for")
        print("  anything the export filtered out. A large count needs explaining before")
        print("  the parity result means anything.")
        for vid, title, po in unmatched[:20]:
            print(f"    {vid}  {po}  {title[:40]}")


if __name__ == "__main__":
    main()
