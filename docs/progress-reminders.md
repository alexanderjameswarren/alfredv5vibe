# Progress: standalone reminders

Spec: [technical-spec-reminders.md](technical-spec-reminders.md). Thread: `rem-j7p`.

- [x] **1. Migration.** Table, comments, indexes, updated_at trigger, `create_reminder` function, register_table. Alex runs it in the SQL editor; `check_platform_conformance` must return CONFORMANT.
  - [x] Written (as `_pending_rem-j7p_reminders.sql`)
  - [x] gitsync, drift check (nothing new came in), db claims, numbered `supabase/migrations/084_reminders.sql`
  - [x] Run by Alex; CONFORMANT; checkpointed; step-1 db claims released
- [x] **2. Dispatcher.** Extend notify-dispatch to send due reminders, then deploy. Verify with a reminder inserted by hand a few minutes ahead (set user_id explicitly — auth.uid() is null in the SQL editor).
  - [x] notify-dispatch sends reminders; `intentionDetailPath` route + tests in viewPaths.js
  - [x] gitsync, drift check (only 084 and a dj-normalise change came in), claim db:deploy, deployed v7, verify_jwt still false
  - [x] Hand-inserted test reminder arrives on time on an idle phone and opens the Inbox (FCM 201); checkpointed
- [ ] **3. MCP tools.** create_reminder, get_reminders, update_reminder; deploy; confirm verify_jwt is still false. Test from a fresh claude.ai thread.
  - [x] Written in `_shared/tools/reminders.ts`, registered in `mcp/index.ts` (78 tools); handler tests + schema parity pass
  - [x] gitsync, drift check, deployed mcp v132, verify_jwt still false
  - [ ] Fresh-thread test script passes
- [ ] **4. App.** Processing moves or keeps reminders, discard cancels and undo restores, intention deep link, detail views show the Pacific time.

## Notes

- Jest finds no tests from this worktree with the default pattern (the backslash in the rootDir glob seems to escape `.claude`). Workaround: `CI=true npx react-scripts test --watchAll=false --testMatch "**/src/viewPaths.test.js"`. Left unfixed for now.
- Android must have Chrome's battery setting on Unrestricted, or pushes wait until the app is opened. Urgency high alone is not enough.
- The claims guard gave two false positives in this thread. It blocked a read-only `sed -n` plus `grep -i` as an in-place edit, and a `>` redirect to `$TEMP` as a write to `supabase/functions/mcp`.
- `supabase/functions/_shared/sam-drill-format.schema.json` is gitignored and was not copied into the worktree, so `functions deploy mcp` fails to bundle from here. Copied in from the main checkout on 2026-09-30. gitnewtree's local-file list needs this file. A file the deploy needs probably should not be gitignored at all.
