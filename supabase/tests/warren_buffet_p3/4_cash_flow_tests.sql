-- Purpose: Warren Buffet Phase 3 Step 9e tests, run after 153_wb_phase3_step9e_overview_cash_flow.sql (spec A52, A53): wb_action_items.cash_flow (last 30 days actual leaving out own-account transfers, card payments, pending rows and older rows; next 30 days from the projection; the typical month from wb_true_cost; runway months only for a monthly shortfall); the big flag on coming_up rows; card fee flags over 90 days, turned info by a matching credit and cleared only by a review with a note; and below_floor.path.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Dated checks use 2031-06-20, so real data does not decide them. The typical month and runway are
-- read from wb_true_cost (today), so a fixture repeating item pushes it negative, then positive. Run the whole file.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/tests/warren_buffet_p3/4_cash_flow_tests.sql

create or replace function pg_temp.zz_txn(p_acct uuid, p_on date, p_amount numeric, p_desc text, p_pending boolean default false)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw, pending)
  select a.user_id, a.context_id, p_acct, 'ZZ-P9E-' || gen_random_uuid(), (p_on + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, p_desc, p_desc, '{}', p_pending
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_acct(p_name text, p_role text)
returns uuid
language sql
as $$
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  select c.user_id, c.id, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), p_name, p_role
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create or replace function pg_temp.zz_pair(p_a uuid, p_b uuid)
returns void
language sql
as $$
  update public.wb_transactions set transfer_pair_id = p_b, kind = 'transfer', kind_source = 'manual' where id = p_a;
  update public.wb_transactions set transfer_pair_id = p_a, kind = 'transfer', kind_source = 'manual' where id = p_b;
$$;

create or replace function pg_temp.zz_rows(p_r jsonb, p_section text, p_id text)
returns jsonb
language sql
as $$ select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(p_r -> p_section) e where e ->> 'link_id' = p_id; $$;

