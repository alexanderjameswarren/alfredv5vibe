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
- [x] 9. Group create/edit page (done 2026-10-22, with removal history) (search-and-add, drag reorder, type picker, pin, archive)
- [x] 10. Group detail page (header, buttons, members, notes, recent executions)
- [x] 11. Context page: create button, browse tabs, group rows, sort
- [ ] 12. Group chips on member rows and running cards; record-links order Context > Group > Item > Intention (incl. execution page); pinned groups on Home
  - Apply bug mvjx4363b4bn4gezrys to item and intention detail pages: Archived pill, Restore as the only action, Edit hidden, edit page redirects.
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
- 2026-10-22 Step 9 is blocked before any code.
  - inbox_rowcap-x7k is merged and synced here. Drift: the sync brought only inbox loading changes (Alfred.jsx inbox routing, useAlfredData paging, inbox screens, inboxQueries) and the snapshot. The group loading is intact, so the spec needs no changes.
  - `src/viewPaths.js` and `src/viewPaths.test.js` are held by warren_buffet_p3-q5k (since 2026-10-21). Nothing was claimed or written; waiting on Alex.
- 2026-10-22 Step 9 built; awaiting Alex's Chrome and phone test.
  - After warren_buffet_p3-q5k checkpointed: drift is Money plan paths only. Re-claimed `Alfred.jsx` and `viewPaths.js` (+ test); new `shared/useDragReorder.js` (+ test).
  - Routes: `/groups/new/context/:contextId` and `/groups/edit/:groupId` (`groupNewPath`, `groupEditPath`, `groupRouteFromPath`). The bare forms, a stale id or a missing context go to /contexts.
  - Save returns with Back when opened in the app (`state.fromApp`); a cold load goes to the group's context.
  - `src/groups/GroupEditScreen.jsx`:
    - EditCard, then collection-style member rows, then ContextForm's Save/Cancel footer and red-outline Archive with a confirm (edit only).
    - Fields: name (placeholder = derived name), type (default = context's default), context, description, pin.
    - Members whose record is gone or archived are hidden but kept.
  - `MemberPicker.jsx`: items and intentions; this context by default, "Search all contexts" to widen; added members and groups' own intentions are left out.
  - `GroupEditRoute.jsx`: save, archive with Undo, leave.
  - `groupSave.js`: create is all-or-nothing (the group is deleted if a member write fails; members cascade); edit is a diff (delete, insert, move changed positions); a blank name is stored as null.
  - `useDragReorder` is the collection page's drag, extracted. The collection page itself is unchanged (its drag state also pauses the collection poll).
  - `ObjectIcon.jsx`: `GroupTypeIcon` (UtensilsCrossed, SquareKanban, ListOrdered, Boxes fallback).
  - Tests: groupSave (7), GroupEditScreen (4), useDragReorder (2), viewPaths (+3). App 2808/2808, CLI 239/239.
  - Not done: `groups` was not added to `ALFRED_FOLDERS`. It changes the EditCard guard's counts in `src/shared/EditCard.test.jsx`, which is not in the plan.
- 2026-10-22 Step 9 tested by Alex in Chrome (create, desktop drag, remove, derived name, project, archive with Undo). Follow-ups built:
  - The members button shows "+ Add Members" when closed and "Done adding" (no plus) when open.
  - The archive pop-up has the Close pop-up's shape: portal, red-outline Archive with the shared `CancelButton` beside it.
  - Member removal history, migration `149_restructure_p5_group_member_removal.sql` (written, not applied):
    - Collections keep a separate append-only `collection_item_removals` table and delete the member. Their Put back re-adds it at the end, and the unique `(collection_id, item_id)` never sees two rows.
    - Groups instead mark the member: `removed_at` and `removed_by`, stamped by a trigger. The unique rule now covers live rows only (`item_group_members_live_unique`), so a removed member can be added again.
    - `recalc_last_completed_group`, `executions_last_completed`, `status_activate_on_execution` and `events_group_freeze` skip removed rows; `item_group_members_last_completed` recalculates when `removed_at` changes.
  - Client:
    - `groupModel` leaves removed members out and adds `removedMembers`.
    - Save marks members removed; `restoreMember` puts one back at the end (refused if it is live again).
    - New `/groups/history/:groupId` (`GroupHistoryScreen`) with Put back; "View removal history" on the edit page once something is removed.
  - `groups` added to `ALFRED_FOLDERS`; `EditCard.test.jsx` claimed, counts 3→4 (Alfred's EditCard call sites), 4→5 (all call sites) and 5→6 (PinnedFooter).
  - Claimed: `db:table:item_group_members`; `db:fn:` recalc_last_completed_group, events_group_freeze, item_group_members_last_completed, executions_last_completed, status_activate_on_execution, item_group_members_stamp_removal.
  - App 2816/2816, CLI 239/239. The front end needs 149 applied before removal works.
- 2026-10-22 Step 9 done.
  - 149 applied and verified by Alex, then checkpointed with its verify script (db: claims released). All the follow-up Chrome tests passed.
  - Bug fixed: Put back cleared `removed_at` on the removed row, which erased the history. `restoreMember` now inserts a new live row at the end and leaves the removed row as it is, the same as re-adding from the search. `GroupHistoryScreen.test.jsx` is new.
  - Yielded `supabase/functions/mcp/index.ts` to warren_buffet_p3-q5k (unchanged from main). Step 16 must re-claim it.
  - App 2818/2818, CLI 239/239.
- 2026-10-22 Step 10 built; awaiting Alex's Chrome test.
  - Re-claimed `src/records/recordRoutes.js` (+ test).
  - Routes:
    - `/groups/detail/:groupId` (`groupDetailPath`).
    - The bare `/groups/detail` shows `selectedGroupId` (Alfred state, set when a group is shown), so Back from a member's item or intention page returns to the group, as the bare intention path does.
    - A record id opens the group: `item_groups` and `item_group_members` in RECORD_SCREENS. `resolve_record` already finds item_groups, because it reads the registry, so no database change was needed.
  - `src/groups/GroupDetailScreen.jsx`:
    - Header: type icon, title (typed, else derived, else "Untitled menu"), CopyButton (`recordCopyText`), display-only StatusPill, and the context RecordLink.
    - ActionBar with Edit, then Archive (red outline, confirm, Undo).
    - Description; members as standard `RowList` rows in position order, with removed members hidden; Recently removed (latest per member that is not back, Put back) and View removal history; Notes (target 'group'); Recent executions (the group's own intention through `RecentCompletions`, else "None yet").
  - `ArchiveGroupDialog.jsx` is now shared by the edit and detail pages.
  - The edit page opened from the detail page returns to it (Save, Cancel, Back). Archiving from the edit page goes to the context; archiving from the detail page goes back where it came from.
  - `groupDetail.js` holds `groupTitle`, `memberRows` and `recentRemovals`.
  - Notes: `notesApi.listNotesForTargets` and `useRecordNotes` take `groupIds`.
  - Tests: groupDetail (3), GroupDetailScreen (4), recordRoutes (+4 cases), viewPaths (+). App 2829/2829, CLI 239/239.
- 2026-10-23 Step 10 done. Alex's Chrome test passed; two gaps fixed.
  - Archived state:
    - Item and intention detail pages show no archived banner or chip. Their only marker is the Notes notice ("This is archived, so notes cannot be added…"), which the group page already showed.
    - The group page now adds an "Archived" pill beside the status and a line "This menu is archived. Restore it from the Recycle Bin" (the link opens the bin on its Groups tab).
    - It hides Archive (on the edit page too) and Put back. Edit stays, as on items.
  - Recycle bin (claimed `src/recycle/`):
    - How it works today: one tab per type. `loadRecycleBin` pages archived rows; Restore sets archived false (an execution goes back to paused) and calls `refreshData`; permanent delete is a hard delete behind a `window.confirm` (`permanentDeleteWarning`), with special cascade wording for collections.
    - Groups follow the same pattern: a new Groups tab (Boxes icon), rows with the type icon and derived name ("Project · Alfred"), restore, and delete.
    - Delete wording: member list, removal history and notes go; the items and intentions stay.
    - Restoring flips only `archived`, so members come back as they were.
    - New `RecycleScreen.test.jsx`; GroupDetailScreen +2 tests.
  - App 2832/2832, CLI 239/239.
- 2026-10-23 Step 10 follow-up, bug mvjx4363b4bn4gezrys: archived records are not editable.
  - An archived group's page keeps the Archived pill and "This … is archived." Its only action is a Restore button (secondary, ArchiveRestore icon), which un-archives in place. Edit, Archive and Put back are hidden; member rows are unchanged.
  - `/groups/edit/:id` for an archived group redirects to its detail page. The history page shows no Put back while the group is archived.
  - The Recycle Bin Groups tab is unchanged. The link from the page to the bin is gone (replaced by Restore).
  - App 2833/2833, CLI 239/239.
- 2026-10-23 Step 11 built; awaiting Alex's Chrome test. The spec's "Context page" section was rewritten to the decisions settled with Alex today.
  - Claimed: `listSortOptions.js`, `useListPreferences.js`, `useContextActions.js`, `ContextForm.test.jsx` and `shared/UnderlineTabs.test.jsx` (its guard counts call sites, 3→4).
  - `rowModel`:
    - `buildGroupRows`: a group's tags and search names come from its live members; it also carries memberCount and lastCompletedAt.
    - `ROW_ACCESSORS.done` (Last done); item and intention rows now carry lastCompletedAt.
    - `rowSearchFields` covers groups.
    - `rowTabs` / `rowsForTab`: All, one tab per type, then Items, with counts; none when there are no groups.
  - Context page:
    - Groups sit in the items-and-intentions list, with the heading "Items, intentions and menus".
    - Tabs appear only when there is a live group; their counts follow the filters.
    - Status chips count groups.
    - Sort is mixed, under `CONTEXT_DETAIL_SORT_OPTIONS` (Name, Created, Last modified, Last done); the default is still Last modified.
    - The "Create <Type>" or "Add Group" button opens `/groups/new/context/:id`.
    - Archived groups are listed in the Archived section.
  - `GroupRowCard`: type icon and name, status chip and context, "Not scheduled", then "N recipes · last cooked" (together types) or "N members · last done". No buttons. Opens the detail page.
  - ContextForm has a "Default group type" picker (this context's types, plus None). `saveContextRecord` takes `defaultGroupTypeId`; leaving it undefined keeps the stored value.
  - App 2843/2843, CLI 239/239.
- 2026-10-23 Step 11 follow-ups. Alex's Chrome test of the first build passed.
  1. Group rows end like item rows: "2 recipes · last done: Oct 21, 2026 · last updated: Oct 23, 2026"; empty dates are left out; other types say "N members".
  2. The tab "Items" is now "Items and intentions".
  3. Last done: `sortByLastDone` treats never done as the oldest (bottom when newest first, top when oldest first).
  4. On the same local day, a group comes before items, then by name.
  5. The selected tab is remembered per context in Alfred (`contextRowTabs`), so Back keeps it.
  6. Group types are shared, migration `150_restructure_p5_shared_group_types.sql` (written, not applied):
     - `group_types.context_id` is dropped. It was only read by the old policy, and an unused column would invite filtering by it.
     - Read for every signed-in user; insert, update and delete for the owner only.
     - `contexts.default_group_type_id` is kept.
     - Client: type names stand alone (`sortTypes`); defaults are the context's default, else the first by name; the picker lists every type.
     - The client works before and after 150.
  7. Settings has a "Group types" section (`GroupTypesSettings`, `groupTypes.js`):
     - The list shows the icon, names, mode and usage count.
     - Add and Edit use the EditCard form: names, an icon from 10, and the mode in plain words.
     - Delete appears only when no group uses the type, behind a confirm with CancelButton.
  - Claimed: `src/reminders/SettingsScreen.jsx` (+ test), the 150 migration, and `db:table:group_types`. EditCard guard counts are now 5/6/7.
  - App 2906/2906, CLI 239/239. One SAM test (`SamPlayer.plan`) failed once under load, then passed alone and on a full rerun.
