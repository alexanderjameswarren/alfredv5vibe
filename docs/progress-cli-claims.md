# Progress: CLI Claims System

## Status: Steps 1–7 done. Step 7d additions awaiting verification. Step 8 next.

### Development Steps
- [x] Step 1: Discovery (read-only). Find where `gitcom` and `gitpush` are defined and summarize what they do; find all existing Claude Code hooks (project and user settings); find the cli-workflow skill if it is in the repo; list git-ignored files a worktree needs to run; read the git rules in `CLAUDE.md`. Report and stop.
- [x] Step 2: Build `scripts/claims.mjs` with locking.
- [x] Step 3: Build the guard hook `.claude/hooks/claims-guard.mjs` and register it in the existing `.claude/settings.local.json`, keeping the audio hooks, and fix the hardcoded absolute paths in `permissions.allow`.
- [x] Step 4: Worktree setup: `.gitignore` entry and `.worktreeinclude`.
- [x] Step 5: Write `scripts/git-commit-claimed.mjs`, `scripts/git-sync.mjs` and `scripts/git-push-worktrees.mjs`; hand Alex the four PowerShell wrapper functions to paste in.
- [x] Step 6: Add the thread protocol to `.claude/CLAUDE.md`.
- [x] Step 7: End-to-end dry run with two worktrees (Alex runs it, CLI writes the checklist).
- [ ] Step 8: Draft the cli-workflow skill changes so every future prompt includes the plan and claim steps, and so Supabase deploys are gated behind a `db:deploy` claim instead of being fine to ask for normally.

---

## Step 2, 2026-09-28

**Files changed**
- `docs/technical-spec-cli-claims.md` — rewritten with Alex's decisions (below).
- `docs/progress-cli-claims.md` — this file.
- `scripts/claims.mjs` — new, the whole of Component 1.

Nothing was committed.

**Decisions applied to the spec**

1. **`claude --worktree` and `.worktreeinclude` both exist in 2.1.284.** Verified two
   ways: `claude --help` lists `-w, --worktree [name]`, and the installed binary
   contains the `.worktreeinclude` reader — it parses the file as gitignore-style
   patterns, cross-references `git ls-files --others --ignored --exclude-standard`,
   and copies each matching ignored file into the new worktree, skipping symlinks.
   So the spec keeps both and **no `scripts/new-worktree.mjs` is needed**. Terms and
   Component 3 now say what is actually true, and `supabase/.temp/` is in the
   `.worktreeinclude` list alongside `.env.production.local` and `workshop/.env`.
2. **Branch from `origin/main`, push main first.** Added as Step 0 of the protocol.
   gitsync merges local `main`, which is what closes the gap.
3. **git commands are repo scripts with thin PowerShell wrappers.** Component 4 now
   names `scripts/git-commit-claimed.mjs`, `scripts/git-sync.mjs` and
   `scripts/git-push-worktrees.mjs`, says `gitcom` is a rewrite (not an update)
   because today it runs `git add .`, and says `gitcommit` becomes a wrapper for
   `gitcom`. The profile edits are handed to Alex, never made by a CLI thread.
4. The root `.claude.md` is deleted, so Component 5 simply says the protocol goes in
   `.claude/CLAUDE.md`.
5. Smaller items folded in: hook in `.claude/settings.local.json`, git common dir
   resolved absolute, `node` prefix on the hook command, `permissions.allow` paths
   made worktree-proof, Supabase deploy gating moved into Step 8.

**What `scripts/claims.mjs` does**

Commands are exactly as specced: `status`, `check`, `claim`, `reserve`, `release`,
`release --all`, `release --owner <name> --all`, with `--owner`, `--run-tag`,
`--note` and `--step`. Notes on the parts that needed a decision while building:

- **Owner detection** compares `git rev-parse --git-dir` with `--git-common-dir`
  rather than looking for `.claude/worktrees/` in the path. They differ in a linked
  worktree and match in the main checkout, so the rule keeps working if Claude Code
  ever moves where it puts worktrees.
- **Paths** are normalised to repo-relative with forward slashes, so an absolute
  Windows path and a relative one are the same claim. Comparison is case-insensitive
  on Windows, so `src/alfred.jsx` cannot slip past a claim on `src/Alfred.jsx`.
- **Claiming a folder absorbs** this owner's own claims inside it, instead of leaving
  duplicates behind.
- **A corrupt claims file is never silently reset.** Exit 2 with the parse error and
  a note to fix it by hand — starting fresh would drop every live claim and let two
  threads edit the same file.
- **The lock is released even when the script exits early.** `process.exit()` skips
  `finally`, so lock removal is also wired to the process `exit` event. Without that,
  one bad claims file wedged every later command behind a lock nobody owned — caught
  in testing.

**Tested** (all against the real `.git/alfred-claims.json`, cleaned up afterwards —
the file is now `{"claims": [], "reservations": []}`):

- status on an empty file, and grouped by owner with ages
- check: free, yours, conflict, and reserved-warning
- conflict between a file and a folder that contains it, both directions
- case-insensitive matching (`SRC/SAM/lib/x.js` vs a claim on `src/sam/`)
- claim is all-or-nothing: one conflict claims nothing
- folder claim absorbing an earlier file claim
- reserve never blocks, and reports who holds the item right now
- release by item, release of something not held, `release --owner X --all`
- rejects `db:nope:x`, `../outside.txt`, and `./` (the whole repo)
- absolute Windows path argument resolves to the same claim
- runs correctly from a subfolder
- **eight concurrent claims on one item: exactly one winner, seven refused**
  (re-run after the lock fix: one winner, five refused)
- lock held by someone else times out at 10s; a 2-minute-old lock is treated as
  stale and removed
- corrupt JSON refuses and leaves no lock behind

---

## Step 3, 2026-09-28

Step 2 verified by Alex: all five tests passed.

**Files changed**
- `scripts/lib/claims-core.mjs` — new. The shared core: where the claims file lives,
  what an item means, what counts as a conflict, locking.
- `scripts/claims.mjs` — refactored onto the core. Behaviour unchanged; the five
  verified tests were re-run and give identical output.
- `.claude/hooks/claims-guard.mjs` — new, the PreToolUse guard.
- `.claude/settings.local.json` — PreToolUse hook registered, permission paths fixed.
- `docs/progress-cli-claims.md` — this file.

Nothing was committed.

**Why a shared core.** The guard and the claimer have to agree on every answer. If they
ever disagreed about whether `src/sam/` covers `src/sam/lib/x.js`, the guard would wave
through an edit the claimer thought it had reserved — the exact failure the system
exists to prevent. The rules now live in one module and neither side reimplements them.
It also cut the guard to a single `git rev-parse` call (root, git dir and common dir in
one), which matters because the hook runs before every tool call.

**Measured cost:** 57ms for a tool the guard ignores (Node startup, no git), 65ms for one
it checks. The early return for non-guarded tools is what keeps the git spawn out of the
common path.

**What the guard does**
- Blocks `Edit`, `Write`, `MultiEdit`, `NotebookEdit` on a path this owner has not
  claimed, directly or through a folder claim. `NotebookEdit` uses `notebook_path`, the
  rest `file_path` — confirmed against `sdk-tools.d.ts` in the installed package.
- Blocks `Bash` when the whitespace-normalised command contains `supabase functions
  deploy` or `supabase db push` and this owner does not hold `db:deploy`. Deliberately
  broad: a false block costs one question, a false allow costs a deploy from a thread
  that does not own the function.
