# Progress: Overwatch (overwatch-q4n)

Spec: docs/technical-spec-overwatch-q4n.md

## Status: Phases 1 to 6 done (Phase 6 finished into main). Reopened 2026-10-27 for Phase 7 (inventory and impact review) and the new Phase 8 (project planning); Step 39 in progress

## Steps

- [x] Step 1: Read-only discovery of every app and the pieces Overwatch builds on (run tag overwatch-q4n-s1-k8vd)
- [x] Step 2: Read-only plan for Phases 1 to 3; claims check clean (run tag overwatch-q4n-s2-r3mb)
- [x] Step 3: Confirm and claim: 34 files and folders claimed, every database item reserved with its step (run tag overwatch-q4n-s3-w7np)

### Phase 1: Plumbing
- [x] Step 4: clips run_tag, repo and branch columns, index, backfill; clip-capture writes them (done 2026-10-24, checkpoint fb0449a)
  - [x] Migration written as `_pending_overwatch-q4n_clips_run_tag.sql`; clip-capture insert writes the columns; `clip-capture/index.test.mjs` (3 pass); `supabase/tests/overwatch-q4n/1_verify_clips_run_tag.sql`
  - [x] gitsync (nothing incoming, branch = main = origin/main at f323428), db:table:clips and db:deploy claimed, numbered `165_overwatch_clips_run_tag.sql`
  - [x] 165 applied 2026-10-24: 883 clips (748 cli), 685 with run_tag, 747 with repo or branch, 0 inbox tags not copied, CONFORMANT (71 tables)
  - [x] clip-capture deployed (version 14); verify_jwt still false; unauthenticated POST gets the function's own 401
  - [x] Verify: CLI reports carry all three, Chrome clip none, inbox_tags_not_on_clip empty, CONFORMANT
  - [x] Checkpoint 165 and clip-capture into main; db:table:clips and db:deploy released
