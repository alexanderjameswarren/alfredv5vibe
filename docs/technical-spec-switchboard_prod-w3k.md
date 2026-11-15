# Switchboard 2.0, production toolkit and friction batch — technical spec

Project code: `switchboard_prod-w3k` (this worktree), with the switchboard repo side under `switchboard_prodrepo-w3k`
Project group: Switchboard 2.0 (`mvsmdaag09pvs6wddm03`)
Progress: `docs/progress-switchboard_prod-w3k.md`
Plan: run tag `switchboard_prod-w3k-s1-q7m3`; decisions: `-s2-r5d8`.
Before this phase: Phases 3-5 under `switchboard2-h8r` (closed 11/12, main 5793f68; see "Closeout (s93)" in `docs/progress-switchboard2-h8r.md`). Phases 6-8 come after this one.

## 1. Goal and non-goals

**Goal.** Fix the friction from the first live client work (the Common Defense diagnosis `cd_ab_diagnose-r4m` and Fix A `cd_ab_recurring_fix-t6k`, 11/12). Give Alex a production toolkit for Salesforce that makes the 11/12 near miss impossible. On that day a validate packaged main's old files, and the quick deploy reported success with every component Unchanged.

**Non-goals.**
- Claude still never deploys to production or runs anything against it. Every `sb prod` command runs in Alex's terminal and refuses to run inside a Claude session.
- No Salesforce record writes by Claude. `sb prod dataop` is Alex's command.
- Client data stays out of Alfred. Backups and failed-row files go to the client's Drive folder or the project log, never into a clip or a table.
- Out of scope, left open: f4e8310d (intake should ask where the processing code lives) and b67cb8c2 (who triggers the one-time sf result fetch). Neither is in the agreed design.

## 2. Who owns what

| owner | where | runs |
|---|---|---|
| `switchboard_prod-w3k` | this worktree (alfred-v5), this window and chat | the spec and progress, the skills, the Alfred side of the filter rule, effort counting, closeout |
| `switchboard_prodrepo-w3k` | the switchboard repo's main checkout (`C:\Users\Alex\projects\switchboard`), its own claude.ai chat and CLI session, bound with `claims.cmd bind` | everything in the switchboard repo |

- The repo thread works in main, not a worktree, for two reasons. Switchboard main already holds every folder claim (sb/, salesforce/, git/, helper/, extension/, clip/, panel/ and more), and install.ps1 installs from main.
- It reports under its own run tags (`switchboard_prodrepo-w3k-s<n>-<4>`).
- It **never sets `project_code`** on the Project's plan. The plan's code stays `switchboard_prod-w3k`. Its steps count toward the Project once effort counting (§9) lands, through `project_codes`.
- **Repo s13 depends on w3k s6** (§10a). Finish by link, which closes the window, starts only after s6's approve-page wording is in production, so the page says what s13's finish does. Repo s12 doesn't depend on any w3k step.
- **Repo s13 also depends on w3k s9 and s9b** (§10b): the `no_prod_deploy` key live in Alfred, and the helper passing it on.
- Each repo-thread step reads this spec for its group, and its report gives the commit only after Alex pushes. Pushes in the switchboard repo are Alex's. After any change under extension/, panel/ or helper/, he reinstalls with install.ps1, and for the extension he reloads too.

## 3. Build order

1. Skills (§4), this worktree.
2. dataop and rollback (§5.2), repo thread. dataop comes first: Fix A's data cleanup needs it by Monday 11/16.
3. sb prod validate and deploy (§5.1), repo thread.
4. The finish gate and the scheduled-job snapshot (§6), repo thread.
5. The filter rule (§7), both sides. The repo lands first.
6. Effort counting (§9), this worktree.
6a. The approve-page wording (§10a), this worktree, at w3k s6, before the filter rule's Alfred side. It must reach production before repo s13.
7. The setup commands (§8), repo thread.
8. Finish-by-link window close and the extension's result line (§10), repo thread.
9. 8b and 8c, plus 8a's optional tile release button (§11), repo thread.
10. Closeout, this worktree.

dataop (2) is built before validate and deploy (3), so it carries the shared pieces itself: the org identity check, the in-session refusal and the project-log record (§5.0). Validate and deploy then reuse them.

## 4. Skills (this worktree)

Friction fixed:
- cli-workflow: edeedacd, 1ba185db, 02bdd170;
- sf-diagnose: 496ca285, baccf500, 43a6c0f1, 48957762, ccdd847c;
- salesforce-workflow: cc6500f6, 4052c4aa, 4dbb4780, 76cab513, 3eca7b74, cd176716, 07a970ec, plus the Stage 7 parts of fa8d5663 and c0121c9f.

