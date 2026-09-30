# Progress: CLI claims follow-ups

Spec: [technical-spec-claims-followup.md](technical-spec-claims-followup.md). Thread:
`claims-followup`. Solo on main — no worktrees.

**Status: Step 10 written, awaiting the worktree proof. Step 9's `db:` claims are
released; the 30 file claims stay.**

- [x] **1. Plan.** Read-only. All 33 items free, no conflicts. Six corrections reported.
- [x] **2. Claim and write the docs.** 30 files claimed; `db:fn:clip-capture`,
      `db:fn:mcp` and `db:deploy` reserved for Step 9.
- [x] **3. Items 1 + 3 — popups and `db:deploy` hygiene.** Verified 2026-09-30: 27
      tests passing, `status` shows 30 claims and 3 reservations with no warning.
- [x] **4. Item 12 — guard false positives.** Verified 2026-09-30: 33 tests passing,
      `src/Alfred.jsx` untouched.
- [x] **4b. The PowerShell bypass.** Found at Step 4, fixed on Alex's instruction.
      Verified 2026-09-30 in a fresh session: PowerShell calls now reach the guard.
- [x] **4c. Is a subagent guarded?** Yes. Verified 2026-09-30, and found that the
      prompt guard was eating subagent reports.
- [x] **4d. The prompt guard and machine traffic.** Fixed and verified live
      2026-09-30; 48 tests passing. Verified by Alex 2026-09-30 — the live
      subagent run was the check.
- [x] **5. Items 5 + 8 — no prompt throws away an answer.** Verified by Alex
      2026-09-30: 61 passing, and a real `gitpush → main → Push` with a blank
      message committed as `claims-followup: push 2026-09-30`, pushed, and kept
      all 30 claims.
- [x] **6. Item 9 — parameters for the four git commands.** Verified by Alex
      2026-09-30 and pushed: 67 passing, every bad command line refused clearly,
      both probe runs stopping at the final `[y/N]`.
- [x] **7. Item 4 — `bind`/`unbind`, and hook tests on a scratch log.** Verified
      by Alex 2026-09-30 and pushed.
- [x] **8. Item 2a — underscores, local half.** Verified by Alex 2026-09-30 and
      pushed: 78 passing, `Bad_Code` refused, `parallel_threads` accepted.
- [x] **9. Item 2b — underscores, Alfred half. DATABASE STEP.** Verified by Alex
      2026-09-30 and pushed: `run_tag_prefix claims_test` returns exactly the
      test clip. Both functions deployed; all three `db:` claims released.
- [x] **10. Items 7 + 11 — what a fresh worktree needs to build, deploy and test.**
      Written and checked in main; the worktree proof is Alex's.
- [ ] **11. Items 6 + 10 — skill layout, fresh-conversation note, full suite.**

---

## Step 1, 2026-09-30 — plan

Read-only. Claims check on 30 files and 3 database items: all free, nothing held by
anyone, claims file empty. Main was already bound to `claims-followup`.

Six things in the spec did not match the code. Alex confirmed all six.

1. **Underscores break `run_tag_prefix`.** `_` is a wildcard in SQL `LIKE`, and
   `clipboard.ts` relies in writing on the tag alphabet not containing one. Step 9
   escapes it. Not in the original spec.
2. **Item 11's cause** — see the correction below.
3. **Item 12 pulls against the rule it sits on.** Alex chose the stricter version:
   keep `mv`, `cp`, `tee` and `sed -i` strict, relax only a plain `>`/`>>` whose target
   resolves outside the repo.
4. **The two harmless blocks have a smaller cause too:** `writeIndicator` reads the
   `-ln` of `git grep -ln` as the `ln` command, and the `-i` of a piped `grep -i` as an
   in-place `sed`. Hit three times while planning.
5. **Item 7's premise is half right.** The schema copies are ignored to stop them
   drifting from the root master, which is a good reason to keep ignoring them, so
   `gitnewtree` runs `prebuild.js` instead. `.env.production.local` holds only the two
   build stamps, so regenerating it is safe; `.worktreeinclude` calls it "Supabase
   credentials", which is wrong — they are hardcoded in `src/supabaseClient.js`.
6. **The database protocol assumes a worktree.** `gitsync` refuses on main, so Step 9
   uses `gitpush` → main → **Push only**, which keeps main's file claims.

### Correction to Step 1: item 11's cause

**I got this wrong in the Step 1 report and Alex's original diagnosis was right.** I
said the `.claude` path could not be the cause because jest's testMatch globs matched
fine with `.claude` in the path. I had tested with forward slashes, which is not what
jest produces on Windows.

Reproduced properly against the installed jest and picomatch:

```
root : C:\Users\Alex\projects\alfred-v5
glob : C:/Users/Alex/projects/alfred-v5/src/**/*.{spec,test}.{js,jsx,ts,tsx}
match: true

root : C:\Users\Alex\projects\alfred-v5\.claude\worktrees\rem-j7p
glob : C:/Users/Alex/projects/alfred-v5\.claude/worktrees/rem-j7p/src/**/*...
match: false
```

`replacePathSepForGlob` is `path.replace(/\\(?![{}()+?.^$])/g, '/')` — it keeps a
backslash that precedes `.`, because that looks like a deliberate escape. So the
separator before `.claude` survives into the glob as an escape, the pattern means
`alfred-v5.claude`, and nothing matches. The rootDir-free globs in the spec match in
both checkouts. `testMatch` is on CRA's supported-override list, so `package.json` can
carry the fix.

