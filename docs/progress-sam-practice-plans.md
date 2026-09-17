# Progress: SAM Practice Plans

Spec: `docs/technical-spec-sam-practice-plans.md`

## Status: Milestone 5 verified — Milestones 6 and 7 are chat work

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
- [x] create_sam_snippet (tier 1), added 2026-09-17 (§6.2)
- [ ] create_sam_snippet deployed; verified from a fresh thread
- [x] Deployed; verified from a fresh thread — Alex, 2026-09-16: all nine new tools, both validation rejections, progress counting, the review-note guard, the goal tool, and a tier-3 regression check on create_sam_song. Test data deleted.

### Milestone 4 — Links and checklist strip (Claude Code)
- [x] recordPass and session creation write plan_id and plan_item_id (§7.2)
- [x] Checklist strip on the SAM home page (§7.3)
- [x] Tapping an item opens the song and snippet at target tempo
- [x] Verified against a test plan — Alex, 2026-09-16: strip counts, expand/collapse persistence, tap-to-open (snippet, whole song, audio), plan tempo not surviving a reload or a normal open, zero-note passes not counting, plan links on passes and sessions. One bug (archived label cut off), fixed in the follow-up below. Test plan deleted.

### Milestone 5 — Player display (Claude Code)
- [x] Plan line with Set tempo button (§7.4)
- [x] Song note line
- [x] Compact plan count while playing
- [x] Snippet row tag
- [x] Goal label by the tempo box
- [x] Verified — Alex, 2026-09-16: desktop checks pass (with the Milestone 4 follow-up). Piano checks not reported separately.

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

#### Milestone 4 — links and checklist strip (2026-09-16)

**Code**
- `src/sam/lib/activePlan.js` (pure):
  - `loadActivePlan`: the plan row, its songs (title, `audio_file_path`,
    `default_bpm`), and its items with snippet title, measure range, hand mode,
    rest measures and archived flag;
  - `loadTodayProgress`: `sam_plan_item_progress` with `p_from` = `p_to` =
    today, the Pacific date from `ptDateKey`;
  - `matchPlanItem` and `planLinkFor`: the §7.2 link rule;
  - `itemState`, `planSummary` and `itemTargetText`: the §7.3 display rules.
- `src/sam/lib/useActivePlan.js` is the one shared hook.
  - It is called once in SamPlayer and handed to SongLoader.
  - It loads when SAM opens, and reloads plan and progress on the home page
    mount and whenever the window regains focus or becomes visible.
  - Concurrent reloads collapse into one. A failed reload keeps the last good
    plan.
  - `refreshProgress` re-runs only the progress function. SamPlayer calls it
    after every recorded pass.
  - `getLink(songId, snippetId)` reads a ref, so it is stable inside
    ScrollEngine's frame loop. It returns nulls until a plan loads.
- `useSamPasses.recordPass` takes a `getPlanLink` and writes `plan_id` and
  `plan_item_id`. A missing or throwing link writes nulls and the pass is still
  recorded.
- `usePracticeSession.startSession` takes a `planLink` and writes both columns
  on every session insert. `beginSession` supplies it for Play, Restart and
  Resume alike.
- `src/sam/components/PlanChecklist.jsx` is the strip. It sits in SongLoader
  directly above PracticeWeekSnapshot and uses the same card treatment:
  `bg-card border border-border rounded-lg`, `text-sm font-medium` headline,
  `text-xs text-muted-foreground` detail, 52–56 px touch rows.
- `SamPlayer.openPlanItem(item)`:
  - loads the song;
  - loads the snippet unless it is archived or missing;
  - sets the tempo box to `target_bpm` and `target_playback_speed`.
  - Nothing is written to the song: tempo only saves through the tempo box's
    own Save button, which appears as usual because the value differs from the
    song's saved tempo.

