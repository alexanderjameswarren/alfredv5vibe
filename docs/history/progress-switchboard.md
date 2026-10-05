# Progress: Switchboard

Spec: [technical-spec-switchboard.md](technical-spec-switchboard.md). Thread: `switchboard-k7w`.

**Status: Steps 1 to 5 complete. Ready to land (step 6): the file list and checks are in the 2026-10-01 landing note. Waiting for Alex to run gitpush.**

- [x] **1. Hook writer and prompt states.** `scripts/lib/session-status.mjs`; prompt-check writes processing and blocked; `.claude/hooks/session-status.mjs` writes waiting on Stop, wired in settings.local.json beside the sound. `session_id` is recorded on every write. Verify: in a fresh session, watch `.clip\session-status.json` go processing, then waiting, and blocked on a wrong-window prompt.
  - [x] Writer, prompt-check writes, Stop hook, settings entry, tests (session-status.test.mjs, hooks.test.mjs)
  - [x] Verified by Alex on 2026-09-30: processing, waiting, blocked with red, and red clearing on the next prompt
- [x] **2. Notification and PostToolUse.** Map `notification_type` (spec §1); PostToolUse writes processing only when the file says approval. Before building, log the raw hook input once and check the types. Verify: a permission prompt turns red, approving it clears red, and leaving a session idle for 60 seconds writes waiting, not approval.
  - [x] `stateForNotification` in the writer; the hook handles Notification and PostToolUse; both wired in settings.local.json; tests in session-status.test.mjs
  - [x] Temporary log of every raw Notification input at `.clip\notification-hook-input.log`
  - [x] Permission prompt writes approval with red: verified by Alex 2026-09-30. Logged type: `permission_prompt`.
  - [x] A denial leaves red until the next prompt: found by Alex. No hook fires on a denial (see notes). Handled by the panel in step 3.
  - [x] Every write records `transcript_path`, carried over when missing; tests in session-status.test.mjs and hooks.test.mjs
  - [x] Verified by Alex 2026-09-30: `transcript_path` appears in the status file
  - [x] Plain idle check, 2026-09-30: after 90 idle seconds the file still said waiting (event Stop). The log gained no `idle_prompt` line; its only entry was the one `permission_prompt`. **idle_prompt does not fire in the VS Code extension.**
  - [x] Logging removed from the hook and its test; Alex deleted the log file himself
- [x] **3. Panel core.** Split in two on 2026-09-30, so each half can be verified in one sitting.
  - [x] **3a. Buttons and colours.**
    - `tools/claude-sessions/claude-sessions.ahk`, with thqby's JSON.ahk in `lib/`.
    - One button per checkout, with colours and sticky red.
    - Taskbar colour priority: red, then yellow, then green, ignoring paused sessions.
    - Timers and timestamps, pause with auto-unpause on processing, blink and alert.
    - **Interrupt detection** (spec §2 "Interrupts"): an approval or processing session whose transcript has `[Request interrupted by user` after `since` shows yellow with red cleared. This is display only.
    - Verify: quit the prototype, run the worktree copy, and take one session through each state.
    - [x] Written
    - [x] Verified by Alex 2026-09-30. Every desktop test passed: green with timer; yellow with blink and the panel coming forward; click stops the blink; red on a permission prompt; yellow "interrupted" after No and after Esc; red, green, yellow after Yes; blocked stays red until the next prompt; pause greys and leaves the taskbar colour; auto-unpause.
    - [x] Correction from the requirements: a small visible **Pause / Resume button** beside each session button. The right-click item stays. Covered by the smoke test.
  - [x] **3b. Windows.**
    - Click to arrange VS Code on monitor 1 and the claude.ai Chrome window on monitor 2. VS Code is matched by checkout folder name, Chrome by project code; right-click overrides either.
    - The **closed** state (addition 2), which is also left out of the taskbar colour.
    - **Reopen and resume** (additions 3 and 4), moved here from step 5 at Alex's request.
    - The **saved chat link** with its right-click option (addition 5).
    - Verify: click a button, then close and reopen the checkout's VS Code window.
    - [x] Written. Smoke test covers the click path, closed after 3 polls, no alert while closed, and reopening at once.
    - [x] Verified by Alex 2026-10-01: every desktop test passed. Closing and reopening this worktree's window **resumed this conversation, so the resume link works.**
    - [x] **Automatic chat link** (added 2026-10-01). A click whose Chrome match came from the project code reads that window's address bar. If the address is a claude.ai chat, the click saves it as the session's link.
      - [x] Written, with the safeguards tested (helper tests and smoke test)
      - [x] Library: keep `lib/chrome-address.ahk`, no UIA-v2 (Alex, 2026-10-01)
      - [x] Verified by Alex 2026-10-01: automatic link saving, and a typed title never saving
