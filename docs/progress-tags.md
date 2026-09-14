# Progress — Tags: spaces, autocomplete picker, collection tags, removals since midnight

Status: **COMPLETE.** All phases done and verified on the phone.
Spec: `docs/technical-spec-tags.md`
Investigation: `docs/history/investigation-tags-and-collections.md`

Rule: one phase at a time. Stop at each gate and wait for Alex to confirm
before starting the next phase.

---

## Phase 1 — Utilities

_Done 2026-09-14. See "Phase 1 findings" below._

- [x] Extract `normalize` from `src/utils/ingredientMatch.js` into
      `src/utils/search.js`; export `matchesLoosely`
- [x] Update `ingredientMatch.js` to import the extracted helper
- [x] Confirm `matchesQuery` and `search.test.js` are untouched
- [x] Create `src/utils/tags.js` with `normaliseTag` and `normaliseTags`
- [x] Create `src/utils/localDay.js` with `startOfPacificDay`
- [x] Tests: loose matcher, tag normaliser (apostrophes, spaces, underscores,
      length cap, dedupe, 20-tag cap)
- [x] Tests: Pacific day — just after midnight, just before midnight,
      2026-03-08 spring forward, 2026-11-01 fall back, all with a non-Pacific
      browser timezone — **see the timezone note in the findings; forcing TZ
      inside Jest is impossible on Windows, so zone-independence is proven two
      other ways instead**
- [x] Confirm what `npm test` actually runs

**Gate:** all tests green, no behaviour change anywhere in the app.
**Result:** 36 suites / 849 tests green (was 33 / 797). Production bundle grew
by 1 byte — the two new modules are not imported by anything yet, so nothing
the app ships has changed.

## Phase 1b — Detail view header and tag display

Inserted after Phase 1 verification. Three pre-existing display faults on the
item and intention detail views, found while verifying Phase 1 but **not a
regression** — nothing imports the new utilities yet. Display only; no change to
how tags are stored, read or normalised.

_Done 2026-09-14. See "Phase 1b findings" below._

- [x] Context name is plain text behind the Contexts-list glyph, not a pill
- [x] Tags render as chips on both detail views, all of them, no "+N more"
- [x] Nothing renders when a record has no tags (and no empty row)
- [x] Title gets its own full-width row; actions move to a wrapping row beneath
- [x] Both headers end up structurally identical
- [x] Tag editing NOT added to these views — that is Phase 4
- [x] The four dirty-check comparisons untouched
- [x] Checked at narrow phone width and desktop

**Gate:** a record with several tags shows all of them; a record with none shows
nothing; a long title uses the full width on a narrow screen; the context name
no longer reads as a tag.
**Result:** 36 suites / 849 tests still green. Bundle +110 B.

## Phase 2 — Edge Function

_Done 2026-09-14. See "Phase 2 findings" below._

- [x] Remove `tags` from the `getContexts` select — **there were TWO**, one in
      `_shared/alfred-tools/tool-handlers.ts` and one inline in `mcp/index.ts`
- [x] Check whether the frontend selects `contexts.tags` anywhere; remove if so
      — no *read* anywhere, but found a **write** that would have broken after
      Migration A; fixed. See findings.
- [x] Add a Deno-side copy of the tag normaliser in
      `supabase/functions/_shared/tags.ts`, with a header noting the duplication
      — both files now name each other as twins
- [x] Normalise tags on write in `ai-enrich`
- [x] **Also normalised the other three model-driven write paths** —
      `createInboxItem`, `updateInboxItem`, and the MCP inline
      `create_inbox_item`. Spec §4 says "any non-UI path"; ai-enrich alone would
      have left the hole open.
- [x] Update the tag-format instruction in the `ai-enrich` prompt (two sites:
      the rules list and the `submit_suggestions` input schema)
- [ ] ~~Update the tag-format instruction in `alfred-enrich/SKILL.md`~~ —
      **BLOCKED, Alex must do this.** The file lives at
      `/mnt/skills/user/alfred-enrich/SKILL.md`, inside the Claude.ai skills
      environment. It is not in this repo and not on this machine. See findings
      for the exact replacement text.
- [x] Update any MCP tool description mentioning tag format — both
      `create_inbox_item` and `update_inbox_item`
- [x] Deploy: `supabase functions deploy mcp --no-verify-jwt`
- [x] **Also deployed `ai-enrich`** — it bundles the same `_shared/` files, so
      without it the old `getContexts` would still be live
- [x] Confirmed `verify_jwt` still false on `mcp` after deploy

**Gate:** contexts still load in the app; inbox enrichment still returns tags.
Tool verification needs a fresh chat thread — the MCP manifest is frozen for
the life of a session.
**Result:** `mcp` at version 84, `verify_jwt: false`. `ai-enrich` at version 9,
`verify_jwt: true` (correct — it is called from the authenticated app).
Frontend 36 suites / 849 tests still green; build clean.

## Phase 2c — Hyphens fold to spaces (rule amendment)

Approved after the spec was written; had to land before Migration A so the
migrated data matches what the code produces. _Done 2026-09-14._

- [x] `src/utils/tags.js` — `.replace(/_/g, " ")` becomes `.replace(/[-_]/g, " ")`
- [x] Deno twin `supabase/functions/_shared/tags.ts` — same change
- [x] Spec §3 amended so the written rule matches the code
- [x] Tests: `stir-fry` / `stir_fry` / `stir fry` all converge; `e-bike` →
      `e bike`; leading and trailing hyphens leave no stray space
- [x] Twins re-verified byte-identical in logic
- [x] `foldText` and `matchesQuery` untouched — storage rule only
- [x] Deployed `mcp` with `--no-verify-jwt` explicit, `ai-enrich` without it
- [x] `verify_jwt` still false on `mcp`

**Result:** 36 suites / 851 tests green (+2). `mcp` v85 `verify_jwt: false`,
`ai-enrich` v10 `verify_jwt: true`. Live probe of the deployed endpoint returns
the function's own OAuth challenge, confirming the flag took effect.

## Phase 3 — Migration A (manual SQL)

SQL written to `docs/migrations/migration-a-tags.sql` on 2026-09-14.
**Not run — Alex runs it by hand.** See "Phase 3 findings" for two corrections
to spec §6 that need review before running.

- [x] Migration A written out, with the hyphen fold folded in
- [x] SQL conversion verified equivalent to the JavaScript rule on the live
      taxonomy plus 14 edge cases — 27/27 identical
- [x] Alex diffs the live `platform_search_items` against the one in the file
- [x] Alex takes a database backup
- [x] Alex runs Migration A
- [x] Verification queries V1–V9 in the file all pass
- [x] `check_platform_conformance` returns CONFORMANT
- [x] Spot-check: `select tags from items where 'nervous system' = any(tags)`
      returns rows

**Gate:** items and intentions load with their tags; tag filters still work;
`get_items` with a tags filter works over MCP, tested from a fresh thread.
**Result (confirmed by Alex 2026-09-14):** `items.tags` and `intents.tags` are
`text[]`, `contexts.tags` is gone, `platform_search_items` uses `&&`, every
stored tag is canonical with underscores and hyphens folded to spaces, and
conformance returned CONFORMANT.

## Phase 4 — TagPicker

_Done 2026-09-14. See "Phase 4 findings" below._

- [x] Build `src/TagPicker.jsx` on `ItemPicker`'s structure
- [x] Create-new row always visible at the bottom, showing the normalised form
- [x] ~~Preserve commit-on-blur~~ — **REVERSED after verification. Blur must not
      commit.** Spec §9.2 updated with the reasoning so it is not restored.
- [x] Preserve the 20-tag and 50-character caps and chip removal
- [x] Replace all four `TagInput` sites
- [x] Delete `TagInput` and `processTags`
- [x] Confirm the four dirty-check comparisons are untouched
- [x] Suggestion pool derived client-side from loaded items + intents, threaded
      to the four sites. No new query, no collection pool.
- [x] 39 tests covering the create row, loose filtering, every commit route,
      the list closing after an add, the already-added state, and the
      never-normalise-on-load guarantee

### Post-verification fixes (2026-09-14)

Both found by Alex on the phone. Behaviour changes, not defects in what was
built. See "Phase 4 verification fixes" at the end of this file.

- [x] **Blur no longer commits.** A tag is created only by tapping Create,
      tapping a suggestion, or pressing Enter. Uncommitted text stays in the
      box rather than being cleared.
- [x] **The list closes and focus drops after any successful add**, so the chip
      row is visible and the keyboard gets out of the way.
- [x] `onMouseDown` focus guards kept — still correct, tests still pass
- [x] Spec §9.2 amended: the old "preserve commit-on-blur" bullet struck
      through, with why it expired
- [x] **"already added" empty state.** Typing a tag already on the record fell
      through to "No matching tags", which read as "that tag does not exist".
      It now says `"buggy" is already added` in the create row's slot.

