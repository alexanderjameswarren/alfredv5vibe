# Progress: Warren Buffet money chat skill and clean-up

Project code: `warren_buffet_p4-r6d`. Spec: `docs/history/technical-spec-warren_buffet_p4-r6d-money_chat.md`. Steps 1 to 10 of this code are Phase 4 and the plan for this slice (`docs/history/progress-warren_buffet_p4-r6d.md`, then run tags `s10` and `s10b`).

**Privacy rule:** no dollar amounts, payees or product names here.

**Status: finished. Steps 11 to 22 done (Step 14 was not needed).** Alex runs gitpush Finish. Nothing here is committed by a thread; Alex commits.

| Step | Work | Files | Database | Status |
|---|---|---|---|---|
| 11 | Confirm and claim | this file and the spec | none | done |
| 12 | Bring prompt 2026-10-25a into the repo, no other change | `docs/wb-weekly-cleanup-task-prompt.md` | none | done |
| 13 (14 not needed) | Money record links | `src/records/recordRoutes.js`, `src/records/recordRoutes.test.js` | none | done, awaiting Alex's check |
| 15 (one more if results need fixes) | Migration and tests | `supabase/migrations/199_wb_subscription_reviews.sql` (was `_pending_`, then 198); `supabase/tests/warren_buffet_p4-r6d/` | `db:table:wb_subscriptions`, `db:table:wb_subscription_reviews`, `db:table:wb_subscription_overview`, `db:fn:wb_record_subscription_review`, claimed at this step | done, checkpointed (cfec4a1) |
| 16 | Tools and deploy; waits for `nightly_counts-f8k` to finish | `supabase/functions/_shared/tools/warren-buffet.ts`, `warren-buffet-p2.ts`, `warren-buffet-p4.ts` and their `.test.mjs` files; `supabase/functions/mcp/index.ts`, `index.test.mjs`, claimed at this step | `db:deploy`, claimed at this step | done, checkpointed (8541ef6), tested |
| 17 | Remove dead code; move 5 test scripts | `src/money/moneyApi.js`, `src/money/moneyApi.test.js`; migrations 134_, 136_, 138_, 141_, 144_; `supabase/tests/warren_buffet_p3/` | none | done (17 and 17b) |
| 18 | `wb-money` and `wb-planning` | `.claude/skills/wb-money/SKILL.md` (new), `.claude/skills/wb-planning/SKILL.md` (the overwatch line moved to Step 20) | none | done |
| 19 | Fresh-thread test, one real review | this file | none | done |
| 20 | Skill fixes (the overwatch line moved to Step 21) | the two wb skills | none | done |
| 21 | New prompt version, and the overwatch hand-over line. Once in main, after Step 16's deploy, Claude updates the "Money cleanup" scheduled task and checks its PROMPT VERSION | `docs/wb-weekly-cleanup-task-prompt.md` (the overwatch line left this slice: `notification_routing-d7v` holds the file) | none | done; the task update follows Finish |
| 22 | Tests, docs to history; Alex runs gitpush Finish | this file and the spec, moved to `docs/history/` | none | done |

Seeding review dates and usage clues happens in chat after the deploy. It is not a CLI step.

**Estimate:** 12 steps, down from 13 because links took 1. Actionable reviews 3 (migration up to 2, tools and deploy 1); skill 3; clean-up 4 (prompt 2, links 1, dead code and test scripts 1); confirm and Finish 2.

**Actual:** 11 numbered steps (14 was not needed), one fewer than the estimate. But they took 17 tagged CLI prompts plus the chat test at Step 19: Step 15 took 5 (s15 to s15e: a plan-guard block, then the 198 number collision), Step 17 took 2 (a plan-guard block on the moved SQL), and Step 18 took 3 (the checkpoint, then the installed skill being ahead of the repo).

## Log

### Step 11: confirm and claim (2026-11-02, run tag `warren_buffet_p4-r6d-s11-p8d4`)
- Spec and this file written.
- Claimed 23 files and folders in one command, no refusals. No `db:` items.
- Not claimed, because `nightly_counts-f8k` holds them: `supabase/functions/mcp/index.ts`, `index.test.mjs`, `.claude/skills/overwatch/SKILL.md`.

