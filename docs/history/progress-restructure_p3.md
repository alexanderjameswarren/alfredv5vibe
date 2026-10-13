# Restructure Phase 3 — progress

Inbox and capture.
Worktree / owner: `restructure_p3-x4n`
Spec: `docs/history/technical-spec-restructure_p3.md`

**Phase 3 complete (2026-10-12).** All eight steps verified. Migrations 116, 119 and 122 applied; mcp v149 deployed.

- [x] 1. Spec and progress docs (2026-10-11).
- [x] 2. Done 2026-10-11: `116_restructure_p3_apps_and_inbox_outcome.sql` applied, CONFORMANT (60 tables). Migration only, no deploy:
  - apps table with description, seed and register_table
  - `contexts.app_id`. No context is named "Body, Mind and Spirit", so none was linked (notice: 0 matched). Alex linked "Alex (body, mind, spirit)" from the context form in step 3.
  - `inbox.source_app` and `inbox.outcome`
  - `job_applications.source_inbox_id`
  - source_metadata trigger and backfill (1 wb-sync row set to warren_buffet)
  - corrected archive_reason comment
  - conformance
- [x] 3. App picker on the context form (verified 2026-10-11 on the phone, and checkpointed). The form's native select is led by the chosen app's icon, with a "No app" option. The context page shows "App: <icon> <name>" under Keywords. The new `src/apps/` holds AppIcon, AppSelect, appsApi and useApps (one read per page load). `contextFormValues` is the single normaliser for both the initial state and the dirty check.
- [x] 4. Inbox detail App picker; processing writes outcome and source_app (verified 2026-10-11 in Chrome mobile view; the query showed jobs, warren_buffet, null app and discarded as expected).
  - The App picker sits beside Context. It is seeded from `sourceApp`, blank when unset, and never filled from the context.
  - `detailBaseline()` is the single seed and dirty-check baseline.
  - The app travels as `onProcess`'s third argument, `{ sourceApp }`. One tap leaves it out and keeps the capture's app, so the one-tap parity test is untouched.
  - Processing is not atomic: each record saves on its own. `outcome` (items, intents, events, appended to any earlier outcome) and `source_app` go in the same update that archives the row.
  - Discard spreads the row, so `sourceApp` and `outcome` are unchanged.
  - The dormant collection branch adds no outcome entry.
- [x] 5. Inbox list: processed captures grouped under their app with its icon and an outcome line. Open captures stay grouped by source_type. (Verified 2026-10-11 in Chrome mobile view; the P3 test records were archived and deleted afterwards.)
  - Recently archived (and Show all, the same list) is grouped by `groupArchived`: app groups in `public.apps` order (by name; the table has no sort column), then No app, then Discarded. Only non-empty groups show.
  - Each processed row has an outcome line using the RecordLinks pattern (EventMetaLink with ObjectIcon). Each record opens `/<id>`; a missing record reads "<Type> deleted".
  - `useOutcomeNames` makes one query per table.
  - Rows are unchanged otherwise: not cards, and they don't open the capture.
- [x] 6. Reminders on intentions (verified 2026-10-11 and 2026-10-12, including the phone test: the notification arrived and the tap opened the intention).
  - Inbox detail: `PendingReminder editable` shows a grouped list (NOTE_LIST) of pending reminders in Pacific time, with a red-outline Cancel (confirm, then state cancelled with reason manual). No Add.
  - The item page keeps the read-only line.
  - Tapping the notification opens `/intentions/detail/<id>` (notify-dispatch `reminderPath`).
  - List-card reminder badges refresh on reload, not instantly after an add or cancel.
  - Follow-up A: compact lines on the intention page, under the schedule line.
    - `IntentionReminderLines` shows "Reminder · <PT time>" per pending reminder with a red Cancel link (confirm only, no toast, no Undo), then an "Add reminder" link.
    - Add opens `SchedulePopover` in its time mode (`initialTime`, `fieldLabel` "Remind me at", `onPick(date, time)`), at the next whole hour. Local time is stored as UTC through `create_reminder` with `p_intent_id`.
    - A past time shows an inline red error inside the popover (`validate` prop). The popover stays open with what was entered.
    - Add is disabled, with the closed title, when Start Now and Schedule are. Pending lines and their Cancel still show on a closed intention.
  - Follow-up B: pending reminders follow the intention.
    - The Background and Closed sheet (`StatusEventsSheet`, `sheetWording`) counts the live event and pending reminders and appears for reminders alone. One answer covers both.
    - "Cancel" sets cancel_reason `intent_status`, and Undo re-arms those that are still ahead.
    - `119_restructure_p3_reminders_follow_intent.sql` allows the `intent_status` and `intent_archived` reasons. Trigger `reminders_follow_intent_archive` (SECURITY DEFINER): archive cancels as `intent_archived`; un-archive re-arms only `intent_archived` reminders still in the future. Verified 2026-10-12.
- [x] 7. Copy button on item and intention detail (verified and checkpointed 2026-10-12).
  - Copy (ClipboardCopy icon, beige, `ACTION_BUTTON`) sits just before ⋯ on both pages and stays enabled when closed. It copies `recordCopyText` (`src/shared/copyRecord.js`): the title, then the description (left out when empty), then the link, separated by blank lines.
  - The pages report through `onNotify(message, { error })`. Alfred passes `notify`: the short toast with no Undo, red for an error.
  - `UndoMessage` shows Undo only when there is a restore, and has `tone: "error"`. `offerUndoFor(msg, null)` no longer wraps the null, which fixes the inbox "Copied" toast whose Undo failed with "Operation failed".
- [x] 8. Tools, skills and deploy (verified 2026-10-12 in a fresh claude.ai chat; mcp v149, CONFORMANT 62 tables).
  - create_inbox_item `source_app` (checked against apps; "job" refused with the valid ids); get_inbox returns `source_app` and `outcome`; update_inbox_item `source_app`
  - archive_inbox_item `outcome` (appended) and `source_app`, stamping `source_inbox_id` on outcome items, intents, events and job_applications (`linked_back`); the stale wording is fixed
  - create_job_application `inbox_id` → `source_inbox_id`; get_contexts returns `app_id`
  - new tier-1 `get_apps` (`_shared/tools/apps.ts`), tool count 116 → 117
  - index.test.mjs: count, get_apps and archive_inbox_item schema parity, source_app advertised
  - skills: alfred-enrich chooses an app from get_apps; job-search passes inbox_id and archives with an outcome
  - `122_restructure_p3_clips_registry_note.sql`: notes-only update of public.clips' registry row, not a re-register
  - deployed with verify_jwt false (checked)

## Decisions (2026-10-11)
- App descriptions approved: alfred, workshop and arnold rewritten by Alex; the rest kept as drafted.
- Enrichment reads apps through a new tier-1 `get_apps` tool in step 8. `get_contexts` also gains `app_id`.

## Later, not Phase 3
- Card reminder badges refreshing straight after an add or cancel (`refreshReminderIndex` is not passed to `useIntentionActions`).
- The in-app `ai-enrich` Edge Function choosing an app.
- An apps sort order column, if name order is not wanted.
