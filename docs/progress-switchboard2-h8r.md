# Switchboard 2.0 — Progress

Project code: `switchboard2-h8r`
Spec: `docs/technical-spec-switchboard2-h8r.md`

Status: Phase 0 in progress: 0.1 to 0.6 done.

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

## Steps

The run tag is filled in when a step runs. Database items are claimed just in time, at the step that needs them.

| phase | step | description | db items | status | date |
|---|---|---|---|---|---|
| — | s1 | Read-only plan | — | done | 2026-10-29 |
| — | s2 | Claim Phase 0 files; write spec and progress | — | done | 2026-10-29 |
| — | s3 | Fold in later decisions: phase order, tile states, clicks, plan guard, sandboxes | — | done | 2026-10-29 |
| — | s4 | Tier decisions; next step's scope at the end of every report | — | done | 2026-10-29 |
| 0 | 0.1 | Split out the shell parser; fix `>` in quotes, `=>`, heredoc and script writes | — | done (s5-m3tx) | 2026-10-29 |
| 0 | 0.2 | Guard and hooks on the new parser; hooks tests; diff `a/` and `b/` prefixes | — | done (s6-p5ua) | 2026-10-29 |
| 0 | 0.3 | `number-migration`; gitpush refuses `_pending_` files and duplicate numbers; gitsync `--no-edit`; "Done at"; gitcom echo | — | done (s7-c6hn) | 2026-10-29 |
| 0 | 0.4 | Main blocks live-worktree codes; duplicate run tag refused; README links | — | done (s8-v9qe) | 2026-10-29 |
| 0 | 0.5 | Plan guard: parse the scope block, record it, enforce create, update, delete, deploy and SQL | — | done (s9-k7wf) | 2026-10-29 |
| 0 | 0.6 | Scope vs changes in the report; cli-workflow skill scope summary; CLAUDE.md | — | done (s10-r2jd) | 2026-10-29 |
| 0 | 0.7 | Module boundaries: bridge vs clipper in `extension/`, header interfaces | — | todo | |
| 0 | 0.8 | `INTERFACES.md` draft; full test run | — | todo | |
| 1 | 1.1-1.7 | Send to CLI (2), tile states and running colours (2), estimates and strip (2), six-tile layout and panel items (1): spec §7 | — | todo | |
| 2 | 2.1-2.10 | SQL queue, links, click pages, runner, read-only queries: spec §8 | see below | todo | |
| 3 | 3.1-3.18 | The move, settings, `sb` commands, Salesforce guard, deploy wrapper, PII hold: spec §9 | — | todo | |
| 4 | 4.1-4.5 | Salesforce reads: spec §10 | the Phase 2 tables, re-claimed | todo | |
| 5 | 5.1-5.6 | Git and Salesforce actions by link: spec §11 | `db:table:switchboard_actions` | todo | |
| 6-8 | | Spec §12-§14 | | todo | |

## Proposed scope per step (Phase 0)

Every report ends with the next step's block, copied from here. The progress file is implied in every block.

**0.1, shell parser split and fixes**
- create: scripts/lib/shell-parse.mjs, scripts/lib/shell-parse.test.mjs
- update: scripts/lib/claims-core.mjs, scripts/lib/claims-core.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**0.2, guard and hooks on the new parser**
- create: nothing
- update: .claude/hooks/claims-guard.mjs, scripts/lib/hooks.test.mjs, scripts/lib/shell-parse.mjs, scripts/lib/shell-parse.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**0.3, migration numbers, gitsync, gitpush** (estimated run: 12m)
- create: nothing
- update: scripts/claims.mjs, scripts/lib/claims-core.mjs, scripts/lib/claims-core.test.mjs, scripts/git-push-worktrees.mjs, scripts/git-sync.mjs, scripts/lib/git-flow.mjs, scripts/lib/git-flow.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**0.4, wrong-window on main, duplicate run tag, README** (estimated run: 10m)
- create: nothing
- update: scripts/lib/project-code.mjs, scripts/lib/project-code.test.mjs, .claude/hooks/prompt-check.mjs, scripts/lib/hooks.test.mjs, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/README.md
- delete: nothing
- deploy: nothing
- SQL: none

