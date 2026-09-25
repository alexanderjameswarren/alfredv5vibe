# Progress: Alfred Clipboard

## Status: **Phases 1 and 2 complete. Phase 3 round 1 (Steps 13-15) complete.** Phase 3 round 2: the inbox detail page, Steps 16-19. **Phase 3 round 2 complete, verified and pushed.** Round 3: the inbox list, Steps 20-23. Steps 20, 20b, 21, 21b and 21c done; 20b deployed (mcp v122). 21c awaiting in-app verification. Step 22 next.

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

- [x] Step 9: Migration adding `posting_url` and `duplicate_of` to `job_applications`. Alex runs it; CONFORMANT. **Also add `clips.links_truncated` (boolean, not null, default false) in this same migration** — decided 2026-09-23, deferred here from Step 3 rather than changing the agreed data model mid-Phase-1. `clip-capture` must then set it from the `links_dropped` it already computes, and that change needs a `clip-capture` redeploy alongside the migration. See the Step 3 notes for why the gap exists. - **done 2026-09-24.** 067 run: CONFORMANT (44 tables), FK with ON DELETE SET NULL and the not-self check present, `posting_url` index partial and non-unique, `clips.links_truncated` boolean/not null/default false, existing rows untouched (0 and 0).
- [x] Step 10: `create_job_application` and `update_job_application` accept both fields; the same-organization-and-role refusal is skipped when `duplicate_of` is given; `get_job_application_sources` excludes duplicates. Deploy, verify, test in a fresh thread. - **written and deployed 2026-09-24.** Also: `clip-capture` sets `links_truncated`; `get_recent_clips` returns it and gains `run_tag_prefix`; the `cli-workflow` skill's tag format gains a thread code. `clip-capture` v8, `mcp` v120, `deno check` delta zero. **Verified in fresh threads:** `posting_url_matches` works and never refuses; `duplicate_of` skips the org-and-role guard; both no-chain rules refuse with errors naming the rows involved; the sources report excludes duplicates and reports `duplicates_excluded`; `run_tag_prefix` works and refuses when combined with `run_tag`. Test rows deleted.
- [x] Step 11: Update `.claude/skills/job-search/SKILL.md` and `.claude/skills/alfred-enrich/SKILL.md` per spec section 4.6. Commit; Alex re-uploads both to claude.ai. - **written 2026-09-24.** job-search 108 to 253 lines, alfred-enrich 174 to 231. No code, nothing deployed. **Re-uploaded and verified by Step 12.**
- [x] Step 12: End-to-end jobs test. - **done 2026-09-24.** In a fresh thread, "Let's look at jobs" found an 80,000 Hours board clip unprompted, treated it as a LIST, created exactly two records on Alex's say-so (Anthropic / Engineering Manager, AI Observability as `considering`; BlueDot Impact / Program Lead as `passed`; `effort` null on both), and archived the clip with `archive_reason` 'processed'.

  **`posting_url` came out null on both.** The board's cards are script-driven, so Claude could only INFER addresses from job numbers and correctly declined to store one it could not confirm - the skill's inferred-link rule working as written. Storing an unverified address in a column meaning "where this posting lives" would be worse than leaving it null. It does mean the duplicate-detection path `posting_url` exists for is unexercised on this board and stays so until a clip carries real hrefs. If `posting_url` turns out null on most real clips, the fix is to put the inferred address in `notes`, where its uncertainty can be stated, rather than loosening what the column means.

**PHASE 2 COMPLETE.**

## Phase 3, round 1: plumbing

The rest of Phase 3 — the detail page, the clipboard card's captured content, the
reworked auto-creation rules — is not in this round. Decision D still stands:
auto-creation needs its own design conversation before any of it is built.

- [x] Step 13: Migration adding `source_inbox_id text null references public.inbox(id) on delete set null` to `items`, `intents` and `events`, each with a partial index on not-null and a column comment, ending with the conformance check. Alex runs it; CONFORMANT required. — **written 2026-09-24**, `supabase/migrations/068_phase3_source_inbox_id.sql`. - **done 2026-09-24.** CONFORMANT (44 tables); the column present on all three tables, text, nullable, commented, each with the FK ON DELETE SET NULL and a partial index; all link counts 0 as expected.
- [x] Step 14: `handleInboxSave` archives the inbox row with `archive_reason` 'processed' and `triaged_at` instead of deleting it, AND sets `source_inbox_id` on every item, intention and event it creates — one change, because either half alone is useless or misleading. Remove the Enrich and Re-enrich buttons and every call to `ai-enrich` from the app (the function itself stays; it is retired separately). Touch `InboxCard` only where the buttons are removed — **not** the normaliser copies or the dirty check, which the detail page replaces. Run the frontend suite. - **written 2026-09-24.** Suite green (64 suites, 1379 tests); JSX compiles. The four normaliser copies and the `eslint-disable`d dirty check were left untouched, as required. Nothing deployed - this is the Vercel frontend, so it reaches the live app only on a push, which is Alex's call. - **verified 2026-09-24.** Alex confirmed triage in the app: the capture archives instead of vanishing, and the records it creates carry `source_inbox_id`. Note from his check: `no_orphan_processed_rows` also lists clips and CLI reports archived by Claude through `archive_inbox_item`; that is expected, since those create nothing.
- [x] Step 15: Record in this file, dated, when `ai-enrich` stopped being called, so its retirement can be scheduled a week later. A note only. - **done 2026-09-24**, see the notes. The clock starts at DEPLOY, not at commit.

## Phase 3, round 2: the inbox detail page

The approved design is `docs/inbox-detail-mockups/` — seven files plus a README
that carries the rules. The README is the specification for these four steps; the
HTML files show it applied. Read both before changing any frontend code.

The seven files are correctly named as of 2026-09-24 (Step 17b, item 6). They were
not when the page was built: the export had shifted every design one filename along,
so six of seven pointed at the wrong picture, and two files were byte-identical
twins. Nothing was blocked — all six desktop designs were present and were read by
their `<title>` — but it is worth knowing the names were untrustworthy for a day,
because the page was built against titles rather than filenames.

Renamed by title, the duplicate deleted, and `keep-reflection-note.html` restored
from commit `fd8abe0` (the Reflection note design had been overwritten when the real
phone mockup was saved over the file that had drifted into holding it). Seven files,
seven distinct designs, every name matching its title, README list accurate.

- [x] Step 16: Intentions need a long-text description — "Details" in the mockups. Check whether `intents` already has a suitable column; if not, write a migration adding one, with a comment, ending with the conformance check. Alex runs it; CONFORMANT required. — **written 2026-09-24**, `supabase/migrations/069_phase3_intents_description.sql`. There was no suitable column: see the notes. - **done 2026-09-24.** CONFORMANT (44 tables); `intents.description` is text, nullable, no default, commented, and 0 of 165 rows have a value. The name `description` with the label "Details" was approved.
- [x] Step 17: The detail page itself, at its own URL through the existing routing, reached by clicking an inbox card. Everything in the README: the back link, the source pill and capture time, Context first and prominent with Tags underneath, the two push-button toggles (New Item / New Intention, either, both or neither, preselected from `suggest_item` / `suggest_intent`), the two sections, the original capture last, and the floating footer. Reuse the EXISTING element editor completely unchanged. Preserve linking an intention to an existing item (`suggested_item_id`). Collections stay hidden. Phone layout: one column, same order, footer pinned. **Its own component, not inside `InboxCard`, with exactly one normaliser.** Run the frontend suite. - **written 2026-09-24.** `src/InboxDetailView.jsx` at `/inbox/detail/:id`, plus `src/CaptureMeta.jsx` and `src/utils/suggestedElements.js` (the one normaliser). Suite green: 66 suites, 1445 tests, up from 64/1379; `react-scripts build` compiles with no warnings at all. Nothing deployed - this is the Vercel frontend and reaches the live app only on a push, which is Alex's call. Three deliberate feature losses were flagged for his ruling; he gave it in Step 17b, which also fixed two things this turned up. - **verified 2026-09-24**, with the Step 17b fixes.
- [x] Step 17b: Alex's rulings on the three feature losses, plus two fixes and the mockup renames. Keep the capture-text pencil; drop "Attach this Item"; drop Target Start Date from this page only. Trace `intents.description` and prove it with a test. Fix the pinned-footer gap **globally**, with one shared measurement rather than per-screen offsets. Rename the mockups. - **done 2026-09-24.** Suite green: 68 suites, 1486 tests, up from 66/1445; build clean. - **partly verified 2026-09-24.** The capture pencil and Details both confirmed working in the app. **The global footer fix shipped a bug of its own** - see Step 17c.
- [x] Step 17c: Three regressions from 17b's footer change, plus Details on the intention view and edit screens. Footers stopped undocking at the bottom of a page; content was cut off behind the capture bar; the Capture button looked clipped on desktop. - **done 2026-09-24.** One root cause found for the first two; the third not explained. - **FAILED in the app 2026-09-24.** `--dock-h` measured correctly (83px) and the layout was still wrong. Rolled back whole by Step 17d; item 4's Details work was kept.
- [x] Step 17d: Roll back the measured-dock layout to production, keep every feature from 17/17b/17c, then fix the original gap with the smallest change: move each pinned footer down to the capture bar's normal height and leave the content padding alone. - **done 2026-09-24.** Suite green: 67 suites, 1492 tests (the 11 useDockHeight tests went with the hook). - **verified 2026-09-24 and PUSHED.** The gap is gone, footers sit flush and release at the bottom of a long form, the item view's last section is visible, and the Capture button matches production.
- [x] Step 17e: Pinned footer spacing. The buttons sat 8px from the top and 12px from the bottom, and once a footer released the card's own bottom padding stacked under it. - **done 2026-09-24.** `py-3` on all six, and a `-mb-*` matching each card's padding. Offsets and content padding untouched, as instructed.
- [x] Step 18: Retire the inline card expansion. Remove the old expanded form from `InboxCard`, including its four normaliser copies and the `eslint-disable`d dirty check — but only once nothing uses them. Run the frontend suite. - **done 2026-09-24.** 1,224 lines removed; `InboxCard` is 44 lines and takes three props. Suite green: 67 suites, 1492 tests; build clean. - **verified 2026-09-24.**
- [x] Step 17f: The inbox detail page's released footer had ~13px above the buttons and ~40px below. - **done 2026-09-24.** A CSS specificity fight, not the padding value — see the notes. - **INCOMPLETE.** The same fight was live on three screens, not one; the claim that the other five were unaffected was wrong. Closed by 17g.
- [x] Step 17g: One shared `PinnedFooter` for all six pinned footers, so the geometry cannot differ between screens. Plus the flaky SAM clock assertion. - **done 2026-09-24.** Suite green three runs in a row: 71 suites, 1569 tests; build clean. - **verified 2026-09-24** for spacing.
- [x] Step 17h: One shared `EditCard` for the four full-screen edit forms, which also fixes the footer painting over the card's rounded corner. Plus `docs/design-system.md`. - **done 2026-09-24.** Suite green: 71 suites, 1572 tests; build clean. - **verified 2026-09-24 and PUSHED.** Round 2 closed.
- [x] Step 19: For clipboard items the detail page also shows the captured page text (collapsed, with Show all), the links, and the screenshot slices. Run the frontend suite. - **done 2026-09-24.** `src/ClipboardCapture.jsx` and `src/utils/capturedClip.js`, 50 new tests. Suite: 69 suites, 1548 tests, ONE pre-existing SAM flake (see the notes); build clean.

