# Technical spec: Switchboard

Progress: [progress-switchboard.md](progress-switchboard.md). Thread: `switchboard-k7w`.

A Windows desktop panel, written in AutoHotkey v2, with one coloured button for every Claude Code session on alfred-v5: the main checkout plus each folder in `.claude\worktrees\`. The repo's Claude Code hooks write each session's state to `.clip\session-status.json` in that session's own checkout, and the panel reads those files. The panel never writes to the repo.

The requirements come from `switchboard-requirements.md` (outside the repo), and the prototype is `claude-sessions.ahk`. Where this spec and the requirements differ, this spec wins.

## 1. Session status file (written by hooks)

`<checkout>\.clip\session-status.json`. `.clip/` is git-ignored (.gitignore line 36) and exempt from claims.

```json
{ "state": "processing", "since": "2026-09-30T18:40:00.000Z", "project": "switchboard-k7w",
  "session_id": "…", "transcript_path": "C:\\Users\\…\\<session_id>.jsonl", "red": false, "event": "UserPromptSubmit" }
```

| Event | Writes |
|---|---|
| UserPromptSubmit, allowed (including loop wake-ups and machine envelopes) | `processing` |
| UserPromptSubmit, blocked (wrong window, malformed tag, untagged paste) | `blocked` |
| Stop | `waiting` |
| Notification, `notification_type` = permission_prompt, worker_permission_prompt, elicitation_dialog, elicitation_url_dialog, agent_needs_input | `approval` |
| Notification, `idle_prompt` | `waiting`. Most likely never fires in the VS Code extension (below), so nothing relies on it. |
| Notification, any other type | nothing |
| Notification with no `notification_type` | Falls back to the message text: "permission" writes `approval`, "waiting for your input" writes `waiting`. |
| PostToolUse | `processing`, **only** when the file currently says `approval`. Otherwise it exits without writing. |

- **`red`** is set by `approval` and `blocked`, cleared by `processing`, and carried over by every other write. The latch lives in the file, so the panel cannot miss a short burst of processing between two polls. The panel shows red whenever `red` is true, whatever `state` says. Red therefore clears only when the session goes back to processing: after an approval through PostToolUse, or on the next prompt. Clicking the button does not clear it.
- **`since`** is kept when the state does not change, and is otherwise the time of the write.
- **`session_id`** is taken from the hook input on every write, and kept from the previous write if the input lacks one.
- **`transcript_path`** works the same way, from the hook input's `transcript_path`. The panel uses it to see interrupts (section 2).
- **No hook fires on a denied permission or an Esc interrupt** (CLI 2.1.285, read from the binary and confirmed on the desktop). `PermissionDenied` fires only for auto mode's classifier. `PostToolUseFailure` fires only when a tool that ran fails. `StopFailure` fires only on API errors, and Stop is skipped on an interrupt. `idle_prompt` is sent only by the terminal UI, and only with no turn running and no dialog open. The VS Code extension runs the CLI headless (`stream-json`), so it most likely never sends idle_prompt. The only trace of an interrupt is the line `[Request interrupted by user` (or `… for tool use]`) in the transcript.
- **`project`**: in a worktree, the folder name. In main, `.git\alfred-project-code.json`, then the previous write's `project`, then `"main"`. Found by reading files only; the hooks never run git to get it. The prompt check's existing `git rev-parse` is unchanged.
- **Safety.** The write is synchronous and inside a try/catch. It goes to `session-status.json.tmp-<pid>` and is then renamed into place, with up to three retries 10 ms apart if a reader has the file open. If it fails, the hook carries on. In prompt-check the writer is loaded with a dynamic `import()` inside a try, so a broken writer cannot change an allow or block decision. The Stop, Notification and PostToolUse hook always exits 0 and prints nothing.
- **Code:** `scripts/lib/session-status.mjs` (the writer), `.claude/hooks/session-status.mjs` (the Stop, Notification and PostToolUse entry point), `.claude/hooks/prompt-check.mjs` (the prompt writes). Tests point the writer at scratch files through `SESSION_STATUS_FILE`, and the real file must stay untouched.
- **Rollout.** Hooks run from each checkout's own copy through `$CLAUDE_PROJECT_DIR`. Other checkouts write nothing until the change reaches main and they gitsync. The prompt-check change works from the next prompt. The new entries in `settings.local.json`, which is tracked, need a fresh session in each checkout.

## 2. Panel (tools\claude-sessions\)

- **Files.**
  - `claude-sessions.ahk` (the panel) and `README.md` (how to start it from main).
  - `lib\JSON.ahk`, a copy of thqby's JSON.ahk for AutoHotkey v2 with its MIT header and source commit.
  - `lib\status.ahk` (pure helpers) and `lib\chrome-address.ahk` (the address-bar reader).
  - Tests: `test-status.ahk`, `smoke-test.ahk`, and `run-tests.ps1`, which runs both.
- **Repo path.** The constant `C:\Users\Alex\projects\alfred-v5`, which `settings.ini` can override. The panel never finds the repo from its own location, because in a worktree `.git` is a file, not a folder.
- **Running it during the build.** Double-click the worktree copy. It reads the same live data it will read from main. Quit the prototype first.
- **Own settings.** `%APPDATA%\claude-sessions\settings.ini` holds the pause state, the VS Code and Chrome title overrides, the saved claude.ai chat link, the last-click time for each button, and the repo path. None of this is ever stored in the repo.
- **Sessions.** Main, plus every folder in `<repo>\.claude\worktrees\`. The folder name is the project code.
- **Files.** Code in `claude-sessions.ahk`. Pure helpers (interrupt search, time formats, colour and taskbar rules) in `lib\status.ahk`, tested by `test-status.ahk`. `smoke-test.ahk` drives the real panel through each state on scratch files in %TEMP%. Run both with `AutoHotkey64.exe /ErrorStdOut <file>` from `tools\claude-sessions`; exit 0 means passed. The panel uses `#Warn`, because AutoHotkey names are case-insensitive and a variable can silently hide a function or class.
- **Reading files.** The panel reads each status file once a second and parses it only when its text has changed. A modified time has only one-second resolution, so two writes in the same second could be missed. The files are tiny. If a read or parse fails because the file is mid-write, it is retried on the next poll. If the claims file fails to parse, it retries once.
- **Interrupts (display only).** For a session whose file says `approval` or `processing`, each poll reads only the end of its `transcript_path` (the last 16 KB), and only when the transcript's size or the file's `since` has changed. The panel matches `"text":"[Request interrupted by user` or `"content":"[Request interrupted by user`, and only with unescaped quotes. So a message that quotes the words, where the quotes are escaped as `\"`, never matches. If the panel finds a match on a line whose `timestamp` is later than the file's `since`, the panel shows that session as waiting (yellow) with red cleared. The panel never writes the status file. The next hook write replaces the file, and the rule is applied again from scratch. This covers a denied permission and Esc while processing.
  - **It depends on the exact wording of that line.** If a future Claude Code version rewords it, detection stops silently, and the session shows red (after a denial) or green (after Esc) until the next prompt. That is the known fallback. It is not an error.

