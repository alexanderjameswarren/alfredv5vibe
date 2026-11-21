# Progress: dataquery_fixes-v3n

Spec: [technical-spec-dataquery_fixes-v3n.md](technical-spec-dataquery_fixes-v3n.md). Every step runs in the
dataquery_fixes-v3n worktree. Fix 3 (the git hold) is out of this project. It belongs to dataop_v2-m5j, which is also
building Switchboard's side of org_type (its s8).

Markers: ✱ a migration link, ⚙ a function deploy, ⛳ a checkpoint.

| Step | What | Marks | Estimate | Status |
|---|---|---|---|---|
| s1 | Plan (read only) | | 10m | done 2026-11-19 |
| s2 | Drift check; the spec and this file; claims; repair 243 numbered and queued | ✱ | 12m | done 2026-11-19: no drift (HEAD = main = origin/main = b682612); 14 items claimed; repair queued as action fdc7b09b-97ce-469b-a3c3-9971d16e75cc. **Repair done:** 243 ran at 20:30:41Z (run 4fc1ebc1-5d32-4464-bbd8-232f4be70f69), 1 row in each table, 7fc72d51 failed, 9ab19061 closed; both db:table claims released at s3 (db:migration:243 kept for the checkpoint) |
| s3 | Fix 2 code: tool, schema and description, headline, approve page, fixture; their tests | | 30m | done 2026-11-19: switchboard.test.mjs 103 of 103, mcp/index.test.mjs 52 of 52, mcp/tables.test.mjs 1 of 1, ApprovePage and ApproveFixture 78 of 78. The live tool strips an unknown org_type (zod v4 object), so sb's s8 links still queue before our deploy. **Tested by Alex** in the local fixture: all three banners right (production orange, sandbox blue with no PRODUCTION anywhere, old link orange with "Org type not recorded") |
| s4 | Fix 2 database: the `_pending_` migration and test script; check, gitsync (Alex), drift check, claim, number, queue | ✱ | 15m | done 2026-11-19: no drift (HEAD = main = b682612; the live guard matches the snapshot); 3 db items claimed; migration **244** (`supabase/migrations/244_org_type.sql`, db:migration:244) queued as action b9a91720-dfaf-4f88-80f8-509b7f245fc5; test queued as action 6dd0cf1e-bb79-47f1-9dd5-698719fd3804; **queued, not applied** |
| s5 | After it is applied: deploy mcp holding db:deploy, conformance, the `--test` script, verify; checkpoint (Alex) | ⚙ ⛳ | 10m | done 2026-11-19: 244 applied at 20:45:36Z (run 85773786-3158-4802-9c2f-fc20f032a75c, CONFORMANT); mcp deployed at 20:48Z ("Deployed Functions.", 4.0 MB); live check: a call with no org_type refused by the deployed schema ("expected one of "sandbox"\|"production" at org_type"), nothing queued; db:deploy and the three db: items released, 243 and 244 kept. Test 6dd0cf1e left for Alex's link; checkpoint and closeout next |
| s6 | Testing: full app suite and scripts suite | | 15m | |
| s7 | Closeout: spec marked live, `claims.cmd status`; Finish is Alex's | | 10m | |

The total estimate is 1h42 (s1 to s7).

## Files (claimed at s2)

- docs/technical-spec-dataquery_fixes-v3n.md, docs/progress-dataquery_fixes-v3n.md
- supabase/migrations/243_fail_lost_dataquery_run.sql (and db:migration:243, from number-migration)
- supabase/functions/_shared/tools/switchboard.ts and switchboard.test.mjs
- supabase/functions/mcp/index.ts and index.test.mjs
- src/switchboard/ApprovePage.jsx, ApprovePage.test.jsx, ApproveFixture.jsx, ApproveFixture.test.jsx
- supabase/tests/dataquery_fixes-v3n/

## Database items

- s2 (the repair): db:table:switchboard_actions, db:table:switchboard_runs. Claimed at s2, and kept until Alex confirms
  243 landed.
- s4 (fix 2): db:table:switchboard_actions, db:fn:switchboard_dataquery_payload_ok, db:fn:switchboard_actions_guard,
  and db:migration:NNN. Then db:deploy (mcp) at s5. Each is claimed at its own step, never before.

