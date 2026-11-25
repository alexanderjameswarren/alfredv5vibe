# Progress: sb3_runner-r4q (alfred-v5 side of Switchboard 3 plumbing)

Main thread: sb3_plumbing-n7c (switchboard repo). Spec: C:\Users\Alex\projects\switchboard\docs\technical-spec-sb3_plumbing-n7c.md
(read only here), section "sb3_runner-r4q (alfred-v5)", A2 and item M.

| Step | When | Work | Est (steps) | DB items | State |
|---|---|---|---|---|---|
| r1 | after SW step 7 | start, plan, claim | 0.25 | | done (s1) |
| r2 | after r1, before R2 | pickup expiry for every kind (15 minutes from approval) and an idempotent pickup id, in switchboard_pickup_helper and switchboard_pickup_git; test 1_verify_pickup_expiry.sql | 1 | db:fn:switchboard_pickup_helper, db:fn:switchboard_pickup_git | done (247 live) |
| ~~r3~~ | dropped at s6 | switchboard_helper_seen not needed | 0 | | dropped |
| r4 | after F, before B | runner pending route, asked by B's check at Alex's click; the runner passes the helper's pickup_id to both pickup functions | 0.5 | db:deploy | done, deployed (s2) |
| r6 | after E2, before R4 | gitnewtree payload keys (_shared/tools/switchboard.ts and test) | 0.5 | db:deploy | code done (s3); schema and mcp deploy are B3's (pages) |
| r7 | with r2, before the hand-over | L1: sf_run kind (migration 248, test 2_verify_sf_run.sql) | 1.5 | db:table:switchboard_actions, db:fn:switchboard_actions_guard, db:fn:switchboard_needs_click, db:fn:switchboard_pickup_helper, db:fn:switchboard_pickup_git | done (248 in main; 250 builds on it) |
| r8 | after 250, deploy after 251 | the runner serves sf_run: kinds, /pickup link and request, /result evidence and sample | 1 | db:deploy (s4b) | done, deployed (s4b) |
| r5 | after the hand-over, after C | sb_status kind and MCP tool | 2 | db:table:switchboard_actions, db:fn:switchboard_pickup_helper, db:fn:switchboard_needs_click, db:fn:switchboard_queue_helper, db:deploy | |

Proposed, not yet agreed: r7 (L1, sf_run kind, 1.5), which the r2 15-minute rule would cover.

## s1 (sb3_runner-r4q-s1-g7m3): r1 and r2

- supabase/migrations/247_pickup_expiry.sql queued as 9308b5ce-c031-455c-b944-e039e24a38e0; test
  supabase/tests/sb3_runner-r4q/1_verify_pickup_expiry.sql queued as 43cbdf16-4cb1-45f7-b080-afc814dbb3ad (--test).
  s1b (sb3_runner-r4q-s1b-x5d1): 247 adds switchboard_runs.failure_reason, written only by the 15-minute expiry.
  Re-queued: migration 35e95805-7c1d-498e-bade-cffc8d5878e5, test 30738ddd-26ac-455a-918b-2a4fbe4e3dcb. The old
  9308b5ce and 43cbdf16 are superseded: issue no link for them.
  Later: get_switchboard_run's RUN_COLUMNS (_shared/tools/switchboard.ts) does not return failure_reason yet.
  After 247, older tests that name switchboard_pickup_helper(uuid, text[]) error if re-run (d4x, k7d, j5w).

- The pickup id lives on the open run row as result {"pickup_id": "<uuid>"} until the helper's result replaces it, so
  no table change was needed. A column would be cleaner; it needs db:table:switchboard_actions or
  db:table:switchboard_runs, so it is left for a later step if wanted.
