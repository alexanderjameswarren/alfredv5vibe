# Progress: SAM practice plan fixes (sam_cleanup-m4t)

Spec: `docs/technical-spec-sam_cleanup-m4t.md`.

## Claims

Claimed at s2c, 31 paths. No `db:` items.

Not claimed yet, each claimed by the step that needs it:
- `docs/history/progress-sam-rail.md`: held by switchboard2-h8r. **s5** claims it
  first. If it is still held, s5 runs the suites, reports the result and the
  block, and leaves the tick.
- `supabase/functions/mcp/index.ts` and `supabase/functions/mcp/index.test.mjs`:
  held by switchboard2-h8r. **s8** claims them just in time, beside `db:deploy`.
  If they are still held, s8 does the migration, the functions and
  `sam-plans.ts`, and reports the block for the tool description.

## Steps

- [x] **s1. Plan.** Read-only.
- [x] **s2. Confirm and claim, spec, progress.** Done at s2c: s2 and s2b were
  refused on held files.
- [x] **s3. Parts 1 and 2.**
  - Part 1: `refresh()` (plan and progress) when `songDbId` or the loaded snippet
    changes, and after each pass in place of `refreshProgress()`. `planRef`
    follows, so pass linking stops reading a stale plan. No polling, no Realtime.
  - Part 2: Next says "optional" for a Free Play item.
  - *Check:* save a plan while `/sam` is showing, open an item, and the new plan
    is in use. Next on a Free Play item reads "optional".
- [x] **s3c. The URL says what is open.** `/sam/songs/<id>?item=<planItemId>`,
  `?snippet=<snippetId>`, or bare for the whole song. Plan items, Next, the home
  checklist, Continue cards and library rows navigate (push); one URL effect
  loads. An old item opens its snippet if it still loads; an unknown snippet
  opens the whole song; either corrects the URL in place. Passes and sessions
  credit the URL's item first.
  - *Check:* reload, Back, Forward and a copied link each restore the item.
- [x] **s4. Part 3.** Remove the legacy beats[] branches from `ScoreRenderer.jsx`
  and `scoreRender.js`. Check `normalizeMeasure`'s callers before touching it.
  **Stopped at s4 (2026-11-06):** 8 stored songs still have beats[] (archived
  "Someone Like You" copies). Alex chose to delete them first.
  - [x] s4b: test script `supabase/tests/sam_cleanup-m4t/1_beats_songs_counts_test.sql`
    queued (action f7acd900-b47b-46b1-aba8-716bcdc2dbf1).
  - [ ] s4b2: the delete, as migration 212; `--expect 134,12,8`. **Stopped:**
    the plan guard refused the `_pending_` file because the draft used a temp
    table (`s4b2_songs`) not named under SQL. Nothing written or queued. The
    `db:` claims are held for the retry.
  - [x] s4b2b: `supabase/migrations/212_sam_cleanup_delete_beats_songs.sql`
    (no temp table, each delete guarded), queued with `--expect 134,12,8`, action
    d3f4d216-81d5-497a-b90a-66954c71fbbb. **Queued, not applied.** `db:` claims
    held until the delete is confirmed; s4c releases them.
  - [x] s4c: the code removal. Migration 212 applied (run 27ac1bfc); a read-only
    check then found 0 beats[] measures in 87 songs. The `db:` claims were released.
    - The beats[] branches are gone from `ScoreRenderer.jsx` and `scoreRender.js`;
      the voice block is now unconditional.
    - `normalizeMeasure` always derives beats[] from rh/lh.
    - The two ScoreRenderer tests were already voice format, so they are unchanged.
    - **Next Checkpoint carries:** `supabase/migrations/212_sam_cleanup_delete_beats_songs.sql`,
      `supabase/tests/sam_cleanup-m4t/1_beats_songs_counts_test.sql`, and this
      step's three code files.
  - *Check:* the score renders as before, and the score tests pass.
- [x] **s5. Part 4.** Claim `docs/history/progress-sam-rail.md` first. Run both
  suites. Tick Step 6, or list the gaps.
  - *Check:* both suites green.
  - Done 2026-11-06: claimed the rail file (now free). SongRail.test 8 and
    MoreDrawer.test 5 pass; no stale selectors; Step 6 ticked.
