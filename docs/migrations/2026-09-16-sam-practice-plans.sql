-- ============================================================================
-- SAM Practice Plans — Milestone 1
-- docs/migrations/2026-09-16-sam-practice-plans.sql
-- Spec: docs/technical-spec-sam-practice-plans.md §5
--
-- Run in the Supabase SQL editor ONE PART AT A TIME, in order.
-- Part 4 has a preview query: check its list before running the update below it.
-- ============================================================================


-- ============================================================================
-- PART 1 — New tables
-- ============================================================================

-- A snippet must belong to the plan item's song. This lets a composite foreign
-- key enforce that.
alter table public.sam_snippets
  add constraint sam_snippets_id_song_id_key unique (id, song_id);


-- ---------------------------------------------------------------------------
-- 1a. sam_practice_plans
-- ---------------------------------------------------------------------------
create table public.sam_practice_plans (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id),
  status              text not null default 'active'
                        check (status in ('active', 'superseded')),
  starts_on           date not null
                        default ((now() at time zone 'America/Los_Angeles')::date),
  ended_at            timestamptz,
  supersedes_plan_id  uuid references public.sam_practice_plans(id) on delete set null,
  day_note            text,
  internal_notes      text,
  review_instructions text not null check (length(btrim(review_instructions)) > 0),
  review_note         text,
  review_noted_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint sam_practice_plans_status_ended_check
    check ((status = 'active') = (ended_at is null)),
  constraint sam_practice_plans_review_noted_check
    check ((review_note is null) = (review_noted_at is null))
);

create unique index sam_practice_plans_one_active
  on public.sam_practice_plans (user_id) where status = 'active';
create index sam_practice_plans_user_created
  on public.sam_practice_plans (user_id, created_at desc);

comment on table public.sam_practice_plans is
'SAM. A practice plan written by Claude and approved by Alex in conversation. PLANS ARE NEVER
EDITED: any change creates a new plan that supersedes this one (trigger-enforced). Only status,
ended_at, review_note, review_noted_at and updated_at may change after insert. At most one active
plan per user. Create plans only through sam_create_practice_plan().';
comment on column public.sam_practice_plans.status is
'active | superseded. A superseded plan can never be reactivated.';
comment on column public.sam_practice_plans.starts_on is
'Pacific (America/Los_Angeles) date the plan began.';
comment on column public.sam_practice_plans.ended_at is
'When this plan was superseded. Null while active (constraint-enforced).';
comment on column public.sam_practice_plans.supersedes_plan_id is
'The plan this one replaced. Chains plan history.';
comment on column public.sam_practice_plans.day_note is
'VISIBLE on the Sam tab. Short daily goal, e.g. "Improve speed on Autumn Leaves."';
comment on column public.sam_practice_plans.internal_notes is
'CLAUDE ONLY. Reasoning behind the plan. Not shown in the app.';
comment on column public.sam_practice_plans.review_instructions is
'CLAUDE ONLY. Plain-language criteria the daily review job applies to decide when to post a
review note, e.g. "Post once he hits 90% at 60 on m.16-17 for three days, or is under 70% there
for four days."';
comment on column public.sam_practice_plans.review_note is
'Written once by the daily review job when review_instructions are met. Can be set from null
exactly once and never changed (trigger-enforced). Its presence means a plan conversation is due.';
comment on column public.sam_practice_plans.review_noted_at is
'When review_note was written. Filled automatically if omitted.';


create or replace function public.sam_practice_plans_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.id, new.user_id, new.starts_on, new.supersedes_plan_id, new.day_note,
      new.internal_notes, new.review_instructions, new.created_at)
     is distinct from
     (old.id, old.user_id, old.starts_on, old.supersedes_plan_id, old.day_note,
      old.internal_notes, old.review_instructions, old.created_at) then
    raise exception 'sam_practice_plans: plan content is immutable. Create a new plan instead.';
  end if;

  if old.status = 'superseded' and new.status = 'active' then
    raise exception 'sam_practice_plans: a superseded plan cannot be reactivated. Create a new plan instead.';
  end if;

  if old.review_note is not null and new.review_note is distinct from old.review_note then
    raise exception 'sam_practice_plans: review_note is already set and cannot be changed.';
  end if;

  if old.review_note is null and new.review_note is not null and new.review_noted_at is null then
    new.review_noted_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function public.sam_practice_plans_guard_update() is
