# Technical Spec: CLI Claims Follow-ups

## Goal

Fix what the first days of real use exposed in the CLI claims system
([technical-spec-cli-claims.md](history/technical-spec-cli-claims.md),
[progress-cli-claims.md](history/progress-cli-claims.md)), running two or three threads
at once. Twelve items: fewer permission popups, underscores in project names, database
claims that are not held for half a day, prompts that do not throw away an answer,
parameters so a command can be one pasted line, a worktree that can actually build,
deploy and test, and a guard that stops blocking harmless commands.

This project runs **solo on main**. No worktrees are open, so `gitsync` — which refuses
outside a worktree — plays no part, and the database step ends with `gitpush` → main →
**Push only**, which pushes and keeps main's file claims.

Thread: `claims-followup`.

---

## 1. Fewer permission popups

Alex gets several permission prompts per project and approves them without reading. A
prompt he did not expect, on a file he has not heard about, is not consent — and the
real safeguards are elsewhere: the guard refuses an edit to an unclaimed file, and Alex
has already confirmed the plan that named the files.

**Keep the forced prompt for exactly two things:**

| Command | Prompt? | Why |
|---|---|---|
| `claim` including `db:deploy` | **yes** | The one claim that can trigger a deploy |
| `cleanup <owner>` where owner ≠ this thread | **yes** | Wipes another thread's record |
| `claim` of files and folders | no | The plan named them; the guard still blocks edits |
| `reserve <item>` | no | A reservation is a note, it blocks nothing |
| `cleanup <this thread>` | no | Same as `release --all` |
| `status`, `check`, `release` | no | Already silent |

The guard hook decides this by **parsing the command's items**, not by matching the
subcommand alone. The chained-command block stays exactly as it is: a claim chained onto
anything else is still refused, whether or not it would have prompted, because chaining
is how a claim hides behind a rule that approved something else.

`claim` and `reserve` are added to `permissions.allow` in
`.claude/settings.local.json`, so the permission layer does not prompt for them either.
A `PreToolUse` hook returning `permissionDecision: "ask"` still overrides an allow rule,
which is what keeps the `db:deploy` case working.

Update: `.claude/CLAUDE.md`, `.claude/skills/cli-workflow/SKILL.md`, and the `USAGE`
text in `scripts/claims.mjs`.

---

## 2. Underscores in project names

`parallel_threads-s5-f2mz`. Hyphens stay the separator between name, step and random
ending; underscores are allowed inside the name. Existing hyphenated codes — `rem-j7p`,
`dj-c7q`, `claims-followup` — keep working unchanged, and tests cover both forms.

Every place that validates a code or a tag:

| Where | What changes |
|---|---|
| `scripts/lib/project-code.mjs` | `TAG_SHAPE`, and `tagInPrompt`'s character class |
| `scripts/git-new-worktree.mjs` | the `CODE` regex |
| claims owner names | derived from the worktree folder name, so `gitnewtree`'s `CODE` is the only gate |
| `scripts/clip.mjs` | `TAG_PATTERN` — today it rejects underscores, so reports would fail to push |
| `supabase/functions/clip-capture/index.ts` | the stored `run_tag` regex |
| `supabase/functions/_shared/tools/clipboard.ts` | `run_tag` and `run_tag_prefix` |
| `supabase/functions/mcp/index.ts` | `get_recent_clips`' description of the tag shape |

### `_` is a SQL LIKE wildcard — escape it

`get_recent_clips` filters a prefix with `.like("source_metadata->>run_tag", prefix +
"%")`, and the comment beside it says the tag alphabet "cannot smuggle a `%` or `_` of
its own into the pattern". Allowing underscores breaks that promise: in `LIKE`, `_`
matches any single character, so `parallel_threads` would also return
`parallelXthreads`.

The prefix is escaped before it reaches the pattern — `_` and `%` and the escape
character itself — and the comment is rewritten to say so. Without this, the feature
silently returns another thread's reports.

**No migration.** `run_tag` lives in `inbox.source_metadata` as JSON; nothing in
`supabase/migrations/` mentions it and no column or constraint changes.

The Edge Function half is a **database step**, with the just-in-time `db:deploy` flow.

---

## 3. `db:deploy` is released at every Checkpoint

A thread held `db:deploy` for thirteen hours and blocked another thread's deploy. A
database claim is meant to live for minutes.

- `gitpush` **Checkpoint releases `db:` claims by default.** The question stays, so Alex
  can keep one deliberately, but a blank answer releases them all rather than none.
