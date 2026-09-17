# Progress: SAM Practice Plans

Spec: `docs/technical-spec-sam-practice-plans.md`

## Status: Milestone 4 in progress (Milestone 3 verified)

Work is committed directly to main. No branches.

---

### Milestone 1 — Database (SQL, run by hand in Supabase)
- [x] Tables: sam_practice_plans, sam_practice_plan_songs, sam_practice_plan_items, sam_goals (spec §5.1–5.4)
- [x] Unique (id, song_id) on sam_snippets
- [x] plan_id and plan_item_id on sam_passes and sam_sessions (§5.5)
- [x] sam_songs.goal_set_at with triggers and backfill (§5.6)
- [x] Immutability triggers on plans, plan songs, plan items
- [x] Functions: sam_plan_item_progress, sam_plan_unplanned_practice, sam_create_practice_plan (§5.7)
- [x] register_table for every new table
- [x] check_platform_conformance returns CONFORMANT

SQL docs/migrations/2026-09-16-sam-practice-plans.sql applied 2026-09-16; CONFORMANT (42 tables); goal_set_at backfilled for 12 songs.

### Milestone 2 — Data cleanup (Claude Code)
- [x] On-screen Hits excludes partial chords (§7.1)
- [x] Session accuracy shows "—" and stores null when nothing was measured
- [x] Tests pass; manual checks verified — tests pass (49 suites, 1038 tests); desktop checks verified by Alex 2026-09-16: newest session stores null accuracy, null best, notesPlayed 0

### Milestone 3 — Claude tools (Claude Code)
- [x] get_sam_practice_plan, get_sam_practice_plans, get_sam_plan_progress, get_sam_goals (§6.1)
- [x] plan_id / plan_item_id filters and columns on get_sam_passes and get_sam_sessions
- [x] create_sam_practice_plan, update_sam_plan_review_note, update_sam_song_goal, create_sam_goal, update_sam_goal (§6.2)
- [x] goal_set_at on get_sam_songs and the get_sam_song_measures song block; get_sam_snippets already returned created_at
- [x] Deployed; verified from a fresh thread — Alex, 2026-09-16: all nine new tools, both validation rejections, progress counting, the review-note guard, the goal tool, and a tier-3 regression check on create_sam_song. Test data deleted.

### Milestone 4 — Links and checklist strip (Claude Code)
- [ ] recordPass and session creation write plan_id and plan_item_id (§7.2)
- [ ] Checklist strip on the SAM home page (§7.3)
- [ ] Tapping an item opens the song and snippet at target tempo
- [ ] Verified against a test plan

### Milestone 5 — Player display (Claude Code)
- [ ] Plan line with Set tempo button (§7.4)
- [ ] Song note line
- [ ] Compact plan count while playing
- [ ] Snippet row tag
- [ ] Goal label by the tempo box
- [ ] Verified at the piano

### Milestone 6 — Practice skill (chat)
- [ ] sam-practice skill drafted and uploaded (§8)
- [ ] Unconfirmed goal tempos reviewed for songs in the first plan
- [ ] First real plan created

### Milestone 7 — Daily review job (chat)
- [ ] sam-plan-review skill drafted and uploaded (§9)
- [ ] Schedule created and logged in platform_schedules
- [ ] First run verified; test plan with a met review instruction produces one Alfred note

---

### Notes

#### Milestone 1

- The migration file `docs/migrations/2026-09-16-sam-practice-plans.sql` named
  in the note above is not in the repository as of Milestone 2. It may still be
  on another machine; commit it there.

#### Milestone 2 — data cleanup (2026-09-16)

**Code**
- New `src/sam/lib/practiceScoring.js` holds the rules:
  - `accuracyOf`;
  - `bestAccuracy`;
  - `formatAccuracy` (returns "—" for null);
  - `onScreenTally`, which decides whether a chord result adds to on-screen
    Hits, Misses or neither.
- `SamPlayer.jsx` `handleChord`: a partial chord still colours its beat amber
  and is still recorded as a partial, but no longer adds to on-screen Hits.
  Misses are unchanged.
