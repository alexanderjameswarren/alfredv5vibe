-- Purpose: Drive Mix step 10, variant (c). The 1980s-and-earlier slice is exempt from the familiar/new split (p_familiar_slices_exempt); a familiar song may break the artist cooldown, never the artist cap, before a new song takes its slot (p_familiar_breaks_cooldown); new_over_cap now marks every new song past its natural slice's new share, carried songs included. The simulator gets the same rules and reports cooling_breaks.
-- Kind: schema change (function replacements with new signatures)
-- Applied: YES
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Spec: docs/technical-spec-drive_mix-v7r.md §4. Run as one block in the SQL editor.
-- Why: with 101 the new share ran at 47% in a 30-day simulation against a 25% cap.
-- Familiar songs were skipped mostly by the artist cap (~140 a day), then the
-- cooldown (~20) and the 7-day gap (~7), and the 1980s slice has 9 familiar songs
-- of 281. Diagnostic sims (2026-10-09): as 101 0.469; oldies exempt 0.313; plus
-- familiar breaks cooldown 0.246 (Alex's pick); oldies exempt plus gap 5 0.277.
-- Both functions gain parameters, so they are dropped and recreated. Both stay
-- SECURITY INVOKER and refuse with no signed-in user.
--
-- The recency query and the quota scaling each appear in both functions. Keep them identical.
-- supabase/migrations/102_drive_mix_oldies_exempt_familiar_breaks_cooldown.sql

begin;

-- ============================================================================
-- drive_mix_pick
-- ============================================================================
drop function if exists public.drive_mix_pick(date, int, int, jsonb, int, numeric, int, int, jsonb, jsonb, jsonb);

create function public.drive_mix_pick(
  p_date                     date    default current_date,
  p_count                    int     default 50,
  p_artist_cap               int     default null,
  p_quotas                   jsonb   default null,
  p_cooldown_days            int     default 2,
  p_new_share                numeric default 0.25,
  p_familiar_days            int     default 5,
  p_familiar_gap_days        int     default 7,
  p_familiar_slices_exempt   text[]  default '{1980s-and-earlier}',
  p_familiar_breaks_cooldown boolean default true,
  p_recency                  jsonb   default null,
  p_last_serving             jsonb   default null,
  p_play_days                jsonb   default null
)
returns table (
  "position"    int,
  song_id       uuid,
  video_id      text,
  title         text,
  artist        text,
  artist_key    text,
  slice         text,
  song_slice    text,
  carried       boolean,
  cooling       boolean,
  last_heard    date,
  distinct_days int,
  familiar      boolean,
  new_over_cap  boolean
)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  c_slices constant text[] := array['country_rap', '1980s-and-earlier', '2010s-2020s', '1990s-2000s'];
  c_shape  constant jsonb  := '{"country_rap": 6, "1980s-and-earlier": 10, "2010s-2020s": 12, "1990s-2000s": 22}';
  v_uid       uuid := auth.uid();
  v_exempt    text[] := coalesce(p_familiar_slices_exempt, '{}');
  v_rec       jsonb;           -- song_id -> last heard before p_date
  v_pdays     jsonb;           -- song_id -> distinct days heard before p_date
  v_raw       jsonb;
  v_q         jsonb;           -- effective quotas, summing to p_count
  v_nq        jsonb;           -- new-song share per slice, summing to v_new_cap
  v_new_cap   int;
  v_cap       int;
  v_ids       uuid[];
  v_keys      text[];
  v_slice     text[];
  v_last      date[];
  v_elig      boolean[];
  v_days      int[];
  v_fam       boolean[];
  v_n         int;
  v_taken     boolean[];
  v_carried   boolean[];
  v_cooled    boolean[];
  v_over      boolean[];
  v_from      text[];
  v_sel       int[] := '{}';
  v_ord       int[];
  v_ac        jsonb := '{}';   -- artist_key -> songs in today's list
  v_sc        jsonb := '{}';   -- slice -> songs in today's list
  v_sf        jsonb := '{}';   -- slice -> familiar songs in today's list
  v_nc        jsonb := '{}';   -- slice -> new songs counted for new_over_cap
  v_heard     jsonb;           -- artist_key -> last day any of its pool songs was heard
  v_cool      date;
  v_gap       date;            -- a familiar song heard after this is too recent
  v_serv_on   date;
  v_serv_ids  uuid[];
  v_s         text;
  v_quota     int;
  v_lim       int;
  v_pass      int;
  v_passes    int[];
  v_want_fam  boolean;
  v_is_cool   boolean;
  v_is_recent boolean;
  v_tmp       int;
  x           int;
  i           int;
  j           int;
  d           int;
begin
  if v_uid is null then
    raise exception 'drive_mix_pick: no signed-in user. Call it through get_drive_mix_pick, or in the SQL editor after "set local role authenticated" and request.jwt.claims.';
  end if;
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'drive_mix_pick: p_count must be between 1 and 200, got %', p_count;
  end if;
  if p_artist_cap is not null and p_artist_cap < 1 then
    raise exception 'drive_mix_pick: p_artist_cap must be at least 1, got %', p_artist_cap;
  end if;
  if p_cooldown_days is null or p_cooldown_days < 0 or p_cooldown_days > 30 then
    raise exception 'drive_mix_pick: p_cooldown_days must be between 0 and 30, got %', p_cooldown_days;
  end if;
  if p_new_share is null or p_new_share < 0 or p_new_share > 1 then
    raise exception 'drive_mix_pick: p_new_share must be between 0 and 1, got %', p_new_share;
  end if;
  if p_familiar_days is null or p_familiar_days < 1 or p_familiar_days > 365 then
    raise exception 'drive_mix_pick: p_familiar_days must be between 1 and 365, got %', p_familiar_days;
  end if;
  if p_familiar_gap_days is null or p_familiar_gap_days < 0 or p_familiar_gap_days > 60 then
    raise exception 'drive_mix_pick: p_familiar_gap_days must be between 0 and 60, got %', p_familiar_gap_days;
  end if;
  if not (v_exempt <@ c_slices) then
    raise exception 'drive_mix_pick: p_familiar_slices_exempt must name slices from %, got %', c_slices, v_exempt;
  end if;
  if p_familiar_breaks_cooldown is null then
    raise exception 'drive_mix_pick: p_familiar_breaks_cooldown must be true or false';
  end if;

  -- Quotas: proportions scaled to p_count by largest remainder (ties to the
  -- earlier slice). Counts that already sum to p_count come back unchanged.
  v_raw := coalesce(p_quotas, c_shape);
  if jsonb_typeof(v_raw) <> 'object' then
    raise exception 'drive_mix_pick: p_quotas must be a json object of slice -> share';
  end if;
  if exists (select 1 from jsonb_each_text(v_raw) q
             where q.key <> all (c_slices) or q.value !~ '^\d+(\.\d+)?$') then
    raise exception 'drive_mix_pick: p_quotas keys must be % with non-negative numbers, got %', c_slices, v_raw;
  end if;
  if coalesce((select sum(q.value::numeric) from jsonb_each_text(v_raw) q), 0) = 0 then
    raise exception 'drive_mix_pick: p_quotas must not all be zero, got %', v_raw;
  end if;
  with raw as (
    select u.k, u.o, coalesce((v_raw ->> u.k)::numeric, 0) as v
    from unnest(c_slices) with ordinality as u(k, o)
  ),
  fl as (
    select raw.k, raw.o,
           floor(raw.v * p_count / (select sum(r2.v) from raw r2))::int as f,
           raw.v * p_count / (select sum(r2.v) from raw r2)
             - floor(raw.v * p_count / (select sum(r2.v) from raw r2)) as rem
    from raw
  ),
  rk as (
    select fl.k, fl.f, row_number() over (order by fl.rem desc, fl.o) as rn,
           p_count - sum(fl.f) over () as spare
    from fl
  )
  select jsonb_object_agg(rk.k, rk.f + case when rk.rn <= rk.spare then 1 else 0 end)
    into v_q
  from rk;

  -- New-song cap, split by largest remainder over the slices that count new
  -- songs, in proportion to their quotas. Exempt slices get 0. At 50 with the
  -- 1980s exempt: 12 split 2 / 0 / 4 / 6.
  v_new_cap := floor(p_new_share * p_count)::int;
  with raw as (
    select u.k, u.o,
           case when u.k = any (v_exempt) then 0 else (v_q ->> u.k)::numeric end as v
    from unnest(c_slices) with ordinality as u(k, o)
  ),
  tot as (select nullif(sum(raw.v), 0) as t from raw),
  fl as (
    select raw.k, raw.o,
           coalesce(floor(raw.v * v_new_cap / tot.t), 0)::int as f,
           coalesce(raw.v * v_new_cap / tot.t - floor(raw.v * v_new_cap / tot.t), 0) as rem,
           raw.v
    from raw, tot
  ),
  rk as (
    select fl.k, fl.f, fl.v, row_number() over (order by fl.rem desc, fl.o) as rn,
           case when (select t from tot) is null then 0 else v_new_cap - sum(fl.f) over () end as spare
    from fl
  )
  select jsonb_object_agg(rk.k, rk.f + case when rk.rn <= rk.spare and rk.v > 0 then 1 else 0 end)
    into v_nq
  from rk;

  v_cap := coalesce(p_artist_cap, ceil(p_count / 25.0)::int);

  -- Recency and play days, once per call: last day and number of distinct days
  -- each pool song's canonical group was heard before p_date. One aggregate over
  -- dj_plays, not a subquery per song. The simulator passes its own maps instead.
  if p_recency is not null then
    v_rec   := p_recency;
    v_pdays := coalesce(p_play_days, '{}');
  else
    select coalesce(jsonb_object_agg(s.id::text, h.m), '{}'),
           coalesce(jsonb_object_agg(s.id::text, h.n), '{}')
      into v_rec, v_pdays
    from public.drive_mix_songs s
    join public.dj_tracks t0
      on t0.user_id = v_uid and t0.video_id = s.video_id
    join (select coalesce(t.canonical_track_id, t.id) as g,
                 max(p.played_on) as m,
                 count(distinct p.played_on)::int as n
          from public.dj_plays p
          join public.dj_tracks t on t.id = p.track_id
          where p.user_id = v_uid and t.user_id = v_uid and p.played_on < p_date
          group by 1) h
      on h.g = coalesce(t0.canonical_track_id, t0.id)
    where s.user_id = v_uid;
  end if;

  -- Every pool song, any status (a retired song's plays still cool its artist),
  -- oldest-heard first, never-heard before all. Only v_elig songs are picked;
  -- a thumbs down is never eligible. Familiar = heard on p_familiar_days days,
  -- thumbs up, or in an exempt slice.
  select array_agg(c.id         order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.artist_key order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.slice      order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.last_heard order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.elig       order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.days       order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.fam        order by c.last_heard asc nulls first, c.tiebreak)
    into v_ids, v_keys, v_slice, v_last, v_elig, v_days, v_fam
  from (
    select b.id, b.artist_key, b.elig, b.slice, b.last_heard, b.days, b.tiebreak,
           (b.up or b.days >= p_familiar_days or coalesce(b.slice = any (v_exempt), false)) as fam
    from (
      select s.id,
             s.artist_key,
             (s.status = 'active' and s.decade is not null and s.genre is not null
              and s.thumbs is distinct from 'down') as elig,
             case when s.genre in ('country', 'rap')   then 'country_rap'
                  when s.decade <= 1980                then '1980s-and-earlier'
                  when s.decade between 1990 and 2000 then '1990s-2000s'
                  when s.decade is not null            then '2010s-2020s'
             end as slice,
             (v_rec ->> s.id::text)::date as last_heard,
             coalesce((v_pdays ->> s.id::text)::int, 0) as days,
             coalesce(s.thumbs = 'up', false) as up,
             md5(p_date::text || ':' || s.id::text) as tiebreak
      from public.drive_mix_songs s
      where s.user_id = v_uid
    ) b
  ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    return;
  end if;

  -- Cooldown: an artist heard on any of the p_cooldown_days days before p_date.
  select coalesce(jsonb_object_agg(u.k, u.m), '{}')
    into v_heard
  from (select xx.k, max(xx.l) as m
        from unnest(v_keys, v_last) as xx(k, l)
        where xx.l is not null
        group by xx.k) u;
  v_cool := p_date - p_cooldown_days;
  v_gap  := p_date - p_familiar_gap_days;

  -- The most recent serving before p_date.
  if p_recency is not null then
    if p_last_serving is not null then
      v_serv_on := (p_last_serving ->> 'served_on')::date;
      select array_agg(e::uuid) into v_serv_ids
      from jsonb_array_elements_text(p_last_serving -> 'song_ids') e;
    end if;
  else
    select sv.served_on, array_agg(sv.song_id)
      into v_serv_on, v_serv_ids
    from public.drive_mix_servings sv
    where sv.user_id = v_uid
      and sv.served_on = (select max(s2.served_on) from public.drive_mix_servings s2
                          where s2.user_id = v_uid and s2.served_on < p_date)
    group by sv.served_on;
  end if;

  v_taken   := array_fill(false, array[v_n]);
  v_carried := array_fill(false, array[v_n]);
  v_cooled  := array_fill(false, array[v_n]);
  v_over    := array_fill(false, array[v_n]);
  v_from    := array_fill(null::text, array[v_n]);

  -- 1. Carry-over: served last time, still eligible, not heard since. Taken in
  -- recency order, so a carry-over larger than p_count keeps the least recently
  -- heard. Exempt from quotas, shares, the cap, the cooldown and the familiar
  -- gap, but counted in all of them.
  if v_serv_ids is not null then
    for i in 1 .. v_n loop
      exit when coalesce(array_length(v_sel, 1), 0) >= p_count;
      if v_elig[i] and v_ids[i] = any (v_serv_ids)
         and (v_last[i] is null or v_last[i] < v_serv_on) then
        v_taken[i]   := true;
        v_carried[i] := true;
        v_from[i]    := v_slice[i];
        v_sel        := v_sel || i;
        v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
        v_sc := v_sc || jsonb_build_object(v_slice[i], coalesce((v_sc ->> v_slice[i])::int, 0) + 1);
        if v_fam[i] then
          v_sf := v_sf || jsonb_build_object(v_slice[i], coalesce((v_sf ->> v_slice[i])::int, 0) + 1);
        end if;
      end if;
    end loop;
  end if;

  -- 2. Slices in spec order, each topped up to its quota (less what was carried),
  -- in recency order, under the cap, never past p_count. Passes per slice:
  --   1 familiar, not cooling, to the familiar share;
  --   5 familiar by cooling artists, to the familiar share (p_familiar_breaks_cooldown);
  --   2 new, not cooling, to the new share;
  --   3 more familiar, not cooling, if new ran short;
  --   4 more new, not cooling, if familiar ran short.
  -- A familiar song heard within p_familiar_gap_days is skipped throughout.
  v_passes := case when p_familiar_breaks_cooldown then array[1, 5, 2, 3, 4] else array[1, 2, 3, 4] end;
  foreach v_s in array c_slices loop
    v_quota := coalesce((v_q ->> v_s)::int, 0) - coalesce((v_sc ->> v_s)::int, 0);
    foreach v_pass in array v_passes loop
      v_want_fam := v_pass in (1, 3, 5);
      v_lim := case
                 when v_pass in (1, 5) then least(v_quota, (v_q ->> v_s)::int - (v_nq ->> v_s)::int
                                                  - coalesce((v_sf ->> v_s)::int, 0))
                 when v_pass = 2 then least(v_quota, (v_nq ->> v_s)::int
                                            - (coalesce((v_sc ->> v_s)::int, 0) - coalesce((v_sf ->> v_s)::int, 0)))
                 else v_quota
               end;
      i := 1;
      while v_lim > 0 and coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
        v_is_cool := p_cooldown_days > 0 and coalesce((v_heard ->> v_keys[i])::date >= v_cool, false);
        if v_elig[i] and v_slice[i] = v_s and not v_taken[i] and v_fam[i] = v_want_fam
           and coalesce((v_ac ->> v_keys[i])::int, 0) < v_cap
           and (v_pass = 5 or not v_is_cool)
           and not (v_fam[i] and p_familiar_gap_days > 0 and coalesce(v_last[i] > v_gap, false)) then
          v_taken[i]  := true;
          v_from[i]   := v_s;
          v_cooled[i] := v_is_cool;
          v_sel       := v_sel || i;
          v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
          v_sc := v_sc || jsonb_build_object(v_s, coalesce((v_sc ->> v_s)::int, 0) + 1);
          if v_fam[i] then
            v_sf := v_sf || jsonb_build_object(v_s, coalesce((v_sf ->> v_s)::int, 0) + 1);
          end if;
          v_lim   := v_lim - 1;
          v_quota := v_quota - 1;
        end if;
        i := i + 1;
      end loop;
    end loop;
  end loop;

  -- 3-4. Still short: any slice (slice = fill). Passes: 1 familiar, not
  -- cooling; 2 new, not cooling; 3 familiar by cooling artists; 4 new by cooling
  -- artists; 5 familiar songs inside the familiar gap. With
  -- p_familiar_breaks_cooldown, 3 runs before 2. The cap applies throughout.
  v_passes := case when p_familiar_breaks_cooldown then array[1, 3, 2, 4, 5] else array[1, 2, 3, 4, 5] end;
  foreach v_pass in array v_passes loop
    v_want_fam := v_pass in (1, 3, 5);
    i := 1;
    while coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
      v_is_cool   := p_cooldown_days > 0 and coalesce((v_heard ->> v_keys[i])::date >= v_cool, false);
      v_is_recent := v_fam[i] and p_familiar_gap_days > 0 and coalesce(v_last[i] > v_gap, false);
      if v_elig[i] and not v_taken[i] and v_fam[i] = v_want_fam
         and coalesce((v_ac ->> v_keys[i])::int, 0) < v_cap
         and (v_pass >= 3 or not v_is_cool)
         and (v_pass = 5 or not v_is_recent) then
        v_taken[i]  := true;
        v_from[i]   := 'fill';
        v_cooled[i] := v_is_cool;
        v_sel       := v_sel || i;
        v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
      end if;
      i := i + 1;
    end loop;
  end loop;

  if coalesce(array_length(v_sel, 1), 0) = 0 then
    return;
  end if;

  -- new_over_cap: every new song past its natural slice's new share, counted in
  -- selection order (carried songs first), whatever path chose it.
  foreach x in array v_sel loop
    if not v_fam[x] then
      v_nc := v_nc || jsonb_build_object(v_slice[x], coalesce((v_nc ->> v_slice[x])::int, 0) + 1);
      v_over[x] := (v_nc ->> v_slice[x])::int > coalesce((v_nq ->> v_slice[x])::int, 0);
    end if;
  end loop;

  -- Spread: songs are grouped by natural slice and familiar/new. Song r of a
  -- group of k aims at position (r - 0.5) * n / k, plus a seeded jitter of up
  -- to a quarter of the group's spacing either way, and the list is sorted by aim.
  -- So every slice, and its new songs, are spaced through the whole list.
  v_n := array_length(v_sel, 1);
  select array_agg(g.x order by g.aim, g.h)
    into v_ord
  from (
    select q.x, q.h,
           (q.rn - 0.5) * v_n / q.k + (q.frac - 0.5) * 0.5 * v_n / q.k as aim
    from (
      select u.x,
             md5(p_date::text || ':order:' || v_ids[u.x]::text) as h,
             row_number() over (partition by v_slice[u.x], v_fam[u.x]
                                order by md5(p_date::text || ':order:' || v_ids[u.x]::text)) as rn,
             count(*) over (partition by v_slice[u.x], v_fam[u.x]) as k,
             ('x' || substr(md5(p_date::text || ':jitter:' || v_ids[u.x]::text), 1, 8))::bit(32)::bigint
               / 4294967296.0 as frac
      from unnest(v_sel) as u(x)
    ) q
  ) g;

  -- Break up adjacent same-artist pairs by swapping with the nearest position
  -- that leaves both spots clean, so the spread survives. Out-of-range array
  -- reads are null, so the edge checks need no guards.
  for i in 2 .. v_n loop
    if v_keys[v_ord[i]] = v_keys[v_ord[i - 1]] then
      <<seek>>
      for d in 1 .. v_n loop
        foreach j in array array[i + d, i - d] loop
          continue when j < 1 or j > v_n or j = i - 1;
          v_tmp := v_ord[i]; v_ord[i] := v_ord[j]; v_ord[j] := v_tmp;
          if (i = 1    or v_keys[v_ord[i]] <> v_keys[v_ord[i - 1]])
             and (i = v_n or v_keys[v_ord[i]] <> v_keys[v_ord[i + 1]])
             and (j = 1    or v_keys[v_ord[j]] <> v_keys[v_ord[j - 1]])
             and (j = v_n or v_keys[v_ord[j]] <> v_keys[v_ord[j + 1]]) then
            exit seek;
          end if;
          v_tmp := v_ord[i]; v_ord[i] := v_ord[j]; v_ord[j] := v_tmp;
        end loop;
      end loop;
    end if;
  end loop;

  return query
  select u.pos::int, s.id, s.video_id, s.title, s.artist, s.artist_key,
         v_from[u.idx], v_slice[u.idx], v_carried[u.idx], v_cooled[u.idx], v_last[u.idx],
         v_days[u.idx], v_fam[u.idx], v_over[u.idx]
  from unnest(v_ord) with ordinality as u(idx, pos)
  join public.drive_mix_songs s on s.id = v_ids[u.idx]
  order by u.pos;
end;
$$;

comment on function public.drive_mix_pick(date, int, int, jsonb, int, numeric, int, int, text[], boolean, jsonb, jsonb, jsonb) is
  'DJ: choose the Drive Mix playlist for a date, any length from 1 to 200. Writes nothing; the same date and count give the same list while no new plays, servings or thumbs land. Needs a signed-in user. '
  'Quotas: p_quotas (default shape country_rap 6, 1980s-and-earlier 10, 2010s-2020s 12, 1990s-2000s 22) are proportions scaled to p_count by largest remainder. Artist cap: p_artist_cap, default ceil(p_count / 25). Thumbs down is never picked. '
  'Familiar = canonical group heard on at least p_familiar_days (5) distinct days, thumbs up, or in a p_familiar_slices_exempt slice (default 1980s-and-earlier); the rest are new. New songs fill at most floor(p_new_share (0.25) x p_count), split across the non-exempt slices like the quotas; within a slice familiar songs come first and each side backfills the other. new_over_cap marks every new song past its natural slice''s share, carried included. A familiar song heard in the last p_familiar_gap_days (7) days is skipped. '
  '1. Carry-over: songs in the most recent serving before p_date still eligible and not heard since go first (carried = true); they count everywhere but are never dropped. '
  '2. Slices in order country_rap, 1980s-and-earlier, 2010s-2020s, 1990s-2000s, in last-heard order. 3. Fill (slice = fill), familiar first. Artists heard in the p_cooldown_days days before p_date are skipped, except that with p_familiar_breaks_cooldown (default true) a familiar song by a cooling artist is taken before any new song (cooling = true); the cap is never broken. 4. Last resort: cooling artists, then familiar songs inside the gap. '
  'Order: each natural slice (song_slice) and familiar/new group is spaced evenly through the list with a seeded jitter; no adjacent same artist where a swap can avoid it. '
  'p_recency (song_id -> last heard), p_play_days (song_id -> distinct days) and p_last_serving ({served_on, song_ids}) are for drive_mix_simulate only: given, they replace dj_plays and drive_mix_servings.';

revoke all on function public.drive_mix_pick(date, int, int, jsonb, int, numeric, int, int, text[], boolean, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.drive_mix_pick(date, int, int, jsonb, int, numeric, int, int, text[], boolean, jsonb, jsonb, jsonb) to authenticated;

-- ============================================================================
-- drive_mix_simulate
-- ============================================================================
-- Each simulated day: pick with the in-memory state, mark the first
-- p_heard_per_day songs heard that day (recency, play days and the cooldown all
-- see it), and hand the whole list to the next day as its last serving, so the
-- unheard rest carries over exactly as it would in real use.
drop function if exists public.drive_mix_simulate(date, int, int, int, int, jsonb, int, numeric, int, int);

create function public.drive_mix_simulate(
  p_start                    date    default current_date,
  p_days                     int     default 60,
  p_heard_per_day            int     default null,
  p_count                    int     default 50,
  p_artist_cap               int     default null,
  p_quotas                   jsonb   default null,
  p_cooldown_days            int     default 2,
  p_new_share                numeric default 0.25,
  p_familiar_days            int     default 5,
  p_familiar_gap_days        int     default 7,
  p_familiar_slices_exempt   text[]  default '{1980s-and-earlier}',
  p_familiar_breaks_cooldown boolean default true
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  c_slices constant text[] := array['country_rap', '1980s-and-earlier', '2010s-2020s', '1990s-2000s'];
  c_shape  constant jsonb  := '{"country_rap": 6, "1980s-and-earlier": 10, "2010s-2020s": 12, "1990s-2000s": 22}';
  v_uid       uuid := auth.uid();
  v_raw       jsonb;
  v_q         jsonb;
  v_rec       jsonb;
  v_pdays     jsonb;
  v_ls        jsonb;
  v_today     jsonb;
  v_day       date;
  v_got       jsonb;
  v_total     int;
  v_cooling   int;
  v_new       int;
  v_over      int;
  v_carried   int := 0;
  v_cool_days jsonb := '[]';
  v_new_days  jsonb := '[]';
  v_short     jsonb := '[]';
  v_srv_day   date[] := '{}';
  v_srv_song  uuid[] := '{}';
  v_srv_heard boolean[] := '{}';
  v_srv_pos   int[] := '{}';
  v_srv_slice text[] := '{}';
  v_srv_fam   boolean[] := '{}';
  v_srv_cool  boolean[] := '{}';
  v_pool      int;
  v_result    jsonb;
  r           record;
  d           int;
begin
  if v_uid is null then
    raise exception 'drive_mix_simulate: no signed-in user. Call it through get_drive_mix_simulation, or in the SQL editor after "set local role authenticated" and request.jwt.claims.';
  end if;
  if p_days is null or p_days < 1 or p_days > 120 then
    raise exception 'drive_mix_simulate: p_days must be between 1 and 120, got %', p_days;
  end if;
  if p_heard_per_day is not null and p_heard_per_day < 0 then
    raise exception 'drive_mix_simulate: p_heard_per_day must be 0 or more, got %', p_heard_per_day;
  end if;
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'drive_mix_simulate: p_count must be between 1 and 200, got %', p_count;
  end if;

  -- Effective quotas, for the shortfall report. Same block as drive_mix_pick;
  -- invalid quotas are rejected by drive_mix_pick on day one.
  v_raw := coalesce(p_quotas, c_shape);
  with raw as (
    select u.k, u.o, coalesce((v_raw ->> u.k)::numeric, 0) as v
    from unnest(c_slices) with ordinality as u(k, o)
  ),
  fl as (
    select raw.k, raw.o,
           floor(raw.v * p_count / nullif((select sum(r2.v) from raw r2), 0))::int as f,
           raw.v * p_count / nullif((select sum(r2.v) from raw r2), 0)
             - floor(raw.v * p_count / nullif((select sum(r2.v) from raw r2), 0)) as rem
    from raw
  ),
  rk as (
    select fl.k, fl.f, row_number() over (order by fl.rem desc, fl.o) as rn,
           p_count - sum(fl.f) over () as spare
    from fl
  )
  select jsonb_object_agg(rk.k, rk.f + case when rk.rn <= rk.spare then 1 else 0 end)
    into v_q
  from rk;

  -- Real recency and play days before the start date for every pool song, once.
  -- Same query as drive_mix_pick; the loop below then advances both maps in memory.
  select coalesce(jsonb_object_agg(s.id::text, h.m), '{}'),
         coalesce(jsonb_object_agg(s.id::text, h.n), '{}')
    into v_rec, v_pdays
  from public.drive_mix_songs s
  join public.dj_tracks t0
    on t0.user_id = v_uid and t0.video_id = s.video_id
  join (select coalesce(t.canonical_track_id, t.id) as g,
               max(p.played_on) as m,
               count(distinct p.played_on)::int as n
        from public.dj_plays p
        join public.dj_tracks t on t.id = p.track_id
        where p.user_id = v_uid and t.user_id = v_uid and p.played_on < p_start
        group by 1) h
    on h.g = coalesce(t0.canonical_track_id, t0.id)
  where s.user_id = v_uid;

  -- The real last serving before the start date seeds the first day's carry-over.
  select jsonb_build_object('served_on', sv.served_on,
                            'song_ids', jsonb_agg(sv.song_id order by sv.position))
    into v_ls
  from public.drive_mix_servings sv
  where sv.user_id = v_uid
    and sv.served_on = (select max(s2.served_on) from public.drive_mix_servings s2
                        where s2.user_id = v_uid and s2.served_on < p_start)
  group by sv.served_on;

  for d in 0 .. p_days - 1 loop
    v_day     := p_start + d;
    v_got     := '{}';
    v_total   := 0;
    v_cooling := 0;
    v_new     := 0;
    v_over    := 0;
    v_today   := '[]';
    for r in select * from public.drive_mix_pick(
               p_date => v_day, p_count => p_count, p_artist_cap => p_artist_cap,
               p_quotas => p_quotas, p_cooldown_days => p_cooldown_days,
               p_new_share => p_new_share, p_familiar_days => p_familiar_days,
               p_familiar_gap_days => p_familiar_gap_days,
               p_familiar_slices_exempt => p_familiar_slices_exempt,
               p_familiar_breaks_cooldown => p_familiar_breaks_cooldown,
               p_recency => v_rec, p_last_serving => v_ls, p_play_days => v_pdays) loop
      v_srv_day   := v_srv_day || v_day;
      v_srv_song  := v_srv_song || r.song_id;
      v_srv_heard := v_srv_heard || (p_heard_per_day is null or r."position" <= p_heard_per_day);
      v_srv_pos   := v_srv_pos || r."position";
      v_srv_slice := v_srv_slice || r.song_slice;
      v_srv_fam   := v_srv_fam || r.familiar;
      v_srv_cool  := v_srv_cool || r.cooling;
      v_total     := v_total + 1;
      v_today     := v_today || to_jsonb(r.song_id::text);
      if r.carried then
        v_carried := v_carried + 1;
      end if;
      if r.cooling then
        v_cooling := v_cooling + 1;
      end if;
      if not r.familiar then
        v_new := v_new + 1;
      end if;
      if r.new_over_cap then
        v_over := v_over + 1;
      end if;
      v_got := v_got || jsonb_build_object(r.slice, coalesce((v_got ->> r.slice)::int, 0) + 1);
      if p_heard_per_day is null or r."position" <= p_heard_per_day then
        v_rec   := v_rec || jsonb_build_object(r.song_id::text, v_day);
        v_pdays := v_pdays || jsonb_build_object(r.song_id::text,
                                                 coalesce((v_pdays ->> r.song_id::text)::int, 0) + 1);
      end if;
    end loop;
    v_ls := jsonb_build_object('served_on', v_day, 'song_ids', v_today);

    v_new_days := v_new_days || jsonb_build_array(jsonb_build_object(
      'date', v_day, 'new', v_new, 'over_cap', v_over,
      'share', case when v_total > 0 then round(v_new::numeric / v_total, 2) end));

    if v_cooling > 0 then
      v_cool_days := v_cool_days || jsonb_build_array(jsonb_build_object('date', v_day, 'cooling_used', v_cooling));
    end if;

    select v_short || coalesce(jsonb_agg(jsonb_build_object(
             'date', v_day, 'slice', q.key, 'quota', q.value::int,
             'filled', coalesce((v_got ->> q.key)::int, 0))), '[]')
      into v_short
    from jsonb_each_text(v_q) q
    where coalesce((v_got ->> q.key)::int, 0) < q.value::int;

    if v_total < p_count then
      v_short := v_short || jsonb_build_array(jsonb_build_object(
        'date', v_day, 'slice', 'total', 'quota', p_count, 'filled', v_total));
    end if;
  end loop;

  select count(*) into v_pool
  from public.drive_mix_songs s
  where s.user_id = v_uid and s.status = 'active' and s.decade is not null and s.genre is not null
    and s.thumbs is distinct from 'down';

  with srv as (
    select u.day, u.song_id, u.heard, u.pos, u.slice, u.fam, u.cool
    from unnest(v_srv_day, v_srv_song, v_srv_heard, v_srv_pos, v_srv_slice, v_srv_fam, v_srv_cool)
           as u(day, song_id, heard, pos, slice, fam, cool)
  ),
  gaps as (
    select srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv
  ),
  heard_gaps as (
    select srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv where srv.heard
  ),
  fam_gaps as (
    select srv.slice, srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv where srv.fam
  ),
  per_slice as (
    select srv.slice,
           round(avg(srv.pos), 1) as avg_position,
           count(*) filter (where srv.fam)::int as familiar_served,
           count(*) filter (where not srv.fam)::int as new_served
    from srv group by srv.slice
  ),
  per_song as (
    select srv.song_id, count(*)::int as served, count(*) filter (where srv.heard)::int as heard
    from srv group by srv.song_id
  ),
  artist_days as (
    select s.artist_key, count(distinct srv.day)::int as days_appeared
    from srv join public.drive_mix_songs s on s.id = srv.song_id
    group by s.artist_key
  ),
  per_artist as (
    select s.artist_key,
           coalesce(sum(ps.served), 0)::int as served,
           count(*)::int as pool_songs,
           coalesce(max(ad.days_appeared), 0)::int as days_appeared
    from public.drive_mix_songs s
    left join per_song ps on ps.song_id = s.id
    left join artist_days ad on ad.artist_key = s.artist_key
    where s.user_id = v_uid and s.status = 'active' and s.decade is not null and s.genre is not null
      and s.thumbs is distinct from 'down'
    group by s.artist_key
  )
  select jsonb_build_object(
    'start', p_start,
    'days', p_days,
    'count', p_count,
    'artist_cap_used', coalesce(p_artist_cap, ceil(p_count / 25.0)::int),
    'cooldown_days', p_cooldown_days,
    'new_share', p_new_share,
    'familiar_days', p_familiar_days,
    'familiar_gap_days', p_familiar_gap_days,
    'familiar_slices_exempt', to_jsonb(coalesce(p_familiar_slices_exempt, '{}')),
    'familiar_breaks_cooldown', p_familiar_breaks_cooldown,
    'quotas_used', v_q,
    'heard_per_day', p_heard_per_day,
    'pool_eligible', v_pool,
    'expected_gap_days', round(v_pool::numeric / p_count, 1),
    'distinct_songs_served', (select count(*) from per_song),
    'distinct_songs_heard', (select count(*) from per_song where heard > 0),
    'carried_per_day_avg', round(v_carried::numeric / p_days, 1),
    'cooling_fills', jsonb_build_object(
                       'total', (select coalesce(sum((e ->> 'cooling_used')::int), 0)
                                 from jsonb_array_elements(v_cool_days) e),
                       'days', v_cool_days),
    'cooling_breaks', (select count(*) from srv where srv.fam and srv.cool),
    'new_songs', (select jsonb_build_object(
                    'cap_per_day', floor(p_new_share * p_count)::int,
                    'share_avg', round(avg((e ->> 'share')::numeric), 3),
                    'share_avg_from_day_2', round(avg((e ->> 'share')::numeric) filter (where o > 1), 3),
                    'share_min', min((e ->> 'share')::numeric),
                    'share_max', max((e ->> 'share')::numeric),
                    'over_cap_total', coalesce(sum((e ->> 'over_cap')::int), 0),
                    'days', v_new_days)
                  from jsonb_array_elements(v_new_days) with ordinality as w(e, o)),
    'slices', (select coalesce(jsonb_object_agg(ps.slice, jsonb_build_object(
                 'avg_position', ps.avg_position,
                 'familiar_served', ps.familiar_served,
                 'new_served', ps.new_served,
                 'familiar_min_repeat_gap', (select min(fg.gap) from fam_gaps fg where fg.slice = ps.slice)
               )), '{}')
               from per_slice ps),
    'ideal_avg_position', round((p_count + 1) / 2.0, 1),
    'repeat_gap', (select jsonb_build_object(
                     'min', min(g.gap),
                     'median', percentile_cont(0.5) within group (order by g.gap),
                     'repeats', count(g.gap))
                   from gaps g where g.gap is not null),
    'heard_gap', (select jsonb_build_object(
                    'min', min(g.gap),
                    'median', percentile_cont(0.5) within group (order by g.gap),
                    'repeats', count(g.gap))
                  from heard_gaps g where g.gap is not null),
    'songs', (select coalesce(jsonb_agg(jsonb_build_object(
                'song_id', ps.song_id, 'title', s.title, 'artist', s.artist,
                'served', ps.served, 'heard', ps.heard)
                order by ps.served desc, s.artist, s.title), '[]')
              from per_song ps join public.drive_mix_songs s on s.id = ps.song_id),
    'artists', (select coalesce(jsonb_agg(jsonb_build_object(
                  'artist_key', pa.artist_key, 'served', pa.served,
                  'days_appeared', pa.days_appeared, 'pool_songs', pa.pool_songs)
                  order by pa.days_appeared desc, pa.served desc, pa.artist_key), '[]')
                from per_artist pa),
    'shortfalls', v_short
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.drive_mix_simulate(date, int, int, int, int, jsonb, int, numeric, int, int, text[], boolean) is
  'DJ: run drive_mix_pick for p_days consecutive days (cap 120) from p_start without writing anything, through the same code path as a real pick, at any count from 1 to 200. Needs a signed-in user. '
  'Starts from real recency and play days (one aggregate) and the real last serving before p_start. Each day the first p_heard_per_day songs (null = all) count as heard that day, for recency, play days (so new songs become familiar) and the artist cooldown; the rest carry over. '
  'Returns one json object: quotas_used, artist_cap_used, new_songs (cap_per_day, share avg, avg from day 2, min, max, over_cap_total, per day), cooling_breaks (familiar songs served by a cooling artist), slices (per natural slice: avg_position against ideal_avg_position, familiar_served, new_served, familiar_min_repeat_gap), repeat_gap, heard_gap, carried_per_day_avg, cooling_fills, per-song served/heard, per-artist served, days_appeared and pool_songs, expected_gap_days, and shortfalls.';

revoke all on function public.drive_mix_simulate(date, int, int, int, int, jsonb, int, numeric, int, int, text[], boolean) from public, anon;
grant execute on function public.drive_mix_simulate(date, int, int, int, int, jsonb, int, numeric, int, int, text[], boolean) to authenticated;

commit;

-- After running: check_platform_conformance must report CONFORMANT.
