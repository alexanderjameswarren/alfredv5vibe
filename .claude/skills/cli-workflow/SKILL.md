---
name: cli-workflow
description: >-
  Runs both halves of the CLI loop for Alex's personal projects. Use it to write
  CLI prompts (each starts with a "Run tag:" line and a "Window:" line) whenever
  he asks for CLI instructions or a code CLI prompt, or is ready to implement,
  in React or Python projects, including parallel work in worktrees (gitnewtree,
  gitcom, gitsync, gitpush, file and database claims). Also use it, more often,
  whenever CLI output comes back: when he sends just "cli", says the CLI
  responded in any wording (fetch the report from the Alfred clipboard with
  get_recent_clips by run tag or project code), pastes CLI output with or
  without comment, or asks only for a TLDR or to flag questions. Assume he has
  not read the CLI output. Use it whenever CLI work is involved, even if he does
  not ask for formatted instructions.
---

# CLI Workflow

This skill helps transition from planning sessions in claude.ai to execution in CLI by generating properly formatted instruction sets.

## When to Use This Skill

- User asks for "CLI instructions" or "Claude CLI prompt"
- User wants to execute planned code changes via Claude CLI
- User says something like "ready to implement this" or "let's build this"
- Planning conversation is complete and user needs execution guidance

## Run tags: matching a CLI report to the thread that asked for it

Alex often has two or three CLI sessions running at once, each driven by a
different claude.ai thread. Every report comes back through the same Alfred
clipboard, so each thread needs a way to pick up its own report and nobody
else's. That is the run tag.

**Every CLI prompt this skill generates starts with a run tag line, as its
very first line. The shape is exact:**

```
Run tag: <project-code>-s<step number>-<4 random lowercase letters or digits>
```

```
Run tag: rem-k4q-s1-t6v2
```

Four parts, three hyphens between them, and **a machine parses this** — the
alfred-v5 prompt guard reads the project code out of it to decide whether the
prompt is in the right window. A tag it cannot parse is **blocked**, not waved
through.

- `<project-code>` is `<project>-<thread code>`: a short name for the work
  (`rem`, `clip`, `ken`, `sam`, `dj`, `jobs`) then THIS conversation's own three
  lowercase letters or digits, made up the first time this thread issues a prompt
  and then never changed. See "The project code" below — it does more work than
  the rest of the tag put together.
- **`s<step number>`** — the letter `s`, then digits. `s1`, `s2`, `s10`. A
  follow-up *within* a step adds a letter: `s3b`, `s3c`. Nothing else goes here.
- **4 random lowercase letters or digits**, so two prompts for the same step
  never share a tag. Make them up; they mean nothing.
- Lowercase letters, digits and hyphens throughout, at most 40 characters.
  Anything else is refused by the push script, not corrected.

**Numbering.** The plan prompt is `s1`. Confirm-and-claim is `s2`. Every prompt
after that increments: `s3`, `s4`, `s5`. A correction or follow-up inside a step
that is already underway keeps the number and adds a letter — `s3b` follows `s3`.

| | |
|---|---|
| ✅ `rem-k4q-s1-t6v2` | the plan prompt |
| ✅ `rem-k4q-s2-9xqm` | confirm and claim |
| ✅ `rem-k4q-s10-b7zz` | tenth step, two digits |
| ✅ `rem-k4q-s3b-k2np` | a follow-up within step 3 |
| ❌ `rem-k4q-plan-t6v2` | "plan" is not a step segment — this is the one that got through |
| ❌ `rem-k4q-step1-t6v2` | it is `s1`, not `step1` |
| ❌ `rem-k4q-fix-t6v2` | `fix` is not a step either; use `s3b` |
| ❌ `rem-k4q-s1` | no random suffix |
| ❌ `rem-k4q-s1-t6v` | suffix must be exactly 4 characters |
| ❌ `rem-k4q-S1-T6V2` | lowercase only |
| ❌ `rem_k4q-s1-t6v2` | hyphens, never underscores |

