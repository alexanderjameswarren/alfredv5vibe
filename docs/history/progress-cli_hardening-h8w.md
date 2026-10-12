# Progress: cli_hardening-h8w

Spec: `docs/technical-spec-cli_hardening-h8w.md`

| Step | Bugs | Status |
|---|---|---|
| 1 | 3 test isolation | complete (verified by Alex, 174/174 twice) |
| 2 | 1, 2 gitpush refusals, Finish from inside | complete (verified by Alex); snippet re-copy deferred to close-out |
| 3 | 4 paths with spaces (guard change) | complete (verified by Alex from a fresh session) |
| 4 | 9 close-out docs move | complete (verified by Alex in a throwaway repo) |
| 5 | 5, 11 prompt classification, Check CLI flicker, three guard false blocks; Finish fixes | complete (verified by Alex; the tile-stays-green check is still to watch) |
| 5b | Finish keeps uncommitted work; clip.mjs encoded push | complete; clip-capture deployed 2026-10-12 14:01 and verified, awaiting checkpoint |
| 6 | 6, 7, 8 Switchboard, plus untagged replies; 10 report only | complete (verified by Alex, all five touch-page checks, and the startup tile order after a restart) |

## Step 1

The hooks the tests drive were already pointed at scratch files. What failed was
the check afterwards, which required the real files to be byte-identical before
and after. Every live session, in any thread, writes those files at any moment.
The checks now look only for this run's own footprint:

- **Guard log:** each hook run must write its one line to the scratch log. A hook
  writes one line to one file, so a line there proves the real log was not touched.
- **Status file:** every driven payload carries a per-run marker as its
  session_id, and the real status file must never contain it.
- **Binding and blocks:** they must not gain this drive's own content.
- **Claims and blocks files** (claims-folders, claim-blocks, and the full-run
  test): they must hold no entry for `wtB`, the tests' scratch worktree.

Files: `scripts/lib/hooks.test.mjs`, `claims-folders.test.mjs`, `claim-blocks.test.mjs`.

## Step 2

- **`scripts/lib/git-flow.mjs`:**
  - `stop()`: code 0 prints a plain line, any other code prints a red banner on stderr.
  - New pure helpers: `modeKey`, `misplacedOptions`, `findCheckout`, `pickCheckouts`, `finishFromInside`, `isInside`, `resultExit`, `refusalBanner`.
- **`scripts/git-push-worktrees.mjs`:**
  - Uses those helpers.
  - "Nothing recognised" now exits 2.
  - A cancel at a confirm exits 0 and stops the run, without "Done.".
  - Finish refuses before the confirm when this terminal is inside the worktree, judged by the checkout and by `process.cwd()`.
- **`scripts/git-sync.mjs` and `scripts/git-commit-claimed.mjs`:** a failed merge or commit now goes through `stop()`, so it shows the banner.
- **`scripts/powershell-profile-snippet.ps1`:** passes the script's exit code to `$LASTEXITCODE`, and its own two refusals set it to 1.
- **Tests:** 11 new in `git-flow.test.mjs`. Full CLI suite: 185/185.

## Step 3

