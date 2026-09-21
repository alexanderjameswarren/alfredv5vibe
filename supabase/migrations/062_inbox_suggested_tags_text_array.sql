-- 062_inbox_suggested_tags_text_array.sql
--
-- SCHEMA CHANGE. Apply once, in order.
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
-- ---------------------------------------------------------------------------
-- THE WINDOW BETWEEN THIS AND THE DEPLOY IS COSMETIC (corrected 2026-09-21)
-- ---------------------------------------------------------------------------
--
-- This header used to say the deployed mcp function's hand-typed column list
-- would fail at request time, and that nothing should be captured in between.
-- Both were wrong, and the correction is worth keeping because the instinct
-- behind them is a good one.
--
-- The column keeps its NAME here; only its type changes. A select naming it
-- still resolves, and PostgREST serialises a text[] to the same JSON array of
-- strings a jsonb array produced. Every access to this column in the codebase
-- is a plain read or a plain JS-array write — no jsonb operator (?|, @>, ->,
-- jsonb_array_elements) touches it outside this file. Writes already send JS
-- arrays, which is how items.tags has worked since 039. Nothing writes null,
-- so the NOT NULL below is safe.
--
-- Checked individually: get_inbox reads, ai-enrich's re-enrich echo, the triage
-- UI's JSON.stringify dirty-checks, and all six write sites. Nothing breaks.
-- CAPTURING DURING THE WINDOW IS SAFE.
--
-- Two things to expect rather than fear. PostgREST's schema cache may lag a
-- request or two after the DDL (Supabase reloads it on an event trigger; it is
-- self-healing). And values come back normalised — ["Whole Foods"] reads as
-- ["whole foods"] — which makes the triage dirty-check MORE correct, since a
-- non-canonical stored tag used to leave a card permanently dirty.
--
-- Deploy promptly anyway. "Safe" is not a reason to leave two states running.


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


-- ---------------------------------------------------------------------------
-- TRIGGER GUARD -- see the note below before removing it
-- ---------------------------------------------------------------------------
--
-- `inbox` carries two user triggers: `set_updated_at` (BEFORE UPDATE, on all
-- six Alfred record tables) and the generic `audit_row` that
-- platform.register_table(p_audited => true) attaches. The ALTER TABLE
-- statements around this do not fire either -- DDL never passes existing rows
-- through a row-level trigger. THE UPDATE DOES.
--
-- Without the guard, set_updated_at would stamp now() onto every row this
-- statement touches. The inbox has a "Last modified" sort option and InboxCard
-- renders that timestamp, so the whole inbox would read as edited today --
-- visible, irreversible, and nothing to do with what actually changed. This is
-- the same guard migration 039 used, for the same reason.
--
-- 🛑 THIS CHANGE IS THEREFORE NOT AUDITED, DELIBERATELY. `DISABLE TRIGGER USER`
-- disables audit_row along with set_updated_at -- they cannot be separated at
-- this granularity. So no audit rows are written for the conversion.
--
-- That is the right trade here and it is a deliberate choice, not an oversight.
-- The audit log exists to explain changes to DATA. This statement changes a
-- representation, not a meaning: the same tags, normalised, in a different
-- column type. What actually happened is recorded here, in a numbered migration
-- that is itself the audit record, and the before/after queries in Steps 0 and
-- 3 capture the evidence either side of it. Writing one audit row per inbox row
-- would bury a real signal under a rename.
--
-- Disabled and re-enabled INSIDE the transaction, so a rollback restores them
-- automatically. Do NOT drop the triggers -- only disable and re-enable.

ALTER TABLE public.inbox DISABLE TRIGGER USER;               -- TRIGGER GUARD

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
  AND jsonb_typeof(i.suggested_tags) = 'array'
  -- ADDED 2026-09-21, and it is not merely an optimisation. The column default
  -- is '[]'::jsonb, so WITHOUT this clause the statement matches nearly every
  -- inbox row -- including every capture that never had a tag -- and rewrites
  -- it to the '{}' the new column already defaults to. 039 touched only rows
  -- that actually had tags, for exactly this reason.
  --
  -- With the trigger guard above it costs nothing visible either way; together
  -- they mean the statement writes only where there is something to write.
  --
  -- A useful side effect: this is now exactly the predicate Step 0's
  -- `rows_with_tags` counts, so that number IS the number of rows this touches.
  AND jsonb_array_length(i.suggested_tags) > 0;

ALTER TABLE public.inbox ENABLE TRIGGER USER;                -- TRIGGER GUARD


ALTER TABLE public.inbox DROP COLUMN suggested_tags;
ALTER TABLE public.inbox RENAME COLUMN suggested_tags_new TO suggested_tags;

COMMENT ON COLUMN public.inbox.suggested_tags IS
  'Tags the AI proposes for the item or intention this capture becomes. Native '
  'text[] as of migration 062, matching items.tags and intents.tags, which moved '
  'in 039. Normalised on write by normaliseTags -- never on load, because the '
  'triage UI dirty-checks this value with JSON.stringify and normalising on load '
  'produces phantom unsaved-changes prompts.';

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
