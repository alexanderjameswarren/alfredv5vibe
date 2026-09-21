# Progress: Tag UX and Inbox Tag Storage

## Status: Steps 0 and 1 complete. Next up: Step 2.

Reference: `docs/technical-spec-tag-ux.md`

One step at a time. Stop after each step and wait for confirmation before
starting the next.

---

## Step 0 — COMPLETE (2026-09-21). Redeploy cancelled.

Prerequisite. Closed without deploying, because there was nothing to fix.

- [x] Confirm whether the deployed `mcp` Edge Function predates migration 039
      — **DISPROVEN.** It is current. See "Step 0 findings" below.
- [x] ~~Redeploy `supabase/functions/mcp`~~ — **CANCELLED** (Alex, 2026-09-21).
      The deployed bundle is byte-identical to repo HEAD, and the bug the
      redeploy targeted does not exist, so it would have been a no-op over
      identical code. The comment fixes below ship with Step 5, which deploys
      the `mcp` function anyway.
- [x] Fix the stale comment in `getIntents` that still says
      `intents.tags is jsonb` — done in the repo, **not deployed**
- [x] Fix the second stale jsonb comment in `getItems` (`tool-handlers.ts:54`),
      approved by Alex 2026-09-21. **Comment only** — `getItems` behaviour is
      untouched, because `ai-enrich` depends on it and it is out of scope here.
- [x] Verify `get_intents` with `tags: ["ai"]` returns the three tagged
      intentions — **it already does**, against the currently deployed function

### Step 0 findings

**The theory was that the deployed function predates migration 039. It does not.**

1. `supabase functions list` reports `mcp` at **version 100, updated
   2026-09-20 12:43 UTC** — today, and six days *after* the tags commit
   (`eda53e1`, 2026-09-14) that accompanied migration 039.
2. Downloaded the deployed bundle to a scratch dir and diffed it against repo
   HEAD. `mcp/index.ts`, `_shared/tags.ts` and `_shared/platform.ts` are all
   **byte-identical**. `_shared/tags.ts` was *created* by the tags commit, so
   its presence at HEAD content proves the bundle was built at or after it.
   (The extraction aborted before `_shared/alfred-tools/` — the CLI refuses to
   write the bundle's `source/src/...` entries outside `supabase/functions` —
   so that one file was not diffed directly. Three-for-three on the rest, from
   a single bundle built from a single tree, settles it.)

**`get_intents` with a tags filter is not broken either.** Against the currently
deployed function:

| Call | Result |
|---|---|
| `tags:["ai"]`, `limit:50` | **3 rows** — the three `ai` intentions |
| `tags:["ai"]`, `include_archived:true`, `limit:50` | `[]` |

The difference is the **post-limit filtering bug** already filed as out of scope
in the spec (`getIntents`, now `tool-handlers.ts:267`). `.limit()` is applied by
Postgres *before* the client-side tag filter, and `clampLimit` hard-caps it at 50
whatever the caller asks. Adding archived rows to the pool pushes the three `ai`
rows past row 50, so they never reach the filter.

**Cause of the original report:** the investigation that produced this spec only
ever probed `get_intents` with `include_archived: true`, and read the resulting
empty array as a broken filter. That was my error in the prior investigation, and
the spec inherited it. The prerequisite in the spec's Overview is therefore void.

