# Switchboard 2.0 — technical spec

Project code: `switchboard2-h8r`
Progress: `docs/progress-switchboard2-h8r.md`
Plan: run tag `switchboard2-h8r-s1-q7m3`; decisions: `-s2-n4vd` and `-s3-w8ke`.

## 1. Goal and non-goals

**Goal.** Replace copy and paste between claude.ai, VS Code, Supabase and Downloads with single-use approval links that Claude issues. Alex stays the man in the middle; claude.ai stays the orchestrator, one action at a time. The tooling serves client Salesforce repos as well as alfred-v5.

**Non-goals.**
- No autonomous chains: Claude never issues a second link before the first one's result is back.
- No production Salesforce deploys or changes, by CLI or by link, ever.
- No Salesforce record writes, by any route.
- Client data is not kept in Alfred. Code is fine.
- No automatic posting of "cli" into the chat (parked as a separate idea).

## 2. Rules for every phase

1. **One action at a time.** One approval link, then wait for its result, the same as CLI prompts.
2. **Deny by default.** An unlisted org, repo, setting or command runs nothing.
3. **Only Alex changes the rules.** Claude sessions may not edit, or run commands that change, the org settings, the project list or the installed helper code (§5.4).
4. **Client data stays out of Alfred.** It is a rule in CLI prompts, and `clip.mjs` enforces it (§9.8). In client repos, Apex test failures are summarised, never pasted. Salesforce full-data results pass through Supabase in transit only (§10), and the spec says so plainly.
5. **Every run is logged.** Each SQL write, read query, Salesforce read, git action and deploy gets a `switchboard_runs` row.
6. **Every prompt declares its scope.** Each prompt carries a scope block, and the plan guard enforces it (§6.2).
7. **Clicks.** An action runs without a click only if it touches nothing but its own thread's worktree and claimed files (§11.1). Anything that touches main always needs a click and is never automatic. Every click page leads with one plain line in capitals saying what happens (§8.1).
8. **Alfred's address is a setting.** The extension and the panel recognise an Alfred link by its path (`/send/<run tag>`, and Phase 2's approval paths) on any host in a list kept in Switchboard's settings, never in code. Today the list is `alfredv5vibe.vercel.app`. A move to another domain adds a host, and old hosts stay listed so old links keep working. The cli-workflow skill writes links from one base-address line.

## 3. Phase order and dependencies

| # | Phase | Built in | Depends on |
|---|---|---|---|
| 0 | Blocking fixes, module boundaries, plan guard | alfred-v5 | — |
| 1 | Send to CLI, tile states, run estimates, six-tile layout | alfred-v5 | 0 |
| 2 | SQL approval queue, and Claude's read-only Supabase queries | alfred-v5 | 0, 1 (posting back into the tab, and the tile states) |
| 3 | Multi-repo and clients: the move, settings, client commands, Salesforce guard and sandbox deploys | Switchboard repo | 0-2 (it moves everything they built) |
| 4 | Salesforce reads | Switchboard repo and alfred-v5 | 2 (queue), 3 (helper home, org settings) |
| 5 | Git commands and Salesforce actions by link | Switchboard repo | 2 (queue and links), 3 (projects, orgs) |
| 6 | Spec files written by link; docs archiving | both | 2, 3 |
| 7 | npm start per tile | Switchboard repo | 3 (ports in `projects.json`) |
| 8 | Remote devices | Switchboard repo | 5 (all approvals go through Alfred) |

## 4. Module map and Alfred interfaces

The modules, each replaceable without rebuilding the others:

| Module | Today (alfred-v5) | After Phase 3 (Switchboard repo) |
|---|---|---|
| Claims | `scripts/claims.mjs`, `scripts/lib/claims-core.mjs` | `claims/` |
| Shell parser (guard) | inside `claims-core.mjs`, lines 440-1183 | `claims/shell-parse.mjs` (split out in Phase 0) |
| Plan guard | none | `hooks/plan-guard.mjs` (Phase 0) |
| Hooks | `.claude/hooks/*` | `hooks/`, registered in `~/.claude/settings.json` |
| Git commands | `scripts/git-*.mjs`, `scripts/lib/git-flow.mjs` | `git/` |
| Switchboard panel | `tools/claude-sessions/` | `panel/` |
| Bridge extension | `extension/bridge.js`, `claude-watch.js`, `lib/{bridge-core,page,plan,verify}.js` | `extension/` (its own Chrome extension) |
| Clip push | `scripts/clip.mjs`, `scripts/lib/last-report.mjs` | `clip/` |
| Send to CLI | none | `send/` (Phase 1, moved in Phase 3) |
| Salesforce | none | `salesforce/` (guard rules, deploy wrapper, helper, org commands) |

Alfred keeps the clipper extension, the Supabase migrations and functions, and the approve page.

**Alfred interfaces.** These are the only couplings, and each is documented in `INTERFACES.md`:

