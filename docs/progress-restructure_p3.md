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
- [x] 6. Intention detail: set a reminder at an exact date and time, list it, cancel it. The same cancel goes on inbox detail. (Built 2026-10-11; awaiting tests in Chrome and on the phone.)
  - `PendingReminder` has an `editable` mode: a grouped list (NOTE_LIST) of pending reminders in Pacific time, with a red-outline Cancel (confirm, then state cancelled with reason manual). With `addText`, it shows "Add reminder": date and time inputs in the SchedulePopover style, defaulting to the next whole hour in local time, stored as UTC through the `create_reminder` RPC with `p_intent_id`.
  - With none pending, only Add shows. The inbox page has Cancel and no Add.
  - The item page keeps the read-only line.
  - Tapping the notification opens `/intentions/detail/<id>` (notify-dispatch `reminderPath`).
  - Not changed: archiving, closing or backgrounding an intention leaves its scheduled reminders firing. No trigger or app code touches them, and the dispatcher reads only state and due_at.
  - List-card reminder badges refresh on reload, not instantly after an add or cancel.
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
