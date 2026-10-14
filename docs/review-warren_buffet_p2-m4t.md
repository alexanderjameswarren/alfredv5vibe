# Warren Buffet Phase 2: Review (DRAFT)

Project code: `warren_buffet_p2-m4t`. Step 9 of `docs/technical-spec-warren_buffet_p2-m4t.md`.
Drafted 2026-10-14 by the CLI. **This is a draft for Alex to correct; it decides nothing.**
Sources: the spec, `docs/progress-warren_buffet_p2-m4t.md`, migrations 103–132, and the run log.
There are no amounts in this document.

---

## 1. Promised versus built

The spec's purpose (§1) had five parts: clean, pair transfers, tag on splits, rules, and
subscriptions. All five are built and live.

| step | spec promised | built | verified |
|---|---|---|---|
| 1 | Read-only plan and conflicts | Done. Fixes 4a–4f and 9.1–9.9 written into the spec. | Alex approved, 2026-10-09 |
| 2 | Migration A: merchants, tags, splits, rules, triggers, processing function, three views | 103, as specified; 104 tests | 104 69/69 (later 85/85); CONFORMANT, 58 tables |
| 3 | wb-sync calls processing; one-time reprocess; check pairs and kinds | wb-sync v5; 105 reprocess; 107 fixes cleaning and payments to people | 394/394 processed; 16 genuine pairs, 0 candidates |
| 4 | Phase 2 MCP tools except subscriptions and rule health; "Always do this" (§6.1) | 18 tools plus the `get_wb_transactions` extension; 108; mcp v145, then v146 | Fresh chat 10/10, plus the plain split refusal |
| 5 | Starter taxonomy in claude.ai | Taxonomy, merchants and rules; review queue at 0 | Alex, 2026-10-11 |
| 5 (added) | — | Tag exclusions: a tag removed by hand stays removed (114, 115) | 115 13/13; real check on bcc82c61 |
| 6 | UI: Transactions, detail with "Always do this", Review, Spending | 117 and 118 (fix as SQL functions, plus notes), three tabs and the detail screen, mcp v147 | 26/26 steps on desktop, phone window, real phone, and as Elise |
| 7 | Migration B + tools: subscriptions, prices, monthly detection | 120–123; wb-sync v6 detects; three tools on mcp v148; Review tab subscription actions | 121 39/39, 123 15/15; 19 detected live |
| 8 | Seeding in claude.ai, then the Subscriptions tab | Seeding done (35 active). 8a: intervals and hand unlink (124, 125, mcp v150). 8b: Subscriptions screen with breakdown | Alex, 2026-10-13, desktop, phone window and real phone |
| 10 | Rule health view and tool; weekly cleanup task; bulk create | 127–132; mcp v152, then v153 (121 tools); weekly task "Money cleanup" | 128 17/17, 130 17/17, 132 19/19; fresh chat on v153; first manual run ok |
| 9 | This review and the Phase 3 steps | This draft | Pending |

**Not built from the spec:** nothing in Phase 2 scope was dropped.

**Built beyond the spec:**
- tag exclusions;
- transaction notes;
- subscription intervals;
- hand links and unlinks for charges;
- acknowledging rule-health findings;
- the monthly-equivalent breakdown;
- `not_subscription` on merchants;
- "Keep watching".

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
- **Findings** (C1): your four, plus the spec's `rule_missing` and `merchant_no_category`. The spec's `one_hit_rule` was dropped.
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
| 103 | Phase 2 tables, triggers, helpers, processing, views | schema | applied 2026-10-09; CONFORMANT, 58 tables |
| 104 | Phase 2 checks | read-only tests | 85/85 after 107 |
| 105 | One-time reprocess of all rows | data | 394/394 (run twice) |
| 106 | Step 3 verification | read-only | unprocessed 0, 16 pairs |
| 107 | Cleaning and payment-to-person fix | schema | applied 2026-10-09 |
| 108 | Tool support: list view, invoker write functions | schema | applied 2026-10-10 |
| 109 | Step 4 verification | read-only | 10/10 |
| 110 | Removes the Step 4 test rule and tag | data | applied |
| 114 | Tag exclusions | schema | applied 2026-10-11 |
| 115 | Tag-exclusion tests | rolled-back tests | 13/13 |
| 117 | "Always do this" functions, transaction notes | schema | applied; CONFORMANT, 60 tables |
| 118 | Step 6 tests | rolled-back tests | 24/24 |
| 120 | Subscriptions, prices, detection, links, overview | schema | applied 2026-10-12 |
| 121 | Step 7 tests | rolled-back tests | 39/39 |
| 122 | "Keep watching" (`wb_…_step7d_keep_watching`) | schema | applied 2026-10-12 |
| 123 | Step 7d tests | rolled-back tests | 15/15 |
| 124 | Billing intervals, backfill | schema | applied 2026-10-13 |
| 125 | Step 8a tests | rolled-back tests | 22/22 |
| 127 | `wb_rule_health` | schema | applied 2026-10-13 |
| 128 | Rule-health tests | rolled-back tests | 17/17 |
| 129 | `wb_bulk_create` | schema | applied 2026-10-13 |
| 130 | Bulk-create tests | rolled-back tests | 17/17 |
| 131 | Acknowledgements; null dry-run ids | schema | applied 2026-10-14; CONFORMANT, 63 tables |
| 132 | Acknowledgement tests | rolled-back tests | 19/19 |

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
| mcp | v150 | 8a | Intervals, hand unlink (v149 was restructure_p3) |
| mcp | v152 | 10c | Rule health, bulk create (v151 was restructure_p4) |
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
- Detection needs about three months of history and finds monthly patterns only. Annual subscriptions come from seeding.
- Some investment descriptions keep a trailing lot number. Investment rows are not categorized.
- `deno check` on mcp reports 97 errors, all in older files. Each step checked that none are in its own files.

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
| SQL, PGlite and Supabase | 104 85, 115 13, 118 24, 121 39, 123 15, 125 22, 128 17, 130 17, 132 19 (251 checks) |
| Functions (`node --test`) | 708/708 |
| CLI (`scripts/lib`) | 224/224 |
| App (react-scripts) | 2465/2465 |