**Gate:** on a phone — add a tag with a space; type `bread` where
`breadcrumbs` exists and successfully create `bread`; type `TJ's` and get
`tjs`; **type text and tap outside — NO tag is created**; each of the three
explicit commit paths works; the chips are visible immediately after an add;
open a record, change nothing, navigate away with no unsaved-changes prompt.

## Phase 5 — Migration B (manual SQL)

SQL written to `docs/migrations/migration-b-collection-tags.sql` on 2026-09-14.
**Not run — Alex runs it by hand.** Spec §7 needed no corrections; see
"Phase 5 findings" for the two questions it did not answer.

- [x] Migration B written out
- [x] Spec §7 checked against the recorded column definitions — correct as
      written, nothing to fix
- [x] Trigger question answered: **no guard needed** (DDL fires no row
      triggers, and neither table has `updated_at` anyway)
- [x] Locking question answered: **metadata-only, milliseconds**, but it does
      take a brief ACCESS EXCLUSIVE lock — `lock_timeout` added
- [x] No-index claim confirmed against what Phase 6 will actually query
- [x] Alex runs Migration B
- [x] Verification queries V1–V5 in the file all pass
- [x] `check_platform_conformance` returns CONFORMANT

**Gate:** collections still load and behave normally with the new empty column
present.

## Phase 6 — Collection tags

_Done 2026-09-14. See "Phase 6 findings" below._

- [x] `removeMembers` snapshots tags
- [x] `addMembers` accepts `entry.tags`
- [x] `addMember` passes tags through
- [x] `reAddRemoval` passes `tags: removal.tags`
- [x] New `updateMemberTags`
- [x] `updateMemberQuantity` left alone — warning comment added on it saying
      why it must not be widened
- [x] No tag handling added to `addOrMergeMembers`; `collapseEntries` untouched
- [x] `loadCollectionTagPool`, drawing from members AND removal history
- [x] Tag chips on collection member rows, opening `TagPicker` with the
      collection pool
- [x] `TagFilter` above the collection list with its own `collectionFilterTag`
      state, reset on view change
- [x] Regression test: recipe-to-collection does not carry source item tags
      (four cases, including the merge path)
- [x] Test: tag survives remove and restore
- [x] Poll paused while a tag editor is open, as it already is for quantity
- [x] 23 new tests; 38 suites / 913 tests green, bundle +871 B

### Post-verification fixes (2026-09-14)

Two interaction fixes from Alex's phone verification. See "Phase 6 interaction
fixes" at the end of this file.

- [x] **The tag editor focuses its input on open**, so the Tag button leaves
      you ready to type rather than needing a second tap
- [x] **Opening one row's editor closes any other through the same close path**
      as Done and the row's own button — one `closeTagEditor`, not three
- [x] Uncommitted text is discarded on switch, not carried or committed
- [x] Poll-pause behaviour unchanged and correct across a switch
- [x] 10 more tests; 38 suites / 923 tests green, bundle +90 B
- [ ] ⚠️ **Alex to judge in use:** the suggestion list may land under the phone
      keyboard for a row low in a long list. Reported, not fixed — see findings
      for the three options.

### Editor simplification (2026-09-14)

Four connected changes, one shape: the row's chips become the tag UI and the
editor becomes only the input. See "Phase 6 editor simplification" at the end
of this file.

- [x] Placeholder is "Search or add" — a collection's tags are not always stores
- [x] **Row chips are removable**, each with its own ×, no editor needed. The
      change the other three depend on.
- [x] Editor renders no chip list of its own — `showChips={false}`
- [x] Done button gone; tapping outside the row closes the whole editor
- [x] Adding a tag still does NOT close the editor — Phase 4's rule holding
- [x] Outside-tap routed through `closeTagEditor()`, so the poll resumes and
      uncommitted text is discarded
- [x] 11 more tests; 38 suites / 934 tests green
- [x] **Fixed: tapping the tag button on a row BELOW an open editor did
      nothing.** A layout bug, not a state bug — confirmed before changing
      anything. See "Phase 6 — the row-switching bug" at the end of this file.
      7 more tests; 38 suites / 941 tests green.

**Gate:** on a phone — tag eggs `tjs` and milk `whole foods`; filter to `tjs`;
remove eggs, restore it, tag still there; add a fresh item, no tags on it; add
a recipe containing an already-tagged item, tag unchanged.

## Phase 7 — Removals since midnight

_Done 2026-09-14. See "Phase 7 findings" below._

- [x] `loadRemovals` gains `since`, allows no limit
- [x] `MAX_REMOVALS` ceiling lifted — bypassed entirely by `limit: null`, and
      still guarding the history view, which is where it belongs
- [x] `limit: 25` removed from the panel fetch
- [x] `.slice(0, 5)` removed from the render
- [x] `reason: 'manual'` filter kept
- [x] Still-in-collection filter kept
- [x] Uses `startOfPacificDay` from Phase 1 — nothing new written
- [x] Duplication check first: no third day-boundary helper exists
- [x] 17 new tests; 39 suites / 958 tests green
- [x] **Removals show their tags and quantity**, in both the panel and the
      history view — read-only. 18 more tests; 40 suites / 976 tests green.

**Gate:** remove more than five items and see all of them; yesterday's
removals are absent; correct from a browser set to a non-Pacific timezone.

---

## Notes

### Phase 1 findings (2026-09-14)

**Files added:** `src/utils/tags.js`, `src/utils/localDay.js`, and three test
files (`tags.test.js`, `localDay.test.js`, `searchLoose.test.js`).
**Files changed:** `src/utils/search.js` (purely additive — `foldText` and
`matchesLoosely` appended, nothing removed) and `src/utils/ingredientMatch.js`
(its private `normalize` deleted, now imports `foldText`).

`search.test.js` is byte-for-byte untouched, confirmed with `git diff --stat`,
and `matchesQuery` has no deleted lines in its diff. `searchLoose.test.js`
carries two guard tests that fail loudly if anyone widens `matchesQuery` later.

#### What `npm test` actually runs

`npm test` is `react-scripts test` — CRA's Jest, whose `testMatch` covers
**only `src/`**. It collected **33 suites / 797 tests before this phase, 36 /
849 after**, all passing.

Things that are NOT run, and were never run:

- `supabase/functions/_shared/tools/dj-reads.test.mjs` — outside `src/`.
- `workshop/tests/*.py` — pytest, a different runner entirely.
- `src/utils/recurrence.manual-check.js` — does not match `*.test.js`.

The investigation's worry that `collectionMembers.test.js` was not wired in was
too pessimistic: the file **is** collected and passes. What the
collection-history notes actually recorded was that some removal-path
assertions were exercised from a scratchpad harness that was never committed —
so those specific cases have no coverage, but the file itself is live. Phase 6
adds its regression tests there and they will run.

Use `CI=true npx react-scripts test --watchAll=false` for a single run; plain
`npm test` starts watch mode.

#### ⚠️ Forcing a non-Pacific timezone is impossible on this machine

The spec asks for the Pacific-day tests to run with the browser timezone forced
to something non-Pacific. **That cannot be done here**, and it took three
attempts to establish why:

1. `process.env.TZ = "…"` at the top of a test file — **no effect**. Jest has
   already built the environment and V8 has cached the zone. Verified directly:
   after setting it, `getHours()` still returned Pacific.
2. `TZ=America/New_York npx react-scripts test` — **also no effect.** This one
   is the trap, because it looks like it worked. A probe test proved the suite
   still ran in `America/Los_Angeles`.
3. The root cause: **Node on Windows ignores the `TZ` environment variable at
   process start** and reads the OS timezone instead. Only in-process mutation
   before the first `Date`/`Intl` use works — which in Jest is always too late.

The remaining option was a Jest `globalSetup`, which would change the
environment for all 36 suites including SAM's Pacific-pinned formatters. That
is a bigger blast radius than the problem justifies, so it was not done.

**Zone-independence is instead proven two ways, both stronger than a single
forced run:**

- `localDay.test.js` has a **source guard** asserting the module contains no
  local-time API at all (`setHours`, `getTimezoneOffset`, `toLocaleDateString`
  and fifteen others). This is the exact regression the TZ requirement exists
  to catch, asserted directly rather than inferred from behaviour. It matters
  because a naive `setHours(0,0,0,0)` implementation passes *every* behavioural
  case in that file when the machine happens to be in Pacific.
- A **365-day cross-check** recomputes every day of 2026 by an independent
  route (pick the offset whose Pacific rendering really reads 00:00) and
  compares. This is what proves the DST algorithm, not just the happy path.

**Plus a genuine empirical run.** The real module source was copied to `.mjs`
and imported under six timezones with runtime mutation (the one mechanism that
does work), confirming the zone each run actually used rather than assuming it:

    America/New_York · Asia/Tokyo · Australia/Sydney
    Europe/London · UTC · Pacific/Kiritimati        → all four cases PASS in all six

