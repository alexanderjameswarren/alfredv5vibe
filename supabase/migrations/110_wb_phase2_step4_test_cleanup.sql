-- Purpose: Warren Buffet Phase 2 Step 4 cleanup. Deletes the inactive "ZZ test rule" and the inactive "ZZ test" tag left by the claude.ai tool verification, only while nothing uses them, and returns what it deleted.
-- Kind: one-off data repair (safe to re-run: a second run deletes nothing)
-- Applied: YES — 2026-10-10 by Alex: deleted "ZZ test rule" and the "ZZ test" tag.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- No real financial data in this file. One statement: the rule goes first, so the
-- tag is no longer referenced by it when the tag goes.
-- supabase/migrations/110_wb_phase2_step4_test_cleanup.sql

with gone_rules as (
  delete from public.wb_rules ru
  where ru.name = 'ZZ test rule'
    and not ru.active
    and ru.hit_count = 0
    and not exists (select 1 from public.wb_split_tags st where st.rule_id = ru.id or st.replaced_rule_id = ru.id)
    and not exists (select 1 from public.wb_transactions x where ru.id = any (x.matched_rule_ids))
  returning ru.id, ru.name
),
gone_tags as (
  delete from public.wb_tags tg
  where tg.name = 'ZZ test'
    and not tg.is_active
    and not exists (select 1 from public.wb_split_tags st where st.tag_id = tg.id)
    and not exists (select 1 from public.wb_tags c where c.parent_id = tg.id)
    and not exists (select 1 from public.wb_rules ru
                    where tg.id = any (ru.add_tag_ids) and ru.id not in (select id from gone_rules))
  returning tg.id, tg.name
)
select json_build_object(
  'deleted_rules', coalesce((select json_agg(r) from gone_rules r), '[]'::json),
  'deleted_tags',  coalesce((select json_agg(t) from gone_tags t), '[]'::json)
) as result;
