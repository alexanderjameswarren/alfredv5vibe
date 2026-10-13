-- Purpose: Warren Buffet Phase 2, Step 10. wb_bulk_create: tags, merchants and merchant rules in one call and one transaction (Step 5 hit the 60-calls-per-5-minutes limit doing them one at a time). Items refer to each other by name, existing ones are reused rather than duplicated, a dry run writes nothing, and any item error means nothing is written. Used by the tier-3 tool bulk_create_wb_taxonomy, whose proposal is the dry run.
-- Kind: schema change (one new function)
-- Applied: YES — 2026-10-13 by Alex ("Success. No rows returned"); 130 all 17 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 6 and 8 (Step 10).
-- No real financial data in this file. Run as one block, then 130_wb_phase2_step10_bulk_create_tests.sql.
-- supabase/migrations/129_wb_phase2_step10_bulk_create.sql

begin;

-- p_payload: {
--   "tags":      [{"group": "Category", "name": "Pets", "parent": "Home", "notes": "…"}],
--   "merchants": [{"name": "Corner Coffee", "match_patterns": ["corner coffee"], "default_kind": "spend", "notes": "…"}],
--   "rules":     [{"name": "Corner Coffee → Food", "merchant": "Corner Coffee", "set_kind": "spend",
--                  "tags": ["Category/Food"], "priority": 100, "notes": "…"}] }
-- Returns {"applied": bool, "dry_run": bool, "counts": {...}, "results": [{"kind", "name", "status", "id", "error"}]}.
-- status: created, exists (reused, nothing changed), updated (merchant patterns added), error.
create or replace function public.wb_bulk_create(
  p_payload    jsonb,
  p_context_id text,
  p_dry_run    boolean default true,
  p_created_by text default 'claude')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user     uuid;
  v_results  jsonb := '[]'::jsonb;
  v_errors   int := 0;
  v_item     jsonb;
  v_name     text;
  v_group    record;
  v_parent   uuid;
  v_id       uuid;
  v_patterns text[];
  v_added    text[];
  v_existing text[];
  v_kind     text;
  v_tag_ids  uuid[];
  v_ref      text;
  v_tag      uuid;
  v_err      text;
  v_status   text;
