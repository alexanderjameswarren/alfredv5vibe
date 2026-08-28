-- ===========================================================================
-- DJ Migration Block F — re-key dj_plays on played_on
--
-- Phase 2b found the dedupe key broken in BOTH directions at once. Nothing
-- currently stored is wrong; the damage is entirely prospective.
--
-- TOO UNSTABLE: a play's label changes as it ages, so one real play minted a
-- fresh row at every stage — Today, Yesterday, This week, Last week.
--
-- NOT DISCRIMINATING ENOUGH: two genuinely different plays days apart both
-- arrive labelled "Today", form the same key, and ON CONFLICT DO NOTHING
-- silently drops the second. A track played on twenty days would keep ONE row,
-- dated the first capture — inverting the system, since the tracks returned to
-- most often are under-counted worst.
--
-- The key becomes (user_id, track_id, played_on, occurrence, source).
--
-- ⚠️ THAT IS ONLY CORRECT ALONGSIDE THE INGEST RULE. Coarse buckets resolve
-- through the §4.2 ladder to poll_date − 2 and − 9, and those move every day,
-- so keying on played_on alone would reproduce the same disease in a new
-- column. The poll therefore writes PRECISE buckets only (Today, Yesterday),
-- enforced in the record_dj_plays handler. Today and Yesterday resolve to a
-- stable date: a play seen as Today on Tuesday and Yesterday on Wednesday
-- resolves to Tuesday both times, so it dedupes across the transition.
--
-- ALSO IN THIS BLOCK: null dj_tracks.album where it came from polling. The feed
-- records what was listened THROUGH, not what the track is FROM — 30 of the
-- first 31 rows say "Summer Jazz: Herbie Hancock", including tracks by Wayne
-- Shorter, Jackie McLean and Lionel Loueke. Folded in here rather than left to
-- phase 3 because dj_tracks is insert-only: the field is frozen at write, so
-- every row Takeout adds later would carry the same wrong value permanently.
--
-- Spec: docs/technical-spec-dj.md §4.3 (rewritten), §5 (familiarity is now
-- distinct days, not play count), §4.2, §9 (album reliability).
--
-- ORDER OF OPERATIONS: run this migration BEFORE deploying the matching
-- dj-courier.ts. The new handler names the new conflict target, and PostgREST
-- rejects an ON CONFLICT that has no matching unique index.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- STEP 1 — PRE-FLIGHT. Run this ALONE first. It must return ZERO rows.
--
-- If it returns anything, two stored rows would collide under the new key and
-- the ALTER in step 2 will fail. That would most likely mean a play was
-- captured twice across a Today -> Yesterday transition under the old key —
-- exactly the duplication this migration prevents going forward. Resolve by
-- hand (keep the earliest observed_at) before continuing. Do NOT auto-delete.
-- ---------------------------------------------------------------------------

select user_id, track_id, played_on, occurrence, source, count(*) as n
from public.dj_plays
group by user_id, track_id, played_on, occurrence, source
having count(*) > 1
order by n desc;


-- ---------------------------------------------------------------------------
-- STEP 1b — ALBUM DIAGNOSTIC. Informational, not blocking.
--
-- Shows each album value alongside how many DISTINCT artists claim it. A row
-- with n_artists > 1 is a mix or radio station masquerading as an album.
--
-- This is a diagnostic, NOT the rule. The cross-artist signal is retrospective,
-- and dj_tracks is insert-only — album is frozen at write, so a rule needing
-- future data cannot work. An album that looks single-artist today may be
-- multi-artist next week, by which point the row cannot be corrected. Nor can
-- the signal separate contamination from a genuine various-artists compilation.
-- Hence step 2 nulls ALL poll-sourced albums rather than the detected ones.
-- ---------------------------------------------------------------------------

select t.album,
       count(*)                       as n_tracks,
       count(distinct t.artist)       as n_artists,
       min(t.artist)                  as example_artist,
       max(t.artist)                  as another_artist
from public.dj_tracks t
where t.album is not null
group by t.album
order by n_artists desc, n_tracks desc;


-- ---------------------------------------------------------------------------
-- STEP 2 — the migration. Run only after step 1 returns nothing.
-- ---------------------------------------------------------------------------

begin;

alter table public.dj_plays
  drop constraint dj_plays_user_id_track_id_played_bucket_occurrence_source_key;

alter table public.dj_plays
  add constraint dj_plays_user_id_track_id_played_on_occurrence_source_key
  unique (user_id, track_id, played_on, occurrence, source);


