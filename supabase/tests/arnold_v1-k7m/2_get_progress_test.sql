-- Arnold V1 step 4: test arnold_get_progress against real microworkout executions, through a throwaway plan.
-- Run whole in the SQL editor, after the arnold_get_progress migration. It ENDS IN A DELIBERATE ERROR so everything
-- rolls back, the test plan included (and any real active plan stays active). The error message is the result:
-- copy the JSON after "ARNOLD_TEST_RESULT" and paste it back.
--
-- Expected:
--   oct28.count >= 3 and oct28.has_mvshk8e8 true (ticks at 19:11Z, 20:16Z and 21:32Z, all 2026-10-28 Pacific,
--     although that execution's closed_at is 19:00Z, before two of them);
--   oct28.checkpoints (ticks at 12:11, 13:16 and 14:32 PT) show count_by_time 0 at 10:00, 2 at 14:00, 3 at 19:00;
--   week rows for the executions goal; every refusal true.
-- supabase/tests/arnold_v1-k7m/2_get_progress_test.sql

do $$
declare
  v_plan_id uuid;
  v_result  jsonb;
  v_refused jsonb := '{}'::jsonb;
begin
  -- Act as Alex: auth.uid() reads the claims, and the authenticated role makes RLS apply as it does for the tools.
  perform set_config('request.jwt.claims',
    json_build_object('sub', '26f0707f-b586-4a3e-841c-8c313d6ab1e5', 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_plan_id := public.arnold_create_plan(
    jsonb_build_object(
      'focus', 'TEST plan for arnold_get_progress',
      'change_summary', 'Test only; rolled back.',
      'review_instructions', 'Test.',
      'nudge_instructions', 'Test.',
      'notification_settings', jsonb_build_object(
        'window_start', '05:00', 'window_end', '20:00', 'max_nudges_per_day', 3,
        'max_encouragements_per_day', 2, 'inbox_waiting_delay_minutes', 120)),
    jsonb_build_array(
      jsonb_build_object(
        'goal_key', 'microworkout', 'label', 'Microworkouts', 'intent_id', 'mur79qma8apmj8yc4i',
        'measure', 'elements', 'target', 5, 'period', 'day',
        'pace_checkpoints', jsonb_build_array(
          jsonb_build_object('time', '10:00', 'count', 1),
          jsonb_build_object('time', '14:00', 'count', 3),
          jsonb_build_object('time', '19:00', 'count', 5))),
      jsonb_build_object(
        'goal_key', 'microworkout_sessions', 'label', 'Microworkout sessions', 'intent_id', 'mur79qma8apmj8yc4i',
        'measure', 'executions', 'target', 3, 'period', 'week', 'usual_days', jsonb_build_array('tue', 'thu'))));

  -- Refusals: each must raise. true = refused as it should be.
  begin
    perform public.arnold_create_plan('{"focus":"x","review_instructions":"x","nudge_instructions":"x","pauses":[]}'::jsonb,
                                      '[]'::jsonb);
    v_refused := v_refused || '{"unknown_plan_field": false}';
  exception when others then
    v_refused := v_refused || jsonb_build_object('unknown_plan_field', true, 'unknown_plan_field_message', sqlerrm);
  end;
  begin
    update public.arnold_plans set focus = 'edited' where id = v_plan_id;
    v_refused := v_refused || '{"plan_edit": false}';
  exception when others then
    v_refused := v_refused || jsonb_build_object('plan_edit', true);
  end;
  begin
    perform public.arnold_get_progress('2026-10-29', '2026-10-01');
    v_refused := v_refused || '{"reversed_range": false}';
  exception when others then
    v_refused := v_refused || jsonb_build_object('reversed_range', true);
  end;

  with p as (
    select * from public.arnold_get_progress('2026-10-01', '2026-10-29')
  )
  select jsonb_build_object(
    'plan_id', v_plan_id,
    'rows_total', (select count(*) from p),
    'oct28', (select to_jsonb(x) || jsonb_build_object('has_mvshk8e8', 'mvshk8e8v1782hfxcb' = any (x.execution_ids))
                from p x where x.goal_key = 'microworkout' and x.local_date = '2026-10-28'),
    'oct29', (select to_jsonb(x) from p x where x.goal_key = 'microworkout' and x.local_date = '2026-10-29'),
    'microworkout_days_with_ticks', (select coalesce(jsonb_agg(jsonb_build_object(
                'date', x.local_date, 'count', x.count, 'met', x.met, 'on_track', x.on_track,
                'last_activity_at', x.last_activity_at, 'execution_ids', x.execution_ids) order by x.local_date), '[]')
                from p x where x.goal_key = 'microworkout' and x.count > 0),
    'session_weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'week_start', x.week_start, 'count', x.count, 'target', x.target, 'met', x.met,
                'on_track', x.on_track, 'days_left', x.days_left, 'execution_ids', x.execution_ids)
                order by x.week_start), '[]')
                from p x where x.goal_key = 'microworkout_sessions' and x.row_kind = 'week'),
    'refusals', v_refused
  ) into v_result;

  raise exception 'ARNOLD_TEST_RESULT %', v_result::text;
end
$$;
