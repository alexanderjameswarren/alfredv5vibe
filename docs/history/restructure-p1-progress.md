# Restructure Phase 1 — progress

Spec: https://claude.ai/code/artifact/5aa5a63b-5d22-48a3-8c9a-dc1bc524f908
Worktree / owner: `restructure_p1-h4nz`

| Step | What | Status |
|---|---|---|
| 1 | Read-only plan | done 2026-10-06 |
| 2 | Migration: status, status_changed_at, is_reference, suggested_status, guard, activation triggers, platform_search_items | done: 088 applied 2026-10-06, verified, CONFORMANT (45 tables) |
| 3 | MCP and alfred-enrich skill | done: deployed 2026-10-06, verified live after a connector reconnect |
| 4–7 | Front end: inbox status, status control and events sheet, chips, archived view | built 2026-10-07, tests and build pass, awaiting phone test |

## Front end (2026-10-07)
- `storage.set` drops `status`/`status_changed_at` on UPDATE for items and
  intents; `storage.patch` is the only way status changes. INSERT keeps it.
- `useStatusSync.watchStatus`: before-status taken from the caller, re-read
  after the write, merged into state, "Moved to active" shown on a flip. Wired
  into moveToPlanner, triage with a date, activate, startNowFromItem,
  startNowFromIntention. A row created by the same action is re-read, never
  announced.
- `triggerRecurrence` makes no successor unless the intention is active (read
  fresh). `closeExecution` sets closed on a done one-off it archives.
- Chips on Intentions (hidden "no live event" filter removed) and Context
  detail; counts on every chip; saved per page in localStorage.
- StatusPicker on Item and Intention detail: someday only while still someday.
  Intention moves to background/closed: running execution blocks; live events
  open the sheet (Archive them / Keep them / Cancel).
- Inbox: one-tap Someday/Active on the card, Status control on the detail page,
  carried to the item and intention at Process.
- Archived section at the foot of Context detail, newest status change first.

