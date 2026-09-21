# Progress: Tag UX and Inbox Tag Storage

## Status: Steps 0, 1, 2a and 2b complete. Next up: Step 3.

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
- [x] Fix the second stale jsonb comment in `getItems` — `tool-handlers.ts`,
      the comment above `const { data, error } = await query` inside
      `getItems` (~54). Approved by Alex 2026-09-21. **Comment only** — behaviour is
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
in the spec (`tool-handlers.ts`, `getIntents`, the `params.tags` filter, ~267).
`.limit()` is applied by Postgres *before* the client-side tag filter, and `clampLimit` hard-caps it at 50
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
      the frequency-descending sort. At the time it sat at
      `src/Alfred.jsx:724-763` (**moved to `src/TagFilter.jsx` in Step 2a**),
      with its new docblock at `:690-723` — the old `:690-727` reference in the
      spec pointed at the function itself and is now the docblock.
- [x] Counts still render inside each pill — the pill body is untouched
- [x] All four call sites covered. They needed no edits: the sort lives inside
      `TagFilter`, and every caller reaches it. Call sites are
      `src/Alfred.jsx:6123` (intentions), `:6183` (memories), `:6466`
      (collection detail) and `:9236` (context detail, Items accordion).
      Those four shifted again in Step 2a — see that step for current numbers.

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
  of scope here. → **ADOPTED. Alex split Step 2 into 2a (the move) and 2b (the
  collapse); 2a landed 2026-09-21 with 16 tests.**
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

## Step 2a — COMPLETE (2026-09-21). Extract TagFilter, no behaviour change.

Split out of the old Step 2 (Alex, 2026-09-21) so the move can be reviewed on
its own rather than tangled up with the collapse rewrite.

- [x] `TagFilter` moved from `src/Alfred.jsx` into `src/TagFilter.jsx`, beside
      `src/TagPicker.jsx`, following that file's conventions (imports, `//`
      header block, `export default function`)
- [x] Pure move — identical rendering, identical props, identical behaviour.
      The component body is byte-for-byte what it was; only the export keyword
      and the comment style around it changed.
- [x] All four call sites resolve to the import. **They needed no textual
      edits:** the component is a default export under the same name, so
      `<TagFilter …>` at `src/Alfred.jsx:6049` (intentions), `:6109`
      (memories), `:6392` (collection detail) and `:9162` (context detail,
      Items accordion) is unchanged and now resolves to the import at `:31`.
- [x] 16 unit tests in `src/TagFilter.test.jsx`, written against behaviour as
      it stands today — the safety net for 2b
- [x] Full suite green: **61 suites, 1225 tests** (was 60 / 1209)
- [x] Production build compiles clean under `CI=true`, warnings as errors
- [x] Every `src/Alfred.jsx` line pointer in the spec refreshed and checked

### Step 2a decisions and surprises

- **Test conventions follow `TagPicker.test.jsx`, not the SAM suites.** That
  file uses plain Jest matchers only — no `@testing-library/jest-dom` — and
  reads the DOM through small helper extractors. Kept that: the central
  assertion here is "these pills, in this order, with these counts", which is
  an array comparison and reads better than a pile of `toBeInTheDocument`.
  `toBeEmptyDOMElement` was swapped for `expect(container.innerHTML).toBe("")`
  to stay inside the convention.
- **Two things noticed and deliberately NOT fixed**, per the pure-move rule.
  Both are recorded in the tests so the behaviour is pinned either way:
  1. **The count is of tag OCCURRENCES, not rows.** A row whose `tags` array
     held `["soup", "soup"]` would make the pill read one higher. Harmless
     today — `normaliseTags` dedupes on every write path, so no stored row can
     be in that shape — but the pill would lie if one ever were.
  2. **`Clear` shows for a tag no visible row carries.** Filter to "beans",
     archive the last beans row, and the bar renders the remaining tags plus
     `Clear`, with no "beans" pill. That is arguably correct — `Clear` is the
     only way back from a list filtered to nothing — but it is worth a decision
     rather than an accident, and 2b's active-filter pill will have to take a
     position on it.
- **No prop or signature changes.** `entities` / `activeTag` / `onFilter`
  exactly as before. 2b will add to this surface; 2a did not.
- **`tagPoolFrom`'s docblock updated** — it referred to `TagFilter` "above",
  which is now a different file. Pointer only; the frequency-first ordering and
  its reasoning are untouched.
- **Surprise: this file's own forward checklists were stale, and had been since
  before Step 1.** Steps 3, 4 and 5 still carried the ORIGINAL investigation
  line numbers — `4477`, `1414`, `2836`, `tool-handlers.ts:606/:689`, and the
  nine triage-UI lines — which Step 1's docblock had already invalidated and
  Step 2a shifted again. Only the spec was refreshed last session; the progress
  file was missed. All now updated and each checked against the code it points
  at, edge-function pointers included. **Both documents now agree**, which is
  the bit that matters for Step 5.
