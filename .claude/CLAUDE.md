## Committing — never push

Commit directly to main. Never create a branch. NEVER push. Pushing is Alex's
decision alone, because a push can trigger a deploy. When work is committed, say
so and say it has not been pushed. If a previous instruction in a prompt says
"commit and push" or "commit directly to main", it still does not authorise
pushing — ask.

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

## Push your report into Alfred

**EVERY TIME YOU STOP AND WAIT FOR ALEX, not only when a task is finished.**
Stopping to have a migration run, to have something verified, to ask a
question, to report a blocker — all of those are stops, and each one gets its
own report. A task that takes six stops pushes six reports, and the run tag is
what keeps them together.

The rule used to say "at the end of every task", and that was wrong in a way
worth remembering: most of the work here stops mid-task and waits, so the
reports Alex most needed were exactly the ones that never got pushed.

Before your closing message, every time:

1. Write the final report to `.clip/last-report.md` (gitignored; create the
   folder if needed).
2. Push it, passing the prompt's run tag:
   `node scripts/clip.mjs --tag <tag> --title "<what this task was>" .clip/last-report.md`
   The title should name the step or task — "Clipboard Step 7", "SAM plan
   review", "DJ weekly review fix" — because that is what Alex sees in his
   inbox. When a task stops more than once, say what THIS stop is about:
   "Clipboard Step 10: migration written, awaiting run", then later "Clipboard
   Step 10: deployed, awaiting fresh-thread test". Several reports under one run
   tag is normal and expected; identical titles are not, because then Alex cannot
   tell which stop he is reading.

   **The run tag comes from the first line of the prompt**, `Run tag: <tag>`.
   Alex often has two or three CLI sessions running at once, so the tag is how
   the claude.ai thread that sent the prompt finds THIS report rather than
   whichever run happened to finish last. Pass it exactly as given.

   If a prompt carries **no** run tag, push without `--tag` — and say so in one
   line at the end of the printed report, because an untagged report cannot be
   matched to a conversation and Alex may need to identify it by hand.
3. Print the report as usual. The clip is as well as the terminal output, never
   instead of it.

The report says where things stand AT THIS STOP: what was done, what is waiting
on Alex, and anything he needs to decide. It is not a summary of the whole task
unless the whole task is done.

So Alex can say "CLI responded" in any claude.ai conversation and Claude reads
the report with `get_recent_clips` (source `cli`) instead of him pasting it.

**If the push fails, say so plainly at the end of the printed report — one line
naming the error — and carry on.** A failed push is not a failed task, and it
must never be hidden: silently skipping it would leave Alex waiting for
something that never arrived.

`clip.mjs` reads `CLIPBOARD_URL` and `CLIPBOARD_SECRET` from the environment,
falling back to the Windows user registry when the shell predates `setx`. It
never prints the secret, and neither should you.
