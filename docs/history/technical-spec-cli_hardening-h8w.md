# Technical spec: CLI workflow and Switchboard hardening (cli_hardening-h8w)

## Overview

Eleven fixes to the CLI tooling: gitpush, the claims guard, the prompt check and
its tests, and to the Switchboard touch page. No database work.

## Bugs

| # | Alfred id | Bug | Cause | Fix |
|---|---|---|---|---|
| 1 | mux0nbt6bmr8semdb2j | Refusals look like success | `git-flow.mjs:stop()` writes plain stdout. Exit 0 on gitpush `main()` "nothing recognised" (:682) and blank selection (:667). The PowerShell wrapper `Invoke-AlfredGit` never passes `$LASTEXITCODE` on, and its own refusals `return` 0 | A real refusal prints a red banner on stderr and exits non-zero. The wrapper exits with node's code |
| 2 | mux0nyh5ur8y0ny8kd9 | Finish from inside the worktree it removes | `doFinish` only warns when `isCurrent`, then merges, pushes and releases, and only the removal fails | Refuse before the confirm. Also compare `process.cwd()` with the worktree path |
| 3 | mux0o0mr8jrll7apeyv | Claims tests fail when a live session writes the real log | `hooks.test.mjs` `drive()` and the full-run test, and `claims-folders.test.mjs` `after`, require the real `.clip/claims-guard.log` and `session-status.json` to be byte-identical before and after | Point every spawned hook at temp files through `CLAIMS_GUARD_LOG` / `SESSION_STATUS_FILE`. Assert only that no line carrying this run's test marker reached a real file |
| 4 | mv1ddl9955z4zpsl2fg | Paths with spaces | Guard: `claims-core.mjs:repoPathsIn` splits on whitespace and ignores quotes. gitpush: `doCheckpoint` joins `--paths` and re-splits it on whitespace (`parseSelection`) | Quote-aware tokens in the guard. Each `--paths` argv token is kept whole |
| 5 | mv46h34hj2ezq1vy85m | Chat prompts treated as CLI prompts | `project-code.mjs:tagInPrompt` accepts a `Run tag:` line anywhere and never checks `Window:`. `extension/claude-watch.js:extractTag` takes the last tag line anywhere in Claude's message | A CLI prompt is one whose first line is `Run tag:` and second line is `Window:`, in both places |
| 6 | mv46amzxds1xk2ieyse | No way to clear the red wrong-CLI tile | `prompt-check.mjs:block()` writes `blocked`, which latches `red` (`session-status.mjs:nextStatus`) and shows as "Approve" | A distinct wrong-window state and a clear action. **The interaction is chosen by Alex before it is built** |
| 7 | muve2ajrwxevn3okijc | Orphan claims tile | `status.ahk:OrphanOwners` draws grey tiles with no action | A red tile with a confirmed release (`claims.mjs cleanup <owner>`). **The interaction is chosen by Alex before it is built** |
| 8 | muyp0eth0pgb73400zh9 | Tiles move when their status changes | `status.ahk:TileSort` sorts by colour rank before the previous position | Drop the colour from the key. Group, then previous position |
| 9 | muvftaeu6suysg3bzk | Close-out leaves docs in `docs/` | Nothing exists | gitpush Finish moves `docs/technical-spec-<code>.md` and `docs/progress-<code>.md` to `docs/history/`, same names |
| 10 | muvcsaqcyc94k3ojr3d | Can the old panel go? | — | **Report only, removal deferred.** See below |
| 11 | (new) | Tile shows red "Check CLI" while the session still works | See below | See below |

### Bug 10: what still depends on the old panel

- The `touchui=0` fallback and the fallback when WebView2 fails (`claude-sessions.ahk` :34, :1019).
- `TaskbarGui()`.
- The touch actions, which reuse the old handlers: `ButtonClick`, `ChatRowClick`, `PauseClick`, `ButtonMenu`.
- The chat tiles, which need `RefreshChatRows`.
- The right-click menu on the main screen.
- `smoke-test.ahk`, which drives the panel and asserts that it owns the taskbar button.
- README lines 87, 111, 115 and 123.

Removing the panel means first moving those handlers out of it. That is not part of this project.

### Bug 11: cause (from the guard log, 2026-10-11 12:02–12:06)

**The hypothesis is disproved.** All three subagent hand-backs were *allowed* as `machine envelope <agent-message>` (log 19:03:50Z, 19:04:20Z, 19:04:38Z UTC). Each one wrote `processing`, which is green.

**The red came from the Stop hook** (`.claude/hooks/session-status.mjs`). It wrote `waiting` whenever the main session ended its turn to wait for background agents. In `status.ahk:ViewOf`, an idle CLI whose `run_tag` has no pushed report yet shows red "Check CLI". The next hand-back's UserPromptSubmit then set it back to processing, which is green.

