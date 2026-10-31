# Switchboard 2.0 — Progress

Project code: `switchboard2-h8r`
Spec: `docs/technical-spec-switchboard2-h8r.md`

Status: Phase 0 complete (0.8, s12-w4tc). Phase 1: 1.1 to 1.3 done.

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
| 0 | 0.7 | Module boundaries: bridge vs clipper in `extension/`, header interfaces | — | done (s11-n6hb) | 2026-10-29 |
| 0 | 0.8 | `INTERFACES.md` draft; full test run | — | done (s12-w4tc) | 2026-10-29 |
| 1 | 1.1 | Send to CLI: extension and host | — | done (s13-q2vx) | 2026-10-29 |
| — | s14 | Re-plan Phase 1: Send by a link in the reply; Alfred's address is a setting | — | done (s14-h5rc) | 2026-10-29 |
| 1 | 1.2 | Send link: host list, click catch, prompt frame | — | done (s15-b3nk) | 2026-10-29 |
| 1 | 1.3 | Send link: panel pastes into the project's window | — | done (s16-f7pz) | 2026-10-29 |
| 1 | 1.4 | Alfred `/send/:runTag` fallback page | — | done (s17-c4mz) | 2026-10-30 |
| 1 | 1.5 | Skill: a Send link under every prompt | — | done (s18-k8tn) | 2026-10-30 |
| 1 | 1.6 | Tile states, including Outside scope and Not sent | — | done (s19-v6pd, s19c-y2rt); Report unread moved to Phase 2 | 2026-10-30 |
| 1 | 1.7 | Running colours by time left | — | todo | |
| 1 | 1.8 | Estimate on the tile; Estimate vs actual | — | todo | |
| 1 | 1.9 | Progress strip | — | todo | |
| 1 | 1.10 | Six-tile layout and lane order | — | todo | |
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

**0.8, interfaces draft and full test run** (estimated run: 12m)
- create: tools/claude-sessions/INTERFACES.md
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none

## Proposed scope per step (Phase 1)

**1.1, send to CLI: extension and host** (estimated run: 20m). The claude.ai tab's prompt goes through the bridge to the native host, which writes it for the panel. Duplicate tags are refused.
- create: nothing
- update: extension/bridge.js, extension/claude-watch.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, tools/claude-sessions/bridge/host.mjs, tools/claude-sessions/bridge/host.test.mjs, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

*Re-planned in s14: Send is a link in the reply (spec §7.1), not a tile tap. The old 1.2 block is replaced by the blocks below.*

**1.2, Send link: host list, click catch, prompt frame** (estimated run: 12m). The host reads `[links] hosts=` from the panel's settings.ini and sends it in `hello`. `claude-watch.js` catches clicks and middle-clicks on `/send/<tag>` links to listed hosts, reads the prompt from the same reply, and sends it on. `bridge.js` closes a `/send/` tab that opens anyway. The host takes an extension-sent `prompt` frame in place of the 1.1 `sendprompt` command path, which is removed.
- create: nothing
- update: extension/claude-watch.js, extension/bridge.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, tools/claude-sessions/bridge/host.mjs, tools/claude-sessions/bridge/host.test.mjs, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

**1.3, Send link: panel pastes into the project's window** (estimated run: 15m). The panel sees `prompt-<project>.json` and finds that project's VS Code window; none found means nothing is sent, and it never uses the active window. It refuses while the tile is Running. Otherwise it focuses Claude Code's input, pastes, submits, restores the clipboard and deletes the file. A refusal turns the tile red "Not sent" until tapped. That covers the panel's own refusals, and the host's or extension's in `prompt-result.json` (`ok: false`, with `project` and `error`). It starts by confirming how to focus Claude Code's input reliably, and stops to ask if there is no reliable way.
- create: nothing
- update: tools/claude-sessions/lib/bridge.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