1. **Clipboard push.** `CLIPBOARD_URL` plus `CLIPBOARD_SECRET`, and the `clip-capture` function.
2. **Activity.** `overwatch-ingest` (session status and finish summaries).
3. **Report status** (Phase 1). The panel reads whether a report's inbox item is archived, using a key that can only read that.
4. **Action queue** (Phase 2): the `switchboard-runner` function. The CLI uses a queue-only key; the desktop helper uses its own pickup key.
5. **MCP tools** for Claude: issue a link, get a run's result, read-only query, and (Phase 4) Salesforce read.

Each interface has a version string. The panel and the helper refuse to work with a mismatch rather than guess.

## 5. Install, settings, and the commands that manage them

Built in Phase 3, and needed by Phases 4 onward.

### 5.1 Install layout and project list

**The source repo** is `C:\Users\Alex\projects\switchboard\`, a private git repo with its own claims file. Switchboard is developed with Claude in this repo, so the repo is not protected.

**The installed copy** is `%LOCALAPPDATA%\Switchboard\`. `install.ps1`, run by Alex:
- copies the code into the installed copy,
- puts `gitpush`, `gitsync`, `gitcom`, `gitnewtree`, `sb`, `claims` and `clip` on PATH,
- registers the native-messaging host,
- writes the hooks into `~/.claude/settings.json`.

The guard protects the installed copy and its config, not the source repo.

**Config** lives in `%LOCALAPPDATA%\Switchboard\config\`:
- **`projects.json`, the project list.** Each project code maps to:
  - its client,
  - one or more repo paths,
  - a mode: `worktrees` (many projects on one repo) or `multi-root` (one project across several repos in one VS Code window and one Claude session),
  - a lane (Fast track, Main, Side road, Country road),
  - a port (Phase 7),
  - its own test classes (Salesforce),
  - a status (`open` or `closed`).
- **`orgs.json`, the Salesforce org entries,** keyed by client and then by alias, with repo paths attached (§5.3).
- **`repos.json`, the repo settings,** keyed by absolute repo path (§5.2).

**Folder layout:**
- One folder per client: `C:\Users\Alex\projects\<client>\`.
- ActBlue has one folder per nonprofit: `...\actblue\<org>\`.
- Worktrees live inside the client folder under `.claude\worktrees\`.
- One-week jobs run in the folder's main checkout.

**Per-repo files Switchboard creates** are kept out of the client's history with `.git/info/exclude`, never `.gitignore`. That covers `.clip/`, and also `.claude/` when the client repo has none of its own. The claims file stays in `.git/`.

### 5.2 Repo settings (`repos.json`)

`mainBranch`, `projectPrefix`, `deployCmd`, `testCmd`, `docsDir`, `finish` (`merge`, `pr`, or `local-commit`; the default is `pr` with a remote and `local-commit` without one), `kind` (`alfred` or `salesforce`), and `orgs` (a list of aliases).

### 5.3 Org entries (`orgs.json`)

Per alias:
- **Identity:** `orgId` and `isSandbox`, recorded from Salesforce at setup, and `sandboxType` (`developer`, `developer_pro`, `partial`, `full`, `production`). Partial and full hold real records.
- **Access:**
  - Only listed orgs run. Production is listed only with `productionAllowed`.
  - `level`: `objects`, then `metadata`, then `ids`, then `data`. The levels are cumulative.
  - `productionFullData`: a separate flag, `false` by default.
  - `contractAllowsClaude`: must be `true` before `level: data` takes effect for that client.
- **Login:** `login`, either `integration` (an API-only user with a read-only permission set) or `admin`.
- **Deploy:**
  - `cliMayDeploy`: `true` by default for sandboxes, always `false` for production.
  - `shared`: other developers use this sandbox. Informational; Alex sets `cliMayDeploy` off for such sandboxes.

Each client entry also says whether it allows an integration user. Team IMPACT and Fuse do.

### 5.4 Commands (`sb`, terminal only, run by Alex)

| Command | What it does |
|---|---|
| `sb client start <client> [--org <nonprofit>] [--repo <url>] [--from-sandbox <alias>] [--project <code>]` | Creates the folder. Either clones the repo, or with no repo retrieves the code (`sf project generate manifest --from-org`, then `sf project retrieve start`). Runs `git init` when there is no repo. Writes `repos.json`, adds the project to `projects.json`, and runs `sf org login web --alias`. Then asks the setup questions for each org and writes the entry. |
| `sb org add <alias> --client <c>` | Asks the same questions for one more org and logs it in. |
| `sb org set <alias> [--level L] [--sandboxes all\|a,b] [--production on\|off] [--production-full-data on\|off] [--login integration\|admin] [--cli-deploy on\|off] [--contract-ok on\|off] [--type T] [--shared on\|off]` | Changes an entry. Shows a before-and-after diff and asks for a typed yes. |
| `sb org show [<alias>\|--client <c>]` | Read-only. |
| `sb org verify <alias>` | Read-only. Runs `sf org display` and checks the `orgId` and `isSandbox` against the entry. |
| `sb project add\|close\|lane\|tests <code> ...` | Edits the project list. |
| `sb client end <client>` | `sf org logout` for every org of that client, which deletes the stored token. Then removes the org entries and marks the projects `closed`. The folders are left in place. |

The setup questions: which sandboxes (all, or named); whether production is allowed; the access level; integration user or admin login; whether the CLI may deploy; the sandbox type; whether the contract allows client data to reach Claude.

`sb client start` and `sb client end` are terminal-only, never by link: they are interactive and change protected config.

### 5.5 Protection

The guard blocks the following for every Claude session, in every window:
- Edit and Write, and any shell write, to `%LOCALAPPDATA%\Switchboard\`.
- Any `sb client`, `sb org` or `sb project` subcommand except `show` and `verify`.
- `install.ps1`.
- `clip release`.

## 6. Phase 0 — blocking fixes, module boundaries, plan guard (in place, in alfred-v5)

### 6.1 Fixes

| Fix | Where | Design |
|---|---|---|
| Two threads pick the same migration number | `claims.mjs`, `git-push-worktrees.mjs` | `claims.mjs number-migration <pending-file>` takes the claims lock, lists `supabase/migrations/` in main and in every live worktree, and prints the next free number. It writes nothing. gitpush refuses a `_pending_` file, or a number already in main. |
| `>` inside quotes blocks a read-only command | `shell-parse.mjs` | A quote-aware tokeniser; a redirect only counts outside quotes. |
| `=>` read as a redirect | `shell-parse.mjs` | `=>`, `->` and `>=` are not operators. |
| Script writes missed; heredoc text read as a file | `shell-parse.mjs` | Heredoc bodies are dropped before scanning, and variables are expanded across `;`. `node -e` and `python -c` bodies are scanned for file writes and judged as writes. |
| Duplicate run-tag paste | `tools/claude-sessions/` | The panel remembers the last tag pasted per tile and refuses it again, with a red flash. |
| Main accepts another worktree's prompt | `project-code.mjs`, `prompt-check.mjs` | On main, block when the tag's project code matches a live worktree, even when main is unbound. |
| gitsync opens an editor | `git-sync.mjs` | `git merge --no-edit main`. |
| gitpush log has no time | `git-push-worktrees.mjs` | `Done at YYYY-MM-DD HH:MM:SS`. |
| README has a broken spec link | `tools/claude-sessions/README.md` | Point it at `docs/history/technical-spec-switchboard.md`. |

### 6.2 Plan guard

**The scope block.** Every CLI prompt carries one, right after the `Window:` line:

```
Scope of this step:
- create: <paths or folders> | nothing
- update: <paths or folders> | nothing
- delete: <paths> | nothing
- deploy: <function names, Salesforce components> | nothing
- SQL: <tables> | none
```

**Recording.** The `UserPromptSubmit` hook parses the block and writes it to `.clip/scope.json`, with the run tag. A short follow-up reply ("yes", "go on") keeps the last scope. A new tagged prompt with no block replaces it with an empty scope, and the guard then allows nothing outside `.clip/`.

**Enforcing.** A `PreToolUse` hook (`plan-guard.mjs`, beside the claims guard) refuses, in addition to what claims already refuse:
- **Create:** a Write of a path that does not exist and is not under `create`.
- **Update:** an Edit or Write of an existing path that is not under `update`.
- **Delete:** an `rm`, `del`, `Remove-Item` or `git rm` target that is not under `delete`.
- **Deploy:** `supabase functions deploy <name>`, or `sf project deploy` with a component, that is not under `deploy`.
- **SQL:** a write to a migration or test SQL file that names a table (`create`, `alter`, `insert into`, `update`, `delete from`, `drop`, `truncate`, or `grant ... on`) not under `SQL`.

`.clip/last-report.md` is always allowed. The progress file of the prompt's own project is implied by any non-empty scope.

**Reporting.** Every CLI report ends with two sections, in this order, followed by the timing table:
1. **Scope vs changes.** `node scripts/clip.mjs --scope` compares the block with this run's edits (the plan guard's `in scope:` log lines for the run tag) and `git status` (and, from Phase 3, the deploy and SQL logs). It prints the section; the CLI pastes it into the report, so the pushed and printed reports stay identical. It lists anything changed that was not declared, and anything declared that was not touched. Uncommitted files from earlier steps that this scope does not name go on a separate line, since a worktree carries them until it checkpoints.
2. **Next step's scope.** The proposed scope block for the next step, copied from that step's entry in the progress file. Every step in the progress file carries one. If the step just finished changed the plan, the CLI updates the next step's block in the progress file first, and says so. `clip.mjs` warns if a report has no "Next step's scope" block.

**claude.ai side.** These changes to `.claude/skills/cli-workflow/SKILL.md` are made in Phase 0 (step 0.6) and uploaded to claude.ai by Alex:
- Every CLI prompt carries a scope block, right after the `Window:` line, followed by an `Estimated run: <duration>` line (§7.4). The prompt hook records both.
- Every reply carrying a prompt starts with a plain summary of its scope, and Alex tapping Send (or pasting) is his approval.
- The prompt's scope block starts from the "Next step's scope" in the last report. Claude summarises that block for Alex before writing the prompt, and says where the prompt differs from it.
- When reading a report, Claude checks its "Scope vs changes" section and raises any difference.

### 6.3 Boundaries

- The shell parser is split out of `claims-core.mjs` into `shell-parse.mjs`, with no claims imports. The plan guard uses it too.
- The hooks import only through `scripts/lib/` entry points.
- The bridge files in `extension/` stop importing clipper code.
- Each module gets a header naming its interface.
- A first draft of `INTERFACES.md` goes in `tools/claude-sessions/`.

## 7. Phase 1 — send to CLI and tile states (in place, in alfred-v5)

### 7.1 Send to CLI, by a link in the reply

**The trigger is a link, not a tile.** Every reply that carries a CLI prompt ends with one "Send to CLI" link, directly under the prompt block. Alex reads the reply, does any steps above the prompt, then clicks the link. The tile still shows "Prompt to paste" but sends nothing.

**The link** is `<Alfred base>/send/<run tag>`, for example `https://alfredv5vibe.vercel.app/send/switchboard2-h8r-s15-k2mz`. Its host must be in the settings list (§2, rule 8).

