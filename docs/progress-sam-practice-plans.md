# Progress: SAM Practice Plans

Spec: `docs/technical-spec-sam-practice-plans.md`

## Status: Milestone 2 built — awaiting manual verification

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
- [ ] Tests pass; manual checks verified — tests pass (49 suites, 1038 tests); manual checks awaiting Alex

### Milestone 3 — Claude tools (Claude Code)
- [ ] get_sam_practice_plan, get_sam_practice_plans, get_sam_plan_progress, get_sam_goals (§6.1)
- [ ] plan_id / plan_item_id filters and columns on get_sam_passes and get_sam_sessions
- [ ] create_sam_practice_plan, update_sam_plan_review_note, update_sam_song_goal, create_sam_goal, update_sam_goal (§6.2)
- [ ] Deployed; verified from a fresh thread

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
