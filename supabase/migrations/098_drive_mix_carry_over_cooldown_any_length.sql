-- Purpose: Drive Mix step 7. drive_mix_pick gains carry-over (unheard songs from the last serving go first), a listening-driven artist cooldown (an artist heard in the last p_cooldown_days gets new songs only as a last resort), length independence (quotas scale to p_count, artist cap defaults to ceil(p_count / 25)) and new default quota shape 6/10/22/12. drive_mix_simulate models all of it and reports per-artist days_appeared and per-day cooling fills.
-- Kind: schema change (function replacements)
-- Applied: YES — confirmed 2026-10-08: CONFORMANT (51 tables); 60-day simulations and a 170-song pick checked
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Spec: docs/technical-spec-drive_mix-v7r.md §4. Run as one block in the SQL editor.
-- Dropped and recreated: the signatures change (new p_cooldown_days, p_last_serving,
-- `carried` and `cooling` output columns), and the old ones must not linger as overloads.
--
-- Quota scaling appears twice, in drive_mix_pick and drive_mix_simulate (which needs
-- the effective quotas to report shortfalls). Keep the two blocks identical.
-- supabase/migrations/098_drive_mix_carry_over_cooldown_any_length.sql

begin;

drop function if exists public.drive_mix_simulate(date, int, int, int, int, jsonb);
drop function if exists public.drive_mix_pick(date, int, int, jsonb, jsonb);

-- ============================================================================
-- drive_mix_pick
-- ============================================================================
-- One code path for real and simulated days. Real: recency from dj_plays, last
-- serving from drive_mix_servings. Simulated (p_recency given): both come from
-- the parameters, so the simulator exercises exactly this logic.
create function public.drive_mix_pick(
  p_date          date  default current_date,
  p_count         int   default 50,
  p_artist_cap    int   default null,
  p_quotas        jsonb default null,
  p_cooldown_days int   default 2,
  p_recency       jsonb default null,
  p_last_serving  jsonb default null
)
returns table (
  "position" int,
  song_id    uuid,
  video_id   text,
  title      text,
  artist     text,
  artist_key text,
  slice      text,
  carried    boolean,
  cooling    boolean,
  last_heard date
)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  c_slices constant text[] := array['country_rap', '1980s-and-earlier', '2010s-2020s', '1990s-2000s'];
  c_shape  constant jsonb  := '{"country_rap": 6, "1980s-and-earlier": 10, "2010s-2020s": 12, "1990s-2000s": 22}';
  v_raw      jsonb;
  v_q        jsonb;           -- effective quotas, summing to p_count
  v_cap      int;
  v_ids      uuid[];
  v_keys     text[];
  v_slice    text[];
  v_last     date[];
  v_elig     boolean[];
  v_n        int;
  v_taken    boolean[];
  v_carried  boolean[];
  v_cooled   boolean[];
  v_from     text[];
  v_sel      int[] := '{}';
  v_ord      int[];
  v_ac       jsonb := '{}';   -- artist_key -> songs in today's list
  v_sc       jsonb := '{}';   -- slice -> songs in today's list
  v_heard    jsonb;           -- artist_key -> last day any of its pool songs was heard
  v_cool     date;
  v_serv_on  date;
  v_serv_ids uuid[];
  v_s        text;
  v_quota    int;
  v_tmp      int;
  i          int;
  j          int;