- **A new prompt gets a new tag**, even when it continues the same work — only
  the project code carries over. The full tag identifies one prompt and its
  messages; the project code identifies the project.

**Why the thread code earns its place.** An exact tag fetches the messages from
one prompt. The thread code is what lets this conversation fetch *everything it
has ever been told*: `get_recent_clips` takes a `run_tag_prefix`, so
`jobs-ax4` returns every report from this thread, oldest to newest, across every
step. That is the difference between "what did the CLI say about step 10" and
"remind me what has happened in this conversation" — worth having when a thread
is picked up days later, or when a report was read and then forgotten.

So: `run_tag` for one prompt's messages, `run_tag_prefix` for the whole thread.

**Old tags still fetch, but are not a format to copy.** Tags already issued in
the older `<project>-<step>-<random>` form (`clip-7b-q4m2`, `jobs-s9-t2v6`) still
match exactly in `get_recent_clips` and still fetch their reports, so do not go
back and re-tag anything. But **do not write a new one in that shape**: it has no
parseable step segment, so the alfred-v5 prompt guard blocks it.

- Remember the tag of the most recent prompt you issued in this thread. That is
  the tag you look for when the report comes back — and remember the thread code,
  which is how you find all of them.

**EVERY prompt gets a tag — including the short ones.** "Confirmed, go ahead",
"yes, claim it", "no drift" all get a `Run tag:` line, for the same reason the
long ones do: alfred-v5 blocks a prompt whose tag belongs to a different window,
and it can only do that if there is a tag. A bare one-word reply Alex types
himself is fine; anything this skill *writes* carries a tag.

### The project code

`<project>-<thread code>` together — everything before the step segment — is the
**project code**: `claims-wq7-s8-k6tr` → `claims-wq7`. It is the one part of the
tag that never changes for the life of a project, and in alfred-v5 it does real
work:

- it names the worktree folder `.claude/worktrees/claims-wq7`,
- which makes it the claims **owner** for every file that thread claims,
- and a `UserPromptSubmit` hook blocks any prompt whose project code does not
  match the window it was pasted into — **and blocks any tag it cannot read the
  project code out of**, which is why the step segment has to be `s<number>` and
  nothing else.

**Choosing one.** Pick it once, in the first prompt of a project, and never
change it: `<project>` is a short name for the work (`claims`, `ken`, `sam`,
`dj`, `jobs`, `inbox`), `<thread code>` is this conversation's three characters.
It must be lower case letters, digits and hyphens. If the same project is picked
up in a new claude.ai thread later, keep the *original* project code — the
worktree and its claims are named after it, and a new thread code would strand
them.

In the Alfred repo (alfred-v5), the `CLAUDE.md` rule makes the CLI push its
closing message to the clipboard with `node scripts/clip.mjs --tag <tag>` EVERY
TIME it hands the turn back — finishing, waiting for something to be run or
verified, or asking a question — so the prompt only needs the tag line. Expect
several messages under one tag for a task that stops more than once. For a repo that does
not have `scripts/clip.mjs` and that rule, add this line to the prompt after the
tag: "When you finish, print your full report; Alex will paste it back." The
return leg then works from the pasted text as before.

## alfred-v5: windows, worktrees and claims

**This section applies to alfred-v5 only.** Other repos have no claims system;
skip it there.

Alfred runs several CLI threads at once, each in its own git worktree and its own
VS Code window, sharing one claims file. A thread claims the files it will touch,
and the guard hook refuses to let it edit anything it has not claimed — so a
prompt that skips the claim step does not go slowly wrong, it stops.

### Say which window, every time

**Every prompt names the window it goes in**, on the line after the run tag:

```
Run tag: claims-wq7-s8-k6tr
Window: the claims-wq7 worktree
```

or

```
Run tag: jobs-ax4-s3-p1m9
Window: the main checkout
```

