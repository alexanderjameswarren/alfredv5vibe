# Restructure Phase 4 — progress

Spec: `docs/technical-spec-restructure-p4.md`. Owner: `restructure_p4-v9k`.
Test every step in desktop Chrome's mobile view against the local dev server.

Testing notes:
- Each part: what it tests and why, "Set up", then "Testing", numbered continuously, one app
  action per step with its expected result. Reuse the named test records.
- Never put Undo in a separate step. The toast disappears while Alex reads the next step, so
  Undo goes in the SAME step as the action ("tap Log, then tap Undo on the message straight away").

| # | Step | Status |
|---|---|---|
| 1 | is_item out of the code; MCP select, types, recurring_only | Done, checkpointed c018a23 |
| 2 | Row model (pure, tested) + extra: inbox Context picker sorted | Done, tested 2026-10-13 |
| 3 | Context detail: merged rows + bug (c); Close replaces Archive on rows; fixes from testing | Done, checkpointed d00dfcf |
| 4 | Intentions list: merged rows + bug (a); follow-ups (In progress section, context edit page, archive buttons, duplicate run card) | Done, checkpointed 59a700b |
| 5 | Recurrence in plain words; follow-ups: four-line rows, Related Intentions close, name clamp, one-line line 2 | Done, checkpointed e8a7b0c |
| 6 | Next-date function + `triggerRecurrence` takes a date (+ item detail duplicate fix, no "next" in repeat lines, repeat-dialog number boxes) | Done, checkpointed 858e4f5 |
| 7 | Completion dialog: next-date field, Completed on; no past event dates; edit a completed date | Done, checkpointed d3bbf2d |
| 8 | Log Execution (was Done/Complete) + header fix; follow-ups: rule A, one-time intentions and items, ActionBar, CopyButton, hidden while open, one Cancel, no repeated tooltips | Done, tested 2026-10-19 |
| 9 | Skip control (+ EventCard Archive Event → Skip; audit closed-as-done readers); follow-ups: Recent executions with skips in line and Show all, Delete Execution on closed executions, Skip Undo fix, recycle bin hides skips, Undo audit | Done, tested 2026-10-19 |
| 10 | Stop control ("Stop repeating"); follow-ups: past-due events ask, "this event" wording, one merged toast | Done, tested 2026-10-19 |
| 10a | Close reason, front end: one Close pop-up in all six places (choice, note, events/reminders question), execution/note creation, disabled rule; follow-ups: shared toggles with icons, pop-up at the page root | Done, tested 2026-10-19 (reason and Closed on saved from Step 11) |
| 11 | Database step (waits on warren_buffet_p2-m4t), incl. `closed_reason`, status_guard Undo exception, MCP fields, backfill list | Migration 139 applied and checkpointed 2026-10-19 (094ab5f; CONFORMANT, 67 tables; db: claims released). Waiting: the is_item drop (pending file), the mcp and ai-enrich deploys |
| 11a | Close reason, finish: write `closed_reason`, Undo back to Someday, review and apply the backfill | Done with Step 11 (139 and `CLOSE_REASON_SAVED`), tested 2026-10-19 |
| 12 | Reminder badges via realtime (+ Step 11 fix: Delete Execution removes an event Start Now created) | Done, tested 2026-10-19; last-done loose end resolved |

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

**11. Database step.** Migration (drop is_item, reminders in
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
Loose end to settle here (from Step 7): after a completion, the intents realtime UPDATE
carrying the trigger-written `last_completed_at` never reached the app, cause unknown;
Step 7 works around it by re-reading (`refreshCompletedRecords`). While wiring realtime,
find out why that update did not arrive, and report it.
Test: add a reminder on detail, go back, the card badge is there without reload.
As built (2026-10-19): a `reminders-changes` channel (user-filtered) in `useRealtime`;
any change re-runs `refreshReminderIndex` and fires `remindersChanged()`
(`useReminderIndex.js`), which the intention page listens to (`onRemindersChanged`) to
re-read its reminder lines. Loose end, findings: RLS is not the cause (intents_access is
owner-or-shared, evaluable by realtime). No migration ever added intents, items, events
or executions to `supabase_realtime` (only 139 adds reminders), and the snapshot does not
dump publications, so whether they are in it is checked live (testing Part 1). Found and
fixed in this project's files: four state writes rebuilt lists from a stale copy
(`setIntents(intents.map…)`, `setEvents(events.map…)` in useIntentionActions,
useEventActions, useExecutionActions), which overwrite a realtime update that arrived
meanwhile; now functional updates. Not ours: `useItemActions.js:50` has the same pattern.

## Log
- 2026-10-13 Step 1 code done. Related tests pass (intentionRows, intentions, contexts).
  `deno check` not run: the local deno cache lacks the supabase-js npm packages.
- 2026-10-19 Step 12 complete (all four parts passed). Realtime check: intents, items,
  events, executions and reminders are all in supabase_realtime, replica identity
  default. LOOSE END RESOLVED: the last_completed_at update did arrive by realtime; it was
  overwritten by the stale-copy list writes (`setIntents(intents.map…)` and the like),
  now functional updates. Log Execution in tab 2 updated tab 1's card (last done Oct 17 ->
  Oct 19, next Tue Oct 20) without a reload. Step 11a marked done: its work shipped in 139.
  Still open, all waiting on others: the mcp deploy (warren_buffet_p3-q5k holds
  mcp/index.ts), the ai-enrich redeploy, then `_pending_restructure_p4-v9k_drop_is_item.sql`.