---

## Step 2, 2026-09-30 — claim and docs

**Files changed**

- `docs/technical-spec-claims-followup.md` — new.
- `docs/progress-claims-followup.md` — new, this file.

30 files claimed for `main` in one command, run tag `claims-followup-s2-m3jc`.
`db:fn:clip-capture`, `db:fn:mcp` and `db:deploy` reserved for Step 9.

Nothing was committed.

---

## Step 3, 2026-09-30 — fewer popups, and `db:deploy` hygiene

**Files changed**

- `scripts/lib/claims-core.mjs` — new `parseClaimsCommand`, `claimsCommandApproval`,
  `isChained`, `DB_CLAIM_STALE_MS`, `staleDbClaims`.
- `.claude/hooks/claims-guard.mjs` — the approval rule reads the command's items;
  `checkApprovalBypass` became `checkClaimsCommand`.
- `.claude/settings.local.json` — `claim` and `reserve` allow-listed.
- `scripts/claims.mjs` — `status` flags stale `db:` claims; `USAGE` rewritten.
- `scripts/git-push-worktrees.mjs` — Checkpoint releases `db:` claims by default.
- `scripts/lib/claims-core.test.mjs` — new, 11 tests.
- `.claude/CLAUDE.md` — the two rules rewritten.
- `.claude/skills/cli-workflow/SKILL.md` — the same two rules.

### What changed, and why it is safe

**The approval rule reads the items, not just the subcommand.** `claims.mjs claim a b c`
is silent; `claims.mjs claim a db:deploy` prompts. `reserve` never prompts — a
reservation blocks nothing. `cleanup <another owner>` prompts; `cleanup <this thread>`
does not, because it is `release --all` under another name.

The **chained-command block is untouched**. A claim chained onto anything else is still
refused whether or not it would have prompted, because chaining is how a claim hides
behind a rule that approved something else. That is now the load-bearing check for the
silent claims, so it is tested directly rather than left implicit.

`claim` and `reserve` are allow-listed in `.claude/settings.local.json`. A `PreToolUse`
hook returning `permissionDecision: "ask"` still overrides an allow rule, which is what
keeps `db:deploy` prompting.

**Checkpoint releases `db:` claims by default.** The question is still asked, so one can
be kept deliberately, but the blank answer flipped from "none" to "all", and the plan
now names any it is about to keep. `status` marks any `db:` claim older than an hour and
explains why that matters.

### Verified

11 unit tests in `claims-core.test.mjs`, and the guard driven with eleven hand-made
payloads: claiming files is silent, `claim db:deploy` asks, `--note "db:deploy later"`
does not, `reserve db:deploy` is silent, `cleanup main` is silent, `cleanup
ghost-thread` asks, a chained claim is blocked, `cd <own root> &&` is still stripped,
and a claim built with `$(…)` asks because it cannot be read.

**Not covered by a test:** the `⚠` line `status` prints for a stale `db:` claim. The
predicate behind it is tested; the formatting is not, because `cmdStatus` needs a real
git checkout and a claims file to reach. Left as it is rather than restructuring
`claims.mjs` for it in this step.

Nothing was committed.

---

---

## Step 4, 2026-09-30 — the guard's false positives

**Files changed**

- `scripts/lib/claims-core.mjs` — `WRITE_INDICATORS` split into
  `COMMAND_INDICATORS` plus a new hand-written `scanRedirects`; new `writeIndicators`,
  `writeCheck` and `expandVars`.
- `.claude/hooks/claims-guard.mjs` — asks `writeCheck` what counts, rather than
  pairing one indicator with every repo path the command names.
- `scripts/lib/claims-core.test.mjs` — 6 more tests, 33 in the folder overall.
- `.claude/hooks/prompt-check.mjs` and the guard — both strip a leading BOM from the
  payload, so a hook can be hand-tested by piping JSON to it from PowerShell. Without
  it every such check answered "could not parse the hook payload" and proved nothing.

### Three separate bugs, three separate fixes

**1. A flag is not a command.** `\bln\b` matched the `-ln` of `git grep -ln`, because
`\b` sits happily between a hyphen and a letter — and `\bsed\b[^|]*\s-i\b` crossed a
`;` to find `grep -i` in the next command. Now every command indicator carries
`(?<![-\w])`, and the in-place rule uses `[^|;&\n]*` so it cannot leave its own
command. This one had hit three times in the two hours before the fix.

**2. A `>` inside quotes is not a redirect.** Redirections are now found by a
hand-written scanner that tracks quote state one character at a time, because "is this
`>` inside quotes" is precisely what a regex cannot answer. It also skips fd
duplication (`2>&1`, `>&2`) and the `=>` of inline JS, and it honours a leading fd
number — `cmd 2> errors.txt` does write `errors.txt`, which the old regex missed.

**3. A redirect out of the repo is not a write to the repo.** Alex's decision of
2026-09-30: keep `mv`, `cp`, `tee` and `sed -i` strict, relax only a plain `>` or `>>`
whose target resolves outside the repo. So `writeCheck` has two rules — a redirection
names its own destination and is judged on it alone; anything else is judged on every
repo path the command mentions, unchanged. `$TEMP` and `%TEMP%` in a target are
expanded from the environment first; what stays unexpanded is treated as outside the
repo, because a variable this process cannot resolve is one the shell cannot resolve
either, so it expands to nothing and lands at the filesystem root.

