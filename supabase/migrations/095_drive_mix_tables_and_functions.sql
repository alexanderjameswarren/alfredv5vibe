-- Purpose: Drive Mix step 3. Create public.drive_mix_songs (the pool) and public.drive_mix_servings (what went out each day), plus drive_mix_pick, drive_mix_simulate and drive_mix_sweep.
-- Kind: schema change (new tables, new functions)
-- Applied: YES — confirmed 2026-10-07: CONFORMANT (51 tables), drive_mix_pick returns [] on the empty pool
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Spec: docs/technical-spec-drive_mix-v7r.md. Run as one block in the SQL editor.
-- supabase/migrations/095_drive_mix_tables_and_functions.sql

begin;

-- ============================================================================
-- 1. drive_mix_songs
-- ============================================================================
create table if not exists public.drive_mix_songs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  video_id       text not null,
  title          text not null,
  artist         text not null,
  artist_key     text not null,
  decade         smallint,
  genre          text,
  status         text not null default 'pending',
  source         text not null,
  retired_reason text,
  added_at       timestamptz not null default now(),

  constraint drive_mix_songs_user_video_key unique (user_id, video_id),
  constraint drive_mix_songs_decade_check
    check (decade is null or (decade between 1900 and 2090 and decade % 10 = 0)),
  constraint drive_mix_songs_genre_check
    check (genre is null or genre in ('pop', 'rock', 'alternative', 'country', 'rap', 'rnb', 'dance', 'other')),
  constraint drive_mix_songs_status_check
    check (status in ('pending', 'active', 'retired')),
  constraint drive_mix_songs_source_check
    check (source in ('playlist_seed', 'artist_top', 'history_sweep', 'manual')),
  constraint drive_mix_songs_retired_reason_check
    check (retired_reason is null or status = 'retired'),
  constraint drive_mix_songs_artist_key_check
    check (btrim(artist_key) <> '')
);

comment on table public.drive_mix_songs is
  'DJ: Drive Mix song pool. Songs Alex knows, each tagged with decade and genre, from which drive_mix_pick chooses the daily Drive Mix playlist. Only status = active with decade and genre set is ever picked.';
comment on column public.drive_mix_songs.id is 'Surrogate key.';
comment on column public.drive_mix_songs.user_id is 'Owner. Set explicitly when inserting from the SQL editor, where auth.uid() is null.';
comment on column public.drive_mix_songs.video_id is
  'YouTube video id, unique per user. Recency is resolved through it: video_id -> dj_tracks -> coalesce(canonical_track_id, id) -> dj_plays. A video_id with no dj_tracks row counts as never heard.';
comment on column public.drive_mix_songs.title is 'Track title as YouTube gives it.';
comment on column public.drive_mix_songs.artist is 'Display billing as YouTube gives it. For swept songs, the canonical dj_tracks row''s artist.';
comment on column public.drive_mix_songs.artist_key is
  'Normalised primary artist for the per-artist cap: lower-cased, trimmed, first name of a collaboration. Filled by trigger from artist when not supplied; set it by hand when the default is wrong.';
comment on column public.drive_mix_songs.decade is '1960, 1970 ... 2020. Null until tagged. Decades before 1960 fit no slice and are picked only as fill.';
comment on column public.drive_mix_songs.genre is 'pop, rock, alternative, country, rap, rnb, dance or other. Null until tagged. country and rap always count in the country-and-rap slice.';
comment on column public.drive_mix_songs.status is 'pending = pooled but not yet tagged and reviewed; active = pickable; retired = never picked.';
comment on column public.drive_mix_songs.source is 'How the song entered the pool: playlist_seed, artist_top, history_sweep or manual.';
comment on column public.drive_mix_songs.retired_reason is 'Why the song was retired. Only allowed when status is retired.';
comment on column public.drive_mix_songs.added_at is 'When the song entered the pool.';

create index if not exists drive_mix_songs_status_idx
  on public.drive_mix_songs (user_id, status);

create index if not exists drive_mix_songs_artist_key_idx
  on public.drive_mix_songs (user_id, artist_key);