### Button states and colours
- Red means `red` is true. Yellow means waiting. Green means processing. Grey means paused.
- **No status** means the checkout has never written a status file (outlined grey).
- **Closed** means no VS Code window is open for that checkout. The panel works this out; no hook writes it. The button shows the last recorded state and time as text, has no running timer, and is left out of the taskbar colour.
- **Taskbar colour.** Taken across unpaused sessions that are not closed: red beats yellow, and yellow beats green. The panel uses the prototype's taskbar progress-bar tint. When a thread finishes, the panel comes forward without taking focus and flashes. The prototype's blink-until-clicked behaviour is kept for unseen yellow and red.
- **Pause.** A small Pause / Resume button sits beside each session button, and the right-click menu has the same item. Pause greys the session out and leaves it out of the taskbar colour. A paused session that starts processing again is unpaused at once.
- **Interrupted.** An approval or processing session with an interrupt line after `since` shows yellow, not red (see "Interrupts" above).
- **Alert and blink.** A session alerts, and blinks until its button is clicked, when it turns red or goes from processing to waiting. It does not alert on red turning to waiting, on the panel's first read, or while it is paused.
- **Button text.** The first line is the project code. For main, when its status file names a project, that is shown as `main · <code>`. The second line is the state and its timer or time, `interrupted <time>` after an interrupt, and a `paused ·` prefix when paused.
- **Timers.** Processing shows the time since `since`. Every other state shows the date and time it was entered.