### Step 12: prompt 2026-10-25a in the repo (2026-11-02, run tag `warren_buffet_p4-r6d-s12-x5h7`)
- The repo prompt now matches the live 2026-10-25a text, confirmed by a diff.
- **25a's only change from 23d:** `source_app: "warren_buffet"` on the Step 7 and Step 8 inbox items, plus the version.
- The progress edit was blocked at that step because its scope didn't list this file. Caught up in Step 13.

### Step 13: Money record links (2026-11-02, run tag `warren_buffet_p4-r6d-s13-f2wa`)
- **No database change:** `record_lookup_tables()` reads `platform.registry`, where every wb_ table is registered, so `resolve_record` already finds them.
- `RECORD_SCREENS` gains accounts, transactions, subscriptions, planned items and projects, each opening its own detail screen.
- **Rules and merchants stay on the generic record page:** the Money app has no screen for either, and this slice adds none. Step 14 was not needed.
- **Alex tested it:** all seven links behave as reported.

### Step 15, part 1: migration written, test script blocked (2026-11-02, run tag `warren_buffet_p4-r6d-s15-c9tj`)
- `supabase/migrations/_pending_warren_buffet_p4-r6d_subscription_reviews.sql` written. Not numbered, queued or run.
- **Test script not written:** the plan guard refused it because it names `contexts`, not declared under SQL. All 36 subscriptions sit in a shared context, which every signed-in user can read, so the other-household check needs a throwaway private context, and it reads the owner from `contexts`.
- The four `db:` items are free. None claimed.

### Step 15, part 1b: test script written (2026-11-02, run tag `warren_buffet_p4-r6d-s15b-r4nz`)
- `supabase/tests/warren_buffet_p4-r6d/1_subscription_reviews_tests.sql` written. Not run or queued.
- Alex accepted the migration's choices: cancel leaves `review_date` alone, the extra table rules, same-day reviews with the newest counting, and the owner and context copied by trigger.

### Step 15, part 2: numbered 198 and queued (2026-11-02, run tag `warren_buffet_p4-r6d-s15c-h3ku`)
- **Drift check after gitsync: none.** 197 touches only `overwatch_watch` and `overwatch_nightly_counts`. The snapshot diff has no wb_ or contexts lines.
- **Claimed:** `db:table:wb_subscriptions`, `db:table:wb_subscription_reviews`, `db:table:wb_subscription_overview`, `db:fn:wb_record_subscription_review`, and the numbered file.
- `supabase/migrations/198_wb_subscription_reviews.sql` differs from the pending file only in its path line. The pending file is deleted.
- **Queued, not applied:** action id `eda5a711-0c02-4460-a91e-42c93e874ea5`.

### Step 15, part 3: applied, renumbered 199 (2026-11-03, run tags `warren_buffet_p4-r6d-s15d-w8ve`, `warren_buffet_p4-r6d-s15e-j6pb`)
- **Applied Nov 3:** switchboard run `c4f317cb-8d51-4fde-b300-6c83e9d35926`, all 35 statements ok. `wb_subscription_reviews` registered with policy none, audited, granted authenticated and service_role, anon stripped.
- **Conformance:** "CONFORMANT — all 102 non-exempt public tables satisfy platform contract v1, and anon reaches nothing undecided."
- **Renumbered 198 to 199:** nightly_counts-f8k's `198_nightly_counts_stopped_rule.sql` landed on main in its Nov 2 checkpoint, after this worktree's sync. The file now reads "Applied: yes" with the run id. Nothing else changed, and the SQL needs no re-run. The 198 file is deleted.
- **Lesson:** checkpoint soon after a migration is applied. Numbering after a sync doesn't stop a later collision from another thread that checkpoints first.

### Step 15, part 4: test passed, checkpointed (2026-11-03)
- **Test:** switchboard run `0ba2f48f-0482-4ed5-808d-66332f8d2332`, all 28 checks passed, failed `[]`.
- **Checkpoint:** Alex put 199 and `supabase/tests/warren_buffet_p4-r6d/` into main (cfec4a1). It regenerated the schema snapshot through 199 and released all four `db:` items.

