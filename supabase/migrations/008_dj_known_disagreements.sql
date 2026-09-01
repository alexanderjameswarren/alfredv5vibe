-- 008 - dj_known_disagreements: decided artist disagreements, so they stop notifying
--
-- ============================================================================
-- WHY A TABLE AND NOT A COLUMN ON dj_tracks
-- ============================================================================
-- Because a DECISION is revisable and an IDENTITY is not.
--
-- dj_tracks is insert-only: artist, match_key and canonical_track_id are
-- written once and never updated (spec 4.1.2). A decision, by contrast, is
-- exactly the kind of thing that should change when better data arrives - the
-- 12 'Release' rows below are decided as "leave it" ONLY until someone resolves
-- them by lookup. Putting a mutable annotation on the insert-only table blurs
-- the one guarantee that has been load-bearing all week, and the next reader
-- would reasonably assume the whole row is frozen.
--
-- It also lets ONE reason cover the twelve Release rows. A column would store
-- twelve copies of that rationale, and twelve copies can drift.
--
-- ============================================================================
-- THIS TABLE IS AUTHORITATIVE. docs/dj-known-disagreements.md IS ITS RENDERING.
-- ============================================================================
-- The prose page explains the decisions for a human; this table is what the
-- code reads. If they ever disagree, THE TABLE IS RIGHT and the page is stale.
-- Both say so, in both places, because two descriptions of the same fact drift
-- within a month otherwise.
--
-- ============================================================================
-- WHAT IT CHANGES
-- ============================================================================
-- resolveTrackIds partitions its findings against this table, so a decided
-- disagreement never reaches `artist_disagreements` at all. It is returned
-- separately as `known_disagreements`, for reporting only.
--
-- That means the daily task's rule - "artist_disagreements non-empty -> raise an
-- item" - stays LITERALLY UNCHANGED and becomes correct. The filtering is in the
-- tool, not the prompt: the same reasoning as spec 11.7, where a comparison left
-- to the caller fired on every collaboration.
--
-- ⚠️ NO TOOL WRITES THIS TABLE. Rows are inserted by hand, reviewed, like
-- migration 007. A decision to stop being told about something should be
-- deliberate, and a tool that could silence its own alarms is the wrong shape.

create table if not exists public.dj_known_disagreements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  -- The pair as it appears in the report. Recorded so a CHANGED disagreement on
  -- the same video still notifies: if the submitted artist becomes something
  -- other than what was decided, that is new information, not the decided case.
  stored_artist text,
  submitted_artist text,
  -- Not optional in practice. An entry without a reason is an unexplained
  -- exemption, which launders "we never looked at it" into "we decided".
  reason text not null,
  decided_at timestamptz not null default now(),
  decided_by text not null default 'alex',
  created_at timestamptz not null default now(),
  unique (user_id, video_id, stored_artist, submitted_artist)
);

comment on table public.dj_known_disagreements is
  'Artist disagreements that have been DECIDED and must stop notifying. '
  'AUTHORITATIVE; docs/dj-known-disagreements.md is a human rendering of it and '
  'is stale if the two disagree. resolveTrackIds partitions against this table, '
  'so a decided disagreement never reaches artist_disagreements - it is reported '
  'separately as known_disagreements. A table rather than a column on dj_tracks '
  'because a decision is revisable and an identity is not, and because one reason '
  'can cover many rows without being duplicated. No tool writes it: rows are '
  'inserted by hand and reviewed, because a tool that can silence its own alarms '
  'is the wrong shape.';

comment on column public.dj_known_disagreements.submitted_artist is
  'The submitted value AT THE TIME OF THE DECISION. Part of the unique key, so a '
  'DIFFERENT submitted artist on the same video is treated as a new disagreement '
  'and still notifies. Deciding "this pair is fine" must not silence "this video '
  'now reports something else entirely".';

alter table public.dj_known_disagreements enable row level security;

drop policy if exists dj_known_disagreements_owner on public.dj_known_disagreements;
create policy dj_known_disagreements_owner
  on public.dj_known_disagreements
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists dj_known_disagreements_lookup
  on public.dj_known_disagreements (user_id, video_id);

-- ---------------------------------------------------------------------------
-- SEED - the 13 decisions made on 2026-08-31 and 2026-09-01, with real reasons.
-- ---------------------------------------------------------------------------
insert into public.dj_known_disagreements
  (user_id, video_id, stored_artist, submitted_artist, reason, decided_at)
select
  t.user_id, v.video_id, v.stored_artist, v.submitted_artist, v.reason, v.decided_at
from (values
  -- ONE reason, written once, covering all twelve Release rows.
  ('V1_dIsqq_js', 'Release', null,
   'Imported from a YouTube "Release - Topic" fallback channel, which is a page label rather than an artist. 30 of the original 42 were repaired by migration 007; this one was NOT, because YouTube Music search never returned its exact video_id and guessing an artist into an insert-only match_key is worse than leaving it honestly wrong. The poll will keep submitting the CORRECT artist and insert-only will keep discarding it (spec 11.13), so this fires forever until a future repair. Do not infer the artist from the track listing - that is the reasoning that would have made "Edin" obscure jazz rather than The Smashing Pumpkins. See docs/dj-release-repair-review.md.',
   '2026-08-31'::timestamptz),
  ('uWdVOwRGDnM', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('YPC8LrLp8wQ', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('F_QWV9hk6mY', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('HJyg_8mItR4', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('2r4E1UE4Pgc', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('UEwjhZ1txmc', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('xtG3EpIiLBM', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('y8EgSUdC6rE', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('JegU7wD5ukE', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('GDzkoJoFjh8', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),
  ('paB8i2_2Q0s', 'Release', null, 'Unrepaired "Release" row - see V1_dIsqq_js for the full reason.', '2026-08-31'::timestamptz),

  -- Its own reason. Not a spelling variant.
  ('AbbzAPXvNZ8', 'Oscar Peterson', 'Oscar Peterson Trio, Clark Terry',
   'DECIDED: no alias-map entry. The alias map exists for ONE ACT SPELLED TWO WAYS - "Eddie Higgins"/"Eddie Higgins Trio", "Red Garland"/"The Red Garland Trio". This is not that: it is a specific collaboration, Oscar Peterson''s trio with Clark Terry, which is a CREDITING difference rather than a vocabulary variant. An alias entry would map every "Oscar Peterson Trio, Clark Terry" credit onto plain "Oscar Peterson", folding a Clark Terry collaboration into Oscar Peterson''s solo work. Accepted knowingly: this fires on every play of this track for as long as the row stands.',
   '2026-09-01'::timestamptz)
) as v(video_id, stored_artist, submitted_artist, reason, decided_at)
join public.dj_tracks t on t.video_id = v.video_id
on conflict (user_id, video_id, stored_artist, submitted_artist) do nothing;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.dj_known_disagreements;
  if n <> 13 then
    raise exception 'Expected 13 seeded decisions, found %. The join to dj_tracks '
      'may have missed a video_id.', n;
  end if;
  select count(*) into n from public.dj_known_disagreements where reason is null or reason = '';
  if n <> 0 then
    raise exception '% entr(ies) have no reason. An unexplained exemption launders '
      '"never looked at" into "decided".', n;
  end if;
end $$;

-- select video_id, stored_artist, submitted_artist, left(reason, 60) || '...' as reason
--   from public.dj_known_disagreements order by decided_at, video_id;
