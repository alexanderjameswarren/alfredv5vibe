-- Purpose: Homer slice 1 (homer-h4k, phase B). The 11 Homer tables, the versioned plan and create_homer_plan, and the
-- guards: plan rows never edited, "never" verdicts only from Alex, taste scores checked against the active plan's
-- scales, reads one per book per device with the reader carried from the device's owner.
-- Kind: schema change (11 tables, 1 RPC, 2 validators, 5 trigger functions). No data.
-- Applied: NO
--
-- Spec: docs/homer-spec-homer-h4k.md ("Decisions", "Tables", "Functions"). Then run supabase/tests/homer-h4k/1_verify.sql
-- and 2_guards_test.sql through the queue with --test.
-- Safe to re-run: every create is idempotent.
-- supabase/migrations/224_homer_core.sql

begin;

-- ============================================================================
-- 1. Validators (pure; used by the plan check constraint, the RPC and the scores trigger)
-- ============================================================================
create or replace function public.homer_plan_settings_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  s jsonb;
  v_keys text[] := '{}';
  v_key text;
  v_kind text;
  dv jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'settings must be a JSON object'; end if;
  if jsonb_typeof(p -> 'scales') is distinct from 'array' then return 'settings.scales must be an array'; end if;
  for s in select value from jsonb_array_elements(p -> 'scales') loop
    if jsonb_typeof(s) <> 'object' then return 'each scale must be an object'; end if;
    v_key := s ->> 'key';
    v_kind := s ->> 'kind';
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]*$' then return format('scale key %s must be a lowercase slug', coalesce(v_key, 'null')); end if;
    if v_key = any(v_keys) then return format('scale key %s appears twice', v_key); end if;
    v_keys := v_keys || v_key;
    if coalesce(btrim(s ->> 'label'), '') = '' then return format('scale %s needs a label', v_key); end if;
    if v_kind = 'range' then
      if jsonb_typeof(s -> 'min') is distinct from 'number' or jsonb_typeof(s -> 'max') is distinct from 'number'
         or (s ->> 'min')::numeric >= (s ->> 'max')::numeric then
        return format('range scale %s needs numbers min < max', v_key);
      end if;
    elsif v_kind in ('choice', 'multi') then
      if jsonb_typeof(s -> 'choices') is distinct from 'array' or jsonb_array_length(s -> 'choices') = 0
         or exists (select 1 from jsonb_array_elements(s -> 'choices') c where jsonb_typeof(c) <> 'string')
         or (select count(distinct c) from jsonb_array_elements_text(s -> 'choices') c) <> jsonb_array_length(s -> 'choices') then
        return format('%s scale %s needs a non-empty list of distinct text choices', v_kind, v_key);
      end if;
    else
      return format('scale %s: kind must be range, choice or multi', v_key);
    end if;
  end loop;

  dv := p -> 'default_verdict';
  if jsonb_typeof(dv) is distinct from 'object'
     or jsonb_typeof(dv -> 'liked_min_finished') is distinct from 'number'
     or (dv ->> 'liked_min_finished')::numeric < 1
     or (dv ->> 'liked_min_finished')::numeric <> trunc((dv ->> 'liked_min_finished')::numeric)
     or coalesce(dv ->> 'otherwise', '') not in ('loved', 'liked', 'tired', 'didnt_click') then
    return 'settings.default_verdict needs liked_min_finished (whole number, at least 1) and otherwise (loved, liked, tired or didnt_click; never is not allowed)';
  end if;
  if jsonb_typeof(p -> 'tired_gap_days') is distinct from 'number' or (p ->> 'tired_gap_days')::numeric < 0 then
    return 'settings.tired_gap_days must be a number, 0 or more';
  end if;
  if jsonb_typeof(p -> 'quiet_after_days') is distinct from 'number' or (p ->> 'quiet_after_days')::numeric < 1 then
    return 'settings.quiet_after_days must be a number, 1 or more';
  end if;
  if p ? 'suggestions' and jsonb_typeof(p -> 'suggestions') <> 'object' then
    return 'settings.suggestions must be an object';
  end if;
  return null;
end;
$$;

comment on function public.homer_plan_settings_problem(jsonb) is
  'Homer: null when plan settings are valid, otherwise the first problem in plain words. Checks scales (key, label, '
  'kind range/choice/multi), default_verdict, tired_gap_days, quiet_after_days and suggestions.';
revoke all on function public.homer_plan_settings_problem(jsonb) from public, anon;
grant execute on function public.homer_plan_settings_problem(jsonb) to authenticated, service_role;

