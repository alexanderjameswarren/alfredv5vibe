# Switchboard 2.0 — technical spec

Project code: `switchboard2-h8r`
Progress: `docs/progress-switchboard2-h8r.md`
Plan: run tag `switchboard2-h8r-s1-q7m3`; decisions: `-s2-n4vd` and `-s3-w8ke`. Phase 3 onward: `-s48-k3vq`; decisions: `-s49-p7wd`.

## 1. Goal and non-goals

**Goal.** Replace copy and paste between claude.ai, VS Code, Supabase and Downloads with single-use approval links that Claude issues. Alex stays the man in the middle; claude.ai stays the orchestrator, one action at a time. The tooling serves client Salesforce repos as well as alfred-v5.

**Non-goals.**
- No autonomous chains: Claude never issues a second link before the first one's result is back.
- No production Salesforce deploys or changes, by CLI or by link, ever.
- No Salesforce record writes, by any route.
- Client data is not kept in Alfred. Code is fine.
- No automatic posting of "cli" into the chat (parked as a separate idea).

## 2. Rules for every phase

1. **One action at a time, per thread.** One approval link, then wait for its result, the same as CLI prompts. Different project codes may each have a live link at once (s49).
2. **Deny by default.** An unlisted org, repo, setting or command runs nothing.
3. **Only Alex changes the rules.** Claude sessions may not edit, or run commands that change, the org settings, the project list or the installed helper code (§5.4).
4. **Client data stays out of Alfred.** It is a rule in CLI prompts, and `clip.mjs` enforces it (§9.8). In client repos, Apex test failures are summarised, never pasted. Salesforce full-data results pass through Supabase in transit only (§10), and the spec says so plainly.
5. **Every run is logged.** Each SQL write, read query, Salesforce read, git action and deploy gets a `switchboard_runs` row.
6. **Every prompt declares its scope.** Each prompt carries a scope block, and the plan guard enforces it (§6.2).
7. **Clicks.** An action runs without a click only if it touches nothing but its own thread's worktree and claimed files (§11.1). Anything that touches main always needs a click and is never automatic. Every click page leads with one plain line in capitals saying what happens (§8.1).
8. **Alfred's address is a setting.** The extension and the panel recognise an Alfred link by its path (`/send/<run tag>`, and Phase 2's approval paths) on any host in a list kept in Switchboard's settings, never in code. Today the list is `alfredv5vibe.vercel.app`. A move to another domain adds a host, and old hosts stay listed so old links keep working. The manifest names no Alfred host: Alex allows the listed hosts once, from "Allow Alfred's sites" on the toolbar icon's right-click menu, and the icon says so while one isn't allowed. The cli-workflow skill writes links from one base-address line.

## 3. Phase order and dependencies

**Order of the remaining work (s48, s49).** First, the tile fixes (§7.2, §8.1). Then Phase 3. Then the git half of Phase 5. Then Phase 4. Then the Salesforce half of Phase 5. Then Phases 6 to 8. Alex has real client work waiting, so Phase 3 is ordered to reach a first client as early as its dependencies allow.

