-- 058 — READ-ONLY VERIFICATION. Nothing is applied; nothing is written.
--
-- Records the third ARTIST_ALIASES entry (dj-normalise.ts) and checks the one
-- thing that decides whether a backfill is also needed.
--
-- ============================================================================
-- THE DECISION: "The Dave Brubeck Quartet" -> "Dave Brubeck Quartet"
-- ============================================================================
--
-- 🛑 THIS DIRECTION IS THE OPPOSITE OF WHAT §4.1.4's RULE AS WRITTEN GIVES, AND
-- THAT IS THE FINDING RATHER THAN AN EXCEPTION TO IT.
--
-- §4.1.4 says: canonicalise to the POLL's vocabulary, because Takeout is a
-- one-time import and the poll writes forever. The poll now sends "The Dave
-- Brubeck Quartet". Applied literally, the rule therefore says canonical is the
-- The-form and the map should read `Dave Brubeck Quartet -> The Dave Brubeck
-- Quartet`.
--
-- ⚠️ THAT IS UNUSABLE HERE, FOR THE RULE'S OWN STATED REASON. The rule is
-- justified by this sentence: translating toward the poll "leaves the 17
-- already-stored rows ALREADY CORRECT — no UPDATE needed, so the insert-only
-- guarantee is never bent." Here the opposite holds. 86 play rows across 24
-- distinct groups are stored as "Dave Brubeck Quartet", and match_key is FROZEN
-- AT WRITE (§4.1.2). Mapping toward the poll would make every one of those rows
-- non-canonical and require re-keying them — exactly the bend the rule exists to
-- avoid.
--
-- ⚠️ AND THE OTHER DIRECTION VIOLATES A DIFFERENT INVARIANT, WHICH IS WHY THIS
-- NEEDED DECIDING RATHER THAN DERIVING. dj-normalise.ts documents the `from`
-- side as "the Takeout `- Topic` channel name" and states that "the poll never
-- submits an alias key anyway, so applying it universally is a no-op there".
-- This entry puts a POLL-SUBMITTED string on the `from` side. That invariant is
-- now false, and the comment is corrected in the same commit rather than left to
-- be discovered.
--
-- 🛑 THE REAL CAUSE: THIS IS NOT THE CASE THE MAP WAS BUILT FOR. §4.1.4's premise
-- is TWO STATIC VOCABULARIES meeting at one boundary — Takeout and the poll, each
-- internally consistent, measured 2026-08-30 at 0 split pairs within each. What
-- happened here is ONE SOURCE CHANGING ITS OWN VOCABULARY OVER TIME: the poll
-- used to send the bare form and now sends the The-form. One source, two eras.
-- The 2026-08-30 measurement is stale as a guarantee about the future, and the
-- rule is silent on this case because it assumed it could not happen.
--
-- The tie-break that decides it, and it is not aesthetic: OF THE TWO ERAS, ONLY
-- ONE HAS ROWS THAT CANNOT BE REWRITTEN. Stored rows are frozen; future polls are
-- free. So canonicalise toward WHAT IS ALREADY WRITTEN AND CANNOT CHANGE, and
-- accept a permanent per-poll translation — a Map lookup on the primary artist.
--
-- ============================================================================
-- SCOPE: THE ACT GENERALLY, NOT ONE ROW. Measured 2026-09-19.
-- ============================================================================
--
-- One page of live YouTube history carried THREE Brubeck tracks, all bylined
-- "The Dave Brubeck Quartet":
--
--     ONWLtHyx4uA  Blue Rondo A La Turk   last played 2026-09-18  <- flagged
--     EZLMHglUTaI  Three to Get Ready     last played 2026-09-16
--     8orj-BSZcOo  Koto Song              last played 2026-09-13
--
-- All three are KNOWN TRACKS stored as "Dave Brubeck Quartet". ⚠️ ONLY ONE WAS
-- FLAGGED, AND THE REASON MATTERS: artist_disagreements is computed per SUBMITTED
-- row, and the sync submits only plays it does not already hold. ONWLtHyx4uA was
-- the only one with a new play in that run. The other 22 groups are not exempt —
-- THEY WILL FLAG ONE AT A TIME AS EACH IS NEXT PLAYED. A single-row report was
-- always going to be the shape of a whole-act change arriving through a daily
-- poll, which is worth knowing before the next one is read as a new finding.
--
-- ============================================================================
-- MUSICBRAINZ DOES NOT BEAR ON THIS
-- ============================================================================
--
-- A display name never reaches setlist.fm. get_dj_setlists is keyed on mbid and
-- REFUSES NAMES OUTRIGHT (dj_setlists.py:499, dj-artists.ts:75) because a name
-- search matches the wrong band. So "which form does MusicBrainz call canonical"
-- cannot affect any setlist read, and is not an argument for either direction.
-- dj_artists.mbid is the only identity setlist.fm sees, and it is unaffected by
-- anything in ARTIST_ALIASES.
--
-- ============================================================================
-- THE ONE THING THAT COULD STILL REQUIRE A BACKFILL
-- ============================================================================
--
-- The alias map applies AT WRITE. Any Brubeck track whose FIRST EVER play landed
-- after the byline changed was inserted under the The-form, and no disagreement
-- was raised for it — there was no stored row to disagree with. That is a real
-- split in dj_tracks, and it is invisible to the disagreement channel by
-- construction.
--
-- dj_artists holds no "The Dave Brubeck Quartet" row, but dj_artists is the
-- IDENTITY table and the rollup groups on dj_tracks.artist — so that is not the
-- same question. Run this before concluding there is nothing to repair.

