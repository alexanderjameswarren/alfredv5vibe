-- Purpose: Drive Mix step 12 verification. Times drive_mix_pick at 50 and 200 and a 30-day simulation at 50, as authenticated, after 112.
-- Kind: read-only verification query. It runs inside a transaction that ends in rollback, so it changes nothing and is never "applied".
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Run as one block in the SQL editor after 112; paste back the single result cell.
-- Timings are as `authenticated` (spec §4, Performance), never as postgres.
-- supabase/migrations/113_drive_mix_verify_step12_timing.sql

begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select sv.user_id from public.drive_mix_servings sv limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
set local statement_timeout = '120s';

do $$
declare
  t    timestamptz;
  p50  json;
  p200 json;
  sim  jsonb;
  ms50 int; ms200 int; mssim int;
begin
  t := clock_timestamp();
  select json_build_object('rows', count(*), 'carried', count(*) filter (where p.carried),
                           'new', count(*) filter (where not p.familiar),
                           'new_over_cap', count(*) filter (where p.new_over_cap))
    into p50 from public.drive_mix_pick(current_date, 50) p;
  ms50 := extract(epoch from clock_timestamp() - t) * 1000;

  t := clock_timestamp();
  select json_build_object('rows', count(*), 'carried', count(*) filter (where p.carried),
                           'new', count(*) filter (where not p.familiar),
                           'new_over_cap', count(*) filter (where p.new_over_cap))
    into p200 from public.drive_mix_pick(current_date, 200) p;
  ms200 := extract(epoch from clock_timestamp() - t) * 1000;

  t := clock_timestamp();
  sim := public.drive_mix_simulate(current_date, 30, null, 50);
  mssim := extract(epoch from clock_timestamp() - t) * 1000;

  perform set_config('dm.result', json_build_object(
    'pick_50',  json_build_object('ms', ms50, 'result', p50),
    'pick_200', json_build_object('ms', ms200, 'result', p200),
    'sim_30_at_50', json_build_object(
      'ms', mssim,
      'new_share_avg', sim -> 'new_songs' -> 'share_avg',
      'new_share_avg_from_day_2', sim -> 'new_songs' -> 'share_avg_from_day_2',
      'over_cap_total', sim -> 'new_songs' -> 'over_cap_total',
      'carried_per_day_avg', sim -> 'carried_per_day_avg',
      'cooling_breaks', sim -> 'cooling_breaks',
      'shortfalls', jsonb_array_length(sim -> 'shortfalls'),
      'repeat_gap', sim -> 'repeat_gap',
      'slices', sim -> 'slices')
  )::text, true);
end;
$$;

select current_setting('dm.result')::json as result;
rollback;