This is not a courtesy. Alfred blocks a prompt whose project code does not match
the window, so a prompt pasted into the wrong one never reaches Claude — but Alex
still has to know where it *should* go, and he is reading this in a claude.ai
thread with several windows open.

Work in the main checkout when it is the only thing running. Use a worktree when
two projects are live at once, or when the work is long enough that something
else will want the repo before it is done.

### A new project's first two prompts

**Prompt 1 is the plan, and it is read-only.** It must:

- list every file and folder the work will touch,
- list every database item it will need — `db:table:<name>`, `db:fn:<name>`,
  `db:deploy` — **each with the step that needs it**,
- run `node scripts/claims.mjs check` on all of it,
- report conflicts and warnings, change nothing, claim nothing, and stop.

**Prompt 2 confirms and claims**, after Alex has read the plan: claim every file
and folder in one command, reserve each database item with its step, then start.

Do not fold these together. The whole value of the plan step is that Alex sees
what a thread intends to own *before* it owns it, and a plan that has already
claimed is not a plan. The exception is a change so small it touches one file
Alex has already named — then his instruction is the confirmation and the thread
claims that file and gets on with it.

**Claiming files no longer raises a permission prompt, so prompt 1 is the only
place Alex sees the list.** Only `claim db:deploy` and `cleanup <another thread>`
still interrupt him. He used to get several popups per project and approved them
without reading, which taught him not to read the one that mattered. Write the
plan prompt knowing its file list is the real approval, not a preview of one.

### Alex's commands

The CLI never runs these. A prompt asks Alex to run one and then waits.

| Command | When |
|---|---|
| `gitnewtree <project-code>` | Starting work that needs its own worktree. Refuses until main is committed and pushed, so `gitpush` main → Push comes first. Say yes to `npm install` when the thread will run tests or a build; skip it for docs-only work. |
| `gitcom` | A local commit, part-way through. Commits only what this thread has claimed and has changed; asks about anything unclaimed. Releases nothing. |
| `gitsync` | Inside a worktree, to bring main in. **Always before a database step**, so the thread is looking at everything already live. |
| `gitpush` | Any terminal — it always acts on the main checkout. For **main**: Push (commit and push, keep the claims) / Finish (and release them) / Skip. For a **worktree**: Checkpoint (merge only named files, release the `db:` claims, worktree carries on) / Finish (merge everything, release every claim, remove the worktree) / Skip. |

**Before asking for `gitpush` Finish on a worktree, tell him to close that
worktree's VS Code window and exit its Claude session.** A running session locks
the worktree and the removal fails — the merge and push still succeed, but he is
left running recovery commands.

### The database step, just in time

At the step that needs the database, not before:

1. `claims.mjs check` the `db:table:*`, `db:fn:*` and `db:deploy` needed.
2. Alex runs `gitsync`.
3. **Drift check.** If the sync brought in a migration or function change
   touching the same tables or function, stop and re-plan that step.
4. Alex confirms; the thread claims the items — **at this step, every time.** A
   `db:` claim is never carried over from an earlier step; if an earlier one
   released them, as it should have, the prompt says to re-claim here.
5. **Number the migration now.** New SQL is written under
   `supabase/migrations/_pending_<owner>_<purpose>.sql` and only gets its real
   number here, after the sync, when the folder listing is current. Then the
   numbered file is written and the `_pending_` one deleted.
6. Alex runs the migration in the Supabase SQL editor. Function deploys the
   thread runs itself — **but only while holding `db:deploy`.** The guard blocks
   `supabase functions deploy` and `supabase db push` otherwise.
7. Verify.
8. Alex runs `gitpush` → that worktree → **Checkpoint**, naming the migration and
   function paths, so only those reach main. **Checkpoint releases the `db:`
   claims itself, all of them, by default.**
9. The thread confirms with `claims.mjs status` that they went, and releases any
   Checkpoint left behind. `db:` claims are the only ones a thread releases.
   Never write a prompt that carries one into the next step: one held across
   steps blocked another thread's deploy for thirteen hours, and `status` now
   warns about any held for more than an hour.