select json_build_object(
  'brubeck_artist_strings_in_dj_tracks', (
    select json_agg(t) from (
      select artist,
             count(*)                        as tracks,
             min(created_at)::date           as first_written,
             max(created_at)::date           as last_written
      from   dj_tracks
      where  artist ilike '%brubeck%'
      group  by artist
      order  by tracks desc
    ) t
  ),
  'the_form_rows_needing_repair', (
    select json_agg(t) from (
      select video_id, artist, title, match_key, created_at::date as written
      from   dj_tracks
      where  artist = 'The Dave Brubeck Quartet'
      order  by created_at
    ) t
  ),
  'when_the_poll_vocabulary_changed', (
    select json_agg(t) from (
      select created_at::date as written, artist, count(*) as tracks
      from   dj_tracks
      where  artist ilike '%brubeck%'
      group  by created_at::date, artist
      order  by written desc
      limit  20
    ) t
  ),
  'other_acts_where_a_The_form_split_already_exists', (
    select json_agg(t) from (
      select regexp_replace(lower(artist), '^the\s+', '') as bare_form,
             array_agg(distinct artist)                   as spellings,
             count(*)                                     as tracks
      from   dj_tracks
      group  by 1
      having count(distinct artist) > 1
      order  by tracks desc
      limit  25
    ) t
  )
) as result;

-- READING IT.
--
-- `brubeck_artist_strings_in_dj_tracks` — one row means no split and the TS entry
--   alone is the whole fix. Two rows means some tracks were already written under
--   the The-form and need a repair migration; `the_form_rows_needing_repair` lists
--   exactly which, with their frozen match_key values.
--
-- `when_the_poll_vocabulary_changed` — dates the switch, so the next act that does
--   this can be checked against the same window rather than investigated cold.
--
-- 🛑 `other_acts_where_a_The_form_split_already_exists` IS THE ONE TO READ FIRST,
--   AND IT IS DELIBERATELY NOT LIMITED TO BRUBECK. If the poll changed its
--   leading-article handling GENERALLY rather than for one act, this returns
--   several rows and the answer is not three alias entries — it is a normalisation
--   rule, and §14.7's warning applies with full force ("prefer the longer form"
--   fixed Eddie Higgins and broke Red Garland). ⚠️ DO NOT ADD A LEADING-ARTICLE
--   STRIPPING RULE ON THE STRENGTH OF ONE ACT. An empty or single-row result here
--   is what licenses handling this as an alias entry at all.