create or replace function public.homer_scores_problem(p_scores jsonb, p_settings jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  e record;
  s jsonb;
begin
  if p_scores is null or jsonb_typeof(p_scores) <> 'object' then return 'scores must be a JSON object'; end if;
  for e in select key, value from jsonb_each(p_scores) loop
    select value into s from jsonb_array_elements(coalesce(p_settings -> 'scales', '[]'::jsonb)) where value ->> 'key' = e.key;
    if s is null then return format('%s is not a scale in the active plan', e.key); end if;
    if s ->> 'kind' = 'range' then
      if jsonb_typeof(e.value) <> 'number'
         or (e.value #>> '{}')::numeric < (s ->> 'min')::numeric or (e.value #>> '{}')::numeric > (s ->> 'max')::numeric then
        return format('%s must be a number from %s to %s', e.key, s ->> 'min', s ->> 'max');
      end if;
    elsif s ->> 'kind' = 'choice' then
      if jsonb_typeof(e.value) <> 'string' or not (s -> 'choices') @> jsonb_build_array(e.value) then
        return format('%s must be one of %s', e.key, s -> 'choices');
      end if;
    else
      if jsonb_typeof(e.value) <> 'array'
         or exists (select 1 from jsonb_array_elements(e.value) c where not (s -> 'choices') @> jsonb_build_array(c)) then
        return format('%s must be a list drawn from %s', e.key, s -> 'choices');
      end if;
    end if;
    s := null;
  end loop;
  return null;
end;
$$;

comment on function public.homer_scores_problem(jsonb, jsonb) is
  'Homer: null when taste scores fit the given plan settings, otherwise the first problem. Every key must be a scale; '
  'range values within min..max, choice values one of the choices, multi values a list of choices.';
revoke all on function public.homer_scores_problem(jsonb, jsonb) from public, anon;
grant execute on function public.homer_scores_problem(jsonb, jsonb) to authenticated, service_role;

-- ============================================================================
-- 2. homer_plans (versioned, never edited, one active per user)
-- ============================================================================
create table if not exists public.homer_plans (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null default auth.uid() references auth.users (id),
  version            integer     not null,
  status             text        not null default 'active',
  instructions       text        not null,
  settings           jsonb       not null,
  change_summary     text,
  written_by         text        not null default 'claude',
  supersedes_plan_id uuid        references public.homer_plans (id),
  created_at         timestamptz not null default now(),
  ended_at           timestamptz,

  constraint homer_plans_status_values check (status in ('active', 'superseded')),
  constraint homer_plans_ended_with_status check ((status = 'superseded') = (ended_at is not null)),
  constraint homer_plans_written_by_values check (written_by in ('alex', 'claude')),
  constraint homer_plans_settings_valid check (public.homer_plan_settings_problem(settings) is null),
  constraint homer_plans_summary_on_supersede
    check (supersedes_plan_id is null or length(btrim(coalesce(change_summary, ''))) > 0),
  constraint homer_plans_user_version unique (user_id, version)
);

create unique index if not exists homer_plans_one_active on public.homer_plans (user_id) where status = 'active';

comment on table public.homer_plans is
  'HOMER. The plan: taste rules and what Alex wants in suggestions (instructions), and settings (scales, default '
  'verdict rule, tired gap, quiet threshold, suggestion rules). NEVER EDITED: a change is a new version written by '
  'create_homer_plan (tier 3), which supersedes the active one. One active per user. Spec: docs/homer-spec-homer-h4k.md.';
comment on column public.homer_plans.id is 'Row id.';
comment on column public.homer_plans.user_id is 'Owner. Owner RLS.';
comment on column public.homer_plans.version is '1, 2, 3 … per user, set by create_homer_plan.';
comment on column public.homer_plans.status is 'active | superseded. A superseded plan never becomes active again.';
comment on column public.homer_plans.instructions is 'Plain text: the taste rules and what Alex wants in suggestions, in his words.';
comment on column public.homer_plans.settings is
  'JSON object: scales [{key,label,kind range|choice|multi,min,max,labels,choices}], default_verdict '
  '{liked_min_finished, otherwise}, tired_gap_days, quiet_after_days, suggestions {...}. Checked by homer_plan_settings_problem.';
comment on column public.homer_plans.change_summary is 'What changed from the previous version and why. Required when superseding.';
comment on column public.homer_plans.written_by is 'Who drafted it: claude (proposed, then approved by Alex) or alex.';
comment on column public.homer_plans.supersedes_plan_id is 'The version this one replaced, or null for the first.';
comment on column public.homer_plans.created_at is 'When this version was written.';
comment on column public.homer_plans.ended_at is 'When it was superseded. Null while active.';

create or replace function public.homer_plans_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.id, new.user_id, new.version, new.instructions, new.settings, new.change_summary, new.written_by,
      new.supersedes_plan_id, new.created_at)
     is distinct from
     (old.id, old.user_id, old.version, old.instructions, old.settings, old.change_summary, old.written_by,
      old.supersedes_plan_id, old.created_at) then
    raise exception 'homer_plans rows are not edited: write a new version with create_homer_plan.' using errcode = '23514';
  end if;
  if old.status = 'superseded' and new.status = 'active' then
    raise exception 'homer_plans: a superseded plan cannot become active again; write a new version.' using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.homer_plans_guard() is 'Homer: on homer_plans only status (active to superseded) and ended_at may change.';
revoke all on function public.homer_plans_guard() from public, anon;

drop trigger if exists homer_plans_guard on public.homer_plans;
create trigger homer_plans_guard before update on public.homer_plans
  for each row execute function public.homer_plans_guard();

create or replace function public.create_homer_plan(
  p_instructions   text,
  p_settings       jsonb,
  p_change_summary text default null,
  p_written_by     text default 'claude')
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old     public.homer_plans%rowtype;
  v_new     public.homer_plans%rowtype;
  v_problem text;
begin
  if auth.uid() is null then
    raise exception 'create_homer_plan: no signed-in user.' using errcode = '28000';
  end if;
  if coalesce(btrim(p_instructions), '') = '' then
    raise exception 'create_homer_plan: instructions are required.' using errcode = '22023';
  end if;
  v_problem := public.homer_plan_settings_problem(p_settings);
  if v_problem is not null then
    raise exception 'create_homer_plan: %.', v_problem using errcode = '22023';
  end if;
  if coalesce(p_written_by, '') not in ('alex', 'claude') then
    raise exception 'create_homer_plan: written_by must be alex or claude.' using errcode = '22023';
  end if;

  -- Lock the active plan so two writers cannot both supersede it.
  select * into v_old from public.homer_plans where user_id = auth.uid() and status = 'active' for update;
  if v_old.id is not null then
    if coalesce(btrim(p_change_summary), '') = '' then
      raise exception 'create_homer_plan: a change_summary is required when superseding version %.', v_old.version
        using errcode = '22023';
    end if;
    update public.homer_plans set status = 'superseded', ended_at = now() where id = v_old.id;
  end if;

  insert into public.homer_plans (version, instructions, settings, change_summary, written_by, supersedes_plan_id)
  values ((select coalesce(max(version), 0) + 1 from public.homer_plans where user_id = auth.uid()),
          p_instructions, p_settings, nullif(btrim(p_change_summary), ''), p_written_by, v_old.id)
  returning * into v_new;
  return to_jsonb(v_new);
end;
$$;

comment on function public.create_homer_plan(text, jsonb, text, text) is
  'Homer: the ONLY way to write a plan. In one transaction: validates settings, supersedes the caller''s active plan '
  '(change_summary required then) and inserts the next version. Returns the new row. Behind the tier-3 '
  'create_homer_plan tool.';
revoke all on function public.create_homer_plan(text, jsonb, text, text) from public, anon;
grant execute on function public.create_homer_plan(text, jsonb, text, text) to authenticated, service_role;

-- ============================================================================
-- 3. homer_readers, homer_devices
-- ============================================================================
create table if not exists public.homer_readers (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id),
  key        text        not null,
  name       text        not null,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint homer_readers_key_slug check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint homer_readers_user_key unique (user_id, key)
);

