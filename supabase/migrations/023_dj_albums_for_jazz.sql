-- 023 - dj_albums becomes usable, gains a track list, and Today's Jazz gets a row
--
-- ============================================================================
-- WHAT THIS IS FOR
-- ============================================================================
-- The Jazz thread: a standing conversation that suggests three albums, and on
-- "let's do Mingus" puts it in Today's Jazz. §1 capability 4, and §14.2's
-- "dj_albums has no writer and no data" finally getting one.
--
-- 🛑 THE WHOLE DESIGN TURNS ON ONE THING: A SUGGESTION IS A WRITE, NOT A
--    SENTENCE. "Try Mingus Ah Um" is homework — it means copying text off a
--    phone and hunting for the album. "It's in Today's Jazz" is a suggestion.
--    Everything below exists to make the second one cheap enough to happen in
--    the same breath as the first.
--
-- ============================================================================
-- ⚠️ dj_albums WAS DESIGNED IN BLOCK C AND NEVER USED. THREE THINGS ARE WRONG
--    WITH IT, AND THEY ARE ONLY VISIBLE NOW THAT SOMETHING WANTS TO WRITE IT.
-- ============================================================================
--
-- 1. THERE IS NO ARTIST TEXT COLUMN. Only `artist_id` -> dj_artists, which holds
--    22 MBID-KEYED CONCERT ACTS. Mingus, Lee Morgan and Eddie Higgins are not
--    there and do not belong there: dj_artists exists so setlist.fm can be
--    queried, and a null mbid means it cannot be. That is the same overloading
--    argument §14.23 settled for dj_artist_tags, and it applies unchanged.
--
--    With artist_id null — the legitimate compilation case the column comment
--    already describes — AN ALBUM CURRENTLY HAS NO WAY TO RECORD WHO MADE IT.
--
--    ⚠️ THE COST, NAMED: this makes a THIRD artist vocabulary, alongside
--    dj_artists.name and dj_tracks.artist. That is real and it is accepted,
--    because the alternative is forcing every jazz musician into an mbid-keyed
--    table built for a different job.
--
-- 2. status IS queued | listening | known, AND THERE IS NO WAY TO SAY NO.
--    The canon accumulates by proposal: the thread suggests, Alex approves, it
--    is recorded. So the thread must be able to know it already asked — and a
--    declined album with nowhere to put the decline gets proposed again next
--    week, forever. That is §11.7, and §14.24 already paid for the lesson once
--    with artist tags.
--
-- 3. THERE IS NO UNIQUE CONSTRAINT AT ALL. Only a PK on id. Nothing stops Kind
--    of Blue being recorded twice.
--
--    ⚠️ DECIDED: TOLERATE DUPLICATE ALBUMS, ADD THE CHEAP GUARD. No canonical
--    album pointer. Tracks needed §4.1's grouping because 4,700 arrived at once
--    with no human in the loop; albums arrive one at a time with Alex approving
--    each, so a second Kind of Blue is visible immediately and gets dismissed.
--    The unique below prevents only the ACCIDENTAL case — the same YouTube id
--    recorded twice — which no human would catch and no human caused.

-- ---------------------------------------------------------------------------
-- dj_albums: the artist, the decision, and when it was asked
-- ---------------------------------------------------------------------------
alter table public.dj_albums
  add column if not exists artist text,
  add column if not exists suggested_on date;

comment on column public.dj_albums.artist is
  'The album artist as a DISPLAY STRING, from YouTube Music''s get_album. '
  '⚠️ NOT a foreign key and NOT an identity. `artist_id` points at dj_artists, '
  'which holds mbid-keyed CONCERT ACTS so setlist.fm can be queried — jazz '
  'musicians have no mbid there and do not belong in it (§14.23''s argument, '
  'unchanged). With artist_id null, this is the only record of who made the '
  'album. '
  '🛑 THIS IS A THIRD ARTIST VOCABULARY, alongside dj_artists.name and '
  'dj_tracks.artist, and nothing joins the three. Accepted deliberately; do not '
  'build an identity on it (§14.1).';

comment on column public.dj_albums.suggested_on is
  'The day the Jazz thread last proposed this album. '
  '🛑 THIS IS WHAT STOPS THE THREAD REPEATING ITSELF. The canon is knowledge the '
  'MODEL holds, not something the listening history contains — so a session can '
  'suggest Mingus Ah Um and have no idea it suggested it last week unless this '
  'row exists. dj_albums IS the memory; the model is not.';

