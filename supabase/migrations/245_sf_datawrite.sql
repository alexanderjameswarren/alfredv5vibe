-- 245: dataop_write-j5w A2. The sf_datawrite action kind: Data run v2's write
-- link (gate, write, after export and after counts under one approval), started only from Alex's click on its link;
-- only counts, the expected and changed numbers and a pass flag come back.
-- Kind: schema change (constraints, two new functions, three functions replaced). Applied: NO (queued at s7b; only a run id shows it ran).
-- Spec: docs/technical-spec-dataop_write-j5w.md (parts 2, 3 and 5).
-- Test: supabase/tests/dataop_write-j5w/1_verify_sf_datawrite.sql (--test).
-- Tables touched: switchboard_actions (kind, payload and click checks), switchboard_runs (a result check).
-- Functions: switchboard_datawrite_payload_problem and switchboard_datawrite_payload_ok (new); switchboard_needs_click,
-- switchboard_queue_helper and switchboard_pickup_helper replaced, same signatures and grants. switchboard_issue_link,
-- switchboard_stakes and switchboard_actions_guard are unchanged. sf_dataop, sf_dataquery and every other kind behave
-- exactly as before.
-- The 4-hour limit on a picked run is switchboard-runner's (stalePicks), not the database's.
-- Deploy order: this migration first, then mcp and switchboard-runner.

-- ============================================================================
-- 1. The kind.
-- ============================================================================
alter table public.switchboard_actions drop constraint switchboard_actions_kind_valid;
alter table public.switchboard_actions
  add constraint switchboard_actions_kind_valid
  check (kind in ('sql', 'git', 'sf_check', 'sb_setup', 'sf_read', 'sf_deploy', 'sf_test', 'sf_read_prod_data', 'docs',
                  'sf_dataop', 'sf_dataquery', 'sf_datawrite'));