-- --- COMMENT ON is design truth under the platform contract, and the existing
-- --- played_bucket comment asserts a drift immunity the index never provided.
-- --- Correcting it is part of the fix, not documentation tidying.

comment on column public.dj_plays.played_bucket is
  'The label YouTube returned, verbatim; NULL for sources with real timestamps. '
  'DIAGNOSTIC ONLY — deliberately NOT part of the dedupe key. It cannot be. This '
  'column previously carried the claim that a play drifting from This week to Last '
  'week "keeps its original bucket and does not re-insert": the STORED row keeps its '
  'bucket, but the INCOMING row carries the NEW label, forms a different key, and '
  'inserts. Keyed on the label, one play minted four rows as it aged; meanwhile two '
  'different plays days apart both arriving as "Today" collided and the second was '
  'silently dropped. Broken in both directions at once. See spec 4.3.';

comment on column public.dj_plays.played_on is
  'Always populated, and the dedupe key with track_id, occurrence and source. For '
  'coarse buckets this is a resolved estimate skewed to the RECENT end (spec 4.2) — '
  'and because those estimates are relative to the poll date they MOVE DAILY, which '
  'is why the daily poll ingests PRECISE buckets only (Today, Yesterday). Those '
  'resolve stably: a play seen as Today on Tuesday and as Yesterday on Wednesday '
  'resolves to Tuesday both times and dedupes across the transition. Coarse buckets '
  'are still READ for gap detection but never written by the poll. Takeout '
  '(precision exact) is the only source that can ingest history at any age.';

comment on column public.dj_plays.occurrence is
  'Nth play of this track on this DAY (not within a bucket). Lets a per-play source '
  'record repeat listens as distinct rows while the unique constraint still absorbs a '
  're-poll. NOTHING IN THE DAILY POLL WILL EVER PRODUCE occurrence > 1 — not rarely, '
  'never: YouTube''s history feed carries ONE ENTRY PER TRACK PER BUCKET, positioned '
  'at that track''s most recent play. Measured in phase 2b — three plays of one song '
  'produced one entry, and twenty would too. This column exists to serve the Takeout '
  'import (spec 7 phase 8), which has real per-play rows and is consequently the only '
  'source from which true play counts can ever be obtained.';

-- --- Album correction. An UPDATE on an insert-only table is exactly what a
-- --- corrective migration is for: "insert-only" constrains the TOOL, so that a
-- --- daily poll can never clobber curation. It was never meant to prevent a
-- --- deliberate, audited, one-off fix. dj_tracks is audited, so this is
-- --- reversible via platform.rollback_audit_entry.

update public.dj_tracks t
set album = null
where t.album is not null
  and exists (select 1 from public.dj_plays p
              where p.track_id = t.id and p.source = 'poll')
  and not exists (select 1 from public.dj_plays p
                  where p.track_id = t.id and p.source <> 'poll');

comment on column public.dj_tracks.album is
  'The album this track is FROM — or NULL, which is the common case. NOT written by '
  'the daily poll. YouTube''s history feed reports what was listened THROUGH rather '
  'than what the track is from: playing a mix stamps the MIX name on every track in '
  'it, and it arrives carrying a real MPREb_ album browse id, so it is structurally '
  'indistinguishable from a genuine album. Measured in phase 2b — 30 of the first 31 '
  'rows said "Summer Jazz: Herbie Hancock", including tracks by Wayne Shorter, Jackie '
  'McLean and Lionel Loueke. Nulled rather than flagged because a flag would preserve '
  'a value nobody should ever read, and because dj_tracks is insert-only: any '
  'detection rule has to be right at insert time from one batch alone, and the '
  'cross-artist signal is retrospective. dj_albums must be populated from a real '
  'lookup or from Takeout, never from the history feed.';

comment on table public.dj_plays is
  'DJ: append-only listening log. Always has a usable date, but that date is sometimes '
  'a resolved guess — precision says which. Nullable dates were rejected: every query '
  'would pay for a precision the use case does not need. NOTE: row count is NOT play '
  'count. The poll records at most one row per track per day regardless of how many '
  'times it was played, so familiarity is measured as DISTINCT DAYS (spec 5). Only '
  'source = ''takeout'' rows can express true repeat counts.';

commit;


-- ---------------------------------------------------------------------------
-- STEP 3 — verify.
-- ---------------------------------------------------------------------------

-- Expect exactly one unique index on dj_plays besides the pkey, on
-- (user_id, track_id, played_on, occurrence, source).
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'dj_plays'
order by indexname;

-- Then run check_platform_conformance — expect CONFORMANT at 27 tables.
-- No table was added or dropped, so the count does not change.
