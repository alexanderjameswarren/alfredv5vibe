# Warren Buffet — Technical Spec

Project code: `warren_buffet-w7b`
Status: Phase 1 ready to build. Phases 2–5 designed at table level only; their build steps get written after Phase 1 data is in.

---

## 1. Purpose

Warren Buffet is the household money app inside Alfred. It answers, in order of importance:

1. **Can we afford it?** Are we cash-flow positive or negative, how fast is cash draining, and how much is genuinely free to spend after everything already earmarked (taxes, insurance, contractor bills, planned projects) and a safety floor.
2. **Where does the money go?** Spending by category, recurring charges and subscriptions, price increases, leaks, and item-level detail for Amazon and other online orders.
3. **Are retirement and investments healthy?** Holdings, fees, and anything unusual — reviewed monthly or quarterly.
4. **Are we ready for the CPA?** Tax-relevant spending tagged, tax payments tracked by tax year, and every expected tax document checked off.
5. **Insurance** — every policy, contact, and claim in one place.

**This project builds the data and the UI. It does not answer financial questions.** The analysis (skills, prompts, scheduled reviews) is a later project that reads what this one stores.

---

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Data source | SimpleFIN Bridge (paid, personal). One access URL covers all connected institutions. | Built for one person pulling their own data. |
| Where the UI lives | A **Money** section inside the Alfred app. | Reuses sign-in, shared contexts, and Elise's existing access. |
| Where the sync runs | A scheduled **Supabase Edge Function**, daily. | Runs when the desktop is off. |
| Sharing with Elise | Reuse Alfred's shared-context mechanism. Every `wb_` row carries `context_id` = the **Money** context (`muvitejhrgt3rgi8t6q`, already created, `shared = true`). | Same rule as items, intents, events. No new household layer. |
| Table prefix | `wb_` | |
| Categorization | Tags in groups, attached to **splits**, not transactions (Phase 2). | One charge can be part pet food, part clothes. Exclusive groups prevent double counting. |
| Free-text context | A plain `notes` column on every human-facing table. | Claude reads notes before any analysis (e.g. "Apple TV is billed through Amazon Prime, bundled with Peacock"). |
| Sign convention | For every account, money in is positive, money out is negative. Credit card charges are negative; payments are positive. | One rule for all math. Verify against SimpleFIN in Step 3. |
| Raw data | Never edited. Corrections live in separate columns and tables. | A resync must never wipe human work. |

---

## 3. Security rules (apply to every step)

1. **No real financial data in any committed file.** No balances, account names, last-four digits, transactions, or the SimpleFIN URL in migrations, seeds, tests, docs, or fixtures. Real data enters only through the sync, the MCP tools, or the Supabase SQL editor run by Alex.
2. **The SimpleFIN access URL lives only in Supabase secrets** (`SIMPLEFIN_ACCESS_URL`) and in the git-ignored `tools/warren-buffet/.env`. Alex sets the secret himself. The CLI never reads, prints, or logs it, and never prints a `.env` file.
3. **Never log credentials.** The sync function must not log the access URL or the request URL it builds from it.
4. Store only last-four digits of account numbers. SimpleFIN does not provide full numbers; keep it that way.
5. Views are created with `security_invoker = true` so row-level security applies through them.

---

## 4. Shared-context row-level security (every `wb_` table)

Every `wb_` table has these two columns:

```sql
user_id    uuid not null default auth.uid() references auth.users(id) on delete restrict,
context_id text not null references public.contexts(id),
```

Child tables (snapshots, transactions, and so on) carry their own copy of both, copied from the parent, so one simple policy applies everywhere instead of lookups through parents. This mirrors Alfred's own tables.

Register with custom policy mode, then write the policy, mirroring `public.intents`:

```sql
select platform.register_table(
  'public.wb_example',
  p_policy_mode => 'none',
  p_audited     => true,
  p_notes       => 'App: Warren Buffet. <what this table is>. Owner OR shared-context RLS (mirrors intents).'
);

create policy wb_example_access on public.wb_example
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));
```

