# Technical Spec: CLI Claims System

## Goal

Let several Claude Code CLI threads work on the Alfred repo (alfred-v5) at the same time without colliding. Each thread works in its own git worktree, and a shared claims file records which files and database items each thread owns. A thread that wants something another thread owns stops and asks Alex instead of editing it. Because no two threads ever edit the same file, merging back into main is always clean.

This project runs solo (no other CLI threads) because the system does not exist yet.

## Terms

- **Worktree:** a separate copy of the project folder on its own branch, sharing the same git history. Created by Alex with `claude --worktree <name>`, which puts it under `.claude/worktrees/<name>/`. Confirmed present in Claude Code 2.1.284 (`claude --help`: `-w, --worktree [name]`).
- **Owner:** the name of the thread that holds a claim. It is the worktree folder name. A thread running in the main checkout has owner `main`. A script works out which it is by comparing `git rev-parse --git-dir` with `--git-common-dir`: they differ in a linked worktree.
- **Branch name:** not assumed. Claude Code's worktree branch naming is not a documented fixed pattern, so anything that needs a worktree's branch reads it from `git worktree list --porcelain`, never constructs it.
- **Claim:** a record that one owner has exclusive rights to one item.
- **Plan reservation:** a non-blocking note that a thread expects to claim a database item at a later step. Other threads see it as a warning, not a block.

## Claimable items

| Item form | Example | Meaning |
|---|---|---|
| File path, relative to repo root | `src/Alfred.jsx` | That one file (may not exist yet) |
| Folder path ending in `/` | `src/components/inbox/` | Everything under that folder |
| `db:table:<name>` | `db:table:job_applications` | That database table's structure and migrations |
| `db:fn:<name>` | `db:fn:mcp` | That Supabase Edge Function |
| `db:deploy` | `db:deploy` | The right to deploy anything to Supabase (migrations or functions). Only one thread at a time. |

A file claim conflicts with a folder claim that contains it, and vice versa.

## Claims storage

- One JSON file at `<git common dir>/alfred-claims.json`, resolved with
  `git rev-parse --path-format=absolute --git-common-dir` so it is always the main
  repo's `.git` folder no matter which subfolder the script runs from. Every worktree
  shares that folder, and git never tracks it, so all threads on this machine see the
  same file.
- **Single machine assumption:** claims only coordinate threads on the same computer. Threads on the desktop and the Surface do not see each other's claims. Documented as a known limit, not solved here.
- Shape:

```json
{
  "claims": [
    { "item": "src/Alfred.jsx", "owner": "inbox-ui", "run_tag": "alfred-ab1-s1-x9k2",
      "claimed_at": "2026-09-27T15:00:00Z", "note": "inbox filters" }
  ],
  "reservations": [
    { "item": "db:table:inbox", "owner": "inbox-ui", "step": "Step 3", "reserved_at": "..." }
  ]
}
```

- Writes are protected by a lock (create an `alfred-claims.lock` folder atomically; retry for up to 10 seconds; treat a lock older than 30 seconds as stale and remove it). Every write re-reads the file inside the lock, so two threads claiming at once cannot both succeed.
- Path items are stored repo-relative with forward slashes. Comparison is
  case-insensitive on Windows, so `src/alfred.jsx` cannot slip past a claim on
  `src/Alfred.jsx`.

## Component 1: `scripts/claims.mjs`

Node script, no dependencies beyond Node's built-ins. It works out the owner from the current worktree unless `--owner` is given.

| Command | What it does |
|---|---|
| `status` | Prints all claims and reservations, grouped by owner, with age. |
| `check <items...>` | Read-only. Reports, per item: free, held by this owner, held by another owner (conflict), reserved by another owner (warning), or **reserved by this owner** (`yours … reserved for <step> — not claimed yet`). Exit code 0 if no conflicts, 1 if any conflict. |
| `claim <items...> [--run-tag t] [--note n]` | Inside the lock, checks every item and claims all of them only if none conflict. All-or-nothing. Exit 1 and list conflicts otherwise. |
| `reserve <item> --step <step>` | Adds a plan reservation. Never blocks. |
| `release <items...>` / `release --all` | Removes this owner's claims (and matching reservations). Refuses `--owner`. |
| `cleanup <owner>` | Manual cleanup of a stale thread. Prints what it removed. |

