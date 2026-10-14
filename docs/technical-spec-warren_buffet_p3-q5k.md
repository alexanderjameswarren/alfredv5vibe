# Warren Buffet Phase 3 — Technical Spec

Project code: `warren_buffet_p3-q5k`. Progress: `docs/progress-warren_buffet_p3-q5k.md`.
Sources: `docs/review-warren_buffet_p2-m4t.md` §7 and §8, as amended by Alex on 2026-10-14 (Step 1
approval, run tag `warren_buffet_p3-q5k-s2-v7c4`). Where this spec and the Phase 1 spec
(`docs/history/technical-spec-warren_buffet-w7b.md` §5) disagree, this spec wins.
Platform rules: `docs/history/technical-spec-platform-layer.md` and the mcp-platform skill.

**No real dollar amounts in this file or any committed file. The safety floor is entered at
seeding (Step 7) and never written into the repo.**

---

## 1. Purpose

Phase 3 answers "can we afford it?":
- projects, which group several payments;
- planned items: future money in or out;
- planned matches: planned items linked to the splits that paid them;
- settings: the safety floor and the horizon;
- free cash, monthly true cost and the burn rate;
- a Money "Plan" tab, and help panels on every rule-driven number.

---

## 2. Decisions

### 2.1 Phase 2 review §7 (Alex, 2026-10-14)

1. **Starting projects.** These are seeded in claude.ai (Step 7), as Phase 2 Step 5 did for tags:
   - Bathroom insurance claim;
   - Bathroom Remodel Design;
   - Backyard renovation;
   - "Meditation Room, Master Bedroom, Alex's Office Design" (one project);
   - Vacation.

   "Design" stays in the names because they are working with a designer.
2. **How charges join a project.** Through a nullable `project_id` on `wb_splits`, set by hand or by a rule. Planned matches stay for "this payment settles that planned item".
3. **Subscription outflows.** These are computed in a view from the next expected date, the interval and the current price. They are never stored as planned items.
   - Included: every active subscription, annual ones too.
   - Excluded: watching and paused subscriptions, and dates inside a prepaid term.
4. **Insurance premiums.** Recurring planned items (interval count + unit), until Phase 4 links them to policies.
5. **Expected inflows.** Royalties, interest and paychecks are recurring planned income items. Variable income is counted at a cautious estimate.
6. **Matching.** Processing suggests matches using merchant + amount within tolerance + date window. Each suggestion is confirmed in the review queue under the reason `planned_match`.
   - The card is labelled as the app's suggestion, shows the planned item beside the payment, and has Confirm / Not this one, like the inbox.
   - Partial payments are allowed.
7. **Free cash** = the lowest projected spending-cash balance over the horizon (12 months), projected day by day, minus the safety floor.
   - The CNB reserve (role `reserve_cash`) is excluded, and shown on its own line.
   - The projection includes:
     - income on its dates;
     - subscriptions (decision 3);
     - planned and project items on their due dates;
     - everyday spending at the burn rate.
   - The floor and the horizon live in `wb_settings`.

   **Monthly true cost** = burn rate + subscriptions normalized to a month + recurring planned outflows spread evenly over 12 months. It is shown against expected monthly income.
8. **Burn rate.** The median of the last 3 full months of spend + refund + fee, shown with the mean. It excludes project-linked splits and splits matched to a planned item.
9. **Drafts** stay out of free cash unless a scenario toggle in the UI includes them.
10. **Where it shows.**
    - A Money "Plan" tab: projects, planned items, matches.
    - Free cash and monthly true cost on Overview.
    - The weekly cleanup gains a section for planned items that are overdue or unmatched.
11. **Phase order.** Phase 3 comes before 3b (orders). The 3b input is the one Amazon export Alex already made.
12. **Tax year.** Planned items get a nullable `tax_year`.
13. **Help text.**
    - Every Money section that shows a rule-driven number, status or finding gets a "?" button.
    - Tapping it opens a short panel (a bottom sheet on mobile) with four headings, always the same:
      - What this is;
      - What's included;
      - What's left out;
      - What to do.
    - All wording lives in one file, `src/money/helpText.js`, keyed by section. A test fails on a key with no entry, or on an entry with an empty heading.
    - Panels show the live working where it helps.
    - Help ships in the same step as its feature.

**Also decided.** A future one-off cost (a new roof, say) is just a planned item with a date and an amount. A project is optional, and only groups several payments.

### 2.2 Step 1 amendments (Alex, 2026-10-14; binding)

