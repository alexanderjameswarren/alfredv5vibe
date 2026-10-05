# Technical spec: Switchboard fixes

Project code `switchboard_fixes-m3x`, main checkout. Fixes bugs in Switchboard
(`tools\claude-sessions\`) and in the claims and git tooling it relies on.
Progress: [progress-switchboard_fixes.md](progress-switchboard_fixes.md).
No database work.

## 1. Claims guard false positives

All three were reproduced by running `writeCheck` on the commands.

**(a) and (b): a bare `.git` or `.clip`.** `EXEMPT_PREFIXES` end in `/`, so
`.git/HEAD` is exempt but `.git` on its own is not. `repoPathsIn` then counts it
as a path, because `.git` and `.clip` look like file extensions to it, and the
folder exists. So `cp -r .git <scratch>` (from a worktree, where `.git` is a
file) and `cd .clip && rm x.log` were blocked. A Read-tool read of `.git` never
reaches the guard; that prompt is Claude Code's own.

Fix: `isExempt` also matches an exempt folder named without its slash.

**(c) A claim read as a copy.** `(?<![-\w])(?:mv|cp|rsync|install|ln)\b` matched
the `install` of `tools/claude-sessions/install-shortcuts.ps1`, because `\b`
sits between `l` and `-`. Logged 2026-10-01 20:54. (`grep 'git mv' …`, blocked
during the plan, is a different case: a whole word in quotes. It stays
blocked, since quotes are deliberately not stripped.)

Fixes:
- A write command word may not be followed by `-`, the same rule that already
  stops one being preceded by `-`. `git grep -ln` taught the lookbehind;
  `install-shortcuts` teaches the lookahead.
- A claims command is judged on its redirections only, when it is a single
  `node scripts/claims.mjs <sub> …` from the start of the command (after the
  own-checkout `cd` strip), unchained and without substitution. Its arguments
  are item names, never executed, so a command word among them writes nothing.
  `node -e "<write>" scripts/claims.mjs claim x` does not start that way and is
  still judged in full.

Kept: `cp`, `mv`, `tee`, `sed -i` stay strict; quotes are still not stripped;
the chained-claim block and the db:deploy prompt are unchanged.

**(d) A report push read as a copy (added s2c).** A `--title` containing "cp"
blocked a `clip.mjs` push. The lone-command rule now covers `clip.mjs` as well as
`claims.mjs` (`isLoneScriptCommand`). Quoted text in general is still read:
`bash -c "rm x"` is caught.

**(e) Both hooks found the checkout from the cwd (added s2c).** The cwd moves with
every `cd`, so a session that had cd'd to `$TEMP` had edits to unclaimed repo
files allowed as "not a git repo" (one real instance in the log, 2026-10-01
21:52:46). `resolveCheckout(CLAUDE_PROJECT_DIR, cwd)` tries the project dir
first, then the cwd. Both claims-guard and prompt-check use it. The owner=?
on most log lines is not this bug: read-only calls exit before the owner is
looked up.

**Rule for hook edits (Alex, s2e).** Every single edit to claims-guard or
prompt-check must leave the hook runnable, and the hook is run once on a
harmless input after each edit. Two half-finished edits in s2c and s2d left the
guard calling a name that was not defined, and it then blocked every edit.

## 2. Hook tests depend on the checkout they run in

`hooks.test.mjs` drives prompt-check with `cwd: ROOT`. In a worktree,
`codeOfCheckout` returns the folder name and ignores the scratch binding, so
three tests fail: the wrong-window bind/unbind message, the binding write, and
the underscore tag. The older "isolate prompt-check tests" item has the same
root cause.

Fix: those tests run against a scratch main checkout, a `.git` folder with
`HEAD`, `objects/` and `refs/` written with fs. Git accepts it, and there is
no `git init`. Every test that does not need a checkout stays as it is.

## 3. Main's chat follows the binding file

`ChatCode` used `s.project` from main's last status write. It now uses
`mainProject`, read from `.git\alfred-project-code.json`, like the label. It
moves to `lib\status.ahk` as `ChatCode(code, mainProject)` so it can be tested.

## 4. Main free

When main has no binding, its button is grey, its second line reads `free`, it
never alerts, and it is left out of the taskbar colour, until a prompt binds a
project.

## 4b. Yellow flashes five times (added s2c)

A button turning yellow flashes 5 times, then stays solid yellow, instead of
flashing until clicked. Red is unchanged. Built in step 5.

## 5. Git counts go stale

Counts re-ran only when a status file changed. They now also re-run when:
- the binding file changes (main);
- a checkout's `logs\HEAD` changes (commit, merge, reset, checkout);
- `.git\logs\refs\remotes\origin\main` changes (push or fetch, for `↑n`).

Compared by modified time, polled with the status files.

## 6. gitpush and gitcom fail on a staged `git mv`

`changedFiles` lists a rename's old path, which is in neither the index nor
the working tree. `git add -- <old>` fails with "pathspec did not match", and
so does a staged `git rm`. Fix: entries with nothing unstaged (status column 2
is a space), and a rename's old end, are not passed to `git add`; they are
already staged. The commit still covers them.

Out of scope: `git commit -m` commits the whole index, selected or not.

## Steps

1. Docs (this file and the progress file).
2. Guard fixes 1a–1c, with unit tests.
3. Test isolation (§2).
4. `git mv` (§6).
5. Panel fixes §3–§5, with test-status and smoke tests.
6. Finish.

No restart is needed for any step; `settings.local.json` is not touched. Guard
edits take effect on the next tool call in every open session. The panel needs
a relaunch.
