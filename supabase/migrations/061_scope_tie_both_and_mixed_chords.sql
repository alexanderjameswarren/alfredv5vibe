-- 061 - How far does the scoreRender tie defect reach?
--
-- READ-ONLY DIAGNOSTIC. Nothing is created, changed or deleted. Run it in the
-- Supabase SQL editor and paste the single JSON result back.
--
-- Kind: read-only diagnostic (never "applied")
--
-- ============================================================================
-- WHY
-- ============================================================================
-- src/sam/lib/scoreRender.js decided whether a beat's notes must be struck
-- with `notes.every(n => n.tie === "end")`, per EVENT. Two shapes defeat it:
--
--   TIE "BOTH"    a middle link in a chain of three or more. Already sounding,
--                 but not "end", so the whole event was treated as struck and
--                 the app demanded a key for a note the score holds.
--
--   MIXED CHORD   one voice ties over while another re-articulates. `every`
--                 is false, so BOTH notes were demanded — including the tied
--                 one.
--
-- This query measures how much of the corpus is affected, which decides
-- whether the accuracy change on 2026-09-20 is a footnote or a comparability
-- break worth warning about in every tool description.
--
-- A note is a CONTINUATION when tie = 'end' or 'both': already sounding.
-- An event is MIXED when it holds at least one continuation AND at least one
-- freshly struck note (a note with no tie, or tie = 'start').
-- ============================================================================

with note_rows as (
  select
    m.song_id,
    m.number          as measure_number,
    hand.hand,
    ev.ord            as event_index,
    n->>'tie'         as tie,
    (n->>'midi')::int as midi
  from public.sam_song_measures m
  cross join lateral (values ('rh', m.rh), ('lh', m.lh)) as hand(hand, events)
  cross join lateral jsonb_array_elements(coalesce(hand.events, '[]'::jsonb))
       with ordinality as ev(event, ord)
  cross join lateral jsonb_array_elements(coalesce(ev.event->'notes', '[]'::jsonb)) as n
),
event_shape as (
  select
    song_id, measure_number, hand, event_index,
    count(*) filter (where tie in ('end', 'both'))            as continuations,
    count(*) filter (where tie is null or tie = 'start')      as struck,
    count(*) filter (where tie = 'both')                      as both_links,
    count(*)                                                  as notes_in_event
  from note_rows
  group by song_id, measure_number, hand, event_index
),
per_song as (
  select
    s.id as song_id,
    s.title,
    count(distinct e.measure_number)
      filter (where e.both_links > 0)                        as measures_with_tie_both,
    count(distinct e.measure_number)
      filter (where e.continuations > 0 and e.struck > 0)    as measures_with_mixed_chord,
    count(distinct e.measure_number)
      filter (where e.both_links > 0
                 or (e.continuations > 0 and e.struck > 0))  as measures_affected,
    count(distinct e.measure_number)                          as measures_total,
    count(*) filter (where e.both_links > 0)                 as events_with_tie_both,
    count(*) filter (where e.continuations > 0 and e.struck > 0) as events_with_mixed_chord,
    -- The control: events the OLD rule already handled correctly.
    count(*) filter (where e.continuations = e.notes_in_event
                       and e.both_links = 0)                 as events_all_tie_end
  from public.sam_songs s
  join event_shape e on e.song_id = s.id
  where s.archived = false
  group by s.id, s.title
)
select json_build_object(
  'per_song_affected', (select json_agg(t order by t.measures_affected desc) from (
    select title, measures_affected, measures_with_tie_both, measures_with_mixed_chord,
           measures_total,
           round(100.0 * measures_affected / nullif(measures_total, 0), 1) as percent_of_measures,
           events_with_tie_both, events_with_mixed_chord, events_all_tie_end
    from per_song
    where measures_affected > 0) t),

  'named_songs', (select json_agg(t order by t.title) from (
    select title, measures_affected, measures_with_tie_both, measures_with_mixed_chord,
           measures_total, events_with_tie_both, events_with_mixed_chord
    from per_song
    where title ilike '%Autumn Leaves%' or title ilike '%Pastorale%'
       or title ilike '%Arabesque%'     or title ilike '%Candeur%'
       or title ilike '%Fly Me To The Moon%') t),

  'corpus_totals', (select json_agg(t) from (
    select count(*)                                   as songs_with_any,
           sum(measures_affected)                     as measures_affected,
           sum(measures_with_tie_both)                as measures_with_tie_both,
           sum(measures_with_mixed_chord)             as measures_with_mixed_chord,
           sum(events_with_tie_both)                  as events_with_tie_both,
           sum(events_with_mixed_chord)               as events_with_mixed_chord
    from per_song where measures_affected > 0) t),

  'songs_clean', (select json_agg(t) from (
    select count(*) as songs_unaffected from per_song where measures_affected = 0) t),

  -- ==========================================================================
  -- WHAT IT COST IN SCORING. Beats already recorded at an affected event, so
  -- how many rows the old rule can have mis-scored. A MISS here is a note he
  -- was right not to play; a PARTIAL is a mixed chord where he played only the
  -- struck note, which is correct playing scored as incomplete.
  -- ==========================================================================
  'recorded_beats_at_affected_events', (select json_agg(t order by t.title) from (
    select sv.title,
           count(*)                                        as rows_total,
           count(*) filter (where ev.result = 'miss')      as misses,
           count(*) filter (where ev.result = 'partial')   as partials,
           count(*) filter (where ev.result = 'hit')       as hits,
           count(distinct ev.session_id)                   as sessions
    from public.sam_session_events ev
    join public.sam_songs sv on sv.id = ev.song_id
    where exists (
      select 1 from event_shape e
      where e.song_id = ev.song_id
        and e.measure_number = ev.measure_number
        and (e.both_links > 0 or (e.continuations > 0 and e.struck > 0))
    )
    group by sv.title
    having count(*) > 0) t),

  -- The same totals across everything, to size the accuracy shift: compare
  -- misses_at_affected against misses_everywhere.
  'accuracy_impact', (select json_agg(t) from (
    select
      count(*) filter (where ev.result = 'hit')     as hits_everywhere,
      count(*) filter (where ev.result = 'miss')    as misses_everywhere,
      count(*) filter (where ev.result = 'partial') as partials_everywhere,
      count(*) filter (where ev.result = 'miss' and aff.hit) as misses_at_affected,
      count(*) filter (where ev.result = 'partial' and aff.hit) as partials_at_affected
    from public.sam_session_events ev
    cross join lateral (
      select exists (
        select 1 from event_shape e
        where e.song_id = ev.song_id
          and e.measure_number = ev.measure_number
          and (e.both_links > 0 or (e.continuations > 0 and e.struck > 0))
      ) as hit
    ) aff) t)
) as result;
