# Progress: alfred_split-v8n

## Status: In Progress

Splitting src/Alfred.jsx into feature folders. Spec:
docs/technical-spec-alfred_split.md.

### Steps
- [x] Step 0: plan (read-only), docs, claims
- [x] Step 1: test helper + guards repointed; pure helpers into src/utils
  (Alfred.jsx 12,052 → 11,575 lines; app 2030/2030, CLI 142/142, same as before)
- [x] Step 2: new shared pieces into src/shared
  (Alfred.jsx 11,575 → 10,749 lines; app 2030/2030, CLI 142/142, same as before)
- [x] Step 3: existing flat shared UI into src/shared
  (24 files moved; Alfred.jsx unchanged at 10,749 lines apart from import paths;
  app 2030/2030, CLI 142/142, same as before)
- [x] Step 4: recycle bin
  (Alfred.jsx 10,749 → 10,195 lines; app 2030/2030, CLI 142/142, same as before)
- [x] Step 5: contexts — ContextForm, ContextCard, ContextsScreen,
  useContextActions (ContextDetailView moves in step 8)
  (Alfred.jsx 10,195 → 9,750 lines; app 2030/2030, CLI 142/142, same as before)

Reordered into dependency layers after step 5 (Alex, 2026-10-05); see the spec.
- [x] Step 6: layer (a) leaf cards — EventCard + EventMetaLink, ExecutionBadge,
  ItemNameLabel, CollectionCard
  (Alfred.jsx 9,750 → 9,117 lines; app 2030/2030, CLI 142/142, same as before)
- [x] Step 7: layer (b) IntentionCard and ItemCard, with their twins
  (Alfred.jsx 9,117 → 7,904 lines; app 2030/2030, CLI 142/142, same as before)
- [x] Step 8: layer (c) detail views — Context, Intention, Item, Execution
  (Alfred.jsx 7,904 → 6,346 lines; app 2030/2030, CLI 142/142, same as before)
- [ ] Step 9: layer (d) per-feature screens and actions
  - [x] 9a home/schedule (Alfred.jsx 6,346 → 6,108 lines; app 2030/2030,
    CLI 142/142, same as before)
  - [x] 9b–9d, one step (agreed after 9a): intentions, then items, then
    executions, with a build and app tests after each part (Alfred.jsx
    6,108 → 5,250 lines; app 2030/2030 after each part, CLI 142/142)
  - [x] 9e inbox (Alfred.jsx 5,250 → 4,681 lines; app 2030/2030, CLI
    142/142, same as before)
  - [x] 9f collections, in three parts with a build and app tests after each
    (Alfred.jsx 4,681 → 4,126 → 3,494 → 2,788 lines; app 2030/2030 after
    each part, CLI 142/142)
- [x] Step 10: layer (e) the shell, including 9g (reminders/settings), in six
  parts with a build and app tests after each (Alfred.jsx 2,788 → 2,675 →
  2,617 → 2,364 → 1,920 → 1,606 lines; app 2030/2030 after each part, CLI
  142/142). As built: see the spec's "As built" section.
- [ ] Finish: Alex runs gitpush Finish. **Ready to finish** once step 10 is
  verified and committed.

### Notes
- Standing permission (Alex, step 9e, 2026-10-05): if a file outside this
  thread's claims needs ONLY an import path changed because of a move, and
  `claims.mjs check` says it is free, claim it and change that path without
  stopping, and list it in the report. Anything beyond an import path, or a
  file someone else holds, still means stop and ask.
- Suspected bug — tested on desktop, not reproduced (Alex, step 7 check):
  ItemCard handleCancel resets elements with `{ ...el }` instead of the
  normaliser used by the useState init and the dirty twin. The worry was that
  after Cancel, re-entering edit would report unsaved changes with nothing
  typed. On desktop, Cancel → Edit → leave with nothing typed gave no prompt.
  The code is unchanged (pure move).