comment on table public.homer_readers is
  'HOMER. The people whose reading is tracked on the shared Amazon account: alex, elise, vasti. Written by the import and by chat.';
comment on column public.homer_readers.id is 'Row id.';
comment on column public.homer_readers.user_id is 'Owner (Alex''s account). Owner RLS.';
comment on column public.homer_readers.key is 'Stable slug: alex, elise, vasti. Not a credential.';
comment on column public.homer_readers.name is 'Display name.';
comment on column public.homer_readers.notes is 'Free notes about this reader.';
comment on column public.homer_readers.created_at is 'When added.';
comment on column public.homer_readers.updated_at is 'Last change.';

create table if not exists public.homer_devices (
  id                 uuid          primary key default gen_random_uuid(),
  user_id            uuid          not null default auth.uid() references auth.users (id),
  device_id          text          not null,
  family             text,
  friendly_name      text,
  reader_id          uuid          references public.homer_readers (id) on delete set null,
  proposed_reader_id uuid          references public.homer_readers (id) on delete set null,
  owner_reason       text,
  owner_status       text          generated always as (
                       case when reader_id is not null then 'confirmed'
                            when proposed_reader_id is not null then 'proposed'
                            else 'unknown' end) stored,
  first_session      date,
  last_session       date,
  sessions           integer,
  hours              numeric(8,1),
  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now(),

  constraint homer_devices_user_device unique (user_id, device_id),
  constraint homer_devices_sessions_order check (first_session is null or last_session is null or last_session >= first_session)
);

comment on table public.homer_devices is
  'HOMER. One row per device id seen in the Kindle reading sessions. Devices are how Alex, Elise and Vasti are told '
  'apart. reader_id is the confirmed owner; setting it carries the reader onto the device''s reads (homer_devices_carry_reader). '
  'Written by the import and by update_homer_device (tier 2).';