begin
  if p_created_by is null or p_created_by not in ('claude', 'manual') then
    raise exception 'wb_bulk_create: created_by must be claude or manual' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'wb_bulk_create: payload must be an object with tags, merchants and rules' using errcode = '22023';
  end if;
  if greatest(jsonb_array_length(coalesce(p_payload -> 'tags', '[]')),
              jsonb_array_length(coalesce(p_payload -> 'merchants', '[]')),
              jsonb_array_length(coalesce(p_payload -> 'rules', '[]'))) > 50 then
    raise exception 'wb_bulk_create: at most 50 tags, 50 merchants and 50 rules per call' using errcode = '22023';
  end if;
  select coalesce(auth.uid(), c.user_id) into v_user from public.contexts c where c.id = p_context_id;
  if v_user is null then
    raise exception 'wb_bulk_create: no context % that you can see', p_context_id using errcode = '23503';
  end if;

  -- Everything runs inside one sub-block; a dry run, or any item error, rolls it all back.
  begin
    -- 1. Tags, in order, so a parent may be an earlier item.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'tags', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error';
      begin
        select g.id, g.name into v_group from public.wb_tag_groups g
        where g.context_id = p_context_id and lower(g.name) = lower(btrim(v_item ->> 'group'));
        if v_group.id is null then
          v_err := format('no tag group "%s"', v_item ->> 'group');
        elsif coalesce(v_name, '') = '' then
          v_err := 'a tag needs a name';
        else
          select t.id into v_id from public.wb_tags t where t.group_id = v_group.id and lower(t.name) = lower(v_name);
          if v_id is not null then
            v_status := 'exists';
          else
            v_parent := null;
            if nullif(btrim(v_item ->> 'parent'), '') is not null then
              select t.id into v_parent from public.wb_tags t
              where t.group_id = v_group.id and lower(t.name) = lower(btrim(v_item ->> 'parent'));
              if v_parent is null then
                v_err := format('no parent tag "%s" in %s', v_item ->> 'parent', v_group.name);
              end if;
            end if;
            if v_err is null then
              insert into public.wb_tags (user_id, context_id, group_id, parent_id, name, notes)
              values (v_user, p_context_id, v_group.id, v_parent, v_name, nullif(btrim(v_item ->> 'notes'), ''))
              returning id into v_id;
              v_status := 'created';
            end if;
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; end if;
      v_results := v_results || jsonb_build_object('kind', 'tag', 'name', concat_ws('/', v_group.name, v_name),
        'status', v_status, 'id', v_id, 'error', v_err);
      v_group := null;
    end loop;

    -- 2. Merchants: an existing one (by name) gets any new patterns added.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'merchants', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error';
      begin
        select coalesce(array_agg(distinct lower(btrim(p))), '{}') into v_patterns
        from jsonb_array_elements_text(coalesce(v_item -> 'match_patterns', '[]')) p
        where btrim(p) <> '';
        v_kind := nullif(btrim(v_item ->> 'default_kind'), '');
        if coalesce(v_name, '') = '' then
          v_err := 'a merchant needs a name';
        elsif exists (select 1 from unnest(v_patterns) p where length(p) < 3) then
          v_err := 'a match pattern needs at least 3 characters';
        elsif v_kind is not null and v_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
          v_err := format('unknown kind "%s"', v_kind);
        else
          select m.id, m.match_patterns into v_id, v_existing from public.wb_merchants m
          where m.context_id = p_context_id and lower(m.name) = lower(v_name);
          if v_id is not null then
            select coalesce(array_agg(p), '{}') into v_added
            from unnest(v_patterns) p
            where p <> all (v_existing);
            if cardinality(v_added) > 0 then
              update public.wb_merchants set match_patterns = match_patterns || v_added where id = v_id;
              v_status := 'updated';
            else
              v_status := 'exists';
            end if;
          elsif cardinality(v_patterns) = 0 then
            v_err := 'a new merchant needs match_patterns';
          else
            insert into public.wb_merchants (user_id, context_id, name, match_patterns, default_kind, notes)
            values (v_user, p_context_id, v_name, v_patterns, v_kind, nullif(btrim(v_item ->> 'notes'), ''))
            returning id into v_id;
            v_status := 'created';
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; end if;
      v_results := v_results || jsonb_build_object('kind', 'merchant', 'name', v_name,
        'status', v_status, 'id', v_id, 'error', v_err);
    end loop;

    -- 3. Rules, on a merchant (by name); an active rule for that merchant is reused, never duplicated.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'rules', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error'; v_tag_ids := '{}';
      begin
        v_kind := nullif(btrim(v_item ->> 'set_kind'), '');
        select m.id into v_id from public.wb_merchants m
        where m.context_id = p_context_id and lower(m.name) = lower(btrim(v_item ->> 'merchant'));
        if coalesce(v_name, '') = '' then
          v_err := 'a rule needs a name';
        elsif v_id is null then
          v_err := format('no merchant "%s"', v_item ->> 'merchant');
        elsif v_kind is not null and v_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
          v_err := format('unknown kind "%s"', v_kind);
        else
          for v_ref in select * from jsonb_array_elements_text(coalesce(v_item -> 'tags', '[]'))
          loop
            select t.id into v_tag from public.wb_tags t
            join public.wb_tag_groups g on g.id = t.group_id
            where g.context_id = p_context_id
              and lower(g.name) = lower(btrim(split_part(v_ref, '/', 1)))
              and lower(t.name) = lower(btrim(substr(v_ref, length(split_part(v_ref, '/', 1)) + 2)));
            if v_tag is null then
              v_err := format('no tag "%s" (write Group/Tag)', v_ref);
              exit;
            end if;
            v_tag_ids := v_tag_ids || v_tag;
          end loop;
          if v_err is null and v_kind is null and cardinality(v_tag_ids) = 0 then
            v_err := 'say what the rule does: set_kind and/or tags';
          end if;
          if v_err is null then
            select r.id into v_tag from public.wb_rules r
            where r.active and r.match ->> 'merchant_id' = v_id::text
            order by r.priority, r.created_at limit 1;
            if v_tag is not null then
              v_id := v_tag;
              v_status := 'exists';
            else
              insert into public.wb_rules (user_id, context_id, name, priority, match, set_kind, add_tag_ids, created_by, notes)
              values (v_user, p_context_id, v_name, coalesce((v_item ->> 'priority')::int, 100),
                      jsonb_build_object('merchant_id', v_id), v_kind, v_tag_ids, p_created_by,
                      nullif(btrim(v_item ->> 'notes'), ''))
              returning id into v_id;
              v_status := 'created';
            end if;
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; v_id := null; end if;
      v_results := v_results || jsonb_build_object('kind', 'rule', 'name', v_name, 'merchant', v_item ->> 'merchant',
        'status', v_status, 'id', v_id, 'error', v_err);
    end loop;

    if p_dry_run or v_errors > 0 then
      raise exception 'wb_bulk_create: roll back' using errcode = 'WB001';
    end if;
  exception when sqlstate 'WB001' then
    null; -- rolled back; the results stay
  end;

  return jsonb_build_object(
    'applied', not p_dry_run and v_errors = 0,
    'dry_run', p_dry_run,
    'counts', (select jsonb_object_agg(k, n) from (
                 select r ->> 'status' as k, count(*) as n from jsonb_array_elements(v_results) r group by 1) s),
    'results', v_results);
end;
$$;

comment on function public.wb_bulk_create(jsonb, text, boolean, text) is
  'Warren Buffet: create tags, merchants and merchant rules in one transaction, referring to each other by name (tag parent, rule merchant, rule tags as Group/Tag). Existing names are reused, an existing merchant gets new patterns added, and a merchant that already has an active rule keeps it (no duplicate). A dry run (the default) writes nothing; any item error writes nothing. At most 50 of each. Security invoker. Returns applied, counts and per-item results.';

grant execute on function public.wb_bulk_create(jsonb, text, boolean, text) to authenticated, service_role;

commit;
