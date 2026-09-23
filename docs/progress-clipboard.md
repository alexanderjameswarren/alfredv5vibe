# Progress: Alfred Clipboard

## Status: Phase 1 in progress — Step 2 migrations written, awaiting Alex's run + CONFORMANT

Spec: docs/technical-spec-clipboard.md

## Phase 1: capture and read

- [x] Step 1: Spike cleanup. Delete `supabase/functions/_shared/tools/clipboard-test.ts`, `scripts/clipboard-tile-screenshot.mjs`, and the two TEMPORARY fenced blocks in `supabase/functions/mcp/index.ts`. Keep the `McpBlock` / `__mcp_content` passthrough, rewrite its comment as a permanent feature, and commit. Give Alex the SQL to drop the temporary `clipboard-test` read policy, and tell him to delete the `clipboard-test` bucket and the "CLIPBOARD TEST" inbox item by hand. Deploy `mcp`, verify `verify_jwt`. — **done 2026-09-23**, `mcp` v109. Three manual items outstanding for Alex (storage policy, bucket, inbox item); see notes.
- [ ] Step 2: Migration file for the `clips` table, the `clipboard` bucket, and its read policy, ending with `register_table`. Alex runs it; `check_platform_conformance` must return CONFORMANT. — **migrations written 2026-09-23**, `supabase/migrations/063_clips_table_and_clipboard_bucket.sql` and `064_drop_clipboard_test_bucket.sql`. Not yet run. Step stays open until Alex reports CONFORMANT.
- [ ] Step 3: `clip-capture` edge function, its `config.toml` block (committed before first deploy), and the secrets `CLIPBOARD_SECRET` and `CLIPBOARD_USER_ID`. Test both endpoints with curl.
- [ ] Step 4: MCP tools: `get_recent_clips`, `get_clip_slices`, `archive_inbox_item`, and the `get_inbox` `source_type` filter. Deploy, verify `verify_jwt`. Tested in a fresh thread.
- [ ] Step 5: Frontend minimum: source icons for `clipboard` and `cli`; realtime handler drops archived rows.
- [ ] Step 6: Chrome extension in `extension/`: options page, capture, slicing, upload, finish, badge. Alex loads it unpacked and clips three real pages (a long job posting, a short page, and a `chrome://` page to check the clean failure).
- [ ] Step 7: `scripts/clip.mjs` and the `CLAUDE.md` rule for pushing CLI reports.
- [ ] Step 8: Alex adds the project instruction in claude.ai, rotates the notification dispatch secret, and runs the end-to-end test in a fresh thread.

## Phase 2: jobs

- [ ] Step 9: Migration adding `posting_url` and `duplicate_of` to `job_applications`. Alex runs it; CONFORMANT.
- [ ] Step 10: `create_job_application` and `update_job_application` accept both fields; the same-organization-and-role refusal is skipped when `duplicate_of` is given; `get_job_application_sources` excludes duplicates. Deploy, verify, test in a fresh thread.
- [ ] Step 11: Update `.claude/skills/job-search/SKILL.md` and `.claude/skills/alfred-enrich/SKILL.md` per spec section 4.6. Commit; Alex re-uploads both to claude.ai.
- [ ] Step 12: End-to-end jobs test: clip a job board page, open a jobs thread, confirm the evaluation, the "other listings" suggestions with links, the filed `considering` row, and the archived inbox item.

## Notes

### Step 1 — spike cleanup, 2026-09-23

**Removed:**

