# Restructure Phase 3 — progress

Inbox and capture.
Worktree / owner: `restructure_p3-x4n`
Spec: `docs/technical-spec-restructure_p3.md`

- [x] 1. Spec and progress docs (2026-10-11).
- [x] 2. Done 2026-10-11: `116_restructure_p3_apps_and_inbox_outcome.sql` applied, CONFORMANT (60 tables). The only notice was 0 contexts named "Body, Mind and Spirit", as expected. Migration only, no deploy:
  - apps table with description, seed and register_table
  - `contexts.app_id`, with Body, Mind and Spirit set to arnold
  - `inbox.source_app` and `inbox.outcome`
  - `job_applications.source_inbox_id`
  - source_metadata trigger and backfill
  - corrected archive_reason comment
  - conformance
- [x] 3. App picker on the context form (built and verified 2026-10-11: every phone test passed, and it was checkpointed). The form's native select is led by the chosen app's icon, with a "No app" option. The context page shows "App: <icon> <name>" under Keywords. The new `src/apps/` holds AppIcon, AppSelect, appsApi and useApps (one read per page load). `contextFormValues` is the single normaliser for both the initial state and the dirty check.
  - Test: link "Alex (body, mind, spirit)" to Arnold from the form; reopen it and the app is still Arnold.
- [x] 4. Inbox detail App picker; processing writes outcome and source_app (built and verified 2026-10-11 in Chrome mobile view; the query showed jobs, warren_buffet, null app and discarded as expected).
  - The App picker sits beside Context. It is seeded from `sourceApp`, blank when unset, and never filled from the context.
  - `detailBaseline()` is the single seed and dirty-check baseline.
  - The app travels as `onProcess`'s third argument, `{ sourceApp }`. One tap leaves it out and keeps the capture's app, so the one-tap parity test is untouched.
  - Processing is not atomic: each record saves on its own. `outcome` (items, intents, events, appended to any earlier outcome) and `source_app` go in the same update that archives the row.
  - Discard spreads the row, so `sourceApp` and `outcome` are unchanged.
  - The dormant collection branch adds no outcome entry.
- [x] 5. Inbox list: processed captures grouped under their app with its icon and an outcome line. Open captures stay grouped by source_type. (Built and verified 2026-10-11 in Chrome mobile view; the P3 test records were archived and deleted afterwards.)
  - Recently archived (and Show all, the same list) is grouped by `groupArchived`: app groups in `public.apps` order (by name; the table has no sort column), then No app, then Discarded. Only non-empty groups show.
  - Each processed row has an outcome line using the RecordLinks pattern (EventMetaLink with ObjectIcon). Each record opens `/<id>`; a missing record reads "<Type> deleted".
  - `useOutcomeNames` makes one query per table.
  - Rows are unchanged otherwise: not cards, and they don't open the capture.
- [x] 6. Intention detail: set a reminder at an exact date and time, list it, cancel it. The same cancel goes on inbox detail. (Verified 2026-10-11 in Chrome and on the phone: the notification arrived and the tap opened the intention.)
  - Inbox detail: `PendingReminder editable` shows a grouped list (NOTE_LIST) of pending reminders in Pacific time, with a red-outline Cancel (confirm, then state cancelled with reason manual). No Add.
  - The item page keeps the read-only line.
  - Tapping the notification opens `/intentions/detail/<id>` (notify-dispatch `reminderPath`).
  - List-card reminder badges refresh on reload, not instantly after an add or cancel.
  - **Follow-up A** (built 2026-10-11; awaiting a Chrome test): compact lines on the intention page, under the schedule line.
    - `IntentionReminderLines` shows "Reminder · <PT time>" per pending reminder with a red Cancel link, then an "Add reminder" link.
    - Add opens `SchedulePopover` in its new time mode (`initialTime`, `fieldLabel` "Remind me at", `onPick(date, time)`), anchored like Schedule. It shows date and time inputs at the next whole hour, with a brown Set reminder and a beige Cancel. Local time is stored as UTC through `create_reminder` with `p_intent_id`.
    - Add is disabled, with the closed title, when Start Now and Schedule are. Pending lines and their Cancel still show on a closed intention.
    - Cancel is confirm only, with no toast and no Undo.
    - There's no grouped section on the intention page.
    - Testing 2026-10-12: the compact line, the Background and Closed sheets, archive (cancelled as intent_archived) and restore (back to scheduled) all passed. **Step 6 verified.**
    - A past time shows an inline red error inside the popover (`SchedulePopover` `validate` prop), not an alert. The popover stays open with what was entered, and changing either input clears the error. Schedule's own popover had no alert, only a disabled button with no date.
  - **Follow-up B** (built 2026-10-11; 119 applied, CONFORMANT; awaiting a Chrome test):
    - The Background and Closed sheet (`StatusEventsSheet`, `sheetWording`) counts the live event and pending reminders and appears for reminders alone. One answer covers both.
    - "Cancel" sets cancel_reason `intent_status`, and Undo re-arms those that are still ahead (`cancelRemindersForStatus`, `restoreRemindersAfterStatus`).
    - Migration `119_restructure_p3_reminders_follow_intent.sql` allows the `intent_status` and `intent_archived` reasons.
    - Trigger `reminders_follow_intent_archive` (SECURITY DEFINER): archive cancels as `intent_archived`; un-archive re-arms only `intent_archived` reminders still in the future.
- [ ] 7. Copy button on item and intention detail.
- [ ] 8. After warren_buffet_p2-m4t finishes and gitsync:
  - tool changes, including a new tier-1 `get_apps` (tool count 113 → 114)
  - index.test.mjs schema checks
  - alfred-enrich skill text
  - re-register `public.clips` to correct its registry note, which still says triage hard-deletes inbox rows
  - mcp deploy

## Decisions (2026-10-11)
- App descriptions approved: alfred, workshop and arnold rewritten by Alex; the rest kept as drafted.
- Enrichment reads apps through a new tier-1 `get_apps` tool in step 8. `get_contexts` also gains `app_id`.