- **`scripts/lib/claims-core.mjs`:**
  - New `shellWords()` lexer: quotes group words, `\ ` and PowerShell `` ` `` escape a space, and any other backslash stays as a Windows separator.
  - `repoPathsIn()` reads those words. A word with spaces counts as one path only if it is one. Otherwise it is treated as a payload (`bash -c "…"`) and searched again, so nothing hidden in it is missed.
  - Per-word logic moved to `pathWord()`. `--flag=path` is now read like `-Name:path`.
- **`.claude/hooks/claims-guard.mjs`:** the claim hint in a block message quotes paths that contain spaces or brackets.
- **`scripts/lib/git-flow.mjs`:** `parseSelection()` takes argv tokens whole, and a typed answer can quote a path.
- **`scripts/git-push-worktrees.mjs`:** `--paths` passes its argv list straight through.
- **Tests:** 9 new in `claims-core.test.mjs`, `git-flow.test.mjs` and `hooks.test.mjs`. Full CLI suite: 193/193.
- **Found, not fixed:** a read-only command containing the words "claims.mjs claim" inside a chained command (for example a grep for that text) is blocked as a chained claim. This was here before step 3.

## Step 4

- **`scripts/lib/git-flow.mjs`:** new `projectDocs`, `planDocsMove`, `applyDocsMove` and `docsMovePaths`.
- **`scripts/git-push-worktrees.mjs`:** worktree Finish now handles the project docs.
  - It refuses before any git change if `docs/history/` already has a same-named file, in the worktree or in main.
  - Its plan shows each move, and notes any missing doc without refusing.
  - After the confirm it moves the files and stages them in the Finish commit, together with the claimed changes.
- **Tests:** 5 new in `git-flow.test.mjs`, using throwaway folders. They are not a git repo, because CLAUDE.md forbids the CLI `git init`/`commit`; Alex checks the git side with a throwaway-repo script. Full CLI suite: 198/198.
- **Not done:** main-checkout Finish (`doMain`) does not move docs. It could, using main's project code, if wanted.

## Step 5

**Finish fixes** (`git-push-worktrees.mjs`, `git-flow.mjs`):
- Main Finish moves docs by main's project code, under the same rules as worktree Finish.
- Docs that Finish moves are left out of the "Claimed" and "Leaving … unclaimed" lists. New helpers: `withoutMoved`, `docsClashRefusal`.

**Bug 5:**
- `project-code.mjs`: a CLI prompt is one whose header is a `Run tag:` line followed by a `Window:` line, at the top of the prompt or of a pasted block (`tagInPrompt`, `headerTag`).
- `system-reminder` is added to the machine envelopes.
- `extension/claude-watch.js`: `extractTag` uses the same header rule. The extension must be reloaded in Chrome.

**Bug 11:**
- `session-status.mjs`: new `pendingBackground` reads the transcript for background agents and shells launched and not yet ended.
- `.claude/hooks/session-status.mjs`: a Stop, or an idle notice, while any of those run writes "processing (background running)", not "waiting".

**Guard** (`claims-core.mjs`, `claims-guard.mjs`):
- New `splitPayloads`: quoted argument text is blanked before write words are looked for. Payloads of bash/sh/zsh/pwsh/powershell/cmd `-c`/`-Command`/`/c`, node/python/perl/ruby `-e`/`-c`, and `eval` are checked as commands of their own, by the same rules.
  - Quoted values of flags that run programs stay readable: `rg --pre`, `git -c core.pager=`, `find -exec`.
  - Double quotes holding `$(…)` stay readable too.
- `cp`/`rsync`/`install`/`ln` at command position write only their destination (`copyDestination`). `mv` still writes both ends.
- The guard's claim detection reads `runText()`: unquoted text plus payloads.
- **Holes found and closed:**
  - `bash -c "echo x > src/a.js"` and `sh -c '… >> …'` were allowed before this project, because a redirect inside a payload was never seen.
  - Step 3's lexer stopped finding paths inside `node -e "…writeFileSync('src/a.js')"`. That regression from step 3 is fixed.

**Tests:** 21 new. CLI suite 214/214; extension 16/16.

## Step 5b

**Finish no longer deletes uncommitted work** (`git-push-worktrees.mjs`, `git-flow.mjs`):
- Before the confirm, Finish refuses with the banner if any change would be left uncommitted, listing the files (`leftBehindRefusal`).
- `--force` removal runs only when git status is clean, and says why it is forcing (`forceDecision`). Otherwise it stops and prints the manual commands.

**Report pushes:**
- `scripts/clip.mjs` sends `title_b64` and `page_text_b64`.
- A non-2xx answer is one plain line. An HTML page is named by its title, not dumped.
- A network error fails cleanly. `fail()` throws and sets the exit code instead of calling `process.exit`, which aborted Node with a libuv assertion.
- An older clip-capture is detected: the script says to deploy it and sends the report unencoded once.

**`supabase/functions/clip-capture/index.ts`:** `/finish` decodes `*_b64` fields. **Needs** `npx supabase functions deploy clip-capture`, under `db:deploy`, which warren_buffet_p2-m4t holds as of 2026-10-12.

**Tests:** 7 new (`clip.test.mjs`, `git-flow.test.mjs`). CLI suite 221/221.

## Step 6

The decisions are in the spec ("Step 6 decisions").

- **`scripts/lib/session-status.mjs`:** new `wrong` state; `prompt_at`; `clearWrong` and the `clear-wrong` command.
- **`.claude/hooks/prompt-check.mjs`:** refusals write `wrong`; typed prompts set `prompt_at`.
- **`tools/claude-sessions/lib/status.ahk`:** `KindOf`/`ViewOf` handle "Wrong window", report-after-prompt and "Reply (untagged)". `TileSort` has no colour in its key. `TouchCommand` handles `release`. `OrphanOwners` lists items.
- **`tools/claude-sessions/claude-sessions.ahk`:** reads `prompt_at`; paused tiles stay in group 0; orphan tiles are red and carry their items. New `ReleaseOrphan` and `ClearWrong`; a tap on a wrong tile clears it.
- **`tools/claude-sessions/ui/switchboard.html`:** the orphan release panel.
- **Tests:** `test-status.ahk` (12 new checks), `smoke-test.ahk` (paused tile keeps its place), `session-status.test.mjs` and `hooks.test.mjs` (4 new). The page script is syntax-checked only.

**Startup order (s10):**
- `status.ahk`: new `StartupOrder`. It puts main first, then the worktrees by session start, oldest first, then any with an unknown start, by name.
- `claude-sessions.ahk`: new `SessionStarts`, which uses the transcript's creation time. `TouchState` uses `StartupOrder` until the first order is recorded.
- **Tests:** 2 new checks in `test-status.ahk`. The AHK tests and host tests pass; CLI suite 224/224.

## Log

- 2026-10-11 s1: plan reported (read-only).
- 2026-10-11 s2: plan confirmed. Spec written. Files claimed.
  - Bug 11 investigated: the subagent hand-backs were allowed as machine envelopes. The red came from the Stop hook writing `waiting` while background agents were still running, so the tile showed "Check CLI".
  - Step 1 done.
- 2026-10-11 s3: step 1 verified by Alex. Step 2 done.
- 2026-10-11 s4: step 2 verified by Alex. Step 3 done.
- 2026-10-11 s5: step 3 verified by Alex (fresh session). Three guard false positives added to the step 5 spec. Step 4 done.
- 2026-10-12 s6: step 4 verified by Alex. Finish fixes and step 5 done.
- 2026-10-12 s7: step 5 verified by Alex. Step 5b (Finish keeps uncommitted work; encoded report push) done; deploy pending.
- 2026-10-12 s8: step 6 design options; s9: Alex chose the recommendations, step 6 built.
- 2026-10-12 s10: step 6 verified by Alex on the touch page. Startup tile order added.
- 2026-10-12 s11: startup order verified by Alex. db:deploy was free at 13:55, so nothing was reserved or claimed; the clip-capture deploy waits on gitsync.
- 2026-10-12 s12: gitsync to beaa5a7.
  - Drift check clean: no change to clip-capture or to `_shared/alfred-tools/supabase-client.ts`, and migration 122 only edits the `platform.registry` note for `public.clips`.
  - db:deploy claimed. clip-capture deployed at 14:01.
  - Verified: the test clip "[cli_hardening-h8w-s12-d6w1] cli_hardening deploy test — archive me" was stored decoded, shell lines and UTF-8 intact, with no unencoded fallback.
  - db:deploy released.