**Gaps**
- **RLS for a second user.** PGlite runs as one superuser with a stubbed `register_table`, so the policies are checked by shape (104), not exercised as Elise. Elise's access was verified by hand once, in 6b.
- **wb-sync `index.ts`.** Only `wb-sync-core.ts` has unit tests. The sync was verified by real runs (v5, v6).
- **The UI** is tested against a mocked Supabase. The real paths were verified by hand.
- **The weekly task prompt** has no automated test. It was verified by one manual run.
- **Detection thresholds** (26–35 days, 10%, 120 days) are tested on invented data only. Their fit to real data is judged by the 19 detected.
- **Performance:** none. The views recompute on every read, which is fine at today's size (hundreds of rows) and untested at tens of thousands.

---

## 6. Stale claims this thread holds

About 70 file claims, which the gitpush **Finish** will release. Notable ones:

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
- **No `db:` claims are held**, apart from what the next checkpoint releases. Check with `claims.mjs status`.

---

## 7. Phase 3 questions for Alex (draft)

From the Phase 1 spec, Phase 3 covers:
- `wb_projects`;
- `wb_planned_items`: future money in or out, with stages draft, estimate, quoted, invoiced, paid, cancelled;
- `wb_planned_matches`: planned items linked to the splits that paid them;
- `wb_settings`: e.g. the safety floor;
- views for monthly cash flow, burn rate (one-off projects separated out) and free cash. Free cash = spendable cash − earmarked − safety floor + expected inflows.

Each question has a recommendation.

1. **Which projects first?** The Phase 1 spec names the bathroom claim, the designer phase and a vacation.
   *Rec:* start with those three, entered in claude.ai, as Step 5 did for tags.
2. **How do charges join a project?** Options: a project link on splits, a "Project" tag group, or only through planned matches.
   *Rec:* a nullable `project_id` on splits, set by hand or by a rule. It reuses the split model, so one charge can be part project, part not. Planned matches stay for "this payment settles that quote".
3. **Do subscriptions generate planned items as stored rows?**
   *Rec:* no. Compute expected subscription outflows in a view, from `next_expected_on`, the interval and the current price, so they can never drift from the subscription. Store only one-off and project items.
4. **Insurance premiums** are not subscriptions, and policies arrive in Phase 4.
   *Rec:* until Phase 4, record premiums as recurring planned items, reusing the interval fields (count + unit). Phase 4 links them to policies.
5. **Expected inflows** (the royalty payer, interest, paychecks).
   *Rec:* recurring planned income items, matched like outflows. Royalties vary, so their amount is an estimate, and stage stays "estimate" until paid.
6. **Matching planned items to payments.**
   *Rec:* processing suggests a match (merchant + amount within tolerance + date window), and you confirm it. An unconfirmed suggestion shows as a new review-queue reason, `planned_match`. Partial payments are allowed, per the Phase 1 design.
7. **Which accounts are "spendable cash", and how far ahead does "earmarked" look?**
   *Rec:* spendable = accounts with role `spending_cash`. Earmarked = planned and subscription outflows in the next **60 days**. Both live in `wb_settings`, with the safety floor, which you set.
8. **Burn rate definition.**
   *Rec:* the median of the last 3 full months of spending (spend + refund + fee), excluding project-linked splits, shown next to the mean. The median resists one-off months.
9. **Draft ("what if") items.**
   *Rec:* drafts stay out of free cash unless a scenario toggle in the UI includes them. They are never included silently.
10. **Where it shows.**
    *Rec:* a Money "Plan" tab (projects, planned items, matches), plus a free-cash figure on Overview. Weekly cleanup gains "planned items overdue or unmatched" as its own section.
11. **Order of phases.**
    *Rec:* Phase 3 before 3b (orders). 3b needs Amazon's data export (Elise's is pending), and Phase 3 needs nothing new.
12. **Tax year.** Splits already carry a nullable `tax_year`.
    *Rec:* planned items get `tax_year` too, as in the Phase 1 design, so Phase 4's CPA handoff can include paid estimates.