- `.claude/CLAUDE.md` and the skill say to **re-claim at the step that deploys**, never
  to carry a `db:` claim across steps.
- `claims.mjs status` flags any `db:` claim held for more than an hour.

---

## 4. `bind` and `unbind`, and hooks that are testable

`claims.mjs bind <code>` and `claims.mjs unbind` set and clear the **main checkout's**
project code without touching any claim. They refuse inside a worktree, where the code
is the folder name and is not settable. The prompt guard's wrong-window message names
them, since that is the moment Alex needs them.

**The prompt guard's tests wrote into the real `.clip/claims-guard.log`.** Both hooks
take the log path from an environment variable, and `project-code.mjs` already takes its
directory from the caller, so the tests run against a scratch log and a scratch binding
file. Each test asserts that the real `.git/alfred-project-code.json` and the real
`.clip/claims-guard.log` were not touched.

---

## 5. A blank commit message fills in a default

Today a blank message cancels the whole run, after Alex has already answered every other
question. Instead it fills in:

```
<project-code>: <mode> <YYYY-MM-DD>
```

for example `claims-followup: checkpoint 2026-09-30`. The project code is the worktree
folder name, or main's recorded code, or `main` if none is set. Modes: `commit`
(gitcom), `push`, `checkpoint`, `finish` (gitpush). It applies to `gitcom` and to every
`gitpush` mode.

---

## 6. Start a fresh conversation for each project

Claude Code reads hook settings when a conversation starts, so a settings change made
mid-conversation does not take effect in that conversation. The skill says to start a
fresh one for each project.

---

## 7. What a fresh worktree needs to build and deploy

Both copies of `sam-drill-format.schema.json` — `src/sam/lib/` and
`supabase/functions/_shared/` — are git-ignored and generated by `scripts/prebuild.js`
from the master at the repo root. A worktree therefore has neither, and a function
deploy from one fails to bundle (and eleven SAM test suites fail, and the app build
fails).

**Why they are ignored:** to stop the copies drifting from the master. That reason still
holds, so they stay ignored, and instead **`gitnewtree` runs `node scripts/prebuild.js`
in the new worktree** — after `npm install` when Alex runs it, and anyway when he skips
it, because `prebuild.js` uses only node built-ins. When install is skipped, gitnewtree
says what will not work until it is run.

`prebuild.js` also rewrites `.env.production.local`, which is safe: that file holds only
`REACT_APP_BUILD_TIMESTAMP` and `REACT_APP_COMMIT_SHA`. `.worktreeinclude` describes it
as "Supabase credentials for the deployed project", which is wrong — the URL and anon
key are hardcoded in `src/supabaseClient.js`. That comment is corrected, and the
"deliberately not copied" note stops claiming prestart/prebuild covers a worktree.

Step 10 also sweeps for anything else ignored-but-needed.

---

## 8. No prompt throws away an answer

`gitpush` Checkpoint's path list takes only numbers and paths, and a blank answer
cancels the whole run. Every numbered and yes/no prompt in `gitcom`, `gitsync`,
`gitpush` and `gitnewtree` is audited for the same trap.

A shared answer parser in `scripts/lib/git-flow.mjs` accepts:

- `a` and `all`
- ranges: `1-4`, and mixtures like `1-3 7 src/x.js`
- numbers and literal paths, as now

and a blank answer **re-asks** with the consequence spelled out — "commit all, or
cancel?" — instead of silently cancelling. The known traps:

| Where | Today | After |
|---|---|---|
| `gitcom` unclaimed-files `all/none/select` | blank cancels the run | re-asks |
| `gitcom` commit message | blank cancels | default message (item 5) |
| `gitpush` which checkout | blank cancels | stays: documented as "enter to cancel" |
| `gitpush` main: unclaimed files | blank cancels | re-asks |
| `gitpush` main / Finish / Checkpoint message | blank cancels | default message |
| `gitpush` Checkpoint paths | blank cancels | re-asks: "commit all, or cancel?" |
| `gitpush` Checkpoint db release | blank = release none | blank = release all (item 3) |
| `choose()` generally | blank returns null | re-asks unless the caller opts out |

The final yes/no stays a yes/no, defaulting to no.

---

## 9. Parameters, so each command is one pasted line

```
gitpush rem-j7p checkpoint --paths <paths> --release-db --message "..."
gitcom --message "..."
gitsync --yes
gitnewtree parallel_threads --install --yes
```

