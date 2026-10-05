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
- [ ] Step 8: layer (c) detail views — Context, Intention, Item, Execution
- [ ] Step 9: layer (d) per-feature screens and actions
  - [ ] 9a home/schedule
  - [ ] 9b intentions
  - [ ] 9c items
  - [ ] 9d executions
  - [ ] 9e inbox
  - [ ] 9f collections
  - [ ] 9g reminders/settings
- [ ] Step 10: layer (e) the shell
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
  (the known Cancel bug, `{ ...el }`, kept as is). IntentionCard: field defaults
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
- Old step numbers in notes above, after the reorder: old step 12 (shell) is
  now step 10; the inbox step is 9e; old steps 7, 8 and 11 named in the step-5
  note are now IntentionCard/ItemCard in step 7 and CollectionCard in step 6.
- **Step 10 (the shell, was step 12) must also** update the file list in PROJECT.md (lines 90–93, and
  anything else listing old paths) and the TagFilter comment in
  src/utils/tags.js (lines 161–172) to match the final layout. Neither was
  claimed or edited in step 3, on Alex's instruction.
