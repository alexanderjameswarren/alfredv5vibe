## Committing — never push

Commit directly to main. Never create a branch. NEVER push. Pushing is Alex's
decision alone, because a push can trigger a deploy. When work is committed, say
so and say it has not been pushed. If a previous instruction in a prompt says
"commit and push" or "commit directly to main", it still does not authorise
pushing — ask.

## Git rules

These are not preferences. Each one is here because it went wrong.

**Stage explicit paths only.** Never `git add -A`, never `git add .`, never
`git commit -a`. Name every file you are committing. Twice now, `git add -A`
has swept an uncommitted change of Alex's into a commit of mine — once
`cli-workflow/SKILL.md` and a job-search rename, once an edit to
`email-capture/index.ts` — and both times the sweep was invisible until after
the commit existed.

**Never stage, commit, stash, restore or discard a file you did not change in
this task.** If one turns up in `git status`, leave it exactly where it is and
say so in your report. A file you did not touch is somebody's work in progress,
and "it looked unrelated" is not a reason to move it. This includes tool
artefacts: mention them, do not tidy them.

**Never amend, reset, rebase or otherwise rewrite a commit without asking Alex
first.** If you commit something by mistake, STOP and tell him what happened.
Do not repair it silently — a silent repair means the mistake and the fix are
both invisible, and he cannot check either. Ask, and wait.

**Never push.** See the section above; it is the same rule and it still holds.

## All SQL lives in supabase/migrations/

ALL SQL goes in supabase/migrations/, numbered in sequence, no exceptions. That
includes schema changes, backfills, data repairs and one-off diagnostic queries.
Never create SQL under docs/. Name the file so its purpose is obvious from the
list, e.g. 031_backfill_sam_session_events.sql. Alex runs every migration himself
in the Supabase SQL editor — never apply one, and never assume one has been
applied.

supabase/migrations/ now holds three kinds of file, and the MOVED header on each
says which: schema changes that must be applied in order; one-off data repairs
and backfills, applied once; and read-only diagnostics and verification queries
that are never "applied" at all. Do not treat the folder as a sequence to run end
to end, and do not assume a numbered file was ever run — Alex runs each one
himself and says so. Files 001-030 are schema changes; 031-056 are mixed, and
were renumbered from docs/ on 2026-09-18.

## Supabase verification queries

When you ask me to run more than one SELECT query in the Supabase SQL Editor,
combine them into a single query that returns one JSON object, so I can run it
once and paste back a single result. Use this pattern:

select json_build_object(
  'descriptive_name_1', (select json_agg(t) from (<query 1>) t),
  'descriptive_name_2', (select json_agg(t) from (<query 2>) t)
) as result;

Rules:
- Give each section a descriptive key that says what it checks.
- Wrap every query in the (select json_agg(t) from (...) t) form, even if it returns one row.
- Do not end inner queries with a semicolon.
- This applies only to read-only SELECT checks. Migrations and anything that
  changes data stay as separate statements.

## Everything you say to Alex goes into Alfred

**Why this rule exists.** Alex does not read this terminal. He reads your
messages through Alfred: a claude.ai conversation fetches them from the
Alfred clipboard and explains them to him. Anything you say that is not
pushed to Alfred is, for practical purposes, never said. That includes
questions you ask him, answers, corrections, apologies, and warnings, not
just end-of-task reports. The clipboard is also his permanent record of
every CLI session, reconstructable by run tag.

**The rule.** Every time you hand the turn back to Alex, for any reason
(finished, waiting for him to run something or verify something, asking
a question, reporting a blocker, answering him, or acknowledging a
correction), your closing message is pushed to Alfred first.

**How.** Compose your complete closing message, everything you are about
to say to Alex, and write it to .clip/last-report.md. Push that file with
clip.mjs. Then print exactly that same text as your closing message. The
pushed text and the printed text must be identical: do not push a summary
and then say more, and do not add anything after the push. If you realize
you need to say more, write a new message, push it, and print it.

**Titles** name the task and what this particular message is, for
example "Clipboard Step 10: migration written, awaiting run", then
"Clipboard Step 10: deployed, awaiting fresh-thread test", or "Step 10:
question about the sources report". Several messages under one run tag
are expected; identical titles are not.

**Run tags.** Pass the prompt's run tag with --tag, exactly as given on
the prompt's first line. If the prompt has no run tag, push without one
and say so in one line at the end of the message.

**What goes in.** Everything you would say to Alex. What does not: your
command-by-command working log. Summarize what you did; do not paste
tool transcripts.

**If the push fails,** say so in one line at the end of the printed
message, naming the error, and carry on. Never hide a failed push.

`clip.mjs` reads `CLIPBOARD_URL` and `CLIPBOARD_SECRET` from the environment,
falling back to the Windows user registry when the shell predates `setx`. It
never prints the secret, and neither should you.

## Working fast

**Comments.** One or two lines, and only where the code is not obvious. No
essays in code or in tests.

**Tests.** Only what the change needs. Short test names, no prose.

**Search.** Use `git grep` or the Grep tool. Never a plain recursive grep over
the repo — it scans node_modules and times out.

**Run tests with:**

```
CI=true npx react-scripts test --watchAll=false
```

Never plain `npx jest`. While working, run only the test files related to the
change; run the full suite once, at the end.

**Build.** Only when asked, or before a push.

**Reports to Alfred.** 25 lines at most: what changed, what Alex must do, what
to test. No background and no reasoning unless something went wrong.

**Every report ends with a timing table** — how long each phase took (reading,
writing, tests, build, deploy, git), plus the total. **Measured, never estimated:**
run `date +%H:%M:%S` when a phase starts and when it ends, and report the real
clock times and the duration between them.