**On the desktop, with the extension:**
1. **Catch.** `claude-watch.js` catches the click (and middle or Ctrl-click) on claude.ai before navigation: a capture-phase listener on the document, for any link whose host is listed and whose path is `/send/<tag>`. Backup: if a `/send/` tab opens anyway, `bridge.js` closes it and handles the send the same way.
2. **Read.** The prompt is read from the code block in the same reply as the link, not from the latest message. Its tag must equal the link's tag, and the reply must be the latest one in the chat that carries a prompt.
3. **Check** (from 1.1): a whole prompt, header to closing tag; not already sent; no other prompt waiting for that project.
4. **Hand over.** `bridge.js` sends a `prompt` frame to the host. The host checks again and writes `prompt-<project>.json`.
5. **Paste.** The panel finds the VS Code window for the tag's project code, with no window found meaning nothing is sent. It never falls back to the active window. It refuses while that tile is Running. Otherwise it focuses Claude Code's input in that window, pastes, submits, restores the clipboard, and deletes the file. A refusal turns the tile red "Not sent" with the reason, until tapped.
6. **On arrival** the prompt hook and plan guard run as for a typed prompt, so a wrong-window or duplicate tag is still refused there.

**Without the extension** (phone, another browser), the link opens a small Alfred page, the app route `/send/:runTag`. It shows the tag and says to send it from the desktop. It reads no data and needs no sign-in. Phase 8 may queue it instead.