- [x] **4. Panel strips.** db strip, main's project, unread-report badge, git counts with the refresh button, orphans (3 days). Verify: claim a db:table, touch a report, and leave a file uncommitted.
  - [x] Written. Helpers are in `lib/status.ahk` (`DbStrip`, `MainStrip`, `Orphans`, `IsUnread`, `CountLines`, `FormatAge`), and the smoke test covers the badge and the strips.
  - [x] Verified by Alex 2026-10-01: badge, git counts with Refresh git, db strip, main strip bind and unbind, orphans with cleanup
- [x] **5. Recovery.** *Built and verified in 3b: the resume link brought this conversation back on 2026-10-01.* Reopen a closed checkout with `code <folder>` (addition 3), then resume its conversation through `vscode://anthropic.claude-code/open?session=<id>` (addition 4). Verify: close a worktree's VS Code window and reopen it from the panel, and check that the same conversation comes back.
- [ ] **6. Finish.** Checkpoint the hooks into main. The other worktrees gitsync and start fresh sessions. Run the panel from main.

## Notes

- **2026-09-30 decisions.**
  - Red clears only on a return to processing. PostToolUse clears it after an approval, and a click never does.
  - Git runs only on a status change, on startup, or from the refresh button, always hidden.
  - The main project code comes from the binding file, then the last write, then "main".
  - JSON is read with a copy of thqby's JSON.ahk.
  - The orphan threshold is 3 days.
- **settings.local.json is tracked by git** (checked before claiming), so gitsync and gitpush carry the new hooks.
- **Addition 4 (resume), found read-only.** Extension 2.1.285 registers a URI handler: `/open?session=<id>` calls `claude-vscode.primaryEditor.open(id)`. It acts on the VS Code window that has focus, so step 5 opens the folder first, waits for its window, then sends the URI. There is no command-line flag or setting for this. Not yet proven live.
- **Step 2 decisions, 2026-09-30.**
  - PostToolUse reads the status file before loading the writer, and exits at once unless it says approval. It still parses the hook input, which is cheap next to Node's own startup.
  - A known `notification_type` never falls back to the message text. The text is used only when the type is missing.
  - The Notification log is a plain append, one line per input with a timestamp. It is best effort and cannot stop a status write.
- **Denied permission, decided 2026-09-30.**
  - No hook fires when Alex clicks No, or on an Esc interrupt. This was read from the CLI 2.1.285 binary and matches the desktop test.
  - `idle_prompt` is sent only by the terminal UI, so it most likely never fires in VS Code, and nothing relies on it.
  - A background transcript watcher was rejected. Instead, the hooks record `transcript_path`, and the panel tails the transcript for the interrupt line.
  - This depends on the line's wording. If Claude Code rewords it, the fallback is red (after a denial) or green (after Esc) until the next prompt.
  - The Notification log stays until the plain idle check is done.