- Pickup id senders: the runner (r4) reads `pickup_id` from the /pickup body and passes it as p_pickup_id; the
  helper (switchboard repo, A2's retry) makes one uuid per approve click and sends it on every retry of that pickup.

## s2 (sb3_runner-r4q-s2-j4c9): r4

- /pickup takes an optional body `pickup_id` (a uuid, lower-cased; anything else is a 400 "pickup_id: not a uuid —
  ..."), checked before anything is failed or picked, and passed as p_pickup_id only when sent.
- POST /pending (pickup key, read-only): { ok, clear, unpicked: [{action_id, kind, project_code, status, approved_at,
  stale}], unreported: [{action_id, run_id, kind, project_code, picked_up_at, stale}] }. unpicked: helper kinds
  consumed, or queued needing no click, not picked up; stale past 15 (10 for queued) minutes, never runs, doesn't
  block. unreported: picked up, still consumed; every one blocks (the helper may still be running it). clear: nothing
  blocks.
- B's check (loader/install-check.mjs, switchboard repo) POSTs {} to /pending with the pickup key at Alex's click;
  refuses when clear is false, naming each unpicked (not stale) and each unreported entry by kind and action id.
- Deployed switchboard-runner; /pending without a key answers 401 from the function (an unknown route answers 404).

## s3 (sb3_runner-r4q-s3-p9f4): r7 (L1) and r6

- 248_sf_run.sql queued as 68277021-adcb-4323-b95f-345531efafe0; test 2_verify_sf_run.sql queued as
  23add94b-9e94-4ae0-8e67-8e6774260ac2 (--test). sf_run: kind, payload check (object with link_id a lower-case uuid,
  at most 200,000 bytes), click check, needs_click true, inserted consumed with created_at at most now(), handed out
  only when named, 15-minute expiry from created_at with failure_reason, in c_all of both pickups.
- r6: gitPayload takes client, lane, main (true) for gitnewtree, refused as the helper refuses them; headline
  "BINDS MAIN TO THE PROJECT" for main. Not deployed: mcp/index.ts's zod inputSchema for queue_switchboard_git lacks
  client, lane and main, so the SDK strips them before the handler; index.ts is not in this step's scope and is
  claimed by sb3_pages-h6v.
- Still needed before a helper can run an sf_run: the runner's HELPER_KINDS, pickupKinds (an eight-kind set),
  /result (output kept or dropped), LONG_PICK_KINDS (30 minutes or 4 hours) and pendingActions.

## s4 (sb3_runner-r4q-s4-k2w7): r8, the runner learns sf_run (not deployed)

- Kinds: sf_run in HELPER_KINDS (eight, passed whole) and LONG_PICK_KINDS (4 hours); the seven of dataop_write-j5w
  are still passed as seven, so never get one. /pending and the stale query take it through those lists.
- /pickup: a picked sf_run adds `link` (switchboard_run_links by payload.link_id, named columns, token_hash never read
  and stripped again in core) and `request` (switchboard_run_requests by link.request_id, whole). Either missing: the
  run closes failed, the action fails, 409 "sf_run <id>: <why> — queue the request again and approve its new link."
  A read that throws leaves the pick open; the retry with the same pickup_id gets the same action.
- /result: sfRunReportProblem (core.ts, the one place) checks {ok, pass, checks: [{check, org, commit?}], sample?}
  with 251's check names and orgs. Run row keeps {ok, exit_code?, pass?, checks?}, summary scrubbed; then
  switchboard_record_run_evidence (pass with checks), then switchboard_store_run_sample (pass, sample sent), then the
  status. Evidence before sample: 250 refuses a sample without valid evidence. Both before the status: contract 10c.
  A failed write: 503 {retry: true}, "evidence: ..." or "sample: ...", action stays consumed. Line
  "run <link id> done: PASS|done: FAIL|failed".
- No double record: the run row is written only while unfinished; 251 records a run id once (already); the sample
  is one row per request (upsert); after the status, a repeat answers already: true and writes nothing.

## s4b (sb3_runner-r4q-s4b-p6t3): against live 251, deployed

- 251's functions match s4 (names, p_run_id, {recorded, already, request_id, page}); no runner change was needed for it.
- Kind by 251's own rule (sfRunKind): pre-check if the action is the link's rerun_action_id, or its action_id with
  request base_page precheck; write if its action_id with base_page dataop or undo; else other (records nothing).
- Write: no evidence, no sample; switchboard_drop_run_sample(link.request_id) at its final status, also when its
  report is refused; a failed drop is noted in the run summary.
- Final: SQLSTATE P0002, 23514, 55000 from the evidence call fail the run at once (422, retry: false, the fix named).
  A sample refused after the evidence is in is noted, not fatal. Any other error, and any throw from the run or
  status writes, is 503 {retry: true}. index.ts's `coded` keeps the SQLSTATE on the thrown error.
- Deployed switchboard-runner (813 kB); without a key /pending, /pickup, /result and /queue answer 401 from the
  function, an unknown route 404. db:deploy released.
- Open (pages thread): a separate pre-check request's sample (s12b) is stored under the pre-check's own id; 251's
  queue moves it to the data operation, so the write's drop covers it once moved. A pre-check never followed by a
  write keeps its sample until the 24-hour prune.

## s5 (sb3_runner-r4q-s5-n3c8): the write's outcome, the 409's project_code, the panel's live link

- Drift: 252 replaced switchboard_record_run_evidence (same names, args and SQLSTATEs; adds a simulation and
  correction-page rule), 253 the preview, 254 adds switchboard_record_run_outcome. Nothing else touches the runner,
  the panel or switchboard_runs.
- Outcome: a write (sfRunKind) whose body has a write object calls switchboard_record_run_outcome(run id, write) after
  the run row and before the drop and the status, succeeded or failed, and on a refused write report after closing the
  run. 254's refusals 22023, P0002, 55000 are noted in the summary ("outcome refused (<code>): ..."); other errors
  503 {retry: true} ("outcome: ..."); a write that isn't an object is noted, not sent. Never on the run row. The reply
  adds outcome (254's reply or null) and outcome_refused.
- The /pickup 409 for a missing link or request carries project_code.
- switchboard-panel: live_link per project, null or {kind, expires_at, chat_url}, from 189's live-link rule (queried
  and checked again in core), the newest by expiry; kind deploy for sf_deploy and sf_test (227). A project with only a
  live link gets a row. waiting_on_alex unchanged. 189's switchboard_issue_link allows one live link per user, so two
  for one project should not occur.
- r6 (mcp/index.ts schema) came in from sb3_pages-h6v B3 (013e7a7). B3 (pages) owns queue_switchboard_git's schema and
  the mcp deploy; plumbing never deploys mcp.
- s5b (sb3_runner-r4q-s5b-v8p2): after the gitsync (a615cae, front end only), deployed switchboard-runner and
  switchboard-panel. No key: runner /pending, /pickup, /result, /queue 401, unknown route 404; panel 401. Panel with
  its key: 33 projects, each with report_unread, waiting_on_alex, lane, lane_order and live_link; no live link at the
  time, so every live_link null. db:deploy released.

## s6 (sb3_runner-r4q-s6-w2d9): M's runner part, and run links on the panel

- M: /pickup's every reply (200 and the sf_run 409) adds expired: [{action_id, kind, project_code}], read after the
  pickup function returns: switchboard_runs with failure_reason expired_not_picked_up and finished_at in the last 5
  minutes (EXPIRED_LOOKBACK_MS), their actions limited to HELPER_KINDS, once per action id. The expiry commits inside
  the pickup function, before it returns, so the read in the same call sees it; repeats within the window are expected
  and de-duped by the helper. A failed read leaves the field out and never fails the pickup. No new timer.
- L3d: switchboard-panel's live_link also comes from switchboard_run_links: not used, not voided, project from its
  request; kind sf_run (review_id null) or sf_review (review_id set, and only while its review is open: consume refuses
  review links, so they are never used); expires_at and chat_url null; the newest per project. A live git-style link
  wins (it expires in 30 minutes and has a chat; the run link stays lit). A failed read leaves run links out.

## Next step's scope

s7: r5, the sb_status kind and MCP tool, as planned (after the hand-over, after C), once Alex sets it.
- create: to be set at planning
- update: to be set at planning
- delete: nothing
- deploy: to be set at planning
- SQL: to be set at planning