-- ⚠️ THE CHECK IS REPLACED, NOT WIDENED IN PLACE — Postgres has no ALTER
-- CONSTRAINT for CHECK. Dropped and re-added, which is safe here and is
-- asserted below rather than assumed: §14.2 records dj_albums as having no
-- writer and no data, so there should be nothing to invalidate.
alter table public.dj_albums
  drop constraint if exists dj_albums_status_check;

alter table public.dj_albums
  add constraint dj_albums_status_check
  check (status = any (array[
    'proposed'::text,   -- the thread put it forward; Alex has not answered
    'queued'::text,     -- accepted, wants to hear it
    'listening'::text,  -- in rotation now
    'known'::text,      -- heard it, done
    'dismissed'::text   -- asked and answered NO
  ]));

comment on column public.dj_albums.status is
  'Where this album sits in the queue — NOT how Alex feels about it, which is '
  'the newest dj_feedback row. '
  'proposed = suggested, unanswered. queued = accepted. listening = in rotation. '
  'known = heard. dismissed = ASKED AND ANSWERED NO. '
  '🛑 `dismissed` IS THE STATE THAT MAKES THE THREAD WORK. Without it a declined '
  'album is indistinguishable from one never mentioned, so it comes back every '
  'week and the section gets skipped (§11.7). '
  '⚠️ DISMISSED IS A QUEUE DECISION, NOT A FEELING, WHICH IS WHY IT IS HERE AND '
  'NOT IN dj_feedback. An album can legitimately be tags=[''canon''] AND '
  'dismissed: yes it is canonical, no I do not want it. Feedback cannot express '
  'that, because it records how you feel rather than where something sits.';

comment on column public.dj_albums.tags is
  'What KIND of thing this album is: canon, latin-jazz, hard-bop, vocal. '
  '⚠️ AN ARRAY IS SAFE HERE AND WAS NOT SAFE FOR ARTIST TAGS, AND THE REASON IS '
  'WORTH KEEPING. §14.24 needed a table because artists had no row of their own, '
  'so the REJECTION had nowhere to live. An album has a row: the category goes '
  'here, the decision goes in `status`, and the two are independent. '
  '⚠️ ACCEPTED COST: an array cannot record WHO called it canon or WHEN. Revisit '
  'the first time a category is disputed and its provenance matters.';

-- ⚠️ UNIQUE ON THE YOUTUBE ID ONLY, AND NULLS ARE FINE. Postgres allows many
-- NULLs in a unique index, which is exactly right: an album recorded from
-- knowledge before it is resolved on YouTube has no id yet, and several such
-- rows must be able to coexist.
create unique index if not exists dj_albums_user_yt_uniq
  on public.dj_albums (user_id, yt_album_id)
  where yt_album_id is not null;

-- ---------------------------------------------------------------------------
-- dj_album_tracks — "have I heard this album" needs something to count
-- ---------------------------------------------------------------------------
-- 🛑 dj_tracks.album CANNOT ANSWER THIS AND MUST NOT BE USED TO TRY. It is
-- unreliable and mostly null (§14.9), it is frozen at write (§4.1.2), and it
-- describes where a PLAY came from rather than what an album CONTAINS. The
-- track list comes from get_album, which returns video ids — the same shape as
-- playlist membership.
--
-- ⚠️ THERE IS DELIBERATELY NO canonical_track_id COLUMN HERE. §14.10 records
-- dj_playlist_tracks.canonical_track_id sitting unpopulated and reading as
-- authoritative — one row filled out of thousands, and anything trusting it got
-- nulls and no error. Canonical grouping is resolved AT QUERY TIME, the way
-- mode=cram and mode=engagement already do it. A column that looks authoritative
-- and is empty is worse than no column.
create table if not exists public.dj_album_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  album_id uuid not null references public.dj_albums(id) on delete cascade,
  -- The YouTube id, which is what joins to dj_tracks and therefore to plays.
  video_id text not null,
  title text not null,
  -- Per-track, because a jazz album's tracks routinely credit different leaders
  -- from the album itself.
  artist text,
  duration_seconds int,
  -- The album's own running order. 1-indexed as get_album reports it.
  position int not null,
  created_at timestamptz not null default now(),
  -- ⚠️ ORDER IS UNIQUE, VIDEO ID IS NOT. Migration 012 removed a duplicate
  -- constraint from playlist membership because duplicates were load-bearing
  -- there; an album has no such case, but over-constraining is how 012 happened,
  -- so only the position is pinned.
  unique (album_id, position)
);