- Testing is a desktop click-through in the local dev server.
- Step 1: the plan said 9 guard tests; it is 8 files (two of them hold the two
  readdirSync guards). `alfredSource()` = Alfred.jsx + every file under the
  feature folders, minus the pre-existing flat files listed in NOT_FROM_ALFRED,
  so a guard sees exactly what it saw in Alfred.jsx. A new file in a feature
  folder that did not come from Alfred.jsx must be added to that list.
- Inbox step: RecentlyArchived.test slices between `{/* Inbox View */}` and
  `{/* Inbox Detail View` — keep both markers adjacent in one file, or update
  the slice.
- Step 1 also moved the `./utils/caseConvert` import out of Alfred.jsx: only
  `storage` used it.
- Step 2: src/shared/ObjectIcon.jsx (OBJECT_ICONS + ObjectIcon), LoginScreen,
  LoadingOverlay, DetailMeta, AddPageChrome, and src/shared/recurrence/
  (CustomRecurrenceDialog, IntervalRecurrenceDialog, SchedulePopover,
  RecurrenceQuickSelect). NAV_ITEMS stays in Alfred.jsx until AppChrome
  (step 12). Ten lucide imports used only by OBJECT_ICONS moved with it.
- Verbatim check: each moved file's body, minus imports and `export`, is
  compared as a substring of the previous Alfred.jsx (piped from `git show`).
  Steps 1 and 2 all pass.
- Guard finding (step 2): a read-only check that wrote scratch files to
  `$S/...` (the session scratchpad, outside the repo) was blocked as an
  unclaimed repo write because `$S` was set in the same command after a `cd`.
  Not routed around; the check was redone with stdin and no files written.