- **Line pointers are now a recurring tax.** Three sessions in a row have
  spent real effort re-deriving them, and Step 2b will shift them a fourth
  time. Not proposing anything now, but if it bites again the answer is
  probably to cite a stable anchor (a function name, a distinctive string)
  instead of a line number. → **ADOPTED. Both documents were converted to
  stable anchors before Step 2b (2026-09-21): enclosing function, plus a string
  to search for, with the line number kept only as an approximate `(~n)` hint.**

---

## Step 2b — COMPLETE (2026-09-21). Collapse the tag bar on typing.

- [x] `listTagsCollapsed` state object added as a sibling of `listSearch`
      (`Alfred`, `const [listTagsCollapsed, setListTagsCollapsed] = useState({})`,
      ~1722), keyed by the same page names plus `collection-detail`
- [x] `TagFilter` accepts `collapsed` and `onToggleCollapsed`
- [x] Typing a character into a screen's search box collapses that screen's bar
- [x] Clearing the search box does NOT auto-expand
- [x] When collapsed with a filter active, the active filter pill stays visible,
      with `Clear` beside it
- [x] When collapsed with no filter, only the toggle shows
- [x] Applied at all four call sites
- [x] Active-filter pill when the tag is no longer in the list — **decided by
      Alex 2026-09-21: show it.** The pill exists to answer "why is this list
      empty", so hiding it in the one case where the list IS empty defeats it.
- [x] All 16 existing `src/TagFilter.test.jsx` tests pass **unchanged** — not
      one needed editing. 16 new tests added on top.

Suite: **61 suites, 1241 tests** (was 61 / 1225). Build clean under `CI=true`.

### What it looks like

Expanded, the bar gains one control at the front:

    [▾ Tags (22)] [beans (9)] [beef (2)] [chicken (4)] … [vegetarian (26)]

Collapsed with a filter on, that is the whole bar:

    [▸ Tags (22)] [beans (9)] [Clear]

Collapsed with no filter:

    [▸ Tags (22)]

### Step 2b decisions and surprises

- **The toggle sits FIRST, not last.** It is then in the same place whether the
  bar is open or shut, so it can be reached without reading the row — which
  matters most on the phone, which is the whole point of the step. Collapsed,
  the row also reads in the right order: what this control is, why the list is
  filtered, how to stop.
- **The toggle shows the count of hidden tags** — `Tags (22)` — so you know the
  size of what you are opening before you open it.
- **No handler means no toggle, and `collapsed` is then ignored.** A bar that
  cannot be reopened must never be closed, so `collapsed` only takes effect when
  `onToggleCollapsed` is supplied. This is also why the 16 original tests pass
  untouched: none of them pass a handler, so none of them render a toggle. That
  is the component's rule, not a test convenience.
- **The collapsed active pill drops its count when the tag is absent.** It reads
  `beans`, not `beans (0)`. The pill is answering "what is filtering this", not
  "how many matched", and `(0)` invites the reading that the count is a result.
- **Surprise: collection detail has no search box at all.** Nothing can ever
  collapse that bar by typing; the toggle is its only control. It also has no
  `listSearch` key, so `collection-detail` is a collapse-only key — the one
  place `listTagsCollapsed` and `listSearch` do not share a keyspace. Given it
  is a separate vocabulary with its own `collectionFilterTag`, that seemed
  right rather than worth forcing into line.
- **The collapse rule is exported as `collapseOnSearch`, not inlined.**
  `executionColdLoad.test.jsx` opens by explaining that `Alfred` cannot be
  rendered in a test, and that a harness reproducing a rule instead of importing
  it "can stay green while the shipping code drifts away from it". Inlining the
  rule in `setSearchFor` would have left "typing collapses / clearing does not"
  either untested or tested against a copy. `Alfred` now calls the exported
  function, and the tests import that same function.
- **Still nothing rendered when no tag is in use** — collapsed or not, filter or
  not. So a stale `activeTag` inherited from another screen still shows no
  `Clear` on a screen whose rows carry no tags. Unchanged from 2a, out of scope
  here, and **Step 3 removes the inheritance that causes it.**
- **Not done, deliberately:** no filter reset on navigation, no suggestion-pool
  change, nothing inbox-related.

---

## Step 3 — Reset the tag filter on navigation

- [ ] `filterTag` clears when navigating between the three screens that share it
- [ ] Follows the existing pattern in `Alfred` -> `viewContextDetail`, the
      `setSearchFor("context-detail")("")` line (~4443)
- [ ] `collectionFilterTag` remains separate and untouched

---

## Step 4 — Exclude archived rows from the tag suggestion pool

- [ ] `tagPool` (`Alfred`,
      `const tagPool = useMemo(() => tagPoolFrom(items, intents)`, ~1380)
      filters archived out of `items` and `intents` before calling
      `tagPoolFrom`
