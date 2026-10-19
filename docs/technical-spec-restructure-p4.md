# Restructure Phase 4: One list per context — technical spec

Owner: `restructure_p4-v9k`. Progress: `docs/progress-restructure-p4.md`.
Plan report: Alfred clip `[restructure_p4-v9k-s1-q7dm]`; confirmed by `[restructure_p4-v9k-s2-h3wn]`.

## Rules carried from Phases 0–3
- One live event per intention, at most one open execution (`events_one_live_per_intent`,
  `executions_one_open_per_intent`, 096).
- Closed and archived are separate; nothing auto-archives.
- Teal = running execution, brown = primary action, amber = paused, red outline = destructive.
- Bordered card = tappable; content to read sits in a grouped list. No carets. RecordLinks header.
  8px corners. Actions open a popover or modal. Undo only when something can be restored.

## Scope
1. **One row per item.** On context detail and the Intentions list, an item and its intentions
   render as ONE row: item name, with the picked intention's schedule line and recurrence.
   Intentions with no item stay rows of their own. The picked intention is the one Run Now would
   use: `itemActionTarget` → `runNowTargetForItem` (runNow.js): open execution first, then a
   recurring intention with the earliest live event, then the newest one-off. Tapping a merged
   row opens item detail. Nav tabs unchanged. The Items list (MemoriesScreen) is NOT changed.
   **Status rule (2026-10-13, supersedes the earlier "picked intention's status" and
   "newest closed intention" rules):** a merged row's status chip is ALWAYS the item's status.
   The picked intention shows only in the schedule line (Scheduled / Overdue / In progress /
   Not scheduled) and its repeat line. Intention-only rows show the intention's status;
   item-only rows the item's. Status chip filters and counts count what each row's chip shows.
   When every intention is closed there is no pick: the row shows the item's status and
   "Not scheduled".
2. **Skip, Done, Stop** on recurring intentions (below).
3. **Recurrence in plain words**, with the next occurrence and the kind (fixed schedule vs
   interval from completion). `{type:"once"}` = no recurrence. Must handle every live shape:
   fixed daily/weekly/monthly, interval, once, and null (legacy fallback via `getRecurrenceConfig`).
4. **Next date on the completion dialog**, editable before saving.
5. **Drop `intents.is_item`.**
6. Bugs: (a) Intentions "Last modified" sort; (b) reminder badges refresh only on reload;
   (c) context detail's tag filter applies only to items.

Out of scope: menus/groups/browse tabs (P5), collection and rank chips (P6), Schedule into
Home and the event onto intents (P7), links (P8), navigation rework, is_reference UI, new
recurrence patterns, goal counts, recurring/snoozed reminders, stars on close, data cleanup,
restyling detail pages beyond the merged row, the Items list.

## Next-date rules
One pure function in `src/utils/recurrence.js`; `triggerRecurrence` takes an explicit date.

| Action | Fixed schedule | Interval from completion |
|---|---|---|
| Done (run or no run) | first occurrence after the event's date; if that is before today, the first occurrence on or after today | completion date + interval |
| Skip | same as Done | event's date + interval; if before today, today |