**Decisions**
- **What "done" and "amber" mean.**
  - Done means qualifying ≥ target_passes.
  - Amber means attempts > 0 and qualifying < target, and not done.
  - Progress is shown as min(qualifying, target)/target.
  - Amber colours the title and the count `text-amber-700`, the same amber
    family as the player's partial-chord colour. The theme's `warning` token
    is brown, not amber.
- **Done rows** strike through the title, target and instruction lines, and
  show a check (`role="img"`, label "Done").
- **Archived or missing snippets.** An item whose snippet is archived, or no
  longer returned, shows " · <title> (snippet archived)" in muted text; the
  title is left out when the snippet is not returned at all. It opens the song
  without a snippet. Passes then match the plan's whole-song item for that
  song, if there is one.
- **The linking rule,** used for both passes and sessions:
  - the plan is linked even when no item matches, e.g. a snippet made on the
    fly (§2.11);
  - the item is linked when the song matches and the snippet id is equal, with
    a null snippet meaning the whole song.
- **The expanded state** is stored in localStorage under
  `sam.planChecklist.expanded`. Every read and write is wrapped in
  try/catch.
- **The home-page reload** runs from SongLoader's landing view, not on
  /sam/stats.

**Tests**
- `activePlan.test.js`: the link rule (whole song, snippet, no match, no plan,
  a throwing plan), done/amber/cap, the summary with and without free play,
  target text, and the loader. The loader test flags archived and missing
  snippets, sends a progress request for today only, and uses the Pacific
  date for today.
- `useSamPasses.test.js`: the pass row carries the link; a whole-song pass
  looks it up with a null snippet; no plan, no link function or a throwing
  link all give nulls and the pass is still written.
- `usePracticeSession.test.js` (+2): the session insert carries the link, and
  nulls without one.
- `PlanChecklist.test.jsx`:
  - hidden without a plan;
  - the collapsed summary and truncated note, and the free-play suffix only
    when free play exists;
  - expanded order with the Optional Free Play label;
  - each row's title, target, instruction and capped progress;
  - done, amber and open states;
  - the archived snippet text;
  - tap opens the item;
  - the remembered state, and storage that throws.
- `SamPlayer.plan.test.jsx` runs end to end:
  - the home page shows the plan, with progress only from the function (for
    today) and no pass reads;
  - no plan means no strip;
  - focus reloads the plan;
  - tapping a snippet item opens it at 60 BPM, with no song write, and the
    session row and the pass row after one loop both carry the plan and item;
  - a recorded pass triggers exactly one progress refetch and no plan reload;
  - a whole-song item links to the whole-song item;
  - an archived snippet opens the whole song.
- Mutations caught: loading archived snippets anyway (1 failure); dropping the
  session link (3 failures).
- `npm test`: 53 suites, 1072 tests pass. Lint is clean on every new and
  changed file.
- **Tap-to-open mechanism** (reported late): neither navigation state nor
  query parameters.
  - The strip calls `SamPlayer.openPlanItem` directly (a prop through
    SongLoader). That function loads the song through the same
    `handleSongLoaded` path as the library, then applies the snippet and
    tempo in memory.
  - The URL then becomes the ordinary `/sam/songs/:id`. So a reload, or
    opening the song normally, loads the song's own defaults. Alex's manual
    test confirmed this.

#### Milestone 4 follow-up (2026-09-16)

**A1. Archived label not shown — a layout bug.** The data was fine: the
snippet's `archived` value is loaded, and the strip reloads when you return
home (a new end-to-end test archives in the player, returns, and sees the
label). The label sat inside the title span, which truncates, so a long title
such as Pastorale's cut off the snippet name and the label with it.
- **Rows now have four lines.**
  1. The song title, truncated, with the progress fixed on the right.
  2. The range, muted: "m.1–2 · RH" (hand mode only when not Both),
     "Whole song", or "… · (snippet archived)".
  3. The target.
  4. The instruction, when there is one.
- **Snippet titles** are added to the range line only when they say more than
  the range. Generated titles ("Measures 1-2 RH No Rest") are left out
  (`itemRangeText`).