## Phase 3, round 3: the inbox list

The approved design is `docs/inbox-list-mockups/` — a README plus a desktop and a
phone board, committed as `10a08ce`. Both were confirmed to be real, distinct mockups
before committing, unlike round 2's folder. Read that README and
`docs/design-system.md` before changing any frontend code.

- [x] Step 20: `create_inbox_item` accepts an optional `source_type` ('mcp' default, or 'task') and `source_metadata` (for a task: task name, run date). Add a task icon to the source icon map. No UI beyond the icon. - **done 2026-09-24**, deployed as mcp v121, `verify_jwt` still false. `deno check` back at the baseline 97 errors — one new one found and fixed, see the notes. - **verified 2026-09-24** by a fresh-thread test: mcp default, task stored with its name and run date at `not_started`, and all three malformed calls refused.
- [x] Step 20b: Three fixes. Confirm from the live function that `create_inbox_item` publishes both new params; mark an mcp capture `enriched` only when something was actually suggested; give `archive_inbox_item` an optional reason. - **done 2026-09-24**, deployed as mcp v122, `verify_jwt` still false, `deno check` at the baseline 97 with no new errors.
- [x] Step 21: The list card and the filters. One shared `InboxListCard` per the mockup: title, meta line, preview line (context chip, New item / New intention, date chip, tags), one action button plus the trash icon. **Process** files an enriched item in one tap from its suggestions, through the SAME save path as the detail page (archive as 'processed', set `source_inbox_id`), and shows only for enriched items that suggest at least an item or an intention. **Copy**, for task items, copies the captured text plus a final line `Alfred inbox item: <id>`. Source filter pills REUSE the existing tag filter component, with no "All" pill. Phone layout per the mockup. - **done 2026-09-24.** `src/InboxListCard.jsx` and `src/utils/inboxSuggestions.js`, with the one-tap/detail-page equivalence proved by test. `InboxCard` and `AiStatusBadge` are gone. Suite: 75 suites, 1636 tests; build clean. - **reviewed from clips 2026-09-24**: the cards match the mockup. The source PILLS were rejected and replaced in 21b.
- [x] Step 21b: Source TABS instead of pills, reusing the front page's underline tabs; StickyNote for the Capture source everywhere including the capture bar's button; an enriched card titled by Claude's suggested name. - **done 2026-09-24.** `TagFilter`'s `noun` prop reverted. Suite: 77 suites, 1672 tests; build clean. - **reviewed from clips 2026-09-25**: the desktop tabs match the front page, titles show suggested names, the Capture button has its icon. Two changes asked for, done in 21c.
- [x] Step 21c: An Inbox glyph on the All tab; compress the tabs on narrow screens the way the top nav does instead of scrolling sideways; Lightbulb for the Capture source. - **done 2026-09-25.** Suite: 77 suites, 1679 tests; build clean.
- [ ] Step 22: "Recently archived (n)" — the last seven days, collapsible, with "Show all". Each row says what happened (processed; processed into an item / intention / event, via `source_inbox_id`; or discarded) and offers a working Undo that un-archives.
- [ ] Step 23: Add every new shared piece to `docs/design-system.md` — list card, filter pills, context chip, preview line, archived row — with the rules for using them, and extend the guard tests so screens must use them.


## Notes

### Step 17f — `space-y-*` beat a negative margin, 2026-09-24

The inbox detail page's released footer had ~13px above the buttons and ~40px
below. Alex's guess was the card's bottom padding — the mockups used about 120px of
it to clear the pinned footer.

**Not that.** The card uses `p-4 sm:p-7` (16/28px); the 120px from the mockups was
never copied, because a sticky footer does that job instead. The footer already
carried `-mb-4 sm:-mb-7` to cancel exactly that padding, and both classes are in the
compiled stylesheet.

**The negative margin was losing a specificity fight.** `space-y-5` on the card
compiles to:

```css
.space-y-5 > :not([hidden]) ~ :not([hidden]) { margin-bottom: calc(1.25rem * 0) }
```

— specificity **(0,3,0)**, because each `:not([hidden])` contributes an attribute
selector. `.-mb-4` and `.sm\:-mb-7` are **(0,1,0)**. So `space-y-5` set
`margin-bottom: 0` on the footer and won, leaving the card's 28px bottom padding
under it: 12px of `py-3` plus a 1px border above the buttons, and 12 + 28 = 40px
below. Exactly the numbers reported.

That `space-y-*` sets `margin-bottom` **at all** is the surprise — it is there to
support `space-y-reverse`, and it is zero in the normal direction, which makes it
invisible until something else wants that property.

**Fix: `space-y-5` → `flex flex-col gap-5` on the card.** `gap` sets no margins, so
there is nothing to lose to. One class, no `!important`, no restructuring, and the
other five footers were never affected because none of them is a `space-y` child.

### Step 20b — three fixes, 2026-09-24

#### 1. The client was showing a cached manifest

Downloaded the deployed function (`supabase functions download mcp --use-api`, the
Step 7c method) and confirmed: the live copy is **byte-identical** to the working tree,
and its registered `create_inbox_item` schema publishes BOTH `source_type` — a
`z.enum(["mcp", "task"])` whose description says exactly when to pass 'task' — and
`source_metadata`.

So the server was right and the test thread's tool list was stale. The fix is a
DISCONNECT AND RECONNECT of the connector, not a new thread; spec §7 says so and this is
the second time it has caught someone out.

(The download itself errors partway with `UnsafeFunctionDownloadPathError` on a
`src/sam/...` asset — the bundle carries the whole repo — but it extracts
`supabase/functions/mcp/index.ts` before failing, which is what the check needs.)

#### 2. `enriched` now means something was suggested

It was unconditional for every mcp capture. So a bare text capture with no context, no
item, no intention and no tags arrived looking researched: the inbox offered Process on
it, which would have filed nothing, and the badge said there was nothing left to think
about.

`ai_status` is now `enriched` only when at least one suggestion survives — context,
item, intention, event, tags **or collection**. Alex's list named five; collection is in
because a row proposing one HAS been researched, and calling it `not_started` would be
the same lie in the other direction. Tags count only if one survived normalisation: a
caller that sent nothing but punctuation has suggested nothing.

#### 3. `archive_inbox_item` takes a reason