- 2026-10-19 Step 11 testing passed (all three parts). Fix: Delete Execution also deletes
  an event Start Now created. No column: Start Now writes the new event's createdAt and the
  execution's startedAt from one timestamp, and `restoreStartNow` deletes the event only
  when the two match to the millisecond and the event is still live on that day; events
  that existed before can never match. Then Step 12 built (see Step 12 above).
- 2026-10-19 Step 11 applied: migration 139 run by Alex, verification matched (six new
  columns, none unfilled, reminders in realtime, nine 'done' rows, new guard comment);
  CONFORMANT (67 tables); checkpointed (main 094ab5f), all six db: claims released.
  Snapshot note: main's schema-snapshot.sql content includes 139, but its header says
  "through migration 138" — scripts/schema-snapshot.mjs labels it with the highest file in
  the main checkout's migrations folder, read before the merge brought 139 in.
  Still waiting: `_pending_restructure_p4-v9k_drop_is_item.sql` (after ai-enrich and mcp
  redeploy); the mcp deploy (Warren holds mcp/index.ts) and ai-enrich deploy.
- 2026-10-19 Step 11 follow-up, WAITING: the `intents.is_item` drop moved to its own
  migration, `_pending_restructure_p4-v9k_drop_is_item.sql`. Deployed check: mcp v155
  (2026-10-19, from warren_buffet_p3-q5k) already has Step 1's change; ai-enrich v18
  (2026-09-25) predates it and still selects is_item. Apply the drop after ai-enrich is
  redeployed from main (and the Step 11 mcp deploy, which waits on Warren's mcp file).
  Alex reviewed: status_written_at agreed; all eight backfill ids are closed (four
  intents incl. mue50pca5iavc7gwjqd under item mue50p2vjlonxqxsz, five items).
- 2026-10-19 Step 11 written for review (spec "Database step", As written): one pending
  migration, app code behind `CLOSE_REASON_SAVED = true`, MCP handler changes. No drift
  from the sync (124-138 are Warren Buffet, email capture). Conflict: mcp/index.ts held by
  warren_buffet_p3-q5k. Nothing applied, deployed or db:-claimed.
- 2026-10-19 Step 10 follow-up tested (labels, merged toast). Fix: Undo reverses the
  status too. `useStatusSync` settle returns `{ moved, restore }`; Schedule, Schedule
  from an item and Log Execution restore flipped statuses in their Undo (new
  useStatusSync.test.js). No Undo exists on Start Now or inbox Process, so no gap there.
- 2026-10-19 Step 10 complete (all four parts passed). Alex decided: Reschedule does not
  un-park; past-due events ask, in Stop and Close; Step 11 restores status_changed_at on
  Stop's Undo. Follow-ups built: "Stop repeating"; "Archive this event" / "Keep this
  event" / "Closing archives this event."; Schedule's two toasts merged into one ("…
  Moved to Active."); status names capitalised in messages ("is Closed").
- 2026-10-19 Step 10 (Stop) built (spec "Stop, as built"): CircleStop button after Log
  Execution on intention and item pages, hidden while open and once ended; the one
  question when something is pending; Background + end date today; Undo stops at a
  failed write. Open: Undo cannot restore status_changed_at until Step 11; a kept live
  date rescheduled is an update, so it does not flip Background back to Active.
- 2026-10-19 Step 10a follow-up tested (icons; Cancel keeps both edit forms). Then the
  toggles took the inbox's style: `ToggleButton` has one style by `tone`, filled when
  chosen; the inbox is unchanged, only the Close pop-up's toggles changed. New
  ToggleButton.test.jsx.
- 2026-10-19 Step 10a complete (all four parts passed; Alex confirmed: item pill and edit
  form close the item's open intentions too; nothing preselected when nothing is done).
  Follow-ups: Completed / Won't do use the new shared `ToggleButton` (the inbox's section
  toggles now use it too), chosen = brown outline and text, Check and Ban icons;
  `CloseDialog` renders at the page root (portal) so the edit form under it cannot take
  its taps; tests for Cancel from both edit forms keeping the form and its changes.
- 2026-10-19 Step 10a built (the prompt called it "Step 10"; the table's 10 is Stop, still
  to do). One `CloseDialog` in all six places through `closeRecords`; Completed with none
  done records a done execution on the picked intention dated Closed on (no next event);
  otherwise a standalone note; Undo removes it first and stops on a failed write; Closed
  disabled with "Finish the execution first" in the pill menu and edit-form picker. Item
  pill and edit form now close the item's open intentions too (for Alex to confirm). The
  reason and Closed on are held, not saved, until Step 11 (`CLOSE_REASON_SAVED`).
- 2026-10-19 Step 9 complete (follow-up testing passed). Last follow-ups: "Show all (N older)"
  under Recent executions, the inbox "Recently archived" control (no Phase 2 view-all page
  existed; `countRecentExecutions`, reads up to 50 of each kind, the completions function's
  cap); Undo audit: every Undo in files this project holds now stops at a failed write
  (Schedule, Schedule from item, Archive intention, Moved to, Close, Archive Context, Skip's
  next date, Log Execution, which now removes the execution first). Not held, listed for
  Alex: `useItemActions` (archive item, item status), `useCollections` (archive collection),
  `useInboxActions` (discard). Open, for Alex: Start Now moves a future date to today and
  Delete Execution leaves it there (recommendation in the spec, Step 9 follow-ups).
- 2026-10-19 Step 9 tested (all three parts passed); follow-ups built (spec "Step 9
  follow-ups"): one "Recent executions" list of five, skips in line; Delete Execution on
  completed and skipped executions (confirm, no Undo; trigger already recomputes last done
  on delete); Skip Undo removes the skip first and stops if it cannot; recycle bin hides
  skips. Checked: "P4 daily test" has two skipped executions, mvfcg01hif04synncy (event
  Oct 18, kept, from Part 1) and mvfcojrwezus2ig9kj (event Oct 19, 14:29 UTC, left by the
  Edit Event Skip + Undo); Alex deletes it in the app.
- 2026-10-19 Step 9 built (spec "Skip / Done / Stop", As built). Skip writes a closed
  `skipped` execution, archives the date, next date by rule, toast "Skipped …" with Undo;
  one-time archives write none; EventCard edit form: Skip on a repeat (hidden while open),
  Archive Event on a one-time date; "Skipped: …" line (`RecentSkips`) apart from Recent
  completions; execution page reads "Skipped". Step 11's recent-completions change dropped.
  Audit left for Alex: recycle bin lists skips; MCP history tool wording.
- 2026-10-19 Step 8 complete (all four follow-up parts passed). Last fixes: one `CancelButton`
  (X icon, light neutral, beside the main button) in Log execution, Complete, Completed on,
  Schedule/Reschedule, the close question, the repeat dialogs and Clone; no tooltip where the
  reason line shows (Start Now, Schedule/Reschedule on both detail pages, EventCard date);
  "Pause or delete it" (and "Finish or delete", "Complete or delete" in the two older
  reasons); the intention page uses `InProgressSection` ("In progress (1)").
  Known limit (Step 11): an item that was Someday stays Active after Undo.
- 2026-10-18 Step 8 follow-ups 2: "Log Execution" replaces Complete on intention and item
  pages (pop-up "Log execution", button "Log", toast "Logged an execution on …"; icon
  NotebookPen; `logAction`); Log Execution and Skip are hidden while an execution is open;
  the record table is in the spec and matches the code; Recent completions reloads at once
  (`completionsChanged`, new RecentCompletions.test.jsx). Checked: "p4 interval test"'s two
  "Friday, October 16" entries are two real done executions (no skipped one listed; the
  list's function only returns done).
- 2026-10-17 Step 8 follow-ups (spec "Step 8 follow-ups"): rule A for fixed schedules;
  Next shown for someday repeats; Complete on every non-closed intention (one-time ones
  close) and on items (creates an intention as Start Now does when there is none); Skip only
  on a repeating intention with a live date; shared ActionBar (fit to width, ⋯ for the rest)
  on intention and item detail; shared CopyButton (icon after the title on intention, item
  and inbox detail; labelled on the inbox task card), old Copy buttons removed. New:
  ActionBar.jsx/.test, CopyButton.jsx/.test; InboxListCard.jsx/.test claimed.
- 2026-10-17 Step 8 built. Intention detail of an ACTIVE-or-other non-closed repeating
  intention has a brown "Complete" (the Done control, labelled with the app's word), which
  opens the same Complete pop-up (Completed on, Next, note) and calls `markDone`: a closed
  `done` execution on the live event (or on a new event dated that day, inserted already
  archived), the note on it, the event archived, the next event on the chosen Next, rows
  re-read; toast "Completed on …" with Undo (removes execution and next event, restores the
  date). Disabled with "Finish the execution first" while an execution is open. Shared
  `nextForCompletion` (recurrence.js) now feeds both pop-ups. Also: a completed execution's
  header no longer shows the scheduled date. Tests in useExecutionActions.test.js,
  IntentionDetailView.test.jsx, ExecutionDetailView.test.jsx.
- 2026-10-17 Step 7 COMPLETE. Last additions: Change on a completed execution's date
  (`CompletedOnDialog`, `changeCompletionDate`; any past day; events untouched); no
  migration needed, the 100 trigger already keeps last_completed_at at the latest done
  date when closed_at changes; rows now refresh "last done" at once (`refreshCompletedRecords`
  re-reads the intention and item after a completion or a date change, instead of relying on
  the realtime message). Designed: an automatic close on completion saves reason 'done' and
  the Completed on date. Step 7 in full: Next date and Completed on in the Complete pop-up,
  no past event dates anywhere a person picks one, edit a completed date.
- 2026-10-16 Step 7 fixes from testing: Completed on has no lower limit (any past day,
  never ahead; Closed on in the design likewise); the picker carries only max=today (the
  "all days greyed" report: see report s8c); while picking, the picker replaces the date
  line (one date, one label) for Completed on and Next; no "run" in any new message.
- 2026-10-16 Step 7 follow-ups: "Completed on" in the Complete pop-up (all runs; back to
  the start day, not ahead; sets closed_at via `closedAtFor`; moves an interval repeat's
  Next unless Next was changed by hand); no past event dates in SchedulePopover (`minDate`,
  four call sites), the event edit form and inbox triage (fixtures moved to future dates in
  InboxDetailView.test and oneTapMatchesDetailPage.test). "Closed on" designed for 10a/11.
  Execution page header shows the event's scheduled date (`formatEventDate(event.time)`).
- 2026-10-16 Step 7 built. The Complete pop-up, for an ACTIVE repeating intention, shows
  "Next: Saturday, October 17" with the repeat line under it (describeRepeat) and a Change
  link opening a date input in the pop-up; dates before today, or after the repeat's end,
  are refused with the reason. An ended repeat reads "Repeat has ended". The default is
  `nextOccurrence` (ExecutionDetailView); the chosen date goes `onComplete(text, date)` →
  `closeExecution("done", { nextDate })` → `triggerRecurrence(…, { nextDate })`. One-offs and
  non-active intentions show nothing new. Tests: CompleteNoteDialog.test.jsx (new),
  ExecutionDetailView.test.jsx.
- 2026-10-16 Step 6 follow-ups 2: interval repeats read "N days after last completion";
  the "Repeat after completion" dialog reads "Schedule next event / [N] [unit] after last
  completion" with the number and unit kept together; Archive in the intention, item and
  event edit footers is the red outline. EventCard.jsx newly claimed.
- 2026-10-14 Step 6 COMPLETE (testing passed). Follow-ups: the repeat line never says
  "· next …" (the schedule line carries the date; "until" and "Ended" stay); the repeat
  dialogs' number boxes use a new shared `src/shared/NumberInput.jsx` (raw text, select on
  focus, "Required" and Done disabled when unusable), with tests for it and both dialogs.
- 2026-10-14 Step 6 built. `nextOccurrence` in `src/utils/recurrence.js` (fixed: first
  occurrence after the event's date, stepped forward to today at the earliest; interval:
  completion + interval; interval skipped: skipped date + interval, clamped to today), with
  `recurrence.test.js` incl. the Micro Workout case. `triggerRecurrence(intentId, event,
  { nextDate, skipped })` uses a given date or that rule; completion passes nothing, the
  existing Archive Event path passes `skipped: true` (the skipped history line is Step 9);
  end date compared as dates. New `useEventActions.test.js`. Also: item detail no longer
  lists an intention with an open run under Related Intentions (it is in In progress), and
  that section's count and chips skip it.
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
