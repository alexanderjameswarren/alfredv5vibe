# Progress: Switchboard touch screen redesign (switchboard_touch-t4n)

## Status: Complete (2026-10-05)

Spec: docs/history/technical-spec-switchboard_touch-t4n.md
Mockup: docs/history/switchboard_touch-t4n-mockup.html

### Development steps
- [x] Step 1: Mouse lock test. A small separate test script tries both
      approaches (ClipCursor and the low-level mouse hook). Alex checks that the
      mouse is blocked and that taps on the touch screen still work. Pick one.
- [x] Step 2: Add the chosen mouse lock to Switchboard, with the hold-Ctrl
      escape and an on/off item in the right-click menu.
- [x] Step 3: WebView2 host test. Switchboard opens a borderless window on the
      touch screen showing a placeholder page; taps, swipes and long-presses
      reach the page; one message goes each way. The old panel stays as it is.
- [x] Step 4: The real page, built from the mockup, showing live data from
      AutoHotkey (display only). The old panel stays available as a fallback
      behind a setting.
- [x] Step 5: Actions: tap opens, long-press pauses and unpauses, arrows and
      swipe scroll, refresh git.
- [x] Step 6: Main screen mode: move there and back, pointer centred,
      right-click menu, opens there when the touch screen is unplugged, mode
      remembered.
- [x] Step 7: Check taskbar colour and flashing with the new window; make the
      new page the default; remove the old panel drawing code once Alex agrees.
      *Done except the removal: the old panel was deliberately kept behind
      `touchui=0`. Removing it is logged in Alfred as a follow-up.*

### Notes
- 2026-10-03, plan decisions (all now in the spec):
  - Purple stays. Sort colours: red, orange, purple, yellow, green, then the rest.
  - The mockup's short wording, with no chat timer.
  - Git counts (±, ↑) stay in the tile's bottom line. Orphans become grey "Closed,
    tap to reopen" tiles. The "new" badge and the step hover tip are dropped.
  - Closed, free-main and no-status sessions sort into the active group, after
    green.
  - The touch screen is found by its 1024×600 size. VS Code goes on the left
    remaining monitor and Chrome on the right.
  - WS_EX_APPWINDOW, so the window keeps its taskbar button.
  - The mouse lock is a separate script that Switchboard starts and stops. Its
    on/off is in the tray menu too.
  - `smoke-test.ahk` is rewritten against the state JSON.
- WebView2 library: thqby's WebView2.ahk (MIT) with Promise.ahk and ComVar.ahk,
  plus WebView2Loader.dll (64-bit), in `lib/webview2/`. `.gitignore` does not
  exclude the DLL.
- The step 2 lock script stays at `lib/mouse-lock.ahk` (the claimed path), run as
  its own process.
- 2026-10-03, step 1 results (Alex):
  - ClipCursor: every check passed. The mouse stops at the edge, taps open tiles,
    arrows and swipes scroll, and the Ctrl crossing works.
  - Hook: also worked, and taps opened tiles.
  - "Touch events" stayed at 0 in both modes. Chrome takes finger taps as touch
    or pointer input, so no touch-generated mouse events reach a hook.
  - **Decision: ClipCursor.** The hook and snap-back are not needed.
    `mouse-lock-test.ahk` is deleted.
- 2026-10-04, step 2 results (Alex): all 14 checks passed. The lock blocks, taps
  work, the Ctrl crossing and snap-back work, the tray and right-click toggles
  work, it survives Win+L, it is released on exit, and the setting is remembered.
- 2026-10-04, step 3 built behind `[panel] touchui=1` (off by default):
  - Vendor files in `lib/webview2/` and `ui/fonts/`, with sources and the DLL's
    SHA-256 in `lib/webview2/README.md`.
  - Folder claims did not cover the files inside them, so the 11 files were
    claimed one by one. The claims bug is logged in Alfred.
  - The panel's global `SETTINGS` is renamed `SETTINGS_INI`. WebView2.ahk has a
    local `settings`, and `#Warn` flags the clash.
  - Claude's own live test used injected touch with the real mouse lock running.
    The window fits the touch screen exactly. Tap, long-press, a short press and
    swipe all reach the page and AutoHotkey. The tick and the local font both
    work.
- 2026-10-04, step 3 results (Alex): everything passed. The borderless window
  fills the touch screen, the taskbar button is there, and the tick counter runs.
  The font works offline. Taps A/B/C, long-press, a short tap, the slide-off
  cancel and swipe all work. The mouse lock still holds, and `touchui=0` turns the
  window off. The tooltips showed on the main monitor, where the pointer is
  fenced; they were removed in step 4.