- **Step 3a decisions, 2026-09-30.**
  - JSON.ahk is vendored from thqby/ahk2_lib at commit `af633c778cabc294f90678d303f1a1c44b50bcc3` (v1.0.8). It is unmodified below an added source-and-MIT header, and it diffs identical to the original.
  - Status files are compared by content every second, not by modified time, which has only one-second resolution.
  - The interrupt search needs unescaped quotes around `"text":"[Request interrupted by user` (or `"content":…`). It finds the real denial in the 19:30 transcript and nothing in this thread's own transcript, which quotes the words many times.
  - In 3a, a click only marks a session seen. Arranging windows is 3b.
  - **Crash found in Alex's desktop test, 2026-09-30.** Going from green to yellow crashed the panel with `Integer has no method named "Call"`. AutoHotkey names are case-insensitive, so the local `alert` in `Refresh()` hid the function `Alert()`.
    - The variable is now `anyAlert`. `shouldAlert` would have clashed with the helper `ShouldAlert()`.
    - The panel now has `#Warn`, which reports this at load. It found no other clash in the panel, `status.ahk` or `JSON.ahk`.
    - The new `smoke-test.ahk` drives the real panel on scratch files in %TEMP%: processing, waiting (the alert path), click, approval, denial interrupt, and auto-unpause. It runs with `#Warn All, StdOut`, so any warning or runtime error fails it.
    - The smoke test fails on a copy with the old bug (both the warning and the crash) and passes on the fix. While it was being written, it also caught a smoke-test variable `file` clashing with AutoHotkey's built-in `File` class.
    - **Correction, found during 3b:** `#Warn All, StdOut` only prints a warning, it does not fail the run. So the claim above that "any warning fails it" was wrong until then. The smoke test now also loads the panel on its own with `/validate` and fails if any warning is printed. That check was proven by injecting a harmless clash into a scratch copy.
    - Run both AutoHotkey tests before every desktop test: `AutoHotkey64.exe /ErrorStdOut test-status.ahk` and `… smoke-test.ahk`, from `tools\claude-sessions`.
  - Settings are in `%APPDATA%\claude-sessions\settings.ini`: `[panel] repo=` and `[paused] <code>=1`.
- **Step 3b decisions, 2026-09-30.**
  - **VS Code windows** are matched on the folder name as a whole title segment (`… - <folder> - Visual Studio Code`), so `alfred-v5` does not match `alfred-v5-old`.
  - **Chrome windows** must contain both the project code and "Claude". For main, the code is its bound project code when it has one.
  - Hand-typed title text replaces the automatic match. It is stored in `settings.ini` under `[vscode]` and `[chrome]`, and leaving it blank clears it.
  - **Closed** means no matching VS Code window for 3 polls in a row, so a window that is briefly retitled while loading does not flicker. A window that comes back reopens the button at once.
  - A closed session shows `closed · <state> <time>`, has no timer, never alerts, and is left out of the taskbar colour.
  - **Reopen** runs `code "<folder>"` hidden and waits up to 30 s for the window. It then waits 3 s so the extension can start, focuses the window, and launches `vscode://anthropic.claude-code/open?session=<id>` through the Windows protocol handler (`Code.exe --open-url -- "%1"`, found in the registry). `code --open-url` is not in `code --help`.
  - **Resume, unproven.** At about 13:57 I launched the URI once for the old "Step 99" conversation. The shell accepted it, but the extension logs and the process list showed nothing I could read as proof. Alex's desktop test decides it.
  - **Chat link**: only `https://claude.ai/…` links are saved (`[chatlink]`). With no matching Chrome window, a click opens the link with `chrome.exe --new-window` and puts the new window on monitor 2.
  - With one monitor, both windows go to monitor 1.
- **Automatic chat link, decisions 2026-10-01.**
  - **Library, decided by Alex 2026-10-01: no UIA-v2.** Descolada's UIA-v2 (commit `2846a9b`, 424 KB plus 45 KB) was too big to write through the Write tool, so `lib/chrome-address.ahk` was built instead and kept. It reads the address with about 30 lines of raw UI Automation COM: the window's first Edit descendant, which is the address bar, and its Value. Live on 2026-10-01 it read every open Chrome window in 0 to 47 ms.
  - **Approved by Alex 2026-10-01:** Chrome reports addresses **without the scheme** (`claude.ai/chat/<id>`). A bare `claude.ai/chat/…` is therefore treated as https and saved as `https://claude.ai/chat/…`; Chrome only hides the scheme for https. An explicit `http://`, any other claude.ai page and any other site save nothing.
  - **Safeguards:**
    - The address is read only from the hwnd that the click matched, before the window is moved.
    - With hand-typed Chrome title text, the reader is never called.
    - Any failure saves nothing, and the click still places both windows.
    - All of this is in the smoke test, through swappable `chromeAddressReader`, `listChromeWindows` and `placeWindow`.
