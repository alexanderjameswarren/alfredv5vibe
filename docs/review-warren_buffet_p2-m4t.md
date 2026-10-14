# Warren Buffet Phase 2: Review

Project code: `warren_buffet_p2-m4t`. Step 9 of `docs/technical-spec-warren_buffet_p2-m4t.md`.
Drafted 2026-10-14 by the CLI; corrected and decided by Alex the same day (§7).
Sources: the spec, `docs/progress-warren_buffet_p2-m4t.md`, migrations 103–132, and the run log.
There are no amounts in this document.

**"(reported)"** marks a figure that comes from Alex's reports of live runs or checks, not from code,
migrations or test output the CLI ran itself.

---

## 1. Promised versus built

The spec's purpose (§1) had five parts: clean, pair transfers, tag on splits, rules, and
subscriptions. All five are built and live.

| step | spec promised | built | verified |
|---|---|---|---|
| 1 | Read-only plan and conflicts | Done. Fixes 4a–4f and 9.1–9.9 written into the spec. | Alex approved, 2026-10-09 |
| 2 | Migration A: merchants, tags, splits, rules, triggers, processing function, three views | 103, as specified; 104 tests | 104 69/69, later 85/85 (reported); CONFORMANT, 58 tables (reported) |
| 3 | wb-sync calls processing; one-time reprocess; check pairs and kinds | wb-sync v5; 105 reprocess; 107 fixes cleaning and payments to people | 394/394 processed, 16 genuine pairs, 0 candidates (reported) |
| 4 | Phase 2 MCP tools except subscriptions and rule health; "Always do this" (§6.1) | 18 tools plus the `get_wb_transactions` extension; 108; mcp v145, then v146 | Fresh chat 10/10, plus the plain split refusal (reported) |
| 5 | Starter taxonomy in claude.ai | Taxonomy, merchants and rules | Review queue at 0 (reported) |
| 5 (added) | — | Tag exclusions: a tag removed by hand stays removed (114, 115) | 115 13/13 (reported); real check on bcc82c61 (reported) |
| 6 | UI: Transactions, detail with "Always do this", Review, Spending | 117 and 118 (fix as SQL functions, plus notes), three tabs and the detail screen, mcp v147 | 26/26 steps on desktop, phone window, real phone, and as Elise (reported) |
| 7 | Migration B + tools: subscriptions, prices, monthly detection | 120–123; wb-sync v6 detects; three tools on mcp v148; Review tab subscription actions | 121 39/39, 123 15/15 (reported); 19 detected, 57 linked (reported) |
| 8 | Seeding in claude.ai, then the Subscriptions tab | Seeding done. 8a: intervals and hand unlink (124, 125, mcp v150). 8b: Subscriptions screen with breakdown | 35 active subscriptions (reported); UI steps passed on desktop, phone window and real phone (reported) |
| 10 | Rule health view and tool; weekly cleanup task; bulk create | 127–132; mcp v152, then v153 (121 tools); weekly task "Money cleanup" | 128 17/17, 130 17/17, 132 19/19 (reported); fresh chat on v153 (reported); first manual run ok (reported) |
| 9 | This review and the Phase 3 steps | This document | Alex, 2026-10-14 |

**Not built from the spec:** nothing in Phase 2 scope was dropped.

**Built beyond the spec:**
- tag exclusions;
- transaction notes;
- subscription billing intervals;
- hand links and unlinks for charges;
- acknowledging rule-health findings;
- the monthly-equivalent breakdown;
- `not_subscription` on merchants;
- "Keep watching".

The last two were not in the spec or in the Step 7 plan. They came out of 7d testing (dismissing a
detection, keeping one under watch).

---

## 2. Deviations and decisions, and why

**Step 1 approvals (2026-10-09)**
- `wb_process_transactions` is security invoker, so there is one implementation, RLS still applies, and audit attribution is kept.
- Exclusivity uses `group_id` and `group_exclusive` copied onto split tags.
- The split sum is a deferred check. A single split follows the amount; a multi-split row shows as `split_mismatch`.
- `wb_transactions` stays unaudited.
- Pairing and tagging touch posted rows only.
- `fee` counts as spending in both views.
- SQL tests were chosen over a TypeScript mirror of the logic.

