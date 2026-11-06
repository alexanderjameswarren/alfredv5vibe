-- Purpose: sam_cleanup-m4t s8 (Part 6b). The same song range may appear more than once in a practice plan, and
-- items are ordered plan-wide, independently of song order (e.g. a La Candeur warm-up early and its climb last).
-- Progress credits each pass to the item it was opened from (sam_passes.plan_item_id), falling back to song plus
-- range for passes with no plan_item_id or one naming an item of another plan.
-- Kind: schema change (one index dropped, three functions replaced)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-sam_cleanup-m4t.md, Part 6.
-- Each function is the snapshot's text (from 054/078/083) with ONLY the changes marked "s8:". Nothing else retyped.
-- Run as one block, then supabase/tests/sam_cleanup-m4t/2_plan_item_positions_test.sql with --test.
-- The conformance result at the end must be conformant true.
-- supabase/migrations/216_sam_plan_item_positions.sql

begin;

-- ============================================================================
-- 1. Items may repeat a range. sam_practice_plan_songs keeps (plan_id, song_id) unique: a song appears once in
--    songs[], and its repeats come through its items.
-- ============================================================================
drop index if exists public.sam_practice_plan_items_one_per_range;

-- ============================================================================
-- 2. sam_create_practice_plan: optional plan-wide item position; the same range allowed more than once.
-- ============================================================================
create or replace function public.sam_create_practice_plan(p_plan jsonb) returns uuid
    language plpgsql
    set search_path to 'public'
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
  -- Warm-up ladder (milestone 4). v_resolved is what the item's ladder actually
  -- resolves to, which is only needed when goal_is_warmup is set.
  v_ladder       jsonb;
  v_goal_warmup  boolean;
  v_consecutive  boolean;
  v_resolved     jsonb;
  -- s8: plan-wide positions. Either every item gives one, or none does.
  v_n_items      integer;
  v_n_positioned integer;
  v_n_distinct   integer;
  v_explicit     boolean;
  v_position     integer;
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

  -- s8: item positions. Absent everywhere = today's order (song by song). Present
  -- everywhere = whole numbers from 1, no two alike, the order across the plan.
  select count(*),
         count(*) filter (where it->>'position' is not null),
         count(distinct it->>'position') filter (where it->>'position' is not null)
    into v_n_items, v_n_positioned, v_n_distinct
    from jsonb_array_elements(p_plan->'songs') s,
         jsonb_array_elements(case when jsonb_typeof(s->'items') = 'array' then s->'items' else '[]'::jsonb end) it;
  v_explicit := v_n_positioned > 0;
  if v_explicit and v_n_positioned < v_n_items then
    raise exception 'sam_create_practice_plan: give every item a position, or none (% of % have one).',
      v_n_positioned, v_n_items;
  end if;
  if v_explicit and exists (
       select 1
         from jsonb_array_elements(p_plan->'songs') s,
              jsonb_array_elements(case when jsonb_typeof(s->'items') = 'array' then s->'items' else '[]'::jsonb end) it
        -- One check, no cast: Postgres does not promise to short-circuit OR. No zero, no leading zeros.
        where not (it->>'position' ~ '^[1-9][0-9]{0,5}$')) then
    raise exception 'sam_create_practice_plan: item positions must be whole numbers from 1.';
  end if;
  if v_explicit and v_n_distinct < v_n_items then
    raise exception 'sam_create_practice_plan: two items have the same position.';
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

    select id, title, archived, default_bpm, goal_bpm, goal_playback_speed, audio_file_path,
           warmup_ladder
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
      -- s8: the stored position is the plan-wide one when given, else the running count as before.
      v_position   := case when v_explicit then (v_item->>'position')::integer else v_item_pos end;
      v_snippet_id := nullif(v_item->>'snippet_id', '')::uuid;
      v_free       := coalesce((v_item->>'is_free_play')::boolean, false);
      v_bpm        := (v_item->>'target_bpm')::integer;
      v_speed      := (v_item->>'target_playback_speed')::integer;
      v_passes     := (v_item->>'target_passes')::integer;
      v_accuracy   := (v_item->>'accuracy_target')::integer;
      -- A ladder is absent (inherit) or an array; a JSON null is treated as absent,
      -- so "warmup_ladder": null means the same as omitting it.
      v_ladder      := case when jsonb_typeof(v_item->'warmup_ladder') = 'array'
                            then v_item->'warmup_ladder' else null end;
      v_goal_warmup := coalesce((v_item->>'goal_is_warmup')::boolean, false);
      v_consecutive := coalesce((v_item->>'consecutive')::boolean, false);

      -- Snippet checks
      if v_snippet_id is not null then
        select id, song_id, title, archived, warmup_ladder
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

      -- s8: the one-item-per-range check is gone. A range may be planned more than once.

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

      -- ---------------------------------------------------------------------
      -- Warm-up checks (warm-up spec §5.2). The table's own constraints enforce
      -- the ladder's SHAPE; these two are the rules a constraint cannot express —
      -- the second spans three tables.
      -- ---------------------------------------------------------------------
      if v_goal_warmup and v_free then
        raise exception 'sam_create_practice_plan: item % (song "%"): goal_is_warmup cannot be combined with is_free_play — a warm-up item needs an accuracy_target and free play forbids one.',
          v_item_pos, v_song.title;
      end if;

      if v_goal_warmup then
        -- The ladder this item will ACTUALLY run, resolved in the player's own
        -- order: the item's, then the snippet's, then the song's, then the app
        -- default. An item resolving to [] could never be completed, so it could
        -- never be done, so it is refused rather than written.
        v_resolved := coalesce(
          v_ladder,
          case when v_snippet_id is not null then v_snippet.warmup_ladder else null end,
          v_song.warmup_ladder,
          sam_default_warmup_ladder()
        );
        if jsonb_typeof(v_resolved) <> 'array' or jsonb_array_length(v_resolved) = 0 then
          raise exception 'sam_create_practice_plan: item % (song "%"): goal_is_warmup needs a ladder, but this range resolves to none — a level below it stores an empty ladder, which stops the chain. Give the item its own warmup_ladder.',
            v_item_pos, v_song.title;
        end if;
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
        target_bpm, target_playback_speed, target_passes, accuracy_target, instruction,
        warmup_ladder, goal_is_warmup, consecutive
      )
      values (
        v_plan_id, v_plan_song_id, v_song_id, v_snippet_id, v_position, v_free,
        v_bpm, v_speed, v_passes, v_accuracy, nullif(btrim(v_item->>'instruction'), ''),
        v_ladder, v_goal_warmup, v_consecutive
      );
    end loop;
  end loop;

  if v_item_pos > 20 then
    raise exception 'sam_create_practice_plan: a plan may have at most 20 items (got %).', v_item_pos;
  end if;

  return v_plan_id;
