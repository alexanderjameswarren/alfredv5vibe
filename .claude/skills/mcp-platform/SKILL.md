---
name: mcp-platform
description: House rules for the Alfred / Ken / Homer MCP platform layer. Read BEFORE any migration adding a new table, view or function (explicit grants, no anon), any Edge Function tool, or any change touching `_shared/platform.ts`. Covers the never-import-Supabase-directly rule, the write-tier taxonomy for `defineTool`, the `platform.register_table()` requirement, tool house style (params / envelope / errors / naming), and the mandatory `check_platform_conformance` step at the end of every migration block.
---

# MCP Platform Layer — House Rules

Skill version: 2026-10-27a

> **Source of truth: `COMMENT ON SCHEMA platform`** (queryable via `get_database_schema`) and `docs/technical-spec-platform-layer.md` in the alfred-v5 repo. When they disagree with this skill, they win — this skill is the model-facing summary, not the contract.

## When this skill applies

Read this file **before**:

- Writing a migration that creates any table in `public` (or a new schema).
- Adding a new MCP tool in `supabase/functions/mcp/index.ts` or any `_shared/tools/*` file.
- Modifying `supabase/functions/_shared/platform.ts`.
- Answering any question about how Alfred's audit log, budget guard, or conformance check works.

If the task doesn't touch tools, tables, or the platform module, skip this skill.

---

## Rule 1 — Never import the Supabase client directly in a tool file

The **only** path to the database from an MCP tool is `ctx.db`, handed to your handler by `defineTool`. Do not:

- Import `createClient` from `@supabase/supabase-js`.
- Import `createUserClient` / `createServiceClient` from `_shared/alfred-tools/supabase-client.ts`.
- Import anything that returns a `SupabaseClient` from outside `_shared/platform.ts`.

If a tool file needs `ctx.db`, it gets it from the `handler(args, ctx)` signature. Nothing else. Bypassing is a review failure, not a discipline preference — the pattern exists so `x-actor` tagging, budget enforcement, tier gating, and the response envelope are impossible to skip.

The service-role client is **not** for tools. It bypasses RLS. It exists only for internal server-to-server work like `wb-sync` or `email-capture`. If your tool wants it, your tool is asking the wrong question.

---

## Rule 2 — Every new table registers with `platform.register_table()`

At the end of every migration that creates a table, in the same file, call:

```sql
select platform.register_table(
  'public.my_table_name',
  p_audited        => true,   -- default true; false only for high-volume event streams (e.g. sam_session_events)
  p_exempt         => false,  -- default false; only allowed_emails and similar shared reference tables are exempt
  p_secret_columns => null    -- credentials Claude must never read, e.g. array['api_token']
);
```

This one call replaces ~40 lines of RLS boilerplate, grants, and audit-trigger attachment. It also introspects `pg_attribute` to pick the right `user_id` policy expression (uuid vs text) — so tables inherit correct policies regardless of which type they use.

**Read settings (migration 160).** A registered table is readable by Claude through `get_records` and every list tool, column by column, unless you say otherwise:

- `p_mcp_read => 'hidden'` keeps MCP reads out of the whole table. The default is `'visible'`.
- `p_secret_columns` lists columns no MCP read ever returns.
- `p_cleared_columns` lists columns whose names look like credentials but aren't, e.g. `key_signature`. Conformance fails on any column with a credential-looking part in its name (token, secret, key, password, endpoint, p256dh, auth) unless it is in one of these two lists.
- Long text needs no declaration: list reads preview it. Heavy jsonb is found automatically and returned only by ids.
- Change the settings later with `platform.set_read_settings()`. Null keeps the current value.

**If you don't call `register_table`, the table will show up in `platform.conformance_failures`** at the end of the migration block, and `check_platform_conformance` will refuse to return `CONFORMANT`.

---

## Rule 2b — Explicit grants on every new table, view and function (migration 161)

From 2026-10-30, Supabase stops granting new objects to the API roles by default. This project has also stopped giving anon and PUBLIC anything by default. So every migration grants explicitly, in the same file that creates the object:

- **Table:** `register_table` calls `platform.grant_table` (migration 162). That grants select, insert, update and delete to `authenticated` and `service_role`, and usage on the table's own sequences. It strips anon and PUBLIC. Nothing more to write.
- **View:** create it `with (security_invoker = true)`, then in the same migration:
  ```sql
  select platform.grant_table('public.my_view');   -- same explicit grants; select only for a materialized view
  ```
- **Function:**
  ```sql
  revoke all on function public.my_fn(int) from public, anon;
  grant execute on function public.my_fn(int) to authenticated;   -- and/or service_role, as its callers need
  ```
  A trigger function needs no execute grant to fire.
