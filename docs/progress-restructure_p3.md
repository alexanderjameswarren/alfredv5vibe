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
- [ ] 3. App picker on the context form.
  - Test: link "Alex (body, mind, spirit)" to Arnold from the form; reopen it and the app is still Arnold.
- [ ] 4. Inbox detail App picker; processing writes outcome and source_app.
- [ ] 5. Inbox list: processed captures grouped under their app with its icon and an outcome line. Open captures stay grouped by source_type.
- [ ] 6. Intention detail: set a reminder at an exact date and time, list it, cancel it. The same cancel goes on inbox detail.
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