### Step 16: tools and the mcp deploy (2026-11-03, run tag `warren_buffet_p4-r6d-s16-t3mx`)
- **Drift check after gitsync (baba0dc..cfec4a1): none.** nightly_counts-f8k's changes to `mcp/index.ts` and `index.test.mjs` add `get_overwatch_nightly_counts` and an `intent_id` on the watch tools; nothing touches wb_ tools or subscription tables. `.claude/CLAUDE.md` now says `scripts/` and `.claude/hooks/` are shims for the installed Switchboard. The rules are unchanged; `claims.mjs` works and shows this thread's claims.
- **New `record_wb_subscription_review`** (tier 2, `warren-buffet-p4.ts`). It calls `wb_record_subscription_review` and returns the review and the subscription's new review date. The database's refusals pass through as they are.
- **`get_wb_subscriptions`** returns `usage_clues`, `last_reviewed_on` and `last_verdict`. `include_reviews` adds up to 10 reviews each, newest first. **`upsert_wb_subscription`** takes `usage_clues`. **`get_wb_transactions`** takes `subscription_id`.
- **Tests:** 119 of 119 pass across the three tool test files, `index.test.mjs` (now 188 tools, with a new Phase 4 schema check) and `tables.test.mjs`.
- **Deployed:** `mcp` is ACTIVE at version 193, from this worktree. The tool list needs a signed-in client, so it is Alex's test. `db:deploy` is held until Checkpoint.
- **Checkpointed** (8541ef6, merged aae5a6b); `db:deploy` released.
- **Alex's test, Nov 3, fresh chat:** `record_wb_subscription_review` is listed. `get_wb_subscriptions` showed `usage_clues`, `last_reviewed_on` and `last_verdict`, all null, on 3 active rows. A keep review with no next date was refused with "wb_record_subscription_review: a next review date is required unless the verdict is cancel. Nothing was changed. [22023]"; the review date and history were unchanged.
- **Gap, not fixed in this slice:** `get_wb_subscriptions` has no `ids` option. Logged in Alfred as a bug for the next wb tools deploy.

### Step 17: dead code removed, moves blocked (2026-11-03, run tag `warren_buffet_p4-r6d-s17-n5ka`)
- **Removed** `getFreeCash` and `getTrueCost` from `src/money/moneyApi.js`, and their two tests. Nothing else in `src/` or `supabase/` used them. moneyApi tests: 44/44 pass.
- **References to the five old paths, none changed:** each file's own path line; the "then run 13x/14x_..._tests.sql" lines in 133, 135, 137, 140 and 143; `docs/history/progress-warren_buffet_p3-q5k.md` (lines 53, 145, 199, 365, 413); `docs/history/progress-warren_buffet_p4-r6d.md` line 167. No script refers to them.
- **Moves blocked by the plan guard:** the copies name wb_ tables, and the scope's SQL line was none. Nothing was created or deleted.
- **The guard reads table names in any .sql file it writes, even one that is only moved and never run.** A step that moves SQL lists every table the files name.

### Step 17b: five test scripts moved (2026-11-03, run tag `warren_buffet_p4-r6d-s17b-q2fd`)
- 134, 136, 138, 141 and 144 are now `supabase/tests/warren_buffet_p3/` 7 to 11, in the same order. A diff of each against its original shows two changed lines: the path line, and "All SQL lives in supabase/migrations/" replaced by "Moved from supabase/migrations/<old name> on Nov 3 2026". The five originals are deleted.
- The old-path mentions in migrations 133, 135, 137, 140 and 143 and in `docs/history/` are left alone, as records of past work.