**Step 3**
- Payments to people (Venmo and Zelle style) were being treated as transfer candidates. 107 added a payment-to-person phrase check: such a payment pairs only on a unique household match, and is otherwise spend or income.
- Cleaning was widened at the same time.
- Accepted leftover: some fund descriptions keep a trailing lot number.

**Step 4**
- The plan said 17 tools; it was 18, a miscount.
- v146 maps every known database refusal to a plain sentence, after a raw error leaked amounts.
- Accepted at the time, fixed in Step 5: a hand removal of a rule tag came back on reprocess.

**Step 5 follow-up**
- Tag exclusions (114): a new audited table, written when a tag is removed by hand and cleared when it is added back.
- Removing a required Category stays allowed; the transaction returns to the review queue.

**Step 6**
- A: "Always do this" became SQL functions (`wb_fix_plan`, `wb_apply_fix`), so the MCP tool is a thin wrapper and the app and the tool share one implementation.
- B: `notes` was added to transactions.
- C and D: the Review actions as planned, and verification across devices and as Elise.

**Step 7**
- D1: `not_subscription` on merchants, so a dismissal sticks.
- D2: `subscription_source`, so hand links are never overwritten.
- D3: exact cents plus a per-subscription tolerance.
- D4: missing charges live in `wb_subscription_overview`, not the review queue.
- D5: detection runs in wb-sync, not in processing. It needs 3 or more charges 26–35 days apart, each within 10% of their median.
- D6: the Review tab actions were part of Step 7.
- Added during the step:
  - helpers `wb_subscription_price_on` and `wb_refresh_subscriptions`;
  - price source `claude`;
  - the old-price rule for seeding.
- **"Keep watching" (122):** the first build kept the row in the queue, because `new_recurring` ignored reviewed. 122 skips a reviewed newest charge, so the next charge brings the row back.

**Step 8**
- Seeding found two gaps:
  - no way to say "every 2 months" or "every 2 weeks", fixed with billing intervals (124);
  - one-off charges linked to standing subscriptions, fixed with the hand-unlink tool `set_wb_transaction_subscription`.
- 8b decisions D1–D5:
  - the monthly equivalent counts active rows only;
  - the link picker shows the merchant's last 180 days, plus search;
  - Confirm and dismiss also appear on the Subscriptions screen;
  - the review-soon badge shows at 30 days;
  - Elise edits everything.
- Grouping covers every status, with Cancelled collapsed, which differs from spec §7.5; the spec was updated.
- The breakdown table was added after verification. Rows are rounded to the cent first, so they sum exactly.

**Step 10**
- Run before Step 9, so that the review closes the phase.
- **Findings** (C1): Alex's four, plus the spec's `rule_missing` and `merchant_no_category`. The spec's `one_hit_rule` was dropped.
- **too_broad** is measured per merchant, because rules match on one merchant each. Payees are normalized before counting: cut at "*", digits removed.
- **Thresholds:** often_overridden needs 2 or more overrides and at least 25% of hits; never_fires waits 14 days.
- **Bulk create** is tier 3, and its proposal is the dry run (C2).
- **After v152:**
  - the counts moved into the payload, because `meta` never reached Claude;
  - dry-run ids are null;
  - acknowledgements were added (131, 132).
- **Weekly task:** Sunday 18:00 Pacific, with overdue subscriptions and reviews due in the same item, and nothing filed on a quiet week.
- **First run's miss:** `manual` was not recorded. Fixed in prompt 2026-10-14a.

**Process slips, for the record**
- The CLI missed the §4.9 and §6 spec updates approved under C1 and C2 until the Step 10 follow-up.
- A `git fetch origin main` was run once to check main. It changes only the remote-tracking ref, and it was reported at the time.

---

## 3. Migrations 103–132 and deploys