**0.5, plan guard** (estimated run: 15m)
- create: .claude/hooks/plan-guard.mjs, scripts/lib/plan-scope.mjs, scripts/lib/plan-scope.test.mjs
- update: .claude/hooks/prompt-check.mjs, .claude/settings.local.json, scripts/lib/hooks.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none
- **Not yet claimed:** `.claude/settings.local.json`, `scripts/lib/plan-scope.mjs` and `scripts/lib/plan-scope.test.mjs`. They need Alex's OK at that step.

**0.6, report sections, skill, CLAUDE.md** (estimated run: 15m)
- create: nothing
- update: scripts/clip.mjs, scripts/lib/last-report.mjs, scripts/lib/clip.test.mjs, .claude/skills/cli-workflow/SKILL.md, .claude/CLAUDE.md
- delete: nothing
- deploy: nothing
- SQL: none

**0.7, module boundaries** (estimated run: 15m)
- create: extension/lib/ (only if the bridge split needs a new module)
- update: extension/, tools/claude-sessions/, scripts/lib/session-status.mjs, scripts/lib/session-status.test.mjs, .claude/hooks/ (headers)
- delete: nothing
- deploy: nothing
- SQL: none

**0.8, interfaces draft and full test run**
- create: tools/claude-sessions/INTERFACES.md
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none

**Database items by step (Phase 2):**
- **2.1-2.4:** `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:fn:switchboard_issue_link`, `db:fn:switchboard_consume_link`, `db:deploy`.
- **2.7-2.8:** `db:table:switchboard_read_log`, `db:table:switchboard_settings`, `db:fn:switchboard_readonly_query`, `db:fn:check_call_budget` (read only), `db:deploy`.

## Estimate

| # | phase | steps |
|---|---|---|
| 0 | Fixes, boundaries, plan guard | 8 |
| 1 | Send to CLI, tile states, estimates, layout | 7 |
| 2 | SQL queue, read-only queries | 10 |
| 3 | Multi-repo and clients | 18 |
| 4 | Salesforce reads | 5 |
| 5 | Git and Salesforce by link | 6 |
| 6 | Spec files, archiving | 2 |
| 7 | npm start per tile | 2 |
| 8 | Remote devices | 4 |
| | **total** | **62** |

## Decisions

- **s2, on the step 1 risks:**
  - The tab check binds to the chat address, with the title as a second check.
  - Salesforce full data passes through Supabase: it is encrypted per result, deleted on fetch, and purged on a schedule. Each client's contract must allow it.
  - Org settings live in the install, keyed by repo path. `.clip/` goes in `.git/info/exclude`.
  - Applied migrations are recorded only in `switchboard_runs`.
  - Risks 5 to 13 were accepted as written.
- **s2, new decisions:**
  - Org settings are managed by `sb` terminal commands, and Claude sessions are blocked from them.
  - `sb client end` signs out of the client's orgs and closes its projects.
  - `cliMayDeploy` is per org and on by default.
  - Deploy by link is optional where `cliMayDeploy` is on and required where it is off.
  - Production deploys are never allowed.
- **s3:**
  - **Confirmed from s2:** protect only the installed copy and its config; `sb client start` and `sb client end` are terminal-only; Apex test failures in client repos are summarised, not pasted.
  - **Phase order:** 0, Send to CLI, SQL queue with read-only queries, the move, Salesforce reads, then the rest.
  - **Tile states and colours:** spec §7.2.
  - **Click rules:** spec §11.1, and capital-letter headlines written by the server.
  - **Plan guard:** spec §6.2.
  - **Sandbox deploys:** own files only, a short lock per sandbox, own tests only, retrieve and compare first, and change tiers. See spec §9.7.

- **s4:**
  - **Permission sets:** click-tier when they add a system permission; object and field access only stays no-click.
  - **Triggers and record-triggered flows:** Apex triggers and active record-triggered flows are click-tier in partial and full sandboxes, and no-click in developer sandboxes. The sandbox type is asked of Salesforce.
  - **Accepted as written in the spec:** test files must be declared; CLAUDE.md gets a line on the sandbox lock; click-tier deploys are refused until Phase 5; a gitsync conflict shows as red "Check CLI".
  - **Reports:** every report ends with the next step's scope block, taken from this file.

