# Inbox atomic (inbox_atomic-q7d) — progress

Bug (September): "Make inbox triage atomic — wrap the downstream writes in a transaction."
Restructure P3 left processing as separate writes on purpose (its spec, *Not in this phase*).
Fixed in main as its own project.

## Step 1 — investigation (2026-10-19, inbox_atomic-q7d-s1-k5dz)
- App Process (`handleInboxSave`, `src/inbox/useInboxActions.js`): item → intention → reminders
  move → event → collection member → archive, each a separate call from the browser.
- MCP `archive_inbox_item` (`supabase/functions/_shared/tools/clipboard.ts`): read outcome →
  update inbox → one link-back update per record, separate PostgREST calls.
- Edge functions only insert captures.

## Step 2 — database side (2026-10-19, inbox_atomic-q7d-s2-e7mq)
- `supabase/migrations/145_inbox_atomic_process_inbox_item.sql`: `process_inbox_item(text, jsonb)`
  and `archive_inbox_item(text, jsonb)`, security invoker, granted to authenticated only.
  Neither names `intents.is_item` (nullable, default false, so inserts need nothing).
- `supabase/tests/inbox_atomic/1_verify.sql` (verification, one JSON cell) and
  `2_failure_test.sql` (fails partway, proves nothing left behind, rolls itself back).
  Not migrations: written as 146 at first, moved out in s4b so a replay never runs them.
- Behaviour changes against today:
  - a failed reminders move now fails the whole Process (it was tolerated);
  - link-back stamps only the caller's own rows (it was any row RLS let through, shared contexts included);
  - processing an archived capture is refused (stops a double tap filing it twice);
  - an MCP link-back failure no longer leaves the capture archived.
- Not applied. Waiting for db:deploy (held by warren_buffet_p3-q5k).

- Alex approved all three behaviour changes (s3).

## Step 3 — callers wired (2026-10-19, inbox_atomic-q7d-s3-u6nb)
- `handleInboxSave` makes one `process_inbox_item` call (payload from `processInboxPayload`).
  On error: an alert, nothing on screen changes, the capture stays open. On success the
  screen takes the returned rows; an event still runs the status watch. No Undo, as before.
- `archiveInboxItemTool` makes one `archive_inbox_item` call; parameters, messages and
  result shape unchanged. `mcp/index.ts` and `tool-definitions.ts` untouched.
- Tests: `src/inbox/useInboxActions.test.js` rewritten; new
  `supabase/functions/_shared/tools/clipboard.test.mjs`.

## Step 4 — numbered (2026-10-20, inbox_atomic-q7d-s4-f3jx)
- Drift check after gitsync: 142 deletes P4 test rows only; 143-144 are Warren Buffet. No
  schema change to this project's tables, no clash with its files. Numbered 145.
- 145 applied by Alex 2026-10-20, no errors.

## Step 5 — tested and deployed (2026-10-20, inbox_atomic-q7d-s5-g2hy)
- 1_verify.sql passed; 2_failure_test.sql: all 23 checks true; CONFORMANT, 68 tables.
- `.claude/CLAUDE.md`: hand-run scripts live in `supabase/tests/<project>/`.
- mcp deployed 16:02 from the working tree (with the uncommitted clipboard.ts). This also
  shipped Phase 4's merged, undeployed alfred-tools changes. get_apps answers.
- `supabase/tests/inbox_atomic/3_cleanup_app_test.sql` removes the app test's captures.

## Next
1. Alex tests Process in the local dev server; then runs 3_cleanup_app_test.sql.
2. Only then push (the app's Process now needs process_inbox_item, which is live).