### Clicking a button
- Maximizes VS Code on monitor 1 and the claude.ai Chrome window on monitor 2, found by window title.
  - VS Code: the checkout folder name as a whole title segment.
  - Chrome: the project code plus "Claude". For main, that is its bound project code.
  - Right-click "VS Code title text…" or "Chrome title text…" replaces either match with hand-typed text, saved in `settings.ini`.
- **Closed** is decided from the VS Code window list each poll: no matching window for 3 polls in a row.
- If no Chrome window matches and a chat link is saved (right-click, then "Save chat link"), the click opens the link in a new Chrome window.
- **Automatic chat link.** When the Chrome match came from the project code, not from hand-typed title text, the click reads that same window's address bar through UI Automation, before moving it. The reader is `lib\chrome-address.ahk`: raw COM, no library, and it reads the first Edit descendant's Value. UIA-v2 was considered and not used.
  - A `https://claude.ai/chat/…` address, or the bare `claude.ai/chat/…` that Chrome displays, is saved as the session's link.
  - Anything else, or any failure, saves nothing, and the click still arranges the windows.
  - "Save chat link…" and "Chrome title text…" stay as manual fallbacks.
- A closed button offers to reopen instead (section 3).

### Strips
- **db:** who holds `db:deploy`, and for how long, plus any `db:fn:` and `db:table:` claims. Red past one hour. Shows "db: free" when nothing is held.
- **main:** `main: <code>` or `main: free`, from `.git\alfred-project-code.json`.
- **Unread report badge.** `• new` on the button's first line, shown when `.clip\last-report.md` has a modified time newer than the last click on that button. A session the panel has never seen starts as read.
- **Unsaved work.**
  - Shown on the button's first line: `±n` for changed files, and `↑n` for main's unpushed commits.
  - For each checkout, `git --no-optional-locks -C <checkout> status --porcelain`, counting the lines. The flag stops `status` from rewriting the index.
  - For main, `git rev-list --count origin/main..main`. This reads local refs only and never fetches.
  - These run through RunWait with Hide and output sent to a file in %TEMP%, on startup, on the refresh button, and when that checkout's status file changes. There is no timer, and the hooks never run git.
- **Orphans.**
  - A claim whose owner is neither `main` nor an existing worktree folder.
  - A worktree whose last activity is more than **3 days** old. Last activity is the newest modified time of its `.clip\session-status.json`, its `.clip\last-report.md`, and `<repo>\.git\worktrees\<name>\index`.

## 3. Recovery after VS Code closes

- **Reopen.** A closed button offers `code "<checkout folder>"`.
- **Resume, found read-only in extension 2.1.285.** The extension registers a URI handler: `vscode://anthropic.claude-code/open?session=<session_id>` opens that conversation in the primary editor. It calls `claude-vscode.primaryEditor.open(session)`, and the extension first checks that the id is well formed. There is no command-line flag or setting that does the same.
  - The URI goes to the VS Code window that has focus. So the reopen sequence is `code <folder>`, then wait until that window exists and is active, then launch the URI with `code --open-url`.
  - This is to be proven in the recovery step. If it does not work, the fallback is that Alex picks the conversation from the panel's conversation history.

## 4. Decisions

- **2026-09-30.**
  - Red clears only on a return to processing. PostToolUse clears it after an approval, and a click never clears it.
  - Git is checked only on a status change, on startup, or from the refresh button, and always runs hidden.
  - The Notification type comes from `notification_type`, confirmed in the input schema of CLI 2.1.284. The message text is only a fallback.
  - The main project code comes from the binding file, then the last write, then "main".
  - JSON is read with a copy of thqby's JSON.ahk.
  - The orphan threshold is 3 days.
  - `settings.local.json` is tracked by git, so gitsync and gitpush carry the new hooks.
  - A denied permission or an Esc interrupt is detected by the panel from the transcript's interrupt line, and shown as waiting with red cleared. There is no background watcher. The hooks record `transcript_path` for this.
  - Nothing relies on `idle_prompt`.
- **Known gap.** Interrupt detection depends on the wording `[Request interrupted by user`. If it changes, a denied turn shows red and an Esc'd turn shows green, until the next prompt.
