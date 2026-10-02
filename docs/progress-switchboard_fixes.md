# Progress: Switchboard fixes

Spec: [technical-spec-switchboard_fixes.md](technical-spec-switchboard_fixes.md). Thread: `main`, project `switchboard_fixes-m3x`.

**Status: done (2026-10-02). Waiting for Alex to run gitpush Finish on main.**

## Summary

- **Claims guard:**
  - `.git` and `.clip` named on their own are exempt.
  - A write word glued to a `-` (`install-shortcuts.ps1`) is no longer read as a command.
  - A single, unchained `claims.mjs` or `clip.mjs` command is judged on its redirects only.
  - Both hooks find the checkout from `CLAUDE_PROJECT_DIR` first, then the cwd. Before, a session that had `cd`'d out of the repo got edits past the guard.
- **Tests:**
  - The binding tests run in a scratch main checkout, so the suite passes in a worktree. That also closes "isolate prompt-check tests".
  - The full-run test had never run anything (`NODE_TEST_CONTEXT`); now it does.
- **gitcom / gitpush:** a staged `git mv` or `git rm` no longer fails `git add`.
- **Switchboard:**
  - Main's chat match follows the binding file.
  - An unbound main is grey and "free".
  - Git counts re-run on binding, `logs\HEAD` and origin/main log changes.
  - Yellow flashes 5 times, then stays solid.

## Files changed

Modified: `.claude/hooks/claims-guard.mjs`, `.claude/hooks/prompt-check.mjs`, `scripts/lib/claims-core.mjs`, `scripts/lib/claims-core.test.mjs`, `scripts/lib/hooks.test.mjs`, `scripts/lib/git-flow.mjs`, `scripts/lib/git-flow.test.mjs`, `scripts/git-push-worktrees.mjs`, `tools/claude-sessions/claude-sessions.ahk`, `tools/claude-sessions/lib/status.ahk`, `tools/claude-sessions/test-status.ahk`, `tools/claude-sessions/smoke-test.ahk`, `docs/technical-spec-switchboard.md`.
New: `docs/technical-spec-switchboard_fixes.md`, `docs/progress-switchboard_fixes.md`.
Claimed but not changed: `scripts/git-commit-claimed.mjs` (it goes through `stageAndCommit`, which was fixed).
Not this project's: `.claude/skills/cli-workflow/SKILL.md`, modified in the tree by someone else.

- [x] **1. Plan and docs.** Plan confirmed 2026-10-01. 15 paths claimed, no db items.
- [x] **2. Guard false positives (1a–1c).** `isExempt` takes a bare exempt folder; write words may not be followed by `-`; a lone claims command is judged on redirections only. Tests in `claims-core.test.mjs`.
  - [x] Written and tested: 4 unit tests in `claims-core.test.mjs`, 2 that drive the real guard in `hooks.test.mjs`. CLI tooling 100/100, app 2019/2019 (2026-10-01, main).
  - [x] Verified live 2026-10-02 (s2e probes): .clip write and delete allowed, `touch src/guard-probe.js` blocked
  - [x] s2c/s2d/s2e: `clip.mjs` joins the lone-command rule. Both hooks find the checkout through `resolveCheckout` (project dir, then cwd), with tests in both test files. prompt-check is claimed for this.
  - Twice the guard was left calling an undefined name mid-edit and blocked every edit. Alex fixed line 350 by hand both times. The rule now: each hook edit leaves the hook runnable, then it is smoke-run.
  - Correction to the plan: `grep 'git mv' …` is still blocked. There `mv` is a whole word inside quotes, and quotes are deliberately not stripped. Only a word glued to a `-` (`install-shortcuts`) is fixed.
