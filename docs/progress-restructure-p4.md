# Restructure Phase 4 — progress

Spec: `docs/technical-spec-restructure-p4.md`. Owner: `restructure_p4-v9k`.
Test every step in desktop Chrome's mobile view against the local dev server.

| # | Step | Status |
|---|---|---|
| 1 | is_item out of the code; MCP select, types, recurring_only | Done, checkpointed c018a23 |
| 2 | Row model (pure, tested) + extra: inbox Context picker sorted | Done, tested 2026-10-13 |
| 3 | Context detail: merged rows + bug (c); Close replaces Archive on rows; fixes from testing | Done, checkpointed d00dfcf |
| 4 | Intentions list: merged rows + bug (a); follow-ups (In progress section, context edit page, archive buttons, duplicate run card) | Done, checkpointed 59a700b |
| 5 | Recurrence in plain words; follow-ups: four-line rows, Related Intentions close, name clamp, one-line line 2 | Done, tested 2026-10-14; awaiting Checkpoint |
| 6 | Next-date function + `triggerRecurrence` takes a date | |
| 7 | Completion dialog: next-date field | |
| 8 | Done control | |
| 9 | Skip control (+ EventCard Archive Event → Skip; audit closed-as-done readers) | |
| 10 | Stop control | |
| 10a | Close reason, front end: one Close pop-up in all six places (choice, note, events/reminders question), execution/note creation, disabled rule | |
| 11 | Database step (waits on warren_buffet_p2-m4t), incl. `closed_reason`, status_guard Undo exception, MCP fields, backfill list | |
| 11a | Close reason, finish: write `closed_reason`, Undo back to Someday, review and apply the backfill | |
| 12 | Reminder badges via realtime | |

## Steps and testing

**1. is_item out of the code.** Removed every `isItem` write (triage row, edit whitelist,
add-intention, schedule-from-item, start-now-from-item, add screen draft); MCP `get_intents`
no longer selects `is_item`; `recurring_only` excludes `{type:"once"}`.
Test: create an intention from inbox triage with an item; add an intention on item detail;
Schedule and Start Now from an item with no intention; edit an intention's name. Each saves
with no error. MCP `get_intents recurring_only` lists only Micro Workout-type rows (after deploy).

**2. Row model.** `src/utils/rowModel.js` builds one row per item (picked intention by the
Run Now rule) plus one per item-less intention. Test: unit tests only.
*Extra:* inbox detail's Context select is alphabetical, case-insensitive
(`src/inbox/InboxDetailView.jsx`). Test: open an inbox item, open Context, names are A–Z.

**3. Context detail.** One list of merged rows; tapping a merged row opens item detail; the
tag filter applies to all rows and the status counts follow it. Test: a context with an item
and its intention shows one row; tag filter changes the counts.

**4. Intentions list.** Merged rows; "Last modified" orders strictly by the date the card
shows. Test: change one intention, sort by Last modified, it moves to the top.

**5. Recurrence in plain words.** Kind + next occurrence; once = none; every live shape incl.
null. Test: rows for daily, weekly, monthly, interval and once intentions read correctly.

**6. Next date.** Pure function and tests including the Micro Workout case.
Test: unit tests; close a daily run started yesterday → next event today.

**7. Completion dialog.** Shows the next date, editable. Test: Complete a recurring run, change
the date, the new event lands on it.

**8. Done.** Done on a recurring intention without a run. Test: last done moves; next event by rule.

**9. Skip.** Skipped execution + history line; Undo; EventCard Archive Event = Skip.
Test: Skip; last done does not move; next date by rule; Undo restores.

**10. Stop.** end_date = today, background, Cancel/Keep question when needed.
Test: Stop with and without a live event/reminder; row reads "Ended".