-- ============================================================================
-- 2. The payload (spec part 2). The problem function returns null for a payload that passes, or one sentence saying
--    what is wrong and what to do; the queue helper raises that sentence. The ok function wraps it for the CHECK.
--    Neither raises: anything unexpected is a problem. Blank space is [ \t\r\n] exactly, not \s, as in A1, so the
--    queue tool's JavaScript patterns match these character for character.
-- ============================================================================
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
      if v_purpose = 'exclude' and (v_u->>'rows')::bigint >= v_expected then
        return format('the exclude upload leaves out %s records, not fewer than the %s the write changes. Leave out fewer, or go back to diagnosis.',
                      v_u->>'rows', v_expected);
      end if;
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

    -- Ids: criteria only, except an export labelled "... broad snapshot", at most 200 (D1, never split).
    select count(*) into v_ids from regexp_matches(v_soql, c_id, 'g');
    if v_step in ('gate', 'after') and v_label ~ 'broad snapshot$' then
      if v_ids > 200 then
        return format('the query %s lists %s Ids; the limit is 200. Select by criteria instead, or split the run.', v_name, v_ids);
      end if;
    elsif v_ids > 0 then
      return format('the query %s lists %s Id%s; only an export labelled "... broad snapshot" may list Ids (at most 200). Select by criteria instead.',
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
  'Switchboard: why an sf_datawrite payload does not meet docs/technical-spec-dataop_write-j5w.md part 2 for the action''s project code, as one sentence saying what to do, or null when it does. alias, org_type ("sandbox" or "production", required), repo, run, run_tag (A1''s rules), request_sha256, selection_sha256, object, problem?, expected (1 to 999,999,999), write (batch {class}, bulk {operation: update, csv, csv_sha256} or undo {class, ids_file, ids_sha256}), uploads? (0 to 2, exclude and undo-ids; an undo''s equals its write; none on a bulk write), queries (2 to 44: gate 1-2 exports, the first selection.soql, or one broad snapshot for an undo; after with "after: broad snapshot" and optionally "after: selection"; 0 to 40 after-counts; labels unique; waits only on "...: wait", at most 180 minutes in all); Ids only in an export labelled "... broad snapshot", at most 200; the payload at most 200,000 characters. Never raises. Used by switchboard_datawrite_payload_ok and switchboard_queue_helper.';
revoke all on function public.switchboard_datawrite_payload_problem(jsonb, text) from public, anon;
grant execute on function public.switchboard_datawrite_payload_problem(jsonb, text) to authenticated, service_role;

create or replace function public.switchboard_datawrite_payload_ok(p_payload jsonb, p_project_code text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.switchboard_datawrite_payload_problem(p_payload, p_project_code) is null;
$$;
comment on function public.switchboard_datawrite_payload_ok(jsonb, text) is
  'Switchboard: whether an sf_datawrite payload meets docs/technical-spec-dataop_write-j5w.md part 2 (switchboard_datawrite_payload_problem is null). Used by switchboard_actions_sf_datawrite_payload.';
revoke all on function public.switchboard_datawrite_payload_ok(jsonb, text) from public, anon;
grant execute on function public.switchboard_datawrite_payload_ok(jsonb, text) to authenticated, service_role;

alter table public.switchboard_actions
  add constraint switchboard_actions_sf_datawrite_payload check (
    kind <> 'sf_datawrite' or coalesce(public.switchboard_datawrite_payload_ok(payload, project_code), false)
  );
comment on constraint switchboard_actions_sf_datawrite_payload on public.switchboard_actions is
  'sf_datawrite payload (docs/technical-spec-dataop_write-j5w.md part 2), checked by switchboard_datawrite_payload_ok against the action''s project code; switchboard_datawrite_payload_problem says why one fails.';

-- An sf_datawrite always waits for Alex's click, whoever queued it, as sf_dataop and sf_dataquery.
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_datawrite_click check (kind <> 'sf_datawrite' or needs_click);
comment on constraint switchboard_actions_sf_datawrite_click on public.switchboard_actions is
  'An sf_datawrite (a data run''s write link) always needs Alex''s click by link, whoever queued it.';

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object" (or "objects", 1 to 20, at metadata), "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). sf_dataop: {"alias", "repo", "plan", "stamp", "preflight_at", "object", "problem", "expected", "write", "rows", "rehearsal"?} (docs/technical-spec-dataops_alfred-d4x.md). sf_dataquery: {"alias", "org_type": "sandbox|production" (required on insert since dataquery_fixes-v3n), "repo", "run", "run_tag", "request_sha256"?, "queries": [{"step", "soql", "sha256", "file" | "label"}]} (docs/technical-spec-dataop_link-k7d.md). sf_datawrite: {"alias", "org_type", "repo", "run", "run_tag", "request_sha256", "selection_sha256", "object", "problem"?, "expected", "write": {"kind": "batch|bulk|undo", ...}, "uploads"?: [{"purpose", "file", "sha256", "rows"}], "queries": [{"step": "gate|after|after-counts", "soql", "sha256", "file" | "label", "wait"?}]} (docs/technical-spec-dataop_write-j5w.md). Fixed after insert.';

-- ============================================================================
-- 3. The run's result for an sf_datawrite (spec part 3): {ok, exit_code?, pass?, datawrite: {stage, query_counts?,
--    gate?, write?, check?}}. Keyed on datawrite, which no other kind writes, so every existing row meets it. That
--    query_counts matches the payload's queries, by position, and write.expected the payload's, is the runner's check.
--    Each non-scalar is checked behind a CASE, since - raises on a scalar and AND is not ordered.
-- ============================================================================
alter table public.switchboard_runs
  add constraint switchboard_runs_datawrite_result check (
    result is null or not (result ? 'datawrite')
    or coalesce((
      result - array['ok', 'exit_code', 'pass', 'datawrite'] = '{}'::jsonb
      and jsonb_typeof(result->'ok') = 'boolean'
      and (not (result ? 'exit_code') or jsonb_typeof(result->'exit_code') = 'number')
      and (not (result ? 'pass') or jsonb_typeof(result->'pass') = 'boolean')
      and case when jsonb_typeof(result->'datawrite') = 'object'
               then (result->'datawrite') - array['stage', 'query_counts', 'gate', 'write', 'check'] = '{}'::jsonb
               else false end
      and jsonb_typeof(result->'datawrite'->'stage') = 'string'
      and result->'datawrite'->>'stage' in ('gate', 'write', 'after', 'counts', 'done')
      -- query_counts: at most 44 whole numbers, 0 to 999,999,999.
      and (not (result->'datawrite' ? 'query_counts')
           or case when jsonb_typeof(result->'datawrite'->'query_counts') = 'array'
                   then jsonb_array_length(result->'datawrite'->'query_counts') <= 44
                        and jsonb_array_length(result->'datawrite'->'query_counts') = jsonb_array_length(jsonb_path_query_array(result,
                              '$.datawrite.query_counts[*] ? (@.type() == "number" && @ >= 0 && @ <= 999999999 && @ == @.floor())'))
                   else false end)
      -- gate, write, check: exactly their keys, each a whole number 0 to 999,999,999.
      and (not (result->'datawrite' ? 'gate')
           or case when jsonb_typeof(result->'datawrite'->'gate') = 'object'
                   then (result->'datawrite'->'gate') - array['added', 'dropped', 'edited'] = '{}'::jsonb
                        and jsonb_path_exists(result, '$.datawrite.gate ? (
                              @.added.type() == "number" && @.added >= 0 && @.added <= 999999999 && @.added == @.added.floor()
                              && @.dropped.type() == "number" && @.dropped >= 0 && @.dropped <= 999999999 && @.dropped == @.dropped.floor()
                              && @.edited.type() == "number" && @.edited >= 0 && @.edited <= 999999999 && @.edited == @.edited.floor())')
                   else false end)
      and (not (result->'datawrite' ? 'write')
           or case when jsonb_typeof(result->'datawrite'->'write') = 'object'
                   then (result->'datawrite'->'write') - array['expected', 'changed', 'failed', 'excluded'] = '{}'::jsonb
                        and jsonb_path_exists(result, '$.datawrite.write ? (
                              @.expected.type() == "number" && @.expected >= 0 && @.expected <= 999999999 && @.expected == @.expected.floor()
                              && @.changed.type() == "number" && @.changed >= 0 && @.changed <= 999999999 && @.changed == @.changed.floor()
                              && @.failed.type() == "number" && @.failed >= 0 && @.failed <= 999999999 && @.failed == @.failed.floor()
                              && @.excluded.type() == "number" && @.excluded >= 0 && @.excluded <= 999999999 && @.excluded == @.excluded.floor())')
                   else false end)
      and (not (result->'datawrite' ? 'check')
           or case when jsonb_typeof(result->'datawrite'->'check') = 'object'
                   then (result->'datawrite'->'check') - array['problems', 'extras', 'new_records'] = '{}'::jsonb
                        and jsonb_path_exists(result, '$.datawrite.check ? (
                              @.problems.type() == "number" && @.problems >= 0 && @.problems <= 999999999 && @.problems == @.problems.floor()
                              && @.extras.type() == "number" && @.extras >= 0 && @.extras <= 999999999 && @.extras == @.extras.floor()
                              && @.new_records.type() == "number" && @.new_records >= 0 && @.new_records <= 999999999 && @.new_records == @.new_records.floor())')
                   else false end)
      -- ok: pass, the stage done, and every part, with at least the payload's minimum of 2 counts.
      and (result->'ok' = 'false'::jsonb
           or (result ? 'pass' and result->'datawrite'->>'stage' = 'done'
               and (result->'datawrite') ?& array['query_counts', 'gate', 'write', 'check']
               and case when jsonb_typeof(result->'datawrite'->'query_counts') = 'array'
                        then jsonb_array_length(result->'datawrite'->'query_counts') >= 2 else false end))
      -- pass true: only when ok, the sum holds and step 5 found no problems.
      and (result->'pass' is distinct from 'true'::jsonb
           or (result->'ok' = 'true'::jsonb
               and jsonb_path_exists(result, '$.datawrite ? (
                     @.write.changed + @.write.failed + @.write.excluded == @.write.expected && @.check.problems == 0)',
                     '{}'::jsonb, true)))
    ), false)
  );
