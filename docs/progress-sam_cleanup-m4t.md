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
- [ ] **s4. Part 3.** Remove the legacy beats[] branches from `ScoreRenderer.jsx`
  and `scoreRender.js`. Check `normalizeMeasure`'s callers before touching it.
  - *Check:* the score renders as before, and the score tests pass.
- [ ] **s5. Part 4.** Claim `docs/history/progress-sam-rail.md` first. Run both
  suites. Tick Step 6, or list the gaps.
  - *Check:* both suites green.
- [ ] **s6. Part 5.** A measure field beside Resume, prefilled with the paused
  measure, limited to the loaded range. Resume starts there.
  - *Check:* pause at m.12, enter 8, Resume, and it starts at m.8 with audio in
    sync.
- [ ] **s7. Part 6a, app side.** Mostly done at s3c: the opened item's id is
  kept (from the URL), written as `plan_item_id`, and preferred over song plus
  range. Left: check the checklist and Next with two items on one range.
  - *Check:* plan 32's items still link and count as before.
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

## Next step's scope (s4)
- create: nothing
- update: src/sam/components/ScoreRenderer.jsx, src/sam/lib/scoreRender.js, src/sam/lib/measureUtils.js, src/sam/components/ScoreRenderer.padding.test.jsx, src/sam/components/ScoreRenderer.labels.vexflow.test.jsx, docs/progress-sam_cleanup-m4t.md
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 20m

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