- 2026-10-04, step 4 built (display only, behind `touchui=1`):
  - `ui/switchboard.html` replaces the placeholder.
  - `TouchState()` in `claude-sessions.ahk` sends the whole sorted state as JSON
    whenever it changes. The page sends `ready` on load and gets the state back.
  - The pure helpers in `lib/status.ahk` are tested in `test-status.ahk`:
    TileSort, TileColor, TileName, CliAction, ChatAction, OrphanOwners, IdleDays
    and ToJson.
  - `smoke-test.ahk` now checks the state JSON instead of the old controls; only
    the flash count still reads the old panel.
  - How the s2 orphan decision was read:
    - "Closed, tap to reopen" goes on closed sessions (no VS Code window), in the
      active group after green. That is today's recovery.
    - Claim owners with no worktree become grey "No worktree" tiles at the end.
    - A worktree idle for more than 3 days gets "idle Nd" in its bottom line.
  - Fixed beyond the mockup: `scroll-padding`. Without it, snapping hid the top
    padding and the "N more" count was wrong.
- 2026-10-04, step 4 results (Alex): all 18 checks passed.
- 2026-10-04, follow-ups before step 5:
  - **Pairing bug (existing, not this project).** Main keeps its saved
    `[chatlink] main=` after it is rebound to a new project. `LearnChatLink` only
    learns while the link is empty, so the new project's chat shows as a separate
    chat in both the old panel and the touch page. Alex is logging it separately.
  - The bottom line is now 22px.
  - The CLI/Chat labels are replaced by icons: `icon` in the state is "cli",
    "both" or "chat".
- 2026-10-04, s5b results (Alex): the icons pass. At arm's length 22px was still
  too small, so the bottom line is now 26px and the icons scale with it.
  - Measured on the touch screen at 26px. **Fits:** Alex's real tiles
    (`s5c ±27` with both icons, `s2 ±3`, the chat), `s5b ±27 ↑3` with both
    icons, `s2b ±3 ↑1` and `s3`.
  - **Gets "…":** `s10→s11 ±127 ↑12` with both icons (220 of 184px) and
    `s9→s10 ±4 idle 4d` (238 of 219px). The ellipsis cuts the end, so it is the
    counts that are lost.
  - Proposed, awaiting Alex:
    - Show only the new step during a handover (`→s11`).
    - Move "idle Nd" to the action line.
- 2026-10-04, s5c results (Alex): 26px reads well, the icons match the text, and
  no real tile wraps. Both shortenings are applied: `TileStep()` shows "→s11",
  and idle shows as "Your turn · idle 4d". The bubble is not dropped.
  - Re-measured, both fit: `→s11 ±127 ↑12` with both icons (177 of 177px) and
    `→s10 ±4`.
  - Known edge: "Paste prompt · idle 4d" wraps the action onto two lines. It fits
    a one-line name, but would clip under a two-line worktree name.
- 2026-10-04, step 5 built:
  - The page sends `tap`, `hold` (CLI tiles only) and `git`. `TouchCommand()`
    maps them, and `TouchDo()` calls the old panel's own handlers.
    - Tap a CLI tile: `ButtonClick`. That covers the send-cli rules, and a closed
      session's reopen dialog.
    - Tap a chat tile: `ChatRowClick`.
    - Long-press a CLI tile: `PauseClick`.
    - Refresh git: `RefreshGit`.
    - Orphan tiles and the top bar do nothing.
  - Each action runs on its own AutoHotkey thread (`SetTimer -1`), never inside
    WebView2's callback.
  - Feedback: a 160 ms brighten-and-shrink on every tap, and the 600 ms fill bar
    on a hold.
  - "Paused Nm" now counts from the pause (`s.pausedAt`), not from the last state
    change.
  - Claude's live test used injected touch on the real tiles under the real mouse
    lock, with window moves faked. Taps, pause and unpause, the slide cancel, a
    chat long-press (ignored) and Refresh git all behaved correctly.
- 2026-10-04, step 5 results (Alex): all 14 checks passed.
- 2026-10-04, paused tiles: their own colour "paused", darker than chat grey.
  - Light theme: #3F4652 with white text. Dark theme: #2B323D with #E6EAF0.
  - The text is italic, and a two-bar pause icon in the text colour sits before
    "Paused Nm".
  - Seen and idle chats are unchanged.
- 2026-10-04, step 6 built (main screen mode):
  - `TouchPlacement()` picks the position. Docked, it fills the touch screen.
    Otherwise it is centred on the primary monitor, or the first non-touch
    monitor if the primary is the touch screen.
  - Main screen size: 1024×600 × 1.25 × that monitor's DPI scale, with the
    WebView2 zoom at 1.25, so the page keeps its layout. It is capped at 90% of
    the monitor.
  - A top-bar tap toggles the mode (`NextTouchMode()`) and saves
    `[panel] touchmode`. Undocking activates the window and moves the pointer to
    its middle.
  - With no touch screen it opens in main screen mode, and the bar reads "Touch
    screen not connected".
  - The monitor layout is checked every second, so plugging the touch screen in
    or out re-places the window. The remembered mode is unchanged, so plugging it
    back in re-docks.
  - Right-click works only in main screen mode, on CLI tiles. It opens
    `ButtonMenu`, the old panel's menu with the mouse lock item.
  - Right-click and long-press: a hold starts only on the primary button, so a
    right-click never pauses.
  - Claude's live test: docked → main → re-docked, with correct sizes, zoom,
    wording, saved mode and pointer move. A separate watcher process saw the
    menu open in main screen mode and not when docked. Unplugging is covered only
    by unit tests and Alex's check.
