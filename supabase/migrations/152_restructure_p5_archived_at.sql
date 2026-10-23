-- Purpose: Restructure P5 Step 12 follow-up (restructure_p5-h7m). Every public table with an archived column gets archived_at timestamptz: when the row was archived, so Archived lists sort by it. One shared trigger function, public.set_archived_at(), sets it to now() when archived becomes true, clears it when archived becomes false, and otherwise leaves it as it was. No restored-on date: platform.audit_log already records restores.
-- Kind: schema change (nine columns, one function, nine triggers) plus a one-off backfill
-- Applied: NO
--
-- Tables: contexts, events, inbox, intents, item_collections, item_groups, items, sam_snippets, sam_songs.
-- Run as one block in the SQL editor, then supabase/tests/restructure_p5-h7m/step12_archived_at_verify.sql.
-- Safe to re-run: the backfill only fills rows whose archived_at is still null.
-- No new table, so no register_table call; adding a column and a trigger leaves conformance as it was.
-- Backfill: the latest false-to-true change in platform.audit_log (an INSERT already archived counts),
-- else updated_at, else now(). It runs with each table's user triggers paused, so it does not bump
-- updated_at, trip status_guard, or write nine tables' worth of rows into the audit log.

begin;

create or replace function public.set_archived_at() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A re-inserted row (Undo of a delete) may carry its old date; keep it.
    new.archived_at := case when new.archived is true then coalesce(new.archived_at, now()) end;
  elsif coalesce(new.archived, false) is distinct from coalesce(old.archived, false) then
    new.archived_at := case when new.archived is true then now() end;
  else
    new.archived_at := old.archived_at;
  end if;
  return new;
end;
$$;

comment on function public.set_archived_at() is
  'Restructure P5. BEFORE INSERT OR UPDATE trigger on every table with an archived column: archived_at is now() when archived turns true, null when it turns false, and otherwise unchanged (a client cannot set it directly). Restores are not dated here; platform.audit_log has them.';

do $$
declare
  t text;
begin
  foreach t in array array['contexts', 'events', 'inbox', 'intents', 'item_collections', 'item_groups', 'items', 'sam_snippets', 'sam_songs'] loop
    execute format('alter table public.%I add column if not exists archived_at timestamptz', t);
    execute format(
      'comment on column public.%I.archived_at is %L', t,
      'When this row was archived; null while it is not. Set only by the set_archived_at trigger. Archived lists sort by it, newest first.');

    execute format('alter table public.%I disable trigger user', t);
    execute format(
      'update public.%I r set archived_at = coalesce(a.at, r.updated_at, now())
         from public.%I r2
         left join (
           select l.record_id, max(l.occurred_at) as at
             from platform.audit_log l
            where l.table_name = %L
              and l.op in (''INSERT'', ''UPDATE'')
              and coalesce((l.old_row->>''archived'')::boolean, false) = false
              and (l.new_row->>''archived'')::boolean is true
            group by l.record_id
         ) a on a.record_id = r2.id::text
        where r2.id = r.id and r.archived is true and r.archived_at is null',
      t, t, 'public.' || t);
    execute format('alter table public.%I enable trigger user', t);

    execute format('drop trigger if exists set_archived_at on public.%I', t);
    execute format(
      'create trigger set_archived_at before insert or update on public.%I
         for each row execute function public.set_archived_at()', t);
  end loop;
end;
$$;

commit;
