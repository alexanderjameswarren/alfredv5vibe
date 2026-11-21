# Switchboard 2.0, production toolkit and friction batch — Progress

Spec: `docs/technical-spec-switchboard_prod-w3k.md`
Codes:
- `switchboard_prod-w3k`: this worktree, the Project's plan code;
- `switchboard_prodrepo-w3k`: the switchboard repo's main checkout, its own chat and CLI. It never sets the plan's project_code.

Project group: Switchboard 2.0 (`mvsmdaag09pvs6wddm03`).

## Steps

Owner `w3k` is this worktree. `repo` is `switchboard_prodrepo-w3k`, whose steps are numbered under its own code. The rows are in build order.

| # | group | owner | step | what | db items | estimate | status |
|---|---|---|---|---|---|---|---|
| 1 | plan | w3k | s1 | Read-only plan | none | 8m | done (s1-q7m3) |
| 2 | plan | w3k | s2 | Spec, progress, claim | none | 8m | done (s2-r5d8) |
| 3 | skills | w3k | s3 | Copy cli-workflow 11-11a over the repo copy. Add sf-diagnose and salesforce-workflow 11-12a from the sync folder. Apply the cli-workflow and sf-diagnose changes (spec §4) | none | 15m | done (s3-h2v6). All three copies were byte-identical to the sync folder, checked with cmp; cli-workflow reached 11-11a by applying its 5-hunk diff. cli-workflow is now 2026-11-12a, sf-diagnose 2026-11-12b, and salesforce-workflow is unchanged at 2026-11-12a. Alex uploads cli-workflow and sf-diagnose to claude.ai |
| 4 | skills | w3k | s4 | salesforce-workflow changes (spec §4) | none | 12m | done (s4-n8c1). salesforce-workflow is now 2026-11-12b; each sb prod line has its "once built; until then" fallback. Alex uploads it to claude.ai |
| — | plan fix | w3k | s5 | Spec fixes from repo s1 (§7 contract set in Alex's terminal, §13 clip test path), new step s6 (§10a), renumbering, claim | none | 6m | done (s5-t4j9); counts with s2 (see Estimate) |
| 6 | approve page | w3k | s6 | Approve page: a gitpush finish by link opens with "Closes the <code> VS Code window, then finishes", with its tests (§10a). Must reach production before repo s13 | none | 8m | done (s6-m2q8); ApprovePage.test.jsx 50 of 50. Reaches production with Alex's push |
| 5 | kickoff | repo | s1 | Read the spec, `claims.cmd check` its files, cancel sf_check 72ca1cc0 | none | 6m | done (repo thread); it found the spec points fixed at s5 |
| 7 | dataop, rollback | repo | s2 | `sb prod dataop`: the shared checks (§5.0), backup, Ids matched, rehearsal record, counts, failed rows | none | 25m | todo |
| 8 | dataop, rollback | repo | s3 | Live: a sandbox rehearsal of Fix A's cleanup (Alex's terminal), and fixes | none | 10m | todo, needed by Monday 11/16 |
| 9 | dataop, rollback | repo | s4 | `sb prod rollback` (deploy and dataop) | none | 15m | todo |
| 10 | validate, deploy | repo | s5 | `sb prod validate`: worktree paths, commit, drift, test count, Job ID | none | 20m | todo |
| 11 | validate, deploy | repo | s6 | `sb prod deploy`: quick deploy, Unchanged as failure, retrieve and compare | none | 15m | todo |
| 12 | validate, deploy | repo | s7 | Live: a validate-only run on Common Defense (Alex), and fixes | none | 10m | todo |
| 13 | gate, snapshot | repo | s8 | gitpush finish gate on the deployed commit | none | 12m | todo |
| 14 | gate, snapshot | repo | s9 | Scheduled-job snapshot before and after a deploy | none | 12m | todo |
| 15 | filter rule | repo | s10 | plan.mjs applies the filter limit only when the contract flag is off. Alex sets contractAllowsClaude on for actblue and commondefense-ab-prod in his terminal (`sb org set <alias> --contract-ok on`) | none | 10m | todo; lands before s7 here |
| 16 | filter rule | w3k | s7 | `_pending_` migration (constraint), switchboard.ts and its test, test script | none | 12m | done (s7-v3k5); written, not queued. switchboard.test.mjs 85 of 85 |
| 17 | filter rule | w3k | s7b | index.ts tool wording (ids filters), drift check, claim, number. Doesn't wait for repo s10: the installed plan.mjs:187 refuses non-Id ids filters for every org | `db:table:switchboard_actions` | 10m | done (s7b-p6w2): no drift; number 235, `supabase/migrations/235_ids_filters.sql`; `db:table:switchboard_actions` and `db:migration:235` held into s7c |
| — | filter rule | w3k | s7c (counts with s7b) | Write 235 and delete the `_pending_` file, then queue it | (the held table claim) | 5m | done (s7c-x9r4): 235 byte-identical to the `_pending_` file; queued as action d50bf3d7-c985-4570-aa78-d4dd9a76c18c, not yet approved |
| — | filter rule | w3k | s7d (counts with s7b) | After 235 is approved: test run, `db:deploy` and the mcp deploy, conformance | `db:deploy` (and the held table claim) | 10m | done (s7d-c5n7): 235 ran CONFORMANT (run c5f420e4); test queued as 9fd29579-c506-498d-a4b6-013de7e5b893; mcp deployed (4.0 MB); conformance CONFORMANT, 117 tables; db:deploy released |
| — | filter rule | w3k | s7e (counts with s7b) | Read the test result, then a Checkpoint request; check the db: claims went | (the held table and migration claims) | 4m | done: checkpointed as 2184cce (merge 290bb33); no db: claims held at s8 |
| 18 | effort counting | w3k | s8 | `_pending_` migration (project_codes, trigger, backfill, function), overwatch-projects.ts (`add_project_codes`, codes) and its test, index.ts wording, test script | none | 20m | stopped (s8-f7h3) at the plan guard. The migration is written. The test script was refused: its throwaway rows go into item_groups and clips, which the scope's SQL line doesn't name. Not started: the tool, its tests, index.ts, the skill |
| — | effort counting | w3k | s8b (counts with s8) | s8 re-sent with SQL widened to item_groups and clips: test script, tool (`add_project_codes`, `codes`), its tests, index.ts, overwatch SKILL.md | none | 18m | done (s8b-q2d6): overwatch-projects.test.mjs 15 of 15; mcp index 51 of 51; mcp/tables.test.mjs fails on project_codes until the checkpoint regenerates the schema snapshot |
| 19 | effort counting | w3k | s8c | gitsync, drift check, claim, number | `db:table:project_codes`, `db:table:project_plans`, `db:fn:overwatch_project_progress` | 8m | done (s8c-k4t1): no drift (HEAD = main = origin/main = 290bb33); three db: items claimed; number 236, `supabase/migrations/236_project_codes.sql` (`db:migration:236`), all held into s8d |
| — | effort counting | w3k | s8d (counts with s8c) | Write 236, delete the `_pending_` file, queue it | the s8c claims | 6m | done (s8d-w8m5): 236 byte-identical to the `_pending_` file; queued as action 350810de-b500-4ea1-bbe5-4691afe6dca6, not yet approved |
| 20 | effort counting | w3k | s8e | After 236 is approved: test run, `db:deploy` and the mcp deploy, conformance, verify steps_used for Switchboard 2.0 and ActBlue Common Defense | the s8c claims, `db:deploy` | 12m | done (s8e-j3p8): 236 ran CONFORMANT (run bdad5f1d), and Switchboard 2.0 shows 113 steps_used; test queued as 7029b934-911a-442c-b4f7-352ac41c962c; mcp deployed (4.0 MB); `check_platform_conformance` not run here (the Alfred tools were disconnected in the CLI session); db:deploy released |
| — | effort counting | w3k | s8f (counts with s8e) | Read the test result, run conformance, then a Checkpoint request; check the db: claims went | the s8c claims | 4m | done: checkpointed as 2f05a5e (merge 606b3a1); no db: claims held at s9 |
| 21a | no prod deploy | w3k | s9 | `queue_switchboard_git` takes `no_prod_deploy` (true, gitpush finish only) with its headline, the approve-page line, tests, spec §10b. No migration: no constraint limits git payload keys | none | 15m | done (s9-h5v2): switchboard.test.mjs 87 of 87; ApprovePage.test.jsx 51 of 51. The `_pending_` migration path was claimed but not written |
| — | no prod deploy | w3k | s9b (counts with s9) | index.ts wording for `no_prod_deploy`, `db:deploy` and the mcp deploy, conformance, then a Checkpoint request | `db:deploy` | 8m | done (s9b-r7c4): mcp index 51 of 51, tables 1 of 1; mcp deployed (4.0 MB); db:deploy released; conformance not run here (Alfred tools not in the CLI session) |
| — | no prod deploy | w3k | s9c (counts with s9) | Conformance in the chat, then a Checkpoint request | none | 4m | done: checkpointed as 95c262c (merge f124368) |
| 21 | setup | repo | s11 | `sb set` (repo finish, project client), `--client` slug or name, `sb project add` refusal | none | 15m | todo |
| 22 | setup | repo | s12 | `sb client start` remote and .gitignore; `sb org add` order, type and contract question; the helper always passes `--contract-ok off` for a link-run `sb org add` | none | 15m | todo |
| 23 | window, extension | repo | s13 | Finish by link closes the worktree's VS Code window, with the refusals. After w3k s6 is in production, w3k s9b is live, and the helper passes `no_prod_deploy` on (§10b, the repo side) | none | 20m | todo |
| 24 | window, extension | repo | s14 | Result line waits while the chat box has text; extension version bump | none | 15m | todo |
| 25 | clip, panel | repo | s15 | 8b: whitespace-only changes listed apart | none | 12m | todo |
| 26 | clip, panel | repo | s16 | 8c: one report per run tag across restarts; 8a's optional tile release button | none | 15m | todo |
| 27 | closeout | w3k | s10 | Closeout entry, estimate vs actual, gitpush Finish request | none | 6m | done (s10-b8n6); was s9, moved at s9 |