- Step 3: AppLink, PinnedFooter, EditCard, InsertRowButton, ItemPicker,
  TagPicker, TagFilter, ListToolbar, SearchInput, SortControl, UnderlineTabs,
  UndoMessage, RemovalMeta, RepeatBlockDialog and their 10 tests moved to
  src/shared/. Byte-identical to HEAD except `./utils/`, `./viewPaths`,
  `./testing/` → `../…`, and PinnedFooter.test's index.css path gaining `".."`.
  Importers updated: Alfred.jsx, InboxDetailView.jsx,
  NotificationChainInline.jsx, sam/components/BrowseTabs.jsx and
  sam/components/WarmupLadderEditor.jsx (the two sam/ files claimed with
  Alex's confirmation, import paths only). Both readdirSync guards confirmed
  to list all 23 shared/ screen files, including shared/recurrence/.
- Step 4: src/recycle/useRecycleBin.js (the five recycle states, the page
  size, both message helpers, loader, single and bulk restore/delete, select
  handlers, and the load-on-view effect, verbatim) and src/recycle/RecycleScreen.jsx
  (the JSX, verbatim but 6 spaces less indented). Alfred calls
  `useRecycleBin({ view, refreshData, contextArchiveBlockers })` where the
  state used to be declared, and renders
  `<RecycleScreen contexts intents {...recycleBin} />`. Both functions it
  passes are hoisted declarations, so they exist at that point. `Scissors` and
  `OBJECT_ICONS` left Alfred's imports with the tabs.
- Step 4, for step 12: the lucide import comment in Alfred.jsx ("the last two
  tab glyphs … `Scissors` is a SAM snippet") now describes an import that
  lives in RecycleScreen. It was left as is because it is a pure move.
- Step 4: one CLI baseline run reported 143 tests / 2 failing before any
  change was made; eight reruns all gave 142/142 and the failure could not be
  reproduced or named. Recorded as a flake in scripts/lib, not this project.
- Step 5: src/contexts/ContextForm.jsx and ContextCard.jsx (verbatim),
  ContextsScreen.jsx (the Contexts view JSX, verbatim, re-indented 6), and
  useContextActions.js (saveContextRecord, saveContext, the two add-to-context
  writers, contextChildCounts, contextArchiveBlockers, archiveContext, in three
  verbatim blocks). It holds no state. Alfred calls it just before
  useRecycleBin, which takes `contextArchiveBlockers` from it, and after `user`
  and every state it reads. Twin rule: ContextForm's useState defaults and their
  dirty-check effect sit together in ContextForm.jsx, both verbatim.
- Step 5, ContextDetailView NOT moved: it renders ItemCard, IntentionCard and
  CollectionCard, which are still inside Alfred.jsx (steps 8, 7 and 11). Moving
  it now would mean importing back from Alfred.jsx (a circular import) or
  passing components in as props (a change of shape, not a move). The same
  shape blocks other detail views. From the code: ContextDetailView →
  ContextForm, ItemCard, IntentionCard, CollectionCard; IntentionDetailView →
  IntentionCard, ItemCard, EventCard; ItemDetailView → ItemCard,
  ExecutionBadge, IntentionCard; ItemCard → ExecutionBadge; IntentionCard →
  EventCard; EventCard → EventMetaLink. Proposed reorder for Alex: leaf cards
  first (EventCard+EventMetaLink, ExecutionBadge, ItemNameLabel,
  CollectionCard), then IntentionCard and ItemCard with their twins, then the
  four detail views, then the per-feature screens and actions, then the shell.
- CLI flake, identified: running `node --test "scripts/lib/*.test.mjs"` in the
  background while other tool calls run makes the session's claims-guard hook
  append to the real guard log mid-run. claims-folders.test.mjs:77 ("the real
  guard log was written to") and hooks.test.mjs:354 ("a full test run leaves
  the real log and the real binding untouched") then fail, and the file-level
  failure shows as a 143rd test. Not a code fault. Run the CLI suite in the
  foreground with nothing alongside.
- Step 6: src/schedule/EventCard.jsx and EventMetaLink.jsx,
  src/executions/ExecutionBadge.jsx, src/items/ItemNameLabel.jsx,
  src/collections/CollectionCard.jsx — all verbatim. EventCard's inline isDirty
  check moved with it, verbatim. `Share2` and `Pin` left Alfred's lucide imports
  with CollectionCard, their last user there. The orphan comment "// Helper functions for
  the inbox screens" stays in Alfred above CLEARED_ENRICHMENT.
- Step 7: src/items/ItemCard.jsx and src/intentions/IntentionCard.jsx.
  Twins sit together. ItemCard: element normaliser in useState lines 38–52,
  dirty twin `originalElements` 69–81, simplified copy in handleCancel 125–131
  (the `{ ...el }` copy, suspected Cancel bug, not reproduced; kept as is). IntentionCard: field defaults
  45–56, dirty-check effect 76–87, reset in handleCancel 120–129.
  IntentionCard is verbatim (517 lines). ItemCard is verbatim except two lines
  (file lines 451 and 456): whitespace-only lines inside the JSX comment
  "Inline flow, deliberately NOT a nested flex row…" that held 24 spaces in
  Alfred.jsx and are empty here. The Edit and Write tools strip trailing
  whitespace, so they cannot be written; they have no effect. Alex chose to
  leave them empty rather than restore them with a script.
  The same stripping meant ItemCard could not be cut out of Alfred.jsx with
  Edit (its old text must match those lines). With Alex's OK, a one-off
  `node -e` deleted Alfred.jsx lines 7907–9117 (the blank line, ItemCard,
  IntentionCard to end of file) after checking that the file was 9,117 lines,
  line 7908 started "function ItemCard(" and line 8601 started
  "function IntentionCard(". git diff showed 1,211 deletions and nothing else.
  Imports used only by the two cards left Alfred.jsx: EditCard,
  InsertRowButton, RepeatBlockDialog, PickedItem, offsetPatch, isFirstStep,
  detailsForStorage.
- Step 8: src/contexts/ContextDetailView.jsx (325 lines),
  src/intentions/IntentionDetailView.jsx (276), src/items/ItemDetailView.jsx
  (516), src/executions/ExecutionDetailView.jsx (424) — all verbatim. No
  whitespace-only lines were involved, so Edit cut them; no script was needed.
  Nothing they use remains inside Alfred.jsx. Fifteen imports left Alfred.jsx
  with them (OriginalCapture, the four NotificationChainInline exports, Play,
  Check, Copy, ChevronDown, Timer, Pencil, getRecurrenceDisplayString,
  DetailMeta, SchedulePopover, ContextForm). The 7 pre-existing unused-prop
  warnings moved into the three views. Alfred.jsx itself now lints clean.
- Step 9a: src/schedule/useEventActions.js (updateEvent; triggerRecurrence
  with its comment, two verbatim blocks; no state), HomeScreen.jsx and
  ScheduleScreen.jsx (view JSX, verbatim, re-indented 6). Alfred calls
  useEventActions after useContextActions; closeExecution, still in Alfred
  until 9d, takes triggerRecurrence from it. `activate` stays for 9d, and the
  derived event lists stay in Alfred (intentions use validEvents too). Imports
  that left Alfred: Pause, Activity, Sun (with the lucide comment that described
  Sun and Scissors, both now gone), calculateNextEventDate, toLocalDateString,
  ContextCard, EventCard, ExecutionBadge. The step-4 note about that comment is
  resolved.
- Remaining steps, sized after 9a: 9b (intentions: moveToPlanner,
  updateIntent, archiveIntention, Intentions and add screens) and 9c (items:
  updateItem, deepCloneItem, Memories and add screens) are each about 250
  lines and could be done as one step. 9d (executions, about 520 lines,
  notification chains), 9e (inbox, about 600 lines plus 7 existing files and
  a guard slice) and 9f (collections, about 1,800 lines) should stay on their
  own. 9g (settings JSX plus the reminder and push effects, about 120 lines)
  could fold into step 10.
- Step 9b–9d. Intentions: src/intentions/useIntentionActions.js
  (moveToPlanner, updateIntent, archiveIntention, verbatim, 122 lines),
  IntentionsScreen.jsx and IntentionAddScreen.jsx (JSX verbatim, re-indented
  6). Items: src/items/useItemActions.js (updateItem, deepCloneItem, verbatim,
  102 lines), MemoriesScreen.jsx and ItemAddScreen.jsx (verbatim,
  re-indented 6). Executions: src/executions/useExecutionActions.js — block A
  (activate, the five notification-chain functions with their comment,
  closeExecution, cancelExecutionForEvent, pause, make active, element toggle
  and update, notes, toggleCollectionItem; 380 lines) and block B
  (startNowFromItem, startNowFromIntention; 170 lines), both verbatim. Twin
  rule: the three string-to-element mappers (activate, startNowFromItem,
  startNowFromIntention) are all in that file, verbatim and not merged.
  toggleCollectionItem moved with the execution writers because it only writes
  the active execution. closeExecution still calls
  clearCompletedFromCollection, which stays in Alfred until 9f; it is a hoisted
  declaration passed in as an argument. openExecution and editItemFromExecution
  are navigation and stay for step 10. ExecutionDetailScreen.jsx holds the two
  execution-route branches. The `view === "execution-detail"` test stays in
  Alfred around it, so those two condition lines lost that prefix; nothing else
  changed (39 lines compared). All four hooks are called in order after
  useEventActions, after every state they read. Alfred.jsx lints clean.
- Step 9e. Moved into src/inbox with their tests, identical apart from import
  paths: InboxDetailView, InboxListCard, RecentlyArchived, OriginalCapture,
  ClipboardCapture, CaptureMeta, PendingReminder, and
  oneTapMatchesDetailPage.test. New: useInboxActions.js (handleCapture,
  discardInboxItem, restoreDiscardedReminders, updateInboxCaptureText,
  processInboxItemFromList, copyTaskInboxItem, handleInboxSave,
  unarchiveInboxItem, verbatim, plus CLEARED_ENRICHMENT with its comment at the
  end); addItemsToCollection (collections) and refreshReminderIndex
  (reminders) come in as arguments. InboxScreen.jsx and InboxDetailScreen.jsx
  hold the two branches (JSX verbatim, re-indented 6). The `view ===` tests
  and the "Inbox View" / "Inbox Detail View" comments stay in Alfred. Only
  guard edit: RecentlyArchived.test now reads InboxScreen.jsx instead of
  slicing Alfred between those two comments. Import-path-only edits:
  intentions/IntentionDetailView.jsx, items/ItemDetailView.jsx,
  utils/inboxSourceTabs.js and its test. Stale but left alone (pure move): the
  comment in InboxDetailScreen saying RecurrenceQuickSelect "lives in this
  file", and InboxDetailView's header saying "Alfred.jsx is 12,900 lines".
- Step 9f. Part 1: CollectionAddItems.jsx and ItemAddToCollection.jsx,
  verbatim plus `export default`; ItemAddToCollection's local `typeOf` moved
  as is, not merged into utils/blockRepeat.js. Part 2: useCollections.js
  holds loadCollectionMembers through refreshCollection (one block, with the
  tag-editor open/close helpers) and the collection CRUD block (addCollection,
  updateCollection, archiveCollection), both verbatim. It owns no state or
  refs: memberWriteInFlight comes in as an argument. pollPausedRef is NOT an
  argument because no moved function touches it; its only writer is the
  pause effect and its only reader the poll, both still in Alfred for step 10.
  useCollections is called before useExecutionActions and useInboxActions,
  which take clearCompletedFromCollection and addItemsToCollection from it;
  reportMembershipError and openTagEditor stay internal. Part 3: five screens,
  not four — "the add-to-collection screen" was two view branches, so
  ItemAddToCollectionScreen (item-add-to-collection) and
  CollectionAddItemsScreen (collection-add-items) are separate files beside
  CollectionsScreen, CollectionDetailScreen and CollectionHistoryScreen. The
  three IIFE branches became component bodies (re-indented 8, compared whole);
  CollectionsScreen is JSX re-indented 6. The `view ===` tests and the view
  comments stay in Alfred. No guard needed editing.
- Step 10. Moved word for word: reminders/ (SettingsScreen, useReminderIndex
  + useReminderListRefresh, useNotificationEffects), alfred/
  (useListPreferences, useAlfredNavigation + useDetailNavigation,
  useAlfredData + useCollectionPoll, useRealtime), shared/ (AppChrome with
  NAV_ITEMS and navCount, BottomDock). Effect order checked against HEAD and
  unchanged. Wiring that is new, not moved: `filterTag` declared above the
  navigation hook; the deferred `loadCollectionMembers` call into
  useAlfredData; three eslint-disable comments for stable values now crossing
  a hook boundary (the build reported them as warnings otherwise). `menuOpen`
  stays Alfred state so it survives the Sam/Timer pages as before. PROJECT.md
  and the utils/tags.js TagFilter comment now point at the new paths (docs
  only). The claims guard blocked a helper script written to $TEMP by heredoc
  (it read a comment as a path); verification ran inline instead.
- For future threads: Alfred.jsx (1,606) is still the busiest file — the
  route switch, derived lists and hook order live there, and any new screen
  touches it. Hook call order in Alfred.jsx is effect order: add a hook where
  its effects should run, not where it reads nicely. Other hotspots and the
  files over 500 lines are listed in the spec.
- Old step numbers in notes above, after the reorder: old step 12 (shell) is
  now step 10; the inbox step is 9e; old steps 7, 8 and 11 named in the step-5
  note are now IntentionCard/ItemCard in step 7 and CollectionCard in step 6.
- **Step 10 (the shell, was step 12) must also** update the file list in PROJECT.md (lines 90–93, and
  anything else listing old paths) and the TagFilter comment in
  src/utils/tags.js (lines 161–172) to match the final layout. Neither was
  claimed or edited in step 3, on Alex's instruction.