end;
$$;

comment on function public.sam_create_practice_plan(jsonb) is 'SAM: the ONLY way to create a practice plan. Atomically supersedes the active plan and inserts
the plan, its songs and items, returning the new plan id. All-or-nothing validation: authenticated,
songs and snippets exist and are not archived, snippet belongs to its song, a song listed once in songs[],
required targets, free play has no accuracy target, tempo rules (songs with audio: target_bpm =
default_bpm, target via speed; without audio: speed 100). Free play tempo defaults to the song''s
goal pair. At most 20 items. The new plan records supersedes_plan_id, so plan history is a chain and
not a set of unconnected rows.

ITEM POSITIONS AND REPEATS (added 2026-11-06, migration 216): a song''s items may repeat a range (one
item per range per plan is no longer required), and an item may carry a plan-wide position, so its
place in the checklist is independent of song order (a warm-up early, the same bars as a climb last).
Either every item gives a position (whole numbers from 1, no two alike) or none does; with none,
positions run song by song in the order given, exactly as before.

WARM-UP LADDER (added 2026-09-27): an item may carry warmup_ladder, goal_is_warmup and consecutive.
The ladder''s SHAPE is checked by the table''s own constraint (sam_warmup_ladder_is_valid); this
function adds the two rules a constraint cannot express — goal_is_warmup is refused with
is_free_play, and refused when the item''s ladder RESOLVES to none (its own, then the snippet''s,
then the song''s, then sam_default_warmup_ladder()), since such an item could never be completed.
Omitting all three keeps the old behaviour exactly: null, false, false.