begin
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'drive_mix_pick: p_count must be between 1 and 200, got %', p_count;
  end if;
  if p_artist_cap is not null and p_artist_cap < 1 then
    raise exception 'drive_mix_pick: p_artist_cap must be at least 1, got %', p_artist_cap;
  end if;
  if p_cooldown_days is null or p_cooldown_days < 0 or p_cooldown_days > 30 then
    raise exception 'drive_mix_pick: p_cooldown_days must be between 0 and 30, got %', p_cooldown_days;
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

  v_cap := coalesce(p_artist_cap, ceil(p_count / 25.0)::int);

  -- Every pool song, any status (a retired song's plays still cool its artist),
  -- oldest-heard first, never-heard before all. Only v_elig songs are picked.
  select array_agg(c.id         order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.artist_key order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.slice      order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.last_heard order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.elig       order by c.last_heard asc nulls first, c.tiebreak)
    into v_ids, v_keys, v_slice, v_last, v_elig
  from (
    select s.id,
           s.artist_key,
           (s.status = 'active' and s.decade is not null and s.genre is not null) as elig,
           case when s.genre in ('country', 'rap')   then 'country_rap'
                when s.decade <= 1980                then '1980s-and-earlier'
                when s.decade between 1990 and 2000 then '1990s-2000s'
                when s.decade is not null            then '2010s-2020s'
           end as slice,
           case when p_recency is not null then (p_recency ->> s.id::text)::date
                else (select max(p.played_on)
                      from public.dj_tracks t0
                      join public.dj_tracks t
                        on t.id = coalesce(t0.canonical_track_id, t0.id)
                        or t.canonical_track_id = coalesce(t0.canonical_track_id, t0.id)
                      join public.dj_plays p on p.track_id = t.id
                      where t0.user_id = s.user_id
                        and t0.video_id = s.video_id
                        and p.played_on < p_date)
           end as last_heard,
           md5(p_date::text || ':' || s.id::text) as tiebreak
    from public.drive_mix_songs s
  ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    return;
  end if;

  -- Cooldown: an artist heard on any of the p_cooldown_days days before p_date.
  select coalesce(jsonb_object_agg(u.k, u.m), '{}')
    into v_heard
  from (select x.k, max(x.l) as m
        from unnest(v_keys, v_last) as x(k, l)
        where x.l is not null
        group by x.k) u;
  v_cool := p_date - p_cooldown_days;

  -- The most recent serving before p_date.
  if p_recency is not null then
    if p_last_serving is not null then
      v_serv_on := (p_last_serving ->> 'served_on')::date;
      select array_agg(x::uuid) into v_serv_ids
      from jsonb_array_elements_text(p_last_serving -> 'song_ids') x;
    end if;
  else
    select sv.served_on, array_agg(sv.song_id)
      into v_serv_on, v_serv_ids
    from public.drive_mix_servings sv
    where sv.served_on = (select max(s2.served_on) from public.drive_mix_servings s2
                          where s2.served_on < p_date)
    group by sv.served_on;
  end if;

  v_taken   := array_fill(false, array[v_n]);
  v_carried := array_fill(false, array[v_n]);
  v_cooled  := array_fill(false, array[v_n]);
  v_from    := array_fill(null::text, array[v_n]);

  -- 1. Carry-over: served last time, still active, not heard since. Taken in
  -- recency order, so a carry-over larger than p_count keeps the least recently
  -- heard. Exempt from quotas, the cap and the cooldown, but counted in them.
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
      end if;
    end loop;
  end if;

  -- 2. Slices in spec order, each topped up to its quota (less what was carried),
  -- in recency order, under the cap, skipping cooling artists, never past p_count.
  foreach v_s in array c_slices loop
    v_quota := coalesce((v_q ->> v_s)::int, 0) - coalesce((v_sc ->> v_s)::int, 0);
    i := 1;
    while v_quota > 0 and coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
      if v_elig[i] and v_slice[i] = v_s and not v_taken[i]
         and coalesce((v_ac ->> v_keys[i])::int, 0) < v_cap
         and not (p_cooldown_days > 0 and coalesce((v_heard ->> v_keys[i])::date >= v_cool, false)) then
        v_taken[i] := true;
        v_from[i]  := v_s;
        v_sel      := v_sel || i;
        v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
        v_quota    := v_quota - 1;
      end if;
      i := i + 1;
    end loop;
  end loop;

  -- 3. Fill: when a slice runs short, any eligible song not cooling tops up the list.
  i := 1;
  while coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
    if v_elig[i] and not v_taken[i]
       and coalesce((v_ac ->> v_keys[i])::int, 0) < v_cap
       and not (p_cooldown_days > 0 and coalesce((v_heard ->> v_keys[i])::date >= v_cool, false)) then
      v_taken[i] := true;
      v_from[i]  := 'fill';
      v_sel      := v_sel || i;
      v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
    end if;
    i := i + 1;
  end loop;

  -- 4. Last resort: the cooldown is a preference. Still short, so take songs by
  -- cooling artists, same recency order and cap (cooling = true).
  i := 1;
  while coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
    if v_elig[i] and not v_taken[i]
       and coalesce((v_ac ->> v_keys[i])::int, 0) < v_cap then
      v_taken[i]  := true;
      v_cooled[i] := true;
      v_from[i]   := 'fill';
      v_sel       := v_sel || i;
      v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
    end if;
    i := i + 1;
  end loop;

  if coalesce(array_length(v_sel, 1), 0) = 0 then
    return;
  end if;

  -- Seeded shuffle, then break up adjacent same-artist pairs by swapping.
  -- Out-of-range array reads are null, so the edge checks need no guards.
  select array_agg(x order by md5(p_date::text || ':order:' || v_ids[x]::text))
    into v_ord
  from unnest(v_sel) as x;

  v_n := array_length(v_ord, 1);
  for i in 2 .. v_n loop
    if v_keys[v_ord[i]] = v_keys[v_ord[i - 1]] then
      for j in 1 .. v_n loop
        continue when j = i or j = i - 1;
        v_tmp := v_ord[i]; v_ord[i] := v_ord[j]; v_ord[j] := v_tmp;
        if (i = 1    or v_keys[v_ord[i]] <> v_keys[v_ord[i - 1]])
           and (i = v_n or v_keys[v_ord[i]] <> v_keys[v_ord[i + 1]])
           and (j = 1    or v_keys[v_ord[j]] <> v_keys[v_ord[j - 1]])
           and (j = v_n or v_keys[v_ord[j]] <> v_keys[v_ord[j + 1]]) then
          exit;
        end if;
        v_tmp := v_ord[i]; v_ord[i] := v_ord[j]; v_ord[j] := v_tmp;
      end loop;
    end if;
  end loop;

  return query
  select u.pos::int, s.id, s.video_id, s.title, s.artist, s.artist_key,
         v_from[u.idx], v_carried[u.idx], v_cooled[u.idx], v_last[u.idx]
  from unnest(v_ord) with ordinality as u(idx, pos)
  join public.drive_mix_songs s on s.id = v_ids[u.idx]
  order by u.pos;
end;
$$;

comment on function public.drive_mix_pick(date, int, int, jsonb, int, jsonb, jsonb) is
  'DJ: choose the Drive Mix playlist for a date, any length from 1 to 200. Writes nothing; the same date and count give the same list while no new plays or servings land. '
  'Quotas: p_quotas (default shape country_rap 6, 1980s-and-earlier 10, 2010s-2020s 12, 1990s-2000s 22) are proportions scaled to p_count by largest remainder; counts that already sum to p_count are used as given. Artist cap: p_artist_cap, default ceil(p_count / 25). '
  '1. Carry-over: songs in the most recent serving before p_date that are still active and not heard since it go first (carried = true), least recently heard first if they exceed p_count; they count toward their slice and the cap but are never dropped by either, and ignore the cooldown. '
  '2. Slices in order country_rap, 1980s-and-earlier, 2010s-2020s, 1990s-2000s, each topped up to its quota in last-heard order, never past p_count. 3. Fill (slice = fill). '
  'Steps 2-3 skip artists with any pool song heard in the p_cooldown_days days before p_date (0 = off). 4. Only if still short, songs by those cooling artists are used as a last resort (cooling = true). The cap applies throughout. '
  'Recency = last dj_plays day before p_date through video_id -> dj_tracks -> canonical group. No adjacent same artist where a swap can avoid it. '
  'p_recency (song_id -> last heard) and p_last_serving ({served_on, song_ids}) are for drive_mix_simulate only: given, they replace dj_plays and drive_mix_servings.';

revoke all on function public.drive_mix_pick(date, int, int, jsonb, int, jsonb, jsonb) from public, anon;
grant execute on function public.drive_mix_pick(date, int, int, jsonb, int, jsonb, jsonb) to authenticated;

-- ============================================================================
-- drive_mix_simulate
-- ============================================================================
-- Each simulated day: pick with the in-memory state, mark the first
-- p_heard_per_day songs heard that day (recency and cooldown both see it), and
-- hand the whole list to the next day as its last serving, so the unheard rest
-- carries over exactly as it would in real use.
create function public.drive_mix_simulate(
  p_start         date  default current_date,
  p_days          int   default 60,
  p_heard_per_day int   default null,
  p_count         int   default 50,
  p_artist_cap    int   default null,
  p_quotas        jsonb default null,
  p_cooldown_days int   default 2
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  c_slices constant text[] := array['country_rap', '1980s-and-earlier', '2010s-2020s', '1990s-2000s'];
  c_shape  constant jsonb  := '{"country_rap": 6, "1980s-and-earlier": 10, "2010s-2020s": 12, "1990s-2000s": 22}';
  v_raw       jsonb;
  v_q         jsonb;
  v_rec       jsonb;
  v_ls        jsonb;
  v_today     jsonb;
  v_day       date;
  v_got       jsonb;
  v_total     int;
  v_cooling   int;
  v_carried   int := 0;
  v_cool_days jsonb := '[]';
  v_short     jsonb := '[]';
  v_srv_day   date[] := '{}';
  v_srv_song  uuid[] := '{}';
  v_srv_heard boolean[] := '{}';
  v_pool      int;
  v_result    jsonb;
  r           record;
  d           int;
begin
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

  -- Real last-heard before the start date for every pool song (the cooldown reads
  -- all of them); same path as drive_mix_pick.
  select coalesce(jsonb_object_agg(x.id::text, x.last_heard), '{}')
    into v_rec
  from (
    select s.id,
           (select max(p.played_on)
            from public.dj_tracks t0
            join public.dj_tracks t
              on t.id = coalesce(t0.canonical_track_id, t0.id)
              or t.canonical_track_id = coalesce(t0.canonical_track_id, t0.id)
            join public.dj_plays p on p.track_id = t.id
            where t0.user_id = s.user_id
              and t0.video_id = s.video_id
              and p.played_on < p_start) as last_heard
    from public.drive_mix_songs s
  ) x
  where x.last_heard is not null;

  -- The real last serving before the start date seeds the first day's carry-over.
  select jsonb_build_object('served_on', sv.served_on,
                            'song_ids', jsonb_agg(sv.song_id order by sv.position))
    into v_ls
  from public.drive_mix_servings sv
  where sv.served_on = (select max(s2.served_on) from public.drive_mix_servings s2
                        where s2.served_on < p_start)
  group by sv.served_on;

  for d in 0 .. p_days - 1 loop
    v_day     := p_start + d;
    v_got     := '{}';
    v_total   := 0;
    v_cooling := 0;
    v_today   := '[]';
    for r in select * from public.drive_mix_pick(v_day, p_count, p_artist_cap, p_quotas,
                                                 p_cooldown_days, v_rec, v_ls) loop
      v_srv_day   := v_srv_day || v_day;
      v_srv_song  := v_srv_song || r.song_id;
      v_srv_heard := v_srv_heard || (p_heard_per_day is null or r."position" <= p_heard_per_day);
      v_total     := v_total + 1;
      v_today     := v_today || to_jsonb(r.song_id::text);
      if r.carried then
        v_carried := v_carried + 1;
      end if;
      if r.cooling then
        v_cooling := v_cooling + 1;
      end if;
      v_got := v_got || jsonb_build_object(r.slice, coalesce((v_got ->> r.slice)::int, 0) + 1);
      if p_heard_per_day is null or r."position" <= p_heard_per_day then
        v_rec := v_rec || jsonb_build_object(r.song_id::text, v_day);
      end if;
    end loop;
    v_ls := jsonb_build_object('served_on', v_day, 'song_ids', v_today);

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
  where s.status = 'active' and s.decade is not null and s.genre is not null;

  with srv as (
    select u.day, u.song_id, u.heard
    from unnest(v_srv_day, v_srv_song, v_srv_heard) as u(day, song_id, heard)
  ),
  gaps as (
    select srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv
  ),
  heard_gaps as (
    select srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv where srv.heard
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
    where s.status = 'active' and s.decade is not null and s.genre is not null
    group by s.artist_key
  )
  select jsonb_build_object(
    'start', p_start,
    'days', p_days,
    'count', p_count,
    'artist_cap_used', coalesce(p_artist_cap, ceil(p_count / 25.0)::int),
    'cooldown_days', p_cooldown_days,
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

comment on function public.drive_mix_simulate(date, int, int, int, int, jsonb, int) is
  'DJ: run drive_mix_pick for p_days consecutive days (cap 120) from p_start without writing anything, through the same code path as a real pick, at any count from 1 to 200. '
  'Starts from real recency and the real last serving before p_start. Each day the first p_heard_per_day songs (null = all) count as heard that day, for recency and the artist cooldown; the rest carry over to the next day. '
  'Returns one json object: quotas_used and artist_cap_used, repeat_gap (days between serves of a song), heard_gap (days between hearings), carried_per_day_avg, cooling_fills (last-resort cooling-artist songs, total and per day), per-song served/heard, per-artist served, days_appeared and pool_songs (most days first), expected_gap_days, and shortfalls.';

revoke all on function public.drive_mix_simulate(date, int, int, int, int, jsonb, int) from public, anon;
grant execute on function public.drive_mix_simulate(date, int, int, int, int, jsonb, int) to authenticated;

commit;

-- After running: check_platform_conformance must report CONFORMANT.
