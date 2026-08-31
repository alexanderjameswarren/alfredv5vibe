# Progress: DJ

**Status:** Phases 0, 1, 2a, 2b, 3a, 3b complete. Next: phase 4 (Surface deployment) — the courier loop runs end to end.
**Migration Block F applied 2026-08-27 — CONFORMANT @ 27, handler deployed, auth verified.**
Next: fresh-conversation check of the new handler behaviour, then phase 3.
**Spec:** `docs/technical-spec-dj.md`

---

## Phase 0 — Schema and auth proof ✅ COMPLETE

- [x] Migration Block A — `dj_tracks`, `dj_plays`, `dj_sync_runs` — CONFORMANT @ 19
- [x] Migration Block B — `dj_venues`, `dj_artists`, `dj_concerts` — CONFORMANT @ 22
- [x] Migration Block C — `dj_playlists`, `dj_playlist_tracks`, `dj_albums`,
      `dj_feedback` — CONFORMANT @ 26
- [x] Migration Block D — dropped `dj_sync_runs`; added `platform_runs`,
      `platform_schedules` — CONFORMANT @ 27
- [x] Migration Block E — replaced `dj_plays` with precision-flagged version —
      CONFORMANT @ 27
- [x] `ytmusicapi` 1.12.2 installed in desktop venv
- [x] Firefox header capture → `data/dj/browser.json`
- [x] `scripts/dj_auth.py` and `scripts/dj_probe.py` created
- [x] Probe successful: 43 playlists, 200 history items, field shape captured
- [x] Recovery window measured: ~2 weeks (Today / Yesterday / This week / Last week)

**Notes:**
- Twice-daily polling dropped — the two-week window makes daily comfortably safe.
- `python` on PATH resolves to system Python 3.12, not the venv. Use
  `.\.venv\Scripts\python.exe` explicitly.
- Chrome 151 cannot easily copy request headers. Firefox is the working path.
- ⚠️ A session cookie was exposed during setup and was **not** rotated, by explicit
  user decision. Only a Google password change would invalidate it.

---

## Phase 1 — Workshop DJ read tools (dev host only) ✅ COMPLETE

- [x] Create `workshop/workshop/tools/dj.py`
- [x] Register in `workshop/workshop/tools/__init__.py`
- [x] Tool: read history — `get_dj_history`
- [x] Tool: read library playlists — `get_dj_playlists` mode `library`
- [x] Tool: read one playlist's contents — `get_dj_playlists` mode `contents`
      (returns `set_video_id` per entry; verified present on all 160 Weezer tracks)
- [x] Credential loading + a clear `auth_expired` error distinct from operational errors
- [x] Filled in `credential_readable` / `auth_detail` in `get_workshop_status`
- [x] `tests/test_dj.py` — 22 stdlib-unittest cases; suite green at 52
- [x] Restart dev Workshop; confirm tool count rises from 3 → **5**
- [x] **Fresh conversation**; confirmed each tool returns data matching the probe
      (verified 2026-08-27: `credential_readable: true` with no `auth_valid` key;
      Weezer contents returns all 160 at `limit_applied: 200` with no truncation;
      library `count` is an unquoted number; history `limit: 5` emits both the platform
      note and the payload hint)

**Notes:**

**Two tools, not three.** History and playlists have different shapes and different
consumers (courier loop vs. cram loop); library-vs-contents is the same object at two
zoom levels, so that is the `mode`. Manifest goes 3 → 5.

**Limit caps deviate from the house 20/50, deliberately.** History default 50 / cap 200;
playlist contents default 100 / cap 200. `get_history()` takes no limit — it returns one
fixed ~200-item page, so a 50-cap would discard three quarters of the recovery window
§6 depends on. Contents needs >160 to read the Weezer playlist back in phase 3. Both stay
bounded at exactly one upstream page.

**"Push filters into the query before LIMIT" cannot be honoured here.** ytmusicapi returns
a fixed page and there is no query to push into. Bucket filtering and the contents cap are
both applied in memory because there is nowhere else to apply them.

**`occurrence` counts from the OLDEST end, not positionally.** Positional numbering over a
newest-first feed is unstable — a song played once "This week" is occurrence 1 today, and
playing it again tomorrow shifts the original to occurrence 2. Occurrence is in the dedupe
key, so that would re-insert an already-recorded play under a fresh number: silent
duplicates, accumulating daily, worst in the busiest bucket. `bucket_play_count` rides along
so the write side can work by count rather than by identity.

> **Superseded by phase 2b, and the reasoning turned out to be moot.** The key is now
> `(user_id, track_id, played_on, occurrence, source)` — see Finding 2 below. More to the
> point, the feed carries one entry per track per bucket, so `bucket_play_count` is always 1
> from polling and `occurrence` can never exceed 1 on this path. The rule was correct; the
> scenario it guarded against cannot arise from this source. It still matters for Takeout.

**`page_full` is separate from `truncated`, and they mean different things.** Filtering to
`Today` and getting 28 of a 200-item page cuts nothing → not truncated. But that 200-item
page may itself be a slice of a longer history → `page_full: true`. This drives
`covered_from` in `platform_runs`: recording the oldest bucket seen as the covered floor
would overstate coverage when the page merely ran out. `oldest_bucket_is_partial` mirrors
`page_full` at the point of use.

**Live page as of 2026-08-27:** Today 28, Yesterday 3, This week 105, Last week 64 = exactly
200, oldest bucket `Last week`. The page is full and its oldest bucket is partial — the
condition above, confirmed on real data rather than hypothesised.

**`likeStatus` is carried** on history items (`INDIFFERENT` / `LIKE` observed). Free
preference signal feeding `dj_feedback`, one short enum per item. Also carried on playlist
tracks for consistency — flag if you want it dropped there.

**Dropped from the payload:** `thumbnails` (~4 URLs each — pure context tax on a courier
whose cost model is context), `feedbackToken` / `feedbackTokens` /
`listenAgainFeedbackTokens` (write handles; these tools are read-only), `views`,
`communityVoteStatus`, `creditsBrowseId`, `pinnedToListenAgain`, and the `duration` string
(`duration_seconds` supersedes it).

**⚠️ ytmusicapi's `limit` is a fetch hint, not a hard cap.** `get_playlist(id, limit=100)`
on the 160-track Weezer playlist returned all 160 — the first response already held them.
Caught in local testing. The cap is enforced by slicing in the handler or it is not
enforced at all. Assume the same is true of any other ytmusicapi `limit`.

**`ytmusicapi` is imported lazily, inside the call path.** `tools/__init__` imports eagerly
so decorators fire, so a module-level import would take the whole server down on a host
where the pip install has not landed — and on the Surface that failure is silent under
`pythonw.exe`. Lazy keeps it a per-call `dependency_missing:` on one tool.

**The credential is re-read every call, never cached.** `YTMusic()` does no network I/O at
construction, so re-running `scripts/dj_auth.py` takes effect without restarting Workshop.
That is the phase-4 and phase-6 recovery path.

**Error tokens Claude routes on:** `auth_missing:` (no readable credential on this host —
the expected phase-4 symptom), `auth_expired:` (YouTube rejected it — names the reauth
path), `dependency_missing:`, `upstream_error:`, `bad_argument:`. All `OperationalError`
per spec §8, which classes expired YouTube auth as operational, not a guardrail denial.
Upstream text is scrubbed of do-not-retry phrasing before interpolation, because
`OperationalError` raises `ValueError` on those substrings at construction and that would
turn a clean error into an opaque "Internal error".

**⚠️ Which exception ytmusicapi raises for a stale cookie is NOT verified.** Confirming it
means invalidating a live credential, which is phase 6's job. Classification is defensive
(401/403 status plus message-text signals) and phase 6 should tighten it against a real
expiry.

**`auth_valid` means "present and readable on this host", not "YouTube still accepts it".**
Proving the latter needs a network round trip and `get_workshop_status` is called at the top
of every scheduled run. A credential YouTube has since rejected reports `auth_valid: true`
here and fails at the DJ tool with `auth_expired:`.

**pytest is not installed in the venv** — the suite runs under stdlib unittest:
`.\.venv\Scripts\python.exe -m unittest discover tests` from `workshop/`.

### Fixes from the fresh-conversation verification pass (2026-08-27)

**⚠️ `count` was a string, `trackCount` an int — same quantity, two types.**
`get_library_playlists` returns `count: '160'`; `get_playlist` returns `trackCount: 160`.
A text sort puts `'95'` above `'160'`. Now coerced to `int` at the boundary via `_as_int`
(handles thousands separators, rejects `bool`, `None` for "Liked Music" which has no count).
Assume any other ytmusicapi numeric field is a string until checked.

**Truncation advice was pointing the wrong way.** The platform's shared note says "Narrow
the query or request a specific subset" — correct for a database read, backwards here:
nothing was narrowed, and the fix is a HIGHER limit. Added `truncation_hint` to the payload
naming the exact remedy (`re-call with limit: 160`). The platform note itself is shared by
every tool and was left alone — **worth revisiting at platform level**, since any tool
reading a fixed upstream page will hit the same mismatch.

**⚠️ `video_id` is NOT unique within a playlist.** The Weezer playlist has Island In The Sun
at positions 5, 13, 62 and Say It Ain't So at 10, 15, 64 — each copy with its own distinct
`set_video_id`. This is not corruption to clean up; spec §5 makes duplicates load-bearing
(a track holds one row per zone so "clear the cram list" cannot erode the setlist). **Key
playlist entries on `set_video_id` or `position`, never on `video_id`** — phases 3, 5 and 7
all touch this. Stated in the tool description so a fresh conversation cannot miss it.

**Occurrence still has no live-data coverage, by nature of the data.** Every play in the
current page is `occurrence: 1 / bucket_play_count: 1` — the page holds no repeated
`(video_id, bucket)` pair at all, so live data cannot exercise the rule and a broken
implementation would pass a live smoke test. Coverage is the synthetic suite in
`tests/test_dj.py` (oldest=1, per-bucket grouping, and specifically that a new arrival does
not renumber existing plays). **First real-data exercise will be phase 2's re-run test;
phase 8's Takeout backfill will produce repeats in volume.**

**`auth_valid` renamed to `credential_readable`.** The old name promised liveness the check
does not deliver, and phase 5's scheduled task reads this field at the top of every run —
anyone seeing `auth_valid: true` would reasonably conclude YouTube accepted the credential,
when all it means is that a file exists and is readable. **That gap is precisely the phase-6
failure mode.** An expired cookie reports `credential_readable: true` here and then fails at
the DJ tool with `auth_expired:`. `auth_detail` unchanged. Nothing consumed the field yet, so
the rename cost nothing.

**`contents` default raised 100 → 200 (now equal to the cap).** Every realistic use of
contents mode wants the whole playlist — diffing against a setlist, reading back after a
write. The largest playlist in the library is 161, so the full payload is rarely paid in
practice, and a silently partial setlist is a worse failure than a large response.

---

### Carry-forward: platform-level findings — RECORD ONLY, no action this phase

Three things found while building phase 1 that are **not** DJ's to fix. Logged so the next
tool in any app does not rediscover them.

**1. The platform truncation note gives wrong advice for upstream-page reads.**
`TRUNCATED_NOTE_PREFIX` in `platform.py` says *"Narrow the query or request a specific
subset."* That presumes a query exists to narrow — true for a Supabase read, false for any
tool paging a fixed upstream response, where the remedy is a HIGHER limit. Deliberately not
edited: the string is shared by every tool across every app, so rewording it is a platform
decision, not a tool one. DJ works around it with a `truncation_hint` field in the payload.
**Worth revisiting at platform level** — this will recur for every future API-backed tool.

**2. `meta.truncated` is a tuple in the runtime and a boolean in the docs.**
`server.py:111` unpacks `meta["truncated"]` as a **`(shown, total)` tuple** and passes both
to `truncated_note()`. The `mcp-platform` skill's TypeScript example shows it as a
**boolean**. Followed `server.py`, because that is what runs. **The skill should be
corrected**, or the next tool author writes `truncated: True` and gets a crash on unpack.