Input shape:
{ day_note, internal_notes, review_instructions,
  songs: [ { song_id, song_note, internal_notes,
             items: [ { snippet_id?, position?, is_free_play?, target_bpm?, target_playback_speed?,
                        target_passes, accuracy_target?, instruction?,
                        warmup_ladder?, goal_is_warmup?, consecutive? } ] } ] }';

revoke all on function public.sam_create_practice_plan(jsonb) from public, anon;
grant execute on function public.sam_create_practice_plan(jsonb) to authenticated, service_role;

-- ============================================================================
-- 3. sam_plan_item_progress: a pass linked to an item of THIS plan counts for that item only. A pass with no
--    plan_item_id, or one naming an item of another plan, falls back to song plus range.
-- ============================================================================
create or replace function public.sam_plan_item_progress(p_plan_id uuid, p_from date, p_to date)
    returns table(plan_item_id uuid, day date, attempts integer, qualifying integer, best_accuracy integer,
                  best_effective_bpm integer, last_completed_at timestamp with time zone,
                  longest_qualifying_streak integer, ladder_completions integer)
    language plpgsql stable
    set search_path to 'public'
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
  -- need. The notes_played rule, the window and the qualifying expression are
  -- unchanged from migration 054; the match is s8's (see the join).
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
        -- s8: linked to this item; or, with no link to any item of this plan, on its song and range.
        on pa.plan_item_id = t.item_id
        or (pa.song_id = t.item_song_id
            and pa.snippet_id is not distinct from t.item_snippet_id
            and (pa.plan_item_id is null
                 or not exists (select 1 from itm t2 where t2.item_id = pa.plan_item_id)))
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

comment on function public.sam_plan_item_progress(uuid, date, date) is 'SAM: THE single source of plan progress, used by both the app and Claude''s tools. Nothing else
counts passes. One row per plan item per Pacific day with at least one attempt.

MATCHING (changed 2026-11-06, migration 216): a pass MATCHES the item its sam_passes.plan_item_id names,
when that is an item of this plan, and no other item. A pass with no plan_item_id, or one naming an
item of another plan (practice before the plan was saved), falls back to the old rule: song_id is
equal and snippet_id is not distinct from the item''s (both null = whole song), so it counts for every
item of this plan on that range. ATTEMPT = a matching pass with notes_played > 0. QUALIFYING = an
attempt with effective_bpm >= target_effective_bpm and, unless free play, accuracy_percent >=
accuracy_target. Day = completed_at in America/Los_Angeles. Range capped at 31 days.

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
-- 4. sam_plan_unplanned_practice: planned means linked to an item of this plan, or on the range of one. Same
--    matching as section 3.
-- ============================================================================
create or replace function public.sam_plan_unplanned_practice(p_plan_id uuid, p_from date, p_to date)
    returns table(song_id uuid, snippet_id uuid, day date, attempts integer, best_accuracy integer,
                  best_effective_bpm integer)
    language plpgsql stable
    set search_path to 'public'
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
          -- s8: linked to an item of this plan, or on an item's range.
          and (i.id = pa.plan_item_id
               or (i.song_id = pa.song_id
                   and i.snippet_id is not distinct from pa.snippet_id))
     )
   group by 1, 2, 3
   order by 3, 1, 2;
end;
$$;

comment on function public.sam_plan_unplanned_practice(uuid, date, date) is 'SAM: attempts (notes_played > 0) per song, snippet and Pacific day that match NO item in the given
plan. Shows practice outside the plan, including snippets made on the fly. A pass is planned when its
plan_item_id names an item of this plan, or when it is on the song and range of one (migration 216;
the same matching as sam_plan_item_progress). Range capped at 31 days.';

revoke all on function public.sam_plan_unplanned_practice(uuid, date, date) from public, anon;
grant execute on function public.sam_plan_unplanned_practice(uuid, date, date) to authenticated, service_role;

commit;

-- ============================================================================
-- 5. Conformance: this is the result the SQL editor shows. Expect conformant true and failures [].
--    Then run supabase/tests/sam_cleanup-m4t/2_plan_item_positions_test.sql with --test.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
