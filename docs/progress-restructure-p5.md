# Progress: Alfred restructure Phase 5 — Menus and groups

Project code: restructure_p5-h7m
Spec: docs/technical-spec-restructure-p5.md

## Status: In progress (step 3 done, awaiting verification)

Each step stops for Alex's verification before the next. Database steps follow the just-in-time pattern: gitsync, drift check, claim db items at that step, `_pending_` migration numbered after the sync, Alex runs the SQL, conformance CONFORMANT, Checkpoint releases db claims.

### Development steps

- [x] 1. Plan (read-only): files, db items per step, claims check, answers to the spec's "plan step must confirm" questions
- [x] 2. Confirm and claim
- [x] 3. Housekeeping: move Phase 4 docs to docs/history/; Finish finds docs by their "Project code:" line
- [x] 4. Undo fix in src/items/useItemActions.js
- [x] 5. Retire ai-enrich: remove callers and code; delete the deployed function (db:deploy)
- [x] 6. Database: drop intents.is_item + is_intention comment; conformance
- [x] 7. Database: group_types (seeded, with icons and execution_mode), contexts.default_group_type_id, item_groups, item_group_members, intents.group_id (+ one live intention per group), events.group_id, executions.group_id (+ intent_id and event_id nullable), notes target 'group', last_completed_at / status triggers (status_guard on item_groups); register_table (policy 'none' + shared-context policy); conformance
- [x] 8. Data layer: group queries, derived names, realtime
- [ ] 9. Group create/edit page (search-and-add, drag reorder, type picker, pin, archive)
- [ ] 10. Group detail page (header, buttons, members, notes, recent executions)
- [ ] 11. Context page: create button, browse tabs, group rows, sort
- [ ] 12. Group chips on member rows and running cards; record-links order Context > Group > Item > Intention (incl. execution page); pinned groups on Home
- [ ] 13. Scheduling a group through its intention (frozen item_ids on events); Close/Undo for groups
- [ ] 14. Menu execution: Start Now together, per-recipe sections, sticky jump bar, skip a recipe, complete all, Log Execution
- [ ] 15. Projects/series: dated member execution list, teal in-progress marker, last_completed_at roll-up
- [ ] 16. MCP: skip wording, get_groups, group_id on reads, recipe (item) filter on get_execution_history / platform_search_executions; deploy (mcp/index.ts claimed at step 2)
- [ ] 17. Final verification; close Alfred intentions mvhawlfa9s9xlsnv069 and muh9uyjx8wdg02kck5d; update the build-order doc

### Notes

- 2026-10-20 Step 1 plan reported (clip `[restructure_p5-h7m-s1-k8vd]`). Findings folded into the spec on 2026-10-21: executions have `item_ids` (no `item_id`), and `intent_id` and `event_id` are NOT NULL; the date column is `last_completed_at`; items have no pin; there is no `closed_at`; the RecordLinks order is fixed inside the component.
- 2026-10-21 Step 2: Alex accepted corrections 1-8 and the spec is updated. The drag stays as built (native long-press works on the phone; drag is tested there). warren_buffet_p3-q5k released viewPaths.js. 78 files and folders were claimed in one command. No db: items are claimed yet.
- 2026-10-21 Step 3:
  - Moved the Phase 4 spec and progress files to `docs/history/` as Write copies, byte-identical by `cmp`, then deleted the originals.
  - Finish (`planDocsMove` in `scripts/lib/git-flow.mjs`) now moves every `docs/*.md` with a `Project code: <code>` line (bold or backticks allowed; `docs/history/` excluded), plus any doc named after the code. `missing` is reported only when no doc carries the line.
  - Four new tests in `git-flow.test.mjs`. A dry run on this worktree finds both P5 docs. CLI suite passes 239/239.
- 2026-10-21 Step 4 built: `useItemActions.js`, three changes, as Phase 4 did elsewhere.
  - `updateItem`'s list write is now functional (`setItems((prev) => …)`), so an update that lands meanwhile is kept.
  - The archive Undo checks its write (`writeError("Restoring the item")`) and puts the saved row back.
  - `setItemStatus`'s Undo throws on a failed write instead of silently doing nothing.
  - New `useItemActions.test.js` (6 tests). App suite 2769/2769, CLI 239/239. Awaiting Alex's phone and Chrome test.
- 2026-10-21 Step 4 verified by Alex (three Chrome tests) and committed.
- 2026-10-21 Step 5, code mostly done; two things are pending.
  - Removed the `[functions.ai-enrich]` block from config.toml and the ai-enrich prompt tests from `elementOffsets.test.js` (6 tests).
  - Removed dead code: `createUserClient`, `getContexts`, `getItems`, and mcp's unused `getItems` import.
  - Stale comments updated in platform.ts, tags.ts, tool-handlers.ts, tool-definitions.ts, supabase-client.ts, notify-dispatch, mcp, and the mcp-platform skill. The get_inbox `in_progress` wording changes with the step 16 deploy.
  - The `src/` comments are history and stay.
  - App suite 2763/2763, CLI 239/239.
  - **Pending:** deleting the `supabase/functions/ai-enrich/` folder. The claims guard blocked `rm` (false positive on the chained `git grep` pathspecs), so it waits for Alex.
  - **Pending:** the deployed delete. `db:deploy` is claimed; the function is live (v18, ACTIVE); Alex runs the delete.
  - Found: the alfred-enrich skill does not carry the `offsetMinutes` prompt rules that the removed test guarded.
- 2026-10-21 Step 5 done.
  - Alex deleted the deployed function; `functions list` no longer shows it.
  - `supabase/functions/ai-enrich/` deleted with a single `rm` (index.ts, deno.json, .npmrc).
  - App 2763/2763, CLI 239/239. `db:deploy` released.
  - Still to do: close Alfred intention muh9uyjx8wdg02kck5d at step 17.