- [x] **3. Hook tests isolated.** Scratch main checkout for the three binding tests. Verified 2026-10-02: CLI suite 104/104 from main and 104/104 in a simulated worktree.
  - The three binding tests run in `scratchMain()`, a `.git` folder made with fs (no `git init`). `drive()` pins `CLAUDE_PROJECT_DIR` to the payload's cwd, since the hooks now prefer it and a suite run from a Claude session inherits the session's.
  - **The fourth test never ran anything.** The nested `node --test` inherited `NODE_TEST_CONTEXT=child-v8`, ran no tests and exited 0, so it passed in 32 ms whatever the suite did. The child env now drops it, and the test asserts the inner run passed at least one test. It takes about 1.2 s now.
  - **Worktree proof, simulated.** No worktree exists, and `git worktree add` is a state-changing git command CLAUDE.md forbids. Instead a scratch script built a fake main plus a linked worktree with fs (`.git` file → `worktrees/<name>` with `commondir`). Git reports it as a linked worktree. It copied the 783 tracked files in from the working tree and ran the suite with cwd and `CLAUDE_PROJECT_DIR` both set to the worktree: 104/104. Control: the same run with HEAD's `hooks.test.mjs` fails exactly the three known tests. The scratch tree is deleted after each run.
- [x] **4. Staged `git mv`.** Skip `git add` for fully staged entries and a rename's old end. Verified 2026-10-02 in a scratch repo.
  - `changedFiles` marks a rename's old name `renamedFrom`. `pathsToAdd(files, paths)` drops it, along with any path with nothing unstaged. `addPaths` runs `git add` on the rest, or skips it when nothing is left. Used by `stageAndCommit` (gitcom and gitpush on main) and by gitpush's `commitIn` (worktree Finish and Checkpoint). `git-commit-claimed.mjs` needed no change.
  - Tests: 2 in `git-flow.test.mjs`, covering the cases: rename, rename then edit, staged rm, staged edit, half-staged edit, unstaged delete, new file, and a path git did not list.
  - Scratch-repo proof, outside alfred-v5, authorised by Alex. Before every state-changing command the script checked that git's top level was the scratch folder. The changes were `git mv a.js renamed.js`, `git rm b.js`, an unstaged edit and a new file.
    - Old way: `git add -- <all>` failed `pathspec 'b.js' did not match` (exit 128).
    - New way: `stageAndCommit` added c.js and d.js only, and committed all four changes: a.js renamed to renamed.js, b.js deleted, c.js edited, d.js new. The tree was clean afterwards.
    - The scratch repo was deleted. alfred-v5's HEAD and status were unchanged.
  - Suites: CLI 106/106, app 2019/2019.
- [x] **5. Panel.** ChatCode from the binding, main free, git recount on binding / logs\HEAD / origin/main, and a yellow button that flashes 5 times and then stays solid yellow, instead of flashing until clicked.
  - [x] Written 2026-10-02. New pure helpers in `lib\status.ahk`: `ChatCode(code, mainProject)`, `IsFree`, `StillFlashing`, `StampKey`. The panel's `ChatCode(s)` is gone.
    - Free main: `FREE_COLOR`, the second line `free`, no alert, out of the taskbar colour and the tray tip.
    - `GitWatchFiles(code)` gives the watched files per session; a change in their modified times re-runs git.
    - A yellow flash is counted as it goes dark, so it lights exactly 5 times.
    - `technical-spec-switchboard.md` updated (colours, alert, button text, Chrome match, git counts).
  - [x] Tests: test-status (10 new checks) and smoke-test (free, chat match from binding, 5 flashes then solid, watched-file recount). The smoke test now uses a scratch binding from the start, because its chat-link checks relied on the old `s.project` match. Both pass.
  - [x] Verified by Alex on the desktop 2026-10-02: all six panel checks. The git-count recount is confirmed at gitpush.
- [ ] **6. Finish.** Alex runs gitpush Finish on main. That commits, pushes, releases main's 16 claims and clears the binding. Then check that main's `±n` drops without Refresh git.

## Notes

- **Decisions, 2026-10-01.** Git recount also watches `logs\HEAD` and origin/main's log. "Isolate prompt-check tests" is the same root cause as the worktree failures. The whole-index commit is out of scope. `technical-spec-switchboard.md` is updated for §3/§4.