**Why `_pending_`.** Two threads both look at `supabase/migrations/`, both see
`083`, both write `084`. The filenames differ, so nothing conflicts and no claim
is contested — claims coordinate paths, and this is a collision in a number.
Numbering last, after a sync, is the only moment the answer is right.

### Claims are never released by the thread

A file or folder claim is held for the whole life of the thread; `gitpush`
Finish releases it. Do not write a prompt that asks a thread to release a file
claim, or to "clean up its claims when done". Database claims are the exception,
and `gitpush` Checkpoint releases those itself at step 8 above.

## Getting the report back

The report reaches this thread in one of two ways.

**1. From the clipboard (the normal path).** Alex sends just `cli`, or says the
CLI responded, finished or replied, in any wording, without pasting anything.

- Call `get_recent_clips` with `source: "cli"` and `run_tag` set to the tag of the
  most recent prompt this thread issued.
- If exactly one report matches, that is the report. Use it.
- If none match, the CLI may still be running, may have pushed without the tag,
  or the push may have failed. Call `get_recent_clips` with `source: "cli"` and
  no tag, and list what is there: title, run tag, repo, and time. Ask Alex which
  one, or whether to wait. Do not guess, and do not assume the most recent one
  is yours; with several CLIs running, it often is not.
- If this thread issued no tagged prompt and more than one unarchived CLI report
  exists, list them the same way and ask.
- If the tool is not available in this thread, say so and ask Alex to paste the
  report instead.

**2. Pasted.** Alex pastes the CLI's output into the chat. Use it as before.

Either way, the response format below is the same. **After responding, archive
the report's inbox item** with `archive_inbox_item`, passing the `inbox_id` from
`get_recent_clips` (not the clip id), so it leaves Alex's inbox. A pasted report
has no inbox item to archive.

If a report was pushed without a run tag, or in a repo other than the one this
thread is working on, mention that in one line in the TLDR.

**The `repo` field names the worktree, not just the repo.** A report from a
worktree reads `alfred-v5 on worktree-claims-wq7`, one from the main checkout
`alfred-v5 on main`. So the repo field is a second check that the work happened
where it was meant to: a report for `claims-wq7` arriving from `main` means the
prompt was run in the wrong window, and that is worth a line in the TLDR rather
than being read past.

Fetch by exact `run_tag` for one prompt's messages, and by `run_tag_prefix` set
to the **project code** — `claims-wq7` — for everything that project has ever
reported, across every step and every thread that worked on it. Since the project
code also names the worktree, the prefix and the worktree are the same string.

## The return leg: responding to CLI output

This is the half of the loop that runs most often, and the half most likely to
go wrong. The CLI's report reaches this thread **without the user having read
it**, whether it was fetched from the clipboard or pasted. That is deliberate —
the whole point of the pattern is that he does not have to read CLI output.
Every rule below follows from that one fact.

### The governing assumption

He has not read the report. He does not know what is in it. He cannot resolve
any reference to it. Write as if he handed you a sealed envelope and asked what
was inside.

### Response format — always these five parts, always in this order

**1. TLDR.** What the CLI actually did, in plain sentences. What changed, what
works now, what it decided along the way.

**2. Questions and recommendations.** Anything the CLI asked, or anything it
left open that needs a decision. Each one gets: the question restated in full,
what is actually being asked, the recommendation, and one line of why.

**3. Your to-dos.** Everything the user must do by hand — run SQL, edit a file,
set a variable, deploy, install. Full paths, always (see below). If the to-dos
include more than one read-only SQL check, combine them into one query (see
Rule 5).

**4. Testing.** Numbered, explicit, doable without reading the CLI output and
without DevTools. See the tool-call rule below. SQL checks here follow Rule 5
too.

**5. Stop — or reply to the CLI, but only if there is no testing.** If part 4
has any testing steps, end the message there. Do not write anything for Alex to
paste into the CLI — no answers to its questions, no "proceed", no fixes, no next
prompt. Wait for his test results. If part 4 is empty (nothing to test), you may
end with the reply to the CLI. See Rule 6.