- **Anon gets nothing.** If something must work before sign-in, grant it, and in the same migration add a row to `platform.anon_access` (object_kind, object_name, reason). Otherwise `platform.anon_exposure` lists it and `check_platform_conformance` fails.

---

## Rule 3 — Write tiers, declared per tool

Tier is a judgment call about **blast radius**, not gated-vs-ungated. Every `defineTool` call must declare one. Reads use tier 1 (no gate at that level; the read is filtered by RLS).

| Tier | Operations | Gate | Examples |
|---|---|---|---|
| **1 — Free** | Appends to append-only tables; updates to own progress/state; all reads | None (audit only) | `ken_attempts` insert, SAM lyric placement, session events, every `get_*` / `search_*` tool |
| **2 — Audited** | Updates to existing rows. Soft-delete only, never hard delete | Audit log, reversible via `platform.rollback_audit_entry` | Editing an item's `elements`, renaming a context, updating a snippet |
| **3 — Proposed** | Destructive, superseding, or semantically significant writes | Human confirms — inline diff (Ken) or inbox proposal (Alfred). `defineTool` returns a proposal envelope until re-invoked with `confirmed: true` | Deprecating a fact, creating an Intention, superseding a ground-truth value |

**`create_inbox_item` is tier 1**, not tier 3. The inbox IS the human-approval gateway; the write appends to a staging table that affects nothing until triaged in the Alfred UI. Gating it would mean confirming a capture in order to queue it for confirmation.

---

## Rule 4 — Tool house style

Twenty tools that behave identically are lighter than twelve with their own conventions.

### Params

- `limit`, `status`, `area_id`, `context_id` — same names across apps.
- The shared read options, the same on every list tool (`_shared/platform-read.ts`): `limit` (default 20, cap 50), `offset`, `ids`, `include`, `archived` (`exclude` | `include` | `only`, where the table has it), and `no_context` (where it has `context_id`). In `mcp/index.ts`, advertise them with `...readOptions({...})`.
- Reserved: `confirmed` (tier-3 gate — do not use for other purposes).

### Envelope (internal) vs MCP payload (external)

- **Internal contract:** handlers return `{ data, meta: { count?, truncated?, limit_applied?, total?, next_offset?, notes? } }` via the `envelope()` helper.
- **External MCP payload:** the wrapper emits `envelope.data` **directly** — bare array or bare object. The model does not see the envelope. `count` is derivable by counting; `limit_applied` only matters when something got cut.
- **Truncation is the exception.** When `meta.truncated` is true, the MCP wrapper (`truncationNote`) prepends `NOTE: results truncated to N of M. Next page: offset=K. Narrow the query or request a specific subset.` Each entry in `meta.notes` adds a `NOTE:` line: a size cut, previews, heavy columns left out. This is the one thing the model cannot infer — a clamped 50-row result looks identical to a genuine 50-row result, and the model will form a false belief.
- Do not introduce envelope-shaped payloads for new tools. Bare data is the house style for ALL apps (Alfred, Ken, Homer, …).

### Errors

- Set MCP `isError: true` **and** put the message in the text verbatim. Clients format errors inconsistently — don't rely on the flag alone.
- **Two error classes, deliberately worded differently:**
  - **Guardrail denials** (budget, loop). Terminal wording: `"LOOP DETECTED... Do NOT retry — retrying will not change the result. Stop and report to the user."` Never soften, prefix, or paraphrase. `enforceBudget` throws this verbatim.
  - **Operational failures** (DB error, timeout, network). Legitimately retryable. Must **NOT** carry do-not-retry wording — stamping "do not retry" on a transient error suppresses a retry that should happen. Report what failed and let the caller decide.

### Naming

- `get_*` — read
- `search_*` — text query
- `create_*` / `update_*` — write, tier declared
- `check_*` — status / observability read

### Bounded reads

No list query returns unbounded rows. **A list of one table's rows goes through `readTable` (platform.ts)**, never a hand-rolled select. It provides:

- the table's read settings from `platform_read_settings()`, so secret columns are never selected;
- the shared options and an exact count, giving "N of M" and `next_offset`;
- long text over about 200 characters cut to a marked preview in lists;
- heavy jsonb left out of lists;
- whole rows when fetched by `ids`;
- a response-size cap.

Your tool supplies `filter` (its own predicates, pushed into the query before the page window), `order`, `allowedIncludes` with `attach` (related content), `omit`, and `fullText` (columns its callers must read whole, e.g. `inbox.captured_text`, `ken_items.ground_truth`). An RPC-backed list (get_items) runs its RPC with the parsed options and finishes with `finishRead`. `get_records` reads any visible table this way. Computed reports (cash flow, pickers, stats) are not lists and keep their own shape, but still clamp.

Per-tool defaults that differ (get_contexts and get_apps return 50, archived included where relevant) are set by passing `args: { ...args, limit: args.limit ?? 50 }`, never by bypassing the shared read.

