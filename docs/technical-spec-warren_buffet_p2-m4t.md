# Warren Buffet Phase 2 — Technical Spec

Project code: `warren_buffet_p2-m4t`
Builds on: `docs/history/technical-spec-warren_buffet-w7b.md` (Phase 1, complete). Read its sections 2–4 (decisions, security rules, shared-context RLS) before anything else; they apply unchanged here.

---

## 1. Purpose

Phase 1 stores every account, balance, holding and raw transaction. Phase 2 turns raw transactions into answers to "where does the money go?":

1. **Clean** each transaction: a readable description, a merchant, and a **kind** (spending, income, transfer, refund, investment, interest, fee).
2. **Pair transfers** between Alex and Elise's own accounts, so moving money is never counted as spending or income.
3. **Tag** spending with tags in groups, on **splits**, so one charge can be part pet food, part clothes, and reports never double count.
4. **Rules** that tag automatically, created mostly by Claude in chat and by Alex's corrections in the UI.
5. **Recurring charges and subscriptions**, with price-change history, prepaid terms, bundles, and review dates.

Still out of scope: projects and planned items (Phase 3), orders and Amazon item detail (Phase 3b), insurance and tax documents (Phase 4), securities (Phase 5). Phase 2 must not paint those into a corner: splits carry a nullable `tax_year`, and the Tax tag group exists from the start.

---

## 2. What Phase 1 data taught us

Checked against the live data on 2026-10-09 (394 transactions):

| finding | consequence |
|---|---|
| SimpleFIN's `payee` is often already clean ("Amazon", "Whole Foods", "PetSmart", "Google Fi Wireless"), but sometimes wrong ("Facebook" for a pool company billed through Facebook; "Barrington Monterossa Payment Supponv"). | Merchant matching uses the payee first and the raw description second. Rules can match either. Payee is never trusted blindly. |
| `mcc` (merchant category code) is **always null**. | No category can come from the bank. Rules and Claude do all categorization. |
| Descriptions carry store numbers, phone numbers, reference numbers, city and state, HTML entities (`&#172;`), and trailing spaces. | A cleaning step produces `clean_description`; the raw `description` is never edited. |
| About half of all transactions are on Visa 3782. | The starter taxonomy and rules are built around that card's merchants first. |
| Transfers come in obvious pairs: the monthly mortgage-savings transfer (checking → Platinum Savings), the savings-for-taxes transfer (checking → Savings 5485), and card payments ("ONLINE PAYMENT THANK YOU" on a card, matched by an "ONLINE TRANSFER … TO VISA … 5819" in a bank account, not always checking). | Transfer pairing matches on opposite amounts across the household's own accounts within a few days, plus known payment phrases. |
| Retirement and brokerage accounts produce dividends, fund purchases and "BANK DEPOSIT SWEEP" rows every month. | All rows on `retirement` and `taxable_investment` accounts default to kind `investment` and stay out of spending and income. |
| Income arrives from sources such as an energy-royalty payer (Calyx Energy) and interest. | Income gets its own tags so the tax checklist in Phase 4 can find every payer. |
| Recurring charges are plentiful (phone, Workspace, ChatGPT, Kindle, Kindle Unlimited, gym dues, health insurance, HOA dues). Only ~90 days of history exist. | Monthly subscriptions can be detected automatically; annual ones cannot yet. The initial subscription list is built by Claude with Alex in chat (Step 7), then detection keeps it current. |
| Cost basis is not reported by Wells Fargo. | Unchanged; Phase 5. |