comment on table public.dj_album_tracks is
  'The track list of an album, from YouTube Music''s get_album. Exists so "have '
  'I heard this album" can be answered from dj_plays. '
  '🛑 dj_tracks.album CANNOT ANSWER THAT — unreliable, mostly null (§14.9), '
  'frozen at write, and it describes where a PLAY came from rather than what an '
  'album contains. '
  '⚠️ NO canonical_track_id COLUMN, DELIBERATELY (§14.10). Grouping is resolved '
  'at query time so a play of ANY upload of a track counts, the same way '
  'mode=cram and mode=engagement do it. A column that looks authoritative and '
  'sits empty is worse than none. '
  '⚠️ COVERAGE IS A FRACTION, NEVER A BOOLEAN. Albums are 8-12 tracks and three '
  'of them may have been heard; "3 of 9" needs no caveat and "unheard: false" '
  'needs a paragraph (§12.12).';

comment on column public.dj_album_tracks.video_id is
  'YouTube video id. Joins to dj_tracks.video_id, and through it to dj_plays. '
  '⚠️ A track never played may not exist in dj_tracks at all — that is a real '
  'zero, not a missing row, and coverage must LEFT JOIN rather than drop it.';

select platform.register_table(
  'public.dj_album_tracks',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: DJ. Track lists for dj_albums, from YouTube get_album. Exists so album coverage can be computed from dj_plays, which dj_tracks.album cannot do (spec 14.9). No canonical_track_id column on purpose — spec 14.10. Audited because a wrong track list silently changes a coverage number the Jazz thread reports.'
);