comment on column public.homer_devices.id is 'Row id.';
comment on column public.homer_devices.user_id is 'Owner. Owner RLS.';
comment on column public.homer_devices.device_id is 'The device id from the Amazon export (device_serial_number), stray quotes removed.';
comment on column public.homer_devices.family is 'Kindle E-reader, Audible, Kindle for PC… or "Kindle app - likely Android/iOS" inferred from the id format.';
comment on column public.homer_devices.friendly_name is 'Name from registration.csv, e.g. "Alexander''s Kindle". Usually null.';
comment on column public.homer_devices.reader_id is 'Confirmed owner. Null until Alex confirms one.';
comment on column public.homer_devices.proposed_reader_id is 'Owner Claude proposes (by series continuity), waiting for Alex.';
comment on column public.homer_devices.owner_reason is 'Why that owner: Alex''s label, or the series continuity evidence.';
comment on column public.homer_devices.owner_status is 'Derived: confirmed (reader_id set), proposed, or unknown.';
comment on column public.homer_devices.first_session is 'First session of 60 seconds or more.';
comment on column public.homer_devices.last_session is 'Last session of 60 seconds or more.';
comment on column public.homer_devices.sessions is 'Sessions of 60 seconds or more.';
comment on column public.homer_devices.hours is 'Reading hours (sessions under 60 s left out, each capped at 4 h).';
comment on column public.homer_devices.created_at is 'When added.';
comment on column public.homer_devices.updated_at is 'Last change.';

-- ============================================================================
-- 4. homer_series, homer_books
-- ============================================================================
create table if not exists public.homer_series (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id),
  name        text        not null,
  series_asin text,
  author      text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint homer_series_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists homer_series_user_asin on public.homer_series (user_id, series_asin) where series_asin is not null;
create unique index if not exists homer_series_user_name_no_asin on public.homer_series (user_id, lower(name)) where series_asin is null;

comment on table public.homer_series is
  'HOMER. A book series. Names and series ASINs come from UnifiedLibraryIndex CustomerRelationshipIndex. Unique by '
  'series_asin; a series without one is unique by name. Written by the import and by chat.';
comment on column public.homer_series.id is 'Row id.';
comment on column public.homer_series.user_id is 'Owner. Owner RLS.';
comment on column public.homer_series.name is 'Series name, e.g. He Who Fights with Monsters.';
comment on column public.homer_series.series_asin is 'Amazon''s series id (the ASIN at the end of "Series Title"), or null.';
comment on column public.homer_series.author is 'Main author.';
comment on column public.homer_series.notes is 'Free notes.';
comment on column public.homer_series.created_at is 'When added.';
comment on column public.homer_series.updated_at is 'Last change.';

create table if not exists public.homer_books (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null default auth.uid() references auth.users (id),
  asin            text          not null,
  title           text          not null,
  author          text,
  series_id       uuid          references public.homer_series (id) on delete set null,
  series_position numeric(6,2),
  acquired        text,
  content_type    text,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),

  constraint homer_books_user_asin unique (user_id, asin),
  constraint homer_books_acquired_values
    check (acquired is null or acquired in ('purchase', 'kindle_unlimited', 'prime_reading', 'sample', 'library', 'other')),
  constraint homer_books_position_needs_series check (series_position is null or series_id is not null)
);

create index if not exists homer_books_series on public.homer_books (series_id);

comment on table public.homer_books is
  'HOMER. A Kindle book by ASIN, with its series and position and how it was acquired. Written by the import and by chat.';
comment on column public.homer_books.id is 'Row id.';
comment on column public.homer_books.user_id is 'Owner. Owner RLS.';
comment on column public.homer_books.asin is 'Amazon''s book id. Unique per user.';
comment on column public.homer_books.title is 'Title as Amazon gives it.';
comment on column public.homer_books.author is 'Author.';
comment on column public.homer_books.series_id is 'The series, or null.';
comment on column public.homer_books.series_position is 'Position in the series ("Position In Collection"); may be fractional.';
comment on column public.homer_books.acquired is
  'purchase | kindle_unlimited | prime_reading | sample | library | other, from Digital.Content.Ownership origin types.';
comment on column public.homer_books.content_type is 'E-Book, E-Book Sample, Personal Document… from the reading sessions.';
comment on column public.homer_books.created_at is 'When added.';
comment on column public.homer_books.updated_at is 'Last change.';

