-- 014 - correct two function comments from 013. Comments only; no logic changes.
--
-- ============================================================================
-- WHY A MIGRATION FOR COMMENTS
-- ============================================================================
-- ⚠️ A COMMENT IN THE DATABASE IS THE QUERYABLE AUTHORITY (spec §11.17). Editing
-- 013's file changes the record of what was run; it does NOT change what
-- get_database_schema returns, which is where the next reader will look. A
-- correction that lives only in a migration file nobody re-reads is not a
-- correction.

-- ---------------------------------------------------------------------------
-- 1. dj_jazz_activity — A PREDICTION WAS SITTING WHERE A MEASUREMENT BELONGS
-- ---------------------------------------------------------------------------
--
-- 013's comment claimed: "Membership alone would miss most of it, since the
-- heavily-played pianists arrived through plays rather than playlists."
--
-- 🛑 THAT WAS A PREDICTION, WRITTEN IN THE PRESENT TENSE, IN THE AUTHORITATIVE
-- PLACE. Measured on first run: 65 artists over ten years, and almost everything
-- in the top 20 is in_playlist TRUE. Oscar Peterson, Wes Montgomery and Dave
-- Brubeck — the three named as expected to arrive through the artist arm — are
-- all already in the playlists. Stacey Kent is the only visible exception near
-- the top.
--
-- The reason is simple and neither of us checked it first: Jazz songs Mix (108)
-- and Christmas jazz (83) are 191 tracks between them, which is far broader
-- coverage than "two playlists" suggested.
--
-- ⚠️ THE ARTIST ARM STILL EARNS ITS PLACE — it does real work further down the
-- list, where single plays by an in-playlist artist would otherwise vanish. The
-- feature is right; the JUSTIFICATION was wrong, and a wrong justification in a
-- column comment becomes tomorrow's evidence for a decision nobody re-derives.
comment on function public.dj_jazz_activity(int) is
  'The jazz bucket''s "what have I been playing". '
  '🛑 JAZZ IS A PROXY, NOT A GENRE: nothing marks a track as jazz — dj_tracks has '
  'no genre column, and dj_artists (which has tags) holds 22 concert acts against '
  '1,206 distinct artists in the history (spec §14.1, §14.3). A play counts as '
  'jazz if the track is in a kind=jazz playlist OR its artist appears in one. '
  'MEASURED 2026-09-02, first run: 65 artists over ten years, and almost all of '
  'the top 20 are in_playlist TRUE — Jazz songs Mix (108) and Christmas jazz (83) '
  'are 191 tracks between them, so membership covers more than expected. '
  '⚠️ AN EARLIER VERSION OF THIS COMMENT PREDICTED THE OPPOSITE — that the '
  'heavily-played pianists arrived through plays rather than playlists. Oscar '
  'Peterson, Wes Montgomery and Dave Brubeck are all in the playlists. The artist '
  'arm still earns its place FURTHER DOWN the list, where a single play by an '
  'in-playlist artist would otherwise vanish; it is not what makes the top of the '
  'list correct. Read in_playlist per row rather than assuming either way. '
  '⚠️ The artist arm is an EXACT STRING match on dj_tracks.artist, so "Oscar '
  'Peterson Trio" and "Oscar Peterson" do not unify — see spec §4.1.4. Report the '
  'definition alongside the numbers; the definition is part of the finding.';

-- ---------------------------------------------------------------------------
-- 2. dj_playlist_engagement — last_touched_on is UNCONDITIONAL here
-- ---------------------------------------------------------------------------
--
-- §12.9 says last_touched_on is shown only when runs is 0. This function returns
-- it ALWAYS; get_dj_managed_playlists mode=engagement nulls it otherwise. That is
-- deliberate — the function reports facts and the tool applies presentation —
-- but undocumented it reads as a discrepancy between the spec and the SQL, and
-- the next reader has to work out which one is wrong.
comment on function public.dj_playlist_engagement(uuid[], int) is
  'Spec §12.9. runs = DAYS in the window on which at least `threshold` distinct '
  'canonical groups from the playlist were played; threshold = '
  'clamp(ceil(0.5 * distinct_groups), 4, 20). '
  '⚠️ DAYS, NOT SESSIONS: dj_plays buckets by UTC day and the feed carries one '
  'entry per track per bucket, so two runs in one day are indistinguishable from '
  'one. The unit is days and the name must not imply otherwise. '
  '⚠️ last_touched_on IS RETURNED UNCONDITIONALLY HERE, which is NOT what §12.9 '
  'describes. That is intentional: this function reports facts, and suppressing '
  'it when runs > 0 is PRESENTATION, applied by get_dj_managed_playlists '
  'mode=engagement. §12.9''s rule — show it only when there has never been a run, '
  'so "never run it, but three of its songs came up on 29 August" is sayable '
  'while a bare "never" on a partly-heard playlist is not — is the TOOL''s job. '
  'A caller using this function directly gets the raw value and must apply the '
  'rule itself. '
  '⚠️ A track in two playlists counts toward both — named, not solved. For '
  'concert playlists the overlap is small; for jazz and discovery it will not be.';

do $$
begin
  -- Both must still exist and still answer. A comment migration that silently
  -- targeted a dropped signature would report success and change nothing.
  if (select obj_description('public.dj_jazz_activity(int)'::regprocedure, 'pg_proc'))
       not like '%MEASURED 2026-09-02%' then
    raise exception 'the dj_jazz_activity comment did not take.';
  end if;
  if (select obj_description('public.dj_playlist_engagement(uuid[], int)'::regprocedure, 'pg_proc'))
       not like '%UNCONDITIONALLY HERE%' then
    raise exception 'the dj_playlist_engagement comment did not take.';
  end if;
  if exists (select 1 from platform.conformance_failures) then
    raise exception 'platform.conformance_failures is not empty after this migration.';
  end if;
  raise notice '014 verified: both function comments updated in the database, '
    'not only in the migration file.';
end $$;