-- ---------------------------------------------------------------------------
-- Today's Jazz — the working playlist, recorded as utility
-- ---------------------------------------------------------------------------
-- 🛑 kind='utility', NOT 'jazz', AND THIS IS NOT A COSMETIC CHOICE.
--
-- Migrations 018 and 020 derive an artist tag from every artist on a track in a
-- kind='jazz' playlist. Today's Jazz is OVERWRITTEN EVERY TIME a suggestion is
-- accepted — so as kind='jazz' it would pump a fresh batch of derived tags into
-- dj_artist_tags continuously, each one written with source='playlist' and the
-- authority of a fact. That is §14.35 on a nightly schedule.
--
-- `utility` means "recorded and measured, never proposed against" (migration
-- 011) and derives NO tag (§14.31's kind->tag map is jazz and concert only).
-- That is exactly the semantics a scratch playlist needs.
--
-- ⚠️ NOTHING IS LOST BY OVERWRITING IT. dj_plays records what was actually
-- heard regardless of what the playlist holds afterwards, which is the whole
-- reason this playlist can be disposable while a concert playlist cannot.
--
-- ⚠️ NO TRACKS ARE RECORDED HERE, DELIBERATELY. Its contents at this moment are
-- six smoke-test tracks that the first real suggestion will overwrite. Recording
-- them would put a membership snapshot into the system that is false within the
-- hour, and record_dj_playlist is the tool for membership when it matters.
--
-- ============================================================================
-- 🛑 FILL IN THE PLAYLIST ID BELOW BEFORE RUNNING. IT CANNOT BE GUESSED.
-- ============================================================================
-- Get it from Workshop: get_dj_playlists mode=library, find "Today's Jazz",
-- copy its playlist_id. It looks like PLV2XoCH1Pv5... (34 chars) — though a
-- 13-character id is also legitimate (§14.11, checked and not a defect).
--
-- The verify block below FAILS LOUDLY if the placeholder is still here, so this
-- cannot be applied half-done and read as success.
do $$
declare
  yt_id  text := 'PLFJfyWbzPrIc';
  owner  uuid;
  n      int;
begin
  if yt_id = 'REPLACE_WITH_TODAYS_JAZZ_PLAYLIST_ID' then
    raise exception
      'Today''s Jazz playlist id was not filled in. Get it from Workshop '
      '(get_dj_playlists mode=library) and replace the placeholder at the top '
      'of this block. Refusing to insert a row with a fake id: a dj_playlists '
      'row pointing at nothing would let every later write appear to succeed '
      'while touching no playlist at all.';
  end if;

  -- user_id defaults to auth.uid(), which is null when this runs from the SQL
  -- editor. Take the owner from the data instead, the way migrations 008 and
  -- 017 do, so the row belongs to whoever owns the rest of the library.
  select user_id into owner
  from public.dj_playlists
  group by user_id
  order by count(*) desc
  limit 1;

  if owner is null then
    raise exception
      'No existing dj_playlists rows to take an owner from. Expected 41.';
  end if;

  insert into public.dj_playlists (user_id, yt_playlist_id, name, kind, description)
  values (
    owner, yt_id, 'Today''s Jazz', 'utility',
    'The Jazz thread''s working playlist. Overwritten on every accepted '
    'suggestion via replace_dj_playlist. kind=utility so it derives NO artist '
    'tags (018/020) — as kind=jazz an overwritten-nightly playlist would pump '
    'derived tags in continuously. Nothing is lost by overwriting: dj_plays '
    'records what was actually heard.'
  )
  on conflict do nothing;

  select count(*) into n
  from public.dj_playlists where yt_playlist_id = yt_id;
  if n <> 1 then
    raise exception 'Expected exactly 1 Today''s Jazz row, found %.', n;
  end if;

  raise notice 'Today''s Jazz recorded as kind=utility, owner %.', owner;
end $$;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  n         int;
  bad       int;
  tj        record;
begin
  -- 1. The status vocabulary actually widened. Asserted by USE, not by reading
  --    the catalogue: a CHECK that exists and rejects the value is the failure
  --    this would otherwise ship.
  begin
    insert into public.dj_albums (user_id, title, status)
    select user_id, '__migration_probe__', 'dismissed'
    from public.dj_playlists limit 1;
  exception when check_violation then
    raise exception
      'status still rejects ''dismissed''. The CHECK was not replaced, and the '
      'Jazz thread has no way to record a NO — so every declined album returns '
      'next week (§11.7).';
  end;

  delete from public.dj_albums where title = '__migration_probe__';

  -- 2. ⚠️ THE OLD VALUES MUST STILL WORK. Widening a CHECK by rewriting it is
  --    exactly where an old value gets dropped by accident, and dj_albums has
  --    no rows to fail loudly on.
  begin
    insert into public.dj_albums (user_id, title, status)
    select user_id, '__migration_probe__', 'known'
    from public.dj_playlists limit 1;
  exception when check_violation then
    raise exception
      'status no longer accepts ''known'' — the rewrite dropped an existing '
      'value. dj_albums has no rows, so nothing would have failed loudly.';
  end;

  delete from public.dj_albums where title = '__migration_probe__';

  -- 3. The unique index guards the accidental case and permits the null one.
  select count(*) into bad from pg_indexes
  where schemaname = 'public' and indexname = 'dj_albums_user_yt_uniq';
  if bad <> 1 then
    raise exception 'dj_albums_user_yt_uniq was not created.';
  end if;

  -- 4. Today's Jazz is utility, has no concert link, and holds no tracks.
  select * into tj from public.dj_playlists where name = 'Today''s Jazz';
  if tj is null then
    raise exception 'Today''s Jazz row is missing.';
  end if;
  if tj.kind <> 'utility' then
    raise exception
      'Today''s Jazz is kind=%, not utility. As kind=jazz it would derive an '
      'artist tag from every artist in it, on every overwrite — §14.35 nightly.',
      tj.kind;
  end if;

  select count(*) into n from public.dj_playlist_tracks where playlist_id = tj.id;
  if n <> 0 then
    raise exception
      '% track(s) recorded for Today''s Jazz. This migration deliberately '
      'records none — its current contents are smoke-test tracks about to be '
      'overwritten, and a false membership snapshot is worse than none.', n;
  end if;

  raise notice 'dj_albums widened; dj_album_tracks created; Today''s Jazz is utility with 0 recorded tracks.';
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. This migration creates dj_album_tracks, so the
-- register_table call above is load-bearing rather than ceremonial.
-- ---------------------------------------------------------------------------
