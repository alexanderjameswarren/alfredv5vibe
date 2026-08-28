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
- [ ] Draft the task prompt (confirm Surface → check gap → backfill → poll → write → stamp)
- [ ] ⚠️ **Two different questions, two different filters over `platform_runs`** — see note
- [ ] Record `oldest_bucket_is_partial` and `page_full` in `platform_runs.details`
- [ ] ⚠️ Poll must filter to `Today` / `Yesterday` before calling `record_dj_plays` — the
      handler rejects coarse buckets (spec §4.3), so an unfiltered batch fails the whole call
- [ ] Create the recurring Claude task
- [ ] Seed the `platform_schedules` row **last**
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

## Phase 8 — Takeout backfill

- [ ] Takeout export downloaded (requested 2026-08-27, scheduled start 2026-08-29)
- [ ] Parser for `watch-history.json` → `precision: 'exact'`
- [ ] Music filter (`- Topic` channels); **review classification before committing**
- [ ] Import; record how far back history actually reaches
- [ ] Re-run canonical grouping across the enlarged track set

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
