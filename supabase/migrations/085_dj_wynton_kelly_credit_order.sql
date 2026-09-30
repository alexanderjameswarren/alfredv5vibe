-- 085 - dj_known_disagreements: the Wes Montgomery / Wynton Kelly Trio reversed
-- credit on "Smokin' At The Half Note" is DECIDED. Five rows, one reason.
--
-- MOVED HEADER: one-off data insert, applied once. Not a schema change. It adds
-- decisions to an existing table and creates nothing.
--
-- ============================================================================
-- WHAT WAS FLAGGED
-- ============================================================================
-- The daily sync reports five videos from "Smokin' At The Half Note" whose
-- stored primary artist disagrees with the submitted one:
--
--   stored     "Wynton Kelly Trio, Wes Montgomery"  -> primary  wynton kelly trio
--   submitted  "Wes Montgomery, Wynton Kelly Trio"  -> primary  wes montgomery
--
-- Two real, separate artists with the LEAD CREDIT REVERSED. Both sides derive
-- their primary through primaryArtistOfDisplay, which cuts at the first comma,
-- so the difference is genuine and the detector is right to report it.
--
-- ⚠️ THIS IS NOT THE match_key COMPARISON BUG (spec 4.1.4, amended 2026-09-25).
-- That bug fired on IDENTICAL bylines, because the detector read both primaries
-- out of a stored match_key and the two writers tokenise differently. It was
-- fixed by deriving both sides through one function. Here the two bylines really
-- do differ. Nothing about this row set depends on that bug, and it is not a
-- regression of it.
--
-- ============================================================================
-- WHY A DECISION AND NOT AN ALIAS-MAP ENTRY
-- ============================================================================
-- ARTIST_ALIASES is for ONE ACT SPELLED TWICE - "Eddie Higgins"/"Eddie Higgins
-- Trio", "Ahmad Jamal Trio"/"Ahmad Jamal". This is not that. Wes Montgomery and
-- the Wynton Kelly Trio are two acts, and an entry mapping either onto the other
-- would fold one artist's work into the other's - exactly the damage that makes
-- a familiarity answer confidently wrong.
--
-- This is the AbbzAPXvNZ8 shape, decided the same way in migration 008: a
-- CREDITING difference, not a vocabulary variant. That entry's reasoning applies
-- here word for word, which is why this file cites it rather than restating it.
--
-- Accepted knowingly: these fire on every play for as long as the rows stand.
-- dj_tracks is insert-only, so the correct incoming value is discarded rather
-- than applied (spec 11.13) and they cannot fix themselves.
--
-- ============================================================================
-- 🛑 WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ============================================================================
-- 1. IT DOES NOT MAKE THE DETECTOR ORDER-INSENSITIVE. Comparing the normalised
--    SET of artists on each side, and suppressing a permutation, would be a fix
--    rather than a suppression - but it would also silence the case where a
--    changed lead credit is the news. That is its own decision, not a side
--    effect of recording these five.
--
-- 2. IT DOES NOT REPAIR THE GROUPING RISK THE REVERSED CREDIT CREATES, and that
--    risk is NOT the unsplit-key defect. Verified 2026-09-29: all five rows are
--    keyed 'wynton kelly trio|<title>' - SPLIT at the first artist, exactly as
--    the fixed record_dj_album and the poll both key. The unsplit defect
--    ('clifford brown max roach|jordu') was fixed in dj-albums.ts and does not
--    apply here.
--
--    What DOES follow from the reversed credit: the poll derives its primary as
--    `wes montgomery`, so ANOTHER upload of one of these recordings arriving
--    from the poll would be keyed 'wes montgomery|<title>' and would NOT group
--    with the row stored here. Same recording, two canonical groups, from the
--    credit order alone. match_key is frozen at write (spec 4.1.2), so nothing
--    re-keys itself. A decision row silences a notification; it repairs no
--    identity. Do not read these five rows as "that was dealt with".
--
-- ============================================================================
-- RUN THIS FIRST - the insert cannot tell you it matched nothing
-- ============================================================================
-- The join to dj_tracks supplies user_id, so a video_id that is not there, or
-- whose artist string differs by one character, inserts NO row and reports no
-- error. partitionDisagreements keys on video_id|stored|submitted exactly, so a
-- stored string that is not character-for-character what is below decides
-- nothing and the flag keeps firing.
--
--   select video_id, artist, match_key
--     from public.dj_tracks
--    where video_id in ('Z6Piiu3d3sE','FsnO8hmlxmM','D12_468jvNk',
--                       'I0V2ZTwnuK8','BCKjFxn0xKY')
--    order by video_id;
--
-- Five rows, every `artist` exactly "Wynton Kelly Trio, Wes Montgomery". If any
-- differs, STOP and fix this file's literals to match what is stored - do not
-- adjust what is stored.
--
-- RUN 2026-09-29: all five confirmed exact. Their keys came back
-- 'wynton kelly trio|<title>' - split, not unsplit, which corrected the header
-- above.