**10a. Close reason, front end** (spec "Close reason"). One pop-up wherever Closed can be
chosen (item and intention status pills, both edit forms on Save, item/merged row Close,
intention row Close): Completed / Won't do, optional note, and the events/reminders question.
Completed creates the closed `done` execution on the picked intention only when none exists
(no next event, even recurring); otherwise notes are standalone. Disabled while a run is
open. Reuses Step 8's no-run Done execution code. `closed_reason` is held, not written, until
11a. Test: each of the six places shows the pop-up; Completed on a recurring intention
makes no next event; Won't do makes no execution; Undo removes what was created.

**11. Database step.** Migration (recent completions + skipped, drop is_item, reminders in
realtime, `closed_reason` on items and intents, status_guard exception for closed → someday
shortly after a close, `get_intents`/`get_items` return `closed_reason`) and mcp deploy.
The backfill list of existing closed records is proposed here for Alex to review.

**11a. Close reason, finish.** Write `closed_reason` from the pop-up; Undo may return a
record to Someday; apply Alex's reviewed backfill (unlisted rows stay null).
Test: close with each reason, check the column; Undo a close of a Someday record.

**11 (continued).** Migration and mcp deploy. Starts only after warren's mcp work is in main and `gitsync` here.
Before the drop: stale-tab guard, `withoutDbOwned` in `src/utils/storage.js` strips `is_item`
on intents writes (approved, claimed 2026-10-13).
Test: SQL verification; skipped line visible; reload the app after the drop.

**12. Reminder badges.** `useRealtime` subscribes to reminders and refreshes the index.
Test: add a reminder on detail, go back, the card badge is there without reload.

## Log
- 2026-10-13 Step 1 code done. Related tests pass (intentionRows, intentions, contexts).
  `deno check` not run: the local deno cache lacks the supabase-js npm packages.
- 2026-10-14 Step 5 COMPLETE, all testing passed. In full: one repeat formatter
  (`recurrenceDisplay.js`) everywhere, with next on intention detail only and honest wording
  for legacy no-day shapes; picker presets read as the repeat line; rows are four lines
  (name clamped to two with a tooltip / one-line status, context, fitted tags / when with
  the repeat / dates); Related Intentions use RowList with Close. Last fixes: a row with
  a tag always shows at least one (the context label shrinks to leave room, `minTagWidth`);
  item detail's "Executions (n)" is now the shared InProgressSection, "In progress (n)",
  with its run notes kept under each card (`extraFor`).
- 2026-10-14 Step 5 follow-ups 2 (four-line rows part 1 passed): row names clamp to two
  lines with a tooltip; line 2 is one line (RowMetaLine), context label truncates, tags fit
  the width by measurement (fallback two). New `TagChips.test.jsx`.
- 2026-10-14 Step 5 follow-ups: rows are four lines (name / status, context, tags / when
  with schedule state and, if repeating, the Repeat icon and text / dates); no "Does not
  repeat" on rows; new shared `src/shared/TagChips.jsx`. Item detail's Related Intentions
  go through RowList: Close not Archive, same rules. Alex agreed the three Step 5 decisions.