- Allows everything else without touching git or the filesystem.
- Allows paths outside the repo, and allows everything when the folder is not a git repo.

**Fail closed, and what it costs.** An unclaimed file is blocked, and so is every edit
when the claims file is missing or unreadable — per the spec. The consequence is real
and worth saying plainly: **from the next session on, nothing can be edited until
something is claimed, including ordinary solo work in the main checkout.** The way out
is to claim what you are working on, which is the habit the system wants anyway.

**One thing added beyond the spec:** `CLAIMS_GUARD=off` in the environment makes the hook
allow everything and say so on stderr. A fail-closed guard with no off switch is a
session that cannot be rescued from itself. It is never off quietly. Say the word and it
comes out.

**Settings changes, each one named**
- Added the `PreToolUse` entry with matcher `Edit|Write|MultiEdit|NotebookEdit|Bash`, so
  the hook is not invoked for tools it would ignore anyway.
- The two audio hooks (`Notification`, `Stop`) are untouched, character for character.
- `Bash(git -C "c:\Users\Alex\projects\alfred-v5" log --oneline --all)` and the
  `--name-status` twin → one `Bash(git log:*)`. The `-C <abs path>` form cannot match in
  a worktree, and a worktree runs plain `git log` from its own cwd anyway.
- `Bash(ls c:/Users/Alex/projects/alfred-v5/*.config.* …)` → `Bash(ls:*)`.
- Removed `Bash("c:\Users\Alex\projects\alfred-v5\docs\progress-phase75-ui-redesign.md":*)`
  — a stray auto-approval to execute a markdown file as a command. It can never usefully
  match. Flagged rather than quietly dropped.
- Added `Bash(node scripts/claims.mjs:*)` so the claims commands do not prompt in every
  new worktree.
- Left alone: the `mcp__claude_ai_Aflred_v5__*` rules (typo'd server name from an old
  connector, not a path problem).

**Tested** — 26 cases, all passing, by piping real PreToolUse payloads into the hook:
no claims file at all (Write blocked, Read allowed); empty claims file (Edit, Write,
MultiEdit, NotebookEdit blocked; Read, Grep, Glob, non-deploy Bash allowed); path outside
the repo allowed; folder claim covering a file; case-insensitive match (`SRC/SAM/x.js`
against a claim on `src/sam/`); absolute path inside a claimed folder; a file held by
another thread, with the message naming the holder; `npx supabase functions deploy`,
`supabase db push` and odd spacing all blocked without `db:deploy`, allowed while holding
it, blocked again after release; `supabase functions list` allowed; malformed and empty
payloads allowed loudly; `CLAIMS_GUARD=off`; corrupt claims file blocked. The claims file
was backed up and restored, and is back to `{"claims": [], "reservations": []}` apart
from this task's own claims.

**Also confirmed live.** The hook loaded in the session that wrote it and blocked this
file until it was claimed — which is the end-to-end proof, and also why Step 4 onwards
must claim its files first.

---

## Step 3 fix, 2026-09-28

**Step 3 verification failed at test 2.** Asked to add a comment to
`src/utils/recurrence.js`, the test session was not blocked. Diagnosis from its
transcript (`~/.claude/projects/c--Users-Alex-projects-alfred-v5/d3ad3bb8-….jsonl`): it
never called `Edit` or `Write` at all. Every tool call in the session was `Bash`. The
change was made with

```
{ printf '// recurrence.js — …\n'; cat src/utils/recurrence.js; } > /tmp/rec.$$ \
  && mv /tmp/rec.$$ src/utils/recurrence.js
```

The hook ran — its matcher already included `Bash` — and allowed it, because it only
looked for Supabase deploy patterns in a `Bash` command. **The guard was watching the
wrong door.** Note also that the redirect target was `/tmp`: a check for "redirects into
the repo" would have missed it too; the repo file was clobbered by `mv`.

The root cause is not a one-off. Claude Code's **auto mode instructs the model to make
file changes with `sed`, heredocs or short scripts rather than the Edit and Write tools**.
So the shell is the *normal* path for a file change in these sessions, and guarding Edit
and Write alone guarded nothing.

The relative hook path was **not** the cause — it worked. It has been made absolute
anyway, as asked.

**Files changed**
- `scripts/lib/claims-core.mjs` — exempt paths, write-construct detection, repo-path
  extraction.
- `.claude/hooks/claims-guard.mjs` — shell-write guard, exempt paths, debug log.
- `.claude/settings.local.json` — hook command now absolute.
- `.claude/CLAUDE.md` — new rule: change files with Edit/Write, never the shell.
- `scripts/claims.mjs` — reports exempt paths instead of claiming them.
- `docs/technical-spec-cli-claims.md`, `docs/progress-cli-claims.md`.
- `src/utils/recurrence.js` — the test session's line 1 comment removed. Claimed, fixed,
  released; `git diff` on it is empty, so it matches the committed version exactly.

Nothing was committed.

**1. Shell writes are now guarded.** If a `Bash` command contains a write construct
(`>`/`>>` except to `/dev/null`, `tee`, `mv`, `cp`, `rm`, `touch`, `mkdir`, `sed -i`,
`dd of=`, `patch`, a `writeFileSync` or `open(...,'w')` payload, or the PowerShell
`Set-Content` / `Add-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` /
`Remove-Item` / `Rename-Item` family), then **every repo path the command names** must be
claimed by this owner.

Scanning the whole command rather than working out the destination is deliberate: shell
is not parseable in a hook, and the failure above proves it — the destination was an
argument of `mv`, three constructs away from the redirect. The cost is false positives:
`git diff src/x.js > /tmp/d` names a repo file in a writing command and is blocked
although it only reads. That is the trade — the answer is to claim the file, which is
the habit the system wants anyway, or `CLAIMS_GUARD=off`.

Three refinements were needed to keep the noise down, each found by a test:
- `printf "x\n"` leaves the token `x\n`, which looked like a Windows path. A backslash
  now only counts with a drive letter or a real file extension.
- A path with a slash needs its parent folder to exist; a **bare** filename has to exist
  outright, because its parent is the repo root, which always does. Without this,
  `console.log` and `claims.mjs` appearing anywhere in a command were reported as repo
  paths.
- `> /dev/null` is excluded. It is on the end of half the commands we run and never
  writes anything; counting it made `claims.mjs status >/dev/null` a "write".

**2. Exempt paths.** `EXEMPT_PREFIXES` in the core: `.clip/`, `.git/`, `node_modules/`,
`tools/sam-tools/node_modules/`, `workshop/.venv/`, `build/`, `coverage/`,
`supabase/.temp/`. The guard never blocks them and `claims.mjs` refuses to claim them,
saying so. This closes the flaw flagged in Step 3 — every worktree can always write its
own `.clip/last-report.md`.

**3. Debug log.** Every invocation appends one line to `.clip/claims-guard.log`:
timestamp, ALLOW/BLOCK, tool, owner, reason. A hook that allows leaves no trace anywhere
else — that is exactly why the transcript could not say whether the guard had run and
allowed or never run at all. Capped at 256KB; `.clip/` is git-ignored.

**4. Absolute hook path.** The command is now
`node "$CLAUDE_PROJECT_DIR/.claude/hooks/claims-guard.mjs"`. Verified on Windows: after
the change, log lines appear with `owner=main`, which only happens once the module has
loaded and resolved the repo. The old relative form depended on hooks running from the
repo root.

