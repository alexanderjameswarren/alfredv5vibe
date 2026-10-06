# Progress: switchboard_guard

Spec: `docs/technical-spec-switchboard_guard.md`.

- [x] s1 Plan (2026-10-06)
- [x] s2 Claim the 12 files; write the spec and this file
- [x] s3 Bugs 1+2: read-only commands do not raise write indicators from their
      arguments; `git diff`/`git log --output` count as writes. Unit tests, then a
      live re-run of the grep blocked on 2026-10-06. Awaiting Alex's confirmation.
- [x] s4 Bug 3: from a worktree, block writes into main and sibling worktrees.
      Hook tests on a scratch main plus a linked worktree, built with fs.
      Awaiting Alex's confirmation.
- [x] s5 Bug 4: `run-tests.ps1` requires the final line; scratch early-exit test.
      Awaiting Alex's confirmation.
- [x] s6 Bug 5: learn main's chat link from `chats.json` `issuedTag`;
      test-status + smoke. Awaiting Alex's confirmation.
- [x] s7 Full suites. Alex's hand tests are pending.

## Log

- 2026-10-06 s1: plan confirmed. A read-only grep with "rmdir" in its pattern was
  blocked during planning, reproducing bug 1.
- 2026-10-06 s3: `claims-core.mjs`.
  - Read-only pipeline elements (grep, rg, cat, head, tail, wc, ls, git
    grep/log/diff/show/status/blame, Select-String, Get-Content, …) no longer
    supply write words. These keep them: `$(…)`, backticks, an unquoted `(`,
    `rg --pre`, `git grep -O`, `--output`, and `git -c`.
  - Write words next to `.`, `/` or a file extension are not commands: `d.patch`,
    `ui/touch/`, `touch.js`. `rm.exe` still counts.
  - `git diff|log|show --output=<file>` is a write, judged on that file.
  - Tests: CLI suite 147/147. Live: the blocked grep re-ran unchanged and was allowed.
- 2026-10-06 s4:
  - `claims-core.mjs`: `resolveRepo` returns `mainRoot`. A new `foreignPath`
    maps a worktree's out-of-checkout path to main-relative form when it lands in
    main or a sibling worktree. Exempt paths and debris (no existing folder) are
    skipped, and Git Bash `/c/...` paths are understood. `writeCheck` takes
    `checkout` and returns `foreign`, and `repoPathsIn` reports outside paths.
  - `claims-guard.mjs`: edits and shell writes with a foreign path are blocked
    by `blockForeign`. Main sessions are unchanged.
  - `hooks.test.mjs`: 6 tests on a scratch main with linked worktrees wt-a and
    wt-b, built with fs, scratch logs only. They cover: the worktree's own claimed
    edit, rm and a temp write are allowed; Edit into main and Write into wt-b are
    blocked; four shell spellings into main are blocked, plus a fifth in Git Bash
    `/c/` form; reading main and writing main's `.git/` are allowed; main itself
    is unchanged.
  - CLI suite 153/153.
- 2026-10-06 s4b (Alex asked): main sessions now read Git Bash `/c/...` paths
  as repo paths too.
  - `claims-core.mjs`: new `nativePath`, used by `toRepoRelative`, so every
    check uses it. `foreignPath` now goes through it as well.
  - Tests (Windows only):
    - hooks: main deleting an unclaimed `src/b.js` by `/c/` path is blocked;
      its own claimed `src/a.js` is allowed; a `/c/` path outside the repo is
      allowed.
    - core: `/c/` `toRepoRelative` and `writeCheck` cases.
  - CLI suite 155/155, none skipped. Awaiting Alex's confirmation.
- 2026-10-06 s5:
  - `tools/claude-sessions/run-tests.ps1`: an AHK test passes only on exit 0
    and a last non-empty line ending in "passed". Exit 0 without that line is
    reported "DID NOT FINISH" and counts as failed.
  - New `-Tests` parameter: runs only the AHK files named, without the host tests.
  - Output files are named `claude-sessions-tests-<pid>-<random>` and deleted at
    the end. README notes added.
  - Proof:
    - a scratch test that exits 0 halfway gives "DID NOT FINISH", runner exit 1;
    - a scratch test that finishes passes, runner exit 0;
    - the real suite passes (test-status, smoke, host), runner exit 0, and no
      temp output files are left.
- 2026-10-06 s6:
  - `lib/status.ahk`: new `FindChatLinkByTag(chats, runTag, project)`. It looks
    only at chats whose issued tag belongs to the project: the one that issued
    the run tag wins, otherwise the first.
  - `claude-sessions.ahk`: `LearnChatLink` tries chats.json first (when
    fresh), then tab titles.
  - `test-status.ahk`: 6 checks, including that the old project's run tag is
    ignored after a rebind.
  - `smoke-test.ahk`: the title-learning case now runs without chats.json. In
    the new case, main rebinds to next-q2z and pairs with an untitled chat that
    issued `next-q2z-s1-ab12`. The code is saved, and the chat gets no separate
    tile.
  - `run-tests.ps1`: passed 3 of 4 runs. One run failed an earlier smoke check,
    "bridge focuses the linked tab" (2 focus calls, want 1). It passed in the
    next three runs. Cause not found; not known to be related.
- 2026-10-06 s6b, the intermittent smoke failure, time-boxed:
  - **Not reproduced:** 10/10 smoke runs passed.
  - **Ruled out by reading the code:**
    - The new chats.json pairing: `LearnChatLink` only saves a link and never
      focuses. At that point `ms.chatLink` is already set, so it returns at once,
      and the chats there carry no issued tags.
    - A double focus in Arrange: one `BridgeArrange` → one `FocusAndPlace` →
      one `focusRequester`, with no retry.
    - The Refresh and Blink timers: both are turned off at the top of the smoke test.
    - Cached tabs: `ReadBridgeFile` never queues a call.
    - A concurrent run: `focusCalls` is in-process.
    - Button and tile clicks: `ButtonClick` goes through the fake `arrangeAction`.
  - **What is left:** only `ChatRowClick` reaches `focusRequester` besides
    Arrange. It runs on an old-panel chat-row click (line 744) or on a chat-tile
    tap from the real touch page (`TouchMessage` → `TouchDo`, on its own timer
    thread). At that point the scratch chat `smoke-start` (tab 1) is unpaired, so
    it has a tile. A real tap or click on the smoke test's own windows would give
    exactly 2 calls. Those windows are real and appear over Switchboard on the
    touch screen. Likely, not proven.
  - **Changed:** only the check's message. It now prints every focus call, with
    composer and action (`77| 1| focus|`), so the next failure names the stray tab.
  - **Possible fix, not made:** disable input to the smoke test's panel and touch
    windows (`+Disabled`). The tests call TouchDo and ButtonClick directly, so
    they do not need the windows to take input.
- 2026-10-06 s7:
  - Correction to s6b: a test script never opens the touch window
    (`claude-sessions.ahk`, where it chooses between the touch window and the old
    panel). The only real-input route is a click on the old panel's chat row.
  - `smoke-test.ahk`: `panel.Opt("+Disabled")` right after the include, plus a
    check that the panel carries WS_DISABLED. The detailed focus message stays.
  - Smoke 10/10 in a row. `run-tests.ps1` passes. CLI suite 155/155. App suite
    2051/2051.
  - Hand tests given to Alex: a worktree Edit into main is blocked; main's tile
    pairs with the new chat after a rebind.