**1.4, Alfred fallback page** (estimated run: 6m). The app route `/send/:runTag`: the tag, its project, and "Send this from your desktop". It reads no data and needs no sign-in.
- create: src/switchboard/SendFromDesktop.jsx, src/switchboard/SendFromDesktop.test.jsx
- update: src/App.js
- delete: nothing
- deploy: nothing
- SQL: none

**1.5, skill: a Send link under every prompt** (estimated run: 4m). It adds one base-address line (`Alfred base: https://alfredv5vibe.vercel.app`). Every reply with a prompt ends with `[Send to CLI](<base>/send/<run tag>)` directly under the prompt block. The tile no longer sends. Bump the version.

  Done in s18, version 2026-10-30. **Checkpoint for 1.4 and 1.5 together:** src/switchboard/SendFromDesktop.jsx, src/switchboard/SendFromDesktop.test.jsx, src/App.js, .claude/skills/cli-workflow/SKILL.md, docs/progress-switchboard2-h8r.md.
- create: nothing
- update: .claude/skills/cli-workflow/SKILL.md
- delete: nothing
- deploy: nothing
- SQL: none

**1.6, tile states** (estimated run: 12m). This covers the five states and their precedence, dark variants, and two reds cleared by a tap. "Outside scope" is written by the plan guard as `wrong` / `outside scope`. "Not sent" comes from 1.3's refusal. "Report unread" needs interface 3; if that needs a Supabase function, the step stops and plans the database items first. Rename the orange tile label "Send cli" (a report is waiting) to "Report ready": it is easily confused with the Send link (s17).
- create: nothing
- update: tools/claude-sessions/lib/status.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk, .claude/hooks/plan-guard.mjs, scripts/lib/session-status.mjs, scripts/lib/session-status.test.mjs, scripts/lib/hooks.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**1.7, running colours by time left** (estimated run: 6m). Spec §7.5.
- create: nothing
- update: tools/claude-sessions/lib/status.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**1.8, estimate on the tile; Estimate vs actual** (estimated run: 10m). The panel reads `estimate` from `.clip/scope.json` and shows `0:30 / 2:30`. `clip.mjs` prints the Estimate vs actual line for the report and appends to `.clip/estimates.jsonl`.
- create: nothing
- update: scripts/clip.mjs, scripts/lib/last-report.mjs, scripts/lib/clip.test.mjs, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**1.9, progress strip** (estimated run: 6m). Spec §7.6, with the `progressStrip` setting on the status menu.
- create: nothing
- update: tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**1.10, six-tile layout and lane order** (estimated run: 10m). Spec §7.7 and §7.3: the 3 × 2 grid, the type scale, the "7+" hint, re-measured fit tables, and tiles ordered by lane.
- create: nothing
- update: tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**Database items by step (Phase 2):**
- **2.1-2.4:** `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:fn:switchboard_issue_link`, `db:fn:switchboard_consume_link`, `db:deploy`.
- **2.7-2.8:** `db:table:switchboard_read_log`, `db:table:switchboard_settings`, `db:fn:switchboard_readonly_query`, `db:fn:check_call_budget` (read only), `db:deploy`.
- **Report unread (moved from 1.6, s19c):** orange clears when the report's inbox item is archived. Interface 3: `db:fn:clip-capture` (or a new function) for a status read by inbox id, its own key, a read of `db:table:inbox`, `db:deploy`; then the panel polls it for the tile's last report. Fold into whichever 2.x step builds the function and key.

## Estimate

| # | phase | steps |
|---|---|---|
| 0 | Fixes, boundaries, plan guard | 8 |
| 1 | Send link, fallback page, skill rule, tile states, estimates, layout | 10 |
| 2 | SQL queue, read-only queries | 10 |
| 3 | Multi-repo and clients | 18 |
| 4 | Salesforce reads | 5 |
| 5 | Git and Salesforce by link | 6 |
| 6 | Spec files, archiving | 2 |
| 7 | npm start per tile | 2 |
| 8 | Remote devices | 4 |
| | **total** | **65** |

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
  - **A slip, caught by the guard (0.6):** the first two CLAUDE.md edits used the main checkout's path, and the claims guard refused them. They were redone on this worktree's copy, which was identical. Main's file was not changed.