`Pacific/Kiritimati` is UTC+14 — a full calendar day ahead of Pacific — and
`Australia/Sydney` has its DST in the opposite phase. Those are the two zones
most likely to expose a local-time dependency, and both pass.

**On a Mac or on Linux CI, `TZ=America/New_York CI=true npx react-scripts test`
would work as the spec intends.** The tests are written to pass under any
ambient zone, so that run would be meaningful there. It has not been verified,
because it cannot be from here.

#### Decision: the normaliser is Unicode-aware, the matcher is not

Spec §3 says "not a letter, digit, space, hyphen or underscore". Taken
literally that is `\p{L}\p{N}`, not `[a-z0-9]`, so **`normaliseTag("Café")`
gives `café`, not `caf`.** Two reasons to read it that way:

- Migration A only lowercases and swaps underscores, so it **preserves**
  accented characters. An ASCII-only normaliser would leave migrated tags that
  could never be reproduced by typing them — you would get a permanent
  duplicate every time.
- Silently deleting a character the user typed is the exact behaviour this
  project exists to remove.

`foldText` in `search.js` stays **ASCII-only**, because it inherited
`ingredientMatch`'s existing behaviour and widening it would change which
ingredients match which items — out of scope and not worth the risk. So `café`
folds to `caf` for *matching* while storing as `café`. Both files' headers say
this and point at each other. Flagging it because it is a deliberate asymmetry,
not an oversight — say the word if you would rather have ASCII-only storage.

**The Babel risk this created has been checked and cleared.** `\p{L}` needs a
transform for CRA's production browserslist. Compiling `tags.js` through
`babel-preset-react-app` with production targets shows Babel expanding it into
explicit character ranges, and running that compiled output gives byte-identical
results including `Café` → `café`. It is not currently in the bundle (nothing
imports it yet), so this only becomes live in Phase 4 — but it will work.

#### Other things worth knowing

- **`normaliseTag` is idempotent, and there is a test pinning it.** This is the
  property spec §4 leans on: normalise-on-write is only safe if a saved record
  reloads byte-identical, or the four `JSON.stringify` dirty-checks start
  reporting phantom edits. Same for `normaliseTags`.
- **Hyphens survive** into storage, per spec §3 — `whole-foods` and
  `whole foods` are different stored tags. The loose matcher folds them
  together, so the picker will show both rather than silently offering one.
- `supabase/schema-snapshot.sql` exists in the working tree but is **0 bytes**.
  Harmless and untracked, but it looks like an interrupted `supabase db dump`.
  Worth deleting so it is not mistaken for a real snapshot later. The DDL this
  project needs is inline in spec §6 and §7, so nothing is blocked.
- Spec §12 claims an index on `(collection_id, removed_at DESC)` already
  exists. **Not verifiable from the repo** — no DDL for that table is committed.
  Taking it on trust from your hand-pulled schema; it only matters at Phase 7.

#### Not done, deliberately

No component touched, no `TagInput` change, no `processTags` deletion, no
database access, no Edge Function change. The 2026-03-08 and 2026-11-01
transition dates in the spec were checked against `Intl` and are correct.

### Phase 1b findings (2026-09-14)

**The two detail views had NOT diverged.** `ItemDetailView` and
`IntentionDetailView` carried byte-for-byte equivalent header markup — same
wrapper, same `flex flex-col sm:flex-row sm:justify-between`, same title `h2`,
same context pill. The only differences were that the intention's button
container also had `shrink-0`, and the intention had a recurrence line after the
header. So no restructuring-one-to-match-the-other was needed; both got the same
change and both now read the same way.

**One new component, `DetailMeta`** (next to `TagFilter`, around
`Alfred.jsx:806`), holding the context line and the tag chips. Both views call
it identically, which is what stops them drifting apart again. It returns `null`
when there is neither a context nor a tag, so a bare record gets no empty row.

**Why the context looked like a tag.** The pill was
`bg-warning-light text-foreground px-2 py-0.5 rounded` and the tag chip is
`bg-warning-light text-accent-foreground text-xs rounded-full` — the same fill,
the same padding, differing only in corner radius and a text colour. It now
renders as plain muted text behind `ObjectIcon type="context"`, which is
`FolderOpen`, the same glyph the Contexts list puts beside a context row
(`Alfred.jsx:8394`) and the same one the nav uses. No new icon was introduced.

**Header layout.** Title is now its own full-width `h2`; actions sit in a
`flex flex-wrap gap-2 mt-3` row beneath it, left-aligned so they line up with
the title rather than floating right. They previously shared a row with the
title, holding a fixed width on the right, which is what squeezed a long name
into a narrow column. The action row strictly gains width at every breakpoint,
so narrow-screen wrapping is better than before, not merely different.

**Verified without a browser.** There is no headless browser in `node_modules`,
so no screenshot was possible. Instead: the file compiles through
`babel-preset-react-app`, the production build succeeds, and every Tailwind class
used was compiled against **this project's own config** to confirm it resolves —
`bg-warning-light`, `text-accent-foreground`, `text-muted-foreground`,
`text-primary`, `rounded-full`, `break-words` and `gap-1.5` all emit CSS. A
wrong semantic colour name would have rendered an unstyled chip and is the one
failure mode reasoning alone would not catch.

#### Deliberately left alone

- **The list-view cards still show the first three tags with "+N more."** That
  is correct for a summary row competing for space, and the task scoped this to
  the detail views.
- **Two context pills remain**, in `CollectionCard` (~`:8555`) and
  `IntentionCard` (~`:11804`). Same near-collision with the tag chip — on
  `IntentionCard` the context pill and the tag chips sit in the *same flex row*,
  which is the worst case of it anywhere in the app. Out of scope here; say the
  word and it is a small follow-up.
- Tag editing on the detail views. The tag picker replaces the existing inputs
  in Phase 4.

### Phase 2 findings (2026-09-14)

#### ⚠️ One thing is still outstanding and only Alex can do it

`/mnt/skills/user/alfred-enrich/SKILL.md` **cannot be reached from here.** It
lives in the Claude.ai skills environment; there is no `/mnt` on this machine
and no copy in the repo. `docs/history/findings-collections-ingredients.md:1002`
already recorded that a repo-wide search for `alfred-enrich` returns zero files.

The line to find says tags should be lowercase and underscore-separated.
Replace it with:

> Tags should be lowercase, with spaces between words, and no punctuation —
> e.g. `whole foods`, `stir fry`, NOT `Whole_Foods` or `stir-fry`. Tags are
> normalised on save, so anything else is silently rewritten.

Not urgent and **not a blocker for Migration A** — the normaliser now enforces
the rule regardless of what the skill says. Left unticked so it is not lost.

#### There were two `getContexts` selects, not one

The spec and the task both describe a single select. There are two, and both
carried `tags`:

- `_shared/alfred-tools/tool-handlers.ts:11` — the original, used by `ai-enrich`
- `mcp/index.ts:96` — the platform-layer rewrite, an inline copy

Deploying only one would have left the column being read. Both are fixed and
both now carry a comment pointing at the other.

#### The frontend never READ contexts.tags — but it would have WRITTEN it

The investigation flagged two direct selects around `Alfred.jsx:2136` / `:2142`
and did not confirm which tables they covered. They are **items** and
**intents**, not contexts, and they keep their tags. No frontend code reads a
context's tags anywhere: no render, no filter, no `TagFilter` call, and the
recycle-bin subtitle that uses `record.tags` is the `items` tab only.

**But there is a write path that would have broken after Migration A**, and it
is not a select, which is why a search for reads missed it:

`saveContextRecord` (~`Alfred.jsx:4189`) builds its payload as
`{ ...existing, name, shared, ... }`. `existing` comes from
`supabase.from("contexts").select("*")`, so it carries every column including
`tags` — and `storage.set` (~`:253`) upserts the WHOLE object with
`.update(dbValue)`. After the column is dropped, that write sends a `tags` key
to a table that no longer has one and PostgREST rejects it outright with
PGRST204.

The window is narrow — a tab that loaded contexts before the migration and
saves a context after it — but the failure would be "editing a context is
broken", which nobody would connect back to a dropped column. `tags` is now
destructured out before the spread, with a comment saying why.

The two remaining `select("*")` calls on contexts are fine and were left alone:
a `*` select simply returns fewer columns once one is dropped.

#### Four model write paths, not one

Spec §8 names `ai-enrich`. Spec §4 is broader and is the one that governs:
*"Normalise when the user commits a tag and when a tag is written by any non-UI
path."* There are four such paths, all of which put model-supplied tags into
`inbox.suggested_tags`, from where they flow verbatim into `items.tags` /
`intents.tags` on triage:

| Path | File | Fixed |
|---|---|---|
| enrichment write-back | `ai-enrich/index.ts` | ✅ |
| `createInboxItem` | `_shared/alfred-tools/tool-handlers.ts` | ✅ |
| `updateInboxItem` | `_shared/alfred-tools/tool-handlers.ts` | ✅ |
| MCP `create_inbox_item` | `mcp/index.ts` (inline insert) | ✅ |
| MCP `update_inbox_item` | `mcp/index.ts` | ✅ via `updateInboxItem` |

