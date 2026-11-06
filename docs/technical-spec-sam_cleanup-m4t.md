# SAM practice plan fixes (sam_cleanup-m4t)

Six small fixes to SAM's practice plan player and score rendering. The front-end
work comes first (s3–s7). The one database and MCP tool change (Part 6) comes
last (s8), done just in time.

## Part 1. A new plan shows without a manual refresh

**Symptom.** A plan saved through `create_sam_practice_plan` does not show in SAM
until a manual reload. Alex is on `/sam`, the plan is saved in claude.ai, and he
clicks an item, which goes to `/sam/songs/<id>`. Next is then worked out from the
old plan and old progress.

**Cause.** `useActivePlan` lives in `SamPlayer.jsx`. That component stays mounted
for `/sam` and every `/sam/songs/<id>`, because `Alfred.jsx` renders it for the
whole SAM view, so the plan in memory survives every route change inside SAM. It
reloads only:
- on mount,
- on window focus or visibilitychange,
- from `SongLoader.jsx` when `samView` becomes "landing".

Opening a song or a snippet never reloads it. After a pass, only
`refreshProgress()` runs, never the plan. `planRef`, which pass linking
(`getLink`) reads, is updated only by `refresh()`, so it goes stale the same way.

Ruled out:
- the service worker (`public/notify-sw.js` has no fetch handler),
- a client query cache (none),
- module-level caches (none).

**Fix.** Call `refresh()`, which reloads the plan and then its progress:
- when `songDbId` changes (a song opens, from a route or from the library),
- when the loaded snippet changes,
- after each recorded pass, in place of `refreshProgress()`.

`refresh()` already runs one load at a time and queues one more if asked during a
load, so several calls close together are safe. No polling and no Realtime.

**Success.**
- A plan saved while `/sam` is showing is the one in use once any item or song
  opens.
- A plan saved mid-practice is in use after the next pass.
- Passes link to the new plan's items.
- A test covers each trigger.

## Part 2. Free Play is marked optional on Next

When the item Next offers is Free Play, the button says so: "Next (optional):
<song> <range>". Its accessible name says the same. `nextItemLabel` and
`PlanNextButton` change together.

**Success.**
- A Free Play Next item shows "optional" in its label and aria-label.
- Main-work Next is unchanged.
- Tests in `activePlan.test.js` and `PlanLine.test.jsx`.

## Part 3. Remove the legacy beats[] render paths

`songSchema.js` already refuses a measure with `beats[]`. The renderers still
carry a branch for it:
- `ScoreRenderer.jsx`, the "Legacy beats format" branch, about line 483,
- `scoreRender.js`, the same branch, about line 885.

Remove both. Voice-format (`rh[]` / `lh[]`) rendering stays exactly as it is.

`measureUtils.normalizeMeasure` turns voice format into beats for internal use,
and its `if (measure.beats) return measure` line may also stop it converting
twice. s4 checks every caller before touching it, and keeps it if anything
relies on that.

**Success.**
- No code reads a stored `measure.beats` as input.
- Score tests pass with fixtures moved to voice format where they used beats.

## Part 4. Song-rail Step 6, Tests