Output is plain text a human can read, because the CLI will relay it.

### Which commands need Alex's approval

`claim`, `reserve` and `cleanup` change who owns what, so Alex sees each one. Three
mechanisms, because the first two were each defeated in testing:

1. **The guard hook returns `permissionDecision: "ask"`** for a bare `claim`,
   `reserve` or `cleanup`. This is the mechanism that actually works. Leaving a
   command out of the allow list is *not enough*: **auto mode's classifier approves
   "local file operations within project scope" before the allow list is consulted**,
   so on 2026-09-28 a claim ran with no prompt at all despite having no rule. A hook
   decision reaches the permission layer directly, which omission does not.
2. **The permission rules** in `.claude/settings.local.json` pre-approve only
   `status`, `check` and `release`. Still correct and still worth having — it is what
   holds when auto mode is off — but it is the second line, not the first.
3. **`release` refuses `--owner`; cross-owner cleanup is the separate `cleanup`
   command.** The guard decides what needs asking by reading the command, so if
   `release` still took `--owner`, wiping another thread's claims would look exactly
   like a thread tidying up after itself and would go through unasked.
4. **The guard blocks a chained claim.** It is not documented whether Claude Code
   splits a compound command before matching a prefix rule, so `claims.mjs check x &&
   claims.mjs claim x` might ride in on the pre-approved `check` rule. `claim`,
   `reserve` and `cleanup` must therefore stand alone — with **one exception**: a
   leading `cd <this thread's own checkout> &&` is stripped before the check. Sessions
   in the VS Code Claude panel add that prefix as a matter of course, and going where
   you already are cannot change which claims file is written or which owner writes it.
   A `cd` to anywhere else is not stripped and stays blocked, because
   `cd ../other-worktree && claims.mjs claim x` would claim as a different owner.

**The prompt is a backstop, not the confirmation.** `.claude/CLAUDE.md` draws the line
by who named the file: **a file Alex named in his instruction is confirmed** — claim it
and get on with it, and do not ask again for it next turn. A file he did not name means
stop, say which file and why, and wait. A prompt he did not expect, on a file he has
not heard about, tells him nothing about intent, so approving it is not him agreeing to
anything.

Both halves of that were learned in testing: first a thread claimed, edited and released
inside one turn without asking; then, once told to ask, it asked again for a file Alex
had just named twice.

## Component 2: guard hook `.claude/hooks/claims-guard.mjs`