- **0.1 (s5-m3tx):**
  - **What moved.** `shell-parse.mjs` holds the parsing: write words, redirects, payloads, splitting, words and heredocs. It has no claims or filesystem imports. `writeCheck`, `repoPathsIn` and `pathWord` stay in claims-core because they need the repo, and claims-core re-exports the parser's public names, so no caller changed.
  - **The move changed no behaviour.** The 127 existing tests passed both before and after it.
  - **One root cause for `>` in quotes and `=>`.** Interpreter source (`node -e`, `python -c`) was scanned for shell redirections, so `x > 1` and `a >= b` read as writes to files named `1` and `=`. Interpreter source now has no redirections. A real redirect after the payload still counts.
  - **Heredocs.** In bash, bodies are stripped before scanning (`stripHeredocs`).
    - A body read by an interpreter or shell (`node -`, `bash`, `cat <<EOF | python -`) is judged as a payload.
    - Plain input bodies are ignored, except when they feed a write or `xargs`; then the whole command, body included, is judged as before.
    - Because bodies are stripped, a heredoc no longer forces whole-command mode, and variables from earlier parts are expanded. That closes the claim_blocks-h3n follow-up.
    - PowerShell is unchanged.
  - **One test changed.** In `claims-core.test.mjs`, the old "a heredoc falls back to the whole command" case (`cat <<EOF > /tmp/x` naming `scripts/clip.mjs`) encoded the bug itself. It now asserts no write, and an `xargs rm <<EOF` case replaces it as the whole-command case.
  - **Script writes.** New patterns cover node `fs` (`append`, `copy`, `rename`, `unlink`, `rm`, `mkdir`, `createWriteStream`, the promises forms), python `os`, `shutil` and `pathlib`, and shells started from code (`child_process`, `execSync`, `os.system`, `subprocess`). The `open(...,'w')` rule now needs the mode as its own argument, so `open('app.py')` is no longer a write.
  - **The guard already runs the fixed parser.** Its own file is untouched and it still imports from claims-core, but claims-core now delegates to `shell-parse.mjs`. Only this worktree's guard is affected.
  - **Found, not fixed:** `git apply` or `patch` fed by a heredoc is not caught, before or after this step, because diff paths carry `a/` and `b/` prefixes, which `pathWord` does not strip.

- **0.2 (s6-p5ua):**
  - **Imports.** `claims-guard.mjs` imports `runText` and `writeIndicator` from `shell-parse.mjs` directly; everything else still comes from claims-core.
  - **Diff prefixes.** `pathWord` in claims-core retries a non-existent path without its `a/` or `b/` prefix, and keeps the stripped path when it is a real, non-exempt repo path. So `git apply <<EOF` and `patch <<EOF` now name the files they change. A real folder named `a/` still matches first.
  - **New tests.**
    - The a/b-prefix tests in claims-core (failed before the fix, pass after).
    - Two end-to-end guard tests in hooks.test. One allows the 0.1 false positives: comparisons in `node -e`, and a heredoc to `$TEMP` that mentions rm. The other blocks script writes and the heredoc patch; its patch case failed before the fix.
  - **Spec additions.** §7.4 to §7.7: run estimate, running colours, progress strip, six-tile layout. Phase 1 goes from 5 to 7 steps, and the total from 60 to 62.

- **0.3 (s7-c6hn):**
  - **`claims.mjs number-migration <_pending_ file>`.** Under the claims lock it reads `supabase/migrations/` in main and in every worktree (`git worktree list`) and prints the next number and the numbered file name.
    - **Issued numbers are recorded.** Each one goes into `<git common dir>/alfred-migration-numbers.json`, so a number that has been handed out but not yet written is never given to another thread. The spec said "writes nothing"; this file is in `.git`, not the repo, and without it the race stays open.
    - **Only the thread's own files.** It refuses a file that is not `_pending_<this owner>_…sql`. Owners with underscores work.
    - **Format.** Numbers are padded to 3 digits.
  - **gitpush refuses** a `_pending_` migration that still exists, and a new migration whose number main (as committed or pushed) or another new file in the same push already uses.
    - The check runs in Push and Finish on main, and in Checkpoint and Finish on a worktree, before the plan prints and before anything changes.
    - Edits to files main already has are never refused, so main's old duplicates (122, 150, 153) block nothing.
  - **gitsync** merges with `git merge --no-edit main` (`syncMergeArgs`).
  - **gitpush** ends `Done at YYYY-MM-DD HH:MM:SS` (`doneAt`).
  - **The gitcom echo:** only the echo looked wrong, and the argument list was fine. `gitLive` printed `args.join(" ")`, and commit b3a44fa received all 8 paths. On that 268-character line the missing space falls at column 181, which matches the terminal wrapping at 180 and losing the space at the wrap. `commandEcho` now prints more than two paths after `--` one per line. The fix is in git-flow.mjs, so `git-commit-claimed.mjs` did not need a change.