Success criterion 9 ("`get_intents` with a `tags` filter returns matching
intentions") was **already met** and needed no deploy. Deleted from the spec
2026-09-21, along with the Overview's prerequisite paragraph.

---

## Step 1 — COMPLETE (2026-09-21). Alphabetical ordering in the tag filter bar.

- [x] `TagFilter` sorts by tag name ascending using `localeCompare`, replacing
      the frequency-descending sort. It now sits at `src/Alfred.jsx:724-763`,
      with its new docblock at `:690-723` — the old `:690-727` reference in the
      spec pointed at the function itself and is now the docblock.
- [x] Counts still render inside each pill — the pill body is untouched
- [x] All four call sites covered. They needed no edits: the sort lives inside
      `TagFilter`, and every caller reaches it. Call sites are
      `src/Alfred.jsx:6123` (intentions), `:6183` (memories), `:6466`
      (collection detail) and `:9236` (context detail, Items accordion).

The whole behavioural change is one expression:

```js
// was: .sort((a, b) => b[1] - a[1])
const sortedTags = Object.entries(tagCounts).sort((a, b) => a[0].localeCompare(b[0]));
```

Full suite green (60 suites, 1209 tests). Production build compiles clean under
`CI=true`, warnings as errors.

### Step 1 decisions and surprises

- **`localeCompare`, not `<`.** `normaliseTag` preserves accents, so "café" is a
  legal tag; a plain comparison sorts it after "z". No locale argument passed —
  the browser default is right for a single-user app, and pinning one would be a
  guess with no evidence behind it.
- **`tagPoolFrom` stays frequency-first, deliberately.** Its docblock used to
  justify its ordering partly by saying it "matches the order `TagFilter`
  already shows its pills in" — which this change made false, so that clause is
  now a note explaining why the two deliberately differ. The picker offers a tag
  you have not named yet (common ones first); the bar helps you find one you
  already have in mind (alphabetical). A later reader will want to make them
  agree; the comment tells them not to.
- **Surprise: no test coverage exists for `TagFilter`, and I did not add any.**
  It is an unexported local function inside a 539 KB monolith, so it cannot be
  rendered in isolation without restructuring. Adding an export or extracting a
  helper purely to test a one-line sort is not worth the blast radius in that
  file. **Recommendation for Step 2:** that step adds collapse state, an
  active-filter pill and an expand control to this same component — real UI
  logic that does deserve tests. Extracting `TagFilter` into its own file
  (alongside `src/TagPicker.jsx`, which is tested) is the natural moment, and
  Step 2 is when to decide it. Flagging, not doing — Step 2 was explicitly out
  of scope here.
- **No behaviour changed beyond order.** Counting, the archived exclusion, the
  Clear pill, the active-pill styling and the click handler are all untouched.
- **Every `src/Alfred.jsx` line reference in the spec was refreshed.** The new
  `TagFilter` docblock pushed everything below it down by 40 lines, which
  invalidated ~20 pointers the spec presents as verified findings — including
  all of Step 5's triage-UI line list. Each new number was checked against the
  code it claims to point at. Steps 2–5 can trust the spec's pointers again.
- **A fourth spec error, not on Alex's list.** The out-of-scope bullet blamed
  the post-limit bug on `searchItems` as well as `getIntents`, citing
  `tool-handlers.ts:60`. Both wrong, both mine: line 60 was inside `getItems`,
  which has no `.limit()` and so is unaffected, and `searchItems` has no tag
  filter at all. `getIntents` is the only affected function. Corrected in the
  spec — **the filed Alfred item probably wants narrowing to match.**

---

## Step 2 — Collapse the tag bar on typing

- [ ] Add `listTagsCollapsed` state object as a sibling of `listSearch`
      (`src/Alfred.jsx:1732-1735`), keyed by the same page names
- [ ] `TagFilter` accepts collapsed state and a toggle
- [ ] Typing a character into a screen's search box collapses that screen's bar
- [ ] Clearing the search box does NOT auto-expand
- [ ] When collapsed with a filter active, the active filter pill stays visible
- [ ] When collapsed with no filter, only the expand control shows
- [ ] Applied at all four call sites

---

## Step 3 — Reset the tag filter on navigation

- [ ] `filterTag` clears when navigating between the three screens that share it
- [ ] Follows the existing pattern at `src/Alfred.jsx:4477`
- [ ] `collectionFilterTag` remains separate and untouched

---

## Step 4 — Exclude archived rows from the tag suggestion pool

- [ ] `tagPool` (`src/Alfred.jsx:1414`) filters archived out of `items` and
      `intents` before calling `tagPoolFrom`
- [ ] `tagPoolFrom` itself unchanged — keeps frequency-then-alphabetical ordering
- [ ] Verified: the picker no longer offers `urgent`, `test tag`, `another tag`,
      `due`, `late`, `overdue`, `past`, `outdoor maintenance`, `cleaning`

---

## Step 5 — Inbox column cutover (code side)

SQL migration is run by hand before this step. See "Manual prerequisites".

- [ ] `supabase/functions/mcp/index.ts:334` — the hand-typed column list still
      names `suggested_tags` correctly
- [ ] `supabase/functions/ai-enrich/index.ts:379` — `buildPreviousSuggestions`
      handles a text array
- [ ] `supabase/functions/ai-enrich/index.ts:582` — write path
- [ ] `supabase/functions/mcp/index.ts:197` — write path
- [ ] `tool-handlers.ts:606` and `:689` — write paths
- [ ] `supabase/functions/email-capture/index.ts:207` — empty array write
- [ ] `src/Alfred.jsx:2836` — empty array write
- [ ] Triage UI: lines 7333, 7393, 7434, 7470, 7487, 7770, 7877, 7894
- [ ] The two `JSON.stringify` dirty-checks at 7514 and 7519 still behave
      correctly and produce no phantom unsaved-changes prompt
- [ ] Deploy `mcp`, `ai-enrich` and `email-capture`

---

## Step 6 — Update the enrichment skill

- [ ] Rewrite the tag guidance in `alfred-enrich` per spec section C1
- [ ] Reuse-first: call `get_tags` and match an existing tag before proposing one
- [ ] New tags only when they fit cuisine, protein, core carb, or dish role
- [ ] Named exclusions with reasoning: cooking method, equipment, source or
      author, season, incidental ingredients

---

## Manual prerequisites (Alex runs these, not the CLI)

- [ ] `supabase/migrations/062_inbox_suggested_tags_text_array.sql` in the
      Supabase SQL editor — **before** Step 5
      (path corrected 2026-09-20: the spec and this file both said `040_...`,
      but `040` is already `040_tags_b_collection_item_tags.sql`. The actual
      file on disk is `062_`.)
- [ ] `check_platform_conformance()` — CONFORMANT required before Step 5 is
      marked done

---

## Notes

Tag clean-up SQL completed 2026-09-20. `recipe`, `mushroom`, `cheese`, `ganache`
and `cheesecake` deleted everywhere; `book`→`books` and `test`→`testing` merged;
18 recipe items gained tags; `vegetarian` removed from the one dessert carrying
it; every `tags` array in `items` and `intents` sorted alphabetically at rest.
Recipes context now carries 22 distinct tags and no untagged items.

The deletions initially did not apply on the first run and had to be re-run as a
standalone statement. Verified clean afterwards.

### Step 0, 2026-09-20 — decisions and surprises

- **Redeploy deliberately not run.** The spec gated it on confirming the stale
  deploy theory first. The theory is disproven and the bug it was meant to fix
  does not exist, so deploying would have been a no-op over a byte-identical
  bundle. Held for Alex rather than burning a production deploy on a comment.
- **The comment fix is in the repo but not live.** `tool-handlers.ts:245` now
  states the column is `text[]`, that it no longer matches `get_items` (which
  filters in Postgres via `platform_search_items`), and carries a warning about
  the page-not-table limit trap — because that trap is what caused the
  misdiagnosis, and the next person to read those lines is the person about to
  repeat it.
- **A second stale jsonb comment exists** at `tool-handlers.ts:54`, inside the
  legacy `getItems`: *"items.tags is a jsonb array"*. Equally false since 039.
  Left untouched — outside the scope Alex specified. One line, zero risk, his
  call. Note `getItems` is still live: `ai-enrich/index.ts:166` calls it. Unlike
  `getIntents` it has no `.limit()`, so it does **not** have the page-not-table
  bug.
- **Spec correction needed.** The Overview's "Prerequisite — redeploy the MCP
  function" paragraph is void, and success criterion 9 is already met. Not
  edited here; the spec is Alex's document.
- **Migration path in the spec is wrong** — `040_` vs the actual `062_`. See
  Manual prerequisites above.
- Nothing was committed. Nothing was pushed. No migration was run.