**Fix (step 5):**
- A Stop while this session still has background work running does not write `waiting`.
- How to detect that from the hook payload or transcript is worked out in step 5.
- If it cannot be detected reliably, the fallback is that "Check CLI" waits a grace period before it turns red.

## Decisions

- **Cancels.** Only real refusals exit non-zero with the red banner. A cancel Alex chooses on purpose at a prompt exits 0 with a plain "Cancelled" line.
- **Out of scope.** `.claude/skills/cli-workflow/SKILL.md` (held by restructure_p3-x4n) and `docs/history/` (held by warren_buffet_p2-m4t) are not touched.
- **Switchboard step.** Before tap-to-clear (6) or orphan release (7) is built, stop and describe the interaction with two or three alternatives to a double tap.
- **To decide in step 6: untagged replies.** A reply to an untagged message is pushed without a run tag. Its `reportTag` then never matches the CLI's `run_tag`, so the tile stays red "Check CLI" until the next tagged prompt.
- **Refusal output (step 2).** `git-flow.mjs:stop()` with code 0 is a plain stdout line (help, a chosen cancel, nothing to do); with any other code it is a red banner on stderr headed "STOPPED".
  - The banner does not claim that nothing happened, because a partial Finish has already pushed. The body says what happened.
  - A cancel at a gitpush confirm ends the whole run with exit 0, without "Done.". It lists the checkouts already done and those not attempted.
  - The PowerShell wrapper sets `$LASTEXITCODE` to the script's code and never calls `exit`, which would close the window.

## Step 6 decisions (Alex, 2026-10-12)

1. **Wrong window.**
   - prompt-check's refusals write their own state, `wrong`, not the red latch.
   - The tile shows red "Wrong window". It clears when tapped, which also jumps to the window as before; the tap runs `scripts/lib/session-status.mjs clear-wrong <checkout>`.
   - It also clears when the next prompt gets through in that window.
2. **Orphan claims.**
   - The tile is red, "No worktree · tap".
   - A tap opens a panel listing the files and db items held, with large "Release all" and "Cancel" buttons. There is no double tap and no long press.
   - "Release all" runs `claims.mjs cleanup <owner>` in the main checkout.
3. **Tile position.**
   - A tile's place is set when it first appears, and only a tile appearing or disappearing moves others. Colour and status changes never move a tile.
   - A paused tile stays where it is, dimmed.
   - The order is group (CLI, chats, orphans), then arrival.
   - **On startup** (added 2026-10-12, s10): the main checkout first, then the worktree sessions, then the chat tiles.
     - Worktree sessions are ordered by when the session started, oldest first. That is the creation time of the session's transcript (`transcript_path` in its status file).
     - A session whose start is not known goes after those that are, by name.
     - After startup the rule above holds: a tile keeps its place, and a new tile goes at the end of its group.
     - Code: `status.ahk:StartupOrder`, used by `TouchState` while there is no previous order.
4. **Untagged replies.**
   - The CLI counts as reported if anything was pushed after its last typed prompt (`prompt_at`, set by prompt-check and never by machine traffic), so red "Check CLI" means only "stopped without reporting".
   - An untagged reply shows orange "Reply (untagged)". It clears when Alex sends that session its next message, tagged or not.
   - A status file from before `prompt_at` existed falls back to matching run tags.

## Steps

1. Isolate the claims tests from the real guard log and status file (bug 3).
2. gitpush refusals and Finish from inside (bugs 1 and 2).
3. Paths with spaces (bug 4). **This changes this session's guard.** Test it from a fresh session.
4. Close-out docs move (bug 9).
5. Prompt classification and the Check CLI flicker (bugs 5 and 11). **This changes this session's prompt check.** Test it from a fresh session. Also three guard false positives found while testing step 3:
   - A grep or other read-only search for the text "claims.mjs claim" is blocked as a chained claim.
   - `cp` counts its source as written. For `cp` only the destination is a write; for `mv` both the source and the destination are.
   - Command words inside quoted argument text are read as commands. For example, `node scripts/clip.mjs --title "...bash -c cp blocked..." .clip/last-report.md` was blocked as a `cp` writing `scripts/clip.mjs`.
     - Quoted argument values must not be scanned as commands.
     - The exception is the payload of a shell wrapper (`bash -c`, `sh -c`, `powershell -Command`), which must still be searched.
6. Switchboard (bugs 6, 7 and 8), interactions agreed first. Old-panel note (bug 10).

## Database

None.

## Tests

- `node --test "scripts/lib/*.test.mjs"`
- `extension/lib/bridge-core.test.mjs`
- `tools/claude-sessions/run-tests.ps1` (AHK)
- The app suite once, at the end.