## Step 2 (2026-10-06)
Migration `088_restructure_p1_status.sql`, run by Alex. Verified: items 396
active / 59 closed, intents 61 active / 132 closed, someday and background 0,
inbox 472 rows all someday, mismatches 0, `updated_at` untouched by the backfill
(only Alex's Water Plants edit), triggers `items_status_guard`,
`intents_status_guard`, `events_status_activate`, `executions_status_activate`
enabled beside `set_updated_at`, `platform_search_items` five arguments with
the same ACL. `check_platform_conformance` CONFORMANT (45 tables).

## Decisions (2026-10-06)
- Backfill: live rows active, archived rows closed. Closed does not archive: status is lifecycle, archived is visibility.
- Scheduling or executing a background record makes it active. Never closed.
- Chips: someday and active on by default; every chip shows its count, on or off.
- One `suggested_status` for both the item and the intention.
- Closing archives past-due and future live events.
- No gating on Do Today or Run Now: auto-flip with a "Moved to active" toast.
- Event and execution writes stay in the browser; the triggers are a safety net.
- MemoriesScreen is left alone.
- Backfill pauses set_updated_at around the archived-rows UPDATE; archived rows take updated_at as status_changed_at.
- No "recurring is active by construction" trigger: the event trigger is the one mechanism.
- platform_search_items keeps its exact ACL (PUBLIC, anon, authenticated, service_role); dropping anon is a separate change.
- 2026-10-07, after phone test 3: executing promotes someday only. Background stays parked when a kept event is done; only a NEW event (scheduling, Start Now's today event) unparks it. Sheet buttons read Archive / Keep / Cancel.
- 2026-10-07, after phone test 8: a new event also promotes the intention's item and its item_ids, from someday ONLY (migration `094_restructure_p1_event_promotes_item.sql`). The intention keeps someday-or-background. A recurrence successor copies item_ids, so background items would be unparked on every recurrence. Schedule Later and inbox triage now re-read the item too (`carriedItems`).
- 2026-10-07, after phone test 10: Done on a one-off closes it and no longer archives it. Closed = reached its end, worth keeping; archived = noise. If the one-off has other live events, DoneEventsSheet asks: "Done for good" closes it and archives them; "More to do" (or dismiss) leaves it active with its events live.
- 2026-10-07, step 18: closed blocks Start Now, Schedule and Create Intention (disabled, with the reason). Do Today removed; Schedule's picker defaults to today; Start Now first and teal. Editing an existing intention shows Save, Cancel and Archive only. Every item and intention card shows a status pill; Related Intentions on item detail has the status chips.
- 2026-10-07, step 19: item detail actions grouped Act (Start Now teal, Schedule, Create Intention) / Manage (Clone, Edit, Add to Collection) / Archive right; item Schedule makes a one-off intention and its event together. Edit forms carry the status picker (applies at once, apart from Save). Add Intention footer: Save and Cancel only. EventCard Start disabled on a closed intention's event.
- 2026-10-07, step 20: detail rows are Start Now (teal, the one primary) · Schedule · Edit · ⋯ on both item and intention; the menu holds Create Intention, Clone, Add to Collection, Archive (item) or Archive (intention). Labels at every width. Edit-form status waits for Save; the live-events sheet fires on Save. Run Now on an item skips closed intentions. Schedule picker opens away from the nearer screen edge.
- 2026-10-07, step 21: intention detail always shows Start Now, Schedule, Edit, ⋯ (the old "no events" gate removed); Start Now on an intention with a due live event runs that event rather than adding one. Detail-page status moved to a pill-with-caret menu beside the title (StatusMenu), no confirm; edit forms keep their picker.
- 2026-10-07, steps 22-24: ONE live event per intention, at most ONE open (active/paused) execution, any number of closed ones as history. Overdue is late, not a different state. Start Now runs/continues/moves the one event; Schedule becomes Reschedule (a move fires no status trigger). Item Schedule reschedules the Run Now target. Closing always archives the date (no Keep); parking may keep it. The event shows as a header line; "Previous executions" lists closed runs (stopgap until Phase 2's history). DoneEventsSheet removed. Enforced by `events_one_live_per_intent` and `executions_one_open_per_intent` (pending migration).
- 2026-10-08, step 26: the date cannot move while its run is ACTIVE (Reschedule disabled, EventCard date locked, moveToPlanner/updateEvent re-check the database); a PAUSED run's date may move. Item buttons target an intention with an open run first (`itemActionTarget`); simultaneous runs across an item's intentions stay allowed.
- 2026-10-08, step 27: intention lists rank by activity (open run active→paused, scheduled soonest, unscheduled, background, closed; `rankByActivity`) on item Related Intentions, the Intentions screen and context detail, the chosen sort ordering within each group. Execution detail links to its context, intention and item (Back lands on Home). Event edit form has a teal Start Now. Start/Continue are teal on every list.
- 2026-10-08, step 28: teal means running. Active execution cards (ExecutionBadge) are teal; paused stays amber; Start/Continue stay teal. Execution page buttons and Cancel's meaning reported, not changed.
- 2026-10-08, step 29: execution page footer is Delete Execution (red text, confirm — it deletes the row, no undo) … Pause (amber outline) or Make Active (teal) … Complete (brown). cancelExecutionForEvent now ends the notification chain before deleting.
- 2026-10-08, step 30: Delete Execution has a red outline; Pause is amber-tinted with its border; Complete is the only solid button. Paused cards stay amber. User-facing text says "execution", never "run".
- 2026-10-08, step 31: the When control's chosen answer is tan secondary, not teal. Intention-form When control held pending a decision (Target Start Date is dead; End Date is the recurrence stop date).
- 2026-10-08, step 32 (last Phase 1 build): intention edit form's When is Doesn't repeat / Repeat (shared WhenButton), with Repeat's "Ends on" as the only stop-date editor plus a "Remove end date" link; Target Start Date and End Date fields removed (columns kept). Inbox's New Intention toggle and the inbox card's Active pill are tan, not teal.
- 2026-10-08, step 33: the Linked Item badge on intention detail gets every intention, so a run belonging to another of the item's intentions shows its name. Tag chips on the Intentions screen and context Items count only status-filtered rows.
- 2026-10-08, step 34: context detail's item badges get every intention. Status chip counts follow the tag filter (`withTag`) on the Intentions screen and context detail. A record's name carries its type icon: context pills on intention cards, collection cards and execution badges; item references on item detail's element links and Add to Collection; context lines in the item pickers.
- For Phase 7, not now: if an event is only a date it may belong as a column on intents. Schedule/Today query events across intentions and executions reference event_id, so revisit when the schedule is rebuilt.