- `usePracticeSession.js` uses the shared rule everywhere accuracy is
  computed: live session accuracy, the live playthrough readout, each
  `summary.playthroughs[]` entry, `summary.accuracyPercent` and
  `summary.bestPlaythroughAccuracyPercent`. Best-of ignores nulls and is null
  when nothing is measured.
- `StatsBar.jsx` and `FocusedPlaybackBar.jsx` show "—" for null Session
  Accuracy and Playthrough Accuracy.

**Decisions**
- **Accuracy is null when nothing was measured.** That means no MIDI note
  arrived, or no beat was scored (hits + misses = 0). This is the same rule as
  `sam_passes.accuracy_percent`. A measured 0 still shows as 0%.
- **Rounding matches Postgres.** The value is computed as
  `round(hits * 100 / total)`. The old `(hits / total) * 100` could round
  differently: 23 of 40 gave 57, while the database gives 58.
- **Two new fields in the session summary.** It now stores `notesPlayed`, both
  session-wide and on each playthrough entry. Without it, a stored null
  accuracy could not be explained from the summary alone. The session
  counters gained a `notesPlayed` tally for this. Partials are counted and
  stored exactly as before. Historic rows are not rewritten; they keep 0.
- **Before anything is played, Session Accuracy now shows "—".** The initial
  live stats start at null, where they used to show 0%.
- **The playthrough fraction is hidden when accuracy is unmeasured.** The
  "(hits/scored)" fraction next to Playthrough Accuracy no longer appears in
  that case, so an idle pass no longer reads "(0/9)".
- **On-screen Hits uses the same counting rule as `sam_passes.hits`, but it is
  not the same number.** The on-screen counter runs from Play, Resume or song
  load, and spans loops. `sam_passes.hits` is per pass. This was left as it is:
  the task was the counting rule, not the counter's scope.

**Readers of accuracyPercent, bestPlaythroughAccuracyPercent and accuracyOf**

The search covered `src`, `supabase/functions`, `supabase/migrations`,
`tools/sam-tools`, `scripts` and `docs/sql`. Only the files below compute or
display these values.

| Reader | Handling of null |
|---|---|
| `usePracticeSession.js`: `accuracyOf` (now imported), live `stats.accuracyPercent`, `playthroughAccuracyPercent`, `summary.accuracyPercent`, `summary.playthroughs[].accuracyPercent` | Produces null by the shared rule |
| `usePracticeSession.js`: `bestPlaythroughAccuracyPercent` | `bestAccuracy`: ignores nulls; null when none is measured (was `Math.max`, which counts null as 0) |
| `StatsBar.jsx`: Session Accuracy, Playthrough Accuracy | `formatAccuracy` shows "—"; the fraction is hidden when null; the green 100% colour cannot match null |
| `FocusedPlaybackBar.jsx`: Session Accuracy, Playthrough badge | `formatAccuracy` shows "—" |
| `SamPlayer.jsx`: passes both values to FocusedPlaybackBar | Pass-through only |
| `get_sam_sessions` (`tool-handlers.ts` `getSamSessions`) | Returns `summary` jsonb untouched, so a null arrives as JSON null. No arithmetic. Not changed (MCP out of scope). |
| `supabase/migrations/001_sam_tables.sql` | A comment listing the summary keys; not code |
| `docs/migrations/2026-09-16-sam-passes-accuracy.sql` and `2026-09-16b` | Column comments that mention `accuracyOf`; not code |

Nothing else reads these values: no SQL function or view reads
`summary->'accuracyPercent'`, and no stats page, script or sam-tools file uses
them. `sam_passes.accuracy_percent` was already null-safe and is untouched.

**Tests** (`npm test`: 49 suites, 1038 tests pass)
- `practiceScoring.test.js`:
  - `accuracyOf` is null with zero notes;
  - null when hits + misses is 0;
  - a real value otherwise, including a measured 0;
  - partials sit outside the ratio;
  - rounding matches Postgres (23/40 → 58);
  - `bestAccuracy` ignores nulls;
  - `formatAccuracy` shows "—" for null, undefined and NaN;
  - `onScreenTally`: a partial counts as neither a hit nor a miss.
