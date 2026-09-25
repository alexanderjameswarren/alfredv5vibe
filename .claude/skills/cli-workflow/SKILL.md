---
name: cli-workflow
description: Runs both halves of the CLI loop for personal projects. Use it to generate CLI instruction sets when the user asks for "CLI instructions", a "code CLI prompt", or says they're ready to implement, in both React and Python projects. ALSO use it — this is the higher-frequency half — whenever the CLI's output comes back: when the user sends just "cli", says the CLI responded in any wording (fetch the report from the Alfred clipboard with get_recent_clips, matching this thread's run tag), or pastes a block of CLI output, whether or not they say so, including when they paste it with no comment, or ask only for a "TLDR", a summary, or "flag questions". Assume the user has NOT read the CLI output. Every generated CLI prompt starts with a "Run tag:" line. Always use this skill when CLI execution is anywhere in the picture, even if the user doesn't explicitly ask for formatted instructions.
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
very first line:**

```
Run tag: <project>-<thread code>-<step>-<4 random characters>
```

For example `jobs-ax4-s10-k7p2`.

- Lowercase letters, digits and hyphens only, at most 40 characters. Anything
  else is refused by the push script, not corrected.
- `<project>` is a short name for the work (`clip`, `ken`, `sam`, `dj`, `jobs`).
- **`<thread code>` is THIS conversation's own code: three lowercase letters or
  digits, made up the first time this thread issues a prompt and then reused for
  every prompt in this thread, unchanged.** It is not per step and not per
  prompt. Write it down in your first prompt and keep using it.
- `<step>` names the step (`s10`, `7b`, `fix`).
- The 4 random characters make it unique, so two prompts for the same step never
  share a tag. Make them up; they do not need to be meaningful.
- **A new prompt gets a new tag**, even when it continues the same work — only
  the project and thread code carry over. The full tag identifies one prompt and
  its messages; the prefix identifies the thread.

**Why the thread code earns its place.** An exact tag fetches the messages from
one prompt. The thread code is what lets this conversation fetch *everything it
has ever been told*: `get_recent_clips` takes a `run_tag_prefix`, so
`jobs-ax4` returns every report from this thread, oldest to newest, across every
step. That is the difference between "what did the CLI say about step 10" and
"remind me what has happened in this conversation" — worth having when a thread
is picked up days later, or when a report was read and then forgotten.

So: `run_tag` for one prompt's messages, `run_tag_prefix` for the whole thread.

**Existing tags stay valid.** Tags already issued in the older
`<project>-<step>-<random>` form (`clip-7b-q4m2`, `jobs-s9-t2v6`) still match
exactly and still fetch their reports. They simply have no thread code, so a
prefix search will not group them. Do not rewrite them, and do not go back and
re-tag anything.

- Remember the tag of the most recent prompt you issued in this thread. That is
  the tag you look for when the report comes back — and remember the thread code,
  which is how you find all of them.

In the Alfred repo (alfred-v5), the `CLAUDE.md` rule makes the CLI push its
closing message to the clipboard with `node scripts/clip.mjs --tag <tag>` EVERY
TIME it hands the turn back — finishing, waiting for something to be run or
verified, or asking a question — so the prompt only needs the tag line. Expect
several messages under one tag for a task that stops more than once. For a repo that does
not have `scripts/clip.mjs` and that rule, add this line to the prompt after the
tag: "When you finish, print your full report; Alex will paste it back." The
return leg then works from the pasted text as before.

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

### Rule 3: testing that requires a tool call becomes a copy-paste prompt

He cannot run a tool by being told its name and arguments. Telling him to "call
`create_ken_area` with name 'Music Theory' and confirm you get an id back" is
not a testing instruction — it is a description of a test he has no way to
perform.

When a test requires an MCP tool call, produce instead a fenced block he can
paste into a **new thread**, then paste that thread's reply back into this one.

**The new thread is mandatory, not a convenience.** A session loads its tool
manifest once, when it starts, and that list is frozen for the life of the
session. So a tool that was just deployed is invisible to every session that was
already running — including the CLI session that deployed it, and including the
current web chat thread. Neither can test it. Only a session started *after* the
deploy has the new tool in its manifest.

Two consequences, both non-negotiable:

- Never fold tool-call verification into the CLI prompt itself on the theory
  that the CLI can check its own work. For a newly created tool it cannot.
- Never attempt the tool call yourself in the current thread to "just check" —
  it will fail for the same reason, and the failure says nothing about whether
  the deploy worked.

The fresh thread has none of this conversation's context, so the prompt must
carry everything it needs, and must specify exactly what to report back and in
what shape — so the reply is pasteable without being read.

```
Run these tool calls in order and report the raw results, nothing else.

1. create_ken_area with name "Music Theory"
2. get_ken_areas

Report: the id returned by step 1, and whether "Music Theory" appears in
the step 2 results. No commentary, no interpretation.
```

Then tell him: paste this into a new thread, paste the reply back here.

Tests he can genuinely run himself — open the app, click this, look at that —
stay as ordinary numbered steps.

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
can trigger a deploy. Deploys the CLI runs itself (`npx supabase functions
deploy ...`) are fine and are not git — ask for those normally.

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

I need you to [clear description of the change].

[Any relevant context about the codebase, file locations, or constraints]

[If applicable: Reference any existing patterns or examples to follow]

[The Rule 5 SQL line from above]
```

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

```
Run tag: [project]-[thread code]-[step]-[4 random characters]

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