- **0.4 (s8-v9qe):**
  - **Main and live worktrees.** On main, the prompt hook blocks any tag whose project code is a live worktree, bound or unbound, and binds nothing. "Live" is read from `.git/worktrees/*/gitdir`, with no git call: the worktree's `.git` file must still exist. The message names the worktree and its folder.
  - **Duplicate paste: the hook refuses it, not the panel.** Spec §6.1 said the panel would refuse, but Switchboard never types prompts: Alex pastes them into Claude Code himself.
    - The rule: a tag equal to the run tag this checkout last accepted (`run_tag` in `.clip/session-status.json`) is blocked as "ALREADY PASTED".
    - The status is written as `wrong` with event `duplicate run tag`, and the tile shows red "Already pasted"; a tap clears it, as for Wrong window.
    - `override:` resends on purpose.
    - Only the last tag is compared. Tags from before that one are not remembered.
  - **README.** The spec link and the bridge-spec link both point to `docs/history/`, and the table gains the Wrong window / Already pasted row.
  - **Not fixed, out of scope:** `extension/README.md` line 181 still links `docs/technical-spec-switchboard_bridge.md`, which also lives in `docs/history/` now.

- **0.5 (s9-k7wf):**
  - **`scripts/claims.mjs` yielded** to gmail_capture-h3w, now that it matches main (f6a2512).
  - **Recording.** The prompt hook records each allowed tagged prompt Alex typed in `.clip/scope.json`: the run tag, `found`, the five lists, and `Estimated run`. The library is loaded so that a failure can never change a prompt decision. Untagged replies and machine traffic leave the scope alone. `PLAN_SCOPE_FILE` redirects it; `drive()` in hooks.test always does, so no test can write the real file.
  - **Enforcement.** `.claude/hooks/plan-guard.mjs` is registered beside the claims guard, with the same matcher, and logs to the same `.clip/claims-guard.log` with a `plan` marker.
    - **Edit tools:** a new file must be under create; an existing one under create or update. Folder entries cover everything under them, and the run tag's `docs/progress-<code>.md` is implied.
    - **`.sql` files:** the new text's tables (create, alter, drop, truncate, insert, update…set, delete from, create index on, grant on) must be named under SQL. Comments are ignored, and schema prefixes and quotes are stripped.
    - **Shell:** rm, del, Remove-Item and git rm targets must be under delete. Other shell writes are judged like the Edit tools. Supabase function names, `db push` and `sf project deploy` metadata or source dirs must be under deploy; a bare `supabase functions deploy` counts as "(all functions)".
    - **Outside the guard:** paths outside the repo, and the claims-exempt folders (`.clip/`, `.git/` and so on).
  - **Decision: no scope file at all → allow.** That covers sessions and threads from before this hook, and the window before the first tagged prompt.
  - **No scope block → nothing may change.** As the spec says, a tagged prompt without a block records `found: false`, and every edit, delete and deploy is then refused, except outside the repo and in `.clip/`.
  - **Rollout risk.** If this reaches main before step 0.6 puts scope blocks into every cli-workflow prompt, every thread's next tagged prompt without a block stops all its edits. Either checkpoint it together with 0.6, or set `PLAN_GUARD=off` (the hook honours it and says so).
  - **Widening the scope** means sending a tagged follow-up prompt (for example s9b) with a new block. An untagged reply cannot widen it.
  - **`extension/README.md`:** the bridge-spec link now points to `docs/history/`.
  - **Found live:** Claude Code reloaded the settings mid-session, so this session's tool calls already run through the plan guard. With no scope recorded yet, it allows them.
  - **Live tests (s9b, s9c):** an undeclared README update was refused by the plan guard alone (the claims guard would have allowed it); a declared one was allowed.

