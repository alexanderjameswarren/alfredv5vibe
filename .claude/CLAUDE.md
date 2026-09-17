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