Every choice each command asks for can be given as a parameter. The command still
**prints its plan and asks one final yes/no** — a parameter answers a question, it does
not skip the confirmation.

The PowerShell wrappers in `scripts/powershell-profile-snippet.ps1` already forward
`$args`, so only their comments change. No profile edit is needed.

---

## 10. Skill layout for a git instruction

Every git instruction claude.ai gives Alex is a short table then the command:

| checkout | mode | files | database claims |
|---|---|---|---|
| the `rem-j7p` worktree | Checkpoint | the migration and the function | released |

Why: one line.

```powershell
gitpush rem-j7p checkpoint --paths supabase/migrations/084_reminders.sql --release-db
```

---

## 11. `npm test` in a worktree

**Confirmed mechanism, reproduced 2026-09-30.** CRA's `testMatch` embeds `rootDir`:
`<rootDir>/src/**/*.{spec,test}.{js,jsx,ts,tsx}`. Jest normalises it with
`replacePathSepForGlob`, which is

```js
path.replace(/\\(?![{}()+?.^$])/g, '/')
```

— a backslash followed by `.` is **kept**, because it looks like a deliberate escape. In
a worktree the root is `…\alfred-v5\.claude\worktrees\<code>`, so the separator before
`.claude` survives into the glob as an escape and the pattern ends up meaning
`alfred-v5.claude`, which matches nothing. In the main checkout there is no dot
directory in the path, so it works. This is why `npm test` in a worktree finds no tests
even with `CI=true … --watchAll=false`.

**Fix:** override `testMatch` in `package.json` with globs that do not embed `rootDir`:

```json
"jest": {
  "testMatch": [
    "**/src/**/__tests__/**/*.{js,jsx,ts,tsx}",
    "**/src/**/*.{spec,test}.{js,jsx,ts,tsx}"
  ]
}
```

`testMatch` is on CRA's supported-override list. `roots` stays `<rootDir>/src`, so the
crawl is still limited to `src/` and `**/src/**` cannot reach `node_modules`. Verified
against the installed picomatch: the rootDir-free globs match in both the main checkout
and a worktree.

Step 10 also decides whether `scripts/lib/*.test.mjs` — which run under `node --test`,
not CRA — should join `npm test`.

---

## 12. The guard blocks harmless commands

Two distinct bugs, both confirmed.

**(a) Flag tokens read as commands.** `writeIndicator` matches command names with
`\b(?:mv|cp|rsync|install|ln)\b`, so the `-ln` in `git grep -ln` matches `ln`, and a
read-only `sed -n … | grep -i …` matches the in-place rule. Hit three times while
planning this project. Fix: command-name indicators must not match inside a flag —
negative lookbehind for `-` and for a word character. Flag-based indicators (`sed -i`,
`dd of=`) keep matching flags, which is the point of them.

**(b) A write whose only target is outside the repo.** A `>` redirect to `$TEMP` was
blocked as a write to `supabase/functions/mcp`, because `repoPathsIn` deliberately
looks at every repo path the command names rather than trying to find the destination.

That breadth is not an accident — the 2026-09-28 breach wrote to `/tmp` and then `mv`'d
the file into the repo — so the relaxation is narrow, and is Alex's decision of
2026-09-30:

> Keep `mv`, `cp`, `tee` and `sed -i` strict; relax only a plain `>` or `>>` whose
> target resolves outside the repo.

So: if the **only** write indicator is a redirect, and every redirect target resolves
outside the repo, the command is allowed. If the command also contains `mv`, `cp`,
`tee`, `rsync`, `ln`, `install`, `patch`, `dd of=`, an in-place `sed`/`perl`, or any of
the PowerShell writers, nothing is relaxed. Tests cover the breach command, both false
positives above, and a redirect to a repo path.

---

## Steps

1. Plan (done).
2. Claim; write this spec and the progress doc.
3. Items 1 + 3 — popups and `db:deploy` hygiene.
4. Item 12 — guard false positives.
5. Items 5 + 8 — no prompt throws away an answer.
6. Item 9 — parameters.
7. Item 4 — `bind`/`unbind`, and hook tests on a scratch log.
8. Item 2a — underscores, local half.
9. Item 2b — underscores, Alfred half. **Database step.** Deploy `clip-capture`, then
   push a short test report under an underscore run tag and confirm it succeeded
   **before** deploying `mcp`. If that push fails, stop and tell Alex.
10. Items 7 + 11 — what a fresh worktree needs to build, deploy and test.
11. Items 6 + 10 — skill layout and the fresh-conversation note; full suite; report.