**The `mv` is why rule 3 cannot go further.** The 2026-09-28 breach redirected to
`/tmp` — which rule 3 now allows on its own — and then moved the result over
`src/utils/recurrence.js`. The `mv` is the only thing that catches it, and a test pins
that.

### Verified

33 unit tests pass. The live hook was driven with 15 write payloads: the six known
false positives allow, a redirect to `$TEMP` and to `/tmp` allow, a redirect to an
exempt path allows, a redirect to a claimed path allows, and a redirect to an
**unclaimed** path plus `mv`, `cp`, `tee`, `sed -i` and the breach command all block.
The three commands the guard had actually blocked in this session were then re-run for
real and all three worked.

Nothing was committed.

---

## Step 4b, 2026-09-30 — the PowerShell bypass

Found while writing Step 4's verification steps: this session has a **`PowerShell`**
tool beside `Bash`, the hook matcher did not name it, and the guard read a command only
when the tool was `Bash`. Every shell-write rule and the Supabase deploy gate were
skipped by using the other tool. `.clip/claims-guard.log` held 2,355 decisions and not
one PowerShell call; a `Move-Item` over an unclaimed file went through unopposed.

**Files changed**

- `.claude/settings.local.json` — matcher now ends `|Bash|PowerShell`.
- `.claude/hooks/claims-guard.mjs` — a `SHELL_TOOLS` map replaces the `=== "Bash"`
  tests, so the command is read, and which shell it is gets passed down.
- `scripts/lib/claims-core.mjs` — PowerShell aliases, per-shell escape character,
  `-Name:Value` parameters, comma-separated path arrays, extensionless backslash paths.
- `scripts/lib/claims-core.test.mjs` — 9 more tests, 42 in the folder.
- `.claude/CLAUDE.md` — a new rule: when the guard blocks something, stop and ask.

### Adding the tool to the matcher was not the fix, only half of it

The rules were written for Bash syntax and had to be taught PowerShell's:

- **Aliases.** `mv`, `cp`, `rm` were already matched, but `mi`, `ci`, `ni`, `sc`, `ac`,
  `del`, `move`, `copy`, `rd` were not. These are applied **only to a PowerShell command
  and only at a command position**, because they are short enough to be anything —
  `CI=true npx react-scripts test`, this project's own test command, starts with what a
  loose case-insensitive `ci` would call a copy. A test pins that it does not.
- **The escape character is different.** Bash escapes with `\`, PowerShell with a
  backtick, and PowerShell paths are full of backslashes. Reading `C:\tmp\` with Bash
  rules loses the quote state and with it the redirect that follows.
- **Parameters.** `-Path`, `-Destination` and `-LiteralPath` were already skipped as
  flags with their values read as paths, but `-Destination:src\x.js` hid the path
  inside the flag, and `-Path a,b` hid two paths in one token.
- **Extensionless backslash paths.** `Remove-Item -Recurse src\sam\lib` named no path
  the old heuristic recognised, because it demanded a `/` or a file extension.

The outside-the-repo rule is unchanged and now applies to both: a plain `>`/`>>` — or
PowerShell's `*>` — is judged on its destination, everything else on every repo path
the command names. `$null` joins the sinks, since `2>$null` ends half the PowerShell we
run. The Move-Item form of the 2026-09-28 breach is pinned by a test, and blocks for the
same reason the `mv` form does.

### Other tools that can change files

| Tool | Watched? |
|---|---|
| `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | yes, in the matcher |
| `Bash` | yes |
| `PowerShell` | **now yes** |
| **Subagents (`Agent`)** | **unverified — see below** |
| `Artifact` with `action: "read"` and `out_dir` | no. It saves a published file to a chosen directory, which can be inside the repo. Permission-gated, not claims-gated. |
| `EnterWorktree` | no. Creates a git worktree, so it both changes git state and creates files. |
| MCP write tools (`mcp__claude_ai_Alfred__create_*`, `update_*`, …) | no, and this is pre-existing: they change database rows with no `db:table:*` check. The guard only gates `supabase functions deploy` and `supabase db push`. |

**The subagent question is the one that matters and I could not answer it.** If
`PreToolUse` hooks do not run for a subagent's tool calls, then `Agent` is a complete
bypass of everything above — and the log cannot say, because no subagent has run in a
guarded session. Testing it means spawning one, which is outside what this step was
asked to do. Recommended check is in the Step 4b report.

### Verified

42 unit tests pass. The live hook was driven with 19 PowerShell payloads: reads,
`2>$null`, a redirect to `$env:TEMP` and a write to a *claimed* path all allow;
`>` into an unclaimed file, `Move-Item`, `Copy-Item`, `Set-Content`, `Add-Content`,
`Out-File`, `New-Item`, `Remove-Item`, the `mi`/`del`/`sc` aliases, the `-Name:Value`
form, the Move-Item breach, and `npx supabase functions deploy mcp` all block. The Bash
drivers from Steps 3 and 4 were re-run with no change.

### Verified in a fresh session, 2026-09-30