| # | what | kind | result |
|---|---|---|---|
| 103 | Phase 2 tables, triggers, helpers, processing, views | schema | applied 2026-10-09; CONFORMANT, 58 tables (reported) |
| 104 | Phase 2 checks | read-only tests | 69, then 85/85 after 107 (reported) |
| 105 | One-time reprocess of all rows | data | 394/394, run twice (reported) |
| 106 | Step 3 verification | read-only | unprocessed 0, 16 pairs (reported) |
| 107 | Cleaning and payment-to-person fix | schema | applied 2026-10-09 |
| 108 | Tool support: list view, invoker write functions | schema | applied 2026-10-10 |
| 109 | Step 4 verification | read-only | 10/10 (reported) |
| 110 | Removes the Step 4 test rule and tag | data | applied |
| 114 | Tag exclusions | schema | applied 2026-10-11 |
| 115 | Tag-exclusion tests | rolled-back tests | 13/13 (reported) |
| 117 | "Always do this" functions, transaction notes | schema | applied; CONFORMANT, 60 tables (reported) |
| 118 | Step 6 tests | rolled-back tests | 24/24 (reported) |
| 120 | Subscriptions, prices, detection, links, overview | schema | applied 2026-10-12 |
| 121 | Step 7 tests | rolled-back tests | 39/39 (reported) |
| 122 | "Keep watching" (`wb_…_step7d_keep_watching`) | schema | applied 2026-10-12 |
| 123 | Step 7d tests | rolled-back tests | 15/15 (reported) |
| 124 | Billing intervals, backfill | schema | applied 2026-10-13 |
| 125 | Step 8a tests | rolled-back tests | 22/22 (reported) |
| 127 | `wb_rule_health` | schema | applied 2026-10-13 |
| 128 | Rule-health tests | rolled-back tests | 17/17 (reported) |
| 129 | `wb_bulk_create` | schema | applied 2026-10-13 |
| 130 | Bulk-create tests | rolled-back tests | 17/17 (reported) |
| 131 | Acknowledgements; null dry-run ids | schema | applied 2026-10-14; **CONFORMANT, 63 tables: confirmed** (claude.ai ran `check_platform_conformance` on 2026-10-14: "all 63 non-exempt public tables") |
| 132 | Acknowledgement tests | rolled-back tests | 19/19 (reported) |

Every rolled-back test file also passed in PGlite before it was handed over. Those PGlite counts are
the CLI's own test output; the Supabase counts in the table are reported.

111–113, 116, 119, the other 122 (`restructure_p3_clips_registry_note`) and 126 belong to other
threads. **There are two files numbered 122**; this is logged as an Alfred bug, and both are
applied and independent.

**Deploys**

| function | version | step | what |
|---|---|---|---|
| wb-sync | v5 | 3 | Processing after each upsert |
| wb-sync | v6 | 7b | Subscription detection after processing |
| mcp | v145 | 4 | 18 Phase 2 tools |
| mcp | v146 | 4 | Plain-sentence database refusals |
| mcp | v147 | 6c | Fix wrapper, `excluded_tags`, manual-removal wording |
| mcp | v148 | 7c | Subscription tools, after the Supabase incident cleared |
| mcp | v150 | 8a | Intervals, hand unlink. v149 was restructure_p3: **inferred** from the version gap and commit timing, not from a deploy log |
| mcp | v152 | 10c | Rule health, bulk create. v151 was restructure_p4: **inferred** from the version gap and commit timing, not from a deploy log |
| mcp | v153 | 10 follow-up | Payload fix, null dry-run ids, acknowledge tool (121 tools) |

---

## 4. Open items, known bugs, Alfred bugs

**Open**
- Elise's current 401(k) balance (from Phase 1).
- Paste weekly-task prompt **2026-10-14a** into the scheduled task. The task still runs 2026-10-13b, which does not record `manual`.
- Quill Health is a real often_overridden finding (Mounjaro), still to fix or acknowledge.
- §9 of the spec: some code comments still cite the Phase 1 spec at its old path.

**Known limits, accepted**
- too_broad judges merchants. A rule that matches on text alone is judged only by never_fires and often_overridden.
- Payee normalization can merge two payees that differ only in digits, or after a "*".
- Detection needs about **two months** of history, because three charges 26–35 days apart can fit in about 52 days. It finds monthly patterns only; annual subscriptions come from seeding.
- Some investment descriptions keep a trailing lot number. Investment rows are not categorized.
- `deno check` on mcp reports 97 errors. Each step checked that none are in its own files; the 97 were not audited.