**Sources.**
- The repo's `.claude/skills/cli-workflow/SKILL.md` is 2026-11-09a. The claude.ai copy is 2026-11-11a and is the base. The step first replaces the repo copy with 11-11a byte for byte, then edits.
- sf-diagnose and salesforce-workflow (both 2026-11-12a) exist only in the claude.ai sync folder (`C:\Users\Alex\.claude\skills\synced\<id>\`). The step copies them into `.claude/skills/sf-diagnose/` and `.claude/skills/salesforce-workflow/` as new files, then edits.
- Each skill gets a new version line (2026-11-1Xa). Alex uploads the three to claude.ai after the step.

**cli-workflow.**
- Every terminal step that must run in a given folder starts its copy box with `Set-Location "<absolute path>";`.
- A reply with an approve link has no other step that asks for a paste-back. Paste-back steps go in their own reply.
- Scope-block deploy entries are names or paths only, comma-separated. Any note goes in brackets after the list.

**sf-diagnose.**
- Setup order: ask for the client folder path, then `sf org list`, then `sb org add` for each org, then `sb org verify`, then `sb project add` with the absolute repo path.
- Production is retrieved into a clean main (git status empty), and `git diff` is the comparison, not a scratch folder. An admin change is committed as "Sync from production <date>"; a code change means stop and look.
- The Drive folder is created only when the first file that can't go in git exists. Its path mirrors the projects folder, then the project name, then the project code.
- Client chat titles name the client: "Not done <code> <Client> <few words>".
- An sf read link ends the reply and never shares it with a decision. After a link, the next reply waits for the done line.
- Developer Console steps open with `sf org open --target-org <alias>`.

**salesforce-workflow.**
- Stage 0 passes or fails on two checks: a private GitHub remote (`git remote -v`) and finish mode pr.
- Main-folder work in a client repo runs in the "<client> main VS Code window". It is opened with `Set-Location "<absolute repo path>"; code .`, then `claude` in that window's terminal, never a standalone terminal.
- Setup pages are opened with `sf org open --target-org <alias> --path <setup path>`.
- At a pause point, before the reply ends:
  - an Alfred intention under the Project in the Work context, due on its date, with the reminder on it;
  - its note opens with one sentence on where things stand, then the steps;
  - `update_project_plan` (where_now, next_step, waiting_on, the date) and `log_activity`;
  - each check's query covers every day since the last check (for example a daily GROUP BY over LAST_N_DAYS:n), never only YESTERDAY.
- Stage 7 uses `sb prod validate <code>` and `sb prod deploy <code>`, and data changes use `sb prod dataop`.
- Stage 8 finishes by link (`queue_switchboard_git`, gitpush mode finish) and reads the PR link from the run's result.

**overwatch SKILL.md.** One line saying that steps_used counts every code the Project has had (after §9 lands; edited in the effort-counting step).

## 5. Production toolkit (repo thread)

Friction fixed: fa8d5663, c0121c9f (validate and deploy).

### 5.0 Shared
- **Refuse inside a Claude session**: refuse when the `CLAUDECODE` environment variable is set, or when an ancestor process is claude. The message says these run in Alex's own terminal.
- **Org identity**: `sf org display --target-org <alias>` must give the org Id and instance recorded in orgs.json for the project's client, and the org must be production with `productionAllowed`. A mismatch refuses before anything runs.
- **Find the project's worktree**: read projects.json and the repo's `git worktree list`, and take the checkout whose folder name is the code. No worktree means no run. Every path passed to sf is absolute, built from that checkout.
- **Record**: `%LOCALAPPDATA%\Switchboard\config\project-logs\<code>.prod.json` (beside the existing `.log`). It holds each run's command, the commit, the Job ID, the test counts, the components and the result. The finish gate (§6) and rollback read it.

### 5.1 `sb prod validate <code>` and `sb prod deploy <code>`
- **Validate**:
  - refuse uncommitted changes in the worktree (`git status --porcelain` not empty), and record HEAD;
  - the changed files are `git diff --name-only <merge-base main>..HEAD` under the package directories, as absolute paths;
  - drift check against production: retrieve those components into `.sb/` inside the checkout (s91's method) and compare them with main's copies. A difference refuses the run and names the files;
  - run `sf project deploy validate` with the tests the project declares;
  - compare the test count with the last `sb test` for that code, from its project log. A different count refuses the run, as at 11/12 (37 against 55);
  - save the Job ID.
- **Deploy**:
  - the quick deploy of the saved Job ID, refused if HEAD has moved since the validate;
  - any component reported Unchanged is a failure;
  - afterwards, retrieve the components and compare them with the worktree's files byte for byte, ignoring line endings. A mismatch is a failure, shown in red;
  - the pre-deploy retrieve is kept for rollback.

### 5.2 `sb prod dataop <code> --plan <file>` and `sb prod rollback <code>`
- **dataop** runs a planned data change (update, insert or delete through the Bulk API by `sf data`) from a plan file in the worktree that names the object, the operation, the CSV and the expected count.
- Before the run:
  - **backup**: export every target record's affected fields to the client's Drive folder, or the project log folder if there is none. The path is recorded, never the data;
  - **Ids matched**: the CSV's Ids equal the backup's Ids exactly, with no extras and none missing;
  - **rehearsal recorded**: the same plan ran on a sandbox (`sb` against a sandbox alias) with a recorded result, and the run refuses without one;
  - **counts before**.
- After the run:
  - counts after, compared with the expected change;
  - **failed rows** saved beside the backup, with only the count and the error kinds on screen.
- **rollback**:
  - for a deploy, re-deploy the pre-deploy retrieve saved by 5.1, by validate and quick deploy with the same checks;
  - for a dataop, restore from its backup through the same dataop path, rehearsal excepted (it names the original rehearsal).

## 6. Finish gate and job snapshot (repo thread)

- **Finish gate.** For a salesforce-kind repo, gitpush finish refuses to merge when the project log has a prod deploy and the commit it deployed isn't the worktree's HEAD, and it names both commits. With no prod deploy recorded, it asks Alex to confirm that nothing went to production; `--no-prod-deploy` answers it, and by link the payload key `no_prod_deploy` does (§10b).
- **Scheduled-job snapshot.** Before and after a prod deploy, read CronTrigger with CronJobDetail (job name, type, state, next fire time) into the project log, and diff the two. A job that is gone, or that changed state, is shown in red. This is metadata, not client records.

## 7. The filter rule (both sides; the repo lands first)

Friction fixed: a80af92f (it supersedes a3a00c04, wont_fix).

**Rule.** At level ids, results stay Id, CreatedDate and LastModifiedDate only, and every read is still approved by link. The filter limit (filters only on those three fields) applies only when the org's `contractAllowsClaude` is false. When it's true, any filter is allowed.

**Where the rule lives today**:
- the helper (`salesforce/read/plan.mjs`, which reads orgs.json);
- the mcp tool (`supabase/functions/_shared/tools/switchboard.ts:608`);
- the `switchboard_actions_sf_read_payload` check constraint (migration 233).

Only the helper knows the contract flag.

**Repo side first** (`switchboard_prodrepo-w3k`). plan.mjs applies the filter limit only when `contractAllowsClaude !== true`, with tests both ways, and RULES.md and README are updated. At the same step, **Alex sets `contractAllowsClaude` to yes for `actblue` and `commondefense-ab-prod` in his own terminal**, one command per org:
- `sb org set <alias> --contract-ok on`, checked with `sb org show`;
- **never by link**: setup links refuse `--contract-ok on` by design (sb/lib/org.mjs:142), they run only `client start` and `org add`, and production is never set up by link.

The repo goes first so the stricter check stays in force until the helper can enforce the flag.

**Alfred side second** (this worktree).
- A migration drops the ids filter-field limit from the constraint and keeps the ids fields limit.
- The tool drops its ids filter check and keeps the fields check. Its description and the approve page say that the helper applies the filter limit by the org's contract.
- A `--test` script shows a contract-free ids filter accepted and a non-Id field at ids still refused.
- db items: `db:table:switchboard_actions` (migration step), then `db:deploy` (mcp deploy).

## 8. Setup commands (repo thread)

Friction fixed: c9cc159a, 599f7fa2, cc6500f6 (the sb side), 5c71b0c2, 0ad5c1f8, 10f0f91c, and the contract default (sb/lib/org.mjs:159).

- **`sb set`**, with the diff-then-yes confirmation that `sb project add` uses:
  - `sb set repo <path> --finish pr|merge|local-commit`
  - `sb set project <code> --client <client>`
- **Every `--client`** accepts the slug or the display name and resolves to the slug. `sb project add` refuses a client not in orgs.json and offers the closest slug ("did you mean common-defense?").
- **`sb client start`** (and `--adopt`):
  - checks for a GitHub remote, and defaults the finish mode to pr when there is one;
  - adds any missing standard Salesforce .gitignore entries (`.sfdx/`, `.sf/`, `.localdevserver/`, `node_modules/`, and `.vscode/` unless the client commits it), as their own commit, which Alex makes by link or in his terminal.
- **`sb org add`**:
  - checks for a duplicate alias before asking anything;
  - reads production or sandbox from sf;
  - asks the sandbox type (developer, developer_pro, partial, full) only for a sandbox;
  - skips the other-developers question for production;
  - asks the contract question, never defaulting to false silently (org.mjs:159). **By link, the helper always passes `--contract-ok off`** when it runs `sb org add` (planSbSetup in `helper/lib/core.mjs`, with its test), so the answer is recorded as off explicitly. A link can never set it on, and there is no payload key for it: `queue_switchboard_sb_setup` and its constraint stay as they are. Alex turns it on only in his terminal (`sb org set <alias> --contract-ok on`).

## 9. Effort counting across a Project's codes (this worktree)

No friction id; carried from the s93 closeout. Today `overwatch_project_progress` (last defined in 178) counts run tags only under `project_plans.project_code`, so Switchboard 2.0 shows 0 steps used, and switchboard2-h8r's steps don't count.

**Where the code history lives.** A new table, `public.project_codes`:
- `user_id`, `group_id` (the Project), `project_code` (unique per user: one code belongs to one Project), `role` (`main` or `side`), `added_at`;
- RLS on user_id, explicit grants and none to anon, registered with `platform.register_table()`.

**How codes get there:**
- a trigger on `project_plans`: when `project_code` is set or changed, the new code is added with role `main`, and the old row stays, so the history is kept;
- side codes (a repo thread's code such as `switchboard_prodrepo-w3k`) are added by a new `update_project_plan` parameter, `add_project_codes`, which never changes `project_code`;
- a backfill in the same migration:
  - every current `project_plans.project_code`;
  - for Switchboard 2.0: `switchboard2-h8r` (main), `switchboard_repo-k7m` and `switchboard_prodrepo-w3k` (side);
  - for ActBlue Common Defense: `cd_ab_recurring_fix-t6k` (side). Alex confirms this list in the step before it is written.

**How the counts are kept.** `overwatch_project_progress` keeps its signature, because the nightly-counts functions read `pr.*`:
- steps_used becomes the number of distinct (code, step number) pairs over every code in `project_codes` for the Project, so s4 under two codes counts twice and s4b under one code counts once;
- reports is the sum over all codes, and last_report_at the latest.

The estimate history (`project_estimates`) is per group already and needs no change. `record_project_estimate` reads steps_used through the function, so it follows. `get_project_plans` adds `codes` (from `project_codes`, read by the tool) and its description says "under every code the Project has had".

**db items**:
- `db:table:project_codes` (new), `db:table:project_plans` (trigger), `db:fn:overwatch_project_progress`, at the migration step;
- `db:deploy`, at the tool deploy;
- then `check_platform_conformance`.

**Repo side.** None. gitnewtree doesn't need to know about it: the trigger records each new plan code.

## 10. Finish-by-link window close and the extension's result line (repo thread)

Friction fixed: 54b1f4e2 (window close), 4f40a508 (result line).

- **Window close.** On a gitpush finish by link, the helper (new `helper/lib/windows.mjs`) finds the worktree's VS Code window by its folder, as the panel's tiles already do:
  - it refuses if that worktree's Claude CLI is still running, or VS Code shows unsaved files, and names which (the window, the session, the dirty file count from the title's marker);
  - otherwise it closes the window, waits for it to go, then runs finish;
  - the approve page says "closes the <code> VS Code window, then finishes" (built at w3k s6, §10a).
- **Result line.** While the claude.ai chat box holds text, the extension waits and retries (every few seconds, with no time limit while the tab is open). It never overwrites or drops what is typed and never fails silently: the tile shows "result line waiting: chat box has text" until it posts. The extension's version goes up, and Alex reinstalls and reloads.

## 10a. Approve-page wording (this worktree, w3k s6)

Lands before repo s13, which relies on it. No migration, no mcp deploy and no db items: the page ships with Alex's push.

- **The approve page** (`src/switchboard/ApprovePage.jsx`, `gitLines`): for a gitpush finish by link, the action line opens with "Closes the <code> VS Code window, then finishes: runs gitpush finish for <code>.", using the action's project code. The phase or project-done line follows as before. Every other git action is unchanged.
- **Tests** (`src/switchboard/ApprovePage.test.jsx`): the finish wording, in `gitLines` and on the rendered page, and a checkpoint's lines unchanged.
- The server-made headline (`GITPUSH FINISH <code>: MERGES INTO MAIN, PUSHES, REMOVES THE WORKTREE`) is left as it is.

## 10b. A Finish by link with no production deploy (this worktree, w3k s9 and s9b)

From the repo chat's s8 (§6's finish gate). In a salesforce-kind repo, gitpush finish refuses when the project log records no production deploy, unless `--no-prod-deploy` says nothing went to production. In the terminal it asks; by link it can't, so it refuses (exit 3). This gives the link a way to carry that answer.

**Alfred side (w3k s9, then s9b).**
- `queue_switchboard_git` (`switchboard.ts`, `gitPayload`) takes `no_prod_deploy`: only `true`, only on gitpush with mode finish. On any other command or mode it refuses, saying only a Finish checks for a production deploy; `false` or any other value is refused too (leave the key out instead).
- The server-made headline for such a Finish ends `; APPROVING CONFIRMS NOTHING FROM <CODE> WENT TO PRODUCTION`.
- The approve page shows a prominent red line under the headline: "Approving confirms nothing from <code> went to production." Every other git action is unchanged.
- **No migration.** The `switchboard_actions_git_payload` constraint checks `command`, `mode` and `then`, and `switchboard_actions_git_repo` checks `repo`; neither limits the other keys, so `no_prod_deploy` is stored as it is. The tool is the only Alfred-side check.
- s9b: the `queue_switchboard_git` description in `supabase/functions/mcp/index.ts` names the key, then `db:deploy` and the mcp deploy. The approve page ships with Alex's push.

**Repo side (the repo chat, before its s13).** The helper (`helper/lib/core.mjs`, the git plan) accepts `no_prod_deploy: true` and passes `--no-prod-deploy` to gitpush finish. It refuses the key on anything but a finish, and in a repo that isn't kind salesforce, naming why. Tests in `helper/lib/core.test.mjs`.

**Dependency.** Repo s13 (Finish by link closes the window) needs w3k s9b live (deployed mcp and the approve page in production) and the repo side's helper change installed, so a Salesforce Finish by link can be approved at all.

## 11. clip and panel fixes (repo thread)

- **8a** (b2eca3bc, 5fac305a): already built by s92/s92b (test domains, timing tables, `clip.cmd release <id>` in the hold message). Only the optional release button on the tile is left.
- **8b** (12400904): clip's change list shows whitespace-only changes in their own section ("whitespace only, N lines"), and the review gate lists them apart. **Recommended over a restore path**: a narrow write path would be a new hole in the shell-edit guard, while the separate list fixes what Alex sees at the review gate with no new way to write files.
- **8c** (a33a4a8a): the tile shows each run tag's report once. It keeps the last report id shown per tile in run-tiles.json, so a panel restart doesn't show it again, and the host ignores a second push of the same report id.

## 12. Already fixed or closed (carried in)

- s84f (git result lines in the chat) and s86q (the extension takes sf_check approvals): built (bridge-core.js POST_LINE and HELPER_KINDS, extension 1.2.27); their rows were never closed.
- d556ef77: the "reads only the Id field" refusal came from the helper before c4af8cb (s89fb). The installed plan.mjs has the new rule. Closed.
- sf_check 72ca1cc0: a stale test, queued since 11/10. The repo thread cancels it.
- ca71fbb2, 03a004cd, 693def48: in cli-workflow 11-11a (reinstall with reload; chain link last under its prompt; any approve link ends the reply).
- b66d4b90: s91 (a57f876), the drift-check retrieve runs in `.sb/` inside the checkout. Its clip part was fixed by s92.

## 13. Files

| group | repo | files |
|---|---|---|
| spec, progress | alfred-v5 | `docs/technical-spec-switchboard_prod-w3k.md`, `docs/progress-switchboard_prod-w3k.md` |
| skills | alfred-v5 | `.claude/skills/cli-workflow/SKILL.md`, `.claude/skills/sf-diagnose/SKILL.md` (new), `.claude/skills/salesforce-workflow/SKILL.md` (new) |
| dataop, rollback, validate, deploy | switchboard | `sb/sb.mjs`, `sb/lib/prod.mjs` (new), `sb/lib/prod.test.mjs` (new), `sb/lib/dataop.mjs` (new), `sb/lib/dataop.test.mjs` (new), `salesforce/deploy.mjs`, `salesforce/deploy.test.mjs`, `salesforce/lib/sf.mjs`, `salesforce/guard.mjs`, `salesforce/guard.test.mjs`, `salesforce/RULES.md`, `README.md` |
| finish gate, job snapshot | switchboard | `git/git-push-worktrees.mjs`, `git/lib/git-flow.mjs`, `git/lib/git-flow.test.mjs`, `salesforce/lib/jobs.mjs` (new), `salesforce/lib/jobs.test.mjs` (new) |
| filter rule, repo side | switchboard | `salesforce/read/plan.mjs`, `salesforce/read/plan.test.mjs`, `salesforce/RULES.md`, `README.md` |
| filter rule, Alfred side | alfred-v5 | `supabase/migrations/_pending_switchboard_prod-w3k_ids_filters.sql` (then its number), `supabase/functions/_shared/tools/switchboard.ts`, `supabase/functions/_shared/tools/switchboard.test.mjs`, `supabase/tests/switchboard_prod-w3k/` |
| approve-page wording (§10a) | alfred-v5 | `src/switchboard/ApprovePage.jsx`, `src/switchboard/ApprovePage.test.jsx` (claimed at s5) |
| no production deploy (§10b) | alfred-v5 | `supabase/functions/_shared/tools/switchboard.ts`, `supabase/functions/_shared/tools/switchboard.test.mjs`, `src/switchboard/ApprovePage.jsx`, `src/switchboard/ApprovePage.test.jsx`; at s9b `supabase/functions/mcp/index.ts`. No migration (claimed `_pending_switchboard_prod-w3k_no_prod_deploy.sql`, not written) |
| no production deploy, repo side | switchboard | `helper/lib/core.mjs`, `helper/lib/core.test.mjs` |
| effort counting | alfred-v5 | `supabase/migrations/_pending_switchboard_prod-w3k_project_codes.sql` (then its number), `supabase/functions/_shared/tools/overwatch-projects.ts`, `supabase/functions/_shared/tools/overwatch-projects.test.mjs`, `supabase/functions/mcp/index.ts`, `supabase/tests/switchboard_prod-w3k/`, `.claude/skills/overwatch/SKILL.md` |
| setup commands | switchboard | `sb/lib/set.mjs` (new), `sb/lib/client.mjs`, `sb/lib/client.test.mjs`, `sb/lib/org.mjs`, `sb/lib/project.mjs`, `sb/lib/repo.mjs`, `sb/lib/store.mjs`, `sb/lib/sb.test.mjs`, `sb/sb.mjs`, `helper/lib/core.mjs`, `helper/lib/core.test.mjs` (`--contract-ok off` by link), `README.md` |
| window close, extension | switchboard | `helper/lib/windows.mjs` (new), `helper/lib/windows.test.mjs` (new), `helper/lib/core.mjs`, `helper/lib/core.test.mjs`, `git/git-push-worktrees.mjs`, `extension/lib/bridge-core.js`, `extension/lib/bridge-core.test.mjs`, `extension/claude-watch.js`, `extension/bridge.js`, `extension/manifest.json` |
| 8a-8c | switchboard | `clip/lib/changes.mjs`, `clip/lib/changes.test.mjs`, `clip/clip.mjs`, `clip/lib/clip.test.mjs`, `panel/lib/status.ahk`, `panel/test-status.ahk`, `panel/bridge/host.mjs`, `panel/bridge/host.test.mjs`, `rules/SWITCHBOARD-RULES.md` |

The switchboard files are covered by switchboard main's folder claims, which the repo thread holds; it checks them at its first step. The approve-page wording for §10 is built at w3k s6 (§10a). Any for §7 is made at the filter-rule step (s7), in the same file.

## 14. Database items, by step

| item | group | step |
|---|---|---|
| `db:table:switchboard_actions` | filter rule, Alfred side | number and queue |
| `db:deploy` | filter rule, Alfred side | mcp deploy |
| `db:table:project_codes` (new) | effort counting | number and queue |
| `db:table:project_plans` | effort counting | number and queue |
| `db:fn:overwatch_project_progress` | effort counting | number and queue |
| `db:deploy` | effort counting | mcp deploy |
| `db:deploy` | no production deploy (§10b) | mcp deploy (s9b) |

Each is claimed at its step, never earlier and never carried over, as CLAUDE.md's "Database steps, just in time" says. Checkpoint releases them.
