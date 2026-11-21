# Progress: dataop_link-k7d

Spec: [technical-spec-dataop_link-k7d.md](technical-spec-dataop_link-k7d.md). The flow is Data run v2, in
`C:\Users\Alex\projects\switchboard\docs\technical-spec-dataop_v2-m5j.md` ("A1 contract"). Every step runs in the
dataop_link-k7d worktree.

**A1 must land before dataop_v2-m5j's s4** (exports by link); its s6 and s8 use it too. A2 (sf_dataop's v2 payload)
is a separate later piece, not in this project.

Markers: ✱ a migration link, ⚙ a function deploy, ⛳ a checkpoint.

| Step | What | Marks | Estimate | Status |
|---|---|---|---|---|
| s1 | Plan (read only) | | 12m | done 2026-11-19 |
| s2 | Confirm and claim; this spec and progress file | | 18m | done 2026-11-19 |
| s3 | The `_pending_` migration and the test script, written but not queued | | 45m | done 2026-11-19: written, not run (no database here); results use `query_counts`, and the payload function is stable, not immutable (spec to follow at s4) |
| s4 | Queue tool `queue_switchboard_sf_dataquery`, its registration, and their tests; the spec's s3 corrections; the s3 draft gains the undo step and leading blank space | | 40m | done 2026-11-19: switchboard.test.mjs 101 of 101, mcp/index.test.mjs 52 of 52; 229 tools registered |
| s5 | Runner: kinds, pickup sets, 4-hour limit, `/result` counts and pass; tests | | 10m | done 2026-11-19: core.test.mjs 95 of 95 |
| s6 | Approval page and dev fixture; tests | | 10m | done 2026-11-19: ApprovePage and ApproveFixture tests 73 of 73; sf_dataop's run limit checked, unchanged (4 hours before and after); Alex's look in Chrome's mobile view pending |
| s7 | The SOQL wrap fix; database steps 1 to 5: check, gitsync (Alex), drift check, claim, number | | 6m | done 2026-11-19: ApprovePage tests 65 of 65; no drift (HEAD = main = origin/main = 332b956); 7 db items claimed; migration **242** (`supabase/migrations/242_sf_dataquery.sql`, db:migration:242) |
| s7b | Database steps 5 to 6: write 242, delete the `_pending_` file, queue 242 | ✱ | 4m | done 2026-11-19: 242 differs from the draft only in its two header lines; queued as action 29bfafda-cb87-486b-b33c-1545d80353c4; **queued, not applied** |
| s7c | After 242 is applied: the test (`--test`), deploy mcp and switchboard-runner holding db:deploy, conformance, verify | ⚙ | 6m | blocked 2026-11-19: 242 applied (run c970c51b-77d8-4c28-ba01-d946df57db83, every statement ok, CONFORMANT, 119 tables); the deploy guard refused, 2 commits behind main; redone as s7d |
| s7d | s7c after Alex's gitsync: deploy mcp and switchboard-runner, queue the test | ⚙ | 6m | done 2026-11-19: main in HEAD; mcp and switchboard-runner deployed ("Deployed Functions."); /queue unauthenticated gives 401; test queued as action ef98db57-34a1-4dd2-9a0b-c7a482e02400, result pending |
| s7e | Checkpoint 242, the test script and both functions to main (Alex), then `claims.cmd status` | ⛳ | 5m | done 2026-11-19: test ef98db57 passed 87 of 87 (run b57ae375-b52f-4705-b218-45c217c85098); checkpoint ede8d05 with the 9 paths; every db: claim released |
| s8 | Full suites, spec marked live; Finish is Alex's | | 8m | done 2026-11-19: app 3,364 passed, 7 skipped, 0 failed; switchboard 101, mcp index 52, mcp tables 1, runner 95, scripts 77, all passing; no db: claim held |

The total estimate is 3h45 (s1 to s8; s3 to s8 are 3h15).

## Files (claimed at s2)

- docs/technical-spec-dataop_link-k7d.md, docs/progress-dataop_link-k7d.md
- supabase/migrations/_pending_dataop_link-k7d_sf_dataquery.sql, supabase/tests/dataop_link-k7d/
- supabase/functions/_shared/tools/switchboard.ts and .test.mjs
- supabase/functions/mcp/index.ts and index.test.mjs
- supabase/functions/switchboard-runner/core.ts, core.test.mjs and index.ts
- src/switchboard/ApprovePage.jsx, ApprovePage.test.jsx, ApproveFixture.jsx, ApproveFixture.test.jsx