| # | Phase | Built in | Depends on |
|---|---|---|---|
| 0 | Blocking fixes, module boundaries, plan guard | alfred-v5 | — |
| 1 | Send to CLI, tile states, run estimates, six-tile layout | alfred-v5 | 0 |
| 2 | SQL approval queue, and Claude's read-only Supabase queries | alfred-v5 | 0, 1 (posting back into the tab, and the tile states) |
| 3 | Multi-repo and clients: the move, settings, client commands, Salesforce guard and sandbox deploys | Switchboard repo | 0-2 (it moves everything they built) |
| 5, git | Git commands by link; the desktop helper arrives here | Switchboard repo and alfred-v5 | 2 (queue and links), 3 (projects) |
| 4 | Salesforce reads | Switchboard repo and alfred-v5 | 2 (queue), 3 (org settings), 5 git (the helper) |
| 5, Salesforce | Salesforce actions by link | Switchboard repo | 3 (orgs, wrapper), 5 git (the helper) |
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
| Settings | none | `config/` (the loader for §5.1's files) |
| `sb` commands | none | `sb/` |
| Desktop helper | none | `helper/` (git actions; Salesforce actions and reads use it too) |
| Salesforce | none | `salesforce/` (guard rules, deploy wrapper, read code, org commands) |

Alfred keeps the clipper extension, the Supabase migrations and functions, and the approve page. `scripts/sql-queue.mjs` and its library stay in alfred-v5 too, since only Alfred has SQL to queue (s49). So do `schema-snapshot`, `inventory` and `prebuild`, which only alfred-v5 uses.

**Alfred interfaces.** These are the only couplings, and each is documented in `INTERFACES.md`:

1. **Clipboard push.** `CLIPBOARD_URL` plus `CLIPBOARD_SECRET`, and the `clip-capture` function.
2. **Activity.** `overwatch-ingest` (session status and finish summaries).
3. **Panel read** (Phase 2, `switchboard-panel`). The panel reads whether a report's inbox item is archived and each project's lane, using a key that can only read those. Tan no longer comes from it (§8.1, s49).
4. **Action queue** (Phase 2): the `switchboard-runner` function. The CLI uses a queue-only key; the desktop helper uses its own pickup key.
5. **MCP tools** for Claude: issue a link, get a run's result, read-only query, and (Phase 4) Salesforce read.

Each interface has a version string. The panel and the helper refuse to work with a mismatch rather than guess.

## 5. Install, settings, and the commands that manage them

Built in Phase 3, and needed by Phases 4 onward.

### 5.1 Install layout and project list

**The source repo** is `C:\Users\Alex\projects\switchboard\`, a private git repo with its own claims file. Switchboard is developed with Claude in this repo, so the repo is not protected. Its project code is `switchboard_repo-k7m`, a code of its own: two windows under one code would make Send refuse. Work in it is done from a window opened on that repo, never from an alfred-v5 worktree. Prompts are pasted by hand there until the panel reads several repos (§9.3).

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
- **The panel's settings,** including the link host list (§7.1), move here from `%APPDATA%\claude-sessions\settings.ini`.

**Folder layout:**
- One folder per client: `C:\Users\Alex\projects\<client>\`.
- ActBlue has one folder per nonprofit: `...\actblue\<org>\`.
- Worktrees live inside the client folder under `.claude\worktrees\`.
- One-week jobs run in the folder's main checkout.

**Per-repo files Switchboard creates** are kept out of the client's history with `.git/info/exclude`, never `.gitignore`. That covers `.clip/`, and also `.claude/` when the client repo has none of its own. The claims file stays in `.git/`.

### 5.2 Repo settings (`repos.json`)

`mainBranch`, `projectPrefix`, `deployCmd`, `testCmd`, `docsDir`, `finish` (`merge`, `pr`, or `local-commit`; the default is `pr` with a remote and `local-commit` without one), `kind` (`alfred` or `salesforce`), `orgs` (a list of aliases), and three that make gitpush and gitnewtree work outside alfred-v5: `migrationsDir` (none turns off the migration checks), `snapshotCmd` (none turns off the schema snapshot) and `setupCmd` (what gitnewtree runs in a new worktree; alfred-v5's is `node scripts/prebuild.js`).

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
| `sb client start <client> [--org <nonprofit>] [--repo <url>] [--adopt <path>] [--from-sandbox <alias>] [--project <code>]` | Creates the folder. Either clones the repo, or with no repo retrieves the code (`sf project generate manifest --from-org`, then `sf project retrieve start`). Runs `git init` when there is no repo. `--adopt` takes a checkout that already exists instead, such as Team IMPACT's, and changes none of its files or branches. Writes `repos.json`, adds the project to `projects.json`, and runs `sf org login web --alias`. Then asks the setup questions for each org and writes the entry. |
| `sb org add <alias> --client <c>` | Asks the same questions for one more org and logs it in. |
| `sb org set <alias> [--level L] [--sandboxes all\|a,b] [--production on\|off] [--production-full-data on\|off] [--login integration\|admin] [--cli-deploy on\|off] [--contract-ok on\|off] [--type T] [--shared on\|off]` | Changes an entry. Shows a before-and-after diff and asks for a typed yes. |
| `sb org show [<alias>\|--client <c>]` | Read-only. |
| `sb org verify <alias>` | Read-only. Runs `sf org display` and checks the `orgId` and `isSandbox` against the entry. |
| `sb project add\|close\|lane\|tests <code> ...` | Edits the project list. |
| `sb client end <client>` | `sf org logout` for every org of that client, which deletes the stored token. Then removes the org entries and marks the projects `closed`. The folders are left in place. |

The setup questions: which sandboxes (all, or named); whether production is allowed; the access level; integration user or admin login; whether the CLI may deploy; the sandbox type; whether the contract allows client data to reach Claude.

`sb client end` and `sb org set` are terminal-only, never by link. `sb client start` and `sb org add` were terminal-only too. From s86 they can run by link, for sandboxes only and within the limits in §11.5, if Alex agrees (decision D1 there). A Claude session still never runs any `sb` command (§5.5); only the helper does, after his click.

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

**The trigger is a link, not a tile.** Every reply that carries a CLI prompt ends with one "Send to CLI" link, directly under the prompt block. Alex reads the reply, does any steps above the prompt, then clicks the link. The tile shows "Prompt ready" but sends nothing.

**The link** is `<Alfred base>/send/<run tag>`, for example `https://alfredv5vibe.vercel.app/send/switchboard2-h8r-s15-k2mz`. Its host must be in the settings list (§2, rule 8).

**On the desktop, with the extension:**
1. **Catch.** `claude-watch.js` catches the click (and middle or Ctrl-click) on claude.ai before navigation: a capture-phase listener on the document, for any link whose host is listed and whose path is `/send/<tag>`. Backup: if a `/send/` tab opens anyway, `bridge.js` closes it and handles the send the same way.
2. **Read.** The prompt is read from the code block in the same reply as the link, not from the latest message. Its tag must equal the link's tag, and the reply must be the latest one in the chat that carries a prompt.
3. **Check** (from 1.1): a whole prompt, header to closing tag; not already sent; no other prompt waiting for that project.
4. **Hand over.** `bridge.js` sends a `prompt` frame to the host. The host checks again and writes `prompt-<project>.json`.
5. **Paste.** The panel finds the VS Code window for the tag's project code, with no window found meaning nothing is sent. It never falls back to the active window. It refuses while that tile is Running. Otherwise it focuses Claude Code's input in that window, pastes, submits, restores the clipboard, and deletes the file. A refusal turns the tile red "Not sent" with the reason, until tapped.
   - **Focus left in an editor or terminal** (the normal rhythm after a gitsync or gitcom) is not refused outright. The panel presses `[send] focusKey` once (Alex's "Claude Code: Focus input", Ctrl+Shift+Alt+C, bound without the `editorTextFocus` condition), then reads the focused element again through UI Automation. It pastes only if that is now Claude's message input, by the saved name. Otherwise: "Not sent: the focus could not be moved to Claude's input: …". Nothing is typed before that confirmation, and the key is never pressed when the input name is not set up.
6. **On arrival** the prompt hook and plan guard run as for a typed prompt, so a wrong-window or duplicate tag is still refused there.

**Without the extension** (phone, another browser), the link opens a small Alfred page, the app route `/send/:runTag`. It shows the tag and says to send it from the desktop. It reads no data and needs no sign-in. Phase 8 may queue it instead.

**What changes from 1.1.** The checks and the host's prompt file stay. Three things change:
- The trigger moves from the panel's `sendprompt` command to the extension: a `prompt` frame instead of a `result` to a pending command.
- The prompt comes from the clicked reply, not the latest message.
- The project is taken from the tag and checked by the panel against a live window, instead of being named by the panel's command.

The `sendprompt` command path is removed in 1.2.

**The host list** lives in the panel's settings (`%APPDATA%\claude-sessions\settings.ini`, `[links] hosts=`, comma-separated) until Phase 3 moves it to `config\`. The host reads it and sends it in its `hello` frame, because the extension cannot read local files. With no host connected the link simply opens the Alfred page.

### 7.2 Tile states

Each project tile shows one of these states. The colours keep the meanings of today's tiles where they match.

| State | When | Colour (light) | Text |
|---|---|---|---|
| Running | The CLI is working. It pales along one blend as the estimate runs out (§7.5). | blend of `#43A047` into `#C5E1A5`; `#C5E1A5` with no estimate | `#111111` |
| Send cli | The CLI is idle and a report is waiting for Claude: until its inbox item is archived, by `switchboard-panel`'s word. Without a fresh read, a report pushed after the chat last changed. A tap types "cli". The label says what the tap does (briefly "Report ready" in 1.6; restored in s23). | orange `#F57C00` | `#1A1200` |
| Prompt ready | A chat reply carries a run tag the CLI has not received. Display only: sending is the reply's link (§7.1), so nothing is pasted (was "Prompt to paste", and "Paste prompt" before that; renamed in s23c). | purple `#7E57C2` | white |
| Your turn | The CLI is idle, its report is handled, and Claude has finished a reply: Alex's move. It flashes. While Claude writes, the tile is green "Claude writing". | yellow `#FBC02D` (unchanged) | `#1A1600` |
| SQL ready, Git ready, Deploy ready | The chat's latest finished reply holds a live approval link (see below). Replaces "Waiting on SQL" (s49). | Alfred light tan `#E4D2C3` (`--secondary`) | `#2A2520` |
| SQL running, Git running, Deploy running | Alex approved and the action is running. | the short green `#C5E1A5` / `#AED581` | `#111111` |

- **Precedence:** the reds; then, while the chat has finished and the CLI is idle, the Running and Ready pair above; then Prompt ready, Send cli, Running, Claude writing, Your turn.
- **An approval link, by what is in the chat (s49).** The chat alone decides. The database never delays tan, and a queued action shows nothing. The steps match the Send link:
  1. **Live link in the chat's latest finished reply:** tan, "SQL ready", "Git ready" or "Deploy ready". The kind and expiry travel in the link, written by the server (§8.1). Past its expiry, the link no longer counts.
  2. **Clicked:** the link's text in the chat changes to "Sending…", then "Sent ✓" once the approve page has opened. The tile stays tan, because Approve is still Alex's move.
  3. **Approved and running:** light green, "SQL running", "Git running" or "Deploy running". The tile stays that colour and never flashes.
  4. **Result posted and Claude answering:** the usual green "Claude writing", at once, since a post starts a new turn.
  5. **The page can't post the result into the chat:** red, "SQL not posted", "Git not posted" or "Deploy not posted", until the line is posted or the tile is tapped.
- **A link used from another device** isn't seen by the chat, so that tile stays tan until the link expires, at most 30 minutes (accepted in s49).
- **Unchanged:** red (Approve, Wrong window, Check CLI) keeps priority over all of these, and the free, closed and paused states stay as they are.
- **Outside scope (red, new).** When the plan guard refuses an action, the tile turns red "Outside scope" and stays red until tapped, like "Already pasted". Without it the refusal shows only inside the CLI's reply, which Alex does not read. The plan guard writes a latched `outside_scope` field (the refused path or deploy target) into the session status; it survives the Stop hook's rewrite to waiting, and a tap clears it. It ranks with the other reds.
- **Dark mode:** each colour gets a dark-theme variant in `switchboard.html`.
- **Report unread (built in 2.8 and 2.9).** Orange clears only when the report's Alfred inbox item is archived, however it was fetched. The panel reads this from `switchboard-panel` every 15 seconds, and a read older than 5 minutes isn't believed.
- **Talking (dropped).** Step 1.6 briefly replaced Your turn with a slate blue "Talking" that did not flash. It lost the "Claude is waiting on you" alert, so s19c restored Your turn.
- **A closed chat gives way (s49).** A saved chat link whose tab is gone gives way to the open chat that issued the project's newest run tag, so a later chat under the same code joins the CLI's tile rather than showing as a tile of its own. A stale chat list changes nothing, and with no such chat the saved link stays.

### 7.3 Panel items

- Instant colour feedback when a Send link is clicked: green at once, red if the send is refused.
- **Tile order:** the main checkout's tile is always first, even with a lane of its own. Then `lane_order` from `switchboard-panel` (2.8, 2.9), then everything else in today's order, so a colour change never moves a tile.
- A finished run needs no new signal: Alex's existing sound hook (`Notification`) already plays one.

### 7.4 Estimated run duration

**In the prompt.** Each CLI prompt carries one line, right after the scope block: `Estimated run: 2m30s`. Claude writes it, starting from the project's past steps. It is part of the cli-workflow skill change in step 0.6.

**Recording.** The `UserPromptSubmit` hook records the estimate, with the run tag and `prompt_at`, beside the scope in `.clip/scope.json`. The panel reads it from there.

**On the tile.** The Running state shows elapsed time against the estimate, as text: `0:30 / 2:30`. With no estimate it shows elapsed time only: `0:30`. Digits are tabular, so a ticking timer never rewraps. The timer never breaks inside itself (non-breaking spaces), except that when elapsed and estimate together have more than 8 digits it breaks at the slash, with `/ 1:00:00` on the next line.

**Calibration.** `node scripts/clip.mjs --estimate .clip/last-report.md`, run once the timing table is written, reads the Total row of the report's timing table, which every report already carries. It prints one line for the CLI to paste into the report (as `--scope` does, so the pushed and printed reports stay identical), `Estimate vs actual: 2m30s vs 3m10s (+27%)`, and appends `{ project, run_tag, estimate, actual }` to `.clip/estimates.jsonl`. Claude can then see how far off its estimates run, per project, from the reports alone.

### 7.5 Running colours by time left

While Running, the tile stays green, because green means Claude is working, and pales gradually as the estimate runs out. There are no jumps: sharp changes are kept for states that need Alex (Your turn, Send cli, the reds). When the report arrives it lands on the orange "Send cli".

| Point in the run | Light | Dark theme | Text (light / dark) |
|---|---|---|---|
| Start | `#43A047` | `#388E3C` | `#111111`, 5.7:1 / 4.6:1 |
| Start to a minute before the estimate | a straight sRGB blend, by elapsed ÷ (estimate − 1 minute) | the same blend | rises with the blend |
| A minute before the estimate, to the estimate | `#C5E1A5` | `#AED581` | `#111111`, 13.2:1 / 11.4:1 |
| Past the estimate | `#C5E1A5`, plus a 6px red inset edge `#C62828` | `#AED581`, same edge | as above |
| Report arrived | orange `#F57C00` (Send cli) | — | `#1A1600` |

- **How it is drawn.** AutoHotkey sends `blend` (0-100) with each tile, every tick. The touch page mixes `--gLong` into `--gShort` with `color-mix(in srgb, …)`, so each theme blends its own pair. The old panel computes the same blend (`BlendHex`) at its refresh rate. Every channel rises along both blends, so the text contrast only improves after the start; a test checks it at every 10%.
- **Short estimates.** An estimate of one minute or less is `#C5E1A5` from the start, and still turns overrun once it is passed.

- **The overrun look is off the scale.** The short shade stays and the red edge is added. The text shows the overrun as well: `3:15 / 2:30`. The edge is `#C62828` in both themes: the dark theme's old `#FF8A80` barely shows on a pale green.
- **With no estimate,** the tile is the short shade `#C5E1A5` / `#AED581` with `#111111` text the whole run (s23; it was `#2E7D32` with white).
- **Claude writing** (on chat tiles and project tiles: "Claude writing", "Chat writing", "Writing") uses the short shade `#C5E1A5` / `#AED581` with black text, since chat replies are usually short. It never flashes or alerts.
- **Greens, not olive and ochre (decided in s22, replacing 1.7).** Ochre was too dark to read, and a warm colour said "stop" while Claude was still working. **A blend, not three bands (s23b):** s22's bands at 5 and 2 minutes left (`#8BC34A` in between) jumped, and the jumps were distracting.

### 7.6 Progress strip (experimental)

- **The strip.** A thin bar, 10px tall (7.7), along the bottom edge of a Running tile. It fills left to right as elapsed time divided by the estimate, and stops at full.
- **Track.** Behind the fill, a faint full-width track, `#111111` at 18%, so it reads as a progress bar from the first second. The track shows only when the strip does.
- **Colour.** Near-black `#111111` at 70% opacity, so it shows along the whole blend: 3.7:1 at the start rising to 6.0:1 in light, 3.2:1 or more in dark. White would vanish on the pale greens. It turns red (`#C62828`, 3.9:1 / 3.4:1 on the short shade) once the run passes its estimate.
- **No estimate, no strip.** Nor on Claude writing, a paused tile or another run's estimate.
- **Setting.** `progressstrip` (1 or 0, default 1) in `[panel]` of the panel's settings.ini. "Progress strip" on the tray menu and on a tile's right-click menu (main screen mode, and the old panel) switches it at once, with no restart.
- **Touch page only.** The old panel's buttons have no strip.

### 7.7 Layout

Two sizes, chosen by the number of tiles, chats and orphans included (`TileRows`, sent to the page as `rows`).

- **Up to 6 tiles: 3 × 2.** The grid fills the space between the top bar and the bottom of the window; each row is (area height − one gap) ÷ 2. Name 39px and action 34px, meta 30px, not 34px: at 34px the deadlock and padlock lines ("⇄ restructure p1", "restructure p1") would be cut off. The kind icons scale with the meta text, and the strip is 10px.
- **7 tiles or more: 3 × 3 (2.9c),** so 9 fit before scrolling. Name 30px, action 26px, meta 26px. The timer's own line break is dropped, and a tile whose action still takes two lines shows its name on one line, with "…".
- **Decided (s46):** 3 × 2 keeps long names as they are, so a two-line name with "Both working" and an estimate stays cut.
- **More tiles than fit** go on the next page, which scroll-snap and the arrows handle. The down arrow shows the number of the next page's first tile ("7+", or "10+" at 3 × 3) instead of "N more".
- **Fit tables,** for the 30px meta line; at 26px there is more room, so they are on the safe side. The tile width is unchanged (3 columns, 260px inside), so only the type size matters. `TileTextWidth` keeps its 26px advance widths; `TileInfoWidth` scales the room by 26/30: 225 with no icon, 197 beside the padlock, 185 beside the terminal (was 260, 231, 219). Still fit: "⇄ restructure p1", "s11 · Blocking 1", and project names beside the padlock. No longer fit: "1 held · Blocking 1" (cut off with "…"), and a holder's git counts beside "s3 · Blocking 1" (dropped, as before when there is no room).

## 8. Phase 2 — SQL approval queue and read-only Supabase queries (in place, in alfred-v5)

### 8.1 Queue, links and click pages

**Tables.**
- `switchboard_actions`: one queue for every kind of action (`sql`, `git`, `sf_deploy`, `sf_test`, `sf_read_prod_data`, `docs`). Columns: `id`, `kind`, `project_code`, `payload`, `fingerprint` (sha256 of the normalised payload), `status`, `link_hash`, `link_expires_at`, `link_used_at`, `created_by`, `needs_click`, `headline`.
- `switchboard_runs`: one row per dry run or real run. Columns: `action_id`, `mode`, `summary`, `result`, `result_pruned_at`, `started_at`, `finished_at`.

Both tables have row-level security: Alex's user only. Neither gets any anon grant.

**Flow.**
1. **Queue.** The CLI queues SQL with its own key, which can only insert `kind = 'sql'` rows. `--describe` is required: one plain sentence saying what the SQL does, stored as `payload.description`, which never changes after insert. `--expect` is required when there are inserts, updates or deletes: one value for each, in order, either a row count or `unknown`, stored as `payload.expected`. Schema changes need none. A do block has no count to give, so what it changes inside isn't compared. `--test` stores `payload.test` and takes no `--expect`.
2. **Review.** Claude reviews the SQL in the chat.
3. **Issue.** Claude calls `issue_switchboard_link(action_id)`. It returns a URL with a random token, stores only the token's hash, binds the link to the fingerprint, and expires it in 30 minutes. One link may be live per project code; another project's live link doesn't stop it (s49). The URL's base address is a server setting, never code. The URL ends `?kind=<kind>&exp=<unix seconds>`, written by the server, so the chat alone can tell the tile what the link is and when it ends (§7.2). The token alone proves anything; these two only drive the display. The extension and the panel recognise it by path on the hosts in the same list as the Send links (§2, rule 8).
4. **Click.** Alex clicks in the chat tab. The extension remembers that tab for the link's token, and the link opens as usual. A link opened elsewhere, such as on the phone, has no remembered tab: the result then goes to the one chat whose latest reply issued the project's run tag, or else the one whose title contains the project code, and two matches post nothing. `chat_url` is dropped: the extension can't write it, and Alex's login plus the single-use link are what keep the SQL safe.
5. **Approve page.** It requires Alex's Alfred login. It shows the headline, the description, then the SQL, and runs the dry run by itself when it opens. A dry run runs the SQL in a transaction, reports what would change ("deletes 3 rows from wb_rules"), lists the rows per statement, and rolls back. **Approve** runs it for real; every action needs a dry run, selects included, and it's the latest dry run that must be clean. If a count differs from `--expect`, that dry run isn't clean: Approve is disabled and the page shows expected against actual. The real run isn't compared, because it has already committed; a difference there is only reported.
   - **Don't run** takes an optional one-line reason, spends the link, marks the action `cancelled` and notes the reason on the latest dry run.
   - **Copy details** sits beside any error or mismatch and copies the action id, the dry-run id, the problem and the counts.
   - **A test action** (`--test`) runs once by itself, undone, shows its result and never offers Approve; the runner refuses Approve too. Its run is a `dry_run` row, and the action ends `succeeded` or `failed`, spending the link. A busy runner leaves the link usable.
   - **While a real or test run is under way,** the page says so in a data attribute for the extension (`data-switchboard-running`, with the kind), which drives the tile's "SQL running" (§7.2).
6. **Consume.** The link is single-use, consumed with an atomic `update ... where link_used_at is null and fingerprint = $1`.
7. **Result.** The extension reads the run id and project from the page's data attributes (`data-switchboard-run-id`, `data-switchboard-project`), which appear only once an action has finished. It posts `sql <run id>` for a real run or a test, or `sql <dry-run id> cancelled: <reason>` for Don't run, into the remembered tab, but only if that chat is idle and its message box is empty. It closes the approve tab only after a confirmed post. It makes one try and doesn't wait: if it can't post, the line stays on the approve page to copy, with Copy, the reason and Try again, and the tile goes red (§7.2); with that tab gone, the toolbar icon says why. Clicked tabs and waiting runs are stored, so an extension reload or a worker restart loses neither. On the phone, the page shows the line to paste. Claude fetches the result with `get_switchboard_run`.

**Headlines.** Every click page leads with one plain line in capitals, saying what happens. The headline is built by the server from the action's kind and payload, never written by Claude. Examples:
- `THIS CHANGES THE LIVE ALFRED DATABASE: DELETES ROWS FROM WB_RULES`
- `THIS MAY CHANGE DATA IN THE LIVE ALFRED DATABASE: CALLS FUNCTION WB_PROCESS`, for a read that could write: a call to anything but a short list of built-ins that only compute, `select into`, `explain analyze`, or row locks. A view that writes through a function it calls can't be seen from the text.
- `THIS PUSHES TO MAIN AND MAKES IT LIVE IN PRODUCTION`
- `THIS DEPLOYS TO SANDBOX ACME-UAT AND DELETES FIELD Account.Old__c`

**Decided in s25.** The run id travels on the approve page as a data attribute, and the extension reads it there to post `sql <run id>`. `switchboard_issue_link` allows one live link at a time (per project code since s49; it was per user). Only the runner executes queued SQL, and only with a valid JWT and approval link.

**Runner.** `switchboard-runner` connects with `SUPABASE_DB_URL` and is the only code that does.
- **Up front, it flags:**
  - statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CREATE DATABASE`),
  - statement kinds that may exceed the time limit (index builds, `UPDATE` or `DELETE` without a `WHERE`, table rewrites).

  Both send the item to the SQL editor instead.
- **Every approved write** runs in one transaction, then runs `check_platform_conformance` and records the run in `switchboard_runs`. Nothing is written to Supabase's own migration history table. Migration files stay in git.
- **Pruning:** a pg_cron job clears `result` after 30 days; the run rows stay.

**Panel.** A live link in the chat shows "SQL ready" (§7.2), from what the chat reports, not from this table. The panel learns Report unread and each project's lane from `switchboard-panel`, a separate read-only function with its own key (interface 3). `waiting_on_alex` stays in its reply, unread by the panel since s49, until a later deploy of that function removes it.

### 8.2 Claude's read-only Supabase queries

MCP tool `get_sql_read(sql)` (decided in s25; the house prefixes rule out `switchboard_query`). The guarded function first planned here was dropped after the 2.10 spike: a query inside it could raise itself back to `postgres`. Instead the tool connects as `claude_reader`, a login of its own, using `SWITCHBOARD_READER_DB_URL`.
- **Access:** usage on `public`, with column-level select built from `platform_read_settings()`, so secret columns and hidden tables are never granted. `platform.apply_reader_access` re-applies the grants when that list changes. Each table's read rule names Alex's id directly, not `auth.uid()`. 88 tables are covered; 11 with no `user_id` are left out.
- **The `net` schema stays open at source (decided in s43).** `claude_reader` has usage on `net` through PUBLIC. A test revoke of all 18 statements had no effect (run 7b666e1a-bd11-4b76-8981-1ad775329f43), because `supabase_admin` made those grants. The protection is the plan guard plus read-only.
- **Plan guard:** before the query runs, `EXPLAIN (VERBOSE, FORMAT JSON)` in the same transaction refuses any relation, function or cast outside `public` and `pg_catalog`. `information_schema` is refused in the query's text, and functions that run a query from text (`query_to_xml` and family, `ts_stat`, `ts_rewrite`) by name. It can't see inside a non-inlined function in `public`.
- **Transaction:** read-only, one statement only, always rolled back. The extended protocol refuses more than one statement in a send.
- **Limits:** 1000-row cap, `statement_timeout` 10s, `lock_timeout` 1s.
- **Budget:** 20 queries per 600 seconds and 200 per 86400 seconds, counted from `switchboard_read_log`, because `check_call_budget` counts every tool's calls.
- **Kill switch:** `switchboard_settings.reads_enabled`.
- **Log:** every call goes to `switchboard_read_log`.

## 9. Phase 3 — multi-repo and clients (the move)

1. **Switchboard repo and install** (§5.1). Moves everything in §4, including the Phase 1 and 2 work, by a plain copy (decided in s49): the first commit names the alfred-v5 commit it came from, and the old history stays readable in alfred-v5. A seed script, an approved exception to the Edit and Write rule, does the copy and the path and import changes; Alex runs it and commits. alfred-v5 keeps working throughout: old `scripts/*.mjs` paths become one-line shims that call the installed copy, until the cutover step deletes them.
2. **User-level hooks.** Registered in `~/.claude/settings.json`; they do nothing in a repo with no `repos.json` entry. The project hooks in `.claude/settings.local.json` are removed in the same step. `CLAUDE.md` and the claude.ai cli-workflow skill change the same day.
3. **Repo settings and project list** (§5.2), read by every command; the project code finds the folder. The prompt check uses `projects.json` to know which window owns which code. The panel reads its repos from the same list, which is what lets Send and the tiles reach a client window.
4. **`sb` commands** (§5.4) and their protection (§5.5).
5. **Finish modes.** `pr` pushes the branch and runs `gh pr create`; `local-commit` commits only; `merge` is the alfred-v5 behaviour today.
6. **Salesforce guard,** in every window:
   - **Blocked:** `sf data *`, `sf apex run` (anonymous Apex), `sf api request *`, `sf apex tail log`, legacy `sfdx force:data:*` and `force:apex:execute`, and any command whose target org is production.
   - **Blocked, not by a command:** every Salesforce MCP tool, whatever its toolset. A repo whose `.mcp.json` names an org is refused until the entry is removed. Team IMPACT's committed `.mcp.json` gives any session in that folder the `data` and `users` tools on production, which a shell-only guard would never see (found in s48).
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
2. The desktop helper polls with its pickup key and runs the query, using the read code in `salesforce/helper`. The helper itself arrives with git by link (§11).
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

Built in two parts: the git half straight after Phase 3, and the Salesforce half after Phase 4 (s48).

### 11.1 Click rules

| Action | Click | Why |
|---|---|---|
| `gitcom` | yes for the first two weeks; then no, and only when claude.ai issued it | Its own worktree, claimed files only |
| `gitsync` | yes for the first two weeks; then no, and only when claude.ai issued it | Its own worktree only |
| `sb deploy`, `sb test` (no-click tier, `cliMayDeploy` on) | no | Its own claimed files, one sandbox, under the lock |
| `sb deploy` (click tier, or `cliMayDeploy` off) | yes, with a warning | Shared or risky metadata |
| `gitpush` Push, Checkpoint, Finish | yes, always | Touches main; never automatic |
| `gitnewtree` | yes | Creates a worktree from `origin/main` |

The two weeks (decided in s49) count from the day git links first go live. **The CLI never runs a git command that changes state,** with or without a click. A no-click action is still issued by Claude one at a time, and logged. It simply runs when the helper picks it up.

### 11.2 The allowlist

**Allowed:** `gitpush`, `gitsync`, `gitcom`, `gitnewtree`, `sb deploy` and `sb test`, with checked arguments. From s86: the read-only sandbox checks (§11.4), and `sb client start` and `sb org add` within §11.5's limits. The folder is chosen from the project code.

**Refused:**
- `sb client end` and `sb org set`, which are terminal-only (§5.4), and any `sb` setup outside §11.5's limits.
- Known traps, for example Finish while that worktree's window is open.
- Anything on production.

The helper runs approved actions in a visible terminal. The click is the yes: a command run by link never stops to ask a question. Where it would have asked, it refuses and says why.

### 11.3 The git payload contract

Claude queues a git action with `queue_switchboard_git` (tier 2, in `_shared/tools/switchboard.ts`). It returns the approval link, as `issue_switchboard_link` does. `project_code` (and an optional `chat_url`) goes in the action's columns; everything else is the payload, and only these keys are accepted:

| Command | Keys besides `command` |
|---|---|
| `gitcom` | `message`; `include_unclaimed`: all or none |
| `gitsync` | none |
| `gitnewtree` | `install`: true or false |
| `gitpush` | `mode`: push, checkpoint or finish. `finish`: phase or project-done (required for a Finish, refused otherwise). `paths` (a list) or `all: true` (Checkpoint only, exactly one). `db`: release or keep (Checkpoint only). `message`. `include_unclaimed` (main only, so never with checkpoint) |

`message` is one line, at most 200 characters, with no double quote, and doesn't start with `-`. A path is a plain relative path with no `..`. Any other key or value is refused before anything is queued.

The headline names the command, the project and what the click changes, for example `GITPUSH FINISH switchboard2-h8r: MERGES INTO MAIN, PUSHES, REMOVES THE WORKTREE`. `project-done` adds `, MOVES THE DOCS TO HISTORY`.

The tool checks the same rules as the helper's `planAction` (switchboard `helper/lib/core.mjs`). The helper checks them again when it runs, plus what only the machine knows: projects.json, whether the project has a worktree or is main's, and the modes each checkout takes. A refusal there is posted to `/result` as failed.

Authenticated can't insert into `switchboard_actions` (migration 189), so the tool queues through `switchboard_queue_git(p_project_code, p_payload, p_headline, p_chat_url)`. This is a SECURITY DEFINER function, granted to authenticated only, that inserts a `kind: git` row for `auth.uid()` with `created_by: 'claude'` and returns `{action_id}`. The table's checks and the guard trigger still apply. Migration 208 added it (s84c).

### 11.4 Read-only sandbox checks (s86)

**What they're for.** They let Claude see the state of a sandbox without asking Alex to run anything: is the alias the org we think it is, what metadata does it hold, and what differs from the worktree. They never touch records, objects or SOQL; those are §10's reads (s88-s92). The two never overlap: s86 has no `sobject`, no describe and no query, and s89 has no CLI command.

**The checks.** Six, each one fixed template. The helper builds the argument list itself. The payload gives only the check's name, the alias and, for `metadata`, a type. The helper always adds `--target-org <alias> --json`.

| Check | Command | Kept from the JSON | Lowest level |
|---|---|---|---|
| `org-verify` | `orgIdentity` (`sf org display`, then `sf org list`, as `sb org verify`) | orgId, isSandbox, how, and whether they match orgs.json | `objects` |
| `limits` | `sf org list limits` | name, max and remaining for each limit | `objects` |
| `metadata-types` | `sf org list metadata-types` | each type's xmlName | `metadata` |
| `metadata` | `sf org list metadata --metadata-type <T>`, where T matches `^[A-Za-z]{1,80}$` | fullName, type and lastModifiedDate. Never lastModifiedByName or createdByName, which are people's names | `metadata` |
| `retrieve-preview` | `sf project retrieve preview`, in the project's checkout | each component's fullName, type, state and path | `metadata` |
| `deploy-preview` | `sf project deploy preview`, in the project's checkout | the same | `metadata` |

**Left out, and why:**
- `sf sobject list` and `describe` are §10's job, under its levels.
- `sf data *`, `sf api request` and `apex run` are refused by the guard (§9.6).
- `sf apex list log` and `get log`: debug logs carry record data.
- Raw `sf org display`: its output carries the access token. `org-verify` keeps only identity fields.
- `project deploy validate` and test runs run code in the org; they belong to the deploy wrapper (§9.7).

**How the helper proves the target is a sandbox.** Before every check, it calls the guard's `checkOrg(alias, { repoRoot, fresh: true })` from `salesforce/guard.mjs`. That's the same function the shell guard and `sb deploy` use, with no cache.
- **Salesforce is asked.** `sf org display` must say isSandbox true, or else `sf org list` or the sandbox instance URL must. If none says so, the org is treated as production.
- **The org is matched.** The orgId must match an orgs.json entry listed for that project's repo. The alias name is never trusted.
- **orgs.json agrees.** The entry must not record the org as production, and its `sandboxType` must not be `production`.
- **Production is refused by link even when `productionAllowed` is on.** Production sf commands stay in Alex's terminal.

A refusal is posted to `/result` as failed, with the reason, and sf never runs.

**Output.** Only the kept fields go into `/result`, as JSON plus a one-line summary ending in `Result:`. Never sf's raw text: the helper reads only the JSON fields above, and on an sf error keeps only `sfJson`'s cleaned message. The row cap is §8.2's: 200 items, then it says how many more there are.

**No click.** A check is `kind: sf_check`, needs_click false (decision D3), queued by Claude with `queue_switchboard_sf_check` (s86d), which never issues a link, and run one at a time per project when the helper next picks up. The tool's reply tells Claude to end its message with `sf <action id> queued`.

**No project code (Alex, s86h).** A check needs none: the helper finds the client's repo from the alias (switchboard s86g). `project_code` is optional on the tool. Without it, `switchboard_queue_helper` gives the row `sf-<alias>`: lower case, other characters folded to `_`, cut to 40. So checks run one at a time per alias. A given code keeps the old rule, one at a time with that project's git actions. The result line in the chat is `sf <action id> done` or `failed`. Claude reads it with `get_switchboard_run`.

**Expiry.** A queued no-click action that hasn't been picked up 10 minutes after it was queued is never run. The next pickup marks it failed, with a run whose summary reads "expired before the helper picked it up" (s86b1, in `switchboard_pickup_helper`).

**Waking the helper (s86b1, proposed, not built).** The helper picks up only when it starts and when the panel writes `helper-pickup.json`. That happens when the extension sees an approval, and a check has no approval to see. (Alex refused a 15-second poll.)
- **A. The extension sees the queue reply** *(recommended)*. `queue_switchboard_sf_check` tells Claude to end its message with a line `sf <action id> queued`. claude-watch already reads every Claude message for `sql` and `git` lines. On that line it asks the panel to write `helper-pickup.json`, as a git approval does. The helper's own header already expects this.
  - Cost: none on the server, and the check runs within seconds.
  - Limit: it only works while that chat is open in Chrome on the desktop. Elsewhere, from the Chromebook or a chat that isn't open, the check waits for the next approval or helper start, and fails after 10 minutes with the expiry summary. Claude then tells Alex to open the chat on the desktop, or just to approve something.
- **B. Long-poll `/pickup`.** The helper keeps one `/pickup` open, and the runner holds it for up to about 50 seconds, checking the queue every few seconds, before it answers empty.
  - It works from any device.
  - But it is polling on the server side: about 1,700 runner calls a day while idle, and the Edge Function wall-clock limit to stay under. It's close to what Alex refused.
- **C. A Realtime wake-up.** The helper keeps a Supabase Realtime socket open on a broadcast channel. `switchboard_queue_helper` sends an empty "wake" broadcast (`realtime.send`) for a no-click action, and the helper then does its usual authenticated `/pickup`.
  - It's immediate and works from any device. The message carries nothing, so a stray wake only causes an empty pickup.
  - But it costs the helper a supabase-js dependency, a socket and its reconnects, and the migration has to grant a realtime send. That's more moving parts than A.

**Recommendation:** A in s86e. The 10-minute expiry is the backstop. Revisit C only if checks are often queued from somewhere other than the desktop.

### 11.5 `sb` setup answers by link (s86)

**Today** `sb client start` and `sb org add` ask up to eleven questions in the terminal:
- `client start` asks for the aliases, which sandboxes may run, whether the client allows an integration user, and the panel display name;
- then, per org: the type, whether production is allowed, the level, the login, whether the CLI may deploy, whether the contract allows client data to reach Claude, and whether the org is shared.

Each config file it writes then waits for a typed yes, and a login that isn't stored opens the browser.

**By link** (decision D1):
1. Claude asks Alex the questions in the chat. Then it calls `queue_switchboard_sb_setup` with the answers: `command` (`client start` or `org add`), `client`, one source (`repo`, `adopt` or `from_sandbox`), `project`, `name`, `sandboxes`, `integration_ok`, and an `orgs` list of `{ alias, type, level, login, cli_deploy, shared }`. It returns an approval link, as git does.
2. **The limits by link** (decision D2):
   - the type is never `production`;
   - the level is `objects` or `metadata`;
   - `contract-ok` is not a payload key, so it's always no.

   Production, `ids`, `data` and the contract flag stay with Alex in the terminal (`sb org add` or `sb org set`), where the typed yes is his.
3. **The approve page** shows every answer in plain words. It names the files the click writes, and says that a Salesforce login may open in the browser on the desktop. The click is the yes. There's no dry run.
   - client start writes repos.json, orgs.json, the repo's `.git/info/exclude`, and projects.json when it's given a project.
   - org add writes orgs.json.
   - The page carries `data-switchboard-kind="sb_setup"` for the extension.
4. **The helper** runs `sb client start` or `sb org add` in a visible window, with every answer as a flag plus `--by-link`. `sb` gains flags for the four start questions that have none: `--aliases`, `--sandboxes`, `--integration-ok` and `--name`. For client start, each org's answers go in one repeatable `--org-setup <alias>:type=..,level=..,login=..,cli-deploy=..,shared=..` (s86e), with 1 to 10 orgs. **org add by link takes exactly one org**: one action per org. Both `queue_switchboard_sb_setup` (s86d) and the helper refuse otherwise. Under `--by-link`:
   - a question with no answer refuses ("not answered in the link: <question>; nothing was written") instead of asking;
   - each config write prints its diff and takes the click as its yes;
   - `sf org login web` still opens the browser, and Alex logs in there.
5. **The result line** is `sb <action id> done` or `failed`, and the summary ends with `sb`'s own last line.

**Per client, no project code (Alex, s86h).**
- Setup needs no project code; one appears only when the first fix starts. `queue_switchboard_sb_setup` takes no `project_code`, and its description says to leave `project` out at setup.
- The row's code is `sb-<client>` (cut to 40), set by `switchboard_queue_helper`. So it's one live link per client. A derived code that collides with another only makes the limits stricter.
- **The folder.** `from_sandbox` needs `folder`, Alex's answer, which Claude asks for. It offers sb's default, `C:\Users\Alex\projects\<client>`. ActBlue clients live at `C:\Users\Alex\projects\actblue\<nonprofit>`.
  - The folder must be a full path strictly inside `C:\Users\Alex\projects\`, with no `..`, no trailing `\`, no `/ : * ? " < > |` and at most 240 characters.
  - `repo`, `adopt` and org add take none.
  - The tool and the `switchboard_actions_sb_setup_folder` check both hold this. That check is NOT VALID, because one cancelled from_sandbox row predates it.
- The approve page shows the folder in full, and says it must be empty.

**Kinds.** `sf_check` (no click) and `sb_setup` (always a click) are new values for `switchboard_actions.kind`, so s86 needs a migration (§11.6).

### 11.6 s86's database change

- **Kinds:** `switchboard_actions_kind_valid` adds `sf_check` and `sb_setup`.
- **Payload checks**, as constraints:
  - an `sf_check` has a `check` from the six and an `alias` string;
  - an `sb_setup` has a `command` of `client start` or `org add`, and an `orgs` array.

  The full rules are in the tool and the helper, as for git.
- **`switchboard_needs_click`:** `sf_check` false, `sb_setup` true.
- **`switchboard_queue_helper(p_kind, p_project_code, p_payload, p_headline, p_chat_url)`:** 208's function for any helper kind (git, sf_check, sb_setup), SECURITY DEFINER, authenticated only. `switchboard_queue_git` stays and calls it.
- **NULL-safe checks (s86b1).** A CHECK passes on NULL, so every payload condition is coalesced to false: a missing key, a JSON null or a non-string fails. The array lengths sit behind a CASE, since `jsonb_array_length` raises on a non-array.
- **`switchboard_pickup_helper(p_user)`:** `switchboard_pickup_git` for those three kinds, still one running per project. It returns `kind` too. First, it fails any queued no-click action more than 10 minutes old, with a run saying why (§11.4). `switchboard_pickup_git` stays until the runner has moved over (s86c), and goes later.
- The test is `supabase/tests/switchboard2-h8r/8_verify_helper_kinds.sql`; s86h's is `9_verify_setup_folder.sql`, so s87's becomes `10_verify_panel_snapshot.sql`.

### 11.7 s86 decisions

**Decided by Alex at s86b:**
- D1: A, sb client start and sb org add by link.
- D2: A. The database refuses the rest too: the sb_setup payload check in s86b's migration.
- D3: A, no click.
- D4: a developer sandbox, with sb org add by link in the live test. He names the alias at s86f.

The options as s86a put them:

- **D1, `sb` setup by link or not.**
  - A, by link within §11.5's limits *(recommended: it is what the s48 plan asked for, and the answers are checked twice)*;
  - B, terminal only, with Claude giving one line that carries every answer as a flag. This drops `sb_setup`, its tool, its approve-page view and its helper code, and saves about 15m;
  - C, both.
- **D2, the limits by link.** A, sandboxes only, level objects or metadata, the contract flag never *(recommended: Claude must not be able to raise its own access by link)*; B, any level, with a warning on the page.
- **D3, sandbox checks without a click.** A, no click from day one *(recommended: read-only, sandbox-proven and field-filtered)*; B, a click for the first two weeks, as gitcom and gitsync had.
- **D4, the live test's sandbox.** Which listed developer sandbox alias to use, and whether to try `sb org add` by link on a real second sandbox or skip that test.

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
| Wrong chat | The tab the link was clicked in, else one matching chat (§8.1) |
| A step does more than declared | the plan guard (§6.2), plus the scope-versus-changes section in the report |
| Claude loosens its own limits | the installed copy and config are protected; `sb` mutations are blocked |
| Click page misleads | the headline is written by the server from the payload, never by Claude |
| Salesforce writes | GET-only helper, CLI guard, no data commands |
| Salesforce MCP server in a client repo | every Salesforce MCP tool blocked; a repo whose `.mcp.json` names an org is refused (§9.6) |
| Shared sandbox clobbered | own-files manifest, sandbox lock, retrieve and compare |
| Production | `isSandbox` from Salesforce, never from the alias; no production deploys at all |
| Client data in Alfred | PII hold; Apex failures summarised; full data encrypted, in transit only, deleted on fetch |
| Read query abuse | read-only role, schema allowlist, caps, budget, kill switch, log |

## 16. Open questions

- **The token deny list for `claude_reader`.** It is drafted from the schema at the migration step, and Alex reviews it.
- **Sandbox type from `/limits`** is a heuristic. Salesforce gives the exact licence type only from production (`SandboxInfo`), and production is never queried. The fallback is the stricter tier.
- **SQL-table detection** in the plan guard is a regex over the SQL file. A table named only inside dynamic SQL (`execute format(...)`) is not seen, and the runner's dry-run summary is the backstop.
