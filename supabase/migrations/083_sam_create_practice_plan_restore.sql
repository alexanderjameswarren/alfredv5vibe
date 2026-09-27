-- Purpose: Restore sam_create_practice_plan. Migration 082 rewrote it from a partial reading and silently dropped six things, including the supersedes_plan_id link and the authentication check. This rebuilds it from 054's original text plus only the warm-up additions.
-- Kind: schema change (one function replaced)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.

-- ============================================================================
-- SAM Warm-up Ladder — fixing migration 082
-- supabase/migrations/083_sam_create_practice_plan_restore.sql
-- Supersedes supabase/migrations/082_sam_create_practice_plan_warmup.sql
-- Rebuilt from the function in supabase/migrations/054_sam_practice_plans.sql
--
-- WHAT WENT WRONG. 082 added the three warm-up columns to this function by
-- RETYPING it, from a reading that started part-way down the body. Six things
-- that were there in 054 were therefore missing from 082, and every one of them
-- has been live since 082 was applied:
--
--   1. `v_uid := auth.uid()` and the not-authenticated check.
--   2. The "plan must be a JSON object" check.
--   3. The "review_instructions is required" check.
--   4. The "songs must be a non-empty array" check.
--   5. `select id into v_prev_plan_id ... where user_id = v_uid and status = 'active'
--      FOR UPDATE` — the row lock, and the scoping of "the active plan" to the
--      caller. 082 superseded by a bare `where status = 'active'`.
--   6. `supersedes_plan_id` in the INSERT. This is the one Alex saw: the old plan
--      was correctly marked superseded, and the new plan had no link back to it.
--
-- The lesson, written down because the same mistake is easy to repeat: a function
-- must be rebuilt from its source text, not retyped from what was read of it. This
-- file was GENERATED from 054's text with three insertions applied to it, and it
-- asserts the presence of all six restored items before writing itself.
--
-- The warm-up behaviour 082 added is unchanged and is all still here: an item may
-- carry warmup_ladder, goal_is_warmup and consecutive; goal_is_warmup is refused
-- with is_free_play and refused when the range resolves to no ladder.
--
-- Run the whole file in one paste. CREATE OR REPLACE with an unchanged signature:
-- nothing to drop, no window where the function is missing.
--
-- AFTER RUNNING IT, see the last section for the supersedes_plan_id already-written
-- rows. Nothing here backfills them.
-- ============================================================================

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
  -- Warm-up ladder (milestone 4). v_resolved is what the item's ladder actually
  -- resolves to, which is only needed when goal_is_warmup is set.
  v_ladder       jsonb;
  v_goal_warmup  boolean;
  v_consecutive  boolean;
  v_resolved     jsonb;
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
        v_plan_id, v_plan_song_id, v_song_id, v_snippet_id, v_item_pos, v_free,
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

comment on function public.sam_create_practice_plan(jsonb) is
'SAM: the ONLY way to create a practice plan. Atomically supersedes the active plan and inserts
the plan, its songs and items, returning the new plan id. All-or-nothing validation: authenticated,
songs and snippets exist and are not archived, snippet belongs to its song, one item per range,
required targets, free play has no accuracy target, tempo rules (songs with audio: target_bpm =
default_bpm, target via speed; without audio: speed 100). Free play tempo defaults to the song''s
goal pair. At most 20 items. The new plan records supersedes_plan_id, so plan history is a chain and
not a set of unconnected rows.

WARM-UP LADDER (added 2026-09-27): an item may carry warmup_ladder, goal_is_warmup and consecutive.
The ladder''s SHAPE is checked by the table''s own constraint (sam_warmup_ladder_is_valid); this
function adds the two rules a constraint cannot express — goal_is_warmup is refused with
is_free_play, and refused when the item''s ladder RESOLVES to none (its own, then the snippet''s,
then the song''s, then sam_default_warmup_ladder()), since such an item could never be completed.
Omitting all three keeps the old behaviour exactly: null, false, false.

