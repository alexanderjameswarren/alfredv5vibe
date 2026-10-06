-- Purpose: Warm-up ladder Milestone 1: the ladder column on snippets, songs and plan items, goal_is_warmup and consecutive on plan items, the two rung columns on sam_passes, the ladder validator, ladder resolution, and the sam_plan_item_progress rewrite.
-- Kind: schema change (columns, constraints, three new functions, one function replaced)
-- Applied: YES — confirmed 2026-10-06: the warm-up ladder constraints exist
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.

-- ============================================================================
-- SAM Warm-up Ladder — Milestone 1
-- supabase/migrations/078_sam_warmup_ladder.sql
-- Spec: docs/technical-spec-sam-warmup-ladder.md §5, §9
-- Builds on: docs/history/technical-spec-sam-practice-plans.md §5, §5.7
--            supabase/migrations/054_sam_practice_plans.sql
--
-- Run in the Supabase SQL editor ONE PART AT A TIME, in order. Parts 1-5 are
-- the migration; Part 6 is the conformance check; Part 7 is a read-only
-- verification query that proves existing plan items still compute identically.
--
-- NOTHING HERE CHANGES EXISTING BEHAVIOUR.
--   - Every new column is nullable, or boolean not null default false.
--   - sam_plan_item_progress keeps its first seven output columns, in order,
--     computed by byte-identical expressions. It gains two columns at the end.
--   - A plan item with consecutive = false and goal_is_warmup = false is
--     reported exactly as it is today.
--
-- DECISIONS TAKEN HERE THAT THE SPEC LEFT OPEN — each is argued at the point it
-- is made, and all five are listed in the report that accompanied this file:
--   1. Validation is a CHECK constraint over one shared IMMUTABLE validator
--      function, not a trigger and not tool-side code (Part 1).
--   2. Rung percents must be STRICTLY ascending (Part 1).
--   3. goal_is_warmup and is_free_play are mutually exclusive (Part 2).
--   4. The two rung columns are NOT added to sam_sessions (Part 3).
--   5. A ladder completion is defined per ladder RUN, not per session, and the
--      recorded rung is trusted as evidence that the lower rungs were satisfied
--      (Part 5).
-- ============================================================================


-- ============================================================================
-- PART 1 — The ladder column, and the validator that guards it
-- ============================================================================