- **An archived snippet keeps its range** in front of the label, so two items
  on one song never look identical.
- **Hardening in `useActivePlan`.** A reload requested while another is still
  running now queues one more load instead of joining it. The running load
  may have started before the change it was asked about.

**A2. A header on the SAM home page.** The back arrow is followed by lucide
`Music` (the icon Alfred's navigation uses for SAM) and "SAM", in the
`text-lg sm:text-xl font-medium` heading style of Alfred's pages. Top padding
on the library is now `pt-2` (was `py-6`; the player is unchanged). The
checklist strip and the 7-day strip now use `mt-2` (was `mt-4`).

**Test list from the Milestone 4 brief**
- **Already covered:** the matching rule; the collapsed line with and without
  free play; done and amber; ordering with free play last.
- **Tap-to-open applying the plan tempo** was only partly covered: the test
  checked for no inserts into `sam_songs`, but a tempo save would be an
  update. The end-to-end mock now records updates and asserts none reach
  `sam_songs`.
- **"Linking doesn't block a pass when the plan hasn't loaded"** was covered
  only at the hook level. It now also has an end-to-end test: the plan request
  never answers, and the session and pass are still written, with null links.
#### Milestone 5 — player display (2026-09-16)

**Code**
- `activePlan.js` gains:
  - `heardTempo`: round(bpm × speed / 100), from the live tempo box.
  - `itemForLoadedRange`: the loaded song and snippet. A range that was typed
    but never saved matches no item: it is not the whole song.
  - `planSongFor`.
  - `planLineText`, `planBadgeText` and `snippetTagText`.
- `components/PlanLine.jsx` sits directly under the stats row when not
  playing.
  - **The item line:** "Plan · 60 BPM · 90% · 2/4 today · Count out loud",
    or "Free play · 78 BPM · 0/1 today".
    - Done: a check and "Done 4/4 today", muted.
    - Amber: attempts today, not done.
    - "Set tempo" appears only when the heard tempo differs from
      `target_effective_bpm`, and sets the tempo box's BPM and speed.
  - **The song note:** "Song goal: …", muted, one line, tap to expand. It
    appears under the item line, or alone when the loaded range has no item.
  - Nothing renders for a song outside the plan.
- **Playing bar:** `FocusedPlaybackBar` takes `planBadge`, shown as "Plan 2/4"
  or "Plan ✓". `LiveSessionCounter` gained an `afterPasses` slot so the badge
  sits right after Completed Passes.
- **Snippet panel:** `SnippetPanel` takes `planTagFor(snippetId)`. A planned
  snippet's row gets "Plan · 60 BPM · 2/4" or "Plan ✓" after its figures.
- **The goal label** (`GoalLabel` in `NumericSettings`):
  - It sits right after the BPM box (songs without audio) or the Speed box
    (audio), inside the tempo row, which already wraps.
  - It shows "Goal N" only when `goalSetAt` is set.
  - It is amber when the heard tempo is below the goal, muted otherwise.
  - Tapping it sets `goal_bpm` (no audio) or `goal_playback_speed` (audio,
    BPM untouched). Nothing is saved.
- **Song fields:** `mapSongRow` carries `goalEffectiveBpm` and `goalSetAt`,
  and the edit dialog's columns (`SONG_EDIT_COLUMNS`) include both.
- **Edit dialog save** (`SongMetadataEditor`): it now updates `goalEffectiveBpm`
  and `goalSetAt` in memory, using the trigger's rule, so the label is right
  without a reload.
- **Session link fix:** a range whose save failed (no snippet id) is linked
  to the plan with no item. Before, it could have matched the whole-song item.
- Every count still comes from `sam_plan_item_progress`. After a pass, the
  existing progress refetch updates the line, the badge and the tags.

**Decisions**
- **Colours:** amber is `text-amber-700` everywhere (line, badge, tag, goal
  label); done is muted.
- **Snippet tag in the default state:** the tag always sits on the muted
  `bg-secondary` chip, so an item with no attempts today reads "open", not
  amber.
- **Goal label on audio songs:** it applies `goal_playback_speed` only. The
  song's BPM is its scroll-sync calibration, which equals `goal_bpm` for these
  songs.

**Tests** (`npm test`: 55 suites, 1107 tests)
- `activePlan.test.js` (+5 groups): heard tempo; plan line text for an item,
  free play, done, and no instruction; the badge and tag; the loaded-range
  rule, including an unsaved range; the plan song lookup.
- `PlanLine.test.jsx` (8):
  - item, free play, done (check, muted) and amber, plus a plain state with no
    attempts;
  - Set tempo only when the tempo differs (below, above, equal), and its
    callback;
  - the song note with an item (truncated, tap expands) and alone;
  - nothing rendered when nothing applies.
- `NumericSettings.goal.test.jsx` (7):
  - hidden while `goal_set_at` is null;
  - amber below the goal, muted at or above it, for songs with and without
    audio;
  - tap-to-apply: `bpm.set(goal_bpm)` with no audio, `playbackSpeed.set(goal
    speed)` with audio, and no write to `sam_songs`;
  - the mapping and edit columns carry the goal fields.
- `SamPlayer.plan.test.jsx` (+7, end to end):
  - the whole-song plan line, with Set tempo changing 65 → 55 and no
    `sam_songs` update;
  - a song outside the plan shows nothing;
  - the song note with an item, and alone;
  - the playing badge next to Completed Passes: amber "Plan 3/4", then
    "Plan ✓" after the pass that finishes it (through the progress refetch);
  - no badge outside the plan;
  - the snippet row tag "Plan · 60 BPM · 0/4", and "Plan ✓".
- Mutations caught: Set tempo always shown (3 failures); the goal label
  ignoring `goal_set_at` (1); the badge not passed to the playing bar (1).
- Lint is clean on every new and changed file.

#### Milestone 5 follow-up (2026-09-16): two UI fixes
- **SAM home header.** It now sits in the library's centered `max-w-lg`
  column, as a three-column grid: back arrow, the centered icon and "SAM",
  and an empty spacer as wide as the arrow. The title stays centered and
  can't overlap the arrow on narrow screens. Spacing is unchanged; the player
  is untouched.
- **The goal label is now a real button,** with the same height, border,
  radius, padding and font size as Save and Tuning.
  - Below the goal: amber text and an amber border.
  - At the goal: muted and disabled.
  - Tooltip and aria-label: "Set tempo to goal (this session only)".
  - Behaviour is unchanged.
  - The plan line's "Set tempo" button already used the Save style; it now
    matches it exactly (`flex items-center gap-1` added).

#### create_sam_snippet (2026-09-17)

Built from the snippet fact-finding report, so plans can use snippets the app
hasn't made yet.

**Code**
- New `supabase/functions/_shared/tools/sam-snippets.ts`, registered in
  `mcp/index.ts`. The tool count is now 67.
- **What it writes:** exactly what the app's Save New writes, after matching
  first with the app's identity rule, archived rows included. It restores an
  archived match rather than duplicating it.
- **Title:** `formatSnippetTitle` is ported. The Edge Function can't import
  `src/sam/lib/snippetsApi.js`, because that file imports the browser Supabase
  client. The test lifts the app's function out of that file and checks both
  give identical output for 120 inputs (every hand mode, including missing;
  rests 0, 1, 2, 10, missing and null; four ranges).
- **Validation:** refuses a missing or archived song, a song with no measures,
  `start_measure` < 1, `end_measure` < `start_measure` or past the last
  measure, a bad `hand_mode`, and a negative or fractional `rest_measures`.
  Nothing is written in any of these cases.
- **Errors:** house style, `create_sam_snippet: …`. A database error reads
  "… failed: <message> [code]", with no do-not-retry wording.

**Tests**
- `sam-snippets.test.mjs`: 25 pass. It uses the real `defineTool`, as the
  plan tools' tests do. Covered:
  - title parity;
  - an insert whose payload is exactly the app's (settings exactly
    `{handMode}`), with `id` first in the result;
  - the defaults (`both`, 0);
  - a live match returned with nothing written, including on a repeated
    call;
  - an archived match restored with the same id and `created_at`;
  - a live match winning over an archived twin;
  - legacy settings without `handMode`, and null settings, matching `both`;
  - a different hand mode creating a separate snippet;
  - a different rest count creating a separate snippet, and a null rest
    matching 0;
  - another song's snippet never matching;
  - all 13 validation errors, with nothing written;
  - `end_measure` equal to the last measure allowed;
  - the wording of an operational error.