'processed' stays the default — this tool is Claude tidying up after dealing with
something. But there was no way to say "this should not have been captured", so a
duplicate Claude cleared away was recorded in the archive as work done. `reason` now
accepts 'processed' or 'discarded', with an allowlist rather than a pass-through:
`inbox_archive_reason_needs_archived` checks the reason's PAIRING with `archived`, not
its value, so an unrecognised string would be stored and then match nothing the archive
screen knows how to describe.

### Step 21c — compression, and the Capture glyph's third attempt, 2026-09-25

#### The tabs compress instead of scrolling

`overflow-x-auto` hid tabs off the right edge, and a tab you have to discover by swiping
is not one tap away. Below `lg` a tab now shows **only its icon and its count**, with the
full name kept as `title` and `aria-label`.

**That is the top navigation's rule and the top navigation's breakpoint**, reused rather
than reinvented: the nav carries ten destinations from 640px up with `hidden lg:inline` on
its labels. A test asserts the nav still uses that exact string, so if the breakpoint ever
moves the two move together. The count survives the label for the nav's own reason — an
inbox glyph alone says nothing about whether there is anything in it.

The row **wraps** as its safety net, as the nav does. A wrapped tab is still reachable; a
clipped one is not.

#### ⚠️ Only a tab with an icon compresses

Without one there would be nothing left to show: a bare count, or on the Recycle Bin's
tabs — which have no counts either — nothing at all.

**Home and the Recycle Bin therefore keep their labels, and I gave neither icons.** Asked
which I would do and why:

| row | decision | why |
|---|---|---|
| Inbox sources | icons, all seven | up to seven tabs on a 390px phone. This is the row the compression exists for. |
| Home: Active / Paused / Today | labels, no icons | three tabs fit at any width, so compressing buys nothing — and inventing three glyphs to enable a compression it does not need would add a vocabulary for no gain. |
| Recycle Bin: eight record types | labels, no icons | the labels ARE the content, and with no counts either an icon-only row would be eight bare glyphs. Items/Intents/Events do have `OBJECT_ICONS` entries, but Songs and Snippets both map to `sam`, so two tabs would be identical. |

Neither needed a special case: the icon rule covers both, and their behaviour is exactly
what it was before the compression existed.

#### The All tab's glyph

`Inbox` — the same lucide component the top navigation's Inbox tab uses through
`OBJECT_ICONS.inbox`. Two references rather than one shared export, because
`OBJECT_ICONS` lives in Alfred.jsx, which imports the tab logic; a guard reads Alfred.jsx
and fails if the two diverge.

It is not decoration: without an icon the All tab would have nothing left below `lg`.

#### Capture is `Send` now, its third glyph

Worth recording all three, because the two failures were different kinds of failure:

1. **Pencil** — also the EDIT control on the inbox detail page. One glyph, two meanings,
   adjacent screens.
2. **StickyNote** (21b) — a rounded rectangle with a folded corner, which at 14px is
   nearly indistinguishable from `File`, the ITEM icon, on the same card two lines below.
3. **Send**, the paper aeroplane — a silhouette rather than an outline, so it survives
   14px; used nowhere else in Alfred, so it cannot collide; and it reads as the gesture,
   which is what a `manual` capture is.

⚠️ The reasoning is in `docs/design-system.md` with a **do-not-change-it-back** note and
the test any replacement has to pass: not already meaning something else in Alfred, and
still distinguishable from `File` at 14px in a card's meta line. Both earlier choices
looked fine at 24px and failed in place.

Changed in `SOURCE_GLYPHS`, so the tab, the card meta lines and the capture bar's Capture
button all moved together — the property that made this a one-line change rather than four.

#### Also in this step, and not part of the design

`supabase/.temp/` is gitignored, and `supabase/.temp/cli-latest` untracked: any `supabase`
command bumps it, so it kept surfacing as a pending change in unrelated work. The other
eight files in that directory are still TRACKED and were deliberately left alone — see the
report.

`.claude/CLAUDE.md` gained a **Git rules** section after `git add -A` swept an uncommitted
edit of Alex's into a commit for the second time in this project. Explicit paths only;
never touch a file you did not change; never rewrite a commit without asking.

### Step 21b — tabs, not pills, 2026-09-24

Alex reviewed the clips and rejected the source pills: they sat directly above cards
carrying real TAG pills, so two different things looked identical. He is right, and the
distinction is worth writing down — it is now a rule in `docs/design-system.md`:

**a row that chooses a VIEW of one list is tabs; a row that selects a PROPERTY of the
rows is pills.** Source is the first of those.

#### `src/UnderlineTabs.jsx`

The front page's tabs were not a component — they were the same eight-class string
written out twice, once by hand three times over (Home) and once through a `.map` (the
Recycle Bin). So "reuse the existing component" meant extracting one, and the inbox is
its third caller rather than a third copy. `TagFilter`'s `noun` prop, added in Step 21
for this, is **reverted** — nothing else wanted it.

`src/utils/inboxSourceTabs.js` holds the parts worth testing on their own:

* **A fixed order** — All, Capture, Claude, Clipboard, Task, CLI, Email — deliberately
  NOT alphabetical and not by count. Six sources never change, so the row can be learned
  by position. The tag pills sort alphabetically for the opposite reason: a tag
  vocabulary grows and you arrive looking for a name.
* **A source tab only while that source has items.** A tab reading "(0)" is a control
  that does nothing, which is why CLI and Email are usually absent.
* **All is always there**, always first, counting everything — including "All (0)" on an
  empty inbox, because it is the way back and the number is true.
* **The selection is DERIVED, not stored.** Process the last Claude item and the Claude
  tab goes; a stored selection would leave the list filtered to a source with no tab to
  unset it, which is `TagFilter`'s own "silently emptied with no visible cause" trap.
  Deriving also means an Undo brings the selection back with the row.
* An unrecognised `source_type` folds onto Capture in the tab, the count, the filter,
  the icon and the label alike — one fold, five places that agree.

#### StickyNote, and why the pencil had to go

A hand-typed capture was a pencil, and the pencil is also the EDIT control on the inbox
detail page — one glyph meaning two things on adjacent screens. `manual` is now
`StickyNote` everywhere a source icon appears, and the capture bar's Capture button
carries the same glyph before its label, so the button and the Capture tab are
recognisably the same thing.

`SourceIcon` also changed shape slightly: `SOURCE_GLYPHS` now exports the icon
COMPONENTS rather than pre-rendered elements, because the tabs want them at 16px and the
card meta lines at 14px, and an element built at one size cannot be reused at another.

#### The card title

An enriched row is titled by Claude's suggested name — the item's, else the intention's
— falling back to the captured text. `listTitleFor`, beside the other suggestion readers.

The captured text is what was said; the suggested name is what it will BECOME, and what
the card's Process button is about to create. So the title and the action agree. NOT
applied to unenriched rows or tasks: neither has a suggestion yet, and showing their raw
text is the only honest thing either can do.

### Step 21 — the inbox list, 2026-09-24

`src/InboxListCard.jsx` replaces `InboxCard`, which is now deleted — along with
`AiStatusBadge`, whose only caller it was. The mockup shows the status as words on the
meta line, so the badge had nothing left to render on.

#### The filter reuses TagFilter without touching it

Alex chose single-select and faithful reuse. The trick is what `entities` it is handed:
each capture becomes a row whose ONLY tag is its source's display NAME. `TagFilter` then
counts sources, sorts them alphabetically, renders the counts, shows `Clear` while one
is on and collapses past four — every one of those behaviours for free, including the
ones nobody would remember to reimplement.

Filtering compares LABELS on both sides rather than mapping a label back to a type,
which also means an unrecognised `source_type` lands under "Capture" exactly as its icon
does, without either the filter or the icon knowing it exists.

**One additive change to TagFilter: a `noun` prop**, defaulting to "Tags". The collapse
toggle hard-coded the word, and a source bar reading "Tags (4)" would be plainly wrong.
Nothing else in the component knows what it is counting — that was already true; this was
the one place the vocabulary leaked.

**Two small deviations from the README, both consequences of faithful reuse:**

* it says a collapsing pill appears with "more than four" sources; `COLLAPSE_MIN_TAGS`
  is four or more. One pill earlier than the prose. Changing it would change the four
  tag screens.
* it says "selecting one or more"; single-select was Alex's decision.

#### 🛑 One tap is DEFINED as "open it and press Process without editing"

That is the risk in a fast path: it can quietly file something different from the
careful path. So `triageDataForOneTap` lives in `src/utils/inboxSuggestions.js` beside
`computeBaseline` — which the detail page now imports from there rather than owning —
and `src/oneTapMatchesDetailPage.test.jsx` renders the REAL detail page, presses Process
untouched, and asserts the emitted triage data equals what the list would send. Ten
shapes, including elements in the enrichment's vocabulary, a suggested existing item
that must lose to a newly created one, and a suggested collection that must be ignored.

Process shows only for an enriched row suggesting an item or an intention. Both halves
earn their place: on an unenriched row there are no suggestions to file, and a row
suggesting only a context has nothing for triage to land on, so Process would archive it
having created nothing.