**What changes from 1.1.** The checks and the host's prompt file stay. Three things change:
- The trigger moves from the panel's `sendprompt` command to the extension: a `prompt` frame instead of a `result` to a pending command.
- The prompt comes from the clicked reply, not the latest message.
- The project is taken from the tag and checked by the panel against a live window, instead of being named by the panel's command.

The `sendprompt` command path is removed in 1.2.

**The host list** lives in the panel's settings (`%APPDATA%\claude-sessions\settings.ini`, `[links] hosts=`, comma-separated) until Phase 3 moves it to `config\`. The host reads it and sends it in its `hello` frame, because the extension cannot read local files. With no host connected the link simply opens the Alfred page.

### 7.2 Tile states

Each project tile shows one of five states. The colours keep the meanings of today's tiles where they match.

| State | When | Colour (light) | Text |
|---|---|---|---|
| Running | The CLI is working. It warms toward orange as the estimate runs out (§7.5). | green `#2E7D32` (today's "CLI working") | white |
| Report unread | The CLI finished and the report's Alfred inbox item is not archived. It clears on archive, however the report was fetched (a tap, or Alex typing "cli"). | orange `#F57C00` (today's "Send cli") | `#1A1200` |
| Prompt to paste | A chat reply carries a run tag the CLI has not received. Display only: sending is the reply's link (§7.1). | purple `#7E57C2` (today's "Paste prompt") | white |
| Talking | The CLI is idle, its last report is handled, and Alex and Claude are working in the chat. | slate blue `#4A6FA5` | white |
| Waiting on SQL | A queued SQL item for this project awaits a click (Phase 2). | Alfred light tan `#E4D2C3` (`--secondary`) | `#2A2520` |