A Claude Code PreToolUse hook (a script Claude Code runs before a tool call; exit code 2 blocks the call and shows the script's error message to Claude).

- **File edits** (tools `Edit`, `Write`, `MultiEdit`, `NotebookEdit`): turn the target path into a repo-relative path. Paths outside the repo are allowed, and so are exempt paths. If the path is claimed by this owner (directly or by folder), allow. Otherwise block with a message saying who holds it or that it is unclaimed, and instructing Claude to stop and ask Alex, and only after Alex confirms, run `node scripts/claims.mjs claim <path>`.
- **Shell writes** (tool `Bash`): if the command contains a write construct —
  `>` or `>>` redirection (except to `/dev/null`), `tee`, `mv`, `cp`, `rm`, `touch`,
  `mkdir`, `sed -i`, `dd of=`, `patch`, a `writeFileSync`/`open(...,'w')` payload, or the
  PowerShell `Set-Content`, `Add-Content`, `Out-File`, `New-Item`, `Copy-Item`,
  `Move-Item`, `Remove-Item`, `Rename-Item` family — then every repo path the command
  names must be claimed by this owner, or it is blocked.

  **Why the whole command and not just the destination.** Shell is not parseable in a
  hook. The write that got through in testing went `{ printf ...; cat file; } > /tmp/x
  && mv /tmp/x file`: the redirect target was outside the repo and the real destination
  was an argument of `mv`. Quoting, heredocs, `$()` and `-c "..."` payloads hide
  arguments from any simple parser. So the rule is coarse on purpose — if a command
  writes at all, every repo file it names must be claimed. The cost is false positives
  (`git diff src/x.js > /tmp/d` is blocked although it only reads), and the answer to
  one is to claim the file or use `CLAIMS_GUARD=off`.
- **Deploy commands** (tool `Bash`): if the command contains `supabase functions deploy` or `supabase db push`, allow only if this owner holds `db:deploy`. Otherwise block with a message to follow the database claim protocol.
- **Never block** reads, searches, or any other tool. Tools that cannot change anything
  return before the hook touches git or the filesystem — measured at 51–54ms for those
  against 63–66ms for one that needs a claims check.
- If the claims file is missing or unreadable, block with a clear message rather than silently allowing.
- **Escape hatch:** `CLAIMS_GUARD=off` in the environment makes the hook allow everything
  and say so on stderr and in its log. A fail-closed guard with no off switch is a
  session that cannot be rescued from itself.
- **Debug log:** every invocation appends one line to `.clip/claims-guard.log` —
  timestamp, decision, tool, owner, reason. A hook that allows leaves no trace anywhere
  else, so without this there is no way to tell "ran and allowed" from "never ran",
  which is exactly the question that came up the first time the guard missed something.
  `.clip/` is git-ignored, and the log stops growing at 256KB.
- **Registered in the existing `.claude/settings.local.json`**, which is tracked by git and
  already holds Alex's `Notification` and `Stop` audio hooks. Those stay exactly as they
  are; the `PreToolUse` entry is added alongside them, with matcher
  `Edit|Write|MultiEdit|NotebookEdit|Bash`. No second settings file is created.
- The hook command is `node "$CLAUDE_PROJECT_DIR/.claude/hooks/claims-guard.mjs"`. A bare
  `.mjs` path does not execute on Windows, and a path relative to the working directory
  only works while hooks run from the repo root. `$CLAUDE_PROJECT_DIR` is verified to
  expand on Windows.
- While in that file, fix the `permissions.allow` rules that hardcode the absolute path
  `c:\Users\Alex\projects\alfred-v5`. They do not match a worktree path, so every
  worktree would re-prompt for commands already allowed in the main checkout. Rewrite
  them as path-independent rules.

### Exempt paths

Some paths must never be claimed, and the guard never blocks them.

`.clip/` is the one that forced this. Claims are path **strings** in one shared file, but
`.clip/last-report.md` is a different file in every worktree — each thread writes its own
copy to report to Alex. Without an exemption the first thread to claim it would lock
every other thread out of reporting, over a file they never share.

The list, in `scripts/lib/claims-core.mjs`: `.clip/`, `.git/`, `node_modules/`,
`tools/sam-tools/node_modules/`, `workshop/.venv/`, `build/`, `coverage/`,
`supabase/.temp/`. All per-worktree or generated. `claims.mjs check` reports them as
`exempt` and `claim` skips them with a note.

### Line endings

`.gitattributes` sets `* text=auto eol=lf` plus explicit `binary` for media and fonts.

Git for Windows puts `core.autocrlf=true` in **system** config, so every checkout here
got CRLF in the working tree while the repo stored LF. That is invisible until it is
not: in the Step 7 dry run, `gitpush` Finish could not remove either worktree because
`.claude/settings.local.json` showed as modified with no visible diff. A `.gitattributes`
overrides `core.autocrlf`, so the behaviour stops depending on a machine-wide setting
nothing in the repo can see — which matters more here than usual, because every worktree
is a separate checkout and they all have to agree.

LF rather than CRLF, and `eol=lf` rather than `text=auto` alone: the repo is already
all-LF (724 of 724 text files), everything that runs this code runs it on Linux (Vercel,
Supabase/Deno), the only Windows consumers are editors and PowerShell, and there are no
`.bat` or `.cmd` files — the one thing that genuinely needs CRLF. `text=auto` alone would
normalise the repo but still write CRLF into the working tree, which is the half that
caused the trouble.

**No renormalisation is needed.** The index is already LF, so `git add --renormalize .`
stages nothing. Files currently CRLF in the working tree keep their endings until they
are next rewritten, and git sees them as clean either way; new checkouts and new
worktrees get LF.

## Component 3: worktree setup

Claude Code 2.1.284 has both halves of this natively, so no setup script is needed.
(Verified on 2026-09-28: `-w, --worktree [name]` is in `claude --help`, and the binary
contains the `.worktreeinclude` reader.)

- Add `.claude/worktrees/` to `.gitignore`.
- Add a `.worktreeinclude` file at the repo root. Claude Code reads it when it creates a
  worktree: lines are gitignore-style patterns, `#` comments and blank lines ignored, and
  every git-ignored file matching a pattern is copied into the new worktree. Symlinks are
  skipped. Contents, from the Step 1 discovery:

```
# Files a worktree needs to run that git does not track.
.env.production.local
workshop/.env
supabase/.temp/
```

  `supabase/.temp/` carries the machine-local Supabase link state (`linked-project.json`,
  `project-ref`, `pooler-url`), without which a worktree has to run `supabase link` before
  it can deploy a function.

- Not copied, deliberately: `node_modules/` and the other installs (rebuild them),
  the two generated `sam-drill-format.schema.json` copies (`scripts/prebuild.js` writes
  them on prestart/prebuild), and `.clip/` — its `last-report.md` is another thread's
  message to Alex and must never be duplicated into a second worktree.

## Component 4: git commands

Alex's `gitcom`, `gitcommit` and `gitpush` are rewritten and a new `gitsync` is added.
**The CLI never runs any of these.** Only Alex invokes them, from a PowerShell prompt;
they are the only route by which anything this project produces reaches main.

**Where the logic lives.** All four behaviours are Node scripts in the repo, under
`scripts/`, so they are versioned, reviewable, and identical on the desktop and the
Surface:

- `scripts/git-commit-claimed.mjs` — gitcom
- `scripts/git-sync.mjs` — gitsync
- `scripts/git-push-worktrees.mjs` — gitpush
- `scripts/lib/git-flow.mjs` — the shared plumbing: running git, reading the working
  tree, listing worktrees, and asking Alex questions.

The PowerShell profile keeps four functions, each a thin wrapper that finds the repo with
`git rev-parse --show-toplevel` and calls the matching script. `gitcommit` calls `gitcom`
(today it is a copy-paste duplicate of it). The exact text to paste is kept in the repo
at `scripts/powershell-profile-snippet.ps1`; Alex pastes it in by hand and no CLI thread
edits the profile.

**Every one of them prints what it is about to do and waits for a typed yes before any
git change.** `git add .` appears in none of them; paths are always passed explicitly
after `--`.

- **gitcom** (rewritten): decides about every changed path from the claims file.
  - claimed by this owner → staged
  - claimed by another owner → **never** staged, and listed so Alex can see why
  - claimed by nobody → Alex is asked: all, none, or file by file

  The middle case is the point: another thread's half-finished file cannot reach main
  through this commit. The unclaimed case exists because Alex's own hand edits sit in the
  same working tree and are his to decide about. The old `gitcom` ran `git add .`, the
  exact sweep rule 1 of `.claude/CLAUDE.md` exists to prevent, which twice pulled his
  unrelated work into a commit. gitcom never touches claims.
- **gitsync** (new, run inside a worktree): merges **local `main`** into this worktree's
  branch, so the worktree includes everything already deployed. This is why the protocol
  requires main to be pushed before a worktree starts — a worktree branches from
  `origin/main`, and gitsync closes the gap from local main afterwards. It refuses to run
  in the main checkout, shows the incoming commits and any uncommitted changes first, and
  on conflict names the conflicting files and the `merge --abort` command rather than
  tidying it away. Two threads should never hold the same file, so a conflict here is
  worth looking at.
- **gitpush** (rewritten, run from anywhere): it always operates on the main checkout,
  found as the first entry of `git worktree list`, so it works from a terminal inside a
  worktree too and there is nothing to remember about which window you are in. gitcom
  and gitsync are deliberately the opposite — they act on the checkout you are standing
  in. gitpush still refuses when main is not checked out. Lists **the main checkout and**
  every open worktree,
  each with its branch (read from `git worktree list --porcelain`), its claims, what is
  unpushed and whether it has uncommitted changes. Alex picks one, several, or all.

  **The main checkout is always listed.** A lot of work never uses a worktree, and
  without this there was no route through gitpush for it: solo work in main could not be
  pushed this way and main's claims could only ever be released by hand, so they piled
  up. There is nothing to merge for main — the work is already there — so its two modes
  differ only in what happens to the claims:
  - **Push only:** commit by the same rules as gitcom if anything has changed, push, and
    **keep** the claims, because the project is still going.
  - **Finish:** the same, then release everything main holds.

  "The same rules as gitcom" is literal: the three-way split and the unclaimed prompt
  live in `claims-core.mjs` and `git-flow.mjs`, and both commands call them.

  For each chosen worktree, one at a time, it asks which mode:
  - **Finish:** commit its claimed changes, merge its branch into main, push, release
    **all** its claims, remove the worktree and delete the branch. Unclaimed changes in
    that worktree are left uncommitted and named, not swept in. Before anything happens
    it says which folder to close in VS Code — Windows will not delete a folder anything
    still has open, and if it is the terminal gitpush was launched from it says that too.
    If removal still fails it tries `--force`, and if that fails it prints the two
    recovery commands (`Remove-Item -Recurse -Force <path>` then `git worktree prune`),
    having already merged, pushed and released.
  - **Checkpoint:** commit only the paths Alex names (normally the database and MCP files
    for a just-deployed step), merge into main, push, release only the `db:` claims he
    names, and keep the worktree. Other uncommitted work stays in the worktree and does
    not reach main, so half-finished front-end code is not deployed by the push. **File
    claims are never released by a checkpoint.**
  - With several worktrees, it stops at the first problem. Worktree removal happens last,
    so a failure there leaves the work already safely in main.

**gitpush is the only thing that releases a file claim.** See the release policy below.

## Component 5: the thread protocol (added to `CLAUDE.md`)

Every CLI thread follows this, whether or not the prompt mentions it.

**File changes go through the Edit and Write tools, never the shell.** Added to
`.claude/CLAUDE.md` on 2026-09-28 after a session made its change with
`{ printf ...; cat file; } > /tmp/x && mv /tmp/x file` and the guard allowed it. The
rule explicitly overrides Claude Code's auto mode, which instructs the model to prefer
`sed`, heredocs and short scripts for file changes. The guard now enforces it, but the
rule stands on its own.

**Step 0, before any worktree starts.** Alex pushes main. `claude --worktree` branches from
`origin/main`, so anything committed locally but unpushed would be invisible to the new
worktree and would surface later as an avoidable merge.

**Step 1, plan (read-only).** List every file and folder the work will touch, and every database item with the step that needs it. Run `claims.mjs check` on the files and on the database items. Report conflicts and warnings. Touch nothing, claim nothing. Stop.

**Step 2, confirm and claim.** After Alex confirms, run `claims.mjs claim` for all files and folders (this re-checks inside the lock, since another thread may have claimed something since the plan). Add a `reserve` for each planned database item. If the claim fails, stop and report. Otherwise start work. Always claim the project's own `docs/` spec and progress files.

**Unplanned file.** If the guard hook blocks an edit to a file Alex did not name, **stop
and hand the turn back to him** — name the file, say what you were about to do and why,
and say who holds it. Wait. Do not claim in the same turn, and do not treat the guard's
message (which shows the claim command) as permission to run it. If Alex *did* name the
file, that is the confirmation: claim it and carry on. Either way the claim runs on its
own, never chained.

**Database step (just in time).** At the step that needs a database item:
1. Check: `claims.mjs check` for the needed `db:table:*`, `db:fn:*`, and `db:deploy`.
2. Stop and ask Alex to run `gitsync` in this worktree.
3. Drift check: after the sync, if main brought in any migration or function change touching the same tables or function since this thread planned, stop and re-plan that step.
4. Ask Alex to confirm the claim, then `claims.mjs claim` the items.
5. **Number the migration now**, not earlier — see below.
6. Deploy. Migrations remain a manual prerequisite Alex runs in the Supabase SQL editor; function deploys the CLI runs itself. Run `check_platform_conformance` where the platform contract requires it.
7. Verify.
8. Stop and ask Alex to run `gitpush` in Checkpoint mode for this worktree, naming the database and function paths.
9. After he confirms, release the `db:` claims. Everything live is now in main.

### Migration numbers: the collision claims cannot catch

Two threads each look at `supabase/migrations/`, each see `083` as the highest, and each
write `084`. The file names differ — `084_add_filter.sql` and `084_backfill_tags.sql` —
so **nothing conflicts, nothing is claimed twice, and the guard has nothing to object
to.** Both land. The sequence now has two `084`s and the order they ran in is
unknowable. Claims coordinate paths; this is a collision in a number, and no amount of
claiming a filename catches it.

The fix is to pick the number last:

- A thread writes new SQL under `supabase/migrations/_pending_<owner>_<purpose>.sql` and
  claims that path like any other file.
- At step 5 of the database flow — after `gitsync`, which is what makes the answer
  correct — it lists the folder, takes the next free number, writes the numbered file,
  and deletes the `_pending_` one. The guard permits the delete because the thread holds
  that claim.

The temporary name sorts away from the numbered files and carries the owner, so a
`_pending_` file in `git status` is a visible loose end rather than a mystery. It is
renumbered before any commit; a `_pending_` file has no business in history.

This is written into `.claude/CLAUDE.md` in both the database step and the SQL section.

**Finishing.** Stop and ask Alex to run `gitpush` in Finish mode. The CLI does not release its own file claims; gitpush does.

### When claims are released

**A file or folder claim is held for the whole life of the thread.** Not until the file
is saved, not until the step ends, not until the turn ends. `gitpush` Finish releases it,
after the work is merged into main and pushed.

The claim is not a lock taken while typing. It is the record that this thread, and no
other, is responsible for that file until its work lands. Released early, another thread
can claim the same file while the first still has uncommitted changes to it — the exact
collision the system exists to prevent, arriving by the one route nothing checks for.

**Database claims are the exception** and keep their just-in-time release: `db:table:*`,
`db:fn:*` and `db:deploy` are claimed at the step that needs them and released once Alex
has checkpointed that step into main. Held for minutes, where file claims are held for
the whole job.

This is written into `.claude/CLAUDE.md` and into `claims.mjs --help`, because the first
test sessions all released each file claim immediately after editing — the natural
reading of "claim, edit, release" and the wrong one.

**Where it goes.** `.claude/CLAUDE.md`, the tracked file that already holds rule 1. The
root `.claude.md` has been deleted, so its contradictory `git add . / commit / push`
block is gone with it. Written in on 2026-09-29 as a "The thread protocol" section
covering Step 0 through Finishing, with the file-naming, never-release and
Edit/Write-only rules in their own sections after it.

Two things in the existing text were corrected at the same time. Rule 1 now names
`gitcom`, `gitsync` and `gitpush` as Alex's, so a thread does not read "they are in this
repo" as "I may run them". And the "Files you did not touch" note said committing was
gone so the `git add -A` sweep could not happen — true of threads, but `gitcom` commits
now, and it asks Alex about unclaimed changes, which he can only answer well if the
thread's report already said what was its own.

## Out of scope

- Coordinating across machines.
- Splitting `Alfred.jsx` (separate project, next).
- Any Supabase table or MCP tool. This system is entirely local files and scripts.

## Success criteria

- Two worktrees can run at once; the second one's plan correctly reports a file the first one claimed, and its guard hook blocks an edit to that file.
- A deploy command is blocked unless the thread holds `db:deploy`.
- gitpush merges a chosen worktree cleanly in both Finish and Checkpoint modes, and Checkpoint mode leaves uncommitted front-end work out of main.
- Existing hooks still work.