- **0.7 (s11-n6hb):**
  - **Boundaries were drawn in place; no file moved.** This step's scope allows no deletes and no new files outside `extension/lib/`. Phase 3 does the moves.
  - **Extension: the split already held.** The bridge half (`bridge.js`, `claude-watch.js`, `lib/bridge-core.js`) and the clipper (the rest) import nothing from each other, except `service-worker.js`'s `import "./bridge.js"`. MV3 allows one service worker, so that import stays as the only seam.
    - `extension/lib/boundaries.test.mjs` lists the two halves and fails on any crossing import, or on a `.js` file in neither half.
    - Every file's header names its half, and the README says so.
    - No module was needed under `extension/lib/`.
  - **Switchboard: decisions out of the panel.** The status logic was already pure, in `lib/status.ahk`. Three pieces were still in `claude-sessions.ahk` and moved, with the same output:
    - the button text, now `ButtonLabel(s, name, offset, nowUtc)`; `Label()` is a one-line wrapper;
    - the tile's git counts, now `GitText`;
    - `ChatRowTitle`.

    The panel's header now states the split: windows, timers and file reading in the panel; decisions in `status.ahk`; the bridge in `bridge.ahk`. The file readers (ReadStatus, ReadClaims and the rest) stay in the panel, because a new file there was outside the scope.
  - **Hooks:** each header gains "Owns:" and "Uses:" lines. All five already imported only from `scripts/lib/`. `scripts/lib/session-status.mjs` names its interface and its users.
  - **Stale spec links** in the headers of the bridge files, `service-worker.js`, `bridge.ahk`, the panel and `bridge/host.mjs` now point to `docs/history/`.
  - **`scripts/lib/session-status.test.mjs` was declared but not changed:** no new boundary needed a test there.

- **0.8 (s12-w4tc):**
  - **`tools/claude-sessions/INTERFACES.md`** lists 17 interfaces: 10 on the machine (`.clip/` and `.git/` files), 4 between Chrome, the host and the panel, and 3 to Alfred. Each row gives the direction, the file or endpoint, and its version check.
  - **No version strings exist yet.** Only clip-capture has a check by behaviour: the plain-text fallback, and the flag when the stored run tag differs. Spec §4's version strings are left for Phase 3, before the move.
  - **Full run, all green:**
    - app 3165 passed, 7 skipped, 0 failed (216 suites, 1 skipped);
    - scripts/lib 353/353;
    - extension 18/18 (boundaries 2, bridge-core 15, plan 1);
    - bridge host 11/11;
    - Switchboard test-status and smoke both passed.
  - **Phase 0 complete.** Still open from it:
    - main's old duplicate migration numbers (122, 150, 153), left as they are;
    - the panel's file readers are still in `claude-sessions.ahk` (0.7);
    - the plan guard sees no shell writes in `--scope` (0.6).
  - **The test checklist's Phase 0 line** is met, and is ticked below.

