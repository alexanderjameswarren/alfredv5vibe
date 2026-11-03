# Warren Buffet: Money chat skill and clean-up

**Status: finished 2026-11-03.** The record is in `docs/history/progress-warren_buffet_p4-r6d-money_chat.md`.

Project code: `warren_buffet_p4-r6d` (a later phase keeps its project's code). Progress: `docs/progress-warren_buffet_p4-r6d-money_chat.md`. Phase 3 and 4 records are in `docs/history/`.

**Privacy rule:** no dollar amounts, payees or product names in the repo or in reports.

## 1. Overview

Alex does most money planning in claude.ai chat. This slice makes Claude good at the rest of Money there, makes subscription reviews actionable, and tidies what earlier phases left open.

At planning time 27 of the 54 `wb_*` tools were named by no skill or scheduled prompt.

## 2. The two skills

| Skill | Covers |
|---|---|
| `wb-planning` (kept) | Planned items, projects, backdating, "can we afford X", missed dates, matches |
| `wb-money` (new) | What needs my attention (moved from wb-planning section 11), reviewing and tagging, rules, subscriptions and their reviews, Amazon order items, reports, approving weekly-cleanup lines |

**Why two:** "what happened and what do I fix" and "what is coming and can we afford it" trigger on different words, and one skill would nearly double in size.

**Rules in `wb-money`, the same as `wb-planning`:**
- Show before you write: a table of exactly what changes; one OK covers those rows.
- No reminders or scheduled tasks unless Alex asks.

**Notes for `wb-money`:**
- `split_wb_order_charges` has no preview, so show the count first.
- The read-only role can't see `wb_order_matches`.
- `upsert_wb_subscription` reprocesses the merchant on every save by default, so bulk date and clue updates pass `reprocess: false`.
- Left out unless Alex asks: `bulk_create_wb_taxonomy` and settings writes.
- The overwatch skill's hand-over line (line 44) names `wb-money` as well.

Skills reach claude.ai only when Alex uploads them. Upload both together, because the installed `wb-planning` description already differs from the repo's.

## 3. Actionable subscription reviews

A review answers, per subscription: is it used, is the price still right, what is the cost per use, and what is the verdict.

### Review dates

Every active subscription gets one.
- **Monthly:** reviewed at least once a year, with first dates spread across the next 12 months.
- **Annual, prepaid and auto-renewing:** 30 days before renewal or term end.

### Usage evidence

Read what the clue names; if there is nothing, ask Alex. **Uses are counted only from a clue's source or from Alex.** Claude never infers one.

| Evidence | Tool | Limit |
|---|---|---|
| Charges at the merchant (visits) | `get_wb_transactions` with the new `subscription_id` | a merchant can have several subscriptions, hence the filter |
| Workouts and yoga | `get_arnold_progress` | 93 days per call |
| Executions of an intention | `get_execution_history` | 50 rows |
| Other Alfred activity | `get_activity` | app, tag, dates |
| App-specific use | that app's own read tool, named in the clue | |

### Price, value, market check

- **Price:** `get_wb_subscriptions` with `include_prices`: changes since the last review, or the whole history on a first review.
- **Value:** amount paid in the period divided by uses. When uses can't be counted, say "not countable".
- **Market check:** stored as one short dated line with its source, in the review row. The detail stays in chat. Chat may search the web only during a review Alex started, naming the source, and never with account details in the search.

### Outcome

A verdict of `keep`, `downgrade`, `switch`, `shop_around` or `cancel`. `record_wb_subscription_review` saves the review and moves `review_date` together, and requires a next date unless the verdict is `cancel`. It never changes the subscription itself: cancel, downgrade and switch are separate proposed calls under the show-a-table rule.

### Weekly cleanup

In REVIEWS DUE, and for past-due reviews in TO DO:
- Each line shows the name and link, review date, term and auto-renew, price, last review date and verdict (or "never"), and whether the price changed since.
- It then says: "To review it, say in chat: review <name>."
- The "set a new date" call goes, because it lets a date move with no review. The cancel line stays as a proposed call.
- A new line counts active subscriptions with no review date.

### Seeding

Review dates and usage clues are seeded in chat after the deploy, through the tools, with a table and Alex's OK. No SQL, and not a CLI step.

### No app UI

The Money app gets no UI for clues or reviews in this slice.

## 4. Database objects

All additive: the live tools and app keep working before the deploy.

- **`wb_subscriptions.usage_clues`** (text): where and how to tell it is used. A new column because `notes` is already filled on nearly every active row with text for people.
- **`wb_subscription_reviews`** (new table): one row per review: date, period, uses, amount paid, cost per use, verdict, market check, next review date. RLS, explicit grants with nothing to anon or public, `register_table`.
- **`wb_record_subscription_review`** (new function): inserts the review and sets `review_date` in one transaction.
- **`wb_subscription_overview`**: `usage_clues`, `last_reviewed_on` and `last_verdict` appended to the end.

## 5. Tools

- **New:** `record_wb_subscription_review`, tier 2.
- `upsert_wb_subscription`: `usage_clues`.
- `get_wb_subscriptions`: the review fields, and `include_reviews`.
- `get_wb_transactions`: `subscription_id` (`wb_transaction_list` already has the column).

## 6. Clean-up in this slice

- **Weekly prompt:** the live task runs 2026-10-25a while the repo holds 2026-10-23d. Bring the live text in first, with no other change.
- **Money records open at their own link:** add the wb_ tables to `RECORD_SCREENS`. Whether `record_lookup_tables()` also needs them is unread at planning time; if it does, Step 13 stops and says so.
- **Remove `getFreeCash` and `getTrueCost`** from `src/money/moneyApi.js`; only their tests call them.
- **Move the real test scripts** to `supabase/tests/warren_buffet_p3/`: 134, 136, 138, 141 and 144. Phase 3's "134–144" was wrong: 135, 137, 140 and 143 are schema, and 139 and 142 belong to another project. Check for references by path before moving.
- **Close the history-file intention** once Alex confirms the files are gone. None were found within three levels of `tools/`.

## 7. Left for later

| Item | Why |
|---|---|
| Elise's Amazon export | Waits on a file from Elise; then an import run, not a build |
| Amazon digital orders | New reader work, with nothing in the skill needing it |
| The interval rule | Needs a view migration, and nothing shows a wrong finding from it |
| Project-wide privileges | Project-wide, not Money |
| Nightly email reader | Another project |
| Shared confirm component | Another project |
| Card-payment timing | No current need |
| A11 gaps | No current need |
| The reserve total | No current need |
| Red-flag help | No current need |

## 8. Sequencing

- **Step 15** needs no mcp file and can go at its turn: gitsync, drift check, claim its `db:` items, number the migration, queue it, verify, Checkpoint.
- **Step 16** waits on `nightly_counts-f8k`, which holds `supabase/functions/mcp/index.ts`, `index.test.mjs` and `.claude/skills/overwatch/SKILL.md`.
  1. Write and test the tool code in the `warren-buffet` tool files, which this thread holds.
  2. Stop until `nightly_counts-f8k` has finished and released `index.ts`.
  3. Alex runs gitsync, then a drift check.
  4. Claim `index.ts`, `index.test.mjs` and `db:deploy`.
  5. Register, deploy, verify, and Alex runs gitpush Checkpoint.
  Deploying without the sync would remove whatever `nightly_counts-f8k` has made live.
- **Step 18's overwatch line** is claimed at that step, and left for last if still held.
- **Step 21:** Alex does not paste the new prompt. Once it is in main, after Step 16's deploy, Claude updates the "Money cleanup" scheduled task itself and checks its PROMPT VERSION.
