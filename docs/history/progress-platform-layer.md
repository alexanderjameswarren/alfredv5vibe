# Progress: MCP Platform Layer v1

## Status: Block 6 awaiting verification

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

### Block 3 — Guardrails proven live (COMPLETE)

- [x] Loop denial verified through the LIVE MCP transport — 4th identical get_contexts
      in 60s returned the verbatim terminal message as an <error>, not an empty result.
      Full chain proven: check_call_budget → enforceBudget throw → MCP catch → isError.
- [x] Message reached the model WORD-FOR-WORD — CLI did not soften the do-not-retry wording.
- [x] Budget-exceeded (60-call volume): covered by SQL test in 02/02b. Not re-tested live —
      it runs the identical throw/catch/surface path as loop detection, which IS proven live.
      A 60-call live test would prove nothing new.
- [x] Opportunistic pruning wired (02c): platform.maybe_prune() runs ~1% from
      check_conformance. No pg_cron dependency.

**Known unexercised code path — MUST test in Block 6:**
- Truncation notice. When meta.truncated is true, defineTool emits an extra text
  block "NOTE: results truncated to N of M". No migrated tool can trigger this yet
  (get_contexts: 8 rows; create_inbox_item: 1 row). Block 6 must migrate get_items
  with a limit below the row count and confirm the notice reaches the model verbatim.
  Do not mark Block 6 complete otherwise.

---


---

### Block 4 — Schema + conformance tools

- [x] Upgrade `get_database_schema` to include: column comments, table comments, RLS policies, grants — **SQL side (user-managed, Option A: enrich `public.get_schema_info` in-place); TypeScript unchanged** (existing handler passes through whatever the RPC returns, so richer fields flow through automatically)
- [ ] Confirm the `platform` schema comment (the contract itself) is returned — verified once user's SQL migration lands
- [x] Add new tool `check_platform_conformance` → wired to `public.platform_check_conformance()` (SECURITY DEFINER wrapper confirmed present alongside `platform_recent_audit`, per user)
- [x] Add new tool `get_platform_contract` → wired to `public.get_platform_contract()` (deployed in migration 04; missed on the first pass, added 2026-07-27 as the Block 4 gap-close)
- [x] Deploy with `--no-verify-jwt` (mcp v15 → v16 initial Block 4; v16 → v17 for `get_platform_contract`, `verify_jwt: false` confirmed via `supabase functions list` both times)
- [ ] Verify all three from claude.ai

**Verification (Alex):** in claude.ai, ask "what does the platform contract require?" — Claude should answer from the schema dump without being told.

**Block 4 decisions**