- 2026-10-14 Step 5 built: one formatter, `src/utils/recurrenceDisplay.js` (`repeatPattern`,
  `describeRepeat`, `getRecurrenceDisplayString` kept for the picker and triage), used by
  rows (IntentionCard, so context detail, Intentions and item detail's intention list),
  intention detail ("Repeats: …"), the repeat picker's preset labels and selected label,
  inbox triage and the recycle bin. "Next" is the live event's date, shown on intention
  detail only when it is today or later (rows already show it in the schedule line). Ended
  = end date today or earlier. New `recurrenceDisplay.test.js`.
- 2026-10-14 Step 4 COMPLETE, all testing passed. In full: the Intentions list on the shared
  row model (`listRows`, `RowList`) with merged rows, item status, Close not Archive, item
  rows with Start Now/Schedule; bug (a) fixed (every row follows the chosen sort); context
  labels on item rows; the "In progress" section (shared `InProgressSection`, also Home's
  list) above the search on Intentions and context detail, its rows out of the list and
  counts; one full-page context edit form from Edit and the Contexts gear, Archive Context on
  it (red outline, confirm, empty-context rule, Undo); Archive Collection red outline; the
  duplicate run card fixed (`withActive`); close reason designed (spec; steps 10a, 11, 11a).
  Also: `PendingReminder.test.jsx` "clears the past-time error" no longer depends on the clock.
- 2026-10-14 Step 4 follow-ups 2: one context edit page (full page on context detail,
  reached from Edit and from the Contexts gear; returns to where you came from; no inline
  form, no "Close"); not its own URL because `src/viewPaths.js` is held by
  warren_buffet_p2-m4t. Start Now and resume no longer add a run realtime already added
  (`withActive`). Close reason designed (spec), steps 10a, 11, 11a.
- 2026-10-14 Step 4 follow-ups (testing passed parts 1-4 first): context label on item rows;
  "In progress" section (shared `InProgressSection`, Home now uses its `ExecutionList`)
  above the search on Intentions and context detail, its rows out of the list and counts,
  pin-to-top removed (`rankRows` deleted); Archive Context moved to the edit form with a
  confirm, red outline; Archive Collection red outline. Found: Home's two "p4 test" cards
  are ONE execution held twice in browser state (see report s5b), not a database breach.
- 2026-10-14 Step 4: the Intentions list uses the same row model and rendering as context
  detail. Shared: `listRows` (rowModel: search, tag, status, sort, counts that apply every
  other filter) and `src/shared/RowList.jsx` (row rendering + Close), both used by
  ContextDetailView and IntentionsScreen; Alfred no longer builds the Intentions list.
  Intentions list: one row per item (items with no intention left out), item status on
  merged rows, Close not Archive, item rows with no pick get item detail's Start Now and
  Schedule, merged rows open item detail. Bug (a): `rankRows` now lifts only open runs
  (active, then paused) and keeps the chosen sort for every other row, on both screens, so
  "Last modified" orders by the date the card shows. Merged rows' reminder badge: the picked
  intention's, else any of its intentions'.
- 2026-10-14 Step 3 COMPLETE. Last fix: tag counts ignored the search (TagFilter was fed
  rows filtered by status only; "Tags (n)" counts distinct tags among those rows). Now fed
  rows filtered by search and status chips, so each tag counts the rows it would show and
  "Tags (n)" counts only tags with a matching row. Step 3 in full: one "Items and intentions"
  list; merged rows show the item's status with the picked intention's schedule and repeat
  lines; Close replaces Archive on every row (one question, Undo, disabled during a run,
  hidden on Closed rows); item rows without a live intention get item detail's Start Now
  and Schedule; status and tag counts each apply every other filter; bug (c) fixed.
- 2026-10-14 Step 3 fixes: (1) chip counts ignored the search text (counted before the
  search filter); now tag and search filter first, so each chip counts the rows it would show.
  (2) Item rows with no live intention get item detail's Start Now (`startNowFromItem`) and
  Schedule (`scheduleFromItem`) in the same right-hand strip as other rows, disabled on
  Closed items; Close keeps its rules.
- 2026-10-13 Step 3 fix: merged rows show the ITEM's status (spec status rule); no pick when
  every intention is closed ("Not scheduled"); Close hidden on rows that read Closed.
- 2026-10-13 Step 3 follow-up: Close replaces Archive on every row (spec "Close on list
  rows"). New `src/shared/useRowClose.jsx` + test, `closeRecords` + new
  `useIntentionActions.test.js`; StatusEventsSheet takes `eventCount` and `title`;
  `refreshReminderIndex` now reaches `useIntentionActions`. Suites 2458/2458, 224/224.
- 2026-10-13 Step 3: context detail's Items and Intentions sections are one "Items and
  intentions" list from `buildRows`. A row with an intention renders as IntentionCard (`row`
  prop: item name and icon, union tags, latest update; opens item detail; no Archive); an
  item with none renders as ItemCard. Ranked by `rankRows`. Tag filter and chip counts apply
  to every row. Suites 2441/2441, 224/224.
- 2026-10-13 Step 1 checkpointed (c018a23). Step 2 rowModel + tests done; inbox Context
  picker sorted. storage.js claimed for Step 11's guard.
