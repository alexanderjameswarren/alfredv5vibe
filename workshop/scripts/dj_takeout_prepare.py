"""Prepare Google Takeout watch-history.json for the phase 8 import.

Reads only. Writes nothing to any database and makes no network call. Emits a
dry-run report by default; `--emit` additionally writes batch files that Claude
submits to `record_dj_plays`.

WHY THIS IS A SCRIPT AND NOT A CONVERSATION
-------------------------------------------
Two reasons, and the second is the important one.

18,188 entries cannot travel through Claude's context — the courier model in
spec §2 is bounded at roughly 50 plays a day for exactly that reason.

More importantly, this transform DECIDES `match_key` for ~15,000 rows in an
insert-only table. Spec §4.1.2: `match_key` and `canonical_track_id` are written
once and never updated, so a transform that drifts between conversations would
silently group one population differently from another with no way to correct
it afterwards. A versioned script is re-runnable and diffable; a conversational
transform is not. Claude's job here is submission and review, not extraction.

THE THREE PRECONDITIONS THIS SCRIPT EXISTS TO ENFORCE
-----------------------------------------------------
1. Every music title is prefixed "Watched " and there is NO artist field. Passed
   raw, every Takeout track would get a match_key that never groups with its
   poll-sourced counterpart — no error, two familiarity groups per song,
   permanently. The prefix is stripped and the artist derived BEFORE the
   normaliser sees anything.

2. Entries with no `subtitles` have no derivable artist and are SKIPPED. A null
   artist is not an absence: `buildMatchKey` yields "|title", so every
   artist-less track sharing a title groups with every other one — and "Happy
   Together" alone has six distinct recordings. It is a collision engine.

3. Only `- Topic` channels are imported. On other channels THE CHANNEL IS NOT
   THE ARTIST: "Vance Joy - Riptide" sits on "Mushroom" (a record label),
   "Brandon Flowers" on a fan upload. The derivation rule would silently write a
   label or a stranger's name into an insert-only match_key. Those entries are
   reported as a reviewed exception list, not imported.

Usage, from workshop/:
    .\\.venv\\Scripts\\python.exe scripts\\dj_takeout_prepare.py
    .\\.venv\\Scripts\\python.exe scripts\\dj_takeout_prepare.py --emit
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "data" / "dj" / "watch-history.json"
OUT_DIR = ROOT / "data" / "dj" / "takeout-batches"

# played_on IS THE UTC DATE OF THE PLAY. Not local, not the account's day — UTC,
# named. And this is FORCED, not chosen.
#
# The poll only ever receives a bucket LABEL ("Today", "Yesterday"). It never
# learns time-of-day, so a poll row can NEVER be converted to a local date: the
# information required does not exist in the feed. Poll rows can therefore only
# carry UTC dates, and Takeout must match THEM — the weaker source dictates the
# definition, because the stronger one can adapt and the weaker one cannot.
#
# Confirmed empirically 2026-08-29: 41 of 41 poll/Takeout disagreements fell in
# the discriminating window (UTC hour < 8), every in-window pair disagreed, and
# every one matched the UTC date. No mixed cases. YouTube buckets by UTC day.
#
# KNOWN, BOUNDED DISTORTION: UTC midnight is 17:00 Pacific in summer, 16:00 in
# winter — the middle of a listening day, not the middle of the night. So a
# track heard Monday evening and Tuesday afternoon can collapse into one UTC
# day, and one heard either side of 17:00 can split across two. Bounded at ±1
# day in both directions, so it roughly cancels for a relative measure like
# distinct-days (§5). Recorded rather than papered over.
#
# One genuine upside: UTC HAS NO DST. The Pacific boundary moves twice a year;
# the UTC one never does. A definition that does not shift under you is worth
# something.
PLAY_DATE_TZ = timezone.utc

WATCHED_PREFIX = "Watched "
TOPIC_SUFFIX = " - Topic"
MUSIC_HEADER = "YouTube Music"
VIDEO_ID_RE = re.compile(r"[?&]v=([A-Za-z0-9_-]{6,})")

# record_dj_plays rejects anything over 500 rather than truncating.
BATCH_SIZE = 500


def video_id_of(url: str | None) -> str | None:
    if not url:
        return None
    m = VIDEO_ID_RE.search(url)
    return m.group(1) if m else None



def assert_no_local_time_conversion() -> None:
    """Prove played_on is the UTC date and NOT a local one — and fail loudly.

    The check discriminates in the OPPOSITE direction from its predecessor. That
    version asserted a Pacific conversion; this one asserts that no conversion
    happens at all. Every case below sits in the window where a UTC date and a
    Pacific date DIFFER, so reintroducing a local-time conversion — the most
    likely regression, since it was the behaviour two days ago — makes these
    fail immediately.

    Needs no data, so it can fail on its own rather than depending on which rows
    happen to be present.
    """
    cases = [
        # (timestamp, expected played_on, what a Pacific conversion would give)
        ("2026-08-29T02:30:00.000Z", "2026-08-29", "Pacific would say 2026-08-28"),
        ("2026-08-29T06:59:00.000Z", "2026-08-29", "Pacific would say 2026-08-28"),
        ("2026-08-29T00:00:00.000Z", "2026-08-29", "UTC midnight, the boundary itself"),
        ("2026-08-29T23:59:59.000Z", "2026-08-29", "last second of the UTC day"),
        ("2026-01-15T03:30:00.000Z", "2026-01-15", "PST too — no DST in UTC"),
        ("2026-01-15T07:59:00.000Z", "2026-01-15", "PST would say 2026-01-14"),
        ("2026-08-29T20:00:00.000Z", "2026-08-29", "NON-discriminating: same either way"),
    ]
    failures = []
    for iso, expected, note in cases:
        got = (datetime.fromisoformat(iso.replace("Z", "+00:00"))
               .astimezone(PLAY_DATE_TZ).date().isoformat())
        if got != expected:
            failures.append(f"    {iso} -> {got}, expected {expected} ({note})")
    if failures:
        raise SystemExit(
            "played_on IS NOT THE UTC DATE — nothing was prepared. A local-time "
            "conversion has been reintroduced:\n" + "\n".join(failures)
        )
    print("  played_on = UTC date: 6 discriminating cases pass "
          "(a Pacific conversion would fail all six)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    ap.add_argument("--emit", action="store_true", help="write batch files")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    assert_no_local_time_conversion()
    entries = json.loads(args.source.read_text(encoding="utf-8"))
    print(f"read {len(entries):,} entries from {args.source}")

    kept: list[dict] = []
    excluded: Counter[str] = Counter()
    non_topic_channels: Counter[str] = Counter()
    no_artist_titles: list[str] = []

    for e in entries:
        if e.get("header") != MUSIC_HEADER:
            excluded["not a YouTube Music entry"] += 1
            continue

        subs = e.get("subtitles") or []
        if not subs or not subs[0].get("name"):
            # Precondition 2 — skipped, and listed rather than counted away.
            excluded["no subtitles: artist not derivable"] += 1
            no_artist_titles.append(e.get("title", "(no title)"))
            continue

        channel = subs[0]["name"]
        if not channel.endswith(TOPIC_SUFFIX):
            # Precondition 3 — the channel is not reliably the artist here.
            excluded["channel is not a '- Topic' auto-upload"] += 1
            non_topic_channels[channel] += 1
            continue

        vid = video_id_of(e.get("titleUrl"))
        if not vid:
            excluded["no video_id derivable from titleUrl"] += 1
            continue

        raw_title = e.get("title") or ""
        if not raw_title.startswith(WATCHED_PREFIX):
            # Do not guess. An unprefixed title means the export shape changed,
            # and silently importing it would poison match_key for that row.
            excluded["title lacks the 'Watched ' prefix — shape changed?"] += 1
            continue
        title = raw_title[len(WATCHED_PREFIX):].strip()
        if not title:
            excluded["title empty after stripping prefix"] += 1
            continue

        ts = e.get("time")
        if not ts:
            excluded["no timestamp"] += 1
            continue
        played_at = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(PLAY_DATE_TZ)

        # Only the fields the handler actually needs. Deliberately omitted:
        #   album, duration_seconds — Takeout carries neither, and the handler
        #     defaults both to null. Sending explicit nulls is 40 bytes a row of
        #     nothing, over ~15k rows.
        #   played_bucket — Block F removed it from the dedupe key and made it
        #     diagnostic only. There WAS no bucket for a Takeout row, so the
        #     honest value is null. An earlier version stuffed the ISO date in
        #     here, which predates Block F: it would have put a date into a
        #     column whose documented meaning is "the label YouTube returned".
        kept.append({
            "video_id": vid,
            "title": title,
            "artists": [channel[: -len(TOPIC_SUFFIX)]],
            "played_on": played_at.date().isoformat(),
            "precision": "exact",
            "_utc": ts,
            "_utc_hour": played_at.astimezone(timezone.utc).hour,
        })

    # --- occurrence, per (video_id, played_on), oldest first ----------------
    # The only source that will ever produce occurrence > 1: the live feed
    # carries one entry per track per bucket, so repeats do not stack there.
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in kept:
        groups[(r["video_id"], r["played_on"])].append(r)
    repeat_days = 0
    repeat_rows = 0
    repeat_hist: Counter[int] = Counter()
    for key, rows in groups.items():
        rows.sort(key=lambda r: r["_utc"])
        for i, r in enumerate(rows, start=1):
            r["occurrence"] = i
        repeat_hist[len(rows)] += 1
        if len(rows) > 1:
            repeat_days += 1
            repeat_rows += len(rows)

    discriminating = [r for r in kept if r["_utc_hour"] < 8]
    for r in kept:
        r.pop("_utc", None)
        r.pop("_utc_hour", None)

    # --- report -------------------------------------------------------------
    dates = sorted({r["played_on"] for r in kept})
    vids = {r["video_id"] for r in kept}
    print()
    print("=" * 72)
    print("DRY RUN — nothing has been written")
    print("=" * 72)
    print(f"  importable rows      {len(kept):,}")
    print(f"  distinct videos      {len(vids):,}")
    print(f"  distinct days        {len(dates):,}")
    print(f"  date range           {dates[0]} .. {dates[-1]}   (UTC)")
    print(f"  batches of {BATCH_SIZE}       {(len(kept) + BATCH_SIZE - 1) // BATCH_SIZE}")

    print()
    print("  EXCLUDED:")
    for reason, n in excluded.most_common():
        print(f"    {n:>6,}  {reason}")
    print(f"    {sum(excluded.values()):>6,}  total excluded")

    print()
    print("  REPLAYS — occurrence > 1 (the question the live feed cannot answer):")
    print(f"    (video, day) pairs with >1 play   {repeat_days:,}")
    print(f"    rows belonging to those pairs     {repeat_rows:,}")
    total_pairs = len(groups)
    pct = (repeat_days / total_pairs * 100) if total_pairs else 0
    print(f"    share of all (video, day) pairs   {pct:.1f}%")
    print("    plays-per-(video,day) distribution:")
    for n, c in sorted(repeat_hist.items()):
        print(f"      {n:>3} play(s) on a day : {c:,} pair(s)")

    if no_artist_titles:
        print()
        print(f"  SKIPPED, NO ARTIST ({len(no_artist_titles)}) — titles:")
        for t in no_artist_titles[:25]:
            print(f"    {t}")

    if non_topic_channels:
        print()
        print(f"  NON-'- Topic' CHANNELS ({sum(non_topic_channels.values())} entries, "
              f"{len(non_topic_channels)} channels) — reviewed exception list, top 20:")
        for name, n in non_topic_channels.most_common(20):
            print(f"    {n:>4}  {name}")

    # --- timezone parity candidates ----------------------------------------
    #
    # ⚠️ ONLY entries whose UTC hour is < 08:00 are listed. Outside that window
    # a UTC date and a Pacific date AGREE, so the subject passes whether the
    # resolution is right or wrong — a check that cannot fail (spec §11.1).
    #
    # The hypothesis these once tested is SETTLED (YouTube buckets by UTC day,
    # 41/41). They now serve as a regression guard: every one of these should
    # match its poll row's played_on exactly. A disagreement means a local-time
    # conversion has crept back in.
    POLL_DAYS = ("2026-08-27", "2026-08-28", "2026-08-29")
    overlap = [r for r in discriminating if r["played_on"] in POLL_DAYS]
    print()
    print("  TIMEZONE PARITY CHECK")
    print(f"    entries in the DISCRIMINATING window (UTC hour < 08): {len(discriminating):,}")
    print(f"    of those, on days where poll rows exist {POLL_DAYS}: {len(overlap)}")
    if overlap:
        print("    Compare each against get_dj_plays (source: 'poll'). A disagreement on")
        print("    played_on means the LA conversion is wrong:")
        seen: set[str] = set()
        for r in sorted(overlap, key=lambda r: r["played_on"], reverse=True):
            if r["video_id"] in seen:
                continue
            seen.add(r["video_id"])
            print(f"      {r['played_on']}  {r['video_id']}  "
                  f"{r['artists'][0][:20]:22} {r['title'][:34]}")
            if len(seen) >= 15:
                break
    else:
        print("    ⚠️  NO OVERLAPPING ROW FALLS IN THE DISCRIMINATING WINDOW.")
        print("    The cross-source guard has NO FAILING CASE AVAILABLE — only the")
        print("    self-check above covers it. NOT FULLY EXERCISED, not passed.")

    if args.emit:
        args.out.mkdir(parents=True, exist_ok=True)
        n = 0
        for i in range(0, len(kept), BATCH_SIZE):
            batch = kept[i:i + BATCH_SIZE]
            p = args.out / f"batch_{i // BATCH_SIZE + 1:03d}.json"
            p.write_text(json.dumps({"source": "takeout", "plays": batch}, indent=1),
                         encoding="utf-8")
            n += 1
        print()
        print(f"  wrote {n} batch file(s) to {args.out}")
    else:
        print()
        print("  (dry run — pass --emit to write batch files)")


if __name__ == "__main__":
    main()