-- ============================================================================
-- 5. homer_reads (one per book per device; reader carried from the device)
-- ============================================================================
create table if not exists public.homer_reads (
  id          uuid          primary key default gen_random_uuid(),
  user_id     uuid          not null default auth.uid() references auth.users (id),
  book_id     uuid          not null references public.homer_books (id) on delete restrict,
  device_id   uuid          references public.homer_devices (id) on delete set null,
  reader_id   uuid          references public.homer_readers (id) on delete set null,
  started_on  date,
  finished_on date,
  hours       numeric(7,1),
  completion  text,
  source      text          not null,
  import_key  text,
  note        text,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint homer_reads_source_values check (source in ('export', 'clip', 'chat')),
  constraint homer_reads_completion_values check (completion is null or completion in ('automatic', 'manual')),
  constraint homer_reads_completion_needs_finish check (completion is null or finished_on is not null),
  constraint homer_reads_dates_order check (started_on is null or finished_on is null or finished_on >= started_on),
  constraint homer_reads_hours_positive check (hours is null or hours >= 0),
  constraint homer_reads_reader_or_device check (reader_id is not null or device_id is not null)
);

create unique index if not exists homer_reads_one_per_book_device on public.homer_reads (user_id, book_id, device_id) where device_id is not null;
create unique index if not exists homer_reads_import_key on public.homer_reads (user_id, import_key) where import_key is not null;
create index if not exists homer_reads_reader_finished on public.homer_reads (reader_id, finished_on);
create index if not exists homer_reads_book on public.homer_reads (book_id);

comment on table public.homer_reads is
  'HOMER. A reader''s reading of a book: dates and hours. From the export, one per book per device '
  '(homer_reads_one_per_book_device); from the weekly clip or chat, with a reader and usually no device. reader_id is '
  'null while the device has no owner, and is filled from the device (homer_reads_fill_reader, homer_devices_carry_reader). '
  'Written by the import, create_homer_read (tier 1) and update_homer_read (tier 2).';
comment on column public.homer_reads.id is 'Row id.';
comment on column public.homer_reads.user_id is 'Owner. Owner RLS.';
comment on column public.homer_reads.book_id is 'The book.';
comment on column public.homer_reads.device_id is 'The device it was read on (export reads), or null.';
comment on column public.homer_reads.reader_id is 'Who read it. Null until the device has a confirmed owner.';
comment on column public.homer_reads.started_on is 'First session on this device, or the date Alex gives.';
comment on column public.homer_reads.finished_on is 'Date finished; null = started but not finished.';
comment on column public.homer_reads.hours is 'Reading hours on this device (60 s floor, 4 h cap per session), or null.';
comment on column public.homer_reads.completion is 'automatic | manual, from UserUniqueTitlesCompleted; null if not from there.';
comment on column public.homer_reads.source is 'export | clip | chat.';
comment on column public.homer_reads.import_key is 'Idempotency key, e.g. export:<asin>:<device_id> or clip:<date>:<asin>. Not a credential.';
comment on column public.homer_reads.note is 'Free note.';
comment on column public.homer_reads.created_at is 'When recorded.';
comment on column public.homer_reads.updated_at is 'Last change.';

create or replace function public.homer_reads_fill_reader()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.reader_id is null and new.device_id is not null then
    select reader_id into new.reader_id from public.homer_devices where id = new.device_id;
  end if;
  return new;
end;
$$;

comment on function public.homer_reads_fill_reader() is 'Homer: a read with a device and no reader takes the device''s confirmed owner.';
revoke all on function public.homer_reads_fill_reader() from public, anon;

drop trigger if exists homer_reads_fill_reader on public.homer_reads;
create trigger homer_reads_fill_reader before insert or update of device_id, reader_id on public.homer_reads
  for each row execute function public.homer_reads_fill_reader();

create or replace function public.homer_devices_carry_reader()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Reads that followed the old owner (or had none) follow the new one. Reads set to someone else by hand stay.
  update public.homer_reads
     set reader_id = new.reader_id
   where device_id = new.id
     and (reader_id is null or reader_id is not distinct from old.reader_id)
     and reader_id is distinct from new.reader_id;
  return null;
end;
$$;

comment on function public.homer_devices_carry_reader() is
  'Homer: when a device''s owner changes, its reads that had no reader or the old owner take the new owner.';
revoke all on function public.homer_devices_carry_reader() from public, anon;

drop trigger if exists homer_devices_carry_reader on public.homer_devices;
create trigger homer_devices_carry_reader after update of reader_id on public.homer_devices
  for each row when (old.reader_id is distinct from new.reader_id)
  execute function public.homer_devices_carry_reader();

-- ============================================================================
-- 6. homer_verdicts ("never" only from Alex)
-- ============================================================================
create table if not exists public.homer_verdicts (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users (id),
  reader_id    uuid        not null references public.homer_readers (id) on delete cascade,
  subject_kind text        not null,
  series_id    uuid        references public.homer_series (id) on delete cascade,
  book_id      uuid        references public.homer_books (id) on delete cascade,
  author       text,
  verdict      text        not null,
  note         text,
  set_by       text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint homer_verdicts_kind_values check (subject_kind in ('series', 'book', 'author')),
  constraint homer_verdicts_verdict_values check (verdict in ('loved', 'liked', 'tired', 'didnt_click', 'never')),
  constraint homer_verdicts_set_by_values check (set_by in ('alex', 'claude')),
  constraint homer_verdicts_one_subject check (
    (subject_kind = 'series' and series_id is not null and book_id is null and author is null) or
    (subject_kind = 'book'   and book_id is not null and series_id is null and author is null) or
    (subject_kind = 'author' and coalesce(btrim(author), '') <> '' and series_id is null and book_id is null)),
  constraint homer_verdicts_never_by_alex check (verdict <> 'never' or set_by = 'alex')
);