- **Precedence:** Waiting on SQL, then Prompt to paste, then Report unread, then Running, then Talking.
- **Unchanged:** red (Approve, Wrong window, Check CLI) keeps priority over all five, and the free, closed and paused states stay as they are.
- **Outside scope (red, new).** When the plan guard refuses an action, the tile turns red "Outside scope" and stays red until tapped, like "Already pasted". Without it the refusal shows only inside the CLI's reply, which Alex does not read. The plan guard writes the session status as `wrong` with event `outside scope` and the refused path or deploy target, the same way the prompt hook writes "Already pasted"; a tap clears it. It ranks with the other reds.
- **Dark mode:** each colour gets a dark-theme variant in `switchboard.html`.
- **"Report unread"** needs interface 3 (§4). The clip push already returns the inbox id, and `.clip/last-report.json` stores it.

### 7.3 Panel items

- Instant colour feedback when a Send link is clicked: green at once, red if the send is refused.
- Tiles ordered by lane: Fast track, Main, Side road, Country road.
- A finished run needs no new signal: Alex's existing sound hook (`Notification`) already plays one.

### 7.4 Estimated run duration

**In the prompt.** Each CLI prompt carries one line, right after the scope block: `Estimated run: 2m30s`. Claude writes it, starting from the project's past steps. It is part of the cli-workflow skill change in step 0.6.

**Recording.** The `UserPromptSubmit` hook records the estimate, with the run tag and `prompt_at`, beside the scope in `.clip/scope.json`. The panel reads it from there.

**On the tile.** The Running state shows elapsed time against the estimate, as text: `0:30 / 2:30`. With no estimate it shows elapsed time only: `0:30`.

**Calibration.** `clip.mjs` reads the Total row of the report's timing table, which every report already carries. It prints one line for the CLI to paste into the report (as `--scope` does, so the pushed and printed reports stay identical), `Estimate vs actual: 2m30s vs 3m10s (+27%)`, and appends `{ project, run_tag, estimate, actual }` to `.clip/estimates.jsonl`. Claude can then see how far off its estimates run, per project, from the reports alone.

### 7.5 Running colours by time left

While Running, the tile warms from green toward orange as the estimate runs out. When the report arrives it lands on the orange "Report unread".

| Time left | Light | Dark theme | Text |
|---|---|---|---|
| More than 5 minutes | green `#2E7D32` | `#256B29` | white |
| 5 to 2 minutes | olive `#9E9D24` | `#8A8A1E` | `#1A1600` |
| Under 2 minutes | amber `#F9A825` | `#E59A10` | `#1A1600` |
| Past the estimate | amber `#F9A825`, plus a 6px red inset edge `#C62828` | `#E59A10`, with edge `#FF8A80` | `#1A1600` |
| Report arrived | orange `#F57C00` (Report unread) | — | `#1A1600` |

- **The overrun look is off the scale.** It is the colour itself that warns: the amber stays, and the red edge is added. The text shows the overrun as well: `3:15 / 2:30`.
- **With no estimate,** the tile stays green the whole run.
- **No clash with yellow.** Amber `#F9A825` is close to today's "Your turn" yellow `#FBC02D`, but that state is replaced by Talking (slate blue) in this phase, so the two never appear together.

### 7.6 Progress strip (experimental)

- **The strip.** A thin bar, 8px tall, along the bottom edge of a Running tile. It fills left to right as elapsed time divided by the estimate, and stops at full.
- **Colour.** It is white at 60% opacity on the tile's colour, and turns red (`#C62828`) once the run passes its estimate.
- **No estimate, no strip.**
- **Setting.** `progressStrip` (on or off, default on) lives in the panel's settings file. It can be switched from the status menu without a restart.

### 7.7 Layout for six projects

Tiles are designed for at most 6 projects, not 9.

- **Grid.** The tile area is a 3 × 2 grid that fills the space between the top bar and the bottom of the window. Each row is (area height − one gap) ÷ 2, about 1.5 times today's 3 × 3 tiles.
- **Larger type.** Name, action and meta text scale by 1.3 (`--nameSize`, `--actSize`, `--metaSize`). The kind icons and the strip scale with them.
- **A seventh project** goes on a second page, which the existing scroll-snap and arrows already handle. The panel shows a "7+" hint on the down arrow.
- **Fit tables.** The bottom-line width table in `status.ahk` (today: 219px, 184px and 167px for 26px Atkinson Bold) is re-measured for the new tile width and font size.

## 8. Phase 2 — SQL approval queue and read-only Supabase queries (in place, in alfred-v5)

### 8.1 Queue, links and click pages

**Tables.**
- `switchboard_actions`: one queue for every kind of action (`sql`, `git`, `sf_deploy`, `sf_test`, `sf_read_prod_data`, `docs`). Columns: `id`, `kind`, `project_code`, `chat_url`, `payload`, `fingerprint` (sha256 of the normalised payload), `status`, `link_hash`, `link_expires_at`, `link_used_at`, `created_by`, `needs_click`, `headline`.
- `switchboard_runs`: one row per dry run or real run. Columns: `action_id`, `mode`, `summary`, `result`, `result_pruned_at`, `started_at`, `finished_at`.

