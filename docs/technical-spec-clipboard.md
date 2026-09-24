# Technical Spec: Alfred Clipboard

Status: approved for build, 2026-09-23. Phases 1 and 2 are in scope for the first build. Phases 3 and 4 are recorded here so decisions aren't lost, but are not built yet.

## 1. Purpose

One click in Chrome saves the current page (all of its text, all of its links, and a full-page screenshot) into Alfred. Any claude.ai thread can then read recent clips on request ("I just clipped two jobs", "just clipped the screen"). The Claude CLI can push its reports the same way, so Alex can say "CLI responded" instead of pasting output.

The first real use is the job search: clipped job postings are evaluated in a jobs thread, and only there do they become rows in `job_applications`.

The clipboard is temporary working space, not a permanent record.

## 2. Decisions already made (do not reopen without asking Alex)

1. **Capture everything, process nothing.** The extension saves the whole page's text, every link, and a full-page screenshot. No "main content" extraction. Claude is told that a page may contain several items (for example several job cards) and handles that in conversation.
2. **Slicing happens in the browser.** The screenshot is scaled to at most 1280 px wide (never upscaled) and cut top to bottom into JPEG slices no taller than 900 px, overlapping by 50 px, at quality 0.8. The server never decodes, resizes, or encodes images. Reason: the spike showed server-side slicing crashed the edge function, and slices of 1280 × 900 stay under the size at which Claude automatically shrinks images, so small text stays readable. Proven by the spike on 2026-09-23 (a 1920 × 5994 page, five slices, all text readable).
3. **Images reach Claude as MCP image blocks,** not links. claude.ai cannot open a link that only appeared in a tool result, and signed storage links exceed the fetch tool's 250-character limit. The `runToolForMcp` passthrough built in the spike (the `__mcp_content` sentinel and the `McpBlock` union) is kept.
4. **Heavy content lives in a separate `clips` table.** The inbox row is a lightweight pointer. Reason: the app loads every inbox row in full on every page load and background refresh.
5. **The extension authenticates with a dedicated long-lived secret,** checked with the same length-check plus `timingSafeEqual` pattern as `notify-dispatch`. Not a pasted login token (they expire in about an hour). Not the `email-capture` pattern (no secret at all).
6. **Screenshots upload directly to storage through one-time signed upload links** issued by the server. The extension never holds a Supabase session or key.
7. **Order of operations follows SAM's rule: upload first, record second.** A clip row is only written after its slices are in storage, so no record ever points at a missing file.
8. **Claude may archive inbox items without confirmation.** Archiving hides an item and is reversible, so it is tier 2, not tier 3.
9. **The `archived` column comes back into use,** deliberately reversing the "inbox triage is hard-delete only" rule for this one purpose. Archiving sets `archived = true` and `triaged_at = now()`. Human triage in the app still hard-deletes, unchanged.
10. **No automatic deletion job during rollout.** A dated Alfred inbox item (2026-10-23) will prompt a review of storage size.
11. **Enrichment never writes to `job_applications`.** Clipped jobs become job rows only inside a jobs conversation, after Alex has seen Claude's evaluation. The `alfred-enrich` skill skips clipboard and CLI items entirely.
12. **Clipped jobs enter `job_applications` as `considering` or `passed`,** never an applied status, so `get_job_application_sources` stays accurate (it already excludes those two statuses).
13. **Duplicates are linked, not removed.** A new `duplicate_of` column points each copy at the main row.
14. **The inbox trash can archives instead of deleting** (added 2026-09-23, Step 5b). This reverses the hard-delete rule for the trash can as well as for Claude, going further than decision 9. Reason: a clip is two rows, and the inbox row is only a pointer at the `clips` row that holds the text and slices. Deleting the pointer left the clip behind, and because `get_recent_clips` judges "already handled" by reading the paired inbox row, a clip whose inbox row had been deleted read as live and returned to every new conversation for ever — binning a clip was the one action that could not make it go away. The row now stays, with `archived = true`, `triaged_at = now()` and a new `archive_reason` column saying which kind of archiving it was: `discarded` (Alex binned it) or `processed` (`archive_inbox_item` tidied it away). Both are reversible. `get_recent_clips` also now treats a clip whose inbox row is MISSING as archived rather than live, which covers rows deleted before this change. **One hard delete remains**: triage through the app's process/save flow (`handleInboxSave`) still deletes the row on success. Phase 3's one-tap process button is where that becomes an archive with `processed`.

