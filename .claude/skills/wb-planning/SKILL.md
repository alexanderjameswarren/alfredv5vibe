---
name: wb-planning
description: "Plan money with Warren Buffet (the Money app's Alfred tools): add or change planned bills, income, one-offs and projects; backdate repeating items; answer \"can we afford X\"; work through missed dates and suggested matches. Load this whenever Alex wants to plan, budget, add a future payment or income, set up a project (a remodel, a trip, an insurance claim), asks whether he can afford something, or asks about free cash, missed dates or planned matches."
---

# Planning with Warren Buffet

Sign rule everywhere: **money in is positive, money out is negative.**

🛑 **Show before you write.** Before any write (`upsert_wb_planned_item`, `upsert_wb_project`,
`create_wb_planned_match`, `update_wb_planned_match`, `unconfirm_wb_planned_match`,
`mark_wb_missed_dates_not_needed`, `set_wb_transaction_project`), show a table of exactly what
will be created or changed (name, amount, date, repeat, stage or draft, merchant, tolerance,
project, tax_year) and wait for Alex's OK. One OK covers the rows in that table, nothing more.

**No reminders or scheduled tasks** (`create_reminder`, `create_platform_schedule`) unless Alex asks for one.

## 1. Check for a duplicate first

Before adding a bill, look for it:
- `get_wb_subscriptions`: a subscription is already counted in free cash and true cost. Never add
  one as a planned item too. Adding QuickBooks as a planned bill while it is an active
  subscription counts it twice.
- `get_wb_planned_items` (drafts are included by default): an item with the same payee, amount or
  date may already exist. Edit it (`upsert_wb_planned_item` with `id`) instead of adding a second.
- When it already exists, as a subscription or as a planned item, offer to edit the existing one.
  **Never offer to add a copy, not even as a draft.**

## 2. Repeating items

- A repeating item is `interval_count` + `interval_unit` (`week` or `month`), with an optional `ends_on`. It has no stage.
- **Backdating is on by default.** A new repeating item with a `merchant_id` moves its first date
  back to the earliest matching payment in the last 3 full months, so payments the burn rate
  already counts get matched, not counted twice. Pass `backdate: false` only when Alex wants the
  date he gave.
- **When the result has `backdated_from`, tell Alex the new first date and the day of the month
  it now falls on** (for example, "it now repeats on the 13th, not the 1st").
