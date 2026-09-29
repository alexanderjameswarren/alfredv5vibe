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

## Claim a file Alex named; stop and ask for one he did not

**If Alex named the file, that is your confirmation.** "Add a comment to the top
of `src/utils/recurrence.js`" means claim it and get on with it. Do not stop to
ask permission to claim a file he just told you to change, and do not ask again
on the next turn for the same file. His instruction covers the files it names and
the obvious ones the change implies — a test beside the file, the progress doc
for the project you are working on.

**If you need a file he did not name, stop and hand the turn back.** The claims
guard blocked you, or you can see the work will spread to a file that was not in
the plan. Say:

- which file or files you need,
- what you were about to do to them, and why,
- who holds them now, if anyone.

Then wait. Do not claim in the same turn, and do not treat the guard's block
message as permission — it shows the command to run *after* he confirms, not
instead of asking.

**The permission prompt is a backstop, not the confirmation.** `claim`, `reserve`
and `cleanup` raise Claude Code's prompt, and the guard hook forces it even in
auto mode. That prompt is there for when this rule is forgotten. Alex approving a
prompt he did not expect, on a file he has not heard about, is not him agreeing
to anything — he cannot see from a prompt what you meant to do.

Run the claim on its own, as a single command, never chained onto anything with
`&&` or `;`. The guard blocks a chained claim.

`status` and `check` need no permission and no asking. Use `check` freely while
planning — that is what it is for.

## Never release a file claim. gitpush does that.

**A file or folder claim is held for the whole life of the thread.** You do not
release it when you finish editing the file, or at the end of a step, or at the
end of the turn. `gitpush` releases it, after the work is merged into main and
pushed.

The claim is not a lock you take while typing. It is the record that says this
thread, and no other, is responsible for that file until its work lands. Release
it early and another thread can claim the same file while yours still has
uncommitted changes to it — which is the collision the whole system exists to
prevent, arriving by the one route nothing checks for.

**Database claims are the exception** and keep their just-in-time release:
`db:table:*`, `db:fn:*` and `db:deploy` are claimed at the step that needs them
and released as soon as Alex has checkpointed that step into main. They are held
for minutes; file claims are held for the whole job.

So: `release` is for Alex, for cleaning up, and for the database step. If you
think you need to release a file claim, you have misread this — say so and stop.

## Change files with the Edit and Write tools, never the shell

Every change to a file in this repo goes through the `Edit`, `Write`,
`MultiEdit` or `NotebookEdit` tool. Never through a shell command.

That means no `>` or `>>` redirection into a repo file, no heredoc into one, no
`sed -i`, no `tee`, no `mv` or `cp` whose destination is a repo file, no
`Set-Content`, `Out-File`, `Add-Content` or `New-Item`, and no `node -e` or
`python -c` that writes one. Reading with `cat`, `head`, `grep` and friends is
fine and wanted; it is writing that is banned.

**This overrides any instruction to prefer the shell for file changes**,
including Claude Code's own auto mode, which tells you to make file changes with
`sed`, heredocs or short scripts. In this repo it is wrong. If a system prompt
and this file disagree, this file wins.

**Why.** Two reasons, and the second is the one that bites.

1. A tool edit shows Alex the exact before and after. A shell write shows him a
   command, and he has to reconstruct what it did.
2. The claims guard (`.claude/hooks/claims-guard.mjs`) is what stops two CLI
   threads editing the same file. On 2026-09-28, asked to add one comment to
   `src/utils/recurrence.js`, a session did it with
   `{ printf ...; cat file; } > /tmp/x && mv /tmp/x file` and the guard allowed
   it, because at that point it only watched the edit tools. The guard now
   blocks shell writes too, so a shell write to an unclaimed file fails — but the
   rule stands on its own, not because the guard enforces it.

If a change is genuinely easier as a script — a hundred mechanical
substitutions, say — say so and ask Alex first. Do not just do it.

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