- 2026-10-04, step 6 results (Alex): all 19 checks passed, including unplugging,
  replugging, and the lock being off with no touch screen.
- 2026-10-04, top bar polish:
  - **Colours:** Alfred's brown from `src/index.css`: `--primary: #7A4E37`
    (line 12) for the bar, and `--primary-hover: #5E3A28` for the refresh button.
    The text is white: about 7:1 on #7A4E37 and about 10:1 on #5E3A28. The same
    in both themes and both modes.
  - **Icons:** "Switchboard" is replaced by a white plug icon. An up arrow sits
    beside "Tap to move to main screen", and a down arrow beside "Move back to
    touch screen".
  - **Move text:** 16 → 20px, the same as main: and db:. Measured at 1024 wide,
    all three fit. A long db: line takes the "…", and main: never shrinks.
  - **Stale db:** a claim over an hour old shows as a yellow chip with dark text,
    because red is unreadable on brown.
  - **Refresh git:** a circular-arrow icon on a 110×80 button. While it runs it
    reads "Refreshing / git". AutoHotkey posts `gitDone` when `RefreshGit()`
    returns. It shows for at least 600 ms, and goes back after 20 s at most.
- 2026-10-05, s7b results (Alex): all 10 checks passed.
- 2026-10-05, top bar, round 2:
  - `main:` and `db:` are now 28px. Measured at 1024 wide: "main:
    sam_glance-p7k" uses 294px, and a long `db:` line still takes the "…".
  - The move text is gone; only a 52px white arrow remains (↑ docked, ↓ main
    screen). "Touch screen not connected" stays as text.
  - The stale `db:` chip is now red text on white.
- 2026-10-05, step 7 built (the old panel is not removed):
  - `touchui` defaults to on, and `touchui=0` brings the old panel back.
  - With the touch page on, the old panel is never shown. The touch window owns
    the one taskbar button: `TaskbarGui()` sets the colour, and `Alert()` brings
    it forward and flashes it.
  - Tray > Show panel brings the touch window forward.
  - If WebView2 fails, it falls back to the old panel.
  - A `TaskbarButtonCreated` handler re-applies the colour after Explorer
    restarts.
  - Live check: the running Switchboard has exactly one window that can take a
    taskbar button, "Switchboard touch". Its colour was confirmed by pixel
    sampling. On Windows 11 the "green" (normal) state is drawn in the accent
    colour (light blue here), and yellow shows as #FCE100.
  - Claude first misread the accent colour as "no colour". It briefly added a
    5-second re-apply, then removed it; the handler stays.
  - **Open item from the s2 decisions:** VS Code and Chrome monitors by left/right
    position is in the spec but never built. `VS_MONITOR`/`CHROME_MONITOR` are
    still fixed numbers. (Built in s8b, below.)
- 2026-10-05, s8b, monitors by position (the s2 decision):
  - **Today's numbering (AutoHotkey):** 1 = DISPLAY1 at 0,0 (left, primary),
    2 = DISPLAY5 at 1920,0 (right), 3 = the touch screen. So VS Code = 1 is the
    left monitor, and Chrome = 2 the right.
  - **The rule:** `AppMonitors()` puts VS Code on the leftmost non-touch monitor
    and Chrome on the rightmost. With one non-touch monitor, both go on it.
  - **Unchanged today:** on Alex's PC it picks 1 and 2, as before.
  - `UpdateAppMonitors()` sets the `VS_MONITOR`/`CHROME_MONITOR` globals. It runs
    every Refresh and before each `Arrange`, and recalculates only when the layout
    changes. `lib/bridge.ahk` (not claimed) is unchanged; it still reads
    `CHROME_MONITOR`.
  - The monitor list is read in physical pixels (`PhysicalMonitors()`) and is
    swappable (`listMonitors`), so the smoke test uses a fixed layout.
  - Tests:
    - test-status: today's layout, renumbered after a replug, the right monitor
      numbered first, one main monitor, three monitors, and touch screen only.
    - Smoke: the real `Arrange` with a renumbered layout puts VS Code on 3 and
      Chrome on 2; with one main monitor, both go on 2.
  - Alex's running Switchboard was not restarted.
- 2026-10-05, s8 and s8b results (Alex): all checks passed.
  - The touch page is the default, with one taskbar button. The accent-blue
    "green" turns yellow when a session needs Alex, and Switchboard comes forward
    without taking the keyboard.
  - Show panel works, and `touchui=0` and back works.
  - Monitors by position work, including unplug and replug.
- 2026-10-05, close-out:
  - The old panel is kept on purpose behind `[panel] touchui=0`. Removing it is a
    follow-up logged in Alfred.
  - Other follow-ups raised during the project:
    - Orphan tiles should become red, with tap-to-release. Logged by Alex.
    - Main keeps a stale `[chatlink]` after a rebind. This is the existing pairing
      bug, diagnosed in s5b, for Alex to log.
  - The spec, progress and mockup moved to `docs/history/`. They were untracked,
    so Claude moved them with the file tools rather than `git mv`.
