-- MOVED 2026-09-18 from docs/migrations/migration-a-tags.sql
-- Originally written 2026-09-14. Content unchanged below this header.
-- Purpose: Tags migration A: tags become text[], hyphens and underscores fold to spaces, contexts.tags dropped, platform_search_items uses &&.
-- Kind: schema change + data conversion
-- Applied: YES — items.tags is text[] with a gin index
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- ===========================================================================
-- MIGRATION A — tags become text[], hyphens and underscores fold to spaces,
--               contexts.tags is dropped, platform_search_items uses &&
--
-- Project:   docs/technical-spec-tags.md §6 (as amended 2026-09-14)
-- Progress:  docs/progress-tags.md — Phase 3
-- Run:       BY HAND, in the Supabase SQL editor. Not via the CLI.
-- Written:   2026-09-14. Not run by Claude; no database was contacted.
-- ===========================================================================
--
-- ---------------------------------------------------------------------------
-- 1. TAKE A BACKUP FIRST. THIS IS NOT CLEANLY REVERSIBLE.
-- ---------------------------------------------------------------------------
--
-- This migration DROPS `items.tags`, `intents.tags` and `contexts.tags` after
-- copying converted values into replacement columns. The original jsonb values
-- are gone the moment it commits. There is no down-migration that restores
-- them, because the information needed to distinguish a tag that was always
-- "stir fry" from one that was "stir_fry" is not kept anywhere.
--
-- `contexts.tags` is dropped OUTRIGHT, with no replacement. Its two rows
-- (`home`, `remodel`) are not migrated anywhere. If you want them, copy them
-- out before running this:
--
--     select id, name, tags from contexts where jsonb_array_length(tags) > 0;
--
-- Recovering anything else means a Supabase point-in-time restore. Take the
-- backup Supabase offers on the dashboard before you start.
--
-- ---------------------------------------------------------------------------
-- 2. PREREQUISITE: Phase 2 must already be deployed. It is.
-- ---------------------------------------------------------------------------
--
-- Both Edge Functions stopped selecting `contexts.tags` and were deployed on
-- 2026-09-14 (mcp v85, ai-enrich v10). Selecting a dropped column is a hard
-- PostgREST error, so running this against the old code would have broken
-- get_contexts immediately. Nothing in the frontend reads that column either,
-- and the one place that would have WRITTEN it back (saveContextRecord) now
-- strips it.
--
-- ---------------------------------------------------------------------------
-- 3. TWO CHANGES FROM SPEC §6 AS WRITTEN — PLEASE READ BEFORE RUNNING
-- ---------------------------------------------------------------------------
--
-- (a) HYPHENS FOLD TOO. Approved after the spec was written. §6's conversion
--     only handled underscores. The JavaScript rule now folds `-` and `_`
--     alike, so the SQL must too or migrated data would not match what the
--     app produces. `translate(lower(v), '_-', '  ')` does both at once and is
--     the exact counterpart of the JS `.replace(/[-_]/g, " ")`.
--
-- (b) TWO THINGS IN §6 WERE WRONG INDEPENDENTLY OF THE HYPHEN CHANGE.
--     Both are corrected below and both are called out here rather than
--     quietly patched. Review them; neither is a judgement call I should make
--     alone.
--
--     (b1) §6 FILTERED BLANKS ON THE RAW VALUE, NOT THE CONVERTED ONE.
--          It said `where btrim(v) <> ''`. A tag of `"_"` or `"-"` or `"__"`
--          passes that test — `btrim('_')` is `'_'`, which is not empty — but
--          converts to a space and then to the EMPTY STRING, which would be
--          stored as a real element of the text[] array. You would get an
--          empty chip in the UI that matches nothing and cannot be searched
--          for. The old tag rule `/^[a-z0-9_-]+$/` permitted `"_"`, so this is
--          reachable, not theoretical. Fixed by filtering AFTER conversion.
--          The JS rule rejects these (normaliseTag returns null), so this also
--          restores equivalence between the two.
--
--     (b2) §6 DID NOT MENTION THE `set_updated_at` TRIGGER.
--          It is a BEFORE UPDATE trigger on all six Alfred tables (confirmed
--          by pg_trigger query, recorded in
--          docs/history/progress-ui-standardization.md:3988). The conversion
--          UPDATE fires it on every row it touches, which would stamp today's
--          date onto the `updated_at` of every tagged item and intention.
--
--          That is visible and irreversible: both cards show "last updated: …"
--          and "Last modified" is a sort option the same doc calls
--          "trustworthy". A migration should not make your whole library look
--          edited today.
--
--          Handled two ways below. First, the UPDATE only touches rows that
--          actually have tags, so untagged records are never stamped at all.
--          Second, user triggers are disabled for the two statements and
--          re-enabled immediately, inside the same transaction — so a rollback
--          restores them automatically.
--
--          ⚠️ If you would rather not touch triggers, delete the four lines
--          marked `TRIGGER GUARD` and accept that tagged records will show
--          today as their last-modified date. Nothing else changes.
--          Do NOT remove the trigger itself — only disable/enable it here.
--
-- ---------------------------------------------------------------------------
-- 4. ONE THING I COULD NOT VERIFY — CHECK IT YOURSELF FIRST
-- ---------------------------------------------------------------------------
--
-- The `platform_search_items` body below is reproduced from spec §6 with `?|`
-- changed to `&&`. I have no database access, so I could NOT confirm it
-- matches the live definition. If the live function differs in any other way —
-- an extra column in the select list, different parameter names or defaults —
-- then `create or replace` here would silently overwrite that behaviour, or
-- fail outright with "cannot change name of input parameter".
--
-- RUN THIS FIRST, in a separate tab, and eyeball the result against §4 below:
--
--     select pg_get_functiondef(p.oid)
--       from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'platform_search_items';
--
-- The ONLY difference you should intend to make is `tags ?| p_tags` becoming
-- `tags && p_tags`. If you see anything else, stop and tell me.
--
-- What the shape must stay: the MCP get_items tool reads `data.rows` and
-- `data.total` from this function, and deliberately excludes `elements` from
-- the row shape. That matches the body below. (Verified against
-- supabase/functions/mcp/index.ts.)
--
-- ===========================================================================