### 2.1 Known limitations, accepted (2026-09-23, after Step 6)

Both were found clipping real pages. **Text capture is complete on every page tried, and that is what the clipboard is for** — so neither is being chased. Recorded so nobody rediscovers them as bugs.

1. **Pages whose content scrolls inside a container capture only partially.** Where the page body does not scroll with the window — an inner pane with its own scrollbar — each tile capture photographs the same region, so the slices stop advancing. Observed on the 80,000 Hours job board (1905 × 6047: 2 usable slices of 5) and a New York Times article (1905 × 6562: 1 of 6). The coherence check catches it, discards the untrustworthy slices, and marks the clip incomplete with the reason, so a clip never claims a screenshot it does not have. Full-page capture for these pages is **out of scope**.
2. **Elements fixed to the screen appear partway down a full-page screenshot.** Anything with `position: fixed` — Alfred's own floating capture bar, cookie banners, sticky headers — is painted where it sat relative to the capture rather than once at the top. Cosmetic only; the text is unaffected. Not being fixed.
3. **Some pages stop early for reasons not established.** The NYT article above stopped after one slice. It may be the same container-scrolling cause or something else; it was not investigated. Same handling: detected, truncated honestly, text unaffected.

The consequence for Phase 2: a clipped job board may have a partial screenshot but complete text and links, which is enough to evaluate postings and point at the others on the page. Claude is told to read `screenshot_note` rather than guess why a screenshot is short.

## 3. Data model

### 3.1 New table: `public.clips`

| Column | Type | Notes |
|---|---|---|
| id | uuid, default gen_random_uuid() | primary key |
| user_id | uuid, default auth.uid(), not null | owner; RLS via `register_table` |
| source | text, not null | `clipboard` or `cli`; check constraint |
| url | text | page address; null for CLI clips |
| title | text | page title, or CLI report title |
| page_text | text, not null | full page text, or the CLI report. Cap at 1 MB (enforced by the capture function, which truncates and sets `text_truncated`) |
| text_truncated | boolean, not null, default false | |
| links | jsonb, not null, default '[]' | array of `{ "text": ..., "href": ... }`, absolute addresses, de-duplicated, capped at 1,000 |
| slice_paths | text[], not null, default '{}' | storage paths in page order; empty for CLI clips |
| slice_count | integer, generated from `cardinality(slice_paths)` | 0 means "no screenshot" |
| screenshot_truncated | boolean, not null, default false | true if the page was taller than the slice cap |
| page_width, page_height | integer | original screenshot size in pixels; null for CLI |
| inbox_id | text | the paired inbox row. No foreign key, because human triage hard-deletes inbox rows |
| captured_at | timestamptz | when the extension or CLI captured it |
| created_at | timestamptz, default now() | |

Indexes: `(user_id, created_at desc)`, `(user_id, source, created_at desc)`.

Ends with `select platform.register_table('public.clips', ...)`, with column comments as the platform contract requires, then `check_platform_conformance` must return CONFORMANT.

### 3.2 Storage bucket: `clipboard`

Private. `file_size_limit` 2 MB per object. `allowed_mime_types` = `{image/jpeg}`. Path shape: `{user_id}/{clip_id}/slice-01.jpg`, `slice-02.jpg`, and so on (two-digit numbering, up to 24 slices).

Policy: authenticated users may SELECT objects in their own folder, copied from the `sam-scores: users read own` policy. No INSERT, UPDATE, or DELETE policies are needed: uploads go through service-issued signed upload links.

### 3.3 Inbox rows for clips

One inbox row per clip, created by the capture function after the clip row:

- `source_type`: `clipboard` or `cli`
- `captured_text`: `Clip: {title} — {url}` (for CLI: `CLI report: {title}`)
- `source_metadata`: `{ "clip_id": ..., "url": ..., "slice_count": ..., "screenshot_note": ... }`. `screenshot_note` is one to three sentences composed by the extension at capture time saying what the screenshot is and, when it is incomplete, why — never a guess. Stored here rather than on `clips` because it needs no schema change. Returned by `get_recent_clips`; used by `get_clip_slices` in place of the cause it used to assume.
- `ai_status`: `not_started`

The clip row's `inbox_id` is then set to the new inbox id.