`Copy`, for tasks, appends `Alfred inbox item: <id>` as its own last line — pasting the
text alone would leave a Claude session with no way to archive the row afterwards. The
clipboard call can be refused (permissions, or a non-https page), so a failure is
reported rather than swallowed; a Copy button that silently did nothing would be
indistinguishable from one that worked.

#### Two things jsdom cannot see, and what changed because of it

* the title's two-line clamp is a Tailwind `line-clamp-2` class, NOT the inline webkit
  properties it compiles to — jsdom discards `-webkit-line-clamp` from an inline style,
  so the clamp would have been unassertable, and an unassertable rule is one that can go
  missing quietly. Same lesson as Step 17g's margins.
* the meta line's time and status are each in their own `<span>` rather than bare text
  nodes between separators, so one fact can be addressed without matching the whole line.

### The existing tag filter, before reusing it for the source pills, 2026-09-24

Investigation only, at Alex's request, before Step 21 tries to reuse it.

`src/TagFilter.jsx` — default export `TagFilter`, plus `collapseOnSearch` and
`COLLAPSE_MIN_TAGS`. 50 tests in `src/TagFilter.test.jsx`. It moved out of Alfred.jsx
on 2026-09-21 as a deliberate pure move, so it already has tests of its own.

**Four call sites**, all in Alfred.jsx: the Intentions list, the Memories list, the
Items accordion on context detail, and collection detail.

**Props.** `entities` (rows to count from), `activeTag`, `onFilter`, `collapsed`,
`onToggleCollapsed`.

**Counting.** Done in the component from the rows it is handed — no query, no RPC. So
the counts are of the list in front of you, not anything global, and archived rows
never reach it because every caller filters them first. Pills are sorted
ALPHABETICALLY, not by frequency, with `localeCompare`; that was changed on
2026-09-21 because count-descending with no tie-break shuffled between renders.

**When "Clear" appears.** Whenever `activeTag` is non-null, and nowhere else. It is
rendered last, after the pills.

**When the collapsing pill appears.** Both conditions must hold: `onToggleCollapsed`
is a function AND there are at least `COLLAPSE_MIN_TAGS` (4) distinct tags. Its
absence is how a caller opts out of collapsing, which is what makes "collapsed with no
way to reopen" impossible rather than merely unlikely. It renders FIRST, so it is in
the same place whether the bar is open or shut.

**What it does.** Reads `Tags (n)`, with a chevron rotated -90 when collapsed. It only
renders the state it is handed — the caller owns it (`listTagsCollapsed`, keyed by
page). Collapsed, the bar shows the toggle plus, if something is filtering, the active
pill and Clear; everything else is hidden. **Clearing the search box does not reopen
it** — expanding is always a deliberate tap. The threshold is checked in the RENDER
rather than in `collapseOnSearch`, so a bar whose tag count drops below four while
collapsed simply opens again.

**Renders nothing at all** when no tag is in use and nothing is filtering. An active
filter alone keeps the bar alive, which was Step 4b: archive the last tagged row while
filtered to its tag and the bar used to vanish, taking `Clear` with it, on the screen
where the list was emptiest.

#### 🛑 The one real obstacle: it is SINGLE-select

`activeTag` is one string or null. `onFilter(tag)` applies, `onFilter(null)` clears,
and tapping the active pill toggles it off. There is no notion of a set.

The inbox list README asks for "selecting one or more narrows the list". So "reuse the
existing component rather than rebuilding it" and multi-select cannot both be had as
things stand. Three ways out, for Alex to choose at Step 21:

1. **Reuse as-is, single-select.** No risk to the four existing screens; the README's
   "one or more" becomes "one".
2. **Add an opt-in multi-select mode** — `activeTags` as an array alongside the
   existing `activeTag`, with the four current callers untouched. More work, and the
   component grows a second shape, but nothing existing changes behaviour.
3. Copy it — explicitly ruled out, and rightly: the collapse rules alone are four
   interacting decisions with 74 tests behind them.

**Recommendation: 2.** The filter is over six fixed source types rather than a growing
tag vocabulary, so "Claude and Task" is a genuinely useful narrowing that "Claude"
alone is not — and an opt-in array leaves the tag screens alone. Worth knowing before
choosing: with six sources the collapsing pill would appear whenever more than four
source types have items, which on a real inbox will be rare.

### Step 20 — task items, 2026-09-24

`create_inbox_item` now takes `source_type` and `source_metadata`. Deployed as mcp
v121; `verify_jwt` still false on mcp and on clip-capture.

**An allowlist, not a pass-through.** `inbox.source_type` has no check constraint and
no enum, so an unrecognised value would be stored happily and then render as a pencil
("typed by hand") everywhere downstream. The handler rejects anything but `mcp` and
`task` with a message a model can act on, and the input schema is a `z.enum` as well —
the schema stops the common case, the handler is what actually holds.

**A task must name itself.** `source_metadata.task_name` is required for a task,
because a task row with no name cannot answer "what ran", which is the only reason the
row says "task" rather than "Claude". `run_date` is optional and checked against
`YYYY-MM-DD` — it reaches the UI as a date, and an unparseable string would render as
"Invalid Date".

**⚠️ A TASK IS NOT ENRICHED, and that is the point of it.** An `mcp` capture is made
by a model that has just researched contexts, items and tags, so claiming `enriched` is
honest. A scheduled task has had no such conversation — it captured something for a
Claude session to look at later. So `ai_status` is `not_started` for a task, which is
what makes the mockup's "Needs a Claude session" status and its Copy-instead-of-Process
button true rather than decorative.

(The `mcp` branch keeps its long-standing quirk of claiming `enriched` even when no
suggestions were passed. Untouched: it predates this and fixing it is not this step.)

**The icon is `ListChecks`.** `Calendar` is already the schedule and `CalendarClock` an
event; a task is not a moment in time but a named job that ran. Added to
`src/CaptureMeta.jsx` alongside a "Task" label, and `get_inbox`'s `source` filter
description now lists the new value, so a model can actually filter to it.

**One new type error, found and fixed.** `z.record(z.unknown())` — zod v4 wants the key
type too. `deno check` went 97 → 98 and back to 97. Worth knowing: the same one-argument
call appears at five OLDER sites in that file and accounts for five of the 97 baseline
errors. Left alone as out of scope, but they are a five-line fix if wanted.

### Step 17h — one edit card, and the squared-off corner, 2026-09-24

#### The corner

A released footer is stretched to its card's edges, and its SQUARE bottom corners
painted over the card's ROUNDED ones. It showed on the item edit screen and not on the
inbox detail page purely because that one footer carried a matching `rounded-b-xl` by
hand — an accident, not a design.

#### The cards had drifted, and nothing was holding them together

| screen | before |
|---|---|
| item edit | `p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md` |
| intention edit | the same |
| Context form | `p-4 sm:p-6 bg-white border-2 border-primary rounded-lg shadow-lg` |
| inbox detail | `p-4 sm:p-7 bg-card border-2 border-primary rounded-xl` (no shadow) |

Three radii, three shadows, three paddings, two spellings of white.

#### `src/EditCard.jsx`

Owns border, radius, shadow, surface and padding — and hands the two numbers its footer
depends on DOWN THROUGH CONTEXT, so no screen states either:

* `EDIT_CARD_INSET` — the padding the footer cancels to reach the card's edges.
* `EDIT_CARD_FOOTER_RADIUS` — `rounded-b-lg`, derived from the card's `rounded-lg`.

Context rather than props was the shape that let the JSX stay where it was: the footer
reads the card it is inside, and a footer with no card (the two add-to-collection pages)
correctly gets nothing to cancel. No call site names an inset any more — which is what
`src/EditCard.test.jsx` enforces.

