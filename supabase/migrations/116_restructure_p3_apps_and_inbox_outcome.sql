-- Purpose: Restructure Phase 3, step 2. The apps table (seeded), contexts.app_id, inbox.source_app (with an insert trigger and backfill from source_metadata->>'app'), inbox.outcome, job_applications.source_inbox_id, and the corrected inbox.archive_reason comment.
-- Kind: schema change (new table, new columns, new trigger, data backfill)
-- Applied: YES — confirmed 2026-10-11, CONFORMANT (60 tables); 0 contexts matched "Body, Mind and Spirit"
--
-- Spec: docs/technical-spec-restructure_p3.md. Run as one block in the SQL editor.
-- Safe to re-run: every create, add, seed and backfill is idempotent.
-- supabase/migrations/116_restructure_p3_apps_and_inbox_outcome.sql

-- ============================================================================
-- 1. apps
-- ============================================================================
create table if not exists public.apps (
  id          text primary key,
  name        text not null,
  description text not null,
  icon        text not null,
  path        text,
  button_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint apps_id_slug check (id ~ '^[a-z][a-z0-9_]*$'),
  constraint apps_screen_pair check ((path is null) = (button_name is null))
);

comment on table public.apps is
  'ALFRED. The apps Alfred is made of: one row per app, whether or not it has a screen. Shared reference data with no user_id: every signed-in user reads it, and only migrations write it. Referenced by contexts.app_id and inbox.source_app.';
comment on column public.apps.id is
  'Text slug, e.g. warren_buffet. Matches platform_runs.app and the app named in inbox.source_metadata->>''app''. Tools take this value.';
comment on column public.apps.name is 'Display name of the app.';
comment on column public.apps.description is
  'One plain line saying what belongs to this app. Enrichment reads it to choose inbox.source_app, the way context descriptions choose a context.';
comment on column public.apps.icon is 'lucide-react icon name, e.g. Wallet.';
comment on column public.apps.path is
  'Route of the app''s screen in the Alfred web app, e.g. /money. Null when the app has no screen.';
comment on column public.apps.button_name is
  'Label of the app''s nav button. Null when the app has no screen. Nav buttons do not read this yet (Restructure Phase 3).';
comment on column public.apps.created_at is 'Row creation.';
comment on column public.apps.updated_at is 'Last change. Stamped by the apps_touch_updated_at trigger.';

create or replace function public.apps_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.apps_touch_updated_at() is 'Alfred: stamps apps.updated_at.';

drop trigger if exists apps_touch_updated_at on public.apps;
create trigger apps_touch_updated_at
  before update on public.apps
  for each row execute function public.apps_touch_updated_at();

insert into public.apps (id, name, description, icon, path, button_name) values
  ('alfred', 'Alfred',
   'Everyday life and household admin: tasks, errands, people, places, recipes, plus Alfred''s own bugs and features, and anything no other app covers.',
   'House', '/', 'Home'),
  ('warren_buffet', 'Warren Buffet',
   'Money: bank and investment accounts, transactions, spending, bills, budgets, net worth and tax.',
   'Wallet', '/money', 'Money'),
  ('timer', 'Timer', 'Timed sessions run on the Timer screen.', 'Timer', '/timer', 'Timer'),
  ('sam', 'Sam', 'Piano practice: songs, scores, lyrics, practice goals and practice plans.',
   'Music', '/sam', 'Sam'),
  ('games', 'Games', 'Games played on the Games screen.', 'Gamepad2', '/games', 'Games'),
  ('jobs', 'Jobs',
   'Job search and consulting: postings, job alerts, applications, recruiters, interviews and follow-ups.',
   'Briefcase', null, null),
  ('dj', 'DJ', 'Music listening: artists, albums, concerts, setlists, playlists and jazz.',
   'Disc3', null, null),
  ('drive_mix', 'Drive Mix',
   'The car playlist: songs and artists to add or cut, thumbs, and today''s mix.',
   'Car', null, null),
  ('ken', 'Ken',
   'Learning and quizzing: facts to learn, quiz areas, corrections and misconceptions.',
   'GraduationCap', null, null),
  ('workshop', 'Workshop',
   'The Workshop server on the Surface tablet: its tunnel, uptime and the jobs it runs.',
   'Wrench', null, null),
  ('arnold', 'Arnold', 'Workouts and movement: gym classes, exercise sessions and fitness goals.',
   'Dumbbell', null, null)
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  icon        = excluded.icon,
  path        = excluded.path,
  button_name = excluded.button_name;

-- policy_mode 'none', contract case (b)-like: no user_id, so the policy is ours.
-- Read-only to signed-in users; no insert/update/delete policy, so only
-- migrations (as postgres) write it.
select platform.register_table(
  'public.apps',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Alfred. The apps Alfred is made of, shared reference data with no user_id. Read-only to authenticated; written only by migrations.'
);

drop policy if exists apps_read on public.apps;
create policy apps_read on public.apps
  for select to authenticated
  using (true);

-- ============================================================================
-- 2. contexts.app_id
-- ============================================================================
alter table public.contexts
  add column if not exists app_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contexts'::regclass and conname = 'contexts_app_id_fkey'
  ) then
    alter table public.contexts
      add constraint contexts_app_id_fkey
      foreign key (app_id) references public.apps (id) on delete set null;
  end if;