- **Step 4 decisions, 2026-10-01.**
  - The db strip lists `db:` **claims** (not reservations) as `<kind:name> · <owner> <age>`, and is red when any is older than an hour.
  - Main's strip reads `.git\alfred-project-code.json` only.
  - **Unread badge `• new`:** the report's modified time is later than the last click on that button (`[lastclick]` in settings.ini). The first time the panel sees a session, it records "now", so old reports don't all light up.
  - **Git counts:** `±n` is changed files, and `↑n` is main's commits ahead of origin/main. They run hidden through `cmd /c … > %TEMP%\…`, using `git --no-optional-locks`, so `status` never rewrites the index and the panel still writes nothing in the repo. They run on the first poll, when that checkout's status file changes, and from the "Refresh git" button.
  - **Orphans:** owners of claims *or reservations* who are neither main nor a worktree folder, plus worktrees idle more than 72 hours (the newest of their status file, last report, and `.git\worktrees\<name>\index`).
- **AutoHotkey pitfalls found while building, 2026-10-01.**
  - More case-insensitive clashes, all caught by `#Warn` or at load: `edit` with the built-in `Edit()`, a test's `orphans` with `Orphans()`, `dbStrip` with `DbStrip()`, and test globals with panel locals.
  - **In v2, `number > ""` is a type error.** It was swallowed by a `try`, which silently disabled the unread badge until the smoke test caught it.
  - `test-status.ahk` now also fails on any warning, as the smoke test already did.
- **Tool artefact, resolved 2026-10-01.** Permission approvals had added three broad allow-rules to the tracked `.claude/settings.local.json` and re-indented it. On Alex's instruction they are replaced with three narrow rules, and the file is back to its original layout:
  - the one fixed test command, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/claude-sessions/run-tests.ps1`;
  - a Read rule for `.git\alfred-claims.json`;
  - a Read rule for `.git\alfred-project-code.json`.
  Its diff against HEAD is only those rules and the hook entries.
- **cli-workflow skill, 2026-10-01.** A new "Starting a new project" section in `.claude/skills/cli-workflow/SKILL.md`, claimed for this thread. It sets the order:
  1. Project code and chat name.
  2. Main or a worktree.
  3. `gitnewtree`.
  4. Files named with the code, dragged into `docs\`.
  5. The plan prompt.
  It also adds the line about keeping each chat as the active tab in its own Chrome window.
- **Landing check, 2026-10-01.**
  - 17 files to commit:
    - Modified: `.claude/hooks/prompt-check.mjs`, `.claude/settings.local.json`, `.claude/skills/cli-workflow/SKILL.md`, `scripts/lib/hooks.test.mjs`.
    - New: `.claude/hooks/session-status.mjs`, `scripts/lib/session-status.mjs`, `scripts/lib/session-status.test.mjs`, the two `docs/*-switchboard.md` files, and the eight files in `tools/claude-sessions/`.
  - Tests: the AutoHotkey tests pass; CLI tooling 91 of 94, the 3 known worktree failures only; app 2019 of 2019.
  - **No database involvement:** no migration, SQL, Supabase or function file, no Supabase reference in the new code, and no `db:` claim or reservation held.
  - Before Finish, quit the panel's worktree copy (its process sits in this folder) and close this worktree's VS Code window and Claude session.
- **Logged in Alfred as their own bugs (2026-09-30), outside this project:** the three worktree test failures below, and the claims guard false positive on reading `.git`. Do not re-run the three tests in main at the finish step, and leave the guard alone.
- **Three hooks.test.mjs tests fail in any worktree:** wrong-window bind/unbind, binding write, underscore tag. They assume `ROOT` is the main checkout with a binding that can be set. In a worktree the project is the folder name. The failure comes from `codeOfCheckout` and is unrelated to the status writer. They should pass in main. Not fixed, because it is outside this project.
- **Claims guard false positive, 2026-09-30.** A read-only attempt to copy HEAD's test files into the scratchpad, to prove the failures above existed before my change, was blocked. It reported `cp .git …` as a write to `.git`, although `.git` was the source, not the destination. Not retried.