create or replace function pg_temp.wb_test_p3_step9e()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  t      date := date '2031-06-20';
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  chk uuid; card uuid; sav uuid; ec uuid; ec2 uuid;
  a uuid; b uuid;
  p_big uuid; p_small uuid; p_in uuid; p_month uuid;
  f_old uuid; f_ancient uuid; f_refunded uuid; f_elsewhere uuid; f_handled uuid; f_rev_only uuid; f_note_only uuid;
  x_refund uuid; f_ref_handled uuid;
  c_roof numeric; v_burn4 numeric;
  r jsonb; r2 jsonb; cf jsonb; path jsonb;
  v_next numeric; v_typ numeric;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  chk := pg_temp.zz_acct('ZZ checking ' || k, 'spending_cash');
  card := pg_temp.zz_acct('ZZ card ' || k, 'credit_card');
  sav := pg_temp.zz_acct('ZZ reserve ' || k, 'reserve_cash');
  insert into public.wb_balance_snapshots (user_id, context_id, account_id, as_of, balance, source)
  values (v_user, v_ctx, chk, t, 1000000, 'manual');

  -- ---------------------------------------------------------------- last 30 days: 1000 - 300 - 50 - 10 = 640
  perform pg_temp.zz_txn(chk, t - 5, 1000, 'ZZ PAYROLL');
  perform pg_temp.zz_txn(chk, t - 10, -300, 'ZZ GROCER');
  perform pg_temp.zz_txn(card, t - 3, -50, 'ZZ CAFE');
  perform pg_temp.zz_txn(chk, t - 29, -10, 'ZZ EDGE IN');                -- the 30th day back counts
  perform pg_temp.zz_txn(chk, t - 30, -70, 'ZZ EDGE OUT');               -- one day older does not
  perform pg_temp.zz_txn(chk, t - 2, -999, 'ZZ PENDING', true);          -- pending never counts
  a := pg_temp.zz_txn(chk, t - 4, -200, 'ZZ TO RESERVE');                -- a move to our own reserve
  b := pg_temp.zz_txn(sav, t - 4, 200, 'ZZ FROM CHECKING');
  perform pg_temp.zz_pair(a, b);
  a := pg_temp.zz_txn(chk, t - 6, -400, 'ZZ CARD PAYMENT');              -- a card payment, paired
  b := pg_temp.zz_txn(card, t - 6, 400, 'ZZ PAYMENT THANK YOU');
  perform pg_temp.zz_pair(a, b);
  b := pg_temp.zz_txn(card, t - 7, 100, 'ZZ PAYMENT RECEIVED');          -- a card payment the sync did not pair
  update public.wb_transactions set kind = 'transfer', kind_source = 'manual' where id = b;

  -- ---------------------------------------------------------------- coming up: big only for money out over 1000
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S9E roof', -50000, t + 3, 'invoiced') returning id into p_big;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S9E lunch', -50, t + 4, 'invoiced') returning id into p_small;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S9E refund', 5000, t + 5, 'invoiced') returning id into p_in;
  -- A repeating bill big enough to make the typical month a shortfall.
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit)
  values (v_user, v_ctx, 'ZZ S9E huge monthly', -100000000, t + 40, 1, 'month') returning id into p_month;

  -- ---------------------------------------------------------------- card fee flags (A53), on emergency credit,
  -- which flags cover and cash flow leaves out
  ec := pg_temp.zz_acct('ZZ line ' || k, 'emergency_credit');
  ec2 := pg_temp.zz_acct('ZZ line two ' || k, 'emergency_credit');
  f_old := pg_temp.zz_txn(ec, t - 80, -15, 'INTEREST CHARGE');                  -- inside 90 days
  f_ancient := pg_temp.zz_txn(ec, t - 100, -16, 'LATE FEE');                    -- outside
  f_refunded := pg_temp.zz_txn(ec, t - 20, -17, 'ANNUAL FEE');
  x_refund := pg_temp.zz_txn(ec, t - 10, 17, 'ANNUAL FEE REVERSAL');            -- the same amount back: info, not cleared
  f_ref_handled := pg_temp.zz_txn(ec, t - 25, -23, 'LATE FEE');
  perform pg_temp.zz_txn(ec, t - 12, 23, 'LATE FEE REVERSAL');                  -- refunded and handled: gone
  update public.wb_transactions set reviewed = true, notes = 'ZZ refund checked' where id = f_ref_handled;
  f_elsewhere := pg_temp.zz_txn(ec, t - 20, -18, 'LATE FEE');
  perform pg_temp.zz_txn(ec2, t - 10, 18, 'ZZ CREDIT');                         -- on another account: does not
  f_handled := pg_temp.zz_txn(ec, t - 15, -19, 'LATE FEE');
  update public.wb_transactions set reviewed = true, notes = 'ZZ called, fee waived next statement' where id = f_handled;
  f_rev_only := pg_temp.zz_txn(ec, t - 14, -21, 'INTEREST CHARGE');
  update public.wb_transactions set reviewed = true where id = f_rev_only;
  f_note_only := pg_temp.zz_txn(ec, t - 13, -22, 'INTEREST CHARGE');
  update public.wb_transactions set notes = 'ZZ waiting on the bank' where id = f_note_only;

  -- ---------------------------------------------------------------- the floor: just above the day the roof lands
  insert into public.wb_settings (user_id, context_id, horizon_months) values (v_user, v_ctx, 12)
  on conflict (context_id) do nothing;
  select closing into c_roof from public.wb_cash_projection(false, t) where day = t + 3;
  update public.wb_settings set safety_floor = c_roof + 1 where context_id = v_ctx;

  r := public.wb_action_items(14, 1000, 60, t);
  cf := r -> 'cash_flow';
  path := r -> 'below_floor' -> 'path';
  select round(sum(burn), 2) into v_burn4 from public.wb_cash_projection(false, t) where day <= t + 3;

  checks := checks || jsonb_build_object(
    'flag_inside_90_days', jsonb_array_length(pg_temp.zz_rows(r, 'flags', f_old::text)) = 1,
    'flag_outside_90_days_left_out', jsonb_array_length(pg_temp.zz_rows(r, 'flags', f_ancient::text)) = 0,
    'flag_refund_stays_as_info', (pg_temp.zz_rows(r, 'flags', f_refunded::text) -> 0 ->> 'severity') = 'info'
                                 and (pg_temp.zz_rows(r, 'flags', f_refunded::text) -> 0 -> 'refund' ->> 'link_id') = x_refund::text
                                 and (pg_temp.zz_rows(r, 'flags', f_refunded::text) -> 0 -> 'refund' ->> 'amount')::numeric = 17
                                 and (pg_temp.zz_rows(r, 'flags', f_refunded::text) -> 0 -> 'refund' ->> 'on') = (t - 10)::text,
    'flag_refund_plus_handled_gone', jsonb_array_length(pg_temp.zz_rows(r, 'flags', f_ref_handled::text)) = 0,
    'flag_credit_elsewhere_stays_red', (pg_temp.zz_rows(r, 'flags', f_elsewhere::text) -> 0 ->> 'severity') = 'red'
                                       and pg_temp.zz_rows(r, 'flags', f_elsewhere::text) -> 0 -> 'refund' = 'null'::jsonb,
    'flag_handled_without_refund_gone', jsonb_array_length(pg_temp.zz_rows(r, 'flags', f_handled::text)) = 0,
    'flag_reviewed_without_note_stays_red', (pg_temp.zz_rows(r, 'flags', f_rev_only::text) -> 0 ->> 'severity') = 'red',
    'flag_shows_note', (pg_temp.zz_rows(r, 'flags', f_note_only::text) -> 0 ->> 'note') = 'ZZ waiting on the bank',
    'flag_todo_says_how', (pg_temp.zz_rows(r, 'flags', f_old::text) -> 0 ->> 'todo') like '%tick Reviewed%');

  checks := checks || jsonb_build_object(
    'path_first_below_is_the_roof_day', r -> 'below_floor' ->> 'first_below_on' = (t + 3)::text,
    'path_starts_with_the_opening', path -> 0 ->> 'type' = 'start'
                                    and (path -> 0 ->> 'balance')::numeric
                                        = (select opening from public.wb_cash_projection(false, t) where day = t),
    'path_has_the_roof_with_its_balance', exists (select 1 from jsonb_array_elements(path) e
                                                  where e ->> 'link_id' = p_big::text and (e ->> 'amount')::numeric = -50000
                                                    and (e ->> 'balance')::numeric = c_roof and (e ->> 'below')::boolean),
    'path_first_below_row_on_that_day', (select e ->> 'on' from jsonb_array_elements(path) with ordinality x(e, n)
                                         where (e ->> 'below')::boolean order by n limit 1) = (t + 3)::text,
    -- One row for the four days up to the roof, unless there is no burn rate at all (then none).
    'path_weekly_burn_row', (select count(*) from jsonb_array_elements(path) e where e ->> 'type' = 'burn')
                            = case when v_burn4 = 0 then 0 else 1 end
                            and (v_burn4 = 0 or exists (select 1 from jsonb_array_elements(path) e
                                        where e ->> 'type' = 'burn' and e ->> 'on' = (t + 3)::text
                                          and (e ->> 'amount')::numeric = v_burn4)),
    'path_in_date_order', not exists (select 1 from jsonb_array_elements(path) with ordinality x(e, n)
                                      join jsonb_array_elements(path) with ordinality y(f, m) on m = n + 1
                                      where (f ->> 'on')::date < (e ->> 'on')::date),
    'path_stops_at_first_below', not exists (select 1 from jsonb_array_elements(path) e where (e ->> 'on')::date > t + 3),
    'path_keeps_causes', jsonb_typeof(r -> 'below_floor' -> 'causes') = 'array');
  select max(p.closing) filter (where p.day = t + 30) - max(p.opening) filter (where p.day = t) into v_next
  from public.wb_cash_projection(false, t) p;
  select net_monthly into v_typ from public.wb_true_cost;

  checks := checks || jsonb_build_object(
    'cash_flow_present', jsonb_typeof(cf) = 'object' and (cf ->> 'days')::int = 30,
    'last_30_leaves_out_transfers_pending_and_older', (cf ->> 'last_30_actual')::numeric = 640,
    'next_30_is_the_projection_change', (cf ->> 'next_30_projected')::numeric = round(v_next, 2),
    'typical_month_is_net_monthly', (cf ->> 'typical_month')::numeric = round(v_typ, 2) and v_typ < 0,
    'runway_is_reserve_over_shortfall', (cf ->> 'runway_months')::numeric
                                         = round((cf ->> 'reserve_balance')::numeric / -v_typ, 1),
    'big_money_out', (pg_temp.zz_rows(r, 'coming_up', p_big::text) -> 0 ->> 'big')::boolean,
    'small_not_big', (pg_temp.zz_rows(r, 'coming_up', p_small::text) -> 0 ->> 'big')::boolean = false,
    'money_in_never_big', (pg_temp.zz_rows(r, 'coming_up', p_in::text) -> 0 ->> 'big')::boolean = false,
    'every_coming_up_row_has_big', not exists (select 1 from jsonb_array_elements(r -> 'coming_up') e
                                               where jsonb_typeof(e -> 'big') <> 'boolean'),
    'big_follows_p_big_amount', (pg_temp.zz_rows(public.wb_action_items(14, 10, 60, t), 'coming_up', p_small::text) -> 0 ->> 'big')::boolean);

  -- No shortfall: the same item as income makes the typical month positive, so no runway.
  -- With the floor at 0 the projection never dips below it, so there is no path.
  update public.wb_planned_items set amount = 100000000 where id = p_month;
  update public.wb_settings set safety_floor = 0 where context_id = v_ctx;
  r2 := public.wb_action_items(14, 1000, 60, t);
  checks := checks || jsonb_build_object(
    'no_runway_without_shortfall', (r2 -> 'cash_flow' ->> 'typical_month')::numeric > 0
                                   and r2 -> 'cash_flow' -> 'runway_months' = 'null'::jsonb,
    'no_path_above_the_floor', r2 -> 'below_floor' ->> 'first_below_on' is null
                               and r2 -> 'below_floor' -> 'path' = '[]'::jsonb);

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step9e();
