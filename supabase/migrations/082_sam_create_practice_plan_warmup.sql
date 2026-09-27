-- Purpose: Teach sam_create_practice_plan the three warm-up item columns, so a plan can be created with an item ladder, a warm-up goal, or consecutive counting.
-- Kind: schema change (one function replaced)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.

-- ============================================================================
-- SAM Warm-up Ladder — Milestone 4, the one SQL change
-- supabase/migrations/082_sam_create_practice_plan_warmup.sql
-- Spec: docs/technical-spec-sam-warmup-ladder.md §5.2, §5.3, §8
-- Replaces the function from supabase/migrations/054_sam_practice_plans.sql
--
-- WHY A MIGRATION AT ALL. `create_sam_practice_plan` writes nothing itself: it
-- hands the whole plan to this function, which inserts items with an EXPLICIT
-- column list. Three columns have existed on sam_practice_plan_items since 078
-- and this function has never written them, so until now there was no way to
-- create an item with a ladder — which is exactly why the read-only item block in
-- the app's ladder dialog has never been reachable.
--
-- Nothing changes for a plan that passes none of the three: they default to null,
-- false and false, as they did before.
--
-- Run the whole file in one paste. It is a CREATE OR REPLACE of one function with
-- an unchanged signature, so there is nothing to drop and no window where the
-- function is missing.
-- ============================================================================

create or replace function public.sam_create_practice_plan(p_plan jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_plan_id       uuid;
  v_song_json     jsonb;
  v_item          jsonb;
  v_song_id       uuid;
  v_plan_song_id  uuid;
  v_snippet_id    uuid;
  v_song          record;
  v_snippet       record;
  v_song_pos      smallint := 0;
  v_item_pos      smallint := 0;
  v_free          boolean;
  v_bpm           integer;
  v_speed         integer;
  v_passes        smallint;
  v_accuracy      smallint;
  v_has_audio     boolean;
  -- Milestone 4: the three warm-up columns, plus what the item's ladder resolves
  -- to when it has none of its own.
  v_ladder        jsonb;
  v_goal_warmup   boolean;
  v_consecutive   boolean;
  v_resolved      jsonb;
begin
  -- Supersede the active plan, if there is one.
  update sam_practice_plans
     set status = 'superseded', ended_at = now()
   where status = 'active';

  insert into sam_practice_plans (day_note, internal_notes, review_instructions)
  values (
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
      v_item_pos    := v_item_pos + 1;
      v_snippet_id  := nullif(v_item->>'snippet_id', '')::uuid;
      v_free        := coalesce((v_item->>'is_free_play')::boolean, false);
      v_bpm         := (v_item->>'target_bpm')::integer;
      v_speed       := (v_item->>'target_playback_speed')::integer;
      v_passes      := (v_item->>'target_passes')::integer;
      v_accuracy    := (v_item->>'accuracy_target')::integer;
      -- A ladder is absent (inherit) or present; jsonb null is treated as absent,
      -- so "warmup_ladder": null means the same as omitting it.
      v_ladder      := case when jsonb_typeof(v_item->'warmup_ladder') in ('array')
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
      -- Warm-up checks (§5.2). The table's own constraints enforce the ladder's
      -- SHAPE and the free-play conflict; these two produce a sentence that names
      -- the item instead of a constraint name, and the resolved-empty rule cannot
      -- be a constraint at all because it spans three tables.
      -- ---------------------------------------------------------------------
      if v_goal_warmup and v_free then
        raise exception 'sam_create_practice_plan: item % (song "%"): goal_is_warmup cannot be combined with is_free_play — a warm-up item needs an accuracy_target and free play forbids one.',
          v_item_pos, v_song.title;
      end if;

      if v_goal_warmup then
        -- The ladder this item will ACTUALLY run, by the same order the player
        -- uses: the item's own, then the snippet's, then the song's, then the app
        -- default. Resolved here rather than trusted, because an item whose ladder
        -- resolves to [] could never be completed and so could never be done.
        v_resolved := coalesce(
          v_ladder,
          case when v_snippet_id is not null then v_snippet.warmup_ladder else null end,
          v_song.warmup_ladder,
          sam_default_warmup_ladder()
        );
        if jsonb_typeof(v_resolved) <> 'array' or jsonb_array_length(v_resolved) = 0 then
          raise exception 'sam_create_practice_plan: item % (song "%"): goal_is_warmup needs a ladder, but this range resolves to none — its own is unset, and the level below it says "no warm-up here". Give the item a warmup_ladder.',
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
the plan, its songs and items, returning the new plan id. All-or-nothing validation: songs and
snippets exist and are not archived, snippet belongs to its song, one item per range, required
targets, free play has no accuracy target, tempo rules (songs with audio: target_bpm =
default_bpm, target via speed; without audio: speed 100). Free play tempo defaults to the song''s
goal pair. At most 20 items.

WARM-UP LADDER (added 2026-09-27): an item may carry warmup_ladder, goal_is_warmup and
consecutive. The ladder''s SHAPE is checked by the table''s own constraint
(sam_warmup_ladder_is_valid); this function adds the two rules a constraint cannot express —
goal_is_warmup is refused with is_free_play, and refused when the item''s ladder RESOLVES to none
(its own, then the snippet''s, then the song''s, then sam_default_warmup_ladder()), since such an
item could never be completed. Omitting all three keeps the old behaviour exactly: null, false,
false.

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
-- If the platform schema is not exposed to your session, the public wrapper is
-- equivalent:
--   select public.platform_check_conformance();


-- ---------------------------------------------------------------------------
-- Verification (read-only, after the function is replaced)
-- ---------------------------------------------------------------------------
-- The three arguments are optional, so an existing-shaped plan must still be
-- accepted unchanged. This does not create anything: it only checks that the
-- function's own comment now documents the new keys, and that the columns it
-- writes exist.
select json_build_object(
  'function_comment_mentions_warmup', (
    select obj_description('public.sam_create_practice_plan(jsonb)'::regprocedure, 'pg_proc')
           like '%WARM-UP LADDER%'
  ),
  'item_columns_present', (select json_agg(t) from (
     select column_name, data_type, column_default, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = 'sam_practice_plan_items'
        and column_name in ('warmup_ladder', 'goal_is_warmup', 'consecutive')
      order by column_name
  ) t),
  'default_ladder_still_there', public.sam_default_warmup_ladder()
) as result;
