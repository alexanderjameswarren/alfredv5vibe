-- 069_phase3_intents_description.sql
--
-- SCHEMA CHANGE. Apply once, in order.
--
-- Alfred Clipboard, Phase 3 Step 16: `intents.description`, the long-text field
-- the inbox detail page calls "Details".
--
-- Design: docs/inbox-detail-mockups/README.md, section 6 — the New Intention
-- section has "Name, Details (a long-text description, new), and When".
--
-- ---------------------------------------------------------------------------
-- CHECKED FIRST: THERE IS NO SUITABLE EXISTING COLUMN
-- ---------------------------------------------------------------------------
--
-- public.intents has sixteen columns and not one of them holds prose:
--
--   text               the intention's NAME. Short, NOT NULL, and what every
--                      list, planner row and event label renders. It is the one
--                      candidate and it is the wrong one: widening it into "name
--                      or possibly name plus paragraphs" would put arbitrary
--                      length into every place an intention is displayed.
--   recurrence_config  jsonb, and a schedule definition
--   target_start_date  a date
--   end_date           a date
--   tags               text[]
--   item_id            a pointer to the reusable item behind the intention
--   collection_id      a pointer to a collection
--
-- The item side of the same form already has what is wanted: `items.description`,
-- text, nullable. Intentions simply never had one, because until now the only way
-- to create one was a single-line box.
--
-- ---------------------------------------------------------------------------
-- WHY `description` AND NOT `details`
-- ---------------------------------------------------------------------------
--
-- The mockup labels the field "Details", and naming the column to match is the
-- obvious move. It is the wrong one: `items.description` already exists and holds
-- exactly the same kind of content in exactly the same position on the same form.
-- Two tables with one concept under two names costs every future reader a lookup,
-- and every shared helper a translation.
--
-- So the column is `description` and the LABEL stays "Details". A UI label exists
-- to read well in one place; a column name exists to be recognised everywhere.


-- ============================================================
-- STEP 0 -- BEFORE PICTURE
-- ============================================================
--
-- Records that there was nothing to reuse, so the next person does not have to
-- take that on trust.

select json_build_object(
  'intents_columns_today', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable
      from pg_attribute a
      where a.attrelid = 'public.intents'::regclass
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    ) t),
  'any_existing_long_text_candidate', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name
      from pg_attribute a
      where a.attrelid = 'public.intents'::regclass
        and a.attnum > 0 and not a.attisdropped
        and format_type(a.atttypid, a.atttypmod) = 'text'
      order by a.attname
    ) t),
  'items_description_for_comparison', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable
      from pg_attribute a
      where a.attrelid = 'public.items'::regclass and a.attname = 'description'
        and not a.attisdropped
    ) t),
  'intents_rows', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as total,
             count(*) filter (where archived is not true) as live
      from public.intents
    ) t)
) as result;


-- ============================================================
-- STEP 1 -- the column
-- ============================================================
--
-- Nullable with no default, matching items.description. NOT NULL DEFAULT '' was
-- considered and rejected: it would make "no details written" and "details
-- deliberately emptied" indistinguishable, and every reader would then have to
-- treat '' and null as the same thing anyway.

alter table public.intents
  add column if not exists description text;

comment on column public.intents.description is
  'Long-form notes about the intention — the how, the why, the context that does '
  'not belong in its name. Null when none were written. '
  'LABELLED "Details" IN THE UI (the inbox detail page''s New Intention section), '
  'but named `description` to match items.description, which holds the same kind '
  'of content in the same position on the same form. One concept under two names '
  'would cost every future reader a lookup. '
  '⚠️ NOT the intention''s name — that is `text`, which is NOT NULL and is what '
  'every list, planner row and event label renders. Keep prose out of it: `text` '
  'appears in places with no room for a paragraph. '
  'Added by migration 069 for the Phase 3 inbox detail page; every row predating '
  'it is null, and nothing infers a description from anything else.';


-- ============================================================
-- STEP 2 -- conformance. MUST still say CONFORMANT.
-- ============================================================
--
-- No register_table call: public.intents was registered on 2026-07-24 and adding
-- a column does not re-register a table. This is here because the contract says
-- every migration that touches schema ends with the check.

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
      where a.attrelid = 'public.intents'::regclass
        and a.attname = 'description'
        and not a.attisdropped
    ) t),
  -- Nothing is backfilled and nothing should be: an intention's name is not its
  -- description, and copying one into the other would invent content.
  'all_null_as_expected', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) filter (where description is not null) as with_description,
             count(*) as total
      from public.intents
    ) t),
  'conformance', (select coalesce(json_agg(t), '[]'::json) from (
      select public.platform_check_conformance() as report
    ) t)
) as result;
