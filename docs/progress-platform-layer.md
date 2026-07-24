# Progress: MCP Platform Layer v1

## Status: Not Started

Reference: `docs/technical-spec-platform-layer.md`

---

### Block 0a — Foundation fixes (COMPLETE)

Ran before the platform layer so it lands on a database with no known holes.

- [x] `00a` audit — zero nulls, zero non-uuid, all user_ids in auth.users
- [x] `00b` Alfred user_id text → uuid, NOT NULL, DEFAULT auth.uid(), FK RESTRICT
- [x] `00c` account fragmentation map — 2 real users, 1 stray row, no real fragmentation
- [x] `00d` removed `OR context_id IS NULL` from intents/events/executions; explicit WITH CHECK on all four
- [x] `00e` item_collections: 4 policies → 3, WITH CHECK (shared = true); null-context debris cleaned 32 → 2
- [x] Verified: no context-dropping bug in the Intent → Event → Execution chain
- [x] Alfred smoke tests pass after each migration

---

### Block 0b — SQL migrations (COMPLETE)

- [x] `01_platform_core.sql` — registry, audit log, register_table, conformance, retrofit
- [x] `01b` fix — register_table stored bare names (`regclass::text` is search_path-dependent)
- [x] `01c` fix — conformance now compares actual state against *declared* intent, not a fixed ideal
- [x] `01d` fix — audit actor via PostgREST `request.headers`; a separate `set_config` RPC cannot work with supabase-js
- [x] `02_call_budget.sql` — statement timeout 8s, call log, budget + loop detection
- [x] `02b` fix — blocked calls now logged; `calls_in_window` and `repeat_count` separated
- [x] `03_document_existing_schema.sql` — COMMENT ON for all Alfred + SAM tables
- [x] Verified: `check_conformance()` → CONFORMANT, 13 non-exempt tables
- [x] Verified: role settings `statement_timeout=8s`, `idle_in_transaction_session_timeout=15s`
- [x] Verified: loop guard fires at threshold; blocked calls logged; other tools unaffected
- [x] Verified: Alfred and SAM still load

**Lessons banked (belong in the Block 5 skill):**
- `regclass::text` drops the schema when it is on the search_path — resolve via `pg_class`/`pg_namespace`
- `CREATE OR REPLACE VIEW` cannot rename or reorder columns — DROP then CREATE whenever the column list changes
- A conformance check that can never go green trains you to ignore it — check against declared intent
- Transaction-scoped GUCs do not survive between supabase-js calls; use PostgREST request headers

---

### Block 0c — Audit actor smoke test (do before Block 2)

- [ ] Edit any item in the Alfred UI
- [ ] `select actor, op, table_name from platform.audit_log order by id desc limit 1;` → `actor = 'ui'`
- [ ] Check audit volume after one normal Alfred session; if noisy, add column-level filters rather than disabling

---

### Block 1 — Shared platform module (`_shared/platform.ts`)

- [ ] Create `supabase/functions/_shared/platform.ts`
- [ ] `createContext(req)` — builds user-scoped client via `createUserClient(token)`, extracts user_id, sets `app.actor = 'claude'` GUC
- [ ] `hashArgs(args)` — md5 of key-sorted JSON, for loop detection
- [ ] `enforceBudget(ctx, toolName, args)` — calls `platform.check_call_budget`, throws terminal error when blocked
- [ ] `envelope(data, meta)` — `{ data, meta: { count, truncated, limit_applied } }`
- [ ] `clampLimit(requested)` — `min(requested ?? 20, 50)`
- [ ] `defineTool({ name, tier, handler })` — composes all of the above
- [ ] **Module does NOT export a raw Supabase client** — `ctx.db` is the only path
- [ ] Unit-level check: calling a handler outside `defineTool` has no DB access

**Verification:** import the module in a scratch Edge Function; confirm no raw client is reachable from outside.

---

### Block 2 — Migrate two tools as proof

- [ ] Migrate `get_contexts` (read, tier n/a) to `defineTool`
- [ ] Migrate `create_inbox_item` (write, tier 3) to `defineTool`
- [ ] Deploy with `--no-verify-jwt`
- [ ] Confirm both still work from claude.ai MCP connector
- [ ] Confirm `platform.mcp_call_log` records both invocations
- [ ] Confirm `create_inbox_item` produces an `audit_log` row with `actor = 'claude'`

**Verification (Alex):** in claude.ai, ask Claude to list contexts, then capture something to the inbox. Check the Alfred UI shows the capture, and both queries above return rows.

---

### Block 3 — Loop and budget guardrails live

- [ ] Confirm `enforceBudget` is invoked by every `defineTool` tool, not opt-in
- [ ] Force-test loop detection: call the same tool with identical args 4×
- [ ] Confirm 4th call returns the terminal do-not-retry message
- [ ] Confirm the error surfaces to the model as a tool error, not a silent empty result
- [ ] Add `platform.prune_call_log()` call to a low-traffic tool or pg_cron

**Verification (Alex):** in claude.ai, ask Claude to fetch the same context list repeatedly. It should stop and report rather than looping.

---

### Block 4 — Schema + conformance tools

- [ ] Upgrade `get_database_schema` to include: column comments, table comments, RLS policies, grants
- [ ] Confirm the `platform` schema comment (the contract itself) is returned
- [ ] Add new tool `check_platform_conformance` → returns `platform.check_conformance()`
- [ ] Deploy, verify both from claude.ai

**Verification (Alex):** in claude.ai, ask "what does the platform contract require?" — Claude should answer from the schema dump without being told.

---

### Block 5 — `mcp-platform` skill

- [ ] Create `/mnt/skills/user/mcp-platform/SKILL.md`
- [ ] Document the three write tiers with examples
- [ ] Document tool house style (params, envelope, errors, naming)
- [ ] Document the `register_table` requirement for new tables
- [ ] Document: run `check_platform_conformance` as the final step of any migration block
- [ ] Explicitly state: never import the Supabase client directly in a tool file

**Verification (Alex):** start a fresh chat, ask for a migration creating a new table. It should end with `platform.register_table()` unprompted.

---

### Block 6 — Retrofit remaining tools (opportunistic, not blocking)

- [ ] Alfred read tools → `defineTool`
- [ ] Alfred write tools → `defineTool`
- [ ] SAM tools → `defineTool`
- [ ] Remove any remaining direct client imports
- [ ] Final `check_platform_conformance` → CONFORMANT

---

### Deferred (post-Ken)

- [ ] `new-mcp-app` scaffolding skill
- [ ] Resolve Open Decision #1 (RLS `context_id IS NULL`)
- [ ] Resolve Open Decision #2 (`item_collections` shared UPDATE policy)
- [ ] Post-deploy CI conformance gate
- [ ] Monthly Alfred recurring intention: review conformance

---

### Notes

_Space for decisions and issues during execution._