**5. The CLAUDE.md rule**, in a new section before the SQL rule: file changes go through
Edit/Write/MultiEdit/NotebookEdit, never the shell; reading with `cat`/`head`/`grep` is
fine; and it says explicitly that it overrides auto mode's instruction to prefer the
shell. With the reason: a tool edit shows Alex the before and after, a shell command
makes him reconstruct it.

**Tested: 54 cases, all passing**, including the exact command that got through. New
coverage: 15 shell-write forms (bash redirect, append, heredoc, `sed -i`, `tee`, `cp`,
`rm`, `touch`, the temp-file-plus-`mv` original, four PowerShell cmdlets, `node -e`
`writeFileSync`, `python -c open`), 11 commands that must *not* be blocked (`cat`,
`grep`, `npm test`, redirect to `/tmp`, redirect to `/dev/null`, `2>&1`, `rm -rf
node_modules`, writes into `.clip/`, `clip.mjs`, `claims.mjs`), the same shell writes
allowed once claimed, and `CLAIMS_GUARD=off` for both an edit and a shell write.

**Also confirmed live in this session:** the guard blocked my own attempt to run the
original `printf | cat > /tmp && mv` command, naming `src/utils/recurrence.js` and
nothing else.

**Latency, re-measured:** 51ms for a `Bash` command that does not write, 54ms for a tool
the guard ignores, 63ms for an `Edit`, 66ms for a shell write that needs the full scan.

**A design flaw this turned up, for Step 6.** Claims are path strings, and every worktree
shares one claims file — but `.clip/last-report.md` is a *different file* in every
worktree. Every thread has to write it to report to Alex, so the first thread to claim it
locks every other thread out of reporting. The same goes for any per-worktree scratch
path. The protocol needs a rule for this; an exempt list in the guard (paths that are
per-worktree by nature and are never coordinated) looks like the right shape.
**Fixed in the Step 3 fix above** — `EXEMPT_PREFIXES`, starting with `.clip/`.

**Known gap for Step 7 to check.** The hook command is the relative
`node .claude/hooks/claims-guard.mjs`, per the spec, which relies on hooks running from
the worktree root. If that ever ran from elsewhere, node would fail to find the file and
exit 1 — a non-blocking error, so the edit would go through. The two-worktree dry run is
where that would show up.

---

## Step 3 fix 2, 2026-09-28

**Re-verification: the guard held, the confirmation did not.** The fresh session was
blocked as designed, then ran `node scripts/claims.mjs claim src/utils/recurrence.js`
itself, edited with the Edit tool, and released — all inside one turn, without asking.
It could do that because `.claude/settings.local.json` pre-approved
`Bash(node scripts/claims.mjs:*)`, every command the script has.

So the guard worked and the gate was open. The guard log confirms the sequence:
`ALLOW Edit owner=main claimed: src/utils/recurrence.js`.

**Files changed**
- `.claude/settings.local.json` — the blanket claims.mjs rule replaced with four narrow ones.
- `scripts/claims.mjs` — `release` refuses `--owner`; new `cleanup <owner>` command.
- `scripts/lib/claims-core.mjs` — `=>` and `->` no longer read as redirects.
- `.claude/hooks/claims-guard.mjs` — blocks a claim chained onto other commands.
- `.claude/CLAUDE.md` — new rule: never claim without asking Alex first.
- `docs/technical-spec-cli-claims.md`, `docs/progress-cli-claims.md`.
- `src/utils/recurrence.js` — the test session's line 1 comment removed. Claimed, fixed,
  released; `git diff` on it is empty.

Nothing was committed.

**1. Narrow permission rules.** Pre-approved now:

```
Bash(node scripts/claims.mjs status)
Bash(node scripts/claims.mjs status:*)
Bash(node scripts/claims.mjs check:*)
Bash(node scripts/claims.mjs release:*)
```

`claim`, `reserve` and `cleanup` match none of them, so each raises the permission
prompt. Checked mechanically: five claim/reserve/cleanup forms all prompt, six
status/check/release forms all stay silent.

**2. `release` no longer takes `--owner`; `cleanup <owner>` replaces it.** This is what
makes the rules separable rather than just narrow. The rules are *prefix* matches, so a
pre-approved `release` would have covered `release --owner other --all` — pre-approving
the wiping of another thread's claims. `cleanup` shares no prefix with `release`,
`check` or `status`, so nothing can reach it without a prompt. (`check` and `claim` also
differ from the second letter, so `check:*` cannot reach `claim`.)

**3. The guard blocks a chained claim.** I could not confirm from the Claude Code binary
whether it splits a compound command before matching a prefix rule. If it does not,
`claims.mjs check x && claims.mjs claim x` would ride in on the pre-approved `check`
rule — the same failure one layer down. Rather than depend on undocumented behaviour,
the guard now refuses `claim`, `reserve` or `cleanup` when the command contains `&&`,
`||`, `;`, `|` or a newline. On its own, such a command can only match a claim rule, and
there are none.

**4. The CLAUDE.md rule** says what the prompt cannot: stop, name the file, say what you
were about to do and why, say who holds it, and wait. It states explicitly that **the
permission prompt is a backstop, not the confirmation** — a prompt Alex did not expect,
on a file he has not heard about, tells him nothing about intent, so approving it is not
him agreeing to anything. It also says the guard's block message shows the claim command
for use *after* he confirms, not instead of asking, which is precisely how the last
session read it.

**5. Also fixed:** `=>` in an inline JS arrow function was being read as a `>` redirect,
so any `node -e` with an arrow function was treated as a shell write. Found by tripping
over it. `->` excluded too.

**Tested: 65 cases, all passing** — the 54 from the previous round plus 11 new: six
chained forms blocked (`check && claim`, `cd && claim`, `claim ; echo`, `claim | tail`,
chained `reserve`, chained `cleanup`), three standalone forms allowed, and chained
`check` and `release` still allowed. Plus a mechanical check of the permission rules
against eleven command forms.

**Residual risk, stated plainly.** The guard cannot tell an approved claim from an
unapproved one — nothing in a hook can. It can only make sure a claim has to arrive as a
bare command, where Claude Code's prompt is the thing Alex sees. A thread determined to
route around that (writing a script into an exempt folder and running it, say) still
could. The defence against that is the CLAUDE.md rule and reading the report, not the
hook.

---

## Step 3 fix 3, 2026-09-28

**Re-verification: stop-and-ask passed, the prompt did not appear.** The session stopped
and asked before claiming, as intended. But when Alex said yes, the claim ran with **no
permission prompt**, and so did `cleanup ghost`.

**Diagnosis: auto mode.** Every settings layer was checked and none contains a broader
rule — `~/.claude/settings.json` has only theme and update keys, `~/.claude.json` has
`allowedTools: []` for this project and no `defaultMode` or `permissions`, and there is
no `.claude/settings.json`. The narrow rules from fix 2 are correct and verified.

The cause is **auto mode's classifier**, which approves before the allow list is
consulted. `claude auto-mode config` lists among its allow rules:

> *Local Operations: Agent deleting local files in working directory, local file
> operations within project scope…*

Running `node scripts/claims.mjs claim …` is exactly that. **Leaving a command out of
the allow list therefore no longer produces a prompt.** Omission was the wrong lever.