- `supabase/functions/_shared/tools/clipboard-test.ts` (the `test_clipboard_image` tool).
- `scripts/clipboard-tile-screenshot.mjs` (the local slicer that stood in for the extension's canvas code).
- `scripts/clipboard-test-tiles/` — the five JPEG tiles that script produced from the real screenshot. Not named in the step, but the same spike artefact, so it went too. The spike's conclusion is recorded in spec decision 2; the files themselves were disposable.
- Both TEMPORARY fenced blocks in `supabase/functions/mcp/index.ts`: the import and the `registerTool` call.
- `sharp`, the image library the local slicer needed. It was installed with `--no-save --no-package-lock`, so removing it left `package.json` and `package-lock.json` untouched (verified). Nothing else in the repo imports it, and the extension slices in the browser, so no build ever needs it.

Registered tool count is back to 72, its pre-spike value.

**Kept, and now permanent:** the `McpBlock` union and the `__mcp_content` passthrough in `runToolForMcp` (`supabase/functions/mcp/index.ts`, around lines 615-700). The comment above it was rewritten from "escape hatch for the spike, delete if abandoned" to a description of a standing wrapper feature: text stays the default, a tool opts into owning its own content blocks by returning `{ __mcp_content: [...] }`, the envelope contract is unchanged, and the cost to every other tool is one property read. Two things were added that were not in the spike version — a pointer to `_shared/tools/clipboard.ts` as the house example (written in Step 4), and an explicit warning that image blocks are expensive (base64 is 4/3 of the bytes, every block lands in context whether or not it is looked at) and that a tool returning them must bound how many it sends and say what it left out.

**Deploy:** `mcp` v109. `verify_jwt` confirmed false two ways — `supabase functions list`, and an unauthenticated POST returning 401 with `WWW-Authenticate: Bearer resource_metadata="..."` plus an `x-deno-execution-id`, which proves the function's own code answered rather than the gateway. `clip-capture` does not exist until Step 3, so only `mcp` could be checked. `supabase/config.toml` untouched.

**Verification limit worth knowing:** there is no `deno` on this machine, so TypeScript was only syntax-checked (esbuild transpile, exit 0). Nothing here is typechecked before it reaches the edge runtime. Same applies to every later step.

### Step 2 — clips table and clipboard bucket, 2026-09-23 (written, not yet run)

Two files:

- **`supabase/migrations/063_clips_table_and_clipboard_bucket.sql`** — the `clips` table with comments and both indexes, the `clipboard` bucket (private, 2 MB, `image/jpeg` only), its read policy, `platform.register_table`, and `platform_check_conformance`. Before/after diagnostic blocks at each end, in the 062 house pattern.
- **`supabase/migrations/064_drop_clipboard_test_bucket.sql`** — spike bucket teardown, guarded and idempotent.

**Decision: the bucket read policy is folder-based, NOT owner-based, which departs from "copy the sam-scores policy" (spec 3.2).** Spec decision 6 has slices uploaded through service-issued signed upload links, so the objects' `owner` column is the service role or null, never Alex. An `owner = auth.uid()` policy would match nothing and every slice read would fail. The policy therefore uses `(storage.foldername(name))[1] = auth.uid()::text`. sam-scores can afford either form because its uploads are browser-direct with the user's own session. 063's final verification prints both policies side by side so the actual divergence is on the record. **If sam-scores turns out to be owner-based, that is worth a second look on its own account** — not because it is broken there, but because the two buckets would then be relying on different things for the same guarantee.

**Decision: `p_audited => true`.** The contract reserves `false` for high-volume append-only telemetry; clips are a few a day, so the exception does not apply. The cost is recorded in the migration header: the audit trigger keeps a row copy, so a clip's page text is stored twice and deleting a clip will not reclaim the audit copy. That belongs in the 2026-10-23 storage review decision 10 already schedules. Flipping it is a one-line follow-up if it dominates.

**Two CHECK constraints beyond the spec's explicit list**, both making a stated invariant mechanical: `cardinality(slice_paths) <= 24` (spec 3.2 and 4.1 both state the 24 cap) and `source <> 'cli' or cardinality(slice_paths) = 0` (spec 4.1.3: CLI clips have no slices).

**Two caps deliberately left OUT of the database**: `page_text` 1 MB and `links` 1,000. Spec 3.1 and 4.1 put both in the capture function, which truncates and sets a flag. A CHECK would turn an oversized page into a hard insert failure and lose the clip instead of degrading gracefully.

**`.claude/skills/mcp-platform/SKILL.md` is stale on `register_table`.** It shows `register_table('my_table', audited => true, ...)`. The live contract (`COMMENT ON SCHEMA platform`) requires `p_`-prefixed parameters and an explicitly schema-qualified name, because the first parameter is `regclass` and an unqualified name resolves through `search_path`. The migration uses the live form; the skill's own preamble says the schema comment wins. Worth fixing the skill file at some point so the next reader is not misled.

**`clipboard-test` bucket appears to be already gone.** `supabase storage ls --linked --experimental` returns only `sam-audio/` and `sam-scores/`, and `supabase storage rm -r ss:///clipboard-test` reports `{"deleted":[],"buckets_deleted":[]}`. The Storage API therefore does not see it. 064 confirms that against `storage.buckets`, which is authoritative, and removes a stale row if one survived. Expect it to report "nothing to do".

Useful discovery for later steps: **`supabase storage ls | cp | mv | rm` work against the linked project** with `--linked --experimental`, authenticated by the CLI's own stored credentials. That is a way to inspect and clean the `clipboard` bucket during Steps 3 and 6 without a service-role key.

### deno check: baseline is 97 pre-existing errors

`deno` is installed (2.9.7, via winget) but was not on the PATH inherited by this session's shells; the working path is
`C:\Users\Alex\AppData\Local\Microsoft\WinGet\Packages\DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe\deno.exe`.

Command for the MCP function:

```
deno check --no-lock --config supabase/functions/mcp/deno.json supabase/functions/mcp/index.ts
```

**It reports 97 errors, and all 97 are pre-existing.** Verified by running the same check against the pre-Step-1 commit (`git show HEAD~1:...` into a temp file in the same directory so relative imports resolve): 97 before, 97 after, identical code distribution. Step 1's change introduced none, and no error mentions `McpBlock`, `__mcp_content` or `content`.

Distribution: 69 × TS7006 (implicit `any` on the `args` parameter of `server.registerTool` callbacks — the MCP SDK does not annotate it), 12 × TS2339, 6 × TS2554, 5 × TS2352, and one each of TS7031, TS2693, TS2351, TS2345, TS2322. Spread across `mcp/index.ts` and five `_shared/tools/*.ts` files. They have never blocked anything because the Supabase CLI bundles without typechecking.

**So the useful signal from here on is the DELTA, not the count.** Every later step reports "97 before, N after"; anything above 97 is mine and gets fixed before deploy. Clearing the existing 97 would touch 70+ call sites in working code and is a separate cleanup — worth doing, but not inside a clipboard step.

No TypeScript changed in Step 2, so there is nothing new to check this step.

### Open issue: the spike's tiles failure was never diagnosed from logs

Spec decision 2 says server-side slicing "crashed the edge function". That is accurate as an observation — `mode: "tiles"` returned a bare "Error occurred during tool execution" with no message from the tool's own code, while every failure path in it produced a specific message, which points at the isolate being killed rather than a throw. But **the actual limit was never read from the logs.** Supabase CLI 2.117.0 has no `logs` subcommand, edge function logs live in Logflare rather than Postgres so the SQL Editor cannot reach them, and there is no Supabase access token on this machine for the Management API.

This does not threaten the design — slicing in the browser is the right call regardless, and the spike proved the client-sliced path works end to end. It is recorded because if a future clip ever fails in a similar way, "we never learned whether that was CPU time or memory" is the missing fact. The query to get it is in the Dashboard's Edge Functions → mcp → Logs, against `function_logs`, looking for `WORKER_LIMIT`, `CPU time limit`, or `memory limit exceeded`.