Micro Workout case: daily, event Monday, run left open, closed Tuesday → next = Tuesday
(today's code gives Wednesday, because it always counts from the close day).

As built (Step 7): the Complete pop-up has "Completed on" for every execution (default
today; ANY past day, so backfills work, never a future one; no lower limit), which sets
`closed_at` (`closedAtFor`: now for today, else midday that day) and so `last_completed_at`;
and, for an active repeat, "Next" with the repeat line, defaulting by the rule below,
recomputed from Completed on for an interval repeat (clamped to today) unless Next was
changed by hand. While a date is being changed, the picker (labelled "Completed on" or
"Next") replaces its line: one date, one label. A completed execution's page has Change on
its "Completed … · read only" line (`CompletedOnDialog`, `changeCompletionDate`): the same
any-past-day rule, saved at midday; events and the next date do not move. The existing
`executions_last_completed` trigger (100) already recomputes `last_completed_at` as the
LATEST done execution whenever a done execution's `closed_at` changes, so no migration is
needed. After a completion or a date change the app re-reads the intention and item(s)
(`refreshCompletedRecords`) so rows show the new "last done" without a reload.
Event dates are never picked in the past: SchedulePopover's `minDate`, EventCard's edit form
(a moved date) and inbox triage's date all refuse with "Pick today or a later date."

As built (Step 6): `nextOccurrence(config, { eventDate, completedOn, today, skipped })` in
`src/utils/recurrence.js`; `triggerRecurrence(intentId, event, { nextDate, skipped })` takes
a chosen date or applies the rule. Today's Archive Event on a live event already passes
`skipped: true`.

The completion dialog and the Done popover show the computed date and let it be edited before
saving. No date is written when the intention is once, not active, past `end_date`, or already
has another live event (existing guards).

## Skip / Done / Stop
- **Skip** inserts a closed execution, `outcome='skipped'`, `closed_at = now`, on the skipped
  event; archives the event; creates the successor by the rule above. Undo removes the
  successor, the skipped execution, and restores the event. `last_completed_at` does not move
  (100's triggers count only `outcome='done'`). History shows a "Skipped" line
  (`alfred_recent_completions` returns skipped rows with their outcome — database step).
  EventCard "Archive Event" on a recurring event becomes this same Skip. Every reader that
  treats a closed execution as done is audited in the Skip step.
  **As built (Step 9, supersedes the history line above):** Skip is `updateEvent(id,
  { archived: true })` on a repeating intention's live date (`useEventActions`): it checks
  the database for an open execution (refuses with "Continue or delete it before
  skipping"), inserts the skipped execution, archives the date, makes the next date with
  `skipped: true`, and toasts "Skipped Monday, October 19." with Undo (successor, execution,
  date). A one-time date's archive (Unschedule, EventCard) writes no execution. Skipped
  executions never appear under Recent completions (rule, 2026-10-19): the history line is
  its own "Skipped: …" line under it (`RecentSkips`, `listRecentSkips` reads `executions`
  directly, the event's date), so `alfred_recent_completions` keeps `outcome='done'` and the
  Step 11 change to it is dropped. EventCard's edit form shows Skip (the shared `skipAction`)
  on a repeating date, hidden while the intention has an open execution; Archive Event stays
  on a one-time date. A skipped execution's page reads "Skipped <event date> · read only".
  Audit: the database's last-done and recent-completions readers already require
  `outcome='done'`; the execution page header was the one front-end reader that said
  "Completed" for any closed execution (fixed). Left for Alex: the recycle bin lists skipped
  executions; the MCP history tools' descriptions; `status_activate_on_execution` fires on a
  skipped insert (moot: a repeat with a live date is already active).
  **Step 9 follow-ups (2026-10-19, supersede the separate "Skipped:" line):**
  - One list, "Recent executions", on intention and item pages (`RecentCompletions`,
    `mergeRecent`): the last five, completed and skipped mixed, newest first by the date
    shown (completion day; a skip's event date). Completed rows keep the bordered card;
    skipped rows have the Skip icon (CalendarX), "<date> (skipped)", grey text, no border.
    Every row opens its execution. `RecentSkips` is gone; `listRecentSkips` stays.
  - A completed or skipped execution's page has Delete Execution (red outline) under the
    read-only line. It asks "Delete this execution? It will be removed from the history."
    (red Delete, shared CancelButton); no Undo. `deleteClosedExecution` deletes it (notes
    cascade), re-reads the intention and items, reloads Recent executions, and returns to
    the page it came from. Events and statuses never move. The 100 trigger already
    recomputes `last_completed_at` on DELETE, so no migration.
  - Skip's Undo deletes the skipped execution first and stops with an error if that fails,
    so it never restores the date beside a skip (`storage.delete` swallows errors).
  - The recycle bin's executions tab leaves out skipped ones (null outcomes kept).
  - "Show all (N older)" beside the Recent executions heading when there are more than
    five (the inbox "Recently archived" control; "Last 5" folds it back). N comes from
    `countRecentExecutions`; Show all reads up to 50 completed and 50 skipped.
  - Undo rule: every write in an Undo is checked, and the first failure throws (an alert)
    and stops the Undo, so it never carries on past a failed write.
  - Open (not built): Start Now on a future date saves the event as today and keeps no
    record of the old date; Delete Execution then leaves it on today. Recommended: record
    the original date on the execution when Start Now moves it, and have Delete Execution
    put it back when the event is still on the day it was moved to and the original is
    today or later. Needs a column, so it belongs with Step 11.
- **Done** without an execution inserts a closed `outcome='done'` execution on the live event
  (or a new event dated today), archives the event, and opens the same next-date popover.
  As built (Step 8): a brown "Complete" button on intention detail for a repeating, not-closed
  intention, opening the Complete pop-up (Completed on, Next, note); `markDone` writes the
  execution at the Completed on date (midday), on a new event inserted already archived when
  there is no live one; Undo removes the execution (its note cascades) and the next event
  and restores the date. Disabled while an execution is open.
- **Stop, as built (Step 10):** `stopAction` (CircleStop, neutral; unused elsewhere — SAM
  and Timer stop with Square) in ActionBar after Log Execution, before Edit, on intention
  detail and on item detail for the picked intention; only when it repeats and has not
  ended (`canStop`: no end date, or one after today), hidden while an execution is open.
  `useStopRepeat` asks the one StatusEventsSheet question (title "Stop repeating"; archive
  or keep) when a live date today or later or a scheduled reminder is pending, else stops
  at once. `stopRepeat` patches `{ status: 'background', endDate: today }`, archives every
  live date and cancels reminders on "archive", and toasts "Stopped repeating. Moved to
  Background." Undo restores end date and status (never someday), then the dates still
  ahead and the reminders; it stops at the first failed write. `status_changed_at` is
  stamped by status_guard and cannot be restored by the client until Step 11.
  Restart: Schedule inserts an event, so 088's trigger moves Background to Active; Edit
  clears the end date (status stays Background until something is scheduled).
  Decided after testing (2026-10-19): the button reads "Stop repeating" (Pause is the
  execution's word). Reschedule (moving a date) does NOT un-park a Background intention;
  only a new event does (the Phase 1 rule). A past-due live event asks the question too,
  in Stop and in Close (`loadClosePending` takes every live event). The question says
  "Archive this event" / "Keep this event" and Close's line "Closing archives this
  event." Step 11: Stop's Undo restores `status_changed_at` under `CLOSE_REASON_SAVED`.
  One tap, one message: `settle({ announce: false })` returns whether a status flipped,
  and Schedule folds it into its toast: "Scheduled for Today, October 19. Moved to
  Active." Status names in messages are capitalised.
  Undo reverses everything the tap did: `settle` returns `{ moved, restore }`, and the
  Undo of Schedule, Schedule from an item and Log Execution runs `restore` last, putting
  each flipped record back to its earlier status (and `status_changed_at` under
  `CLOSE_REASON_SAVED`); Someday stays Active (status_guard refuses it); it stops at the
  first failed write. Log Execution's toast also says "Moved to Active." when it did.
- **Stop** sets `end_date` to today, keeps `recurrence_config` (row reads "Ended"), and ALWAYS
  moves the intention to background. If there is a future event or a pending reminder it first
  asks the single Cancel/Keep question (`StatusEventsSheet`). Scheduling again flips it back
  to active through `status_activate_on_event`.

## Dropping is_item — order
Nothing reads `is_item`; writers disagreed (87 rows false with an item). `storage.set` sends
the keys it is given, so a write naming a dropped column fails. Order:
1. App stops writing it (Step 1) and that is live in production (Checkpoint).
2. MCP `get_intents` stops selecting it and is deployed.
3. Stale-tab guard (approved): `withoutDbOwned` in `src/utils/storage.js` strips `is_item`
   from every intents write, so a tab opened before the drop, whose state rows still carry
   `isItem`, cannot send it through whole-row writes (`archiveIntention` and its Undo).
   Ships in the database step, before the drop runs.
4. The column is dropped (database step).

## Row model
`src/utils/rowModel.js`: `buildRows({items, intents, events, openExecutions, itemsWithoutIntents})`
returns `{key, kind: "item"|"intention", item, intent, intents, event, open, status, tags}`.
An intention whose item is not in `items` stays its own row. Archived intentions are ignored.
`status` is the item's on an item row and the intention's on an intention-only row. `intent`
is the Run Now pick, or null when every intention is closed. `tags` is the union of
the item's and its intentions' tags. `updatedAt` on an item row is the latest of the item's
and its intentions' `updated_at`; `ROW_ACCESSORS` sorts by it and the card shows it.
`rankRows` tiers rows as `rankByActivity` tiers intentions.

Rendering: a row with a picked intention is an `IntentionCard` with `row` (item name and icon,
the item's status pill, the schedule line always shown, union tags, row date; tap opens item
detail). A row with no pick is an `ItemCard`; when the item has (closed) intentions it adds
"Not scheduled" beside the pill. Merged rows on context detail consider
only intentions in the same context; an item's intention filed in another context does not
merge (intentions made from an item copy its context, so this is rare).

## Close on list rows (Step 3 follow-up)
Rows in the lists this phase touches have **Close, not Archive**. Archive stays on the item
and intention detail pages. `src/shared/useRowClose.jsx` (hook + `CloseRowButton`) and
`closeRecords` in `useIntentionActions`.
- Merged or item-only row: closes the item and every intention on it not already closed.
  Intention-only row: closes that intention. **A row whose chip reads Closed has no Close**
  (merged and item-only rows: the item is closed; intention-only rows: the intention is).
  An item that is closed while one of its intentions is still open therefore has no Close on
  its row; that intention is closed from its own detail page. (No live data has this case
  on 2026-10-13: the only closed item, "Someday4 test", has only a closed intention.)
- Asks one question (`StatusEventsSheet`, title `Close "<name>"`) only when an intention
  being closed has a live event dated today or later, or scheduled reminders; otherwise it
  closes with no pop-up. Several events are named together ("2 scheduled events (from …)").
  As with every close since P1, the sheet offers Close-and-archive or Cancel, no Keep: a
  closed intention keeps no plan.
- Closing archives every live event of those intentions (past-due included) and cancels
  their scheduled reminders. A recurring intention also gets `end_date` = today (as Stop), and
  `triggerRecurrence` never runs for a non-active intention, so it makes no further event.
- Toast: `Closed "<name>"` plus what was archived and cancelled. Undo restores previous
  statuses, the end date, events dated today or later, and reminders still ahead. A previous
  status of someday cannot be restored (status_guard); if nothing at all can be put back the
  toast has no Undo.
- Disabled while the item or any of its intentions has an open (active or paused) execution,
  with the line "Finish the execution first" on the row.
- Look: neutral secondary button (not red, not brown), lucide `CircleCheckBig` + "Close".
  The intention detail page has no Close button to match (Closed is an option in its status
  menu), and `CircleCheckBig` is not used elsewhere in the app (`CheckCircle2` is Money's
  "all good" mark).

## Shared list rules (Step 4)
Context detail and the Intentions list share `listRows` (rowModel) and `src/shared/RowList.jsx`.
- **In progress section** (`src/executions/InProgressSection.jsx`, whose `ExecutionList` is
  also Home's Active and Paused lists): every running, then paused, execution in scope, as
  Home's teal ExecutionBadge cards, above the search box. Scope: all on Intentions; on a
  context page, runs whose context is this one plus any run that takes one of its rows out.
  Ignores search, tags, chips and sort. Hidden when empty.
- A row with an open run (`hasOpenRun`: any of its intentions, or a run carrying the item) is
  in the section and not in the list; the list's chips, tags, Tags (n) and "x of y" count only
  the list. No pin-to-top: every list row follows the chosen sort.
- Item rows (no pick) show the same context label as intention rows.

## Context and collection archive (Step 4 follow-up)
- Context detail has no Archive at the top. "Archive Context" is at the bottom of the context
  edit form, below a divider (as the collection form), red outline (`border-2
  border-destructive text-destructive`, `rounded-lg`).
- It stays disabled, with the reason, while the context holds any item, intention, event or
  collection (contexts never cascade), so the live-events question can never arise; tapping
  it asks "Archive this context?" (Archive / Cancel). Archiving returns to the previous page
  and the toast keeps its existing Undo (un-archiving is one write).
- "Archive Collection" uses the same red outline; nothing else on that form changed.
- Every Archive button in an edit form's footer uses it too (Step 6 follow-up): intention
  edit (IntentionCard), item edit (ItemCard), event edit (EventCard "Archive Event").
  Style only. Inbox detail's "Discard" keeps its solid fill (not an Archive button).

## Repeat line (Step 5, as built)
`src/utils/recurrenceDisplay.js` is the only formatter. Fixed schedules read "Every …";
interval repeats read "N units after last completion" ("1 day after last completion",
"3 weeks after last completion", "6 months after last completion"). `{type:"once"}`, null and unknown
shapes read "Does not repeat". Weekly with no days, and monthly with neither a day nor an
ordinal (legacy shapes the engine never repeats), read "…, with no day chosen". An end date
ahead adds "· until October 20"; one today or earlier reads "Ended October 13". Dates gain
the year when it is not the current one. **No "· next …" anywhere** (Step 6 follow-up): the
schedule line beside every repeat line already carries the date.

**Number boxes in the repeat dialogs** (`src/shared/NumberInput.jsx`, Step 6 follow-up):
"Repeat after completion" (how many) and "Custom recurrence" (repeat every, day of month)
hold raw text: empty is allowed while typing, nothing snaps back, focus selects the whole
value; an empty or invalid value shows "Required" (or "At most N") under the box and
disables Done. Other number boxes in the app are left for Alfred record 790410b6.

## Row layout (Step 5 follow-up, as built)
Every row card in the shared layout (RowList: context page, Intentions list, item detail's
Related Intentions) is four lines, one kind of information each:
1. Name.
2. What it is: status chip, context label, tags (first three, then "+N more"; `TagChips`).
3. When: the event icon (`CalendarClock`, Alfred's event icon) with the schedule state
   ("Scheduled · Friday, October 23", "Overdue · …", "In progress · …", "Not scheduled"),
   then, on repeating rows only, lucide `Repeat` (the icon the edit form's Repeat button
   already uses) with the repeat text. The reminder badge sits at the end of this line.
   Rows never say "Does not repeat"; intention detail still does.
4. last done · last updated (item rows keep their element count first).
Item rows drop the description in this layout. Line 3 wraps; the buttons are untouched.

**Limits (Step 5 follow-up 2):**
- The name is clamped to two lines (`line-clamp-2`) ending in "…", with the full name as
  its `title` tooltip; tapping the row opens the detail page, which shows it whole.
- Line 2 (`RowMetaLine` in `src/shared/TagChips.jsx`) is ONE line, never wrapping: the
  status chip (never truncates), the context label (at most 45% of the line, "…" beyond,
  full name as tooltip), then the tags in the rest. `TagChips fit` measures an off-screen
  copy with ResizeObserver and shows as many tags as fit, the rest as "+N more", so the count
  follows the screen width. Where widths cannot be measured (no ResizeObserver, or nothing
  laid out) it shows two tags plus "+N more". A row with a tag always shows at least one:
  the tag area's minimum width is one tag plus "+N more" (`minTagWidth`), and the context
  label shrinks (to 3.5rem at least, still "…") to leave it.
- Item detail's running and paused runs use the same `InProgressSection` ("In progress (n)"),
  with each run's notes under its card.

**Related Intentions** on item detail now render through RowList as intention-only rows:
Close instead of Archive, same rules (hidden on Closed, disabled with "Finish the execution
first" during a run, one pop-up when pending, Undo). Collection cards keep Archive (Phase 6).

## Vocabulary (one verb per meaning)
- **Start Now**: begin an execution. **Continue**: open the one in progress.
- **Complete**: finish the execution in progress. Only on the execution page.
- **Log Execution**: record an execution that already happened, in one step (intention and
  item pages, and their ⋯). Pop-up "Log execution", main button "Log", toast "Logged an
  execution on Sunday, October 18." with Undo. Brown, icon NotebookPen.
- **Close**: the thing is done for good. **Skip**: pass over this date. **Delete
  Execution**: remove an execution. Always "execution", never "run".
While an execution is in progress or paused, the page shows Continue and HIDES Log
Execution and Skip (never Continue and Log Execution together); Reschedule keeps its greyed
state and reason.

## What Log Execution writes (`recordDone`, `markDone`, `completeItem`)
| Case | Writes |
|---|---|
| Item with no intention | creates the intention (as Start Now does), creates an event for the Completed on day (archived), creates the execution closed as done |
| Intention with a live event | reuses it (archived), creates the execution closed as done |
| Intention with no live event | creates an event for the Completed on day (archived), creates the execution closed as done |
| Item with intentions | uses the intention Start Now would pick, then as above |
| Then | a repeating intention gets its next event on the Next date; a one-time intention closes |
Recent completions on the page reloads at once (`completionsChanged` in notesApi), on log,
on Undo and on a completion-date change.

## Step 8 follow-ups (as built)
**Rule A (fixed schedules).** Count from the EARLIER of the scheduled date and Completed on,
step along the schedule, never before today. Examples: scheduled Mon Oct 19, completed Sat
Oct 17, daily → Sun Oct 18; scheduled Mon, completed Tue, daily → Tue; scheduled Oct 7,
completed Oct 7 (backfill), daily → today; weekly Tuesday, scheduled Tue Oct 20, completed
Sat Oct 17 → Tue Oct 20. A skip counts from the skipped date. Interval repeats unchanged.
One helper: `nextOccurrence`; `nextForCompletion` offers Next for active AND someday
intentions (completing makes someday active), not for background or closed.

**Complete everywhere.** Every intention not closed has Complete (Complete pop-up: Completed
on, Next for repeats, note). A one-time intention is closed by it (as completing an
execution). Items have Complete too: it completes the intention Start Now would pick, or
creates one first exactly as Start Now does; Undo also deletes an intention it created.
`recordDone`, `markDone`, `completeItem` in `useExecutionActions`. Skip shows only when the
(picked) intention repeats and has a live date. Complete and Skip are disabled with "Finish
the execution first" while an execution is open.

**Action rows** (`src/shared/ActionBar.jsx`, with `skipAction`, `completeAction`,
`archiveAction`). Intention page: Start Now, Reschedule/Schedule, Skip, Complete, Edit,
Archive. Item page: Start Now, Schedule, Skip, Complete, Add to Collection, Clone, Edit,
Archive. As many as fit at the current width (ResizeObserver) are buttons; the rest go into
⋯ in the same order; no ⋯ when everything fits. Start Now and Schedule are pinned (always
buttons; Schedule is a popover and cannot live in a menu). Menu-only, after the rest:
"Unschedule" (one-time intention with a live date) and "Create Intention" (item). Archive is
the red outline as a button, red text in the menu. Clone's icon is CopyPlus so the Copy icon
means only copy.

**Copy** (`src/shared/CopyButton.jsx`, small and large). A faint icon after the title on
intention and item detail; on the inbox detail page (no title) after the "Original capture"
heading. Tapping copies what Copy copied before and turns the icon into a check mark for a
moment; no toast. The inbox task card keeps a labelled Copy button with the same feedback.
The old Copy buttons in the action rows are gone.

## Context edit page (Step 4 follow-up, as built)
One context edit form, as a whole page, the way item detail's edit is: context detail's
Edit and a context card's gear (Contexts list) both open it; Save and Cancel return to where
you came from (detail, or the list). Archive Context sits on it. No inline form on context
detail and no "Close" label. Not its own URL: a new route needs `src/viewPaths.js`, held by
warren_buffet_p2-m4t; the page is a mode of `/contexts/detail`, as item edit is of item
detail. "Add Context" on the Contexts list is unchanged (inline create form).

## Close reason (front end built 2026-10-19, Step 10a; writing the reason waits on Step 11)

**As built (Step 10a).** `CloseDialog` (shared): Completed / Won't do (Close waits for a
choice unless Completed is preselected), Closed on (the Complete pop-up's `DateRow`; any
past day, never the future: "It cannot be closed in the future."), optional note, the
`sheetWording` line when future events or reminders are pending, shared CancelButton. All
six places go through `closeRecords` with `{ reason, note, closedOn, pickedIntentId }`:
row Close (`useRowClose`), intention pill and edit form (`IntentionDetailView`), item
pill and edit form (`ItemDetailView`). Defaults: `closeDefaults` (Closed on = the picked
intention's live date when not in the future, else today; Completed preselected when the
item or any intention being closed has `last_completed_at`). Disabled rule: Closed is a
disabled choice in `StatusMenu` and `StatusPicker` (`blocked`) with "Finish the execution
first" printed under it; the row Close button lost its repeating tooltip.
- Item pill and item edit form close the item AND its open intentions, as the row Close
  does (before, they closed only the item). Picked intention: the one Start Now would pick.
- Until Step 11 (`CLOSE_REASON_SAVED = false` in `status.js`): a close saves the status
  (and end date, archived events, cancelled reminders) and the Completed execution or the
  note; the reason and Closed on are held in the pop-up and NOT saved. Closed on still
  dates the execution a Completed close creates. `status_changed_at` is stamped now() by
  status_guard. Turning the flag on writes `closed_reason` and `status_changed_at` on every
  closed record, restores both on Undo, and does the same for the automatic close.
- The execution is written after the statuses (so its insert cannot activate a someday
  intention) and never makes a next event. Undo deletes it (or the standalone note) first,
  then restores; it stops at the first failed write; the rows re-read last_completed_at.
- Follow-ups: the two choices are `ToggleButton`s (`src/shared/ToggleButton.jsx`, shared
  with the inbox's New Item / New Intention), ONE style, the inbox's: `tone` "primary"
  (Completed, New Item) is a brown outline with brown text, filled dark brown with white
  text when chosen; "secondary" (Won't do, New Intention) a tan outline with dark text,
  filled light tan when chosen. Icons Check (as Complete) and Ban (unused elsewhere;
  CircleSlash is SAM's). The pop-up is portalled to `document.body`.

### Design
Every close records why. Labels **Completed** / **Won't do**; stored in a new column
`closed_reason` on `items` and `intents`: `'done'` | `'wont_do'` (`'done'` matches
`executions.outcome`). Null = unknown (closed before this, or not backfilled).

**One pop-up, always**, in all six places Closed can be chosen: item detail status pill;
intention detail status pill; item edit form status buttons (on Save, not on tap);
intention edit form status buttons (on Save); item / merged row Close; intention row Close.
It holds the two-way choice, an optional note box, and, when relevant, the existing question
about future events and reminders, all in ONE pop-up. Completed is preselected when a
completed execution already exists. This replaces today's no-pop-up close (those tests change).

What each choice writes:
| Case | Writes |
|---|---|
| Completed, no completed execution yet | a closed execution, `outcome='done'` (on the event if live, else a new event dated today, archived); the note becomes its note. On a merged row or item covering several intentions: ONLY on the picked intention; every closed record gets the same reason |
| Completed, item with no intention | the note as a standalone note on the item; no execution, no invented intention |
| Completed, a completed execution already exists | the note as a standalone note on the record; no second execution |
| Won't do | the note as a standalone note; no execution |
The note is optional. An execution created at close must NOT generate a next event, even on a
recurring intention (closing also stops the repeat via end_date) — explicit test.

**Undo** removes what the close created (execution or note), restores every status, end
date, archived event and cancelled reminder (as today), and `last_completed_at` falls back to
its earlier value by itself (the 100 triggers recalculate on execution delete). Undo may
return a record to Someday (needs the Step 11 guard exception).

**Closed on** (added 2026-10-16). The Close pop-up also has a "Closed on" date, with the
same Change pattern as the Complete pop-up. Default: the intention's live event date if it
has one (even a past one), otherwise today. Any past date, never the future (no lower
limit, as Completed on). It is
written to `status_changed_at` on every record the close closes (items and intents), so an
item with no intention records its close date too. When the reason is Completed and the
close creates the done execution, that execution's completion date (`closed_at`, via
`closedAtFor`) is the Closed on date, so `last_completed_at` shows the real day. Undo
restores the previous `status_changed_at` as well. Database note for Step 11:
`status_guard` stamps `status_changed_at` itself and ignores client writes today, so it must
accept a client-supplied value on a move to closed (no later than now()).

**Automatic close on completion** (added 2026-10-17). Completing a one-time intention's
execution already closes the intention (`closeExecution`). That close saves
`closed_reason = 'done'`, and its Closed on date (`status_changed_at`) is the Completed on
date, not the day of the tap. Step 11's backfill treats existing automatic closes the same
way where it can tell: a one-time intention whose latest done execution's `closed_at` sits
just before its `status_changed_at` gets 'done' and that completion date.

**Disabled rule**, all six places: Closed cannot be chosen while an execution is open (for an
item, an open execution on any of its intentions or one carrying the item). Pills and edit
buttons show Closed disabled with "Finish the execution first", as the row Close does.

**Database (Step 11):** `closed_reason` on items and intents (check constraint, comment);
`status_guard` exception allowing closed → someday within a few minutes of
`status_changed_at` (so Undo works; must not open a general way back to someday);
`get_intents` and `get_items` return `closed_reason`; a backfill of existing closed records
from a list Alex reviews (Claude proposes each row's reason, Alex confirms, rows not listed
stay null).

## Extra: inbox Context picker
The inbox detail "Context" select is sorted by name, case-insensitive. The App picker uses the
apps list, not the context list, and is unchanged; no other inbox picker uses contexts.

## Database step (one step, near the end)
One migration, `_pending_restructure_p4-v9k_phase4.sql`, numbered after `gitsync`:
- ~~`alfred_recent_completions`: include `outcome in ('done','skipped')`, return `outcome`.~~
  Dropped 2026-10-19 (Step 9): skips never appear under Recent completions; `RecentSkips`
  reads them directly.
- `alter table intents drop column is_item`.
- `alter publication supabase_realtime add table reminders`.
- Then the mcp function deploy.

Items: `db:fn:alfred_recent_completions`, `db:table:intents`, `db:table:executions`,
`db:table:reminders`, `db:deploy`.

**Waits on warren_buffet_p2-m4t.** They hold `db:deploy` and `supabase/functions/mcp/index.ts`.
Deploying mcp from this worktree would ship its older `index.ts` over their live code. The step
does not start until their mcp work is in main and Alex has run `gitsync` here. Stop and tell
Alex at that point; nothing is claimed or deployed early.

**As written (2026-10-19, after gitsync to 138; not applied).** The migration is
`supabase/migrations/_pending_restructure_p4-v9k_restructure_p4.sql` (replaces the planned
`_phase4` name): drop `intents.is_item`; `closed_reason` on items and intents; a new
server-only `status_written_at` (filled from `status_changed_at`, then default now());
`status_guard` allows closed -> someday within 10 minutes by `status_written_at` and keeps an
app-supplied `status_changed_at` no later than now(); reminders into `supabase_realtime`;
`executions.prior_event_date` and `prior_intent_status`; `closed_reason = 'done'` on Alex's
eight confirmed records (closed rows, and an item's closed intentions); `platform_search_items`
returns `closed_reason`. App: `CLOSE_REASON_SAVED = true` (writes need the migration, so it
must be applied BEFORE this code reaches main); `restoredCloseFields` for Close, Log
Execution and Stop Undos; Close's Undo returns Someday; Start Now records the moved date or
un-parked status and Delete Execution restores them (`restoreStartNow`); storage strips
`is_item`, `status_written_at`, and keeps `closed_reason` out of whole-record writes. MCP:
`get_intents` selects `closed_reason`; `get_execution_history` rows carry `is_completion`
and its description (tool-definitions.ts) says skips are not completions. Still to do:
the same wording in `mcp/index.ts` (held by warren_buffet_p3-q5k) and `ai-enrich/index.ts`;
the reminders realtime subscription (Step 12).

## Bugs — causes and fixes
- (a) `rankByActivity` (status.js) re-tiers after `sortRows`, and orders the scheduled tier by
  event date; the card's first date is "last done". Fix (as built, Step 4): `rankRows` lifts
  only rows with an open run (active, then paused, which read "In progress"/"Paused"); every
  other row keeps the chosen sort exactly. Scheduled, background and closed rows no longer
  re-tier. Applies to context detail and the Intentions list (shared `listRows`). The card
  already shows "last updated"; a merged row's date is the latest of its item and intentions.
- (b) No realtime on `reminders`; the index refreshes only on view change to three lists.
  Fix: reminders join the realtime publication (database step); `useRealtime` subscribes and
  refreshes the reminder index on change. A refresh after detail Add/Cancel stays only if the
  realtime event is not enough.
- (c) ContextDetailView counts tag-filtered items plus all intents and filters only items.
  Fix: the tag filter applies to every row, offers every row's tags, and counts follow it.