**The fix: the guard returns `permissionDecision: "ask"`.** Confirmed supported in
2.1.284 — the binary documents `"allow"`, `"deny"`, `"ask"` for PreToolUse. For a bare
`claim`, `reserve` or `cleanup` the hook now writes

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",
 "permissionDecisionReason":"…"}}
```

to stdout and exits 0. A hook decision reaches the permission layer directly rather
than by omission.

**Does it hold in auto mode? Not settled from here, and Alex's step 1 is the test.**
What is known: hooks certainly reach the permission layer in auto mode — the `exit 2`
block path has been stopping edits all through this work, in auto mode. What could not
be tested from a CLI session is whether `"ask"` becomes a *visible prompt*: a bare claim
run here logged `ASK` correctly and then proceeded, because there is nobody to prompt in
a non-interactive session, so "ask" resolved to allow. That says nothing either way
about an interactive session.

**Fallback if `"ask"` does not hold:** switch the same branch from `"ask"` to `"deny"`
with a message telling the thread to ask Alex to run the claim in his own terminal.
That is guaranteed to work — `deny` is the path already proven — at the cost of Alex
typing every claim himself. One-line change; say the word.

**Files changed**
- `.claude/hooks/claims-guard.mjs` — new `ask()` path for bare claim/reserve/cleanup.
- `.claude/CLAUDE.md` — a file Alex names is confirmation; stop-and-ask is for files he
  did not name.
- `scripts/claims.mjs` — `--help` now says the prompt is a backstop, matching CLAUDE.md;
  the stale comment on `release --owner` corrected to describe the guard, not the rules.
- `docs/technical-spec-cli-claims.md`, `docs/progress-cli-claims.md`.
- `src/utils/recurrence.js` — **no change needed.** The test session had already removed
  the `// testing claims` line and the blank line; `git diff` on it is empty and it does
  not appear in `git status`. Verified, not edited.

Nothing was committed.

**The friction Alex reported is fixed too.** Asked to remove the comment from the file
he had just named, the thread asked permission again. CLAUDE.md now draws the line by
who named the file: **a file Alex named is confirmed** — claim it, get on with it, and
do not ask again for it on the next turn; his instruction covers the files it names and
the obvious ones the change implies. Only a file he did not name triggers stop-and-ask.

**Tested: 69 cases, all passing** — the 65 from fix 2, with the claim/reserve/cleanup
cases re-expected as `ask` rather than `allow`, plus four new: claim with flags asks,
and `status`, `check` and `release` are confirmed *not* to ask. The harness now reads
the hook's stdout and distinguishes ask from a plain allow. The permission-rule check
still reports ALL CORRECT and the audio hooks intact.

---

## Step 4, 2026-09-28

**Step 3 verified and complete.** In a fresh session: naming a file let the thread claim
without stopping to ask, the claim raised a permission prompt in auto mode, the guard log
showed `ASK` then `ALLOW`, `status` ran silently, `cleanup` prompted, and
`src/utils/recurrence.js` is back to its committed state. So **`permissionDecision: "ask"`
does hold in auto mode** — the open question from fix 3 is answered, and the `deny`
fallback is not needed.

**Files changed**
- `.gitignore` — `/.claude/worktrees/` added.
- `.worktreeinclude` — new.
- `scripts/claims.mjs` — `cleanup` now says when the owner name is unknown.
- `docs/progress-cli-claims.md` — this file.

Nothing was committed.

**`cleanup <owner>` on an unknown name.** It used to print `Released 0 record(s)` whether
the name was dead, never used, or a typo. Now it says so and exits 1:

```
No owner called "ghost" holds anything. Nothing removed.

Owners with records right now: ghost-thread, main
Did you mean: ghost-thread?
```

The claims file holds only current claims, so "never existed" and "already released
everything" genuinely cannot be told apart — but listing the owners that *do* hold
something makes a misspelling obvious, which is the point. A substring match either way
adds the "did you mean". `cleanup` also now refuses `--owner`: the name to clear is the
positional argument and only that, so `cleanup ghost` cannot quietly clear something else
(it previously took `--owner` in preference to the positional, which was worse than
useless).

**`.worktreeinclude`**, at the repo root, holding exactly the three entries from the
spec — `.env.production.local`, `workshop/.env`, `supabase/.temp/` — plus a comment
block recording what is deliberately *not* copied and why, so the next person does not
have to re-derive it from the Step 1 discovery.

**Verified without creating a worktree** by reproducing what Claude Code does: it matches
the patterns against `git ls-files --others --ignored --exclude-standard`. All three match
real files (1, 1 and 9 respectively — the nine being the Supabase link state).
`/.claude/worktrees/` is confirmed ignored via `git check-ignore`, and `.claude/CLAUDE.md`,
`.claude/settings.local.json`, `.gitignore` and `.worktreeinclude` are all confirmed
*not* ignored, so nothing needed was swept up by the new rule.

**The guard suite still passes: 69 cases, 0 failures.**

**⚠️ What a test worktree will and will not show.** `claude --worktree` branches from
`origin/main`, and none of this project's work is committed. So a worktree made now gets
the three copied files — which is what Step 4 is for — but **no claims system at all**:
no `scripts/claims.mjs`, no `.claude/hooks/`, and the old `.claude/settings.local.json`.
That is expected, not a failure. Testing the claims system inside a worktree has to wait
until Alex commits and pushes, which is also the protocol's Step 0.

---

## Step 5, 2026-09-29

**Step 4 verified and complete.** `.gitignore` line 46 ignores `.claude/worktrees/`; a
real `claude --worktree wt-test` copied all three `.worktreeinclude` entries with the
right `project-ref`; `claims.mjs` and `.claude/hooks/` were absent in the worktree as
predicted; `git status` in main was unchanged; the worktree removed cleanly.

**Files changed**
- `scripts/lib/git-flow.mjs` — new. Shared plumbing for the three commands.
- `scripts/git-commit-claimed.mjs` — new. gitcom.
- `scripts/git-sync.mjs` — new. gitsync.
- `scripts/git-push-worktrees.mjs` — new. gitpush.
- `scripts/powershell-profile-snippet.ps1` — new. The exact profile text for Alex.
- `scripts/lib/claims-core.mjs` — `removeClaims()` and `itemsHeldBy()` added.
- `.claude/CLAUDE.md` — the never-release-a-file-claim rule.
- `scripts/claims.mjs` — `--help` says the same.
- `docs/technical-spec-cli-claims.md`, `docs/progress-cli-claims.md`.

Nothing was committed, and none of these scripts has been run in a mode that changes git
state — that is Alex's to do.

**The release-policy inconsistency, fixed.** The spec said file claims are held until
gitpush Finish releases them; every test session released each claim right after editing,
which is the natural reading of "claim, edit, release" and the wrong one. `.claude/CLAUDE.md`
and `claims.mjs --help` now both say it outright, with the reason: a claim released while
the file still has uncommitted changes lets a second thread claim it, which is the exact
collision the system exists to prevent, arriving by the one route nothing checks for.
Database claims keep their just-in-time release and the text says so.

**gitcom** partitions every changed path against the claims file — mine / another
thread's / nobody's. Another thread's is never staged and is listed so the reason is
visible. Nobody's gets Alex an all / none / select prompt, because his own hand edits sit
in the same working tree. It stages explicit paths after `--`; `git add .` appears nowhere
in `scripts/`. It never touches claims.

**gitsync** refuses to run outside a worktree, shows the incoming commits and any dirty
files first, and on conflict names the conflicting files and the `merge --abort` command.