## Closeout (s10)

The phase is done on both sides, 2026-11-15. The Project, Switchboard 2.0, stays open: Phases 6 to 8 come next.

**Shipped, this worktree** (alfred-v5 main f124368):
- skills: cli-workflow 2026-11-12a, sf-diagnose 2026-11-12b and salesforce-workflow 2026-11-12b (w3k s3-s4, a837994);
- approve page: a Finish by link says it closes the VS Code window first (w3k s6, d1f9282);
- filter rule, Alfred side: migration 235, ids reads may filter on any field (w3k s7-s7e, 2184cce, merge 290bb33);
- effort counting: migration 236 (project_codes), `codes` and `add_project_codes`, overwatch 2026-11-13a (w3k s8-s8f, 2f05a5e, merge 606b3a1);
- no_prod_deploy on a Finish by link, with its headline and the approve page's red line (w3k s9-s9c, 95c262c, merge f124368). mcp is deployed with all of it.

**Shipped, repo chat** (switchboard_prodrepo-w3k, switchboard main 7d616ea):
- sb prod dataop and rollback (repo s2-s4d: 1280fbb, e947f1e, 381457c);
- sb prod validate, deploy and deploy rollback, including the check-only production validate (repo s5-s7c: 77095a0, 45385e7, 9a1f885);
- the gitpush finish gate and the scheduled-job snapshot (repo s8-s9, ee8e2c4);
- the filter rule's repo side (repo s10, 146ef89);
- the setup commands (repo s11-s12: 3081a98, f8df4b3);
- the Finish by link window close, with the helper passing no_prod_deploy (repo s13, c9a22ee);
- the result line is tap only, extension 1.2.30 (repo s14: c9a22ee, 91f15f9, 47909b0);
- the whitespace-only change list, Send cli once per report, the Release button on held tiles, the tile binding fix and the PII hold in client repos (repo s15-s16 and s13b-s13d, 7d616ea).