'SAM: enforces plan immutability. Allows only status active->superseded, ended_at, a one-time
review_note, and review_noted_at. Stamps updated_at.';

create trigger sam_practice_plans_guard_update
  before update on public.sam_practice_plans
  for each row execute function public.sam_practice_plans_guard_update();


-- Shared: reject every update (plan songs and plan items are immutable).
create or replace function public.sam_practice_reject_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '%: rows are immutable. Create a new plan instead.', tg_table_name;
end;
$$;

comment on function public.sam_practice_reject_update() is
'SAM: rejects all updates on immutable practice-plan child tables.';


-- ---------------------------------------------------------------------------
-- 1b. sam_practice_plan_songs
-- ---------------------------------------------------------------------------
create table public.sam_practice_plan_songs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id),
  plan_id        uuid not null references public.sam_practice_plans(id) on delete cascade,
  song_id        uuid not null references public.sam_songs(id) on delete cascade,
  position       smallint not null check (position > 0),
  song_note      text,
  internal_notes text,
  created_at     timestamptz not null default now(),
  constraint sam_practice_plan_songs_plan_song_key unique (plan_id, song_id),
  constraint sam_practice_plan_songs_id_plan_song_key unique (id, plan_id, song_id)
);

create index sam_practice_plan_songs_song
  on public.sam_practice_plan_songs (song_id);

comment on table public.sam_practice_plan_songs is
'SAM. One row per song in a practice plan. Immutable (trigger-enforced). Read across plans by
song_id to see a song''s plan history.';
comment on column public.sam_practice_plan_songs.position is
'Order of the song within the plan, starting at 1.';
comment on column public.sam_practice_plan_songs.song_note is
'VISIBLE in the player when this song is loaded. Short song goal, e.g. "Master m.16-17, then
start m.18." Measure numbers are PLAYED numbers; add the printed number in parentheses when it
helps, e.g. "m.37 (22)".';
comment on column public.sam_practice_plan_songs.internal_notes is
'CLAUDE ONLY. E.g. "Has the fingering, needs speed. This plan addresses that."';

create trigger sam_practice_plan_songs_reject_update
  before update on public.sam_practice_plan_songs
  for each row execute function public.sam_practice_reject_update();


-- ---------------------------------------------------------------------------
-- 1c. sam_practice_plan_items
-- ---------------------------------------------------------------------------
create table public.sam_practice_plan_items (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id),
  plan_id               uuid not null,
  plan_song_id          uuid not null,
  song_id               uuid not null,
  snippet_id            uuid,
  position              smallint not null check (position > 0),
  is_free_play          boolean not null default false,
  target_bpm            integer not null check (target_bpm > 0),
  target_playback_speed integer not null default 100 check (target_playback_speed > 0),
  target_effective_bpm  integer
                          generated always as (round(target_bpm * target_playback_speed / 100.0)::integer) stored,
  target_passes         smallint not null check (target_passes > 0),
  accuracy_target       smallint check (accuracy_target between 1 and 100),
  instruction           text,
  created_at            timestamptz not null default now(),
  constraint sam_practice_plan_items_plan_song_fkey
    foreign key (plan_song_id, plan_id, song_id)
    references public.sam_practice_plan_songs (id, plan_id, song_id) on delete cascade,
  constraint sam_practice_plan_items_snippet_fkey
    foreign key (snippet_id, song_id)
    references public.sam_snippets (id, song_id),
  constraint sam_practice_plan_items_accuracy_check
    check ((is_free_play and accuracy_target is null)
        or (not is_free_play and accuracy_target is not null))
);