---

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| Where categorization logic lives | One Postgres function, `wb_process_transactions(ids uuid[])`, called by the sync after each upsert, by MCP tools after rule changes, and by the UI after corrections. **Security invoker**, not definer. | One implementation for three callers. Every caller already has full access to `wb_` rows under RLS (the sync's service role bypasses it; shared-context users can read and write every row), so invoker needs no hand-written RLS check and keeps `x-actor` audit attribution. |
| AI cost | No paid AI call per transaction. Rules do the routine work; uncategorized items wait in a **review queue**; Claude works the queue in chat through MCP tools and turns patterns into rules. | Alex does not want to pay for AI enrichment of every item. |
| Who wins | Manual tags, manual kinds and manual merchants always win. A rule never overwrites anything a person or Claude set. Claude-set values are marked `claude` and can be overwritten by Alex, never by a rule. | Human corrections must stick. |
| Tags live on splits | Every transaction has at least one split. A trigger creates the default split. Split amounts must sum to the transaction amount (deferred constraint trigger on `wb_splits`). When the sync changes the amount of an existing transaction, a single split follows it; a multi-split transaction is left alone and shows in the review queue as `split_mismatch`, so the sync never fails on it. | Allows item-level tagging later (Amazon) without schema change. |
| Exclusive groups | Enforced in the database: `group_id` and `group_exclusive` are copied onto `wb_split_tags` by trigger, with a partial unique index on `(split_id, group_id) where group_exclusive`. | Reports built on one exclusive group can never double count. |
| Tags in reads | Tags stay relational (needed for splits and exclusivity). Views and tool reads expose them as `tag_names text[]`, so tools filter with `.overlaps()` as the platform contract expects. | Contract rule: tags are text[] at the API surface. |
| Tag hierarchy | `wb_tags.parent_id`, same group only, no cycles. Reports roll children up to parents. | "Restaurants", "delivery", "groceries" can be viewed as "food" or separately, with no re-tagging. |
| Starter taxonomy | Claude proposes it from real data in Step 5; Alex refines; nothing is seeded in a migration except the four groups. | Alex wants to refine tags himself once data is in. Tags are data, not code. |
| Transfer pairing | Automatic when unambiguous; ambiguous or unmatched candidates go to the review queue. Paired rows get kind `transfer` and link to each other. Posted rows only. | A wrong pair hides real spending; better to ask. Pending rows are deleted when they post, which would orphan a pair. |
| Pending rows | Cleaned, given a merchant and a default kind, but never paired, never rule-tagged, and kept out of the review queue's tag and transfer reasons and out of the spending and cash-flow views. | The sync deletes a pending row when it posts under a new id; any tag or pair on it would be lost. |
| Audit | `wb_transactions` stays unaudited (the sync writes it daily). Every new Phase 2 table is audited. | Audit rows for `last_seen_at` bumps would bury the human edits. |
| Fees | `fee` counts as spending everywhere: in `wb_spending_by_tag` and in `wb_cash_flow_monthly`. | Bank fees are money spent. |
| Subscriptions | Detected monthly patterns create `watching` rows; Alex or Claude confirms them to `active`. Prices are recorded per change. | Detection on 90 days is useful but not trustworthy enough to act on alone. |

---

## 4. Data model (Phase 2)

All new tables follow Phase 1 §4: `id uuid` primary key, `user_id`, `context_id` (Money context `muvitejhrgt3rgi8t6q`), owner-or-shared-context RLS mirroring `public.intents`, `register_table(..., p_policy_mode => 'none', p_audited => true)`. Child tables copy `user_id` and `context_id` from their parent by trigger, so tools and the sync never have to. Edited tables have `updated_at` (stamped by `wb_touch_updated_at`). Every human-facing table has `notes text`. No real financial data in any committed file.

The kinds, used everywhere: `spend`, `income`, `transfer`, `refund`, `investment`, `interest`, `fee`.
The value sources, used everywhere: `default` (processing's own logic), `rule`, `claude`, `manual`.

### 4.1 `wb_transactions` (new columns; table stays unaudited)

| column | type | notes |
|---|---|---|
| clean_description | text | set by processing; never typed by hand |
| merchant_id | uuid references wb_merchants on delete set null | |
| merchant_source | text | check in sources; `claude` and `manual` are never changed by processing |
| kind | text | check in kinds; null until processed |
| kind_source | text | check in sources; `claude` and `manual` are never changed by processing |
| transfer_pair_id | uuid references wb_transactions on delete set null | both rows point at each other |
| transfer_candidate | boolean not null default false | processing found a transfer to pair but no unique match |
| matched_rule_ids | uuid[] not null default '{}' | rules that matched at the last processing; `hit_count` is computed from it |
| reviewed | boolean not null default false | Alex or Claude marked it done |
| processed_at | timestamptz | last time `wb_process_transactions` touched it |

Index on `transfer_pair_id`, and on `(kind, posted_at)`.

### 4.2 `wb_merchants` (audited)

`id, name` (unique case-insensitive), `match_patterns text[]` (case-insensitive substrings matched against payee then description), `default_kind` (check in kinds), `notes`. Example: name "Amazon", patterns `{amazon mktpl, amzn.com/bill, amazon.com}`.

### 4.3 `wb_tag_groups` (audited)

`id, name` unique case-insensitive, `exclusive boolean`, `required_for_kinds text[]` (which kinds must have a tag from this group to leave the review queue), `sort_order`, `notes`.

Seeded in the migration (structure only, no tags), owned by the Money context's own user:

| group | exclusive | required_for_kinds |
|---|---|---|
| Category | yes | `{spend, refund, income, fee}` |
| Who | yes | `{}` |
| Tax | no | `{}` |
| Label | no | `{}` (free labels such as a project or trip until Phase 3) |

Changing `exclusive` pushes the new value onto every `wb_split_tags` row of the group; turning it on fails if any split already has two tags from that group.

### 4.4 `wb_tags` (audited)

`id, group_id, parent_id` (same group only, no cycles; checked by trigger), `name` (unique within group, case-insensitive), `is_active`, `sort_order`, `notes`. Tags are deactivated, not deleted, once used (`on delete restrict` from `wb_split_tags`). A tag's `group_id` cannot change once it is used or has children.

### 4.5 `wb_splits` (audited)

`id, transaction_id` (cascade), `amount numeric(14,2)`, `description`, `tax_year int` (null = calendar year of the transaction), `position int`, `notes`.

- AFTER INSERT trigger on `wb_transactions` creates one full-amount split at position 0.
- Deferred constraint trigger on `wb_splits` (insert, update, delete): at commit, the splits of the transaction must number at least one and sum to its amount. Skipped when the transaction itself is gone (a cascade delete of a pending row).
- AFTER UPDATE OF amount trigger on `wb_transactions`: a single split takes the new amount; with two or more splits nothing changes and the review queue shows `split_mismatch`.
- Existing transactions get default splits in the migration.

### 4.6 `wb_split_tags` (audited)

`id, split_id` (cascade), `tag_id` (restrict), `group_id` and `group_exclusive` (copied from the tag's group by BEFORE trigger, never typed), `source` check in (`rule`, `claude`, `manual`), `rule_id` nullable (on delete set null), `created_at`. Unique `(split_id, tag_id)`. Partial unique index `(split_id, group_id) where group_exclusive`. `replaced_rule_id` (Step 4, nullable, on delete set null; never on a `rule` tag) records the rule whose tag a hand tag replaced or took over, for rule health (Step 10).

A hand removal of a rule tag is not remembered: the next reprocess adds it back. To stop a rule tagging something, change the rule, or tag the split by hand in that group.

### 4.7 `wb_rules` (audited)

| column | notes |
|---|---|
| name, priority, active | lower priority runs first (ties: oldest first); first matching rule per exclusive group wins |
| match | jsonb object, at least one key, only these keys: `merchant_id`, `payee_contains`, `description_contains`, `account_ids` (array), `amount_min`, `amount_max`, `kind`. All present keys must match. `*_contains` are case-insensitive substrings of the field (`description_contains` checks the raw and the clean description). `amount_min` / `amount_max` compare the **absolute** amount, inclusive. `kind` compares the kind before this rule's own `set_kind`. |
| set_kind | optional; check in kinds |
| set_merchant_id | optional |
| add_tag_ids | uuid[] |
| created_by | `claude`, `manual` |
| created_from_transaction_id | nullable, references `wb_transactions` on delete set null; the transaction a rule was made from by "Always do this" (§6.1) |
| hit_count, last_hit_at | computed by processing from `wb_transactions.matched_rule_ids`: the number of matching transactions and the date of the newest one; written only when changed, so a reprocess does not audit every rule |
| notes | |

### 4.8 `wb_subscriptions` (audited) and `wb_subscription_prices` (audited)

As designed in Phase 1 §5, finalized:

`wb_subscriptions`: `id, name, plan, merchant_id, billed_through_id` (self), `bundle_id` (self), `cadence` (`monthly`, `quarterly`, `annual`, `other`), `expected_amount`, `term_end_date`, `auto_renew`, `review_date`, `last_charged_on`, `next_expected_on`, `status` (`watching`, `active`, `paused`, `cancelled`), `owner`, `notes`.

`wb_subscription_prices`: `id, subscription_id, effective_on, amount, source` (`detected`, `manual`), `transaction_id` nullable, `notes`.

Transactions link to a subscription through `wb_transactions.subscription_id` (nullable, added in Step 7's migration).

### 4.9 Views (`security_invoker = true`)

All three use the Pacific date of `coalesce(posted_at, transacted_at)`; amounts keep the sign rule (money out negative).

- `wb_review_queue` — one row per transaction and reason, with the fields needed to decide (account, date, amount, raw and clean description, payee, merchant, kind, sources, `tag_names`). Reasons:
  - `no_kind` — kind is null (not yet processed).
  - `missing_required_tag` — a split has no tag from a group whose `required_for_kinds` holds the kind; `detail` names the group. Posted, unreviewed rows only.
  - `transfer_candidate` — `transfer_candidate` is true and the row is unpaired. Posted, unreviewed rows only.
  - `split_mismatch` — splits do not sum to the amount (shown even when reviewed).
  - `price_change`, `new_recurring` — added in Step 7.
- `wb_spending_by_tag` — per month, per group, per tag at `leaf` level and rolled up to the `top` parent, the sum of split amounts for kinds `spend`, `refund` and `fee`. Exclusive groups also get an untagged row (`tag_id` null), so a group's rows add up to total spending. Posted rows only; transfers, income and investments excluded by construction.
- `wb_cash_flow_monthly` — per month: `income` (kinds `income` and `interest`), `spending` (`spend` + `refund` + `fee`), `net`. Transfers and investments excluded; posted rows only. (Phase 3 builds burn rate and free cash on top of this.)
- `wb_transaction_list` (Step 4) — every transaction with `account_label`, `merchant_name`, `tag_names text[]` (filtered with overlaps), `split_count` and `needs_review` (true when the row is in the review queue; computed inline, kept in step with `wb_review_queue`). No `raw`. What `get_wb_transactions` and the UI list.
- `wb_rule_health` (Step 10) — one row per finding, with `finding`, merchant, rule and counts:
  - `duplicate_rules`: a merchant with two or more active rules;
  - `one_hit_rule`: a rule that matched once and never again in 30 days;
  - `overridden_rule`: a rule whose tags were overridden by hand two or more times;
  - `rule_missing`: a merchant tagged by hand three or more times with no rule;
  - `merchant_no_category`: a merchant with no category.

---

## 5. Processing: `wb_process_transactions(ids uuid[])`

Security invoker, `search_path = public, pg_temp`, executable by `authenticated` and `service_role` only. Returns counts as jsonb. Helpers, all pure and tested on invented values:

- `wb_clean_description(raw text, strip_location boolean)`
- `wb_is_transfer_phrase(text)`, `wb_is_interest_phrase(text)`, `wb_is_fee_phrase(text)`, `wb_is_p2p_phrase(text)` (Venmo, Zelle, Visa Direct, PayPal, Cash App; migration 107)
- `wb_default_kind(account_role, amount, raw_description, payee, merchant_default_kind)`
- `wb_transfer_match(a_account, a_amount, a_date, b_account, b_amount, b_date)` and `wb_pair_decision(forward_matches, reverse_matches)` → `pair`, `ambiguous` or `none`.
- `wb_rule_matches(match, account_id, amount, payee, description, clean_description, merchant_id, kind)`.

For each transaction in `ids`, in order:

1. **Clean** the description:
   - decode HTML entities (named and numeric);
   - drop URLs with a path (`g.co/helppay#CA`), masked account numbers and any short number after them (`XXXX1234`, `XXXXX6   937`), reference numbers (`REF #…`, `CONF …`, `*` followed by a code), phone numbers in the common shapes (including `888-5550123`), upper-case letter-digit codes of five or more (`PTQV5S`), dates (`ON 10/02/26`), and store numbers (`#123`, digit runs of four or more);
   - collapse whitespace and trim stray punctuation.

   When a merchant matched, also drop a trailing two-letter state code. The city stays: without a city list, removing "the word before the state" also removed merchant words (migration 107).
2. **Merchant** (skipped when `merchant_source` is `claude` or `manual`): the merchant whose pattern is contained in the payee, else in the description (pattern inside the text, never the reverse); the longest matching pattern wins, then the name. Source `default`; null when nothing matches.
3. **Default kind** (skipped when `kind_source` is `claude` or `manual`, or the row is already paired). Precedence:
   1. account role `retirement` or `taxable_investment` → `investment`;
   2. the merchant's `default_kind`;
   3. a transfer or card-payment phrase → `transfer`, unless the row is a payment to a person (`wb_is_p2p_phrase`), which falls through to the sign rules;
   4. a positive interest phrase → `interest`;
   5. a negative fee or interest-charge phrase → `fee`;
   6. a positive amount on a `credit_card` or `emergency_credit` account → `refund`;
   7. any other positive amount → `income`, and anything else → `spend`.
   Source `default`.
4. **Transfer pairing** (posted rows only; never a row whose `kind_source` is `claude` or `manual`). A candidate is an unpaired row whose kind is `transfer`. Its matches are unpaired, posted rows on another household account (synced, role not `closed` or `history_rollup`) with the opposite amount, within 5 days. The search also runs in reverse, from the match back to the candidates. Exactly one match both ways → pair both rows, kind `transfer`, source `default`, `transfer_candidate` false. Otherwise the candidate gets `transfer_candidate = true`, which puts it in the review queue. A payment to a person is also searched for a match and paired on exactly one, but is never flagged as a candidate.
5. **Rules** (posted rows only). Delete the transaction's existing `source = 'rule'` tags. Then run the active rules in priority order:
   - `set_kind` applies unless the kind is `claude`/`manual` or the row is paired; source `rule`.
   - `set_merchant_id` applies unless the merchant is `claude`/`manual`; source `rule`.
   - Tags go on the default split only when the transaction has a single split; multi-split transactions are left to humans.
   - In an exclusive group, the first rule wins, and a group that already holds a tag (from any source) is skipped. Open-group tags accumulate. Inactive tags are skipped.
   - Matching rule ids are stored in `matched_rule_ids`.
6. Set `processed_at`. Finally, recompute `hit_count` and `last_hit_at` for every rule from `matched_rule_ids`, updating only rows whose values changed.

Re-running is safe: the result depends only on the row, the rules and the merchants, never on how many times it ran.

The sync calls it for every new or changed transaction, plus any with `processed_at` null; a processing error is recorded on the run and does not fail it. A tool and a UI action re-run it over a date range after rules change.

---

## 6. MCP tools (Phase 2)

Platform contract as in Phase 1 (`ctx.db` only, list default 20 cap 50, filters before LIMIT, no raw jsonb). Every write sets `context_id` to the Money context. "read" means tier 1.

| tool | tier | purpose |
|---|---|---|
| `get_wb_transactions` (extended) | read | Adds `clean_description`, merchant name, `kind`, `kind_source`, `transfer_pair_id`, `reviewed`, `tag_names`; new filters `kind`, `merchant_id`, `tag` (overlaps), `needs_review`. |
| `get_wb_review_queue` | read | Items needing attention, grouped by reason, with the fields needed to decide. |
| `get_wb_tags` | read | Groups and tags as a tree, with usage counts. |
| `create_wb_tag` | 1 | New tag in a group, optional parent. |
| `update_wb_tag` | 2 | Rename, re-parent, deactivate, notes. |
| `get_wb_merchants` / `upsert_wb_merchant` | read / 2 | Merchants and their patterns. |
| `get_wb_rules` | read | Rules with hit counts. |
| `create_wb_rule` / `update_wb_rule` | 2 / 2 | Rules; update can deactivate. |
| `get_wb_rule_preview` | read | Dry run for a rule match, or the §6.1 plan for one transaction: merchant and pattern, count, too-narrow flag, existing rules. |
| `create_wb_rule_from_transaction` | 3 (with `propose`) | §6.1 "Always do this": the proposal is the plan; on `confirmed: true` it creates or updates the merchant, then creates or updates the merchant rule, and reprocesses. |
| `tag_wb_transactions` | 2, at most 25 rows per call | Add or remove tags on transactions' single split, source `claude` or `manual`. `defineTool` takes one static tier, so there is no tier-3 bulk form: bulk tagging is the job of rules. |
| `set_wb_transaction_kind` | 2 | Set kind (and optionally merchant) with source `manual` or `claude`; can pair or unpair transfers (both rows get the source, so processing leaves them alone). |
| `split_wb_transaction` | 2 | Replace a transaction's splits; amounts must sum. |
| `mark_wb_reviewed` | 2 | Mark transactions reviewed. |
| `reprocess_wb_transactions` | 2 | Re-run processing over a date range or ids. |
| `get_wb_spending` | read | Spending by tag group, month range, rolled up or leaf level. |
| `get_wb_cash_flow` | read | Monthly income, spending, net. |
| `get_wb_subscriptions` / `upsert_wb_subscription` / `record_wb_subscription_price` | read / 2 / 2 | Step 7. |
| `get_wb_rule_health` | read | Rows from `wb_rule_health`. Step 10. |

Tool descriptions state the sign rule and that manual tags are never overwritten by rules, and the rule tools say that rules match on merchants, not on exact descriptions. The new tools go in `_shared/tools/warren-buffet-p2.ts`; the Phase 1 file keeps its eight.

Multi-row writes are one transaction each, through invoker functions from the Step 4 migration: `wb_replace_splits`, `wb_set_transfer_pair`, `wb_apply_tags` and `wb_rule_preview`. PostgREST runs each call in its own transaction, so two separate calls could leave a split sum broken or a half-made pair.

### 6.1 Rules from a fix ("Always do this")

Used by the transaction detail UI (Step 6) and by the tools (Step 4).

1. A rule created from a fix matches on the **merchant**, never on the exact raw description. If the transaction has no merchant yet, the same action creates or updates the merchant first, with a short match pattern: the shortest distinctive word, editable before saving.
2. Before saving, show the match pattern and how many past transactions it would catch (a dry-run count). A count of 1 is flagged as probably too narrow.
3. If a rule already exists for that merchant, offer to update it instead of adding another.
4. The rule records the transaction it was created from (`created_from_transaction_id`) and `created_by`.

---

## 7. UI (Money section additions)

1. **Transactions tab**: list with filters (account, month, kind, tag, text, needs-review). Each row shows clean description, merchant, amount, kind chip, tags. Tap to open.
2. **Transaction detail**: raw and clean description, kind (editable), tags per group (exclusive groups as a single picker), split editor, transfer pair link, notes. After a manual change, offer **"Always do this for <merchant>"**, which follows §6.1 (merchant match, dry-run count, update an existing rule rather than add one), creates or updates the rule (`created_by` `manual`) and reprocesses matching rows.
3. **Review tab**: the review queue, newest first, grouped by reason, with one-tap actions.
4. **Spending tab**: a month picker, totals by Category (top level, expandable to children), and a cash-flow strip (income, spending, net) for the last 6 months. Desktop first; mobile must work.
5. **Subscriptions tab** (Step 8): active and watching subscriptions with cadence, current price, last price change, next expected charge, review date, bundle and billed-through relationships, notes.

Elise sees and edits everything, as in Phase 1.

---

## 8. Build steps

Each step ends with verification and stops for Alex. Database claims are taken just in time. `gitsync` is Alex's to run.

| step | what | who |
|---|---|---|
| 1 | Read-only plan: current state of wb-sync and the wb_ tools, Money UI structure, migration number, conformance, claims check, and any conflict with this spec. | CLI |
| 2 | Migration A: §4.1–4.7 tables and columns, triggers (default split, split sum, amount follow, exclusive tags, tag parent), seeded tag groups, default splits for existing rows, the §5 helpers and `wb_process_transactions` (security invoker), views `wb_review_queue`, `wb_spending_by_tag`, `wb_cash_flow_monthly`. No existing row is processed. Conformance CONFORMANT. SQL tests for cleaning, kinds and pairing in a read-only diagnostics file (invented values only). | CLI + Alex |
| 3 | wb-sync calls processing for new, changed and unprocessed rows; one-time reprocess of all existing rows. Verify transfer pairs (the two recurring transfers and the card payments pair; nothing else does), kinds on investment accounts, cleaned descriptions. | CLI + Alex |
| 4 | Phase 2 MCP tools from §6 except subscriptions and rule health, including the `get_wb_transactions` extension and §6.1. Deploy. Verification in a fresh claude.ai chat. | CLI + Claude |
| 5 | Starter taxonomy, in claude.ai: Claude reads all transactions and the review queue, proposes Category tags (with parents), Who tags, Tax tags, merchants and rules; Alex refines; Claude creates them and reprocesses; review queue shrinks to genuine edge cases. | Claude + Alex |
| 6 | UI: Transactions, transaction detail with "always do this", Review, Spending. | CLI + Alex |
| 7 | Migration B + tools: `wb_subscriptions`, `wb_subscription_prices`, `wb_transactions.subscription_id`, monthly-pattern detection in processing (watching rows, price-change reasons in the review queue). | CLI + Alex |
| 8 | Subscriptions seeding in claude.ai (including annual ones Alex knows about, prepaid terms, bundles and billed-through notes), then the Subscriptions tab UI. | Claude + Alex, then CLI |
| 9 | Phase 2 review; Phase 3 build steps. | Claude + Alex |
| 10 | Rule health and a weekly cleanup task: view `wb_rule_health` (§4.9), tool `get_wb_rule_health`, and a weekly scheduled claude.ai task. The task reads the review queue and rule health, then creates one Alfred inbox item with proposed rule fixes and other cleanup for Alex to approve. Other data-cleanup checks may be added to it later. | CLI, then Claude + Alex |

---

## 9. Open items

- Elise's current 401(k) balance (Phase 1 carry-over).
- Amazon order detail waits for Phase 3b; until then Amazon charges are tagged as a whole or split by hand.
- The guard bug for chat prompts with run tags (Alfred item ce6c2190).
- Code comments in `wb-sync/index.ts`, `_shared/wb-sync-core.ts`, `_shared/tools/warren-buffet.ts`, `mcp/index.ts` and `src/money/moneyApi.js` still cite the Phase 1 spec at its old path; update each when its step touches the file.
