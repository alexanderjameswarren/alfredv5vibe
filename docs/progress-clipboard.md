# Progress: Alfred Clipboard

## Status: **Phase 1 complete.** Phase 2 started - Step 9 migration written, awaiting Alex's run + CONFORMANT.

Spec: docs/technical-spec-clipboard.md

## Phase 1: capture and read

- [x] Step 1: Spike cleanup. Delete `supabase/functions/_shared/tools/clipboard-test.ts`, `scripts/clipboard-tile-screenshot.mjs`, and the two TEMPORARY fenced blocks in `supabase/functions/mcp/index.ts`. Keep the `McpBlock` / `__mcp_content` passthrough, rewrite its comment as a permanent feature, and commit. Give Alex the SQL to drop the temporary `clipboard-test` read policy, and tell him to delete the `clipboard-test` bucket and the "CLIPBOARD TEST" inbox item by hand. Deploy `mcp`, verify `verify_jwt`. — **done 2026-09-23**, `mcp` v109. Three manual items outstanding for Alex (storage policy, bucket, inbox item); see notes.
- [x] Step 2: Migration file for the `clips` table, the `clipboard` bucket, and its read policy, ending with `register_table`. Alex runs it; `check_platform_conformance` must return CONFORMANT. — **done 2026-09-23.** `063_clips_table_and_clipboard_bucket.sql` returned CONFORMANT across all 44 non-exempt tables; table, constraints, indexes, owner RLS policy and registry row all as expected; bucket private, 2 MB, `image/jpeg` only. `064_drop_clipboard_test_bucket.sql` confirmed the spike bucket and its objects gone.
- [x] Step 3: `clip-capture` edge function, its `config.toml` block (committed before first deploy), and the secrets `CLIPBOARD_SECRET` and `CLIPBOARD_USER_ID`. Test both endpoints with curl. — **function written, committed before the first deploy, deployed (v3), secrets set, endpoint tests A–F all pass.** **Verified via Test G:** two clips, `test_e_must_be_absent` empty, both paired soundly, zero clips without an inbox pointer, both slice files present.
- [x] Step 4: MCP tools: `get_recent_clips`, `get_clip_slices`, `archive_inbox_item`, and the `get_inbox` `source_type` filter. Deploy, verify `verify_jwt`. Tested in a fresh thread. — **written and deployed 2026-09-23** (`mcp` v111, 75 registered tools, `deno check` delta zero). **Verified in a fresh thread:** all ten checks passed, including the clean "no screenshot" error on a CLI clip and Claude understanding from the descriptions alone that a clip may hold several items.
- [x] Step 5: Frontend minimum: source icons for `clipboard` and `cli`; realtime handler drops archived rows. — **done 2026-09-23.** Both icons correct, an archived item vanished live and returned live on un-archive, ordinary capture unaffected, no console errors. (`npm start` first failed on "Environment key jest/globals is unknown"; `npm ci` fixed it — almost certainly node_modules drift from the `sharp` install/uninstall in Step 2. Worth remembering: `--no-save` keeps the manifests clean but not the tree.)
- [x] Step 5b: The inbox trash can archives instead of deleting, and records why. `inbox.archive_reason` ('discarded' | 'processed'); `archive_inbox_item` writes 'processed' and clears on un-archive; `get_recent_clips` treats a clip whose inbox row is MISSING as archived. Spec decision 14. — **066 run (CONFORMANT, 44 tables, both constraints present, all 10 existing rows null). App checks passed: "Capture discarded." with working undo, labels read "Discard", a discarded capture is archived with reason 'discarded' rather than deleted, save-through-the-form still commits. `mcp` deployed v112.** **Verified in a fresh thread:** archiving set `archive_reason` 'processed', un-archiving cleared all three fields.
- [x] Step 6: Chrome extension in `extension/`: options page, capture, slicing, upload, finish, badge. Alex loads it unpacked and clips three real pages (a long job posting, a short page, and a `chrome://` page to check the clean failure). — **first version 2026-09-23: install, options, saving, pairing, text read-back and the `chrome://` refusal all verified.** Three faults found in real use and fixed in Step 6a below: screenshots wrapping to the top, double-click duplicates, and `get_recent_clips` missing `page_width`/`page_height`. Retest: the wrap is FIXED (Yahoo re-clipped as 7 slices, final slice showing the true page bottom). Two pages that scroll inside a container were correctly flagged incomplete — accepted as limitations, see spec §2.1. Step 6b then fixed the truncation REASON, which was being mis-reported by the server. Geometry tests 34/34. `clip-capture` v4, `mcp` v114. Awaiting Alex's final retest.
- [x] Step 6c: Silent default capture (visible screen, no debugger banner); full-page capture moved to a right-click menu item and a second shortcut; abort cleanly on navigation or tab close. - **done 2026-09-23.** Verified: silent click showed no banner (1 slice, `capture_mode` visible, note opening "VISIBLE SCREEN ONLY, BY CHOICE", and a scrolled clip correctly reporting 952px down); "Clip full page" showed the banner and gave 7 slices, "FULL PAGE, complete", worst join 1.51; closing the tab mid-capture gave a red `!` with nothing saved; `visible_clips_not_flagged_truncated` empty; and from `get_clip_slices` ALONE a fresh thread described the visible clip as part of the page with nothing wrong. Clicking a link mid-capture was not tested — the page blurs and shifts during a full-page capture, which is accepted.
- [x] Step 7: `scripts/clip.mjs` and the `CLAUDE.md` rule for pushing CLI reports. - **done 2026-09-23.** Pushed its own report as the first real CLI clip (`089ad3dd-...`), and a claude.ai thread read it with `get_recent_clips` source `cli` with nothing pasted, then archived its inbox item.
- [x] Step 7b: Run tags, so "CLI responded" picks up the right report when several CLI sessions are running. `clip.mjs --tag`; `run_tag`, `repo` and `branch` in `source_metadata`; `get_recent_clips` returns all three and filters on `run_tag`; the `CLAUDE.md` rule passes the prompt's tag. - **done 2026-09-23.** Verified: `run_tag` "clip-7b-q4m2" returned exactly that report (repo alfred-v5, branch main); "no-such-tag" returned zero.
- [x] Step 7c: Investigate the report that a fresh thread's `get_recent_clips` definition lacked `run_tag`. - **2026-09-23: no code fault.** The deployed v117 bundle already contained the `run_tag` zod input and the disambiguation rule, proven by downloading it (see notes). Cause is a stale client-side tool manifest; spec §7 already requires disconnecting and reconnecting the connector, not just a fresh thread. Redeployed as v118 to bump the version. **Confirmed after a connector reconnect.**
- [x] Step 8: Alex adds the project instruction in claude.ai, rotates the notification dispatch secret, and runs the end-to-end test in a fresh thread. - **done 2026-09-23.** Project instructions added; the notification dispatch secret rotated with `cron.alter_job` (`net._http_response` shows 200s after one expected 401 during the switch, which is the job and the function changing a moment apart - see 033's note that the two must change together or every call 401s); fresh-thread checks pass.

**PHASE 1 COMPLETE.**

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

### Step 4 — the four tool changes, 2026-09-23

New module `supabase/functions/_shared/tools/clipboard.ts` holding `get_recent_clips` (tier 1), `get_clip_slices` (tier 1) and `archive_inbox_item` (tier 2), plus the `source_type` filter and description fix on `get_inbox` in `mcp/index.ts`. `mcp` v111, 75 registered tools (was 72).

**`deno check` delta: zero.** 97 before, 97 after, identical distribution; `clipboard.ts` contributes none and checks clean on its own. It was briefly 101 — see the fixes note below.

**`CLIP_VOCAB`**, a shared description block appended to both clip tools, following the `JOB_VOCAB` pattern in `job-applications.ts` so the two tools cannot drift on the thing the model most needs to know: a clip is a WHOLE page and often holds several distinct items; read the text first; fetch slices only when layout or visuals matter or the text came out thin; the `links` list is how to point Alex at the other items on a page he clipped.

**Archived state is judged by the paired inbox row, which forced a two-query design.** `clips` has no foreign key to `inbox` (deliberately — triage hard-deletes inbox rows), so PostgREST cannot embed the join and `include_archived` cannot be a simple `.eq()`. `get_recent_clips` therefore over-fetches up to `ARCHIVE_SCAN_WINDOW` (50) recent clips, looks up their inbox `archived` flags in one `.in()` query, filters, then cuts to `limit`. At a few clips a day that window is the whole history several times over. A clip whose `inbox_id` is null counts as not archived, which is true — there is no inbox row hiding it.

**Two response-only caps on `get_recent_clips`, each flagged.** The platform contract says list reads exclude heavy jsonb; `page_text` and `links` are exactly that, and this tool returns both because delivering them *is* the tool. The obligation that comes with the exception is a bounded reply, so `page_text` is cut at 60,000 characters and `links` at 200 entries, per clip, with `page_text_truncated_in_response` / `page_text_total_chars` and `links_truncated_in_response` / `link_count` alongside. **These are distinct from `clips.text_truncated`** and the code says so: `text_truncated` means the stored text is not the whole page; the response flag means the stored text is whole but this reply is not. A clip can carry either, both, or neither.

**`get_clip_slices` downloads through `ctx.db`**, per spec 4.2 — the caller's own token, so the bucket's folder-per-user read policy is what decides. Not the service role. Caps at 8 image blocks and names the `from` value to continue at; also carries a 12 MB base64 budget that real 40-80 KB slices will never reach, for the case where something puts 2 MB objects in the bucket.

**`get_inbox`'s two queries now carry a comment saying they must stay in step.** The `source_type` filter had to be added to both the main query and the mirrored count query; a filter on only one of them makes the "N of M" truncation NOTE quietly lie, which is worse than no NOTE because the model believes it. Description also corrected to list all four `ai_status` values including `re_enriched`, which it had been omitting.

**Two new type errors were introduced and fixed before deploy**, which is the delta discipline working as intended rather than a clean first pass:

- `TS2352` on `(data ?? []) as Row[]` in `clipboard.ts` — supabase-js types a select's `data` as a union including `GenericStringError[]`, which does not overlap `Row`. Fixed with `as unknown as Row[]` and a comment noting the cast is still ours to own, because the column list is hand-typed and nothing verifies it.
- three `TS7006` implicit-`any` on the new `registerTool` callbacks. Annotated `args: Record<string, unknown>`. **The same one-line annotation would clear the other 69 pre-existing TS7006s**, which remain the separate cleanup already noted below. New code is annotated; the backlog is untouched.

**⚠️ Every function's version bumped, not just the one deployed.** Deploying `mcp` alone left the list reading `ai-enrich` v11→v12, `email-capture` v8→v9, `push-send` v4→v5, `notify-dispatch` v4→v5, `sam-song-scores` v1→v2. Combined with the unexplained v109→v110 on `mcp` last step, the likely explanation is that the platform re-versions every function on certain project-level changes rather than only on deploy. **All seven `verify_jwt` flags held their correct values through it**, and the two that matter were confirmed by unauthenticated request as well. Recorded because a project-wide version bump is precisely the event that could flip a flag silently, and now we know it does not.

### Step 5 — frontend minimum, 2026-09-23

`src/Alfred.jsx` only, two sites, per spec 4.3. No edge function touched, so no deploy and no `deno check`. Full suite green: 64 suites, 1379 tests. **The `InboxCard` normaliser copies and the dirty check were not touched**, as instructed.

**1. `SourceIcon`** gains `clipboard` → `Paperclip` and `cli` → `Terminal` (both confirmed present in the installed lucide-react). A comment now records why this map is a maintenance hazard: its fallback is `manual`, so an unrecognised `source_type` renders as a pencil — quietly wrong rather than visibly wrong — and nothing in the database constrains `source_type` (no check, no enum), so a new writer that forgets this map produces no error anywhere. That is the argument for adding the icon in the same change as the writer.

**2. `handleInboxChange`** now keeps the realtime list in step with what both loaders do. `loadData` and `refreshData` filter `archived` out, and until Step 4 nothing ever wrote that column — human triage hard-deletes, so the DELETE branch was the whole story. `archive_inbox_item` revives it, so a row can now leave the list without being deleted, and an open inbox screen would otherwise keep showing an item Claude had already handled until the next background refresh.

**The UPDATE branch handles both directions, which is one step past the literal spec line** ("drop rows whose `archived` is true"). An un-archived row has to come back, and by then it is no longer in `prev`, so the existing `map` would silently do nothing and the item would reappear only on refresh. Half a handler reads as a bug to whoever finds it next, and the asymmetry would have shown up immediately in the archive/un-archive test. A small `upsertSorted` helper is shared by the INSERT and UPDATE paths so both keep the `createdAt`-ascending order the loaders use. INSERT now also ignores a row that arrives already archived.

### Step 5b — the trash can archives, 2026-09-23

**The bug, confirmed from the code before changing anything.** `get_recent_clips` called a helper that returned the inbox ids it *found* with `archived = true`. A clip whose inbox row had been **deleted** was therefore absent from that set and counted as live. Deletion was exactly what the trash can did, so the one action meant to make a clip go away made it permanent: it returned to every new conversation, for ever, and nothing could stop it. Alex spotted this before it bit; it was never hit in practice because no clip had been binned yet.

**The fix inverts the question.** The helper is now `liveInboxIds` and returns ids that are present *and* not archived. Both ways of leaving the inbox — archived, or gone — then fall on the same side of the test, because neither is in the answer. A null `inbox_id` still counts as live, and that is deliberate: it means the pairing update failed at capture time, so an inbox row does exist and is untriaged, we just do not know which one. Treating that as handled would hide a clip nobody had looked at.

**Six parts, all written:**

1. **`066_inbox_archive_reason.sql`** — `archive_reason text` on `inbox`, nullable, commented, with `inbox_archive_reason_check` (null | 'discarded' | 'processed'). ⚠️ **Must be run before the mcp deploy**, because `archive_inbox_item` writes the column.
2. **The trash can archives.** `deleteInboxItem` → `discardInboxItem`, setting `archived`, `triaged_at` and `archive_reason: 'discarded'`. The undo writes the original row back, restoring all three together.
3. **`archive_inbox_item`** writes `'processed'` when archiving and clears it on un-archive.
4. **`handleInboxSave` is untouched** and still hard-deletes on successful triage. That is now the ONLY hard delete left on the inbox. Phase 3's one-tap process button is where it becomes an archive with `'processed'` — noted against Phase 3 below and in decision 14.
5. **`get_recent_clips`** treats a missing inbox row as archived, as above.
6. **Spec decision 14** records the reversal and its reason.

**One constraint beyond the request:** `inbox_archive_reason_needs_archived`, refusing a reason on a row that is not archived. Modelled on `job_applications_due_needs_action` in the same schema, which exists for the identical shape of problem — a dependent field meaningless without its parent flag. A reason without `archived` would read as dispositioned while sitting in the inbox. Every writer today satisfies it. One line to drop if it gets in the way.

**Renamed the prop, and the comments that had gone stale.** `onDelete` → `onDiscard`, and both button labels changed from "Delete" to "Discard". The old comment on that prop said Step 10 renamed it *away* from `onArchive` precisely so the name would not lie about behaviour — leaving it called `onDelete` while it archives would have repeated the mistake that comment warns about. Two other comments claiming "this removes the row" were corrected. `InboxCard`'s normaliser copies and dirty check were not touched.

**⚠️ `supabase storage rm` does not work in CLI 2.117.0.** It resolves paths for `ls` but issues no DELETE call and always reports `{"deleted":[],"buckets_deleted":[]}`. Confirmed with `--debug`: the only HTTP call is a GET for api-keys. `ss:///bucket/prefix` is the correct URL form (the alternative errors with `LegacyStorageInvalidUrlError`), and `ls` on the exact object path resolves it — so it is `rm` that is broken, not the path.

**That corrects an inference from Step 2.** I read `rm -r ss:///clipboard-test` returning `{"deleted":[]}` as evidence the bucket was empty. Given `rm` never deletes anything, that reasoning was unsound. The conclusion still held, but on the other two pieces of evidence: the root `ls` listing only `sam-audio/` and `sam-scores/`, and `064`'s SQL against `storage.buckets`. Deleting objects needs the dashboard or a service-role call; the `clipboard` bucket has no DELETE policy, so a user token cannot do it either.

### Step 6 — the Chrome extension, 2026-09-23

`extension/` at the repo root. Manifest V3, plain ES modules, **no build step**. No edge function changed, so no `deno check` delta and nothing deployed. Nine files plus a README written for someone who has never side-loaded an extension.

**Nothing depends on the extension id**, which matters because it will be loaded unpacked on three machines and an unpacked extension gets a different id on each. No id appears in the code, the manifest, or on the server: `clip-capture` reflects whatever `chrome-extension://` origin arrives rather than matching a known one, and authentication is the per-machine shared secret. A fourth machine needs no server change. Asserted mechanically in the validation script — the manifest contains no `chrome-extension://` string at all.

**The secret is nowhere in the repo.** `lib/config.js` holds `DEFAULT_BASE_URL` and nothing else; the secret has no default, is typed into the options page, and lives only in `chrome.storage.local`. `local` and not `sync` deliberately: `sync` would push a shared secret to every signed-in machine through the Google account, and pasting it once per machine should be a decision rather than a browser feature.

**Geometry is pure and unit-tested — `node extension/lib/plan.test.mjs`, 20/20.** `lib/plan.js` has no Chrome APIs and no canvas, so the arithmetic that decides whether a page is fully captured can be checked without a browser. It includes the 4160px case the Step 2 local slicer had already proved, so the extension and that script agree by construction.

**The tests found dead code, and the dead code was mine.** `planTiles` carried a "drop a trailing sliver shorter than the overlap" guard, copied from the Step 2 script. It can never fire: reaching iteration `top = k*step` at all requires the previous tile not to have finished the page, which rearranges to exactly the negation of the sliver condition. Measured to confirm — `totalHeight` 1751 yields a final tile of 51, and 1750 stops a tile earlier, so the smallest last tile possible is `overlap + 1`. The guard is gone and the proof is in the function's comment so nobody helpfully re-adds it. Two tests now pin the real property instead: the minimum last-tile height, and that every tile after the first adds new page beyond the overlap.

**Chrome renders the downscale, we only crop.** `Page.captureScreenshot`'s clip takes a `scale`, so the capture comes back at ~1280 wide instead of full resolution. That saves memory and, more importantly, keeps a tall page under Chrome's maximum texture size — `planCapture` also clips the requested HEIGHT to what 24 slices can hold, so a 1920×60000 page asks for 30675 rows rather than 60000 and is marked `screenshot_truncated`. Asking for the full height and throwing most of it away would risk Chrome refusing the capture outright with an error that explains nothing.

**Measuring and capturing are one debugger session**, not two, because each attach raises Chrome's "is debugging this browser" banner and two round trips would flash it twice per clip. Detach is in a `finally` so a throw cannot leave the banner up.

**`cssContentSize`, not `contentSize`.** The clip is measured in CSS pixels; `contentSize` is the older field and can come back in device pixels on a high-DPI screen, which would ask for a region the wrong size and silently capture a fraction of the page.

**The popup is switched on and off rather than declared.** Chrome fires `action.onClicked` only when there is no `default_popup` — declaring one would mean the icon could never clip. So the manifest declares none, a failure turns the popup on for exactly one click, and `popup.js` turns it off again as it opens, first thing, before any rendering, so an exception cannot leave the icon stuck showing a stale error. The keyboard shortcut is its own command rather than `_execute_action`, so it always clips even while the popup is switched on.

**`/start` is called even for a text-only clip.** A clipboard clip needs a server-minted `clip_id` and `/start` is where ids come from; it writes nothing, so calling it with `slice_count: 0` costs nothing and keeps one code path.

**Uploads are sequential, not parallel.** Twenty-four simultaneous multi-hundred-kilobyte PUTs from a service worker is a good way to have a few fail, and `/finish` would then refuse the whole clip.

**Two small things worth knowing:**

- **Text-only clips report as a red `!`** even though they saved. The clip is real and in Alfred with its text and links, but calling a missing screenshot a clean success would hide it. The popup explains.
- **No icons.** Chrome draws a lettered placeholder, which is enough to find on a toolbar. Adding three PNGs and an `icons` block is all it would take; skipped rather than commit binary files I cannot see.

### Step 6a — three fixes after the first real use, 2026-09-23

Step 6's first version installed, saved, paired and read back correctly, and `chrome://settings` failed cleanly. Three faults found in real use.

#### 1. Screenshots wrapped back to the top — the important one

**Symptom.** On a 1905 x 10404 Yahoo article and a 1905 x 10294 job board, the last slices showed the TOP of the page again — the opening photo and its caption, the site header and first card — instead of the article's end and the footer. Both clips said `screenshot_truncated: false`, so they claimed a complete screenshot they did not have. A 1920 x 5994 page had been fine.

**What it was not.** The slicer. `planCapture`/`planTiles` on 1905 x 10404 give scale 0.6719, a scaled height of 6991, 9 tiles, and a final tile of **191px** — exactly the "~190 px strip" observed. The 80k board gives 9 tiles with a 117px last tile. The geometry was right to the pixel, and neither page is anywhere near the 24-slice cap. So the corruption was **inside the single bitmap Chrome returned**. There is now a test pinning those two cases so this cannot be re-litigated.

**The cause.** Inferred, not measured: fine at ~6000 rows, wrapped at ~10300, with the tail repeating the head, is what exceeding an internal surface or texture limit looks like. `clip.scale` does not protect against it, because the limit applies to what Chrome COMPOSITES, not to what it hands back — which is why passing scale did not help.

⚠️ **I could not measure it directly, and said so.** Alex asked for the exact slice and pixel row where repetition starts. `supabase storage` in CLI 2.117.0 **cannot download**: remote→local `cp` refuses with `LegacyStorageUnsupportedOperationError` (with or without `-r`), and `rm` silently does nothing. Only `ls` works. So the causal story rests on the numbers above rather than on the pixels, and the fix is built so that being wrong about the cause still cannot produce a lying clip.

**The fix, two halves that only work together:**

- **One capture per tile.** Each `Page.captureScreenshot` now asks for one tile's clip — about 1350 CSS pixels tall, never the whole page. Nothing goes near any limit. Chrome also encodes the JPEG, so no bitmap is decoded, resized or re-encoded in the service worker at all: `lib/slice.js` is deleted.
- **A coherence check that can actually see a failure.** Consecutive tiles share 50 rows; on a sound capture those are the same pixels twice and differ only by JPEG noise (measured at 0.46 and 0.54 in Step 2). `lib/verify.js` measures every join, and anything over `OVERLAP_MAX_DIFF` (12) means the picture jumped: the tiles from there on are **discarded**, the remainder renumbered, and `screenshot_truncated` set true with the reason recorded.

  **This is why the two halves are one change.** Slicing a single bitmap made the check worthless — two slices cut from the same bitmap share its corruption and have identical overlaps by construction, so the old design could not have detected its own failure. Separate captures are what make the joins meaningful.

  Also checked: if every tile comes back byte-identical, Chrome ignored the clip's y offset entirely, and no overlap comparison could see that either. It is caught separately and refuses to save a screenshot at all.

`screenshot_truncated` now means "you are not looking at the whole page" for either reason — too tall for 24 slices, or tiles thrown away — and the popup says which. The per-join numbers are stored on the result so the next odd screenshot diagnoses itself from the popup, which matters given the slices cannot be pulled out of storage from the command line.

#### 2. Double-click made duplicate clips

Two identical rows 27 seconds apart. A clip takes several seconds and an impatient second click started a second one. Now guarded — but the guard **says something**, because silently dropping the click would look like the button doing nothing: an amber `..` badge, a popup explaining a capture is already running and how long it has been going, and an explicit note that the click was ignored so there would not be two copies. Not a queue: a second click is somebody wondering whether the first worked, not a request for two.

#### 3. `get_recent_clips` now returns `page_width` and `page_height`

Claude had been estimating page height from the slice count — a guess built on a guess. Both columns were already stored; they were simply missing from the select list and the payload. `mcp` v113. `deno check` delta zero.

### Step 6b — honest truncation reasons, 2026-09-23

Retest outcome: **the wrap is fixed.** The Yahoo article re-clipped at 1905 x 7829 as 7 slices, `screenshot_truncated false`, final slice showing the true bottom. Per-tile capture worked. Two other pages came back incomplete and were **correctly flagged** — which is the coherence check doing its job.

**Accepted limitations, not being chased** (also in spec §2.1): pages whose content scrolls inside a container capture only partially — 80,000 Hours (1905 x 6047, 2 usable slices of 5) and a NYT article (1905 x 6562, 1 of 6). Text capture is complete on every page tried, and that is what the clipboard is for.

#### The wrong reason — and it was not the extension

The 80k clip reported the page was "taller than the 24-slice cap". It is 6047px and plans **5** slices. `planCapture(1905, 6047).truncated` is **false**, so the extension's own message could not have said that — it said the join mismatch. The claim came from the server, in two places:

1. **`get_clip_slices` asserted the cap unconditionally.** Any clip with `screenshot_truncated` got `"the page was taller than the 24-slice cap"` with no check whatsoever. Wrong three times out of three: 6047, 6562 and 7829px pages plan 5, 6 and 7 slices.
2. **The `get_recent_clips` description offered the cap as the first of two possible causes**, so a conversation naturally picked it.

The real reason existed only in the extension's popup and reached nothing downstream. Hence both fixes being one change.

**`describeScreenshot()`** in `extension/lib/plan.js` now composes the reason ONCE, from facts, where the facts are. `capHit` comes from `planCapture().truncated` and nothing else may assert it. The service worker records facts (`firstBadTile`, `badJoin`, `capHit`, `slicesPlanned`) rather than assembling prose at each site. Six tests pin it, including one asserting the exact pages that were mis-blamed produce no cap claim.

A test bug worth noting: the first version asserted `!/cap/i`, which fails on the word "capture" that the message legitimately contains. The assertion now targets the claim (`/slice cap/i`, `/taller than/i`), not the substring. The code was right; the test was too broad.

**`screenshot_note`** travels: extension → `/finish` → `inbox.source_metadata.screenshot_note` (no schema change, capped at 1000 chars) → returned by `get_recent_clips`, and used by `get_clip_slices` in place of the cause it used to invent. Where no note exists (clips saved before this), both say only what is certain — the screenshot is incomplete, the reason was not recorded, the text is unaffected. **Never guess a cause.**

`clip-capture` v4, `mcp` v114. `deno check` delta zero. Geometry tests 28 → 34.

### Step 6c — two capture modes, 2026-09-23

Step 6 verified: Yahoo control complete at 7 slices, worst join 1.51; the 80k board correctly incomplete with the right reason and no cap claim; both Alfred inbox screens (live 1905 x 1897, localhost 1905 x 1775) complete at 2 slices with joins under 1.0 and the list readable; older clips correctly reporting no recorded reason. A third accepted limitation added to spec 2.1: `position: fixed` elements appear partway down a full-page screenshot.

**The default click is now silent.** `chrome.tabs.captureVisibleTab` needs no debugger, so no "is debugging this browser" bar. It takes one photograph of the visible screen, scaled to 1280 wide and put through the same `planTiles` rules (usually one slice, two on a tall window). Page size, viewport height and scroll position come from the injected reader, which already runs — so the silent path touches `chrome.debugger` not at all.

**Full page is now a deliberate act**: right-click the toolbar icon then "Clip full page", or Ctrl+Shift+U. The debugger path is unchanged, banner and all.

#### The decision asked for: `screenshot_truncated` is FALSE for a visible capture

`screenshot_truncated` is a **fault flag**, not a coverage flag. It drives `get_clip_slices`'s "SCREENSHOT INCOMPLETE" warning and tells Claude to distrust the picture. A visible capture lost nothing it tried to get — a smaller thing was attempted and achieved — so marking it true would mean every everyday clip arriving pre-labelled as broken, and the word "incomplete" would stop carrying information at all.

What stops it being mistaken for a whole page is two things that travel WITH the clip, not a boolean:

- **`capture_mode`** — `visible` or `full`, in `inbox.source_metadata` (no schema change), returned by `get_recent_clips`. It exists because a one-slice visible capture and a one-slice short page are otherwise indistinguishable in SQL and in a tool payload.
- **`screenshot_note`** — now opens `VISIBLE SCREEN ONLY, BY CHOICE ... not the whole page, and nothing went wrong. The page is WxHpx and you are seeing about Npx of it ...` and names "Clip full page" as the way to get more. Full-page notes open `FULL PAGE, complete:` so the two can never read alike.

**And `get_clip_slices` now surfaces the note ALWAYS, not only when truncated.** That was the gap the decision created: with the flag false, a model fetching slices without calling `get_recent_clips` first would have seen one image and taken it for the page. Five tests pin the wording, including that a visible note contains neither "incomplete" nor "truncated" nor any fault word.

Both tool descriptions now lead with the two-modes distinction and say explicitly: never describe a visible clip as the full page, and never as truncated.

#### Interruptions abort, and nothing is written

`assertTabUnchanged` runs before every tile, and once more immediately before `/finish` — uploads take time too, so the page can change after the last tile. It throws "The page changed during capture, so nothing was saved." (naming both addresses) or "The tab was closed during capture, so nothing was saved." `/finish` is never called, so no row exists. A clip assembled from two different pages would be a convincing lie rather than an obvious failure, which is why this aborts rather than salvages.

**Slices already uploaded when an abort fires stay in storage, unreferenced — noted for the 2026-10-23 storage review.** They cannot be cleaned up from the command line either: `supabase storage rm` does nothing in CLI 2.117.0. Same for slices from a `/finish` that fails for any other reason.

Progress remains **icon-only** — badge counts, green tick, red `!`, amber `..`. No page overlays, no Chrome notifications.

**Two test bugs of my own, both the same shape:** an over-broad negative regex. `!/cap/i` failed on the word "capture"; `!/went wrong/` failed on the deliberate reassurance "nothing went wrong". Both now target the claim rather than the substring. Worth remembering: when asserting that text does NOT say something, match the phrase, not a fragment that innocent wording contains.

### Step 7 — CLI push, 2026-09-23

`scripts/clip.mjs`, the `CLAUDE.md` rule, and `.clip/` gitignored. Pushed its own report as the first real CLI clip: clip `089ad3dd-d301-422a-b45a-acce9602a471`, inbox `d43ae5ef-644d-4c99-8e29-5bc5bcec6742`.

**The registry fallback is the interesting part, and it was verified for real.** `setx` writes the Windows registry, but a shell that is already open keeps the environment it started with — so immediately after setting these, every existing terminal and everything spawned from one still sees nothing. That looks exactly like "the variables are not set" and sends you round the loop again. `clip.mjs` reads the environment first, then `[Environment]::GetEnvironmentVariable(name,'User')` via PowerShell, and fails only when neither works, with a message that explains the staleness rather than just listing what is missing. This session's own shell predates the `setx`, so the fallback is what found both values — tested by accident and then on purpose.

**The secret never reaches output on any path.** Errors name what was missing or wrong and at most a length. It is read from the environment rather than taken as a flag because a command line is visible in the process list and in shell history. A secret under 32 characters is refused locally, mirroring the edge function's own check, so a bad value fails with a sentence instead of arriving as a 500.

A `cli` clip skips `/start` entirely — there are no slices, so there is nothing for an upload link to be for, and `/finish` mints the id.

**The `CLAUDE.md` rule** says the clip is *as well as* the printed report, never instead of it, and that a failed push must be stated in one line at the end of the printed report rather than hidden. A failed push is not a failed task; silently skipping it would leave Alex waiting for something that never arrived.

**`capture_mode` null now resolves to `"full"`** in `get_recent_clips`, per Alex's note. Clips saved before Step 6c recorded no mode and the visible mode did not exist then, so every one of them went through the full-page path — the absence is a known fact, not a guess. Resolved once in the tool rather than left to each reader, because a `null` reaching a model is a `null` it has to guess about, and the obvious guess ("mode unknown, so maybe partial") is the wrong one. `mcp` v116, `deno check` delta zero.

### Step 7b — run tags, 2026-09-23

Two or three CLI sessions run at once, so "CLI responded" cannot mean "the newest report". Every prompt now opens with `Run tag: <tag>` and the report carries it back.

**`clip.mjs --tag`** validates strictly — lowercase letters, digits, hyphens, 1 to 40 — and **refuses a malformed tag rather than mangling it**. A tag only works by exact match, so a silently-normalised one would match nothing, which is worse than no tag at all: it looks like it is working. The failure message says to fix it or drop `--tag` and push untagged.

The tag does two jobs and is stored twice for them: **prefixed to the title as `[tag] `** so Alex can tell concurrent runs apart at a glance in his inbox, and **stored as a field** so matching is exact. A prefix is for eyes; a field is for lookups.

**`repo` and `branch` need no flags**, because the point is that they are automatic. `git rev-parse --show-toplevel` rather than `cwd` so the answer is the same whichever subdirectory the script ran from. Every git failure is swallowed to null: this is context, not payload, and no git, a detached HEAD or a plain folder must not stop a report reaching Alfred.

**The tag is validated in `clip-capture` too, not only in the script.** `clip.mjs` is one caller of a public endpoint; anything arriving may have come from elsewhere. A malformed tag is dropped rather than stored, because a stored-but-unmatchable tag looks like a working one.

**The `run_tag` filter has to start on the inbox row.** The tag lives in `inbox.source_metadata` and there is no foreign key from `clips` to `inbox` (063 explains why), so PostgREST cannot embed the join: matching inbox ids are looked up first, then the clips query is constrained to them. An empty match short-circuits to an empty result — asking for a tag that produced nothing must return nothing, not everything, and that is the sort of filter that fails open if you let it.

**`readInboxState` now returns the whole `source_metadata` envelope** instead of one `Map` per field. It started with a `Map` for the note, gained one for `capture_mode`, and would have gained three more here. One map of objects plus a small `metaText()` reader does the same job and stops growing.

**The description carries the disambiguation rule**, because the tool cannot enforce it: when Alex says the CLI responded, find the run tag of the prompt this conversation issued and pass it. With no tag and more than one unarchived CLI report, **do not guess and do not assume the most recent** — list them with titles, tags and times and ask. `repo` and `branch` help when two runs have similar titles.

`clip-capture` v6, `mcp` v117, `verify_jwt` false on both, confirmed both ways. `deno check` delta zero.

### Step 7c — the run_tag schema was already deployed, 2026-09-23

Step 7b verified: `run_tag` "clip-7b-q4m2" with `include_archived` returned exactly that report (repo alfred-v5, branch main), and "no-such-tag" returned zero.

**Reported problem:** a fresh claude.ai thread's tool definition for `get_recent_clips` showed no `run_tag` input and no disambiguation rule, suggesting the registration in `mcp/index.ts` had not been updated.

**Finding: nothing was wrong with the code, and it was already deployed.** For the first time in this build the deployed bundle could be inspected directly, which settled it rather than leaving it to memory:

```
npx supabase functions download mcp --project-ref <ref> --use-api --workdir <temp dir>
```

`--workdir` is what makes that safe — without it the download writes into `supabase/functions/` and would clobber local source. It errors part way through (`UnsafeFunctionDownloadPathError` on `src/sam/lib/keySignature.js`, which lives outside the functions tree) but writes `mcp/index.ts` before failing, which is all that was needed. The deployed v117 bundle contained `run_tag: z` in the zod `inputSchema` at line 2310 and the "DO NOT GUESS and do not assume the most recent" rule in the description — same count of `run_tag` mentions as the local source.

**Alex's own test proves it independently.** `no-such-tag` returned zero. The MCP SDK builds a zod object from `inputSchema` and parses incoming arguments through it, and a zod object strips unknown keys by default — so if `run_tag` had been missing from the deployed schema it would have been removed before reaching the handler, the filter would never have applied, and "no-such-tag" would have returned clips rather than nothing. The filter working IS evidence the schema has the field. (Reasoning about the SDK's behaviour, not something tested directly here — there is no bearer token available to call `tools/list`.)

