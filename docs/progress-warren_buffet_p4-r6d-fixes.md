# Warren Buffet fixes after Phase 4: progress

Project code: `warren_buffet_p4-r6d`. Spec: `docs/technical-spec-warren_buffet_p4-r6d-fixes.md`.

Files claimed at S24 (2026-11-15): `.claude/skills/wb-money/SKILL.md`, `supabase/functions/_shared/tools/warren-buffet-p2.ts`, `supabase/functions/_shared/tools/warren-buffet-p2.test.mjs`, `supabase/functions/mcp/index.ts`, `supabase/functions/mcp/index.test.mjs`, this file and the spec.

## Steps

| Step | What | Database | Deploy | Estimate | Status |
|---|---|---|---|---|---|
| S23 | Plan, read-only | none | no | 10m | Done 2026-11-15 |
| S24 | Spec, progress, claims | none | no | 10m | Done 2026-11-15 |
| S25 | F1 and F2: the wb-money skill rules and a new version date | none | no | 15m | Done 2026-11-15 (version 2026-11-15a) |
| S26 | F3: ids and offset on get_wb_subscriptions, with tests, and the skill line | none | no | 20m | Done 2026-11-15 (skill 2026-11-15b) |
| S27 | Deploy mcp, then Checkpoint; one fresh claude.ai thread tests F1, F2 and F3 | `db:deploy` | mcp | 15m (+ gitsync wait) | Done 2026-11-16: mcp v224 ACTIVE, `verify_jwt` false; Checkpoint 2708138 |
| S28 | Record Alex's fresh-thread test; fix its three gaps in the skill (stale accounts, links on every to-do, rule findings link the rule) | none | no | 10m | Done 2026-11-16 (skill 2026-11-16a) |
| S29 | Alex runs gitpush Checkpoint for the skill, uploads it and retests the three gaps in a fresh thread; record the retest and close part 1 | none | no | 5m | Next |

## Step scopes

### S25
- create: nothing
- update: .claude/skills/wb-money/SKILL.md
- delete: nothing
- deploy: nothing
- SQL: none
- Estimated run: 15m
- Then Alex uploads the skill to claude.ai and tests F1 and F2 in a fresh thread.

### S26
- create: nothing
- update: supabase/functions/_shared/tools/warren-buffet-p2.ts, supabase/functions/_shared/tools/warren-buffet-p2.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs, .claude/skills/wb-money/SKILL.md
- delete: nothing
- deploy: nothing
- SQL: none
- Estimated run: 20m
- Tests:
  - `node --test supabase/functions/_shared/tools/warren-buffet-p2.test.mjs`
  - `node --test supabase/functions/mcp/index.test.mjs supabase/functions/mcp/tables.test.mjs`
  - The full suites once, at the end.

### S27
- create: nothing
- update: docs/progress-warren_buffet_p4-r6d-fixes.md
- delete: nothing
- deploy: supabase/functions/mcp (holding db:deploy)
- SQL: none
- Estimated run: 15m
- Order:
  1. `claims.cmd check db:deploy`.
  2. Alex runs gitsync in this worktree.
  3. Drift check on `mcp/index.ts` and `warren-buffet-p2.ts`.
  4. Claim `db:deploy`, then deploy.
  5. Verify an ids read in a fresh thread.
  6. Alex runs gitpush Checkpoint with the mcp paths.
  7. `claims.cmd status` shows db:deploy has gone.

## Next step's scope

Run tag: warren_buffet_p4-r6d-s29-<new>
- create: nothing
- update: docs/progress-warren_buffet_p4-r6d-fixes.md
- delete: nothing
- deploy: nothing
- SQL: none
- Estimated run: 5m
- Before it: Alex runs `gitpush warren_buffet_p4-r6d checkpoint --paths .claude/skills/wb-money/SKILL.md docs/progress-warren_buffet_p4-r6d-fixes.md`, uploads wb-money 2026-11-16a to claude.ai, and retests in a fresh thread: stale accounts (reads the wb-sync log, names the cause), a link on every to-do (including a subscription price change), and rule findings linking the rule.

## Decisions

- 2026-11-15 (s24): Old fix 4 (the anon revoke and default privileges) is dropped, because migration 161 already did it. The supabase_admin default-privileges gap goes to Platform health.
- 2026-11-15 (s24): F3 takes both `ids` and `offset`.

## Timing log

| Step | Run tag | Estimate | Actual |
|---|---|---|---|
| S23 | warren_buffet_p4-r6d-s23-k7wf | 10m | 2m 29s |
| S24 | warren_buffet_p4-r6d-s24-m3qd | 10m | 0m 44s |
| S25 | warren_buffet_p4-r6d-s25-t8nb | 15m | 0m 36s |
| S26 | warren_buffet_p4-r6d-s26-r5jc | 20m | 3m 20s |

- S25: the plan guard refused the progress file, which was new and not in that scope block. The bug is filed in Alfred. Every prompt now lists the progress file under update, and S25's progress edits were made at S26.
- S26: get_wb_subscriptions takes `ids` and `offset`. The new helper `subscriptionPage` uses `parseReadOptions` with fixed settings, since the view is unregistered, and then checks each id is a uuid. Reads use `.range`, and the result carries `next_offset`. In index.ts the schema is `...readOptions()`, and `subscriptionPage` joins the Phase 2 schema test's helper list. Tests:
  - p2: 46 of 46.
  - index and tables: 52 of 52.
  - All function tests: 1222 of 1222 on the rerun. The first run had 1 failure, with 16 fewer tests counted, so probably one file failed to load; the file wasn't identified.
  - Scripts: 77 of 77.
  - App: 3341 passed, 7 skipped.
- Main is 2 commits ahead (the switchboard_prod-w3k merge, 119dff2), so S27 needs a gitsync before the deploy.

| S27 | warren_buffet_p4-r6d-s27-w2hv | 15m | 0m 54s |

- S27: the gitsync brought in 119dff2, with two switchboard_prod-w3k docs and nothing under supabase/functions or the skill. No drift, so the tests weren't rerun. `db:deploy` claimed, and `supabase functions deploy mcp` run from this worktree: v224 ACTIVE, `verify_jwt` false. Checkpoint pending, which releases `db:deploy`.

| S28 | warren_buffet_p4-r6d-s28-q6ld | 10m | 0m 45s |

- S27 Checkpoint landed at 2708138; `db:deploy` released.
- S28: Alex's fresh-thread test (wb-money 2026-11-15b, mcp v224):
  - F3, `ids` on get_wb_subscriptions: pass (called with ids, returned the subscription).
  - F2, Live data first: pass (a second ask hours later read again and named its date).
  - F1, Help with every to-do: mostly pass, with three gaps: it advised reconnecting the bank when the wb-sync log showed a SimpleFIN 503 and an unfinished run; a subscription price change had no link; rule findings linked the merchant instead of the rule.
- S28 fixes, skill 2026-11-16a: a 🛑 "Stale accounts: read the sync log first" rule (get_platform_runs, `warren_buffet` / `wb-sync`; reconnect only on a login error; a 503 is SimpleFIN's side; a stuck run is a job problem); the link part of Help with every to-do now has no exceptions; §3 links each rule finding to its `rule_id`.
- S28: a claim block from job_health-t4m on `mcp/index.ts` and `mcp/index.test.mjs`; both were unchanged from main and released with yield.
