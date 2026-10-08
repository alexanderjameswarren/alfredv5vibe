-- Purpose: Drive Mix step 6. The oldest slice becomes "1980s-and-earlier": every tagged song with decade <= 1980 (1950s and earlier included) counts in it, so no tagged song is fill-only any more. Replaces drive_mix_pick and drive_mix_simulate (new slice key and default quotas) and updates the decade comment.
-- Kind: schema change (function replacements, one comment)
-- Applied: YES — confirmed 2026-10-08: CONFORMANT (51 tables); today's pick 8/27/10/5 across the four slices
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Spec: docs/technical-spec-drive_mix-v7r.md §2, §4. Run as one block in the SQL editor.
-- Quotas unchanged: country_rap 5, 1980s-and-earlier 8, 2010s-2020s 10, 1990s-2000s 27.
-- Dropped and recreated rather than replaced, because the parameter defaults change.
-- supabase/migrations/097_drive_mix_slice_1980s_and_earlier.sql

begin;

drop function if exists public.drive_mix_simulate(date, int, int, int, int, jsonb);
drop function if exists public.drive_mix_pick(date, int, int, jsonb, jsonb);

comment on column public.drive_mix_songs.decade is
  '1950, 1960 ... 2020. Null until tagged. Slices: 1980 and earlier -> 1980s-and-earlier; 1990, 2000 -> 1990s-2000s; 2010 and later -> 2010s-2020s; genre country or rap overrides the decade.';

-- ============================================================================
-- drive_mix_pick
-- ============================================================================
create function public.drive_mix_pick(
  p_date       date  default current_date,
  p_count      int   default 50,
  p_artist_cap int   default 2,
  p_quotas     jsonb default '{"country_rap": 5, "1980s-and-earlier": 8, "2010s-2020s": 10, "1990s-2000s": 27}',
  p_recency    jsonb default null
)
returns table (
  "position" int,
  song_id    uuid,
  video_id   text,
  title      text,
  artist     text,
  artist_key text,
  slice      text,
  last_heard date
)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  c_slices constant text[] := array['country_rap', '1980s-and-earlier', '2010s-2020s', '1990s-2000s'];
  v_ids   uuid[];
  v_keys  text[];
  v_slice text[];
  v_last  date[];
  v_n     int;
  v_taken boolean[];
  v_from  text[];
  v_sel   int[] := '{}';
  v_ord   int[];
  v_ac    jsonb := '{}';
  v_s     text;
  v_quota int;
  v_got   int;
  v_tmp   int;
  i       int;
  j       int;
