# Progress: switchboard_smoke-r5j

## Status: In Progress

Two fixes, in the main checkout.

### Steps
- [x] Step 1: plan (read-only)
- [x] Step 2: smoke test uses scratch settings; guard judges only the parts of a command that write
- [ ] Step 3: Alex's hand tests

### 1. Smoke test read the real settings.ini
`smoke-test.ahk` included the panel before it pointed `SETTINGS_INI` at its
scratch copy, so the panel's startup read `%APPDATA%\claude-sessions\settings.ini`
(touchmode among others) and ran two `Refresh()`es that could write it
(`lastclick`, `chatlink`, `paused`). Fix: the panel's settings folder comes from
`SWITCHBOARD_SETTINGS_DIR` when set; the smoke test sets it before the include
and checks the real file's modified time is unchanged at the end.

### 2. Guard blocked a command that only read repo files
`rm -rf "$S"; mkdir -p "$S"; git archive HEAD tools/claude-sessions | tar -x -C "$S"`
was blocked because any write command made every repo path in the whole
command count. Fix: split at `;` `&&` `||` and newlines outside quotes
(pipelines stay whole) and check only the parts that write, with `NAME=value`
from earlier parts expanded. Falls back to the whole command for `cd`/`pushd`/
`Set-Location`, an unresolved variable, or `$(…)`/backticks in a writing part.
Also new: `tar -x`, `unzip` and `find … -delete` count as writes.

### Notes
- tar -x and unzip are judged on their `-C`/`-d` folder when they name one;
  without one they are strict. `tar -x` with no `-C` into a repo cwd, naming no
  repo path, is still not caught: the guard does not know the cwd.
- A bare folder name (`src`) is still not read as a path, as before.
- Step 2 tests: CLI tooling 125/125, app 2030/2030, Switchboard all passed; real
  settings.ini modified time unchanged across the run.
