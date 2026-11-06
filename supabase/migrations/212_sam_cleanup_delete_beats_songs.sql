-- Purpose: sam_cleanup-m4t s4b2b. Delete the 8 archived "Someone Like You" copies (created 2026-02-14/15), the only
-- stored songs whose measures still use the legacy beats[] format, so s4c can remove the beats[] render path.
-- Removes 134 sam_session_events, then 12 sam_sessions (both NO ACTION on the song), then 8 sam_songs. Their 64
-- sam_song_measures and 8 sam_snippets go by cascade; they have no passes, goals, plan rows or child songs.
-- Every delete is limited to the 8 ids that are still archived and titled 'Someone Like You'.
-- Rehearsed by supabase/tests/sam_cleanup-m4t/1_beats_songs_counts_test.sql (action f7acd900, ok).
-- Kind: one-off data repair (three deletes: 134, 12, 8 rows expected)
-- Applied: NO
-- supabase/migrations/212_sam_cleanup_delete_beats_songs.sql

begin;

delete from public.sam_session_events
 where song_id in (
         select id from public.sam_songs
          where id in ('6d2b5206-8f04-4ec4-abf4-8122383b927a', '179dd081-1575-42c2-89a9-7b05d927aa93',
                       '10856805-6e74-412e-9398-ac6a2f471156', 'ee14dee1-c783-4277-ab9b-e19ff5e5fdf9',
                       '1a39dad3-30a8-4da7-bcc7-5446614cb7ea', '032f4a21-2a5e-496b-ae1d-6c128c88ce79',
                       '311de635-9df6-4bde-af39-c07290b031fa', 'e6013004-9d75-458f-9d27-3b42776538d6')
            and archived and title = 'Someone Like You')
    or session_id in (
         select id from public.sam_sessions
          where song_id in (
                  select id from public.sam_songs
                   where id in ('6d2b5206-8f04-4ec4-abf4-8122383b927a', '179dd081-1575-42c2-89a9-7b05d927aa93',
                                '10856805-6e74-412e-9398-ac6a2f471156', 'ee14dee1-c783-4277-ab9b-e19ff5e5fdf9',
                                '1a39dad3-30a8-4da7-bcc7-5446614cb7ea', '032f4a21-2a5e-496b-ae1d-6c128c88ce79',
                                '311de635-9df6-4bde-af39-c07290b031fa', 'e6013004-9d75-458f-9d27-3b42776538d6')
                     and archived and title = 'Someone Like You'));

delete from public.sam_sessions
 where song_id in (
         select id from public.sam_songs
          where id in ('6d2b5206-8f04-4ec4-abf4-8122383b927a', '179dd081-1575-42c2-89a9-7b05d927aa93',
                       '10856805-6e74-412e-9398-ac6a2f471156', 'ee14dee1-c783-4277-ab9b-e19ff5e5fdf9',
                       '1a39dad3-30a8-4da7-bcc7-5446614cb7ea', '032f4a21-2a5e-496b-ae1d-6c128c88ce79',
                       '311de635-9df6-4bde-af39-c07290b031fa', 'e6013004-9d75-458f-9d27-3b42776538d6')
            and archived and title = 'Someone Like You');

delete from public.sam_songs
 where id in ('6d2b5206-8f04-4ec4-abf4-8122383b927a', '179dd081-1575-42c2-89a9-7b05d927aa93',
              '10856805-6e74-412e-9398-ac6a2f471156', 'ee14dee1-c783-4277-ab9b-e19ff5e5fdf9',
              '1a39dad3-30a8-4da7-bcc7-5446614cb7ea', '032f4a21-2a5e-496b-ae1d-6c128c88ce79',
              '311de635-9df6-4bde-af39-c07290b031fa', 'e6013004-9d75-458f-9d27-3b42776538d6')
   and archived
   and title = 'Someone Like You';

commit;
