-- SAM pass counter
-- One row per completed playthrough of a song or a snippet.
-- Run this in the Supabase SQL editor BEFORE any CLI work on the app code.
-- Ends with platform.register_table() per the platform contract.

create table if not exists public.sam_passes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id),
  song_id      uuid not null references public.sam_songs(id) on delete cascade,
  snippet_id   uuid references public.sam_snippets(id) on delete cascade,
  session_id   uuid references public.sam_sessions(id) on delete set null,
  bpm          integer,
  completed_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

comment on table public.sam_passes is
  'SAM. One completed playthrough of a song (snippet_id null) or a snippet (snippet_id set). Append-only. A row exists only when playback reached the final measure of the loaded range, having started at the first measure of that range, without a stop or reset in between. Looped playback writes one row per cycle.';

comment on column public.sam_passes.snippet_id is
  'NULL means the pass was the whole song. A whole-song pass never credits the snippets inside it.';

comment on column public.sam_passes.session_id is
  'The practice sitting this pass belonged to, when known. Nullable and ON DELETE SET NULL so pass history survives session cleanup.';

comment on column public.sam_passes.bpm is
  'Playback tempo in force at the instant the pass completed. If tempo changed mid-pass, this is the tempo at the finish line, not the start.';

comment on column public.sam_passes.completed_at is
  'Instant the final measure was crossed. Bucketing into "today" happens in the app at local midnight, matching however Today minutes already buckets.';

create index if not exists idx_passes_song_completed
  on public.sam_passes (song_id, completed_at desc);

create index if not exists idx_passes_snippet_completed
  on public.sam_passes (snippet_id, completed_at desc);

select platform.register_table(
  'public.sam_passes',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'SAM: completed playthroughs of a song or snippet'
);
