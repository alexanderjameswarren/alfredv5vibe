# Technical spec: alfred_split

## Goal

`src/Alfred.jsx` (12,052 lines at the start) is claimed by almost every front-end
project, so parallel CLI threads block each other. Split it by feature into
folders that separate threads can claim independently. Alfred.jsx ends as a thin
shell: top-level state wiring, data loading, and the route switch.

This is also the first real test of the claims system.

## Ground rules

- **Pure move.** No behaviour changes, no renames that change behaviour, no
  "while I'm here" fixes. A bug spotted on the way is recorded under Notes in
  the progress file, not fixed.
- **Twin-site rule.** Every normaliser and its dirty-check twin move together,
  into one module, in the same step (see "Normalisers and twins").
- **One feature per step, smallest risk first:** pure helpers, shared
  components, each feature screen, then the shell. Every step leaves
  `npm run build`, the app suite and the CLI suite green, with test counts
  unchanged.
- **Props, not new React context.** Screens receive what they use today as
  props. Introducing context would be a structural change; it is out of scope.
- **Guard tests read source through `src/testing/alfredSources.js`**, which
  concatenates Alfred.jsx and every file under the feature folders, so a move
  does not change any guard's count. The two "not rebuilt elsewhere" guards list
  files recursively through the same helper.
- **No database or edge-function work.**
- Verification is a click-through in the local dev server on **desktop**.

## Layout

Top-level feature folders, following `src/sam/` and `src/timer/`. Pure helpers
stay in the existing `src/utils/`. Target sizes in lines.

| Folder | Files |
|---|---|
| src/utils/ (new files) | storage.js 170, flattenElements.js 150 (+ uid), eventDates.js 40, listSortOptions.js 80, tagFilterViews.js 45, removalLabels.js 50 |
| src/testing/ | alfredSources.js — test helper only |
| src/shared/ | ObjectIcon.jsx 65, DetailMeta.jsx 30, LoginScreen.jsx 80, LoadingOverlay (with LoginScreen or own file), AddPageChrome.jsx 25, AppChrome.jsx 300 (header, drawer, tabs, NAV_ITEMS), BottomDock.jsx 80, recurrence/ (CustomRecurrenceDialog, IntervalRecurrenceDialog, SchedulePopover, RecurrenceQuickSelect); moved in: AppLink, PinnedFooter, EditCard, InsertRowButton, ItemPicker, TagPicker, TagFilter, ListToolbar, SearchInput, SortControl, UnderlineTabs, UndoMessage, RemovalMeta, RepeatBlockDialog + tests |
| src/contexts/ | ContextForm 150, ContextCard 95, ContextDetailView 330, ContextsScreen 80, useContextActions 200 |
| src/schedule/ | EventCard 410, EventMetaLink 25, HomeScreen 180, ScheduleScreen 60, useEventActions 150 |
| src/intentions/ | IntentionCard 550, IntentionDetailView 300, IntentionsScreen 85, IntentionAddScreen 50, useIntentionActions 130 |
| src/items/ | ItemCard 700, ItemDetailView 520, ItemNameLabel 10, MemoriesScreen 60, ItemAddScreen 40, useItemActions 110 |
| src/executions/ | ExecutionDetailView 425, ExecutionBadge 50, ExecutionDetailScreen 50, useExecutionActions 650; moved in: useExecutionRoute.js, executionColdLoad.test.jsx |
| src/inbox/ | InboxScreen 90, InboxDetailScreen 45, useInboxActions 500; moved in: InboxDetailView, InboxListCard, RecentlyArchived, OriginalCapture, ClipboardCapture, CaptureMeta, PendingReminder + tests, oneTapMatchesDetailPage.test.jsx |
| src/collections/ | CollectionCard 80, CollectionAddItems 150, ItemAddToCollection 400, CollectionsScreen 100, CollectionDetailScreen 520, CollectionHistoryScreen 115, useCollections 700 |
| src/reminders/ | useReminderIndex 40, useNotificationEffects 90, SettingsScreen 25; moved in: NotificationChainInline, NotificationSettings, NotificationDiagnostics |
| src/recycle/ | RecycleScreen 200, useRecycleBin 360 |
| src/alfred/ | useAlfredData 400, useRealtime 300, useAlfredNavigation 450, useListPreferences 120 |
| src/Alfred.jsx | ~700–900: hook calls, state wiring, route switch |

Left over 500 lines on purpose (splitting them further would not be a pure
move): ItemCard, ItemDetailView, IntentionCard, CollectionDetailScreen,
useCollections, useExecutionActions.

## Steps

1. Test helper `src/testing/alfredSources.js`; repoint the eight text-reading
   guard test files; pure helpers into src/utils.
2. New shared pieces into src/shared (ObjectIcon, DetailMeta, LoginScreen,
   LoadingOverlay, AddPageChrome, recurrence pickers).
3. Existing flat shared UI files into src/shared, with their tests.
4. Recycle bin into src/recycle.
5. Contexts: ContextForm, ContextCard, ContextsScreen, useContextActions.
   (ContextDetailView moves in step 8.)