-- WHERE VALIDATION LIVES, AND WHY IT IS A CHECK CONSTRAINT.
--
-- The rules in spec §5.1 are a pure function of one jsonb value, they are the
-- same on all three tables, and they must hold no matter who writes the row:
-- the Edit Song dialog, the snippet editor, a Claude tool, a hand-written
-- UPDATE in the SQL editor, or a future backfill. That rules out validating in
-- the tools: a tool-side check is a good error message, not an invariant, and
-- the two ladder editors in milestone 3 write from the app without going
-- through a tool at all.
--
-- A trigger would enforce it, but it needs three trigger objects and three
-- attachments for one rule, it can be switched off with ALTER TABLE ... DISABLE
-- TRIGGER, and on sam_practice_plan_items it would sit beside a trigger that
-- already rejects every update, which invites confusion about which one fired.
-- A CHECK constraint over one shared function is declarative, is visible in the
-- table definition, and states the rule once.
--
-- THE ONE CAVEAT, stated so a future reader is not surprised: Postgres does not
-- re-validate existing rows when the body of a function used by a CHECK
-- constraint changes. If the rules in §5.1 are ever loosened or tightened, the
-- three constraints must be dropped and re-added so the existing rows are
-- checked against the new rule.
create or replace function public.sam_warmup_ladder_is_valid(p_ladder jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = public
as $$
declare
  v_len  integer;
  v_rung jsonb;
  v_pct  integer;
  v_prev integer := null;
  v_keys integer;
  i      integer;
begin
  -- NULL means "fall through to the next level" (spec §5.1). It is not a ladder
  -- and there is nothing to check.
  if p_ladder is null then
    return true;
  end if;

  if jsonb_typeof(p_ladder) <> 'array' then
    return false;
  end if;

  v_len := jsonb_array_length(p_ladder);

  -- The empty array is how a song or an item opts OUT of a ladder it would
  -- otherwise inherit (spec §5.1). It is valid and means "no warm-up here".
  if v_len = 0 then
    return true;
  end if;

  -- At most six rungs. A ramp longer than six is a practice session, not a
  -- warm-up, and the strip in the player has no room for it.
  if v_len > 6 then
    return false;
  end if;

  for i in 0 .. v_len - 1 loop
    v_rung := p_ladder -> i;

    if jsonb_typeof(v_rung) <> 'object' then
      return false;
    end if;

    -- Exactly the four known keys, nothing else. A rung written with
    -- "target_pass" or "percent" would otherwise be accepted and then silently
    -- ignored by every reader, which is worse than a rejected write.
    select count(*) into v_keys
      from jsonb_object_keys(v_rung) k
     where k not in ('target_percent', 'accuracy_target', 'target_passes', 'consecutive');
    if v_keys > 0 then
      return false;
    end if;

    -- target_percent, target_passes and consecutive are required on every rung.
    -- accuracy_target must be present but may be null, which means "use the
    -- item's accuracy target" (spec §3).
    -- jsonb_exists() rather than the `?` operator: identical meaning, and no
    -- client that rewrites `?` as a bind placeholder can mangle it.
    if not (jsonb_exists(v_rung, 'target_percent')
            and jsonb_exists(v_rung, 'target_passes')
            and jsonb_exists(v_rung, 'consecutive')
            and jsonb_exists(v_rung, 'accuracy_target')) then
      return false;
    end if;

    if jsonb_typeof(v_rung -> 'target_percent') <> 'number' then
      return false;
    end if;
    v_pct := (v_rung ->> 'target_percent')::numeric::integer;
    if (v_rung ->> 'target_percent')::numeric <> v_pct then
      return false;                      -- whole percents only
    end if;
    if v_pct < 10 or v_pct > 100 then
      return false;
    end if;

    -- STRICTLY ascending, which is stronger than the spec's "ascending order".
    -- Two rungs at the same percent are two rungs at the same tempo, and the
    -- recorded warmup_target_percent would then no longer identify which rung a
    -- pass belonged to — which is exactly what the progress function reads it
    -- for. A rung that exists only to tighten the accuracy bar at the same
    -- tempo belongs in the rung below it.
    if v_prev is not null and v_pct <= v_prev then
      return false;
    end if;
    v_prev := v_pct;

    -- The last rung is the target. A ladder that stops short of 100% would
    -- leave the player looping below target tempo with nothing to finish.
    if i = v_len - 1 and v_pct <> 100 then
      return false;
    end if;

    if jsonb_typeof(v_rung -> 'accuracy_target') not in ('null', 'number') then
      return false;
    end if;
    if jsonb_typeof(v_rung -> 'accuracy_target') = 'number' then
      if (v_rung ->> 'accuracy_target')::numeric < 1
         or (v_rung ->> 'accuracy_target')::numeric > 100 then
        return false;
      end if;
    end if;

    if jsonb_typeof(v_rung -> 'target_passes') <> 'number' then
      return false;
    end if;
    if (v_rung ->> 'target_passes')::numeric < 1
       or (v_rung ->> 'target_passes')::numeric > 32767 then
      return false;
    end if;

    if jsonb_typeof(v_rung -> 'consecutive') <> 'boolean' then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

comment on function public.sam_warmup_ladder_is_valid(jsonb) is
'SAM: the ONE definition of a valid warm-up ladder (spec §5.1), used by the CHECK constraint on
sam_snippets, sam_songs and sam_practice_plan_items. True for NULL (inherit) and for [] (no warm-up
here). Otherwise: 1-6 rungs; every rung an object with exactly the keys target_percent,
accuracy_target, target_passes, consecutive; percents whole, 10-100, STRICTLY ascending, last rung
exactly 100; accuracy_target null or 1-100; target_passes >= 1; consecutive a boolean. NOTE:
Postgres does not re-check existing rows when this body changes — drop and re-add the three
constraints if the rules ever change.';

revoke all on function public.sam_warmup_ladder_is_valid(jsonb) from public, anon;
grant execute on function public.sam_warmup_ladder_is_valid(jsonb) to authenticated, service_role;


-- --- The column, same shape on all three tables -----------------------------

alter table public.sam_snippets
  add column if not exists warmup_ladder jsonb;

alter table public.sam_songs
  add column if not exists warmup_ladder jsonb;

alter table public.sam_practice_plan_items
  add column if not exists warmup_ladder jsonb;

alter table public.sam_snippets
  add constraint sam_snippets_warmup_ladder_valid
  check (public.sam_warmup_ladder_is_valid(warmup_ladder));

alter table public.sam_songs
  add constraint sam_songs_warmup_ladder_valid
  check (public.sam_warmup_ladder_is_valid(warmup_ladder));

alter table public.sam_practice_plan_items
  add constraint sam_practice_plan_items_warmup_ladder_valid
  check (public.sam_warmup_ladder_is_valid(warmup_ladder));

-- One comment text, said three times, because a reader who lands on any one of
-- these columns needs the whole rule and the whole fallback order.
comment on column public.sam_snippets.warmup_ladder is
'Warm-up ladder for this passage: a jsonb ARRAY of rungs, each
{target_percent, accuracy_target, target_passes, consecutive}. target_percent is a percent of the
TARGET tempo (the plan item''s target_effective_bpm, else the song''s confirmed goal_effective_bpm,
else whatever is in the tempo box), never of goal_bpm. NULL = inherit: resolution order is plan item
-> snippet -> song -> the app default in sam_default_warmup_ladder(). [] = no warm-up here, which is
how a level opts out of an inherited ladder. A rung''s null accuracy_target means "use the plan
item''s accuracy target" (85% off-plan). consecutive on a rung means that rung''s target_passes must
be met as a streak WITHIN ONE SESSION — a stop or a pause ends the session and the streak with it.
Validated by sam_warmup_ladder_is_valid(). Ladder PROGRESS is never stored: it lives in memory for
the session, and pressing Warm up always restarts at rung one.';

comment on column public.sam_songs.warmup_ladder is
'Warm-up ladder fallback for every range in this song: a jsonb ARRAY of rungs, each
{target_percent, accuracy_target, target_passes, consecutive}. target_percent is a percent of the
TARGET tempo, never of goal_bpm. NULL = inherit: resolution order is plan item -> snippet -> song ->
the app default in sam_default_warmup_ladder(), so NULL here falls through to the default. [] = no
warm-up for this song. A rung''s null accuracy_target means "use the plan item''s accuracy target"
(85% off-plan). consecutive on a rung means that rung''s target_passes must be met as a streak
WITHIN ONE SESSION — a stop or a pause ends the session and the streak with it. Validated by
sam_warmup_ladder_is_valid(). Ladder progress is never stored.';

comment on column public.sam_practice_plan_items.warmup_ladder is
'Warm-up ladder for this item, overriding the snippet''s and the song''s while the plan is active,
including after the item is complete for the day: a jsonb ARRAY of rungs, each
{target_percent, accuracy_target, target_passes, consecutive}. target_percent is a percent of this
item''s target_effective_bpm. NULL = inherit from the snippet, then the song, then
sam_default_warmup_ladder(). [] = no warm-up for this item. A rung''s null accuracy_target means
"use this item''s accuracy_target". consecutive on a rung means that rung''s target_passes must be
met as a streak WITHIN ONE SESSION. Set at creation and never changed — plan items are immutable
(sam_practice_plan_items_reject_update). Validated by sam_warmup_ladder_is_valid().';


-- ============================================================================
-- PART 2 — Warm-up as a goal, and consecutive counting, on plan items
-- ============================================================================

-- Both default false, so every existing row keeps exactly today's meaning and
-- the checklist reads identically. The table's reject-every-update trigger
-- (sam_practice_plan_items_reject_update, migration 054) already covers these
-- columns: it raises on any UPDATE regardless of which column changed, so all
-- three new item columns are set at insert and can never change afterwards.
-- Nothing needed to be added to that trigger.
alter table public.sam_practice_plan_items
  add column if not exists goal_is_warmup boolean not null default false,
  add column if not exists consecutive    boolean not null default false;

-- A warm-up item's top rung falls back to the item's accuracy_target when its
-- own is null (spec §5.2), and a free-play item is required to have a null
-- accuracy_target (migration 054). The two cannot both hold, so they are
-- mutually exclusive. THIS CONSTRAINT IS A DECISION, not something the spec
-- states: §5.2 says an item's target_passes and accuracy_target "must still be
-- supplied" for a warm-up item, which is impossible when is_free_play is true.
alter table public.sam_practice_plan_items
  add constraint sam_practice_plan_items_warmup_not_free_play
  check (not (goal_is_warmup and is_free_play));

-- An item whose goal IS the warm-up, carrying its own EMPTY ladder, could never
-- be completed. The resolved-empty case (item null, snippet [] for instance)
-- needs three tables and so cannot be a check constraint; the create tool
-- rejects that in milestone 4, and sam_plan_item_progress reports 0 completions
-- for it either way. The jsonb_typeof guard is here because Postgres does not
-- promise which CHECK runs first: without it, a non-array ladder could raise a
-- raw "cannot get array length of a scalar" instead of the validator's clean
-- constraint violation.
alter table public.sam_practice_plan_items
  add constraint sam_practice_plan_items_warmup_goal_needs_ladder
  check (not (goal_is_warmup
              and jsonb_typeof(warmup_ladder) = 'array'
              and jsonb_array_length(warmup_ladder) = 0));

comment on column public.sam_practice_plan_items.goal_is_warmup is
'True = the WARM-UP IS THE GOAL. The item is complete for the day once the resolved ladder has been
completed at least once that Pacific day (sam_plan_item_progress.ladder_completions >= 1), NOT when
target_passes qualifying passes are reached. accuracy_target is still required and IS what the top
rung falls back to when the rung''s own accuracy_target is null. target_passes is still required but
does NOT substitute: §5.1 requires target_passes on every rung, so the top rung always carries its
own. Mutually exclusive with is_free_play (constraint-enforced). Default false = today''s behaviour,
unchanged. Set at insert; the table is immutable.';

comment on column public.sam_practice_plan_items.consecutive is
'How target_passes is counted. FALSE (the default, and today''s behaviour, unchanged) = CUMULATIVE:
any target_passes qualifying passes across the whole Pacific day, in any order, in any number of
sittings. TRUE = the target_passes qualifying passes must be a STREAK WITHIN ONE SESSION: passes in
a row, with no non-qualifying pass between them. A stop or a pause ends the session and therefore
the streak, because that is what "without stopping" means. Read
sam_plan_item_progress.longest_qualifying_streak for a consecutive item and .qualifying for a
cumulative one; the function returns both on every row and never decides between them. Set at
insert; the table is immutable.';


-- ============================================================================
-- PART 3 — Recording which rung a pass belonged to
-- ============================================================================

-- WHY NOT ON sam_sessions TOO (spec §5.4 asks for a decision): no. A session
-- does not have a rung — it moves through them, which is the whole point — so
-- there is no honest value to store. "Was this sitting a warm-up?" is already
-- answerable from its passes, and a pair of columns on the session row would be
-- a second, staler answer to a question that already has one. That is the same
-- reason ladder progress is never stored (spec §2.9).
alter table public.sam_passes
  add column if not exists warmup_rung           smallint,
  add column if not exists warmup_target_percent smallint;

alter table public.sam_passes
  add constraint sam_passes_warmup_rung_range
  check (warmup_rung is null or warmup_rung between 1 and 6);

alter table public.sam_passes
  add constraint sam_passes_warmup_percent_range
  check (warmup_target_percent is null or warmup_target_percent between 10 and 100);

-- Either a pass is part of a ladder run, with both facts, or it is an ordinary
-- pass with neither. A rung with no percent would be unreadable without the
-- ladder, which is exactly what the percent exists to avoid.
alter table public.sam_passes
  add constraint sam_passes_warmup_pair
  check ((warmup_rung is null) = (warmup_target_percent is null));

comment on column public.sam_passes.warmup_rung is
'1-based index of the warm-up ladder rung this pass belonged to, or NULL for an ordinary pass. The
app writes this, and the app only reaches rung N after rungs 1..N-1 were satisfied on their own
rules — so a pass marked with rung N is the engine''s own evidence that the rungs below it were met.
sam_plan_item_progress relies on that rather than re-deriving it. A DROP back to rung 1 inside one
session is how "he pressed Warm up again" is recognised. NULL on every row written before this
column existed.';

comment on column public.sam_passes.warmup_target_percent is
'The rung''s target_percent, denormalised onto the pass so analysis never has to resolve the ladder
that was in force — ladders can be edited, and ladder progress is never stored. Percent of the
TARGET tempo, so the rung''s BPM was greatest(20, round(target_effective_bpm * this / 100)). Because
percents are strictly ascending and the last rung is always 100, warmup_target_percent = 100
identifies a TOP-rung pass with no ladder lookup at all. NULL on an ordinary pass. A pass below the
top rung is at a deliberately slow tempo: it is not evidence about the passage at target tempo, so
it never qualifies for a plan item (it fails the tempo bar by construction) and is excluded from
measure stats by default.';

-- No new index. Every warm-up query reaches these rows through an existing
-- path — (song_id, completed_at) for history and progress, (snippet_id,
-- completed_at) for a snippet — and then filters on the rung within a handful
-- of rows. An index that earns nothing is one more thing to keep true.


-- ============================================================================
-- PART 4 — Resolving a ladder in SQL, so there is one fallback order
-- ============================================================================

-- The app default (spec §3) has to exist in SQL as well as in the player,
-- because sam_plan_item_progress needs the top rung's pass count to say whether
-- a ladder was completed, and an item that supplies no ladder of its own
-- resolves all the way to this default. Put it in a function rather than
-- inlining it, so the player can read the same bytes over RPC and the constant
-- exists once.
create or replace function public.sam_default_warmup_ladder()
returns jsonb
language sql
immutable
parallel safe
set search_path = public
as $$
  select '[{"target_percent": 70,  "accuracy_target": null, "target_passes": 2, "consecutive": true},
           {"target_percent": 85,  "accuracy_target": null, "target_passes": 2, "consecutive": true},
           {"target_percent": 100, "accuracy_target": null, "target_passes": 2, "consecutive": true}]'::jsonb;