## s7: database items (claimed at s7, after gitsync, never before)

- `db:table:switchboard_actions`
- `db:table:switchboard_runs` (the result check)
- `db:fn:switchboard_dataquery_payload_ok` (new)
- `db:fn:switchboard_needs_click`
- `db:fn:switchboard_queue_helper`
- `db:fn:switchboard_pickup_helper`
- `db:deploy` (mcp and switchboard-runner)
- `db:migration:NNN`, from `claims.cmd number-migration`

## s3 notes

- **`query_counts`, not `counts`.** An sql run's result already stores `counts` (core.ts, runSql), so a result check
  keyed on `counts` would refuse existing rows. sf_dataquery's result is `{ok, exit_code?, query_counts, pass}`; the
  runner (s5) and the spec (s4) use that name.
- **The runs check is not kind-aware.** A CHECK can't see the action's kind, so it constrains any result carrying
  `query_counts`; that an sf_dataquery result always carries it, matched to the payload by position, is the runner's
  check (s5).
- **`switchboard_dataquery_payload_ok` is stable**, not immutable as the spec says: `convert_to` is stable.
- ~~Exports and counts must start with SELECT~~: changed at s4. Blank space (`[ \t\r\n]`) may come first; a comment
  first is still refused.

## s4 notes

- **Undo** (Alex): `undo` is an export step, in the payload function, the queue tool, the MCP schema and the spec.
- **Blank space is `[ \t\r\n]`, not `\s`,** in both the database function and the tool: the two `\s` sets differ
  (JavaScript's includes non-breaking and other Unicode spaces), and the tool must not disagree with the database.
- **The payload cap is measured as Postgres prints jsonb** (`jsonbTextLength`), so 220,000 means the same in both.
- The test script gained: an undo export, leading-newline export and count accepted; undo on a count link, undo with
  a count's SOQL, a hash of the SOQL without its leading newline, and a comment before SELECT refused.

## s5 notes

- **Pickup:** six kinds are passed on whole; the five of dataops_alfred-d4x are now passed on too, so they still get
  sf_dataop and never sf_dataquery; four and three get the default, as before. The Switchboard helper's fallback chain
  (six, then five, then four) is served at every link.
- **The 4-hour limit** is `LONG_PICK_KINDS` (sf_dataop, sf_dataquery) in index.ts's stalePicks; others keep 30 minutes.
- **`/result` for sf_dataquery** keeps `{ok, exit_code?, query_counts, pass}` only and scrubs the summary with
  blankIds. A report with query_counts missing (when ok), the wrong length, a non-whole number, or no boolean pass
  (when ok) gets a 400. The run closes as failed, its summary saying "refused by the runner: <why>", and its result is
  `{ok: false}`. A failed run may leave out query_counts.
- `exit_code` is kept beside the four, as the spec's part 5 and the database's check allow.

## s6 notes

- **sf_dataop's run limit:** main's stalePicks gave sf_dataop 4 hours (`.eq("kind", "sf_dataop")` with
  `dataopBefore`), and it still has 4 hours (`.in("kind", LONG_PICK_KINDS)`). Same, so neither runner file changed.
- **The page:** an orange "Production, read only" banner with "Bulk exports" or "Counts". Then the org, repo, run folder,
  run tag and request hash. Each query follows, in order, with its step, its file or rule label, and a 12-character
  hash that shows the full value on hover (title) and on expand (details). Its SOQL is in a `pre` that wraps
  (`whitespace-pre-wrap break-all`), keeps blank space and is never cut. A line says what comes back. The approve,
  cancel and expiry flow is the helper kinds' own. The chat line is `dataquery <action id>`.
- **The fixture:** `/approve-fixture/sf_dataquery`, with a Link picker: manifest and undo, a leading newline, a count
  link, and a 100,000-character export.

## s7 notes

- **Wrap fix:** the SOQL block is `whitespace-pre-wrap break-words` (overflow-wrap: break-word), not `break-all`.
  It wraps at spaces, and breaks inside a word only when one word is wider than the box. Blank space and line breaks
  are kept, and nothing is cut.
- **Drift:** none. HEAD, main and origin/main are all 332b956, the commit this worktree started on, so the sync brought
  no migration or function change.
- **Number:** 242. The command skipped 241, which is issued or claimed elsewhere.
- **Held now:** db:table:switchboard_actions, db:table:switchboard_runs, db:fn:switchboard_dataquery_payload_ok,
  db:fn:switchboard_needs_click, db:fn:switchboard_queue_helper, db:fn:switchboard_pickup_helper, db:deploy and
  db:migration:242. The Checkpoint at s7b releases them.

## s7b notes

- 242 is the s7 draft with the number in its first header line and "queued at s7b" in its third; nothing else changed
  (diff checked). The `_pending_` file is deleted.
- Queued: action **29bfafda-cb87-486b-b33c-1545d80353c4**. The runner's headline is "THIS CHANGES THE LIVE ALFRED
  DATABASE: ALTERS TABLE SWITCHBOARD_ACTIONS, CREATES FUNCTION SWITCHBOARD_DATAQUERY_PAYLOAD_OK, ...". It asked for no
  `--expect`.
- `--describe` is one sentence of at most 300 characters, so it names each change briefly rather than in full.

## s7c notes

- **242 is applied:** run c970c51b-77d8-4c28-ba01-d946df57db83, every statement ok, CONFORMANT (119 tables).
- **Deploy refused** by the claims guard: the worktree is 2 commits behind main (43eb8b9 and the merge e7fc0f0,
  health_alerts-v7p). Those commits change no function folder, but a deploy sends this worktree's whole copy.
- **Drift check on those commits:** migration 241 (`241_health_check_failure_subject.sql`) has no switchboard table or
  function in it. The rest is skills, docs, a test move and the schema snapshot, so no re-plan is needed.
- Nothing was deployed and the test was not queued. Every claim is still held, db:deploy included.

## s7d notes

- After the gitsync, `git log HEAD..main` is empty, and db:deploy was still held.
- Deployed mcp (4.0 MB), then switchboard-runner (795 kB); each ended "Deployed Functions."
- An unauthenticated POST to switchboard-runner /queue returns 401 `{"ok":false,"error":"unauthorized"}`.
- Test queued: action **ef98db57-34a1-4dd2-9a0b-c7a482e02400** (--test). Its result is pending; s7e reads it before
  the checkpoint.

## s8: summary

A1 is built and live:
- **The kind:** `sf_dataquery`, migration 242, applied and verified 87 of 87.
- **The tool:** `queue_switchboard_sf_dataquery` in mcp.
- **The runner:** it picks up the kind with a 4-hour limit and keeps only `query_counts` and `pass`.
- **The approval page:** orange "Production, read only", with every SOQL whole, and a dev fixture.
- **In main:** the database and function files went in at checkpoint ede8d05. The page, the fixture, their tests, this
  file and the spec go in with the Finish.
- **Full suites, all passing:**
  - app Jest: 228 suites passed and 1 skipped; 3,364 tests passed, 7 skipped, 0 failed;
  - switchboard.test.mjs: 101 of 101;
  - mcp index.test.mjs: 52 of 52;
  - mcp tables.test.mjs: 1 of 1;
  - switchboard-runner core.test.mjs: 95 of 95;
  - scripts/lib: 77 of 77.
- **Claims:** no db: claim is held. The file claims go with the Finish.

## Timing log (measured run time per step)

| Step | Run tag | Measured |
|---|---|---|
| s1 | dataop_link-k7d-s1-r8w3 | 2m48s |
| s2 | dataop_link-k7d-s2-p4n7 | 2m49s |
| s3 | dataop_link-k7d-s3-j2x8 | 4m52s |
| s4 | dataop_link-k7d-s4-w6c1 | 4m56s |
| s5 | dataop_link-k7d-s5-h3q9 | 2m51s |
| s6 | dataop_link-k7d-s6-n5t2 | 3m21s |
| s7 | dataop_link-k7d-s7-v8m4 | 1m14s |
| s7b | dataop_link-k7d-s7b-q1d6 | 1m48s |
| s7c | dataop_link-k7d-s7c-f9k5 (blocked) | 0m38s |
| s7d | dataop_link-k7d-s7d-m3r7 | 1m06s |
| s8 | dataop_link-k7d-s8-c2w6 | see its report |

s1 to s7d total 26m23s, against an estimate of 3h45. The waits between steps (Alex's tests, gitsyncs, approvals and the
checkpoint) are not in these numbers.

## Next step's scope

None. Alex finishes the worktree: gitpush **Finish** for dataop_link-k7d, which carries the approval page, the
fixture, their tests, the spec and this file, and releases the file claims.