- Mutations caught: a changed title in the port (3 failures); inserting even
  when a live match exists (4).
- `mcp/index.test.mjs`: 13 pass. The new test checks the registration, tier 1,
  and that the schema lists exactly the five args the handler reads.
- Every other Edge Function suite passes.
- `deno check` is clean on `sam-snippets.ts`. `mcp/index.ts` gains only the
  usual implicit-`any` `args` warning.

#### Readability pass (2026-09-17)

Alex plays without glasses; the plan UI had to be legible from a playing
posture. Readability only — no layout or behaviour changes.

| element | before | after |
|---|---|---|
| Checklist range / target / instruction | `text-xs`, `text-muted-foreground` | `text-sm`; target and instruction `text-foreground`, range stays `text-muted-foreground` |
| Checklist progress count | `text-sm font-mono` | `text-base font-mono font-semibold` (a step above the title) |
| Checklist done item | `text-muted-foreground` + strikethrough | `text-foreground` + strikethrough |
| Checklist amber | `text-amber-700` | `text-amber-800` |
| Checklist collapsed day note, Free Play label | `text-xs` | `text-sm` |
| Checklist summary, expanded day note | `text-dark` (an undefined class) | `text-foreground` |
| Plan line | `text-dark` / `text-muted-foreground` when done | `text-foreground` (body size already) |
| Plan line amber | `text-amber-700` | `text-amber-800` |
| Song note | `text-muted-foreground` | `text-foreground` |
| Snippet plan tag | `text-xs`, `bg-secondary`, `text-muted-foreground` / `text-amber-700` | `text-sm`, `bg-card border border-border`, `text-foreground` / `text-amber-900` |

