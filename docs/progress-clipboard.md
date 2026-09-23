# Progress: Alfred Clipboard

## Status: Phase 1 in progress — Step 2 migrations written, awaiting Alex's run + CONFORMANT

Spec: docs/technical-spec-clipboard.md

## Phase 1: capture and read

- [x] Step 1: Spike cleanup. Delete `supabase/functions/_shared/tools/clipboard-test.ts`, `scripts/clipboard-tile-screenshot.mjs`, and the two TEMPORARY fenced blocks in `supabase/functions/mcp/index.ts`. Keep the `McpBlock` / `__mcp_content` passthrough, rewrite its comment as a permanent feature, and commit. Give Alex the SQL to drop the temporary `clipboard-test` read policy, and tell him to delete the `clipboard-test` bucket and the "CLIPBOARD TEST" inbox item by hand. Deploy `mcp`, verify `verify_jwt`. — **done 2026-09-23**, `mcp` v109. Three manual items outstanding for Alex (storage policy, bucket, inbox item); see notes.
- [x] Step 2: Migration file for the `clips` table, the `clipboard` bucket, and its read policy, ending with `register_table`. Alex runs it; `check_platform_conformance` must return CONFORMANT. — **done 2026-09-23.** `063_clips_table_and_clipboard_bucket.sql` returned CONFORMANT across all 44 non-exempt tables; table, constraints, indexes, owner RLS policy and registry row all as expected; bucket private, 2 MB, `image/jpeg` only. `064_drop_clipboard_test_bucket.sql` confirmed the spike bucket and its objects gone.
- [ ] Step 3: `clip-capture` edge function, its `config.toml` block (committed before first deploy), and the secrets `CLIPBOARD_SECRET` and `CLIPBOARD_USER_ID`. Test both endpoints with curl. — **function written, committed before the first deploy, deployed (v3), secrets set, endpoint tests A–F all pass.** Awaiting Alex's Test G (the database-side confirmation) before this is closed.
- [ ] Step 4: MCP tools: `get_recent_clips`, `get_clip_slices`, `archive_inbox_item`, and the `get_inbox` `source_type` filter. Deploy, verify `verify_jwt`. Tested in a fresh thread.
- [ ] Step 5: Frontend minimum: source icons for `clipboard` and `cli`; realtime handler drops archived rows.
- [ ] Step 6: Chrome extension in `extension/`: options page, capture, slicing, upload, finish, badge. Alex loads it unpacked and clips three real pages (a long job posting, a short page, and a `chrome://` page to check the clean failure).
- [ ] Step 7: `scripts/clip.mjs` and the `CLAUDE.md` rule for pushing CLI reports.
- [ ] Step 8: Alex adds the project instruction in claude.ai, rotates the notification dispatch secret, and runs the end-to-end test in a fresh thread.

## Phase 2: jobs

- [ ] Step 9: Migration adding `posting_url` and `duplicate_of` to `job_applications`. Alex runs it; CONFORMANT. **Also add `clips.links_truncated` (boolean, not null, default false) in this same migration** — decided 2026-09-23, deferred here from Step 3 rather than changing the agreed data model mid-Phase-1. `clip-capture` must then set it from the `links_dropped` it already computes, and that change needs a `clip-capture` redeploy alongside the migration. See the Step 3 notes for why the gap exists.
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

**The bucket read policy is folder-based** — `(storage.foldername(name))[1] = auth.uid()::text` — rather than `owner = auth.uid()`. The reasoning was that spec decision 6 uploads slices through service-issued signed links, so `storage.objects.owner` is the service role or null and never Alex, and an owner-based policy would match nothing and fail every slice read. This was written up as a possible departure from "copy the sam-scores policy" (spec 3.2). **Verified on Alex's run: sam-scores is folder-based too, so there is no divergence** — both buckets rely on the same guarantee, and the concern is closed.

**Decision: `p_audited => true`.** The contract reserves `false` for high-volume append-only telemetry; clips are a few a day, so the exception does not apply. The cost is recorded in the migration header: the audit trigger keeps a row copy, so a clip's page text is stored twice and deleting a clip will not reclaim the audit copy. That belongs in the 2026-10-23 storage review decision 10 already schedules. Flipping it is a one-line follow-up if it dominates.

**Two CHECK constraints beyond the spec's explicit list**, both making a stated invariant mechanical: `cardinality(slice_paths) <= 24` (spec 3.2 and 4.1 both state the 24 cap) and `source <> 'cli' or cardinality(slice_paths) = 0` (spec 4.1.3: CLI clips have no slices).

**Two caps deliberately left OUT of the database**: `page_text` 1 MB and `links` 1,000. Spec 3.1 and 4.1 put both in the capture function, which truncates and sets a flag. A CHECK would turn an oversized page into a hard insert failure and lose the clip instead of degrading gracefully.

**`.claude/skills/mcp-platform/SKILL.md` is stale on `register_table`.** It shows `register_table('my_table', audited => true, ...)`. The live contract (`COMMENT ON SCHEMA platform`) requires `p_`-prefixed parameters and an explicitly schema-qualified name, because the first parameter is `regclass` and an unqualified name resolves through `search_path`. The migration uses the live form; the skill's own preamble says the schema comment wins. Worth fixing the skill file at some point so the next reader is not misled.

**`clipboard-test` bucket appears to be already gone.** `supabase storage ls --linked --experimental` returns only `sam-audio/` and `sam-scores/`, and `supabase storage rm -r ss:///clipboard-test` reports `{"deleted":[],"buckets_deleted":[]}`. The Storage API therefore does not see it. 064 confirms that against `storage.buckets`, which is authoritative, and removes a stale row if one survived. Expect it to report "nothing to do".

