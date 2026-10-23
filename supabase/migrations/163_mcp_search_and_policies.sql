-- Purpose: MCP read access S5 (Alex, 2026-10-23, run tag mcp_read_gaps-t8k-s8-q9rn; spec docs/technical-spec-mcp-read-access.md, decisions 4, 11 and 12, Part B.4). Four things:
--   1. platform_search_items, the reader behind get_items and (now) search_items, matches each word of the search text
--      separately against the name, the description and the item's notes (on the item, its intentions and its
--      executions), so "style consistency design contract" finds "Alfred-wide style consistency and design contract".
--      Words split on spaces and common punctuation; %, _ and \ are matched literally. Rows whose name holds every word sort first. New p_offset, p_archived
--      (exclude, include, only) and p_no_context. It is no longer SECURITY DEFINER and has no user_id filter: RLS decides,
--      so items in shared contexts appear as they do in the app.
--   2. The items, intents, contexts and notes policies call (select auth.uid()), evaluated once per query instead of once
--      per row. Same rules, same names, same roles.
--   3. A GIN index on executions.item_ids, which the notes arm of the search reads with ?.
--   4. Explicit grants on the new function (Rule 2b).
-- Kind: schema change
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Run after 162. Time it with
-- supabase/tests/mcp_read_gaps/3_search_timing.sql before and after. Safe to run again from the top.
-- The only caller of platform_search_items is get_items in mcp/index.ts (checked 2026-10-23); the old five-argument call
-- shape still works, every new parameter has a default.
-- supabase/migrations/163_mcp_search_and_policies.sql

begin;

-- ============================================================================
-- 1. platform_search_items
-- ============================================================================
drop function if exists public.platform_search_items(text, text, text[], integer, text[]);

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
    -- Null when there is no search text.
    select array_agg(replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')) as ws
      from regexp_split_to_table(coalesce(p_search_text, ''), '[\s,;:.!?()\[\]{}"]+') as w
     where w <> ''
  ),
  filtered as (
    select i.id, i.name, i.description, i.context_id, i.tags, i.is_capture_target,
           i.created_at, i.status, i.closed_reason, i.last_completed_at, i.archived,
           coalesce((select bool_and(i.name ilike '%' || w || '%') from unnest((select ws from words)) as w), false)
             as name_match
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
       and ((select ws from words) is null
            or not exists (
                 select 1 from unnest((select ws from words)) as w
                  where not (
                    i.name ilike '%' || w || '%'
                    or coalesce(i.description, '') ilike '%' || w || '%'
                    or exists (select 1 from notes n
                                where n.body ilike '%' || w || '%'
                                  and ((n.target_type = 'item' and n.target_id = i.id)
                                       or (n.target_type = 'intention'
                                           and n.target_id in (select t.id from intents t where t.item_id = i.id))
                                       or n.execution_id in (select x.id from executions x where x.item_ids ? i.id))))))
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
  'Alfred: the reader behind get_items and search_items. Items the caller can see (RLS: own, or in a shared context), filtered by context (or no context), archived (exclude, include, only), tags (any-of), status (any-of) and search text before the page window. Search text is split into words; every word must appear in the name, the description, or a note on the item, its intentions or its executions; %, _ and \ match literally. Rows whose name holds every word come first, then by name. Returns { rows, total } with status, closed_reason and last_completed_at. Security invoker since migration 163.';

revoke all on function public.platform_search_items(text, text, text[], integer, text[], integer, text, boolean) from public, anon;
grant execute on function public.platform_search_items(text, text, text[], integer, text[], integer, text, boolean)
  to authenticated, service_role;

-- ============================================================================
-- 2. Policies: (select auth.uid()) once per query
-- ============================================================================
alter policy items_access on public.items
  using (
    (user_id = (select auth.uid()))
    or ((context_id is not null) and (context_id in (select contexts.id from public.contexts where contexts.shared = true))))
  with check (
    (user_id = (select auth.uid()))
    or ((context_id is not null) and (context_id in (select contexts.id from public.contexts where contexts.shared = true))));

alter policy intents_access on public.intents
  using (
    (user_id = (select auth.uid()))
    or (context_id in (select contexts.id from public.contexts where contexts.shared = true)))
  with check (
    (user_id = (select auth.uid()))
    or (context_id in (select contexts.id from public.contexts where contexts.shared = true)));

alter policy contexts_access on public.contexts
  using ((user_id = (select auth.uid())) or (shared = true));

alter policy notes_delete on public.notes
  using (user_id = (select auth.uid()));

alter policy notes_insert on public.notes
  with check (
    (user_id = (select auth.uid()))
    and (((target_type = 'item') and exists (select 1 from public.items i
                                              where i.id = notes.target_id and coalesce(i.archived, false) = false))
         or ((target_type = 'intention') and exists (select 1 from public.intents t
                                                      where t.id = notes.target_id and coalesce(t.archived, false) = false))
         or ((target_type = 'group') and exists (select 1 from public.item_groups g
                                                  where g.id = notes.target_id and g.archived = false)))
    and ((execution_id is null) or exists (select 1 from public.executions x where x.id = notes.execution_id)));

alter policy notes_update on public.notes
  using (user_id = (select auth.uid()))
  with check (
    (user_id = (select auth.uid()))
    and (((target_type = 'item') and exists (select 1 from public.items i where i.id = notes.target_id))
         or ((target_type = 'intention') and exists (select 1 from public.intents t where t.id = notes.target_id))
         or ((target_type = 'group') and exists (select 1 from public.item_groups g where g.id = notes.target_id))));

-- ============================================================================
-- 3. GIN index for item_ids ? id
-- ============================================================================
create index if not exists idx_executions_item_ids on public.executions using gin (item_ids);

commit;

-- ============================================================================
-- Result: expect conformance CONFORMANT, search_finds_style_item true, policies_with_bare_uid [].
-- ============================================================================
select json_build_object(
  'conformance', platform.check_conformance(),
  'search_finds_style_item', (
    select coalesce(bool_or(r->>'name' = 'Alfred-wide style consistency and design contract'), false)
      from jsonb_array_elements(
             public.platform_search_items(p_search_text => 'style consistency design contract', p_limit => 50)->'rows') r),
  'policies_with_bare_uid', (select coalesce(json_agg(t), '[]'::json) from (
      select tablename, policyname from pg_policies
       where schemaname = 'public' and tablename in ('items', 'intents', 'contexts', 'notes')
         and (coalesce(qual, '') ~ '(?<!SELECT )auth\.uid\(\)' or coalesce(with_check, '') ~ '(?<!SELECT )auth\.uid\(\)')
       order by 1, 2) t),
  'function_is_invoker', (select not prosecdef from pg_proc
                           where oid = 'public.platform_search_items(text, text, text[], integer, text[], integer, text, boolean)'::regprocedure),
  'gin_index', (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'idx_executions_item_ids')
) as result;
