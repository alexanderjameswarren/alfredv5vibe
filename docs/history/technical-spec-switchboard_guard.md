# Technical spec: switchboard_guard

Five Switchboard and claims-guard bugs, fixed in one project in the main checkout.

## Bugs, causes, fixes

1. **Read-only searches for "rmdir" are blocked** [muvfsos8dmuqcr62ck].
   Cause: `COMMAND_INDICATORS` in `scripts/lib/claims-core.mjs` match the write
   words anywhere in the command text, including a grep pattern. Fix: a pipeline
   element that starts with a read-only program (grep, rg, git
   grep/log/diff/show/status/blame, cat, head, tail, wc, ls, Select-String,
   Get-Content, …) raises no command indicator from its arguments. Redirections
   are still checked. These stay strict: `rg --pre`, `git grep -O`/`--open-files-in-pager`,
   `git diff`/`git log` with `--output`, `find` (it can `-exec` and `-delete`),
   `xargs`, and `sh -c`/`bash -c`, which are not on the read-only list anyway.
2. **"touch" inside a path is read as the command** [muve2qzkn4ip5gud1j].
   Same cause: `(?<![-\w])touch\b` matches `*touch*` in a glob and `foo/touch.x`.
   The same fix covers it.
3. **A worktree session can write into the main checkout** [mur72wib1e1109bxelc].
   Cause: in `.claude/hooks/claims-guard.mjs`, a path outside the session's own root
   is "outside the repo" and allowed, and `repoPathsIn` drops it too. That includes
   main and sibling worktrees. Fix: `resolveRepo` also returns the main checkout's
   root. From a worktree, an edit or shell write into main or into another worktree
   is blocked unless it is exempt (`.git/`, `.clip/`, …). Main's behaviour is unchanged.
4. **Smoke test reported passed without finishing** [muve4cv7axongyt1sv4].
   Cause: `tools/claude-sessions/run-tests.ps1` trusts exit code 0 alone, and the
   included panel can exit 0 partway through (tray Exit, `#SingleInstance Force`).
   Fix: a test passes only on exit 0 and its own last line ("all passed" /
   "smoke passed"). Anything else is reported "did not finish". The runner takes an
   optional test list, and each run uses its own output files.
5. **Main keeps a stale chat link after a rebind** [muvd7x91to4poutscpa].
   switchboard_rebind-h6d already drops the old link. Remaining cause:
   `LearnChatLink` in `claude-sessions.ahk` only learns from a tab whose title holds
   the project code. Fix: also learn from `chats.json`. Take the chat whose
   `issuedTag` equals the session's run tag first, then any chat whose tag belongs to
   the project. The helper goes in `lib/status.ahk`.

## Files

`scripts/lib/claims-core.mjs`, `scripts/lib/claims-core.test.mjs`,
`.claude/hooks/claims-guard.mjs`, `scripts/lib/hooks.test.mjs`,
`tools/claude-sessions/{run-tests.ps1, claude-sessions.ahk, lib/status.ahk, smoke-test.ahk, test-status.ahk, README.md}`,
and this spec and its progress file.

**Database:** none. **`.claude/settings.local.json`:** untouched.

## Note on the other sessions

Each worktree session runs its own copy of the hooks
(`$CLAUDE_PROJECT_DIR/.claude/hooks/...`). These changes reach it only after they
land in main and that worktree runs `gitsync`.