- **Amounts that vary** (fuel, utilities, a card's statement): suggest a wider `amount_tolerance`
  before creating, and say why. A payment only matches when its amount is within the tolerance, so
  a tight one matches only some months, and the rest stay in the burn rate.

## 3. Drafts and stages

- **Anything not committed is a draft.** For a one-off, that is `stage: "draft"`; for a repeating
  item, `is_draft: true`. Free cash leaves drafts out unless `include_drafts: true`.
- Stages, one-offs only:

| stage | when |
|---|---|
| `draft` | a what-if: an idea, not committed |
| `estimate` | committed, with a rough amount Alex made up or was told |
| `quoted` | a written quote is in hand |
| `invoiced` | a bill has arrived and is owed |
| `paid` | fully matched to payments. This is set automatically on confirming; do not set it by hand when a match can do it |
| `cancelled` | not happening; kept for the record |

- Move the stage on as the quote and invoice arrive.

## 4. tax_year

Leave `tax_year` empty unless the payment falls in a different year from the tax year it belongs
to. For example, a bill paid in January that belongs to the previous year gets that previous
year. If it is unclear which year a payment counts for, ask Alex; do not guess.

## 5. Merchants

- Link a `merchant_id` (from `get_wb_merchants`) whenever the payee is clear. An item with no
  merchant, such as a check or a deposit, is suggested any posted payment with the same sign and
  amount (within its tolerance, exact at 0) inside its window that has no confirmed match.
  Payments with no merchant come first, and a transfer between our own accounts is never
  suggested.
- **Be careful with generic bill-pay merchants**, such as a bank's online bill pay or a payment
  app that pays many payees. Linking one would suggest every bill paid through it. Prefer the real
  payee's merchant; if only the generic one exists, say so and ask, or leave the merchant empty.

## 6. "Can we afford X?"

Use `get_wb_free_cash` with `what_if`. It writes nothing.
- **What to pass:** `[{name, amount, date, interval_count?, interval_unit?, ends_on?}]`, up to 10 items. Money out is negative.
- **What to report:**
  - `what_if.without` and `what_if.with`: free_cash, the low balance (`low_balance`) and its date (`low_on`), and the first date below the floor (`first_below_floor_on`);
  - `difference`;
  - `days_sooner`: how many days earlier the floor is crossed. Negative means later. When only one
    side crosses, the other counts as the day after `horizon_end` and `days_sooner_at_least` is true:
    say "at least". Null when neither crosses.
- **Never say "affordable" or give a yes or no.** Free cash can already be negative, because the
  reserve is left out on purpose. Describe the change, and let Alex decide.
- **Flags:** an item with `outside_horizon: true` was not counted (its date is past the horizon); say so. A past one-off counts today.
- **To save one afterwards:** ask, then use `upsert_wb_planned_item`.

## 7. Missed dates

`get_wb_missed_dates` lists past due dates that no confirmed payment covers.
- **`within_window: true`:** the payment may still post; usually just wait.
- **`has_suggestion: true`:** answer the suggestion with `update_wb_planned_match` (`confirm` or `reject`).
- **Otherwise:** find the payment and match it, or, if the date was never going to be paid here
  (for example, before the bank sync started), ask Alex and then call
  `mark_wb_missed_dates_not_needed` with `dates: [{planned_item_id, occurrence_on, reason}]`.
  A repeating item needs `occurrence_on`; a one-off takes none. `undo: true` takes the mark off.

## 8. Matches

- **Suggestions:** `get_wb_planned_matches` (status `suggested`), or `get_wb_review_queue` reason
  `planned_match`. Answer with `update_wb_planned_match`; for a part-payment, confirm with a lower `amount`.
- **By hand:** `create_wb_planned_match` (tier 3). Show the proposal first: `amount_applied` and
  `would_mark_paid`. Pass `transaction_id` for a single-part payment, or `split_id`. A repeating item needs `occurrence_on`.
- **A wrong confirmed match:** `unconfirm_wb_planned_match` with `match_id`. It never changes the stage.
  - **If `paid_not_covered` is true, ask Alex whether to set the item back to `invoiced`.** Only after a yes, use `upsert_wb_planned_item` with `stage: "invoiced"`.
- **Within tolerance counts as covered (A45).** A date or one-off whose confirmed payments leave no
  more than its `amount_tolerance` unpaid is covered: it is not missed, it can become paid, and it
  gets no more suggestions.
- **`over_matched: true`** means the confirmed payments exceed the amount by more than the tolerance.
  It is a warning to check for a wrong match, never a block.

## 9. Removing things

There is no delete tool, on purpose: deleting would lose matches and history.
- **To drop a one-off:** set `stage: "cancelled"`.
- **To stop a repeating item:** set `ends_on`. Its past dates stay matched.
- **To delete outright:** Alex does that in the app.

## 10. Projects

- **Summary:** `get_wb_project_summary` gives spent (negative), received (positive), net, `budget_left`
  (the budget is measured against spent, not net), the amounts still due, and `planning` (every item is a
  draft and nothing is paid yet).
- **Putting payments on a project:** `set_wb_transaction_project` (up to 25 single-part payments).
- **A single future cost needs no project:** just a planned item.

## 11. "What needs my attention?"

- Use `get_wb_action_items`. Lead with the red flags and `below_floor`, then the rest by section.
  - **The amount to move is `shortfall_30d`, and no other figure:** the floor less the lowest balance
    in the next 30 days (`low_30d_balance` on `low_30d_on`), moved by `first_below_on`. A dip later
    than 30 days is not in it.
  - **A past-due card bill is a red flag only**, not a card bill to pay.
- Give each row's link (`link_kind`, `link_id`) and its `todo`.
- **It only reads.** Never mark, match, confirm or change anything from it without asking Alex first.
- **To close a fee flag:** ask Alex for the note, then call `mark_wb_reviewed` with that one charge's
  `transaction_ids` and `note`. Reviewed plus a note is the only thing that clears a flag; a refund only turns it green.
- **Card bills come from the card's statement and due days** (`update_wb_account`:
  `statement_close_day`, `payment_due_day`, `autopay`, taken from the statement), never from a
  planned item: free cash already counts card balances.
