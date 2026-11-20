-- 246: dataop_write-j5w s10. The sf_datawrite Id rule, decided with the Switchboard thread (dataop_v2-m5j).
-- The 200 limit exists because a Salesforce query can't take a longer Id list, not because of what Alfred stores.
-- New rule: each query that may list Ids (selection.soql, "after: selection", every after-count, and every export
-- labelled "... broad snapshot") lists at most 200; every other export lists none; no limit across the link. The
-- 200,000-character payload limit stays. Fix C (a 136-Id selection and four 136-Id rule counts) passes.
-- s11c (from the Switchboard thread, dataop_v2-m5j s9c): the rule "the exclude upload has fewer rows than expected"
-- is dropped. write.excluded counts only manifest records the gate left out; exclude.csv also holds records added at
-- the gate, which were never in expected, so its rows may exceed them. Every other upload rule stays.
-- Kind: schema change (one function replaced, same signature and grants). Applied: NO (queued again at s11c; the s11b
-- action 36135bf4 is superseded and left unapproved; only a run id shows it ran).
-- Spec: docs/technical-spec-dataop_write-j5w.md (part 2, "Ids").
-- Test: supabase/tests/dataop_write-j5w/2_verify_ids_rule.sql (--test).
-- Tables touched: switchboard_actions (its sf_datawrite payload check calls this function through
-- switchboard_datawrite_payload_ok, which is unchanged).
-- Functions: switchboard_datawrite_payload_problem replaced. Everything else in 245 is unchanged. Every row already in
-- switchboard_actions passes the new rule, which only accepts more.
-- Deploy order: this migration, then mcp (the queue tool's copy of the rule), so the tool never offers what the
-- database refuses.

create or replace function public.switchboard_datawrite_payload_problem(p_payload jsonb, p_project_code text)
returns text
language plpgsql
stable  -- not immutable: convert_to is stable
set search_path = public, pg_temp
as $$
declare
  c_keys     constant text[] := array['alias', 'org_type', 'repo', 'run', 'run_tag', 'request_sha256', 'selection_sha256',
                                      'object', 'problem', 'expected', 'write', 'uploads', 'queries'];
  c_required constant text[] := array['alias', 'org_type', 'repo', 'run', 'run_tag', 'request_sha256', 'selection_sha256',
                                      'object', 'expected', 'write', 'queries'];
  c_qkeys    constant text[] := array['step', 'soql', 'sha256', 'file', 'label', 'wait'];
  c_hex      constant text := '^[0-9a-f]{64}$';
  c_csv      constant text := '^[A-Za-z0-9_.-]{1,80}\.csv$';
  c_name     constant text := '^[A-Za-z][A-Za-z0-9_]{0,79}$';
  c_int      constant text := '^[1-9][0-9]{0,8}$';           -- 1 to 999,999,999, as jsonb prints a whole number
  -- An Id: a quoted literal of exactly 15 or 18 letters and digits. Counted conservatively.
  c_id       constant text := '''[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?''';
  v_code     text := p_project_code;
  v_keys     text[];
  v_len      integer;
  v_run      text;
  v_tag      text;
  v_sel      text;
  v_expected bigint;
  v_w        jsonb;
  v_wkind    text;
  v_u        jsonb;
  v_purpose  text;
  v_purposes text[] := '{}';
  v_undo_up  jsonb;
  v_q        jsonb;
  v_i        integer := 0;
  v_step     text;
  v_rank     integer;
  v_last     integer := 0;
  v_n_gate   integer := 0;
  v_n_after  integer := 0;
  v_n_counts integer := 0;
  v_soql     text;
  v_sha      text;
  v_label    text;
  v_name     text;
  v_labels   text[] := '{}';
  v_ids      integer;
  v_wait     jsonb;
  v_waits    integer := 0;
  v_broad    boolean := false;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return 'the payload must be a JSON object: pass sb''s printed arguments exactly as they are.';
  end if;
  if v_code is null or v_code !~ '^[a-z0-9][a-z0-9_-]{1,40}$' then
    return 'the action needs the data operation''s project code, as sb printed it.';
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_payload) k where not (k = any(c_keys));
  if v_keys is not null then
    return format('the payload does not take %s. Pass sb''s printed arguments exactly as they are.', array_to_string(v_keys, ', '));
  end if;
  select array_agg(k order by n) into v_keys from unnest(c_required) with ordinality t(k, n) where not (p_payload ? k);
  if v_keys is not null then
    return format('missing %s: pass every argument sb printed.', array_to_string(v_keys, ', '));
  end if;
  v_len := length(p_payload::text);
  if v_len > 200000 then
    return format('the payload is %s characters; the limit is 200,000. Select by criteria instead of long lists, or split the run.',
                  to_char(v_len, 'FM999,999,999'));
  end if;

  -- ---- the run's identity (A1's rules, with org_type required) ----
  if jsonb_typeof(p_payload->'alias') is distinct from 'string' or p_payload->>'alias' !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' then
    return 'alias must be the org''s alias (letters, digits, _ . -).';
  end if;
  if jsonb_typeof(p_payload->'org_type') is distinct from 'string' or p_payload->>'org_type' not in ('sandbox', 'production') then
    return 'org_type must be exactly "sandbox" or "production", as sb printed it from orgs.json.';
  end if;
  if jsonb_typeof(p_payload->'repo') is distinct from 'string' or length(p_payload->>'repo') > 240
     or p_payload->>'repo' !~ '^[A-Za-z]:(\\[^\\/:*?"<>|[:cntrl:]]+)+$' or strpos(p_payload->>'repo', '..') > 0 then
    return 'repo must be the checkout''s absolute path, e.g. C:\Users\Alex\projects\common-defense, with no ..';
  end if;
  v_run := p_payload->>'run';
  if jsonb_typeof(p_payload->'run') is distinct from 'string' or length(v_run) > 200 or strpos(v_run, '..') > 0
     or left(v_run, 9) not in ('data-ops/', 'data-ops\')
     or substr(v_run, 10, length(v_code)) <> v_code
     or substr(v_run, 10 + length(v_code)) !~ '^[\\/][A-Za-z0-9_.-]{1,80}$'
     or substr(v_run, 10 + length(v_code)) ~ '^[\\/]\.+$' then
    return format('run must be the run folder inside repo: data-ops/%s/<run>, one folder, with no ..', v_code);
  end if;
  v_tag := p_payload->>'run_tag';
  if jsonb_typeof(p_payload->'run_tag') is distinct from 'string' or length(v_tag) > 60
     or left(v_tag, length(v_code) + 2) <> v_code || '-s'
     or substr(v_tag, length(v_code) + 3) !~ '^[0-9]+[a-z]*-[a-z0-9]{4}$' then
    return format('run_tag must be this project''s run tag, e.g. %s-s4-ab12.', v_code);
  end if;
  if jsonb_typeof(p_payload->'request_sha256') is distinct from 'string' or p_payload->>'request_sha256' !~ c_hex then
    return 'request_sha256 must be request.json''s SHA-256: 64 lower-case hex characters.';
  end if;
  if jsonb_typeof(p_payload->'selection_sha256') is distinct from 'string' or p_payload->>'selection_sha256' !~ c_hex then
    return 'selection_sha256 must be selection.soql''s SHA-256: 64 lower-case hex characters.';
  end if;
  v_sel := p_payload->>'selection_sha256';
  if jsonb_typeof(p_payload->'object') is distinct from 'string' or p_payload->>'object' !~ c_name then
    return 'object must be one API name, e.g. GiftTransaction or Donation__c.';
  end if;
  if p_payload ? 'problem'
     and (jsonb_typeof(p_payload->'problem') is distinct from 'string' or char_length(p_payload->>'problem') not between 20 and 600
          or p_payload->>'problem' ~ '[\r\n]') then
    return 'problem must be the request''s problem sentence: one line of 20 to 600 characters, or left out.';
  end if;
  if jsonb_typeof(p_payload->'expected') is distinct from 'number' or p_payload->>'expected' !~ c_int then
    return 'expected must be the whole number of records the write changes, 1 to 999,999,999.';
  end if;
  v_expected := (p_payload->>'expected')::bigint;

  -- ---- the write: batch, bulk update or undo ----
  v_w := p_payload->'write';
  if jsonb_typeof(v_w) is distinct from 'object' then
    return 'write must be {kind: batch, class}, {kind: bulk, operation: update, csv, csv_sha256} or {kind: undo, class, ids_file, ids_sha256}.';
  end if;
  v_wkind := case when jsonb_typeof(v_w->'kind') = 'string' then v_w->>'kind' end;
  if v_wkind = 'batch' then
    if v_w - array['kind', 'class'] <> '{}'::jsonb or not (v_w ? 'class') then
      return 'a batch write is {kind: batch, class} only: the class name, with no Ids or start arguments (production starts new <Class>()).';
    end if;
  elsif v_wkind = 'bulk' then
    if v_w - array['kind', 'operation', 'csv', 'csv_sha256'] <> '{}'::jsonb or not (v_w ?& array['operation', 'csv', 'csv_sha256']) then
      return 'a bulk write is {kind: bulk, operation: update, csv, csv_sha256}, nothing more or less.';
    end if;
    if v_w->'operation' is distinct from '"update"'::jsonb then
      return 'a bulk write is an update only: operation must be "update".';
    end if;
    if jsonb_typeof(v_w->'csv') is distinct from 'string' or v_w->>'csv' !~ c_csv then
      return 'write.csv must be one .csv file name in the run folder.';
    end if;
    if jsonb_typeof(v_w->'csv_sha256') is distinct from 'string' or v_w->>'csv_sha256' !~ c_hex then
      return 'write.csv_sha256 must be the CSV''s SHA-256: 64 lower-case hex characters.';
    end if;
  elsif v_wkind = 'undo' then
    if v_w - array['kind', 'class', 'ids_file', 'ids_sha256'] <> '{}'::jsonb or not (v_w ?& array['class', 'ids_file', 'ids_sha256']) then
      return 'an undo write is {kind: undo, class, ids_file, ids_sha256}, nothing more or less.';
    end if;
    if jsonb_typeof(v_w->'ids_file') is distinct from 'string' or v_w->>'ids_file' !~ c_csv then
      return 'write.ids_file must be one .csv file name in the run folder.';
    end if;
    if jsonb_typeof(v_w->'ids_sha256') is distinct from 'string' or v_w->>'ids_sha256' !~ c_hex then
      return 'write.ids_sha256 must be the Id file''s SHA-256: 64 lower-case hex characters.';
    end if;
  else
    return 'write.kind must be batch, bulk or undo.';
  end if;
  if v_wkind in ('batch', 'undo') and (jsonb_typeof(v_w->'class') is distinct from 'string' or v_w->>'class' !~ c_name) then
    return 'write.class must be the deployed Batch class''s name (letters, digits, _).';
  end if;

  -- ---- uploads: the files known before the run that it uploads after Alex's Enter ----
  -- s6b: a bulk write uploads nothing. Records left out at the gate come out of the CSV on Alex's PC, and failures come
  -- from the Bulk API job's own result.
  if v_wkind = 'bulk' and p_payload ? 'uploads' then
    return 'a bulk write uploads nothing; remove uploads.';
  end if;
  if p_payload ? 'uploads' then
    if jsonb_typeof(p_payload->'uploads') is distinct from 'array' or jsonb_array_length(p_payload->'uploads') > 2 then
      return 'uploads must list at most 2 files, each {purpose, file, sha256, rows}, or be left out.';
    end if;
    for v_u in select value from jsonb_array_elements(p_payload->'uploads') loop
      if jsonb_typeof(v_u) <> 'object' or v_u - array['purpose', 'file', 'sha256', 'rows'] <> '{}'::jsonb
         or not (v_u ?& array['purpose', 'file', 'sha256', 'rows']) then
        return 'each upload is {purpose, file, sha256, rows}, nothing more or less.';
      end if;
      v_purpose := case when jsonb_typeof(v_u->'purpose') = 'string' then v_u->>'purpose' end;
      if v_purpose is null or v_purpose not in ('exclude', 'undo-ids') then
        return 'an upload''s purpose must be "exclude" or "undo-ids".';
      end if;
      if v_purpose = any(v_purposes) then
        return format('there are two %s uploads: list each purpose once.', v_purpose);
      end if;
      v_purposes := v_purposes || v_purpose;
      if jsonb_typeof(v_u->'file') is distinct from 'string' or v_u->>'file' !~ c_csv then
        return format('the %s upload''s file must be one .csv file name in the run folder.', v_purpose);
      end if;
      if jsonb_typeof(v_u->'sha256') is distinct from 'string' or v_u->>'sha256' !~ c_hex then
        return format('the %s upload''s sha256 must be 64 lower-case hex characters.', v_purpose);
      end if;
      if jsonb_typeof(v_u->'rows') is distinct from 'number' or v_u->>'rows' !~ c_int then
        return format('the %s upload''s rows must be its row count, 1 to 999,999,999.', v_purpose);
      end if;
      -- s11c: no rows-versus-expected rule for exclude. exclude.csv also holds records added at the gate, which were
      -- never in expected, so it may legitimately have more rows than the manifest records it leaves out.
      if v_purpose = 'undo-ids' then v_undo_up := v_u; end if;
    end loop;
  end if;
  if v_wkind = 'undo' then
    if v_undo_up is null then
      return 'an undo needs its Id file in uploads: {purpose: "undo-ids", file: <ids_file>, sha256: <ids_sha256>, rows: <expected>}.';
    end if;
    if v_undo_up->>'file' <> v_w->>'ids_file' or v_undo_up->>'sha256' <> v_w->>'ids_sha256' then
      return 'the undo-ids upload must be the write''s Id file: the same file and sha256 as write.ids_file and write.ids_sha256.';
    end if;
    if (v_undo_up->>'rows')::bigint <> v_expected then
      return format('the undo Id file has %s rows but expected is %s: they must be equal, since expected is the Id file''s row count.',
                    v_undo_up->>'rows', v_expected);
    end if;
  elsif v_undo_up is not null then
    return 'only an undo uploads an Id file: leave the undo-ids upload out.';
  end if;

  -- ---- queries: the gate, the after export, the after counts, in that order ----
  if jsonb_typeof(p_payload->'queries') is distinct from 'array' or jsonb_array_length(p_payload->'queries') not between 2 and 44 then
    return 'queries must list 2 to 44 queries: the gate, the after export, then the after counts.';
  end if;
  for v_q in select value from jsonb_array_elements(p_payload->'queries') loop
    v_i := v_i + 1;
    if jsonb_typeof(v_q) <> 'object' then
      return format('query %s must be {step, soql, sha256, file | label, wait?}.', v_i);
    end if;
    v_label := case when jsonb_typeof(v_q->'label') = 'string' then v_q->>'label' end;
    v_name := coalesce(quote_literal(v_label), quote_literal(case when jsonb_typeof(v_q->'file') = 'string' then v_q->>'file' end),
                       'number ' || v_i);
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v_q) k where not (k = any(c_qkeys));
    if v_keys is not null then
      return format('the query %s does not take %s.', v_name, array_to_string(v_keys, ', '));
    end if;
    v_step := case when jsonb_typeof(v_q->'step') = 'string' then v_q->>'step' end;
    v_rank := case v_step when 'gate' then 1 when 'after' then 2 when 'after-counts' then 3 end;
    if v_rank is null then
      return format('the query %s needs a step: gate, after or after-counts.', v_name);
    end if;
    if v_rank < v_last then
      return format('the query %s (%s) comes after a later step: list the gate first, then after, then after-counts.', v_name, v_step);
    end if;
    v_last := v_rank;

    if jsonb_typeof(v_q->'soql') is distinct from 'string' then
      return format('the query %s needs its soql, the exact text.', v_name);
    end if;
    v_soql := v_q->>'soql';
    if strpos(v_soql, ';') > 0 then
      return format('the query %s has a semicolon: one query, no ;.', v_name);
    end if;
    v_sha := encode(sha256(convert_to(v_soql, 'UTF8')), 'hex');
    if jsonb_typeof(v_q->'sha256') is distinct from 'string' or v_q->>'sha256' <> v_sha then
      return format('the query %s has a sha256 that isn''t the SHA-256 of its soql''s exact bytes: pass both as sb printed them.', v_name);
    end if;
    if v_step in ('gate', 'after') then
      if char_length(v_soql) > 100000 then
        return format('the query %s is %s characters; an export is at most 100,000. Select by criteria instead, or split the run.',
                      v_name, to_char(char_length(v_soql), 'FM999,999,999'));
      end if;
      if v_soql !~* '^[ \t\r\n]*SELECT[ \t\r\n]+Id([ \t\r\n]*,|[ \t\r\n]+FROM[ \t\r\n])' or v_soql ~* 'COUNT[ \t\r\n]*\(' then
        return format('the query %s is an export: SELECT Id, ... FROM ..., with no COUNT(.', v_name);
      end if;
    else
      if char_length(v_soql) > 8000 then
        return format('the query %s is %s characters; a count is at most 8,000.', v_name, to_char(char_length(v_soql), 'FM999,999,999'));
      end if;
      if v_soql !~* '^[ \t\r\n]*SELECT[ \t\r\n]+COUNT\(\)[ \t\r\n]+FROM[ \t\r\n]+[A-Za-z][A-Za-z0-9_]*[ \t\r\n]+WHERE[ \t\r\n]'
         or v_soql ~* 'GROUP[ \t\r\n]+BY' then
        return format('the query %s is a count: SELECT COUNT() FROM <object> WHERE ..., with no GROUP BY.', v_name);
      end if;
    end if;

    -- Exactly one of file and label; labels unique within the payload.
    if (v_q ? 'file') = (v_q ? 'label') then
      return format('the query %s needs exactly one of file and label.', v_name);
    end if;
    if v_q ? 'file' then
      if jsonb_typeof(v_q->'file') <> 'string' or v_q->>'file' !~ '^[A-Za-z0-9_.-]{1,80}\.soql$' then
        return format('the query %s''s file must be one .soql file name in the run folder.', v_name);
      end if;
    else
      if v_label is null or char_length(v_label) not between 1 and 200 or btrim(v_label) = '' or v_label ~ '[\r\n]' then
        return format('the query %s''s label must be one line of 1 to 200 characters.', v_name);
      end if;
      if v_label = any(v_labels) then
        return format('the label %s is used twice: labels are unique within a link.', v_name);
      end if;
      v_labels := v_labels || v_label;
    end if;

    -- What each step holds.
    if v_step = 'gate' then
      v_n_gate := v_n_gate + 1;
      if v_wkind = 'undo' then
        if v_n_gate > 1 then
          return 'an undo''s gate is exactly one export: a fresh export of the broad snapshot.';
        end if;
        if v_label is null or v_label !~ 'broad snapshot$' then
          return 'an undo''s gate is a fresh export of the broad snapshot, labelled e.g. "gate: broad snapshot".';
        end if;
      elsif v_n_gate = 1 then
        if v_q->>'file' is distinct from 'selection.soql' or v_sha <> v_sel then
          return 'the gate''s first export must be selection.soql (file "selection.soql"), with its sha256 equal to selection_sha256.';
        end if;
      elsif v_label is null then
        return 'the gate''s second export must be labelled, e.g. "gate: broad snapshot".';
      end if;
    elsif v_step = 'after' then
      v_n_after := v_n_after + 1;
      if v_label is null or v_label not in ('after: broad snapshot', 'after: selection') then
        return 'an after export is labelled "after: broad snapshot" (required) or "after: selection" (optional).';
      end if;
      if v_label = 'after: selection' then
        if v_wkind = 'undo' then
          return 'an undo''s after is only "after: broad snapshot": leave "after: selection" out.';
        end if;
        if v_sha <> v_sel then
          return 'the query ''after: selection'' is selection.soql run again: its sha256 must equal selection_sha256.';
        end if;
      else
        v_broad := true;
      end if;
    else
      v_n_counts := v_n_counts + 1;
    end if;

    -- A wait only on an after-count labelled "...: wait".
    if v_q ? 'wait' then
      if v_step <> 'after-counts' or v_label is null or v_label !~ ': wait$' then
        return format('the query %s takes no wait: only an after-count labelled "...: wait" does.', v_name);
      end if;
      v_wait := v_q->'wait';
      if jsonb_typeof(v_wait) <> 'object' or v_wait - array['stable_minutes', 'limit_minutes'] <> '{}'::jsonb
         or jsonb_typeof(v_wait->'stable_minutes') is distinct from 'number' or v_wait->>'stable_minutes' !~ '^[1-9][0-9]?$'
         or jsonb_typeof(v_wait->'limit_minutes') is distinct from 'number' or v_wait->>'limit_minutes' !~ '^[1-9][0-9]{0,2}$'
         or (v_wait->>'stable_minutes')::integer > 60 or (v_wait->>'limit_minutes')::integer > 240 then
        return format('the query %s''s wait must be {stable_minutes: 1 to 60, limit_minutes: 1 to 240}.', v_name);
      end if;
      v_waits := v_waits + (v_wait->>'limit_minutes')::integer;
    end if;

    -- Ids (s10): a Salesforce query takes at most 200 listed Ids, so each query that may list them (selection.soql,
    -- "after: selection", every after-count, every export labelled "... broad snapshot") lists at most 200. Every
    -- other export lists none. There is no cap across the link; the 200,000-character payload cap still applies.
    select count(*) into v_ids from regexp_matches(v_soql, c_id, 'g');
    if v_step = 'after-counts' or (v_step = 'gate' and v_q->>'file' = 'selection.soql')
       or v_label = 'after: selection' or v_label ~ 'broad snapshot$' then
      if v_ids > 200 then
        return format('the query %s lists %s Ids; a Salesforce query takes at most 200. Select by criteria instead, or split the run.',
                      v_name, v_ids);
      end if;
    elsif v_ids > 0 then
      return format('the query %s lists %s Id%s; Ids go only in selection.soql, "after: selection", an after-count or an export labelled "... broad snapshot". Select by criteria instead.',
                    v_name, v_ids, case when v_ids = 1 then '' else 's' end);
    end if;
  end loop;

  if v_n_gate = 0 or v_n_gate > 2 then
    return format('the gate has %s exports; it takes 1 or 2 (an undo, exactly 1).', v_n_gate);
  end if;
  if not v_broad then
    return 'the after step needs "after: broad snapshot", the same fields as the before broad snapshot.';
  end if;
  if v_n_counts > 40 then
    return format('there are %s after-counts; the limit is 40. Move the rest to a count link.', v_n_counts);
  end if;
  if v_waits > 180 then
    return format('the waits add up to %s minutes; the limit is 180, so the run fits its 4 hours. Shorten the waits, or move a rule to a count link.',
                  v_waits);
  end if;
  return null;
