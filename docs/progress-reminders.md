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
- [x] **3. MCP tools.** create_reminder, get_reminders, update_reminder; deploy; confirm verify_jwt is still false. Test from a fresh claude.ai thread.
  - [x] Written in `_shared/tools/reminders.ts`, registered in `mcp/index.ts` (78 tools); handler tests + schema parity pass
  - [x] gitsync, drift check, deployed mcp v132, verify_jwt still false
  - [x] Fresh-thread test script passes, including a made-up intent_id refused with "not found"
- [ ] **4. App.** Processing moves or keeps reminders, discard cancels and undo restores, intention deep link, detail views show the Pacific time.
  - [x] `utils/remindersApi.js`, `PendingReminder.jsx`, and the Alfred.jsx wiring (process, discard, Undo, Put back, the intention route); InboxDetailView gets a `renderReminders` prop; tests
  - [x] Build (after copying in the SAM schema file)
  - [x] Browser tests passed: the detail lines, processing into an intention, discard with Undo and Put back, processing into a memory, and the unknown-intention fallback
  - [x] 🔔 time on inbox cards and Intentions-list cards, from one query per list, refreshed on list views and after process, discard, Undo and Put back
  - [x] Browser: the bells on inbox and intention cards, the bell moving on processing, discard with Undo and Put back. The bells stay on the list cards only, by decision.
  - [x] An archived capture on `/inbox/detail/:id` opens what it became, found by sourceInboxId. The item comes first, then the intention (directly, or through the event it created). With neither, it falls back to the Inbox list. Uses `replace`, so Back does not loop.
  - [x] Items (memories): the detail page and the Memories-list card show the reminder on the item's source capture (`inbox_id = source_inbox_id`). This reuses the same one-query index, refreshed on the Memories view and after processing.
  - [ ] Phone test after deploy

## Notes

- Jest finds no tests from this worktree with the default pattern (the backslash in the rootDir glob seems to escape `.claude`). Workaround: `CI=true npx react-scripts test --watchAll=false --testMatch "**/src/viewPaths.test.js"`. Left unfixed for now.
- Android must have Chrome's battery setting on Unrestricted, or pushes wait until the app is opened. Urgency high alone is not enough.
- The claims guard gave two false positives in this thread. It blocked a read-only `sed -n` plus `grep -i` as an in-place edit, and a `>` redirect to `$TEMP` as a write to `supabase/functions/mcp`.
- `supabase/functions/_shared/sam-drill-format.schema.json` and `src/sam/lib/sam-drill-format.schema.json` are gitignored and were not copied into the worktree. Without them, `functions deploy mcp` fails to bundle, and the app build and 11 SAM test suites fail. Both were copied in from the main checkout on 2026-09-30. gitnewtree's local-file list needs both files. A file the deploy or the build needs probably should not be gitignored at all.
- `react-scripts build` reported a stale `no-undef` on Alfred.jsx, one line above the real use. ESLint run directly on the changed files passes with 0 warnings, and the build compiles with `DISABLE_ESLINT_PLUGIN=true`. The build's ESLint cache under node_modules/.cache is stale. I left it untouched.
- intent_id has no FK. `public.create_reminder` (084) refuses an intention the caller cannot see, with the error "intention <id> not found". Intentions in shared contexts are allowed, by decision. A test pins the wording.