-- ===========================================================================
-- PRE-FLIGHT — run this BEFORE the migration and keep the output.
-- It is what you will compare against afterwards.
-- ===========================================================================
--
--   select tag, count(*) as n
--     from (
--       select jsonb_array_elements_text(tags) as tag from items
--       union all
--       select jsonb_array_elements_text(tags) from intents
--     ) z
--    group by tag
--    order by n desc, tag;
--
-- Expected to include the underscored forms: nervous_system, stir_fry,
-- evening_routine, middle_eastern, to_read, outdoor_maintenance, another_tag,
-- test_tag. Note the total row count — it should not change, only the spelling.


begin;

-- --- items -----------------------------------------------------------------

drop index if exists idx_items_tags;

alter table items add column tags_new text[] not null default '{}'::text[];

alter table items disable trigger user;                      -- TRIGGER GUARD

-- Only rows that actually have tags are touched; every other row keeps the
-- '{}' column default and is never written to.
--
-- Conversion, in the same order as normaliseTag() in src/utils/tags.js:
--   lower()                  -> lowercase
--   translate(…, '_-', '  ') -> underscores AND hyphens become spaces
--   regexp_replace('\s+')    -> collapse whitespace runs
--   btrim()                  -> trim
--   where tag <> ''          -> reject what did not survive  [see 3(b1)]
--   array_agg(distinct …)    -> dedupe; also sorts each record's tags, which
--                               is harmless and matches §6's note
update items i
   set tags_new = x.tags_arr
  from (
    select id, array_agg(distinct tag) as tags_arr
      from (
        select it.id,
               btrim(regexp_replace(
                 translate(lower(v.raw), '_-', '  '),
                 '\s+', ' ', 'g')) as tag
          from items it
          cross join lateral jsonb_array_elements_text(it.tags) as v(raw)
      ) f
     where tag <> ''
     group by id
  ) x
 where x.id = i.id;

alter table items enable trigger user;                       -- TRIGGER GUARD

alter table items drop column tags;
alter table items rename column tags_new to tags;

-- Mandatory, not cosmetic: a GIN index on jsonb uses jsonb_ops, one on a text
-- array uses array_ops. The type change alone does not convert the opclass.
create index idx_items_tags on items using gin (tags);


-- --- intents ---------------------------------------------------------------

drop index if exists idx_intents_tags;

alter table intents add column tags_new text[] not null default '{}'::text[];

alter table intents disable trigger user;                    -- TRIGGER GUARD

update intents i
   set tags_new = x.tags_arr
  from (
    select id, array_agg(distinct tag) as tags_arr
      from (
        select it.id,
               btrim(regexp_replace(
                 translate(lower(v.raw), '_-', '  '),
                 '\s+', ' ', 'g')) as tag
          from intents it
          cross join lateral jsonb_array_elements_text(it.tags) as v(raw)
      ) f
     where tag <> ''
     group by id
  ) x
 where x.id = i.id;

alter table intents enable trigger user;                     -- TRIGGER GUARD

alter table intents drop column tags;
alter table intents rename column tags_new to tags;

create index idx_intents_tags on intents using gin (tags);


-- --- contexts: delete the column outright ----------------------------------
--
-- Not converted, not replaced. A jsonb column with a GIN index, two rows of
-- data and no user interface — never reachable from the app. Contexts keep
-- `keywords`, which is the field that does real work during inbox triage.
-- Dropping the column drops its index too; the explicit drop is belt-and-braces.