**gitpush** refuses to run inside a worktree or when main is not checked out, lists each
worktree with branch, claims, unpushed commits and dirty count, then Finish / Checkpoint /
skip per worktree, stopping at the first problem. Worktree removal is last so a failure
there leaves the work already safely in main.

**What was actually tested, and what could not be.** Every path that does not change git
state was run: gitsync refusing in the main checkout; gitpush finding no worktrees; gitcom
listing the real working tree and cancelling on an empty answer. A fake `other-thread`
claim on `.claude/settings.local.json` confirmed gitcom puts it under "WILL NOT be
committed" and excludes it; the claim was then cleaned up. `removeClaims` — the only part
of gitpush that can run without git changes — has 11 assertions covering Checkpoint
releasing only named `db:` items, Checkpoint leaving every file claim, Finish releasing
everything including reservations, and another owner's claims never being touched. All
pass. The PowerShell snippet parses with zero errors through
`[System.Management.Automation.Language.Parser]::ParseFile`. The guard suite is still
69/69.

**The commit, merge, push and worktree-removal paths are untested by definition** — they
change git state, so they are Alex's to run.

**One bug found and fixed while testing:** `git status --porcelain` collapses a wholly
untracked folder to a single entry, so `.claude/hooks/` appeared instead of
`.claude/hooks/claims-guard.mjs`, and a claim on the file inside it matched nothing — a
claimed new file would have been offered as if nobody owned it. `changedFiles` now passes
`-uall`.

---

## Step 6, 2026-09-29

**Step 5 verified and complete.** gitcom listed claimed and unclaimed files correctly,
cancel and "n" both left nothing staged, gitsync and gitpush refused correctly in the
main checkout, and the real commit contained exactly the 17 listed files with claims
unchanged afterwards — which is the never-release rule working. Alex installed the
profile as `profile.ps1` (CurrentUserAllHosts), the old functions are gone, and he
pushed.

**Files changed**
- `scripts/git-push-worktrees.mjs` — the main checkout is now a first-class entry.
- `scripts/lib/claims-core.mjs` — `holderOf()` and `partitionByClaims()` moved in.
- `scripts/lib/git-flow.mjs` — `unpushed()`, `describeFile()`, `selectByClaims()`,
  `stageAndCommit()`.
- `scripts/git-commit-claimed.mjs` — now a thin caller of the shared pieces.
- `.claude/CLAUDE.md` — the thread protocol, plus two corrections.
- `docs/technical-spec-cli-claims.md`, `docs/progress-cli-claims.md`.

Nothing was committed.

### The gitpush gap

gitpush listed only worktrees, so work done in the main checkout — which is most of it —
had no route through it. Main could not be pushed this way and **main's claims could only
ever be released by hand**, so they piled up: twelve were sitting there when this started.

Main is now always listed, first, with its branch, unpushed commits against its upstream,
claims and dirty count. Two modes, because there is nothing to merge — the work is
already on main — so the only real choice is what happens to the claims:

- **Push only** — commit by the gitcom rules if anything changed, push, **keep** the
  claims, because the project is still going.
- **Finish** — the same, then release everything main holds.

Finish releases main's `db:` claims along with its file claims, which is what Finish means
for a worktree too; the confirmation lists every item by name before anything happens.

**"The same rules as gitcom" is literal.** The three-way split (mine / another thread's /
unclaimed) and the all-none-select prompt moved into `partitionByClaims` in claims-core
and `selectByClaims` in git-flow, and both commands call them. A promise that two commands
behave identically is only true when it is the same code; gitcom lost about forty lines to
this and reads better for it.

Unpushed commits are counted against `@{u}` for main and against `main` for a worktree,
and a branch that tracks nothing is reported as such rather than as "nothing to push".

### Step 6: the protocol in CLAUDE.md

