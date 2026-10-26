-- Overwatch Step 4 verification. Read-only. Run after the clips run_tag migration, and again after clip-capture is
-- redeployed and one fresh CLI report and one Chrome clip have been pushed. Paste back the single result cell.
-- supabase/tests/overwatch-q4n/1_verify_clips_run_tag.sql

select json_build_object(
  'new_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             col_description(a.attrelid, a.attnum) is not null as has_comment
        from pg_attribute a
       where a.attrelid = 'public.clips'::regclass
         and a.attname in ('run_tag', 'repo', 'branch')
         and not a.attisdropped
       order by a.attname
    ) t),
  'check_and_index', (select coalesce(json_agg(t), '[]'::json) from (
      select 'constraint' as kind, conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = 'public.clips'::regclass and conname = 'clips_run_tag_format'
      union all
      select 'index', indexname, indexdef
        from pg_indexes
       where schemaname = 'public' and tablename = 'clips' and indexname = 'clips_run_tag_idx'
    ) t),
  -- Every tag the inbox holds should now be on its clip. Expect 0.
  'inbox_tags_not_on_clip', (select coalesce(json_agg(t), '[]'::json) from (
      select c.id as clip_id, i.source_metadata->>'run_tag' as inbox_run_tag
        from public.clips c
        join public.inbox i on i.id = c.inbox_id or i.source_metadata->>'clip_id' = c.id::text
       where i.source_metadata->>'run_tag' is not null
         and c.run_tag is distinct from i.source_metadata->>'run_tag'
       limit 20
    ) t),
  -- The newest five clips: after the redeploy, a fresh CLI push has all three set and a Chrome clip has none.
  'newest_clips', (select coalesce(json_agg(t), '[]'::json) from (
      select id, source, created_at, run_tag, repo, branch
        from public.clips
       order by created_at desc
       limit 5
    ) t),
  -- The prefix search the index is for.
  'overwatch_reports', (select coalesce(json_agg(t), '[]'::json) from (
      select run_tag, created_at
        from public.clips
       where run_tag like 'overwatch-q4n-%'
       order by created_at
    ) t),
  'conformance', (select public.platform_check_conformance())
) as result;
