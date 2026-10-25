-- Overwatch Step 25: process_friction status. Run after the friction status migration. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE. The error undoes everything it wrote, so nothing is saved. It writes its own test
-- entries as the user who owns the Money context (Alex), and only reads the real ones.
-- The error starts "FRICTION STATUS TEST PASSED" or "FRICTION STATUS TEST FAILED".
-- supabase/tests/overwatch-q4n/19_friction_status_test.sql

do $$
declare
  v_uid    uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  t        text := 'TEST ow25 ' || substr(gen_random_uuid()::text, 1, 8);
  v_id     uuid;
  v_res    jsonb := '{}'::jsonb;
  v_failed text;
  v_err    text;
  n        int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- 0. The backfill: nothing resolved is still open, and nothing open has a resolved stamp.
  v_res := v_res || jsonb_build_object(
    '0_backfill_consistent', not exists (select 1 from public.process_friction
                                         where (status = 'open') <> (resolved_at is null)));

  -- a. A new entry is open.
  insert into public.process_friction (what_happened, process) values (t, 'skill:sam-practice') returning id into v_id;
  insert into public.process_friction (what_happened, process) values (t, 'skill:sam-practice'), (t, 'inbox');
  v_res := v_res || jsonb_build_object(
    'a_default_open', (select status from public.process_friction where id = v_id) = 'open');

  -- b. fixed needs the resolved stamp; with it, it saves.
  v_err := null;
  begin update public.process_friction set status = 'fixed' where id = v_id;
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('b_fixed_needs_stamp', v_err is not distinct from '23514');
  update public.process_friction set status = 'fixed', resolved_by = 'TEST skill change', resolved_at = now() where id = v_id;
  v_res := v_res || jsonb_build_object(
    'b_fixed_saved', (select status from public.process_friction where id = v_id) = 'fixed');

  -- c. fixed cannot carry a wont_fix_reason.
  v_err := null;
  begin update public.process_friction set wont_fix_reason = 'TEST' where id = v_id;
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('c_fixed_no_reason', v_err is not distinct from '23514');

  -- d. wont_fix needs a reason, not blank; with one and the stamp, it saves.
  update public.process_friction set status = 'open', resolved_by = null, resolved_at = null where id = v_id;
  v_res := v_res || jsonb_build_object(
    'd_reopened', (select status = 'open' and resolved_at is null from public.process_friction where id = v_id));
  v_err := null;
  begin update public.process_friction set status = 'wont_fix', resolved_by = 'alex', resolved_at = now() where id = v_id;
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('d_wont_fix_needs_reason', v_err is not distinct from '23514');
  v_err := null;
  begin update public.process_friction set status = 'wont_fix', wont_fix_reason = '  ', resolved_by = 'alex', resolved_at = now()
    where id = v_id;
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('d_blank_reason_refused', v_err is not distinct from '23514');
  update public.process_friction set status = 'wont_fix', wont_fix_reason = 'TEST one-off', resolved_by = 'alex',
    resolved_at = now() where id = v_id;
  v_res := v_res || jsonb_build_object(
    'd_wont_fix_saved', (select status from public.process_friction where id = v_id) = 'wont_fix');

  -- e. open cannot carry a stamp or a reason; an unknown status is refused.
  v_err := null;
  begin insert into public.process_friction (what_happened, process, resolved_by, resolved_at) values (t, 'other', 'x', now());
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('e_open_no_stamp', v_err is not distinct from '23514');
  v_err := null;
  begin insert into public.process_friction (what_happened, process, wont_fix_reason) values (t, 'other', 'x');
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('e_open_no_reason', v_err is not distinct from '23514');
  v_err := null;
  begin insert into public.process_friction (what_happened, process, status) values (t, 'other', 'parked');
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('e_unknown_status_refused', v_err is not distinct from '23514');

  -- f. The trigger count sees only open entries: two of the three test entries.
  select count(*) into n from public.process_friction where what_happened = t and status = 'open';
  v_res := v_res || jsonb_build_object('f_open_count', n = 2);

  -- g. Another user sees none of it.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select count(*) into n from public.process_friction;
  v_res := v_res || jsonb_build_object('g_hidden_from_other_user', n = 0);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;
  if v_failed is null then
    raise exception 'FRICTION STATUS TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'FRICTION STATUS TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