The building session could only test itself, and a hook matcher is read when a
conversation starts. A fresh conversation confirms the matcher is live: every
`PowerShell` call in it appears in `.clip/claims-guard.log`, where before the fix
2,355 decisions contained not one. The line reads `owner=?` for a read-only
command — the guard returns at `!filePath && !deploying && !indicator` before it
resolves the owner — so `owner=` is not the signal; the presence of a
`PowerShell` line at all is.

Also verified on the rules rather than the guard: two planted commands,
`Set-Content` into `src/guard-test.txt` and `npx supabase functions deploy`, were
refused before being run. That is CLAUDE.md working, not the guard — the guard
had already blocked both forms from the building session's payloads.

Nothing was committed.

---

## Step 4c, 2026-09-30 — subagents are guarded

**Subagents are guarded. `Agent` is not the bypass Step 4b feared.**

One `general-purpose` subagent was told to make a single `Write` to
`docs/guard-subagent-test.md`, a path no thread has claimed, and not to claim it
or retry. The log:

```
2026-09-30T15:59:06.506Z  BLOCK  Write  owner=main  unclaimed: docs/guard-subagent-test.md
```

The file was not created, and `git status` shows nothing new. So `PreToolUse`
fires for a subagent's tool calls, the owner resolves the same way, and every
rule built in Steps 3, 4 and 4b applies inside one.

The Step 4b table's `Agent` row can be marked **yes**.

### But prompt-check eats subagent messages

The subagent's report never arrived, either on its first run or when it was
resumed to restate one line. Three `BLOCK Prompt` lines appeared in those two
minutes, none of them anything Alex typed:

```
15:59:15  BLOCK  Prompt  untagged, looks pasted (1644 characters)
16:00:01  BLOCK  Prompt  untagged, looks pasted (543 characters)
16:00:01  BLOCK  Prompt  untagged, looks pasted (879 characters)
```

`prompt-check.mjs` exempts `source !== "user"`, and these arrive as `user`. It
has no notion of a subagent, and `looksPasted` blocks anything over 400
characters, four lines, or carrying a `# Your Task` heading — which is every
substantive agent prompt or report. The parent is told nothing: the tool result
says the report was delivered, and it was not.

**Inferred, not proven:** that these three lines are the subagent's handbacks is
the only reading consistent with the timing and the character counts, but the
hook does not record enough of the payload to say for certain.

**Proposed fix, not implemented.** One line in `prompt-check.mjs`'s `log()` to
dump the payload's top-level keys, one throwaway subagent, and the field that
identifies a subagent prompt is known — then exempt it beside the existing
`source` test, and pin it with a test on the scratch log from Step 7. Until that
is done, a subagent in this repo works but cannot report, so do not rely on one.

Nothing was committed.

---

## Step 4d, 2026-09-30 — the prompt guard and machine traffic

**Files changed**

- `scripts/lib/project-code.mjs` — new `machineEnvelope`; `classifyPrompt` gained
  a `machine` field.
- `.claude/hooks/prompt-check.mjs` — allows a machine envelope; `log()` honours
  `CLAIMS_GUARD_LOG` so the tests do not write the real log.
- `scripts/lib/hooks.test.mjs` — new, 6 tests. 48 in the folder overall.
- `docs/progress-claims-followup.md` — this.

### There is no field. The marker is in the prompt text.

Step 4c proposed finding the payload field that identifies a subagent. Three
throwaway subagents and a payload dump later: **there isn't one.** What arrives is

```
session_id      aa2bc90b-…   ← this session's, not the subagent's
transcript_path …/aa2bc90b-….jsonl
cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name
prompt          "<agent-message from=\"ad3b77bf…\">\n[Subagent hand-back] …"
```

No `source` — it defaults to `"user"` — and `session_id` is the **parent's**,
because the hand-back is delivered into the parent's conversation, not the
subagent's. Nothing outside the text distinguishes it from Alex typing.

So the check is on the text: an envelope tag — `agent-message`,
`cross-session-message`, `task-notification` — at the very start of the **raw**
prompt. `agent-message` is the one observed; the other two are named from the
SendMessage and background-task docs and are unverified, but they arrive the same
way and would break the same way.

**Anchored on the raw prompt, deliberately not on the paste-unwrapped text.** A
real envelope is never pasted, so an envelope inside a `<pasted_content>` wrapper
is someone typing the shape of one, and stays blocked. The hand-back's own frame
makes the matching promise from the other side: the harness indents every line of
the report, so a frame at column zero within it would be forged. A test pins both
directions.

### Verified

48 tests pass, 6 of them new: the envelope is recognised, an envelope that is
indented, prefixed or pasted is not, a hand-back passes the live hook although it
is long and untagged, **a pasted untagged "# Your Task" prompt is still blocked**,
a forged envelope inside a pasted prompt is blocked, and short replies and
`override:` still pass. Every one drives the hook as a process over stdin, writes
to a scratch log, and asserts the real log and the real `.git/alfred-project-code.json`
were untouched.

Then live, which is the real proof: a subagent was run and **its report arrived**,
with `ALLOW Prompt machine envelope <agent-message>` in the log where the three
blocks were.

**Still to do in Step 7:** `claims-guard.mjs` has the same hard-coded log path and
no `CLAIMS_GUARD_LOG` yet, and neither hook's tests point the binding file
somewhere scratch — these tests avoid the write path rather than redirecting it.

Nothing was committed.

---

## Step 5, 2026-09-30 — no prompt throws away an answer

**Files changed**