create unique index sam_practice_plan_items_one_per_range
  on public.sam_practice_plan_items
  (plan_id, song_id, coalesce(snippet_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index sam_practice_plan_items_plan_position
  on public.sam_practice_plan_items (plan_id, position);
create index sam_practice_plan_items_snippet
  on public.sam_practice_plan_items (snippet_id) where snippet_id is not null;

comment on table public.sam_practice_plan_items is
'SAM. One checklist item in a practice plan: a song or snippet, a tempo, a pass count, and (except
free play) an accuracy target. Immutable (trigger-enforced). At most one item per exact range
(song + snippet, null snippet = whole song) per plan, so a pass never counts toward two items.
Progress is computed ONLY by sam_plan_item_progress(); never count passes separately.';
comment on column public.sam_practice_plan_items.snippet_id is
'Null = whole song. Must belong to song_id (composite foreign key).';
comment on column public.sam_practice_plan_items.position is
'Checklist order across the whole plan, starting at 1.';
comment on column public.sam_practice_plan_items.is_free_play is
'Optional Free Play: tempo target, no accuracy target, counted separately in the app.';
comment on column public.sam_practice_plan_items.target_bpm is
'Tempo-box BPM (quarter notes per minute). For songs with audio this equals the song''s
default_bpm and the target is expressed through target_playback_speed.';
comment on column public.sam_practice_plan_items.target_playback_speed is
'Speed percent. 100 for songs without audio.';
comment on column public.sam_practice_plan_items.target_effective_bpm is
'Generated heard tempo. A pass qualifies when sam_passes.effective_bpm >= this. Never compare
target_bpm directly.';
comment on column public.sam_practice_plan_items.target_passes is
'Qualifying passes needed today for the item to be crossed off.';
comment on column public.sam_practice_plan_items.accuracy_target is
'Minimum sam_passes.accuracy_percent for a pass to qualify. Required unless free play; null for
free play (constraint-enforced).';
comment on column public.sam_practice_plan_items.instruction is
'VISIBLE. One short line, e.g. "Count out loud."';

create trigger sam_practice_plan_items_reject_update
  before update on public.sam_practice_plan_items
  for each row execute function public.sam_practice_reject_update();


-- ---------------------------------------------------------------------------
-- 1d. sam_goals
-- ---------------------------------------------------------------------------
create table public.sam_goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id),
  title        text not null check (length(btrim(title)) > 0),
  kind         text not null check (kind in ('song', 'technique', 'progression')),
  status       text not null default 'someday'
                 check (status in ('someday', 'active', 'done', 'dropped')),
  song_id      uuid references public.sam_songs(id) on delete set null,
  notes        text,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index sam_goals_user_status on public.sam_goals (user_id, status);

comment on table public.sam_goals is
'SAM. Longer-range learning goals: songs to learn, techniques, chord progressions. Maintained by
Claude through tools. No deletes: use status dropped.';
comment on column public.sam_goals.kind is 'song | technique | progression';
comment on column public.sam_goals.status is 'someday | active | done | dropped';
comment on column public.sam_goals.song_id is 'Optional link to the song this goal is about.';
comment on column public.sam_goals.completed_at is 'Set when status becomes done.';

create or replace function public.sam_goals_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.sam_goals_touch_updated_at() is 'SAM: stamps sam_goals.updated_at.';

create trigger sam_goals_touch_updated_at
  before update on public.sam_goals
  for each row execute function public.sam_goals_touch_updated_at();


-- ---------------------------------------------------------------------------
-- 1e. Register with the platform
-- ---------------------------------------------------------------------------
select platform.register_table(
  'public.sam_practice_plans',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: SAM. Practice plans; immutable content, superseded not edited, one active per user.'
);

select platform.register_table(
  'public.sam_practice_plan_songs',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: SAM. Songs within a practice plan with visible and internal notes; immutable.'
);

select platform.register_table(
  'public.sam_practice_plan_items',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: SAM. Checklist items with tempo, pass and accuracy targets; immutable.'
);

select platform.register_table(
  'public.sam_goals',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: SAM. Learning goals list (songs, techniques, progressions) with status.'
);


-- ============================================================================
-- PART 2 — Links on existing tables, and goal_set_at on songs
-- ============================================================================

-- 2a. Plan links on passes and sessions
alter table public.sam_passes
  add column plan_id uuid references public.sam_practice_plans(id) on delete set null,
  add column plan_item_id uuid references public.sam_practice_plan_items(id) on delete set null;