**Writes from the sync function** run as the service role, where `auth.uid()` is null. The function sets `user_id` and `context_id` explicitly: `context_id` from the `WB_CONTEXT_ID` secret, and `user_id` read from that context row's own `user_id`. No user id is hard-coded.

**Known limit:** "shared" means every signed-in user, not specifically Elise. Safe while the allowlist is two people. If anyone else is ever added, replace `contexts.shared` with a per-context member list first.

---

## 5. Full data model (all phases)

Phase 1 tables are fully specified in §6. Later phases are listed here so Phase 1 does not paint them into a corner; their columns get finalized when they are built.

### Phase 1 — accounts, balances, raw transactions
- `wb_accounts` — every account, synced or manual, with a role.
- `wb_balance_snapshots` — one balance per account per day.
- `wb_holding_snapshots` — one row per investment position per day.
- `wb_transactions` — raw transactions exactly as SimpleFIN reports them. **Stored from day one even though categorizing is Phase 2**, because SimpleFIN only ever returns the last 90 days. Every day not stored is history lost.

### Phase 2 — cleanup, splits, tags, rules, merchants, subscriptions
- `wb_transactions` gains: `clean_description`, `merchant_id`, `kind` (spend, income, transfer, refund, investment, interest, fee), `transfer_pair_id` (links the two sides of a move between own accounts), `reviewed`.
- `wb_splits` — one or more per transaction; amounts must sum to the transaction. Default single split created automatically. Carries `tax_year` (nullable; null means the calendar year of the transaction date).
- `wb_tag_groups` — `exclusive` boolean. Exclusive groups (Category, Who) allow one tag per split; open groups (Tax, Project labels) allow many.
- `wb_tags` — with `parent_id`, so "restaurants", "delivery", "groceries" roll up to "food" without re-tagging. Alex refines the tag list once real data is in.
- `wb_split_tags` — which tags are on which split, with `source` (rule, claude, manual) and `rule_id`. Manual tags are never overwritten by rules. Exclusivity enforced in the database.
- `wb_merchants` — one clean name plus the messy bank-description patterns that map to it.
- `wb_rules` — priority, match conditions, actions, `hit_count`, `active`, `notes`.
- `wb_subscriptions` — service, plan, charging merchant, `billed_through_id` (self-reference: Apple TV billed through Prime), `bundle_id` (self-reference: parts of a bundle), cadence (monthly, quarterly, annual, other), `term_end_date` (prepaid contracts — a missing monthly charge before this date is expected), `auto_renew`, `review_date` (default ~30 days before renewal; feeds Alfred reminders), status (active, paused, cancelled, watching), `notes`.
- `wb_subscription_prices` — one row per price change: date, amount, source (detected, manual). Sync flags any charge that differs from the latest price.

### Phase 3 — projects, planned items, free cash
- `wb_projects` — e.g. bathroom claim, designer phase, a vacation. Status, optional budget, `notes`.
- `wb_planned_items` — future money in or out: amount, expected date, counterparty, optional project, stage (draft, estimate, quoted, invoiced, paid, cancelled), `tax_year`, `notes`. Draft = "what if" scenario. Active subscriptions and insurance premiums generate planned items.
- `wb_planned_matches` — links planned items to the splits that paid them, with amount applied (partial payments, insurance checks in pieces).
- `wb_settings` — small key-value settings such as the safety floor.
- Views: monthly cash flow, burn rate (one-off projects separated out), free cash = spendable cash − earmarked − safety floor + expected inflows.

### Phase 3b — orders
- `wb_orders` — merchant, order number, date, order URL, buyer (Alex, Elise), total, source (email, clip, export), `source_inbox_id`, `notes`.
- `wb_order_items` — description, quantity, price, suggested tags, returned/refunded.
- `wb_order_matches` — orders to card charges with amount (Amazon charges per shipment).
- Flow: order email forwarded → Alfred inbox ($$ tab) → parsed into an order → inbox item archived. If the email lacks item detail, the order is flagged with its URL; Alex clips the order page; the clip fills the same order (matched by order number). History backfill from Amazon's "Request your data" export (Alex's requested; Elise's pending — placeholder until then).