Both tables have row-level security: Alex's user only. Neither gets any anon grant.

**Flow.**
1. **Queue.** The CLI queues SQL with its own key, which can only insert `kind = 'sql'` rows.
2. **Review.** Claude reviews the SQL in the chat.
3. **Issue.** Claude calls `issue_switchboard_link(action_id)`. It returns a URL with a random token, stores only the token's hash, binds the link to the fingerprint, and expires it in 30 minutes. The URL's base address is a server setting, never code. The extension and the panel recognise it by path on the hosts in the same list as the Send links (§2, rule 8).
4. **Click.** Alex clicks in the same chat tab, and the extension checks two things:
   - the tab's address equals `chat_url`. Switchboard records that address when it maps the run tag to the chat.
   - as a second check, the tab's title contains the project code.

   If either check fails, nothing runs.
5. **Approve page.** It requires Alex's Alfred login. It shows the headline, the SQL, and a **Dry run** button. A dry run runs the SQL in a transaction, reports what would change ("deletes 3 rows from wb_rules"), and rolls back. **Approve** runs it for real.
6. **Consume.** The link is single-use, consumed with an atomic `update ... where link_used_at is null and fingerprint = $1`.
7. **Result.** The extension posts `sql <run id>` into the same tab once the chat is idle. Claude fetches the result with `get_switchboard_run`. Approving from the phone just opens the Alfred page.

**Headlines.** Every click page leads with one plain line in capitals, saying what happens. The headline is built by the server from the action's kind and payload, never written by Claude. Examples:
- `THIS CHANGES THE LIVE ALFRED DATABASE: DELETES ROWS FROM WB_RULES`
- `THIS PUSHES TO MAIN AND MAKES IT LIVE IN PRODUCTION`
- `THIS DEPLOYS TO SANDBOX ACME-UAT AND DELETES FIELD Account.Old__c`