Fixing only `ai-enrich` would have left a model able to write `Whole Foods`
through the MCP tools, which is precisely the §4 failure.

#### The twin normalisers are verified identical

`src/utils/tags.js` and `supabase/functions/_shared/tags.ts` were diffed with
comments, type annotations and `export` keywords stripped: **byte-identical
logic**. Both carry a boxed header naming the other and stating that a change to
one is a bug until the same change lands in the other. Same rule, same Unicode
`\p{L}\p{N}` handling, same apostrophe stripping, same caps. Nothing was
"improved" in the port.

#### `ai-enrich` had to be deployed too

The task named only `supabase functions deploy mcp --no-verify-jwt`. But
`ai-enrich` bundles `_shared/alfred-tools/tool-handlers.ts` — the file holding
one of the two `getContexts` selects — so deploying only `mcp` would have left
the old select live and Migration A would still have broken it. Both were
deployed. The upload manifests confirm `_shared/tags.ts` went out with each.

`ai-enrich` was deployed WITHOUT `--no-verify-jwt`, deliberately: its
`config.toml` entry is `verify_jwt = true` and it is called from the
authenticated app. Post-deploy `functions list` confirms `mcp` `verify_jwt:
false` and `ai-enrich` `verify_jwt: true`.

A live probe of the deployed `mcp` endpoint returns `401` with
`WWW-Authenticate: Bearer resource_metadata=...` — the function's OWN OAuth
challenge, not the gateway's JWT rejection, which is the proof that
`--no-verify-jwt` took effect and requests are reaching the code.

#### Not done, deliberately

No SQL, no database access, no column dropped — Migration A is Phase 3 and Alex
runs it by hand. `[v22]` on the `get_items` description was left alone; that
tool's description did not change and bumping it would be misleading.

### Phase 2c findings (2026-09-14)

One-character change in two files: `/_/g` became `/[-_]/g`. The reasoning is
worth keeping, because the bug it fixes was invisible from the UI.

Hyphens surviving into storage meant `stir-fry` and `stir fry` were permanently
different tags. **The picker's loose matcher hid this from anyone typing** — it
folds both to `stirfry`, so a human would always be offered the existing one.
But the AI write paths never touch the picker. A model returning `stir-fry`
wrote a duplicate straight past the only thing that would have caught it. That
is why this had to land before Migration A rather than alongside the picker.

`foldText` and `matchesQuery` were not touched and did not need to be — the
loose matcher already ignored hyphens. That is precisely why it masked the
problem.

### Phase 3 findings (2026-09-14)

**Nothing was run. No database was contacted.** The SQL is written to
`docs/migrations/migration-a-tags.sql` for Alex to run by hand.

#### ⚠️ Two corrections to spec §6, beyond the approved hyphen change

Both are in the file, both are called out in its header comments, and neither
is a call I should make alone — review before running.

**1. §6 filtered blanks on the RAW value, not the converted one.**
It said `where btrim(v) <> ''`. A tag of `"_"` passes that test — `btrim('_')`
is `'_'`, not empty — then converts to a space and then to the empty string,
which gets stored as a real element of the `text[]`. Demonstrated:

| input | §6 as written | corrected |
|---|---|---|
| `"_"` | `""` stored | filtered out |
| `"__"` | `""` stored | filtered out |
| `"-"` | `"-"` stored | filtered out |
| `"---"` | `"---"` stored | filtered out |

An empty chip in the UI that matches nothing and cannot be searched for. The
old tag rule `/^[a-z0-9_-]+$/` permitted `"_"`, so this is reachable rather
than theoretical. Fixed by filtering after conversion, which also restores
equivalence with `normaliseTag` (which returns null for all four).

**2. §6 did not mention the `set_updated_at` trigger.**
It is a BEFORE UPDATE trigger on all six Alfred tables — confirmed by
`pg_trigger` query and recorded in
`docs/history/progress-ui-standardization.md:3988`, which also calls "Last
modified" sort *"trustworthy"* and says **"Do not remove the trigger."**

The conversion `UPDATE` fires it on every row it touches, stamping today onto
the `updated_at` of every tagged item and intention. Both cards display
"last updated: …" and it is a sort option. A migration should not make the
whole library look edited today, and it is not reversible.

Handled two ways in the file: the `UPDATE` now only touches rows that actually
have tags (untagged records are never stamped — they keep the `'{}'` column
default), and user triggers are disabled for the two statements and re-enabled
immediately inside the same transaction, so a rollback restores them. The four
lines are marked `TRIGGER GUARD` and can be deleted to accept the reset
instead. Verification query V8 confirms triggers came back enabled.

#### SQL/JavaScript equivalence is verified, not assumed

The SQL expression
`btrim(regexp_replace(translate(lower(v), '_-', '  '), '\s+', ' ', 'g'))`
was modelled in JS and run against the real `normaliseTag` over the live
taxonomy Alex confirmed — `nervous_system`, `stir_fry`, `evening_routine`,
`middle_eastern`, `to_read`, `outdoor_maintenance`, `another_tag`, `test_tag`
— plus `book`, `books`, `recipe`, `test`, `testing` and 14 edge cases.
**27 of 27 identical**, including all four blank-ish inputs resolving to
"rejected" on both sides.

`translate(lower(v), '_-', '  ')` is the exact counterpart of the JS
`.replace(/[-_]/g, " ")` — one call, both characters.

The SQL deliberately does NOT strip apostrophes, convert other punctuation, or
enforce the 50-character cap, all of which the JS rule does. Those are no-ops
on this data: the Phase 1 audit found zero tags violating `/^[a-z0-9_-]+$/`,
so nothing stored contains an apostrophe or other punctuation, and everything
is far under 50 characters. Verification query **V5** re-checks this against
the real data after the migration by round-tripping every stored tag through
the rule — zero rows means SQL and JavaScript agree on what is actually there.

#### One thing I could not verify

**The `platform_search_items` body is reproduced from spec §6, with `?|`
changed to `&&`. I have no database access and could not diff it against the
live definition.** If the live function differs in any other way — an extra
column in the select list, different parameter names or defaults — then
`create or replace` would silently overwrite that behaviour, or fail with
"cannot change name of input parameter".

The file opens with the `pg_get_functiondef` query to run first, and says the
only intended difference is the operator. What I *could* check from the repo:
the return shape matches what `mcp/index.ts` reads (`data.rows`, `data.total`)
and the row list correctly excludes `elements`.

### Phase 4 findings (2026-09-14)

**New:** `src/TagPicker.jsx` (+ `TagPicker.test.jsx`, 26 tests).
**Changed:** `src/Alfred.jsx` only. `TagInput` and `processTags` deleted —
81 lines gone. 37 suites / 877 tests green; bundle +4.59 kB.

#### ItemPicker was the right base, but as a sibling not a wrapper

Its *patterns* ported cleanly and are reused verbatim: the 200 ms blur grace,
the `TAG_PICKER_CAP` with an overflow note, the dropdown box and row styling,
the empty-pool-versus-no-match distinction.

Its *component* could not be reused. `ItemPicker` is item-shaped the whole way
down — it takes `items`, resolves `contexts`, hides archived rows, and hands
back a record through `onPick`. A tag is a bare string with none of that. Trying
to generalise it would have meant making half its props optional and adding a
render-prop for the row, which is a worse component than two clear ones. This is
what §9.2 meant by "taking ItemPicker's structure"; no restructuring of
`ItemPicker` itself was needed or done.

**One deliberate divergence:** the list opens on FOCUS, where `ItemPicker`'s
dropdown stays shut until you type. An item list is thousands of rows; a tag
pool is a dozen strings, and browsing it is the point — seeing that
"middle eastern" already exists is what stops a second spelling being invented.

#### The double-commit trap, and how it is closed