- [x] **s6. Part 5.** A measure field beside Resume, prefilled with the paused
  measure, limited to the loaded range. Resume starts there.
  - *Check:* pause at m.12, enter 8, Resume, and it starts at m.8 with audio in
    sync.
  - Done 2026-11-06:
    - `ResumeMeasureField` and `resolveResumeMeasure` live in
      TransportControls.jsx. The field takes played numbers and shows the
      printed one as "(n)".
    - SamPlayer keeps `resumeInput` (prefilled on pause). `handleResume` sets
      `pausedMeasure` to the clamped value, and the seek and ScrollEngine's
      start index follow it. SongRail passes `resumeAt` through.
    - FocusedPlaybackBar shows only while playing and has no Resume, so it is
      untouched. SamPlayer.audio.test is untouched; practice.test covers resume.
    - Tests: 4 in practice.test, 5 in the new TransportControls.test.
  - s6b (Alex's test passed; style fix):
    - The box now follows the BPM box: a label above ("Resume at:"), full
      width, `UI.input` (44px), `type="number"` and `inputMode="numeric"`.
    - It selects the whole value on focus. Enter, or the keypad's Go, resumes.
    - There is no shared number-input component, so it copies TempoControls'
      markup. SongRail needed no change.
    - Tests: +2 in TransportControls.test.
- [x] **s7 done 2026-11-06.**
  - `planItemsOnRange` was added. The snippet-row tag lists every item on its
    range, in position order ("Plan · 60 BPM · 1/4 / Plan · 75 BPM · 1/2"), and
    its tone follows the opened item. The row ladder editor prefers the opened
    item.
  - 4 SamPlayer.plan tests with two items on one range: the checklist order,
    Next, the plan line, the tag, and the session and pass link. Shared counts
    are marked TODO(s8). Plus 1 activePlan test.
  - Still range-keyed, with only the first item on the range shown: a snippet
    loaded by hand from the tray (it clears the opened item) and the stale-URL
    fallback. These are fine as they are. The counts come from
    `sam_plan_item_progress`, and `sam_plan_unplanned_practice` also matches by
    range; both go to s8.
- [ ] **s7. Part 6a, app side.** Mostly done at s3c: the opened item's id is
  kept (from the URL), written as `plan_item_id`, and preferred over song plus
  range. What remains:
  - SamPlayer's snippet-row plan tags (about lines 434 and 485) still call
    `matchPlanItem` by range alone. With two items on one range they would tag
    only the first; they should list or prefer the opened item.
  - Tests for two items on one range: the checklist rows, Next, the plan line
    and the snippet tag.
  - The counts stay range-matched until s8 changes `sam_plan_item_progress`.
  - *Check:* plan 32's items still link and count as before.
- **s8 stopped 2026-11-06.**
  - The plan guard refused `_pending_sam_cleanup-m4t_plan_item_positions.sql`
    because the SQL touches `sam_practice_plans`, which was not in scope. The
    function supersedes and inserts plans, and the progress functions check the
    plan exists. Nothing was written.
  - The mcp files are now claimed by this thread (free at s8). The `db:` claims
    were taken, then released at the stop.
  - The retry needs, under SQL: sam_practice_plans, sam_practice_plan_songs,
    sam_practice_plan_items, sam_passes, sam_songs, sam_snippets and
    platform.conformance_failures.
- [x] **s8r 2026-11-06 (the retry).**
  - Claimed the 7 `db:` items; the mcp files were already held.
  - `216_sam_plan_item_positions.sql`: drops `sam_practice_plan_items_one_per_range`
    and replaces the three functions. The function bodies were diffed against
    the snapshot, and only the marked changes differ.
  - Queued, not applied:
    - test `2_plan_item_positions_test.sql`, action 0ce798d4-29c6-4eb7-b46d-467f0d451ad1,
      to be run AFTER 216;
    - migration 216, action 43559849-cd80-490b-a0c8-432c7180b60f.
  - `sam-plans.ts` takes `position` (every item or none, no two alike) and the
    proposal lists the checklist order. It never had an item-level "appears
    twice" check; the song-level one stays. +3 tests.
  - The `create_sam_practice_plan` text and its schema now have `position`, with
    repeats allowed. +1 index test.
  - Skill updated to 2026-11-06a.
  - Plan-test lint is down to 0 errors. TODO(s8) is gone, and the tag test now
    asserts per-item counts.
- **s8b stopped 2026-11-06.**
  - Migration 216 applied (run c3902d60, conformant). Its first test run
    (cf03b03f) failed 3 checks, all bugs in the test script. They are fixed:
    - a smallint[] cast;
    - the unplanned rows filtered to the test song;
    - the active plan recorded at run time instead of plan 32 (74b06905 is
      active now).
  - Re-queued as action 982a341f-5a48-44b8-92f4-02a11121289a.
  - Claimed `db:deploy` and the 7 items. Then the plan guard refused a read-only
    `git grep` for the text "supabase functions deploy" as an undeclared deploy.
    Stopped before deploying. `db:deploy` was released while waiting; the 7
    items are held.
- [x] **s8c 2026-11-06.**
  - The re-queued test passed (run a716adc0, 17 of 17).
  - Claimed `db:deploy`, then ran `npx supabase functions deploy mcp`:
    "Deployed Functions." Conformance: CONFORMANT, 103 tables.
  - Live check, an unconfirmed `create_sam_practice_plan` that wrote nothing:
    the La Candeur 1-38 snippet appears twice at positions 2 and 1, it is
    accepted, and the proposal lists "CHECKLIST ORDER (by position)". So the
    deployed bundle carries s8r's code.
  - The tool description this session sees is the connector's copy from before
    the deploy, so the new text is confirmed by the bundle, not read live.
  - The 8 `db:` claims (with `db:deploy`) are held for the Checkpoint.
- [ ] **s8. Part 6b, database and tool, just in time.**
  - Database: `gitsync`, a drift check, claim the `db:` items and the mcp files,
    and number the migration. It drops `sam_practice_plan_items_one_per_range`,
    adds plan-wide item positions to `sam_create_practice_plan`, and makes
    `sam_plan_item_progress` and `sam_plan_unplanned_practice` match on
    `plan_item_id` first.
  - Tool and deploy: update `sam-plans.ts`, `mcp/index.ts` and the skill rule,
    queue the migration and the `--test` script, deploy mcp, run
    `check_platform_conformance`, then Checkpoint.
  - *Check:* plan 32 rebuilt with the La Candeur climb last, and each pass
    counting for the item it was opened from.
- [ ] **Finish.** gitpush Finish.

| Step | Estimate |
|---|---|
| s3 | 25m |
| s4 | 20m |
| s5 | 10m |
| s6 | 30m |
| s7 | 35m |
| s8 | 60m |
| **Total** | **3h00m** (3h10m with s2) |

## Next step's scope (s8b)
Starts after Alex approves migration 216 (43559849) and then the test (0ce798d4,
expected ok true). Claim `db:deploy` and re-claim the 7 `db:` items. Deploy mcp,
run `check_platform_conformance`, and check that the live
`create_sam_practice_plan` text mentions `position`. Then Checkpoint, which
releases the `db:` claims.
- create: nothing
- update: docs/progress-sam_cleanup-m4t.md
- delete: nothing
- deploy: mcp
- SQL: none
Estimated run: 10m

## Timing log

| Step | Start | End | Duration |
|---|---|---|---|
| s1 | 14:17:58 | 14:20:43 | 2m45s |
| s2 (refused) | 15:15:55 | 15:17:02 | 1m07s |
| s2b (refused) | 15:18:38 | 15:18:42 | 0m04s |
| s2c | 15:22:14 | 15:23:17 | 1m03s |
| s3 | 15:38:08 | 15:42:44 | 4m36s |
| s3b | 16:01:42 | 16:07:59 | 6m17s |
| s3c | 06:36:32 | 06:43:54 | 7m22s |
| s4 (stopped) | 06:53:22 | 06:54:25 | 1m03s |
| s4b | 07:06:43 | 07:08:59 | 2m16s |
| s4b2 (stopped) | 07:18:23 | 07:19:10 | 0m47s |
| s4b2b | 07:30:52 | 07:31:40 | 0m48s |
| s4c | 07:43:04 | 07:45:46 | 2m42s |
| s5 | 07:55:02 | 07:56:27 | 1m25s |
| s6 | 08:02:07 | 08:07:38 | 5m31s |
| s6b | 08:13:22 | 08:14:31 | 1m09s |
| s7 | 08:25:36 | 08:28:55 | 3m19s |
| s8 (stopped) | 08:49:00 | 08:52:25 | 3m25s |
| s8r | 09:01:37 | 09:11:26 | 9m49s |
| s8b (stopped) | 09:59:55 | 10:01:44 | 1m49s |
| s8c | 10:06:21 | 10:07:43 | 1m22s |

## Log

- 2026-11-05 s2c: claimed 31 paths. Part 1's cause was found at s2: the plan
  state survives route changes inside SAM, and nothing reloads it when an item
  opens.
- 2026-11-05 s3:
  - `useActivePlan(openKey)` reloads plan and progress when the key (song id,
    plus snippet id) changes.
  - SamPlayer passes the key, and calls `refresh()` after each pass in place of
    `refreshProgress()`.
  - `refresh()` already runs one load at a time and queues one more, so an older
    plan load cannot land last. Progress keeps its sequence guard. Tests cover
    both.
  - `nextItemLead` / `nextItemLabel` read "Next (optional):" for Free Play.
  - SongLoader.jsx needed no change: its landing reload stays.
  - The SAM suites: 63 passed, 1 skipped, 923 tests.
  - The full app suite fails only `src/switchboard/ApprovePage.test.jsx`, which
    this thread did not touch.
- 2026-11-05 s3b: the same-song item bug (Great Balls 18-25 RH, then another
  Great Balls item, opened as the full song at 150) **did not reproduce**.
  - `openPlanItem` never goes through the URL effect, and it sets song, id,
    snippet and tempo in one batch.
  - The URL carries no snippet, so the only ways to get the full song at the
    song's default tempo are: the URL load of `/sam/songs/<id>` (reload,
    browser Back or Forward, a typed or pasted link), a Continue card, the
    library, or the family sheet.
  - 8 tests added in `SamPlayer.plan.test.jsx`, all passing:
    - snippet to snippet, snippet to whole song, and whole song to snippet,
      each via Next and via the home checklist;
    - Next while paused;
    - StrictMode with a slow fetch.
  - No app code changed. The candidate fix, if the manual repro shows a URL
    path: carry the plan item in the URL (`?item=<id>`) and re-run the URL
    effect when it changes.