**Not yet proven end to end, on purpose:**
- **A real Finish by link of a Salesforce project.** It covers the window close, the finish gate and no_prod_deploy. It's tested in units, with one real link on a throwaway folder. Its first real run is Fix B's finish.
- **A real sb prod deploy (quick deploy) to production.** So far only a check-only validate has run on commondefense-ab-prod (repo s7c, 55 = 55). The first real deploy is Fix B's.
- **A real sb prod dataop on production.** It has run only in sandbox rehearsals on actblue. The first is Fix B's data change, if Fix B has one.

**Friction, spec §2 to §10b:**
- Fixed:
  - edeedacd, 1ba185db, 02bdd170 (cli-workflow, w3k s3);
  - 496ca285, baccf500, 43a6c0f1, 48957762, ccdd847c (sf-diagnose, w3k s3);
  - 4052c4aa, 4dbb4780, 76cab513, 3eca7b74, cd176716, 07a970ec (salesforce-workflow, w3k s4);
  - cc6500f6 (its skill part at w3k s4, its sb part at repo s12);
  - fa8d5663 and c0121c9f (their Stage 7 skill parts at w3k s4; validate and deploy at repo s5-s7c);
  - a80af92f (repo s10, then w3k s7-s7d);
  - c9cc159a, 599f7fa2, 5c71b0c2, 0ad5c1f8, 10f0f91c (setup, repo s11-s12);
  - 4f40a508 (result line, repo s14, extension 1.2.30).