### Phase 4 — insurance and tax documents
- `wb_policies`, `wb_claims` (linked to a project), `wb_contacts` (agent, CPA, contractor, designer, adjuster), `wb_documents` (private storage bucket; linked to policy, claim, project, planned item, or tax document; carries `tax_year`).
- `wb_tax_documents` — expected-documents checklist per tax year: form type, issuer, linked account, expected-by date, status (expected, received, sent to CPA, not coming), document link, `notes`. Generated each year from accounts and income sources. Feeds the CPA handoff: payment history by tax year, tax-tagged expense list, generated document index.

### Phase 5 — investments
- `wb_securities` — one row per symbol: name, fund type, expense ratio, looked-up date, `notes`. Supports the retirement fee and performance review.

---

## 6. Phase 1 tables (build exactly)

All money columns are `numeric(14,2)` except share counts. All tables include `created_at timestamptz default now()` and, where rows are edited, `updated_at timestamptz default now()`. All tables include `user_id` and `context_id` per §4.

### 6.1 `wb_accounts` (audited)

| column | type | notes |
|---|---|---|
| id | uuid pk default gen_random_uuid() | |
| source | text not null | check in (`simplefin`, `manual`) |
| external_id | text | SimpleFIN account id. Null for manual. Unique with `source` where not null. |
| institution | text | from SimpleFIN `org.name`, or typed for manual |
| name | text not null | as reported; never edited by humans |
| display_name | text | human-editable label; UI shows this when set |
| last4 | text | parsed from the name when present |
| owner | text | check in (`alex`, `elise`, `joint`); null until assigned |
| role | text not null default `unassigned` | check in (`unassigned`, `spending_cash`, `reserve_cash`, `credit_card`, `emergency_credit`, `loan`, `retirement`, `taxable_investment`, `rewards`, `history_rollup`, `closed`) |
| currency | text not null default `USD` | |
| credit_limit | numeric(14,2) | manual; e.g. HELOC line, which SimpleFIN reports as $0 |
| reward_unit | text | e.g. `points`, `miles`; rewards accounts only |
| reward_value_per_unit | numeric(10,6) | dollar value per unit, chosen by Alex; null = don't convert |
| expires_on | date | rewards expiration, or CD maturity |
| active_from | date | for `history_rollup` accounts, first snapshot date |
| active_until | date | for `history_rollup` accounts, the day before synced history starts, so rollups never double count with real accounts |
| is_hidden | boolean not null default false | hide closed or dormant accounts |
| last_synced_at | timestamptz | set by the sync |
| notes | text | |

**`history_rollup` role:** Alex's existing spreadsheet tracks some lines as combined totals ("wells", "credit card", "cnb") going back to April 2025. These are imported as manual accounts with role `history_rollup`, valid only up to `active_until`. Net-worth history uses them before that date and real accounts after. No real values go in the repo; Claude enters them through the MCP tools in Step 8.

### 6.2 `wb_balance_snapshots` (not audited — sync-managed daily series)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| account_id | uuid not null references wb_accounts(id) on delete cascade | |
| as_of | date not null | local date, America/Los_Angeles |
| balance | numeric(14,2) not null | |
| available_balance | numeric(14,2) | |
| reported_at | timestamptz | SimpleFIN `balance-date` |
| source | text not null | check in (`sync`, `manual`, `import`) |
| notes | text | |

Unique `(account_id, as_of)`. The sync upserts, so a second run the same day replaces that day's sync row. A sync never overwrites a `manual` or `import` row.

### 6.3 `wb_holding_snapshots` (not audited)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| account_id | uuid not null references wb_accounts(id) on delete cascade | |
| as_of | date not null | |
| external_id | text not null | SimpleFIN holding id |
| symbol | text | |
| description | text | |
| shares | numeric(20,6) | |
| market_value | numeric(14,2) | |
| cost_basis | numeric(14,2) | |
| purchase_price | numeric(14,4) | |
| currency | text | |

