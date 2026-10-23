-- Purpose: MCP read access S5b (Alex, 2026-10-23, run tag mcp_read_gaps-t8k-s9-c3ly). After 163, searches were 2.5 to 4
-- times slower (live: four words 18 -> 49 ms, one common word 25 -> 95 ms). Cause, measured with EXPLAIN ANALYZE on a local
-- copy at live scale (350 items, 600 notes, 1500 executions): the notes arm was a correlated subquery, so notes were scanned
-- again for every item and every word (213 ms with RLS off), and under row-level security every one of those note rows also
-- ran the notes policy, which checks items, intents and item_groups under their own policies (416 ms). Without the notes
-- arm the same search took 1 ms, so neither per-word matching nor items RLS was the cost.
-- Fix: the notes that contain each word are found ONCE and mapped to item ids (the item itself, an intention's item_id, an
-- execution's item_ids), then joined. Same results as 163 (checked locally: totals agree), same signature and output.
-- Locally: four words 416 -> 7 ms, one word 162 -> 3 ms, both under RLS. No trigram index needed.
-- Kind: schema change (function body only)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Run after 163. Then run
-- supabase/tests/mcp_read_gaps/3_search_timing.sql for the after numbers. Safe to run again from the top.
-- supabase/migrations/164_mcp_search_set_based_notes.sql

begin;

create or replace function public.platform_search_items(
  p_context_id  text    default null,
  p_search_text text    default null,
  p_tags        text[]  default null,
  p_limit       integer default 20,
  p_status      text[]  default null,
  p_offset      integer default 0,
  p_archived    text    default 'exclude',
  p_no_context  boolean default false)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with words as (
    -- Words split on spaces and common punctuation, with LIKE's wildcards and escape character made literal.
    select distinct replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') as w
      from regexp_split_to_table(coalesce(p_search_text, ''), '[\s,;:.!?()\[\]{}"]+') as w
     where w <> ''
  ),
  note_hits as materialized (
    -- Each word's notes, read once (under the notes policy once per note, not once per item).
    select wd.w, n.target_type, n.target_id, n.execution_id
      from words wd
      join notes n on n.body ilike '%' || wd.w || '%'
  ),
  note_items as materialized (
    -- The items those notes belong to: on the item, on one of its intentions, or on an execution that carried it.
    select h.w, h.target_id as item_id from note_hits h where h.target_type = 'item'
    union
    select h.w, t.item_id
      from note_hits h join intents t on h.target_type = 'intention' and t.id = h.target_id
     where t.item_id is not null
    union
    select h.w, e.item_id
      from note_hits h
      join executions x on x.id = h.execution_id
     cross join lateral jsonb_array_elements_text(x.item_ids) as e(item_id)
  ),
  filtered as (
    select i.id, i.name, i.description, i.context_id, i.tags, i.is_capture_target,
           i.created_at, i.status, i.closed_reason, i.last_completed_at, i.archived,
           (exists (select 1 from words)
            and not exists (select 1 from words wd where not (i.name ilike '%' || wd.w || '%'))) as name_match
      from items i
     where (case coalesce(p_archived, 'exclude')
              when 'include' then true
              when 'only'    then coalesce(i.archived, false)
              else not coalesce(i.archived, false)
            end)
       and (p_context_id is null or i.context_id = p_context_id)
       and (not coalesce(p_no_context, false) or i.context_id is null)
       and (p_tags is null or array_length(p_tags, 1) is null or i.tags && p_tags)
       and (p_status is null or array_length(p_status, 1) is null or i.status = any(p_status))
       and not exists (
             select 1 from words wd
              where not (
                i.name ilike '%' || wd.w || '%'
                or coalesce(i.description, '') ilike '%' || wd.w || '%'
                or exists (select 1 from note_items ni where ni.w = wd.w and ni.item_id = i.id)))
  ),
  page as (
    select * from filtered
     order by name_match desc, name, id
     limit greatest(coalesce(p_limit, 20), 0) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'rows', coalesce(
      (select jsonb_agg(jsonb_build_object(
                'id', p.id, 'name', p.name, 'description', p.description, 'context_id', p.context_id,
                'tags', p.tags, 'is_capture_target', p.is_capture_target, 'created_at', p.created_at,
                'status', p.status, 'closed_reason', p.closed_reason, 'last_completed_at', p.last_completed_at,
                'archived', p.archived)
              order by p.name_match desc, p.name, p.id)
         from page p),
      '[]'::jsonb),
    'total', (select count(*) from filtered)
  );
$$;

comment on function public.platform_search_items(text, text, text[], integer, text[], integer, text, boolean) is
  'Alfred: the reader behind get_items and search_items. Items the caller can see (RLS: own, or in a shared context), filtered by context (or no context), archived (exclude, include, only), tags (any-of), status (any-of) and search text before the page window. Search text is split into words; every word must appear in the name, the description, or a note on the item, its intentions or its executions; %, _ and \ match literally. Notes are matched once per word and mapped to items (migration 164), not re-scanned per item. Rows whose name holds every word come first, then by name. Returns { rows, total }. Security invoker.';

-- create or replace keeps the grants from 163; restated so this file stands alone (Rule 2b).
revoke all on function public.platform_search_items(text, text, text[], integer, text[], integer, text, boolean) from public, anon;
grant execute on function public.platform_search_items(text, text, text[], integer, text[], integer, text, boolean)
  to authenticated, service_role;

commit;

-- ============================================================================
-- Result: expect conformance CONFORMANT and search_finds_style_item true.
-- ============================================================================
select json_build_object(
  'conformance', platform.check_conformance(),
  'search_finds_style_item', (
    select coalesce(bool_or(r->>'name' = 'Alfred-wide style consistency and design contract'), false)
      from jsonb_array_elements(
             public.platform_search_items(p_search_text => 'style consistency design contract', p_limit => 50)->'rows') r),
  'function_is_invoker', (select not prosecdef from pg_proc
                           where oid = 'public.platform_search_items(text, text, text[], integer, text[], integer, text, boolean)'::regprocedure)
) as result;