_Superseded in part — blur no longer commits at all (see "Phase 4 verification
fixes" at the end). The handlers stayed; only their justification changed._

This was the real hazard in the phase and it is not obvious from the spec.

Commit-on-blur plus a clickable suggestion list is a conflict: tapping a
suggestion blurs the input, blur commits whatever is typed, and *then* the click
adds the suggestion. One tap, two tags. Typing "brea" and tapping
"breadcrumbs" would have produced both `brea` and `breadcrumbs`.

Closed with `onMouseDown={(e) => e.preventDefault()}` on every surface inside
the control — suggestion rows, the create row, and each chip's ×. Preventing
the default on mousedown stops focus moving at all, so no blur fires and the
click still lands. Blur then means only what it should: focus genuinely left
the control, e.g. Save was tapped.

A pleasant side effect: removing a chip mid-typing no longer commits the
half-typed text. Two tests assert `fireEvent.mouseDown(...) === false`, which is
how Testing Library reports that `preventDefault` was called — so if anyone
removes those handlers later, the suite says so rather than the bug reappearing
silently in the app.

#### Behaviour change: one tag per commit, not comma-separated

`TagInput` split on commas. That existed only because spaces were illegal and a
comma was the sole way to type two tags. Now that spaces are legal, a comma is
just punctuation inside a name, so `"a, b"` commits as the single tag `a b`
rather than two tags `a` and `b` — spec §9.2, "selection is single per commit".
The placeholder changed from "Add tags (comma separated)" to
"Search or add a tag…" so the old habit is not invited.

#### Where the create row hides, precisely

Visible by default, beneath the matches. Hidden in exactly three cases:

1. the typed text normalises to `null` (punctuation only, or over 50 chars);
2. it normalises to a tag already offered in the visible list — picking the
   suggestion is the same act;
3. it normalises to a tag already applied as a chip.

Case 3 is not in the spec but follows from it: without it, typing `TJ's` on a
record already tagged `tjs` would offer `Create "tjs"`, and committing it would
be a silent no-op. Offering a button that does nothing is worse than hiding it.

**One edge case worth knowing:** typing only punctuation (`!!!`) leaves the
suggestion list fully populated rather than emptying it. `matchesLoosely` folds
a punctuation-only query to empty, and an empty query matches everything by its
documented contract. The box reads as unfiltered, which is effectively what it
is. No false affordance either way — there is nothing to create, and pressing
Enter says why. `matchesLoosely` was not changed to "fix" this; it is correct,
and changing it would alter the contract Phase 1 pinned.

#### Normalise on commit, never on load — and it is now tested

`value` renders as chips exactly as stored. Two tests pin this: a legacy
`Legacy_Tag` renders untouched, and `onChange` is never called by mounting,
focusing or typing. Only an actual commit or removal calls it. That is the
property spec §4 depends on, and it now fails loudly rather than silently.

The four dirty-check comparisons were not touched — confirmed by diff.

#### Threading the pool

`tagPoolFrom(...recordLists)` sits beside `TagFilter` and derives the pool the
same way `TagFilter` derives its pills: count tag occurrences client-side over
rows already in state, most-used first, ties alphabetical. No query added.

Memoised once in `Alfred` as `tagPool` and threaded to **14 render sites** —
the five cards in Alfred's own render, the three detail views, and the six
cards nested inside those views. `ContextDetailView`, `IntentionDetailView` and
`ItemDetailView` each gained a `tagPool = []` prop purely to pass it through.
Verbose, but it matches the codebase's explicit-props style; `.claude.md` rules
out Context, and deriving the pool locally was not possible because no single
card receives both the item list and the intent list.

The `= []` defaults mean a missed site degrades to "no suggestions, create still
works" rather than a crash.

#### Not done, deliberately

No collection tag pool and no collection code touched — that is Phase 6. No tag
editing added to the detail views; Phase 1b made those display-only. No SQL.
`foldText` and `matchesQuery` unchanged.

### Phase 4 verification fixes (2026-09-14)

Two behaviour changes from Alex's phone verification. Neither was a defect in
what was built — both were decisions that turned out wrong in the hand.
`TagPicker.jsx` only; 33 tests now (was 26), 37 suites / 884 tests green,
bundle +8 B.

#### 1. Blur no longer commits — reversing spec §9.2

Typing `wo` and tapping outside created a tag called `wo`. A tag is now created
only by an explicit act: tapping Create, tapping a suggestion, or pressing
Enter. Blur hides the list and does nothing else, and the typed text **stays in
the box** rather than being cleared, so nothing uncommitted disappears from
view.

**Why the original reasoning expired.** §9.2 called the blur commit
load-bearing, and it was — while typing was the ONLY way to add a tag. Losing
half-typed text on blur was then worse than the occasional accidental tag. The
always-visible Create row removes that premise, and once it existed the failure
ran the other way: every stray tap on the page could invent a tag.

**Accepted cost, not mitigated:** type a complete tag, tap Save without
committing it, and the tag is not saved. Creating a tag should be deliberate.

Spec §9.2 has the old bullet struck through with this reasoning inline, so the
behaviour cannot be "restored" by someone reading the spec later. Two tests pin
it, one of them named after the reported `wo` case.

**One change beyond the brief, same principle.** A *refused* commit used to
clear the box too — press Enter on `!!!`, get an error, lose the text. It now
keeps the text so it can be fixed. Same complaint as commit-on-blur, one step
later. Three tests assert the text survives (invalid, over-length, at the cap).

#### 2. The list closes after a tag lands

The dropdown stayed open over the chip row, so there was no way to see the tag
had been added. Any successful add now closes the list and drops focus, which
also dismisses the phone keyboard.

Refused commits deliberately leave the list open — nothing landed, so there is
nothing to step back and look at.

**Accepted cost:** adding several tags in a row costs one extra tap each.

`dismiss()` blurs through `rootRef.current?.querySelector("input")` rather than
a ref on the input. `SearchInput` does not forward one, and teaching it to would
touch a component `ItemPicker` and `ListToolbar` also render — not worth it for
one caller. Contained to `TagPicker`.

Six tests cover it: closes after each of the three commit paths, drops focus,
stays open when refused, reopens on focus.

#### What did NOT change

The `onMouseDown` focus guards stayed, and their tests still pass unchanged.
Their original justification is gone — there is no double commit to prevent
any more — but they are still needed for two other reasons, now written into
the file: on a phone, releasing focus mid-tap dismisses the keyboard and
reflows the page under the finger; and removing a chip would otherwise close
the dropdown as a side effect of the ×. They are also what makes `dismiss()`
need an explicit blur.

`foldText`, `matchesQuery`, the normalisation rule and the four dirty-check
comparisons were all untouched.

### Phase 4 display fix — "already added" (2026-09-14)

Found on the phone after the two behaviour fixes. `TagPicker.jsx` only;
39 tests now (was 33), 37 suites / 890 tests green, bundle +34 B.

**The problem.** Add the tag `buggy`, then type `buggy` again. The Create row
correctly hid — there is nothing to create — but the list then fell through to
the generic **"No matching tags"**, which reads as *"that tag does not exist"*
when in fact it is already on the record. The one state where the answer is
"you already have it" was being reported as the state where the answer is
"there is no such thing".

The cause: `applied` tags are filtered out of the suggestion list (correctly —
offering a tag you already have is noise), so `shown` was empty, and the empty
state had no way to tell "filtered out because applied" from "nothing matched".

**The fix.** A third derived state, `alreadyApplied`, true when the typed text
normalises to a tag already in `value`. It renders in the slot the Create row
would have taken — same question, "can I add this?", so the same place — and
suppresses the generic empty state rather than sitting alongside it:

    "buggy" is already added

Quoting the **normalised** form, matching how the Create row displays it, so
typing `Buggy` or `bug-gy` names the chip you actually have rather than the
text you typed. Rendered as a `<p>` with the same `NOTE` styling as the other
empty states — not a button, because there is nothing to do and something
tappable there would imply otherwise.

`alreadyApplied` and `showCreate` are mutually exclusive by construction: the
latter already required `!applied.has(candidate)`.

**It sits beneath matches rather than replacing them.** With `buggy` applied and
`buggy code` in the pool, typing `buggy` shows `buggy code` as a suggestion
*and* the already-added line underneath — which is also what explains the
missing Create row.

**Every other empty state is untouched**, and two tests guard that: a genuine
no-match still offers Create, an empty pool still reads "No other tags yet",
and text that normalises to nothing still behaves as before.

### Phase 5 findings (2026-09-14)

**Nothing was run. No database was contacted.** SQL is in
`docs/migrations/migration-b-collection-tags.sql`.

**Spec §7 needed no corrections.** Unlike §6, which had two independent bugs,
the two statements here are right as written. The table names match the
`MEMBERS_TABLE` / `REMOVALS_TABLE` constants in `collectionMembers.js`, neither
table already has a `tags` column, and `text[] not null default '{}'::text[]`
is the correct shape. Two cosmetic additions, neither a correction: statements
are schema-qualified with `public.`, and a `lock_timeout` was added (below).

#### 1. Triggers — no guard needed, for two independent reasons

Migration A needed `disable trigger user` because its UPDATE rewrote every
tagged row and `set_updated_at` would have stamped today onto all of them.

**`ALTER TABLE` is DDL and fires no row-level triggers at all** — not BEFORE
UPDATE, not AFTER INSERT/UPDATE/DELETE. Existing rows are never passed through
a trigger, so neither `set_updated_at` nor the generic `audit_row` trigger that
`platform.register_table(p_audited => true)` attaches can fire. This holds
whether or not these tables are registered as audited, which is why their audit
status did not need looking up — and just as well, since it is not recorded
anywhere in the repo.

**And neither table has an `updated_at` column.** Worth stating because it is
an easy misread: `docs/history/progress-ui-standardization.md:3988` says
`set_updated_at` is on "all six Alfred tables" and names `item_collections` —
which is the collection ITSELF, not `collection_items`, the membership join
table. Their columns are `id, collection_id, item_id, quantity, position,
added_at, added_by` and `id, collection_id, item_id, item_name, quantity,
position, reason, removed_at, removed_by`. No `updated_at` on either, so the
trigger cannot be attached to them in the first place.

Verification query V4 still checks every trigger is enabled afterwards — not
because this migration could disable one, but because a half-finished
Migration A could have left one that way.

#### 2. Locking — metadata-only, but it is still an exclusive lock

**No table rewrite.** Since PostgreSQL 11, `ADD COLUMN ... NOT NULL DEFAULT
<constant>` records the default once in `pg_attribute` and materialises it on
read for existing rows. Supabase is well past 11. `'{}'::text[]` is a constant
literal cast — immutable, not volatile — which is exactly the condition for
that fast path. A volatile default such as `now()` would force a full rewrite;
this one does not.

**It does still take an ACCESS EXCLUSIVE lock** on each table, blocking all
reads and writes while held. Held for milliseconds, because the work is a
catalogue update whose cost does not scale with row count.

**Time at this data size: milliseconds, and size is close to irrelevant.** The
recorded backfill put five membership rows across four collections; removals
accumulate but this is a shopping list, so hundreds at the outside. Live counts
are not visible from here, but the operation is O(1) in rows.

**The real risk is lock queueing, and it is not about size.** If a long-running
statement already holds a lock on either table, the ALTER waits behind it and
every new query queues behind the ALTER. Two mitigations, both in the file:
`set local lock_timeout = '3s'` so it gives up rather than stalling the app,
and a note not to run it with the collection detail view open — that view polls
every five seconds.

#### 3. No index — confirmed against what Phase 6 will actually query

Spec §7's claim holds. Checked both directions:

* The collection list's tag filter runs **client-side**, over members already
  in React state, reusing `TagFilter` — no query involved.
* `loadCollectionTagPool` (spec §9.4) selects the `tags` column filtered by
  `collection_id` and ordered by `removed_at`. It never filters BY tag, so a
  GIN index on `tags` could not be used by it.

No statement anywhere puts `tags` in a WHERE clause, so an index would be pure
write-amplification on a table written during shopping. The file records the
`create index` to reach for if that ever changes.

#### Reversibility

Recorded at the top of the file, as asked. Nothing is destroyed: drop the two
columns and you are back. Safe right up until Phase 6 ships, because until then
nothing reads them — no frontend code, no Edge Function, no RPC. After Phase 6
a rollback would discard applied tags, which are real but ephemeral by design.
No backup required for this one.

### Phase 6 findings (2026-09-14)

**Changed:** `src/utils/collectionMembers.js` and `src/Alfred.jsx`.
**New:** `src/utils/collectionMembers.tags.test.js` (19 tests); four more added
to `collectionMembers.test.js`. 38 suites / 913 tests green, bundle +871 B.

#### The design question, answered before building — chips go on a second line

The brief asked whether the chip-and-picker pattern works one-handed in a
supermarket. Short answer: the picker does, the chips could not go where the
spec implies.

The member row is a single flex line — `[grip] [name] [qty] [×]` — and at 360px
it is already full. Adding a tag control **and** legible chip text to that line
would have left roughly 130px for the item name, which is where the information
actually is while shopping.

The deciding constraint is the brief's own: *"the tag should be legible at a
glance"*. That rules out a count badge or a bare icon — knowing an item has one
tag is useless; you need to read **which store**. So the store name must render
as text in the list, and text needs width the row does not have.

**So chips render on a second line under the item name, and only when a row has
tags.** An untagged list is exactly as compact as it was before this phase; a
tagged row grows by about 20px, not a full 44px row. Since shopping means
filtering to one store, most visible rows carry a tag — but the list is short by
then, which is the point of the filter.

The control is a 44px `Tag` icon button between quantity and ×, which toggles a
`TagPicker` open **beneath that row**, one at a time. Two pickers open at once
would push the list off a phone screen.

Cost, accepted: the name column loses ~44px to the new button. Names truncate;
they already did.

#### Data layer

All five spec §10 edits, plus `loadCollectionTagPool`. Two things deliberately
NOT done, both load-bearing:

* **`updateMemberQuantity` was not widened.** `addOrMergeMembers` calls it in a
  loop, so a `tags` key in that payload would wipe a row's store every time a
  recipe was added. It now carries a warning comment saying so, pointing at
  `updateMemberTags` immediately below it.
* **No tag handling in `addOrMergeMembers`.** The merge policy is "leave
  existing tags alone", which means implementing nothing. A test covers it: a
  row tagged `tjs` that a recipe re-adds keeps `tjs` and merges only quantity.

`normaliseTagsArray` guarantees shape only — array of non-empty strings,
deduplicated. It deliberately does **not** re-run `normaliseTag`: tags arrive
here already canonical from the picker, and folding again would be a second copy
of the rule that could drift from the first.

#### The leak guard, tested four ways

`collapseEntries` rebuilds every entry as `{itemId, quantity}`. Since
`addMembers` now accepts `entry.tags`, that discard is the **only** thing
stopping an item's own `vegetarian` / `recipe` tags landing on its shopping row.
It is one line and widening it would look like a helpful generalisation.

Four tests in `collectionMembers.test.js` under "item tags must not leak into
collection rows": a single tagged entry, a multi-item recipe add, the merge path
where the row already exists, and the same item appearing twice in one call.

#### Two tests needed a second mock file

The existing `collectionMembers.test.js` mock is built tightly around
`addOrMergeMembers` and models only `collection_items`. The round-trip and pool
tests need `collection_item_removals` too. Widening the old mock would have put
its 19 existing assertions at risk for no gain, so the new tests live in
`collectionMembers.tags.test.js` with their own smaller mock. The leak
regression stayed in the original file, because it runs through
`addOrMergeMembers` and needs that mock.

#### UI wiring

* **`collectionFilterTag` is its own state**, reset on view change alongside
  `filterTag`. Sharing would have left a `tjs` filter set when opening a
  context, where no such tag exists and the list would silently come back empty.
* **Drag-to-reorder is hidden while a filter is active.** The visible rows are a
  subset, so a drop position would write an ordering that means nothing once the
  filter clears. The grip disappears rather than misbehaving.
* **The poll pauses while a tag editor is open**, exactly as it already did for
  an open quantity field. A five-second tick would otherwise replace `members`
  under the picker and discard chips added since the last write.
* **New tags join the pool optimistically**, so tagging three items for the same
  store costs one "Create" and two taps rather than three Creates.
* `loadCollectionTagPool` failing is non-fatal — it logs and leaves the pool
  empty. A picker with no suggestions still lets you create a tag; a blocked
  control mid-shop would be worse. One arm failing still yields the other.

#### The pools never mix

Two functions, two tables, two call sites. `tagPoolFrom(items, intents)` feeds
the four item/intention pickers; `loadCollectionTagPool(collectionId)` feeds the
member rows. Neither reads the other's source. `"tjs"` cannot appear on a recipe
and `"vegetarian"` cannot appear on a shopping row.

#### Not done, deliberately

Phase 7 untouched — "Recently removed" is still the last five, and
`MAX_REMOVALS`, the `limit: 25` fetch and the `.slice(0, 5)` are all as they
were. No SQL. `TagPicker`, normalisation, matching and the four dirty-check
comparisons all unchanged.

### Phase 6 interaction fixes (2026-09-14)

Two fixes from Alex's phone verification. `TagPicker.jsx` and the collection
detail view only; 10 more tests (49 on TagPicker, was 43), 38 suites / 923
tests green, bundle +90 B.

#### 1. The editor focuses its input on open

Tapping the Tag button opened the picker but left the cursor nowhere, so typing
needed a second tap. `TagPicker` gained an `autoFocus` prop, passed only by the
collection tag editor. The four item/intention pickers deliberately do **not**
pass it — they sit inside a form you may be scrolling past, and raising the
keyboard on render would be wrong there.

**Focused two ways on purpose.** The `autoFocus` attribute goes to the input,
AND an effect calls `.focus()` on mount. iOS does not reliably honour the
attribute — the same reason `ItemPicker`'s inline variant does not depend on it
— and the effect runs inside the commit the tap triggered, which is what lets
the keyboard come up. Focusing an already-focused input is a no-op, so doing
both costs nothing.

Focusing fires `onFocus`, which opens the suggestion list. Intended, and the
reason for the report below.

#### ⚠️ The keyboard question — reported, not fixed

Asked for, and it is a real risk rather than a theoretical one.

The dropdown is `absolute … max-h-60`, so it hangs **below** the input by up to
240px, on top of a ~36px input. When the input focuses, the browser scrolls it
into view above the keyboard — but browsers scroll the *focused element*, not
its overflowing sibling. On a 390×844 phone the keyboard takes roughly 300px,
leaving ~500px, and iOS scrolls minimally: the input often lands near the
bottom of that band with the dropdown below the fold.

**Worst case is the case that matters.** The create row is at the BOTTOM of the
list, so it is the first thing clipped — and it is what you want when inventing
a new store name.

**Mitigating in practice:** a collection's tag pool is two to five store names,
so the dropdown is usually 100–180px rather than the full 240. It may well be
fine in use, which is why it is being left for Alex to judge. The page can also
be scrolled after the keyboard is up.

Three options if it does turn out wrong, none applied:

1. `scrollIntoView({ block: "start" })` on the row when the editor opens, so
   the dropdown gets the whole remaining band. Simplest, probably sufficient.
2. Flip the dropdown above the input when there is no room below. Most correct,
   most code, and needs measurement.
3. Shorten `max-h-60` for the collection editor only. Cheapest, and makes the
   list scroll sooner — which pushes the create row further out of reach, so
   probably the worst of the three despite being the easiest.

#### 2. One close path, used by all four routes

Tapping a different row's Tag button already closed the open one — it set
`editingTagsItemId` to the new id, which unmounts the old picker. But it did it
by *overwriting the id*, a different route from Done and the row's own button,
which both set null. Three ways to close, one of which skipped the other two's
code entirely.

Now `closeTagEditor()` is the single close, and `openTagEditor()` calls it
before setting the new id. Done, the open row's own button, switching rows and
leaving the view all route through it. The cleanup is still one state write —
the point is that when it stops being one, it stops being one everywhere at
once, rather than the switch path quietly keeping the old behaviour.

The view-change reset also calls it now. Function declarations hoist, so an
effect declared above it can call it fine.

**Uncommitted text is discarded on a switch.** The picker unmounts with its
row, taking its `query` state with it — Phase 4's rule holding: a tag is
created only by an explicit act, and switching rows is not one. Two tests pin
it: the new row's box is empty, and `onChange` is never called.

**The poll stays correct across a switch.** `pollPausedRef` reads
`editingTagsItemId !== null`, and React batches the two writes inside the click
handler, so there is no intermediate render where it is null and the poll could
resume mid-switch. Closing fully still resumes it. The poll-pause expression
itself was not touched.

#### Not changed

`TagPicker`'s commit behaviour — a test asserts blur still does not commit with
`autoFocus` on. Normalisation, matching, the four dirty-check comparisons, and
Phase 7's three removal caps all untouched.

### Phase 6 editor simplification (2026-09-14)

`TagPicker.jsx` and the collection detail view only. 11 more tests (60 on
TagPicker, was 49), 38 suites / 934 tests green.

Four changes that are really one: **the row's chips become the tag UI, and the
editor becomes only the way to add.** Each made the next possible.

#### What was wrong

The editor carried its own copy of the row's chips, each with an ×, plus a Done
button. The chips under the item name were read-only. So removing a tag meant
opening an editor to reach a second copy of the thing you were already looking
at — and tapping away left the input and Done stranded on screen, because only
the dropdown closed.

#### 1. Removable chips in the row — the one the rest depend on

Each chip now carries its own ×. Removing a tag is one tap on the chip in front
of you, with no editor involved. Once that exists, the editor's chip list is a
duplicate and Done has nothing left to do.

**Tap target: a 32px × inside a ~30px chip, not the usual 44px.** 44 would make
a chip taller than the item name it sits under and crowd the row it is meant to
annotate — the chips are an annotation on a list you are scanning, not a
primary control. 32px is a comfortable deliberate tap.

Accidental activation while scrolling is less of a risk than it looks: a
browser cancels the click once the finger moves, so a scroll never fires one.
The mis-tap that *could* happen is two ×s sitting shoulder to shoulder, so the
chip row went from `gap-1` to `gap-1.5` to keep them apart.

#### 2. The editor is now input and dropdown only

`TagPicker` gained `showChips`, default true. The four item/intention pickers
are untouched — they sit inside forms where the chips have nowhere else to
live. The collection editor passes `showChips={false}`.

`value` is still passed and still does everything else: deduplication, hiding
applied tags from the suggestions, and the "already added" line. Only the
display is suppressed. A test pins that.

The row's chips sit directly above and stay visible while the editor is open,
so a tag landing is still confirmed on screen — which is what the Phase 4 fix
was for, and it survives.

#### 3. Tapping outside closes the whole editor

Done is gone. A `mousedown` listener on the document closes the editor when a
tap lands outside the row.

**`mousedown` and NOT `touchstart`.** A tap fires both; a scroll fires only
`touchstart`. Listening to `touchstart` would have closed the editor the moment
a finger landed to scroll the list, which is not a dismissal.

**"Outside" means outside the whole row, not just the editor.** That is what
makes the row's own Tag button keep working: the tap lands inside, the listener
ignores it, and `toggleTagEditor` closes the editor by itself rather than the
two racing to do it. Same for the row's chips — removing a tag mid-edit should
not throw you out of the editor. Both are tested.

The listener is attached only while an editor is open, and removed when it
closes.

#### 4. Adding a tag still does not close the editor

The thing most at risk from the other three, and it holds. `TagPicker.dismiss()`
closes its dropdown and drops focus so the new chip is visible; the editor
container is owned by the row and stays mounted. Two tests: one tag added
leaves the input present, and two tags go in without reopening anything.

Closing happens only on an explicit dismissal — outside tap, or the Tag button
again.

#### Everything closes through one path

The outside tap calls `closeTagEditor()`, the same function Done used to call
and the same one the Tag button and a view change call. So the poll resumes
correctly on the new path without the poll-pause expression changing at all,
and uncommitted text is discarded rather than committed — Phase 4's rule, that
a tag is created only by an explicit act, and tapping away is not one.

#### Not changed

Normalisation, matching, `TagPicker`'s commit behaviour, the four dirty-check
comparisons, the poll-pause expression, and Phase 7's three removal caps.

### Phase 6 — the row-switching bug (2026-09-14)

With row A's tag editor open, tapping the tag button on a row **below** A closed
A and opened nothing. Tapping a row **above** A worked. `Alfred.jsx` and the
test file only; 7 more tests, 38 suites / 941 tests green.

#### It was layout, and that was confirmed before anything changed

A stale-state bug looks identical from the outside, so the state machine was
ruled out first — two ways.

**By inspection.** `toggleTagEditor("B")` compares `editingTagsItemId === "B"`.
At the moment B's click would run, that value is either `null` (the mousedown
dismissal already committed) or `"A"` (it has not). Both are `!== "B"`, so both
take the `openTagEditor("B")` branch. **There is no reachable state in which
tapping B's button fails to open B.**