### Rule 1: never reference anything by its label from the report

The report numbers and names its own findings — "fix 2", "issue 4", "the
parity test", "the approach above", "as noted". Those labels are meaningless to
him. He never saw them.

Every item must be restated in full, in your own words, as if introducing it for
the first time.

- ✗ "Fix 2 and 4, but not in the handlers."
- ✓ "Two of the problems it found are worth fixing now. The first is that the
  date filter silently drops rows with no timestamp. The second is that the
  retry loop has no ceiling, so a failing call can spin forever. I'd fix both —
  but in the shared query helper, not in each individual handler, so the fix
  lands in one place."

Same for anything the CLI named: a test, a file, a helper, an approach. Say what
it is before you have an opinion about it.

**If you cannot restate an item in full, you did not understand it either.** Say
so plainly rather than passing the label through.

### Rule 2: restate every question before answering it

An answer floating free of its question is unusable. "Keep it" tells him
nothing. The question comes first, in full, then the recommendation.

- ✗ "Keep it. The parity test alone is worth having."
- ✓ "It's asking whether to keep the test it wrote — the one that runs the old
  and new code paths on the same input and checks they return identical results.
  Keep it. It's the only thing that will catch a silent behaviour change when
  this code is refactored later."

### Rule 3: every test step is either one app action or one paste-ready block

A test step is one of two things, never both, never several:

- **An app action** he does himself: open this screen, tap this button, look
  for this text. One action per step.
- **A paste-ready block**: a fenced code block containing the exact text he
  pastes into a new Claude thread. Never a description of what to ask
  ("Ask Claude for a reminder 10 minutes out"), never a quoted sentence inside
  a numbered list.

**One block per paste.** If he has to paste, wait for a reply, then paste
again, each paste is its own numbered step with its own fenced block. Never
put two prompts in one block and never put a prompt inside prose.

**Expected results go after the block, as a separate short line.** Never
mixed into the block, where he'd paste them into Claude.

**Split sequences.** If a sentence in a test contains "then", "and ask",
"press", or more than one verb aimed at different places (the app and
Claude), it is several steps. Split it until each step is one action or one
paste.

**Each block tells the fresh thread what to report back**, so he can paste
the reply here without reading it.

The new thread is mandatory for newly deployed tools: a session loads its
tool list once at startup, so only a thread started after the deploy can see
a new tool. Never fold tool-call checks into the CLI prompt, and never try
the call in the current thread.