-- artist_key default. A trigger, not the tools, so the sweep, the MCP tool and a
-- hand insert all get the same rule.
create or replace function public.drive_mix_songs_set_artist_key()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_key text;
begin
  if new.artist_key is null or btrim(new.artist_key) = '' then
    v_key := btrim((regexp_split_to_array(
      lower(btrim(new.artist)),
      '\s*(,|&|\+|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\swith\s)\s*'))[1]);
    if v_key is null or v_key = '' then
      v_key := lower(btrim(new.artist));
    end if;
    new.artist_key := v_key;
  else
    new.artist_key := lower(btrim(new.artist_key));
  end if;
  return new;
end;
$$;

comment on function public.drive_mix_songs_set_artist_key() is
  'DJ: fills drive_mix_songs.artist_key from artist when it is not supplied (first name of a collaboration, lower-cased), and lower-cases a supplied one.';

drop trigger if exists drive_mix_songs_set_artist_key on public.drive_mix_songs;
create trigger drive_mix_songs_set_artist_key
  before insert or update on public.drive_mix_songs
  for each row execute function public.drive_mix_songs_set_artist_key();

-- ============================================================================
-- 2. drive_mix_servings
-- ============================================================================
create table if not exists public.drive_mix_servings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete restrict,
  served_on   date not null,
  position    int not null,
  song_id     uuid not null references public.drive_mix_songs(id) on delete restrict,
  video_id    text not null,
  recorded_at timestamptz not null default now(),

  constraint drive_mix_servings_position_key unique (user_id, served_on, position),
  constraint drive_mix_servings_song_key unique (user_id, served_on, song_id),
  constraint drive_mix_servings_position_check check (position >= 1)
);

comment on table public.drive_mix_servings is
  'DJ: what the Drive Mix playlist actually carried each day, one row per song. Written from the video_ids sent to YouTube, never re-derived from the picker, so it matches what went out. One serving per date: a second is refused by the tool. Recency does NOT read this table; it reads dj_plays.';
comment on column public.drive_mix_servings.id is 'Surrogate key.';
comment on column public.drive_mix_servings.user_id is 'Owner. Set explicitly when inserting from the SQL editor, where auth.uid() is null.';
comment on column public.drive_mix_servings.served_on is 'The day the playlist was written for (UTC date, as drive_mix_pick uses).';
comment on column public.drive_mix_servings.position is '1-based order in the playlist.';
comment on column public.drive_mix_servings.song_id is 'The pool song. ON DELETE RESTRICT: retire a song rather than deleting it.';
comment on column public.drive_mix_servings.video_id is 'The video_id sent to YouTube, copied so the record stands even if the pool row changes.';
comment on column public.drive_mix_servings.recorded_at is 'When the serving was recorded.';

create index if not exists drive_mix_servings_served_on_idx
  on public.drive_mix_servings (user_id, served_on desc);

create index if not exists drive_mix_servings_song_idx
  on public.drive_mix_servings (song_id);