- Still open:
  - 54b1f4e2 (window close). It's built at repo s13 but not yet proven on a real Salesforce Finish. Mark it fixed after Fix B's finish.
- Already settled, not this phase's work: a3a00c04 (wont_fix, superseded by a80af92f), d556ef77 (closed, §12).
- Beyond §10b, also fixed this phase: b2eca3bc and 5fac305a (8a, release button, repo s16), 12400904 (8b, repo s15), a33a4a8a (8c, repo s16).

**Carries forward:**
- Phases 6 to 8:
  - Fix B's finish by link proves the window close, the finish gate and no_prod_deploy. Mark 54b1f4e2 fixed then.
  - Fix B's first real sb prod deploy, and its dataop if it has one, prove them on production.
- Loose ends:
  - f4e8310d (intake should ask where the processing code lives) and b67cb8c2 (who triggers the one-time sf result fetch) are still open. Both were out of scope from the start.
  - sf_check 72ca1cc0 is still queued, because no command cancels a queued action. Cancel it with the approve page's Don't run.
  - orgs.json records no instanceUrl, so the org identity check compares the org Id only.
  - no_prod_deploy's salesforce-only check lives in gitpush, not the helper: helper.mjs doesn't pass `repoKind`, and it wasn't in repo s13's scope.
  - Migration 235's header lines 7-8 still say to queue it only after repo s10. This is history only, and harmless.
  - The repo file's s3e row (rerun the dataop rehearsals) is still todo there. s4c and s4d's rehearsals covered it.
  - Record this phase's estimate in Alfred with `record_project_estimate` (28). effort_estimate still shows 105, from h8r.

**Estimate against actual:**
- Planned: 27 numbered rows, then 28 once s9 was added (w3k 12 rows, repo 16). The run estimates came to about 5h.
- Step numbers used:
  - this worktree: s1-s10, so 10, with lettered follow-ups s7b-s7e, s8b-s8f, s9b and s9c;
  - repo chat: s1-s13, so 13, covering its 16 planned rows. It folded s9 into s8 and ran s13-s14 and s15-s16 as one tag each. Its lettered follow-ups were s2b, s3b-s3d, s4b, s4c, s7b, s8b, s12b, s12c and s13b-s13d.
  - So 23 distinct (code, step) pairs against 28 planned. That is what steps_used counts under project_codes.
- Measured CLI time:
  - this worktree: about 46m across 17 timed runs;
  - repo chat: about 2h49m;
  - together about 3h35m against about 5h estimated, near 70%. h8r ran at about 50%. Alex's own terminal rehearsals aren't counted.

## Estimate