| # | decision |
|---|---|
| A1 | Match suggestions run in one function, `wb_suggest_planned_matches(transaction_ids, planned_item_ids)`. It is called at the end of `wb_process_transactions` and by planned-item writes. No wb-sync change. (Subscription detection runs in wb-sync, not in processing; this differs on purpose.) |
| A2 | The projection is a function, `wb_cash_projection(include_drafts, today)`. Burn rate, subscription outflows and true cost stay views. |
| A3 | The burn rate also excludes splits on subscription-linked charges (`wb_transactions.subscription_id` set), so subscriptions are not counted twice. |
| A4 | The projection starts from spending_cash minus what is owed on credit cards, including any balance owed on emergency_credit. Unused credit never counts as cash. |
| A5 | Matches carry `occurrence_on`. Stage applies to one-off planned items only; a recurring item has no stage. |
| A6 | `wb_replace_splits` keeps project links and matches when it rebuilds splits. Matches use `on delete restrict`. |
| A7 | An overdue one-off planned item with no confirmed match counts on day 1 of the projection. |
| A8 | Expected monthly income = planned income items normalized to a month. Past income appears only as working in the help panel. |
| A9 | Rule-health help gets help entries only, and no screen. **No rule-health screen is planned in any phase**; findings are read in claude.ai and the weekly cleanup task. |
| A10 | `src/money/` is claimed as a folder. |
| A11 | Out of scope: `set_project_id` in `wb_rule_preview`, `wb_bulk_create` and `wb_fix_plan`. |
| A12 | A test keeps the SQL monthly-equivalent rule in step with `moneyFormat.monthlyEquivalent`. |
| A13 | The platform spec is `docs/history/technical-spec-platform-layer.md`. |
| A14 | Recurring "what if" items are wanted (Alex, 2026-10-14, run tag `warren_buffet_p3-q5k-s2-m3qd`). `wb_planned_items.is_draft boolean not null default false`, for recurring items only; a one-off draft stays stage `draft`. Drafts of either kind stay out of free cash unless the drafts toggle includes them. |

---

## 3. Data model

Every table follows Phase 1 §4:
- `id uuid`, `user_id`, `context_id` (the Money context);
- owner-or-shared-context RLS mirroring `public.intents`;
- `platform.register_table(..., p_policy_mode => 'none', p_audited => true)`;
- `updated_at`, stamped by `wb_touch_updated_at`;
- `notes`.

Sign rule: money in is positive, money out is negative.

### 3.1 `wb_projects` (audited)

| column | notes |
|---|---|
| name | not blank; unique per context, ignoring case |
| status | `active` (default), `on_hold`, `done`, `cancelled` |
| budget | nullable, ≥ 0 |
| starts_on, ends_on | nullable; ends_on ≥ starts_on |

### 3.2 `wb_planned_items` (audited)

| column | notes |
|---|---|
| project_id | nullable; `on delete set null` |
| name, counterparty | name not blank |
| merchant_id | nullable; `on delete set null`; used by match suggestions |
| amount | signed, never 0. For a recurring item, the amount of each occurrence. |
| due_on | a one-off's date; a recurring item's first (or next) date |
| interval_count, interval_unit | both null for a one-off. For a recurring item, 1–120 and `week` or `month`. |
| ends_on | recurring only; nullable; ≥ due_on |
| stage | one-off: required, one of `draft`, `estimate`, `quoted`, `invoiced`, `paid`, `cancelled`. Recurring: always null (A5). |
| is_draft | default false; true only on a recurring item (A14) |
| tax_year | nullable, 2000–2100 |
| amount_tolerance | ≥ 0, default 0; for suggestions |
| match_window_days | 0–90, default 10; for suggestions |

### 3.3 `wb_planned_matches` (audited)

| column | notes |
|---|---|
| planned_item_id | `on delete restrict` |
| split_id | `on delete restrict` (A6) |
| transaction_id | filled from the split by trigger, never typed |
| occurrence_on | required when the planned item is recurring; null for a one-off (A5) |
| amount_applied | same sign as the planned item, never 0; may be partial |
| status | `suggested` (default), `confirmed`, `rejected` |
| source | `default` (the suggestion function), `claude`, `manual` |
| decided_at | nullable |

- There is one row per (planned item, split, occurrence), with nulls not distinct.
- `user_id` and `context_id` are copied from the planned item.
- The split's transaction must be posted.
- The confirmed `amount_applied` on one split cannot exceed the split's own amount, in absolute terms.
- A rejected row stays, so the same suggestion is never made again.

### 3.4 `wb_settings` (audited)

| column | notes |
|---|---|
| context_id | unique: one row per context |
| safety_floor | nullable, ≥ 0. **Set by Alex at seeding, never in a committed file.** |
| horizon_months | 1–24, default 12 |

No row is seeded in a migration.

### 3.5 New columns

- `wb_splits.project_id`: nullable, references `wb_projects`, `on delete set null`, indexed (Step 2).
- `wb_rules.set_project_id` (Step 4). Processing sets it on a single-split transaction only, like tags, and never over a hand value.

### 3.6 `wb_replace_splits` (Step 2, A6)

The rebuild reuses existing split rows by position, so their ids, project links and matches survive.
- Input split *i* updates the existing split at position *i*:
  - amount, description, tax_year, notes and tags are replaced, as before;
  - `project_id` is set only when the input has a `project_id` key (null clears it), and is kept otherwise.