$$;

comment on function public.sam_default_warmup_ladder() is
'SAM: the app default warm-up ladder (spec §3) — 70/85/100 percent of target tempo, two consecutive
passes each, accuracy inherited from the plan item. The last level of the resolution order, used
when no plan item, snippet or song supplies one. This is the single source of the constant: the
player should read it here rather than keeping its own copy.';

revoke all on function public.sam_default_warmup_ladder() from public, anon;
grant execute on function public.sam_default_warmup_ladder() to authenticated, service_role;


create or replace function public.sam_resolve_warmup_ladder(
  p_song_id      uuid,
  p_snippet_id   uuid default null,
  p_plan_item_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  -- First level that is not NULL wins. coalesce is the whole rule: NULL means
  -- "fall through", and [] is not NULL, so an empty array stops the chain and
  -- means "no warm-up here".
  select coalesce(
    (select i.warmup_ladder from sam_practice_plan_items i where i.id = p_plan_item_id),
    (select s.warmup_ladder from sam_snippets s        where s.id = p_snippet_id),
    (select g.warmup_ladder from sam_songs g           where g.id = p_song_id),
    public.sam_default_warmup_ladder()
  );
$$;

comment on function public.sam_resolve_warmup_ladder(uuid, uuid, uuid) is
'SAM: THE resolution order for a warm-up ladder (spec §4) — plan item, then snippet, then song, then
sam_default_warmup_ladder(). NULL at a level means fall through; [] at a level means "no warm-up
here" and stops the chain, so this returns [] rather than the default. Pass p_snippet_id NULL for a
whole song and p_plan_item_id NULL when the loaded range matches no plan item. security invoker, so
it sees only the caller''s rows.';

revoke all on function public.sam_resolve_warmup_ladder(uuid, uuid, uuid) from public, anon;
grant execute on function public.sam_resolve_warmup_ladder(uuid, uuid, uuid) to authenticated, service_role;


-- ============================================================================
-- PART 5 — sam_plan_item_progress: two new columns, nothing else changed
-- ============================================================================

-- CREATE OR REPLACE cannot add columns to a function's RETURNS TABLE, so the old
-- function has to go first. Run this DROP and the CREATE below it TOGETHER, in
-- one paste: between them the app's checklist and get_sam_plan_progress have no
-- progress function to call. Pasted together they run in one implicit
-- transaction, so there is no window where the function is missing.
drop function if exists public.sam_plan_item_progress(uuid, date, date);

create or replace function public.sam_plan_item_progress(
  p_plan_id uuid,
  p_from    date,
  p_to      date
)
returns table (
  plan_item_id              uuid,
  day                       date,
  attempts                  integer,
  qualifying                integer,
  best_accuracy             integer,
  best_effective_bpm        integer,
  last_completed_at         timestamptz,
  longest_qualifying_streak integer,
  ladder_completions        integer
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
  with itm as (
    select i.id                    as item_id,
           i.song_id               as item_song_id,
           i.snippet_id            as item_snippet_id,
           i.position              as item_position,
           i.is_free_play          as item_free,
           i.target_effective_bpm  as item_bpm,
           i.accuracy_target       as item_accuracy,
           public.sam_resolve_warmup_ladder(i.song_id, i.snippet_id, i.id) as ladder
      from sam_practice_plan_items i
     where i.plan_id = p_plan_id
  ),
  -- The top rung's own bar. The ladder's last rung is always the 100% rung
  -- (validator), and its target_passes is always present (§5.1 requires it on
  -- every rung), so only accuracy_target falls back to the item's.
  top_rung as (
    select t.item_id,
           coalesce((t.ladder -> -1 ->> 'accuracy_target')::smallint,
                    t.item_accuracy)                                      as top_accuracy,
           (t.ladder -> -1 ->> 'target_passes')::smallint                  as top_passes,
           coalesce((t.ladder -> -1 ->> 'consecutive')::boolean, false)    as top_consecutive
      from itm t
     where jsonb_array_length(t.ladder) > 0
  ),
  -- Every attempt on every item, with the three facts the aggregates below
  -- need. The join, the notes_played rule, the window and the qualifying
  -- expression are unchanged from migration 054.
  att as (
    select t.item_id,
           t.item_position,
           (pa.completed_at at time zone 'America/Los_Angeles')::date as pt_day,
           -- Sessions are the unit a streak lives in. A pass whose session_id is
           -- NULL cannot be attributed to a sitting — a row written before the
           -- column was filled, a session row since deleted (ON DELETE SET
           -- NULL), or a pass that completed inside the window where the app is
           -- still inserting the session row — so it becomes a group of its own
           -- and can never join, or bridge, a streak. That under-counts rather
           -- than inventing a streak that did not happen.
           coalesce(pa.session_id, pa.id)                             as session_key,
           pa.id                                                      as pass_id,
           pa.completed_at,
           pa.accuracy_percent,
           pa.effective_bpm,
           pa.warmup_rung,
           pa.warmup_target_percent,
           coalesce(pa.effective_bpm >= t.item_bpm
                    and (t.item_free or pa.accuracy_percent >= t.item_accuracy),
                    false)                                            as qualifies
      from itm t
      join sam_passes pa
        on pa.song_id = t.item_song_id
       and pa.snippet_id is not distinct from t.item_snippet_id
     where pa.notes_played > 0
       and pa.completed_at >= (p_from::timestamp at time zone 'America/Los_Angeles')
       and pa.completed_at <  ((p_to + 1)::timestamp at time zone 'America/Los_Angeles')
  ),
  -- One row per item per day with at least one attempt. Identical to 054.
  base as (
    select a.item_id,
           a.pt_day,
           count(*)::integer                              as n_attempts,
           count(*) filter (where a.qualifies)::integer    as n_qualifying,
           max(a.accuracy_percent)::integer                as best_acc,
           max(a.effective_bpm)::integer                   as best_bpm,
           max(a.completed_at)                             as last_at,
           min(a.item_position)                            as pos
      from att a
     group by a.item_id, a.pt_day
  ),
  -- The longest run of qualifying passes inside one session, on one day.
  -- Gaps-and-islands: within a session, two ordinal sequences drift apart
  -- exactly when the qualifying flag changes, so their difference labels each
  -- unbroken run.
  islands as (
    select a.item_id, a.pt_day, a.session_key, a.qualifies,
           row_number() over (partition by a.item_id, a.pt_day, a.session_key
                              order by a.completed_at, a.pass_id)
         - row_number() over (partition by a.item_id, a.pt_day, a.session_key, a.qualifies
                              order by a.completed_at, a.pass_id) as grp
      from att a
  ),
  streaks as (
    select s.item_id, s.pt_day, max(s.run_len)::integer as longest
      from (
        select item_id, pt_day, session_key, grp, count(*) as run_len
          from islands
         where qualifies
         group by item_id, pt_day, session_key, grp
      ) s
     group by s.item_id, s.pt_day
  ),
  -- LADDER RUNS. A run is one press of Warm up: it starts at the first warm-up
  -- pass of a session and again whenever the rung DROPS below the previous
  -- warm-up pass's rung, which only happens when he restarts the ladder. Passes
  -- that keep looping at the top rung after completion never decrease, so they
  -- stay in the run that earned them.
  runs as (
    select r.item_id, r.pt_day, r.session_key, r.completed_at, r.pass_id,
           r.warmup_target_percent,
           r.top_ok,
           sum(case when r.is_restart then 1 else 0 end) over (
             partition by r.item_id, r.pt_day, r.session_key
             order by r.completed_at, r.pass_id
           ) as run_no
      from (
        select a.item_id, a.pt_day, a.session_key, a.completed_at, a.pass_id,
               a.warmup_rung, a.warmup_target_percent,
               -- The top rung's bar, which can be STRICTER than the item's: the
               -- top rung is 100% of the target, so its tempo bar is the item's
               -- target_effective_bpm (floored at 20, per §4), but its accuracy
               -- bar is the rung's own when it has one.
               coalesce(a.effective_bpm >= greatest(20, t.item_bpm)
                        and (tr.top_accuracy is null
                             or a.accuracy_percent >= tr.top_accuracy),
                        false) as top_ok,
               (lag(a.warmup_rung) over w is null
                or a.warmup_rung < lag(a.warmup_rung) over w) as is_restart
          from att a
          join itm t      on t.item_id = a.item_id
          join top_rung tr on tr.item_id = a.item_id
         where a.warmup_rung is not null
        window w as (partition by a.item_id, a.pt_day, a.session_key
                     order by a.completed_at, a.pass_id)
      ) r
  ),
  -- Within a run, only the top-rung passes decide completion.
  top_islands as (
    select item_id, pt_day, session_key, run_no, top_ok, grp, count(*) as len
      from (
        select item_id, pt_day, session_key, run_no, top_ok,
               row_number() over (partition by item_id, pt_day, session_key, run_no
                                  order by completed_at, pass_id)
             - row_number() over (partition by item_id, pt_day, session_key, run_no, top_ok
                                  order by completed_at, pass_id) as grp
          from runs
         where warmup_target_percent = 100
      ) s
     group by item_id, pt_day, session_key, run_no, top_ok, grp
  ),
  run_totals as (
    select item_id, pt_day, session_key, run_no,
           coalesce(sum(len) filter (where top_ok), 0) as cumulative_top,
           coalesce(max(len) filter (where top_ok), 0) as longest_top
      from top_islands
     group by item_id, pt_day, session_key, run_no
  ),
  completions as (
    select rt.item_id, rt.pt_day, count(*)::integer as n
      from run_totals rt
      join top_rung tr on tr.item_id = rt.item_id
     where case when tr.top_consecutive then rt.longest_top else rt.cumulative_top end
           >= tr.top_passes
     group by rt.item_id, rt.pt_day
  )
  select b.item_id,
         b.pt_day,
         b.n_attempts,
         b.n_qualifying,
         b.best_acc,
         b.best_bpm,
         b.last_at,
         coalesce(st.longest, 0)::integer,
         coalesce(c.n, 0)::integer
    from base b
    left join streaks     st on st.item_id = b.item_id and st.pt_day = b.pt_day
    left join completions c  on c.item_id  = b.item_id and c.pt_day  = b.pt_day
   order by b.pt_day, b.pos;
end;
$$;

comment on function public.sam_plan_item_progress(uuid, date, date) is
'SAM: THE single source of plan progress, used by both the app and Claude''s tools. Nothing else
counts passes. One row per plan item per Pacific day with at least one attempt.

UNCHANGED (first seven columns, same expressions as migration 054): a pass MATCHES an item when
song_id is equal and snippet_id is not distinct from the item''s (both null = whole song). ATTEMPT =
a matching pass with notes_played > 0. QUALIFYING = an attempt with effective_bpm >=
target_effective_bpm and, unless free play, accuracy_percent >= accuracy_target. Day =
completed_at in America/Los_Angeles. Matching ignores sam_passes.plan_item_id. Range capped at 31
days.

longest_qualifying_streak — the longest run of CONSECUTIVE qualifying passes within ONE SESSION on
that day. Consecutive means passes in a row with no non-qualifying pass between them; a stop or a
pause ends the session and therefore the streak. A pass with a null session_id is treated as a
session of one, so it can never join or bridge a streak. A streak that crosses Pacific midnight is
split at midnight, because an item is a per-day thing. Read this column for an item with
consecutive = true and the qualifying column for one with consecutive = false; this function
reports both and decides neither.

ladder_completions — how many times the resolved warm-up ladder was completed that day. A LADDER RUN
is one press of Warm up: it begins at the first warm-up pass of a session and again whenever
warmup_rung DROPS below the previous warm-up pass''s rung in that session. A run is COMPLETED when
its top-rung passes (warmup_target_percent = 100) meet the top rung''s target_passes — as a streak
if that rung is consecutive, cumulatively if not — where a top-rung pass counts if its effective_bpm
reached the item''s target_effective_bpm and its accuracy reached the top rung''s accuracy_target,
falling back to the item''s. The lower rungs are NOT re-derived: the app only marks a pass with rung
N after rungs 1..N-1 were satisfied on their own rules, so the recorded rung is the engine''s own
evidence. Zero when no level supplies a ladder ([]). The ladder is resolved at READ time by
sam_resolve_warmup_ladder, so editing a snippet''s or song''s ladder can change today''s count for an
item that inherits one; an item carrying its own ladder is immutable and cannot drift. Known limit:
with a single-rung ladder a restart is indistinguishable from continued looping, so two warm-ups in
one session count as one.';

revoke all on function public.sam_plan_item_progress(uuid, date, date) from public, anon;
grant execute on function public.sam_plan_item_progress(uuid, date, date) to authenticated, service_role;


-- ============================================================================
-- PART 6 — Platform registration and conformance
-- ============================================================================

-- No new tables, so nothing to register: sam_snippets, sam_songs, sam_passes and
-- sam_practice_plan_items are all registered already, and adding columns does
-- not change a table's policy mode, audit setting or user_id column. Same
-- reasoning as migration 047. Conformance is re-checked regardless, because
-- conformance also checks that new columns carry comments.
-- Expected: CONFORMANT, plus a table count.
select platform.check_conformance();
-- If the platform schema is not exposed to your session, the public wrapper is
-- equivalent:
--   select public.platform_check_conformance();


-- ============================================================================
-- PART 7 — Verification (read-only; run after Parts 1-6)
-- ============================================================================
--
-- Proves the thing that matters: existing plan items compute IDENTICALLY. It
-- recomputes all seven of the old output columns with migration 054's own
-- expressions and full-joins that against the new function, over the newest
-- plan's last 31 days. mismatched_rows_must_be_null must come back null.
--
-- It also confirms the new columns are inert on existing data: no pass carries a
-- rung, no item carries a ladder or a new flag, and every item still resolves to
-- the app default.

-- The newest plan, active or superseded, so this still runs if no plan is active.
with plan as (
  select id, starts_on from sam_practice_plans order by created_at desc limit 1
),
rng as (
  select greatest(p.starts_on,
                  ((now() at time zone 'America/Los_Angeles')::date - 30)) as d_from,
         ((now() at time zone 'America/Los_Angeles')::date)                as d_to
    from plan p
),
newf as (
  select * from sam_plan_item_progress((select id from plan),
                                       (select d_from from rng),
                                       (select d_to from rng))
),
oldf as (
  select i.id as plan_item_id,
         (pa.completed_at at time zone 'America/Los_Angeles')::date as day,
         count(*)::integer as attempts,
         (count(*) filter (
            where pa.effective_bpm >= i.target_effective_bpm
              and (i.is_free_play or pa.accuracy_percent >= i.accuracy_target)
         ))::integer as qualifying,
         max(pa.accuracy_percent)::integer as best_accuracy,
         max(pa.effective_bpm)::integer    as best_effective_bpm,
         max(pa.completed_at)              as last_completed_at
    from sam_practice_plan_items i
    join sam_passes pa
      on pa.song_id = i.song_id
     and pa.snippet_id is not distinct from i.snippet_id
   where i.plan_id = (select id from plan)
     and pa.notes_played > 0
     and pa.completed_at >= ((select d_from from rng)::timestamp at time zone 'America/Los_Angeles')
     and pa.completed_at <  (((select d_to from rng) + 1)::timestamp at time zone 'America/Los_Angeles')
   group by i.id, 2
)
select json_build_object(
  'range_checked', (select json_agg(t) from (select * from rng) t),
  'row_counts', (select json_agg(t) from (
     select (select count(*) from newf) as new_rows,
            (select count(*) from oldf) as old_rows
  ) t),
  'mismatched_rows_must_be_null', (select json_agg(t) from (
     select coalesce(n.plan_item_id, o.plan_item_id) as plan_item_id,
            coalesce(n.day, o.day)                  as day,
            n.attempts as new_attempts, o.attempts as old_attempts,
            n.qualifying as new_qualifying, o.qualifying as old_qualifying,
            n.best_accuracy as new_best_accuracy, o.best_accuracy as old_best_accuracy,
            n.best_effective_bpm as new_best_bpm, o.best_effective_bpm as old_best_bpm,
            n.last_completed_at as new_last_at, o.last_completed_at as old_last_at
       from newf n full join oldf o using (plan_item_id, day)
      where n.plan_item_id is null
         or o.plan_item_id is null
         or n.attempts           is distinct from o.attempts
         or n.qualifying         is distinct from o.qualifying
         or n.best_accuracy      is distinct from o.best_accuracy
         or n.best_effective_bpm is distinct from o.best_effective_bpm
         or n.last_completed_at  is distinct from o.last_completed_at
  ) t),
  'new_columns_today', (select json_agg(t) from (
     select plan_item_id, day, attempts, qualifying,
            longest_qualifying_streak, ladder_completions
       from newf
      order by day desc, plan_item_id
      limit 20
  ) t),
  'ladder_data_must_all_be_zero', (select json_agg(t) from (
     select (select count(*) from sam_passes where warmup_rung is not null)                  as passes_with_a_rung,
            (select count(*) from sam_snippets where warmup_ladder is not null)              as snippets_with_a_ladder,
            (select count(*) from sam_songs where warmup_ladder is not null)                 as songs_with_a_ladder,
            (select count(*) from sam_practice_plan_items where warmup_ladder is not null)   as items_with_a_ladder,
            (select count(*) from sam_practice_plan_items where goal_is_warmup)              as items_goal_is_warmup,
            (select count(*) from sam_practice_plan_items where consecutive)                 as items_consecutive
  ) t),
  'every_item_resolves_to_the_default', (select json_agg(t) from (
     select count(*) as items,
            count(*) filter (
              where sam_resolve_warmup_ladder(song_id, snippet_id, id)
                    = sam_default_warmup_ladder()
            ) as resolving_to_default
       from sam_practice_plan_items
      where plan_id = (select id from plan)
  ) t)
) as result;
