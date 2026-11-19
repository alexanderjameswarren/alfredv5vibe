-- 243: dataquery_fixes-v3n fix 1: fail the lost sf_dataquery action 7fc72d51 and close its open run 9ab19061.
-- Kind: one-off data repair, applied once. Applied: NO (queued at s2; only a run id shows it ran).
-- Spec: docs/technical-spec-dataquery_fixes-v3n.md (Fix 1).
-- Its window was closed before it finished, so the helper never reported; switchboard_pickup_helper held every
-- dataop_v2-m5j link behind it. Both updates are guarded: if the runner's stale limit or the helper's lostRunReport
-- closed it first, each touches 0 rows and --expect 1,1 fails. Nothing else fires (no chat line, signal or notification).

update public.switchboard_actions
   set status = 'failed'
 where id = '7fc72d51-bf6d-44a6-b98d-86efee63af24'
   and kind = 'sf_dataquery' and status = 'consumed' and picked_up_at is not null;

update public.switchboard_runs
   set summary = 'lost: its window was closed before it finished',
       result = '{"ok": false, "lost": true}'::jsonb,
       finished_at = now()
 where id = '9ab19061-25c1-4f7a-a2c7-0088ac3e97ae'
   and action_id = '7fc72d51-bf6d-44a6-b98d-86efee63af24' and mode = 'real' and finished_at is null;