**Runner.** `switchboard-runner` connects with `SUPABASE_DB_URL` and is the only code that does.
- **Up front, it flags:**
  - statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CREATE DATABASE`),
  - statement kinds that may exceed the time limit (index builds, `UPDATE` or `DELETE` without a `WHERE`, table rewrites).

  Both send the item to the SQL editor instead.
- **Every approved write** runs in one transaction, then runs `check_platform_conformance` and records the run in `switchboard_runs`. Nothing is written to Supabase's own migration history table. Migration files stay in git.
- **Pruning:** a pg_cron job clears `result` after 30 days; the run rows stay.

**Panel.** A project with a waiting SQL item shows Waiting on SQL (§7.2).

### 8.2 Claude's read-only Supabase queries

MCP tool `switchboard_query(sql)`, which calls `switchboard_readonly_query`. It runs as role `claude_reader`:
- **Access:** usage on `public` only. Select on every `public` table except a deny list of token and secret tables, kept in the migration. No other schema is granted.
- **Transaction:** read-only, one statement only. A `;` outside quotes, or more than one parsed statement, is refused.
- **Limits:** 1000-row cap, `statement_timeout` 10s, `lock_timeout` 1s.
- **Budget:** `check_call_budget` is called twice, once for 20 queries per 600 seconds and once for 200 per 86400 seconds, with no change to the function.
- **Kill switch:** `switchboard_settings.reads_enabled`.
- **Log:** every call goes to `switchboard_read_log`.

## 9. Phase 3 — multi-repo and clients (the move)

1. **Switchboard repo and install** (§5.1). Moves everything in §4, including the Phase 1 and 2 work, with history kept (Alex chooses `git subtree split` or a copy). alfred-v5 keeps working throughout: old `scripts/*.mjs` paths become one-line shims that call the installed copy, until the cutover step deletes them.
2. **User-level hooks.** Registered in `~/.claude/settings.json`; they do nothing in a repo with no `repos.json` entry. The project hooks in `.claude/settings.local.json` are removed in the same step. `CLAUDE.md` and the claude.ai cli-workflow skill change the same day.
3. **Repo settings and project list** (§5.2), read by every command; the project code finds the folder. The prompt check uses `projects.json` to know which window owns which code.
4. **`sb` commands** (§5.4) and their protection (§5.5).
5. **Finish modes.** `pr` pushes the branch and runs `gh pr create`; `local-commit` commits only; `merge` is the alfred-v5 behaviour today.
6. **Salesforce guard,** in every window:
   - **Blocked:** `sf data *`, `sf apex run` (anonymous Apex), `sf api request *`, `sf apex tail log`, legacy `sfdx force:data:*` and `force:apex:execute`, and any command whose target org is production.
   - **Production is decided by asking Salesforce:** `sf org display --json` must return `isSandbox: true`, and the `orgId` must match an entry listed for this repo. The result is cached for 10 minutes per alias. The alias name is never trusted.
   - **Sandbox deploys and tests** run only through the deploy wrapper (§9.7). A bare `sf project deploy` or `sf apex run test` is blocked.
7. **Sandbox deploy wrapper** (`sb deploy <alias>`, `sb test <alias>`):
   - **Own files only.** The manifest is built from this thread's claimed files that differ from the thread's base commit, never from a whole source folder. Every worktree holds old copies of other threads' files, and a folder deploy would overwrite their work in a shared sandbox. Deleted components go into `destructiveChanges.xml`, which is a click-tier change.
   - **Short sandbox lock.** The wrapper claims `sf:deploy:<alias>` for the length of the deploy or test run, and releases it in a `finally`. A stale lock (dead process, over 30 minutes) is broken by `status`. Two threads never deploy or test the same sandbox at once; otherwise both keep working.
   - **Own tests only.** `--test-level RunSpecifiedTests` with the project's test classes (`projects.json`, plus any claimed `*Test.cls`). Never `RunLocalTests` or `RunAllTestsInOrg`.
   - **Retrieve and compare.** Before each deploy, retrieve the same components from the sandbox and compare them with the thread's base commit. If the sandbox differs from the base, someone changed it through the screens. The wrapper stops, shows the diff, and needs a click to overwrite.
   - **What may change, by tier:**

     | Tier | Metadata | Route |
     |---|---|---|
     | No click | ApexClass; new CustomObject and CustomField; CustomMetadata records; PermissionSet with object and field access only; Flow other than an active record-triggered flow; and, in developer and developer pro sandboxes only, ApexTrigger and active record-triggered Flow | CLI, when `cliMayDeploy` is on |
     | Click, warning | ApexTrigger and active record-triggered Flow in partial and full sandboxes (they can change real records) | link (Phase 5) |
     | Click, warning | PermissionSet that adds any system permission (for example Modify All Data, View All Data, Manage Users, Author Apex) | link (Phase 5) |
     | Click, warning | Deleting a field, or changing a field's type | link (Phase 5) |
     | Click, warning | Profile, Role, Group (public groups), SharingRules | link (Phase 5) |
     | Click, warning | Org settings (`Settings` types such as Security and Session), and organization-wide defaults | link (Phase 5) |
     | Blocked | Anything, on production | never |

     **How the tier is decided:**
     - **Types and field types:** from the manifest's types, and from a field diff against the retrieved version.
     - **System permissions:** a permission set's added system permissions come from a diff of its `userPermissions` against the retrieved version.
     - **Active record-triggered flows:** a Flow counts as one when its `processType` is `AutoLaunchedFlow`, its `start` has a `triggerType` of `RecordBeforeSave`, `RecordAfterSave` or `RecordBeforeDelete`, and its status is `Active`.
     - **Sandbox type is asked of Salesforce, never taken from the alias or from `orgs.json`.** A sandbox cannot report its own licence type, so the wrapper reads `/limits` and uses `DataStorageMB`: 200 MB is developer, 1 GB is developer pro, anything larger is partial or full. If the answer is missing or disagrees with `orgs.json`, the sandbox is treated as partial or full.
     - **Mixed manifests:** a manifest with any click-tier item is all click-tier.
     - **Unknown types:** a type not in the table is click-tier.
   - **Before Phase 5 exists,** click-tier deploys are refused in the CLI with the reason, and Alex runs them by hand.
8. **PII check in `clip.mjs`.** Before sending, it scans for:
   - emails;
   - phone numbers, with 10 or more digits and separators, ignoring ISO timestamps and run ids;
   - card-like numbers, 13 to 19 digits that pass a Luhn check.

   A hit holds the report in `.clip/held/<id>.md`; `clip release <id>` sends it (Alex only). It warns in alfred-v5 and holds in client repos.
9. **Salesforce-workflow rules folded in.** `salesforce/RULES.md` is quoted into the cli-workflow skill and enforced by the guard and the wrapper where they can be.
10. **Sandbox types** are recorded in `orgs.json`. Partial and full sandboxes are treated as holding real records.

## 10. Phase 4 — Salesforce reads (read-only, always)

**Route.**
1. Claude calls `sf_read`, which queues a `switchboard_actions` row.
2. The desktop helper, `salesforce/helper`, polls with its pickup key and runs the query.
3. It posts the result back, and Claude fetches it.

The helper is the only route.

**The helper.**
- **What it sends:** HTTP GET only, to a fixed list of endpoints (`/query`, `/sobjects`, `/sobjects/X/describe`). There is no write code path.
- **Before every query:** it reads `/sobjects/Organization` (Id, IsSandbox) and refuses on a mismatch with the entry.
- **Parsing:** SOQL is parsed with `soql-parser-js`, and every object and field is checked against the level.
  - Below `data`, Claude does not write SOQL. It names an object and filters, and the filters may use only allowed fields, with no subqueries and no relationship fields.
  - Anything that does not parse fully is refused.

**Access levels.**
- **`objects`**: the object list.
- **`metadata`**: adds describes.
- **`ids`**: adds Id, CreatedDate and LastModifiedDate.
- **`data`**: adds all fields. It also requires `contractAllowsClaude`: each client's contract must allow its data to reach Claude before full data is turned on for that client.

**Full-data results pass through Supabase.**
- Each result is encrypted with its own random key. The key goes back to Claude in the tool response; the ciphertext is stored in `switchboard_runs.result`.
- The row is hard-deleted when fetched, and a pg_cron purge deletes anything older than 10 minutes.
- The run log keeps the query and the row count only.
- Production full data needs an approval link every time, and the helper stamps each result `PRODUCTION FULL DATA`.

**Limits.** The same row cap, timeout, budget, kill switch (`sf_reads_enabled`) and logging as §8.2.

## 11. Phase 5 — git commands and Salesforce actions by link

### 11.1 Click rules

| Action | Click | Why |
|---|---|---|
| `gitcom` | no | Its own worktree, claimed files only |
| `gitsync` | no | Its own worktree only |
| `sb deploy`, `sb test` (no-click tier, `cliMayDeploy` on) | no | Its own claimed files, one sandbox, under the lock |
| `sb deploy` (click tier, or `cliMayDeploy` off) | yes, with a warning | Shared or risky metadata |
| `gitpush` Push, Checkpoint, Finish | yes, always | Touches main; never automatic |
| `gitnewtree` | yes | Creates a worktree from `origin/main` |

A no-click action is still issued by Claude one at a time, and logged. It simply runs when the helper picks it up.

### 11.2 The allowlist

**Allowed:** `gitpush`, `gitsync`, `gitcom`, `gitnewtree`, `sb deploy` and `sb test`, with checked arguments. The folder is chosen from the project code.

**Refused:**
- `sb client start` and `sb client end`, which are terminal-only (§5.4).
- Known traps, for example Finish while that worktree's window is open.
- Anything on production.

The helper runs approved actions in a visible terminal.

## 12. Phase 6 — spec files and archiving

Claude's spec and progress text is written into the project's `docsDir` by link: a `docs` action whose payload is the file contents and whose fingerprint is checked. Finish moves the project's docs to `docs/history/`.

## 13. Phase 7 — npm start per tile

Each tile gets a fixed port from `projects.json`. "Start" runs `npm start` in that checkout with `PORT` set, and the localhost tab opened from the tile is bound to it.

## 14. Phase 8 — remote devices

- **The desktop is the only machine with code, git and the panel.** The Chromebook uses VS Code Remote Tunnels (already working to desktop-67ia3s7).
- **Approvals from any device.** Every approval goes through Alfred; the helper picks up approved actions, so a click from any device works, and the Alfred login is required.
- **Home network.** The desktop serves the touch page on the home network. Local testing uses the desktop's network address and the tile's port.
- **Send to CLI from the Chromebook** is by hand at first.
- **After the nightly reboots,** the tunnel, the panel and the helper start at login via a scheduled task.

## 15. Security summary

| Threat | Control |
|---|---|
| Link leaked or replayed | single use, 30 minutes, token stored only as a hash, bound to the fingerprint, Alfred login required |
| SQL changed after review | fingerprint check at consume time |
| Wrong chat | `chat_url` match, then a title check |
| A step does more than declared | the plan guard (§6.2), plus the scope-versus-changes section in the report |
| Claude loosens its own limits | the installed copy and config are protected; `sb` mutations are blocked |
| Click page misleads | the headline is written by the server from the payload, never by Claude |
| Salesforce writes | GET-only helper, CLI guard, no data commands |
| Shared sandbox clobbered | own-files manifest, sandbox lock, retrieve and compare |
| Production | `isSandbox` from Salesforce, never from the alias; no production deploys at all |
| Client data in Alfred | PII hold; Apex failures summarised; full data encrypted, in transit only, deleted on fetch |
| Read query abuse | read-only role, schema allowlist, caps, budget, kill switch, log |

## 16. Open questions

- **The token deny list for `claude_reader`.** It is drafted from the schema at the migration step, and Alex reviews it.
- **Moving history.** Alex chooses `subtree split` or a plain copy at the Phase 3 move.
- **Sandbox type from `/limits`** is a heuristic. Salesforce gives the exact licence type only from production (`SandboxInfo`), and production is never queried. The fallback is the stricter tier.
- **SQL-table detection** in the plan guard is a regex over the SQL file. A table named only inside dynamic SQL (`execute format(...)`) is not seen, and the runner's dry-run summary is the backstop.
