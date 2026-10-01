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

## What it reads and writes

- Reads each checkout's `.clip\session-status.json` (written by the repo's hooks), the
  transcript tail, `.clip\last-report.md`, `.git\alfred-claims.json` and
  `.git\alfred-project-code.json`, and runs `git --no-optional-locks` hidden for counts.
- Writes only `%APPDATA%\claude-sessions\settings.ini`: pause state, title overrides,
  chat links, last-click times, and `[panel] repo=` to point it at another clone.
  It never writes to the repo.
- Hooks write status only once they are in that checkout, and need a fresh Claude Code
  session there after they first arrive.

## Tests

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/claude-sessions/run-tests.ps1
```

Runs `test-status.ahk` (helpers) and `smoke-test.ahk` (the real panel on scratch files,
fake windows and a scratch settings file). Either fails on any `#Warn` warning. The
panel briefly shows and flashes during the smoke test.
