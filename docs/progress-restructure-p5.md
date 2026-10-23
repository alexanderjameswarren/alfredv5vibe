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
- [x] 12. Group chips on member rows and running cards; record-links order Context > Group > Item > Intention (incl. execution page); pinned groups on Home
  - Apply bug mvjx4363b4bn4gezrys to item and intention detail pages: Archived pill, Restore as the only action, Edit hidden, edit page redirects.
- [x] 13. Scheduling a group through its intention (frozen item_ids on events); Close/Undo for groups (done 2026-10-23; closed_reason rules in migration 153)
- [x] 14. Menu execution, split in two:
  - [x] 14a. Start Now together, cooking page (per-recipe sections, sticky jump bar, recipe notes), skip a recipe, Complete all, Pause/Continue, Delete (done 2026-10-23)
  - [x] 14b. parent_execution_id (migration 154); Log Execution on a menu; Recent executions on menu and recipe pages; the finished cook's page; jump bar position; the menu's own card (built 2026-10-23; awaiting migration and Chrome test)
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
- 2026-10-23 Step 12 built; awaiting Alex's Chrome test. No db: claims held at the start.
  - `src/groups/GroupsContext.jsx`:
    - Alfred wraps the app in `GroupsProvider`, so cards and headers find a record's groups without new props (`useRecordGroups`, `useExecutionGroups`).
    - `chipsFor` covers live groups of live memberships only.
    - `GroupChips` / `RecordGroupChips` draw the chip line.
  - Chips:
    - Item rows (ItemCard) and intention rows (IntentionCard; a merged row counts its item and intentions) get their own chip line.
    - Running execution cards (ExecutionBadge, used on Home and in In progress) show the execution's own group, else its intention's.
    - EventCard's meta row gains the group and follows the new order.
  - RecordLinks:
    - New `groups` prop; the order is Context > Group > Item > Intention > execution everywhere.
    - The item, intention and execution headers pass their groups.
    - NoteSourceLinks follows the order automatically, since it goes through RecordLinks.
  - Home: Pinned Groups (GroupRowCard, the Pinned Collections grid), shown only when a pinned live group exists.
  - Bug mvjx4363b4bn4gezrys on item and intention detail:
    - The status menu becomes an Archived pill beside a read-only status, with "This item/intention is archived."
    - `restoreAction` (added to ActionBar.jsx) is the only action and un-archives in place.
    - The edit form never opens for an archived record (`startInEditMode` included). Intention reminder lines are disabled.
    - Related Intentions and member rows are unchanged: they are live records.
  - The claims guard blocked a new `src/shared/archivedRecord.jsx`. It was not claimed; `restoreAction` lives in the already-claimed ActionBar.jsx and the pill is inline. Claimed `src/schedule/EventCard.jsx` and five test files under "anything else".
  - Tests: GroupsContext (5), RecordLinks (+2), ItemDetailView (+3), IntentionDetailView (+2). App 2918/2918, CLI 239/239.