Unique `(account_id, as_of, external_id)`.

### 6.4 `wb_transactions` (not audited — raw mirror; Phase 2 adds human columns and turns audit on for those writes via tools)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| account_id | uuid not null references wb_accounts(id) on delete cascade | |
| external_id | text not null | SimpleFIN transaction id |
| posted_at | timestamptz | |
| transacted_at | timestamptz | |
| amount | numeric(14,2) not null | |
| description | text | raw, unedited |
| payee | text | |
| memo | text | |
| mcc | text | merchant category code |
| pending | boolean not null default false | |
| raw | jsonb not null | full SimpleFIN object; excluded from list reads |
| first_seen_at | timestamptz not null default now() | |
| last_seen_at | timestamptz not null default now() | |

Unique `(account_id, external_id)`. Index on `(account_id, posted_at desc)`.

**Pending handling:** a pending transaction often reappears with a new id once posted. If a later fetch covers a pending row's date and does not return it, the sync deletes that pending row. Posted rows are never deleted by the sync.

### 6.5 Phase 1 views (`security_invoker = true`)

- `wb_account_latest` — each account with its most recent snapshot (balance, available, as_of), role, owner, display name, staleness (days since last snapshot).
- `wb_net_worth_daily` — per date, totals by role group: spending cash, reserve cash, credit owed, retirement, taxable investments, rewards (converted only where `reward_value_per_unit` is set), and overall net worth. Uses `history_rollup` accounts only within their active window.

---

## 7. The sync (`wb-sync` Edge Function)

**Secrets:** `SIMPLEFIN_ACCESS_URL` (set by Alex), `WB_CONTEXT_ID` = `muvitejhrgt3rgi8t6q`.

**Each run:**
1. Open a `platform_runs` row (app value decided in Step 1).
2. Choose the window: start = later of (today − 89 days) and (last successful run − 10 days). The overlap catches late-posting and changed transactions; 89 avoids SimpleFIN's 90-day cap message.
3. `GET {access}/accounts?start-date=<unix>&pending=1` using the credentials embedded in the access URL as basic auth. One request per run; SimpleFIN rate-limits heavy use.
4. Upsert `wb_accounts` by `(source='simplefin', external_id)`. New accounts arrive with role `unassigned`. Never overwrite human columns (`display_name`, `owner`, `role`, `credit_limit`, reward fields, `is_hidden`, `notes`).
5. Upsert today's `wb_balance_snapshots` row per account (`source = sync`).
6. Upsert today's `wb_holding_snapshots` rows.
7. Upsert `wb_transactions` by `(account_id, external_id)`, updating `last_seen_at`; apply the pending rule in §6.4.
8. Close the run with counts (accounts, new transactions, updated transactions, holdings) and any SimpleFIN `errors` strings.

**Errors:** SimpleFIN returns an `errors` array. The 90-day-cap message is informational. Any other message (usually a bank connection needing re-login) marks the run as partial and creates one Alfred inbox item for Alex, following whatever convention Step 1 finds for system-created inbox items. Never more than one open inbox item per distinct error.

**Schedule:** once daily, early morning Pacific, using the same scheduling mechanism existing jobs use (Step 1 finds it), plus a `platform_schedules` definition so staleness is visible.

**Manual run:** the function can be invoked on demand for testing.

---

## 8. Phase 1 MCP tools (Alfred MCP server, `defineTool`)

Follow the platform contract: `ctx.db` only, tiers declared, list limits default 20 cap 50, filters before LIMIT, no `raw` jsonb in list reads.