comment on constraint switchboard_runs_datawrite_result on public.switchboard_runs is
  'An sf_datawrite run''s result (docs/technical-spec-dataop_write-j5w.md part 3): only ok, exit_code, pass (required when ok; true only when ok, changed + failed + excluded = expected and check.problems = 0) and datawrite {stage, query_counts (up to 44 whole numbers), gate {added, dropped, edited}, write {expected, changed, failed, excluded}, check {problems, extras, new_records}}, every count a whole number 0 to 999,999,999; when ok, stage done and every part present. No rows, Ids, text or output.';

-- ============================================================================
-- 4. needs_click: sf_datawrite always. Otherwise as 242.
-- ============================================================================
create or replace function public.switchboard_needs_click(p_kind text, p_payload jsonb, p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'sf_dataop' then true -- a production data run: always, by link only (D1). Never loosen this line.
    when p_kind = 'sf_dataquery' then true -- a production export or count: always, by link only. Never loosen this line.
    when p_kind = 'sf_datawrite' then true -- a data run's write link: always, by link only. Never loosen this line.
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true       -- gitcom, gitsync: a click until the no-click project
    when p_kind = 'sf_check' then true  -- a link for now (s86pa); read-only, on a sandbox the helper proves first
    when p_kind = 'sf_read' then true   -- every Salesforce read, by link (s89a, spec 10)
    when p_kind = 'sb_setup' then true  -- writes Switchboard's config: always
    else true                           -- sql, docs and the rest of Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 10, 11.1, 11.4). Every kind does for now. sf_dataop (dataops_alfred-d4x, D1), sf_dataquery (dataop_link-k7d) and sf_datawrite (dataop_write-j5w) always do, whoever queued them, and their _click checks hold that too. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 5. switchboard_queue_helper takes sf_datawrite, which needs its project code (none is derived), and refuses a bad