exception when others then
  return 'the payload could not be checked (' || sqlerrm || '): pass sb''s printed arguments exactly as they are.';
end;
$$;
comment on function public.switchboard_datawrite_payload_problem(jsonb, text) is
  'Switchboard: why an sf_datawrite payload does not meet docs/technical-spec-dataop_write-j5w.md part 2 for the action''s project code, as one sentence saying what to do, or null when it does. alias, org_type ("sandbox" or "production", required), repo, run, run_tag (A1''s rules), request_sha256, selection_sha256, object, problem?, expected (1 to 999,999,999), write (batch {class}, bulk {operation: update, csv, csv_sha256} or undo {class, ids_file, ids_sha256}), uploads? (0 to 2, exclude and undo-ids; an undo''s equals its write; none on a bulk write), queries (2 to 44: gate 1-2 exports, the first selection.soql, or one broad snapshot for an undo; after with "after: broad snapshot" and optionally "after: selection"; 0 to 40 after-counts; labels unique; waits only on "...: wait", at most 180 minutes in all); Ids (a Salesforce query takes at most 200) only in selection.soql, "after: selection", an after-count or an export labelled "... broad snapshot", at most 200 per query and no limit across the link; the payload at most 200,000 characters. Never raises. Used by switchboard_datawrite_payload_ok and switchboard_queue_helper.';
revoke all on function public.switchboard_datawrite_payload_problem(jsonb, text) from public, anon;
grant execute on function public.switchboard_datawrite_payload_problem(jsonb, text) to authenticated, service_role;

-- Result: must say CONFORMANT. Then run supabase/tests/dataop_write-j5w/2_verify_ids_rule.sql with --test.
select public.platform_check_conformance() as conformance;