begin
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'drive_mix_pick: p_count must be between 1 and 200, got %', p_count;
  end if;
  if p_artist_cap is null or p_artist_cap < 1 then
    raise exception 'drive_mix_pick: p_artist_cap must be at least 1, got %', p_artist_cap;
  end if;
  if p_quotas is null or jsonb_typeof(p_quotas) <> 'object' then
    raise exception 'drive_mix_pick: p_quotas must be a json object of slice -> song count';
  end if;
  if exists (select 1 from jsonb_each_text(p_quotas) q
             where q.key <> all (c_slices) or q.value !~ '^\d+$') then
    raise exception 'drive_mix_pick: p_quotas keys must be % with whole-number counts, got %', c_slices, p_quotas;
  end if;
  if (select sum(q.value::int) from jsonb_each_text(p_quotas) q) > p_count then
    raise exception 'drive_mix_pick: p_quotas add up to more than p_count (%)', p_count;
  end if;

  -- Eligible songs, oldest-heard first, never-heard before all.
  select array_agg(c.id         order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.artist_key order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.slice      order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.last_heard order by c.last_heard asc nulls first, c.tiebreak)
    into v_ids, v_keys, v_slice, v_last
  from (
    select s.id,
           s.artist_key,
           case when s.genre in ('country', 'rap')   then 'country_rap'
                when s.decade <= 1980                then '1980s-and-earlier'
                when s.decade between 1990 and 2000 then '1990s-2000s'
                else                                      '2010s-2020s'
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
    where s.status = 'active'
      and s.decade is not null
      and s.genre is not null
  ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    return;
  end if;

  v_taken := array_fill(false, array[v_n]);
  v_from  := array_fill(null::text, array[v_n]);

  -- Slices in spec order, each in recency order, under the artist cap.
  foreach v_s in array c_slices loop
    v_quota := coalesce((p_quotas ->> v_s)::int, 0);
    v_got := 0;
    i := 1;
    while v_got < v_quota and i <= v_n loop
      if v_slice[i] = v_s and not v_taken[i]
         and coalesce((v_ac ->> v_keys[i])::int, 0) < p_artist_cap then
        v_taken[i] := true;
        v_from[i]  := v_s;
        v_sel      := v_sel || i;
        v_ac       := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
        v_got      := v_got + 1;
      end if;
      i := i + 1;
    end loop;
  end loop;

  -- Fill: when a slice runs short, any eligible song tops up the list.
  i := 1;
  while coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
    if not v_taken[i] and coalesce((v_ac ->> v_keys[i])::int, 0) < p_artist_cap then
      v_taken[i] := true;
      v_from[i]  := 'fill';
      v_sel      := v_sel || i;
      v_ac       := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
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
  select u.pos::int, s.id, s.video_id, s.title, s.artist, s.artist_key, v_from[u.idx], v_last[u.idx]
  from unnest(v_ord) with ordinality as u(idx, pos)
  join public.drive_mix_songs s on s.id = v_ids[u.idx]
  order by u.pos;
end;
$$;

comment on function public.drive_mix_pick(date, int, int, jsonb, jsonb) is
  'DJ: choose the Drive Mix playlist for a date. Writes nothing; the same date gives the same list while no new plays land. '
  'Recency = last dj_plays day before p_date, through video_id -> dj_tracks -> canonical group; never-heard first. '
  'Fills slices in order country_rap, 1980s-and-earlier (decade <= 1980), 2010s-2020s, 1990s-2000s (p_quotas = song counts, sum <= p_count), then tops up from any eligible song (slice = fill) when a slice runs short, at most p_artist_cap songs per artist_key, no adjacent same artist where a swap can avoid it. '
  'p_recency is for drive_mix_simulate only: a song_id -> last-heard-date map that replaces the dj_plays lookup.';

revoke all on function public.drive_mix_pick(date, int, int, jsonb, jsonb) from public, anon;
grant execute on function public.drive_mix_pick(date, int, int, jsonb, jsonb) to authenticated;

-- ============================================================================
-- drive_mix_simulate — unchanged apart from the default quotas' slice key
-- ============================================================================
create function public.drive_mix_simulate(
  p_start         date  default current_date,
  p_days          int   default 60,
  p_heard_per_day int   default null,
  p_count         int   default 50,
  p_artist_cap    int   default 2,
  p_quotas        jsonb default '{"country_rap": 5, "1980s-and-earlier": 8, "2010s-2020s": 10, "1990s-2000s": 27}'
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_rec      jsonb;
  v_day      date;
  v_got      jsonb;
  v_total    int;
  v_short    jsonb := '[]';
  v_srv_day  date[] := '{}';
  v_srv_song uuid[] := '{}';
  v_pool     int;
  v_result   jsonb;
  r          record;
  d          int;
begin
  if p_days is null or p_days < 1 or p_days > 120 then
    raise exception 'drive_mix_simulate: p_days must be between 1 and 120, got %', p_days;
  end if;
  if p_heard_per_day is not null and p_heard_per_day < 0 then
    raise exception 'drive_mix_simulate: p_heard_per_day must be 0 or more, got %', p_heard_per_day;
  end if;

  -- Real last-heard before the start date; same path as drive_mix_pick.
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
    where s.status = 'active' and s.decade is not null and s.genre is not null
  ) x
  where x.last_heard is not null;

  for d in 0 .. p_days - 1 loop
    v_day   := p_start + d;
    v_got   := '{}';
    v_total := 0;
    for r in select * from public.drive_mix_pick(v_day, p_count, p_artist_cap, p_quotas, v_rec) loop
      v_srv_day  := v_srv_day || v_day;
      v_srv_song := v_srv_song || r.song_id;
      v_total    := v_total + 1;
      v_got      := v_got || jsonb_build_object(r.slice, coalesce((v_got ->> r.slice)::int, 0) + 1);
      if p_heard_per_day is null or r."position" <= p_heard_per_day then
        v_rec := v_rec || jsonb_build_object(r.song_id::text, v_day);
      end if;
    end loop;

    select v_short || coalesce(jsonb_agg(jsonb_build_object(
             'date', v_day, 'slice', q.key, 'quota', q.value::int,
             'filled', coalesce((v_got ->> q.key)::int, 0))), '[]')
      into v_short
    from jsonb_each_text(p_quotas) q
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
    select u.day, u.song_id
    from unnest(v_srv_day, v_srv_song) as u(day, song_id)
  ),
  gaps as (
    select srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv
  ),
  per_song as (
    select srv.song_id, count(*)::int as served
    from srv group by srv.song_id
  ),
  per_artist as (
    select s.artist_key,
           coalesce(sum(ps.served), 0)::int as served,
           count(*)::int as pool_songs
    from public.drive_mix_songs s
    left join per_song ps on ps.song_id = s.id
    where s.status = 'active' and s.decade is not null and s.genre is not null
    group by s.artist_key
  )
  select jsonb_build_object(
    'start', p_start,
    'days', p_days,
    'count', p_count,
    'artist_cap', p_artist_cap,
    'quotas', p_quotas,
    'heard_per_day', p_heard_per_day,
    'pool_eligible', v_pool,
    'expected_gap_days', case when p_count > 0 then round(v_pool::numeric / p_count, 1) end,
    'distinct_songs_served', (select count(*) from per_song),
    'repeat_gap', (select jsonb_build_object(
                     'min', min(g.gap),
                     'median', percentile_cont(0.5) within group (order by g.gap),
                     'repeats', count(g.gap))
                   from gaps g where g.gap is not null),
    'songs', (select coalesce(jsonb_agg(jsonb_build_object(
                'song_id', ps.song_id, 'title', s.title, 'artist', s.artist, 'served', ps.served)
                order by ps.served desc, s.artist, s.title), '[]')
              from per_song ps join public.drive_mix_songs s on s.id = ps.song_id),
    'artists', (select coalesce(jsonb_agg(jsonb_build_object(
                  'artist_key', pa.artist_key, 'served', pa.served, 'pool_songs', pa.pool_songs)
                  order by pa.served desc, pa.artist_key), '[]')
                from per_artist pa),
    'shortfalls', v_short
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.drive_mix_simulate(date, int, int, int, int, jsonb) is
  'DJ: run drive_mix_pick for p_days consecutive days (cap 120) from p_start without writing anything. '
  'Starts from real recency before p_start, then treats the first p_heard_per_day songs of each day (null = all) as heard that day. '
  'Returns one json object: per-song and per-artist serve counts, repeat_gap min/median in days, expected_gap_days (pool / count), and shortfalls (days a slice, or the whole list, came up short).';

revoke all on function public.drive_mix_simulate(date, int, int, int, int, jsonb) from public, anon;
grant execute on function public.drive_mix_simulate(date, int, int, int, int, jsonb) to authenticated;

commit;

-- After running: check_platform_conformance must report CONFORMANT.
