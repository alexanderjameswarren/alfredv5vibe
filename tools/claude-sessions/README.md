# Switchboard (claude-sessions)

A desktop panel with one coloured button per Claude Code session on alfred-v5: the
main checkout plus each worktree. Spec: `docs/technical-spec-switchboard.md`.

## Start it from main

1. Needs AutoHotkey v2 (`C:\Program Files\AutoHotkey\v2\`). Nothing else to install.
2. Quit any other copy first: right-click its tray icon, then Exit. A worktree's copy is
   a different file, so it would keep running alongside.
3. Double-click `C:\Users\Alex\projects\alfred-v5\tools\claude-sessions\claude-sessions.ahk`,
   or use the Switchboard shortcut below.

The X button minimizes the panel; to quit, right-click the tray icon, then Exit. The
tray, taskbar and panel use `alfred.ico`; if it is missing they fall back to the green H.

## Shortcuts: Start menu and login

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\claude-sessions\install-shortcuts.ps1
```

Writes a "Switchboard" shortcut to the Start menu Programs folder and to the Startup
folder, both running this checkout's `claude-sessions.ahk` with `alfred.ico`. Rerunning
just overwrites them. Add `-Remove` to delete both.

- **Pin to Start:** Start, type `Switchboard`, right-click it, Pin to Start (or Pin to
  taskbar).
- **Stop starting at login:** Settings > Apps > Startup and switch Switchboard off, or
  delete `Switchboard.lnk` from `shell:startup` (Win+R). Rerunning the installer puts it
  back.

## Setting up a new PC from scratch

1. Install AutoHotkey v2 and Node (`C:\Program Files\nodejs\`), and clone alfred-v5 to
   `C:\Users\Alex\projects\alfred-v5` (or set `[panel] repo=`, below).
2. Load the Chrome extension from the main checkout's `extension\` folder and give it
   the secret. See `extension\README.md`, "Installing it on a machine".
3. Register the Chrome bridge with the extension's ID from `chrome://extensions`. Run
   from the main checkout:
   ```
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\claude-sessions\bridge\install.ps1 -ExtensionId <ID>
   ```
   Then click **↻** on the extension's card. `%LOCALAPPDATA%\claude-sessions\bridge\tabs.json`
   appears within a few seconds.
4. Install the shortcuts (below) and start Switchboard.

Without step 3 the panel still works, but the old way: it matches only the active tab
of each Chrome window by title, and has no chat section.

## Reading the buttons

Colour says which window to go to; the second line says what to do there, after the
CLI's run-tag step (`s9`, or `s9 -> s10` when Claude has issued a newer prompt).

| Colour | Label | Where the keyboard and pointer go |
|---|---|---|
| Red | `Approve`, or `Check CLI` (idle, with no report for its run) | VS Code |
| Green | `CLI working` / `Both working` | VS Code |
| Green | `Claude writing` | the chat's message box |
| Orange | `Send cli`: there's a report Claude hasn't read. A click types and sends `cli` if the box is empty and Claude is idle. | the chat |
| Purple | `Paste prompt`: Claude issued a newer run tag. Nothing is typed. | the chat |
| Yellow | `Your turn` | the chat |
| Grey | `chat unknown`, `paused`, `closed`, `free`, `no status` | the chat |

- Red, purple, orange and yellow flash 5 times, then stay solid.
- Hovering a button shows "Step N of M: name" from the project's `docs\progress-*.md`.
- Below the buttons, one row for each claude.ai chat with no session: green while
  writing, yellow when it finishes unseen, grey once seen. A click brings it forward.

Full rules: `docs/technical-spec-switchboard_bridge.md`, section 5.

## What it reads and writes

- Reads each checkout's `.clip\session-status.json` (written by the repo's hooks), the
  transcript tail, `.clip\last-report.md`, `.git\alfred-claims.json` and
  `.git\alfred-project-code.json`, and runs `git --no-optional-locks` hidden for counts.
- Reads each checkout's `.clip\last-report.json` (written by `scripts/clip.mjs`) and
  `docs\progress-*.md`, and the bridge's `tabs.json`, `chats.json` and `result.json`.
- Writes `%APPDATA%\claude-sessions\settings.ini`: pause state, title overrides, chat
  links, last-click times. Under `[panel]`:
  - `repo=` points it at another clone;
  - `bridge=` points it at another bridge folder;
  - `pointer=0` stops the mouse following the keyboard;
  - `mouselock=0` turns the mouse lock off (below);
  - `touchui=0` brings back the old panel instead of the touch window (below), which is the default;
  - `touchmode=` is that window's remembered mode, `touch` or `main`.
- The touch window's WebView2 profile lives in `%APPDATA%\claude-sessions\webview2\`.
- Writes the bridge's `command.json` when you click. It never writes to the repo.

## Which screen gets which window

A click puts VS Code on the leftmost monitor and Chrome on the rightmost, never on the touch screen (the 1024×600 one). With only one other monitor, both go on it. Monitors are matched by position, not by Windows' numbering, so unplugging and replugging a screen changes nothing.

## Mouse lock (`lib\mouse-lock.ahk`)

Keeps the mouse pointer off the 1024×600 touch screen, while finger taps on the touch screen still work.
- **How:** Windows `ClipCursor` fences the pointer inside the box around the other monitors, re-applied every second.
- **Crossing:** hold Ctrl to lift the fence while it is held.
- **Turning it off:** use **Mouse lock** in the tray menu or a button's right-click menu. The choice is remembered.
- **Process:** Switchboard starts the lock as its own process and closes it on exit. The lock also exits on its own if Switchboard is gone.
- **No touch screen:** the lock does nothing.
- **Tests:** the smoke test never starts it.

## Touch window (the default; spec: `docs/history/technical-spec-switchboard_touch-t4n.md`)

Switchboard is a borderless window filling the 1024×600 touch screen. It is a WebView2 control showing `ui\switchboard.html`, a 3×3 grid of tiles.
- **Taskbar:** it owns Switchboard's one taskbar button, with the same colours, flashing and come-forward as before. On Windows 11 the "green" state shows in the system accent colour.
- **Going back to the old panel:** set `touchui=0` under `[panel]` in `%APPDATA%\claude-sessions\settings.ini`, then Exit from the tray and start Switchboard again. Delete the line, or set it to `1`, to return. If WebView2 fails to start, Switchboard falls back to the old panel by itself.
- **How it updates:** AutoHotkey sends the whole state as one JSON message whenever it changes (`TouchState()`). The page only draws it.
- **Tap a tile:** does what clicking its old button or chat row does.
- **Long-press a CLI tile (600 ms):** pauses or unpauses it.
- **Refresh git:** works as on the old panel.
- **Arrows and swipe:** scroll the tiles.
- **Tap the top bar:** moves the window to the main screen, centred and larger, with the pointer in its middle. Tap it again to move back.
  - In main screen mode, right-click a session for its old menu.
  - The mode is remembered in `[panel] touchmode=touch|main`.
  - With no touch screen it opens on the main screen and re-docks when the screen is plugged back in.
- **No internet needed:** the page is served from the `ui\` folder as `https://switchboard.ui/`.
- **Font:** Atkinson Hyperlegible, in `ui\fonts\`.
- **The old panel** is unchanged and still in the code. It is hidden unless `touchui=0`.
- **The WebView2 library:** in `lib\webview2\`; its sources and licences are in that folder's README.

## The Chrome bridge (`bridge\`)

- `host.mjs` is the native messaging host Chrome starts. `host.bat` launches it, and
  `install.ps1` registers it.
- It writes only to `%LOCALAPPDATA%\claude-sessions\bridge\` (and `host.log` there),
  and never runs any other program.
- The registry entry points at one `host.bat`. If you run `install.ps1` from a worktree,
  rerun it from main before that worktree is removed.
- Hand checks, no Chrome needed:
  - `node tools/claude-sessions/bridge/try-host.mjs` sends a fake tab and chat list
    through the host.
  - `node tools/claude-sessions/bridge/focus-tab.mjs <tabId>` (or `--url <address>`,
    `--sendcli`) asks Chrome to focus a tab, and prints the reply.
- Hooks write status only once they are in that checkout, and need a fresh Claude Code
  session there after they first arrive.

## Tests

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/claude-sessions/run-tests.ps1
```

Runs `test-status.ahk` (helpers), `smoke-test.ahk` (the real panel on scratch files,
fake windows, a scratch settings file and a scratch bridge folder) and
`bridge\host.test.mjs` (the host). The AHK tests fail on any `#Warn` warning. The
panel briefly shows and flashes during the smoke test. Run the AHK files through this
script or PowerShell, not Git Bash, which mangles `/ErrorStdOut`.