- `scripts/lib/git-flow.mjs` — new `parseSelection`, `askSelection`, `today`,
  `defaultMessage`, `askMessage`; `choose` re-asks on blank and takes an opt-out;
  `ask` ends the run at EOF.
- `scripts/git-commit-claimed.mjs` — default commit message.
- `scripts/git-push-worktrees.mjs` — the shared parser at all three list prompts,
  default message in all three modes.
- `scripts/lib/git-flow.test.mjs` — new, 13 tests. 61 in the folder overall.
- `docs/progress-claims-followup.md` — this.

### The audit

Every numbered and yes/no prompt in the four commands, and what a blank did:

| Where | Was | Now |
|---|---|---|
| `gitcom` unclaimed all/none/select | cancelled the run | re-asks |
| `gitcom` commit message | cancelled the run | `<code>: commit <date>` |
| `gitpush` which checkout | cancels | **cancels** — the prompt says so |
| `gitpush` mode (per checkout) | Skip, silently | Skip, and the Skip line says enter does it |
| `gitpush` main unclaimed files | cancelled | re-asks (same shared code as gitcom) |
| `gitpush` main / Finish / Checkpoint message | cancelled, *after* the final yes | default message |
| `gitpush` Checkpoint paths | cancelled | asks "commit all N?", then cancels if he says no |
| `gitpush` Checkpoint db release | release all | unchanged, that was Step 3 |
| `gitsync` merge? | no | unchanged — a final yes/no |
| `gitnewtree` do all / npm install / open window | no | unchanged — final yes/no, and both print the manual command |

Only one blank still cancels: gitpush's first question, which is asked before
anything has been decided, so there is no earlier answer for it to throw away.
The final yes/no in each command stays a yes/no defaulting to no.

### The parser

`parseSelection(answer, count)` takes `a`/`all`, numbers, ranges (`1-4`, and
`4-1` the same way), `1,2,3`, and anything else as a literal word — a path, or
now a checkout name at gitpush's first prompt. Out-of-range numbers come back in
`bad` rather than being dropped, so a typo gets answered instead of quietly doing
something smaller than asked. Commas split only when every part is numeric, so a
path containing one survives.

### The one that is not in the spec: EOF

Making `choose` re-ask on blank turns a closed stdin into an infinite loop — it
is handed `""` forever and asks forever. So `readLineSync` now tells "he pressed
enter" apart from "there is no input", and `ask` ends the run on the second.
Without it, `gitpush </dev/null` would spin a core rather than stop. A test pins
it, and the four commands were each run with stdin closed: all four stop at their
first prompt, having changed nothing.

### Verified

61 tests pass, 13 new. The interactive ones drive git-flow as a child process
with a scripted stdin, because what is under test is what the loop does with an
empty answer, not what the parser does with one.

Not covered by a test, and it cannot be from here: the three prompts inside
`doCheckpoint` and `doFinish` need a live worktree, and running either for real
would merge and push. The shared pieces they call are all tested; the wiring is
Alex's verification.

Nothing was committed.

---

## Step 6, 2026-09-30 — parameters, so each command is one pasted line

**Files changed**

- `scripts/lib/git-flow.mjs` — new `parseArgs`, `exclusive`, `resolveUnclaimed`,
  `UsageError`; `selectByClaims` takes an `include` answer instead of asking.
- `scripts/git-push-worktrees.mjs` — `<checkout> <mode>` and six options.
- `scripts/git-commit-claimed.mjs` — `--include-unclaimed`, `--message`.
- `scripts/git-sync.mjs` — `--help`, and it refuses anything else.
- `scripts/git-new-worktree.mjs` — `--install` / `--no-install`.
- `scripts/powershell-profile-snippet.ps1` — comments only; it already forwarded
  `$args`, so no profile edit is needed.
- `scripts/lib/git-flow.test.mjs` — 6 more tests, 67 in the folder overall.
- `docs/progress-claims-followup.md` — this.

```
gitpush rem-j7p checkpoint --paths supabase/migrations/084_x.sql --release-db
gitcom --include-unclaimed none --message "step 5: the answer parser"
gitnewtree parallel_threads --install
```

### There is no --yes, and the spec asked for one

Item 9's example lines include `gitsync --yes` and `gitnewtree … --yes`, and the
sentence under them says a parameter "answers a question, it does not skip the
confirmation". Those cannot both hold: the only question `gitsync` asks *is* the
confirmation. Alex's Step 6 instruction settles it the same way — "always asks
one final yes/no, even when every parameter is given" — so **no command has a
`--yes`**, and `gitsync` has no parameters at all beyond `--help`. It now refuses
`--yes` by name rather than ignoring it.

### Unknown means unknown

An unrecognised option stops the command with exit 2 before anything runs, and
so does a third positional, a missing value, and a contradictory pair
(`--all` with `--paths`, `--release-db` with `--keep-db`, `--install` with
`--no-install`).

So does an option the chosen mode will not read — `--release-db` on a Push,
`--paths` on a Finish — checked however the mode was chosen, because Alex can
name one on the command line and pick another at the prompt. A silently ignored
`--relese-db` would mean db claims held across steps with nothing to say why,
which is the thirteen-hour bug wearing a typo.

`--paths` and `--include-unclaimed` are checked against the working tree too: a
path that is not a change here is an error, not a quiet omission. Interactively
the same mistake still asks "carry on without them?", because at a prompt it is
a slip to correct rather than an instruction that was already wrong when pasted.