| tool | tier | purpose |
|---|---|---|
| `get_wb_accounts` | read | Accounts with latest balance, role, owner, staleness. Filters: role, owner, include_hidden. |
| `get_wb_balance_history` | read | Snapshots for one account, or totals for a role, over a date range. |
| `get_wb_net_worth` | read | Rows from `wb_net_worth_daily` over a date range. |
| `get_wb_transactions` | read | Filters: account, date range, text search on description/payee, min/max amount, pending. |
| `get_wb_holdings` | read | Latest holdings per account, or a given date. |
| `update_wb_account` | 2 | Edit human columns only: display_name, owner, role, credit_limit, reward fields, expires_on, active_from/until, is_hidden, notes. |
| `create_wb_manual_account` | 1 | Create a manual account (401k, HELOC limit holder, rewards, history rollups). Always in the Money context. |
| `record_wb_balance` | 1 (new date) / 2 (replacing an existing manual or import row) | Manual or import balance for a manual account on a date. Refuses to touch `sync` rows. |

Sync health is read with the existing `get_platform_runs` / `get_platform_schedules` tools, once the app value from Step 1 is allowed.

---

## 9. Phase 1 UI (Money section in Alfred)

Mobile-first; must work on a phone.

1. **Overview:** totals by role group (spending cash, reserve cash, credit owed, retirement, taxable investments, rewards), net worth, and a sync status line (last successful sync; warning if older than 36 hours or any account is stale or erroring).
2. **Accounts list:** grouped by role; display name, institution, last four, owner, latest balance. `unassigned` accounts float to the top with a prompt to assign a role. Hidden accounts behind a toggle.
3. **Account detail:** balance history chart, recent transactions (newest first, pending marked), holdings for investment accounts, editable human fields, notes.
4. **Manual accounts:** add one; record a balance for a date.
5. **Net worth chart:** from `wb_net_worth_daily`, including the spreadsheet history.

Placement must follow the feature-folder structure from the Alfred.jsx split project (`alfred_split-v8n`); Step 1 checks its status and the conventions.

---

## 10. Phase 1 build steps

Each step ends with a verification section and stops for Alex. Database claims are taken just in time at the step that needs them.

| step | what | who |
|---|---|---|
| 0 | `tools/warren-buffet/` probe folder, ignores, SimpleFIN claimed and verified. | done |
| 1 | Read-only plan: scheduling mechanism used by existing jobs; how Edge Functions are laid out and deployed; MCP server structure and an example tool to mirror; `platform_runs.app` / `platform_schedules.app` allowed values; convention for system-created inbox items; Alfred.jsx split status and where a Money feature folder goes; full file list; claims check. | CLI |
| 2 | Migration: four tables, policies, indexes, two views, `register_table` calls. Conformance check must report CONFORMANT. | CLI, then Alex verifies |
| 3 | `wb-sync` Edge Function. Alex sets both secrets himself. Manual invoke. Verify counts, sign convention on cards, idempotency (second run adds no duplicates). | CLI + Alex |
| 4 | Daily schedule, `platform_schedules` row, error-to-inbox path (tested with a simulated error, not a real broken connection). | CLI |
| 5 | MCP tools from §8. Deploy. | CLI |
| 6 | Assign roles, owners, display names; hide dormant accounts; create manual accounts (Elise's 401(k), HELOC limit, Wells Fargo rewards points, AA miles with expiration). Done in the claude.ai thread through the new tools. | Claude + Alex |
| 7 | Money section UI from §9. | CLI |
| 8 | Spreadsheet backfill: `history_rollup` accounts and historical snapshots entered through the tools from Alex's spreadsheet. No values in the repo. | Claude + Alex |
| 9 | Phase 1 review: what the data taught us; write Phase 2 build steps. | Claude + Alex |

---

## 11. Open items (not blocking Phase 1)

- Elise's 401(k): find a way to connect it; manual account until then.
- Tag list, safety floor, whether house and cars count toward net worth, which tax tags the CPA wants — all decided in their phases.
- $$ inbox tab depends on the inbox tag rework.
- Elise's Amazon data export: placeholder until she requests it.
- Insurance and the scan/zip/index CPA handoff are later projects that will read Phase 4 tables.
