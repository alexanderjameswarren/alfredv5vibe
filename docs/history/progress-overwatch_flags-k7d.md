# Progress: overwatch_flags-k7d

Fix three Overwatch false-alarm problems. Window: the main checkout. No spec file.

## The three fixes

1. **Skill** (friction a0900bed-68e4-4602-be8b-cd5500e51045), `.claude/skills/overwatch/SKILL.md`:
   - Move "check each flagged record's current state before suggesting an action" from
     "Going through an Overwatch list" up into "Four rules that hold everywhere". It applies to
     every chat reply that repeats a flag from a note, an inbox item or the nightly counts. For
     an intention, call `get_intents` and then `get_events` with `intent_id` before repeating it.
   - Add: when a planning chat sets a Project's `target_date` from a to-do's deadline, date
     the to-do too.
   - Under "A deadline with no date", note that an intention in a dated Project is left out.
   - Bump the `Skill version:` line (from 2026-11-19a).
2. **Deadline check** (friction 551b62b0-00f9-4add-97dd-9beb6a765ad4), in
   `public.overwatch_nightly_counts`: `deadline_candidates` leaves out an active intention
   that is in an active Project with `project_plans.target_date` set. Membership counts
   through `i.group_id` or through `item_group_members` (`member_type = 'intention'`,
   `removed_at is null`). Such an intention counts as dated. A past target is already
   flagged as a `target` overrun.
3. **Stall check** (same friction): the last sign of life is
   `greatest(last_report_at, status_written_at)`. A Project is stalled when its last sign is
   more than `stall_days` old, or when it has no sign at all and has a plan. `days` is counted
   from the last sign, and `last_sign_at` is added to each `stalled` row.

The SQL lives only in `public.overwatch_nightly_counts`, last defined in migration 219. The
tool file and `supabase/functions/mcp/index.ts` don't change (index.ts is held by
sb3_pages-h6v and isn't needed). The prompt doc `docs/overwatch-nightly-task-prompt.md`
changes 2a and 7b and gets a new PROMPT VERSION (from 2026-11-08a). Claude updates the live
scheduled task afterwards.

## Files

- `.claude/skills/overwatch/SKILL.md`
- `docs/overwatch-nightly-task-prompt.md`
- `docs/progress-overwatch_flags-k7d.md`
- `supabase/migrations/_pending_main_overwatch_flags.sql`, numbered at s4
- `supabase/tests/overwatch_flags-k7d/` holding `1_counts_test.sql`

## Database items

- `db:fn:overwatch_nightly_counts`, claimed at s4 and not before.
- The migration number comes from `claims.cmd number-migration` at s4.
- No `db:table` claims (tables are only read) and no `db:deploy` (no Edge Function deploy).

## Steps

- [x] **s1** Read-only plan.
- [x] **s2** Claim the files and create this progress file.
- [x] **s3b** `supabase/tests/overwatch_flags-k7d/1_counts_test.sql` written: 13 checks (6 on
      deadline_candidates, 7 on stalled) plus 3 security checks, in a block that undoes
      itself. Not queued: it runs against the new function, after the migration.
- [x] **s3** Done: the skill (Skill version 2026-11-23a), the prompt doc (PROMPT VERSION
      2026-11-23a; 2a and 7b), and the draft `_pending_main_overwatch_flags.sql`. **Blocked:**
      the plan guard refused `supabase/tests/overwatch_flags-k7d/1_counts_test.sql` because
      its fixtures insert into item_groups, project_plans, clips, intents and
      item_group_members, and s3 declared `SQL: none`. A tagged follow-up whose SQL line names
      those tables is needed to write it.
- [x] **s4** (part 1) Main isn't behind origin/main (0/0, against the last-fetched ref).
      Drift check over 220 to 247: none touches the function. 236 changes
      `overwatch_project_progress` (adds project_codes), which the stall part reads, but its
      `last_report_at` and `status_written_at` columns are unchanged. The live body matches
      219's exactly (md5 a1adbae6…, 27018 chars), so no re-base was needed and the DRAFT
      marker is removed. Claimed `db:fn:overwatch_nightly_counts`. Number **249** (claimed
      `db:migration:249` and `supabase/migrations/249_overwatch_flags.sql`).
- [x] **s4b** Wrote `supabase/migrations/249_overwatch_flags.sql` (identical to the draft) and
      deleted the `_pending_` file. Queued 249: action id
      `ccc4701d-32c4-40c0-81bc-7aad55a7e551`. Queued without `--expect`, because the runner
      refuses one when there is no insert, update or delete. **Queued, not applied.**
- [x] **s4c** 249 applied (run 4dc0a327, CONFORMANT). Queued
      `supabase/tests/overwatch_flags-k7d/1_counts_test.sql` with `--test`: action id
      `c06945e4-a857-40c9-80ae-dce2019f3a27`. Its result comes back to Claude.
- [x] **s4d** The first test run (0426fe57) passed 12 of 16; the 4 status-line stall checks
      failed. The cause is the fixtures, not 249. `project_plans.status_written_at` has no
      default, and the live `project_plans_check_group` stamps it on insert only when
      `coalesce(where_now, next_step, waiting_on, waiting_on_kind) is not null`. The fixtures
      set none of those, so it was null. Fix: every fixture plan now writes `where_now`. The
      checks are unchanged. Queued again with `--test`: action id
      `27f319b5-25b1-4deb-a689-6c812ecdfa10`.
- [ ] **s5 (now)** Verify: the test result must be `ok: true` with 16 checks. Then a gitpush
      Checkpoint on main carrying the skill, the prompt doc, 249, the test and this file, which
      releases the `db:` claims. Confirm with `claims.cmd status`. Afterwards Claude updates
      the live nightly task to PROMPT VERSION 2026-11-23a and offers the skill update.
- [ ] **s4 (original plan, kept for reference)** Ask Alex for a gitsync, then run the drift check. Claim
      `db:fn:overwatch_nightly_counts`, then number the migration. Queue the migration first,
      then the test (`--test`). The test checks the new behaviour, so it fails against the old
      function.
- [ ] **s5** Verify, then ask Alex for a gitpush Checkpoint (migration path) and confirm the
      `db:` claim was released.
- [ ] **s6** Ask Alex for a gitpush Finish.

## Warnings

- **s4 starts from the live function definition, re-read at that step.** Migration 219
  rewrites the whole 400+ line function. The new migration must be built on the current
  definition (from `schema-snapshot.sql` after the gitsync, or the live database), not on the
  s3 draft alone. If any migration after 247 touches the function, re-plan s4.
- `status_written_at` defaults to now(), so a brand-new Project isn't stalled for its first
  `stall_days` days. That is intended.

## Next step's scope (s5)

Verify the test result (`ok: true`, 16 checks). Then Alex runs gitpush Checkpoint on main for:
.claude/skills/overwatch/SKILL.md, docs/overwatch-nightly-task-prompt.md,
supabase/migrations/249_overwatch_flags.sql, supabase/tests/overwatch_flags-k7d/1_counts_test.sql,
docs/progress-overwatch_flags-k7d.md. Then check with `claims.cmd status` that the db: claims went.

- create: nothing
- update: docs/progress-overwatch_flags-k7d.md
- delete: nothing
- deploy: nothing
- SQL: none