create index sam_passes_plan on public.sam_passes (plan_id) where plan_id is not null;
create index sam_passes_plan_item on public.sam_passes (plan_item_id) where plan_item_id is not null;

comment on column public.sam_passes.plan_id is
'The practice plan active when this pass was recorded, if any. Set even when the pass matches no
item (e.g. a snippet made on the fly). Historic rows are null. Never rewritten.';
comment on column public.sam_passes.plan_item_id is
'The plan item matching this pass''s song and snippet when recorded, if any. Recorded for
history only: progress counting matches on song and snippet, not this column.';

alter table public.sam_sessions
  add column plan_id uuid references public.sam_practice_plans(id) on delete set null,
  add column plan_item_id uuid references public.sam_practice_plan_items(id) on delete set null;

create index sam_sessions_plan on public.sam_sessions (plan_id) where plan_id is not null;
create index sam_sessions_plan_item on public.sam_sessions (plan_item_id) where plan_item_id is not null;

comment on column public.sam_sessions.plan_id is
'The practice plan active when this session started, if any. Historic rows are null.';
comment on column public.sam_sessions.plan_item_id is
'The plan item matching this session''s song and snippet when it started, if any.';


-- 2b. goal_set_at on songs
alter table public.sam_songs
  add column goal_set_at timestamptz;

comment on column public.sam_songs.goal_set_at is
'When the goal tempo was deliberately set or confirmed. NULL = placeholder goal (backfilled or
defaulted), never to be treated as a real target. Stamped automatically on update when
goal_playback_speed changes, or goal_bpm changes on a song without audio (on songs with audio a
goal_bpm change is only scroll-sync calibration). An explicit write to this column is kept.
On insert, a simplified song whose goal pair matches its parent copies the parent''s value.';


-- Replaces the insert trigger function from the goal-tempo migration.
-- Same goal_bpm fill as before, plus goal_set_at inheritance for simplified songs.
create or replace function public.sam_songs_fill_goal_tempo()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.goal_bpm is null then
    new.goal_bpm := coalesce(new.default_bpm, 68);
  end if;

  if new.goal_set_at is null
     and new.song_type = 'simplified'
     and new.parent_song_id is not null then
    select p.goal_set_at
      into new.goal_set_at
      from public.sam_songs p
     where p.id = new.parent_song_id
       and p.goal_bpm = new.goal_bpm
       and p.goal_playback_speed = new.goal_playback_speed;
  end if;

  return new;
end;
$$;

comment on function public.sam_songs_fill_goal_tempo() is
'SAM: guarantees every song has a goal tempo. When an insert omits goal_bpm, copy default_bpm
(or 68). A simplified song whose goal pair matches its parent inherits the parent''s goal_set_at.
App and tool code should pass goal_bpm only when the source actually specifies one.';


create or replace function public.sam_songs_mark_goal_set()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- An explicit write to goal_set_at wins.
  if new.goal_set_at is distinct from old.goal_set_at then
    return new;
  end if;

  if new.goal_playback_speed is distinct from old.goal_playback_speed
     or (new.goal_bpm is distinct from old.goal_bpm and new.audio_file_path is null) then
    new.goal_set_at := now();
  end if;

  return new;
end;
$$;

comment on function public.sam_songs_mark_goal_set() is
'SAM: stamps sam_songs.goal_set_at when a goal tempo is deliberately changed. See the column
comment for the rule.';

create trigger sam_songs_mark_goal_set
  before update of goal_bpm, goal_playback_speed, goal_set_at on public.sam_songs
  for each row execute function public.sam_songs_mark_goal_set();