create unique index if not exists homer_verdicts_one_series on public.homer_verdicts (reader_id, series_id) where subject_kind = 'series';
create unique index if not exists homer_verdicts_one_book on public.homer_verdicts (reader_id, book_id) where subject_kind = 'book';
create unique index if not exists homer_verdicts_one_author on public.homer_verdicts (reader_id, lower(author)) where subject_kind = 'author';

comment on table public.homer_verdicts is
  'HOMER. A reader''s stored verdict on a series, book or author: loved, liked, tired, didnt_click or never, plus a note. '
  'Separate from queue status. One per reader and subject. A missing verdict on a series falls back to the plan''s '
  'default rule when read (homer_series_verdicts); defaults are never stored. "never" needs set_by = alex '
  '(homer_verdicts_never_by_alex), is written only by the tier-3 create_homer_never tool, and only Alex can lift it '
  '(homer_verdicts_guard). Others are written by update_homer_verdict (tier 2).';
comment on column public.homer_verdicts.id is 'Row id.';
comment on column public.homer_verdicts.user_id is 'Owner. Owner RLS.';
comment on column public.homer_verdicts.reader_id is 'Whose verdict.';
comment on column public.homer_verdicts.subject_kind is 'series | book | author.';
comment on column public.homer_verdicts.series_id is 'The series, when subject_kind = series.';
comment on column public.homer_verdicts.book_id is 'The book, when subject_kind = book.';
comment on column public.homer_verdicts.author is 'The author''s name, when subject_kind = author.';
comment on column public.homer_verdicts.verdict is
  'loved | liked | tired (liked and burned out: counts as liked for similar books; the series comes back after the '
  'plan''s tired_gap_days) | didnt_click | never (never suggested).';
comment on column public.homer_verdicts.note is 'Why, in Alex''s words.';
comment on column public.homer_verdicts.set_by is 'alex (he said it) or claude (Claude''s reading of what he said). never needs alex.';
comment on column public.homer_verdicts.created_at is 'When first set.';
comment on column public.homer_verdicts.updated_at is 'Last change.';

create or replace function public.homer_verdicts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.verdict = 'never' and new.verdict <> 'never' and new.set_by <> 'alex' then
    raise exception 'homer_verdicts: only Alex can lift a "never" (set_by must be alex).' using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.homer_verdicts_guard() is 'Homer: a never verdict can be changed only with set_by = alex.';
revoke all on function public.homer_verdicts_guard() from public, anon;

drop trigger if exists homer_verdicts_guard on public.homer_verdicts;
create trigger homer_verdicts_guard before update on public.homer_verdicts
  for each row execute function public.homer_verdicts_guard();