- **1.1 (s13-q2vx):**
  - **The path.** The panel's `command.json` carries `sendprompt` (tab, `project`, optional `tag`). The host forwards it, adding `sentTag`, the last tag sent for that project, from `sent.json`. `bridge.js` asks the tab's watcher for `read-prompt`, without focusing the tab. The watcher returns the last whole prompt in Claude's latest finished message, code blocks first.
    - `checkPrompt` refuses: no prompt; a project code different from the window's; a tag other than the one the panel named; or the tag already sent. Only a passing prompt leaves the extension.
    - The host checks again. The project matches the pending command; the text starts and ends with its `Run tag:` line; it is 64 KB at most; it is not a duplicate; and no `prompt-<project>.json` is still waiting. Then it writes that file and records the tag in `sent.json`.
    - `result.json` carries `did: "prompt"` and the tag, never the text.
  - **"The latest prompt whose tag has not been sent"** is read as the last whole prompt in Claude's latest message. When that one was already sent, nothing is sent; the watcher does not fall back to an older prompt. The skill puts at most one prompt in a reply, so an older one is always stale.
  - **A whole prompt** runs from the `Run tag:` + `Window:` header to the closing `Run tag:` line with the same tag. With no closing line nothing is sent, so a cut-off prompt never goes. It is read only when the chat is finished, as for the issued tag.
  - **Privacy rule changed.** `claude-watch.js` no longer says "no chat text ever leaves the page". The exception is the prompt block, and only on `read-prompt`, which a panel command triggers; its header says so.
  - **One at a time per project** is enforced by the waiting `prompt-<project>.json`. In 1.2 the panel also refuses while the tile is Running.
  - **Duplicate tags are checked three times:** in the extension, in the host, and, as before, by the prompt hook when it is pasted.

- **s14 (re-plan, s14-h5rc):**
  - **Send is a link** at the end of the reply, under the prompt, to `<Alfred base>/send/<run tag>`. The tile still shows "Prompt to paste" but sends nothing. Spec §7.1 is rewritten.
  - **Alfred's address is a setting:** spec §2, rule 8. The host list lives in the panel's settings.ini until Phase 3. Phase 2's approval links use a server-side base address and the same host list.
  - **Kept from 1.1:** the whole-prompt rule, the checks, `prompt-<project>.json`, `sent.json`, and `result.json` without text.
  - **Changes in 1.2:**
    - the extension, not the panel, starts the send (a `prompt` frame); the `sendprompt` command is removed;
    - the prompt is read from the clicked reply;
    - the project comes from the tag, and the panel checks it against a live window.
  - **"The latest prompt" kept:** a link in an older reply is refused unless that reply is the latest one carrying a prompt. Otherwise an old link, never sent, could send a stale prompt.
  - **Phase 1: 7 → 10 steps**, adding the click catch, the fallback page and the skill rule, and splitting the panel paste out on its own. The total goes from 62 to 65.
  - **Spec §7.4 calibration:** `clip.mjs` now prints the Estimate vs actual line for the CLI to paste rather than adding it to the report, matching `--scope`.

- **1.2 (s15-b3nk):**
  - **The host list.** The host reads `[links] hosts=` from the panel's settings.ini, or from `SWITCHBOARD_SETTINGS_DIR`. It is comma-separated, lower-cased, and invalid entries are dropped. The host sends it in `hello`. `bridge.js` keeps the list and sends it to every claude.ai tab; a watcher also asks for it on start. When the host disconnects the list is cleared, so a link is never caught and then dropped. With no list, a link simply opens Alfred's page.
    - **Alex must add the line once:** `[links]` then `hosts=alfredv5vibe.vercel.app` in `%APPDATA%\claude-sessions\settings.ini`. The code holds no default, per rule 8.
  - **The link.** It must be https, its host exactly listed (no subdomains), and its path `/send/<tag>`.
    - `sendTagOf` lives in bridge-core, and claude-watch has a copy because content scripts cannot import. One test checks both against the same cases.
  - **The catch.** Capture-phase `click` and `auxclick` listeners on the document call `preventDefault` and `stopImmediatePropagation` for a listed link only; the middle button is included, other buttons are not.
    - The backup: when a listed `/send/` tab is created or navigated with a claude.ai opener, `bridge.js` closes it and asks the opener's watcher to act on the last link with that tag.
  - **The reply.** `promptForLink` finds the reply that holds the link. It refuses:
    - when the link is outside any reply;
    - when the reply is older than the latest one carrying a prompt;
    - when the reply has no whole prompt;
    - when the prompt's tag differs from the link's;
    - and, in the click handler, while Claude is still writing.
  - **Refusals still reach the host,** as a `prompt` frame with `error` and no text, so the panel can show "Not sent" in 1.3.
  - **New file `prompt-result.json`** replaces 1.1's use of `result.json`. The panel's focus wait reads `result.json` by id, and a Send outcome landing there could have overwritten the reply it was waiting for.
  - **Removed:** the panel-started `sendprompt` command, `read-prompt`, `promptResult`, and the host's pending-command map.

