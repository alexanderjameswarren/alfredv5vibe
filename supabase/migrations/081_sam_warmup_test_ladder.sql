-- Purpose: Put a warm-up ladder on one snippet by hand, so Milestone 2 can be tested at the piano before the editors exist.
-- Kind: one-off data write (one UPDATE), plus the read-only queries around it
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.

-- ============================================================================
-- A test ladder on a snippet
-- Warm-up ladder Milestone 2
-- supabase/migrations/081_sam_warmup_test_ladder.sql
--
-- WHY BY HAND. Nothing can write a ladder yet: the editors are milestone 3, the
-- tools are milestone 4, and a plan item cannot be given one after the fact
-- because plan items are immutable and sam_create_practice_plan takes no ladder
-- argument. A snippet is the one level that can be set with a plain UPDATE.
--
-- Run PART 1, pick a snippet, put its id in PART 2 and run that. PART 3 checks
-- what the app will resolve. PART 4 undoes it.
--
-- REQUIRES migration 080 (two rungs minimum) to have been run: the ladder below
-- has two rungs and would be valid either way, but a one-rung ladder would be
-- accepted without it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- PART 1 — Pick a snippet (read-only)
-- ---------------------------------------------------------------------------
-- Snippets on today's plan first, since those are the ones with a target tempo
-- from the item — which is what the rung percents are percentages of. A short
-- range is the point (§2: typically 1-5 bars).
select json_build_object(
  'snippets_on_todays_plan', (select json_agg(t) from (
     select sn.id               as snippet_id,
            g.title             as song,
            sn.title            as snippet,
            sn.start_measure, sn.end_measure, sn.rest_measures,
            sn.settings->>'handMode'     as hand_mode,
            i.target_effective_bpm       as item_target_bpm,
            i.accuracy_target,
            sn.warmup_ladder             as ladder_now
       from sam_practice_plan_items i
       join sam_snippets sn on sn.id = i.snippet_id
       join sam_songs g     on g.id = i.song_id
       join sam_practice_plans p on p.id = i.plan_id and p.status = 'active'
      order by i.position
  ) t),
  'other_recent_short_snippets', (select json_agg(t) from (
     select sn.id as snippet_id, g.title as song, sn.title as snippet,
            sn.start_measure, sn.end_measure, sn.warmup_ladder as ladder_now
       from sam_snippets sn
       join sam_songs g on g.id = sn.song_id
      where not sn.archived
        and sn.end_measure - sn.start_measure <= 4
      order by sn.created_at desc
      limit 15
  ) t)
) as result;


-- ---------------------------------------------------------------------------
-- PART 2 — Set the ladder (the one write in this file)
-- ---------------------------------------------------------------------------
-- 70% then 100%, two consecutive passes each, accuracy inherited from the plan
-- item (85% off plan). Deliberately the smallest ladder that is still a ladder,
-- so a full run is four good passes: two slow, two at target.
--
-- REPLACE the id below with one from PART 1.
update sam_snippets
   set warmup_ladder = '[
         {"target_percent": 70,  "accuracy_target": null, "target_passes": 2, "consecutive": true},
         {"target_percent": 100, "accuracy_target": null, "target_passes": 2, "consecutive": true}
       ]'::jsonb
 where id = '00000000-0000-0000-0000-000000000000';   -- <<< PUT THE SNIPPET ID HERE

-- A harder variant, if the two-rung one turns out too easy to be interesting:
-- three rungs, the top one cumulative and stricter.
--
-- update sam_snippets
--    set warmup_ladder = '[
--          {"target_percent": 50,  "accuracy_target": 100, "target_passes": 2, "consecutive": true},
--          {"target_percent": 70,  "accuracy_target": 95,  "target_passes": 2, "consecutive": true},
--          {"target_percent": 100, "accuracy_target": 95,  "target_passes": 3, "consecutive": false}
--        ]'::jsonb
--  where id = '00000000-0000-0000-0000-000000000000';


-- ---------------------------------------------------------------------------
-- PART 3 — What the app will do with it (read-only)
-- ---------------------------------------------------------------------------
-- The resolved ladder is what the player will run, and the rung tempos are what
-- the tempo box will show. If `resolved_source` is not 'snippet', something at a
-- higher level is overriding it.
select json_build_object(
  'resolved_for_each_plan_item', (select json_agg(t) from (
     select g.title as song,
            sn.title as snippet,
            i.target_effective_bpm as target_bpm,
            sam_resolve_warmup_ladder(i.song_id, i.snippet_id, i.id) as resolved_ladder,
            case
              when i.warmup_ladder  is not null then 'plan item'
              when sn.warmup_ladder is not null then 'snippet'
              when g.warmup_ladder  is not null then 'song'
              else 'default'
            end as resolved_source,
            -- The tempo each rung will put in the box: round(target * pct / 100),
            -- floored at 20 (§4). On a song WITH audio the box reaches this
            -- through the speed percent instead, with BPM pinned to default_bpm.
            (select json_agg(greatest(20, round(i.target_effective_bpm * (r->>'target_percent')::numeric / 100)) order by (r->>'target_percent')::int)
               from jsonb_array_elements(sam_resolve_warmup_ladder(i.song_id, i.snippet_id, i.id)) r
            ) as rung_bpms
       from sam_practice_plan_items i
       join sam_songs g on g.id = i.song_id
       left join sam_snippets sn on sn.id = i.snippet_id
       join sam_practice_plans p on p.id = i.plan_id and p.status = 'active'
      order by i.position
  ) t),
  'ladders_now_stored', (select json_agg(t) from (
     select 'snippet' as level, id, warmup_ladder from sam_snippets where warmup_ladder is not null
     union all
     select 'song', id, warmup_ladder from sam_songs where warmup_ladder is not null
     union all
     select 'plan item', id, warmup_ladder from sam_practice_plan_items where warmup_ladder is not null
  ) t)
) as result;


-- ---------------------------------------------------------------------------
-- PART 4 — After the passes are in: what got recorded, and what it counts as
-- ---------------------------------------------------------------------------
-- The rung columns on today's passes, newest first, and the progress function's
-- own answer for the same day. `warmup_rung` null is an ordinary pass.
select json_build_object(
  'todays_passes', (select json_agg(t) from (
     select pa.completed_at,
            g.title as song,
            sn.title as snippet,
            pa.session_id,
            pa.effective_bpm,
            pa.accuracy_percent,
            pa.notes_played,
            pa.warmup_rung,
            pa.warmup_target_percent
       from sam_passes pa
       join sam_songs g on g.id = pa.song_id
       left join sam_snippets sn on sn.id = pa.snippet_id
      where (pa.completed_at at time zone 'America/Los_Angeles')::date
            = (now() at time zone 'America/Los_Angeles')::date
      order by pa.completed_at desc
      limit 40
  ) t),
  'progress_today', (select json_agg(t) from (
     select * from sam_plan_item_progress(
       (select id from sam_practice_plans where status = 'active'),
       (now() at time zone 'America/Los_Angeles')::date,
       (now() at time zone 'America/Los_Angeles')::date
     )
  ) t)
) as result;


-- ---------------------------------------------------------------------------
-- PART 5 — Undo
-- ---------------------------------------------------------------------------
-- Back to inheriting (null), which for a snippet means fall through to the song
-- and then the app default. To say "no warm-up on this passage" instead, set
-- '[]'::jsonb — that stops the chain rather than falling through.
--
-- update sam_snippets set warmup_ladder = null
--  where id = '00000000-0000-0000-0000-000000000000';