**The look: `border-2 border-primary rounded-lg shadow-md` on `bg-card`.** Alex offered
the inbox page's `rounded-xl` for all four; the counts said otherwise. `rounded-xl`
appeared **0** times in Alfred.jsx against `rounded-lg`'s **92**, and `shadow-md` 53
times against `shadow-lg`'s 4. Three of the four cards were already `rounded-lg
shadow-md`. Taking `rounded-xl` would have made these four agree with each other and
disagree with every other card in the app. The inbox mockup's 12px radius loses 4px to
match the whole app.

Padding unified on `p-4 sm:p-6`. Safe now in a way it would not have been earlier: every
list site passes `onViewDetail`, so `ItemCard` and `IntentionCard` render their editing
card ONLY full-screen. `ContextForm` is the one with two modes, and its panel mode keeps
an unpinned footer.

#### 🛑 Why the card does NOT clip its contents

The instruction was to clip — `overflow: clip` rather than `hidden`, which is right about
`sticky`: clip establishes no scroll container, so sticky keeps working. **It would have
broken the intention edit screen.**

`RecurrenceQuickSelect` opens an absolutely-positioned dropdown (`absolute z-50 mt-1
w-full`) and sits near the bottom of that form; `ItemPicker` does the same a few fields
above it. Overflow clipping applies to absolutely-positioned descendants whose containing
block is inside the clipped box, so both dropdowns would be cut off at the card's edge,
and `overflow-clip-margin` cannot help a list of unknown height.

So the equivalent Alex allowed: the footer takes the card's own bottom radius, from the
same constant the card builds its own radius from. The problem was never general overflow
— it was one known element stretched to the card's edges — and this fixes exactly that
while clipping nothing.

#### Untouched, as instructed

`EventCard` shares the old class list and is a card in a LIST, not a full-screen form, so
it keeps it. The Context form's panel mode on the context detail page keeps its unpinned
footer. Both are asserted by the guard test, so a later tidy-up cannot sweep them in by
accident.

#### `docs/design-system.md`

Started, per Alex. `EditCard` and `PinnedFooter` as the first two shared components: what
each owns, what a caller may pass, the rule that full-screen edit forms must use them,
and the two reasoned exceptions. It also records the `!important` trap and the two
constants that are not derived from anything, so the next person does not rediscover
either the hard way.

### Step 17g — one footer component, after three rounds of fixing six copies, 2026-09-24

#### What 17f got wrong

17f found the real mechanism — `space-y-*` beating a negative-margin utility on
specificity — and then asserted that only the inbox detail page had it, because
"none of the other five is a `space-y` child". **That check was wrong.** It looked at
each footer's own class list instead of walking up to its actual parent. Walking up
properly:

| footer | its parent chain | affected? |
|---|---|---|
| CollectionAddItems | plain `<div>`, no card | no — nothing to cancel |
| ItemAddToCollection | plain `<div>`, no card | no |
| **ContextForm** | `space-y-4` → card `p-4 sm:p-6` | **yes** |
| **ItemCard** | `space-y-3` → card `p-3 sm:p-4` | **yes** |
| **IntentionCard** | `space-y-3` → card `p-3 sm:p-4` | **yes** |
| InboxDetailView | card `p-4 sm:p-7` | fixed in 17f |

Alex saw it on the item edit screen. It was equally true of the intention edit screen
and the Context form.

#### The fix: `src/PinnedFooter.jsx`

All six footers are one component now. It owns the sticky offset, the inset that makes
a released footer finish on its container's border, equal vertical padding, the top
border and the flex row. Each screen passes ONE number — its container's padding —
used for the left, right and bottom cancellation together, so those three can never
disagree. The vertical padding is a single constant applied to both sides, so "equal
above and below" is a property of the code rather than of two numbers that happen to
match.

`src/utils/pinnedFooterGeometry.js` holds the constant and the per-screen insets.

**The cancelling margins carry `!important`**, in one rule in `index.css`, and the
comment there names exactly what it beats. That is the only thing that reliably
outranks `.space-y-3 > :not([hidden]) ~ :not([hidden])` at (0,3,0). Applied to all
three sides, not just the bottom, so the next spacing utility on a container cannot
reopen the hole from a different direction. `margin-top` is deliberately left alone —
the container's own spacing is what puts a gap above the footer.

#### A false start worth recording

The geometry was inline first, on the reasoning that an inline declaration beats every
selector and needs no `!important`. It worked in the browser and **vanished in tests**:
jsdom's CSS parser silently discards `calc(-1 * var(…))` from an inline style, so the
rendered `style` attribute came back holding only the padding. A mechanism that cannot
be asserted is a mechanism that breaks quietly — which is the whole history of this
footer — so the margins moved to the stylesheet where a test can read them.

#### The computed spacing, and how it was established

Identical on all six screens, released or docked:

| | value | how |
|---|---|---|
| above the buttons | **12px** | inline `padding-top`, read back through `getComputedStyle` in jsdom for all five inset configurations |
| below the buttons | **12px** | inline `padding-bottom`, same assertion, and compared to `paddingTop` directly |
| residual container padding below a released footer | **0px** | the compiled rule cancels exactly `--pf-now`, and each screen's `--pf-now` is checked against its container's real padding class |

There is no browser here, so the last row is arithmetic over two facts a test pins
rather than a measurement: container `padding-bottom: P` plus footer
`margin-bottom: -P` leaves nothing. The inset also has no effect on the two inner
numbers — it only decides where the footer ENDS. Final confirmation on a screen is
Alex's.

Tests: `PinnedFooter.test.jsx` (12) and `utils/pinnedFooterGeometry.test.js` (9). The
second is the structural guard: it pairs every screen's inset with its container's
padding class, asserts all six call sites go through the component, and fails if
`sticky-above-bar`, `bottom-28` or `bottom-32` ever come back or if a call site tries
to pass its own padding.

#### The SAM flake, fixed

`src/sam/SamPlayer.practice.test.jsx` → "holding every note of the stuck beat resumes
the run" read the real clock twice and allowed 0.5ms between them, so it failed
whenever the machine was busy (4200.5007 observed). **A wider tolerance would have
been the wrong fix** — it would stop the test checking the thing it exists for, which
is that the offset is the beat's own time and not merely near it.

`performance.now` is now frozen for the resume, restored in a `finally`, and the
assertion is `toBe(4200)` — exact. Full suite run three times: clean every time.

### Step 19 — the app shows what was captured, 2026-09-24

Two new files:

| file | what it is |
|---|---|
| `src/utils/capturedClip.js` | the pure decisions — finding the clip id, resolving the capture mode, deciding whether a caveat is owed, when to collapse text, cleaning the link list. 29 tests. |
| `src/ClipboardCapture.jsx` | the fetch and the display. 21 tests, against a mocked browser client. |

Plus 6 tests on the page for where it goes and when it hides.

**Reads go through the browser client**, which carries the signed-in user's own
token, so the `clipboard` bucket's folder-per-user policy is what decides — spec 4.2,
the same rule `get_clip_slices` follows with `ctx.db`. One `createSignedUrls` call
covers every slice; the browser then fetches and caches the images itself. Blobs were
the alternative and would have meant up to 24 downloads held in memory plus a
cleanup path to get wrong.

**Passed IN to the page as `renderCapturedContent`**, not imported by it. The page
takes everything as props and reads nothing global, which is what lets its 66 tests
mount it with four plain objects; importing a Supabase-touching component would put
the database behind every one of them. Same arrangement, same reason, as
`renderRecurrence`.

Decisions worth knowing:

* **The failure state is per-slice.** One object can be missing from a set of nine,
  and a single banner would either hide eight good images or claim all nine were
  fine. A slice that cannot be signed keeps its POSITION, so the numbering still
  matches the page.
* **A missing clip is not an error.** A deleted row and one hidden by RLS both arrive
  as null, and both mean the capture is still perfectly triageable — so it says the
  stored page is gone and gets out of the way.
* **The caveat covers two cases, and the second is the one that gets forgotten.**
  Incomplete (`screenshot_truncated`) AND visible-screen-only (`capture_mode`), which
  is not broken, not flagged, and still not the page. `get_clip_slices` learned this
  the hard way.
* **A missing capture mode means `full`**, resolved in `captureModeFor` exactly as the
  tool resolves it, so the two readers cannot drift.
* **Text is clamped, not cut.** "Show all" reveals text already in the DOM, so a
  browser find reaches it either way.
* **Links are behind their count.** A job board's capture carries hundreds and they
  would bury the screenshot.
* Hidden while the capture text is being edited: a screenshot under a textarea
  invites the reader to think they are editing the page.

#### ⚠️ One pre-existing test flake, unrelated

`src/sam/SamPlayer.practice.test.jsx` → *"holding every note of the stuck beat
resumes the run"* fails intermittently:

```
expect(performance.now() - scrollStartT()).toBeCloseTo(4200, 0)
Expected: 4200   Received: 4200.5007
```

It reads the **real** clock and allows 0.5ms across a React state update, so it fails
whenever the machine is under load. **It is not from this work:** the same test fails
identically at commit `527df29` — the tree Alex verified and pushed — with Step 19
stashed away, and it passes when run on its own. Nothing in Step 19 is imported by
SAM.

Fixable by freezing `performance.now()` for that assertion or widening the tolerance,
but it is SAM's test and outside this phase. Left alone deliberately, recorded here so
the next person does not read it as a Clipboard regression.

### Steps 17e and 18 — footer spacing, and the inline form retired, 2026-09-24

#### 17e: the buttons sat too high, in two different ways

Docked, the footers were `pt-2 pb-3` — 8px above the buttons and 12px below.
Released, it was worse: the card's own bottom padding stacks underneath a footer
that has let go, so the space below grew to `pb-3` PLUS `p-3`/`p-4`.

Two changes, applied to all six:

* **`py-3`** — equal above and below. The inbox detail page's footer came down from
  `py-3.5` to match, so all six share one number.
* **`-mb-3 sm:-mb-4`** (or `-mb-4 sm:-mb-6`, or `-mb-4 sm:-mb-7`) — cancels the
  card's bottom padding, mirroring the `-mx-*` already beside it. Only the three
  footers that live inside a card need it; the two add pages sit on the page
  background, and the inbox detail page already had it.

The `pt-2` in `ContextForm`'s and `ItemCard`'s BASE class moved into the two
branches of their `stickyFooter` ternary. Left where it was, this change would have
reached those components' unpinned mode too — a screen Alex did not ask about.

**Offsets and content padding untouched**, as instructed, and for the reason Step
17d settled: the offset is clearance and the padding is the scroll room that lets a
footer undock.

#### 18: 1,224 lines removed

`InboxCard` was 1,240 lines. It is now **44**, and takes three props — `inboxItem`,
`onOpen`, `onDiscard`. `src/Alfred.jsx` went from 12,990 lines to 11,845.

Gone with it: **all four normaliser copies** (0 left in the file), the
**`eslint-disable`d dirty check**, the collection picker, the capture-text editor
(which lives on as the detail page's pencil), the enrichment info panel, and the
seven props the form needed. The `Info` icon import went with the panel.

**Nothing else referenced any of it**, checked three ways: `<InboxCard` has exactly
one render site; seventeen symbols the form owned now appear zero times; and the
build reported exactly one newly-unused import, which was removed.

Two branches of `handleInboxSave` became unreachable, and they are treated
differently ON PURPOSE:

| branch | verdict |
|---|---|
| `itemItemLinks` — "Attach this Item" | **REMOVED.** Alex dropped the control in 17b, so nothing will ever feed it again. Dead for good. |
| `addToCollection` | **KEPT**, with a comment saying it is dormant. The design hides collections *"for now"*; that is a plan, not a removal, and the section will send the same shape when it returns. |

#### The guard tests had to follow the code

`utils/elementOffsets.test.js` scans source text to catch a seventh normaliser being
added with `collectable` carried through and the offset forgotten — the twin-site
rule. It read `Alfred.jsx` alone, which was right while both element editors lived
there. Step 17 moved one into `InboxDetailView.jsx`, so the scan now reads both files
(plus `utils/suggestedElements.js` for the normaliser count) and the expectations
moved with the code:

* normaliser sites **6 → 3**: four copies replaced by one tested function, plus the
  item editor's own pair.
* `delete X.collectable` **1 → 2**: both editors render the Can buy checkbox now; it
  was the item editor only before the detail page was built to the approved design.
* two patterns are variable-agnostic now (`offsetPatch\(` rather than
  `offsetPatch\(el\)`, `delete \w+\.` rather than `delete next\.`), because the
  extracted normaliser and the new editor name their locals differently and a rule
  about every site must not be blind to one over a variable name.

### Step 17d — the measured layout rolled back, 2026-09-24

Alex measured `--dock-h` in the running app: **83px**, so the 17c callback-ref fix
worked and the measurement really was reaching the CSS. The layout was still wrong
anyway — footers not releasing, the item view's last section still behind the bar,
and the Capture button cramped. Production, which predates all of this, was right
apart from the original gap.

**So the measured approach was rolled back whole rather than debugged further.** That
was Alex's call and it is the right one: two rounds of fixes had each traded one
layout bug for another, and there was a known-good arrangement sitting in production
to return to.

#### What was removed

`src/useDockHeight.js` and its 11 tests, `--dock-h`, `--dock-gap`,
`.pad-above-dock`, and the `pb-[env(safe-area-inset-bottom)]` on the capture bar. The
dock block in `Alfred.jsx` — all 49 lines of it, wrapper through Capture button — is
now **byte-identical to commit 0e5b446**, checked with `diff`, and the content
wrapper is back to `pb-28 sm:pb-32`.

#### The one remaining change, and why it is enough

`.sticky-above-bar` in `index.css`: `position: sticky; bottom: 63px`, and `83px` at
`sm`. Every one of the six pinned footers uses it, and each footer's class list is
otherwise **exactly** production's — verified by taking each production class list,
substituting the offset token, and finding the result in the file (5 of 5, plus the
inbox detail page's, which is new in Step 17).

83px is Alex's measurement of the live bar. 63px is derived from it by the two
padding differences below `sm`: the bar's `py-4`→`py-2` (−16px) and the textarea's
`sm:py-3`→`py-2.5` (−4px).

**The content padding is deliberately still 112/128px, and that is the load-bearing
part.** The two numbers do different jobs, and mirroring them was the original
mistake:

| | what it is | must be |
|---|---|---|
| footer offset | clearance over the bar | **equal to the bar** — 112px floated it, leaving the gap |
| content padding | scroll room | **larger than the bar** — it is what lets the footer UNDOCK |

A sticky footer releases only once the page can scroll far enough for its resting
place to rise above the sticky line. The space below the content is what allows that
scrolling. With the offset at 63/83px and the padding at 112/128px there is ~49px of
slack, so the footer is flush while scrolling AND releases at the bottom onto the
card's rounded edge. Cutting the padding to the bar's height — which 17b did — is
what killed the release.

Accepted cost, agreed with Alex: type enough into the Capture bar and it grows past
83px, and a footer will overlap its top edge until you stop. Transient, and cheaper
than a live measurement that shipped three regressions.

#### The `pb-[env(safe-area-inset-bottom)]` hypothesis: ruled out, but the mechanism is real

Alex's theory was that adding `pb-[...]` to the capture bar replaced its existing
bottom padding, costing the bar its padding on desktop.

**It cannot have, on that element.** The bar div is
`bg-white border-t border-border shadow-lg` — it has **no padding at all**. The
padding lives on the inner `max-w-4xl … py-2 sm:py-4` div, which was never touched.
On desktop `env(safe-area-inset-bottom)` is 0, so the declaration added nothing and
replaced nothing.

**The mechanism he describes is real, though, and would have applied one element
down.** `pb-*` and `py-*` both set `padding-bottom`, and which wins is decided by
source order in the generated stylesheet, not by the order in the class attribute —
so `py-2 sm:py-4 pb-[env(…)]` on the inner div really would have zeroed the bar's
bottom padding on desktop. Worth remembering as a Tailwind trap; it just was not this
bug. The cramped button is unexplained and goes away with the rollback either way.

### Step 17c — the measurement never ran, 2026-09-24

#### The root cause, and why it was invisible

`useDockHeight` took a ref and measured it in `useEffect(…, [ref])`.

Alfred has **five early returns before the dock is rendered** — `authLoading`,
`!user`, `!dataLoaded`, the SAM view and the Timer view — and every cold load passes
through at least one. So on the render where the effect first ran, `ref.current` was
null and the effect returned early. A ref object is stable for the life of a
component, so **the dependency array never changed and the effect never ran again.**
`--dock-h` was never published. Every screen used the CSS fallback for the whole
session.

The fallback was `4rem` (64px), chosen small on the reasoning that being slightly
too small was the safer error. That reasoning was wrong, and it is what turned a
silent no-op into three visible bugs:

| the real dock | the fallback | what it caused |
|---|---|---|
| ~81px desktop | 64px | footers sat 17px BEHIND the capture bar |
| ~81px desktop | 64 + 24 = 88px of padding | only 7px of clearance, against 128px before — last section unreachable |
| — | — | and 7px of slack is far too little for a sticky footer to visibly release |

So items 1 and 2 are one bug with one fix. The fallback is now **8rem, deliberately
larger than any real dock**: for one frame, too much space is invisible and too
little is broken.

#### The fix

`useDockHeight` now returns a **callback ref** and holds the node in state. React
calls it the moment the dock mounts, however many renders later that is, and again
with null when it goes — so the observer effect re-runs on both. Tested, including
the exact failure: *"measures a dock that mounts on a LATER render"*.

`--dock-gap` (2rem) is now a named token rather than a literal in one calc, because
it does two jobs and the second is easy to delete by accident: breathing space under
the content, AND **the slack a pinned footer needs in order to undock**. A sticky
footer releases only once the page can scroll far enough for its resting place to
rise above the sticky line, and the space below the content is what allows that
scrolling. At maximum scroll the card's bottom edge now sits `--dock-gap` above the
dock, so the footer releases and you see exactly that much of the card's rounded
bottom edge.

#### 🛑 Item 3 is NOT explained by this, and is not closed

The clipped Capture button on desktop has no cause I can find. Nothing in 17b or 17c
touches the dock's own markup or CSS beyond attaching a ref, and:

* the dock is `fixed bottom-0`, so it cannot extend below the viewport;
* no ancestor has a `transform`, `filter` or `will-change`, which are the only things
  that would make `fixed` resolve against something other than the viewport;
* every `z-30`/`z-40`/`z-50`/`z-[100]` in the app is a modal, the mobile drawer or a
  dropdown — nothing that would paint over the bar in a resting state;
* a pinned footer cannot cover it: the dock is `z-20` and a sticky footer has
  `z-index: auto`, so the dock paints above it.

What WAS true before the fix is that every pinned footer overlapped the bottom 17px
of the dock, hidden behind it, putting the footer's `border-t` across the screen
just above the Capture button. That may be what read as clipping. Re-check after
this lands; if it persists, the two things to establish are whether the page scrolls
sideways at all (a horizontal scrollbar eats the bottom of the viewport) and the
browser zoom level.

Defensively, the capture bar now carries `pb-[env(safe-area-inset-bottom)]` so a
device's home bar cannot overlap the button. On the BAR, not the dock wrapper: the
wrapper is transparent behind the Undo message, and a background there would put a
white strip behind a pill that floats over the page. Zero on desktop.

#### Details on the intention view and edit screens — and a second silent drop

The view screen shows `intention.description` below the name, muted, absent when
empty, `whitespace-pre-wrap` because paragraph breaks are content. The edit screen
has a Details textarea directly under Name, matching the inbox detail page's order.

**`updateIntent` would have dropped it.** That function builds an explicit whitelist
— *"be explicit about what we're storing"* — and `description` was not in it. The edit
screen would have shown the box, accepted the text, reported a successful save and
changed nothing, with no error anywhere. A whitelist fails that way silently, once
per new column.

So the mapping moved to `src/utils/intentionRows.js` alongside the triage builder —
one home for "how an intents row is built", both ways it can be built — with
`detailsForStorage` as the single rule for blank-means-null. 28 tests.
`src/utils/triageRows.js` is gone, folded into it.

Worth knowing: an omitted column is NOT erased, because `storage.set` issues an
UPDATE, which only names the columns it is given. That is why `source_inbox_id`
survives an edit despite also being absent from the whitelist. The safety comes from
UPDATE's semantics rather than from the list being complete.

### Step 17b — rulings, two fixes, and the footer gap, 2026-09-24

#### 1. The capture-text pencil is back (Alex's ruling)

On the "Original capture" section, reusing `updateInboxCaptureText`. It keeps its
OWN Save and Cancel rather than committing through the card footer. Step 12.7b
argued against a second Save on the old card and was right there — both pairs were
labelled the same and one of them filed the capture. Here the footer's primary says
**Process**, a different action with a different outcome, so a pair scoped to this
one section is clearer than folding a typo fix into the button that files a record.

Pressing Process with an unsaved correction pending **writes the text first**, so a
triage in the same press files the corrected capture rather than the text being
corrected. If the text write fails, nothing is filed.

**A bug this exposed, and the fix.** Saving the capture text clears the enrichment
in the database — the suggestions describe text that no longer exists. `baseline`
was `useMemo`'d on `inboxItem`, so the moment that row came back with every
`suggested_*` field nulled, the baseline changed underneath a form nobody had
touched and the dirty check reported a dozen differences at once. `baseline` is now
**state, seeded once**, advanced only by `handleSaveCapture`. Two fields follow a
correction — an item or intention name still showing the capture verbatim, because
that is a pre-fill; a name the user wrote is theirs and is left alone.

#### 2 and 3. Dropped, as ruled

"Attach this Item" and Target Start Date are not on the page and were never added,
so there was no code to remove. **The intention edit screen and
`intents.target_start_date` are untouched** — the ruling was for this page only.

#### 4. `intents.description`: traced, no fault found, now under test

Traced end to end: the page emits `intentionData.description` (already tested), the
mapping in `handleInboxSave` copies it, `toSnakeCase` leaves an already-snake key
alone, and `storage.set` sends every key it is given — there is no column whitelist
anywhere. **No fault.** The likeliest reading of "0 of 166" is the one Alex
suggested: no Details text was typed on the capture that was tested, and null is the
correct result for that.

What was wrong is that this could only be answered by reading code. The mapping
lived inside a 12,900-line component where no test could reach it, which is why
"probably fine, here is my reasoning" was the best available answer.

So the row builder is now `src/utils/triageRows.js` — `intentionRowFromTriage`,
pure, with `src/utils/triageRows.test.js` (18 tests). And
`InboxDetailView.test.jsx` gained a **joined-chain** group: render the page, type
into Details, press Process, feed the emitted triage data to the real row builder
and the real case converter, and assert on `description` in the object Postgres
would be sent. Nothing stubbed between the keystroke and the row; only the network
call is out of scope.

#### 5. The pinned footer gap — one measurement, six footers

**The cause.** Six footers were positioned `sticky bottom-28 sm:bottom-32` — 112px,
or 128px above `sm`. The dock they were meant to sit on is about **61px** on a phone
and **77px** above `sm`. So every one of them floated roughly 50px too high, and the
page scrolled through the daylight underneath. The content wrapper's matching
`pb-28 sm:pb-32` over-reserved by the same amount. Both numbers were a guess at the
dock's height, and the guess was wrong everywhere.

**Why not better numbers.** There is no correct number. The dock is one fixed
container holding the Undo message stacked on the Capture bar, and its height moves:
the capture textarea grows with what you type up to 50vh, the Undo message comes and
goes, the padding changes at `sm`, and a long undo message wraps. A per-screen offset
is the same guess repeated six times, which is exactly how five of the six came to
share a number wrong for all of them.

**The fix.** `src/useDockHeight.js` measures the dock and publishes `--dock-h` on the
document root; `src/index.css` defines `.sticky-above-dock` (`bottom: var(--dock-h)`)
and `.pad-above-dock`, with a fallback value for the frame before the first
measurement. `getBoundingClientRect`, not `offsetHeight`, because the textarea's
height is fractional and rounding leaves a half-pixel seam. A measurement of 0 is
never published — that would drop every footer behind the bar for a frame.
`ResizeObserver` is feature-detected. Tested: `src/useDockHeight.test.jsx`, 8 tests.

**Every screen changed** — all six pinned footers plus the content padding:

| where | what it is |
|---|---|
| `CollectionAddItems` | Add items to a collection |
| `ItemAddToCollection` | Add this item to a collection |
| `ContextForm` | Context add / edit, when full-screen |
| `ItemCard` | The item edit screen |
| `IntentionCard` | The intention edit screen |
| `InboxDetailView` | The new inbox detail page |
| the main content wrapper | `pb-28 sm:pb-32` -> `pad-above-dock` |

`bottom-28` and `bottom-32` no longer appear anywhere in the app.

#### 6. Mockups renamed

See the section above the step list.

### Step 17 — the inbox detail page, 2026-09-24

`/inbox/detail/:id`. New files:

| file | why it is its own file |
|---|---|
| `src/InboxDetailView.jsx` | the page. Reads nothing global, so a test mounts it with four plain objects |
| `src/utils/suggestedElements.js` | **the one normaliser**, replacing four copies that had to stay byte-identical |
| `src/CaptureMeta.jsx` | `friendlyDate`, `sourceLabel`, `SourceIcon` — moved out of Alfred.jsx, which imports the page and so cannot export to it |

Tests: `src/InboxDetailView.test.jsx` (41), `src/utils/suggestedElements.test.js`
(14), plus 12 route tests in `src/viewPaths.test.js`.

#### The route follows the execution precedent, not a new one

`/inbox/detail/:id`, resolved by `inboxIdFromPath`, with `parentPath` falling back
to `/inbox` rather than to the bare `/inbox/detail` — one visible correction
instead of two. No `useExecutionRoute`-style fetch hook: `loadData` already selects
every live inbox row into state, so the capture is a plain lookup, exactly as the
add pages resolve their target. The only care needed is not judging a row missing
before `dataLoaded`.

#### 🛑 THREE FEATURE LOSSES, AWAITING ALEX'S RULING

The approved design does not include these, and Step 18 deletes the old form that
does. Each is a real capability going away:

1. **Editing the captured text** — the pencil from Step 12.7, with
   `updateInboxCaptureText` and `CLEARED_ENRICHMENT` behind it. After Step 18
   there is no way in the app to fix a typo in a capture.
2. **"Attach this Item"** — appended the new item as a bullet element of an
   existing item (`itemItemLinks`). The page sends `[]`.
3. **Target Start Date** — the When control has three answers and no fourth.
   `endDate` survives, carried by the repeat control.

Also absent by design: the `ai_status` badge and the enrichment info panel
(confidence, reasoning). The badge still shows on the inbox LIST row.

#### A bug found while wiring it up, and fixed

`handleInboxSave` resolves the intention's item as
`triageData.intentionData.itemId || createdItemId` — **the passed id WINS over the
item just created.** So picking an existing item and then turning New Item on gave
a page promising "the new item will be linked" and an intention attached to the
earlier pick. Dimming the picker hides a stale value; it does not clear it. The
page now sends `itemId: itemOn ? null : linkedItemId || null`, with a test.

#### Decisions worth knowing

* **One Context and one Tags, shared by both sections.** The old card had a pair
  per section, so filing one capture could put the item in one context and its
  intention in another with nothing pointing it out.
* **"a date" means an EVENT** (`createEvent` + `eventDate`), which is what put a
  capture on the planner before and what "do it Saturday" means in Alfred.
* **Process is disabled with neither toggle on.** Nothing would be created, and
  Discard is the button for "this should just go away".
* **Nothing re-seeds the form.** The old card re-seeded when enrichment landed,
  because it had an Enrich button and the user was waiting. Step 14 removed that
  button, so the only way suggestions now arrive mid-edit is a coincidence — and
  overwriting what somebody is typing to serve a coincidence is the wrong trade.
* **Details is stored as NULL when blank**, honouring migration 069's comment.
  Deliberately unlike `items.description`, which has always stored `''`.
* **The dirty check has no `eslint-disable`.** `baseline` is one memoised object
  that seeds the state AND is what the comparison reads, so the effect depends on a
  single boolean. The old card needed the disable because its hand-written
  dependency list could not be kept honest.
* **`InboxCard` is otherwise untouched.** It gained one optional `onOpen` prop and
  its collapsed row calls it, which makes the whole expanded form unreachable —
  Step 18 then deletes dead code rather than live code.
* **Phone layout comes from the README's rule**, not a picture: the mockup for it
  does not exist (see the table above). One column, same order, footer pinned —
  the card is `max-w-[860px] mx-auto` and collapses to full width below that.

### Step 16 — intentions had nowhere to put prose, 2026-09-24

`supabase/migrations/069_phase3_intents_description.sql` adds
`public.intents.description text null`.

**Checked first, as asked: no existing column would do.** `public.intents` has
sixteen columns and the only text one is `text` — the intention's NAME, NOT NULL,
and what every list, planner row and event label renders. Widening it into "name,
or possibly name plus three paragraphs" would push arbitrary length into every
place an intention is displayed. The rest are a jsonb schedule
(`recurrence_config`), two dates, a `text[]` of tags, and foreign keys.

The item half of the same form already has exactly the right column:
`items.description`, text, nullable. Intentions never had one because until now
the only way to make one was a single-line box.

**Named `description`, labelled "Details".** Matching the mockup's label would
have made it `intents.details`, sitting beside `items.description` holding the
same kind of content in the same position on the same form — one concept under two
names, costing every future reader a lookup and every shared helper a translation.
A UI label needs to read well in one place; a column name needs to be recognised
everywhere. So the column matches its sibling and the label stays as designed.

Nullable with no default, matching `items.description`: `not null default ''`
would make "nothing written" and "emptied on purpose" indistinguishable, and every
reader would end up treating `''` and null alike anyway. Nothing is backfilled —
an intention's name is not its description, and copying one into the other would
invent content.

### Step 15 — the ai-enrich retirement clock

**2026-09-24: the last caller of `ai-enrich` was removed from the code.**
`handleEnrich` and `handleReEnrich` are gone from `src/Alfred.jsx`, along with
the Enrich / Re-enrich / Enriching buttons, the `enriching` state, the `onEnrich`
prop and `handleInboxEnrich`. Nothing in the repository calls
`/functions/v1/ai-enrich` any more — verified by grep across `src/`, which now
returns only comments.

⚠️ **THE CLOCK DOES NOT START TODAY. It starts when the frontend deploys.**
Removing the caller from the code stops nothing: Alfred is served from Vercel and
deploys on push to `main`, and nothing has been pushed. Until then the live app
still has its Enrich buttons and will still call the function. Counting a week
from the commit date would schedule the retirement while calls were still
arriving.

**So: fill in the deploy date below when it happens, and count from that.**

```
ai-enrich last caller removed from code:  2026-09-24
Frontend deployed (calls actually stop):  2026-09-24   <- Alex pushed
Earliest safe retirement (deploy + 7d):   2026-10-01
```

**Filled in 2026-09-24:** Alex pushed the frontend the same day the caller was
removed, so the two dates coincide and the clock is already running. Do not retire
`ai-enrich` before **2026-10-01**, and not then either without the log check below.

**Before retiring, confirm from the logs rather than from reasoning.** The repo
grep proves the app does not call it; it does not prove nothing else does. Check
Dashboard → Edge Functions → `ai-enrich` → Logs for the seven days after the
deploy, and look for any invocation at all. Anything found is worth identifying
before deleting: `ai-enrich` is the only function holding `ANTHROPIC_API_KEY`, so
a forgotten caller fails in a way that is easy to misread as an API problem
rather than a missing function.

**Retirement order, from the spec's Phase 3 section**, and the ordering is the
point: remove the callers (done), confirm a week of silence in the logs, *then*
delete the function and the `ANTHROPIC_API_KEY` secret. Not in one change — a
function with no callers is harmless, and an undeletable one is not.


### Investigation: what happens to `captured_text` when an inbox item is triaged

Asked 2026-09-24, ahead of the Phase 3 decision that created records should link
back to the inbox item they came from.

#### The short answer: nothing keeps it. There is no link, and no copy.

`handleInboxSave` (`src/Alfred.jsx:3062-3208`) is the ONLY triage path. It writes
up to four records and then hard-deletes the inbox row at
`src/Alfred.jsx:3199`. Every field each record receives is enumerated in that
function, and none of them is `captured_text` or the inbox id:

| record | written at | fields | provenance field? |
|---|---|---|---|
| `items` | `Alfred.jsx:3089-3099` | id, user_id, name, description, context_id, elements, tags, is_capture_target, created_at | **none** |
| `intents` | `Alfred.jsx:3129-3143` | id, user_id, text, created_at, is_intention, is_item, archived, item_id, context_id, recurrence_config, target_start_date, end_date, tags | **none** |
| `events` | `Alfred.jsx:3148-3159` | id, user_id, intent_id, context_id, time, item_ids, archived, created_at, text | **none** |
| `collection_items` | via `addItemsToCollection`, `Alfred.jsx:3170-3177` | collection_id, item_id, quantity | **none** |

Confirmed against the live schema: `items` has eleven columns and not one of them
records where the row came from. The same is true of `intents` and `events` —
they are Alfred's original tables and predate the inbox having anything worth
pointing at.

#### The one place the text survives, and why it is not enough

The triage form PRE-FILLS from the capture:

- `itemName` defaults to `suggestedItemText || capturedText` (`Alfred.jsx:7519`)
- `intentText` defaults to `suggestedIntentText || capturedText` (`Alfred.jsx:7508`)

So if Alex leaves the pre-filled field alone, the capture survives — as
`items.name` or `intents.text`, that is, **as a title**. `events.text` then copies
the intention's text (`Alfred.jsx:3159`), so the same string can reach three
tables.

That is fine for "buy milk". It loses everything for a capture longer than a
title: a forwarded email's body, a paragraph of context, the reason he captured
it. Those go into a form field that exists only to name the record, get replaced
by whatever he types, and are gone. **And nothing anywhere records that the
record came from a capture at all**, so the loss is not visible either.

#### What happens on delete today

`storage.delete('inbox:{id}')` at `Alfred.jsx:3199`. The row goes.

`public.inbox` is registered `audited: true`, so the `platform.audit_row` AFTER
DELETE trigger writes the whole old row to `platform.audit_log`. **The original
`captured_text` is therefore recoverable — by a person with SQL access, reading
an audit table.** It is not reachable from the app, not reachable by Claude, and
not associated with whatever the capture became. As a recovery story that is
real; as a feature it is nothing.

#### There is no tool path. Claude cannot triage at all.

Worth stating plainly, because the question assumed one might exist: there is
**no `create_item`, `create_intent` or `create_event` tool**. The MCP surface has
75 tools and the only writers touching this area are `create_inbox_item`,
`update_inbox_item` and `archive_inbox_item`. Claude can put things INTO the
inbox and hide them again; it cannot turn one into an item or an intention. The
app is the only triage path, so `handleInboxSave` is the whole of the answer.

#### Proposed link-back column

```
source_inbox_id  text  null  references public.inbox(id) on delete set null
```

On `items`, `intents` and `events`. Indexed per table, partial on not-null.

- **`text`, not `uuid`** — `inbox.id` is `text`, and so is `items.id`. A uuid
  column would not match the referenced key.
- **Nullable** — almost every existing row has no inbox origin and never will.
  Null means "not from a capture", which is the truth for most of the table.
- **ON DELETE SET NULL.** Not CASCADE: deleting an inbox row must never destroy
  the item it became, and CASCADE would do exactly that to real records. Not
  RESTRICT: that would make an inbox row undeletable once triaged, which is worse
  than the problem it prevents. SET NULL degrades to "origin unknown", which is
  honest.
- **Collections are deliberately left out.** `collection_items` is a membership
  row rather than a record of its own, and its provenance is the item's.

⚠️ **This column only becomes meaningful once triage archives instead of
deleting** (Phase 3 decision E). While `handleInboxSave` hard-deletes, ON DELETE
SET NULL would null every link moments after it was written — the feature would
look implemented and record nothing. **Ship E first, or both together.**

⚠️ **It cannot be backfilled.** The association was never recorded, and the audit
log holds deleted inbox rows without saying what they became. Every row that
exists before this lands has a null `source_inbox_id`, permanently. That is an
argument for doing it sooner rather than later, not for skipping it.

**No migration written** — the proposal only, as asked.


**2026-09-24 — the CLI report rule was rewritten** (`.claude/CLAUDE.md`, "Everything you say to Alex goes into Alfred"): Alex does not read the CLI terminal at all, so every closing message — questions, answers, corrections, blockers, not just reports — is pushed to Alfred first and printed verbatim afterwards, with the pushed and printed text identical.

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
