# Technical spec: Switchboard touch screen redesign (switchboard_touch-t4n)

## Overview

Switchboard moves onto Alex's Eyoyo 7-inch touch screen (1024×600 pixels). It
sits to the left of and below his left monitor. The panel is redrawn as an HTML
page shown inside a WebView2 control (Microsoft's built-in browser engine,
embedded in a normal desktop window). AutoHotkey keeps all of the existing
logic: reading status files, git checks, the Chrome extension bridge, focusing
windows, moving the mouse pointer, and the taskbar colour and flashing. The page
only draws what AutoHotkey tells it and reports taps back.

The project also adds a mouse lock: the mouse pointer can no longer wander onto
the touch screen, but finger taps on it still work.

Reference mockup, approved by Alex on the real screen:
`docs/history/switchboard_touch-t4n-mockup.html`. Open it in Chrome on the touch screen
in full screen (F11). The final page should look and behave like it, except
where this spec says otherwise.

## What stays the same

- All status logic, colours and their meanings (red, orange, purple for "Paste
  prompt", yellow, green, grey), the send-cli rules (never send while Claude is still writing; never
  auto-type a prompt for "paste prompt"), step tags, timers and time stamps,
  `main:` and `db:` status, worktree recovery, title overrides.
- Not always on top. It comes forward and flashes when a thread needs Alex.
- The taskbar button stays and keeps its colour priority (red beats yellow beats
  green; a paused session is left out). Yellow flashes 5 times then stays solid.
  On Windows 11 the "green" (normal) state is drawn in the system accent colour.
- After a tile is tapped, the mouse pointer moves to the target window, so Alex
  can let go of the mouse, tap, then pick the mouse up already in the right place.