- **`get_database_schema` needed no TypeScript change.** The existing MCP callback calls `client.rpc("get_schema_info", { target_table })` and stringifies the result. User is upgrading the SQL side (Option A — enrich in-place, adds column comments / table comments / grants / top-level `platform_schema_comment`); enriched fields flow through the current TypeScript verbatim.
- **`get_database_schema` NOT migrated to `defineTool` in this block.** Block 4's task is content upgrade, not platform-layer routing. Retrofit is Block 6's opportunistic sweep. Left the old raw-client callback in place to minimize surface area of this block.
- **`check_platform_conformance` is a new tool, wired via `defineTool` from day one.** Tier 1 (read, no gate). Handler is `ctx.db.rpc("platform_check_conformance")` — one line. Return shape passed through unchanged so the model sees the same output a psql call would produce (whether that's a text scalar or a set of rows, up to the SQL function).
- **`platform_recent_audit`** exists as a public wrapper too (per user), but Block 4 doesn't require exposing it as an MCP tool. Rollback and audit inspection are documented as human operations in the spec; leaving that wrapper unwired for now.
- **`get_platform_contract` gap-close (2026-07-27).** Tool was specced in Block 4 but missed on the first pass. Wired verbatim per user's brief: tier 1, one-line handler `ctx.db.rpc('get_platform_contract')`. Description positions it as the design-time first read (contract rules + registry + live conformance report — one call rather than three). Registered next to `check_platform_conformance` for locality. mcp v16 → v17.

---

### Block 5 — `mcp-platform` skill

- [x] Create skill file — written to `C:\Users\Alex\.claude\skills\mcp-platform\SKILL.md` (standard Claude Code user-skill location on Windows; `/mnt/skills/user/` is the hosted-env virtual mount path, not directly writable from this session)
- [x] Document the three write tiers with examples (Rule 3)
- [x] Document tool house style — params, envelope (internal) vs MCP payload (external), errors (two classes worded differently), naming, bounded reads (Rule 4)
- [x] Document the `register_table` requirement for new tables (Rule 2)
- [x] Document: run `check_platform_conformance` as the final step of any migration block (Rule 5)
- [x] Explicitly state: never import the Supabase client directly in a tool file (Rule 1)
- [ ] Fresh-chat verification (Alex)

**Verification (Alex):** start a fresh chat, ask for a migration creating a new table. It should end with `platform.register_table()` unprompted.

**Block 5 decisions**

- **Location:** `%USERPROFILE%\.claude\skills\mcp-platform\SKILL.md` — the standard Claude Code user-skill path on Windows. The spec's `/mnt/skills/user/mcp-platform/SKILL.md` is Anthropic's hosted-env virtual mount and isn't writable from this Windows session. If Alex's fresh-chat verification runs in claude.ai (hosted), the file content needs syncing to whatever backing store their claude.ai skills read from — the file here is source-of-truth and can be uploaded/copied as-is.
- **Frontmatter shape:** `name` + `description` only. Reference/design skill, not user-invocable — no `user-invocable: true`, no `allowed-tools`. `description` is discoverability-tuned: names the triggers (migration adding a table, new MCP tool, changes to `_shared/platform.ts`) so the agent surfaces it at the right moment.
- **Anchor to source of truth up top:** every rule the skill states also lives in `COMMENT ON SCHEMA platform` (queryable via `get_database_schema`) and `docs/technical-spec-platform-layer.md`. If they drift, they win. The skill is the model-facing summary, not the contract.
- **Content structure — 5 named rules + a `defineTool` canonical example + an anti-patterns list.** Rules are numbered so anti-patterns can cite them ("refuse; cite Rule 1"). Anti-patterns section explicitly lists request shapes that should be refused (raw client import, skipping `register_table`, softening guardrail messages, emitting envelope externally, unbounded lists). Directive prose, not tutorial — trades warmth for density.
- **Tier 1 covers all reads.** Explicit note that reads use tier 1 (no gate) because the tier system is oriented toward writes. Otherwise "what tier is my read tool?" becomes an infinite decision loop.
- **`create_inbox_item` is called out as tier 1 by name.** The instinct to gate any write with "inbox" in it was strong enough to require correcting in Block 2; the skill preempts that.
- **Truncation NOTE wording matches spec: `"NOTE: results truncated to N of M."`** — flagged that my `runToolForMcp` currently emits `"N (result-set ceiling hit)"` instead. Block 6 must fix this when it migrates `get_items` (which needs a count query for M) so the wiring matches what the skill documents.

---

### Block 6 — Retrofit remaining tools (opportunistic, not blocking)

- [x] Alfred read tools → `defineTool` (get_items, search_items, get_execution_history, get_intents, get_events, get_collections, get_inbox, get_tags, get_database_schema)
- [x] Alfred write tools → `defineTool` (update_inbox_item — tier 2)
- [x] SAM tools → `defineTool` (get_sam_songs, get_sam_sessions, get_sam_snippets, get_sam_song_measures, get_sam_lyric_workspace — reads; place_sam_lyrics, update_sam_song_measures, load_sam_lyrics — tier 2 writes)
- [x] Remove any remaining direct client imports — `createUserClient` import gone from `mcp/index.ts`; deploy bundle shrank from 6 files to 5 (`supabase-client.ts` no longer needed by the mcp function; still exists for `ai-enrich`)
- [x] Truncation wording fix — `runToolForMcp` NOTE now emits `"N of M"` when the handler provides a `total`, or `"N (more available)"` when it can't (e.g. tag-filter case). `EnvelopeMeta` gained a `total?: number` field for this.
- [x] `get_items` real-truncation wiring — new inline handler applies `clampLimit(args.limit)` and runs a separate count query with the same server-side predicates; sets `truncated + total`. Same shape for `get_inbox`.
- [x] Deploy with `--no-verify-jwt` (mcp v17 → v18, `verify_jwt: false` confirmed via `supabase functions list`)
- [ ] `check_platform_conformance` → CONFORMANT (post-deploy, Alex verification via claude.ai or psql)
- [ ] Verify `get_items` truncation NOTE reads `"N of M"` end-to-end (Alex verification)

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

**Block 6 decisions**

- **All 18 remaining tools migrated in one deploy.** Every registration callback now returns `runToolForMcp(<toolNameTool>, args, token)`. The old `async ({destructured}: {types}) => { createUserClient; call handler; format }` scaffolding is gone. Zero raw-client references remain in `mcp/`.
- **Thin delegation for most tools; inline rewrite for `get_items` + `get_inbox`.** The other 16 defineTool handlers just call the existing `tool-handlers.ts` function with `ctx.db` and rethrow errors — no behavior change. `get_items` and `get_inbox` rewrite inline to add exposed `limit` param + count-query-driven truncation, since Block 3 required real-truncation validation for `get_items` (270 rows) and the same pattern applies to `get_inbox` (127 rows).
- **`tool-handlers.ts` untouched.** All handlers stay exported for `ai-enrich`, which uses `getContexts / getItems / searchItems / getExecutionHistory / getCollections / getTags` directly. The MCP path no longer imports them (other than for thin delegation via `ctx.db`), so if a future `ai-enrich` deprecation happens the file becomes prune-able.
- **Tier assignments:** all reads tier 1, all writes tier 2. `update_inbox_item` was previously "successful updates get a preamble" — matched the create_inbox_item cleanup and dropped the preamble as part of the migration. Bare data is the house style.
- **`load_sam_lyrics` classified as tier 2, not tier 3, despite its destructive `replace=true` path.** Forcing `confirmed: true` on every routine lyric load would break the workflow. The audit trigger captures the pre-image, and `platform.rollback_audit_entry()` reverses the delete. If the user disagrees, one-line bump to tier 3.
- **`EnvelopeMeta.total`** — new optional field. Set only when the handler ran a separate count query and knows the true row count that would have been returned without the limit. Consumed by `runToolForMcp` for the "N of M" NOTE. When absent, the NOTE degrades to "N (more available)" — honest fallback rather than a fabricated M.
- **Tag-filter truncation is honest.** In `getItemsTool`, tag filter runs client-side (items.tags is jsonb). Running a server-side count without the tag predicate would report an inflated M. When tags is present the handler sets `truncated: true` with no `total` — user sees "N (more available)" and can narrow other filters. Documented inline.
- **Count queries use `head: true`.** `.select("id", { count: "exact", head: true })` sends `Prefer: count=exact` and doesn't fetch rows — just the count. Cost is one extra round-trip only when truncation actually fires (so the common case pays nothing).
- **Deploy bundle shrunk from 6 files → 5.** `_shared/alfred-tools/supabase-client.ts` is no longer bundled with the mcp function because nothing in the tree references it after the migration. Concrete evidence that Rule 1 (no raw client in tools) is enforced by the import graph, not just discipline.
- **Truncation NOTE wording**: `NOTE: results truncated to N of M. Narrow the query or request a specific subset.` — matches spec + skill. Fallback: `NOTE: results truncated to N (more available). Narrow the query or request a specific subset.`
- **mcp v17 → v18**, `verify_jwt: false` confirmed via `supabase functions list --project-ref ...` JSON output.

**Alex-side verification for Block 6:**

1. In claude.ai, invoke `get_items` with default params (no limit). Expect capped-at-20 response.
2. Force truncation: `get_items` with limit=5 on a context that has >5 items. Expect a `NOTE: results truncated to 5 of M. …` block prepended before the JSON array. Confirm `M` is the actual count (matches `select count(*) from items where archived=false and context_id=...`).
3. `get_items` with a tag filter that hits the limit: expect NOTE with `"(more available)"` fallback instead of "of M".
4. `get_inbox` with limit=5 when there are >5 pending items: same "N of M" behavior.
5. Any other migrated tool: confirm it still works normally.
6. Run `check_platform_conformance` from claude.ai. Expect `CONFORMANT`. If not: `select * from platform.conformance_failures` for details.
7. Trigger a `update_inbox_item` call, then `select actor, op, table_name from platform.audit_log order by id desc limit 1;` — expect `actor='claude'`, `op='UPDATE'`, `table_name='inbox'`.
8. Confirm audit history on a `place_sam_lyrics` or `update_sam_song_measures` call.
9. Confirm loop detection still fires (call `get_contexts` 4× with identical args in <60s) — the verbatim guardrail message reaches the model unmodified via the tier-1 path.