- 2026-11-06 s3c: the URL is now the single source of what is open.
  - `activePlan.js`: `openSearch`, `parseOpenSearch`, `loadOpenableSnippet`,
    `loadStaleItemSnippet`; `matchPlanItem`, `planLinkFor` and
    `itemForLoadedRange` take the opened item id.
  - `useActivePlan.js`: `getLink(song, snippet, itemId)` and `whenLoaded()`.
  - `SamPlayer.jsx`: `openItemId` state; the URL effect keys on path and query;
    state→URL replaces the query when a snippet is picked in the player.
  - `SongLoader.jsx`: library, Continue and family-sheet rows navigate.
    `SongRail.jsx` and `PlanChecklist.jsx` needed no change.
  - Tests: 6 in `SamPlayer.plan.test.jsx`, 2 in `activePlan.test.js`. SAM suites
    63 passed, 1 skipped, 939 tests; full app suite 221 suites, 3259 tests;
    scripts 54.
- 2026-11-06 s4 stopped before any deletion. A read-only check (get_sql_read)
  of `sam_songs.measures` found beats[] measures in 8 of 95 songs:
  - all titled "Someone Like You", all archived, 8 measures each, created
    2026-02-14/15, last updated 2026-09-16;
  - they have 0 passes and 12 sessions between them;
  - ids: 6d2b5206-8f04-4ec4-abf4-8122383b927a, 179dd081-1575-42c2-89a9-7b05d927aa93,
    10856805-6e74-412e-9398-ac6a2f471156, ee14dee1-c783-4277-ab9b-e19ff5e5fdf9,
    1a39dad3-30a8-4da7-bcc7-5446614cb7ea, 032f4a21-2a5e-496b-ae1d-6c128c88ce79,
    311de635-9df6-4bde-af39-c07290b031fa, e6013004-9d75-458f-9d27-3b42776538d6.
  - `sam_song_measures` has no beats column; the claude_reader role cannot read it.
- 2026-11-06 s4b: claimed the 11 `db:table:` items. A read-only check found none
  of the stop conditions: 8 archived matches, 12 sessions, 0 passes, no goals,
  no plan rows, no children inside or outside the 8, all `original`. The reader
  cannot see `sam_session_events`, so the test returns that count. The test is
  queued; the delete is not yet written, since `supabase/migrations/` was not in
  this step's scope.