**Alfred and tooling bugs logged or seen**
- The duplicate migration number 122 (logged by Alex).
- The guard bug for chat prompts with run tags (Alfred item ce6c2190, from Phase 1).
- Two app tests fail on certain dates because they look for today's date: `PreviousExecutions.test.jsx` and `StatusEventsSheet.test.jsx` (Alfred item 49958c85, not ours).
- The claims guard misparses paths containing spaces, in rm and in gitpush `--paths`. This came up with the "(1)" files.
- `deno check` leaves `deno.lock` files behind; they were deleted each time.
- `src/sam/SamPlayer.plan.test.jsx` failed once under full-suite load, and passed alone and on a rerun.
- A Supabase "Edge Function Degradation" incident blocked one deploy on 2026-10-12. It was retried after the incident.

---

## 5. Tests: counts and gaps

| suite | count (latest) |
|---|---|
| SQL on Supabase | 104 85, 115 13, 118 24, 121 39, 123 15, 125 22, 128 17, 130 17, 132 19: 251 checks (reported); the same files passed in PGlite (CLI output) |
| Functions (`node --test`) | 708/708 (CLI output) |
| CLI (`scripts/lib`) | 224/224 (CLI output) |
| App (react-scripts) | 2465/2465 (reported here as last run at the Step 8 sync; no `src/` change since) |

**Gaps**
- **RLS for a second user.** PGlite runs as one superuser with a stubbed `register_table`, so the policies are checked by shape (104), not exercised as Elise. Elise's access was verified by hand once, in 6b (reported).
- **wb-sync `index.ts`.** Only `wb-sync-core.ts` has unit tests. The sync was verified by real runs (v5, v6; reported).
- **The UI** is tested against a mocked Supabase. The real paths were verified by hand (reported).
- **The weekly task prompt** has no automated test. It was verified by one manual run (reported).
- **Detection thresholds** (26–35 days, 10%, 120 days) are tested on invented data only. Their fit to real data is judged by the 19 detected (reported).
- **Performance:** none. The views recompute on every read, which is fine at today's size (hundreds of rows) and untested at tens of thousands.

---

## 6. Stale claims this thread holds

67 file claims as of 2026-10-14, which the gitpush **Finish** will release. Notable ones:

- **`_pending_` paths that no longer exist:**
  - phase2_tables, phase2_tests, reprocess_all, verify_step3, cleaning_p2p_fix;
  - step4_tool_support, verify_step4, tag_exclusions and its tests;
  - step6 (both), step7 (both), step7d (both), step8 (both);
  - step10 rule_health, bulk_create (both pairs) and acks (both).
- **`supabase/functions/wb-sync/deno.lock`:** a lock file that was deleted.
- **`docs/technical-spec-warren_buffet-w7b.md`, `docs/progress-warren_buffet-w7b.md` and `docs/technical-spec-warren_buffet-w7b (1).md`:** paths from before the Phase 1 docs moved to `docs/history/`.
- **Shared files other threads may want:**
  - `supabase/functions/mcp/index.ts` and `index.test.mjs`;
  - `src/money/`;
  - `src/viewPaths.js` and its test;
  - `_shared/tools/warren-buffet.ts` and its test.
- **Every numbered migration 103–132 of this project.**
- **No `db:` claims are held.**

---

## 7. Phase 3 decisions (Alex, 2026-10-14)

Phase 3, from the Phase 1 spec, covers:
- projects;
- planned items: future money in or out, with stages draft, estimate, quoted, invoiced, paid, cancelled;
- planned matches: planned items linked to the splits that paid them;
- settings;
- views for cash flow, burn rate and free cash.

1. **Starting projects.** Which projects to seed first.
   **Decision:** seeded in claude.ai, as Step 5 did for tags:
   - Bathroom insurance claim;
   - Bathroom Remodel Design;
   - Backyard renovation;
   - "Meditation Room, Master Bedroom, Alex's Office Design" (one project);
   - Vacation.

   "Design" stays in the names because they are working with a designer.
2. **How charges join a project.** A project link on splits, a tag group, or planned matches only.
   **Decision:** a nullable `project_id` on `wb_splits`, set by hand or by a rule. Planned matches stay for "this payment settles that planned item".
3. **Subscriptions and planned items.** Stored rows or computed.
   **Decision:** subscription outflows are computed in a view from the next expected date, the interval and the current price, and are never stored as planned items.
   - Included: every active subscription, annual ones too.
   - Excluded: watching, paused, and dates inside a prepaid term.