-- ============================================================================
-- 3. drive_mix_pick
-- ============================================================================
-- Read-only and deterministic for a given date: every random choice is an md5
-- of the date and the song id. SECURITY INVOKER, so RLS scopes every read.
create or replace function public.drive_mix_pick(
  p_date       date  default current_date,
  p_count      int   default 50,
  p_artist_cap int   default 2,
  p_quotas     jsonb default '{"country_rap": 5, "1960s-1980s": 8, "2010s-2020s": 10, "1990s-2000s": 27}',
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
  c_slices constant text[] := array['country_rap', '1960s-1980s', '2010s-2020s', '1990s-2000s'];
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
                when s.decade between 1960 and 1980 then '1960s-1980s'
                when s.decade between 1990 and 2000 then '1990s-2000s'
                when s.decade between 2010 and 2020 then '2010s-2020s'
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

  -- Fill: any eligible song, including pre-1960 songs that fit no slice.
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
  'Fills slices in order country_rap, 1960s-1980s, 2010s-2020s, 1990s-2000s (p_quotas = song counts, sum <= p_count), then fills the rest from any eligible song (slice = fill), at most p_artist_cap songs per artist_key, no adjacent same artist where a swap can avoid it. '
  'p_recency is for drive_mix_simulate only: a song_id -> last-heard-date map that replaces the dj_plays lookup.';

revoke all on function public.drive_mix_pick(date, int, int, jsonb, jsonb) from public, anon;
grant execute on function public.drive_mix_pick(date, int, int, jsonb, jsonb) to authenticated;

-- ============================================================================
-- 4. drive_mix_simulate
-- ============================================================================
-- Runs drive_mix_pick for consecutive days with the last-heard map held in
-- memory, so it writes nothing at all, temp tables included.
create or replace function public.drive_mix_simulate(
  p_start         date  default current_date,
  p_days          int   default 60,
  p_heard_per_day int   default null,
  p_count         int   default 50,
  p_artist_cap    int   default 2,
  p_quotas        jsonb default '{"country_rap": 5, "1960s-1980s": 8, "2010s-2020s": 10, "1990s-2000s": 27}'
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

-- ============================================================================
-- 5. drive_mix_sweep
-- ============================================================================
create or replace function public.drive_mix_sweep()
returns setof public.drive_mix_songs
language plpgsql
volatile
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  r     public.drive_mix_songs;
begin
  if v_uid is null then
    raise exception 'drive_mix_sweep: no signed-in user. Run it through the create_drive_mix_sweep tool, not the SQL editor.';
  end if;

  for r in
    with played as (
      select coalesce(t.canonical_track_id, t.id) as grp
      from public.dj_plays p
      join public.dj_tracks t on t.id = p.track_id
      where p.user_id = v_uid
      group by 1
      having count(distinct p.played_on) >= 2
    ),
    pooled as (
      select distinct coalesce(t.canonical_track_id, t.id) as grp
      from public.drive_mix_songs s
      join public.dj_tracks t on t.user_id = s.user_id and t.video_id = s.video_id
      where s.user_id = v_uid
    ),
    candidates as (
      select c.video_id, c.title, c.artist
      from played g
      join public.dj_tracks c on c.id = g.grp
      where g.grp not in (select grp from pooled)
        and c.artist is not null
        and btrim(c.artist) <> ''
        and c.artist <> 'Release'
        -- Only ACTIVE jazz tags, matched on the exact dj_tracks.artist string of
        -- any track in the group. Rejected tags are decisions not to tag.
        and not exists (
          select 1
          from public.dj_tracks v
          join public.dj_artist_tags at on at.artist = v.artist
          where (v.id = g.grp or v.canonical_track_id = g.grp)
            and at.tag = 'jazz'
            and at.status = 'active'
        )
    )
    insert into public.drive_mix_songs (user_id, video_id, title, artist, status, source)
    select v_uid, cd.video_id, cd.title, cd.artist, 'pending', 'history_sweep'
    from candidates cd
    on conflict (user_id, video_id) do nothing
    returning *
  loop
    return next r;
  end loop;
end;
$$;

comment on function public.drive_mix_sweep() is
  'DJ: add to the Drive Mix pool, as pending, every canonical track group played on at least two different days that is not already pooled (by group), has no track by an artist with an ACTIVE jazz tag (exact dj_tracks.artist match), and is not credited to Release. '
  'Inserts the canonical row''s video_id, title and artist; decade and genre stay null. Returns the rows added. Refuses without a signed-in user.';

revoke all on function public.drive_mix_sweep() from public, anon;
grant execute on function public.drive_mix_sweep() to authenticated;

-- ============================================================================
-- 6. Register with the platform — last, per the contract
-- ============================================================================
select platform.register_table(
  'public.drive_mix_songs',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: DJ. Drive Mix song pool; drive_mix_pick chooses the daily playlist from active, tagged rows.'
);

select platform.register_table(
  'public.drive_mix_servings',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: DJ. What the Drive Mix playlist carried each day, written from the video_ids sent to YouTube.'
);

commit;

-- After running: check_platform_conformance must report CONFORMANT.
--   select * from platform.conformance_failures;  -- empty = conformant
