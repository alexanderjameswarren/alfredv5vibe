# Progress: CLI claims follow-ups

Spec: [technical-spec-claims-followup.md](technical-spec-claims-followup.md). Thread:
`claims-followup`. Solo on main — no worktrees.

**Status: Step 5 done, awaiting Alex's verification.**

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
- [x] **5. Items 5 + 8 — no prompt throws away an answer.** 61 tests passing,
      awaiting Alex's verification.
- [ ] **6. Item 9 — parameters for the four git commands.**
- [ ] **7. Item 4 — `bind`/`unbind`, and hook tests on a scratch log.**
- [ ] **8. Item 2a — underscores, local half.**
- [ ] **9. Item 2b — underscores, Alfred half. DATABASE STEP.** Deploy `clip-capture`,
      push a test report under an underscore tag and confirm it landed, then `mcp`.
- [ ] **10. Items 7 + 11 — what a fresh worktree needs to build, deploy and test.**
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