### Verified

67 tests pass, 6 new, covering the pasted shape, lists, `--flag=value`, aliases,
unknown options, extra positionals and the exclusive pairs.

Run for real, all stopping before they could change anything: `--help` on each;
`--relese-db` refused; `main checkpoint` refused; `--release-db` on a push
refused; `--yes` refused by gitsync; `--install --no-install` refused; and
`gitpush main push --message "probe"` printing its full plan and stopping at
`Do all of that? [y/N]`, which is the rule the whole step turns on.

Nothing was committed.

---

## Step 7, 2026-09-30 — bind/unbind, and tests that cannot touch the real thing

**Files changed**

- `scripts/claims.mjs` — `bind <code>` and `unbind`; `USAGE`; neither argument
  is normalised as a path.
- `scripts/lib/project-code.mjs` — `CODE_SHAPE`; `projectFile` honours
  `CLAIMS_PROJECT_FILE`.
- `.claude/hooks/claims-guard.mjs` — `log()` honours `CLAIMS_GUARD_LOG`.
- `.claude/hooks/prompt-check.mjs` — both block messages name bind and unbind.
- `.claude/CLAUDE.md` — the project-code paragraph now mentions them.
- `scripts/git-push-worktrees.mjs` — the two small fixes below.
- `scripts/lib/hooks.test.mjs` — 4 more tests, 71 in the folder overall.
- `docs/progress-claims-followup.md` — this.

### bind and unbind

The main checkout's code could only be set by the first tagged prompt of a
project and cleared by `gitpush` Finish. Neither helps in the case that actually
happens: main is bound to a finished project, the next prompt is for a new one,
the guard blocks it correctly and says nothing about what to do. Both block
messages now name the commands, and only in the main checkout — inside a
worktree the code is the folder name, and the message says so instead.

Neither touches a claim, and both say so in their output. They are silent at the
permission layer for the same reason `reserve` is: `claimsCommandApproval` asks
about `claim db:deploy` and `cleanup <someone else>`, and an unrecognised
subcommand is not one of those.

### Scratch copies, and the test that proves it

`CLAIMS_GUARD_LOG` and `CLAIMS_PROJECT_FILE` override the two files either hook
writes. The binding is the one that mattered most: the prompt guard *writes* it
on the first tagged prompt of a project, so a test driving that path would have
rebound Alex's own window — and until now the only reason it never did was that
no test drove that path.

Every hook-driving test goes through one `drive()` helper that points both
overrides at a fresh temp folder and, after the call, asserts the real
`.clip/claims-guard.log` and the real `.git/alfred-project-code.json` are byte
for byte what they were. On top of that, one test runs **the whole suite as a
child process** and makes the same assertion across all of it; the child sets
`HOOKS_TEST_CHILD=1` and that one test skips itself, which is what stops it
recursing. Checked by hand that the child really runs the suite: 71 tests, one
skipped.

### Two gitpush fixes

**A refusal now comes before the listing.** `gitpush main checkpoint` printed
thirty lines of checkout detail and then refused, which reads as though
something happened. The checkout name and the mode are resolved and checked
first, so the refusal arrives on its own. `gitpush checkpoint` — a mode where a
checkout belongs — now says so rather than reporting an unknown checkout.

**Claims are a count.** `claims  30 — claims.mjs status for the list` instead of
thirty paths that pushed the question itself off the screen.

### Verified

71 tests pass, 4 new. `bind`/`unbind` exercised against a scratch binding file —
set, switched, cleared, cleared again — with the real one unchanged afterwards,
and their four refusals (no code, bad code, argument to `unbind`, and a
worktree) checked by hand.

Nothing was committed.

---

## Step 8, 2026-09-30 — underscores in project codes, local half

**Files changed**

- `scripts/lib/project-code.mjs` — `TAG_SHAPE`, `CODE_SHAPE`, `tagInPrompt`'s
  character class; new `CODE_FORMAT`, one sentence every refusal now quotes.
- `scripts/git-new-worktree.mjs` — its own `CODE` regex deleted; it uses
  `CODE_SHAPE` and `CODE_FORMAT`.
- `scripts/claims.mjs` — `bind`'s refusal quotes `CODE_FORMAT`.
- `scripts/clip.mjs` — `TAG_PATTERN`, the `--help` text and the refusal.
- `scripts/lib/project-code.test.mjs`, `scripts/lib/hooks.test.mjs` — 7 more
  tests, 78 in the folder overall.
- `docs/progress-claims-followup.md` — this.

`parallel_threads-s5-f2mz` parses as `parallel_threads` + `s5` + `f2mz`. The
underscore is part of the NAME; the three separators are still hyphens, and the
step and the random suffix still take no underscore. `dj_weekly-review-s3b-k9m1`
— both kinds in one name — parses as `dj_weekly-review`.

**Three regexes became one.** `git-new-worktree.mjs` had its own copy of the
code rule and `claims.mjs` had its own wording of the refusal, for a string that
is the folder name, the claims owner and the tag's first segment all at once.
They now share `CODE_SHAPE` and `CODE_FORMAT`, so this item changed one place
instead of three and the next one will too. `clip.mjs` keeps its own alphabet
check on purpose: it runs before anything is parsed, and it is the last thing
between a mangled tag and the clipboard.