- 2026-10-21 Step 6, written and waiting on Alex.
  - After gitsync, the highest migration is 146 (a WB function, nothing on intents), so there is no drift. The snapshot header says "through 145" but its content already has 146: the same header lag Phase 4 recorded.
  - `db:table:intents` claimed.
  - No code reads or writes is_item. `withoutDbOwned` keeps stripping it on purpose, as the stale-tab guard; the intentionRows test guards against isItem returning.
  - SQL written as `_pending_restructure_p5-h7m_drop_is_item.sql`, to be numbered 147. Waiting on Alex's OK to claim the numbered path.
  - Yielded `src/viewPaths.js` and `src/viewPaths.test.js` to warren_buffet_p3-q5k (unchanged). Step 9 must re-claim them.
- 2026-10-21 Step 6 done.
  - Alex ran the SQL: conformant true, failures []; only is_intention is left on intents; the new comment is in place; the app reloads fine.
  - Numbered as `147_restructure_p5_drop_is_item.sql` (Applied: YES); the pending file is deleted.
  - `db:table:intents` released.
  - Alfred intention mvhawlfa9s9xlsnv069 stays open until the step 16 skip-wording deploy.
- 2026-10-21 Step 7 written, not applied.
  - Drift: after gitsync the highest migration is 147; the sync brought only the regenerated snapshot. Nothing touches the step's tables or triggers.
  - Claimed 16 db items: 8 tables (group_types, contexts, item_groups, item_group_members, intents, events, executions, notes) and 8 functions (executions_last_completed, recalc_last_completed_group, status_activate_on_execution, status_activate_on_event, status_guard, events_group_freeze, executions_group_tag, item_group_members_last_completed).
  - Migration `148_restructure_p5_groups.sql` (pending file deleted) and `supabase/tests/restructure_p5-h7m/step7_verify.sql`.
  - Choices beyond the prompt list:
    - `executions_has_subject` check: an execution has an intention, a group, or item_ids.
    - `executions_group_tag` copies the intention's group_id onto an execution.
    - Member changes recompute a group's last_completed_at (`item_group_members_last_completed`).
    - Groups move someday → active on their own event only; member events do not move them.
    - The three new tables join `supabase_realtime` (needed in step 8).
    - Icon names: UtensilsCrossed, SquareKanban, ListOrdered; Boxes is the fallback.
  - Not syntax-checked against a database (no local Postgres): Alex's run is the first.
- 2026-10-21 Step 7 done.
  - Alex ran 148 whole with no errors. `step7_verify.sql` passed every check: conformant true, failures []; seeds and defaults; nullable intent_id and event_id; 8 indexes; triggers; checks; policies; 3 realtime tables; 7 functions. The five additions were accepted.
  - Checked: `last_completed_guard` lets the group recalc through, because it runs at trigger depth 2, as for items.
  - Checked: the two "is_item" hits (`sam_create_practice_plan`, `wb_planned_start_from_history`) are "this item" in comments, matched by LIKE's `_` wildcard. Neither touches intents, so nothing to fix.
  - db: claims are released by Checkpoint.
- 2026-10-21 Step 8 built; awaiting Alex's Chrome check.
  - No db: claims are held (checked).
  - Yielded `src/inbox/useInboxActions.js` and `src/records/recordRoutes.js` to inbox_rowcap-x7k (unchanged). Step 12 must re-claim recordRoutes.js.
  - Kept, because this step changed them: `useAlfredData.js`, `useRealtime.js`, `Alfred.jsx`.
  - `useAlfredData`: `groupTypes`, `itemGroups` and `groupMembers` are loaded in loadData and refreshData (`groupQueries`, `setGroupData`).
  - `useRealtime`: three unfiltered channels with one upsert handler (`applyRowChange`); `Alfred.jsx` passes the three setters.
  - `storage`: `group_type`, `group` and `group_member` key prefixes; item_groups follows the items rules (status patched only; last_completed_at and status_written_at never sent). Case conversion is generic (`caseConvert.js`), so it needs no entries.
  - New `src/groups/groupModel.js`: `liveMembers` (position order; deleted and archived out), `derivedGroupName`, `groupDisplayName`, `groupsForRecord`, `groupIntention`, `groupTypeOf` and `groupIcon` (Boxes fallback), `hasRunningMember` (separately groups; active only).
  - Tests: `groupModel.test.js` (14), plus additions to `storage.test.js` and `useRealtime.test.js`. App 2779/2779, CLI 239/239.
  - `src/groups/` is not yet in `ALFRED_FOLDERS` (`testing/alfredSources.js`); add it in step 9, with the first screen.
- 2026-10-21 Step 8 verified in Chrome by Alex and checkpointed.
  - Yielded `src/alfred/useAlfredData.js`, `src/alfred/useRealtime.js` and `src/Alfred.jsx` to inbox_rowcap-x7k (all unchanged from main).
  - Given up so far:
    - to warren_buffet_p3-q5k: `src/viewPaths.js` and `src/viewPaths.test.js`
    - to inbox_rowcap-x7k: `src/inbox/useInboxActions.js`, `src/records/recordRoutes.js`, `useAlfredData.js`, `useRealtime.js` and `Alfred.jsx`
  - 73 file claims are still held; no db: claims.
  - **Step 9 waits until inbox_rowcap-x7k has checkpointed.** Then: gitsync, and re-claim `src/Alfred.jsx` and `src/viewPaths.js` (+ test), plus `useAlfredData.js`, `useRealtime.js` or `recordRoutes.js` if needed (recordRoutes by step 12 at the latest).
