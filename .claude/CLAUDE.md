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