`docs/history/progress-sam-rail.md` Step 6 ("Selector updates, MoreDrawer tests,
both suites") is unticked. `MoreDrawer.test.jsx` (5 tests) and `SongRail.test.jsx`
(8 tests) exist.

s5 runs both suites:
- If they are green, it ticks Step 6 with a log line.
- If not, it lists what is missing or failing.

The rail file is held by switchboard2-h8r, so s5 claims it first.

**Success.** Step 6 is ticked with both suites green, or a precise list of the
gaps.

## Part 5. Resume at a chosen measure

While paused, a number field sits beside Resume:
- It is prefilled with `pausedMeasure` and is editable.
- Resume starts at the measure entered: the ScrollEngine start index, plus the
  audio seek through `getSeekForMeasure` on songs with audio.
- The value is limited to the loaded range (the snippet's bounds, or the song's
  measures).
- An empty or out-of-range value falls back to the paused measure.

It appears wherever Resume does: `TransportControls.jsx` (via `SongRail.jsx`) and
`FocusedPlaybackBar.jsx`.

**Success.**
- Prefilled with the paused measure.
- Editing it and pressing Resume starts at that measure, with audio synced.
- An invalid value resumes at the paused measure.
- Tests in `TransportControls.test.jsx` and `SamPlayer.practice.test.jsx`.

## Part 6. The same song twice in a plan, items ordered on their own

### What blocks it today

1. `sam-plans.ts` validation rejects a repeated `song_id` ("appears twice; list
   each song once with all its items").
2. `sam_create_practice_plan` rejects it too ("listed more than once"), and so
   does the unique key `sam_practice_plan_songs (plan_id, song_id)`.
3. The same range twice is refused by the function ("one item per range per
   plan") and by the unique index `sam_practice_plan_items_one_per_range` on
   `(plan_id, song_id, coalesce(snippet_id, 0))`.
4. Item positions follow song order. The function numbers items while walking
   `songs[]` and their nested `items[]`, so no item can sit after another song's
   items.
5. Passes are matched to items by song plus snippet, never by item id: in the
   app (`matchPlanItem`, `planLinkFor`, `itemForLoadedRange`, `planSongFor` in
   `activePlan.js`) and in the database (`sam_plan_item_progress`,
   `sam_plan_unplanned_practice`). Two items on one range would share every pass.

### The live example: plan 32 (b6e8418a, 2026-11-05)

La Candeur has a warm-up at 70 (the whole song, item 1) and a climb at 75 x3 that
Alex should play last. The climb could not be a second whole-song item, and it
could not sit at the end of the list. So it is a workaround snippet (837efd57,
bars 1–38, no rest) at position 2. The song note tells him to play it last, but
the checklist and Next send him there second.

### Design

Settled at s8 (migration 216):
- **Songs once, items may repeat.** A song appears once in `songs[]`, and
  `sam_practice_plan_songs (plan_id, song_id)` stays unique, holding the song
  note. Its items may repeat a range: the index
  `sam_practice_plan_items_one_per_range` and the function's check are gone.
- **Positions.** Each item takes an optional plan-wide `position`, and the
  checklist runs in that order, whatever the song order.
  - Either every item gives one or none does. Some but not all is refused.
  - Positions are whole numbers from 1, no two alike. Gaps are allowed.
  - With none, positions run song by song in array order, as before.
  - `sam-plans.ts` applies the same rule before the proposal, and the proposal
    lists the checklist order.

**Pass matching.** A pass counts for the plan item that was opened.
- The app keeps the id of the item it opened, from the URL's `?item=` (s3c). It
  writes that id to `sam_passes.plan_item_id` and `sam_sessions.plan_item_id`.
  Both columns already exist (migration 054), so no new column is needed.
- In `sam_plan_item_progress`, a pass linked to an item of THIS plan counts for
  that item only. A pass with no `plan_item_id`, or linked to an item of another
  plan, falls back to song plus range and counts for every item of this plan on
  that range. The second case is practice done before a plan saved mid-day; Alex
  accepted this refinement at s8.
- `sam_plan_unplanned_practice` uses the same matching. A pass is planned when it
  is linked to an item of this plan, or when it is on an item's range.
- In the app, `itemForLoadedRange` and `matchPlanItem` prefer the opened item
  id. The snippet tags list every item on a range (s7), and `planSongFor` keeps
  its one row per song.

### Steps

- **s7 (app only):** keep the opened item id, link passes by it, and update the
  checklist and the player.
- **s8 (database and tool):**
  - one migration, `_pending_sam_cleanup-m4t_plan_repeat_songs.sql`, renumbered
    after gitsync;
  - `sam-plans.ts` validation and proposal;
  - the tool descriptions in `mcp/index.ts`;
  - the mcp deploy, `check_platform_conformance`, and the sam-practice skill rule
    at line 250.
- s8 claims `supabase/functions/mcp/index.ts` and `index.test.mjs` just in time,
  beside `db:deploy`. If switchboard2-h8r still holds them, s8 still does the
  migration, the functions and `sam-plans.ts`, and reports the block for the
  tool description.

**Database items, all claimed at s8:**
- `db:table:sam_practice_plan_items`
- `db:fn:sam_create_practice_plan`
- `db:fn:sam_plan_item_progress`
- `db:fn:sam_plan_unplanned_practice`
- `db:deploy`
- `db:table:sam_practice_plan_songs`, only if its key is relaxed

**Success.**
- `create_sam_practice_plan` accepts plan 32 rebuilt the natural way: La Candeur
  whole song @70 at position 1, and La Candeur whole song @75 x3 last.
- The checklist and Next show that order.
- A pass played from the climb item counts for the climb only. One from the
  warm-up counts for the warm-up only.
- Older passes with no item id still count by range.
- `get_sam_practice_plan` and `get_sam_plan_progress` return the same.
- A `--test` script in `supabase/tests/sam_cleanup-m4t/` shows each of these.