### Step 18: wb-money written, wb-planning trimmed (2026-11-03, run tag `warren_buffet_p4-r6d-s18-v7gc`)
- **New `.claude/skills/wb-money/SKILL.md`** (147 lines, version 2026-11-03): what happened and what to fix. Sections: 1 what needs my attention, 2 review queue and tagging, 3 rules, merchants and tags, 4 subscriptions, 5 subscription reviews, 6 setting review dates, 7 Amazon order items, 8 reports, 9 approving a weekly cleanup line, and what is left out on purpose.
- **`wb-planning`** (133 lines, version 2026-11-03): section 11 moved to wb-money; the description and a line under the title point to wb-money. Nothing else changed.
- **The overwatch hand-over line moved to Step 20.** `notification_routing-d7v` holds `.claude/skills/overwatch/SKILL.md`.
- **Step 18b, checkpointed** (2026-11-03, run tag `warren_buffet_p4-r6d-s18b-k8wr`): Alex put both skills into main (worktree c5d5f2e, main 21ce8e5). Both files on main match the worktree; their full text went to Alfred for the claude.ai skill update.
- **Step 18c, the installed wb-planning was ahead of the repo** (2026-11-03, run tag `warren_buffet_p4-r6d-s18c-h6tz`), as the weekly cleanup prompt was at Step 12. It held rules that had never been written back: due-but-unpaid repeating dates count on day 1, a paid one-off no longer counts as due, card purchases are planned on the charge day, and confirming a match clears the other suggestions. These are now in the repo copy, word for word. wb-money section 1 took the installed order (`below_floor` first), the null `first_below_on` rule and the refund-kind wording. Its description no longer has angle brackets, which claude.ai skill cards refuse. Both files are now version 2026-11-03b, and the repo holds both sets of rules.

### Step 19: fresh-thread test and one real review (2026-11-03)
- Claude offered both skills (2026-11-03b, main d4edd14) as skill cards, and Alex saved them.
- **"What needs my attention in money?"** loaded wb-money and led with the floor warning, then the flags and to-dos, with links.
- **A real review of a gym membership:** it read 24 charges and found two yearly price rises. It asked how use is counted and saved Alex's answer as `usage_clues`. Arnold covers only this week, so it used Alex's estimate. It worked out a cost per use and did a market check with named sources. Verdict keep, next review on 2027-04-15, before the usual yearly rise. It showed the table, then saved after Alex's OK.
- **Read back:** the review row, `usage_clues`, `review_date`, `last_reviewed_on` and `last_verdict` all match the table.
- **Gap:** the price rises showed in the charges but were missing from the price history (`price_count` 1). The chat offered to add them but didn't put them in the save table. Fixed in Step 20.

### Step 20: skill fixes (2026-11-03, run tag `warren_buffet_p4-r6d-s20-p4yb`)
- **wb-money 5a and 5f:** price changes the charges show but the history lacks are proposed as `record_wb_subscription_price` calls, using the charge's `transaction_id`, in the same save table as the review.
- **wb-planning section 1:** the double-counting example names "an accounting app", not a product.
- Both skills are now version 2026-11-03c.
- **The overwatch line is not done:** `notification_routing-d7v` still holds `.claude/skills/overwatch/SKILL.md`. It moves to Step 21.
- **Yielded to notification_routing-d7v:** `supabase/functions/mcp/index.ts` and `index.test.mjs`, both unchanged from main since the Step 16 checkpoint.

### Step 21: weekly cleanup prompt 2026-11-03a (2026-11-03, run tag `warren_buffet_p4-r6d-s21-z9mc`)
- **Reviews are actionable.** Step 3.4 also keeps `previous_price`, `last_change_on`, `last_reviewed_on`, `last_verdict` and `no_review_date_count`. A week is not quiet while any active subscription has no review date. REVIEWS DUE lines show the price change and the last review, and offer "review <name>" in chat in place of the `review_date` call, as does the TO DO `subscription_review` row. A count line covers subscriptions with no review date, and Step 8 records `no_review_date_count`. A review date now moves only through a review.
- **The version is 2026-11-03a** in the header, the setup check, the prompt line, Step 8 and Step 9.
- **Not in main yet:** main still has 2026-10-23d. Step 12's 25a was never checkpointed, so the checkpoint carries both changes.
- **The overwatch line is not done:** `notification_routing-d7v` still holds the file. It leaves this slice and goes to that project or a later one.
- **Done:** prompt 2026-11-03a written, and Claude reviewed the diff. **After gitpush Finish,** Claude updates the "Money cleanup" scheduled task and checks its PROMPT VERSION.