-- ============================================================================
-- PART 3 — Database functions
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 3a. sam_plan_item_progress
-- ---------------------------------------------------------------------------
create or replace function public.sam_plan_item_progress(
  p_plan_id uuid,
  p_from    date,
  p_to      date
)
returns table (
  plan_item_id       uuid,
  day                date,
  attempts           integer,
  qualifying         integer,
  best_accuracy      integer,
  best_effective_bpm integer,
  last_completed_at  timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  if p_plan_id is null then
    raise exception 'sam_plan_item_progress: p_plan_id is required.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'sam_plan_item_progress: p_from and p_to are required, and p_to must not be before p_from.';
  end if;
  if p_to - p_from > 30 then
    raise exception 'sam_plan_item_progress: the date range is capped at 31 days.';
  end if;
  if not exists (select 1 from sam_practice_plans pl where pl.id = p_plan_id) then
    raise exception 'sam_plan_item_progress: plan % not found.', p_plan_id;
  end if;

  return query
  select i.id,
         (pa.completed_at at time zone 'America/Los_Angeles')::date,
         count(*)::integer,
         (count(*) filter (
            where pa.effective_bpm >= i.target_effective_bpm
              and (i.is_free_play or pa.accuracy_percent >= i.accuracy_target)
         ))::integer,
         max(pa.accuracy_percent)::integer,
         max(pa.effective_bpm)::integer,
         max(pa.completed_at)
    from sam_practice_plan_items i
    join sam_passes pa
      on pa.song_id = i.song_id
     and pa.snippet_id is not distinct from i.snippet_id
   where i.plan_id = p_plan_id
     and pa.notes_played > 0
     and pa.completed_at >= (p_from::timestamp at time zone 'America/Los_Angeles')
     and pa.completed_at <  ((p_to + 1)::timestamp at time zone 'America/Los_Angeles')
   group by i.id, 2
   order by 2, min(i.position);
end;
$$;

comment on function public.sam_plan_item_progress(uuid, date, date) is
'SAM: THE single source of plan progress, used by both the app and Claude tools. One row per plan
item per Pacific day with at least one attempt. Attempt = pass matching the item''s song and
snippet (null = whole song) with notes_played > 0. Qualifying = attempt with effective_bpm >=
target_effective_bpm and, unless free play, accuracy_percent >= accuracy_target. Matching ignores
sam_passes.plan_item_id. Range capped at 31 days.';

revoke all on function public.sam_plan_item_progress(uuid, date, date) from public, anon;
grant execute on function public.sam_plan_item_progress(uuid, date, date) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3b. sam_plan_unplanned_practice
-- ---------------------------------------------------------------------------
create or replace function public.sam_plan_unplanned_practice(
  p_plan_id uuid,
  p_from    date,
  p_to      date
)
returns table (
  song_id            uuid,
  snippet_id         uuid,
  day                date,
  attempts           integer,
  best_accuracy      integer,
  best_effective_bpm integer
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  if p_plan_id is null then
    raise exception 'sam_plan_unplanned_practice: p_plan_id is required.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'sam_plan_unplanned_practice: p_from and p_to are required, and p_to must not be before p_from.';
  end if;
  if p_to - p_from > 30 then
    raise exception 'sam_plan_unplanned_practice: the date range is capped at 31 days.';
  end if;
  if not exists (select 1 from sam_practice_plans pl where pl.id = p_plan_id) then
    raise exception 'sam_plan_unplanned_practice: plan % not found.', p_plan_id;
  end if;

  return query
  select pa.song_id,
         pa.snippet_id,
         (pa.completed_at at time zone 'America/Los_Angeles')::date,
         count(*)::integer,
         max(pa.accuracy_percent)::integer,
         max(pa.effective_bpm)::integer
    from sam_passes pa
   where pa.notes_played > 0
     and pa.completed_at >= (p_from::timestamp at time zone 'America/Los_Angeles')
     and pa.completed_at <  ((p_to + 1)::timestamp at time zone 'America/Los_Angeles')
     and not exists (
       select 1
         from sam_practice_plan_items i
        where i.plan_id = p_plan_id
          and i.song_id = pa.song_id
          and i.snippet_id is not distinct from pa.snippet_id
     )
   group by 1, 2, 3
   order by 3, 1, 2;
end;
$$;

comment on function public.sam_plan_unplanned_practice(uuid, date, date) is
'SAM: attempts (notes_played > 0) per song, snippet and Pacific day that match NO item in the given
plan. Shows practice outside the plan, including snippets made on the fly. Range capped at 31 days.';

revoke all on function public.sam_plan_unplanned_practice(uuid, date, date) from public, anon;
grant execute on function public.sam_plan_unplanned_practice(uuid, date, date) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3c. sam_create_practice_plan
-- ---------------------------------------------------------------------------
create or replace function public.sam_create_practice_plan(p_plan jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_prev_plan_id uuid;
  v_plan_id      uuid;
  v_plan_song_id uuid;
  v_song_json    jsonb;
  v_item         jsonb;
  v_song         record;
  v_snippet      record;
  v_song_pos     integer := 0;
  v_item_pos     integer := 0;
  v_song_id      uuid;
  v_snippet_id   uuid;
  v_has_audio    boolean;
  v_free         boolean;
  v_bpm          integer;
  v_speed        integer;
  v_passes       integer;
  v_accuracy     integer;
begin
  if v_uid is null then
    raise exception 'sam_create_practice_plan: not authenticated.';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'sam_create_practice_plan: the plan must be a JSON object.';
  end if;
  if nullif(btrim(p_plan->>'review_instructions'), '') is null then
    raise exception 'sam_create_practice_plan: review_instructions is required.';
  end if;
  if jsonb_typeof(p_plan->'songs') is distinct from 'array'
     or jsonb_array_length(p_plan->'songs') = 0 then
    raise exception 'sam_create_practice_plan: songs must be a non-empty array.';
  end if;

  -- Supersede the current active plan. Everything below runs in this one
  -- transaction, so any validation failure rolls this back too.
  select id into v_prev_plan_id
    from sam_practice_plans
   where user_id = v_uid and status = 'active'
   for update;

  if v_prev_plan_id is not null then
    update sam_practice_plans
       set status = 'superseded', ended_at = now()
     where id = v_prev_plan_id;
  end if;

  insert into sam_practice_plans (supersedes_plan_id, day_note, internal_notes, review_instructions)
  values (
    v_prev_plan_id,
    nullif(btrim(p_plan->>'day_note'), ''),
    nullif(btrim(p_plan->>'internal_notes'), ''),
    btrim(p_plan->>'review_instructions')
  )
  returning id into v_plan_id;

  for v_song_json in select value from jsonb_array_elements(p_plan->'songs') loop
    v_song_pos := v_song_pos + 1;
    v_song_id  := nullif(v_song_json->>'song_id', '')::uuid;

    if v_song_id is null then
      raise exception 'sam_create_practice_plan: song entry % is missing song_id.', v_song_pos;
    end if;

    select id, title, archived, default_bpm, goal_bpm, goal_playback_speed, audio_file_path
      into v_song
      from sam_songs
     where id = v_song_id;

    if not found then
      raise exception 'sam_create_practice_plan: song % not found.', v_song_id;
    end if;
    if v_song.archived then
      raise exception 'sam_create_practice_plan: song "%" is archived.', v_song.title;
    end if;
    if exists (select 1 from sam_practice_plan_songs
                where plan_id = v_plan_id and song_id = v_song_id) then
      raise exception 'sam_create_practice_plan: song "%" is listed more than once.', v_song.title;
    end if;
    if jsonb_typeof(v_song_json->'items') is distinct from 'array'
       or jsonb_array_length(v_song_json->'items') = 0 then
      raise exception 'sam_create_practice_plan: song "%" needs a non-empty items array.', v_song.title;
    end if;

    v_has_audio := v_song.audio_file_path is not null;

    insert into sam_practice_plan_songs (plan_id, song_id, position, song_note, internal_notes)
    values (
      v_plan_id,
      v_song_id,
      v_song_pos,
      nullif(btrim(v_song_json->>'song_note'), ''),
      nullif(btrim(v_song_json->>'internal_notes'), '')
    )
    returning id into v_plan_song_id;

    for v_item in select value from jsonb_array_elements(v_song_json->'items') loop
      v_item_pos   := v_item_pos + 1;
      v_snippet_id := nullif(v_item->>'snippet_id', '')::uuid;
      v_free       := coalesce((v_item->>'is_free_play')::boolean, false);
      v_bpm        := (v_item->>'target_bpm')::integer;
      v_speed      := (v_item->>'target_playback_speed')::integer;
      v_passes     := (v_item->>'target_passes')::integer;
      v_accuracy   := (v_item->>'accuracy_target')::integer;

      -- Snippet checks
      if v_snippet_id is not null then
        select id, song_id, title, archived
          into v_snippet
          from sam_snippets
         where id = v_snippet_id;

        if not found then
          raise exception 'sam_create_practice_plan: item % (song "%"): snippet % not found.',
            v_item_pos, v_song.title, v_snippet_id;
        end if;
        if v_snippet.song_id <> v_song_id then
          raise exception 'sam_create_practice_plan: item %: snippet "%" does not belong to song "%".',
            v_item_pos, v_snippet.title, v_song.title;
        end if;
        if v_snippet.archived then
          raise exception 'sam_create_practice_plan: item %: snippet "%" is archived.',
            v_item_pos, v_snippet.title;
        end if;
      end if;

      if exists (select 1 from sam_practice_plan_items
                  where plan_id = v_plan_id
                    and song_id = v_song_id
                    and snippet_id is not distinct from v_snippet_id) then
        raise exception 'sam_create_practice_plan: item %: song "%" already has an item for this exact range. One item per range per plan.',
          v_item_pos, v_song.title;
      end if;

      -- Pass and accuracy checks
      if v_passes is null or v_passes < 1 then
        raise exception 'sam_create_practice_plan: item % (song "%"): target_passes must be at least 1.',
          v_item_pos, v_song.title;
      end if;
      if v_free and v_accuracy is not null then
        raise exception 'sam_create_practice_plan: item % (song "%"): free play items take no accuracy_target.',
          v_item_pos, v_song.title;
      end if;
      if not v_free and (v_accuracy is null or v_accuracy < 1 or v_accuracy > 100) then
        raise exception 'sam_create_practice_plan: item % (song "%"): accuracy_target between 1 and 100 is required.',
          v_item_pos, v_song.title;
      end if;

      -- Tempo checks (spec §4)
      if v_has_audio then
        if v_song.default_bpm is null then
          raise exception 'sam_create_practice_plan: item %: song "%" has audio but no default_bpm.',
            v_item_pos, v_song.title;
        end if;
        v_bpm := coalesce(v_bpm, v_song.default_bpm);
        if v_bpm <> v_song.default_bpm then
          raise exception 'sam_create_practice_plan: item %: song "%" has audio, so target_bpm must equal its default_bpm (%). Set the target through target_playback_speed.',
            v_item_pos, v_song.title, v_song.default_bpm;
        end if;
        if v_speed is null and v_free then
          v_speed := v_song.goal_playback_speed;
        end if;
        if v_speed is null or v_speed < 1 then
          raise exception 'sam_create_practice_plan: item %: song "%" has audio, so target_playback_speed is required.',
            v_item_pos, v_song.title;
        end if;
      else
        v_speed := coalesce(v_speed, 100);
        if v_speed <> 100 then
          raise exception 'sam_create_practice_plan: item %: song "%" has no audio, so target_playback_speed must be 100.',
            v_item_pos, v_song.title;
        end if;
        if v_bpm is null and v_free then
          v_bpm := v_song.goal_bpm;
        end if;
        if v_bpm is null or v_bpm < 1 then
          raise exception 'sam_create_practice_plan: item %: song "%" needs a target_bpm.',
            v_item_pos, v_song.title;
        end if;
      end if;

      insert into sam_practice_plan_items (
        plan_id, plan_song_id, song_id, snippet_id, position, is_free_play,
        target_bpm, target_playback_speed, target_passes, accuracy_target, instruction
      )
      values (
        v_plan_id, v_plan_song_id, v_song_id, v_snippet_id, v_item_pos, v_free,
        v_bpm, v_speed, v_passes, v_accuracy, nullif(btrim(v_item->>'instruction'), '')
      );
    end loop;
  end loop;

  if v_item_pos > 20 then
    raise exception 'sam_create_practice_plan: a plan may have at most 20 items (got %).', v_item_pos;
  end if;

  return v_plan_id;
end;
$$;

comment on function public.sam_create_practice_plan(jsonb) is
'SAM: the ONLY way to create a practice plan. Atomically supersedes the active plan and inserts
the plan, its songs and items, returning the new plan id. All-or-nothing validation: songs and
snippets exist and are not archived, snippet belongs to its song, one item per range, required
targets, free play has no accuracy target, tempo rules (songs with audio: target_bpm =
default_bpm, target via speed; without audio: speed 100). Free play tempo defaults to the song''s
goal pair. At most 20 items. Input shape:
{ day_note, internal_notes, review_instructions,
  songs: [ { song_id, song_note, internal_notes,
             items: [ { snippet_id?, is_free_play?, target_bpm?, target_playback_speed?,
                        target_passes, accuracy_target?, instruction? } ] } ] }';

revoke all on function public.sam_create_practice_plan(jsonb) from public, anon;
grant execute on function public.sam_create_practice_plan(jsonb) to authenticated, service_role;


-- ============================================================================
-- PART 4 — Mark hand-set goal tempos as confirmed
-- Songs in rotation (goals set by hand) plus their simplified versions.
-- Drills are not included.
-- ============================================================================

-- 4a. PREVIEW. Check this list before running 4b.
select id, title, song_type, goal_bpm, goal_playback_speed, goal_effective_bpm, goal_set_at
  from public.sam_songs
 where id in (
         '0ce141e8-3fb6-456a-8090-b860dd0d0290',  -- Pastorale No. 3
         '34edbb1d-eb6e-4ef1-8d77-91739d037b9e',  -- Arabesque No. 2
         'b7bf882c-9256-48d5-9c0e-926e79744173',  -- La Candeur No. 1
         '6f99b354-a1b7-426f-a907-de4f0da3824f',  -- Autumn Leaves
         '030333d9-1b9f-4f74-80fb-7fbed587fda6',  -- Someone Like You
         '7a8d3645-c9b9-4518-a28a-5f9800bd02fa',  -- Say It Ain't So
         '8d83a19e-b0e0-4168-aa68-cad7c3fcecde',  -- The Entertainer
         'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096'   -- The Scientist
       )
    or (song_type = 'simplified'
        and parent_song_id in (
         '0ce141e8-3fb6-456a-8090-b860dd0d0290',
         '34edbb1d-eb6e-4ef1-8d77-91739d037b9e',
         'b7bf882c-9256-48d5-9c0e-926e79744173',
         '6f99b354-a1b7-426f-a907-de4f0da3824f',
         '030333d9-1b9f-4f74-80fb-7fbed587fda6',
         '7a8d3645-c9b9-4518-a28a-5f9800bd02fa',
         '8d83a19e-b0e0-4168-aa68-cad7c3fcecde',
         'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096'
       ))
 order by title;


-- 4b. APPLY. Run only after the preview looks right.
update public.sam_songs
   set goal_set_at = now()
 where goal_set_at is null
   and (
         id in (
           '0ce141e8-3fb6-456a-8090-b860dd0d0290',
           '34edbb1d-eb6e-4ef1-8d77-91739d037b9e',
           'b7bf882c-9256-48d5-9c0e-926e79744173',
           '6f99b354-a1b7-426f-a907-de4f0da3824f',
           '030333d9-1b9f-4f74-80fb-7fbed587fda6',
           '7a8d3645-c9b9-4518-a28a-5f9800bd02fa',
           '8d83a19e-b0e0-4168-aa68-cad7c3fcecde',
           'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096'
         )
      or (song_type = 'simplified'
          and parent_song_id in (
           '0ce141e8-3fb6-456a-8090-b860dd0d0290',
           '34edbb1d-eb6e-4ef1-8d77-91739d037b9e',
           'b7bf882c-9256-48d5-9c0e-926e79744173',
           '6f99b354-a1b7-426f-a907-de4f0da3824f',
           '030333d9-1b9f-4f74-80fb-7fbed587fda6',
           '7a8d3645-c9b9-4518-a28a-5f9800bd02fa',
           '8d83a19e-b0e0-4168-aa68-cad7c3fcecde',
           'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096'
         ))
       );