--    payload with the sentence that says what to do. Same signature and grants.
-- ============================================================================
create or replace function public.switchboard_queue_helper(p_kind text, p_project_code text, p_payload jsonb,
                                                           p_headline text, p_chat_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_code    text := nullif(btrim(coalesce(p_project_code, '')), '');
  v_id      uuid;
  v_problem text;
begin
  if v_user is null then
    raise exception 'switchboard_queue_helper: no signed-in user.' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite') then
    raise exception 'switchboard_queue_helper: % is not a helper kind (git, sf_check, sf_read, sb_setup, sf_dataop, sf_dataquery, sf_datawrite).', coalesce(p_kind, 'null')
      using errcode = '23514';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'switchboard_queue_helper: the payload must be a JSON object.' using errcode = '23514';
  end if;
  if p_headline is null or btrim(p_headline) = '' then
    raise exception 'switchboard_queue_helper: a headline is required.' using errcode = '23514';
  end if;

  -- Only the strings the payload checks accept are used; anything else leaves the code null and is refused below.
  if v_code is null and p_kind in ('sf_check', 'sf_read') and jsonb_typeof(p_payload->'alias') = 'string' then
    v_code := 'sf-' || left(regexp_replace(lower(p_payload->>'alias'), '[^a-z0-9_-]', '_', 'g'), 37);
  elsif v_code is null and p_kind = 'sb_setup' and jsonb_typeof(p_payload->'client') = 'string' then
    v_code := 'sb-' || left(p_payload->>'client', 37);
  end if;
  if v_code is null then
    raise exception 'switchboard_queue_helper: % needs a project code (sf_check, sf_read and sb_setup derive one from the alias or client; git, sf_dataop, sf_dataquery and sf_datawrite never do).',
      p_kind using errcode = '23514';
  end if;

  -- dataop_write-j5w: say what is wrong with a write link's payload, and what to do, before the check refuses it.
  if p_kind = 'sf_datawrite' then
    v_problem := public.switchboard_datawrite_payload_problem(p_payload, v_code);
    if v_problem is not null then
      raise exception 'switchboard_queue_helper: refused: %', v_problem using errcode = '23514';
    end if;
  end if;

  -- The guard trigger sets fingerprint, status and needs_click; the table's checks refuse a bad code or payload.
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, chat_url, created_by)
  values (v_user, p_kind, v_code, p_payload, btrim(p_headline), p_chat_url, 'claude')
  returning id into v_id;
  return jsonb_build_object('action_id', v_id, 'project_code', v_code);
end;
$$;
comment on function public.switchboard_queue_helper(text, text, jsonb, text, text) is
  'Switchboard: queue an action the desktop helper runs (kind git, sf_check, sf_read, sb_setup, sf_dataop, sf_dataquery or sf_datawrite) for the signed-in caller, as created_by claude, and return {action_id, project_code}. git, sf_dataop, sf_dataquery and sf_datawrite need p_project_code; with none, an sf_check or sf_read uses sf-<alias> and an sb_setup sb-<client>, so the one-live-link and one-running limits hold per alias and per client. An sf_datawrite payload that fails is refused with switchboard_datawrite_payload_problem''s sentence. The guard trigger sets fingerprint, status and needs_click; the payload checks refuse what the kind does not allow. A link, where the kind needs a click, is issued separately by switchboard_issue_link (spec 10, 11.3-11.6; dataops_alfred-d4x; dataop_link-k7d; dataop_write-j5w).';