### Step 22: tests, docs to history (2026-11-03, run tag `warren_buffet_p4-r6d-s22-c3ln`)
- **Tests, all pass:** `src/records` and `src/money` 223/223 (18 suites); the three warren-buffet tool test files with `mcp/index.test.mjs` and `tables.test.mjs` 119/119; `scripts/lib/*.test.mjs` 54/54.
- **The overwatch hand-over line left this slice:** `notification_routing-d7v` held the file. It's in Alfred as follow-up `14f95ae1-8f48-4e04-91cd-a33c183c8605`.
- The spec is marked finished, and both docs are moved to `docs/history/`.

## Open follow-ups
- `get_wb_subscriptions` has no `ids` option (Alfred `18959f50-7812-49f4-87ee-baa184cbe39e`).
- 26 more active subscriptions need review dates and usage clues, to set in chat ("set review dates").
- The two older prices of the reviewed gym membership aren't in its price history yet.
- The migration-number collision bug (Alfred `7a15ee32-e968-466d-9e99-e9b599a5ceae`).
- The overwatch hand-over line (Alfred `14f95ae1-8f48-4e04-91cd-a33c183c8605`).
- After Finish: Claude updates the "Money cleanup" task to 2026-11-03a and checks its PROMPT VERSION.

## Lessons
- **Installed skills and task prompts can be ahead of the repo.** Compare before replacing: the weekly prompt at Step 12 and wb-planning at Step 18c both held rules the repo lacked.
- **Checkpoint soon after a migration is applied.** Numbering after a sync doesn't stop a later collision from a thread that checkpoints first (198 at Step 15).
- **List every table named in any .sql file written,** even one that is only moved and never run. The plan guard reads them all (Steps 15 and 17).

## Timing log

| Step | Run tag | Phase | Start | End | Duration |
|---|---|---|---|---|---|
| 11 | s11-p8d4 | Claim, spec, progress | 13:44:23 | 13:45:04 | 0:41 |
| 12 | s12-x5h7 | Diff, edits, check, blocked progress edit | 13:48:24 | 13:49:02 | 0:38 |
| 13 | s13-f2wa | Reading, writing, tests | 13:50:25 | 13:51:41 | 1:16 |
| 15 | s15-c9tj | Reading, migration, blocked test script | 14:01:34 | 14:03:58 | 2:24 |
| 15 | s15b-r4nz | Test script | 14:18:42 | 14:18:44 | 0:02 |
| 15 | s15c-h3ku | Drift check, claim, number, queue | 14:26:03 | 14:27:02 | 0:59 |
| 15 | s15d-w8ve | Number check, stopped on 198 | 13:04:12 | 13:04:24 | 0:12 |
| 15 | s15e-j6pb | Number check, claim, rename, log, queue | 13:12:19 | 13:13:30 | 1:11 |
| 16 | s16-t3mx | Drift check, tools, tests, deploy, log | 13:27:59 | 13:34:55 | 6:56 |
| 17 | s17-n5ka | Checks, dead code, tests, blocked moves, log | 14:01:45 | 14:03:54 | 2:09 |
| 17b | s17b-q2fd | Copy, diff, delete, log | 14:06:29 | 14:11:02 | 4:33 |
| 18 | s18-v7gc | Reading, both skills, log | 14:12:54 | 14:14:18 | 1:24 |
| 18b | s18b-k8wr | Compare with main, log, report | 14:18:50 | 14:19:08 | 0:18 |
| 18c | s18c-h6tz | Fold in installed rules, diff, log | 14:23:58 | 14:24:21 | 0:23 |
| 20 | s20-p4yb | Claims, yields, skill fixes, log | 14:44:05 | 14:44:49 | 0:44 |
| 21 | s21-z9mc | Claim check, prompt edits, diff, log | 14:50:58 | 14:52:09 | 1:11 |
| 22 | s22-c3ln | Tests, final log, move to history | 14:55:46 | 14:58:20 | 2:34 |