- Settings live in `%APPDATA%\claude-sessions\`, never in the repo. This now also
  holds the WebView2 data folder and the last chosen mode.

## Architecture

**Host.** The existing AutoHotkey v2 script hosts a borderless window (no
Windows title bar) containing a WebView2 control. The window sets
WS_EX_APPWINDOW so it keeps its taskbar button, and with it the taskbar colour.
The WebView2 engine itself already ships with Windows 11.

**Default and fallback.** The touch window is the default (`[panel] touchui`
missing or 1). It owns Switchboard's one taskbar button: its colour, its flash,
and the come-forward when a thread needs Alex. `touchui=0` brings back the old
panel, which stays in the code until Alex decides to remove it. If WebView2 fails
to start, Switchboard shows the old panel instead.

**WebView2 library.** thqby's `WebView2.ahk` (github.com/thqby/ahk2_lib, MIT),
with its `Promise.ahk` and `ComVar.ahk`, and Microsoft's 64-bit
`WebView2Loader.dll` (WebView2 SDK, Microsoft's licence). All are stored in
`tools\claude-sessions\lib\webview2\` with both licences and a note of the source
commit. `.gitignore` does not exclude the DLL.

**Monitors.** The touch screen is the monitor that is 1024×600 (physical pixels).
- **VS Code** goes to the leftmost of the remaining monitors, and **Chrome** to
  the rightmost. That matches the old fixed numbers 1 and 2 on Alex's layout.
- **One main monitor left:** both go on it.
- **Re-chosen** whenever the monitor layout changes (checked every second and
  before each arrange), so an unplug and replug that renumbers the monitors
  changes nothing.
- **Code:** `AppMonitors()` in `lib/status.ahk`. It sets `VS_MONITOR` and
  `CHROME_MONITOR`, which `lib/bridge.ahk` also reads.

**Page.** A local HTML page under `tools\claude-sessions\ui\`. It must work with
no internet connection, so the font (Atkinson Hyperlegible, open licence) is
stored in the repo, not loaded from Google Fonts.

**Messages.**
- AutoHotkey → page: the full current state as one JSON message, sent every
  time anything changes. The page keeps no state of its own apart from its
  scroll position.
- Page → AutoHotkey: one message per action: open a tile, pause, unpause, move
  to main screen, move back to touch screen, refresh git, and (main screen only)
  open the right-click menu for a tile.

## Layout (docked on the touch screen)

- **Fills the whole 1024×600 screen.** No claude.ai or Windows bars, so the top
  bar can be about 90 pixels tall.
- **Top bar.** Alfred's brown, from `src/index.css` (`--primary` #7A4E37), with
  white text and icons.
  - The wide left part is one tap target that moves Switchboard to the main
    screen. It shows a plug icon, then `main:` and `db:` at 28px, then a large
    arrow: up when docked, down in main screen mode.
  - A long `db:` line takes the "…"; `main:` never shrinks.
  - A `db:` claim over an hour old shows red on a white chip.
  - To its right, a darker brown (#5E3A28) refresh icon button reads "Refreshing
    git" while the refresh runs.
- **Tiles: 3 columns × 3 rows.** Text sizes: project name 30px, action 26px,
  bottom line 26px, all bold.
  - Each tile shows the project name (underscores shown as spaces) and the action
    ("Send cli", "Paste prompt", "Working 3:41" and so on).
  - The bottom line has an icon, then the step tag and git counts. The icon is a
    terminal for a CLI, a speech bubble for a chat, or both for a CLI with its
    chat. During a handover the step shows only the new one ("→s11").
  - Chat tabs have a white inner border.
  - Paused tiles are a darker grey, in italic, with a pause icon.
- **Tile wording.** The mockup's short wording: "Working 3:41", "Paused 2h",
  "Reply ready" and so on. Chat tiles show no timer, because that would need
  changes to the extension, which are out of scope.
- **Git counts.** Each CLI tile's small bottom line keeps the changed-file count
  (±N) and, for main, the ahead count (↑N).
- **Dropped.** The "• new" badge, the "Step N of M" hover tip, and the orphans
  strip.
- **Closed sessions** (no VS Code window) read "Closed, tap to reopen". A tap
  keeps today's recovery behaviour.
- **Orphans.** Claim owners with no worktree show as grey "No worktree · N held"
  tiles at the end of the list. A tap does nothing for now. A worktree idle for
  more than 3 days gets "· idle Nd" on its action line.
- **Sort order.** Active CLI projects first, then standalone claude.ai chats,
  then paused CLI projects, then orphans. Within each group: red,
  orange, purple, yellow, green, then anything else. Closed, free-main and
  no-status sessions are in the active group, after green. Ties keep their current order, so tiles don't jump around.
  The most urgent tile is top-left, which is easiest for Alex's left thumb.
- **Right side.** Only tall up and down arrows. Each shows "N more" when tiles
  are hidden in that direction; the down arrow turns yellow when there are
  hidden tiles below. Swiping also scrolls, snapping by row.

## Touch actions

- **Tap a tile:** the existing click behaviour for that session or chat. That
  includes the send-cli rules, and the reopen dialog for a closed session.
  Orphan tiles do nothing.
- **Long-press a CLI tile (600 ms):** pause it, or unpause it if paused. A dark
  bar fills across the tile while held. Moving the finger more than about 12
  pixels cancels, so a swipe never pauses anything. Chat tiles ignore long-press.
- **Refresh git:** the old panel's refresh.
- **Feedback:** every tap briefly brightens what was tapped.
- **How actions run:** each one runs on its own AutoHotkey thread, never inside
  WebView2's message callback.

## Main screen mode

- Tapping the top bar moves Switchboard onto the primary monitor and puts the
  mouse pointer in its middle. The bar's arrow then points down, and tapping or
  clicking the bar re-docks.
  - The window is centred, at 125% of the 1024×600 page (WebView2 zoom 1.25),
    capped at 90% of the monitor.
  - If the primary monitor is the touch screen, it uses the first other monitor.
- In main screen mode, everything works with the mouse. Right-clicking a CLI
  tile opens the existing AutoHotkey right-click menu (title overrides, chat link,
  mouse lock). Right-click does nothing while docked.
- If the touch screen is not connected, Switchboard opens in main screen mode
  and the bar says the touch screen is not connected.
- Unplugging or replugging is noticed within a second: the window moves to the
  main screen, then re-docks.
- The last mode is remembered between restarts (`[panel] touchmode`).

## Mouse lock

- **Goal:** the mouse pointer cannot enter the touch screen, while finger taps
  on the touch screen still work.
- **Chosen: `ClipCursor`.** This Windows function confines the pointer to one
  rectangle: the bounding box of every monitor except the touch screen.
  - **Why.** In the step 1 test (2026-10-03), it passed every check. The mouse
    stopped at the edge, and finger taps, arrows, swipes and the Ctrl crossing
    all worked.
  - **Why taps survive.** Chrome and WebView2 take finger input as touch or
    pointer input, not as mouse events. The test's touch-event counter stayed
    at 0 in both modes, so the fence never sees a tap.
  - **The hook approach worked too.** Its touch detection and snap-back are not
    needed, so it was dropped as the more complex of the two.
- **Re-applied every second.** Windows resets the clip on some events, such as
  a permission prompt or the lock screen.
- **No touch screen:** if no 1024×600 monitor is connected, the lock does
  nothing. It checks every second, so plugging the screen in or out is picked up.
- **Escape hatch:** holding Ctrl lifts the fence while held. The lock can be
  turned on and off from the right-click menu and from the tray menu. The setting
  is `[panel] mouselock=` in `%APPDATA%\claude-sessions\settings.ini`, and it is
  on by default.
- **Separate process:** `tools\claude-sessions\lib\mouse-lock.ahk`. Switchboard
  starts it at launch when the lock is on, and closes it on exit or when the lock
  is turned off. It is passed Switchboard's process ID and exits on its own if
  Switchboard disappears, so a crash cannot leave the fence up. It releases the
  clip when it exits.
- The pointer jump after a tile tap only ever targets the main monitors, so it
  is unaffected.

## Out of scope

- Any change to status logic, hooks, the Chrome extension or the claims system.
- Settings screens or typing on the touch screen.

## Database

None. This project touches no database tables, functions or deploys.

## Success criteria

1. The mouse cannot drift onto the touch screen, and every tile and button there
   still responds to a finger.
2. Docked, Switchboard fills the touch screen and matches the mockup, with live
   data.
3. Tap opens, long-press pauses and unpauses, swipe and arrows scroll, and the
   "N more" counts are correct.
4. The top bar moves Switchboard to the main screen and back; right-click works
   there; it opens on the main screen when the touch screen is unplugged.
5. Taskbar colour and flashing behave exactly as before.

## Tests

- **`smoke-test.ahk`** checks what is drawn through the state JSON sent to the
  page (`TouchState()`), not the old controls' text. Only the flash count still
  reads the old panel. It drives page messages through `TouchDo()` and uses a
  fixed fake monitor layout.
- **`test-status.ahk`** covers the pure helpers in `lib/status.ahk`:
  - sorting, colours, wording and icons
  - JSON
  - touch commands and window placement
  - the mouse-lock fence, and the VS Code/Chrome monitors
- **Live checks.** The WebView2 window itself (touch input, layout fit, taskbar
  button) was checked live with scratch harnesses and injected touch, then by
  Alex on the real screen.