- **0.6 (s10-r2jd):**
  - **`clip.mjs --scope` prints the "Scope vs changes" section; clip.mjs does not add it to the report.** CLAUDE.md requires the pushed and printed report to be identical, so the CLI runs `--scope` and pastes the output in. It needs no clipboard settings and pushes nothing.
  - **What it compares.** The scope comes from `.clip/scope.json`. "This run's edits" are the plan guard's `ALLOW … plan <tag>  in scope: <path>` log lines, and git status (`--porcelain -z`, untracked files listed) is added to them.
    - **Changed, not declared:** edited this run, and not covered by create, update or delete.
    - **Declared, not touched:** a create, update or delete entry that no changed path matches.
    - **Uncommitted from earlier steps:** in git status, but neither declared nor edited this run. A worktree carries these until it checkpoints, and listing them as undeclared would be noise.
    - **Gaps:** shell writes are not in the log, so a shell write shows only as "uncommitted from earlier steps". `.clip/` is left out. The log stops growing at 256 KB, after which the edits are missed.
  - **The missing-section warning is a warning, never a refusal.** It applies to file pushes only, not to piped output, so a test log pushed with `|` is not nagged. A next-step heading counts only when `- create:`-style lines follow it.
  - **The logic lives in `last-report.mjs`** (`missingSections`, `scopeVsChanges`, `formatScopeVsChanges`, `touchedFromLog`, `changedFromStatus`). It imports `covers` from plan-scope, so 0.6 depends on 0.5 and the two must reach main together.
  - **Skill 2026-10-29b:** a new section, "Every prompt declares its scope and its estimated run". Every prompt carries the block and the estimate, starting from the last report's next-step block and saying where it differs. Every reply carrying a prompt opens with a plain scope summary, and sending it is Alex's approval. The return leg checks "Scope vs changes". The templates and both examples now carry a block.
  - **CLAUDE.md:** two new sections. "The plan guard" covers widening scope only by a tagged follow-up, never editing `scope.json` or setting `PLAN_GUARD=off`, test files declared, and the two report sections. "Salesforce sandboxes and client repos" covers the sandbox deploy lock and Apex failures summarised. The two report sections do not count toward the 25-line limit.
  - **Spec §7.2:** a new red "Outside scope" tile state, cleared by a tap. Phase 1 stays at 7 steps, because it goes into the tile-states steps (the plan guard writes `wrong` / `outside scope`, as prompt-check does for "Already pasted").
  - **A slip, caught by the guard:** the first two CLAUDE.md edits used the main checkout's path, and the claims guard refused them. They were redone on this worktree's copy, which was identical. Main's file was not changed.

## Deferred and parked

- Auto-posting "cli" into the chat: parked as a separate idea.
- `claude_reader` token deny list: drafted at the migration step.

## Test checklist

- [ ] Phase 0: each of the 9 fixes has a failing test first, then passes. The plan guard refuses an undeclared create, delete, deploy and SQL table. Both suites green.
- [ ] Phase 1: a duplicate send is refused; each of the five tile states shows; Report unread clears on archive.
- [ ] Phase 2: a link fails after 30 minutes, on a second use, in the wrong tab, and with changed SQL; a dry run rolls back.
- [ ] Phase 3: alfred-v5 works through the shims before the cutover. `sf data query` and a production deploy are blocked. A deploy holds the sandbox lock and sends only claimed files. A screen-made change is caught by the compare.

## Timing log

| step | total |
|---|---|
| s1 | 2m53s |
| s2 | 2m07s |
| s3 | 2m18s |
| s4 | 0m38s |
| s5 (0.1) | 10m24s |
| s6 (0.2) | 2m20s |
| s7 (0.3) | 7m22s (estimate 12m) |
| s8 (0.4) | 5m10s (estimate 10m) |
| s9 (0.5) | 5m35s (estimate 15m) |
| s10 (0.6) | 5m29s (estimate 15m) |