Example, from a bad instruction ("Make another reminder, discard its item,
and ask Claude for get_reminders with state all: it should be cancelled.
Press Undo: it's scheduled again."):

1. Paste into a new thread:
```
   Use create_reminder to remind me "Test R3: discard" 30 minutes from now.
   Report only the reminder id and the inbox item id.
```
2. In the app, open the inbox item "Test R3: discard" and discard it.
3. Paste into the same thread:
```
   Call get_reminders with state "all". Report the state and cancel reason
   of "Test R3: discard", verbatim.
```
   Expected: state cancelled, reason inbox_discarded.
4. In the app, tap Undo on the discard.
5. Paste into the same thread:
```
   Call get_reminders with state "all" again. Report the state of
   "Test R3: discard", verbatim.
```
   Expected: state scheduled, and the item is back in the inbox.
   
### Rule 4: files always get full paths

Any instruction touching a file names the file completely. Never "run the SQL",
"update the env file", "edit the skill". He should never have to go find the
thing you mean.

- ✗ "Run the migration, then update your .env."
- ✓ "Run `docs/migrations/2026-09-11-ken-areas.sql` in the Supabase SQL editor.
  Then add `KEN_API_URL=https://...` to `/home/alex/projects/ken/.env.local`."

If a file must be created, give the full path it should be created at and its
complete contents.

### Rule 5: several read-only SQL checks become one JSON query

The Supabase SQL Editor only shows the result of the last statement when several
are pasted together. So whenever he needs to run more than one read-only
`select` to check something, combine them into a single query that returns one
JSON object. He runs it once, copies one cell, and pastes it back.

```sql
select json_build_object(
  'ken_areas_exist',   (select coalesce(json_agg(t), '[]'::json) from (
                          select id, name from ken_areas order by name
                        ) t),
  'ken_items_by_area', (select coalesce(json_agg(t), '[]'::json) from (
                          select area_id, count(*) from ken_items group by area_id
                        ) t)
) as result;
```

- Give each section a key that says what it checks.
- Wrap every query in the `coalesce(json_agg(t), '[]'::json)` form, even if it
  returns one row. Without `coalesce`, a query with no rows returns `null`,
  which is easy to misread as an error.
- No semicolons inside the inner queries.
- Tell him what to paste back: "Copy the single value in the result cell and
  paste it here."

**Only pure reads.** Migrations, inserts, updates, deletes, and any function
call that changes state stay as separate statements, run on their own, so a
failure points at exactly one thing. This includes `select
platform.register_table(...)` — it starts with `select` but it writes, so it is
never bundled.

### Rule 6: the hard stop

The next CLI prompt is **never** in the same message as the testing
instructions. Generate it only after he confirms testing passed and has answered
the open questions. Answering his questions and handing over the next prompt in
one message collapses the verification gate that the whole pattern exists to
create.

## Platform-layer projects (Alfred / Ken / Homer / any MCP app)

If the change touches MCP database tables, Edge Function tools, or
`_shared/platform.ts`, the platform contract governs it and there are
non-negotiable rules the CLI prompt must carry. **Read the `mcp-platform` skill
first** and reflect its requirements into the generated prompt — do not restate
the rules from memory here, they live in that skill and in `COMMENT ON SCHEMA
platform`. In particular, any generated prompt that creates a table or tool must:

- end every schema migration with `select platform.register_table(...)` and a
  final `check_platform_conformance` step (CONFORMANT required to call it done);
- build tools via `defineTool` with a declared tier, reaching the DB only through
  `ctx.db`;
- treat SQL migrations as a manual prerequisite the user runs (see Step 2) — the
  platform SQL is applied out-of-band in Supabase, not by the CLI.

When in doubt whether a task is platform-governed, it is if it writes to Supabase.

In alfred-v5 this always runs through the just-in-time database step above:
`_pending_` SQL naming, `gitsync` first, the drift check, `db:deploy` held before
any function deploy, and a `gitpush` Checkpoint to land it.

## Skill Workflow

### Step 1: Assess Complexity

Determine if this is a **simple** or **complex** change:

**Simple change** = Can be completed in a single CLI prompt
- Single file modification
- Adding one function or component
- Simple bug fix
- Quick configuration change

**Complex change** = Requires multiple steps or verification points
- Multiple file changes
- New feature implementation
- Architecture changes
- Changes requiring testing between steps

**When uncertain**, ask the user: "This could go either way—would you prefer a single prompt or a step-by-step breakdown with verification points?"

### Step 2: Handle Manual Prerequisites

Before generating CLI instructions, identify any manual steps the user must complete:
- Setting up external accounts/services
- Running database migrations or SQL scripts
- Installing dependencies
- Creating API keys or credentials
- Configuring environment variables

**If manual steps exist:**
1. Walk the user through these steps FIRST
2. Wait for confirmation they're complete
3. THEN generate the CLI instructions

**SQL checks:** any read-only queries he needs to run to confirm a manual step
worked are combined into one JSON query, per Rule 5. The steps that change the
database stay separate.

**Platform-layer note:** for Alfred/Ken/Homer work, SQL migrations are always a
manual prerequisite — the user runs them in the Supabase SQL editor, and the
schema-side objects (`register_table`, RPCs, policies) must be deployed and
verified CONFORMANT *before* the CLI touches the TypeScript that depends on them.
Sequencing the SQL after the handler wiring means debugging two unknowns at once.

### Step 3: Generate Instructions

**Never ask the CLI to commit, push, or run any other git command that changes
state.** No "commit when tests pass", no "commit and push", no "commit directly
to main", no branches. The CLI leaves its changes in the working tree and names
the files it touched; committing and pushing are Alex's alone, because a push
can trigger a deploy.

That includes `gitcom`, `gitsync`, `gitpush` and `gitnewtree`. They live in
alfred-v5's `scripts/`, and they do commit, merge and push — which is exactly why
a prompt asks Alex to run one and waits, rather than asking the CLI to.

**Supabase deploys are not a free pass either.** A prompt may ask the CLI to run
`npx supabase functions deploy`, but only as part of the database step above:
after `gitsync`, after the drift check, and while the thread holds `db:deploy`.
The guard blocks it otherwise, so a prompt that asks for a bare deploy wastes a
round trip. Migrations are always Alex's to run in the Supabase SQL editor.

This is also the rule in alfred-v5's `CLAUDE.md`, so a prompt that asks for a
commit will be refused there and simply wastes a round trip.

Every generated CLI prompt, simple or complex, starts with its `Run tag:` line
(see "Run tags" above) and carries this line so the CLI
follows Rule 5 when it hands SQL back:

```
If you need me to run more than one read-only SELECT in the Supabase SQL Editor,
combine them into one query that returns a single JSON object: wrap each query
as (select coalesce(json_agg(t), '[]'::json) from (<query>) t), give each a
descriptive key inside json_build_object, and tell me to paste back the single
result cell. Migrations and anything that changes data stay as separate statements.
```

#### For Simple Changes

Provide a clean, copy-paste ready prompt:

```
Run tag: [project]-[thread code]-[step]-[4 random characters]
Window: [the main checkout | the <project code> worktree]

I need you to [clear description of the change].

[Any relevant context about the codebase, file locations, or constraints]

[If applicable: Reference any existing patterns or examples to follow]

[The Rule 5 SQL line from above]
```

Naming the files in the prompt is what lets the thread claim them without
stopping to ask — so name them.

#### For Complex Changes

Generate three artifacts:

**1. Technical Specification** (if not already created)

Create a `technical-spec.md` file that includes:
- Overview of the change
- Architecture decisions
- Key components affected
- Implementation approach
- Success criteria

**2. Progress Tracking File**

Create `progress-[feature-name].md`:

```markdown
# Progress: [Feature Name]

## Status: In Progress

### Development Steps
- [ ] Step 1: [Description]
- [ ] Step 2: [Description]
- [ ] Step 3: [Description]

### Notes
[Space for notes during execution]
```

**3. Initial CLI Prompt**

In alfred-v5 the first prompt of a new project is the **plan**, read-only — see
"A new project's first two prompts" above. The template below is the one that
follows it, once Alex has confirmed the plan and the thread has claimed.

```
Run tag: [project]-[thread code]-[step]-[4 random characters]
Window: [the main checkout | the <project code> worktree]

# Project Context
[Brief description of what we're building]

# Reference Documents
- Technical spec: docs/technical-spec.md
- Progress tracking: docs/progress-[feature-name].md

# Your Task
1. Read the technical specification
2. Review the progress tracking file
3. Execute the first incomplete step
4. After completing the step, update the progress file
5. Provide clear verification instructions for the human
6. Wait for verification before proceeding to the next step

# Verification Pattern
After each step, ask me to verify by:
- Opening the app
- Performing specific actions (be explicit)
- Confirming expected behavior

Only proceed to the next step after I confirm verification is successful.

# Important
- Mark steps complete in the progress file as you finish them
- Add notes about any decisions or issues encountered
- Never commit, push, merge, or run any git command that changes state
- If you need clarification, stop and ask
- If you need me to run more than one read-only SELECT in the Supabase SQL
  Editor, combine them into one query that returns a single JSON object: wrap
  each query as (select coalesce(json_agg(t), '[]'::json) from (<query>) t),
  give each a descriptive key inside json_build_object, and tell me to paste
  back the single result cell. Migrations and anything that changes data stay
  as separate statements.
```

### Step 4: Present to User

**For simple changes:**
"Here's your CLI prompt:" [paste prompt]

**For complex changes:**
1. Show the technical spec (or amendment to existing spec)
2. Show the progress file
3. Show the initial prompt
4. Say: "I've created the spec and progress tracking file. Copy these into your docs folder, then feed the initial prompt to Claude CLI."

**In alfred-v5, say where it goes and what has to happen first.** If the project
needs its own worktree, that is a `gitpush` (main → Push) then
`gitnewtree <project code>` before the first prompt, and the prompt goes in the
window `gitnewtree` opens. If it runs in the main checkout, say so. Either way
name the window, because he has several open.

## Example Outputs

### Example 1: Simple Change

**User request:** "I need CLI instructions to add a dark mode toggle to the navbar"

**Output:**
```
Run tag: alfred-q2z-dark-p3w9

Add a dark mode toggle to the navbar component. The toggle should:
- Use a sun/moon icon (react-icons preferred)
- Store preference in localStorage
- Apply theme by toggling a class on the root element
- Follow the existing button styling pattern in the navbar

The navbar is located at src/components/Navbar.jsx
```

### Example 2: Complex Change

**User request:** "Ready for CLI instructions to build the MIDI recording feature we discussed"

**Output includes:**

**technical-spec-midi-recording.md**
```markdown
# MIDI Recording Feature

## Overview
Add ability to record MIDI performances and save them for playback

## Key Components
- MIDIRecorder service class
- Recording state management
- File export (JSON format)
- Playback system integration

[... full spec ...]
```

**progress-midi-recording.md**
```markdown
# Progress: MIDI Recording Feature

## Status: Not Started

### Development Steps
- [ ] Create MIDIRecorder service class
- [ ] Add recording state to context
- [ ] Implement record/stop UI controls  
- [ ] Add playback from recording
- [ ] Implement file export

### Testing Steps
- [ ] Verify recording captures all notes
- [ ] Verify playback timing accuracy
- [ ] Test export/import cycle

### Notes
```

**Initial CLI Prompt**
```
Run tag: sam-m8t-midi1-h7k2

# Project Context
We're adding MIDI recording capability to the piano learning app. Users need to record their practice sessions and play them back.

# Reference Documents
- Technical spec: docs/technical-spec-midi-recording.md
- Progress tracking: docs/progress-midi-recording.md

# Your Task
1. Read the technical specification to understand the full scope
2. Review the progress tracking file
3. Execute the first incomplete step: Create MIDIRecorder service class
4. After implementation, update progress-midi-recording.md to mark the step complete
5. Provide verification instructions

# Verification Pattern
After completing the MIDIRecorder class, ask me to:
- Import and instantiate the recorder in the dev console
- Call start() and play some notes
- Call stop() and verify the recording object contains the note data
- Confirm the data structure matches the spec

Wait for my verification before proceeding to the next step.

# Important
- Update the progress file after each step
- Add notes about implementation decisions
- Stop and ask if anything is unclear
```

## Integration with Existing Work

When the user is continuing work on an existing project:

1. **Ask for current state**: "Can you share the current technical spec and progress file?"
2. **Assess what's needed**:
   - If user wants entirely new functionality: Create new spec and progress file
   - If user wants changes to existing work: Generate amendment to add to existing spec
3. **Reference existing context**: Include in the CLI prompt what's already built and what's changing

## Common Patterns

### Python Projects
- Emphasize virtual environment activation
- Include testing steps (pytest)
- Reference requirements.txt updates if needed

### React Projects  
- Include npm install steps if new dependencies
- Emphasize component testing in browser
- Reference existing component patterns

### General Best Practices
- Each step should be independently verifiable
- Progress file is the source of truth for status
- Verification should involve running the app, not just reading code
- Stop after verification, wait for user to say "continue" or "proceed"