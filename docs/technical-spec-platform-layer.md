# Technical Spec: MCP Platform Layer v1

> **Status:** Foundation migrations `00b`–`00e` complete and verified.
> Platform migrations `01`–`03` pending. TypeScript layer (`defineTool`) not started.
> **Canonical copy:** `docs/technical-spec-platform-layer.md` in the repo.
> If this file is in project knowledge and the repo has moved on, the repo wins.
> **Live contract:** `COMMENT ON SCHEMA platform` — read via `get_database_schema`.
> That is the version that cannot go stale; this document explains the reasoning behind it.

## Overview

Extract the cross-cutting concerns currently reimplemented in every MCP tool into a shared layer, so that new apps (Ken, Homer, ...) are correct by construction rather than by discipline.

**The problem.** Every Edge Function tool today conflates three concerns — capability (what data can be reached), interface (what Claude calls, what comes back), and policy (who's allowed, how much, with what approval). Each tool implements all three inline. There is no shared place for "cap results at 50" or "log this write," so it gets re-decided per tool. Twenty tools feel heavier than twenty tools should.

**The fix.** Pull policy out of the tools into a layer they sit on. Make the correct path shorter than the wrong path, then detect drift automatically.

**Design principle.** Conventions that live in a person's head or a spec document *will* be violated — most likely by Claude CLI writing the next app's migration from an underspecified prompt. Only structure and automation survive. This spec enforces invariants mechanically and documents judgment calls in prose.

---

## Architecture

Four layers, weakest to strongest enforcement.

### Layer 1 — Paved path (Postgres + TypeScript)

`platform.register_table()` collapses ~40 lines of RLS, grants, and trigger attachment into one call. It is type-aware: Alfred stores `user_id` as `text`, SAM as `uuid`, so the generated policy expression is chosen by introspecting `pg_attribute`.

`defineTool()` wraps every MCP tool with context creation, actor GUC, budget enforcement, tier gating, and response envelope.

**Enforcement mechanism:** `_shared/platform.ts` does *not* export a raw Supabase client. The only path to the database is `ctx.db`, handed to a handler by `defineTool`. A tool written outside the factory has nothing to call — bypassing becomes a compile error rather than a discipline question.

### Layer 2 — Drift detection

`platform.conformance` (one row per public table) and `platform.conformance_failures` (violations only, with a human-readable reason per column). Surfaced three ways:

- MCP tool `check_platform_conformance` — Claude runs it as the last step of any migration block
- Post-deploy CI — fail the deploy on any violation
- Monthly Alfred recurring intention — the system reminds you

### Layer 3 — Contract where Claude reads it

Two placements for two moments:

- **`COMMENT ON SCHEMA platform`** — for when Claude is *designing*. Since `get_database_schema` returns comments, the contract rides along with every schema read.
- **`mcp-platform` skill** — for when Claude is *writing code*. Tiers, house style, registration requirement.

This is the mechanics/policy split already in use: mechanics belong in tool descriptions, policy belongs in skills. If a skill has to explain *how to call* a tool, the tool description is underspecified and the knowledge now lives in two places that will diverge.

### Layer 4 — Scaffolding

A `new-mcp-app` skill that generates a conformant starting package. Deferred to Phase 6 — build it once Ken has proven the pattern.

---

## Write tiers

The axis is **blast radius**, not gated-vs-ungated. This replaces "the inbox is the only write surface," which was right for *capture* and wrong as a universal law — which is why SAM drifted from it. The drift was correct instinct; this gives it a principle.

| Tier | Operations | Gate | Examples |
|---|---|---|---|
| **1 — Free** | Appends to append-only tables; updates to own progress/state | None (audited only) | `ken_attempts` insert, mastery update, SAM lyric placement, session events |
| **2 — Audited** | Updates to existing rows. Soft-delete only, never hard delete | Audit log, reversible | Editing an item's elements, renaming a context |
| **3 — Proposed** | Destructive, superseding, or semantically significant | Human confirms — inline diff (Ken) or inbox (Alfred) | Deprecating a fact, creating an Intention, superseding a ground-truth value |

Tier is declared per tool in `defineTool({ tier: 1|2|3 })`. Tier assignment is a judgment call and is deliberately *not* automated.

---

## Audit and rollback

`platform.audit_log` captures before/after images via a single generic trigger, attached by `register_table`. Two details make it actually useful:

**`old_row` is the point.** A log without the before image records that something happened; it can't undo it. `platform.rollback_audit_entry(id)` reverses a single change — INSERT→delete, DELETE→reinsert, UPDATE→restore old values.

**The `actor` column is what makes it an undo.** Because MCP tools correctly use `createUserClient(token)`, Postgres sees *the user*, not Claude. Without `actor`, AI writes and UI writes are indistinguishable. It's populated from a transaction-scoped GUC set at the top of every MCP request:

```sql
select set_config('app.actor', 'claude', true);
```

Then "show me everything Claude changed in the last hour" and "roll back that session" are both one query.

Rollback is intentionally **not** exposed as an MCP tool. It's a human operation.

---

## Call guardrails

Layered; no single one suffices.

**Postgres (hard stops).** `statement_timeout = 8s` and `idle_in_transaction_session_timeout = 15s` on the `authenticated` role. Nothing in app code can override these.

**Function level.** Every list tool clamps `limit` to `min(requested ?? 20, 50)`. Response-size ceiling with explicit truncation notice. Heavy JSONB (`sam_songs.measures`, Ken's `tricky_fragments`) excluded from list queries.

**Session level.** `platform.check_call_budget()` runs two independent guards:
- *Volume*: 60 calls / 5 min per user
- *Loop*: same tool + identical args hash 3× in 60s

**The error text is load-bearing.** Models retry on ambiguous failures. `"429 Too Many Requests"` invites a retry; `"LOOP DETECTED... Do NOT retry — retrying will not change the result. Stop and report to the user."` breaks the loop. The wording in `check_call_budget` is deliberate and should not be softened.

**Design level (the real win).** The best guardrail is fat, purpose-built tools. Thin CRUD primitives force composition across five calls to answer one question — that's where budgets burn. Ken's `get_quiz_batch` returning items + recent attempts + relevant misconceptions in one shot is structurally loop-resistant. `platform.tool_usage_recent` surfaces tools with a high repeat ratio, which is the signal that a tool should return more per call.

---

## Tool house style

Twenty tools that behave identically are lighter than twelve with their own conventions.

- **Params:** `limit`, `status`, `area_id` — consistent names across apps
- **Envelope:** every response `{ data, meta: { count, truncated, limit_applied } }`
- **Errors:** `{ error: { code, message } }` where `message` is written for the model that will read it
- **Naming:** `get_*` (read), `search_*` (text query), `create_*` / `update_*` (writes, tier declared)

---

## Resolved decisions (migrations 00b–00e, completed)

**#1 — RLS `context_id IS NULL` clause. RESOLVED (00d).** `intents`, `events`, and `executions` carried `OR context_id IS NULL`, making every un-contexted row readable and writable by any authenticated user. Audit showed all 32 affected rows belonged to the primary account, so removal cost nothing. Clause dropped; explicit `WITH CHECK` added to all four Alfred policies (previously absent, so Postgres silently reused `USING`). An un-contexted row is now private to its owner — "no context" became a legitimate state rather than a hole.

**#2 — `item_collections` shared UPDATE policy. RESOLVED (00e).** Audit proved the policy was *load-bearing*: all three collections are shared and owner-held, and the policy is what lets the partner edit the shared grocery list. Removing it would have broken daily use. Fixed minimally instead — `WITH CHECK (shared = true)` so a non-owner can edit but not un-share. Four redundant policies collapsed to three. Residual risk (a non-owner reassigning `user_id`, which `WITH CHECK` cannot prevent since it can't see the pre-update row) accepted and documented in the table comment.

**#3 — `user_id` type divergence. RESOLVED (00b).** All seven Alfred tables migrated `text` → `uuid NOT NULL DEFAULT auth.uid()` with FKs to `auth.users(id)`. The type was the enabler, not the point — the real defects were the missing default (every insert path had to remember `user_id`), the nullable column, and the absent FK. `ON DELETE RESTRICT` chosen over `CASCADE`: deleting an account believed empty would otherwise have silently destroyed its rows. SAM's pre-existing FKs are `NO ACTION`, which is behaviourally identical here; left alone. `register_table`'s `pg_attribute` type introspection is now belt-and-braces rather than load-bearing, and is retained for future tables.

### Incidental findings, also resolved

- **Account fragmentation.** Four `auth.users` rows for two actual people. Data was *not* meaningfully fragmented — the second account is the partner, working as designed through shared contexts. One stray inbox capture under a work identity; `katieporter.com` owned nothing. Cleanup path documented in 00d Section 3.
- **Null-context test debris.** 32 rows, almost all from the Feb 2026 build window and predating the `auth.users` record (backfilled during the storage→Postgres migration). Reduced to 6, then 2 chains. Verified *not* a context-dropping bug: nulls propagate faithfully through Intent → Event → Execution.

### Still open

- **Uncontexted intents.** Alfred permits creating an intent with no context. No longer a security question, purely design: the inbox already exists as the unsorted staging area, so an intent with no context arguably means triage escaped early. Decide whether to require a context at triage or add a catch-all.

---

## Success criteria

- [ ] `select * from platform.conformance_failures` returns zero rows
- [ ] Every existing table registered; `allowed_emails` exempt, `sam_session_events` audited=false
- [ ] Every existing table and significant column carries a `COMMENT`
- [ ] `get_database_schema` returns comments, RLS policies, and grants
- [ ] Existing Alfred and SAM RLS behavior unchanged (retrofit is non-destructive)
- [ ] An audited UPDATE via MCP produces an `audit_log` row with `actor = 'claude'`
- [ ] The same UPDATE via the web UI produces `actor = 'ui'`
- [ ] `rollback_audit_entry()` successfully reverses an UPDATE
- [ ] 4th identical tool call within 60s is refused with terminal, do-not-retry language
- [ ] All MCP tools route through `defineTool`; no raw client import outside `_shared/platform.ts`
- [ ] `--no-verify-jwt` verified post-deploy by smoke test, not by memory

---

## Non-goals

- Rewriting Alfred/SAM tool internals. Retrofit is grants + audit + comments only. Tools migrate to `defineTool` opportunistically as they're touched.
- Unifying `user_id` types.
- Ken's schema. Separate spec, built natively on this layer as proof it works.
- The `new-mcp-app` scaffolding skill. Deferred until Ken validates the pattern.