- Extra input splits are inserted, with `project_id` from the input or null.
- Existing splits beyond the input count are deleted. Their matches move to the position-0 split first.
- Tag behaviour is unchanged: the split's old tags go, the given tags are added with the given source, and their exclusions clear.
- The output adds `project_id` to each split.

### 3.7 Functions and views (Steps 4 and 5)

| object | kind | step |
|---|---|---|
| `wb_suggest_planned_matches(transaction_ids uuid[], planned_item_ids uuid[])` | invoker function | 4 |
| `wb_confirm_planned_match` | invoker function: confirm / reject / partial amount in one transaction | 4 |
| `wb_process_transactions` | sets `project_id` from rules; calls the suggestion function | 4 |
| `wb_review_queue`, `wb_transaction_list` | gain `planned_match`, with `needs_review` kept in step | 4 |
| `wb_planned_occurrences` | set-returning helper: occurrences in a date range | 5 |
| `wb_subscription_outflows` | view (decision 3) | 5 |
| `wb_burn_rate` | view, with working: months used and exclusions (decision 8, A3) | 5 |
| `wb_true_cost` | view: monthly true cost against expected monthly income (A8) | 5 |
| `wb_cash_projection(include_drafts boolean, today date)` | invoker function, day by day (A2, A4, A7) | 5 |
| `wb_free_cash(include_drafts boolean, today date)` | invoker function: low point, low date, floor, reserve line | 5 |

---

## 4. MCP tools (Step 6)

All tools use `defineTool`, `ctx.db` only and bare-data payloads. Every list is bounded with `clampLimit` (default 20, cap 50).

| tool | tier |
|---|---|
| `get_wb_projects`, `get_wb_planned_items`, `get_wb_planned_matches`, `get_wb_settings`, `get_wb_free_cash`, `get_wb_true_cost` | 1 |
| `get_wb_cash_projection` (event days and the low point only, never 365 rows) | 1 |
| `upsert_wb_project`, `upsert_wb_planned_item`, `create_wb_planned_match`, `update_wb_planned_match`, `set_wb_transaction_project` (≤ 25 rows) | 2 |
| `update_wb_settings` (its `propose` shows old vs new) | 3 |
| changed: `create_wb_rule`, `update_wb_rule` (set_project_id); `split_wb_transaction` (project_id per split) | 2 |

New tools go in `_shared/tools/warren-buffet-p3.ts`.

---

## 5. Build steps

Each step ends with verification and stops for Alex. Database claims are taken at the step that needs them. Migrations are numbered after gitsync.

| step | what | db: claims | deploy |
|---|---|---|---|
| 1 | Read-only plan | none | no |
| 2 | **Migration C.** The four tables, `wb_splits.project_id` and `wb_replace_splits` (§3.6). Rolled-back tests. CONFORMANT. | `db:table:wb_projects`, `db:table:wb_planned_items`, `db:table:wb_planned_matches`, `db:table:wb_settings`, `db:table:wb_splits`, `db:fn:wb_replace_splits` | no |
| 3 | **Help for the Phase 2 screens.** The "?" component, `helpText.js` and its test. Entries for: the review reasons; the rule-health findings (entries only, A9); the subscription statuses and Keep watching; the monthly breakdown; Always do this. | none | Vercel on merge |
| 4 | **Processing and suggestions.** `wb_rules.set_project_id`; the suggestion and confirm functions; `planned_match` in the queue and `wb_transaction_list`; its help entry; tests. | `db:fn:wb_process_transactions`, `db:fn:wb_suggest_planned_matches`, `db:fn:wb_confirm_planned_match`, `db:table:wb_rules`, `db:table:wb_planned_matches`, `db:table:wb_review_queue`, `db:table:wb_transaction_list` | no |
| 5 | **Views and projection** (§3.7), with tests on invented data, including the monthly-equivalent test (A12). Help for free cash, true cost, burn rate, spendable cash, the reserve line and the floor. | `db:table:wb_subscription_outflows`, `db:fn:wb_planned_occurrences`, `db:fn:wb_cash_projection`, `db:fn:wb_free_cash`, `db:table:wb_burn_rate`, `db:table:wb_true_cost` | no |
| 6 | **MCP tools** (§4). Plain-sentence errors, schema-versus-handler tests, tool count. | `db:deploy` | mcp |
| 7 | **Seeding in claude.ai.** Projects, premiums, inflows, one-offs, then the floor and horizon (Alex sets the floor). Confirm the first suggestions. | none | no |
| 8 | **Plan tab UI.** Projects and planned items; the match card on Review; a project picker on splits. Help for the stages and the match card. | none | Vercel on merge |
| 9 | **Overview.** Free cash and its low date, the reserve line, true cost against income, and the drafts toggle. Each panel shows its live working. | none | Vercel on merge |
| 10 | **Weekly cleanup prompt.** Adds the overdue and unmatched planned-items section, with a version bump. | none | no |
| 11 | **Phase 3 review.** | none | no |
