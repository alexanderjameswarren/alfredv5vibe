-- 070_inbox_suggested_intent_description.sql
--
-- SCHEMA CHANGE. Apply once, in order.
--
-- `inbox.suggested_intent_description`: the enrichment's suggestion for the
-- intention's Details field. `inbox.suggested_item_description` already does this
-- for the item half of the same form; the intention half had no equivalent, so
-- computeBaseline hard-coded the Details box to empty.


-- ============================================================
-- STEP 0 -- BEFORE PICTURE.
-- ============================================================

select json_build_object(
  'suggested_intent_columns_now', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable
      from pg_attribute a
      where a.attrelid = 'public.inbox'::regclass
        and a.attname like 'suggested_%'
        and not a.attisdropped
      order by a.attname
    ) t)
) as result;


-- ============================================================
-- STEP 1 -- the column.
-- ============================================================
--
-- Nullable with no default, matching suggested_item_description: an unenriched
-- row and an enrichment that deliberately left Details empty must stay
-- distinguishable.

alter table public.inbox
  add column if not exists suggested_intent_description text;

comment on column public.inbox.suggested_intent_description is
  'Enrichment''s suggested Details for the intention — what the capture said '
  'beyond the intention''s name (the number to call, the reason, the constraint). '
  'Pre-fills the New Intention "Details" box on the inbox detail page and is '
  'written to intents.description when the capture is processed. '
  'Null when the enrichment suggested none, and null on every row predating '
  'migration 070. Nothing infers it from captured_text at read time. '
  '⚠️ NOT the intention''s name — that is suggested_intent_text.';


-- ============================================================
-- STEP 2 -- conformance. MUST still say CONFORMANT.
-- ============================================================
--
-- No register_table call: public.inbox is already registered, and adding a
-- column does not re-register a table.

select public.platform_check_conformance();


-- ============================================================
-- STEP 3 -- AFTER PICTURE. Compare against Step 0.
-- ============================================================

select json_build_object(
  'new_column', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable,
             pg_get_expr(d.adbin, d.adrelid) as column_default,
             col_description(a.attrelid, a.attnum) as comment
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.inbox'::regclass
        and a.attname = 'suggested_intent_description'
        and not a.attisdropped
    ) t),
  -- Nothing is backfilled: no existing enrichment wrote Details, and copying
  -- suggested_intent_text into it would invent content.
  'all_null_as_expected', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) filter (where suggested_intent_description is not null) as with_description,
             count(*) as total
      from public.inbox
    ) t),
  'conformance', (select coalesce(json_agg(t), '[]'::json) from (
      select public.platform_check_conformance() as report
    ) t)
) as result;
