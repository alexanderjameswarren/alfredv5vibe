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
| A2 | The projection is a function, `wb_cash_projection(include_drafts, today)`. Burn rate, subscription outflows and true cost stay views. Two dated helpers sit behind the views, `wb_burn_rate_on(today)` and `wb_subscription_occurrences(from, to, today)`, so the projection can be run as of any day (A23). |
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
| A15 | Help numbers in SQL (Alex, 2026-10-14, run tag `warren_buffet_p3-q5k-s3-h6tz`). Applied migrations are never edited. The next time a migration redefines `wb_transfer_match`, `wb_detect_subscriptions`, `wb_subscription_overview` or `wb_rule_health_all` (or any object whose number the help states), that migration adds a comment next to each such number saying "if you change this value, update help entry <key> in src/money/helpText.js and its test". The JS mirrors live in `src/money/ruleNumbers.js`, and `helpText.test.js` checks them against the newest SQL definition. **Exception (Alex, 2026-10-20, run tag `warren_buffet_p3-q5k-s8-h1zc`):** a rolled-back test file may be edited after it was run, because it changes nothing in the database. The edit adds a header note naming the reason. The first case was 136, for A45. |
| A16 | `never_fires` is fixed in step 10, the weekly cleanup step (Alex, same run tag). The new rule: flag a rule when its last match is older than about 1.5 times its expected interval, and give a brand-new rule that long before its first match is due. Step 3 does not change the check. |
| A17 | `wb_splits.project_source` (`rule`, `claude`, `manual`). Rules never overwrite claude or manual. A hand removal (project_id null with source claude or manual) sticks, as tag exclusions do. A project written with no source counts as manual. (Alex, 2026-10-16, run tag `warren_buffet_p3-q5k-s4-n8rc`.) |
| A18 | Step 4 adds a minimal "Suggested match" group to Review: the planned item's name and date beside the payment, with Confirm, "Not this one" and the "?" (no longer reserved). Step 8 builds the full card. |
| A19 | Suggestions after planned-item writes come from explicit calls, not a trigger: the step 6 tools and step 8 screens call `wb_suggest_planned_matches` after they write. Processing is re-run once after seeding (step 7). |
| A20 | Fully confirming a one-off sets its stage to `paid` automatically. Nothing ever sets it back automatically. |
| A21 | The help does not state default numbers (the default tolerance and window). Per-item values are shown as live working instead. |
| A22 | The six step 5 help entries (`overview.burn_rate`, `overview.spendable_cash`, `overview.free_cash`, `overview.reserve_cash`, `overview.safety_floor`, `overview.true_cost`) are written in step 5 as reserved, and unreserved in step 9 when Overview shows them. (Alex, 2026-10-17, run tag `warren_buffet_p3-q5k-s5-c4wr`.) |
| A23 | `wb_burn_rate_on` and `wb_subscription_occurrences` are the dated helpers behind the views (see A2). |
| A24 | An active subscription more than 7 days past its expected date counts once, on day 1 of the projection. Paused subscriptions, and prepaid terms that do not renew, never count. A charge 0–7 days late also counts on day 1, because it is imminent (confirmed by Alex, 2026-10-17, run tag `warren_buffet_p3-q5k-s5-y8kd`). |
| A25 | Missed dates of recurring planned items are not counted on day 1. They **must** appear as unmatched in the weekly cleanup's planned-items section (step 10, "done when"). |
| A26 | Burn subtracts only the confirmed `amount_applied` of planned matches; the rest of a mixed payment still counts. |
| A27 | True cost uses the median burn; the mean is working. |
| A28 | With no safety floor set, free cash uses 0 and returns `floor_missing: true`. |
| A29 | There is no "unconfirm" of a planned match in Phase 3. It is noted under step 8: add it if the Plan tab shows the need. (Alex, 2026-10-19, run tag `warren_buffet_p3-q5k-s6-p9xe`.) |
| A30 | The project spent-to-date summary (`wb_project_summary`) is built in step 8, not step 6. |
| A31 | **Any other thread must run gitsync before deploying mcp**, or the Warren Buffet Phase 3 tools disappear from live. Alex tells restructure_p4-v9k himself. |
| A32 | `create_wb_planned_match` is **tier 3 with propose**. The proposal shows the planned item's name and due date (with occurrence_on for a recurring item), the payment's date, description and amount, the amount that would be applied, and whether confirming would mark the item paid. Propose only reads, and shares its validation with the handler (`matchPlan`), so it refuses anything the write would refuse. `update_wb_planned_match` stays tier 2, because it acts on an app suggestion Alex has already seen. |
| A33 | `get_wb_planned_items` includes drafts by default, and every item says plainly whether it is a draft (`draft: true` for stage draft, or for is_draft on a recurring item). Free cash still leaves drafts out by default. |
| A34 | A new repeating item with a merchant starts from the **earliest matching payment inside the burn window** (`wb_planned_start_from_history`: same merchant and sign, amount within tolerance, from the first burn month to today). The form shows it and can override it; `upsert_wb_planned_item` returns it as `backdated_from`. With no merchant, or no payment, the given date stands. (Alex, 2026-10-19, run tag `warren_buffet_p3-q5k-s8-t3bv`; A34–A41 all from this run tag.) |
| A35 | "Planning" is derived, never stored: a project is planning when every item that is not cancelled is a draft and nothing has been paid on it. A project with no items is not planning. |
| A36 | Project totals are spent (gross money out, negative), received (money in, positive) and net (their sum). **The budget is measured against spent**, not net: `budget_left = budget + spent`. |
| A37 | "More than planned": a warning when an item's confirmed matches exceed its amount. Warning only, never blocking (`over_matched`, computed). |
| A38 | A split's project shows in the transaction detail, where it can be edited, and in `get_wb_transactions` as `project_names` (from `wb_transaction_list`). |
| A39 | Remove (unconfirm) a match: `wb_unconfirm_planned_match` sets it to rejected, so it is not suggested again, and never changes the stage (A20). If that leaves a one-off at stage paid no longer fully covered (`paid_not_covered`), the app asks "Set it back to invoiced?" with Yes or No. App only in step 8. Replaces A29. |
| A40 | Missed dates: the `wb_planned_unmatched` view lists past due dates not fully matched, and the `wb_planned_skips` table records a date marked "Not needed", which the view then leaves out. Step 10's weekly cleanup reads the same view (A25). |
| A41 | Step 8 is split into 8a–8d. 8a is the database. **What 8b–8d hold was replaced by A42–A44.** |
| A42 | **Planning happens mostly in claude.ai**, so Claude must work well as the planning tool. 8b is tools first. New tools: the project summary; missed dates; mark a missed date not needed; unconfirm a match (tier 2, returning `paid_not_covered` so Claude can ask about setting the item back to invoiced). Plus the planned handler changes (`backdated_from`, `project_names`, `over_matched`) and the what-if (A43). They need `mcp/index.ts`. Before deploying, the live mcp version must still be v155; if higher, stop and ask. (Alex, 2026-10-19, run tag `warren_buffet_p3-q5k-s8-n7xr`; A42–A44 all from this run tag.) |
| A43 | `get_wb_free_cash` takes optional hypothetical items (amount, date, optional interval). It returns free cash with and without them and writes nothing, so Claude can answer "can we afford X on date Y" in one call. Tier 1, bounded. **Amended** (Alex, 2026-10-19, run tag `warren_buffet_p3-q5k-s8-c8pk`):
- There is **no `affordable` yes or no**. Free cash is already negative before any what-if, because the reserve is left out on purpose, so it would always say no.
- It returns `without` and `with`, each with `free_cash`, `low_balance`, `low_on` and `first_below_floor_on`.
- It also returns `difference`, and `days_sooner`: how many days earlier (positive) or later (negative) `first_below_floor_on` comes with the items.
- Each item keeps `dates_counted`, and is flagged `outside_horizon` when its date is past the horizon. |
| A44 | 8c is a planning skill, `.claude/skills/wb-planning/SKILL.md`, tested with a scripted planning conversation in a fresh thread. 8d is a slimmer app: the Plan tab overview (projects with totals, upcoming, repeating, what-ifs, missed dates with Not needed), project detail, planned item detail with matched payments and Remove (with the set-back-to-invoiced question), the full Review suggestion card, and the single-split project picker on transaction detail, all with their help. **Dropped for now:** the add and edit forms and the split-editor picker. Claude does the entry. |
| A45 | **Covered within tolerance.** A planned date, or a one-off, counts as covered when what its confirmed matches leave unpaid is no more than the item's `amount_tolerance`. This applies to bills and to income. One rule, `wb_planned_left(amount, paid, tolerance)` (and `leftOf` in the handlers), decides it everywhere: missed dates, auto-paid (A20), `paid_not_covered`, new suggestions, project amounts still due, the projection, `remaining`, `over_matched` (only beyond the tolerance), and `create_wb_planned_match`'s "already paid in full" and `would_mark_paid`. Found in 8b batch 1: a salary date 0.01 short was listed as missed. (Alex, 2026-10-19, run tag `warren_buffet_p3-q5k-s8-x9tr`.) |
| A46 | **Deleting a planned item** goes through one function, `wb_delete_planned_item(p_id)`. It is security invoker and granted to authenticated only. In one transaction it deletes the item's matches (every status), then the item; skips cascade. It returns the counts removed: confirmed, suggested, rejected and skips. It never touches transactions, splits or projects, and an item the caller cannot see is refused with nothing changed. **Only the app calls it; there is no MCP delete tool, on purpose.** The skill sends deletes to the app. (Alex, 2026-10-21, run tag `warren_buffet_p3-q5k-s10-c4vj`; the 8d decisions below come from the same tag.) |
| A47 | **8d app decisions.** The item detail has both actions: **Remove match** on each match row (the unconfirm, with the "Set it back to invoiced?" question, A39) and **Delete item** for the whole item (A46). The confirmation says exactly what goes. Missed dates on the Plan overview are a read-only list, each row linking to its item; there is no Not needed button in the app, because Claude does that. The 8 Money tabs are fine. No add or edit forms. |
| A48 | **Reuse Alfred's UI patterns.** Before building any new UI element, look for the existing Alfred pattern or component and reuse it. Confirmations are pop-ups in Alfred's confirmation pattern (the overlay and card of ExecutionDetailView's "Delete execution" and of StatusEventsSheet, with CancelButton styling), never inline. There is no generic shared confirm component yet, so the Money item page copies that pattern. A shared one would be extracted only with Alex's OK. (Alex, 2026-10-22, run tag `warren_buffet_p3-q5k-s13-q8rn`; standing for the rest of the project.) |
| A49 | **Step 9 decisions.** The free cash card adds "Missed dates aren't counted", linking to the Plan tab's Missed dates. The `overview.safety_floor` help says "Ask Claude to change it (it shows old against new before saving)". The `overview.free_cash` help adds A45 (a date counts as covered within tolerance) and A25 (missed repeating dates are not counted). There is no what-if form in the app; that stays in claude.ai (A43). **Step 9 grows:** the Overview becomes the money to-do list, with Action Items and Dropping below the floor. Order: the data first, then layout mockups in claude.ai, then the UI. (Alex, 2026-10-22, run tag `warren_buffet_p3-q5k-s16-v7ea`.) |
| A50 | **The money to-do list's data.** The data plan is approved, with additions (Alex, 2026-10-22, run tag `warren_buffet_p3-q5k-s17-a8tm`).<br>**Card settings:** `wb_accounts` gains `statement_close_day` and `payment_due_day` (1–31, null allowed) and `autopay` (none, minimum, full; null allowed). They start null and are set through Claude.<br>**One function:** `wb_action_items(p_days 14, p_big_amount 1000, p_big_days 60, p_today)`. It is security invoker and granted to authenticated only (service_role revoked too, since `ctx.db` runs as authenticated). It returns one JSON object, and every row has type, title, todo, severity (red, amber, info), amount, on, link_kind and link_id. The sections:<br>• **flags:** card interest, late fees and finance charges in the last 30 days, and a card bill past due and unpaid;<br>• **reconcile:** review queue counts by reason;<br>• **overdue:** missed dates, overdue one-offs and overdue subscriptions;<br>• **coming_up:** planned items, less what is covered (A45), and subscriptions in the next `p_days`;<br>• **big_bites:** payments out over `p_big_amount` in the next `p_big_days`, from planned items (what-ifs included and marked) and subscriptions;<br>• **card_bills:** the balance on the last close day, less card payments since, due on the next due day. A card without days gets "Set this card's statement and due days";<br>• **needs_attention:** the latest wb-sync problem, synced balances not updated for 2 days, hand-entered balances older than 30 days or never entered, subscriptions past their review date or still watching, accounts with no role, and rule health;<br>• **money_intentions** and **money_inbox:** open intentions and unprocessed inbox items in the Money context, read through their own RLS;<br>• **below_floor:** the first projected day under the floor, the shortfall then and at the low point (what to move from the reserve), and the payments up to that day. It is read from `wb_cash_projection` and `wb_free_cash`; no projection logic is copied.<br>**Card bills are reminders, never planned items:** the projection already counts what is owed on the cards (A4).<br>**The 9c tool** `get_wb_action_items` returns the same object. `mcp/index.ts` is claimed only at 9c, after a gitsync.<br>**Grants (confirmed 2026-10-23, run tag `warren_buffet_p3-q5k-s17-k3wq`):** Claude's scheduled tasks reach the database only through the MCP connector, whose `ctx.db` carries the user's token, so they run as authenticated. The service client is used only by the server-side Edge Functions (wb-sync, email-capture, clip-capture, notify-dispatch), and none of them reads action items. So service_role stays revoked. **A future server-side job that reads `wb_action_items`**, such as an email reader built as an Edge Function, needs execute granted to service_role first. The 30-day threshold for hand-entered balances stays. |
| A51 | **9b fixes** (Alex, 2026-10-23, run tag `warren_buffet_p3-q5k-s18-u2fc`). The 9b live read counted a cashed check and a mobile deposit a second time, because neither planned item had a merchant, so neither was ever suggested a match.<br>**Matches for items with no merchant:** `wb_suggest_planned_matches` suggests, for a planned item (one-off or repeating) with no merchant, a posted payment of the same sign whose amount is within its tolerance (exact when 0), inside its match window, with no confirmed match. It never suggests a transfer between our own accounts (`transfer_pair_id` set); unpaired household transfers count. Payments with no merchant come first. When an item at a merchant and an item with none both fit one payment, the item at the merchant wins.<br>**`wb_action_items`:**<br>• a planned item with no merchant gets "Deposit it; it will be matched once it posts." for money in, and "Pay it; …" for money out;<br>• a planned date past due but still inside its match window, and a subscription charge up to 7 days late, stay in **coming_up** with `late` true, amber, and "(late, due …)" in the title; **overdue** holds only dates past the window and charges more than 7 days late;<br>• a title cut at 120 characters ends with "…".<br>Every coming_up row carries `late`. |
| A52 | **The Overview layout** (Alex, 2026-10-23, from the claude.ai mockups; run tag `warren_buffet_p3-q5k-s21-o4kz`). It replaces the separate Free cash and True cost cards of the step 9 plan. From the top:<br>1. **Sync line** as before; the warning banner shows only when there is a problem. The no-role banner goes; those accounts are To do rows.<br>2. **Funds transfer required:** an amber card, shown only when `below_floor.first_below_on` is set. It reads "Move $shortfall_then from (reserve account) by (date)", then the biggest cause other than the burn rate, the projected balance that day, and the floor. "See what causes it" opens the causes, each linked (the Subscriptions breakdown toggle). "Reserve $reserve_balance" opens the reserve account: the visible `reserve_cash` account with the largest balance.<br>3. **Red flags:** one red card per row, the title linked, with its todo underneath.<br>4. **To do:** overdue, reconcile, card_bills, needs_attention, money_intentions and money_inbox, in that order. Each row has a kind label: Card for card bills, Intention, Someday for inbox items, Rule for rule health, Account for account rows and sync problems, and Review for everything else. The header shows the count.<br>5. **Major expenses, next 60 days:** the big_bites rows, with what-ifs marked and left out of the header total.<br>6. **Next 14 days:** every coming_up row in one card. Money in is green, `big` rows are bold, and `late` rows carry a "late" badge (the SQL's "(late, due …)" suffix is dropped from the title). The header reads "In \| Out \| Net", with only Net coloured. The card shows 12 rows, then "See every item".<br>7. **Cash flow:** Last 30 days, Next 30 days and Typical month, each coloured by sign. Under a divider, the reserve runway, left out when `runway_months` is null.<br>8. **Net worth** as before.<br>**Data:** `wb_action_items.cash_flow` has four fields:<br>• `last_30_actual`: settled spending-cash and card rows over the last 30 days, without paired transfers or transfers received on a card;<br>• `next_30_projected`: the projection's closing on day 30 less its opening today, with no drafts;<br>• `typical_month`: `wb_true_cost.net_monthly`;<br>• `runway_months`: the reserve divided by the monthly shortfall, null unless `typical_month` is negative.<br>coming_up rows gain `big`: money out over `p_big_amount`.<br>**Links by link_kind:** planned_item, subscription, transaction and account open their Money pages (Back from an item or a transaction returns to Overview); intention and inbox_item open Alfred's intention and inbox detail. review_reason opens Review, which has no reason filter. merchant opens Review too, because rule health has no screen (A9).<br>**Help:** new entries `overview.funds_transfer`, `todo`, `major_expenses`, `next_days` and `cash_flow`. Unreserved: `burn_rate`, `reserve_cash`, `safety_floor` and `true_cost`. `spendable_cash` and `free_cash` stay reserved, since the new layout shows neither. The 14, 60, 1000 and 30 are mirrored in `ruleNumbers.js` and checked against the SQL defaults (A15). |
| A53 | **Overview changes after live testing** (Alex, 2026-10-23, run tag `warren_buffet_p3-q5k-s21-f6mc`). They fold into the same pending cash flow migration.<br>1. **The path to the first day below.** "See what causes it" becomes "Show the path to (date)". `below_floor.path` lists:<br>• the starting balance (the projection's opening today);<br>• every planned item, deposit and subscription charge from today to `first_below_on` in date order, using the projection's own planned rows (due dates less what is confirmed, and an overdue one-off on today);<br>• the burn rate as one row per week, dated on the week's last day.<br>Each row has its date, title, amount, link, `balance` (the projection's closing that day) and `below` (under the floor). The app highlights the first `below` row and links every dated row that has a record. `causes` stays in the data only because the live `get_wb_action_items` description names it; the UI keeps it for the "Biggest:" line.<br>2. **Card fee flags** look back 90 days, not 30. A flag clears **only** when the charge is marked handled, refund or not. A credit of the same amount on the same card, on or after the charge, no longer clears it. Instead the flag turns `info` (green in the app), carries `refund` (amount, date, link), and reads "Refund received: +$X on (date)" with the refund linked. A flag with no refund stays red until handled. (Changed by Alex, 2026-10-23, run tag `warren_buffet_p3-q5k-s21-n2hp`.) Handled uses the transaction's existing fields, `reviewed` and `notes`: reviewed *and* with a note, so ticking Reviewed alone never hides a flag. The flag card shows the note under the title, and the todo says how. No new column. **Through Claude:** `mark_wb_reviewed` sets reviewed, but no tool writes a transaction note. That is 9c-style work, alongside updating the tool's description for the 90 days, the clearing rules, `note` and `path`.<br>3. **Back from an account opened on the Overview** returns to the Overview. The Reserve button is a text link, like "See every item".<br>4. **Major expenses:** the heading on one line, with the total on its own row beneath, like In \| Out \| Net.<br>5. **Every heading** reads title, count, then the help icon: "To do (9) ?". |
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
- `wb_rules.set_project_id` (Step 4). Processing sets it on a single-split transaction only, like tags; the first matching rule wins. It never writes over a hand value, and it clears a rule's project when no rule sets one any more.
- `wb_splits.project_source` (Step 4, A17). A trigger fills `manual` when a project is written with no source.

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
| `wb_planned_occurrences(p_from, p_to, p_include_drafts)` | set-returning helper: occurrences in a date range. **Moved from step 5 to step 4**, because matching needs recurring due dates. | 4 |
| `wb_monthly_equivalent(amount, interval_count, interval_unit)` | immutable function: the JS monthly-equivalent rule (A12) | 5 |
| `wb_subscription_occurrences(from, to, today)` | dated helper: active subscriptions' expected charges (A23, A24) | 5 |
| `wb_subscription_outflows` | view (decision 3) | 5 |
| `wb_burn_rate_on(today)` | dated helper: 3 months, exclusions, median and mean (A23, A26) | 5 |
| `wb_burn_rate` | view, with working: months used and exclusions (decision 8, A3) | 5 |
| `wb_true_cost` | view: monthly true cost against expected monthly income (A8) | 5 |
| `wb_cash_projection(include_drafts boolean, today date)` | invoker function, day by day (A2, A4, A7) | 5 |
| `wb_free_cash(include_drafts boolean, today date)` | invoker function: low point, low date, floor, reserve line | 5 |

### 3.8 Plan tab support (Step 8a)

| object | kind | notes |
|---|---|---|
| `wb_planned_skips` (audited) | table | planned_item_id (`on delete cascade`), occurrence_on (recurring only, as in matches), reason. One row per (item, occurrence), nulls not distinct. Owner and context filled from the item by trigger (A40). |
| `wb_planned_unmatched` | view | past due dates not fully matched: recurring dates from due_on (drafts left out) and overdue one-offs (not draft, paid or cancelled), less skips. Columns include confirmed_total, remaining, days_late, within_window, has_suggestion (A25, A40). |
| `wb_project_summary` | view | per project: spent, received, net, budget_left (A36), planned_out_due and planned_in_due (one-offs left to pay; recurring dates over the horizon), draft_out_due and draft_in_due, item_count, draft_count, payment_count, last_payment_on, planning (A35). |
| `wb_unconfirm_planned_match(match_id)` | invoker function | confirmed → rejected; returns stage, confirmed_total and paid_not_covered; never changes the stage (A39). |
| `wb_planned_start_from_history(merchant_id, amount, tolerance, today)` | invoker function | earliest matching payment from the first burn month (A34). |
| `wb_transaction_list` | view, redefined | adds `project_names` at the end (A38). |

---

## 4. MCP tools (Step 6)

All tools use `defineTool`, `ctx.db` only and bare-data payloads. Every list is bounded with `clampLimit` (default 20, cap 50).

| tool | tier |
|---|---|
| `get_wb_projects`, `get_wb_planned_items`, `get_wb_planned_matches`, `get_wb_settings`, `get_wb_free_cash`, `get_wb_true_cost` | 1 |
| `get_wb_cash_projection` (event days and the low point only, never 365 rows) | 1 |
| `upsert_wb_project`, `upsert_wb_planned_item` (then suggests matches, A19), `update_wb_planned_match` (through `wb_confirm_planned_match`), `set_wb_transaction_project` (≤ 25 rows) | 2 |
| `create_wb_planned_match` (propose shows the match, A32) | 3 |
| `update_wb_settings` (its `propose` shows old vs new) | 3 |
| changed: `create_wb_rule`, `update_wb_rule` (set_project_id); `split_wb_transaction` (project_id per split) | 2 |

New tools go in `_shared/tools/warren-buffet-p3.ts`.

**Step 8b additions (A42, A43).** 134 → 138 tools.

| tool | tier | notes |
|---|---|---|
| `get_wb_project_summary` | 1 | `wb_project_summary` rows; filters project_id and status; bounded |
| `get_wb_missed_dates` | 1 | `wb_planned_unmatched` rows; filters project_id, planned_item_id and include_within_window (default true); bounded |
| `mark_wb_missed_dates_not_needed` | 2 | up to 25 `{planned_item_id, occurrence_on?, reason?}`. All checked before any write: the item exists; occurrence_on is required for a repeating item and refused for a one-off; the date must be missed now. Already-marked dates are reported. `undo: true` deletes the marks. |
| `unconfirm_wb_planned_match` | 2 | confirmed only (plain refusal otherwise), through `wb_unconfirm_planned_match`. Returns `paid_not_covered`, and a `hint` to ask about setting the item back to invoiced when it is true. Never writes the stage. |
| `get_wb_free_cash` + `what_if` | 1 | up to 10 items `{name?, amount, date, interval_count?, interval_unit?, ends_on?}`. Computed in the handler from `wb_cash_projection` and writes nothing. A past one-off counts today; repeating dates count from today; a date past the horizon is `outside_horizon`. Returns `without` and `with` (free_cash, low_balance, low_on, first_below_floor_on), `difference`, `days_sooner`, `horizon_end`, and per item `dates_counted`, `first_on` and `last_on`. |
| `upsert_wb_planned_item` | 2 | a new repeating item with a merchant is backdated through `wb_planned_start_from_history`, only to an earlier date; returns `backdated_from`; `backdate: false` opts out |
| `get_wb_planned_items` | 1 | `over_matched` per item (a one-off in total, a repeating item on any one date) |
| `get_wb_transactions` | 1 | `project_names` |

---

## 5. Build steps

Each step ends with verification and stops for Alex. Database claims are taken at the step that needs them. Migrations are numbered after gitsync.

| step | what | db: claims | deploy |
|---|---|---|---|
| 1 | Read-only plan | none | no |
| 2 | **Migration C.** The four tables, `wb_splits.project_id` and `wb_replace_splits` (§3.6). Rolled-back tests. CONFORMANT. | `db:table:wb_projects`, `db:table:wb_planned_items`, `db:table:wb_planned_matches`, `db:table:wb_settings`, `db:table:wb_splits`, `db:fn:wb_replace_splits` | no |
| 3 | **Help for the Phase 2 screens.** The "?" component, `helpText.js` and its test. Entries for: the review reasons; the rule-health findings (entries only, A9); the subscription statuses and Keep watching; the monthly breakdown; Always do this. | none | Vercel on merge |
| 4 | **Processing and suggestions.** 4a (database): `wb_rules.set_project_id`, `wb_splits.project_source`, `wb_planned_occurrences`, the suggestion and confirm functions, `planned_match` in the queue and `wb_transaction_list`, `wb_replace_splits`, and tests. 4b (app): the minimal Suggested match group (A18) and its help entry. | `db:fn:wb_process_transactions`, `db:fn:wb_suggest_planned_matches`, `db:fn:wb_confirm_planned_match`, `db:fn:wb_planned_occurrences`, `db:fn:wb_replace_splits`, `db:table:wb_rules`, `db:table:wb_splits`, `db:table:wb_planned_matches`, `db:table:wb_planned_items`, `db:table:wb_review_queue`, `db:table:wb_transaction_list` | no |
| 5 | **Views and projection** (§3.7), with tests on invented data, including the monthly-equivalent test (A12). Help for free cash, true cost, burn rate, spendable cash, the reserve line and the floor. | `db:fn:wb_monthly_equivalent`, `db:fn:wb_subscription_occurrences`, `db:table:wb_subscription_outflows`, `db:fn:wb_burn_rate_on`, `db:table:wb_burn_rate`, `db:table:wb_true_cost`, `db:fn:wb_cash_projection`, `db:fn:wb_free_cash` | no |
| 6 | **MCP tools** (§4). Plain-sentence errors, schema-versus-handler tests, tool count (121 → 134). Any other thread must gitsync before deploying mcp (A31). | `db:deploy` | mcp |
| 7 | **Seeding in claude.ai.** Projects, premiums, inflows, one-offs, then the floor and horizon (Alex sets the floor). Confirm the first suggestions. | none | no |
| 8a | **Plan tab database** (§3.8), with rolled-back tests. CONFORMANT. | `db:table:wb_planned_skips`, `db:table:wb_planned_unmatched`, `db:table:wb_project_summary`, `db:fn:wb_unconfirm_planned_match`, `db:fn:wb_planned_start_from_history`, `db:table:wb_transaction_list` | no |
| 8b | **Tools first (A42, A43).** New: project summary, missed dates, mark not needed, unconfirm. Changed: the free cash what-if, `backdated_from`, `project_names`, `over_matched`. Needs `mcp/index.ts`. Before deploying, the live mcp version must still be v155; if higher, stop and ask. **Done 2026-10-20:** live on mcp v157, 138 tools, with the tolerance fix (A45, migrations 143–144); fresh-thread verification passed. | `db:deploy` | mcp |
| 8c | **Planning skill** `.claude/skills/wb-planning/SKILL.md` (A44), tested in a fresh thread. | none | no |
| 8d | **Slimmer app (A44, A46, A47).** 8d-1 `wb_delete_planned_item`; 8d-2 the Plan tab overview (with read-only missed dates); 8d-3 project detail; 8d-4 item detail (Remove match, Delete item); 8d-5 the full Review card; 8d-6 the single-part project picker; and their help. No add or edit forms, and no split-editor picker. **Done 2026-10-22:** all six sub-steps tested in Chrome; 146 is live. | 8d-1: `db:fn:wb_delete_planned_item` | Vercel on merge |
| 9 | **Overview.** Free cash and its low date, the reserve line, true cost against income, and the drafts toggle. Each panel shows its live working. **Grew into the money to-do list (A49–A53). Done 2026-10-23:** 150, 151 and 153 are live, the Overview is live (merge ffeb7cc), and mcp v160 has `get_wb_action_items`, the card fields, and the note on `mark_wb_reviewed`. | 9a, 9b, 9e: `db:fn:wb_action_items`, `db:table:wb_accounts`, `db:fn:wb_suggest_planned_matches`; 9c, 9f: `db:deploy` | mcp, Vercel on merge |
| 10 | **Weekly cleanup prompt.** Adds the overdue and unmatched planned-items section, with a version bump. | none | no |
| 11 | **Phase 3 review.** | none | no |