Useful discovery for later steps: **`supabase storage ls | cp | mv | rm` work against the linked project** with `--linked --experimental`, authenticated by the CLI's own stored credentials. That is a way to inspect and clean the `clipboard` bucket during Steps 3 and 6 without a service-role key.

### Step 3 — clip-capture edge function, 2026-09-23

`supabase/functions/clip-capture/index.ts` plus its `deno.json`, and the `[functions.clip-capture]` block in `supabase/config.toml`. **Plain `Deno.serve` with manual routing, not Hono** — matching `email-capture`, `notify-dispatch`, `push-send` and `sam-song-scores`, all of which are standalone functions with no extra dependency. `mcp` is the only function that needs Hono, because it hosts the MCP transport.

`deno check`: **clip-capture 0 errors; mcp unchanged at 97.** Delta zero.

**Judgment calls, none of which reopen a spec decision:**

- **`/start` writes nothing to the database.** It mints a uuid and one single-use upload link per slice; `/finish` writes the rows. That is spec decision 7 (upload first, record second) taken literally — an abandoned `start` costs a few unused links and leaves no trace.
- **Slice paths are validated against `{user_id}/{clip_id}/` before anything is written.** Cheap, and it is what stops a malformed caller recording a row pointing at another user's object — the service role would read it happily and the bucket's read policy would never be consulted.
- **A missing slice returns 409 and writes nothing**, listing what was missing and what was found. The clip id and its upload links stay valid, so the caller can re-upload and retry.
- **If the inbox insert fails, the clip row is rolled back.** A clip with no inbox row is not merely incomplete, it is *silent* — the inbox is the only way a clip gets mentioned to Alex or Claude. Better to write nothing and let the caller retry. The uploaded slices stay in storage, orphaned; that is the accepted cost under decision 10, and a retry reuses the same paths.
- **If the final `clips.inbox_id` update fails, that is NOT an error.** Both rows exist and are correct, and `inbox.source_metadata.clip_id` already carries the link in the other direction, so nothing is unrecoverable. The response carries a `warning` instead. Rolling back two good rows over a convenience pointer would be the worse outcome.
- **Text truncation is byte-accurate.** `String.prototype.slice` counts UTF-16 code units, not bytes, so the 1 MB cap is applied by encoding, cutting the byte array, and letting a non-fatal `TextDecoder` turn a split character at the boundary into U+FFFD, which is then stripped. Always valid UTF-8, always at or under the cap.
- **CORS reflects `chrome-extension://` origins** rather than hard-coding one, because the extension id is not known until Step 6. The header comment says plainly that CORS is not the security boundary here — non-browser callers ignore it entirely, and the secret is the actual gate.
- **OPTIONS is answered before the secret check**, because a browser preflight carries no custom headers and would otherwise be rejected before the extension could ever send one. The preflight response reveals nothing.
- **A 401 says only `unauthorized`** — never whether the header was absent, the wrong length, or simply wrong.

**⚠️ Gap in the data model: link truncation is silent. RESOLVED — deferred to Step 9.** Spec 3.1 defines `text_truncated` and `screenshot_truncated` but no `links_truncated`, so a page with more than 1,000 links has the excess dropped with no record on the row. The `/finish` response reports `links_dropped` and that is currently the only place it appears. **Alex's call, 2026-09-23: add the column, but in the Phase 2 migration (Step 9), not now** — so Phase 1 does not change the agreed data model mid-flight. Until then, if "Claude missed a listing on a huge job board" comes up, this is the first thing to check.

Note the semantics, because the column will be derived from them: **`links_dropped` counts links lost to the 1,000 cap only.** De-duplication is not loss — three links with two distinct hrefs give `links_stored: 2, links_dropped: 0`. (My own Test D prediction said `links_dropped: 1` for the duplicate; that prediction was wrong, the code was right, and the test now asserts the correct value.)

**Endpoint tests A–F, run 2026-09-23 against clip-capture v3 — all pass:**

| | Test | Result |
|---|---|---|
| A | wrong secret (long enough to pass a length check) → 401 `{ok:false,error:"unauthorized"}`, no detail | pass |
| B | no secret header at all → same 401 | pass |
| C | `/start` → clip id + 2 uploads at `{user_id}/{clip_id}/slice-0N.jpg` | pass |
| D1 | both slices PUT to their signed links → 200 | pass |
| D2 | `/finish` → ok, `slice_count 2`, `links_stored 2`, `links_dropped 0`, no warning | pass |
| E | claimed-but-absent slices → 409, `missing` listed, nothing written | pass |
| F | cli clip with no `/start` and no slices → ok, `slice_count 0` | pass |

Test ids kept for Step 4: clipboard clip `14746114-3a4d-44a1-909f-11d7157c255a` / inbox `d680b849-2a88-4d52-89df-3f38ec732655`; cli clip `466a3631-de46-4de8-a0a0-edeb068ed24b` / inbox `4800354b-3525-4672-94eb-df4c43c1c30d`. Test E's clip `992aee1e-d695-432f-9238-73c8386e1edd` must NOT exist in the database.

**One bug found and fixed before testing:** `normaliseLinks` incremented a `considered` counter it never used — dead code, no runtime effect, removed and redeployed before the tests ran rather than left to linger.

**⚠️ `mcp` went from v109 to v110 without anyone deploying it.** Observed during this step's verification. The most likely cause is `supabase secrets set` re-versioning the project's functions so they pick up new environment values — the built-in `SUPABASE_*` secrets all show an `updated_at` from the same window. **`verify_jwt` survived as false on both functions**, confirmed by `functions list` and by an unauthenticated request that each function's own code answered. Recording it because an unexplained version bump is exactly the shape of the problem this project has been bitten by twice, and "we saw it and checked" is worth more than "we assume it was fine".

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
