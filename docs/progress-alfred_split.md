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
- [ ] Step 5: contexts
- [ ] Step 6: home and schedule
- [ ] Step 7: intentions
- [ ] Step 8: items
- [ ] Step 9: executions
- [ ] Step 10: inbox
- [ ] Step 11: collections
- [ ] Step 12: reminders/settings and shell cleanup
- [ ] Finish: Alex runs gitpush Finish

### Notes
- Known bug, for after the split: ItemCard handleCancel resets elements with
  `{ ...el }` instead of the normaliser used by the useState init and the dirty
  twin. After Cancel, re-entering edit can report unsaved changes with nothing
  typed. Plausible, unverified. Not fixed here (pure move).
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
- **Step 12 must also** update the file list in PROJECT.md (lines 90–93, and
  anything else listing old paths) and the TagFilter comment in
  src/utils/tags.js (lines 161–172) to match the final layout. Neither was
  claimed or edited in step 3, on Alex's instruction.