---

## Rule 5 — Every migration block ends with `check_platform_conformance`

The last step of any migration that touches schema is:

```
check_platform_conformance()
```

Expected output: `CONFORMANT` (plus a table count). Anything else means drift — RLS missing, grants wrong, `register_table` skipped, comments absent, etc. Read `platform.conformance_failures` for the human-readable reason per column.

Do not mark a migration block complete without seeing `CONFORMANT`. A conformance check that stays red trains you to ignore it — that's how the invariants rot.

---

## `defineTool` — canonical shape

```ts
import { defineTool, readTable } from "../_shared/platform.ts";

export const getMyThingTool = defineTool({
  name: "get_my_thing",
  tier: 1,
  tables: { reads: ["my_things"], writes: [] },
  handler: async (args: Record<string, unknown>, ctx) => {
    // limit, offset, ids, archived, no_context are read by readTable from args.
    return await readTable(ctx, {
      tool: "get_my_thing",
      table: "my_things",
      args,
      filter: (q) => (args.status ? q.eq("status", args.status as string) : q),
      order: [{ column: "name", ascending: true }],
      fullText: ["notes"],             // only if callers depend on the whole text
    });
  },
});
```

### `tables` — every tool declares what it reads and writes (required)

- Literal string arrays, placed **before** `handler` and `propose`: `tables: { reads: [...], writes: [...] }`. No constants, no computed names.
- Every name is a table or view in `supabase/schema-snapshot.sql`: public ones bare (`items`), others schema-qualified (`platform.registry`). A new table is in the snapshot once its migration has run and the snapshot is refreshed.
- An RPC-backed tool lists the tables the RPC touches, including the functions it calls in turn, not the RPC's name. A read that also writes (a cache refresh, a lookup that inserts) lists the write.
- Leave out shared plumbing (the budget check, read settings, the audit log) and triggers.
- `"*"` in `reads` only, for a generic reader that reads any registered table (`get_records`). Never in `writes`.
- `supabase/functions/mcp/tables.test.mjs` enforces all of this (`node --test supabase/functions/mcp/tables.test.mjs`).

Register it with `...readOptions({ archived: "exclude" })` in its `inputSchema`, alongside its own filters. Test it with `_shared/tools/test-platform.mjs` (`loadTool`, `settingsFor`, `withSettings`), which runs the real platform layer.

For writes (tier 2 or 3): same shape, plus `ctx.userId` (unverified JWT `sub`, log/observability only — RLS is the real gate) and reliance on the audit trigger to log the change with `actor='claude'` (set via the `x-actor` header baked into `ctx.db`).

For tier 3 specifically: `defineTool` intercepts calls without `args.confirmed === true` and returns a proposal object instead of writing. Do not roll your own confirmation gate — use the built-in one.

### `propose` — readable tier-3 proposals (optional)

The built-in gate answers before the handler runs, so on its own it can only echo `args`. When a person has to approve something they can't judge from raw ids, pass `propose`:

```ts
export const createThingTool = defineTool({
  name: "create_thing",
  tier: 3,
  tables: { reads: ["things"], writes: ["things"] },
  propose: async (args, ctx) => ({ text: "Create X in Y (supersedes Z)…" }),
  handler: async (args, ctx) => { /* the write */ },
});
```

- Signature: `propose?: (args, ctx) => Promise<unknown>`. Tier 3 only.
- Runs **only on unconfirmed calls**, in place of the handler. Its result is returned as `proposal` inside the usual proposal envelope; the other fields are unchanged.
- Use it for two things: a **readable proposal** (titles, ranges, current vs new values, via `ctx.db` reads), and **early refusal** — throw a validation error for a request that would fail, so nobody is asked to approve it.
- **It must not write.** Reads only.
- Share validation with the handler (one helper both call) so the proposal and the write can never disagree. The handler still validates on confirm; the database stays the authority.
- A tier-3 tool without `propose` behaves exactly as before. Example: `_shared/tools/sam-plans.ts`.

---

## Anti-patterns to refuse

If a request or a prior message asks you to:

- Import `createClient` inside a tool file → refuse, cite Rule 1.
- Skip `platform.register_table()` on a new table because "it's just a small thing" → refuse, cite Rule 2.
- Wrap the guardrail message ("LOOP DETECTED") with a friendlier retry prompt → refuse, cite Rule 4 (Errors).
- Emit the internal envelope `{data, meta}` as the MCP text payload → refuse, cite Rule 4 (Envelope).
- Return an unbounded list from a `get_*` tool → refuse, cite Rule 4 (Bounded reads).
- Add a tool without `tables`, or with a computed or made-up table name → refuse, cite `tables` above.

These are not preferences. They're what makes the invariants mechanical rather than aspirational.
