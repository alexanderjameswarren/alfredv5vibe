-- Analyzer port — what are bump_parent_edited_at and stamp_song_edited?
-- Read-only. Neither function has ever existed in this repo or its git
-- history: both were created directly in the SQL editor (almost certainly the
-- Feb 2026 data-layer "Phase 1" SQL, which was run by hand and never
-- committed). So the database is the only place to find out what they do.
--
-- The earlier trigger check listed triggers on sam_songs and
-- sam_song_measures only. A function "attached to no trigger" there may still
-- be attached to a trigger on ANOTHER table, or to an event trigger — query 2
-- checks everywhere.

-- 1. Full definitions, plus the facts that decide how they behave:
--    trigger function or not, security definer, owner, comment.
select p.oid,
       n.nspname                         as schema,
       p.proname                         as function,
       pg_get_function_result(p.oid)     as returns,
       p.prosecdef                       as security_definer,
       pg_get_userbyid(p.proowner)       as owner,
       obj_description(p.oid, 'pg_proc') as comment,
       pg_get_functiondef(p.oid)         as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname in ('bump_parent_edited_at', 'stamp_song_edited')
   or p.prosrc ilike '%measures_edited_at%'
order by p.proname;

-- 2. Every trigger, on ANY table, that calls either function. Empty for
--    stamp_song_edited = not attached anywhere.
select c.relnamespace::regnamespace as schema, c.relname as "table",
       t.tgname, t.tgenabled, p.proname as function,
       pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where p.proname in ('bump_parent_edited_at', 'stamp_song_edited')
order by p.proname, c.relname;

-- 3. Event triggers that call either function (DDL-level; expect none).
select e.evtname, e.evtevent, e.evtenabled, p.proname
from pg_event_trigger e
join pg_proc p on p.oid = e.evtfoid
where p.proname in ('bump_parent_edited_at', 'stamp_song_edited');

-- 4. Anything else that calls stamp_song_edited by name — another function,
--    a view, a policy expression, a cron job.
select 'function' as kind, n.nspname || '.' || p.proname as name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosrc ilike '%stamp_song_edited%' and p.proname <> 'stamp_song_edited'
union all
select 'view', schemaname || '.' || viewname
from pg_views where definition ilike '%stamp_song_edited%'
union all
select 'policy', schemaname || '.' || tablename || ' ' || policyname
from pg_policies
where coalesce(qual, '') ilike '%stamp_song_edited%'
   or coalesce(with_check, '') ilike '%stamp_song_edited%';

-- 4b. pg_cron jobs, if pg_cron is installed (skip if this errors).
select jobid, jobname, schedule, command
from cron.job
where command ilike '%stamp_song_edited%' or command ilike '%measures_edited_at%';

-- 5. Did a CLI migration ever create or drop them? (Skip if the table does
--    not exist — it only does if `supabase db push` has ever been used.)
select version, name
from supabase_migrations.schema_migrations
where array_to_string(statements, ' ') ilike '%stamp_song_edited%'
   or array_to_string(statements, ' ') ilike '%bump_parent_edited_at%';