4. **Insurance premiums.** They are not subscriptions, and policies arrive in Phase 4.
   **Decision:** recurring planned items (interval count + unit) until Phase 4 links them to policies.
5. **Expected inflows.** Royalties, interest, paychecks.
   **Decision:** recurring planned income items. Variable income (royalties) is counted at a cautious estimate, with stage "estimate" until paid.
6. **Matching planned items to payments.** Automatic or confirmed.
   **Decision:** processing suggests matches (merchant + amount within tolerance + date window). They are confirmed in the review queue under a new reason, `planned_match`.
   - Each is shown as a card clearly labelled as the app's suggestion, with the planned item beside the payment and Confirm / Not this one buttons, like the inbox.
   - Partial payments are allowed.
7. **Free cash.** What counts, over what horizon.
   **Decision:** free cash = the lowest projected spending-cash balance over the next 12 months, projected day by day, minus the safety floor.
   - Spendable = accounts with role `spending_cash` only. The CNB reserve account is excluded and shown on its own line.
   - The projection includes:
     - income on its dates;
     - subscriptions (decision 3);
     - planned and project items on their due dates;
     - everyday spending at the burn rate.
   - The floor value is set by Alex in `wb_settings` during seeding (not recorded here). The horizon and the floor live in `wb_settings`.

   A second line, **"monthly true cost"** = burn rate + subscriptions normalized to a month + recurring planned outflows spread evenly over 12 months, shown against expected monthly income. Large annual bills (property tax, premiums) therefore appear both on their dates in the projection and amortized in this line.
8. **Burn rate.** How it is measured.
   **Decision:** the median of the last 3 full months of spend + refund + fee, shown with the mean. It excludes project-linked splits **and** splits matched to a planned item, so big bills (e.g. property tax) leave the burn rate once matched.
9. **Draft ("what if") items.** Whether they count.
   **Decision:** drafts stay out of free cash unless a scenario toggle in the UI includes them.
10. **Where it shows.** Tabs and summaries.
    **Decision:**
    - a Money "Plan" tab (projects, planned items, matches);
    - free cash and monthly true cost on Overview;
    - weekly cleanup gains a section for planned items overdue or unmatched.
11. **Order of phases.** Phase 3 or 3b (orders) first.
    **Decision:** Phase 3 before 3b. Correction to the draft: there is no separate Amazon export from Elise; the one export Alex already made is the 3b input.
12. **Tax year.** Splits already carry a nullable `tax_year`.
    **Decision:** planned items get a nullable `tax_year`.
13. **Help text.** How a rule-driven number explains itself.
    **Decision:**
    - **The "?" button.** Every Money section that shows a rule-driven number, status or finding gets a "?" button. Tapping it opens a short panel (a bottom sheet on mobile) with the same four headings every time:
      - What this is;
      - What's included;
      - What's left out;
      - What to do.
    - **One file.** All help wording lives in one file (proposed `src/money/helpText.js`, name to be settled), keyed by section. A test fails if a component renders a "?" for a key with no entry, or if an entry has an empty heading.
    - **Live working.** Where it helps, the panel shows the live working, not just the rule. Example: burn rate lists the three months it used and names what it excluded (e.g. "property tax, matched to its planned item").
    - **Same step as the feature.** Help ships in the same step as the feature it explains, and is never deferred to a later phase. If a step cannot explain plainly what a number includes and excludes, the rule is not settled yet.

**Also decided:** a future one-off cost (e.g. a new roof) is just a planned item with a date and amount. A project is optional, for grouping several payments.

---

## 8. Phase 3 step outline (proposed)

This is an outline for the Phase 3 project's own spec, not that spec. Steps run one at a time and
end with verification. Database claims are taken just in time, and migrations are numbered after
gitsync.