### ⚠ The Alfred side rejects an underscore tag today

Read-only check of the three files Step 9 owns. **Do not use an underscore run
tag until Step 9 is deployed.**

| Where | Rule | What happens today |
|---|---|---|
| `clip-capture/index.ts:405` | `/^[a-z0-9-]{1,40}$/` | the tag is **dropped to null** and the clip is stored untagged |
| `_shared/tools/clipboard.ts:221` | the same, on `run_tag` | `get_recent_clips` errors |
| `_shared/tools/clipboard.ts:231` | the same, on `run_tag_prefix` | the same |

**The first one is the dangerous one, and it is silent from this end.**
`clip.mjs` prints the tag it *sent*, not the tag the server stored, so a push
under an underscore tag would report `run tag: parallel_threads-s5-f2mz` and
have saved a clip with no tag at all. The report would then be unfindable by tag
— exactly the failure the tags exist to prevent.

Also waiting for Step 9, and not a rejection but a silent wrong answer:
`clipboard.ts:265` filters a prefix with `.like(…, prefix + "%")`, and `_` is a
single-character wildcard in SQL `LIKE`. Once underscores are real,
`parallel_threads` as a prefix would also match `parallelXthreads`. The comment
beside it promises the tag alphabet cannot smuggle one in; Step 9 escapes the
prefix and rewrites that comment.

**`.claude/skills/cli-workflow/SKILL.md` was deliberately left alone.** It tells
claude.ai "hyphens, never underscores", which is still the correct instruction
until the Alfred half is live. It flips in Step 9, with the deploy.

### Verified

78 tests pass, 7 new: the underscore forms, a name with both kinds, every
existing hyphenated tag unchanged, the malformed ones still malformed, an
underscore refused in the step and in the suffix, `CODE_SHAPE` accepting and
refusing, `clip.mjs` taking an underscore tag (driven with `--help`, so nothing
is pushed) and still refusing a bad one, and the live prompt guard letting
`parallel_threads-s5-f2mz` into a window bound to `parallel_threads` while
`parallel-threads-…` is blocked as a different project.

By hand: `gitnewtree parallel_threads` gets past the code check, and `Bad_Code`
and `_bad` are refused with the new one-line description.

Nothing was committed.

---

## Step 9, 2026-09-30 — underscores, Alfred half. DATABASE STEP.

**Files changed**

- `supabase/functions/clip-capture/index.ts` — the stored tag's alphabet.
- `supabase/functions/_shared/tools/clipboard.ts` — one `TAG_ALPHABET` for
  `run_tag` and `run_tag_prefix`; `escapeLike` before the `LIKE` filter.
- `supabase/functions/mcp/index.ts` — both tag descriptions.
- `scripts/clip.mjs` — prints the tag the SERVER stored, and warns on a mismatch.
- `docs/progress-claims-followup.md` — this.

### The prefix had to be escaped, not just allowed

`_` matches any single character in SQL `LIKE`, so `parallel_threads` as a
prefix would have returned `parallelXthreads` too — another thread's reports,
looking exactly like yours. `escapeLike` escapes `\`, `%` and `_` before the
pattern is built. A hyphenated prefix comes out byte for byte identical, which
is what keeps every existing tag working.

### clip.mjs was reporting its own intentions

It printed the tag it SENT. The function validates the tag and stores null if it
does not like it, so an underscore tag was reported back as saved while the clip
carried none — and the report was then unfindable by tag, with nothing anywhere
to say why. It now prints what came back in the response, warns loudly and exits
1 on a mismatch, and tells a function too old to report the field at all apart
from one that reported null.

### Deployed, and what it proved

Claimed `db:fn:clip-capture`, `db:fn:mcp` and `db:deploy` in one command
(run tag `claims-followup-s9b-e2wr`) after Alex confirmed. No `gitsync`: solo on
main, no worktrees, so nothing could have drifted underneath it.

`npx supabase functions deploy clip-capture` — no flag needed, because
`config.toml` declares `verify_jwt = false` for it, which is the whole point of
that block.

Then a test report pushed under `claims_test-s1-u7qz`:

```
run tag:  claims_test-s1-u7qz
clip id:  1c75aa69-4507-4442-b92d-ec8641e99ad7
inbox id: 683b6675-2d0a-4abd-b80a-a607e6365c41
```

That line is now the **server's** answer, not ours, and it came back with no
mismatch warning — so the field was present in the response and the comparison
ran and passed. Before this deploy the same push would have stored null.

Alex verified the stored tag from claude.ai by listing recent clips unfiltered.

### Then mcp, and what the live server says

`npx supabase functions deploy mcp --no-verify-jwt` — `config.toml` declares
`verify_jwt = false` for it too, so the flag is belt and braces rather than
load-bearing.

Checked against the live server through the MCP connector:

| Call | Result |
|---|---|
| `run_tag: claims_test-s1-u7qz` | the test clip, tag stored as sent |
| `run_tag_prefix: claims_test` | the same one clip |
| `run_tag_prefix: claims-followup` | today's four reports, and **not** the `claims_test` one |
| `get_inbox` | 15 items — the rest of the server is fine |

The hyphenated prefix behaving exactly as before is the regression check that
matters: the escaping changed the pattern only for a prefix that contains an
underscore.

**A false alarm worth recording.** The first three calls came back `[]` and
looked like a broken deploy. They were not: `get_recent_clips` excludes clips
whose inbox item has been archived, and Alex archives each report as he reads
it. With `include_archived: true` everything was there. Nothing was reverted;
the check to run first in that situation is another tool — `get_inbox` answered
it in one call.

**The connector's cached tool descriptions are still the old ones**, so the
schema claude.ai sees still says "letters, digits and hyphens". That is a
caching layer, not the function: the live server accepts underscores, as above.
Reconnecting the connector refreshes it.

`.claude/skills/cli-workflow/SKILL.md` flipped with the deploy: snake_case
project names are now the preferred form, with `parallel_threads` and
`job_search` as the examples, and the old "hyphens, never underscores" row
replaced by two that show where an underscore may and may not go.

### Still to do in this step

- **Release the three `db:` claims** after Alex's `gitpush main push`. On main
  there is no Checkpoint mode, and Push only keeps every claim, so these have to
  be released by hand — `status` starts warning after an hour.

Nothing was committed.

**Done 2026-09-30**, at the start of Step 10: `release db:fn:clip-capture
db:fn:mcp db:deploy` took six records — the three claims and the three Step 2
reservations. 30 file claims remain, which is the whole point.

---

## Step 10, 2026-09-30 — what a fresh worktree needs

**Files changed**

- `package.json` — a `jest.testMatch` override, and a `jestNote` beside it.
- `scripts/git-new-worktree.mjs` — runs `scripts/prebuild.js` in the new
  worktree, and says so in the plan.
- `.worktreeinclude` — two comments that were wrong.
- `docs/progress-claims-followup.md` — this.

### Item 11: npm test in a worktree, reproduced and fixed

Run against the installed picomatch, with jest's own `replacePathSepForGlob`:

```
main      CRA default   match=true
main      rootDir-free  match=true
worktree  CRA default   match=false
            glob: C:/Users/Alex/projects/alfred-v5\.claude/worktrees/probe_tree/src/**/…
