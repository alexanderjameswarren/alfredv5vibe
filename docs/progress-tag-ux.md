# Progress: Tag UX and Inbox Tag Storage

## Status: Step 0 investigated — premise disproven, redeploy NOT run, awaiting Alex

Reference: `docs/technical-spec-tag-ux.md`

One step at a time. Stop after each step and wait for confirmation before
starting the next.

---

## Step 0 — Redeploy and verify the MCP function

Prerequisite. Nothing else starts until this is green.

- [x] Confirm whether the deployed `mcp` Edge Function predates migration 039
      — **DISPROVEN.** It is current. See "Step 0 findings" below.
- [ ] ~~Redeploy `supabase/functions/mcp`~~ — **NOT RUN.** Deliberately held.
      The redeploy's only stated purpose was to fix a bug that does not exist.
      Awaiting Alex's call on whether to deploy the comment fix anyway.
- [x] Fix the stale comment at `tool-handlers.ts:245` that still says
      `intents.tags is jsonb` — done in the repo, **not deployed**
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
in the spec (`tool-handlers.ts:245-251`). `.limit()` is applied by Postgres
*before* the client-side tag filter, and `clampLimit` hard-caps it at 50 whatever
the caller asks. Adding archived rows to the pool pushes the three `ai` rows past
row 50, so they never reach the filter.

**Cause of the original report:** the investigation that produced this spec only
ever probed `get_intents` with `include_archived: true`, and read the resulting
empty array as a broken filter. That was my error in the prior investigation, and
the spec inherited it. The prerequisite in the spec's Overview is therefore void.

Success criterion 9 ("`get_intents` with a `tags` filter returns matching
intentions") is **already met** and needs no deploy.

Note: verification needs a **new chat thread**. A session's tool manifest is
frozen at session start, so neither the CLI session nor the current web chat can
see a freshly deployed tool. Moot while nothing has been deployed.

---

## Step 1 — Alphabetical ordering in the tag filter bar

- [ ] `TagFilter` (`src/Alfred.jsx:690-727`) sorts by tag name ascending using
      `localeCompare`, replacing the current frequency-descending sort
- [ ] Counts still render inside each pill
- [ ] Verified on all four call sites: intentions list, memories list, collection
      detail, context detail

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