-- ============================================================================
-- 7. homer_taste_profiles (scores checked against the active plan's scales)
-- ============================================================================
create table if not exists public.homer_taste_profiles (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id),
  reader_id   uuid        not null references public.homer_readers (id) on delete cascade,
  series_id   uuid        not null references public.homer_series (id) on delete cascade,
  description text,
  scores      jsonb       not null default '{}'::jsonb,
  plan_id     uuid        references public.homer_plans (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint homer_taste_profiles_one unique (reader_id, series_id),
  constraint homer_taste_profiles_scores_object check (jsonb_typeof(scores) = 'object')
);

comment on table public.homer_taste_profiles is
  'HOMER. What a reader thinks a series is like: a free-text description and scores on the active plan''s scales. '
  'scores is jsonb keyed by scale key, checked against the active plan by homer_taste_scores_check (no check '
  'constraint, so scales change with a plan version, not a migration). Written by update_homer_taste_profile (tier 2).';
comment on column public.homer_taste_profiles.id is 'Row id.';
comment on column public.homer_taste_profiles.user_id is 'Owner. Owner RLS.';
comment on column public.homer_taste_profiles.reader_id is 'Whose profile.';
comment on column public.homer_taste_profiles.series_id is 'The series described.';
comment on column public.homer_taste_profiles.description is 'Free text in the reader''s words.';
comment on column public.homer_taste_profiles.scores is
  'JSON object {scale_key: value}: a number for range scales, a choice for choice scales, a list for multi scales.';
comment on column public.homer_taste_profiles.plan_id is 'The plan version the scores were last checked against.';
comment on column public.homer_taste_profiles.created_at is 'When first written.';
comment on column public.homer_taste_profiles.updated_at is 'Last change.';

create or replace function public.homer_taste_scores_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_plan    public.homer_plans%rowtype;
  v_problem text;
begin
  -- Only when the scores themselves are written; scores kept from a dropped scale survive other edits.
  if tg_op = 'UPDATE' and new.scores is not distinct from old.scores then
    return new;
  end if;
  select * into v_plan from public.homer_plans where user_id = new.user_id and status = 'active';
  if new.scores = '{}'::jsonb then
    new.plan_id := v_plan.id;
    return new;
  end if;
  if v_plan.id is null then
    raise exception 'homer_taste_profiles: there is no active Homer plan, so there are no scales to score against.'
      using errcode = '23514';
  end if;
  v_problem := public.homer_scores_problem(new.scores, v_plan.settings);
  if v_problem is not null then
    raise exception 'homer_taste_profiles: % (plan version %).', v_problem, v_plan.version using errcode = '23514';
  end if;
  new.plan_id := v_plan.id;
  return new;
end;
$$;

comment on function public.homer_taste_scores_check() is
  'Homer: checks taste scores against the active plan''s scales when they are written, and stamps plan_id.';
revoke all on function public.homer_taste_scores_check() from public, anon;

drop trigger if exists homer_taste_scores_check on public.homer_taste_profiles;
create trigger homer_taste_scores_check before insert or update on public.homer_taste_profiles
  for each row execute function public.homer_taste_scores_check();

-- ============================================================================
-- 8. homer_genres, homer_genre_series
-- ============================================================================
create table if not exists public.homer_genres (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id),
  name        text        not null,
  description text,
  status      text        not null default 'proposed',
  sort_order  integer     not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint homer_genres_status_values check (status in ('proposed', 'accepted')),
  constraint homer_genres_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists homer_genres_user_name on public.homer_genres (user_id, lower(name)) where archived_at is null;

comment on table public.homer_genres is
  'HOMER. A named cluster of series ("my genres"), each with its own read-next queue. Claude proposes '
  '(status proposed); Alex names, edits and accepts. Archived, never deleted. Written by update_homer_genre (tier 2).';
comment on column public.homer_genres.id is 'Row id.';
comment on column public.homer_genres.user_id is 'Owner. Owner RLS.';
comment on column public.homer_genres.name is 'Alex''s name for it.';
comment on column public.homer_genres.description is 'What belongs in it.';
comment on column public.homer_genres.status is 'proposed | accepted.';
comment on column public.homer_genres.sort_order is 'Order on the Homer tab.';
comment on column public.homer_genres.archived_at is 'When dropped; null while in use.';
comment on column public.homer_genres.created_at is 'When added.';
comment on column public.homer_genres.updated_at is 'Last change.';

create table if not exists public.homer_genre_series (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id),
  genre_id   uuid        not null references public.homer_genres (id) on delete cascade,
  series_id  uuid        not null references public.homer_series (id) on delete cascade,
  is_example boolean     not null default false,
  created_at timestamptz not null default now(),

  constraint homer_genre_series_one unique (genre_id, series_id)
);

create index if not exists homer_genre_series_series on public.homer_genre_series (series_id);

comment on table public.homer_genre_series is
  'HOMER. Which series belong to which genre; is_example marks the ones that define it. A series may sit in several '
  'genres. Written by update_homer_genre (tier 2).';
comment on column public.homer_genre_series.id is 'Row id.';
comment on column public.homer_genre_series.user_id is 'Owner. Owner RLS.';
comment on column public.homer_genre_series.genre_id is 'The genre.';
comment on column public.homer_genre_series.series_id is 'The series.';
comment on column public.homer_genre_series.is_example is 'True for the series that define the genre.';
comment on column public.homer_genre_series.created_at is 'When added.';

-- ============================================================================
-- 9. homer_queue_items (cheap to add, move and drop; verified before written)
-- ============================================================================
create table if not exists public.homer_queue_items (
  id                  uuid          primary key default gen_random_uuid(),
  user_id             uuid          not null default auth.uid() references auth.users (id),
  genre_id            uuid          references public.homer_genres (id) on delete set null,
  reader_id           uuid          not null references public.homer_readers (id) on delete cascade,
  kind                text          not null default 'book',
  title               text          not null,
  author              text,
  asin                text,
  series_id           uuid          references public.homer_series (id) on delete set null,
  book_id             uuid          references public.homer_books (id) on delete set null,
  why                 text,
  on_kindle_unlimited boolean,
  ku_checked_on       date,
  verified_on         date          not null,
  status              text          not null default 'queued',
  position            numeric       not null default 1000,
  created_by          text          not null default 'claude',
  archived_at         timestamptz,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  constraint homer_queue_kind_values check (kind in ('book', 'series', 'pick_up_again')),
  constraint homer_queue_status_values check (status in ('queued', 'maybe_later', 'reading', 'read', 'never')),
  constraint homer_queue_created_by_values check (created_by in ('alex', 'claude')),
  constraint homer_queue_ku_needs_date check (on_kindle_unlimited is null or ku_checked_on is not null),
  constraint homer_queue_title_not_blank check (btrim(title) <> '')
);