worktree  rootDir-free  match=true
```

The backslash before `.claude` survives normalisation — `replacePathSepForGlob`
is `p.replace(/\\(?![{}()+?.^$])/g, "/")` and keeps a backslash that precedes a
dot, because that looks like a deliberate escape. The pattern then means
`alfred-v5.claude`, which matches nothing, so `npm test` in a worktree finds no
tests at all and says so as though there were none to find.

`testMatch` is on CRA's supported-override list, so `package.json` carries globs
with no `<rootDir>` in them. `roots` stays `<rootDir>/src`, so `**/src/**`
cannot reach `node_modules`. Checked in main with `--listTests`: **91 files
before, 91 after, none from node_modules.**

**CRA rejects a `"//"` comment key inside `jest`** — it validates that object
against a fixed list and refused to run at all. The explanation lives in a
top-level `jestNote` instead, which CRA never looks at, so the why sits next to
the what for whoever deletes the block in a year.

### Item 7: gitnewtree generates what git does not carry

Both copies of `sam-drill-format.schema.json` are generated from the master at
the repo root and kept git-ignored so they cannot drift from it. That reason
still holds, so they stay ignored and `gitnewtree` runs `node
scripts/prebuild.js` in the new worktree instead — **after any install, and
unconditionally**, because `prebuild.js` uses only node built-ins and the
worktree most likely to hit the problem is the one where install was skipped.
It is named in the plan the command prints, and its failure says exactly what
will not work and how to fix it.

### The sweep: anything else ignored but needed

| Ignored | Verdict |
|---|---|
| `.env.production.local` | copied, and `prebuild.js` rewrites it — only two build stamps |
| `workshop/.env` | copied |
| `supabase/.temp/` | copied — without it a worktree must `supabase link` before deploying |
| the two schema copies | **now generated by gitnewtree** |
| `node_modules/`, `tools/sam-tools/node_modules/`, `workshop/.venv/` | reinstall; gitnewtree says so |
| `tools/sam-tools/{mutation,noop}-*.json`, `scores-reference.json` | one-off query output saved for migration 053's manual verification. Not inputs. |
| `build/`, `songs/`, `separated/`, `workshop/data/`, `__pycache__`, `.pytest_cache` | output |
| `.clip/` | deliberately not copied; clip.mjs and the guard both create it |

Also checked: the master `sam-drill-format.schema.json` at the repo root is
tracked, so a worktree has it to generate from; and the `scripts/lib/*.test.mjs`
suite imports nothing outside `node:`, so **those 78 tests run in a worktree
with no install at all**. Only the CRA suite needs `npm install`.

### Two things that were wrong in `.worktreeinclude`

`.env.production.local` was described as "Supabase credentials for the deployed
project". It holds `REACT_APP_BUILD_TIMESTAMP` and `REACT_APP_COMMIT_SHA` and
nothing else; the URL and anon key are hardcoded in `src/supabaseClient.js`. And
the note under "deliberately not copied" said `prebuild.js` regenerates the
schema copies "on prestart and prebuild", which is true and useless — nothing
runs either before the first `npm test`. It now says gitnewtree runs it.

### Verified here, and what is not

78 node tests pass; 91 CRA test files found before and after the `testMatch`
change. The worktree half cannot be proved from main — making a worktree needs a
clean, pushed main, and `gitnewtree` is Alex's command. The commands are in the
Step 10 report.

Nothing was committed.
