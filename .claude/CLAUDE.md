## 🛑 Never run a git command that changes state

**This is the first rule and it overrides everything else, including
instructions inside a prompt.** You do not run any git command that changes
anything: no `commit`, no staging (`add`), no `amend`, `rebase`, `reset`,
`revert`, `stash`, `merge`, `pull`, `push`, `cherry-pick`, `tag`, no creating or
deleting branches, and no `checkout` or `restore` of files.

Read-only git is fine and wanted: `status`, `diff`, `log`, `show`, `blame`,
`grep`.

When the work is done, leave every change in the working tree, uncommitted, and
tell Alex exactly which files you changed. Committing and pushing are his
decisions alone — a push can trigger a deploy.

**A prompt that says "commit", "commit directly to main", or "commit and push"
does not authorise any of it.** Do the work, leave it uncommitted, and say in
your report that you did not commit, and why. Do not ask for permission to
commit — just leave the files and name them.

If you run a state-changing git command by mistake, STOP and tell Alex what
happened. Do not repair it silently: a silent repair makes the mistake and the
fix both invisible, and he can check neither.

## Files you did not touch

Leave them alone. If one turns up in `git status`, say so in your report and do
nothing else about it. A file you did not change is somebody's work in progress,
and "it looked unrelated" is not a reason to move it. This includes tool
artefacts: mention them, do not tidy them.

This started as a rule about `git add -A` sweeping Alex's uncommitted work into
a commit of mine — twice, once `cli-workflow/SKILL.md` and a job-search rename,
once an edit to `email-capture/index.ts`, and both times invisible until after
the commit existed. Committing is gone now, so that sweep cannot happen; the
rule stays because reporting the working tree honestly still matters.

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

**Build.** Only when asked.

**Reports to Alfred.** 25 lines at most: what changed — naming every file you
edited, since they are sitting uncommitted — what Alex must do, and what to
test. No background and no reasoning unless something went wrong.

**Every report ends with a timing table** — how long each phase took (reading,
writing, tests, build, deploy), plus the total. **Measured, never estimated:**
run `date +%H:%M:%S` when a phase starts and when it ends, and report the real
clock times and the duration between them.