**By experiment.** A throwaway probe reproduced the exact structure and the
exact event sequence in jsdom — mousedown on B (dismissal closes A), then click
on B — and B opened correctly. jsdom has no layout engine, so the one thing it
cannot reproduce is the reflow. It behaving correctly there is the evidence
that the fault is not in the logic.

**The cause.** An open editor makes its row taller, so every row below sits
lower. Closing A on mousedown moved those rows back UP between the press and
the release, so the button under the finger on press was elsewhere on release
and the click never completed on it. Rows above an open editor never move,
which is exactly why tapping upward worked. The directional asymmetry was the
whole clue.

#### The fix: switch on the press

Two parts, both needed.

**The tag button acts on `onMouseDown` rather than `onClick.`** The whole switch
— close A, open B — completes on the press, so no click has to land anywhere
and the reflow becomes irrelevant rather than merely less likely.
`preventDefault` keeps focus off the button, which also stops the phone
keyboard flickering between editors.

`onClick` survives for keyboard only, guarded on `e.detail === 0`. Enter and
Space produce a click with detail 0 and no mousedown; a pointer click carries 1
or more and was already handled on the press. The guard doubles as protection
against a stray click that a reflow lands on the wrong button.

**The dismissal listener now exempts any row's tag button**, matched on a
`data-tag-toggle` attribute. Without it the two race and the symptom is
identical: React's handlers run at the root container and the dismissal runs at
the document, so the button would open B and the dismissal, seeing the press
land outside A, would immediately close it.