- `usePracticeSession.test.js` drives the hook and checks the stored summary:
  - zero notes: null live and stored;
  - partials only: null, with partials still stored;
  - a real value: 75 with a partial present;
  - best-of over [50, null, 0] is 50;
  - all passes unmeasured: best-of is null;
  - the live readout goes null for an idle pass.
- `SamPlayer.hits.test.jsx` runs the real `handleChord`, with mocked MIDI,
  ScrollEngine and matcher:
  - a partial leaves on-screen Hits and Misses unchanged;
  - Session Accuracy shows "—" until a beat is scored.
  - Temporarily making partials count as hits again fails this test.
- `accuracyDisplay.test.jsx`: StatsBar and FocusedPlaybackBar show "—" when
  unmeasured, with no "0%", "NaN" or "null%", and show percentages when
  measured.

#### Milestone 3 — Claude tools (2026-09-16)

**Tools**

| Tool | Tier | Status |
|---|---|---|
| get_sam_practice_plan | 1 | new |
| get_sam_practice_plans | 1 | new |
| get_sam_plan_progress | 1 | new |
| get_sam_goals | 1 | new |
| create_sam_practice_plan | 3 | new |
| update_sam_plan_review_note | 2 | new |
| update_sam_song_goal | 3 | new |
| create_sam_goal | 1 | new |
| update_sam_goal | 2 | new |
| get_sam_passes | 1 | changed: plan_id and plan_item_id as filters and columns |
| get_sam_sessions | 1 | changed: plan_id and plan_item_id as filters and columns |
| get_sam_songs | 1 | changed: returns goal_set_at |
| get_sam_song_measures | 1 | changed: song block returns goal_set_at |
| get_sam_snippets | 1 | unchanged; it already returned created_at |

The registered tool count goes from 57 to 66. The index test still expected
55: `get_sam_passes` and `get_sam_song_scores` had landed without updating
it. The count is now corrected, and the test comment names all eleven.

**Code**
- New `supabase/functions/_shared/tools/sam-plans.ts` holds all nine tools.
  Database access is only through `ctx.db`.
- `_shared/alfred-tools/tool-handlers.ts` carries the pass, session, song and
  measures changes; `mcp/index.ts` has the registrations and descriptions.
- Every new or changed description ends with the same `SAM_DATA_RULES` text:
  - compare heard tempos only, never `goal_bpm` or `default_bpm`;
  - passes with `notes_played` 0 are test data;
  - measure numbers are played numbers;
  - a goal with null `goal_set_at` is a placeholder;
  - days are Pacific dates.
- The `get_sam_songs` description used to call `goal_bpm` "the deliberately
  set goal tempo", which contradicts §4. It now says `goal_bpm` is the goal in
  tempo-box units, and points to `goal_effective_bpm` and `goal_set_at`.

**Platform change: an optional `propose` in `defineTool`** (`_shared/platform.ts`)
- **Why it was needed.** `create_sam_song`'s tier-3 flow comes from
  `defineTool`'s built-in gate, which answers an unconfirmed call before the
  handler runs, with no database access. So it can only echo the args. The
  required proposals need song and snippet titles, measure ranges, heard
  tempos and the plan being superseded.
- **What changed.** `DefineToolOptions` gained an optional
  `propose(args, ctx)`.
  - The gate still intercepts every unconfirmed tier-3 call and returns the
    same envelope.
  - When `propose` is given, its read-only result is added as `proposal`.
  - If `propose` throws, the error surfaces like a handler error. A request
    that cannot succeed is therefore refused before anyone is asked to
    approve it.
- **Existing tools are unaffected.** A tier-3 tool without `propose` returns
  exactly the old shape, and a test pins this.

**Decisions**
- **Proposals are validated in full.**
  - `create_sam_practice_plan` checks the §6.2 rules while building its
    proposal: songs and snippets exist and aren't archived, each snippet
    belongs to its song, tempo and accuracy rules, the §4 audio rule, and at
    most 20 items. Every problem is listed in one error. The database checks
    again on confirm and remains the authority.
  - `update_sam_song_goal` runs the same validation in its proposal and its
    handler, through the shared `planSongGoal`, so the two cannot disagree.