**Why these tokens** (contrast against their own background):
- `text-dark` and `text-muted` are used 63 times in the app but are NOT
  defined in `tailwind.config.js` or `index.css`. They do nothing; the text
  merely inherits. Every one of them in these components is now an explicit
  token.
- `foreground` #2A2520 is 15.2:1 on the card, 14.5:1 on the background.
- `muted-foreground` #524D48 is 8.4:1 on the card. It is the darkest muted
  token there is — the range line's problem was its size, not its colour.
- Amber on the card: `amber-700` 5.0:1, `amber-800` 7.1:1, `amber-900` 9.1:1.
- The snippet tag also sits on a selected row filled with `primary-light`
  #D4B8A8, where `amber-700` is 2.7:1 and `amber-800` 3.8:1 — both too low.
  Giving the chip its own `card` background fixes that for every state, and
  a border keeps it visible on a plain white row. On the chip, `foreground`
  is 15.2:1 and `amber-900` 9.1:1.
- Nothing in the three components is now below `text-sm`, SAM's body size.

**Tap affordance (2026-09-17).** On a tablet there is no hover, so nothing said
a checklist row could be tapped to open its song. Each row now has its own
outlined surface (`border-border` on `card`, rounded), a pressed state
(`active:bg-secondary`) alongside the existing hover, and a trailing
`ChevronRight` in the same place as the practice snapshot's. Rows are spaced
`gap-2` and the padding moved from the list to the rows, so the strip is no
taller than before. Behaviour is unchanged; a test pins the border, the pressed
state, the 52px target and the chevron.
