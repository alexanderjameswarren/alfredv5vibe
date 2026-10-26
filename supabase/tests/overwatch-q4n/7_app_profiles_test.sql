-- Overwatch Step 9: app_profiles under owner RLS, its stamps and its checks. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE. The error undoes everything it wrote, so nothing is saved. It runs as the user who
-- owns the Money context (Alex), the same user 091 and 168 seed for.
-- The error starts "APP PROFILES TEST PASSED" or "APP PROFILES TEST FAILED".
-- supabase/tests/overwatch-q4n/7_app_profiles_test.sql

do $$
declare
  v_uid    uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_id     uuid;
  v_stamp  timestamptz;
  v_n      int;
  v_err    text;
  v_res    jsonb := '{}'::jsonb;
  v_failed text;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- a. Insert with no current_state: no state stamp, owner from auth.uid().
  insert into public.app_profiles (app_id, rhythm_days) values ('overwatch', 7) returning id into v_id;
  v_res := v_res || jsonb_build_object(
    'a_owner_is_caller', exists (select 1 from public.app_profiles where id = v_id and user_id = v_uid),
    'a_no_state_stamp', (select current_state_updated_at is null from public.app_profiles where id = v_id));

  -- b. Writing current_state stamps it.
  update public.app_profiles set current_state = 'TEST state (rolled back)' where id = v_id;
  select current_state_updated_at into v_stamp from public.app_profiles where id = v_id;
  v_res := v_res || jsonb_build_object('b_state_stamped', v_stamp is not null);

  -- c. Another column changing leaves the stamp; a client-supplied stamp is ignored.
  update public.app_profiles set rhythm_days = 14, current_state_updated_at = '2000-01-01' where id = v_id;
  v_res := v_res || jsonb_build_object(
    'c_stamp_kept', (select current_state_updated_at = v_stamp from public.app_profiles where id = v_id));

  -- d. One profile per app.
  v_err := null;
  begin
    insert into public.app_profiles (app_id) values ('overwatch');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('d_duplicate_refused', v_err is not distinct from '23505');

  -- e. rhythm_days must be 1 to 365.
  v_err := null;
  begin
    update public.app_profiles set rhythm_days = 0 where id = v_id;
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('e_rhythm_zero_refused', v_err is not distinct from '23514');

  -- f. The app must exist.
  v_err := null;
  begin
    insert into public.app_profiles (app_id) values ('no_such_app');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('f_unknown_app_refused', v_err is not distinct from '23503');

  -- g. Another user neither sees nor changes it.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.app_profiles where id = v_id;
  v_res := v_res || jsonb_build_object('g_hidden_from_other_user', v_n = 0);
  update public.app_profiles set rhythm_days = 30 where id = v_id;
  get diagnostics v_n = row_count;
  v_res := v_res || jsonb_build_object('g_other_user_cannot_update', v_n = 0);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;

  if v_failed is null then
    raise exception 'APP PROFILES TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'APP PROFILES TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
