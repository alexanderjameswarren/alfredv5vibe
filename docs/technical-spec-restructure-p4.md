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
- **Done** without a run inserts a closed `outcome='done'` execution on the live event (or a
  new event dated today), archives the event, and opens the same next-date popover.
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

## Repeat line (Step 5, as built)
`src/utils/recurrenceDisplay.js` is the only formatter. Fixed schedules read "Every …";
interval repeats read "N units after you last did it". `{type:"once"}`, null and unknown
shapes read "Does not repeat". Weekly with no days, and monthly with neither a day nor an
ordinal (legacy shapes the engine never repeats), read "…, with no day chosen". An end date
ahead adds "· until October 20"; one today or earlier reads "Ended October 13". "· next
Wednesday, October 15" is the live event's date, shown only when it is today or later and
not past the end date, and not on rows, whose schedule line already shows it. Dates gain
the year when it is not the current one.

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

## Context edit page (Step 4 follow-up, as built)
One context edit form, as a whole page, the way item detail's edit is: context detail's
Edit and a context card's gear (Contexts list) both open it; Save and Cancel return to where
you came from (detail, or the list). Archive Context sits on it. No inline form on context
detail and no "Close" label. Not its own URL: a new route needs `src/viewPaths.js`, held by
warren_buffet_p2-m4t; the page is a mode of `/contexts/detail`, as item edit is of item
detail. "Add Context" on the Contexts list is unchanged (inline create form).

## Close reason (DESIGN, not built)
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
- `alfred_recent_completions`: include `outcome in ('done','skipped')`, return `outcome`.
- `alter table intents drop column is_item`.
- `alter publication supabase_realtime add table reminders`.
- Then the mcp function deploy.

Items: `db:fn:alfred_recent_completions`, `db:table:intents`, `db:table:executions`,
`db:table:reminders`, `db:deploy`.

**Waits on warren_buffet_p2-m4t.** They hold `db:deploy` and `supabase/functions/mcp/index.ts`.
Deploying mcp from this worktree would ship its older `index.ts` over their live code. The step
does not start until their mcp work is in main and Alex has run `gitsync` here. Stop and tell
Alex at that point; nothing is claimed or deployed early.

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
