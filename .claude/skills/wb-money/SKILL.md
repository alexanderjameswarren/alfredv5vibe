---
name: wb-money
description: "Look after money that has already happened in Warren Buffet (the Money app's Alfred tools): what needs Alex's attention in money; the review queue and tagging transactions; fixing rules, merchants and tags; subscriptions and subscription reviews (\"review\" and a subscription's name, reviews due, is it worth it); Amazon order items; spending, cash-flow, true-cost, net-worth and balance reports; and approving a line from the weekly Money cleanup item. Load this whenever Alex asks what needs his attention in money, wants transactions tagged or fixed, a rule or merchant changed, a subscription reviewed, added or cancelled, a spending or net-worth question answered, or says yes to a cleanup line. For planning ahead (planned bills, income, projects, \"can we afford X\", missed dates, matches) use wb-planning."
---

# Money with Warren Buffet: what happened, and what to fix

Skill version: 2026-11-03b

This skill covers what has happened. **wb-planning** covers what is coming and whether we can
afford it; load it for planned items, projects, free cash with a what-if, missed dates and matches.

Sign rule everywhere: **money in is positive, money out is negative.**

🛑 **Show before you write.** Before any write, show a table of exactly what will change (the
record, the field, the old value and the new one) and wait for Alex's OK. One OK covers the rows in
that table, nothing more.

**No reminders or scheduled tasks** (`create_reminder`, `create_platform_schedule`) unless Alex asks for one.

**Links:** give every record as `https://alfredv5vibe.vercel.app/<id>`.

**Privacy:** this file names no real amounts, payees or products. Say them in chat only.

## 1. "What needs my attention?"

- Use `get_wb_action_items`. Lead with `below_floor`, then the red flags, then the rest by section.
  - **The amount to move is `shortfall_30d`, and no other figure:** the floor less the lowest balance
    in the next 30 days (`low_30d_balance` on `low_30d_on`), moved by `first_below_on`. A dip later
    than 30 days is not in it. If `first_below_on` is null, there is nothing to move. Never quote another "move" amount.
  - **A past-due card bill is a red flag only**, not a card bill to pay.
- Give each row's link (`link_kind`, `link_id`) and its `todo`.
- **It only reads.** Never mark, match, confirm or change anything from it without asking Alex first.
- **To close a fee flag:** ask Alex for the note, then call `mark_wb_reviewed` with that one charge's
  `transaction_ids` and `note`. Reviewed plus a note is the only thing that clears a flag. Only a refund-kind credit of the same amount on that card turns it green (never a card payment or a transfer), and each refund counts for one fee.
- **Card bills come from the card's statement and due days** (`update_wb_account`:
  `statement_close_day`, `payment_due_day`, `autopay`, taken from the statement), never from a
  planned item: free cash already counts card balances.
- Subscription reviews that are due show here too; work them with section 5.

## 2. Review queue and tagging

- **What is waiting:** `get_wb_review_queue` gives counts by reason over the date range, and the items.
  `get_wb_transactions` reads any transactions, with filters (account, dates, merchant,
  `subscription_id`, tag, kind, `needs_review`).
- **Tags:** `tag_wb_transactions` (up to 25 rows, one call). A tag removed by hand or by Claude is
  never put back by a rule.
- **Kind, merchant or transfer pair:** `set_wb_transaction_kind`. A paired row must be unpaired before its
  kind can change from transfer.
- **One charge for several things:** `split_wb_transaction`. The splits must add up to the charge.
- **Done with a row that needs no change:** `mark_wb_reviewed`, with a `note` when Alex gives a reason.
- Fix the row first; when the same fix will keep coming back, go to section 3 for a rule.

## 3. Rules, merchants and tags

- **Health first:** `get_wb_rule_health` lists findings by kind, each with its `detail`. A finding
  that is deliberate gets `acknowledge_wb_rule_health` with a short reason; it comes back on its own if it grows.
- **Before any new rule, preview it:** `get_wb_rule_preview` with `match`, or with `transaction_id`
  for the "always do this" plan. Show Alex the count and samples. Then `create_wb_rule`, or
  `create_wb_rule_from_transaction` (it proposes first; call again with `confirmed: true` after his OK).
  If a rule already exists for the merchant, update it (`update_wb_rule` or `update_rule_id`) rather than add a second.
- **Watch for drift:** several one-off rules for one merchant, each catching a different
  description, mean the merchant's pattern is too narrow. Propose one better pattern on the merchant
  (`upsert_wb_merchant`) instead of another rule, and say so.
