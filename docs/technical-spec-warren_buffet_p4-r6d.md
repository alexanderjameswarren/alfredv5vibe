# Warren Buffet Phase 4: technical spec

Project code: `warren_buffet_p4-r6d`. Progress: [progress-warren_buffet_p4-r6d.md](progress-warren_buffet_p4-r6d.md).

## Privacy rule

The history files are real bank, card and Amazon data in the **main checkout's** `tools/warren-buffet/history/`, ignored only through `.git/info/exclude`.

- Never copy them into the worktree or any tracked path.
- No amounts, descriptions, payees, order items or account numbers in docs, reports or test fixtures. Tests use invented data.
- Reports give only file names, column headers, row counts and date ranges.
- After Phase 4 the files are deleted. An Alfred intention tracks this.

## Goal

1. Fix the interval rule behind rule health.
2. Import Wells Fargo and CNB history from before SimpleFIN sync began, without it touching the review queue, To do or planned matching.
3. Let Claude in chat scan that history once and compare burn-rate windows.
4. Break Amazon spending into real categories instead of one lump.

## Decisions

### P4-D1: interval rule
Use the most common gap between a merchant's linked charges. Gaps are rounded: up to 10 days counts as one week, 11 to 17 days as two weeks, and longer gaps to whole months, so 30 and 31 days count as the same. On a tie, take the longer gap. With too few charges, fall back to today's chain.

This also fixes `wb_rule_health_all` (migration 156, line 44), where the comment says "most frequent" but the code uses `min()` of the subscription intervals. It is the only place that picks one interval: detection is monthly-only, and `wb_refresh_subscriptions` uses the row's own interval.

### P4-D2: cutoffs
Import only rows dated before each account's first synced day. From the live data:

