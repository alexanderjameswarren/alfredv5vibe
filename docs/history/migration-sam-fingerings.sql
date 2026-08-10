-- SAM: RH fingering cues
-- Run in the Supabase SQL editor BEFORE any CLI/TypeScript work.
-- Ends with platform.register_table(); follow with check_platform_conformance.

create table if not exists public.sam_song_fingerings (
  id          uuid primary key default gen_random_uuid(),
  song_id     uuid not null references public.sam_songs(id) on delete cascade,
  measure_num integer not null,
  rh_index    integer not null,
  note_index  integer not null default 0,
  finger      smallint not null check (finger between 1 and 5),
  source      text not null default 'manual' check (source in ('manual', 'musicxml')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

comment on table public.sam_song_fingerings is
  'SAM. One row per fingering cue, mapped onto right-hand notation events the same way '
  'sam_song_lyrics maps syllables. Scoped to song_id only — fingerings do NOT follow a '
  'song across re-import, and flattened repeats are marked independently. RLS inherited '
  'via the parent song.';

comment on column public.sam_song_fingerings.rh_index is
  'Index into sam_song_measures.rh — which notation event this fingering sits on.';

comment on column public.sam_song_fingerings.note_index is
  'Index into the event''s noteheads, low pitch to high. 0 for single-note events.';

comment on column public.sam_song_fingerings.finger is
  'Right-hand finger number, 1 (thumb) through 5 (little finger).';

comment on column public.sam_song_fingerings.source is
  'manual = entered in the edit screen. musicxml = seeded from <technical><fingering> at '
  'import. Both may exist on one notehead; manual always wins at render.';

-- Manual and imported fingerings coexist on the same notehead.
create unique index if not exists sam_song_fingerings_coord_source_key
  on public.sam_song_fingerings (song_id, measure_num, rh_index, note_index, source);

-- Primary read path: all fingerings for a song, ordered for render.
create index if not exists idx_song_fingerings_song_measure
  on public.sam_song_fingerings (song_id, measure_num, rh_index);

-- Per-song visibility toggle for imported fingerings.
-- sam_songs is already registered; adding a column needs no re-registration.
alter table public.sam_songs
  add column if not exists show_imported_fingerings boolean not null default false;

comment on column public.sam_songs.show_imported_fingerings is
  'When false (default), fingerings with source=''musicxml'' are hidden. Manual fingerings '
  'always render.';

-- Registration. policy_mode => 'none' because this table has no user_id column —
-- ownership is reached through the parent song, same as sam_song_lyrics and
-- sam_song_measures. register_table still enables RLS, issues grants, and attaches
-- the audit trigger; the policy itself is ours to write, immediately below.
select platform.register_table(
  'public.sam_song_fingerings',
  p_policy_mode => 'none',
  p_notes       => 'SAM: RLS via parent song'
);

create policy "Users see own song fingerings"
  on public.sam_song_fingerings
  for all
  using (
    exists (
      select 1 from public.sam_songs
      where sam_songs.id = sam_song_fingerings.song_id
        and sam_songs.user_id = auth.uid()
    )
  );