insert into public.dj_known_disagreements
  (user_id, video_id, stored_artist, submitted_artist, reason)
select
  t.user_id, v.video_id, v.stored_artist, v.submitted_artist, v.reason
from (values
  -- ONE reason, written once, covering all five - as 008 did for the Release rows.
  ('Z6Piiu3d3sE', 'Wynton Kelly Trio, Wes Montgomery', 'Wes Montgomery, Wynton Kelly Trio',
   'DECIDED: no alias-map entry. Two real, separate artists with the lead credit reversed - stored "Wynton Kelly Trio, Wes Montgomery" from the album import of "Smokin'' At The Half Note", submitted "Wes Montgomery, Wynton Kelly Trio" by the poll. The alias map is for ONE ACT SPELLED TWICE; an entry here would fold one artist''s work into the other''s. Same reasoning as AbbzAPXvNZ8 in migration 008: a crediting difference, not a vocabulary variant. NOT the match_key comparison bug - that one fired on identical bylines and is fixed; these two bylines genuinely differ. Accepted knowingly: fires on every play while this row stands, because dj_tracks is insert-only and the correct value is discarded rather than applied (spec 11.13). VERIFIED 2026-09-29, and NOT the unsplit-key defect: all five rows are keyed "wynton kelly trio|<title>", split at the first artist, so there is nothing here for the album-import backfill to repair. SEPARATE AND STILL OPEN, from the credit order alone: the poll derives its primary as "wes montgomery", so another upload of one of these recordings arriving from the poll would key "wes montgomery|<title>" and would not group with the row stored here - one recording, two canonical groups. match_key is frozen at write (spec 4.1.2). That is NOT decided by this row.'),
  ('FsnO8hmlxmM', 'Wynton Kelly Trio, Wes Montgomery', 'Wes Montgomery, Wynton Kelly Trio',
   'Reversed lead credit on "Smokin'' At The Half Note" - see Z6Piiu3d3sE for the full reason.'),
  ('D12_468jvNk', 'Wynton Kelly Trio, Wes Montgomery', 'Wes Montgomery, Wynton Kelly Trio',
   'Reversed lead credit on "Smokin'' At The Half Note" - see Z6Piiu3d3sE for the full reason.'),
  ('I0V2ZTwnuK8', 'Wynton Kelly Trio, Wes Montgomery', 'Wes Montgomery, Wynton Kelly Trio',
   'Reversed lead credit on "Smokin'' At The Half Note" - see Z6Piiu3d3sE for the full reason.'),
  ('BCKjFxn0xKY', 'Wynton Kelly Trio, Wes Montgomery', 'Wes Montgomery, Wynton Kelly Trio',
   'Reversed lead credit on "Smokin'' At The Half Note" - see Z6Piiu3d3sE for the full reason.')
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
   where video_id in ('Z6Piiu3d3sE','FsnO8hmlxmM','D12_468jvNk','I0V2ZTwnuK8','BCKjFxn0xKY')
     and stored_artist = 'Wynton Kelly Trio, Wes Montgomery'
     and submitted_artist = 'Wes Montgomery, Wynton Kelly Trio';
  if n <> 5 then
    raise exception 'Expected 5 decided rows, found %. The join to dj_tracks missed a '
      'video_id, or a stored artist string is not exactly '
      '"Wynton Kelly Trio, Wes Montgomery". Run the pre-check query in the header.', n;
  end if;
end $$;

-- After this lands, docs/history/dj-known-disagreements.md needs a section for
-- these five. The table is authoritative and the page is its rendering, so the
-- page is stale until it says so.