| group | owner | steps |
|---|---|---|
| Plan and spec | w3k | 2 |
| Skills | w3k | 2 |
| Repo kickoff | repo | 1 |
| Approve page | w3k | 1 |
| dataop and rollback | repo | 3 |
| sb prod validate and deploy | repo | 3 |
| Finish gate and job snapshot | repo | 2 |
| Filter rule | repo 1, w3k 2 | 3 |
| Effort counting | w3k | 3 |
| Setup commands | repo | 2 |
| Window close and extension | repo | 2 |
| No prod deploy by link (s9, s9b) | w3k | 1 |
| 8b and 8c (8a's button) | repo | 2 |
| Closeout | w3k | 1 |
| **total** | | **28** |

- Each numbered row counts once, including the planned lettered rows (s7b, s8b, s8c). An unplanned lettered follow-up counts with its step.
- s5 (11/12) is a plan correction and counts with s2. Alfred's run-tag count will still show it as its own step.
- s5 raised the total from 25 to 27: it added the repo kickoff and w3k s6.
- Calibration from switchboard2-h8r:
  - the plan was 95-105 and the s-numbers ran to s93, but 174 step ids, so the growth was lettered follow-ups;
  - its build steps took about 50% of their estimates.
- The run estimates above add up to about 5h, for both threads.
- Alfred's effort_estimate for this Project still says 105, carried over from h8r. Record 27 for this phase with `record_project_estimate`.

## Carried in

- **s84f and s86q: done.** Already built (bridge-core.js POST_LINE and HELPER_KINDS, extension 1.2.27). Their rows in `docs/progress-switchboard2-h8r.md` were never closed. This line closes them.
- **d556ef77: closed.** The refusal's wording existed only before c4af8cb (s89fb, 11/11 12:20). The installed plan.mjs has the new rule.
- **sf_check 72ca1cc0:** queued since 2026-11-10, a stale test. The switchboard repo chat cancels it (repo s1).
- **Friction already fixed:**
  - ca71fbb2 (reinstall with reload), 03a004cd (chain link last under its prompt) and 693def48 (any approve link ends the reply), all in cli-workflow 11-11a;
  - b66d4b90 (drift-check retrieve outside the project), s91 a57f876.
- **8a:** built by s92/s92b, except the optional release button on the tile (step 24).

## Decisions

- s2 (11/12):
  - the switchboard repo work runs as `switchboard_prodrepo-w3k` in the repo's main checkout;
  - the build order is the one above;
  - contractAllowsClaude is set at repo s10, not by hand;
  - the spec takes the house name `technical-spec-`;
  - 8b separates whitespace-only changes rather than adding a restore path (spec §11).
- s5 (11/12), from repo s1's findings:
  - Alex sets contractAllowsClaude for actblue and commondefense-ab-prod in his terminal, never by link (§7);
  - new w3k s6, the tool and approve page (§10a), lands before repo s12 and s13;
  - the filter rule is renumbered s7 and s7b, effort counting s8 to s8c, closeout s9;
  - the estimate is 27.
  - Found at s5: the sb_setup payload constraint (migration 220) lists each org key, so a `contract_ok` key would also have needed a migration and a helper change.
- s6 (11/12): Alex chose the simpler option. There is no `contract_ok` key, no migration and no mcp deploy. Repo s12's helper always passes `--contract-ok off` for a link-run `sb org add`. s6 is the approve-page wording only (8m), and only repo s13 depends on it.
- s9 (11/14), from the repo chat's s8: a new step for `no_prod_deploy` on a Finish by link (§10b); the closeout moves to s10; the estimate is 28. No migration: the git payload constraint doesn't limit keys (unlike sb_setup's).

## Next step's scope

**None: the phase is closed.** The next step is Alex's gitpush finish (phase) for switchboard_prod-w3k. It merges this worktree into main, moves the spec and this file to docs/history/, removes the worktree and releases its claims. No CLI step follows in this worktree.
- create: nothing
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none

## Timing log

| step | total |
|---|---|
| s1 | 5m55s (estimate 8m) |
| s2 | 3m53s to the docs (14:58:16-15:02:09), of which about 0m40s was the guard stop and the claim; closing measured in the report (estimate 8m) |
| s3 | 4m29s to the progress update (15:14:31-15:19:00); the report is in its timing table (estimate 15m) |
| s4 | 2m58s (20:01:41-20:04:39) (estimate 12m) |
| s5 | 3m46s (20:07:10-20:10:56) (estimate 6m) |
| s6 | 2m07s (20:13:58-20:16:05) (estimate 8m) |
| s7 | 2m31s (20:25:18-20:27:49) (estimate 12m) |
| s7b | 1m44s (20:31:06-20:32:50) (estimate 10m) |
| s7c | 1m15s (20:34:33-20:35:48) (estimate 5m) |
| s7d | 1m39s (20:38:15-20:39:54) (estimate 10m) |
| s8 | 3m24s (07:49:44-07:53:08), stopped at the plan guard (estimate 20m) |
| s8b | 2m32s (07:56:20-07:58:52) (estimate 18m) |
| s8c | 0m42s (08:01:47-08:02:29) (estimate 8m) |
| s8d | 0m45s (08:04:10-08:04:55) (estimate 6m) |
| s8e | to the progress update from 08:15:18; the report is in its timing table (estimate 12m) |
| s9 | 2m59s (12:08:19-12:11:18) (estimate 15m) |
| s9b | 1m08s (12:15:22-12:16:30) (estimate 8m) |
| s10 | to the progress update from 13:30:47; the report is in its timing table (estimate 6m) |