- **Database refusals** (SQLSTATE P0001, and classes 22 and 23) surface as
  `<tool>: validation error: <database message, unchanged>`. Other database
  errors are reported as operational, with no do-not-retry wording.
- **`p_plan` is exactly the §6.2 input shape.**
  - Omitted optional values are sent as null or left out.
  - An item's `target_bpm`, `target_playback_speed` and `accuracy_target` are
    left out when not given. That lets the function apply the free-play
    default (the song's goal pair).
  - The function's result is read as the new plan id: a bare uuid, with a
    row-shaped reply also accepted.
- **Plan views.**
  - Every plan column is returned except `user_id`.
  - A whole-song item has `snippet_title` "Whole song" and null
    `start_measure`, `end_measure` and `hand_mode`.
  - A snippet's hand mode comes from `sam_snippets.settings.handMode`
    (default "both"), because the table has no `hand_mode` column.
- **Progress range.**
  - "31 days" means 31 calendar days inclusive.
  - When the range is capped, `range` gains `capped: true`,
    `requested_from` and a `note`.
  - A reversed range is an error, and so is a malformed or impossible date
    such as 2026-02-30.
  - Item rows are sorted by day, then position.
- **`update_sam_plan_review_note` guards twice.** It reads the plan first
  (`already_noted` or a refusal), and the update itself is filtered on
  `status = 'active'` and `review_note is null`. If a concurrent write wins,
  the tool re-reads and reports what it found instead of overwriting.
- **`update_sam_song_goal` applies the audio rule in all three modes,**
  including `confirm_only`:
  - on audio songs, `goal_bpm` is set to `default_bpm`;
  - on other songs, `goal_playback_speed` is set to 100.
  - A stale pair can therefore change the heard goal on confirm. The proposal
    shows the current and new heard tempo, so that change is visible before
    approval.
  - `goal_set_at` is written from the Edge Function's clock.
- **`update_sam_goal`:**
  - `song_id: null` unlinks the song;
  - `completed_at` is set only on a change into `done` and cleared on a change
    out of it, so editing the notes of a done goal keeps its date.
- **`get_sam_goals`** defaults to 50 rows (`clampLimit(limit ?? 50)`), newest
  update first.

**Not visible from here.** The Milestone 1 SQL is not in the repo, and the
schema tool shows tables but not function bodies. The table shapes were
confirmed live. The `sam_create_practice_plan` input keys and return value,
and the column names the two progress functions return, follow the spec
(§5.7, §6.2). A mismatch would show at the first confirmed plan or the first
progress read.

**Tests**
- `node --test supabase/functions/_shared/tools/sam-plans.test.mjs`: 28 pass.
  - The suite loads the REAL `platform.ts`, with only its Deno imports
    stubbed, so the tier-3 tests go through the actual gate.
  - Covered:
    - both tier-3 proposals without `confirmed`, with nothing written;
    - a plan that would be refused, with every problem listed;
    - the exact `p_plan` passed to the function;
    - a P0001 refusal passed through unchanged;
    - `update_sam_song_goal` rejecting `goal_bpm` on an audio song and
      `goal_playback_speed` on a no-audio song, with and without `confirmed`;
    - the audio and no-audio writes;
    - review note `already_noted` (nothing written), a superseded plan, and
      the guarded update;
    - progress range defaults (active, and superseded using the Pacific end
      date), the 31-day cap keeping the latest 31, and a reversed range;
    - bad date formats;
    - the progress handler's function arguments and joins;
    - plan views, history by song, truncation, and goals;
    - the gate itself.
  - Mutations caught: removing the review-note pre-check, and removing
    `propose` from the gate (10 failures).
- `node --test supabase/functions/mcp/index.test.mjs`: 12 pass. It checks:
  - the new tools register;
  - the pass and session schemas and handlers carry the plan filters;
  - the nine schemas advertise exactly the args their handlers read,
    including args read through helpers (a removed schema field fails the
    test);
  - the count is 66.
- All other Edge Function suites and `tools/sam-tools` (269) still pass.
- `deno check`: `sam-plans.ts`, `platform.ts` and `tool-handlers.ts` are
  clean. `mcp/index.ts` gains only the nine implicit-`any` `args` warnings
  every registration already has.