drop index if exists idx_contexts_tags;
alter table contexts drop column tags;


-- --- the search function: ?| becomes && ------------------------------------
--
-- `?|` is the jsonb "any key exists" operator and has no meaning for text[].
-- `&&` is the array overlap operator and is the correct equivalent. This MUST
-- ship in the same transaction as the column change: between the two, the MCP
-- get_items tool's tag filter would be broken.
--
-- ⚠️ Diff this against the live definition first — see section 4 above.

create or replace function public.platform_search_items(
  p_context_id text default null,
  p_search_text text default null,
  p_tags text[] default null,
  p_limit integer default 20)
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with filtered as (
    select id, name, description, context_id, tags, is_capture_target, created_at
      from items
     where user_id = auth.uid()
       and archived = false
       and (p_context_id  is null or context_id = p_context_id)
       and (p_search_text is null or
            (name ilike '%' || p_search_text || '%' or
             description ilike '%' || p_search_text || '%'))
       and (p_tags is null
            or array_length(p_tags, 1) is null
            or tags && p_tags)
  )
  select jsonb_build_object(
    'rows',
      coalesce(
        (select jsonb_agg(row_to_json(x) order by x.name)
           from (select * from filtered order by name limit p_limit) x),
        '[]'::jsonb),
    'total',
      (select count(*) from filtered)
  );
$function$;

commit;


-- ===========================================================================
-- VERIFICATION — run every one of these AFTER the commit.
-- ===========================================================================

-- V1. The columns are text[] now, and contexts.tags is gone.
--     Expect exactly two rows, both udt_name = '_text', both default '{}'::text[].
--     `contexts` must NOT appear.
select table_name, column_name, data_type, udt_name, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and column_name = 'tags'
   and table_name in ('items', 'intents', 'contexts')
 order by table_name;

-- V2. No underscore or hyphen survives anywhere. EXPECT ZERO ROWS.
--     (Regex, not LIKE — `_` is a wildcard in LIKE and would match everything.)
select 'items' as source, tag from items, unnest(tags) as tag where tag ~ '[-_]'
union all
select 'intents', tag from intents, unnest(tags) as tag where tag ~ '[-_]';

-- V3. No empty-string tags crept in. EXPECT 0. This is the 3(b1) check.
select (select count(*) from items,   unnest(tags) as tag where tag = '') as empty_in_items,
       (select count(*) from intents, unnest(tags) as tag where tag = '') as empty_in_intents;

-- V4. The taxonomy, after. Compare against the PRE-FLIGHT output.
--     The known underscored tags must appear in spaced form:
--       nervous system · stir fry · evening routine · middle eastern
--       to read · outdoor maintenance · another tag · test tag
--     Total count of tag instances should be unchanged unless two spellings
--     merged into one on the same record (which is the point).
select tag, count(*) as n
  from (
    select unnest(tags) as tag from items
    union all
    select unnest(tags) from intents
  ) z
 group by tag
 order by n desc, tag;

-- V5. Every stored tag is canonical — i.e. round-tripping it through the rule
--     changes nothing. EXPECT ZERO ROWS. This is the strongest single check
--     that SQL and JavaScript agree.
select tag
  from (
    select unnest(tags) as tag from items
    union all
    select unnest(tags) from intents
  ) z
 where tag <> btrim(regexp_replace(translate(lower(tag), '_-', '  '), '\s+', ' ', 'g'))
    or tag = ''
    or length(tag) > 50;

-- V6. Both GIN indexes exist and use array_ops; the contexts one is gone.
--     Expect exactly two rows.
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('idx_items_tags', 'idx_intents_tags', 'idx_contexts_tags')
 order by indexname;

-- V7. The search function now uses && and not ?|.
--     Expect uses_overlap = true, uses_jsonb_any = false.
select position('tags && p_tags' in pg_get_functiondef(p.oid)) > 0 as uses_overlap,
       position('?|'             in pg_get_functiondef(p.oid)) > 0 as uses_jsonb_any
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'platform_search_items';

-- V8. The triggers are back on. EXPECT tgenabled = 'O' for every row.
--     'D' means disabled and would silently stop updated_at being maintained.
select c.relname as table_name, t.tgname, t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where c.relname in ('items', 'intents')
   and not t.tgisinternal
 order by c.relname, t.tgname;

-- V9. Spot-check from spec §6's own success criterion. Expect rows back.
select id, name, tags from items where 'nervous system' = any(tags);

-- V10. Platform conformance. NOT SQL — run the `check_platform_conformance`
--      MCP tool from a chat thread. House rules say a migration is not done
--      until it returns CONFORMANT.