- 2026-10-23 Step 12 Chrome test passed. Follow-ups:
  1. `src/shared/archivedRecord.jsx` (claimed with Alex's OK) holds `ArchivedPill`, `ArchivedNotice` and `restoreAction`, now used by the item, intention and group pages. `restoreAction` was moved out of ActionBar.jsx, not copied.
  2. Running cards (ExecutionBadge): the group is a plain icon-and-name line like the context line, with no pill and no button. Rows keep the chip.
  3. GroupRowCard shows the Pin icon after the name when the group is pinned, as Collection and Context cards do.
  4. Not done. The context Archived section sorts by `status_changed_at || updated_at`; status_changed_at defaults to the creation time, hence Alex's report. `update_updated_at` stamps updated_at on EVERY update, so it is reliable on archive but not only on archive (later trigger writes move it). Options reported; waiting on Alex.
  - Yielded `_shared/platform.ts` and `.claude/skills/mcp-platform/SKILL.md` to mcp_read_gaps-t8k (both unchanged).
  - `_shared/alfred-tools/tool-handlers.ts` and `tool-definitions.ts` are unchanged from main, but they are held through the folder claim, so they cannot be yielded.
  - App 2920/2920, CLI 239/239.
- 2026-10-23 Step 12 follow-ups passed in Chrome. Second round (restructure_p5-h7m-s12c-k8rm):
  1. Pin: Chrome pushed the pin, a flex sibling of the clamped name, to the card's right edge. It now sits inline inside the name span, after the last word.
  2. `git diff main -- supabase/functions/_shared/alfred-tools/` is empty, and the step 5 removals (fbf3226) are in main. The folder claim was released with Alex's OK so mcp_read_gaps-t8k can work. **Step 16 re-claims `_shared/alfred-tools/tool-handlers.ts`, and anything else it needs there, just in time** (after a gitsync, since mcp_read_gaps-t8k may have changed it).
  3. Migration `152_restructure_p5_archived_at.sql` (Alex chose this over updated_at): `archived_at` on all nine tables with an archived column (contexts, events, inbox, intents, item_collections, item_groups, items, sam_snippets, sam_songs). None was held by another thread.
     - One trigger function, `public.set_archived_at()`: set on true, cleared on false, else unchanged.
     - Backfill from the audit log's latest false-to-true change, else updated_at, with user triggers paused.
     - Verify with `supabase/tests/restructure_p5-h7m/step12_archived_at_verify.sql`. Number taken right after Alex's gitsync, so no `_pending_` file was needed.
     - App: the context Archived section and every archive tab of the Recycle Bin (not Executions, which has no archived column) sort by archived_at, newest first, and show "Archived <date>". Shared helpers `archivedAt`, `byNewestArchive` and `archivedOnLabel` are in archivedRecord.jsx. updated_at stands in for a row with no archived_at.
     - The Recycle Bin selects archived_at, so the migration must run before this reaches main.
     - Not changed: the inbox's Recently Archived (src/inbox, unclaimed) still dates by triaged_at.
  - App 2921/2921, CLI 239/239.
- 2026-10-23 Step 13 built (restructure_p5-h7m-s13-b4qw); awaiting Alex's Chrome test. No db: claims held; no database change.
  - New `src/groups/useGroupActions.js`:
    - `scheduleGroup`: the first Schedule creates the own intention (named after the group then, its context, one-off, `groupId`) and an event with empty item_ids. `events_group_freeze` sets group_id and freezes the recipes; `status_activate_on_event` flips the group and recipes someday → active. The client only re-reads statuses: watchStatus now takes `groups`.
    - A later Schedule reuses the intention; a live date is moved through moveToPlanner.
    - Undo deletes the event, and the intention if this tap made it.
    - `setGroupStatus`: the own intention follows where its status allows. The live-events sheet's yes archives its dates and cancels its reminders. Undo restores all of it.
    - `archiveGroup` / `unarchiveGroup`: Archive takes the own intention and its live dates; its reminders follow by trigger. Undo brings all three back. Restore brings the newest archived own intention back, but not its dates.
  - `closeRecords` takes `group`:
    - It closes the group and its own intention, and never its members.
    - Completed records on the own intention with item_ids [] (no recipe is counted as cooked). The note goes on the group.
    - Undo restores the group's status and reason.
  - Group detail:
    - Header: an editable StatusMenu (same gate as intentions), the ScheduledLine, and the reminder line. Add reminder is disabled until the first Schedule, because a reminder needs the intention.
    - Buttons: Schedule/Reschedule, Edit, Close (new `closeAction`), Archive. A run on the own intention blocks Close and Archive.
  - Group rows (RowList, context page): a real when line, Schedule and Close. `closeTargets` and `closeBlocked` know group rows.
    - Home's pinned group cards show the when line but no buttons, as pinned collections have none.
  - The own intention is never a row: buildRows skips intents with groupId, and the Recycle Bin's Intentions tab skips them. Restoring a group there also restores its intention.
  - EventCard: a group's own date shows the group type icon and name, and tapping it opens the group. It has no intention link and no Start (step 14 adds Start Now for menus).
  - Tests: useGroupActions (7), GroupRowCard (3), GroupDetailScreen (+5), useIntentionActions (+3), useRowClose (+3), useStatusSync (+1), EventCard (+1), rowModel (+2).
  - App 2946/2946 (SamPlayer.plan flaked once and passed on rerun), CLI 239/239.
- 2026-10-23 Step 13 Chrome test passed. Follow-ups (restructure_p5-h7m-s13b-v7jx):
  1. GroupRowCard now uses the row cards' own layout: `flex-col sm:flex-row sm:items-center sm:justify-between`, with the buttons `shrink-0 self-end sm:self-auto`, as ItemCard and IntentionCard have.
  2. The bug: closed_reason was kept on reopen. Every status move outside the Close pop-up patched only `{ status }`, and status_guard never touches closed_reason. It affected items, intentions and groups, both through the status chip and the edit form, and the Undo of a move. Close's own Undo was already right.
     - New `statusPatch(status, before)` in utils/status.js: leaving Closed clears closedReason, and an Undo back to Closed restores `before`'s reason and closed date.
     - It is used by setItemStatus, setIntentionStatus and setGroupStatus (including the own intention that follows the group), and by their Undos.
     - Recommended, not written: clear closed_reason in status_guard on any move out of closed, which covers MCP and any future path. The app fix stays either way.
     - Claimed `src/utils/status.js` and its test.
  - App 2951/2951, CLI 239/239.
- 2026-10-23 Step 13 follow-ups passed in Chrome; production had no reason on a non-closed row. Database rules (restructure_p5-h7m-s13c-r9td), migration `153_restructure_p5_closed_reason_rules.sql`, numbered right after Alex's gitsync (which brought only the snapshot; no drift):
  - Rule 1 is in `status_guard`: once the final status is decided (after the someday revert), a move out of closed sets closed_reason null. Every other behaviour is unchanged, including the 10-minute Undo-of-close exception. It is inside the function, not a second trigger, so it never depends on trigger firing order.
  - Rule 2 is `<table>_closed_reason_only_closed` CHECK (closed_reason is null or status = 'closed') on items, intents and item_groups. The column and function comments are updated.
  - App paths write a reason only together with status closed: closeFields, and `statusPatch` for an Undo back to Closed. `storage.set` strips closed_reason on update.
  - Verify with `supabase/tests/restructure_p5-h7m/step13_closed_reason_rules_verify.sql`. db: claims held: items, intents, item_groups and fn status_guard, until Checkpoint.
  - Test: statusPatch never writes a reason without Closed. App 2952/2952 (SamPlayer.plan flaked once and passed on rerun), CLI 239/239.
- 2026-10-23 Step 14a built (restructure_p5-h7m-s14-p8wa); 14b is left for the next pass. No db: claims held, no database change. Claimed `src/executions/`, `src/notes/` and `IntentionsScreen.jsx` (no change needed there in the end).
  - The shape of a menu run:
    - One execution on the menu's own intention: group_id set, item_ids [].
    - One per live item member: group_id, item_ids [recipe], intent_id and event_id null.
    - Intention members are not executed. Pure helpers are in `src/groups/menuRun.js`.
  - `startMenuNow` (useExecutionActions):
    - It goes through the own intention, made if needed with createdAt = startedAt, and its live event, as intention Start Now does: an open run is continued, a future date moves to today (priorEventDate), and no date makes today's.
    - Recipes' own intentions and events are never touched.
    - If a recipe run fails to save, the runs already made are deleted.
  - Complete, Delete, Pause and Continue act on the whole menu:
    - Complete closes every recipe at the menu's exact closed_at, as done or skipped. The menu's own intention is NOT auto-closed as a one-off is, because the menu is cooked again.
    - Delete removes the recipe runs, then restoreStartNow, and also the own intention when Start Now made it.
    - Skip saves outcome 'skipped' on the open recipe run, and Unskip sets it back to null.
    - Step ticks and Start/Reset take a `target` run.
  - Hidden everywhere: Alfred derives `shownRuns(...)` for every running list (Home Active/Paused, every In progress section, item rows, allLiveExecutions). The raw lists still hold recipe runs for the hooks and the cooking page. An open recipe run opened by URL or note link shows "Open the menu" instead of itself.
  - Cooking page:
    - ExecutionDetailView takes `menu`. The step list moved unchanged into `ExecutionElements.jsx`. `MenuRecipeSections.jsx` adds a sticky, sideways-scrolling jump bar and collapsible sections, each with its steps, Skip/Unskip and its own note.
    - The menu's note is on the group (target 'group'); a recipe's is on the item with that run's execution_id. useExecutionNotes takes `target`.
    - The header is named after the menu; the hidden intention is never linked.
  - Completed menu: Delete and Change date carry the recipe runs, found by group_id + intent_id null + the same closed_at (`menuHistory.js`). There is no parent column. That match is the one join, and a `parent_execution_id` column would be the sturdier option for 14b's history if wanted.
  - Start Now (teal, first) is on the menu page and on menu rows; Continue opens the open run. It is not offered on separately groups or on the date cards.
  - Tests: menuRun (5), useExecutionActions.menu (8), MenuRecipeSections (5), ExecutionDetailScreen (3), GroupDetailScreen (+3), GroupRowCard (+1). App 2977/2977, CLI 239/239.
- 2026-10-23 Step 14a passed in Chrome (notes on a skipped recipe stay allowed, as Alex likes). Step 14b built (restructure_p5-h7m-s14b-g6ln) after Alex's gitsync. The sync brought 153_wb, which does not touch executions, so there is no drift. **Main now has two migrations numbered 153** (`153_restructure_p5_closed_reason_rules` and `153_wb_phase3_step9e_overview_cash_flow`); this was reported to Alex.
  1. Migration `154_restructure_p5_parent_execution.sql`:
     - It adds executions.parent_execution_id (text, references executions(id) on delete cascade), a partial index, and a check that only a run with no intention has a parent (never itself).
     - The backfill uses the 14a rule.
     - Verify with `supabase/tests/restructure_p5-h7m/step14b_parent_execution_verify.sql`. db:table:executions is held until Checkpoint.
     - Every lookup now uses the parent: recipeRunsOf, Complete, Pause/Continue, and the cooking page (`useCookRecipes`). Deleting a finished cook is one delete (the cascade takes the recipes); Change date moves the recipes by parent. The closed_at match is gone.
     - **The front end needs 154 live**, because Start Now writes parent_execution_id.
  2. Log Execution on a menu (`logMenuDone`, `LogMenuDialog`): the Phase 4 pop-up (CompleteNoteDialog gained `children`) with every recipe ticked; unticked ones are recorded as skipped.
     - It records on the live date (archived), else on a new archived date that day. The note goes on the menu.
     - Undo is one delete plus the date (and the intention, if it made one).
     - It is hidden while the menu is cooking.
  3. Recent executions (`withCookInfo` in RecentCompletions):
     - The menu page shows each cook's "N done · N skipped".
     - A recipe page's done rows from inside a menu read "· in <menu>" and open the menu's cook. Recipe skips inside a menu are not listed there (skips list by intention).
  4. A finished cook's page reads its recipe runs by parent and shows them read-only, each marked Done or Skipped, with their notes.
  5. The jump bar sticks at the measured bottom of whatever is pinned at top 0 (`pinnedTopHeight`, i.e. AppChrome's header), re-measured on resize, and sits below the header (z-[5] vs z-10). A jump scrolls so the section's header lands right under the bar (`jumpTarget`). AppChrome is not edited.
  6. ExecutionBadge: a group's own run is titled with the group's current name and has no group line. Member runs keep the line.
  - Tests: menuRun (+1), useExecutionActions.menu (+2, fixtures moved to parents), MenuRecipeSections (+1), ExecutionDetailScreen (+1), RecentCompletions.menu (3), LogMenuDialog (1), GroupDetailScreen (+2), ExecutionBadge (+1). App 3011/3011, CLI 239/239.