- **Merchants:** `get_wb_merchants`, `upsert_wb_merchant`. Rules match on merchants, so a clean
  merchant pattern does most of the work.
- **Tags:** `get_wb_tags`, `create_wb_tag`, `update_wb_tag`. Prefer an existing tag to a near-duplicate.
- **After a rule or merchant change,** `reprocess_wb_transactions` on the ids or dates it touches, and report the counts.

## 4. Subscriptions

- `get_wb_subscriptions` (current price, review_date, `usage_clues`, `last_reviewed_on`,
  `last_verdict`; `include_prices`, `include_reviews`). It has **no ids option yet**: find one by `search` on its name.
- `upsert_wb_subscription`: create, confirm a detected one, pause, cancel, set the review date or
  `usage_clues`. **Bulk saves of review dates or clues pass `reprocess: false`.**
- `record_wb_subscription_price`: a new price from a date; with `transaction_id`, the charge's date.
- `set_wb_transaction_subscription`: link or unlink charges by hand.
- A subscription is already counted in free cash and true cost: never add one as a planned item too.

## 5. Subscription reviews

Start one when Alex says "review <name>", when a weekly-cleanup REVIEWS DUE line is approved, or
when a review date has passed.

**a. Read.** `get_wb_subscriptions` with `search`, `include_reviews` and `include_prices`. Show the
price changes since the last review, or the whole history on a first review.

**b. Usage.** Read `usage_clues` and follow them:
- Charges at the merchant: `get_wb_transactions` with `subscription_id`, or `merchant_id`.
- Workouts and yoga: `get_arnold_progress`, at most 93 days per call.
- Intention executions: `get_execution_history`.
- Other Alfred use: `get_activity`, or that app's own read tool.

Count uses **only** from a clue's source or from Alex; never infer one. With no clue, or no data
where the clue points, ask Alex, and offer to save his answer as the clue (`upsert_wb_subscription`
with `usage_clues`, `reprocess: false`). For example, yoga classes count as uses of a gym
membership; a house cleaner's visits are its charges.

**c. Value.** The amount paid in the period divided by the uses, only when uses can be counted.
Otherwise say "not countable".

**d. Market check.** Only during a review Alex started. Search the web for a fair price for this
kind of service or plan in his area. Name the source, and never put account details in a search.
Keep it to one dated line with its source. Say plainly whether he looks to be overpaying or
underpaying, and whether a cheaper plan, bundle or term exists.

**e. Verdict.** `keep`, `downgrade`, `switch`, `shop_around` or `cancel`, with one line of why. Then
the next review date: at least yearly for monthly ones; 30 days before renewal or term end for
annual, prepaid and auto-renewing ones.

**f. Save.** Show the table (verdict, next review date, period, uses, amount paid, cost per use,
market check, notes), then `record_wb_subscription_review`. It saves the review and moves the review
date together, and changes nothing else. **Cancelling, downgrading or switching are separate
proposed calls** (`upsert_wb_subscription`), never folded into the review. A refusal from the
database comes back as it is: read it to Alex and fix the input.

## 6. Setting review dates

Every active subscription has a review date. When one is missing, propose dates: monthly ones
spread across the next 12 months, so they don't land in one week; annual ones 30 days before
renewal. Show them all in one table, then save with `upsert_wb_subscription` (`review_date`,
`reprocess: false`).

## 7. Amazon order items

- `get_wb_order_items`: items, their category tag, and the charge each shipment matched.
- `set_wb_order_item_tags`: the Category tag, by item ids, by ASIN, or every untagged item of one site.
- `split_wb_order_charges`: splits matched charges by their items' categories. **It has no preview**,
  so show Alex how many charges it will touch first. It is safe to rerun after tags change.
- The read-only role can't check order matches; trust the tools' `matched_charge`.

## 8. Reports

`get_wb_spending`, `get_wb_cash_flow`, `get_wb_true_cost`, `get_wb_cash_projection`,
`get_wb_net_worth`, `get_wb_balance_history`, `get_wb_holdings`.
- **Read them; never recompute** a total they already give.
- **Say what period each one covers**, and what it leaves out (spending excludes transfers, income and investments).

## 9. Approving a line from the weekly Money cleanup item

Run exactly the proposed call after Alex says so, nothing more. When the line is a review, follow
section 5.

## Left out on purpose

- `bulk_create_wb_taxonomy`: setup only.
- Settings writes (`update_wb_settings`): only when Alex asks.
