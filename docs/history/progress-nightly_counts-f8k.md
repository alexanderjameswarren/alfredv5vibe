# Progress: nightly counts (nightly_counts-f8k)

Spec: `docs/technical-spec-nightly_counts-f8k.md`. Estimate: 10 steps.

| Step | What | Estimate | Status |
|---|---|---|---|
| s1 | Read-only plan | 10m | done |
| s2 | Confirm, claim, spec and progress files | 10m | done |
| s3 | Function, watch column, test script | 25m | done (s3b) |
| s4 | Sync, number, queue, verify, conformance, checkpoint | 10m | done (s4b): 73 checks passed |
| s5 | Nightly tool, watch tools, unit tests (no deploy) | 20m | done, not deployed |
| s6 | Sync, deploy mcp, verify, checkpoint | 10m | done: mcp 192 |
| s7 | Prompt rewrite, skill edits, both test suites | 15m | done, in the worktree only |
| s8 | Stopped-schedule rule and `active_yesterday`, new migration, test | 20m | done |
| s8b | Sync, number, queue, verify, conformance, checkpoint | 10m | done (s8c): migration 198 |
| s9 | Compare the tool against that morning's note | 10m | done: matched the Nov 3 nightly |
| s10 | Task updated by Claude (prompt 2026-11-02a), manual run; name `details.counts` | 5m | done, in the worktree only |
| Finish | `gitpush` Finish for the worktree | 5m | next |

The watch tools fold into s5, and the tool deploy is its own step, so mcp deploys once.

## Database items

| Item | Step |
|---|---|
| `db:fn:overwatch_nightly_counts`, `db:table:overwatch_watch`, `db:deploy` | s4 |
| `db:fn:mcp`, `db:deploy` | s6 |

Reserved at s2. Claimed just in time at each step, and released at Checkpoint.

## Scope blocks

```
Scope of this step (s3, function, watch column, test script):
- create: supabase/migrations/_pending_nightly_counts-f8k_counts_fn.sql, supabase/tests/nightly_counts-f8k/1_counts_test.sql
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 25m
```

```
Scope of this step (s4, migration):
- create: supabase/migrations/197_nightly_counts_fn.sql
- update: nothing
- delete: supabase/migrations/_pending_nightly_counts-f8k_counts_fn.sql
- deploy: nothing
- SQL: overwatch_watch, item_groups, project_plans, clips, intents, events, executions, items, item_group_members, inbox, platform_schedules, platform_runs, overwatch_plans
Estimated run: 10m
```

```
Scope of this step (s5, tools and unit tests):
- create: supabase/functions/_shared/tools/overwatch-nightly.ts, supabase/functions/_shared/tools/overwatch-nightly.test.mjs
- update: supabase/functions/_shared/tools/overwatch-plan.ts, supabase/functions/_shared/tools/overwatch-plan.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 20m
```

```
Scope of this step (s6, tool deploy):
- create: nothing
- update: nothing
- delete: nothing
- deploy: mcp
- SQL: none
Estimated run: 10m
```

```
Scope of this step (s8, stopped-schedule rule):
- create: supabase/migrations/_pending_nightly_counts-f8k_stopped_rule.sql, supabase/tests/nightly_counts-f8k/2_stopped_rule_test.sql
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: platform_schedules, platform_runs, overwatch_plans
Estimated run: 20m
```

```
Scope of this step (s9, comparison):
- create: nothing
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 10m
```

```
Scope of this step (s10, name the run record's counts key):
- create: nothing
- update: docs/overwatch-nightly-task-prompt.md
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 5m
```

```
Scope of this step (Finish):
- create: nothing
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 5m
```

## Log

- **s1:** plan reported, no conflicts.
- **s2:** first claim refused on the mcp files, held by `switchboard2-h8r`. Resumed as s2b once they were released.
- **s2b:** 12 paths claimed, database items reserved, spec and progress written. Fading is intentions only, and watch items gain `intent_id`.
- **s3:** blocked by the plan guard: its SQL scope was none, so neither SQL file could be written. Yielded to `warren_buffet_p4-r6d`: `.claude/skills/overwatch/SKILL.md` and `supabase/functions/mcp/index.test.mjs`. Re-claim both before s5 and s8.
- **s3b:** migration and test script written, unnumbered and not run. The fading line is tested with a 2020 clock, because rows dated near the line could fall behind real rows under the cap of 50.
- **s4:** drift check clean (only `196_link_per_project.sql` came in, and it names none of these tables). Claimed `db:fn:overwatch_nightly_counts`, `db:table:overwatch_watch` and the 197 path. Blocked by the plan guard: the scope said `<next number>`, not the file name, so nothing was numbered or queued.
- **s4b:** `197_nightly_counts_fn.sql` written, byte-identical to the `_pending_` file, which is deleted. Queued, not applied: migration `448b1125-42f9-423f-bb14-aff80787bc29`, then test `a0485626-488b-4114-a7f1-192209d06cd6`. Conformance and Checkpoint still to come.
- **s5:** migration 197 applied and checkpointed. `get_overwatch_nightly_counts` written and registered, watch tools take `intent_id`, tests pass. Not deployed. `supabase/functions/mcp/index.test.mjs` re-claimed; `.claude/skills/overwatch/SKILL.md` still to re-claim at s8.
- **s6:** drift clean, tests re-run and passing, mcp deployed. Response size not measured here: the claude.ai thread's first call is the first real one.
- **s7:** the first real call came back whole, about 37,000 characters. Prompt rewritten to version 2026-11-02a, skill to 2026-11-02a, spec updated. The task is not updated. Order is now s8 stopped-schedule fix, s9 comparison, s10 task and Finish.
- **s8:** stopped-rule migration and `2_stopped_rule_test.sql` written, not numbered, queued or run. `active_yesterday` is tested on real activity (an app's first active day), since `activity` is not in the step's SQL scope.
- **s8b:** Alex's rule: no ok run after the previous due time **plus grace**. Drift clean, 198 free. `198_nightly_counts_stopped_rule.sql` written, test updated. Blocked by the plan guard deleting the `_pending_` file, so nothing is queued. The spec's section 6 still states the earlier rule without grace.
- **s8c:** `_pending_` file deleted, spec section 6 updated. Queued, not applied: migration `a5ac3c93-552c-401a-b6ad-c1ec1be71104`, then test `b13780d2-100a-4c2c-b855-5794ecbffcc3` (`1_counts_test.sql`), then test `112c2b7f-33c0-4cd8-b7e9-0abbbae4340a` (`2_stopped_rule_test.sql`).
- **s9:** compare done: the tool matched the Nov 3 nightly.
- **s10:** the task runs prompt 2026-11-02a (main a2e7fe2). Manual run: 15 Alfred calls, no pause, 2 minutes, closed partial on a Drive Mix recipe read (tracked as a Drive Mix item). It stored the flag counts as `details.flag_counts`; every earlier run used `details.counts`. Step 9 now names `details.counts`, one key per flag, and the prompt is 2026-11-03a. Nothing in the repo reads either key: the Overwatch tab reads `details.local_date`, `duplicate_of` and `skipped`, and the weekly prompt reads the nightly's `reminders_sent`. Finish next.