### 3.4 `job_applications` additions (Phase 2)

- `posting_url` text, nullable. Partial index on `(user_id, posting_url)` where not null. Not unique: the same posting can legitimately be a duplicate row.
- `duplicate_of` uuid, nullable, references `job_applications(id)` on delete set null. Check: `duplicate_of <> id`. Rule enforced by the tool: a duplicate always points at a main row, never at another duplicate (no chains).
- `get_job_application_sources` excludes rows where `duplicate_of` is not null.

## 4. Components

### 4.1 Edge function: `clip-capture` (new)

A separate function, not a route on `mcp`, because it authenticates with a shared secret rather than OAuth and must use the service-role client to issue upload links and write on Alex's behalf. It is a server-to-server exception of the same kind as `email-capture` and `notify-dispatch`, and must say so in a header comment.

- `supabase/config.toml` gets a `[functions.clip-capture]` block with `verify_jwt = false`, committed **before** the first deploy.
- Secrets: `CLIPBOARD_SECRET` (random, at least 32 bytes) and `CLIPBOARD_USER_ID` (Alex's user id). Every request must carry `x-clipboard-secret`; compare with length check plus `timingSafeEqual`. Reject before doing any work.
- CORS: allow the extension's origin (`chrome-extension://...`) and plain `POST`/`OPTIONS`.

Endpoints:

1. `POST /clip-capture/start` with `{ "slice_count": n }` → creates a clip id, returns `{ clip_id, uploads: [{ path, signed_url, token }] }` using `createSignedUploadUrl` for each slice path. `n` from 0 to 24.
2. `POST /clip-capture/finish` with `{ clip_id, source, url, title, page_text, links, slice_paths, page_width, page_height, screenshot_truncated, captured_at }` → verifies every listed slice exists in storage, inserts the clip row, inserts the inbox row, links them, returns `{ clip_id, inbox_id }`. If any listed slice is missing, it fails and writes nothing.
3. CLI clips skip `start` and call `finish` directly with `source: "cli"` and no slices.

Truncation of oversized text and link lists happens here, and sets the truncated flags.

### 4.2 MCP tools (all in a new `_shared/tools/clipboard.ts`)

- **`get_recent_clips`**, tier 1. Parameters: `limit` (default 5, capped by `clampLimit`), `source` (`clipboard` | `cli`, optional), `since_minutes` (optional), `include_archived` (default false; "archived" is judged by the paired inbox row). Returns, per clip: id, source, url, title, captured_at, inbox_id, slice_count, screenshot_truncated, text_truncated, page_text, links. **No images.** Text first is the default because it is cheap.
- **`get_clip_slices`**, tier 1. Parameters: `clip_id`, optional `from` and `to` slice numbers. Returns a text block (slice list, sizes, "slices X–Y of N") followed by up to 8 image blocks, via the `__mcp_content` passthrough. Downloads through `ctx.db` so storage policies apply.
- **`archive_inbox_item`**, tier 2. Parameters: `inbox_id`, optional `archived` (default true; false un-archives). Sets `archived` and `triaged_at` (null when un-archiving). Audited and reversible.
- **`get_inbox`** gains an optional `source_type` filter, applied to both the main query and the mirrored count query, and its description is corrected to list `re_enriched`.

Tool descriptions must tell Claude: a clip is a whole page and may contain several items (for example several job listings); read the text first and call `get_clip_slices` only when the layout or visuals matter, or when the text is thin or confusing.

### 4.3 Frontend changes (Phase 1, minimum only)

- `SourceIcon` map (`Alfred.jsx` around line 7429): add `clipboard` (paperclip) and `cli` (terminal) icons.
- Realtime handler `handleInboxChange` (around line 2716): on INSERT and UPDATE, drop rows whose `archived` is true, so an item Claude archives disappears live instead of lingering until the next refresh.
- No other inbox screen work in Phase 1. Do not touch the `InboxCard` normaliser copies or the dirty check.

### 4.4 Chrome extension (`extension/` at the repo root)

Manifest V3. Not under `src/`. Its own `README.md`. No build step if avoidable (plain JavaScript modules).

- **Permissions:** `activeTab`, `scripting`, `storage`, `debugger`, and host permission for the Supabase functions address.
- **Options page:** function base address and secret, stored in `chrome.storage.local` (not sync), entered once per machine.
- **Toolbar click** (plus an optional keyboard shortcut):
  1. Inject a script that returns `document.title`, `location.href`, `document.body.innerText`, and every `<a href>` as `{text, href}` with absolute addresses.
  2. Capture the full page with the Chrome DevTools Protocol through `chrome.debugger` (`Page.getLayoutMetrics`, then `Page.captureScreenshot` with `captureBeyondViewport: true`). Chrome briefly shows a "being debugged" banner; that is expected.
  3. Slice in the service worker with `createImageBitmap` and `OffscreenCanvas`, per decision 2. Cap at 24 slices; if the page is taller, keep the top 24 and set `screenshot_truncated`.
  4. Call `start`, upload each slice to its signed link, then call `finish`.
  5. Show the result on the toolbar badge: a green tick for success, a red "!" for failure, with the error available in the popup.
- **Pages that cannot be captured** (`chrome://` pages, the Chrome Web Store, PDFs in the built-in viewer): fail cleanly with a clear message. If the screenshot fails but the text succeeds, save a text-only clip and say so.
- Wide pages are simply scaled down to 1280 px wide. No special handling.

### 4.5 CLI push

- `scripts/clip.mjs`: reads a file (or standard input), posts it to `finish` as a `cli` clip with a title, and prints the new clip id. Reads `CLIPBOARD_URL` and `CLIPBOARD_SECRET` from environment variables, set per machine.
- A rule in the repo's `CLAUDE.md`: at the end of every task, write the final report to a file and push it with `scripts/clip.mjs`, then also print it as usual.

### 4.6 Skills and project instructions (Phase 1 and 2)

- **Project instruction (claude.ai, Phase 1):** "When Alex says he clipped something or that the CLI responded, call `get_recent_clips` first (source `cli` for CLI reports). After handling a clip, archive its inbox item with `archive_inbox_item`."
- **`job-search` skill (Phase 2):** at the start of any job conversation, call `get_recent_clips` with source `clipboard` and look for job pages. For each: identify the main posting; evaluate it; also name any other listings on the page that look worth a look, with their links from the clip's `links` list, and suggest Alex clip them. On Alex's decision, create a `considering` or `passed` row with `posting_url`. If the posting matches an existing row, create it with `duplicate_of` pointing at the main row. Archive the clip's inbox item once handled. Never create job rows without Alex's say-so in the conversation.
- **`alfred-enrich` skill (Phase 2):** skip inbox items whose `source_type` is `clipboard`, `cli`, or `task`. Never write to `job_applications`.
- Both skills are edited in `.claude/skills/` in the repo, committed, and then re-uploaded to claude.ai.

## 5. Phases

### Phase 1: capture and read (build now)

Cleanup of the spike; `clips` table and `clipboard` bucket; `clip-capture` function and secrets; the four tool changes in 4.2; the frontend minimum in 4.3; the extension; the CLI push; the project instruction. Done when Alex can clip a page, say "I just clipped this" in a fresh thread, and Claude reads the text and, when asked, the screenshot, then archives the inbox item and it disappears from the app.

### Phase 2: jobs (build now)

`job_applications` columns; `create_job_application` and `update_job_application` accept `posting_url` and `duplicate_of`, and the same-organization-and-role refusal is skipped when `duplicate_of` is given; the sources report excludes duplicates; the two skill updates. Done when a jobs thread picks up a clipped posting, evaluates it, points out other interesting listings on the page, and files the one Alex chooses as `considering`.

### Phase 3: inbox screen (later; design notes only)

**Decisions taken 2026-09-24, after Phase 2 shipped.** These supersede the
"expand inline" assumption the earlier notes were written against; the
per-card notes below are kept because their substance still applies, on a page
rather than in an expanded card.

**A. Inbox cards open on their own page, not inline.** Tapping a card navigates
to it. The card stays a summary.

This is also the moment to pay off the debt `InboxCard` has accumulated, and the
rebuild is what makes it affordable: the **four duplicated copies of the elements
normaliser** collapse into one function, and the **`eslint-disable`d dirty check**
goes with them. That check compares `JSON.stringify(state)` against
`JSON.stringify(normalise(props))` across a hand-maintained dependency list; if
the four copies ever diverge the card reports itself permanently dirty and the
user gets an unsaved-changes prompt they cannot clear. A full-page form has its
own route and its own lifecycle, so the whole mechanism can be replaced rather
than extended. **Do not add a fifth copy in the meantime.**

**B. An expanded clipboard card shows what was captured** — the page text, the
links, and the screenshot slices. Today a clip's card shows only
`Clip: {title} — {url}`; everything else lives in `clips` and is visible only to
Claude. Alex should be able to see what he clipped without asking a conversation.
This is the first place the app renders an image (see the slice-thumbnail note
below) and the first place it reads the `clips` table.

**C. Enrichment leaves the app entirely.** Remove the Enrich and Re-enrich
buttons and every direct enrichment path from the frontend. Enrichment happens
only from claude.ai, through the connector and the `alfred-enrich` skill.

Then **plan the retirement of the `ai-enrich` edge function** once nothing calls
it. It is the only function holding `ANTHROPIC_API_KEY`, and the only one that
runs an agentic loop server-side, so retiring it removes a secret and a class of
failure. Retire it in this order: remove the callers, confirm from the logs that
nothing invokes it for a week, then delete the function and the secret. Do not
delete it in the same change that removes the buttons — a function with no
callers is harmless, and an undeletable one is not.

**D. The rules for automatically creating items, intentions and collections from
an inbox item will be reworked, and that needs its own design discussion before
any build.** The current shape — three accordion sections that each write a
different table on save — grew rather than being designed, and Phase 3 should not
carry it forward unexamined. Nothing in this section should be built until that
conversation has happened.

**E. Saving through the inbox form archives with `archive_reason = 'processed'`
instead of deleting.** Step 5b turned the trash can into an archive
(`discarded`) but deliberately left `handleInboxSave` alone, so successful triage
is now the LAST remaining hard delete on the inbox.

**F. Items and intentions created from an inbox item link back to it.** A
`source_inbox_id` on the created record, so "where did this come from" is
answerable. This only becomes meaningful once E lands: while triage deletes the
inbox row, any link would be broken moments after being created. **E and F ship
together, or E first.** See the investigation in `docs/progress-clipboard.md`
for what is and is not preserved today, and the proposed column.

**Still applicable from the earlier notes:**

- Source pills with an icon and a word, one soft colour per type: clipboard,
  capture, email, Claude (mcp), CLI, task. A filter row of the same pills at the
  top.
- A one-line preview on each card, visible without opening it: target context,
  item and/or intention icons, memory icon, and tag pills ("+N more" past four or
  five).
- A one-tap process button beside the trash can, enabled whenever the item is
  enriched (not only when it has a context, since memory-bound items have none).
  Consider tinting the preview when confidence is low. It archives with
  `archive_reason = 'processed'` rather than deleting — the same change as E.
- "Recently archived" (last seven days) collapsed at the bottom, with "show all",
  each card showing where it went and an undo button. `archive_reason`
  distinguishes `discarded` from `processed`, which is what lets that panel say
  where something went rather than only that it left.
- Clip cards: title, address, slice count, and a thumbnail of the first slice.
- Scheduled-task items: `create_inbox_item` accepts a `source_type` (including
  `task`) and `source_metadata` (task name, date); task cards show a copy button
  instead of process. Copying appends a final line `Alfred inbox item: {id}`.
- Hide the Enrich button on clipboard, CLI and task items — moot once C lands,
  since the button goes entirely.

### Phase 4: awareness everywhere (later)

- Project instruction: "If a message includes an Alfred inbox item id, archive that item once the work is done." This covers every scheduled-task prompt without editing each skill.
- Update each scheduled task (SAM daily practice, DJ daily and weekly, Ken seed check) to pass `source_type: "task"`.
- Add clipboard awareness to other skills as needed (Ken for clipped news, SAM or debugging for clipped screens).

## 6. Out of scope

- Automatic deletion of clips or slices (see decision 10).
- Rule-based routing of financial clips (separate project, in the Alfred inbox).
- Any "main content" extraction in the extension.

## 7. Risks and checks

- `verify_jwt` has silently reset on redeploy in this project. After every deploy, confirm `mcp` and `clip-capture` both show `verify_jwt: false`, and confirm with an unauthenticated request that the function's own code answers.
- A session started before a deploy cannot see new tools. Tool tests always run in a fresh claude.ai thread, after disconnecting and reconnecting the Alfred connector.
- The notification dispatch secret was exposed in a chat log on 2026-09-23. Rotate it during Phase 1 setup.