create unique index if not exists homer_queue_one_live_asin on public.homer_queue_items (reader_id, asin)
  where asin is not null and archived_at is null;
create index if not exists homer_queue_genre_order on public.homer_queue_items (genre_id, position) where archived_at is null;

comment on table public.homer_queue_items is
  'HOMER. Read-next queues, one loose queue per genre. Each item: a suggested book, series or "pick it up again?", why, '
  'whether it is on Kindle Unlimited, and a status (queued, maybe_later, reading, read, never; separate from verdicts). '
  'verified_on is required: Claude checks the title exists (web search) before writing it. Kindle links are built from '
  'asin, never stored. Move = new position; drop = archived_at. Written by create_homer_queue_items (tier 1) and '
  'update_homer_queue_item (tier 2).';
comment on column public.homer_queue_items.id is 'Row id.';
comment on column public.homer_queue_items.user_id is 'Owner. Owner RLS.';
comment on column public.homer_queue_items.genre_id is 'The genre queue it sits in; null = not sorted yet.';
comment on column public.homer_queue_items.reader_id is 'Who it is for (slice 1: alex).';
comment on column public.homer_queue_items.kind is 'book | series | pick_up_again (a tired series coming back).';
comment on column public.homer_queue_items.title is 'Title of the book or series.';
comment on column public.homer_queue_items.author is 'Author.';
comment on column public.homer_queue_items.asin is 'ASIN when known; the Kindle links are built from it.';
comment on column public.homer_queue_items.series_id is 'The series, when it is one Homer knows.';
comment on column public.homer_queue_items.book_id is 'The book, when it is one Homer knows.';
comment on column public.homer_queue_items.why is 'Why it was suggested, in a sentence or two.';
comment on column public.homer_queue_items.on_kindle_unlimited is 'True/false when checked; null when not checked.';
comment on column public.homer_queue_items.ku_checked_on is 'When Kindle Unlimited was checked. Required with on_kindle_unlimited.';
comment on column public.homer_queue_items.verified_on is 'When Claude confirmed (web search) that the title exists.';
comment on column public.homer_queue_items.status is 'queued | maybe_later | reading | read | never.';
comment on column public.homer_queue_items.position is 'Order within the queue, ascending; fractional so a move touches one row.';
comment on column public.homer_queue_items.created_by is 'alex or claude.';
comment on column public.homer_queue_items.archived_at is 'When dropped; null while in the queue.';
comment on column public.homer_queue_items.created_at is 'When added.';
comment on column public.homer_queue_items.updated_at is 'Last change.';

-- ============================================================================
-- 10. updated_at stamps (shared public.update_updated_at)
-- ============================================================================
drop trigger if exists set_updated_at on public.homer_readers;
create trigger set_updated_at before update on public.homer_readers for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_devices;
create trigger set_updated_at before update on public.homer_devices for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_series;
create trigger set_updated_at before update on public.homer_series for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_books;
create trigger set_updated_at before update on public.homer_books for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_reads;
create trigger set_updated_at before update on public.homer_reads for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_verdicts;
create trigger set_updated_at before update on public.homer_verdicts for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_taste_profiles;
create trigger set_updated_at before update on public.homer_taste_profiles for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_genres;
create trigger set_updated_at before update on public.homer_genres for each row execute function public.update_updated_at();
drop trigger if exists set_updated_at on public.homer_queue_items;
create trigger set_updated_at before update on public.homer_queue_items for each row execute function public.update_updated_at();

-- ============================================================================
-- 11. Register: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table('public.homer_plans', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Versioned reading plan; never edited, one active. Written by create_homer_plan (tier 3).');
select platform.register_table('public.homer_readers', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Alex, Elise, Vasti.', p_cleared_columns => array['key']);
select platform.register_table('public.homer_devices', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Kindle device ids and their owners.');
select platform.register_table('public.homer_series', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Book series.');
select platform.register_table('public.homer_books', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Kindle books by ASIN.');
select platform.register_table('public.homer_reads', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Reads: one per book per device from the export, plus clip and chat reads.',
  p_cleared_columns => array['import_key']);
select platform.register_table('public.homer_verdicts', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Verdicts on series, books and authors; never only from Alex.');
select platform.register_table('public.homer_taste_profiles', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Per-series description and scores on the plan''s scales.');
select platform.register_table('public.homer_genres', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Named clusters of series.');
select platform.register_table('public.homer_genre_series', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Series in each genre.');
select platform.register_table('public.homer_queue_items', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Homer. Read-next queues by genre.');

commit;

-- ============================================================================
-- 12. Result: must say CONFORMANT. Then run the two test scripts with --test, and check_platform_conformance.
-- ============================================================================
select public.platform_check_conformance() as conformance;