- **1.3 (s16-f7pz), the three layers.** For spec §7.1 step 5; the spec file was outside this step's scope.
  1. **Window.** `PickSendWindow` takes the one VS Code window whose title names the checkout's folder. That is the worktree folder, or main's `alfred-v5`, as a whole ` - `-separated segment (`CodeTitleMatches`). None, or more than one, is refused, and the active window is never a fallback. The checkout is `SessionForProject`: a worktree by its code, or main by its binding.
  2. **Focus.**
     - The panel activates the window and checks that it is in front.
     - It reads the focus through UI Automation (`lib\focus-check.ahk`: `IUIAutomation::GetFocusedElement`, then the element's name, help text, class and automation id).
     - `FocusVerdict` passes only when the name or help text exactly matches, ignoring case, a name saved in `[send] input`. Chromium gives a placeholder as the help text.
     - It refuses at once when the class or name looks like Monaco or xterm (an editor or terminal).
     - If focus is elsewhere, it presses `[send] focusKey` (default `^{Esc}`) once, checks VS Code is still in front, and reads the focus again. Any failure means nothing is pasted, and the tile shows "Not sent: <reason>".
     - **There is no built-in input name.** Until Alex runs `lib\focus-check.ahk` once, which shows what UI Automation sees and saves it on Yes, every Send is refused with "Claude's input is not set up".
  3. **Delivery.** After the paste (clipboard, Ctrl+V, Enter, clipboard restored), the tile waits up to `[send] deliverySeconds` (default 8) for `.clip/session-status.json` `run_tag` to equal the tag. If it doesn't, the tile shows "Not delivered".
  - **The tab-title check was not built.** It was optional, and the three layers do not need it.
  - **Refused while** the CLI is processing, or waiting on an approval.
  - **Every prompt file is taken and deleted,** whether it is delivered or refused, so a refused prompt never goes later by surprise. A refused tag is removed from `sent.json`, so the same link can be clicked again.
  - **Host and extension refusals** in `prompt-result.json` show as "Not sent: <error>". The file present at startup is not shown, nor is an id already shown. A tap clears any Send note.
  - **Found while testing:** the panel's `prompt-*.json` glob also matched `prompt-result.json`, which would have been taken and deleted. It is now skipped.
  - **Live check:** `FocusedElement()` ran on this machine and read Chrome's focused window (class `Chrome_WidgetWin_1`). So the COM calls work; what Claude Code's input reports is still to be seen at calibration.
- **1.3 follow-up (s16c-d9wq), Send link not caught:**
  - **The cause, certain.** AutoHotkey's `IniWrite` writes `settings.ini` as UTF-16 LE with a BOM, and the host read it as UTF-8. So `readLinkHosts()` returned `[]` on the real file, `hello` carried no hosts, and the click catch and the backup had nothing to match. The tests had written UTF-8 files.
    - Fixed by decoding by the BOM. A new host test with a UTF-16 LE file failed before the fix and passes after. The real file now reads `["alfredv5vibe.vercel.app"]`.
  - **Not ruled out:** claude.ai's link markup or click handling could still be a second problem. Only Chrome can show it, so there are now log lines at each stage:
    - `host.log`: `link hosts: …` at start.
    - The service worker console: `[Alfred bridge] link hosts from the host: …`, and `/send/ tab left open: … <why>`.
    - The claude.ai tab's console: `[Alfred watch] link hosts: …`, `Send link not caught: … <why>`, and `Send <tag>: <outcome>`.
  - **Duplicate `clip-full-page` menu:** the top-level call and `onInstalled` both ran `removeAll` before either `create`. Installs now run one after another, and the create callback reads `lastError`. The clipper's behaviour is unchanged.
  - **Rule from now on: bump `extension/manifest.json`'s version whenever extension code changes.** It is now 1.1.0.
  - **Settings in use:** `[send] focusKey=^+!c` (VS Code's "Claude Code: Focus input" bound to Ctrl+Shift+Alt+C, because Ctrl+Esc opens the Start menu). `[send] input=Message input`. Claude's input needs `editor.accessibilitySupport` set to "on"; without it, UI Automation sees only class "View".
  - **Risks:**
    - On Windows, Ctrl+Esc opens the Start menu rather than reaching VS Code (confirmed live, s16c). If it does, the panel refuses ("the focus key took focus out of VS Code"), and `focusKey` can be set to another binding.
    - Chromium builds its accessibility tree only when a UI Automation client asks, so the first read after a VS Code start may see only the window. The answer is to refuse and retry the link. Kept: the whole-prompt rule and the host's checks (tag shape, header and closing lines, 64 KB, duplicate, one waiting). The project now comes from the tag; the panel checks the window in 1.3.
- **1.6 (s19-v6pd, s19c-y2rt), tile states, done:**
  - Order after the reds: Waiting on SQL (tan), Prompt to paste (purple), Report ready (orange), Running (green), Your turn (yellow, flashes; green "Claude writing" while Claude writes).
  - s19c: the slate blue "Talking" from s19 is removed; it lost Your turn's flash, the "Claude is waiting on you" alert. Live test passed for the labels and the Outside scope latch.
  - **Outside scope is a latched field, not the `wrong` state** the spec proposed: the Stop hook rewrites the state to waiting at the end of every turn, so `wrong` would vanish. `session-status.json` `outside_scope` holds the refusal and carries over every write; `clear-wrong` (a tap) clears it and leaves the CLI's state alone.
  - Report ready keeps today's test (the report was pushed after the chat last changed) and only shows while the CLI is idle. True "unread until archived" moved to Phase 2 (see "Database items by step").
  - Waiting on SQL is wired (`sqlWaiting`) but nothing sets it until Phase 2.
  - Not sent was already red until tapped (1.3).
  - Three claims-guard tests fail while this thread holds src/App.js (from 1.4): they expect it unclaimed. They pass once 1.4's claim is released by Finish.

## Deferred and parked

- Auto-posting "cli" into the chat: parked as a separate idea.
- `claude_reader` token deny list: drafted at the migration step.

## Test checklist

- [x] Phase 0: each of the 9 fixes has a failing test first, then passes. The plan guard refuses an undeclared create, delete, deploy and SQL table. Both suites green.
- [ ] Phase 1: a Send link sends only to its project's window and never to the active one. A duplicate, a stale reply's link, and a send while Running are each refused. On a phone the link opens the Alfred page. Each tile state shows; Your turn flashes; Outside scope stays red until tapped.
- [ ] Phase 2: Report unread clears on archive. A link fails after 30 minutes, on a second use, in the wrong tab, and with changed SQL; a dry run rolls back.
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
| s11 (0.7) | 5m31s (estimate 15m) |
| s12 (0.8) | 1m54s (estimate 5m) |
| s13 (1.1) | 3m45s (estimate 8m) |
| s14 (re-plan) | 2m27s (estimate 4m) |
| s15 (1.2) | 5m19s (estimate 6m) |
| s16 (1.3) | 7m37s (estimate 10m) |
| s16c (1.3 fix) | 2m05s (estimate 10m) |
| s17 (1.4) | 1m27s (estimate 4m) |
| s18 (1.5) | 1m28s (estimate 3m) |
| s19 (1.6) | 7m05s (estimate 8m) |
| s19c (1.6 follow-up) | 3m32s (estimate 4m) |