- [ ] `tagPoolFrom` itself unchanged — keeps frequency-then-alphabetical ordering
- [ ] Verified: the picker no longer offers `urgent`, `test tag`, `another tag`,
      `due`, `late`, `overdue`, `past`, `outdoor maintenance`, `cleaning`

---

## Step 5 — Inbox column cutover (code side)

SQL migration is run by hand before this step. See "Manual prerequisites".

Every location below is anchored by its enclosing function plus a string to
search for. The `(~n)` is last-known line, approximate and not to be trusted —
search for the string.

**Edge functions**

- [ ] `mcp/index.ts`, `getInboxTool` — the hand-typed `.select(...)` string of
      21 columns still names `suggested_tags` correctly (~334)
- [ ] `ai-enrich/index.ts`, `buildPreviousSuggestions` — the `fields` array
      handles a text array (~379)
- [ ] `ai-enrich/index.ts`, the `submit_suggestions` update —
      `suggested_tags: normaliseTags(suggestions.suggested_tags)` (~582)
- [ ] `mcp/index.ts`, `createInboxItemTool` —
      `suggested_tags: normaliseTags(args.suggested_tags)` (~197)
- [ ] `tool-handlers.ts`, `createInboxItem` —
      `suggested_tags: normaliseTags(params.suggested_tags)` (~627)
- [ ] `tool-handlers.ts`, `updateInboxItem` —
      `updates.suggested_tags = normaliseTags(params.suggested_tags)` (~710)
- [ ] `email-capture/index.ts`, the `inboxRecord` literal —
      `suggested_tags: []` (~207)

**Browser — the ten triage-UI locations, one per line**

- [ ] `Alfred` -> `handleCapture` — `suggestedTags: []` in the new-capture
      record (~2802)
- [ ] `CLEARED_ENRICHMENT` (module constant above `InboxCard`) —
      `suggestedTags: []` (~7299)
- [ ] `InboxCard` —
      `const [intentTags, setIntentTags] = useState(inboxItem.suggestedTags || [])`
      (~7359)
- [ ] `InboxCard` —
      `const [itemTags, setItemTags] = useState(inboxItem.suggestedTags || [])`
      (~7400)
- [ ] `InboxCard`, the re-seed effect, under `if (inboxItem.suggestIntent)` —
      `setIntentTags(inboxItem.suggestedTags || [])` (~7436)
- [ ] `InboxCard`, the same effect, under `if (inboxItem.suggestItem)` —
      `setItemTags(inboxItem.suggestedTags || [])` (~7453)
- [ ] `InboxCard`, the `isDirty` effect —
      `JSON.stringify(intentTags) !== JSON.stringify(inboxItem.suggestedTags || [])`
      (~7480)
- [ ] `InboxCard`, the `isDirty` effect —
      `JSON.stringify(itemTags) !== JSON.stringify(inboxItem.suggestedTags || [])`
      (~7485)
- [ ] `InboxCard` -> `handleReEnrich` —
      `suggestedTags: intentTags.length > 0 ? intentTags : []` (~7736)
- [ ] `InboxCard` -> `handleCancel` —
      `setIntentTags(inboxItem.suggestedTags || [])` (~7843)
- [ ] `InboxCard` -> `handleCancel` —
      `setItemTags(inboxItem.suggestedTags || [])` (~7860)

(That is eleven checkboxes for ten `suggestedTags` triage locations plus
`handleCapture`, which lives outside `InboxCard`.)

- [ ] The two `JSON.stringify` dirty-checks above still behave correctly and
      produce no phantom unsaved-changes prompt
- [ ] The triage write-through in `Alfred` -> `handleInboxSave` still needs no
      change: `tags: triageData.itemData.tags || []` (~2962) and
      `tags: triageData.intentionData.tags || []` (~3009)
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
- **The comment fix is in the repo but not live.** The comment above
  `getIntents`' tag filter now
  states the column is `text[]`, that it no longer matches `get_items` (which
  filters in Postgres via `platform_search_items`), and carries a warning about
  the page-not-table limit trap — because that trap is what caused the
  misdiagnosis, and the next person to read those lines is the person about to
  repeat it.
- **A second stale jsonb comment exists** in `tool-handlers.ts`, inside the
  legacy `getItems`: *"items.tags is a jsonb array"*. Equally false since 039.
  Left untouched — outside the scope Alex specified. One line, zero risk, his
  call. Note `getItems` is still live: `ai-enrich/index.ts` calls it from its
  tool dispatch, `case "get_items"` (~166). Unlike
  `getIntents` it has no `.limit()`, so it does **not** have the page-not-table
  bug.
- **Spec correction needed.** The Overview's "Prerequisite — redeploy the MCP
  function" paragraph is void, and success criterion 9 is already met. Not
  edited here; the spec is Alex's document.
- **Migration path in the spec is wrong** — `040_` vs the actual `062_`. See
  Manual prerequisites above.
- Nothing was committed. Nothing was pushed. No migration was run.