**So the cause is a stale tool manifest in the claude.ai client, and spec §7 already says so:** "A session started before a deploy cannot see new tools. Tool tests always run in a fresh claude.ai thread, **after disconnecting and reconnecting the Alfred connector**." A new thread alone is not enough — the connector caches the manifest, and only reconnecting re-fetches it.

Redeployed anyway (v118) to bump the version, since a new deployment is the cheapest thing that might invalidate a client-side cache. No code changed; `deno check` delta zero.

**The reusable part is the diagnostic.** "Is the deployed function actually what I think it is?" now has an answer that does not depend on anyone's memory of what they deployed. Worth reaching for before hunting a bug in source that turns out to be correct.

### Test fixtures: removed 2026-09-23

`065` ran; both clip rows and both inbox rows are gone. The two slice JPEGs were deleted through the dashboard, because `supabase storage rm` does not work (see above). `clips` is now empty and the `clipboard` bucket holds one harmless leftover: a `.emptyFolderPlaceholder` under `26f0707f-.../14746114-...`, which Supabase drops in when the dashboard removes the last file in a folder. It cannot affect anything — `get_clip_slices` reads paths from the clip row rather than listing the bucket, and `clip-capture`'s slice verification only checks that the names it was given are present, so an extra entry in the listing never matches. Delete the folder in the dashboard if it bothers you; Step 6 creates a fresh folder per clip id regardless.

### Original note: test fixtures, safe to delete after Step 5 verification

`supabase/migrations/065_delete_step3_test_clips.sql` is written and ready but **must not be run until Step 5's verification passes** — the two Step 3 clips are the only rows in `clips` and every test from Step 3 to Step 5 uses them. Step 6 replaces them with real clipped pages.

The migration deletes the two clip rows and their two inbox rows. It deliberately does **not** delete the slice objects, for the same reason 064 refuses to: `storage.objects` is an index, not the files. Claude runs the Storage API removal alongside it:

```
npx supabase storage rm -r ss:///clipboard/26f0707f-.../14746114-.../ --linked --experimental
```

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
