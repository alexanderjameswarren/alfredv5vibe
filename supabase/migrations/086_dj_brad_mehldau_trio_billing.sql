-- 086 - dj_known_disagreements: the Brad Mehldau Trio "Day Is Done" tracks are
-- DECIDED. Nine rows, one reason.
--
-- MOVED HEADER: one-off data insert, applied once. Not a schema change. It adds
-- decisions to an existing table and creates nothing.
--
-- ============================================================================
-- WHAT WAS FLAGGED
-- ============================================================================
-- The daily sync of 2026-10-02 reports nine videos from "Day Is Done" whose
-- stored primary artist disagrees with the submitted one:
--
--   stored     "Brad Mehldau Trio"  -> primary  brad mehldau trio
--   submitted  "Brad Mehldau"       -> primary  brad mehldau
--
-- ============================================================================
-- WHY A DECISION AND NOT AN ALIAS-MAP ENTRY
-- ============================================================================
-- An alias "Brad Mehldau" -> "Brad Mehldau Trio" was written and withdrawn on
-- 2026-10-02 before it was deployed. Checked first: 8 tracks are stored under plain
-- "Brad Mehldau", which are solo and duet recordings (VMY2rbMh4EI, OpRv8d910Vk,
-- P4E5MHNHLas, VxzWDnfqZzY, 8N-2n8Uf5V8, JQ5dVL-OEEI, 3-WmpchW43o,
-- F3BoubSfcO8). The alias would key their future plays as
-- 'brad mehldau trio|<title>' against stored rows keyed 'brad mehldau|<title>'.
-- match_key is frozen at write (spec 4.1.2), so every one of them would split.
-- The reverse direction would re-key these nine instead.
--
-- So these are TWO REAL BILLINGS, not one act spelled twice. Mehldau solo and
-- the Mehldau Trio are different line-ups. This is the same shape as migration 085
-- (Wes Montgomery / Wynton Kelly Trio): a crediting difference, decided rather
-- than translated.
--
-- Accepted knowingly: these fire on every play for as long as the rows stand.
-- dj_tracks is insert-only, so the incoming value is discarded rather than
-- applied (spec 11.13).
--
-- 🛑 NOT COVERED, AND STILL OPEN: the poll keys these recordings
-- 'brad mehldau|<title>', so a poll-first upload of one would not group with
-- the row stored here. A decision row silences a notification; it repairs no
-- identity.
--
-- ============================================================================
-- RUN THIS FIRST - the insert cannot tell you it matched nothing
-- ============================================================================
--   select video_id, artist, match_key
--     from public.dj_tracks
--    where video_id in ('yM7YNJXmY1o','ncM17KVGxX4','bKFwfvfaSJU','YvMaC63vdao',
--                       '8XGkgjcU9QM','erg2_NslRgU','RP9XLElmYK8','6JKG8_eJVMA',
--                       'Hi_seRUIjWs')
--    order by video_id;
--
-- Nine rows, every `artist` exactly "Brad Mehldau Trio". If any differs, STOP
-- and fix this file's literals to match what is stored.

insert into public.dj_known_disagreements
  (user_id, video_id, stored_artist, submitted_artist, reason)
select
  t.user_id, v.video_id, v.stored_artist, v.submitted_artist, v.reason
from (values
  ('RP9XLElmYK8', 'Brad Mehldau Trio', 'Brad Mehldau',
   'DECIDED: no alias-map entry. Two real billings - stored "Brad Mehldau Trio" for the album "Day Is Done", submitted "Brad Mehldau" by the poll. 8 solo and duet tracks are stored under plain "Brad Mehldau" (VMY2rbMh4EI, OpRv8d910Vk, P4E5MHNHLas, VxzWDnfqZzY, 8N-2n8Uf5V8, JQ5dVL-OEEI, 3-WmpchW43o, F3BoubSfcO8), so an alias either way would split one side''s frozen match_keys (spec 4.1.2). Same shape as migration 085 (Wes Montgomery / Wynton Kelly Trio): a crediting difference, not a vocabulary variant. Accepted knowingly: fires on every play while this row stands, because dj_tracks is insert-only (spec 11.13). STILL OPEN: the poll keys these "brad mehldau|<title>", so a poll-first upload would not group with the stored row. That is NOT decided by this row.'),
  ('yM7YNJXmY1o', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.'),
  ('ncM17KVGxX4', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.'),
  ('bKFwfvfaSJU', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.'),
  ('YvMaC63vdao', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.'),
  ('8XGkgjcU9QM', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.'),
  ('erg2_NslRgU', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.'),
  ('6JKG8_eJVMA', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.'),
  ('Hi_seRUIjWs', 'Brad Mehldau Trio', 'Brad Mehldau',
   'Trio billing on "Day Is Done" vs poll''s plain "Brad Mehldau" - see RP9XLElmYK8 for the full reason.')
) as v(video_id, stored_artist, submitted_artist, reason)
join public.dj_tracks t on t.video_id = v.video_id
on conflict (user_id, video_id, stored_artist, submitted_artist) do nothing;

-- ---------------------------------------------------------------------------
-- VERIFY. A silent no-op is the failure mode this guards against.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
    from public.dj_known_disagreements
   where video_id in ('yM7YNJXmY1o','ncM17KVGxX4','bKFwfvfaSJU','YvMaC63vdao',
                      '8XGkgjcU9QM','erg2_NslRgU','RP9XLElmYK8','6JKG8_eJVMA',
                      'Hi_seRUIjWs')
     and stored_artist = 'Brad Mehldau Trio'
     and submitted_artist = 'Brad Mehldau';
  if n <> 9 then
    raise exception 'Expected 9 decided rows, found %. The join to dj_tracks missed a '
      'video_id, or a stored artist string is not exactly "Brad Mehldau Trio". '
      'Run the pre-check query in the header.', n;
  end if;
end $$;
