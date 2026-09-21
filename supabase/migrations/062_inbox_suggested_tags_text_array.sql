-- 040_inbox_suggested_tags_text_array.sql
--
-- Hard cutover: inbox.suggested_tags jsonb -> text[]
-- Brings the inbox into line with items.tags and intents.tags, which moved to
-- native text[] in migration 039.
--
-- Existing values are normalised on the way through, mirroring normaliseTag in
-- src/utils/tags.js and supabase/functions/_shared/tags.ts.
--
-- ONE KNOWN DIVERGENCE: the JavaScript version uses Unicode property classes
-- (\p{L}, \p{N}). Postgres regex has no equivalent, so this uses [[:alnum:]],
-- which under a UTF-8 collation handles accented letters correctly. Acceptable
-- for a one-time pass over staging data; the JS rule remains authoritative for
-- everything written from here on.
--
-- The normaliser is a pg_temp function and dies with this session, so it does
-- not become a permanent third copy of the rule.
--
-- RUN THIS, THEN DEPLOY THE EDGE FUNCTIONS IMMEDIATELY. Between the two, the
-- deployed mcp function's hand-typed column list at index.ts:334 will fail at
-- request time. Do not capture anything to the inbox in that window.


-- ============================================================
-- STEP 0 -- BEFORE PICTURE. Run on its own first.
-- ============================================================

select json_build_object(
  'column_type', (select coalesce(json_agg(t), '[]'::json) from (
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inbox'
        and column_name = 'suggested_tags'
    ) t),
  'rows_with_tags', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as total,
             count(*) filter (where triaged_at is null) as untriaged
      from inbox
      where suggested_tags is not null
        and jsonb_typeof(suggested_tags) = 'array'
        and jsonb_array_length(suggested_tags) > 0
    ) t),
  'distinct_tag_values', (select coalesce(json_agg(t), '[]'::json) from (
      select tag, count(*) as uses
      from inbox, jsonb_array_elements_text(suggested_tags) as tag
      where jsonb_typeof(suggested_tags) = 'array'
      group by tag order by tag
    ) t)
) as result;


-- ============================================================
-- STEP 1 -- THE MIGRATION
-- ============================================================

BEGIN;

CREATE FUNCTION pg_temp.normalise_tag(raw text) RETURNS text AS $$
  SELECT left(
    btrim(
      regexp_replace(                                  -- collapse whitespace
        regexp_replace(                                -- fold - and _ to space
          regexp_replace(                              -- strip other punctuation
            regexp_replace(lower($1), '[''’]', '', 'g'),  -- delete apostrophes
            '[^[:alnum:] _-]', ' ', 'g'),
          '[-_]', ' ', 'g'),
        '[[:space:]]+', ' ', 'g')
    ), 50)
$$ LANGUAGE sql IMMUTABLE;


ALTER TABLE public.inbox
  ADD COLUMN suggested_tags_new text[] NOT NULL DEFAULT '{}';


-- Normalise, drop empties, dedupe first-occurrence-wins, preserve order,
-- cap at 20 -- exactly what normaliseTags does.
UPDATE public.inbox i
SET suggested_tags_new = COALESCE((
  SELECT array_agg(d.tag ORDER BY d.ord)
  FROM (
    SELECT c.tag, min(c.ord) AS ord
    FROM (
      SELECT pg_temp.normalise_tag(elem) AS tag, ord
      FROM jsonb_array_elements_text(i.suggested_tags)
           WITH ORDINALITY AS t(elem, ord)
    ) c
    WHERE c.tag <> ''
    GROUP BY c.tag
    ORDER BY min(c.ord)
    LIMIT 20
  ) d
), '{}'::text[])
WHERE i.suggested_tags IS NOT NULL
  AND jsonb_typeof(i.suggested_tags) = 'array';


ALTER TABLE public.inbox DROP COLUMN suggested_tags;
ALTER TABLE public.inbox RENAME COLUMN suggested_tags_new TO suggested_tags;

COMMENT ON COLUMN public.inbox.suggested_tags IS
  'Tags the AI proposes for the item or intention this capture becomes. Native '
  'text[] as of migration 040, matching items.tags and intents.tags. Normalised '
  'on write by normaliseTags -- never on load, because the triage UI dirty-checks '
  'this value with JSON.stringify and normalising on load produces phantom '
  'unsaved-changes prompts.';

COMMIT;


-- ============================================================
-- STEP 2 -- CONFORMANCE. Run on its own, not bundled.
-- ============================================================

select check_platform_conformance();


-- ============================================================
-- STEP 3 -- AFTER PICTURE. Compare against Step 0.
-- ============================================================

select json_build_object(
  'column_type', (select coalesce(json_agg(t), '[]'::json) from (
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inbox'
        and column_name = 'suggested_tags'
    ) t),
  'rows_with_tags', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as total,
             count(*) filter (where triaged_at is null) as untriaged
      from inbox
      where cardinality(suggested_tags) > 0
    ) t),
  'distinct_tag_values', (select coalesce(json_agg(t), '[]'::json) from (
      select unnest(suggested_tags) as tag, count(*) as uses
      from inbox group by 1 order by 1
    ) t)
) as result;