revoke all on function public.switchboard_queue_helper(text, text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_helper(text, text, jsonb, text, text) to authenticated;

-- ============================================================================
-- 6. switchboard_pickup_helper: c_all and c_prod gain sf_datawrite. It goes only to a caller that names it (the
--    default stays the four, and the six of dataop_link-k7d don't name it), only consumed by the click on its link,
--    within 15 minutes of the click, and it fails unrun past that (O6). Same signature and grants.
-- ============================================================================
create or replace function public.switchboard_pickup_helper(p_user uuid, p_kinds text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  c_prod   constant text[] := array['sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  v_kinds  text[];
  v_action public.switchboard_actions;
  v_run    uuid;
begin
  if p_user is null then
    raise exception 'switchboard_pickup_helper: no user.' using errcode = '22004';
  end if;
  if p_kinds is null then
    v_kinds := array['git', 'sf_check', 'sf_read', 'sb_setup'];
  elsif cardinality(p_kinds) = 0 or array_position(p_kinds, null) is not null or not (p_kinds <@ c_all) then
    raise exception 'switchboard_pickup_helper: p_kinds must list helper kinds only (%).', array_to_string(c_all, ', ')
      using errcode = '22023';
  else
    v_kinds := p_kinds;
  end if;

  -- A no-click action must not run long after it was queued: past 10 minutes it fails, with a run saying why.
  with expired as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_all) and status = 'queued' and not needs_click
       and picked_up_at is null and created_at < now() - interval '10 minutes'
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired before the helper picked it up: queued over 10 minutes ago, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from expired;

  -- O6: an approved production data run, export, count or write not picked up within 15 minutes of the click never runs.
  with stale as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_prod) and status = 'consumed' and picked_up_at is null
       and (link_used_at is null or link_used_at < now() - interval '15 minutes')
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired: approved over 15 minutes ago and never picked up, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from stale;

  -- Ready: clicked (consumed), or queued and needing no click. A production kind only clicked, by its link. Not while
  -- that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = any(v_kinds) and a.picked_up_at is null
     and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click))
     and (not (a.kind = any(c_prod))
          or (a.status = 'consumed' and a.needs_click and a.link_used_at is not null
              and a.link_used_at >= now() - interval '15 minutes'))
     and not exists (select 1 from public.switchboard_actions b
                      where b.user_id = p_user and b.kind = any(c_all)
                        and b.project_code = a.project_code
                        and b.picked_up_at is not null and b.status = 'consumed')
   order by a.created_at, a.id
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  update public.switchboard_actions
     set picked_up_at = now(), status = 'consumed'
   where id = v_action.id;
  insert into public.switchboard_runs (user_id, action_id, mode, summary)
  values (p_user, v_action.id, 'real', 'picked up by the helper')
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'kind', v_action.kind,
                            'project_code', v_action.project_code, 'payload', v_action.payload,
                            'fingerprint', v_action.fingerprint, 'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_helper(uuid, text[]) is
  'Switchboard: hand the helper the oldest action of p_user, of a kind in p_kinds (default git, sf_check, sf_read, sb_setup; sf_dataop, sf_dataquery and sf_datawrite only when named), that is ready to run: clicked, or queued and needing no click. An sf_dataop, sf_dataquery or sf_datawrite only when consumed by Alex''s click on its link, within 15 minutes of the click; one approved longer ago is marked failed with a run saying it expired (O6). A queued no-click action over 10 minutes old is marked failed the same way. One running at a time per project code, across every helper kind. Sets picked_up_at, marks it consumed and opens a real run row. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key (dataops_alfred-d4x; dataop_link-k7d; dataop_write-j5w).';
revoke all on function public.switchboard_pickup_helper(uuid, text[]) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid, text[]) to service_role;

-- ============================================================================
-- 7. Result: must say CONFORMANT. Then run supabase/tests/dataop_write-j5w/1_verify_sf_datawrite.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