end
$$;

comment on column public.contexts.app_id is
  'The app this context belongs to, or null. Set by hand on the context form. Not used to guess inbox.source_app (Restructure Phase 3 decision 3).';

-- Arnold owns the "Body, Mind and Spirit" context, matched by exact name. Left
-- unset, with a notice, unless exactly one context has that name.
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.contexts where name = 'Body, Mind and Spirit';
  if v_count = 1 then
    update public.contexts set app_id = 'arnold'
    where name = 'Body, Mind and Spirit' and app_id is distinct from 'arnold';
  else
    raise notice 'contexts.app_id: % contexts named "Body, Mind and Spirit"; arnold not set.', v_count;
  end if;
end
$$;

-- ============================================================================
-- 3. inbox.source_app, its insert trigger and backfill
-- ============================================================================
alter table public.inbox
  add column if not exists source_app text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inbox'::regclass and conname = 'inbox_source_app_fkey'
  ) then
    alter table public.inbox
      add constraint inbox_source_app_fkey
      foreign key (source_app) references public.apps (id) on delete set null;
  end if;
end
$$;

comment on column public.inbox.source_app is
  'Which app this capture belongs to, or null while unknown. Never guessed at capture: set at creation only when the sender knows it (create_inbox_item, scheduled tasks, or source_metadata->>''app'' via inbox_set_source_app), otherwise filled in by enrichment or the App picker on the inbox detail page, and kept by processing. Separate from source_type, which says how the capture arrived.';

create or replace function public.inbox_set_source_app()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source_app is null
     and new.source_metadata ? 'app'
     and exists (select 1 from public.apps a where a.id = new.source_metadata->>'app') then
    new.source_app := new.source_metadata->>'app';
  end if;
  return new;
end;
$$;

comment on function public.inbox_set_source_app() is
  'Alfred: on inbox insert, copies source_metadata->>''app'' into source_app when source_app is null and the value names a row in apps (wb-sync sets app = warren_buffet).';

drop trigger if exists inbox_set_source_app on public.inbox;
create trigger inbox_set_source_app
  before insert on public.inbox
  for each row execute function public.inbox_set_source_app();

update public.inbox i
set source_app = i.source_metadata->>'app'
where i.source_app is null
  and i.source_metadata ? 'app'
  and exists (select 1 from public.apps a where a.id = i.source_metadata->>'app');

-- ============================================================================
-- 4. inbox.outcome
-- ============================================================================
create or replace function public.inbox_outcome_valid(p_outcome jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_outcome) = 'array'
     and not exists (
       select 1 from jsonb_array_elements(p_outcome) e
       where jsonb_typeof(e) <> 'object'
          or jsonb_typeof(e->'table') is distinct from 'string'
          or jsonb_typeof(e->'id') is distinct from 'string'
          or btrim(e->>'table') = ''
          or btrim(e->>'id') = ''
     );
$$;

comment on function public.inbox_outcome_valid(jsonb) is
  'Alfred: true when an inbox.outcome value is an array of {table, id} objects with non-empty string values.';

alter table public.inbox
  add column if not exists outcome jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inbox'::regclass and conname = 'inbox_outcome_shape'
  ) then
    alter table public.inbox
      add constraint inbox_outcome_shape check (public.inbox_outcome_valid(outcome));
  end if;
end
$$;

comment on column public.inbox.outcome is
  'Every record this capture became: a list of {"table": "intents" | "items" | "events" | "job_applications" | ..., "id": "<id>"}. Empty until processed. Written by the app''s Process and by archive_inbox_item. The reverse link is source_inbox_id on items, intents, events and job_applications.';

-- ============================================================================
-- 5. job_applications.source_inbox_id
-- ============================================================================
alter table public.job_applications
  add column if not exists source_inbox_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_applications'::regclass
      and conname = 'job_applications_source_inbox_id_fkey'
  ) then
    alter table public.job_applications
      add constraint job_applications_source_inbox_id_fkey
      foreign key (source_inbox_id) references public.inbox (id) on delete set null;
  end if;
end
$$;

create index if not exists job_applications_source_inbox_idx
  on public.job_applications (source_inbox_id) where source_inbox_id is not null;

comment on column public.job_applications.source_inbox_id is
  'The inbox capture this application was created from, or null. text because inbox.id is text. ON DELETE SET NULL, like source_inbox_id on items, intents and events. Set by create_job_application''s inbox_id parameter.';

-- ============================================================================
-- 6. Corrected inbox.archive_reason comment
-- ============================================================================
comment on column public.inbox.archive_reason is
  'WHY this row was archived, or null while it is still in the inbox. '
  '''discarded'' = binned with the trash can on the inbox screen. '
  '''processed'' = handled: by the app''s Process (detail page or one-tap), which '
  'creates the item, intention or event and then archives, or by archive_inbox_item '
  'from Claude. Processing archives; nothing deletes inbox rows. Both reasons are '
  'reversible. Set together with archived and triaged_at, and cleared together with '
  'them on un-archive (inbox_archive_reason_needs_archived enforces the pairing). '
  'What a processed capture became is in outcome.';

-- ============================================================================
-- 7. Conformance: must return CONFORMANT
-- ============================================================================
select public.platform_check_conformance();