Neither the outside-tap dismissal nor the editor's height was touched — both
were ruled out as fixes because both would undo verified behaviour.

#### What the tests prove, and what they do not

jsdom cannot reproduce a reflow, so **no test here can fail for the original
reason**. What they pin instead is the property that makes the reflow harmless.

The central one fires **mousedown and no click at all** — which is precisely
the situation the device produced, since the click was the thing being lost.
Move the handler back to `onClick` and it fails.

Verified by reverting the harness to the pre-fix shape: that test failed, and so
did the one covering the dismissal exemption. Notably the "full tap" test still
**passed** on the broken shape, because in jsdom the click always lands — which
is the clearest statement of what jsdom can and cannot catch, and why the
press-only test is the one that matters.

**None of this proves the fix works on a phone. Only the phone proves that.**

#### Still true afterwards

Adding a tag does not close the editor; scrolling does not close it; tapping
inside the row does not close it; tapping the same row's button closes it;
tapping outside closes everything. All still routed through `closeTagEditor()`,
so the poll resumes and uncommitted text is discarded. The poll-pause
expression, normalisation, matching, `TagPicker`'s commit behaviour and the
four dirty-check comparisons are all unchanged.

#### A narrower residual, not fixed

The same reflow affects any control on a row below an open editor, not just the
tag button — the remove-× would mis-land the same way. It is much less likely
to be hit (the row visibly moves first), and fixing it generally would mean
either exempting every button from the dismissal or making the editor not
change row height, both of which undo verified behaviour. Left alone
deliberately. Note that the quantity field is NOT affected: focus happens as
the press is dispatched, before the re-render.