- [x] Step 5: platform_runs and platform_schedules app foreign key to apps; MCP tool inputs and dj-courier follow (done 2026-10-24, main 989c5ea)
  - [x] `_pending_overwatch-q4n_platform_app_fk.sql` (refuses to run if any app value has no apps row); the 4 app inputs in mcp/index.ts are free text naming get_apps; dj-courier checks app against apps for create_platform_run and create_platform_schedule (VALID_APP gone); tests: dj-courier 59 pass, mcp index 36 pass
  - [x] gitsync (only this project's Step 4 merge and the snapshot came in), db:table:platform_runs, db:table:platform_schedules and db:deploy claimed, numbered `166_overwatch_platform_app_fk.sql`
  - [x] 166 applied 2026-10-24: only the two app foreign keys remain; apps in use alfred 702, dj 68, ken 46, sam 42, warren_buffet 32; CONFORMANT (71 tables)
  - [x] mcp deployed (version 166); verify_jwt still false; unauthenticated POST gets the function's own 401
  - [x] Verify from claude.ai: "homer" refused with the full get_apps list, nothing written; drive_mix run created and read back; test row deleted
  - [x] Checkpoint 166, mcp and dj-courier into main (87e0f21, merged as 989c5ea); db:table:platform_runs, db:table:platform_schedules and db:deploy released. The first attempt did not land.
- [x] Step 6: claim_blocks table and the overwatch-ingest function (claim_block only) (done 2026-10-24, checkpoint 9099f33, main 097ccde)
  - [x] `_pending_overwatch-q4n_claim_blocks.sql` (one row per episode, unique on waiter, holder, item, blocked_at; owner RLS, not audited); `supabase/functions/overwatch-ingest/` (index.ts, ingest.ts, deno.json, ingest.test.mjs: 9 pass); config.toml entry with verify_jwt = false; `3_verify_claim_blocks.sql` and `4_cleanup_step6_test_rows.sql`
  - [x] gitsync (only this project's Step 5 merge and the snapshot came in), db:table:claim_blocks and db:deploy claimed, numbered `167_overwatch_claim_blocks.sql`
  - [x] 167 applied 2026-10-24, CONFORMANT (72 tables); id and user_id comments added to 167 afterwards and run on their own. Grants match every other table (GRANT ALL from the schema's default privileges; grant_table adds the four and strips anon)
  - [x] Alex sets OVERWATCH_INGEST_SECRET (Supabase and desktop) and OVERWATCH_INGEST_URL (desktop); overwatch-ingest deployed (version 1, verify_jwt false, own 401 unauthenticated)
  - [x] CLI test events sent: new inserted 1; two repeats updated 2 with the bad event rejected by index; clear updated 1 and the resent new unchanged; wrong secret 401
  - [x] Verify: one episode, repeat_count 2, last_seen_at and cleared_at 20:03 UTC, same user as clips, CONFORMANT; test row cleaned up
  - [x] Checkpoint 167, overwatch-ingest and config.toml into main; db:table:claim_blocks and db:deploy released
- [x] Step 7: claims script posts blocks, repeats and clears through a local outbox and detached sender (done 2026-10-24, checkpoint 16bf53c, main a1267f6)
  - [x] claims-core: `blockEvents` (new, repeat, clear from the before and after block lists) and `queueBlockEvents`, called wherever the blocks file is written (recordBlocks, pruneBlocksLocked, and the refused-claim path in claims.mjs); `resolveRepo` sets `outboxFile` only where `scripts/overwatch-post.mjs` exists and CLAIMS_BLOCKS_FILE is unset
  - [x] `scripts/lib/overwatch-post.mjs` (outbox, sender lock, batches of 200, keep on failure, drop on 400 or rejected, cap 5000, log) and `scripts/overwatch-post.mjs` (the detached sender; OVERWATCH_SENDER=off stops it); tests: overwatch-post 11 pass, CLI suite 250 pass
  - [x] Checkpoint the five scripts into main (no database items)
  - [x] Two-checkout test: main held docs/overwatch-block-test.md; check sent `new`, the guard's refusal sent `repeat`, main's release sent `clear` (20:39:33 UTC); one episode, repeat_count 1, CONFORMANT; cleaned up
- [x] Step 8: Register DJ daily sync, Drive Mix daily refresh and Weekly DJ review schedules; prompts write runs (done 2026-10-24, checkpoint 592d0b6, main 6a3a13d)
  - [x] `_pending_overwatch-q4n_seed_schedules.sql` (091 pattern; expected_by in Pacific: 04:30, 04:54, Friday 06:00; grace 6); weekly prompt opens and closes a run; daily prompt's stale 17:00 UTC fixed
  - [x] gitsync (nothing came in), db:table:platform_schedules claimed, numbered `168_overwatch_seed_schedules.sql`
  - [x] Alex runs 168: three rows in (dj/daily_history_sync 04:30, drive_mix/daily_refresh 04:54, dj/weekly_review Friday 06:00, grace 6, enabled), CONFORMANT
  - [x] Drive Mix task updated with the run lines; the Weekly DJ review task gets the whole updated prompt file
  - [x] Checkpoint 168 and the two prompt docs into main; db:table:platform_schedules released. The Weekly DJ review task has the repo prompt word for word; the Drive Mix task has its run lines and loads the two run tools
  - [ ] Watch (no step needed): the next runs show up in get_platform_runs under each app and job

**Phase 1 done 2026-10-24.**

### Phase 2: Core tables
- [x] Step 9: app_profiles table and the overwatch apps row (done 2026-10-24, checkpoint 12884d5, main c5a28a6)
  - [x] `_pending_overwatch-q4n_app_profiles.sql`: overwatch apps row (Radar, /overwatch); app_profiles (one per user per app, rhythm_days 1 to 365, app_profiles_touch stamps updated_at and current_state_updated_at, owner RLS, audited); `7_app_profiles_test.sql` (rolls itself back)
  - [x] gitsync (nothing came in), db:table:apps, db:table:app_profiles and db:fn:app_profiles_touch claimed, numbered `169_overwatch_app_profiles.sql`. Checked: nothing in the app renders apps.path or button_name, so the row keeps path /overwatch
  - [x] Alex runs 169 (CONFORMANT, 73 tables) and `7_app_profiles_test.sql` (PASSED, 9 checks); checkpointed, db claims released
  - [x] Phase 6: the Overwatch icon in `src/apps/AppIcon.jsx` (Step 30 added Radar; Step 31 replaced it with TowerControl, mapping the row's "Radar" to it until Step 33's migration)
- [x] Step 10: activity table (with tags snapshot) and its three triggers (done 2026-10-24, checkpoint c01977f, main ca716c9)
  - [x] `_pending_overwatch-q4n_activity.sql`: group_types.kind (moved here from Step 11, named kind because conformance treats a "key" column as a credential) backfilled from the seeded labels; activity (owner RLS, audited, unique source_ref); activity_from_execution, activity_from_record_close (items and intents), activity_from_group_close. AFTER triggers, SECURITY DEFINER, exception-wrapped, only touch activity; the record and group triggers fire only on status, closed_reason or status_changed_at changes. Dedupe on matching timestamps within 10 minutes
  - [x] `8_activity_triggers_test.sql` (19 checks, rolls itself back)
  - [x] gitsync (nothing came in), db:table:group_types, activity, executions, items, intents, item_groups and the three db:fn items claimed, numbered `170_overwatch_activity.sql`. Alex agreed to kind moving into this step
  - [x] Alex runs 170 (CONFORMANT, 74 tables) and `8_activity_triggers_test.sql` (PASSED, 19 checks); checkpointed, db claims released
  - [x] Live: closing "OW Test close done" (mvmwqau76q5bx129p2) as done in the app made exactly one row (done, trigger, intents:mvmwqau76q5bx129p2:1792877102.353000). Undo and a Project close are covered by the test only
  - [ ] At Finish: `9_cleanup_step10_live_test.sql` removes that intention, its execution and event, and its activity row
- [x] Step 11: project_plans and project_links with the Project-only guard (finds Project groups by group_types.kind) (done 2026-10-24, checkpoint 66048af, main db0b3c6)
  - [x] `_pending_overwatch-q4n_project_plans.sql`: project_plans (one per Project group, project code once per user, waiting-on and hurdle kinds checked, status_written_at stamped when the status line changes); project_links (three kinds, once per pair and kind, never to itself); `project_plans_check_group` guards both (same user's Project groups only); owner RLS, audited
  - [x] `10_project_plans_test.sql` (17 checks, rolls itself back)
  - [x] gitsync (nothing came in), db:table:project_plans, db:table:project_links and db:fn:project_plans_check_group claimed, numbered `171_overwatch_project_plans.sql`
  - [x] Alex runs 171 (CONFORMANT, 76 tables) and `10_project_plans_test.sql` (PASSED, 17 checks); checkpointed, db claims released
- [x] Step 12: overwatch_plans (one active, seeded) with its two RPCs; overwatch_watch; overwatch_notes; overwatch_seen_releases; process_friction (done 2026-10-24, checkpoint 3d41c75, main b1a4ef7)
  - [x] `_pending_overwatch-q4n_overwatch_plans.sql`: the five tables (owner RLS, audited, every column commented; overwatch_seen_releases.entry_key cleared for conformance, since its name looks like a credential); create_overwatch_plan and update_overwatch_checks (invoker, caller's own rows); overwatch_plans_guard (only active true to false and checks_next_run may change, reserved as a new db:fn); starting plan seeded with the spec 4.6 settings (091 pattern)
  - [x] `11_overwatch_plans_test.sql` (22 checks, rolls itself back)
  - [x] gitsync (nothing came in), the five tables and three functions claimed, numbered `172_overwatch_plans.sql`
  - [x] Alex runs 172 (CONFORMANT, 81 tables) and `11_overwatch_plans_test.sql` (PASSED, 22 checks); checkpointed, db claims released

**Phase 2 done 2026-10-24.**

### Phase 3: Tools
- [x] Step 13: get_activity, log_activity, get_project_plans, update_project_plan, get_project_links, create_project_link, and the step-count RPC (done 2026-10-24, checkpoint baa3287, main ce331e8)
  - [x] `_pending_overwatch-q4n_project_progress_fn.sql`: overwatch_project_progress (invoker; Project groups in the given statuses, their plans, steps_used, reports and last_report_at from clips.run_tag)
  - [x] `_shared/tools/overwatch-activity.ts` (get_activity via readTable with Pacific date bounds and tag containment; log_activity, once per source_ref) and `_shared/tools/overwatch-projects.ts` (get_project_plans computed and clamped; update_project_plan upserts only the fields passed; get_project_links via readTable; create_project_link); registered in mcp/index.ts. Tests: overwatch-activity 8, overwatch-projects 6, mcp index 37 (count 147, new schema and tier test); all function and tool tests 725 pass
  - [x] gitsync (nothing came in; deployed mcp is still the Step 5 deploy of 11:14), db:fn:overwatch_project_progress and db:deploy claimed, numbered `173_overwatch_project_progress_fn.sql`
  - [x] Alex runs 173 (CONFORMANT, 81 tables); mcp deployed (version 168, verify_jwt false, own 401 unauthenticated)
  - [x] Verified from a new claude.ai thread: log_activity once per source_ref, tag filter, Pacific dates, trigger refused (by the input schema); plans, waits, links, duplicate and non-Project refused; cleanup left 0 of everything; checkpointed, db claims released
- [x] Step 14: get/create_overwatch_plan (tier 3), update_overwatch_checks, watch, notes, get_claim_blocks, update_app_profile, record_seen_releases, log_friction, get_friction, update_friction (tier 2) (done 2026-10-25, checkpoint 621a6ab, main af98e6b)
  - [x] `_shared/tools/overwatch-plan.ts`: the 14 tools (create_overwatch_plan tier 3 with propose listing what changes; the list tools through readTable, current watch items and open friction by default; create_overwatch_note and update_app_profile upsert; record_seen_releases reports which entries are new). No migration: the tables and RPCs came in Step 12. Registered in mcp/index.ts (count 161). Tests: overwatch-plan 11, mcp index 37 (schema and tier test covers all 20 Overwatch tools); all function and tool tests 773 pass
  - [x] gitsync (nothing came in), db:deploy claimed, mcp deployed 2026-10-25 (version 169, verify_jwt false, own 401 unauthenticated)
  - [x] Verified from a new claude.ai thread (four prompts, records named "OW TEST Step 14"); `14_cleanup_step14_test.sql` left every count at 0 and one active plan; checkpointed, db:deploy released

**Phase 3 done 2026-10-25.**

### Phase 4: Skills and backfill
Plan approved 2026-10-25 (run tag overwatch-q4n-s15-f2tb). Steps 17, 19 and 20 are done from claude.ai.
- [x] Step 15 (CLI): get_inbox gains a source_app filter ("none" = unrouted) (done 2026-10-25, checkpoint dddea36, main 995f940; tested: 9 unfiltered, 6 none, 1 warren_buffet, malformed refused)
  - [x] mcp/index.ts handler and schema; index.test.mjs (get_inbox schema list, new filter test): 38 pass
  - [x] gitsync (nothing came in), db:deploy claimed, mcp deployed 2026-10-25 (version 170, verify_jwt false, own 401 unauthenticated)
  - [x] Verify from a new thread (app id, "none", malformed); Checkpoint; db:deploy released
- [x] Step 16 (CLI): skills. cli-workflow (status line and log_activity on every report; closeout ships and closes the group; new projects get group and plan; log_friction); alfred-enrich (router: source_app or blank with a reason; duplicate check includes won't-do closes); new overwatch skill; job-search reads get_inbox by source_app jobs; sam-practice archives only its own items. Alex pastes changed skills into claude.ai and adds the log_friction line to the Alfred project instructions
  - [x] Written 2026-10-25: alfred-enrich, cli-workflow, job-search, sam-practice (additions only) and the new `.claude/skills/overwatch/SKILL.md`
  - [x] Checkpoint (76a8991, main b5feaed)
  - [x] Alex pastes the five skills into claude.ai, adds the project-instructions line, and adds source_app "sam" to the SAM daily review task's create_inbox_item call (Phase 4 confirmed complete 2026-10-25)
- [x] Step 17 (app, claude.ai): "Overwatch" Project group created in the app (id mvnv8pa2v6zip3xnpm); update_project_plan with code overwatch-q4n (done 2026-10-25)
- [x] Step 18 (CLI, SQL): backfill 30 days of activity, after Step 17 (done 2026-10-25, checkpoint 01c6e02, main 9283d59; 729 rows, 3 fewer than the preview because the CLI window moved forward about 3 hours). Same source_refs and skip rules as the triggers with on conflict do nothing; one progress row per CLI run tag from clips
  - [x] Preview `15_preview_activity_backfill.sql` run 2026-10-25: 732 to insert, 2 already present; approved
  - [x] `_pending_overwatch-q4n_activity_backfill.sql`: the preview's rows, inserted where the source_ref is new (safe to run twice)
  - [x] gitsync (nothing came in), db:table:activity claimed, numbered `174_overwatch_activity_backfill.sql`
  - [x] Alex runs 174 and `16_verify_activity_backfill.sql` (passed); Checkpoint; db:table:activity released
- [x] Step 19 (claude.ai): the four friction inbox items into process_friction, then archived (done 2026-10-25; Alex's labels: cli_testing_steps, todos, todos, skill:cli-workflow)
- [x] Step 20 (claude.ai): update_app_profile for every app from the approved drafts (done 2026-10-25: all 12 apps; rhythm_days alfred 2, warren_buffet 7, sam 3, ken 7, jobs 7, dj 3, drive_mix 14; workshop, timer, games, arnold, overwatch none)

### Phase 5: Nightly and weekly jobs
Estimate tracking first (spec 4.12, added 2026-10-25), because the nightly and weekly jobs read it.
- [x] Step 21 (CLI, SQL): project_estimates table (one initial, at most one final, insert-only) and an RPC that inserts a row and sets project_plans.effort_estimate in one transaction; seeds the Overwatch project with initial 40 then scope_increase +4 at step 18 (current 44)
  - [x] `_pending_overwatch-q4n_project_estimates.sql`: table (kind, estimate, cli_estimate, steps_added, at_step, reason; checks for each kind), project_estimates_guard (insert-only, own Projects only), record_project_estimate (factor from the active plan for initial and re_estimate; scope adds to the current figure; final from steps_used or given), owner RLS, audited, the seed; `17_project_estimates_test.sql` (17 checks, rolls itself back)
  - [x] gitsync (nothing came in), the four db items claimed, numbered `175_overwatch_project_estimates.sql`
  - [x] Alex runs 175, `17_project_estimates_test.sql` and `18_verify_project_estimates.sql` (passed); Checkpoint (c085b45, main 7462412); db claims released
- [x] Step 22 (CLI): record_project_estimate (tier 2) and get_project_estimates (tier 1); update_project_plan stops setting effort_estimate; tests; deploy
  - [x] overwatch-projects.ts: the two tools, estimateSummary; effort_estimate out of PLAN_FIELDS; get_project_plans adds original_estimate and scope_adjusted_estimate (one extra read per page)
  - [x] mcp/index.ts: both registered (163 tools), update_project_plan loses effort_estimate and points at record_project_estimate; tests 698 + 250 pass
  - [x] gitsync (only the schema snapshot came in), db:deploy claimed, mcp deployed (v171, verify_jwt false, unauthenticated 401)
  - [x] Checkpoint (9655213), db:deploy released; Alex's claude.ai test passed all four (scope_increase +1 at step 22 recorded, current 45)
- [x] Step 23 (CLI, skills): cli-workflow: the plan prompt asks for a step estimate by phase, saved as the initial row; scope rows from reports; the final row at closeout before the group is closed. overwatch skill: flag scope changes in the nightly note; overrun against the current estimate; the weekly accuracy report and correction factor through the plan gate
  - [x] cli-workflow and overwatch SKILL.md edited
  - [x] Alex pastes both into claude.ai; Checkpoint (main b610823)
- [x] Step 24 (claude.ai): add estimate_accuracy_min_shipped (3) and estimate_correction_factor (1.0) to the plan's settings with create_overwatch_plan (done 2026-10-25, plan 3a098929-2949-4cd6-b9af-87e7981c0707)
- [x] Step 25 (CLI, SQL + tools): friction status (spec 4.11, added 2026-10-25), before the weekly job, because its trigger counts only open entries. Migration: status (open, fixed, wont_fix; default open) and wont_fix_reason on process_friction, with checks (wont_fix needs a reason; open has no resolved_by or resolved_at; fixed and wont_fix have both); rows already resolved become fixed. update_friction sets status and stamps or clears the resolved pair; get_friction filters by status, open by default; tests; deploy mcp. The overwatch skill line: the trigger counts open only, and how to close as wont_fix
  - [x] `_pending_overwatch-q4n_friction_status.sql` (two columns, three checks, the open index on status, backfill); `19_friction_status_test.sql` (14 checks, rolls itself back)
  - [x] overwatch-plan.ts: get_friction `status` (open default, all) replaces `open`; update_friction `status` and `wont_fix_reason` (resolved_by alone still means fixed; wont_fix defaults resolved_by to alex); log_friction unchanged (the column defaults to open). Tests 700 pass. Overwatch skill weekly friction line
  - [x] gitsync (only our Step 23 merge came in), db:table:process_friction and db:deploy claimed, numbered `176_overwatch_friction_status.sql`; no caller of get_friction's old `open` argument in skills or docs
  - [x] Alex runs 176 (7 entries, all open), `19_friction_status_test.sql` (14 checks passed), `20_verify_friction_status.sql` (CONFORMANT); mcp deployed (v172, verify_jwt false, unauthenticated 401; downloaded source shows the new get_friction and update_friction schemas)
  - [x] Checkpoint (main 4705656), db claims released; claude.ai test passed (7 open; wont_fix refused without a reason, set with one)
- [x] Step 26 (CLI, docs): docs/overwatch-nightly-task-prompt.md and the schedule row
  - [x] Prompt written, `PROMPT VERSION: 2026-10-25a`: 10 steps; every number from the plan's settings; profiles through get_records app_profiles; scope changes since the last note; nudges capped at pushes_per_day; every inbox item source_app overwatch; proposed 5:40 am Pacific
  - [x] Alex's review (2026-10-25): task health via list_triggers, low-confidence routing (routing_low_confidence 0.6), overdue intentions (overdue_days 2) plus deadline mentions with no date in one item; procedure in the prompt, judgment in the skill (spec section 6 rule). Prompt 2026-10-25b; overwatch skill nightly section is now a pointer plus judgment
  - [x] routing_low_confidence 0.6 and overdue_days 2 added through the gate (active plan b39c8dcd-4324-4e63-8b97-7e14eb67be57); Alex pasted the overwatch skill; skill checkpoint in main (35e1636)
  - [x] The schedule rows (Step 27's migration 177); the prompt pasted into the claude.ai scheduled task
- [x] Step 27 (CLI, docs + SQL): docs/overwatch-weekly-task-prompt.md and the two schedule rows
  - [x] Weekly prompt written, `PROMPT VERSION: 2026-10-25a`: Mondays 6:15 am Pacific, checks weekly_day and raises a mismatch item; week from activity and notes; ideas and newly possible; feature watch via record_seen_releases; friction grouped (pattern_id only) and a fix item at 3 open in 30 days; estimate accuracy with the factor proposed, never written; drift audit every audit_every_weeks weeks (Phase 5 checks; the rest waits for Phase 7); nudges share pushes_per_day with the nightly. Overwatch skill weekly section is now a pointer plus judgment; spec section 6 updated
  - [x] `_pending_overwatch-q4n_schedules.sql`: overwatch/nightly and overwatch/weekly, the 168 pattern
  - [x] 2026-10-25, Alex moved the mornings so everything lands before 5 am Pacific: DJ 3:30, Drive Mix 3:54 (both tasks already moved), nightly 4:20, weekly Monday 4:35; plan 2b0efc78-b788-427a-b75f-efb9e91864ea (push_time 05:00, friction_trigger_count 3, friction_window_days 30). Weekly prompt reads the two friction settings (2026-10-25b); nightly prompt changed above the line only (stays 2026-10-25b); spec updated. The migration also moves the two 168 rows to 03:30 and 03:54
  - [x] gitsync (only the schema snapshot came in), db:table:platform_schedules claimed, numbered `177_overwatch_schedules.sql`; check `21_verify_schedules.sql`
  - [x] Alex runs 177 and the check; Checkpoint (main 38a1d45); both claude.ai tasks created from main (nightly trig_013sUsnchXf7L29ti7CunERU, weekly trig_01RMA3sFh9aXgRvZFzzHhSWR); the Overwatch Project group set to Active
- [x] Step 28 (CLI): fixes from the first manual nightly run (81ca5572-e5db-4d7d-9025-af9c53c5d1cb, partial)
  - [x] Nightly prompt 2026-10-25c: bulk reads grouped locally (activity window, one inbox read for backlog, unrouted, low confidence and Overwatch's own items, one ok-runs read for schedules, one events and one executions read for overdue), recipes at most 2 calls and skipped for apps already active yesterday, a call budget rule (pause once at 45 in 5 minutes, else skip counts), about 40 to 45 calls on a typical night; duplicate runs (a scheduled run stops with duplicate_of, a manual run goes ahead and replaces the note; create_overwatch_note already upserts on user, period and date, so no tool change); one-time tasks skipped in task health
  - [x] cli-workflow: set the new Project group to Active; friction wording names friction_trigger_count and friction_window_days. log_friction's description the same (mcp/index.ts; mcp index tests 38 pass)
  - [x] gitsync (only the schema snapshot came in), db:deploy claimed, mcp deployed (v173, verify_jwt false, unauthenticated 401; downloaded source has the new log_friction wording)
  - [x] Alex's Project-group rule (scope_increase +2 at step 28, estimate 47): nightly prompt 2026-10-25d counts empty Project groups (one get_groups read, flags key empty_projects, no item); cli-workflow 1b finds existing items and intentions for a new Project, else pushes an overview item; overwatch skill and spec 4.3 carry the rule
  - [x] Checkpoint (main f557cf8); Alex pasted cli-workflow and the overwatch skill; the nightly task updated to 2026-10-25d from main
- [x] First nightly run checked by hand (run 81ca5572, partial; its fixes are Step 28)
- [ ] First weekly run checked by hand (the weekly note for 2026-10-26 exists; not reviewed step by step in this thread)

### Phase 6: The tab
- [x] /overwatch shipped in the worktree (2026-10-26): status line and Briefing, Action Required, Active Projects, Quiet lately, Activity, Ideas, Friction (Steps 29 to 37)
- [x] Step 29 (CLI, read-only): Phase 6 plan (run tag overwatch-q4n-s29-k2rp): new src/overwatch/ folder plus viewPaths, Alfred.jsx, AppChrome, ObjectIcon, AppIcon (Radar); one view for apps' last activity; claims check clean. Estimate 8 steps (30 to 37). Alex approved every recommendation and added four design rules (spec section 9)
- [x] Step 30 (CLI): claim, skeleton
  - [x] Claimed src/overwatch/, viewPaths.js and its test, Alfred.jsx, AppChrome.jsx, ObjectIcon.jsx, AppIcon.jsx; reserved db:table:overwatch_app_last_activity for Step 33
  - [x] /overwatch route (view 29), nav entry with Radar (ObjectIcon and AppIcon), OverwatchPage with the seven section cards (empty states), OverwatchSection, overwatchCopy.js plus OverwatchCopyButton (on the shared CopyButton), NoteMarkdown; tests: 5 suites, 89 pass
  - [x] Alex looks at it in Chrome's mobile view (all pass)
- [x] Step 30 done
- [x] Step 31 (CLI): overwatchApi.js, Tonight's note and Needs you
  - [x] Icon: TowerControl replaces Radar (ObjectIcon, AppIcon with Radar mapped to it); Step 33's migration sets apps.icon for overwatch to TowerControl
  - [x] overwatchApi.js (getNotes, getRunFor by details.local_date, getNeedsYou, firstLine); NoteSection (NoteMarkdown, date, run status, copy with note and run ids); NeedsYouSection (Inbox-style rows opening the inbox item, kind from source_metadata, copy); page loads both. Tests: 6 suites, 98 pass
  - [x] Alex tests with the 2026-10-25 note and item 458af39a (all pass)
  - [x] Step 31b, Alex's review (scope_increase +2 at step 31, estimate 49):
    - spec section 9: the tab is a live snapshot (Activity the one dated section; its own tab is future work); a status line linking to /overwatch/note with the note's copy, a warning only on a FAILED run; "Action Required"; red for time-sensitive things (urgent_within_days, default 7, through the gate); every link a real anchor (also in docs/design-system/design-system.md); estimated finish from pace; the inbox line rule. Section 6: the note's new shape. 4.6: urgent_within_days
    - code: /overwatch/note route (viewPaths); statusLine.js; getLatestRuns (getRunFor dropped); NoteSection is the note view with a Back link and no run status; ActionRequiredSection replaces NeedsYouSection (stretched real links, red for overdue and failure kinds). Tests: 6 suites, 101 pass
    - nightly prompt 2026-10-26a: note shape (no title; Action Required, Yesterday's Activity), friendly dates, records as markdown links, projects with estimated finish (needs first_report_at) and sub-bullets, quiet apps "Jobs (3 days)" with the real last use from the app's data, the inbox line, schedule problems as bugs to log, urgent deadlines
    - overwatch skill 2026-10-26a (judgment for the above); cli-workflow 2026-10-26a ("Nothing travels by hand"; step format: one physical action, one-line terminal boxes, Expected on every terminal step, numbering restarts per part, START NEW / IN THAT SAME CLAUDE AI THREAD)
    - Step 33 now also adds first_report_at to overwatch_project_progress (db:fn reserved)
  - [x] Alex tests the revised tab (all pass); urgent_within_days 7 in the plan (499309d8-d8bd-42a5-be70-590214bccfb0)
  - [x] Step 31c: header without tagline; status line "everything scanned" / "partially scanned: <plain words>" / red "Scan failed · see Action Required" (skipped entries now { part, error }); Briefing page (Newspaper) at /overwatch/briefing and /overwatch/briefing/<note_id>, one header per briefing linking to itself, old title lines stripped, copy ends "Let's go through this briefing."; Action Required titles shortened. Nightly prompt 2026-10-26b (skipped format, scan_gap items, the proposal first line fixed for dedup); weekly prompt 2026-10-26a (note rules, skipped format, friction-fix and newly-possible first lines fixed for dedup). Spec updated. Tests: 6 suites, 106 pass
  - [x] Alex tests Step 31c (all pass); prompts, skills and the style guide checkpointed (main 811cd4c); both tasks updated from main
- [x] Step 31 done
- [x] Step 32 (CLI): the Projects section
  - [x] Fixes: short Action Required titles capitalised; skipped entries parsed in both forms (old "<part> — <error>" strings and { part, error }), warren_buffet worded "Money"; the bold "**Overwatch nightly, …**" title line stripped from the briefing and its copy
  - [x] getProjects (overwatch_project_progress, project_estimates, live item_group_members, waited-on group names, the active plan's settings); projectsModel.js (estimated finish from pace, waiting on, stall and overrun from the plan's settings, empty group); ProjectsSection (cards linking to the group, red overrun and empty warning, scope changes, copy); header "Projects (1 of 3)". Tests: 7 suites, 116 pass
  - [x] Alex tests with the Overwatch project (all pass)
- [x] Step 32 done
- [x] Step 33 (CLI, SQL + UI): the database step, then Quiet lately
  - [x] Projects card fixes: the whole card is one real link to its group (stretched; the waited-on link and copy sit above it); the Project group type's icon (read live from group_types, SquareKanban); copy "Steps: 29 of 49 (original 40)". Tests 6 suites, 42 pass
  - [x] `_pending_overwatch-q4n_tab_views.sql`: view overwatch_app_last_activity (security_invoker, platform.grant_table per Rule 2b, since register_table is for tables); overwatch_project_progress dropped and recreated with first_report_at (grants again); apps row icon Radar to TowerControl; check query with conformance. `22_tab_views_test.sql` (10 checks, rolls itself back) and `23_verify_tab_views.sql`
  - [x] gitsync (only our checkpoint came in; record_project_estimate is plpgsql and calls the function at run time, so the drop and recreate is safe), the three db items claimed, numbered `178_overwatch_tab_views.sql`
  - [x] Alex runs 178 (CONFORMANT), `22_tab_views_test.sql` (11 checks passed), `23_verify_tab_views.sql` (view rows only for alfred, sam, dj, arnold; first_report_at 2026-10-24)
  - [x] Quiet lately: getQuiet (the view, app_profiles rhythms, ease_off watch items); quietModel.js (last use = newer of the view and the latest nightly note's quiet_apps flag, which holds { app, days_since, rhythm_days } and is read as for_date minus days_since, or last_used_on if a later prompt adds it; "No activity yet" when neither has a date; past rhythm only; ease_off and no-rhythm apps left out; red at twice the rhythm; quietest first); QuietSection (app icon, "Jobs (3 days)", Money for warren_buffet, the whole row a real link to the app's screen when it has one, copy); appNames.js shared with the status line. Tests: 9 suites, 129 pass
  - [x] Alex tests Quiet lately (all pass)
  - [x] Step 33d: a quiet app with no date is titled by name only ("Money"), the line below says "No activity yet"; nightly prompt 2026-10-26c: the quiet_apps flag is { app, last_used_on, days_since, rhythm_days }, last_used_on required, read from the app's own data when the activity log has no row ("none" only when the app has no data); up to 4 extra calls, usually 0 because Step 4's pull already read that record
  - [x] Alex checkpoints the prompt and migration 178 (9b6bb8a) and updates the task
- [x] Step 34 (CLI): the Activity section
  - [x] getActivityDay (a UTC window a day either side, served by activity_user_occurred_idx, filtered to the Pacific day; no database change needed); activityModel.js and ActivitySection.jsx, self-contained (own reads, state, apps): Earlier / Later by day (Later disabled on today), "Today" / "Yesterday" / "Fri, Oct 23"; rows with app icon, kind · time · source (not for nightly); a whole-row real link for group, item, intention, execution and job_application targets; rows of the same app, kind and title grouped as "Sam: practice pass ×12", expandable; app and kind chips (the Inbox chip style, with counts) that persist while paging; empty texts; copy per row. Loads when the section is opened. Tests: 9 suites, 131 pass
  - [x] Alex tests Activity (all pass)
  - [x] Step 34b: rows sharing a group_id (2 or more, after filtering) become one project row: "<Project>: N <kind> reports" or "N updates", ", Steps lo to hi" when every title names a step; time range · Project icon; a real link to the group with a separate chevron (stops the click) and its own copy ("Where does this project stand now?"); expanded rows keep their links and copies; chips count underlying rows. getActivityGroupInfo reads the groups' names and the Project icon. Tests: 9 suites, 134 pass
  - [x] Alex tests on Sat, Oct 24 (all pass)
  - [x] Step 34c: opens on yesterday (Later to Today, disabled there); copy text always uses the real date ("Sun, Oct 25"); nightly rows show "Logged overnight", their copy has the date only, and they belong to the day in source_ref ("sam:2026-10-24"), not occurred_at (the 11:39 am Oct 25 rows were Oct 24's, stamped when the first manual run ran; the 12:00 pm ones are the 4:20 run's noon placeholder). Tests: 9 suites, 136 pass
  - [x] Alex tests Step 34c (all pass)
- [x] Step 34 done
- [x] Step 35 (CLI): Ideas and Friction
  - [x] Ideas (spec section 9 item 5: Someday Projects, and active ones parked behind a hurdle): getIdeas (overwatch_project_progress for someday and active, item_groups.created_at, contexts); IdeasSection (Project icon, whole-row real link to the group, "added Oct 3", Someday or Parked (kind): waiting on …, context · app, copy, oldest first, "No ideas waiting.")
  - [x] Friction: getOpenFriction (status open, the plan's settings); FrictionSection (groups by process with plain names and counts, a red Pattern marker when the entries inside friction_window_days reach friction_trigger_count, first lines with dates, copy per entry and per group, "No open friction."). Tests: 10 suites, 143 pass
  - [x] Nightly prompt 2026-10-26d: log_activity passes occurred_at = yesterday at noon Pacific with the right offset
  - [x] Checked: "OW Test close done" (Oct 24, 2:25 pm, trigger) is Step 10's live trigger test; the intention mvmwqau76q5bx129p2 still exists, closed done; test residue, removed at Finish by `9_cleanup_step10_live_test.sql`
  - [x] Alex tests; prompt 2026-10-26d on main (c5ad7d8), task updated
  - [x] Step 35b A: the copy rule (a group of 2 or more copies once on its header, its rows do not; a single entry copies itself; "Other" friction entries stand alone and are never a pattern), applied to Friction and to Activity's project and same-title groups. Tests: 10 suites, 144 pass
  - [x] Step 35d: Action Required titles get More / Less. Wider Ideas built to Alex's rule: getIdeaRecords (Alfred context found by name; active or someday items and intentions there, idea-tagged ones elsewhere; live group memberships); ideasModel.js (Projects group first; Alfred rows in no group and not tagged bug, by first app-id tag then "No app"; other contexts by context; oldest first); IdeasSection (group headings with app, context or Project icon and count; whole-row real links; the copy rule; More / Less). Expected now: Alfred 9, DJ 2, Overwatch 1, Workshop 2, No app about 30, other contexts 0, plus the Projects group. Tests: 11 suites, 148 pass
  - [x] Step 35e: Ideas groups start collapsed and their headings toggle (the copy button sits beside the toggle and works either way); capture targets (items with is_capture_target) are left out everywhere: only "Alfred Roadmap" is one, "Overall Roadmap" is not flagged and stays. Tests: 11 suites, 150 pass
  - [x] Step 35f: Alex ran by hand (2026-10-26) three new apps (switchboard Cable, monty_don Sprout, sports Trophy) and app tags on 11 items and 18 intentions; recorded as `_pending_overwatch-q4n_new_apps_and_app_tags.sql` (idempotent, marked Applied by hand); Cable, Sprout and Trophy added to AppIcon. Tests: 12 suites, 155 pass
  - [x] gitsync (no schema drift), db:table:apps, db:table:items, db:table:intents claimed, numbered `179_apps_switchboard_monty_don_sports_and_idea_app_tags.sql` (not to be run again)
  - [x] Step 35g bug: the new apps' rows sat under "No app" because the tab took its apps list from useApps, which caches it for the whole browser session; a tab loaded before the apps were added kept the old list. The tab now reads apps fresh with the rest of its data (getApps), Activity reads them when it opens, the status line, Quiet lately and Ideas use that list, the Money name stays in appNames.js, unknown icons fall back to the grid. Tests: 12 suites, 157 pass
  - [x] Checkpoint 179 (main 440c0c6), db claims released; Alex tests Ideas
- [x] Step 36 (CLI): mobile polish and full tests
  - [x] "Active Projects (N)", the limit wording and activeCountLabel removed; tap targets to 40px (copy buttons through OverwatchCopyButton, Activity chevrons, chips, More / Less, briefing header links); long words, ids and URLs wrap on the tab and the Briefing page (overflow-wrap anywhere). No screenshots: no browser driver is installed and the app needs a sign-in
  - [x] Full app suite 207 suites, 3098 pass; CLI suite 250 pass. Build: compiles (with the ESLint plugin off); with it on, it reports a stale "OverwatchPage is not defined" at Alfred.jsx 1877 that direct ESLint (with and without the cache) does not, so node_modules/.cache needs clearing (Alex's step)
  - [x] Alex clears the build cache and rebuilds (compiles); device mode at 412px, all pass
  - [x] Step 35b B (wider Ideas): stopped after reading; Alex approved rule (a) in Step 35d. No app field (app only as a tag on some rows), "section" undefined, no "idea" tag in use yet. Alfred context would show about 45 rows (17 items, 28 intentions, bugs and active-Project members excluded); other contexts 0. Waiting for Alex's choice
  - [x] Step 35c: MoreLess.jsx (useClamp measures scrollHeight against clientHeight; a small More / Less control that stops the click), on Friction entries (also when the text has more than its first line), Activity rows and project rows, and Ideas rows. Action Required titles still clamp with no toggle. Tests: 11 suites, 146 pass
  - [x] Step 35b C: alfred-enrich 2026-10-26a gets the `idea` tag rule (bugs get `bug` instead; Alfred code ideas also get the app tag); spec Appendix A (profile preference) and B (sweep) suggest `idea`. The hourly enrichment task's prompt is not in the repo; it follows the alfred-enrich skill

- [x] Step 37 (CLI): closeout prepared (run tag overwatch-q4n-s37a-q6tm); Alex ran gitpush Finish for Phase 6, which merged it into main and moved this file and the spec to docs/history (Step 39 brings them back)
  - Finish list as prepared: (1) Supabase SQL editor, `supabase/tests/overwatch-q4n/9_cleanup_step10_live_test.sql` removes the "OW Test close done" intention mvmwqau76q5bx129p2, its execution, event and activity row; (2) the final estimate: record_project_estimate kind final for the Overwatch group, before the group is closed (cli-workflow closeout); (3) close the Overwatch Project group as Completed in the app (writes the shipped activity row); (4) the first weekly run reviewed on the next Monday; (5) Phases 7 and 8 stay deferred. Which of (1) to (4) ran is not recorded here; with the project reopened, (2) and (3) wait for the new closeout (Step 61)

### Phase 7: Inventory and impact review (revived 2026-10-27; spec 4.9, 4.13 to 4.15, 5.4 to 5.6, 5.9, section 6)
- [x] Step 38 (CLI, read-only): plan for Phases 7 and 8 (run tag overwatch-q4n-s38a-h4tw): file and database lists, claims check clean, 166 defineTool calls (163 registered, 3 unregistered DJ tools, none registered without defineTool), the snapshot lag confirmed, 22 steps estimated. Alex confirmed every recommendation, replacing the project_plans ranking with the portfolio plan
- [x] Step 39 (CLI): claim, docs back to docs/, the Oct 27 decisions in the spec, this file (run tag overwatch-q4n-s39-m2kd)
  - [x] Claimed 40 files and folders in one command; reserved db items with their steps (43, 45, 53, 57)
  - [x] Spec and progress written back to docs/; the docs/history copies deleted
  - [x] Spec: Phase 7 decisions (5.6, 5.9, 4.9, 4.13 to 4.15, section 6, section 7), new Phase 8 (8a families, chat work, 8b portfolio plan in 4.16, section 7 and section 9, 8c in 4.17), old Phase 8 moved out
- [x] Step 40 (CLI): `tables` on defineTool, first batch of annotations; lanes in the spec (run tag overwatch-q4n-s40-p7cv)
  - [x] Spec 4.16, section 7 and section 9: lanes are rows of a plan version (portfolio_lanes: name, position, note); slices belong to a lane, ordered within it, one in progress per lane; create_portfolio_plan takes lanes with their slices; Now is one line per lane. db:table:portfolio_lanes reserved for Step 53; Steps 53 to 56 unchanged
  - [x] platform.ts: `ToolTables` and an optional `tables` on DefineToolOptions (required from Step 41)
  - [x] Annotated 74 tools: mcp/index.ts 23, warren-buffet 8, warren-buffet-p2 25, warren-buffet-p3 18. RPC-backed tools list the tables the RPC and the functions it calls touch (from the schema snapshot); views and platform.* names as they are; defineTool's own plumbing (budget, settings, audit) is not declared. Every declared name exists in schema-snapshot.sql
  - [x] Tests: mcp index, the three Money suites and the platform tests, 156 pass. `deno check --no-lock` on mcp/index.ts: 111 type errors already in the code (implicit any, zod's z.record arity, Supabase result types), none about `tables`
- [x] Step 41 (CLI): annotate the other 92; compare type errors with main (run tag overwatch-q4n-s41-w3fq)
  - [x] 92 annotated across 22 files in _shared/tools/ (the three unregistered DJ tools included); 166 of 166 defineTool calls now carry `tables`, every name in schema-snapshot.sql
  - [x] `deno check --no-lock` on mcp/index.ts: main (8094166) and this worktree both 111 errors, messages identical; none new
  - [x] Tests: mcp index, every _shared tool and platform suite, alfred-tools: 776 pass
- [x] Step 41b (CLI): `tables` required, the conformance test, the mcp-platform skill (run tag overwatch-q4n-s41b-k8rz). One step added (scope_increase +1 at step 41). Checkpointed with Steps 39 to 41 (main 2a7ac3c)
  - [x] scripts/lib/inventory.mjs: snapshotObjects, parseDefineTools (name and literal tables from the properties before handler or propose), tableProblems ("*" in reads only), toolSourceFiles; inventory.test.mjs (8 tests)
  - [x] supabase/functions/mcp/tables.test.mjs: every defineTool under supabase/functions, 166 found. Failed as it should with get_apps' tables removed ("no tables before the handler") and with get_reminders reading "reminders_made_up" ("not in the schema snapshot"); both restored; passes
  - [x] get_records reads "*"; platform.ts `tables` required (deno check: the same 111 existing errors, none about tables)
  - [x] Spec 5.6: tables before handler, "*" for generic readers, triggers and shared plumbing not declared. mcp-platform skill 2026-10-27a (first version line): the `tables` rule, both examples, an anti-pattern line; Alex pastes it into claude.ai
  - [x] Tests: functions 777 pass; CLI suite 258 pass; app suite 207 suites, 3098 pass
- [x] Step 42 (CLI): gitpush fixes: snapshot label, `--no-snapshot` (Checkpoint only, Alex's call), folders in `--paths` (run tags overwatch-q4n-s42-d5jn, overwatch-q4n-s42b-x4hm)
  - [x] Label: the snapshot runs with `--through <newest merged migration>` and records the larger of that and the checkout's own (snapshotLabel); worktree merges and main pushes both pass it. Today's 178-with-179-merged corrects itself at the next push that carries a migration; a one-off `npm run schema:snapshot` makes it right now
  - [x] `--no-snapshot` on Checkpoint: snapshotDecision `skip`, the plan says the snapshot is skipped and stays behind; refused on Finish and main; in --help
  - [x] Tests: schema-snapshot 16 pass (5 new)
  - [x] Step 42b, `--paths` folders (Alex confirmed claiming git-flow.mjs and its test): expandPathWords in git-flow.mjs (a changed file as before; a folder becomes every changed, added or deleted file under it; a folder with nothing changed under it is refused); doCheckpoint uses it for `--paths` and for typed answers. Fixes the 2026-10-24 note below. Tests: 5 new; CLI suite 268 pass
- [ ] Step 43 (CLI, SQL): platform_inventory, platform_open_work, finish_summaries and replace_platform_inventory (run tag overwatch-q4n-s43-r6tb)
  - [x] `_pending_overwatch-q4n_platform_inventory.sql`: platform_inventory (kinds include trigger; reads_any for a "*" reader; details jsonb; unique kind + name; not audited), platform_open_work (docs/ files only; unique file + line; not audited), finish_summaries (one per merge commit; reviewed_by_run needs reviewed_at; audited); replace_platform_inventory (upsert then delete unseen, one transaction, refuses empty or duplicate sends; service_role only); owner RLS, grants via register_table, every column commented, check query with conformance
  - [x] `24_platform_inventory_test.sql` (24 checks, rolls itself back) and `25_verify_platform_inventory.sql`
  - [x] gitsync (fast-forward fe80fd3 to 96091f9, only this project's two checkpoints; no migration, snapshot or name drift), the four db items claimed, numbered `180_overwatch_platform_inventory.sql` (claimed; the _pending_ file deleted)
  - [x] Alex runs 180, `24_platform_inventory_test.sql` and `25_verify_platform_inventory.sql`; checkpointed (main 1303ffd), db claims released (none held at Step 44)
- [ ] Step 44 (CLI): scripts/inventory.mjs and `npm run inventory` (run tag overwatch-q4n-s44-q9wf)
  - [x] scripts/lib/inventory.mjs: tier and offset from the parser; appFor (name words, only seeded app ids), toolParts (registered only, "*" as reads_any), skillPart and taskPromptPart (tools mentioned, their tables, version line), edgeFunctionPart, snapshotParts (tables, views, triggers with their function's writes), screenParts, isWorkDoc and openWork, lastChangedFromLog, dedupeParts; spec 5.5 "As built"
  - [x] scripts/inventory.mjs and `npm run inventory` (package.json): payload to .scratch/inventory.json, summary; `--json`
  - [x] Tests: inventory 21 pass (13 new); CLI suite 281 pass; mcp tables test passes
  - [x] Real run: 497 parts (163 tools, 12 skills, 8 functions, 5 task prompts, 106 tables and views, 164 triggers, 39 screens), 920 open-work lines (867 checkboxes, 22 deferred, 31 not fixed), about 880 of them in docs/history; 8 skills have no "Skill version:" line
  - [x] Alex decided (Step 45): docs/history filtered, see spec 4.13
- [ ] Step 45 (CLI): history filter; overwatch-ingest kinds `inventory` and `finish_summary`; `--send`; deploy; first send (run tag overwatch-q4n-s45-v8kp)
  - [x] openWork: in docs/history only unchecked follow-ups, deferred, not fixed and "Later" bullets (as deferred_phase); "Later" bullets everywhere. Inventory now 497 parts, 121 open-work lines (31 checkbox, 58 deferred, 32 not fixed). Tests: inventory 23
  - [x] ingest.ts: parseInventory, parseFinishSummary, isRefusal; index.ts: inventory through replace_platform_inventory, finish_summary upserted on merge_commit, database refusals 400. Tests: ingest 15
  - [x] overwatch-post: sendGroups (a `_kind` event goes alone, in order; blocks still batch); scripts/inventory.mjs `--send` queues one inventory event under the claims lock and runs the sender. Payload about 185 KB on the wire, one request. Tests: overwatch-post 13; CLI suite 285 pass
  - [x] gitsync (fast-forward cd8b120 to 1303ffd: only the snapshot, through migration 180, labelled right by Step 42's fix); db:deploy claimed; overwatch-ingest deployed (version 2, verify_jwt false, unauthenticated POST gets its own 401 `{"ok":false,"error":"unauthorized"}`)
  - [x] First send (run tag overwatch-q4n-s45b-c3tz): 501 parts (8 functions, 39 screens, 12 skills, 109 tables and views, 5 task prompts, 163 tools, 165 triggers), 124 open-work lines (32 checkbox, 59 deferred, 33 not fixed); the function returned parts 501, open_work 124, removed 0 and 0
  - [x] Alex runs the check query; checkpointed (main 9c3c9c1), db:deploy released
- [ ] Step 45 (CLI): overwatch-ingest kinds `inventory` and `finish_summary`; the outbox sends an inventory on its own; deploy overwatch-ingest (db:deploy reserved)
- [ ] Step 46 (CLI): get_platform_inventory, get_open_work, get_finish_summaries, mark_finish_summaries_reviewed; deploy mcp (run tag overwatch-q4n-s46-j5ry)
  - [x] `_shared/tools/overwatch-inventory.ts` (new): the four tools through readTable (inventory counts per kind in a NOTE; `table` marks uses), mark sets reviewed_at and reviewed_by_run; registered in mcp/index.ts (167 tools); spec section 7. Tests: overwatch-inventory 6, all function tests 798 pass; deno check back to the 111 existing errors
  - [x] gitsync (fast-forward 124521a to 9c3c9c1, this project's checkpoint only; nothing under mcp/, migrations or the snapshot), db:deploy claimed, mcp deployed (version 174, verify_jwt false, unauthenticated POST gets its own 401 "Unauthorized")
  - [x] Alex runs the four new-thread prompts (inbox users, reads_any, warren_buffet history, finish summaries); checkpointed (main be7bfbe), db:deploy released. The test showed BEFORE triggers that change their own row listed as reads only (fixed in Step 47)
- [ ] Step 47 (CLI): gitpush sends the inventory and the finish summary; triggers that change their own row (run tag overwatch-q4n-s47-g6sd)
  - [x] inventory.mjs: a trigger whose function assigns to NEW (:= or =, at a statement start) writes its own table (inbox.set_updated_at, set_archived_at, inbox_set_source_app now both); buildInventory(root) moved into the lib, scripts/inventory.mjs uses it
  - [x] scripts/lib/finish-summary.mjs (new): parseNumstat, classifyPaths, toolsIn, buildFinishSummary, collectFinishSummary, sendsFor, sendPlanLine, queueOverwatch; tests 10
  - [x] gitpush: a "Send" line in every mode's plan; afterPush queues the inventory after every push into main and a finish summary on Finish (worktree: merge commit against its first parent; main: against the upstream before the push); nothing when refused, cancelled, skipped, failed, or OVERWATCH_SENDER=off; prints what was queued and the sender's log
  - [x] Spec 5.4 and 5.5; CLI suite 296 pass
  - [ ] Alex's next checkpoint shows the Send line and the queued line; then check get_platform_inventory's seen_at
- [ ] Step 48 (CLI, docs): nightly prompt (finish summaries against the inventory, follow-up items, current_state, mark reviewed); weekly drift audit Phase 7 checks; overwatch skill; Alex pastes prompts and skills
- [ ] Step 49 (CLI): end-to-end check (a real inventory send, a finish summary, the next audit run)

### Phase 8: Project planning (new 2026-10-27; spec section 10 item 8, 4.16, 4.17)
The old Phase 8 (Switchboard state through overwatch-ingest) moved out of this project to an Alfred intention.
- [ ] Step 50 (CLI, read-only): 8a review pass 1, Alfred core (alfred, overwatch, timer, games); findings saved to current_state from claude.ai
- [ ] Step 51 (CLI, read-only): 8a review pass 2, Money and SAM (warren_buffet, sam)
- [ ] Step 52 (CLI, read-only): 8a review pass 3, chat-and-tool apps (dj, drive_mix, ken, jobs; workshop, switchboard, arnold, monty_don, sports)
- [ ] Chat work in claude.ai (no step number): Alfred items and intentions review, including the roadmap item and SAM; friction log turned into intentions attached to projects; ideas from other Claude chats swept into Alfred
- [ ] Step 53 (CLI, SQL): 8b portfolios, portfolio_plans, portfolio_slices, create_portfolio_plan, the two guards (db items reserved)
- [ ] Step 54 (CLI): 8b tools in overwatch-portfolio.ts (get_portfolios, upsert_portfolio, get_portfolio_plan, create_portfolio_plan tier 3, update_portfolio_slice); deploy mcp
- [ ] Step 55 (CLI): 8b Projects section: portfolio switch; Now, Next, Later; "Not in the plan"
- [ ] Step 56 (CLI): 8b plan page /overwatch/plan/<portfolio_id> (theory, notes, review_by, versions); nightly review_by item; overwatch skill
- [ ] Step 57 (CLI, SQL): 8c inbox.suggested_group_id; process_inbox_item `group` payload (db items reserved)
- [ ] Step 58 (CLI): 8c create_inbox_item and update_inbox_item accept suggested_group_id; alfred-enrich skill; deploy mcp
- [ ] Step 59 (CLI): 8c inbox detail: SuggestedGroup with an accept toggle
- [ ] Step 60 (CLI): full app and CLI suites, mobile check
- [ ] Step 61 (CLI): closeout

## Notes
- 2026-10-24: Alex agreed: proposals are plain task inbox items (no Phase 9 dependency); project planning fields in a one-to-one project_plans table, not on item_groups; Overwatch fixes the plumbing gaps it needs; the wider drift list is a separate bug (inbox item fe062cd4-832d-4a3c-a67b-ecdba5699b30).
- 2026-10-24, after the plan step: app_profiles instead of columns on apps; claim_blocks moves to Phase 1; three activity triggers; block episodes not attempts, posted from an outbox; create_overwatch_plan is tier 3; activity keeps a tags snapshot (the CLI suggested dropping the tag filter; Alex wants tag filtering); group_types gets a stable key; seeding through migrations; Today's Jazz is a chat skill, not a schedule.
- 2026-10-24: inbox ownership: every item has one owner app; the hourly enrichment job is Overwatch's router and leaves an item blank with a reason when unsure; app skills read only their own items; the nightly job audits routing. Spec principle 5 rewritten.
- 2026-10-24, gitpush follow-up (not fixed here): Checkpoint `--paths` refuses a new folder ("not changed in overwatch-q4n: supabase/functions/overwatch-ingest") because it compares each path against git's per-file list. It should accept a folder whose files are new or changed. Until then, name the files one by one.
- 2026-10-24, during Step 5: process friction log added (spec 4.11): any thread logs snags in how the work runs with log_friction, without asking; the weekly job groups open entries by process and proposes a fix once one process has three or more in 30 days. Table in Step 12, tools in Step 14, logging instructions in Phase 4. The overwatch skill also enriches and routes on the spot any item the hourly job has not reached yet.
- 2026-10-25, during Step 22, Alex's friction decisions: a status column (open, fixed, wont_fix, the last with a one-line reason), with only open entries counting toward the trigger (Step 25); a Friction section on the tab (Phase 6); friction covers every workflow, not just coding, and the logging line is now in his claude.ai profile preferences (spec 4.11 reworded). Adds one step.
- 2026-10-27, Steps 38 and 39, Alex's decisions: Phase 7 as specced plus open work from docs (platform_open_work), the snapshot label fix with a `--no-snapshot` opt-out, literal `tables` arrays checked by a test in the mcp suite, the three unregistered DJ tools annotated but not inventoried, reviewed_at on finish_summaries; old Phase 8 out; new Phase 8 project planning with the portfolio plan (slices in two lanes, versioned per portfolio) in place of a project ranking. The portfolio plan needs four steps, not three (53 to 56), so 8c moves to 57 to 59, and the project ends at Step 61 (23 steps from 39, one more than the Step 38 estimate).
- 2026-10-27, Step 38: the claims guard read the `=>` arrow in a read-only `node -e` as a `>` redirect and blocked it; reported, not retried.