**4. `get_history()` does not paginate — ~200 is a hard ceiling.**
The ytmusicapi source sends one browse request and never follows a continuation. No
parameter reaches older plays and no tool change can, because the data is not offered.
**This revises spec §6:** the recovery window is ~200 PLAYS, not ~2 weeks — days of
coverage depend on listening volume (~13 days at the 2026-08-27 two-day average of
~15/day; ~7 days at that day's own rate of 28/day). A daily poll is still comfortably
safe, but the failure budget is measured in plays. A gap longer than ~200 plays is
unrecoverable from the live API and only phase 8's Takeout backfill can fill it. Spec §6
updated with the phase-5 consequence.

**3. ytmusicapi returns numeric fields as STRINGS.**
`get_library_playlists` gives `count: '160'`; `get_playlist` gives `trackCount: 160`. Same
quantity, two types, and a text sort puts `'95'` above `'160'`. Fixed at DJ's boundary with
`_as_int`. **Treat every ytmusicapi numeric field as a string until verified** — this will
bite phase 7 (setlist.fm cross-referencing) and any future write-side tool. Also recorded in
spec §9.

---

## Phase 2a — Alfred MCP write tools ✅ COMPLETE

**Split out of phase 2** once it emerged the courier had no write leg: `supabase/functions/`
contained zero `dj_` references. The §2 arrow marked "(3) writes via Alfred MCP" was a
design, not code. Edge Function work + a deploy + a manifest freeze — the same shape as
phase 1, not a step inside phase 2.

- [x] Create `supabase/functions/_shared/tools/dj-courier.ts`
- [x] Match-key normaliser — extracted to `dj-normalise.ts` (rules in spec §4.1.1)
- [x] Bucket → `played_on` + `precision` resolution in the handler
- [x] Tool: `record_dj_plays` — tier 1, tracks + plays in one call
- [x] Tool: `create_platform_run` — tier 1, separate so a failed poll can still stamp
- [x] Tool: `get_platform_runs` — tier 1 read, gap detection
- [x] Register all three in `mcp/index.ts`
- [x] Tests: 22 normaliser + 15 handler, all green
- [x] Deploy: `npx supabase functions deploy mcp --no-verify-jwt`
- [x] ⚠️ **Verified MCP auth survived the deploy** — `--no-verify-jwt` has silently reset before
- [x] Confirm tool count rises by three — **24 → 27**
- [x] **Fresh conversation**; called each tool. Empty read → write → read-after-write all
      passed through RLS. Timestamp fix verified on a second deploy: both stamps identical
      to the millisecond (run `cd5398b9-8275-45d0-acb9-fb1fa0948060`).

**Notes:**

**Design decisions (approved before build):**
- **Normaliser lives in the handler, not in Claude's context.** Conversational derivation
  drifts, and grouping must be identical across the daily poll, phase 8's Takeout backfill,
  and manual imports. A drifted key does not error — it silently fails to group.
- **`dj_tracks` is insert-only** (`ON CONFLICT DO NOTHING`). Keeps the tool a pure append
  (tier 1) and means the courier can never clobber hand-curated grouping.
- **`occurrence`: send all N, let the unique constraint absorb the rest.** Rather than
  reading M and inserting N−M, send occurrences 1..N against
  `(user_id, track_id, played_bucket, occurrence, source)` with `ON CONFLICT DO NOTHING`.
  **This makes the phase-2b hard gate a database guarantee rather than an assertion that
  the arithmetic is right** — and it still genuinely tests occurrence stability, because
  unstable numbering would slip past the constraint and insert.
- **Auto-link canonical grouping on exact normalised `match_key` equality only.** Earliest
  inserted member of a group is canonical; `canonical_track_id` is set at insert and never
  re-pointed, consistent with insert-only. Anything fuzzier stays a proposal (spec §4.1).
- **Batch cap** so a malformed call cannot submit 50,000 elements.

**⚠️ Write-once means a normaliser change is a migration, not a deploy.** `match_key` and
`canonical_track_id` are written once and never updated, so improving the stripping rules
later will **not** regroup already-imported tracks — the two populations would disagree
invisibly. Rules are therefore documented explicitly in spec §4.1.1 rather than left
implicit in code, and were chosen to be right now rather than iterated on.

### Build notes

**Files:** `_shared/tools/dj-normalise.ts` (pure rules, import-free),
`_shared/tools/dj-courier.ts` (the three tools), plus registration in `mcp/index.ts`.

**The normaliser is a separate, import-free module** so it can be unit-tested under plain
Node with type stripping — there is no Deno toolchain on this machine, and the rules are
the part that must not be wrong. `dj-courier.ts` imports from it.

**⚠️ Found while building: a NULL `played_bucket` would silently defeat dedupe entirely.**
The unique index is `(user_id, track_id, played_bucket, occurrence, source)`, and **Postgres
treats NULLs as DISTINCT in a unique index** — so a row with a null bucket can never
conflict with anything, and re-importing would duplicate every row with no error. The poll
path always has YouTube's label, so phase 2b is unaffected; **phase 8's Takeout rows would
have hit it**, since those carry a real timestamp and no bucket. Handled by requiring
`played_bucket` non-null on every row and defaulting the explicit-date path to the ISO
date, which makes the key effectively `track + date + occurrence + source`. Covered by a
test.

**Rejection, not truncation, over the 500-play cap.** For a write, a silently dropped tail
is worse than a failed call: the caller would stamp a successful `platform_runs` row over
an incomplete import, and §4.5's whole detection mechanism assumes a run row means what it
says.

**Testing:** 37 tests, all green.
- `dj-normalise.test.mjs` (22) — the remaster case from §4.1, that
  `Undone - The Sweater Song` survives (positional stripping would destroy it),
  `(Reprise)` and `(Instrumental)` surviving, parenthetical-`with` stripping while bare
  "with" does not, live/studio merging as documented, and the §4.2 date ladder including
  month/year/leap boundaries.
- `dj-courier.test.mjs` (15) — against a simulated PostgREST client that models both
  unique constraints. Covers the **hard gate in simulation** (re-run inserts zero rows),
  repeat occurrences, canonical linking within one batch and across calls, three variants
  pointing at one leader, and that **a re-poll cannot overwrite a hand-curated track row**.
- Neither is wired into `npm test` — that runs react-scripts/jest over `src/` only. Run:
  `node --experimental-strip-types --test supabase/functions/_shared/tools/dj-*.test.mjs`
- The handler test reads the real `dj-courier.ts` and stubs only its `../platform.ts`
  import, so there is no checked-in duplicate to drift. It fails loudly if that import line
  changes.

**Simulation is not the database.** These tests model the unique constraints; they do not
prove RLS, the CHECK constraints, PostgREST's `ignoreDuplicates` semantics, or that
`.select()` after an upsert returns only genuinely-inserted rows. **The `plays_inserted`
count depends on that last one** — phase 2b's live double-sync is what actually confirms it.

### ⚠️ Found by the live smoke test: inverted run timestamps

The 2a smoke row came back with **`finished_at` ~278 ms EARLIER than `started_at`** — a run
that ended before it began.

Cause: two clocks *and* two moments. `finished_at` defaulted to `new Date()` **in the Edge
Function, before the insert**; `started_at` was omitted, so Postgres filled it with `now()`
**after the round trip**. The gap is roughly the network hop plus any real skew between the
Edge runtime and the database host. Neither timestamp was wrong on its own.

Consequence if left: **phase 5's gap logic and phase 9's sync-history page both compute a
duration from this pair** and would get a negative number.

Fixed — both defaults now come from one instant in the handler, `started_at` is written
explicitly rather than left to the DB default, and an inverted pair is rejected instead of
written. Passing `started_at` (recorded before the work begins) yields a real duration;
omitting it means "start unknown", and equal timestamps are the honest answer to that
rather than a fabricated interval. Trade-off accepted: rows written by this tool use the
Edge runtime's clock rather than the database's, so internal coherence is guaranteed while
agreement with rows written by other paths is not. Three regression tests added (18 total).

**The simulation could not have caught this** — the fake never modelled Postgres supplying
`started_at` from its own clock. A precise instance of the "simulation is not the database"
caveat above, and the reason the live smoke test earned its place.

**Cleanup:** `scripts/dj-runs-admin.js` — browser-console `runsList()` / `runsDelete()`,
dry-run by default, refuses to run unfiltered. There is deliberately **no delete tool** for
`platform_runs`: §4.5 leans on the *absence* of a row as the signal that a job never ran, so
a tool that makes rows disappear would undermine the mechanism the design depends on.

**⚠️ Two smoke rows are still in the table** (`phase2a_smoke`, plus the timestamp-fix
verification run `cd5398b9-8275-45d0-acb9-fb1fa0948060`). `get_platform_runs` with
`app: "dj", status: "ok", limit: 1` and **no `job` filter would return it** — which is
exactly the gap-detection call shape. Either delete it before 2b or always filter by `job`.

---

## Phase 2b — Courier loop, end to end ✅ COMPLETE

**Runbook:** `docs/runbook-dj-phase2b.md` — paste into a FRESH conversation. Both legs are
verified in isolation; this connects them. Scope of the first run is **Today + Yesterday
only**, deliberately.

- [x] Step 0 — deleted the two Phase 2a smoke rows before anything else
- [x] Match-key normaliser exercised on live data
- [x] Bucket → `played_on` + `precision` resolution exercised (`day` only, by design)
- [x] Write path: `dj_tracks` upsert with canonical grouping
- [x] Write path: `dj_plays` insert
- [x] Write path: `platform_runs` stamp
- [x] **Canonical grouping EXERCISED AND PASSED** — Herbie Hancock, "The Pleasure Is Mine":
      the 1999 and 1987 remasters grouped on `match_key`, 1 link. The real outcome, not the
      deferred one §4.1 hedged for.
- [x] 🚧 **HARD GATE PASSED TWICE** — identical re-send inserted 0 rows on both runs.
- [x] Run 1 `0c22d51b-11fe-4fea-8807-e68d60b3bbf3` — 31 plays read, 31 written
- [x] Run 2 `40f9d098-9662-4a15-8de2-fa1c7de4b9ff` — incremental: 31 already held, 1 inserted

**Notes:**

**Why the double-sync is a gate and not a nice-to-have.** It is the first real exercise of
the occurrence rule. `tests/test_dj.py` covers the property on a constructed feed — oldest=1,
per-bucket grouping, and that a new arrival does not renumber existing plays — but live data
never has: the history page contains no repeated `(video_id, played_bucket)` pair, so every
play reads `occurrence: 1 / bucket_play_count: 1` and a broken implementation would pass a
live smoke test unchallenged.

If the numbering is wrong it **fails silently**. Nothing errors. Duplicate `dj_plays` rows
accumulate daily, worst in the busiest bucket (`This week`, 105 of the current 200), and the
familiarity counts that drive cram ordering drift upward with them — so the first visible
symptom would be a cram list ordered wrongly, weeks later, for reasons that look like a
cram-logic bug rather than an import bug.

The write side works **by count, not by identity** — but not by computing N−M. Occurrences
1..N are sent and the unique index absorbs the M already held, so the gate is a **database
guarantee** rather than an assertion that the arithmetic is right.

**First-run scope is Today + Yesterday only, deliberately.** Both are `precision: day`, so
every row written has a genuinely correct date and **nothing depends on the estimate ladder**
— if something goes wrong it is the write path, not date resolution. Two variables at once
would make a failure ambiguous. Widen on the second run, once the gate has passed.

**⚠️ The first run's covered floor deliberately understates what was AVAILABLE.**
`covered_from` will be yesterday, but the page also held `This week` and `Last week` data
that was consciously not written. **A later run must not treat that as a gap to backfill —
nothing is missing.** The run's `details` records `covered_floor_is_deliberate: true` for
exactly this reason; without it, phase 5's gap logic inherits a phantom hole and would
re-import data that was skipped on purpose.

**⚠️ "Not exercised" is not "passed".** 31 plays across ~15 tracks may contain no variant
pair, in which case canonical auto-linking never fires; the live page has also historically
held zero repeated `(video_id, bucket)` pairs, in which case the multi-occurrence path never
fires either. Where that happens the honest outcome is **NOT EXERCISED, recorded here as
such** — not a green tick. Phase 8's Takeout import produces both in volume and is the real
test. A gate that passes because it was never triggered is worse than one openly deferred,
because it stops anyone looking again.

### Findings from the live runs

**Run 2 was a deliberate attempt to exercise multi-occurrence dedupe, and it failed to —
which is how both of the findings below were found.** "Happy Together" was played three
times. The feed reported it ONCE, `bucket_play_count: 1`, and `Today` went 28 → 29 rather
than 28 → 31. Re-checked 70 minutes later: still one. In the same window 12 *different*
tracks moved `Today` 29 → 41, exactly +12 — one entry each.

**THE MODEL: YouTube's history feed carries ONE ENTRY PER TRACK PER BUCKET, positioned at
that track's most recent play. Repeats do not stack.**

#### ⚠️ FINDING 1 — play counts are not obtainable from polling

Polling can establish **that** a track was played on a day. It can never establish **how
many times.** Three plays produced one entry; twenty would produce one entry.

§5 defined cram ordering as "play count for the track's canonical group". **That number
cannot be measured from this source.** §5 rewritten: familiarity is now **the number of
DISTINCT DAYS on which the canonical group appeared.** A different quantity, adopted
knowingly as the proxy rather than pretending counts are real — and one that happens to be
immune to the same track being recorded by both the poll and Takeout.

**`occurrence` now exists solely to serve phase 8's Takeout import**, which has real
per-play rows. Nothing in the daily poll will ever produce `occurrence > 1` — not rarely,
never.

#### ⚠️ FINDING 2 — the dedupe key was broken in BOTH directions

Key was `(user_id, track_id, played_bucket, occurrence, source)`.

- **Too unstable.** A play's label changes as it ages, so one real play mints a fresh row at
  each stage: `Today` → `Yesterday` → `This week` → `Last week`. Four rows, one play.
- **Not discriminating enough.** Two genuinely different plays on different days both arrive
  labelled `Today`, form the same key, and `ON CONFLICT DO NOTHING` silently drops the
  second. No error, no count, nothing in the run log. **A track played on twenty days keeps
  ONE row, dated the first capture.**

Together these **invert the system**: the tracks returned to most often are under-counted
worst, and "how long since I heard this" answers with the *first* time rather than the most
recent — the exact opposite of what §4.2 was built to deliver.

**Nothing currently stored is wrong.** All 32 rows are correct with no duplicates; the
damage is entirely prospective. Fixed by Migration Block F plus the paired handler change.

#### ⚠️ FINDING 3 — the schema comment asserted the opposite

`dj_plays.played_bucket` carried: *"it is the dedupe key: a play drifting from This week to
Last week keeps its original bucket and does not re-insert."*

The **stored** row keeps its bucket. The **incoming** row does not — it carries the new
label, forms a different key, and inserts. The comment asserted a drift immunity the index
never provided. Under the platform contract `COMMENT ON` is design truth, so this is worse
than a stale doc: it is a false invariant that would be trusted. Corrected in Block F.

### Migration Block F — ✅ APPLIED 2026-08-27

`supabase/migrations/005_dj_plays_dedupe_key.sql`. Re-keys `dj_plays` on `played_on` and
rewrites three `COMMENT ON` statements.

**The key alone is not sufficient, and checking that was the substantive part of the
design.** Coarse buckets resolve to `poll_date − 2` and `− 9`, which move every day — so
keying on `played_on` would reproduce the same disease in a new column. **The poll therefore
ingests PRECISE buckets only (`Today`, `Yesterday`)**, which resolve stably:

| Day | Label | Resolves to |
|---|---|---|
| Tue | `Today` | Tue − 0 = **Tue** |
| Wed | `Yesterday` | Wed − 1 = **Tue** |

Same play, same `played_on`, so it dedupes across the transition instead of duplicating.
**The key and the ingest rule are one mechanism; neither is correct alone** — which is why
the restriction is enforced in the `record_dj_plays` handler (`INGESTIBLE_BUCKETS`) rather
than left to the caller, where phase 5's scheduled task would have to remember it forever.

Coarse buckets are still **read** for gap detection, just never written. Tolerable because
the poll is daily, and consistent with §6: a gap beyond the ~200-item page is unrecoverable
from the live API regardless.

**ORDER MATTERS: migration first, then deploy.** The new handler names the new conflict
target and PostgREST rejects an `ON CONFLICT` with no matching unique index.

**Applied 2026-08-27:**
- Pre-flight duplicate check returned zero rows — no stored row collided under the new key.
- Constraint swapped; `dj_plays_user_id_track_id_played_on_occurrence_source_key` verified
  present, no index mentions `played_bucket`.
- Album `UPDATE` ran; `select album ... where album is not null` now returns zero rows.
- Five `COMMENT ON` statements applied, including the false `played_bucket` claim.
- `check_platform_conformance` → **CONFORMANT @ 27**.
- `npx supabase functions deploy mcp --no-verify-jwt` — `dj-courier.ts` and
  `dj-normalise.ts` uploaded; auth confirmed still working by calling an existing tool.

⚠️ **Process note: the COMMENT ON statements were missed on the first attempt** because the
instruction said "take these from the file, they are long" rather than giving the SQL
inline. The index swap succeeded and the comments silently did not run — the migration
looked done and was not. **Hand over complete, runnable SQL, never a pointer to a file.**

#### ⚠️ FINDING 4 — `dj_tracks.album` records the wrong thing entirely — FIXED IN BLOCK F

30 of run 1's 31 rows record `"Summer Jazz: Herbie Hancock"` — including tracks by Wayne
Shorter, Jackie McLean and Lionel Loueke, who have nothing to do with that compilation.
**The field records what was listened THROUGH, not what the track is FROM.**

There is no signal to filter on: the mix arrives carrying a real `MPREb_` album browse id,
structurally identical to a genuine album.

**Nulled rather than flagged.** The feed is not giving a lower-confidence album, it is
giving a different thing, and a flag would preserve a value nobody should ever read.

**Nulled for ALL poll-sourced rows rather than only detected ones, because `dj_tracks` is
insert-only.** `album` is frozen at write, so a detection rule has to be right at insert
time from one batch alone — and the cross-artist signal that reveals a mix is
*retrospective*. An album looking single-artist today may be multi-artist next week, by
which point the row cannot be corrected. Every false negative would be permanent, and the
signal also cannot separate contamination from a genuine various-artists compilation.
Losing a real "Criss-Cross" is the acceptable price for not storing 30 lies.

Folded into Block F rather than deferred to phase 3 on cost-curve grounds: trivial at 31
rows, thousands of frozen wrong values after Takeout. `record_dj_plays` now discards album
on the poll path and **reports `albums_discarded` in its result** — visible, not silent.
`dj_albums` must be fed from a real lookup or from Takeout, never from the history feed.

**The pre-flight diagnostic, recorded before the column was nulled** (2026-08-27):

| album | n_tracks | n_artists | verdict |
|---|---|---|---|
| `Summer Jazz: Herbie Hancock` | 30 | **4** | mix — Herbie Hancock, Wayne Shorter, + 2 |
| `Criss-Cross` | 1 | 1 | genuine — Thelonious Monk |
| `Weezer (Teal Album)` | 1 | 1 | genuine — Weezer |

So nulling loses **two** real values, not one. Both are written down here because the
knowledge is worth keeping even though the column is not. **30 of 32 album values were
wrong** — the ratio that made the decision easy.

**⚠️ And the Teal Album row corrected a spec error.** §7 phase 3 claimed *Happy Together*
was "a Turtles cover with no Weezer studio recording. Live-only." It is on **Weezer (Teal
Album)**, the 2019 covers record — proven by a play of it carrying that album. Phase 3 would
have gone hunting for a live-only recording that it did not need. **The other three hazard
notes came from the same memory and are now flagged for re-checking.** A field wrong 30
times out of 32 was still right about the one thing nobody had verified.

> **Consequence to know:** a track first seen via poll keeps `album = NULL` forever, since
> insert-only never revisits it. Making `album` a NULL→value exception to insert-only would
> fix that and is the natural follow-up once a real lookup exists. Not proposed now.

### Recorded, no action

- **UNEXPLAINED — the page tail is not a simple queue.** Adding one play to `Today` should
  push one item off the oldest end. Observed: `Today` 28 → 29, `This week` 105 → 104,
  `Last week` 64 → 64. The departing item came from the middle. **Logged, not theorised
  about.** Now a 🛑 **blocking precondition on phase 5** — if items can leave from the
  middle, the tail is not a coverage floor at all.
- **`canonical_links` now carries the target's `video_id` and `title`**, not just its uuid.
  Reviewable at n=1; useless at Takeout volume. Done in this pass.
- **Capture `oldest_bucket_is_partial` in `platform_runs.details`** — for phase 5's runbook.
- **⚠️ DROPPED INFERENCE.** Phase 2b concluded from "31 distinct tracks" that Alex does not
  replay tracks, with implications for cram logic. **That conclusion is withdrawn** — he was
  listening to a jazz mix, so distinctness is expected. The observation stands; the inference
  did not follow, and says nothing about how a concert playlist gets played front to back.


### Post-Block-F verification (2026-08-28)

**Test 1 — coarse bucket rejection: PASSED.** A single `This week` play was rejected, no
rows written; the error named §4.3 and pointed at Takeout.

**Test 2 — poll write: PASSED.** 30 plays from `Today`, 30 tracks created, 30 inserted,
`albums_discarded: 30`. Re-sending 3 of the same rows returned `plays_inserted: 0`,
`plays_already_held: 3`, `tracks_created: 0` — the unique index absorbing repeats and
`dj_tracks` staying insert-only, now confirmed against the NEW key.

**Test 3 — Today→Yesterday convergence: ✅ VERIFIED 2026-08-29.**

41 rows, 41 distinct tracks, **zero duplicates in `dj_plays`.** Yesterday's 30 plays came
back under `Yesterday`, resolved to the same `played_on: 2026-08-28` the `Today` capture
used, and re-matched instead of minting second rows. **Block F's last unverified mechanism
is now confirmed against live data** — every prior test used a constructed feed.

Arithmetic: the `Yesterday` bucket offered 41; **29 re-matched and 12 inserted**, totalling
41. See finding 3 below for the missing one.

### ⚠️ FEED INSTABILITY — third finding, and the one that changes phase 5

**One of yesterday's 30 stored plays vanished from the feed entirely.** It exists in the
database with no upstream counterpart. Not a duplicate, not a dedupe failure — a dropout.

That is now **three** independent observations that the feed misreports the past:

| # | Observation | Phase |
|---|---|---|
| 1 | Items leave the page from the MIDDLE, not the tail (`Today` 28→29 while `This week` 105→104) | 2b |
| 2 | `oldest_bucket_is_partial` — the page edge truncates a bucket mid-way | 1 |
| 3 | **A previously-present play disappeared from the feed while still stored** | Block F verification |

Individually minor. Together they say something the design does not currently assume:

> 🛑 **THE FEED IS LOSSY, NOT MERELY TRUNCATED. Phase 5's gap logic must assume plays can
> disappear from the middle of a window it has already covered.**

Truncation and lossiness are different failure modes and **only truncation is accounted
for**. A gap calculation that reasons "we saw back to X, therefore everything after X is
covered" is unsound against a feed that can drop an item it previously served. Worse, the
DIRECTION of the error is silent: a dropout makes coverage look complete.

Practical consequence: **`dj_plays` is the authority on what was heard, not the feed.**
Re-polling a covered window can legitimately return fewer rows than are stored, and that is
not evidence of a bug. A sync that finds fewer plays than it holds must not "correct"
anything — `dj_plays` is append-only and a dropout is not a deletion signal.

**`albums_discarded` is a POLICY counter, not a filter-quality signal.** It came back 30 of
30 and 3 of 3, which is correct: the poll discards **every** album unconditionally, so the
number always equals the count of submitted plays that carried one. Flagged by a reviewing
Claude as unable to distinguish working from broken — true, and worth stating, because the
name invites reading it as a test result. It reports how much was dropped, nothing more.
Clarified in the tool description and in the handler comment.

**⚠️ A `platform_runs` row WAS owed for the test-2 write and was initially skipped** on the
grounds that manual invocations should not distort staleness detection. That reasoning is
backwards here: **30 real plays were permanently written.** The run log records coverage,
and coverage of 2026-08-28 genuinely happened. Omitting the row does not keep the log clean
— it makes the log disagree with the data, so phase 5 would see 2026-08-28 as an uncovered
gap and try to backfill a day that is already complete. **A run row is fake when no data
was written, not when the trigger was manual.**

---

## Phase 3a — Playlist write tools ✅ COMPLETE

- [x] §2 amended: Workshop never writes to Supabase; it DOES write to YouTube Music
- [x] `workshop/workshop/tools/dj_write.py`, registered in `tools/__init__.py`
- [x] `search_dj_music` (tier 1), `create_dj_playlist` (tier 2), `edit_dj_playlist`
      (tier 2, mode add|move), `remove_from_dj_playlist` (tier 3, mode remove_items|delete_playlist)
- [x] `_shared/tools/dj-tracks.ts` — shared canonical resolver
- [x] `_shared/tools/dj-playlists.ts` — `record_dj_playlist` + `create_dj_concert` (both tier 2)
- [x] Registered in `mcp/index.ts`; deployed; auth verified after deploy
- [x] Tests: 57 Alfred-side + 52 Workshop, all green
- [x] Restart dev Workshop; tool count 5 → **9**
- [x] **Fresh conversation**; all four checks passed, nothing deleted, concert row
      `c3085a27-6b73-4dd4-b24b-06412526c168` seeded
- [x] Follow-up: tier-3 proposals now resolve their target; `rename` mode added

**Notes:**

**Tier forced the tool split.** Tier is a property of the tool, not the call, so a
mode-based tool cannot span tiers — that is why `remove_from_dj_playlist` stands alone
instead of being a third mode on `edit_dj_playlist`.

**⚠️ Track resolution was EXTRACTED to `dj-tracks.ts`, not copied.** `record_dj_playlist`
needs the same video_id → `dj_tracks` resolution that `record_dj_plays` does. Duplicating it
would be the §4.1.2 hazard exactly: two copies of canonical grouping would not error when
they diverged, they would silently group one import path differently from the other — and
`dj_tracks` is insert-only, so those rows could never be corrected. One implementation, both
callers. `record_dj_plays` was rewired to it and its 23 tests still pass unchanged.

**⚠️ `dj_concerts.artist_id` is NOT NULL with ON DELETE RESTRICT**, so a concert cannot
exist without a `dj_artists` row. `create_dj_concert` resolves the artist by name and creates
it if unknown — the FK is a schema detail, not something a caller should have to sequence.

**⚠️ Search cannot fail, only be wrong.** Probing `Weezer Happy Together` returned the Teal
Album cover at #1 and **The Turtles' original at #2** — adjacent, both plausible. That is why
3b gates on human review of all twelve resolutions before anything is created.

**ytmusicapi's `limit` is a fetch hint here too** — `search(limit=3)` returned 20, exactly as
`get_playlist(limit=100)` returned 160 in phase 1. Sliced in the handler. Third confirmation;
treat it as universal for this library.

### Follow-ups from the 3a verification

**⚠️ The tier-3 gate stopped accidental EXECUTION but not accidental WRONG TARGET.**
The delete proposal echoed back its arguments and nothing else — no title, no track count,
no confirmation the id even existed. So one mistyped character produced a proposal that read
exactly as reassuring as the correct one, and confirming it would have deleted something
else. A speed bump only works if a human can read it, and there was nothing to read.

**Fixed at the PLATFORM level, not in the tool.** `define_tool` now takes a `preview`
callable and **requires it for tier 3 at registration time**. The gate runs it and embeds
the result as `target` in the proposal. Doing it per-tool would have made "a destructive tool
can say what it would destroy" a habit each tool re-forms; requiring it makes it mechanical —
the same reasoning as the existing schema-parity assertion. A preview that raises is reported
*inside* the proposal with a "do NOT confirm" warning, because an unresolvable id is usually
a wrong id and that is precisely what the reader needs to see, not a transport error.

`remove_from_dj_playlist`'s preview reports title, track count, owner, privacy and the
concrete effect — and for `remove_items`, **how many of the requested entries actually
match**, so a stale `set_video_id` surfaces before confirmation rather than as a silent
no-op afterwards. Four new platform tests (56 total).

**⚠️ The search collision is six-way, not two-way.** One query for "Happy Together" returned
six distinct recordings under that exact title — Weezer, The Turtles, Gerard Way, Filter,
Johnny Cash, and King Princess with Mark Ronson. Picking by title alone is a one-in-six
guess. The tool description now says title collisions are **routine, not an edge case**, and
that the artist must be **matched, not merely noticed** — a result whose artist does not
match is a NON-match however well the title fits.

**Consequence for 3b: presenting twelve resolutions is not sufficient** if each was chosen
from six plausible candidates. For any title where the top results disagree on artist, the
alternatives must be shown, not just the pick.

**`rename` mode added to `edit_dj_playlist`** — needed to park the old Weezer playlist
before the rebuild rather than delete it.

**Not exercised: every write path.** The tools are registered, typed and unit-tested, but
**no YouTube mutation has been performed.** Creating or deleting a playlist changes Alex's
real account, so that is his verification to run, not mine.

---

## Phase 3b — Weezer rebuild (first playlist writes)

- [ ] Delete the existing 160-track Weezer Concert playlist
- [ ] Create replacement; populate the 12-song body in order (spec §7, phase 3)
- [ ] Resolve the four hazard titles — Happy Together (cover, live-only), I Just Threw
      Out the Love of My Dreams (B-side), Go Away, Shine Again
- [ ] Seed `dj_playlists` / `dj_playlist_tracks` rows (all `role: body`)
- [ ] Seed `dj_concerts` row: Weezer, Las Vegas, Oct 2026, `committed`
- [ ] Verify order in the YouTube Music app

**Notes:**
- Setlist source resolved — supplied manually, not from setlist.fm. Phase order unchanged.
- The 12-song seed is knowingly short (a touring set is 18–22). The gap is phase 7's job.
- **Measured how broken it is (phase 1 read, 2026-08-27):** of 160 entries, **49 video_ids
  appear more than once**, many exactly four times at a regular stride — My Name Is Jonas at
  positions 0, 22, 71, 120; Undone at 1, 18, 67, 116; Pork And Beans at 2, 23, 72, 121. It
  looks like a discography appended roughly four times over. Every copy carries its own
  distinct `set_video_id`, so they are real separate entries, not a read artifact.
  Confirms "nothing to lose" — delete and rebuild rather than dedupe in place.

---

## Phase 3b — Weezer rebuild ✅ COMPLETE

- [x] Old playlist RENAMED-in-spirit — actually left untouched; rename proved unnecessary
      since a playlist's title has no bearing on whether its tracks are readable
- [x] Mined the old playlist for resolved video ids — **all twelve resolved from it**
- [x] Created replacement: **`PLGhCMggoJnIc`**, "Weezer Concert 2026", UNLISTED, 12 tracks
- [x] Order verified position by position, 0 Jonas → 11 Buddy Holly
- [x] Seeded `dj_playlists` / `dj_playlist_tracks` — Supabase row
      `96eaf6f4-9781-4341-9147-4271bded0638`, all 12 `role: body`, positions 1–12
- [x] `dj_concerts` row `c3085a27-6b73-4dd4-b24b-06412526c168` (seeded during 3a)
- [x] Verified in the YouTube Music app by Alex
- [x] Old playlist confirmed untouched: still 160 tracks, still "Weezer Concert"

**Notes:**

**Confirmed property: `create_dj_playlist` preserves `video_ids` order on creation.** A
fresh setlist needs no follow-up `move`. Confirmed against live data, not assumed — the
twelve came back in exactly the order sent.

**`tracks_created` was 11 of 12** — one track already existed in `dj_tracks` from history
recording. The shared resolver reused it rather than duplicating, which is the insert-only
guarantee working across two different write paths.

**`count` came back as an INTEGER this time** (12, 160) — the phase-2b string-coercion fix
confirmed on live data.

**Step 3 was never exercised.** All twelve resolved from the old playlist, so no search ran
and the six-way "Happy Together" collision never got a chance to bite. The pre-resolution
work done in this session is why. Recorded as not-exercised, not as passed.

### ⚠️ THE FINDING: `set_video_id` is recycled across playlists

Eleven of the twelve handles on the brand-new playlist **already existed in the old one**,
and three denoted a *different song* there — Go Away and I Just Threw Out swapped handles,
and Buddy Holly took the handle Say It Ain't So has in the old playlist. Within one playlist
the values are unique (160 entries, 160 distinct handles).

**A stale handle fails loudly. A handle from another playlist matches a real entry and
SUCCEEDS** — a move or remove on the wrong song, reported as success. Same class as the
stale smoke row: a wrong answer that looks right.

**Fixed structurally, not just documented.** `edit_dj_playlist` mode `move` now REQUIRES
`video_id` alongside `set_video_id`, and both it and `remove_from_dj_playlist` re-read the
target playlist and verify the pair before acting — turning a foreign handle into a clean
`stale_or_foreign_handle` error. One extra read per operation, affordable precisely because
§5 already puts cram rebuilding in the weekly job. Written into spec §5, since **phase 7 is
the consumer**: bulk cram reordering is exactly the pattern that would cache handles.

### Canonical linking — DEFERRED, not passed

`canonical_links_made` is `0`. No variant pair exists among the twelve; every one is a
distinct song from a distinct release. **The gate did not pass, it never fired.**

**A live test case exists and is verified.** The old playlist contains *All My Favorite
Songs* twice — `2-NJMRHY0Kc` (OK Human album cut) and `jFIXI6OekbY` (feat. AJR). Both
normalise to `weezer|all my favorite songs`, checked against the real rule, **so they WOULD
group.** Use this pair as the deliberate test whenever a phase exercises canonical linking.

### Prior signal: the old playlist's head is this setlist

Positions 0–12 of the old playlist are the twelve target songs — with **#8/#9 transposed**
(I Just Threw Out before Go Away) — **plus *Perfect Situation* at position 12**. Someone had
already built this setlist; the 160-track mess is that head followed by a 49-song block
repeated three times.

**That is prior signal, not noise.** Before phase 7 rebuilds the setlist from setlist.fm, it
is worth knowing that a thirteenth song was once on it and that the 8/9 order was once the
other way round.

---

## Pre-Phase-5 batch (2026-08-29)

- [x] `get_dj_plays` built, tested (18 cases), deployed — Alfred **29 → 30 tools**
- [x] Tier-3 preview — **was already built** in phase 3a; appeared outstanding only because
      dev Workshop had not been restarted since. No code needed.
- [x] `canonical_links` identity fields — **already built and deployed** in
      `dj-tracks.ts`; looked absent in 3b because `canonical_links_made` was 0
- [ ] Restart dev Workshop (lands tier-3 preview, `move` pair-verification, `rename`,
      credential fix)
- [ ] **Fresh conversation**; verify `get_dj_plays` both modes

**`get_dj_plays` — tier 1, two modes.**

`plays` returns raw rows newest-first with the track inlined, a real `total` from a count
query, and date/source/video_id filters. `familiarity` returns one row per canonical group
**sorted least-familiar first, which is cram order directly** (§5).

**Zero-play tracks come back, and that is the point rather than an edge case.** familiarity
reads `dj_plays`, so a never-played track produces no row — yet those are exactly the songs
that belong at the TOP of a cram list. When `video_ids` is supplied, **every id gets an
entry**, including ids unknown to `dj_tracks` entirely (`known_track: false`) — a newly
discovered setlist song would otherwise be invisible twice over. Leaving the caller to
notice what came back missing is reconstruction logic that gets written once, forgotten,
and then quietly wrong.

**`distinct_days: 0` is a fact; `days_since_last: null` means NEVER.** The null-vs-zero
distinction is deliberate and stated in the tool description.

**An enumerated subject is never truncated.** `limit` applies only to the date-range form —
clamping a familiarity result the caller explicitly enumerated would recreate the
reconstruction problem the zero-play rule removes.

**Errors rather than truncates above a 5000-row scan cap.** Truncation that shortens an
answer is fine; truncation that *corrupts* one is not — a clamped aggregate returns a
`distinct_days` that is wrong rather than short, and the caller sorts by it. Same reasoning
as the 500-play submission limit.

**`estimated_days`** counts days made only of coarse-bucket guesses. Expected to be 0 — the
poll writes `day`, Takeout writes `exact` — which is exactly why it should be visible if it
ever isn't.

**Deferred: the unbounded all-time ranking.** Needs a Postgres RPC to aggregate server-side
(the pattern `get_items` uses via `platform_search_items`), which is a migration. Not
guessing at its shape before a consumer exists.


### Verification pass 2026-08-28 — results

**Tier-3 preview: ✅ VERIFIED.** A real playlist resolves with title, 160 tracks, owned,
privacy and a concrete effect statement; a mistyped id returns `resolved: false` with a
plain "do NOT confirm" warning above the raw error. The gate now stops a wrong TARGET, not
just accidental execution.

**Canonical grouping: ✅ VISIBLY WORKING on live data.** *The Pleasure Is Mine* reads
`distinct_days: 1` with `play_rows: 2` across two video_ids — which is precisely why both
fields exist, and the first live confirmation that variant grouping counts as one song.

**⚠️ Zero-play rule: STILL UNTESTED. Check C could not test it and I wrote it wrongly.**
All twelve setlist songs turned out to have plays, so the query returned 12 because twelve
tracks have plays — **not** because zero-fill worked. **If zero-fill were entirely broken
that exact query would still return 12.** A check that cannot fail is not a check.

Both cases ARE built and unit-tested (`dj-reads.test.mjs:80` known-with-no-plays,
`dj-reads.test.mjs:95` unknown-to-dj_tracks). Neither has live coverage.

**⚠️ There is probably no live subject for the known-but-unplayed case.** Every `dj_tracks`
row originates from `record_dj_plays` (which writes a play by construction) or from the
twelve written by `record_dj_playlist` — and all twelve have plays. **Zero-play tracks do
not currently exist in the database.** Options: add *Perfect Situation* (`Mpp3vUZKuzc`,
position 12 of the old playlist's head, a genuine setlist candidate) which would create one
naturally; or accept that phase 7 is the first live exercise. A fabricated video_id can
exercise the unknown-id case today at no cost.

**`unknown_video_ids` is a DIAGNOSTIC LIST, not a substitute bucket.** Unknown ids appear
both in that list AND as zero rows with `known_track: false`. The empty list in the
verification read meant "no unknown ids were passed", which reads misleadingly like
"unknowns are excluded". Naming issue, not a behaviour issue.

**Dev-vs-Surface divergence: RULED OUT by the repo.** `dj_write.py` is **byte-identical**
between `17d06ba` (Surface) and `131d87e` (Dev) — the whole file arrived in one commit
(`588ba28`) with `rename`, `_verify_entries`, `_preview_removal` and
`stale_or_foreign_handle` together, and `17d06ba` is an ancestor of `131d87e`. A frozen
conversation manifest served old tool descriptions against a restarted server.
**The only workshop-side difference between the hosts is `dj.py`** — the `credential_state`
fix, which matters for phase-4 diagnosis and nothing else.


### Verification pass 2026-08-29 — results

**Check 1 — zero-fill: ✅ PASSED, and it is the first zero-play check that COULD have
failed.** A deliberately fake id returned `distinct_days: 0`, `days_since_last: null`,
`known_track: false`, appearing in **both** the diagnostic list and `groups`, sorted first.
Never-played sorting to cram position one is correct (§5). Broken zero-fill would have
returned 1 rather than 2 — spec §11.1 applied and working.

**Check 2 — Perfect Situation: ALREADY DONE.** The playlist already held 13 tracks with
Perfect Situation present, `role: body`, cram 0, `concert_id` linked. **Phase 3b included
the 13th track from the start**, so the "add it on the merits" proposal was a decision
already made. Supabase agrees with YouTube: `96eaf6f4-9781-4341-9147-4271bded0638` ↔
`PLGhCMggoJnIc`. Nothing to fix.

**Check 3 — known-but-unplayed: NOT EXERCISED, and there will be no live subject.** Every
`dj_tracks` row arrives either via a play (which creates one by construction) or via a
setlist that has been played through. **Phase 7 is the first live exercise.** Recorded
as-is; deliberately not engineered around.

**⚠️ Check 4 — `by_bucket`: PASSED, but against a NO-OP run only.** `Yesterday` came back
with `submitted: 0` despite never being sent, so the explicit zero works. But all three
`Today` plays were `already_held`, so **no rows were inserted at all** — the insert path
was never exercised. **Re-verify against a poll that actually writes.** This is spec §11.1
again in miniature: the zero was demonstrated, the insert attribution was not.

**⚠️ SOMETHING OTHER THAN A SCHEDULED TASK IS WRITING PLAYS.** Today's sync had already run
before that conversation opened, and **no scheduled task exists yet** — so it was run
manually from somewhere else.

> 🛑 **Phase 5's gap logic assumes the scheduled task is the only writer. It is not, and it
> may never be.** A manual sync is indistinguishable from a scheduled one in `dj_plays`, and
> only distinguishable in `platform_runs` if whoever ran it stamped a row — which nothing
> enforces. Consequences: a manual run keeps coverage current and therefore MASKS a dead
> scheduled task (already recorded under phase 5's two-questions-two-filters note), and a
> run that wrote plays without stamping leaves coverage the log does not know about. The
> second is the more dangerous: the data is ahead of the record, so gap detection would
> re-poll a window already covered — harmless via dedupe, but it means the log understates
> reality and nothing flags it.


### `get_dj_managed_playlists` verification 2026-08-29 — all four passed

**Checks 1, 2, 4 passed.** List mode returned `track_counts {body: 13, cram: 0}` and
`cram_headroom: 8`; tracks mode returned 13 with `missing_set_video_id: 0`; an unrecorded
playlist errored loudly naming `record_dj_playlist` rather than returning empty.

**Check 3 passed — recorded order matches YouTube for all 13.** The first live run of what
phase 7's diff will do.

**⚠️ Two caveats from that pass, both worth keeping:**

**Every cached `yt_set_video_id` currently matches the live one — that is a COINCIDENCE OF
TIMING, not a guarantee.** The playlist was recorded minutes after it was built and nothing
has moved since. The refresh-before-every-move rule stands unchanged; a matching cache today
is not evidence the cache can be trusted tomorrow.

**⚠️ THE §5 INTERLEAVING RULE IS STILL UNVERIFIED.** Check 3 ran against an **empty cram
block**, so what passed is the degenerate case where "every cram row by position, then every
body row by position" reduces to "body order, unchanged". **Every wrong implementation of
the rule gives the same answer when cram is empty.** Recorded as **NOT EXERCISED**, not as
passed — spec §11.1. The rule is covered by unit tests with a deliberately discriminating
fixture (`dj-reads.test.mjs`), but has never run on real data.


### ⚠️ THE SCHEMA HAS NO SOURCE OUTSIDE THE DATABASE — REPO-WIDE, NOT A DJ GAP

**Corrected.** An earlier version of this note said "the DJ schema has no source", which
implied DJ was uniquely undocumented. It is not — **this is how the whole repo has always
worked.**

Only **six of 29 registered tables** have a `create table` anywhere in
`supabase/migrations/`: `sam_songs`, `sam_sessions`, `sam_snippets`, `item_collections`,
and the two reconstructed here. **Missing entirely:** `items`, `contexts`, `intents`,
`events`, `executions`, `inbox`, `sam_song_measures`, `sam_song_lyrics`,
`sam_song_fingerings`, `sam_session_events`, `collection_items`,
`collection_item_removals`, and all nine remaining DJ tables.

**The existing migration files are documentation, not a runnable build.** Every original
says *"Run this in the Supabase SQL Editor"* in its header; the filenames are `001_`–`005_`
rather than the CLI's required `<14-digit timestamp>_name.sql`, so **the CLI has never
applied them and there is no remote migration history**; and `001_sam_tables.sql` uses bare
`CREATE TABLE` with no `IF NOT EXISTS`, so it cannot be re-run. They are a chronological
record of selected changes, each with prose explaining *why* — which is valuable, and a
different thing from a schema source.

**Adopting CLI migrations properly is a PROJECT-WIDE decision affecting Alfred and SAM —
explicitly not something to decide inside DJ phase 5.** It would mean repairing remote
history, renaming every file, and taking a baseline; it touches every app.

**Chosen route: a schema SNAPSHOT, outside `migrations/`.**

```
supabase db dump --schema public,platform -f supabase/schema-snapshot.sql
```

Rather than hand-reconstructing the nine remaining tables. A hand reconstruction is
best-effort introspection while a dump is authoritative — so **the hand version would itself
be a record that cannot be checked against the thing it describes, which is §11.4 appearing
inside the fix for §11.4.**

Outside `migrations/` on purpose. Placed inside it, a pulled or dumped file would collide
three ways: **naming** (a timestamped file alongside `001_`–`005_` breaks the ordering
convention), **granularity** (a flat snapshot duplicates `001` and `002`, creating two
sources for `sam_songs` and `item_collections`), and **run-vs-document ambiguity** (the
existing files announce "paste this into the SQL editor" and are not idempotent, whereas a
dumped file looks CLI-managed and runnable).

⚠️ **`--schema public,platform` is not optional.** `db dump` and `db pull` default to
`public` only, which would omit the `platform` schema — `register_table`,
`check_conformance`, `audit_row`, `registry`. That is the load-bearing part of the contract.

⛔ **BLOCKED ON DOCKER (2026-08-29).** `supabase db dump` requires Docker Desktop and it is
not installed on this machine (`docker: command not found`). Credentials were NOT the
problem — the CLI got as far as *"Initialising login role... Dumping schemas from remote
database..."* using the linked project's stored credentials, then failed with
`LegacyDockerRunError`. **It also left a 0-byte `schema-snapshot.sql`, which was deleted** —
an empty snapshot is the staleness trap in its purest form, a file that looks current and
says nothing.

🛑 **NOTHING ENFORCES REGENERATION.** The snapshot must be re-dumped whenever the schema
changes, and no check will notice if it isn't. **A stale snapshot is worse than none,
because it looks current** — §11.4 again, which is exactly why the file carries its
generation date in a header line and lives outside `migrations/` where it cannot be mistaken
for the thing that built the database.

### ⚠️ `platform.registry` retains a row for a DROPPED table

`get_platform_contract` lists **`public.dj_sync_runs`** among registered tables.
`get_database_schema('dj_sync_runs')` returns **"table not found"** — it was dropped in
Block D, when `platform_runs` and `platform_schedules` replaced it.

The registry lists **28 non-exempt** tables; `check_platform_conformance` reports **27**.
Conformance passes because it checks tables that exist; **nothing checks for registry rows
whose table does not.** So the contract's own inventory has advertised a non-existent table
since Block D and no check has ever noticed.

**This is §11.4 inside the platform layer**: a record that cannot be checked against the
thing it describes, disagreeing with it silently. It is not DJ-specific — it belongs to the
platform contract and the `mcp-platform` skill, and either `register_table` needs an
`unregister_table` counterpart or conformance needs to flag orphaned registry rows.

**The orphan row itself is trivial to remove** and should be, since an inventory listing a
non-existent table is actively misleading:

```sql
delete from platform.registry where table_name = 'public.dj_sync_runs';
-- then: check_platform_conformance  -- expect CONFORMANT, and the registry drops to 27
```

(Run in the SQL editor — the `platform` schema is not reachable through PostgREST, so no
tool can do it. Verify the column name against `select * from platform.registry limit 1`
first; `table_name` is inferred from the contract text, not confirmed.)

**The MISSING CHECK is not fixed here, deliberately.** Conformance validates tables that
exist; nothing validates that every registry row still HAS a table. Adding that is a change
to the platform contract and the `mcp-platform` skill, affecting Alfred and SAM as much as
DJ — out of scope for DJ phase 5, and recorded so it is not rediscovered.


### ✅ Takeout export arrived 2026-08-29 — measured, not imported

`workshop/data/dj/watch-history.json` and `search-history.json` (gitignored, desktop only).
**Nothing has been parsed or imported.** Phase 8 is not started. These are counts only.

| | |
|---|---|
| watch-history.json | 7.0 MB, **18,188 entries** |
| Oldest | **2024-09-19T16:55:15Z** |
| Newest | 2026-08-29T16:08:20Z (today) |
| Reach | **~23.3 months, unbroken** — every month from 2024-09 to 2026-08 present |
| Per year | 2024: 2,961 · 2025: 9,696 · 2026: 5,531 (partial) |
| YouTube Music entries | **15,525** |
| Plain YouTube entries | 2,663 |
| `- Topic` channel entries | **16,766** |

**⚠️ AUTO-DELETE HAS PROBABLY NOT PRUNED IT, and the reasoning is checkable rather than
reassuring.** Google's activity auto-delete settings are 3, 18 or 36 months. Measured from
2026-08-29 those boundaries fall at 2026-05-29, 2025-02-28 and 2023-08-29. **The oldest
entry, 2024-09-19, matches none of them** — it sits nearly 19 months before the 18-month
boundary and well after the 36-month one. A pruned history would end ON a boundary. So
2024-09-19 most likely marks where the account's history genuinely begins.

**Scale, for context:** `dj_plays` currently holds ~71 rows. Takeout is **roughly 250×**
that, and it is the only source with real timestamps and per-play rows — so it is the only
thing that can ever measure true play counts or exercise `occurrence > 1` (spec §7 phase 8).

**⚠️ The two music filters disagree by 1,241 entries.** `header: "YouTube Music"` gives
15,525; `- Topic` channels give 16,766. Spec §7 phase 8 says to filter on `- Topic` and
review the classification before committing rows — **that gap is what the review is for**,
and neither number should be assumed correct in advance.



### Album nulling — confirmed built, and the rule that generalises

**It was implemented in Migration Block F**, in three places: `dj-courier.ts:261`
(`album: source === "poll" ? null : albumIn`, with `albums_discarded` counted and returned),
the one-off backfill in `005_dj_plays_dedupe_key.sql:138`, and the `COMMENT ON` explaining
why. Verified at the time: `select album ... where album is not null` returned zero rows.

**The detection rule is SOURCE, not content — and that generalises.** The original guess was
"same album name across tracks by different artists". That cannot work, and the reason
applies to **any field written into an insert-only table**:

> 🛑 **In an insert-only table, a value is frozen at write, so any rule that decides it must
> be correct FROM ONE BATCH ALONE.** A retrospective signal — one that only becomes visible
> as more data arrives — can never be that rule. The cross-artist signal is retrospective by
> nature: an album looking single-artist today becomes multi-artist next week, by which point
> the row cannot be corrected. Every false negative is permanent.

So the poll stores no album, unconditionally. **Playlist-sourced albums ARE kept**
(`dj-playlists.ts:165`) and that is deliberate: a playlist read returns each track's real
album — "Weezer (Blue Album)", "Pinkerton - Deluxe Edition", varying per track. **Same field
name, different meaning, different source.** The history feed gives playback context; a
playlist read gives the album.

**⚠️ The finding that prompted the re-check: `dj_tracks.album` could not be inspected by any
tool.** `TRACK_COLS` in both read tools omitted it, so a field the system had made a
deliberate correctness decision about was invisible — confirming it meant opening the SQL
editor. **A field nobody can read is a field nobody can check.** Now added to `TRACK_COLS`,
surfacing on `get_dj_plays` (inlined track) and `get_dj_managed_playlists`.



### Takeout dry run 2026-08-29 — measured, nothing written

`workshop/scripts/dj_takeout_prepare.py`. Reads only; no database, no network.

```
importable rows      15,185      distinct videos  4,563
distinct days           650      date range       2024-09-19 .. 2026-08-29 (LA)
EXCLUDED: 2,663 not YouTube Music · 321 non-'- Topic' · 19 no subtitles
```

**15,185 matches the `- Topic` count exactly** — the filter lands where predicted.

#### ✅ REPLAYS ARE RARE — distinct-days is nearly lossless

| | |
|---|---|
| `(video, day)` pairs with >1 play | **342** of 14,843 (**2.3%**) |
| Rows in those pairs | 684 |
| Maximum plays on one day | **2 — no triples in 650 days** |

**§5 adopted distinct-days as a concession after establishing that true counts are
unobtainable by polling. It turns out to lose ~2.2% — 342 plays out of 15,185.** For cram
ordering, which sorts by *relative* familiarity, that is noise. **Worth knowing before phase
7 builds on the proxy**: the worry that it was discarding a lot was unfounded.

Also: `occurrence > 1` will finally have **342 live subjects**, after being NOT EXERCISED
since phase 2b.

#### All 19 artist-less entries have a URL as their title

`Watched https://music.youtube.com/watch?v=i0BGs4v-8H4` — Takeout recorded no metadata at
all, only the link. Not a missing channel on an otherwise normal entry: **unusable, not
merely awkward.** Their video_ids are listed and recoverable later via a real lookup.

#### ⚠️ THE FIRST PARITY SUBJECTS WERE A CHECK THAT COULD NOT FAIL

The initial design listed the 15 most recent entries. **A timezone bug only manifests when
the UTC timestamp falls between 00:00 and 08:00** — late evening in Los Angeles, already
tomorrow in UTC. A play at `20:00Z` is the same date under either conversion, so those
subjects would have passed whether the code was right or wrong. §11.1, in the check written
to enforce §11.1.

**Corrected two ways:**
1. **A standalone arithmetic self-check** that needs no data and runs on every invocation:
   six discriminating timestamps either side of the DST boundary, asserting `02:30Z → the
   previous day` and `07:00Z → the same day` in PDT, `03:30Z`/`08:00Z` in PST. It aborts the
   whole script on failure.
2. **Parity subjects are now drawn ONLY from the discriminating window.** 3,528 entries
   qualify; **18 fall on days where poll rows exist**.

#### 🛑 AND THE CORRECTED CHECK IMMEDIATELY SURFACED A DISAGREEMENT TO RESOLVE

Takeout says these were played on **2026-08-27** Los Angeles time:

| video_id | UTC | Los Angeles | Takeout `played_on` |
|---|---|---|---|
| `6iGO6X1uXAM` Eddie Higgins | 2026-08-28T02:59Z | 2026-08-27 19:59 PDT | **2026-08-27** |
| `Cn3hIJhVXT8` Red Garland | 2026-08-28T02:18Z | 2026-08-27 19:18 PDT | **2026-08-27** |
| `lOy_PAVZUD4` Red Garland | 2026-08-28T02:10Z | 2026-08-27 19:10 PDT | **2026-08-27** |
| `PMeRw7YeUs8` Red Garland | 2026-08-28T01:28Z | 2026-08-27 18:28 PDT | **2026-08-27** |

**But the 2026-08-28 poll captured Eddie Higgins and Red Garland tracks in its `Today`
bucket, which resolved them to `played_on: 2026-08-28`.** If those are the same listens,
the two sources disagree by one day, and only two explanations fit:

- **(a) the LA conversion is wrong** — unlikely, the arithmetic self-check covers exactly
  this window; or
- **(b) YouTube's `Today` bucket does not align with the account-timezone calendar day.**

**(b) would be a real finding.** §4.2 treats `Today`/`Yesterday` as `precision: "day"` —
*actual*, not estimated. If YouTube's day boundary is not the account's midnight, that claim
is wrong, and every poll-sourced `day` row is potentially off by one.

🛑 **RESOLVE BEFORE IMPORTING ANY BATCH.** Compare the four video_ids above against
`get_dj_plays` with `source: "poll"`. Same `played_on` → conversion verified. Different →
stop, because 15,185 rows are about to commit to whichever answer is right.

#### Overlap mitigation: `get_dj_plays` CAN filter by source

Confirmed in code — `source` is a parameter on **both** modes, applied through
`applyPlayFilters`. So a consumer can separate poll from takeout rows and avoid
double-counting raw plays. **Within the 2024-09 → today overlap, Takeout is the better
record**: exact timestamps and per-play granularity, against day buckets from a feed known
to drop entries. The poll rows there are not merely redundant, they are inferior — but
`dj_plays` is append-only and they stay.

#### `tzdata==2026.3` added to requirements

`zoneinfo` had no tz database (Windows ships none). Pinned rather than hand-rolling DST
arithmetic. Phase 5's `poll_date` has the same requirement.



### ✅ HYPOTHESIS CONFIRMED 2026-08-29 — YouTube buckets by UTC day

**41 of 41** disagreements fell in the discriminating window; **every** in-window pair
disagreed; **every** one matched the UTC date. No mixed cases, no out-of-window
disagreements.

**UTC is FORCED, not chosen — this is the load-bearing point.** The poll receives only a
bucket LABEL and never learns time-of-day, so a poll row can **never** be converted to a
local date: the information does not exist in the feed. Poll rows can therefore only carry
UTC dates, and Takeout must match THEM. **The weaker source dictates the definition, because
the stronger one can adapt and the weaker one cannot.**

**The ~94 existing poll rows need no correction.** They already hold UTC dates. Under the
corrected definition they were right all along — only §4.2's documentation was wrong.

**Block F convergence is unaffected.** It is arithmetic, not semantic: `Today` on a run with
`poll_date = D` gives `D`; `Yesterday` on a run with `poll_date = D+1` gives `D`. Both land
on `D` regardless of what the buckets *mean*, because the resolution is `poll_date − 0` and
`poll_date − 1`. It depends only on `poll_date` advancing by one per day.

**`tzdata` is no longer needed and the pin was removed.** Nothing converts to a local
timezone any more; the only remaining `zoneinfo` use is the parity script's diagnostic
comparison. Left in, a dependency present "just in case" would hint that timezone conversion
happens somewhere — and the whole point of this decision is that it does not. It is one line
to restore.

#### ⚠️ CORRECTION: the replay number I reported was measured on the wrong date definition

I previously reported **342 repeat pairs, 2.3%, "distinct-days is nearly lossless"**. That
was computed with Pacific dates. Re-run under UTC:

| | Pacific dates (wrong) | **UTC dates (correct)** |
|---|---|---|
| `(video, day)` pairs with >1 play | 342 | **9** |
| Share of all pairs | 2.3% | **0.1%** |
| Distinct days | 650 | **663** |

**But the drop is an ARTIFACT OF THE BOUNDARY, not a change in listening behaviour.** UTC
midnight is 17:00 Pacific — the middle of an evening. A track played at 16:00 and 18:00
Pacific is one Pacific day with two plays, and **two different UTC days with one play each**.
333 of the 342 repeat pairs were split apart that way, which is also why distinct days rose
by 13.

So the honest reading is **not** "replays are rarer than I thought". It is:

- **By listening session** (Pacific day), the replay rate is ~2.3% — that number stands.
- **Under the stored UTC definition**, distinct-days loses only 0.1% *because the boundary
  already separates most same-evening repeats into different days*.
- **The cost is the other direction:** one evening's double-play can count as two distinct
  days, inflating familiarity slightly. Exactly the ±1 distortion named in §4.2, now
  measured at 333 pairs out of 15,176.

**For phase 7 this is still fine** — distinct-days is a *relative* measure and the distortion
runs both ways across all tracks. But "nearly lossless" was the right conclusion for the
wrong reason, and §5's proxy should not be described as capturing replays. It does not; it
counts UTC days.

**`occurrence > 1` now has 9 live subjects, not 342.** Still the first ever, but a much
thinner sample — the multi-occurrence dedupe path gets exercised, barely.

#### The parity guard now confirms alignment

The 15 subjects that previously resolved to `2026-08-27` under Pacific now resolve to
`2026-08-28` — matching the poll rows exactly. The script's self-check was inverted to assert
**no local-time conversion**: six cases in the window where a Pacific conversion would give a
different answer, so reintroducing one fails all six immediately.



### Takeout tranche 1 — 40 rows committed 2026-08-30

| | |
|---|---|
| submitted / inserted / already held | **40 / 40 / 0** |
| `tracks_created` vs already known | **4 vs 36** — the assertion that mattered |
| `canonical_links_made` | 0 (all distinct songs; not evidence at volume) |
| `by_bucket` | `Today: 0`, `Yesterday: 0`, `(no bucket): 40/40` ✅ |
| covered | 2026-08-25 → 2026-08-29 |
| `occurrence > 1` | none in tranche — **NOT EXERCISED** |

**Readback diff: 0 mismatches across 40 rows, byte-identical**, including all three
non-ASCII titles — `Köln…` (U+00F6), `∞` (U+221E), `♡` (U+2661). That was the specific risk
of a model acting as transport, tested and clear.

**Check A passed.** `AUAxlOfw2O0` resolved to track `d3eb3393-…` — the **same track id** as
the existing poll row. Insert-only reused it; no second group.

**The ∞ and ♡ tracks inserted cleanly with `match_key` null.** A null key is filtered out of
grouping, so they stand alone — the empty-title guard, written blind, meeting its first real
case. Had the fallback produced `coldplay|` instead, every symbol-titled Coldplay track
would have merged into one group. **Two of 4,563 permanently ungroupable is the right
outcome; recorded, not fixed.**

### ⚠️ ARTIST SPELLING SPLIT — measured, recorded, deliberately not fixed

See spec §9 for the full write-up and §11.6 for the general form. In brief: the poll and
Takeout disagree on some primary artist names, and insert-only means **whichever arrived
first wins permanently — decided by which day listening happened.**

**The narrowing that matters:** `buildMatchKey` uses `artists[0]` only, so multi-artist
collaborations are unaffected (9 of 12 pairs identical). Only a differing PRIMARY name
splits. Measured: 3 tracks stranded as `Eddie Higgins Trio` against 27 further videos that
will arrive as `Eddie Higgins`.

- [ ] 🛑 **MEASURE ALL 93 POLL TRACKS BEFORE THE BULK IMPORT.** The 3-of-12 figure is a
      SAMPLE presented as a shape; it must not be presented as the total. If the real number
      is ~3, proceed. If it is ~30, this is a different decision.
      Query: `get_dj_plays mode:"plays" source:"poll"`, paged by date, reporting only
      `video_id` + `track.artist`.

**`canonical_artist` added to `familiarity` mode output** — the same gap as `album`, one
field over. Without it, two groups for one act look like two different songs, which is
precisely the shape this limitation produces.



### Artist alias map built 2026-08-30 — verified before batch 2

Two-entry constant in `dj-normalise.ts`, canonicalising toward the poll's vocabulary.
Full write-up in spec §4.1.4.

**Verification against the export and all 94 poll tracks:**

```
EXPORT after the map:
    30 videos   Eddie Higgins        ->  Eddie Higgins Trio
    16 videos   The Red Garland Trio ->  Red Garland
   total translated: 46 of 4,563 videos

POLL vs TAKEOUT match_key, all 94 poll videos, WITH the map:
   identical: 94  |  differing: 0     (was 77 / 17)

Eddie Higgins:        30 export videos -> "Eddie Higgins Trio"  | stored 5  | NEW 25
The Red Garland Trio: 16 export videos -> "Red Garland"         | stored 12 | NEW 4
```

**The 25 new Eddie Higgins videos land as `Eddie Higgins Trio`, matching the 5 already
stored. The 4 new Red Garland videos land as `Red Garland`, matching the 12.** The
poll/Takeout disagreement goes from 17 to zero.

**The 40 rows already committed need no correction.** Three were Eddie Higgins tracks
submitted with the channel spelling, and insert-only meant the stored `Eddie Higgins Trio`
row won — so they were already canonical. No row written so far is wrong.

**107 Alfred-side tests**, including: the direction reverses between entries; matching is
case- and whitespace-insensitive but **not fuzzy** (`Eddie Higgins Quartet` passes through
untouched); Miles Davis is asserted absent; every entry must carry a rationale; and **no
alias chains** — a `to` may never be another entry's `from`, since that would make the result
depend on evaluation order, which is the very class of silent input the map exists to remove.

---

## Phase 4 — Surface deployment ⚠️ FULL PHASE, NOT A STEP

- [x] Pin `ytmusicapi==1.12.2` in `workshop/requirements.txt`
- [x] Commit and push — phases 1–3b, 24 files
- [ ] Tap **Refresh Workshop** tile on the Surface
- [ ] Confirm health check passes and `git sha` matches dev
- [ ] Get `browser.json` onto the Surface (fresh capture **or** copy — never commit)
- [ ] **Verify file ownership**: readable by `alexa`, not just `rdpuser`
- [ ] Confirm Surface tool count matches dev
- [ ] Call a DJ tool against Surface; confirm real data
- [ ] Disable the **Workshop (Dev)** connector in Claude settings
- [ ] Re-test with dev disabled; confirm `get_workshop_status` reports `host: surface`

- [ ] 🛑 **PREREQUISITE — authorise the Workshop (Surface) connector.** Flagged during
      phase 1 (2026-08-27), **still uncleared as of 2026-08-28.** Nothing else in phase 4
      can be verified until it is done: every Surface-side check reads through that
      connector. Clear it BEFORE the refresh tile, not after.

**Notes:**
- ⚠️ **BLOCKER, found during phase 1 (2026-08-27), STILL OPEN at 2026-08-28.** The **Workshop (Surface)**
  connector is present but **not authenticated**. Claude cannot call a single tool on it,
  so every phase-4 verification step that reads from the Surface is blocked until it is
  authorised via claude.ai connector settings. Worth doing before RDP day rather than
  discovering it mid-phase. Workshop (Dev) is authenticated and answering normally.
- RDP to the Surface has caused user-account problems before. Budget real time.
- Workshop autostarts under `pythonw.exe` — no console. Failures are silent. Verify
  via `get_workshop_status` and `data/workshop.log`.
- **RDP is the confirmed transfer route for `browser.json`**, so the rdpuser-writes /
  alexa-reads ownership problem is LIVE, not hypothetical. Permissions will be set
  explicitly rather than relying on NTFS inheritance.
- **What does NOT travel by git** (confirmed with `git check-ignore`, not assumed):
  `workshop/.env`, `workshop/data/` (the whole tree, including `data/dj/browser.json` and
  `data/dj/headers.txt`), `workshop/.venv/`, `__pycache__/`, `*.pyc`. Everything else in
  `workshop/` does travel. The credential is therefore the ONLY thing needing manual
  transfer.
- `auth_valid` / `auth_detail` in `get_workshop_status` now answers "did `browser.json`
  land, and can this process read it" in one call — that is the `rdpuser`/`alexa`
  ownership check, without trial-and-error tool invocations.
- The DJ tools degrade cleanly if the pip install has not landed: they return
  `dependency_missing:` rather than taking the server down at import.

---

## Phase 5 — Scheduled daily task

> 🛑 **BLOCKING PRECONDITION — gap logic must NOT treat `oldest_bucket_in_page` as a
> coverage floor until the page-tail behaviour is understood.**
>
> Phase 2b observed that adding one play to `Today` did **not** push one item off the
> oldest end. `Today` 28 → 29, `This week` 105 → 104, `Last week` 64 → 64 — the departing
> item came from the **middle**, not the tail. Deliberately not theorised about.
>
> **If items can leave the page from the middle, the tail is not a floor at all.** Any gap
> calculation resting on "we saw back to X, so everything after X is covered" is unsound,
> and would fail by *silently under-reporting* missing plays — a wrong answer that looks
> right, the same failure class as the stale smoke row.
>
> This is a design constraint, not a footnote. Either understand the behaviour first, or
> build gap detection on `platform_runs.covered_to` alone and treat the page as unordered.

- [ ] ⚠️ **Verify the coarse-bucket rejection LIVE** — `record_dj_plays` refusing
      `This week` / `Last week` is unit-tested (`dj-courier.test.mjs:321`) but the live
      path has never been hit; every test so far filtered at read time. Unit tested is not
      unexercised, and the contract asserts it.
- [ ] 🛑 **Gap detection must RECONCILE the run log against `dj_plays`, not trust it.**
      `platform_runs` asserts coverage and nothing can check that assertion against the
      data — there is no link from a run to the rows it produced. They are reconcilable
      today only because `observed_at` clusters into visible batches, which is a
      coincidence of how the data looks, not a property of the design; two writers a second
      apart would be indistinguishable. **"What is the newest `played_on` I actually hold?"
      is answerable from `dj_plays` and cannot drift. "What does the log say I covered?"
      can. Where they disagree, THE DATA WINS.** (spec §11.4)
- [ ] 🛑 **The scheduled task is NOT the only writer.** Plays have already been written
      manually with no scheduled task in existence. Gap logic must not assume a single
      writer, and a run that writes without stamping leaves coverage the log does not know
      about — the data ahead of the record, with nothing flagging it.
- [ ] 🛑 **Re-verify `by_bucket` against a poll that actually INSERTS.** The 2026-08-29
      check passed against a no-op run: the explicit `Yesterday: 0` was demonstrated, but
      every Today play was already held, so insert attribution was never exercised.
- [ ] 🛑 **THE FEED CANNOT PROVE ABSENCE** (spec §11.3). It confirms a play happened; it
      never confirms one did not. Gap logic must not reason "we saw back to X, therefore
      everything after X is covered" — that fails in the reassuring direction, which is the
      direction nobody investigates. `dj_plays` is the authority.
- [ ] 🛑 **Verify** per-bucket counts land in `platform_runs.details`.
      `record_dj_plays` now RETURNS `by_bucket` with every ingestible bucket including
      `submitted: 0`, so the mechanism is the tool rather than the caller's memory — this
      checklist item is the verification that the run stamp actually carries it.
      The 18:25 run on 2026-08-28 wrote 30 `Today` rows and **zero `Yesterday` rows**; the
      12 Weezer `Yesterday` rows only appeared at 20:19. Either that run never submitted its
      Yesterday bucket, or the plays were not in the feed yet — **and the stored row counts
      cannot distinguish those.** A run that silently skips a bucket looks identical to a
      run where the bucket was empty. Same shape as the lossy-feed finding: the failure is
      invisible after the fact unless the run records what it SUBMITTED, not just what
      landed.
- [ ] 🛑 **THE TASK PROMPT MUST READ `artist_disagreements`** from every
      `record_dj_plays` response and carry it into `platform_runs.details`. Empty is normal;
      any entry means two vocabularies disagree about one act and a new alias-map entry is
      owed (spec §4.1.4). **A signal nobody looks at is the exact shape this project keeps
      finding** — the detector is free, but only if something reads it.
      - [ ] ⚠️ **NEW 2026-08-31 — AN EMPTY LIST IS NOT EVIDENCE THAT NO SPLIT EXISTS, and
            the task prompt must not word it as if it were.** The detector fires only when
            the **same `video_id`** carries a different stored artist. A split spread
            across **different videos** is invisible to it — and that is exactly what Red
            Garland was. *The detector built to catch future splits would not have caught
            the one that prompted it.* The prompt may say "no same-video disagreements";
            it may **not** say "no vocabulary drift".
      - [ ] ⚠️ **NEW — the task must NOT re-implement the comparison.** It compares
            normalised PRIMARY artists, both read from `match_key`. An earlier version
            compared the joined `artist` column and fired on every collaboration
            (spec §11.7). A prompt that eyeballs `artist` strings would reintroduce it.
      - [ ] The real safeguard is the periodic hand-run split scan across the whole artist
            vocabulary — run with the stored alias targets seeded as a **positive
            control**, since both known splits are cross-source and a one-sided scan
            returns 0 whether or not it works. Not automated; decide in Phase 9 whether it
            should be.

- [ ] 🛑 **HOST CHECK, EVERY RUN.** The task prompt begins by calling
      `get_workshop_status` and confirming `host` is `"surface"`, and STOPS if it is not.
      Promoted out of the drafting parenthetical it used to live in, because anything
      inside a drafting note gets dropped the next time the prompt is rewritten — and this
      runs daily, not once. Both hosts expose identically-named tools, so a task silently
      polling a desktop that is sometimes off is a failure that looks like something else
      for a week (spec §7 phase 4 step 8).

- [ ] 🛑 **`poll_date` MUST be the UTC date. ⚠️ THIS REVERSES THE 2026-08-27 DECISION.**
      That decision said `America/Los_Angeles`, **and the reasoning was wrong**: it assumed
      the account timezone governs how YouTube buckets history. It does not — YouTube
      buckets by **UTC day**, confirmed 41/41 against exact Takeout timestamps (spec §4.2).
      **The reversal is recorded with its reason so it is not re-reversed later by someone
      reading the old rationale.**
      More fundamentally, UTC is **forced rather than chosen**: the poll receives only a
      bucket LABEL and never learns time-of-day, so a poll row can never be converted to a
      local date. The information does not exist in the feed.
      - [ ] Runtime guard: if the resolved `poll_date` differs from what the previous
            successful run's `covered_to` would predict, the run SAYS SO rather than
            proceeding quietly.

- [ ] 🛑 **SCHEDULE THE POLL AWAY FROM UTC MIDNIGHT.** If bucket boundaries are UTC, a run
      near 00:00 UTC risks the feed rolling over mid-request — some entries answered under
      one UTC day, some under the next, with no way to tell which afterwards. **The 18:25
      UTC run was safely mid-day.** Recommend a stable slot around **16:00–20:00 UTC**
      (09:00–13:00 Pacific) and record the reason, because a firing time chosen for
      convenience will eventually drift toward the boundary with nobody remembering why it
      mattered.
      ⚠️ **This is a real lever, not the earlier coincidence.** Choosing a time so that the
      LA date and UTC date happen to agree would have been leaning on an accident; choosing
      a time far from the boundary that actually governs bucketing is the mechanism itself.

- [ ] 🛑 **Unfillable gaps: do NOT attempt the backfill.**
      **A gap of exactly ONE day needs no special handling** — that is precisely what the
      `Yesterday` bucket covers, so the normal poll fills it. This is why §6 chose a daily
      cadence: a single missed run is self-healing.
      **A gap of TWO OR MORE days is permanently lost from the live API.** Everything older
      than yesterday is unreachable — coarse buckets are rejected by `record_dj_plays`
      (spec §4.3), so attempting it is guaranteed to fail and is just noise in the log.
      Instead: poll Today and Yesterday normally, stamp `status: "partial"` with the
      unfillable dates in `details`, raise **ONE** inbox item naming the lost range and
      saying **Takeout is the only recovery path**, then set `notified_at` via
      `update_platform_run` so it does not repeat daily.
      **The data is gone. The run's job is to record that accurately, not to pretend
      otherwise.**

- [ ] 🛑 **An EMPTY day is `status: "ok"` with zeros — never `failed`.**
      A quiet day is a normal outcome. Marking it failed would make the staleness signal
      cry wolf, which is how people learn to ignore it. `by_bucket` already distinguishes
      "empty" from "not submitted", which is the distinction that actually matters.

- [ ] **The gap-reconciliation call is `get_dj_plays` `mode: "plays"`, `limit: 1`** — it
      returns newest `played_on` first, answering "what do I actually hold?" directly.
      Named here so it does not get rebuilt. Compare it against `platform_runs.covered_to`;
      where they disagree, the data wins (§11.4).

- [ ] Draft the task prompt (confirm Surface → reconcile → poll Today+Yesterday → write →
      stamp). **Note "backfill" is deliberately NOT a step** — see the unfillable-gap item.
- [ ] ⚠️ **Two different questions, two different filters over `platform_runs`** — see note
- [ ] Record `oldest_bucket_is_partial` and `page_full` in `platform_runs.details`
- [ ] ⚠️ Poll must filter to `Today` / `Yesterday` before calling `record_dj_plays` — the
      handler rejects coarse buckets (spec §4.3), so an unfiltered batch fails the whole call
- [ ] Create the recurring Claude task
- [ ] Seed the `platform_schedules` row **last** — `create_platform_schedule` with
      `app: "dj"`, `job: "daily_history_sync"`, `executor: "claude"`, `cadence: "daily"`.
      **The schedule definition is the final step of standing a job up, not the first**
      (spec §7 phase 5): a cadence recorded before the job actually runs makes the staleness
      check alarm about a job that was never stood up.

- [ ] 🛑 **`credential_readable` is NOT an auth check. The task must not treat it as one.**
      It proves a credential FILE exists and is readable by this process. It does **not**
      prove YouTube still accepts the cookie — an expired credential reports
      `credential_readable: true` and then fails at the first DJ call with `auth_expired:`.
      **Only a real DJ call proves the credential is alive.** This is exactly why the field
      was renamed from `auth_valid`; a task prompt that reads it as an auth gate would
      reintroduce the misreading the rename existed to prevent, and would report a healthy
      run while polling nothing.
- [ ] 🛑 **NEW 2026-08-31 — A FAILED RUN MUST RECORD WHAT THE FAILURE SAID, verbatim.**
      `platform_runs.details` gets the actual error text and, where there is one, the HTTP
      status — never just `status: "failed"`.
      **Learned the expensive way during the Phase 8 import.** The importer's error path
      printed a property that is empty under PowerShell 5.1, so every failure rendered as
      a blank line while the server was returning
      `{"error":"platform_check_call_budget failed: JWT expired"}` every single time. That
      blank cost a bisect of the batch files, a character-encoding investigation, a
      transport measurement and two void experiments — to find an expired token
      (spec §11.10).
      **A daily task is worse**, because nobody is watching it live: a month of
      `status: "failed"` with no message is a month of nothing to act on.
      - [ ] ⚠️ Distinguish **expired credential** from **genuine failure** in the stamp.
            They need different responses — one is "re-auth", the other is "investigate" —
            and a run log that conflates them trains its reader to ignore both.
- [ ] ⚠️ **NEW — beware time-correlated failures presenting as data-specific ones**
      (spec §11.10). In a sequential job, elapsed time correlates with position, so an
      expiring credential looks exactly like "these particular plays are bad". If a run
      starts failing partway through, **re-try something already known to have succeeded**
      before investigating the payload. That control answered the import question in four
      requests after two void runs without it.
- [ ] Observe two consecutive successful days

**Notes:**

**⚠️ Manual runs share the `daily_history_sync` job name, deliberately — and that masks one
signal.**

Manual verification writes are stamped under the same `job` as scheduled runs, because they
produce **real coverage**: 30 plays for 2026-08-28 were permanently written by a manual
invocation, so the day genuinely is covered. Giving them a separate job name would make
tomorrow's scheduled run see `covered_to: 2026-08-27`, report 2026-08-28 as a lost window,
and backfill an already-complete day — a phantom gap reported as real.

It would also force every staleness query to union two job names and keep them in step,
which is **exactly the argument §3 used to refuse splitting `platform_runs` by executor**.
The same reasoning applies to job names.

**But there is a genuine cost, and it is worse than the provenance issue it was raised as:
a manual run keeps coverage current, so it MASKS "the scheduled task never fired."** If the
daily task silently died and manual syncs continued, §6 mitigations 2 and 3 would never
trigger. The automation could be dead for a month with nothing to show it.

**Resolution — two questions, two filters, one table:**

| Question | Query |
|---|---|
| Is the DATA current? (gap detection, backfill) | newest `ok` run for app+job — **include manual** |
| Is the AUTOMATION alive? (§6 mitigations 2 and 3) | newest `ok` run **where `details->>'manual' is distinct from 'true'`** |

`details` is jsonb, so this is queryable — just not indexed and easy to forget, which is why
it is written here rather than left to be rediscovered. **If a real query ever needs it
indexed, that is a migration adding a proper `trigger` column — not a reason to add one
speculatively now.**

Zero-duration rows are expected: a stamp written after the fact omits `started_at`, so
`finished_at` equals it by design (the handler refuses to invent an interval). Phase 9's
duration display must tolerate zero rather than treat it as an error.

---

## Phase 6 — Failure tests

- [ ] Workshop unreachable → inbox item, `status: failed`
- [ ] Credential invalidated → inbox item naming the reauth tile, `status: auth_expired`
- [ ] Skipped day → next run detects gap and backfills
- [ ] Repeated failure → `notified_at` suppresses duplicate inbox items

**Notes:**

---

## Phase 7 — setlist.fm and cram logic

> 🛑 **THE FIRST CRAM ROW EXERCISES TWO DEFERRED RULES.** Both have been verified only
> against unit tests with constructed fixtures, and neither can run on real data until a
> cram row exists — which happens here, and nowhere earlier.
>
> **1. §5 interleaving.** Rendered order is every cram row by position, then every body row
> by position. Every live check so far ran with an EMPTY cram block, where the rule reduces
> to "body order, unchanged" and every wrong implementation gives the identical answer.
> Verify by comparing `rendered_position` from `get_dj_managed_playlists` against YouTube's
> `position` from `get_dj_playlists mode=contents` **with at least two cram rows and two
> body rows present** — fewer cannot distinguish the failure modes.
>
> **2. The known-but-unplayed zero-play case.** `get_dj_plays` mode `familiarity` returns
> `distinct_days: 0` / `days_since_last: null` for a track in `dj_tracks` with no plays.
> No such track has ever existed: every `dj_tracks` row arrives via a play, or via a
> setlist that has been played through. A cram row for a newly-discovered setlist song is
> the first one — and it is the case §5 depends on, since a never-played song is what
> should float to the top of the cram list.
>
> **These are not two footnotes. They are two verifications riding on this phase**, and
> both are currently marked NOT EXERCISED rather than passed.


- [ ] Obtain setlist.fm API key
- [ ] Populate `dj_artists.mbid` for artists with upcoming concerts
- [ ] Setlist fetch + diff against playlist body
- [ ] Cram insertion (both zones for `new_setlist`)
- [ ] Cram ordering by canonical-group play count
- [ ] "Clear the cram list" path
- [ ] Neglected-song proposal with user confirmation
- [ ] **Acceptance test:** Weezer diff surfaces C.E.O., Hoops, We Might as Well Be
      Strangers (or whatever the real Gathering setlists show). If it surfaces
      nothing once the tour is underway, the diff logic is wrong.

**Notes:**
- Tour opens 8 Sep 2026; user's Vegas date is October. Real setlists will exist by then.

---

## Phase 8 — Takeout backfill ✅ COMPLETE

> 🛑 **PRECONDITIONS. All three are decided BEFORE the import, not during it.**
> `dj_tracks` is insert-only, so anything written wrong here can never be corrected —
> `match_key` and `canonical_track_id` are frozen at insert (§4.1.2). At ~18k entries this
> is the largest write the system will ever make, and it is one-way.
>
> **1. 🛑 STRIP `"Watched "` AND DERIVE ARTIST BEFORE THE NORMALISER SEES ANYTHING.**
> **All 15,525** music titles are prefixed `"Watched "` — `"Watched Everything Will Be
> Alright"`. There is no artist field at all; the artist is `subtitles[0].name` minus
> `" - Topic"` (`"The Killers - Topic"`).
> Passed raw, every Takeout track would get `the killers|watched everything will be alright`,
> which **never groups** with the poll's `the killers|everything will be alright`. No error.
> Two familiarity groups per song, permanently, across ~18k rows — §11.2 at scale.
> Partially mitigated by luck: `titleUrl` yields the video_id, `dj_tracks` is keyed on
> `(user_id, video_id)`, and insert-only means an already-known video keeps its correct row.
> **The damage is confined to videos not yet in `dj_tracks` — which is nearly all of them.**
> - [ ] **Verification that CAN FAIL:** pick a track that **already exists in `dj_tracks`
>       from polling**, import its Takeout counterpart, and confirm the two produce the
>       **same `match_key`**. Do not assume — a check run against a track absent from
>       `dj_tracks` would pass whether or not the stripping works (§11.1).
>
> **2. 🛑 THE 19 ENTRIES WITH NO `subtitles` HAVE NO DERIVABLE ARTIST — SKIP AND REPORT.**
> Decided, not deferred. `buildMatchKey` with no artist yields `|title`, so **every
> artist-less track sharing a title groups together** — and "Happy Together" alone has six
> distinct recordings. A null artist does not group with nothing; it is a collision engine.
> 19 of 15,525 is 0.12%. Skip them, report the count and the titles, write nothing.
>
> **3. ⚠️ THE 321 MUSIC ENTRIES ON NON-`Topic` CHANNELS — SAMPLED, AND THEY SPLIT THREE WAYS.**
> This is the filter disagreement in concrete form (15,525 by `header` vs 15,185 `- Topic`).
> Sampled 2026-08-29:
> - **Ambient / sleep / background** — Yellow Brick Cinema (34), relaxdaily (9), Soothing
>   Relaxation (8), Liquid Mind, SleepTube, Nu Meditation Music, BuddhaTribe. Plausibly not
>   taste-model material at all.
> - **Official artist / VEVO channels** — BrandonFlowersVEVO, TheKillersMusic, BLACKPINK,
>   ROSÉ, DisneyMusicVEVO. Genuine music, just not auto-generated `- Topic` uploads.
> - **Non-song video** — "DANCE PERFORMANCE", "JACKET MAKING", official video uploads.
>   Watched, but not listened to.
>
> ⚠️ **And for these, THE CHANNEL IS NOT THE ARTIST.** "Vance Joy – Riptide" sits on
> channel **"Mushroom"** (a record label); "Brandon Flowers – Miss America" on **"Abby
> Noroozi"** (a fan upload). The `- Topic` artist-derivation rule silently produces a label
> or a stranger's name as the artist. **So the 321 cannot be imported by the same rule**,
> and importing them wrong is worse than not importing them.
> - [ ] Recommended default: **import `- Topic` only (15,185)**, and treat the 321 as a
>       reviewed exception list — most probably skipped.


- [x] Takeout export downloaded 2026-08-29 — **18,188 entries, 2024-09-19 → 2026-08-29,
      ~23.3 months unbroken.** Measured only; nothing parsed. See the arrival note above.
- [x] Parser for `watch-history.json` -> `precision: 'exact'` - `dj_takeout_prepare.py`
- [x] Music filter (`- Topic` channels), classification reviewed before committing.
      **`header` is NOT part of it** - it records which client played the audio, and
      gating on it silently dropped 1,581 plays (see 2026-08-31 above).
- [x] **Takeout has NO album field.** Confirmed: the complete key set across all 18,188
      entries is `activityControls, header, products, subtitles, time, title, titleUrl`.
      Phase 8 rows get `album = null` **by necessity, not policy** - the album question
      only ever applied to poll-sourced rows and is already handled (Block F).
- [x] **IMPORT COMPLETE, 2026-08-31.** `dj_plays` holds **16,766** rows with
      `source = 'takeout'`, **exactly** the number of music entries in the export.
      Nothing lost, nothing duplicated.
- [x] **How far back history actually reaches: 2024-09-19 to 2026-08-29** - 673 distinct
      days across 23.3 months, 4,732 distinct tracks.
- [x] **Canonical grouping verified across the enlarged track set, 2026-08-31.**
      `scripts/dj-grouping-check.js`. All four failure lists empty:
      `UNDER_FIRED`, `CROSS_KEY`, `CHAINED`, `DANGLING`.

      | | actual | predicted offline |
      |---|---|---|
      | `match_keys` with >1 track | **256** | 255 |
      | tracks inside those groups | **558** | 556 |
      | canonical links | **302** | 301 |

      One pair over, in the predicted direction: poll-only tracks absent from the export.
      2 null `match_key` rows, the two symbol-only titles.

      **The clean result is informative, not vacuous** - had grouping never run, all 256
      multi-track keys would have appeared under `UNDER_FIRED`. The counts alone could
      not have failed, so the invariant was checked per group and the links counted
      separately.

      Over-firing reviewed by eye on the 15 largest groups and accepted: live, acoustic
      and remaster variants folding into one group is the intended behaviour, and the
      feat.-stripping cases (Charli XCX *Girl, so confusing* with the Lorde feature; Dua
      Lipa *Levitating* with the DaBaby feature) are different recordings correctly
      folded for familiarity purposes. No group is large enough to hide a runaway merge -
      219 pairs, 29 triples, 5 quads, one 5, one 6.

      ⚠️ **The canonical MEMBER is arbitrary and this is now concrete, not theoretical.**
      Import order picked every leader and the export landed newest-first, so the crown
      went to whichever variant was heard most recently: Wes Montgomery leads with *West
      Coast Blues (Live)*, Lady Gaga with *Die With A Smile (Live in Las Vegas)*, Coldplay
      with *Jupiter (Single Version)*. `get_dj_plays` `familiarity` returns
      `canonical_title` / `canonical_artist` / `canonical_video_id` **and sorts by
      `canonical_title`**, so a cram list will carry those labels.
      **Decision: leave it.** `canonical_track_id` is insert-only, so changing the rule is
      a backfill migration; and a "best member" rule is a judgment call worth making on
      evidence. Revisit after seeing a real Phase 5/7 cram list. If it reads badly the fix
      is a **display-time** rule - e.g. shortest title in the group - which touches no
      insert-only column and is reversible.

### 2026-08-31 - `header` was never a music test. 1,581 plays were being dropped.

`dj_takeout_prepare.py` gated on `header == "YouTube Music"`. That excluded **1,581
entries on `- Topic` channels** - Bill Evans, Thelonious Monk, the Dave Brubeck
Quartet, The Red Garland Trio - whose only disqualification was carrying header
`"YouTube"`, i.e. having been played from the YouTube client rather than the
YouTube Music one. **1,277 of them fell in 2025.** Importable rows: 15,185 ->
**16,766**; batches 31 -> **34**.

`header` records WHICH CLIENT played the audio. It says nothing about whether the
audio is music. Precondition 3 already answers that and answers it better: a
`- Topic` channel is an auto-generated per-artist channel, so it is music by
construction. The header test added no information and cost rows.

**The asymmetry is what settles it, and it generalises.** A wrongly-INCLUDED play is
one deletable row. A wrongly-EXCLUDED play is not recoverable by re-running the
import - `dj_plays` is insert-only, so restoring it is a backfill migration. When
the two error directions cost that differently, a filter belongs on the
over-including side. **Any filter feeding an insert-only table should be read this
way.**

### 2026-08-31 - CORRECTION: I claimed Takeout collapses repeat plays. It does not.

**What I did.** I measured 9 rows with `occurrence > 1` across the export, compared
that against the poll's known inability to see repeats, and concluded Takeout
collapses repeats the same way - proposing to record that true play counts are
unrecoverable from the export.

**Why it was wrong.** I had *myself* measured **342 same-day repeat pairs under
Pacific dates**, and had *myself* explained the drop to 9: UTC midnight is 17:00
Pacific, so 333 pairs straddle the boundary and land on two different UTC days. I
then argued from the 9 as though the 342 did not exist. Had Takeout collapsed
repeats, the Pacific figure would also have been ~9.

`occurrence > 1` measures **how often two plays share a UTC day** - a property of
where the day boundary sits, not of what the source records.

**The refutation is a count, not an argument** (Alex's instruction: *"Check that
before recording anything"*):

| | |
|---|---|
| Music entries in the export | **16,766** |
| Distinct `(video_id, timestamp)` pairs | **16,766** |
| Duplicate rows | **0** |

Every play has its own row. **Nothing is collapsed.**

**Sec 11.5 SHAPE - why this one was dangerous.** "Takeout can't restore play counts"
is a claim about what data MEANS. It is unfalsifiable everywhere the alternatives
agree, and under UTC bucketing the alternatives agree almost everywhere - 9 vs. 342
is the only place they diverge. It would have become documented truth, cited later
as settled, with the measurement that refutes it sitting unread in the same file.
**A claim about meaning must be stated as a count that could have come out
differently.**

### 2026-08-31 - CAPABILITY GAINED: true play counts are recoverable.

Not a caveat - a capability, and it should be recorded as available rather than lost.

| | |
|---|---|
| Distinct tracks | 4,732 |
| **Tracks played more than once** | **1,644** |
| Mean rows per track | **3.54** |
| Max rows for one track | **85** (*Weightless Part 1*) |

Next four: *Bali Rain* 73, *Adventure of a Lifetime* 72, *Paradise* 71, *The
Scientist* 68.

This is the replay behaviour Sec 5 assumed was unmeasurable. **It does not change
distinct-days as the cram proxy** - the POLL still cannot see counts, so a proxy
that depends on counts would work on history and fail on everything arriving after
the import. Sec 5 stands as written.

What changes is that the STORED record can now answer **"what do I actually play
over and over"**, by counting `dj_plays` rows for `source = 'takeout'`. That is a
real input for discovery and for the Friday review. WARNING: any such query MUST
filter to `source = 'takeout'`: mixing poll rows in produces a count that is part
true frequency and part polling artefact, which is worse than either alone.

### 2026-08-31 - the 167 UTC-day collisions are real second sessions, not double logging

Including the 1,581 took `occurrence > 1` from 9 pairs to **167**, and 158 of those
are cross-header. I suspected one session logged twice under both clients, because
offsets cluster tightly within a day (2025-01-11: sixteen collisions all ~68,960s).

**Wrong, and the offsets say so.** A constant offset across many tracks is what
REPLAYING AN ALBUM IN THE SAME ORDER looks like - track *n* of the second listen
sits a fixed distance from track *n* of the first. A 19-hour constant offset is not
a logging delay. Reading 2025-01-11 track by track confirms it: a YouTube Music
session 00:28-04:32, then a separate YouTube-client session from 19:37 replaying
some of the same tracks.

Only **4 adjacent pairs sit under 300s** (min 23s), the range where "one play logged
twice" is even plausible - and those are equally consistent with a restart. Out of
16,766 rows, not a reason to exclude anything.

### 2026-08-31 - PHASE 8 IMPORT COMPLETE. 16,766 rows.

Batches 30 and 32 went in on a fresh token, first attempt, no errors: 500 + 500 rows,
302 tracks created, 34 canonical links made. Nothing about them was ever wrong.

**VERIFIED, not assumed:**

| | |
|---|---|
| `dj_plays` where `source = 'takeout'` | **16,766** |
| Music entries in the export | **16,766** |
| Difference | **0** |

Batch 30's exclusive date range (2024-11-17 .. 2024-12-11), which held **0** rows while
it was failing, now holds **475**.

Coverage: **2024-09-19 to 2026-08-29**, 673 distinct days, 4,732 distinct tracks.

`artist_disagreements` was **empty on every batch** - no third vocabulary split surfaced
across the whole import.

**Still open (deliberately, not forgotten):** re-run canonical grouping across the
enlarged track set. 4,732 tracks now exist where the grouping rules were last exercised
over a few hundred, and 11.6 applies - import order is a silent input to identity in an
insert-only table.

### 2026-08-31 - RESOLVED: the batch 30/32 500 was AN EXPIRED TOKEN.

```
{"mode":"dry_run","error":"platform_check_call_budget failed: JWT expired"}
```

All four probe files returned it - batch 30, batch 31 (**known good**), and 10-row
slices of each. Not size, not content, not batch 30. **A Supabase access token lasts
about an hour and a 34-batch import runs longer than that.**

**⚠️ THE MESSAGE WAS IN EVERY FAILED RESPONSE FROM THE FIRST 500. THE IMPORT SCRIPT
THREW IT AWAY.** Its catch block printed `$_.ErrorDetails.Message`, which is EMPTY for
these responses under PowerShell 5.1, so every failure rendered as a blank line. The
server had been saying exactly what was wrong, every time.

Everything that followed was caused by that: a bisect of batch 30, a hunt through
character encodings, a transport measurement with a local HttpListener, two probe runs
whose results were void, and a spec principle written about a mistake
(11.9) that would never have been made had the error been visible.

**⚠️ WHY IT LOOKED DATA-SPECIFIC, AND THIS IS THE PART TO REMEMBER.** In a long
sequential job, **elapsed time correlates with position**, so any time-based failure
impersonates a position-based one. Batches 1-29 passed and 30 failed because batch 30 is
where the hour ran out. 31 then passed on a fresh token; 32 failed on the next stale one;
32 "recovered" later on another fresh one. Every one of those reads as "specific rows are
bad" and none of it was about rows. Recorded as spec 11.10.

**Fixed in `dj-import-takeout.ps1`:**

1. **The response body is now read properly** - falling back to the response stream when
   `ErrorDetails` is empty - and the HTTP status is printed with it. An expiry is called
   out by name: *"THE TOKEN HAS EXPIRED. Nothing is wrong with this batch."*
2. **The token's own `exp` claim is decoded before anything is sent.** Already expired ->
   refuse to start. Under 10 minutes left -> warn that it may not cover the run.
3. **Expiry is re-checked before every batch**, so a long import stops cleanly with
   `re-run with -From N` instead of emitting a wall of identical 500s.

Verified against synthetic tokens at -60s, +5min and +50min.

**NOT a data problem, and nothing about batches 30 and 32 needs investigating.** They are
still unimported; they simply need running with a valid token.

### 2026-08-31 - what the false trail did produce

Two things worth keeping, both unrelated to the actual fault:

- **The string-body corruption is real** and is fixed (`ReadAllBytes`). It never affected
  the import, because the batch files are pure ASCII, and the `dj_tracks` audit returned
  zero corrupted rows. Fixed because depending on "the payload happens to be ASCII" is a
  silent dependency on a serialiser default feeding an insert-only `match_key`.
- **Spec 11.9** (a control must be a copy, not a reconstruction) stands on its own.

Both were found while chasing the wrong thing. Neither justifies the chase: the cost was
several hours and two void experiments, and the whole of it was avoidable by printing the
response body.

### 2026-08-31 - THE FIRST BISECT RUN WAS VOID. The splitter re-encoded the files.

**Every result from that probe run has been discarded.** It appeared to show that
batch 30's second half was content-specific and that batch 32 had recovered. It showed
neither.

`dj_split_batch.py` rebuilt its files with `json.dumps(..., ensure_ascii=False)`.
`dj_takeout_prepare.py` uses the DEFAULT `ensure_ascii=True`. So:

| file | bytes > 127 |
|---|---|
| `batch_030.json` (real) | **0** - pure ASCII, non-ASCII escaped as backslash-uXXXX |
| `batch_001.json` (the "unchanged control") | **74** - raw UTF-8 |

Same decoded data, different bytes. And that difference is load-bearing, because
**PowerShell 5.1's `Invoke-RestMethod` corrupts non-ASCII in a STRING body** - measured
with a local HttpListener: U+221E becomes `?`, U+00E9 becomes a lone `0xE9` which is
invalid UTF-8, and `charset=utf-8` in the Content-Type does not prevent it. The probe
files were therefore corrupted in transit; the real batch files, containing no byte over
127, never could be.

That also explains the one piece of evidence that looked like corruption reaching
Supabase - a dry run reporting `submitted=Michael Bubl<U+FFFD>`. Real, and caused
entirely by the probe file.

**⚠️ THE CONTROL WAS THE PART THAT FAILED.** It was added specifically so the run could
not be misread - "both halves passed" is also what a transient fault looks like once it
has stopped. But it was REBUILT rather than COPIED, so it was not the file that failed.
It tested the splitter.

**A control must be a byte-for-byte copy, not a semantically equal reconstruction.**
Reconstructing re-runs the serialiser, and the serialiser is part of what is under test.
Recorded as spec 11.9.

Fixed: the control is now `shutil.copyfile`, slices use the identical serialisation to
`dj_takeout_prepare.py` (`indent=1`, default `ensure_ascii`), and the script **aborts**
if any emitted file contains a byte over 127. Verified: the control is now byte-identical
to `batch_030.json`, and all three probe files are pure ASCII.

**STILL UNEXPLAINED: why batch 30 and batch 32 returned a 500.** The bisect has to be
re-run on files that are actually the batch.

### 2026-08-31 - transport hardened: byte[] body, not a string

`dj-import-takeout.ps1` now sends `[System.IO.File]::ReadAllBytes($file)`. Re-measured:
byte-identical for every file, string or bytes.

**This corrupted nothing that was imported** - the audit over `dj_tracks` returned zero
corrupted rows (48 matches, every one a legitimate question mark in a title: "What's
Up?", "Where Is My Mind?", "Do I Wanna Know?"), and the batch files are pure ASCII so the
defect could never fire on them.

It is fixed anyway, because "the payload happens to contain no non-ASCII byte" is a
**silent dependency on a serialiser default**. Change `ensure_ascii`, or hand-edit a
batch file, and an insert-only `match_key` is written wrong with no error. The fix
removes the dependency rather than documenting it.

### 2026-08-31 - batches 30 and 32 fail with a 500. CAUSE NOT YET KNOWN.

Batches 30 and 32 return a 500 on the **dry run**, reproducibly. 31, 33 and 34 pass.
Batches 1-29, 31, 33, 34 are written; **30 and 32 are outstanding.**

**THE FAILURE IS ATOMIC. THERE IS NO PARTIAL STATE.** This is the property that makes
the situation recoverable rather than a mess, so it was verified three independent
ways rather than inferred once:

1. Batch 30's **exclusive** date range (2024-11-17 .. 2024-12-11) holds **0 rows**. The
   65 rows in the overlapping window are batch 31's, on the shared 2024-11-16 boundary.
2. **25 videos exclusive to batch 30, spread across insert positions 13-311**, all come
   back `known_track: false`. No tracks were created either.
3. Replaying batches 1-29 through the real `record_dj_plays` into the test harness's
   fake DB lands on **exactly 14,500 plays**, matching the live count.

**Re-running batch 30 or 32 is therefore safe** once the cause is known - nothing to
clean up, nothing to reconcile.

⚠️ **THE 40-ROW "PARTIAL COMMIT" WAS AN ARITHMETIC SLIP, NOT A PARTIAL WRITE.** 14,500
looked like 40 rows too many because the count of batches 1-29 omitted the **40 tranche
rows that existed before batch 1**: 40 + 460 + (28 x 500) = 14,500 exactly. A suspicious
round number invited a story about chunked writes; it was a missing term.

⚠️ **AND THE FIRST PROBE OF IT PROVED NOTHING.** It sampled the *alphabetically* first 20
exclusive videos, which says nothing about **insert order** - the order that decides what
a partial write would have committed. It was re-run positionally before being believed.
A sample has to be drawn on the axis the hypothesis is about (spec 11.1).

**ELIMINATED** - none of these distinguishes 30 and 32 from 31:

| Hypothesis | Result |
|---|---|
| Malformed rows | Identical key sets, no duplicate dedupe keys, no empty/null fields, no control characters, comparable payload sizes |
| Normaliser/`prepareRows` throws | The **real** function run over all 34 batches: 0 throw |
| Null `match_key` (the `inf` and heart titles) | Present in 30 **and** 31 - 12 vs 15 |
| DB state left by the failed confirm | Nothing was written, so nothing changed |
| Shares videos with a failed batch | 31 shares 71 with batch 30 and passes; 32 shares 83 and fails |
| Known-track count, query count, `.in()` URL size | 30: 174 known, 31: 139, 32: 108 - not monotonic |
| Tool logic end to end | Replayed 1-29 then dry-ran 30-34 against the fake DB: **all five pass** |

⚠️ **THE LOCAL REPLAY IS NOT EVIDENCE ABOUT 30 AND 32.** It passes batch 32, which really
fails. A harness that cannot fail on a known failure says nothing about the unknown ones,
and it was explicitly NOT used to claim 33 and 34 were safe (spec 11.1).

**A CORRELATION WAS PROPOSED AND IS DEAD.** New-tracks-created ordered the known results
(31: 117 passes, 30: 139 fails, 32: 180 fails) and predicted a threshold near 130. Alex
tested it: **batch 33 has 145 new tracks and passes**, 34 has 80 and passes. Not
monotonic, no threshold. Recorded because it was stated as a falsifiable prediction and
was killed by one measurement - which is the point of stating it that way. It was never
recorded as a cause, and no fix was built on it.

**NEXT: does the failure track SIZE or CONTENT.** `dj_split_batch.py` emits each failing
batch as halves **plus the unchanged 500-row original as a control**. The control matters:
"both halves passed" is also what a transient fault looks like once it has stopped, so
without the original still failing in the same session the split is a check that cannot
fail. Both halves pass -> size or time limit. One half fails -> bisect it.

**⚠️ DO NOT change the import path to make this go away before the cause is known.** A
workaround that removes the symptom without an explanation is how a silent failure gets
built into an insert-only table.

### 2026-08-31 - verification done before regenerating

- **Transport is faithful.** Every `(video_id, artist, title)` in the batch files is
  byte-identical to the export: 4,563 distinct, **0 drift in either direction**.
  Checked because `match_key` is insert-only, so drift here is permanent.
- **No encoding damage.** 85 non-ASCII strings, **0** carrying U+FFFD or a
  latin-1-as-UTF-8 signature. (An earlier apparent mojibake in an artist name was
  the Windows console, not the data. The first mojibake test was itself invalid -
  its comparison string passed through the same console; it was rebuilt from
  codepoints.)
- **No third artist split.** Candidate splits across all 1,241 export artists plus
  the stored alias targets: **exactly the two known ones**, no others. 35 artists
  arrive only with the new rows (Yuja Wang, Alice Coltrane, Ryo Fukui, Sonny
  Clark...), 1-2 rows each, none a variant of a stored name.
  - WARNING: **the within-export scan alone could not have failed.** Both known
    splits are CROSS-source - the export holds one side, `dj_tracks` the other - so
    a scan of export artists returns 0 whether or not it works. It was re-run with
    the two stored names seeded as a positive control and fired on both before the
    0 was believed.
  - WARNING, **still unclosed:** `artist_disagreements` only fires when the SAME
    `video_id` carries a different stored artist. A split across DIFFERENT videos
    (which is what Red Garland was) is invisible to it. Closing that needs the full
    stored artist vocabulary compared against the export - not done here.
- **Batch 1 prediction: 40 already held / 460 new** - unchanged by the regeneration.
  All 40 stored takeout keys still fall inside the new batch 1; range still
  2026-08-29 .. 2026-08-11; 0 rows with `occurrence > 1`.

**Notes:**
- Verify the export was **Export once**, not recurring — a two-day delay suggested it
  may have been scheduled as repeating.

---

## Phase 9 — Alfred surfaces

- [ ] Staleness query (newest `ok` run per app vs. `platform_schedules` cadence)
- [ ] Home-view banner when stale
- [ ] Sync history page
- [ ] ⚠️ Check `viewPaths.test.js` state first — a new route breaks its hard-coded
      counts unless the derive-from-route-table rewrite has landed

**Notes:**
