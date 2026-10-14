# Restructure Phase 4 — progress

Spec: `docs/technical-spec-restructure-p4.md`. Owner: `restructure_p4-v9k`.
Test every step in desktop Chrome's mobile view against the local dev server.

| # | Step | Status |
|---|---|---|
| 1 | is_item out of the code; MCP select, types, recurring_only | Done, checkpointed c018a23 |
| 2 | Row model (pure, tested) + extra: inbox Context picker sorted | Done, tested 2026-10-13 |
| 3 | Context detail: merged rows + bug (c); Close replaces Archive on rows; fixes from testing | Done, tested 2026-10-14; awaiting Checkpoint |
| 4 | Intentions list: merged rows + bug (a) | |
| 5 | Recurrence in plain words | |
| 6 | Next-date function + `triggerRecurrence` takes a date | |
| 7 | Completion dialog: next-date field | |
| 8 | Done control | |
| 9 | Skip control (+ EventCard Archive Event → Skip; audit closed-as-done readers) | |
| 10 | Stop control | |
| 11 | Database step (waits on warren_buffet_p2-m4t) | |
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

**11. Database step.** Migration (recent completions + skipped, drop is_item, reminders in
realtime) and mcp deploy. Starts only after warren's mcp work is in main and `gitsync` here.
Before the drop: stale-tab guard, `withoutDbOwned` in `src/utils/storage.js` strips `is_item`
on intents writes (approved, claimed 2026-10-13).
Test: SQL verification; skipped line visible; reload the app after the drop.

**12. Reminder badges.** `useRealtime` subscribes to reminders and refreshes the index.
Test: add a reminder on detail, go back, the card badge is there without reload.

## Log
- 2026-10-13 Step 1 code done. Related tests pass (intentionRows, intentions, contexts).
  `deno check` not run: the local deno cache lacks the supabase-js npm packages.
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