Reordered at step 5 (Alex, 2026-10-05). The detail views render cards that
were still inside Alfred.jsx, so the rest goes in dependency layers, leaves
first. Target locations are unchanged from the layout above.

6. Layer (a), leaf cards: EventCard + EventMetaLink → schedule/,
   ExecutionBadge → executions/, ItemNameLabel → items/,
   CollectionCard → collections/.
7. Layer (b), twin cards: IntentionCard → intentions/, ItemCard → items/,
   each with its normaliser/dirty-check twins.
8. Layer (c), detail views: ContextDetailView → contexts/,
   IntentionDetailView → intentions/, ItemDetailView → items/,
   ExecutionDetailView → executions/.
9. Layer (d), per-feature screens and actions, one feature per sub-step:
   9a home/schedule (HomeScreen, ScheduleScreen, useEventActions);
   9b intentions (IntentionsScreen, IntentionAddScreen, useIntentionActions);
   9c items (MemoriesScreen, ItemAddScreen, useItemActions);
   9d executions (ExecutionDetailScreen, useExecutionActions);
   9e inbox (InboxScreen, InboxDetailScreen, useInboxActions, and the
   existing inbox files); 9f collections (CollectionAddItems,
   ItemAddToCollection, CollectionsScreen, CollectionDetailScreen,
   CollectionHistoryScreen, useCollections); 9g reminders/settings.
10. Layer (e), the shell: useAlfredData, useRealtime, useAlfredNavigation,
    useListPreferences, AppChrome, BottomDock.

Each step: `npm run build`, `CI=true npx react-scripts test --watchAll=false`,
`node --test "scripts/lib/*.test.mjs"`, test counts equal before and after,
then the desktop click-through in the progress file.

## Normalisers and twins (line numbers as of the start)

- ItemCard element normaliser: useState init (9812–9827), dirty twin
  `originalElements` (9845–9857), simplified copy in handleCancel (9901–9906).
  All move into items/ItemCard.jsx together.
- IntentionCard field defaults: useState (11109–11121), dirty twin
  (11138–11149), reset copy in handleCancel → intentions/IntentionCard.jsx.
- ContextForm defaults: useState (7835–7842), dirty twin (7844–7854) →
  contexts/ContextForm.jsx.
- EventCard inline isDirty (11746–11748) → schedule/EventCard.jsx.
- String→element mapper ×3 in activate, startNowFromItem,
  startNowFromIntention → executions/useExecutionActions.js together.

## Shared-state hotspots

- Record arrays (items, intents, events, contexts, collections, allInboxItems,
  executions, reminderIndex, user) → alfred/useAlfredData + alfred/useRealtime,
  passed down as props.
- Navigation (setView, guardedSetView, previousView, itemHistoryStack,
  selected*Id, return views, add pages, view*Detail) → alfred/useAlfredNavigation.
- setUnsavedChanges / confirmDiscardIfDirty, offerUndoFor, withLoading → shell
  or navigation hook; `storage` → utils/storage.js.
- listSearch, listTagsCollapsed, filterTag, sort preferences →
  alfred/useListPreferences.
- pollPausedRef and memberWriteInFlight: written by collection writers, read by
  the polling effect. Owned by useAlfredData and passed into useCollections.

Where parallel threads will still collide after the split:
- the shell's route switch and viewPaths.js, for any new view or route;
- useAlfredData and useRealtime, for any new table or loaded field;
- items/ItemDetailView.jsx and items/ItemCard.jsx (status, notes and links all
  land there);
- shared/AppChrome.jsx, for a new nav tab;
- cross-feature writers: handleInboxSave and startNowFrom*.

## Ownership map for upcoming projects

| Project | Files |
|---|---|
| Inbox detail page and card redesign | inbox/InboxDetailView, InboxListCard, InboxScreen (+ useInboxActions if the onProcess contract changes) |
| Status and item groups (menus/projects) | items/ItemCard, ItemDetailView, MemoriesScreen, useItemActions; alfred/useAlfredData + useRealtime if new fields |
| Collections as ranking | collections/CollectionDetailScreen, useCollections, utils/collectionMembers.js |
| Quick notes on items | items/ItemDetailView, ItemCard, useItemActions — collides with status/groups |
| Links on items and intentions | items/ItemDetailView, ItemCard, intentions/IntentionDetailView, IntentionCard, maybe shared/DetailMeta — collides with notes and status |
| Design-consistency contract | shared/*, index.css, guard tests — touches everything; run alone |
| Search box on Contexts | contexts/ContextsScreen only |

## Decisions (Step 2, 2026-10-05)

- The ~30 existing flat files move into the feature folders (step 3, and the
  inbox step for the inbox files).
- contexts/ and items/ are separate folders.
- The ItemCard Cancel bug is not fixed here; it is a known bug for after the
  split (progress file, Notes).
- Testing is on desktop, in the local dev server.

## Out of scope

- De-duplicating the three element-mapper copies or the ItemCard normaliser
  copies.
- Any bug found during the split.
- React context, renames, or splitting the >500-line components further.
- Database and edge-function work.
