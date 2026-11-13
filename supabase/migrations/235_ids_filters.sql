-- Switchboard 2.0 switchboard_prod-w3k s7: the ids filter rule, Alfred side. Kind: schema change (one constraint).
-- Spec: docs/technical-spec-switchboard_prod-w3k.md 7. Friction a80af92f. Tables touched: switchboard_actions.
--
-- At level ids a read still returns only Id, CreatedDate and LastModifiedDate, and every read is still approved by
-- link. What changes: its filters may name any field. The filter limit now lives only in the desktop helper
-- (switchboard salesforce/read/plan.mjs), which applies it unless the org's contractAllowsClaude is on, a flag only
-- orgs.json holds. Queue only after that helper change is installed (switchboard_prodrepo-w3k s10), so Alfred never
-- accepts a wider ids filter before the helper enforces the contract.
--
-- The check below is migration 233's, unchanged except the ids clause: the filters half is dropped and the fields
-- half kept. It only loosens, so every existing row still meets it. No new table, view or function, so no grants.

alter table public.switchboard_actions drop constraint switchboard_actions_sf_read_payload;
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_read_payload check (
    kind <> 'sf_read'
    or coalesce((
      payload - array['alias', 'production', 'level', 'object', 'count', 'fields', 'filters', 'limit'] = '{}'::jsonb
      and length(payload::text) <= 8000
      and jsonb_typeof(payload->'alias') = 'string'
      and payload->>'alias' ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'
      and jsonb_typeof(payload->'production') = 'boolean'
      and coalesce(payload->>'level', '') in ('objects', 'metadata', 'ids', 'data')
      -- objects: nothing else.
      and (payload->>'level' <> 'objects' or not (payload ?| array['object', 'count', 'fields', 'filters', 'limit']))
      -- metadata, ids, data: one object.
      and (payload->>'level' = 'objects'
           or (jsonb_typeof(payload->'object') = 'string' and payload->>'object' ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'))
      -- metadata: the object only.
      and (payload->>'level' <> 'metadata' or not (payload ?| array['count', 'fields', 'filters', 'limit']))
      -- ids, data: a count, or fields with a row cap; filters optional.
      and (payload->>'level' not in ('ids', 'data') or (
        case when payload ? 'count'
             then payload->'count' = 'true'::jsonb and not (payload ?| array['fields', 'limit'])
             else case when jsonb_typeof(payload->'limit') = 'number'
                       then (payload->>'limit') ~ '^[0-9]+$' and (payload->>'limit')::numeric between 1 and 1000
                       else false end
                  and case when jsonb_typeof(payload->'fields') = 'array'
                           then jsonb_array_length(payload->'fields') between 1 and 50
                                and jsonb_array_length(payload->'fields') = jsonb_array_length(jsonb_path_query_array(payload,
                                      '$.fields[*] ? (@.type() == "string" && @ like_regex "^[A-Za-z][A-Za-z0-9_]{0,79}$")'))
                           else false end
        end
        and (not (payload ? 'filters')
             or case when jsonb_typeof(payload->'filters') = 'array'
                     then jsonb_array_length(payload->'filters') between 1 and 10
                          and jsonb_array_length(payload->'filters') = jsonb_array_length(jsonb_path_query_array(payload,
                                '$.filters[*] ? (@.type() == "object" && @.field.type() == "string"
                                                 && @.field like_regex "^[A-Za-z][A-Za-z0-9_]{0,79}$"
                                                 && ((@.op == "=" || @.op == "!=" || @.op == "<" || @.op == "<=" || @.op == ">" || @.op == ">=")
                                                     && (@.value.type() == "string" || @.value.type() == "number"
                                                         || @.value.type() == "boolean" || @.value.type() == "null")
                                                     || @.op == "in" && @.value.type() == "array"
                                                        && @.value.size() >= 1 && @.value.size() <= 100))'))
                     else false end)
        and not coalesce(jsonb_path_exists(payload,
              '$.filters[*].keyvalue() ? (!(@.key == "field" || @.key == "op" || @.key == "value"))', '{}'::jsonb, true), true)
        and not coalesce(jsonb_path_exists(payload,
              '$.filters[*] ? (@.op == "in").value[*] ? (@.type() == "object" || @.type() == "array")', '{}'::jsonb, true), true)
        -- ids: only the three fields come back. Filters may name any field; the helper applies the contract's limit.
        and (payload->>'level' = 'data' or
          not coalesce(jsonb_path_exists(payload,
                '$.fields[*] ? (!(@ == "Id" || @ == "CreatedDate" || @ == "LastModifiedDate"))', '{}'::jsonb, true), true))
      ))
    ), false)
  );

comment on constraint switchboard_actions_sf_read_payload on public.switchboard_actions is
  'sf_read payload (spec 10): alias, production, level, object, count or fields with limit, filters; never SOQL. At ids only Id, CreatedDate and LastModifiedDate come back; ids filters may name any field, and the desktop helper limits them to those three unless the org''s contractAllowsClaude is on (switchboard_prod-w3k spec 7).';

-- Result: must say CONFORMANT. Then run supabase/tests/switchboard_prod-w3k/1_ids_filters.sql with --test.
select public.platform_check_conformance() as conformance;
