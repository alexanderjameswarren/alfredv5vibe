# Technical spec: Switchboard bridge

Progress: [progress-switchboard_bridge.md](progress-switchboard_bridge.md). Thread: `switchboard_bridge-p8v`. Builds on [technical-spec-switchboard.md](technical-spec-switchboard.md).

Switchboard can see only the active tab of each Chrome window, and only by window title. This project connects it to the Alfred Clipboard extension (`extension\`) over Chrome native messaging, so that Switchboard can:

1. find any tab in any window and bring it forward,
2. pair a session with its chat by exact claude.ai address instead of by title,
3. list every open claude.ai chat, and show for each project which window to go to and what to do there (section 5).

```
claude.ai tab ──claude-watch.js──▶ service worker (bridge.js) ──native port──▶ host.mjs ──files──▶ panel
                                                         ◀──────────────── commands ◀── command.json ◀──
hooks / clip.mjs ──▶ <checkout>\.clip\session-status.json, last-report.json ──────────────────────▶ panel
```

## 1. Native messaging host (tools\claude-sessions\bridge\)

- **Files.**
  - `host.mjs` is the host, and `host.bat` is its launcher. The launcher is `@echo off` and runs `%ProgramFiles%\nodejs\node.exe` by its absolute path, falling back to `node` on the PATH. Nothing in it is rewritten at install time.
  - `host-manifest.template.json` is the template for Chrome's host manifest.
  - `install.ps1` registers the host. `-DryRun` prints the manifest and the registry key without changing anything.
  - `host.test.mjs` tests framing, the field whitelist, command filtering, `install.ps1 -DryRun`, and the real process launched through `host.bat`: frames only on stdout, a forwarded command, and exit on EOF.
  - `try-host.mjs` is a hand check with no Chrome involved. It starts `host.bat` with a fake origin, sends one tab list and one chat list, drops a focus command, and prints what the host sends back.
- **Field whitelist.** The host copies only the known fields, with their types checked, into each file. Anything else an extension message carries is dropped. An `issuedTag` that is not a whole run tag is dropped too. Only `focus` and `sendcli` commands with an id plus a `tabId` or an http(s) `url` are forwarded, and nothing else from `command.json` travels.
- **Name:** `com.alfred.switchboard`.
- **Install.** `install.ps1 -ExtensionId <daily>,<test>` takes the ids from `chrome://extensions`; the script does not work them out itself. It writes the real manifest to `%LOCALAPPDATA%\claude-sessions\bridge\com.alfred.switchboard.json`, with the absolute path to `host.bat` and one `allowed_origins` entry for each id. It then sets `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.alfred.switchboard` to that manifest's path. Running it again overwrites both. `-Remove` deletes both.
  - **Re-point after Finish.** The registry entry points at one `host.bat`. If it points into the worktree, it breaks when gitpush Finish deletes the worktree. Rerun `install.ps1` from main after Finish. That is the last step of the project.
- **What it does.**
  - It only writes the state files below and forwards commands. It never runs any other program.
  - It writes nothing to stdout except protocol messages: a 4-byte little-endian length, then UTF-8 JSON.
  - Diagnostics go to `host.log` in the bridge folder, capped at 256 KB.
- **Caller.** On Windows, Chrome passes the calling extension's origin (`chrome-extension://<id>/`) as the host's first argument. The host writes it into every file as `origin`, along with `extension_id`.
- **Startup.** The host sends `{type: "hello"}` when it starts.
- **Lifetime.** Chrome starts one host process for each `connectNative` port. The process ends when the port closes (stdin EOF).

## 2. Files

### Bridge folder

**Location.** `%LOCALAPPDATA%\claude-sessions\bridge\`, outside the repo.
- The panel can override it with `[panel] bridge=` in `settings.ini`, and the smoke test points it at `%TEMP%`.
- The host's folder is fixed, but `SWITCHBOARD_BRIDGE_DIR` overrides it for tests.

**Writes.** Every write replaces the whole file: the host writes `<name>.tmp-<pid>`, then renames it into place, retrying up to three times 10 ms apart.

| File | Writer | Content |
|---|---|---|
| `tabs.json` | host | `{ at, origin, tabs: [{ tabId, windowId, index, active, windowFocused, title, url, discarded }] }` |
| `chats.json` | host | `{ at, origin, chats: [{ tabId, windowId, url, title, state, since, issuedTag, composerEmpty, viewedAt }] }` |
| `command.json` | panel | `{ id, action, tabId }`, or `url` in place of `tabId`. `action` is `focus` or `sendcli`. A `focus` may add `composer: true`. |
| `result.json` | host | `{ id, ok, windowTitle, did, error }` |

- **`at` is the heartbeat.** The extension resends both lists whenever they change, and at least every 15 s. If `at` is older than 45 s, the panel treats that file as stale. A stale tabs file means it falls back to title matching. A stale chats file means every chat counts as `unknown`.
- **Addresses.** URLs are normalised: the query and fragment are dropped. A chat address is `https://claude.ai/chat/<uuid>`.
- **Commands.** The host watches `command.json`, with `fs.watch` plus a 500 ms poll as a fallback. It forwards each new `id` once, then deletes the file. The answer appears in `result.json` with the same `id`.

### Checkout files (signals from the CLI side)

- **IDE context is ignored.** prompt-check strips the context blocks the VS Code panel attaches (`<ide_selection>`, `<ide_opened_file>`, any `<ide_*>…</ide_*>`) before it looks for the tag, the override and the pasted-prompt signals. So a selection that holds example run tags cannot decide the window, and `run_tag` follows the same rule. Machine envelopes are still judged on the raw prompt.
- **`.clip\session-status.json` gains `run_tag`.** prompt-check passes the prompt's tag to the writer on every allowed tagged prompt. Every other write carries the previous `run_tag` over, the same way it already does for `session_id`. An untagged prompt (a short reply, an override) keeps the previous tag. The tag is the CLI's current run.
- **`.clip\last-report.json`**, written by `scripts/clip.mjs` (through `scripts/lib/last-report.mjs`) after each successful push of that checkout's own `.clip\last-report.md`:
  - It holds `{ run_tag, title, pushed_at }`. `run_tag` is the tag that was sent, or null.
  - It sits beside `.clip\last-report.md`, in the checkout found by `git rev-parse --show-toplevel`.
  - A push of any other file, or from stdin, does not touch it, so a piped test run never counts as a report.
  - clip.mjs prints a `local:` line saying whether it was written.
  - It is written atomically. A failure to write it is reported, but never fails the push.
  - `.clip\` is git-ignored and exempt from claims.

## 3. Extension

- **The clip code is untouched.** `service-worker.js` gains exactly one line, `import "./bridge.js";`, and nothing else for the whole project. Everything new lives in `bridge.js`, `lib\bridge-core.js` (pure, tested with node) and `claude-watch.js`.
- **Manifest.**
  - Add the permissions `tabs` and `nativeMessaging`, and the host permission `https://claude.ai/*`.
  - Add a `content_scripts` entry: `claude-watch.js` on `https://claude.ai/*`.
  - **No `key`.** A key would change the daily extension's id and wipe the secret it has stored.
- **bridge.js.**
  - Connects with `chrome.runtime.connectNative("com.alfred.switchboard")`.
  - Every bridge call is wrapped so that a failure is silent and never reaches the clip code.
  - `onDisconnect` always reads `chrome.runtime.lastError`.
    - If the error is "host not found" (the Surface, the Chromebook) or "forbidden" (this id is not in `allowed_origins`), it gives up until the service worker next starts. After `install.ps1` runs, the extension must be reloaded.
    - Any other error reconnects with backoff, from 1 s doubling to 60 s.
  - It sends the tab list on the host's `hello`, on each change (debounced 500 ms), and every 15 s.
  - The listeners are added at the top level, and do nothing without a port.
  - An open native port keeps an MV3 service worker alive.
- **Tabs.**
  - Built from `chrome.tabs.query({})` and `chrome.windows.getAll()`, and resent (debounced 500 ms) on these tab and window events: created, removed, updated, activated, moved, attached, and window focus.
  - `focus` picks the tab by `tabId`, or by its normalised `url`. It then does `chrome.tabs.update(tabId, {active: true})` and `chrome.windows.update(windowId, {focused: true})`.
  - The reply's `windowTitle` is the tab's title, read again after activation. Chrome's window title is the active tab's title plus " - Google Chrome", and Chrome has no API for the window's own title, so the panel matches on the prefix.
  - A missing tab replies `ok: false` with `error` ("no tab with id N" or "no tab with that address"), and so does any thrown error.
  - `sendcli` focuses the same way, then hands over to the watcher (see Send cli below). Any other action replies `unsupported action`.
  - Windows may refuse Chrome the foreground, so the window may only flash in the taskbar. That is why the panel activates it itself.
  - `tools/claude-sessions/bridge/focus-tab.mjs <tabId>` (or `--url <address>`, plus `--sendcli` for Send cli) is the hand check. It writes `command.json`, waits 5 s for the matching `result.json`, and prints it.
  - **`viewedAt`.** The time the chat's tab was last both active and in the focused window. That is when Alex has seen its finish.
- **Tabs that are open already.** A content script does not run in tabs that were open before the extension loaded or reloaded, so `bridge.js` injects `claude-watch.js` into them with `chrome.scripting`.

### claude.ai watcher (claude-watch.js)

- **States.**
  - `responding` while the stop button shows.
  - `finished` when the page is recognised and no stop button shows.
  - `unknown` whenever the page cannot be recognised. That includes when the message box or the stop/send button area is not found.
  - A broken selector therefore gives `unknown`, never `finished`.
  - A tab that has not reported yet, or a discarded (sleeping) tab, is also `unknown`.
  - The check is debounced 1 s, so a flicker is not a finish.
- **The selectors** live in one table at the top of the file (`SELECTORS`), so a claude.ai redesign is a one-place fix.
  - The message box is a `contenteditable` ProseMirror or textbox.
  - The stop area is a button whose aria-label has "Stop" or "Send".
  - `[data-is-streaming="true"]` also counts as responding.
  - Claude's messages are the `[data-is-streaming]` elements, with `.font-claude-response` and `.font-claude-message` as fallbacks.
  - They were written without seeing the live page. All of them were proven on claude.ai in steps 8–10 (2026-10-03): state, tag, message box, send button and `insertText`.
- **Finding the tag (s10c).**
  - Claude's latest message is found with `[data-is-streaming]` first, then `.font-claude-response`, then `.font-claude-message`. Each selector is tried on its own, and only the outermost matches count.
  - The tag is read from the message's whole text, and then from each `<pre>` block's own text. Leading spaces, no-break spaces and zero-width characters before `Run tag:` are tolerated.
  - The first live check had found no tag in a reply whose code block held two.
- **Mechanics.**
  - A MutationObserver plus a 5 s tick schedule a check, at most once a second.
  - A change to `finished` must hold for 1 s before it is reported. `responding` and `unknown` are reported at once.
  - A report is sent through `chrome.runtime.sendMessage` only when it differs from the last one.
  - Off a `/chat/` path (`/new`, projects), the watcher sends `null`, and the tab drops out of its report.
  - When the extension is reloaded, the old watcher stops itself, and a re-injection replaces it.
- **bridge.js** keeps the last report per tab, and copies only `url`, `state`, `since`, `issuedTag` and `composerEmpty`. It accepts a report only from its own extension and from a `https://claude.ai/` tab.
  - The chat list, built by `buildChatsMessage`, is every `claude.ai/chat/` tab. A tab with no report, a report for another address, or a discarded tab counts as `unknown`.
  - It is sent with the tab list, on the same triggers.
  - It injects the watcher into already-open claude.ai tabs on each host `hello`. That also restores the reports after the service worker restarts.
- **On a machine with no host**, the watcher still runs, and each change it reports wakes the service worker, which finds no host and drops the report.
- **What leaves the page, and nothing else:**
  - the address, title and state;
  - `issuedTag`, the last `Run tag: <tag>` found in Claude's latest message (see below);
  - `composerEmpty`, true or false: whether the message box holds any text. Its text is never read out.
- **No chat text ever leaves the page.**
  - The watcher looks only at lines of Claude's latest message that begin `Run tag:`, and sends just the tag that matches the run-tag shape.
  - It sends no other message text, no prompt text and nothing Alex has typed, to the service worker, the host, any file or anywhere else.
  - Tag lines are read only once the message is `finished`, so a half-written tag is never sent.
- **Send cli** (command `sendcli`, sent through `bridge.js` to the tab's content script):

  | Message box | Claude | Does |
  |---|---|---|
  | empty | not writing | types `cli` and sends it |
  | empty | writing | types `cli`, does not send |
  | has text, or chat `unknown` | — | focus only |

  - The content script checks the state again when the command arrives, not as the panel last saw it.
  - It types with the editor's own input path (`insertText`) and sends by clicking the send button. It never presses keys in other windows.
  - `result.json`'s `did` says `sent`, `typed` or `focused`.
  - Focusing the chat always happens.
  - **Built (s11).**
    - Only an orange click writes `action: "sendcli"`; every other colour writes `focus`.
    - `bridge.js` focuses the tab, then asks the watcher with `send-cli`. The watcher decides with `cliPlan(state, composerEmpty)`, from a fresh read of the page.
    - It focuses the box, types with `document.execCommand("insertText", false, "cli")`, and for `send` clicks the send button once it is enabled (polled up to 1.5 s; still disabled means `typed`). It never clicks the stop button.
    - With no answer from the watcher, the result is `focused`.

## 4. Run-tag rules (cli-workflow skill)

The `cli-workflow` skill in the repo gains two rules:

- **One prompt at a time.** Claude does not write a new CLI prompt while a prompt it issued in that thread still has a report it has not read. Design changes discussed in the meantime wait, and go into the prompt written after that report.
- **The tag appears twice.** Every CLI prompt ends with its `Run tag:` line repeated as the last line, so the tag is at the bottom of Claude's reply, where the watcher reads it.
  - prompt-check reads the first `Run tag:` line (`tagInPrompt`, a single non-global match), so a repeated tag is accepted. The s2b prompt proved it live.
  - If the two lines differ, the first one wins. The skill says they must be identical.

## 5. Panel

### Pairing and focus

- **New file `lib\bridge.ahk`.**
  - Reads `tabs.json` and `chats.json` each poll, parsing them only when the text has changed.
  - Writes `command.json` (temp file, then rename) and waits up to 3 s for a matching `result.json`.
  - Pure helpers go in `lib\status.ahk`, tested by `test-status.ahk`.
- **Pairing.**
  - A session with a saved chat link is paired with the tab whose normalised address equals that link.
  - With no saved link, the panel learns one from any tab (see "Learning a link" below). With hand-typed Chrome title text, it learns nothing and the old title match applies.
- **Bringing a window forward.**
  1. The panel writes a `focus` command.
  2. When the result says `ok`, it finds the `chrome.exe` window whose title starts with `windowTitle`, then moves it to monitor 2, maximizes it and activates it. A Chrome window id cannot be turned into a window handle, so the title is the link. The panel activates the window itself because Windows does not let Chrome take the foreground.
  3. On a stale file, no match, a timeout or `ok: false`, it falls back to today's title match, then to opening the saved link.

### State per project code

**Colour says which window to go to; the label says what to do there.**

Each session combines the CLI (its status file and `last-report.json`) with its paired chat (`chats.json`). The rules are checked in this order:

| # | Colour | When | Label |
|---|---|---|---|
| 1 | Grey | Paused, closed or free; or Claude's side matters and the chat is `unknown` or unpaired | `paused` / `closed` / `free` / `chat unknown` |
| 2 | Red (VS Code) | CLI needs approval (red latch, as today) | `Approve` |
| 3 | Red (VS Code) | CLI idle, and `last-report.json`'s `run_tag` is not the CLI's current `run_tag` | `Check CLI` |
| 4 | Green | CLI processing, Claude responding, or both | `CLI working` / `Claude writing` / `Both working` |
| 5 | Orange | Both idle, and the latest report is not read | `Send cli` |
| 6 | Purple | Both idle, report read, and the chat's `issuedTag` is newer than the CLI's `run_tag` | `Paste prompt` |
| 7 | Yellow | Both idle, report read, no newer tag | `Your turn` |

- **Notes on the rules.**
  - **"Idle"** for the CLI means state `waiting` (after an interrupt, as today). For Claude it means `finished`.
  - **"Read by Claude"** is inferred: the paired chat has finished a reply after `last-report.json`'s `pushed_at`, using the chat's `since` for `finished`. There is no Alfred lookup and no database work.
  - **"Newer tag"** means `issuedTag` is present and differs from the CLI's `run_tag`, and its project matches this session. A tag for another project is ignored.
  - Rows 1–3 need only the CLI. Rows 5–7 need a paired, known chat; without one the button is grey `chat unknown`, as row 1 says.
- **Where the keyboard lands (s10d).**
  - The rule is `FocusTarget(color, label)`.
  - Red, and green while the CLI works (`CLI working`, `Both working`): VS Code is activated last.
  - Everything else (purple, orange, yellow, `Claude writing`, grey) and every chat row: Chrome is placed last, and the focus command carries `composer: true`. The host forwards only a literal `true`.
  - `bridge.js` then sends `focus-composer` to the tab's watcher. The watcher focuses the message box and puts the cursor at its end. It types nothing and reads nothing.
  - On the title-match fallback (no bridge), Chrome is still placed last, but the cursor is not moved.
  - **The mouse pointer follows (s12).**
    - After any click on a session button or chat row, the pointer moves to the centre of the window that got the keyboard, so the scroll wheel works there.
    - It uses `SetCursorPos` in screen coordinates, with the thread made per-monitor DPI aware for the window position and the move. That holds on every monitor, including the touch screen.
    - `[panel] pointer=0` in `settings.ini` turns it off. It is on by default.
- **Clicks.**
  - Every colour arranges both windows: VS Code on monitor 1, the chat on monitor 2. The keyboard and the pointer go where described above.
  - **Nothing is ever typed for purple**, or for any colour but orange. Alex reviews every real prompt before it goes in.
  - Orange sends `sendcli` (section 3), and the watcher decides on the live page whether to send, type or only focus.
- **Code.**
  - `ViewOf`, `StepText`, `ChatRowView`, `ProgressSummary` and `FindChatLinkByCode` in `lib\status.ahk`. The panel reads `last-report.json` per checkout, and `chats.json` each poll.
  - The paused, closed and free states and "no status" keep their old colours and second line.
  - Paused, closed and free sessions are left out of the taskbar. A grey button (`chat unknown`) is included, but adds no colour.
  - The second line reads `s9 -> s10 · Paste prompt · 10:45`. The time is the elapsed timer while the CLI processes, and otherwise the time the state was entered.
  - Every attention colour (red too) flashes 5 times, then stays solid. That replaces red flashing until clicked.
- **Learning a link.** With no saved link, no typed Chrome title and a fresh `tabs.json`, each poll looks for a `claude.ai/chat/` tab in any window whose title carries the chat code plus "Claude". It saves that tab's address as the session's link.
- **Watcher, s10 fix.** A new chat moves from `/new` to `/chat/<id>` in place. The watcher now checks at once on any address change: a 500 ms address poll, the Navigation API, and a `watch-recheck` nudge from `bridge.js` on `tabs.onUpdated`. Measured in jsdom: 250 ms.
- **Second line, the run-tag step.** This is the step segment of the CLI's current `run_tag`: `s2`, `s2b`, `s3`. When Claude has issued a newer tag, both are shown: `s2 -> s3`. Then comes the label, then the timer as today.
- **Tooltip.** "Step N of M: <name>" from `docs\progress-<project name>.md` in that checkout.
  - The project name is the code without its thread suffix: `switchboard_bridge-p8v` → `switchboard_bridge`.
  - Steps are the top-level `- [ ]` and `- [x]` lines. N is the first unticked one, and the name is its bold text without the number. M is the number of steps in all. With every step ticked, it shows "Step M of M: done".
  - A missing file, or one with no steps, means no tooltip.
- **Flashing and taskbar.**
  - Red, purple, orange and yellow are attention colours. When a session turns to one of them, it alerts, flashes 5 times and then stays solid until clicked or until its state changes. This is `StillFlashing` for every attention colour, not only yellow.
  - Taskbar priority: red, purple, orange, yellow, green. The taskbar progress bar has only red, yellow and green states, so purple and orange show as yellow there.
- **Unpaired claude.ai chats.**
  - One row each, below the session buttons.
  - Green while `responding`. Yellow once `finished`, until that tab's `viewedAt` is later than the finish; it flashes 5 times when it turns yellow. Grey (`seen`) after that, and grey when `unknown`.
  - Up to 8 rows. A row shows the chat title without " - Claude", then its state.
  - Clicking a row focuses that chat. A stale `chats.json` hides the section.
- **Testing.** Quit the live Switchboard before running the worktree copy. `#SingleInstance` works per file, so both copies would run, both would alert, and both would write `settings.ini`.

## 6. Testing the extension

- While testing, switch the daily extension off in `chrome://extensions` and load the worktree's `extension\` as the test copy. Paste the clipboard secret into the test copy's options page.
  - With both copies on, two hosts write the same files, and the keyboard shortcuts and menus clash.
  - The `origin` field in each file shows which copy wrote it.
- After Finish, reload the daily extension from main, switch it back on, and remove the test copy.

## 7. Hooks: when changes take effect

- **No fresh session is needed.** Claude Code starts a new `node` process for every hook event and reads the script from disk each time. So a change to `prompt-check.mjs` or to `session-status.mjs` takes effect from the next prompt in a checkout that has the change.
  - Only a change to the hook entries in `settings.local.json` needs a fresh session, and this project makes none.
  - Other checkouts get the change only when it reaches main and they gitsync. Until then they write no `run_tag`, and the panel treats a missing tag as unknown: no `Check CLI`, and no step on the label.
- **Rule from switchboard_fixes.** Every hook edit must leave the hook runnable, and then the hook is smoke-run. A broken prompt-check in this worktree would hit every prompt Alex sends here.

## 8. Decisions

- **2026-10-02.**
  - The bridge folder is `%LOCALAPPDATA%\claude-sessions\bridge\`.
  - `service-worker.js` changes by one import line only.
  - There is no manifest `key`.
  - There is one host name, and it is re-pointed to main after Finish.
  - Only one copy of the extension is enabled at a time while testing.
  - The panel activates the Chrome window itself.
  - `install.ps1` takes the extension ids as a parameter.
- **2026-10-02, s2b.**
  - A watcher that cannot read the page reports `unknown`, never `finished`.
  - The colour/label model in section 5.
  - The run tag comes from the status file (CLI) and from `issuedTag` (Claude).
  - "Read" is inferred from a finished reply after the push.
  - Only tags leave a chat; no chat text does.
  - Purple never types.
  - The cli-workflow skill gains the two rules in section 4.
- **2026-10-03.**
  - IDE context blocks are stripped before prompt-check looks for a tag (s5).
  - The claude.ai selectors were proven live. Tags are read from the outermost latest message and from each code block (s10c).
  - The keyboard goes to VS Code for red and a working CLI, and to the chat's message box otherwise (s10d).
  - Only orange types, decided on the live page (s11).
  - The mouse pointer follows the keyboard, on by default (s12).
  - The temporary watcher diagnostics are gone (s12).