### Phase 7 findings (2026-09-14)

`collectionMembers.js` and `Alfred.jsx`; one new test file. 17 tests, 39 suites
/ 958 tests green, bundle +339 B.

#### Duplication check first — no third helper exists

Asked for before writing anything, because recent SAM work touched "today's
activity". Searched `src/sam/lib/`, `src/utils/` and the rest for day-boundary
or today-comparison helpers.

| File | Returns | TZ-aware | Tested | Verdict |
|---|---|---|---|---|
| `sam/lib/practiceTimeFormat.js` | date **keys** (`"YYYY-MM-DD"`) | yes, PT | yes | pre-existing |
| `utils/localDay.js` | an **instant** (`Date`) | yes, PT | yes, 12 tests | pre-existing |
| `sam/lib/usePracticeStats.js` | — | — | — | **consumer, not a helper** |
| `sam/components/PracticeWeekSnapshot.jsx` | — | — | — | display only |
| `RepeatBlockDialog.jsx` | — | — | — | comment match only |

The SAM work added **no new boundary helper**. `usePracticeStats` imports
`ptDateKey` / `dateKeyMinusDays` from `practiceTimeFormat.js` and buckets by
date-key strings — it delegates rather than rolling its own, which is what that
module's header rule requires. `PracticeWeekSnapshot` compares strings it is
handed.

So it remains the deliberate two-way split in spec §5.3 — keys for SAM,
instants for Alfred — and `localDay.js` was used as planned.

#### All three caps, and why the first one was not simply deleted

- **`limit: 25`** on the panel fetch — gone.
- **`.slice(0, 5)`** on the render — gone.
- **`MAX_REMOVALS = 200`** — *bypassed* rather than deleted. The panel passes
  `limit: null`, which skips the `.limit()` call entirely. The constant stays
  and still clamps the history view, which asks for 50 and should keep a
  ceiling. Deleting it would have removed a bound that is doing real work
  somewhere else.

`limit: null` and an omitted limit are deliberately different: `null` means "no
ceiling, I meant it", `undefined` means "I did not think about it" and still
gets `DEFAULT_REMOVALS`. That is what leaves the history view untouched, and a
test pins both.

Moving only one or two of the three would have looked like it worked: a heavy
shopping day exceeds 25 long before it exceeds 200, so the panel would have
gone on hiding the older half of the same day.

#### The day boundary, stated accurately

`removed_at` is a server timestamp and the boundary comes from an IANA rule, so
the device's **timezone** is consulted for nothing — a phone in Tokyo and a
phone at home show the same list at the same moment.

The device **clock** is not entirely out of it, and an earlier draft of the code
comment overclaimed that it was. `startOfPacificDay()` reads `new Date()` to
decide which Pacific day is current, which is unavoidable for a window meaning
"today". A clock wrong by minutes or hours lands on the same day and changes
nothing; only one wrong enough to cross a Pacific day boundary picks a different
day. The comment now says this, and it is also what makes the change testable
without waiting a day — see verification.

#### What the tests assert

The mock records the **query chain** rather than simulating PostgREST, because
what is under test is the query: which bounds get applied and, more to the
point, which do not. A count ceiling silently reappearing under a time window is
invisible in returned rows.

So the tests assert that `.limit()` is never called for the panel's
combination, that `.gte("removed_at", …)` carries a Pacific midnight — checked
by rendering the ISO back through `Intl` and asserting it reads `00:00` in
Los Angeles — and that everything that had to survive did: the `manual` reason
filter, the collection scope, the unknown-reason rejection, error reporting, and
camelCased rows **with tags**, which Put back reads to restore them.

#### One cosmetic inconsistency, not fixed

`friendlyDate` labels each row using the **browser's** timezone while the
selection is now Pacific. On a device far enough ahead, a row correctly inside
today's Pacific window can be labelled "Yesterday at …". It needs roughly an
eight-hour-plus offset and a late-in-the-Pacific-day viewing to show up.

Left alone deliberately: `friendlyDate` is shared with the inbox and the full
history view, and pinning it to Pacific would change timestamps on screens this
project has no business touching. The rows shown are correct either way; only
the label can disagree.

#### Not changed

Normalisation, matching, `TagPicker`, everything from Phase 6, and the four
dirty-check comparisons. No SQL — both migrations were already applied.

### Phase 7 — removals show what they carried (2026-09-14)

Tags and quantity now render on every removal, in both the panel and the
history view. `Alfred.jsx` plus one new component; 18 tests, 40 suites / 976
tests green, bundle +27 B.

#### The two views are two CALLS, not two queries

Checked before building anything, because the brief reasonably assumed the
history view had its own query. It does not: `loadCollectionRemovals` and
`loadCollectionHistory` both call `loadRemovals`, which selects `"*"`. Both
were already carrying `tags` and `quantity` — snapshotted at removal time since
Phase 6 and Phase 3 respectively.

**So no query changed.** A test pins the `select("*")` and asserts both call
shapes — the panel's `since` + `limit: null`, and the history view's
`limit: 50` — return both fields, because "the history view has its own query"
is an easy and wrong thing to act on later.

#### One component, three places

A removal renders in three places: the panel, a single entry in the history
view, and a row inside a grouped bulk entry. `RemovalMeta` is the one component
behind all three, extracted to `src/RemovalMeta.jsx` rather than left inline —
the same call made for `TagPicker`, and it is what makes the three testable at
all without standing up the whole of `Alfred.jsx`.

Quantity renders verbatim, as the member row shows it. `"6 + 3"` is a real
value `addOrMergeMembers` produces, and nothing here parses or reformats it.

Chips use the app's standard read-only tag styling — the same fill and shape as
an item card, an intention card, and a collection member row's chips minus the
× only a removable one needs.

**Read-only, and a test asserts there are no buttons at all.** A removal is a
record of something that happened; editing it would be editing history. Tags
are edited on the member row, which is where the item is.

Nothing renders when a removal has neither — no empty row, no stray gap. Rows
recorded before Migration B have no `tags` at all, and are handled without
throwing.

#### Not changed

The since-midnight window, the still-a-member filter, the panel's manual-only
filter, and the history view's own behaviour — no reason filter, its own limit.
Normalisation, matching, `TagPicker`, and the four dirty-check comparisons.

---

## Project complete

Every phase is done and verified on the phone. Tags may contain spaces, tag
entry is an autocomplete picker everywhere, collection items carry per-trip
tags that survive remove-and-restore, and "recently removed" shows everything
since Pacific midnight.

40 suites / 976 tests green.

### Deliberately left open

Two known issues, both judged not worth the change they would require. Recorded
so they are found on purpose rather than rediscovered as bugs.

**1. `friendlyDate` labels rows in the browser's timezone, not Pacific.**
The removals panel SELECTS by Pacific midnight, so which rows appear is correct
on any device. The label beside each row is device-local, so on a device roughly
eight or more hours ahead, a row correctly inside today's Pacific window can
read "Yesterday at …". Left alone because `friendlyDate` is shared with the
inbox and the full history view, and pinning it to Pacific would change
timestamps on screens this project has no business touching. The list is right
either way; only the label can disagree.

**2. The reflow affects the remove-× on rows below an open tag editor.**
An open editor makes its row taller. Closing it moves every row below back up,
so a control pressed on one of those rows can be somewhere else on release and
its click never lands. This was fixed for the tag button by doing the whole
switch on the press. The remove-× on a row below an open editor has the same
exposure. Much less likely to be hit — the row visibly moves first — and fixing
it generally would mean either exempting every button from the outside-tap
dismissal or making the editor not change row height, both of which undo
behaviour that is verified and wanted. The quantity field is NOT affected:
focus happens as the press is dispatched, before the re-render.

### Also still outstanding, from Phase 2

`/mnt/skills/user/alfred-enrich/SKILL.md` still tells the model to write tags
underscore-separated. It lives in the Claude.ai skills environment, not this
repo, so Alex has to edit it there. Not a correctness problem — the normaliser
enforces the rule regardless of what the skill says — just a stale instruction
that will make the model's suggestions get rewritten on save.