Input shape:
{ day_note, internal_notes, review_instructions,
  songs: [ { song_id, song_note, internal_notes,
             items: [ { snippet_id?, is_free_play?, target_bpm?, target_playback_speed?,
                        target_passes, accuracy_target?, instruction?,
                        warmup_ladder?, goal_is_warmup?, consecutive? } ] } ] }';

revoke all on function public.sam_create_practice_plan(jsonb) from public, anon;
grant execute on function public.sam_create_practice_plan(jsonb) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Conformance
-- ---------------------------------------------------------------------------
-- No table, column or policy changed. Expected: CONFORMANT, plus a table count.
select platform.check_conformance();
--   select public.platform_check_conformance();   -- if platform is not exposed


-- ---------------------------------------------------------------------------
-- Verification: the six restored items are in the deployed function
-- ---------------------------------------------------------------------------
-- Every value must be true. Read from pg_proc, so it checks what the DATABASE now
-- holds rather than what this file says.
select json_build_object(
  'has_auth_check',        p.prosrc like '%not authenticated%',
  'has_object_check',      p.prosrc like '%must be a JSON object%',
  'has_review_check',      p.prosrc like '%review_instructions is required%',
  'has_songs_check',       p.prosrc like '%songs must be a non-empty array%',
  'has_row_lock',          p.prosrc like '%for update%',
  'scopes_active_by_user', p.prosrc like '%user_id = v_uid and status = ''active''%',
  'writes_supersedes',     p.prosrc like '%insert into sam_practice_plans (supersedes_plan_id%',
  'writes_warmup_columns', p.prosrc like '%warmup_ladder, goal_is_warmup, consecutive%',
  'resolves_default',      p.prosrc like '%sam_default_warmup_ladder()%'
) as result
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'sam_create_practice_plan';


-- ---------------------------------------------------------------------------
-- The rows 082 already wrote wrong (READ-ONLY — this backfills nothing)
-- ---------------------------------------------------------------------------
-- HOW MANY PLANS ARE AFFECTED. Only plans created while 082 was live can be, and
-- only those that actually superseded something: the first plan a user ever made
-- has a null supersedes_plan_id legitimately, and so does any plan created when
-- nothing was active.
--
-- `would_be` is the plan each null-linked plan most likely superseded: the one, for
-- the same user, whose ended_at is at or just before this plan's created_at. With
-- one active plan per user at a time that is a tight inference, not a guess — but it
-- IS an inference, so read the list before deciding anything.
--
-- A BACKFILL IS SAFE ONLY WHERE would_be IS EXACTLY ONE ROW AND ITS ended_at IS
-- WITHIN SECONDS OF created_at. The function writes both in the same transaction,
-- so a real supersede shows a gap of milliseconds; anything wider is two unrelated
-- events and must be left alone. The UPDATE is written out at the end, commented,
-- for you to run per id if you choose to — the immutability trigger allows it,
-- since supersedes_plan_id is not one of the columns it guards.
select json_build_object(
  'plans_total', (select count(*) from sam_practice_plans),
  'null_link_total', (select count(*) from sam_practice_plans where supersedes_plan_id is null),
  'candidates', (select json_agg(t) from (
     select p.id,
            p.starts_on,
            p.created_at,
            (select json_agg(json_build_object('id', q.id, 'ended_at', q.ended_at,
                                               'gap_seconds', extract(epoch from (p.created_at - q.ended_at))))
               from sam_practice_plans q
              where q.user_id = p.user_id
                and q.id <> p.id
                and q.ended_at is not null
                and q.ended_at <= p.created_at
                and q.ended_at > p.created_at - interval '1 minute'
            ) as would_be
       from sam_practice_plans p
      where p.supersedes_plan_id is null
      order by p.created_at desc
  ) t)
) as result;

-- To link one plan, once you have read the list above and the gap is seconds:
--
-- update sam_practice_plans
--    set supersedes_plan_id = '<the would_be id>'
--  where id = '<the plan with the null>'
--    and supersedes_plan_id is null;