## s2 notes

- Live state at 20:26Z, just before queuing: action 7fc72d51 consumed and run 9ab19061 open, both unchanged since s1.
- The `_pending_` file was numbered 243 by `claims.cmd number-migration`, and then deleted.

## s3 notes

- Tool: `org_type` is in `DATAQUERY_KEYS` and `DATAQUERY_ORG_TYPES`. It is checked first, and refused when it is
  missing or any other value, with the message "`org_type` must be exactly "sandbox" or "production", as sb printed
  it, not "<value>"". The headline begins `SANDBOX` or `PRODUCTION`, and keeps the existing `EXPORT` and `COUNTS`
  words. The `next` text names the same org. `alias` no longer says "production org".
- The mcp schema has `org_type: z.enum(["sandbox", "production"])` (required), and the description has "a PRODUCTION
  or SANDBOX banner from org_type". mcp/index.test.mjs stubs zod, so its check reads the registration source.
- Page: the sandbox banner is `approve-sandbox-read`, `bg-sky-700 text-white`, with the text "Sandbox, read only". The
  production banner is unchanged (`approve-production-read`). With no org_type, the production banner adds
  `approve-org-type-missing`, "Org type not recorded". The helper is `dataqueryOrgType`. The fixture has two new
  choices, `sandbox` and `untyped`.
- **The live tool before our deploy:** the MCP SDK (1.30.0) parses arguments with a zod v4 object, which drops keys it
  doesn't know. Checked: `{alias, org_type}` parses to `{alias}`. So an org_type argument is silently stripped, and
  the payload is stored without it. Today's payload check accepts that payload, so sb's s8 links queue normally.
- **Deploy order (s4/s5):** there is a gap whichever goes first.
  - The new tool sends org_type, which today's `switchboard_dataquery_payload_ok` rejects as an unknown key.
  - The old tool strips org_type, which the new guard refuses on insert.
  - So deploy mcp straight after the migration is applied, in the same step. sf_dataquery queuing fails for those
    few minutes, and nothing else does.

## Timing log (measured run time per step)

| Step | Start | End | Time |
|---|---|---|---|
| s1 | 12:16:10 | 12:19:21 | 3m 11s |
| s2 | 12:25:34 | 12:26:52 | 1m 18s |
| s3 | 12:31:46 | 12:34:38 | 2m 52s |
| s4 | 12:40:03 | 12:43:19 | 3m 16s |
| s5 | 12:47:58 | 12:49:12 | 1m 14s |

## s4 notes

- 244 replaces two functions with their signatures unchanged, and updates one column comment. The payload function is
  242's with only `org_type` added: in `c_keys`, and checked when present. The guard is the live definition (checked
  against the database) plus the INSERT-only rule, errcode 23514, "a new sf_dataquery needs payload.org_type, exactly
  "sandbox" or "production", as sb prints it." Grants are restated as they were (authenticated and service_role,
  nothing for public or anon). The file ends with `platform_check_conformance()`.
- The test (`1_verify_org_type.sql`) makes 23 checks: the payload check alone (8); sandbox and production inserts pass;
  missing, "prod" and null are refused, with the message; the oldest sf_dataquery row without org_type can still
  change status; a git insert is unaffected; the grants; the trigger is still attached; conformance. It is all undone.
- The test must run only after 244 is applied. Run before 244, it fails on the insert checks.

## Next step's scope

Run tag: dataquery_fixes-v3n-s6-xxxx (checkpoint and closeout: s6 testing and s7)
- create: nothing
- update: docs/technical-spec-dataquery_fixes-v3n.md (marked live)
- delete: nothing
- deploy: nothing
- SQL: none (read the result of test 6dd0cf1e once Alex has approved it)
- Before it: Alex runs a gitpush Checkpoint of supabase/migrations/243_fail_lost_dataquery_run.sql,
  supabase/migrations/244_org_type.sql, supabase/tests/dataquery_fixes-v3n/1_verify_org_type.sql,
  supabase/functions/_shared/tools/switchboard.ts and supabase/functions/mcp/index.ts (it releases db:migration:243
  and 244)
- Then: `claims.cmd status` (no db: claims), full suites (app and scripts), `check_platform_conformance`; Finish is
  Alex's
