-- Purpose: Homer data repair (homer-h4k, s17). create_homer_book made a second "Street Cultivation" series
-- (9c446b9a…) when books 2 and 3 were added by name only; the real series is f7ef6cb1… (series_asin B086YRRJ97,
-- which holds book 1, B07W9J75R3). Move the two books back, then delete the stray series if nothing else uses it.
-- Kind: data repair, applied once. 2 rows updated in homer_books, 1 row deleted from homer_series. No schema change.
-- Applied: NO
--
-- The delete is guarded: verdicts, taste profiles and genre links CASCADE on a series delete, and books and queue
-- items are set null, so it runs only when none of them references the stray series. Triggers on both tables are
-- only updated_at and the audit trigger. The tool bug is fixed in create_homer_book (s17).
-- supabase/migrations/232_fix_street_cultivation_series.sql

begin;

update public.homer_books
   set series_id = 'f7ef6cb1-ed94-4d5a-86f7-51810136e73b'
 where asin in ('B086Q8ZGTD', 'B08NFJWWBF')
   and series_id = '9c446b9a-84a9-4208-b5c0-1c75b0a241b3';

delete from public.homer_series s
 where s.id = '9c446b9a-84a9-4208-b5c0-1c75b0a241b3'
   and not exists (select 1 from public.homer_books b where b.series_id = s.id)
   and not exists (select 1 from public.homer_verdicts v where v.series_id = s.id)
   and not exists (select 1 from public.homer_genre_series g where g.series_id = s.id)
   and not exists (select 1 from public.homer_queue_items q where q.series_id = s.id)
   and not exists (select 1 from public.homer_taste_profiles t where t.series_id = s.id);

commit;