| Account | Import rows before |
|---|---|
| Visa 3782 | 2026-07-10 |
| Visa 5819 | 2026-07-10 |
| Platinum Savings 2756 | 2026-07-10 |
| Premier Checking 9881 | 2026-07-13 |
| Savings 5485 | 2026-07-21 |
| CNB cash savings | 2026-08-04 |
| Everyday Checking 5239 (Elise's; no synced rows) | every row |
| Closed CNB account (hidden; no synced rows) | every row |

The script reads each cutoff from the database at run time. These dates are not hard-coded. It records each account's earliest date in `wb_accounts.history_from`.

### P4-D3: CNB
The file holds 19 rows. 17 were imported as they are; the 2 on or after the 8560 cutoff were already synced. That count is expected: CNB is emergency cash, used mainly for transfers to Wells Fargo and the occasional check. The rows map to CNB cash savings and the hidden closed CNB account.

### P4-D4: imported rows
- `wb_transactions.source` is `history_import`; the default is `sync`.
- `external_id` is prefixed so it can never collide with a SimpleFIN id, and hashes account, date, amount, description and occurrence number. The occurrence number is needed because identical rows exist in the files.
- CHECK # goes in `memo`. Every STATUS maps to posted.

Imported rows run through normal processing and tag rules, and count for interval data. They are kept out of:

| Kept out of | Where |
|---|---|
| Review queue and needs_review | base of `wb_review_queue`, and `wb_transaction_list.needs_review`. `reviewed = true` alone is not enough, because `no_kind`, `split_mismatch` and `planned_match` ignore it |
| Card fee and interest flags | `wb_action_items` (migration 158, line 314). An explicit filter, because the 90-day lookback alone could reach a quiet account's imported rows |
| Planned-match suggestions | `wb_suggest_planned_matches`, reached from `wb_process_transactions` |
| Planned-item backdating | `wb_planned_start_from_history` |
| Rule-health findings | `merchant_no_category`, `too_broad`, `often_overridden` in `wb_rule_health_all` |

### P4-D5: credentials
The import script reads the service-role key from an environment variable set in Alex's shell for the run only. It is never written to a file.

### P4-D6: tools
- `get_wb_transactions` gets a source filter. `wb_transaction_list` must expose `source`, which Step 4 adds. A tool's parameters and description are registered in `supabase/functions/mcp/index.ts`, so this needs that file.
- The filter is built in Step 8b with the Amazon read tool, so one step claims `index.ts` and deploys `mcp` once.
- `get_wb_true_cost` is unchanged. There is no `as_of` option: Claude compares burn-rate windows with read-only SQL.

### P4-D7: Amazon
The goal is spending categories, not reconciliation. Amazon orders hold food, clothes, entertainment and more, and one "Amazon" lump hides how spending is really distributed. Matching to card charges is only a means to splitting a charge by item category.

- **Range:** orders from September 2024 only. Refund Details included. Digital Content Orders in a later pass.
- **Stored:** only order id, order and ship dates, ASIN, product name, department, quantity, item amounts, status and payment method type.
- **Never stored:** addresses, tracking, gift fields, coordinates, photos or invoices.
- **Buyer:** a buyer column holds the place for Elise's orders later.
- **Grouping:** items group by order and ship date, because Amazon charges once per shipment.
- **Tables:** `wb_orders`, `wb_order_items`, `wb_order_matches`, from the Phase 1 design. `wb_order_matches` is built only on path A.
- **Categories:** Amazon's department maps to Warren Buffet tags. Claude tags the rest from product names in chat.

**Match test first (Step 8a).** A dry run that writes nothing reports how many Amazon card charges match one shipment exactly by amount within 0 to 3 and 0 to 7 days, and how many don't. Alex and Claude decide from that rate before anything is written. Build only after the decision (Step 8b).

- **Files:** the export's `Your Amazon Orders/Order History.csv` and `Your Returns & Refunds/Refund Details.csv`, read in place.
- **Line amount:** `Total Amount`, which already includes tax, shipping and discounts.
- **Left out of matching:** cancelled rows, rows with no ship date, shipments totalling zero, and other sites. `Website` is read only for this filter and never stored. Whole Foods orders are in the same file, and their charges carry a Whole Foods name.
- **Several ship dates:** one row can name more than one; its total cannot be split, so it sits on the earliest.
- **Amazon card charge:** a settled debit on a `credit_card` account whose payee or description contains "amazon" or "amzn", dated from 2024-09-01 up to 7 days after the last order in the export. Transfers, Prime, digital, web services and tips are counted but not matched.
- **Charge date:** posted date, or transacted date where a row has no posted date, as a Pacific date. Imported rows have only a posted date.

- **Path A, most match:** matched charges are split by item category. Unmatched charges stay tagged Amazon.
- **Path B, few match:** a breakdown-only view of Amazon spending by category, with no matching.

**Decided in Step 8b: path A.** The match test found 293 Amazon charges; at 0 to 3 days, 233 (80%) match one shipment.

- **Match rule:** the 0 to 3 day window, exact amount, one shipment only. A shipment two charges would claim stays unmatched. Unmatched charges stay tagged Amazon.
- **Whole Foods items are stored too,** with the same allowed columns and a site column (`amazon` or `wholefoods`). They are not matched or split; their purpose is lookup, such as when something was last bought or what it has cost over time. Their range is the same, from September 2024.
- **Splits come later (Step 8c),** after Claude has given the items categories in chat. Step 8b writes none.
- **Tables:** `wb_orders` holds one row per shipment. `wb_order_items` holds the product lines, with unit and line amounts, order and ship dates, buyer and a category tag. `wb_order_matches` links a shipment to its charge. Shipments totalling zero are stored but never matched.
- **Refunds:** `wb_order_items` holds `refunded_amount` and `refund_date`, filled by the writer from Refund Details for in-range orders, so refunded items don't look bought. That file names an order, not an item, so a refund lands on the order's only line, or on a line not yet refunded whose total is exactly the refund. Anything else is counted as unplaced and never guessed. Alex decided in Step 8d: the refunds that can't be tied to an item (7 of 21) are left out, with no order-level refund storage.
- **The match rule is also held in the database:** a trigger refuses a match unless it is an Amazon shipment above zero, the charge is exactly its amount, and `days_apart` is the real gap. Leaving both charges unmatched when two claim one shipment is the writer's rule.
- **Read tool:** `get_wb_order_items`, searching by product name words, site and date range.

### P4-D8: chat review
After the Wells Fargo and CNB import, Claude in chat does a one-time review scan and a fee and interest scan, and compares the burn rate over the current window with a 12-month window. The scans produce a summary only: nothing is added to the queue or To do. Burn-rate windows are compared with read-only SQL. No code beyond P4-D6.

The burn-rate window is the 3 full Pacific calendar months before today's month (`wb_burn_rate_on`, migration 137). Imported rows fall outside the live window, so the import does not move today's burn rate.

### P4-D9: where imported rows reach on purpose
Imported rows are allowed to reach three things:

- **Transfer pairing across the cutoff:** a payment can be imported on one side and synced on the other.
- **Subscription linking and date refresh:** this adds price history, and the last-charged date only moves forward.
- **Subscription detection's 120-day lookback:** the rows are real charges.

## Schema changes

- `wb_transactions.source`: `sync` or `history_import`, default `sync`.
- `wb_accounts.history_from`: the account's earliest imported date.
- Step 8 tables, per P4-D7.

## Import script

A new local Node script under `tools/warren-buffet/import/`, dry-run first. It takes the history folder path as an argument and writes nothing to the repo. Processing runs in batches through `wb_process_transactions`.

- **Wells Fargo parser:** columns DATE, DESCRIPTION, AMOUNT, CHECK #, STATUS.
- **CNB parser:** six filter lines, then POSTED DATE, MERCHANT, ACCOUNT NUMBER, TRANSACTION TYPE, CATEGORY, CREDITS, DEBITS. Dates read "Mon DD YYYY", amounts sit in two columns, and the account comes from the row.
- **Re-runs:** the external id makes a second run insert nothing.
- **Dry-run output:** counts and dates per account, and a boundary check against each cutoff. Never row contents.
- **Import order:** Elise's small Wells Fargo file first, then the other Wells Fargo files, then CNB.

## Out of scope

- Money records opening at their own link
- "Paid by card" timing
- The nightly email reader
- Logged-out access cleanup
- The chat skill fixes
- Small clean-ups: moving test scripts, unused functions, shared confirm component

**Closed already, no work here:**
- **Garbled card name:** fixed in Phase 3 (A54, `cleanName` in `wb-sync-core.ts`, live as wb-sync v8).
- **14-day "never fires" bug:** fixed by migrations 155 and 156.

## House rules

- Platform rules from the mcp-platform skill: explicit grants to authenticated and service_role on every new table, view and function, nothing to anon or public; `register_table` for new tables; `check_platform_conformance` CONFORMANT at the end of every migration step.
- New SQL as `_pending_` files, numbered only at its database step after gitsync.
- Help text ships in the same step as the feature it explains.
- Any new UI follows existing Alfred patterns (confirmations as modals, like closing an execution).