CLAUDE.md had the claim rules, the never-release rule and the Edit/Write rule, but **not
the protocol** — no Step 0, no plan step, no claim step, no database flow, no mention of
worktrees at all. A thread reading it would have known how to behave once it had claims
and no idea how to get them. Added as a "The thread protocol" section covering owner
detection, Step 0 (push main first, and say so if main has unpushed commits), Step 1
(read-only plan naming every file **and every database item with the step that needs it**,
`check` everything, change nothing, stop), Step 2 (claim **all files in one command** after
confirmation, reserve the database items, always claim the project's `docs/` files), the
just-in-time database flow (check → gitsync → drift check → claim → deploy → verify →
gitpush Checkpoint → release only the `db:` claims), and Finishing via gitpush Finish.

**Two contradictions found and fixed:**

1. Rule 1 lists the git commands a thread must never run, but `gitcom`, `gitsync` and
   `gitpush` now live in this repo. A thread could reasonably read "they are in `scripts/`"
   as "I may run them". Rule 1 now names all three as Alex's, with reading them allowed.
2. "Files you did not touch" said committing was gone so the `git add -A` sweep could not
   happen. True of threads, but `gitcom` commits now. Corrected to: threads still cannot
   commit and gitcom stages named paths, so the sweep has two locks on it — and the
   honest-reporting rule matters *more* now, because gitcom asks Alex about unclaimed
   changes and he can only answer well if the report already said what was the thread's.

Nothing else contradicted: the SQL rule already said Alex runs migrations himself, which
is what the database step says, and "Working fast" is about style, not git.

### Tested

Everything that does not change git state. gitpush now lists main with the right unpushed
count (0 vs origin/main), dirty count and all twelve claims; selecting it offers
push/finish/skip; **Push only** shows "Keep all 12 claim(s)…" and **Finish** shows
"Release all 12 claim(s): …" by name; an empty answer at the confirm cancels and changes
nothing, and `claims.mjs status` and `git status` were identical afterwards. gitcom still
produces the same output after losing its duplicated logic. All four files parse. The
guard suite is still 69/69.

**Untested by definition:** the commit, push and release paths. Those are Alex's.

---

## Step 7d, 2026-09-29 — lock handling, gitnewtree, prompt guard

**The 7c retest passed.** `.gitattributes` gives `eol=lf` with no CRLF in the index;
`check` shows "yours (reserved)"; a fresh worktree `wt-c` claimed and wrote a file with
no `cd`-prefix block; `settings.local.json` stayed clean after a claim approval; `gitpush`
ran from inside `wt-c` and operated on main; Finish committed, merged, pushed and
released. Removal failed because the worktree was **locked** by a still-running
`claude --worktree` session ("lock reason: claude session wt-c") — not an open window.
Unlocking and force-removing worked.

**Files changed**
- `scripts/lib/project-code.mjs` — new. Project codes and run-tag parsing.
- `.claude/hooks/prompt-check.mjs` — new. The `UserPromptSubmit` guard.
- `scripts/git-new-worktree.mjs` — new. `gitnewtree`.
- `scripts/lib/git-flow.mjs` — `listWorktrees` now reports lock state.
- `scripts/git-push-worktrees.mjs` — lock handling; clears main's project code on Finish.
- `.claude/settings.local.json` — `UserPromptSubmit` registered.
- `scripts/powershell-profile-snippet.ps1` — the `gitnewtree` wrapper.
- `.claude/CLAUDE.md`, `docs/technical-spec-cli-claims.md`, `docs/progress-cli-claims.md`.

Nothing was committed and no worktree was created.

### 1. Locked worktrees

`git worktree list --porcelain` reports `locked` and often a reason, and that was being
thrown away. A lock is a different problem from a busy folder: `--force` does not help,
because `claude --worktree` holds the lock for as long as its session is alive. gitpush
now shows `LOCKED <reason>` in the listing, repeats it in the pre-flight warning, and on
failure says so plainly and prints the recovery starting with `git worktree unlock`,
followed by the forced remove and the branch delete — and the `Remove-Item` /
`worktree prune` pair underneath in case the folder is *also* held open. As before this
only ever happens after the merge, push and release have succeeded, so nothing is at
stake but tidying.

### 2. gitnewtree

`gitnewtree <project-code>` is now the front door for Step 0. It refuses while main has
uncommitted or unpushed work — showing exactly what, and saying to run `gitpush` first —
then fetches, creates `.claude/worktrees/<code>` on `worktree-<code>` from `origin/main`,
copies what `.worktreeinclude` names, opens a new VS Code window, and says node_modules
is not there and offers to install it. It shows the plan and waits for a yes.

`claude --worktree` still works and is documented as the alternative. The three
differences are the ones that cost time in the dry run: no Step 0 check, so a worktree
can branch from a stale `origin/main`; the folder name is now the project code the prompt
guard tests against, so it wants choosing deliberately; and missing dependencies used to
be discovered at the first failing command.

The copy is reimplemented because `git worktree add` does not read `.worktreeinclude` —
each pattern goes to `git ls-files --others --ignored --exclude-standard`, the same list
Claude Code matches. Verified read-only: **11 files**, matching what `claude --worktree`
reported in the dry run.

### 3. The prompt guard

A `UserPromptSubmit` hook, because the failure it prevents is silent. A prompt pasted into
the wrong window starts work on the wrong branch and claims files for the wrong owner, and
nothing downstream objects — every one of those actions is legitimate *for the window it
ran in*. There was no check anywhere for the one thing that was wrong.

- A worktree's project code is its folder name, which is also its claims owner.
- Main's is recorded from the first tagged prompt and cleared by gitpush Finish on main,
  in `<git common dir>/alfred-project-code.json` beside the claims file.
- A tag's project code is everything before the last `s<digit>…` segment.

Tagged and matching passes; tagged and mismatched blocks, naming both projects; untagged
short replies pass; untagged and pasted-looking (a `# Your Task` heading, over 400
characters, or four or more lines) blocks and asks; `override:` passes loudly. Prompts
whose `source` is not `user` — loop and schedule wake-ups, SDK, system — always pass,
since blocking machinery would wedge the session. Everything is logged to
`.clip/claims-guard.log` next to the tool guard's lines.

A tag with no step segment cannot be parsed, so it is allowed with a note rather than
blocked — the alternative is refusing an older or hand-written tag with no way to tell
whether it was wrong.

### Tested

Three suites, all passing: **75** tool-guard cases, **14** new prompt-guard cases, **11**
removeClaims assertions. The prompt-guard set covers the first tagged prompt recording
main's code, a matching tag, a mismatched tag, three shapes of short reply, a pasted
prompt with no tag, a 450-character single line, `override:` on a wrong-project prompt,
two machinery sources, an empty prompt, and an old-style tag with no step segment.
gitnewtree was exercised as far as it can be without creating a worktree: no argument,
an invalid code, and the Step 0 refusal against main's real uncommitted state. The
profile snippet parses with zero errors.

**Untested:** actually creating a worktree, and the lock-recovery path. Both are Alex's.

---

## Step 7 RESULT + Step 7c fixes, 2026-09-29

**The dry run passed end to end.** Plan, claim and reserve in wt-a. wt-b's `check`
reported CONFLICT on `shared.md` naming wt-a, and the guard blocked its write. The
database flow claimed and released only `db:` items, leaving the file claims alone.
`gitsync` in wt-b fast-forwarded wt-a's work with no conflict. `gitpush` Finish
committed, merged, pushed and released claims for both worktrees. Final state clean,
main's 12 claims intact. Both worktrees ran in their own VS Code windows using the
Claude panel.

**Step 7 is complete.** Five things it surfaced, all fixed below.

**Files changed**
- `.gitattributes` — new.
- `.claude/hooks/claims-guard.mjs` — the `cd` prefix exception.
- `scripts/claims.mjs` — `check` reports your own reservation.
- `scripts/git-push-worktrees.mjs` — runs from anywhere; worktree-removal handling.
- `docs/technical-spec-cli-claims.md`, `docs/progress-cli-claims.md`.

Nothing was committed.

### 1. Line endings

`* text=auto eol=lf`, plus explicit `binary` for media and fonts, and `-diff` on the
lockfile.

`core.autocrlf=true` turns out to be in **system** config — the Git for Windows installer
default — so every checkout got CRLF in the working tree while the repo stored LF. A
`.gitattributes` overrides it, which is what matters here: nothing in the repo could see
that setting, and every worktree is a separate checkout that has to agree with the others.

LF rather than CRLF, and `eol=lf` rather than bare `text=auto`, because the index is
already **724 of 724 text files LF**; everything that runs this code runs it on Linux
(Vercel, Supabase/Deno); the only Windows consumers are editors and PowerShell, both fine
with LF; and there are no `.bat` or `.cmd` files, the one thing that genuinely needs CRLF.
`text=auto` alone would normalise the repo but still write CRLF into the working tree —
the half that caused the trouble.

**No renormalisation needed.** The index is already LF, so `git add --renormalize .`
stages nothing; confirmed. Of the working tree, 536 files are LF, 178 CRLF and 10 mixed;
git reads all of them as clean either way, and they become LF as they are rewritten. New
checkouts and new worktrees get LF from the start, which is the case that mattered.

**One honest caveat.** I could not reproduce the exact trigger — the worktrees were gone
by the time I looked, and on paper `autocrlf=true` should have cleaned a CRLF working
file back to LF without reporting a difference. What `.gitattributes` does for certain is
make the behaviour deterministic and identical in every checkout, which removes the class.
If a worktree ever shows `.claude/settings.local.json` as modified again, the other
candidate is Claude Code persisting an approved permission rule into it during the
session — a real content change, and one that Finish now warns about before it starts.

### 2. Worktree removal

Finish now says, **before** the confirmation, which folder to close in VS Code, and says
so explicitly when that folder is the terminal gitpush itself was launched from. If plain
removal still fails it tries `--force`, and if that fails too it prints the exact
recovery:

```
Remove-Item -Recurse -Force "<worktree path>"
git -C "<main path>" worktree prune
```

plus the branch delete. Both failures happened for real in the dry run — the plain remove
refused over the line-ending flip, the forced remove hit "Permission denied" from the open
VS Code window — and neither costs any work, since the merge, push and release are all
done by that point. What was missing was saying so, and saying what to type.

### 3. gitpush from any terminal

It no longer refuses inside a worktree. It finds the main checkout as the first entry of
`git worktree list` and operates there, printing "Run from worktree X; operating on the
main checkout." when that applies. `ctx.owner` is pinned to `main` so nothing downstream
can act as the worktree it happened to be launched from. It still refuses when main is not
checked out.

gitcom and gitsync stay local to the checkout they are run in, deliberately — that is what
they mean.

### 4. The `cd` prefix

The guard stripped nothing before checking for chaining, so `cd <checkout> && claims.mjs
claim x` — which Claude panel sessions produce naturally — was blocked as a chained claim.
A leading `cd <this thread's own checkout> &&` is now stripped before the check. Safe
because going where you already are cannot change which claims file is written or which
owner writes it, and the rest of the command is still checked for every other kind of
chaining. A `cd` anywhere else is **not** stripped and stays blocked:
`cd ../other-worktree && claims.mjs claim x` would claim as a different owner, which is
exactly what the rule is for.

### 5. `check` and your own reservation

An item this thread had reserved reported as plain `free`, which reads as though the plan
had never been made. It now reads:

```
yours     db:table:inbox (reserved for Step 5 — not claimed yet)
```

Another thread still sees `warning … reserved by <owner> for <step>`. Neither is a
conflict, so exit codes are unchanged.

### Tested

75 guard cases (up from 69), all passing — seven new ones covering the `cd` rule:
own checkout with backslashes, with forward slashes, `cd .`, a different repo, `cd own &&
claim && echo`, `cd own ; claim`, and `echo && cd own && claim`. Only the first three are
allowed. `removeClaims` still 11/11. `check` verified from both the reserving thread and
another. gitpush re-run from main lists correctly and cancels cleanly; gitcom unchanged.

**Untested:** gitpush launched from inside a worktree, and the worktree-removal recovery
path — both need a worktree, and creating one is Alex's. They are in the verification
steps.

---

## Step 7b, 2026-09-29 — gitpush prompt wording

Before the dry run, three changes.

**1. The mode prompts spell themselves out.** `choose()` in `git-flow.mjs` now takes an
optional `hint` per option, and when any option has one it prints every option on its own
line before asking. These are decisions about pushing and about releasing claims, taken
once in a while; `[f/c/s]` is not something to have to remember.

```
wt-a:
  c  Checkpoint — merge only the files you name into main and push, while the worktree carries on
  f  Finish — commit its work, merge it into main, push, release its claims, and remove the worktree
  s  Skip — leave it alone
```

```
main:
  p  Push — commit and push main's changes, keeping its claims (the project is still going)
  f  Finish — commit and push, then release all of main's claims (the project is done)
  s  Skip — leave it alone
```

**2. Order.** Checkpoint before Finish, Push before Finish. The reversible choice comes
first, so the one that removes a worktree and releases every claim is never the option
sitting under the cursor. The `all / none / select` prompt in gitcom has no hints and is
unchanged.

**3. Phase 0 of the checklist was wrong.** It expected a clean working tree, but the
Step 6 and Step 7 changes — the protocol, the SQL numbering rule, the checklist itself —
were uncommitted. The worktrees branch from `origin/main`, so they would have started
under the *old* rules and the dry run would have proved nothing about the current ones.
Phase 0 now begins with `gitpush` → main → Push, and the three checks confirm the
baseline afterwards rather than assuming it.

Tested by driving `choose()` directly, since there is no worktree yet to show the
worktree prompt: `c`, the full word `finish`, an unrecognised `x` followed by `s`, and
Enter to cancel all behave. The live `main:` prompt renders correctly from `gitpush`, and
gitcom's prompt is unchanged. Nothing was committed and no git state changed.

---

## Step 7, prepared 2026-09-29 — the two-worktree dry run

Step 6 verified: gitpush listed main with correct counts, cancel / Push-only-n /
Finish-n all changed nothing, Finish named all 12 claims and Push only kept them,
gitcom showed the same 7 files, and the real Push only committed exactly those 7,
pushed, and kept the 12.

**Alex runs this. Nothing in it is a CLI thread's to do.** Phase 0 is what gets main
into the state the rest assumes: 12 claims held, working tree clean, nothing unpushed.

The dry run uses three files that nothing holds — `docs/dryrun/wt-a.md`,
`docs/dryrun/wt-b.md`, `docs/dryrun/shared.md` — and two fake database items,
`db:table:dryrun_fake` and `db:deploy`. No migration is written and nothing is
deployed: the database flow is exercised as far as claiming and releasing a `db:`
item, which is the part the claims system is responsible for.

`W` below is the worktree folder: `.claude\worktrees\wt-a` or `...\wt-b`.

### Phase 0 — Step 0, get main pushed first

**This is an action, not just a check.** The claims system's own rules —
`.claude/CLAUDE.md`, the guard, the scripts — are what the two worktrees will run
under, and `claude --worktree` branches from **origin/main**. Anything still sitting
uncommitted here is invisible to them. Start by landing it:

```powershell
cd C:\Users\Alex\projects\alfred-v5
gitpush
```

Pick main, pick **`p`** (Push: keeps the claims — this project is still going), give a
message, approve. Then confirm the baseline:

```powershell
git status --short                      # expect: empty
git log origin/main..HEAD --oneline     # expect: empty
node scripts/claims.mjs status          # expect: main, 12 claims
```

✅ All three, or the worktrees will start from an older main and the rest of this
proves nothing. ✅ The 12 claims are still there — Push keeps them.

### Phase 1 — two worktrees

Two new terminals, one each:

```powershell
cd C:\Users\Alex\projects\alfred-v5
claude --worktree wt-a
```

```powershell
cd C:\Users\Alex\projects\alfred-v5
claude --worktree wt-b
```

In a third terminal, in the main checkout:

```powershell
git worktree list                       # expect: 3 entries
```

In **wt-a**, ask it to run `node scripts/claims.mjs status`.
✅ It must say **`This thread: wt-a`**, and list main's 12 claims. Same in wt-b for
`wt-b`. That is one claims file shared across all three checkouts.

### Phase 2 — plan in wt-a (Step 1, read-only)

Prompt wt-a:

> Step 1 plan only, read-only. The work will create `docs/dryrun/wt-a.md` and
> `docs/dryrun/shared.md`, one line in each. At a later step it will need
> `db:table:dryrun_fake` and `db:deploy`. Run `claims.mjs check` on all four,
> report, and stop. Claim nothing and change nothing.

✅ All four report **free**. ✅ Nothing is claimed and no file is written.

### Phase 3 — claim in wt-a (Step 2)

Prompt wt-a:

> Confirmed. Claim both files in one command, reserve `db:table:dryrun_fake` for
> "Step 5", then write one line into each file.

✅ **Two permission prompts** — one for the claim, one for the reserve. Approve both.
✅ The claim is a single command with both paths, not two commands.
✅ Both files get written, through the Edit/Write tools.

### Phase 4 — wt-b hits the conflict

Prompt wt-b:

> Step 1 plan only, read-only. The work will create `docs/dryrun/wt-b.md` and
> `docs/dryrun/shared.md`. Run `claims.mjs check` on both, report, and stop.

✅ `wt-b.md` is **free**; `shared.md` is **CONFLICT — wt-a holds it**.
✅ The thread stops and asks rather than carrying on.

### Phase 5 — the guard blocks what the check warned about

Prompt wt-b:

> Drop `shared.md`. Claim `docs/dryrun/wt-b.md` and write one line into it. Then, as
> a deliberate test, try to add a line to `docs/dryrun/shared.md`.

✅ One permission prompt for the claim; `wt-b.md` is written.
✅ The edit to `shared.md` is **blocked by the guard, naming wt-a**.
✅ `type .claude\worktrees\wt-b\.clip\claims-guard.log` shows the BLOCK line.

### Phase 6 — the database flow in wt-a, simulated

Prompt wt-a:

> Database step. Run `claims.mjs check` on `db:table:dryrun_fake` and `db:deploy`,
> then stop and ask me to run gitsync.

✅ Both free (the reservation is wt-a's own, so no warning). ✅ It stops.

In the wt-a terminal:

```powershell
gitsync
```

✅ **"Already up to date with main. Nothing to merge."** — correct: nothing has landed
on main since wt-a branched. Phase 8 is where gitsync does real work.

Prompt wt-a:

> Confirmed, no drift. Claim both database items. Treat the deploy as done — do not
> run anything. Then release only the `db:` claims, keeping the file claims.

✅ One prompt for the claim. ✅ `claims.mjs status` afterwards shows wt-a still holding
**both files** and **no db items**. That is the whole rule in one screen: database
claims are released just in time, file claims are not.

### Phase 7 — Finish wt-a

Close the wt-a Claude session first, so the worktree is not in use. Then in the main
checkout:

```powershell
cd C:\Users\Alex\projects\alfred-v5
gitpush
```

✅ Three entries listed: `[1] main`, plus wt-a and wt-b with their claims and dirty
counts. Pick **wt-a's number** (not 1), then `f` for Finish — the prompt spells out
Checkpoint, Finish and Skip on their own lines.
✅ The plan names the two files it will commit and says it will release wt-a's claims,
remove the worktree and delete the branch. Approve, give a message.

```powershell
git worktree list                       # expect: 2 entries, wt-a gone
git log --oneline -3                    # expect: the merge of wt-a's branch
node scripts/claims.mjs status          # expect: main's 12 + wt-b's 1. No wt-a.
```

### Phase 8 — wt-b syncs, then finishes

In the wt-b terminal:

```powershell
gitsync
```

✅ This time it lists wt-a's commit(s) as incoming and merges them. ✅ No conflict —
wt-b never touched wt-a's files, which is the claims system's whole promise.

```powershell
dir docs\dryrun                         # expect: all three files present now
```

Close the wt-b session, then from the main checkout:

```powershell
gitpush
```

Pick wt-b, `f`, approve, give a message.

### Phase 9 — everything cleaned up

```powershell
node scripts/claims.mjs status   # expect: main only, 12 claims. No wt-a, no wt-b.
git worktree list                # expect: 1 entry, the main checkout
git branch                       # expect: main only, no worktree branches
git status --short               # expect: empty
git log origin/main..HEAD        # expect: empty
dir docs\dryrun                  # expect: three files, now on main
```

### Phase 10 — remove the dry-run litter

```powershell
Remove-Item -Recurse -Force docs\dryrun
gitpush
```

Pick main, `p`. The three deletions appear as **claimed by nobody** — answer `a`, give
a message, approve. That also exercises gitcom's unclaimed-file path.
✅ Afterwards `claims.mjs status` still shows main's 12: **Push only keeps claims.**

### What would count as a failure

- A `check` that reports free for a file another worktree holds.
- The guard letting an edit through to `shared.md` from wt-b.
- A claim running with no permission prompt.
- A thread releasing a file claim by itself at any point.
- gitpush Finish leaving wt-a's claims behind, or removing claims that belong to main.
- A merge conflict in Phase 8.

### Notes

**Step 1 discovery, 2026-09-28. Read-only; no files changed except this one.**

**1. `gitcom` / `gitpush`** — defined in
`C:\Users\Alex\OneDrive\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`,
not in the repo (nothing in the repo mentions them). The whole profile is 20 lines.
All three are four-liners: `gitcom` = prompt for message, `git add .`, `git commit`.
`gitcommit` = an exact duplicate of `gitcom`. `gitpush` = the same plus `git push`.
There is no `gitsync`. The profile lives in OneDrive, so edits to it sync to the
Surface.

**2. Hooks** — there is no `.claude/settings.json` and no `.claude/hooks/` folder.
`~/.claude/settings.json` holds no hooks (theme, autoUpdatesChannel,
agentPushNotifEnabled only). Every existing hook is in `.claude/settings.local.json`:
`Notification` and `Stop`, both playing `Windows Ringout.wav` via powershell. That
file **is tracked by git**, so worktrees inherit it. No plugin hooks, no managed
settings. Its `permissions.allow` list contains rules hardcoded to the absolute
path `c:\Users\Alex\projects\alfred-v5`, which will not match a worktree path.

**3. cli-workflow skill** — in the repo at `.claude/skills/cli-workflow/SKILL.md`
(578 lines, tracked). Has the full run-tag machinery and the rule "Never ask the CLI
to commit, push, or run any other git command that changes state", with supabase
deploys explicitly exempted as fine to ask for normally. No mention of worktrees or
claims anywhere.

**4. Git-ignored files a worktree needs**
- Copy: `.env.production.local` (the only root env file — `.env.local` does not
  exist), `workshop/.env`, `supabase/.temp/` (machine-local Supabase link state:
  `linked-project.json`, `project-ref`, `pooler-url`; without it the worktree needs
  `supabase link` before it can deploy a function — `cli-latest` inside it is
  rewritten by any supabase command, which is harmless).
- Rebuild, do not copy: `node_modules/`, `tools/sam-tools/node_modules/`,
  `workshop/.venv/`.
- Auto-generated by `scripts/prebuild.js` on prestart/prebuild, do not copy:
  `src/sam/lib/sam-drill-format.schema.json`,
  `supabase/functions/_shared/sam-drill-format.schema.json`.
- Not needed: `build/`, `coverage/`, `songs/`, `separated/`, `workshop/data/`,
  pycache dirs, `tools/sam-tools/*.json` scratch, `.clip/` (the Write tool creates it;
  its `last-report.md` is another thread's message and must not be copied).
- `CLIPBOARD_URL` / `CLIPBOARD_SECRET` come from the environment or the Windows user
  registry, not a file, so worktrees inherit them.

**5. Git rules in CLAUDE.md** — `.claude/CLAUDE.md` (tracked) is the real one: rule 1
is never run a state-changing git command, it overrides any prompt, "commit and push"
in a prompt does not authorise it, leave everything uncommitted and name the files;
read-only git is wanted; plus the untouched-files rule, all-SQL-in-migrations, the
single-JSON Supabase query form, the Alfred clipboard rule, and the 25-line report
with a measured timing table. The root `.claude.md` (173 lines, lowercase) has since
been deleted by Alex, which resolves discovery conflict 9 below.

**Conflicts between the spec and what is here — all resolved on 2026-09-28**

1. ~~`claude --worktree <name>` does not exist.~~ It does in 2.1.284. Resolved.
2. Branch name `worktree-<name>` is unconfirmed. **Still true** — the spec now reads
   each branch from `git worktree list --porcelain` rather than constructing it.
3. A new worktree starts from `origin/main`, not local HEAD. **Still true** — handled
   by protocol Step 0 (push main first) plus gitsync.
4. ~~`.worktreeinclude` is not a feature of the installed CLI.~~ It is in 2.1.284.
   Resolved.
5. `gitcom` is a rewrite, not an update, and `gitcommit` needed a decision. Resolved:
   both become wrappers over repo scripts.
6. Hooks live in `.claude/settings.local.json`, not a new `.claude/settings.json`.
   Resolved: the PreToolUse entry joins the existing file.
7. `git rev-parse --git-common-dir` returns a relative path. Resolved:
   `--path-format=absolute`, implemented and tested from a subfolder.
8. A hook entry is a shell command. Resolved: `node .claude/hooks/claims-guard.mjs`.
9. ~~The root `.claude.md` contradicts rule 1.~~ Alex deleted it. Resolved.
10. The cli-workflow skill's supabase-deploy carve-out. Resolved: Step 8 amends it.