| step | what | db: claims | deploy |
|---|---|---|---|
| 1 | Read-only plan: confirm this outline against the live schema; spec conflicts; migration number; claims check. | none | no |
| 2 | **Migration C, schema.**<br>Tables: `wb_projects`, `wb_planned_items` (with interval count + unit for recurring items, stage, `tax_year`), `wb_planned_matches` (partial amounts) and `wb_settings`.<br>Also `wb_splits.project_id`.<br>All registered with `register_table`, with intents-style RLS and audit; conformance must be CONFORMANT.<br>Rolled-back SQL tests. | `db:table:wb_projects`, `db:table:wb_planned_items`, `db:table:wb_planned_matches`, `db:table:wb_settings`, `db:table:wb_splits` | no (migration only) |
| 3 | **Help text for Phase 2 screens** (decision 13).<br>Builds the shared "?" component (a bottom sheet on mobile, with the four fixed headings) and the help file (proposed `src/money/helpText.js`), plus the test that fails on a missing key or an empty heading.<br>Entries for:<br>• the review-queue reasons: no_kind, missing_required_tag, transfer_candidate, split_mismatch, price_change, new_recurring, and later planned_match;<br>• the rule-health findings: never_fires, too_broad, often_overridden, duplicate_rules, rule_missing, merchant_no_category;<br>• the subscription statuses (watching, active, paused, cancelled) and the Keep watching button;<br>• the monthly subscription breakdown;<br>• Always do this.<br>UI only. | none | no (Vercel on merge) |
| 4 | **Processing and match suggestions.**<br>Rules can set `project_id`, and a suggestion function proposes planned matches (merchant + amount within tolerance + date window).<br>The review queue gains `planned_match`, and its help entry is written here. `wb_transaction_list.needs_review` stays in step.<br>Tests. | `db:fn:wb_process_transactions`, `db:fn:wb_suggest_planned_matches` (name to be settled), `db:table:wb_rules`, `db:table:wb_review_queue`, `db:table:wb_transaction_list` | wb-sync only if suggestion runs in the sync (decide in step 1) |
| 5 | **Views.**<br>Subscription outflows (decision 3).<br>The day-by-day 12-month spending-cash projection and free cash (decision 7).<br>Burn rate, with its exclusions (decision 8).<br>Monthly true cost against expected monthly income.<br>Drafts kept out unless a scenario flag is passed.<br>Tests with invented data.<br>**Done when:** there is help text for every new number or section in this step (free cash, monthly true cost, burn rate, spendable cash, the CNB reserve line, the safety floor). The views also expose the live working the panels show: the months used, and what was excluded and why. | `db:table:wb_subscription_outflows`, `db:table:wb_cash_projection`, `db:table:wb_burn_rate`, `db:table:wb_true_cost` (names to be settled) | no |
| 6 | **MCP tools.**<br>Projects, planned items (create/update; recurring), planned matches (confirm, reject, partial), settings (floor, horizon), and reads for free cash, true cost and the projection.<br>Plain-sentence errors, schema-versus-handler tests, and a tool-count update. | `db:deploy` | **mcp** |
| 7 | **Seeding in claude.ai.**<br>The five projects (decision 1), recurring premiums and inflows, known one-offs, and the safety floor and horizon in `wb_settings` (Alex sets the floor).<br>Then confirm the first match suggestions. | none (data through tools) | no |
| 8 | **Plan tab UI.**<br>Projects, planned items, matches.<br>The `planned_match` review card, labelled as the app's suggestion, with Confirm / Not this one.<br>Phone width, RLS, plain errors.<br>**Done when:** there is help text for every new number or section in this step (planned item stages, the planned_match card). | none (UI under RLS) | no (Vercel on merge) |
| 9 | **Overview numbers:** free cash with its lowest-point date, the reserve on its own line, monthly true cost against income, and the scenario toggle for drafts.<br>**Done when:** there is help text for every new number or section in this step (free cash, monthly true cost, burn rate, spendable cash, the CNB reserve line, the safety floor, the what-if toggle), each panel showing its live working. | none | no (Vercel on merge) |
| 10 | **Weekly cleanup prompt update:** a section for planned items overdue or unmatched; bump the prompt version; Alex pastes it into the task. | none | no |
| 11 | **Phase 3 review**, as this document did for Phase 2. | none | no |

Notes for the Phase 3 spec:
- Matching suggestions may run in processing (per transaction) or as a set-level pass after the sync, like detection. Step 1 decides.
- The projection's daily granularity over 12 months is about 365 rows a call. It can be a set-returning function rather than a view if that reads better. Step 1 decides.
