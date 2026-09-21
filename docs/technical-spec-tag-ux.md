# Technical Spec — Tag UX and Inbox Tag Storage

## Overview

Three related changes.

**Change A — tag filter bar.** The bar takes too much vertical space on mobile. On
the Recipes context page it renders 22 pills, roughly six or seven wrapped rows,
which pushes search results off screen while typing. Make it collapse
automatically on typing, sort its tags alphabetically, and stop it leaking a
filter between screens.

**Change B — inbox tag storage.** `inbox.suggested_tags` is still `jsonb`.
`items.tags` and `intents.tags` moved to native `text[]` in migration 039. Hard
cutover of the inbox column to match, normalising existing values on the way.

**Change C — enrichment skill.** Update the tag guidance in the alfred-enrich
skill so Claude reuses existing tags and only proposes a new one when it fits the
established tag shapes.

## Current state — established by investigation, not assumption

### The tag filter bar

`TagFilter` lives in `src/TagFilter.jsx`, beside `src/TagPicker.jsx`, with unit
tests in `src/TagFilter.test.jsx`. It was a local, unexported function inside
`src/Alfred.jsx` until Step 2a (2026-09-21) moved it out unchanged.

Four call sites, all `<TagFilter`, each identified by the `entities` prop it
passes. Line numbers are approximate hints only.

| Screen | Route | Search for | ~Line |
|---|---|---|---|
| Intentions list | `/intentions` | `entities={intentionsWithoutActiveEvent}` | 6076 |
| Memories list | `/memories` | `entities={memoriesWithoutContext}` | 6142 |
| Collection detail | `/collections/detail` | `entities={members}` | 6436 |
| Context detail, Items accordion | `/contexts/detail` | `entities={items}` (inside `ContextDetailView`) | 9212 |

Only the first two and the last sit under a search box. **Collection detail has
no search box at all**, so nothing can ever collapse its bar by typing.

The tag list is derived client-side inside `TagFilter` from whatever array it is
handed. There is no query and no RPC. It is therefore already scoped to the
current context.

~~Ordering is frequency descending with **no tie-break**, so equal-count tags
land in row order.~~ **DONE in Step 1, 2026-09-21** — ordering is now ascending
by tag name via `localeCompare`. See A4.

Three of the four call sites share one `filterTag` state value. Collection detail
deliberately uses a separate `collectionFilterTag` — reasoning at
`Alfred`, the `collectionFilterTag` state declaration and the comment above it
(~1408): collection tags are store labels, a different vocabulary, and a leaked
filter would silently empty a context page.

Archived rows are excluded, but not inside `TagFilter`. Each array is filtered
before it is handed over, at three separate places in `src/Alfred.jsx`:

- `Alfred`, building `intentionsWithoutActiveEvent` —
  `if (!i.isIntention || i.archived) return false` (~5106)
- `Alfred`, `const memoriesWithoutContext =` (~5111)
- `Alfred`'s render, the `<ContextDetailView>` props —
  `items={items.filter((i) => i.contextId === selectedContextId && !i.archived)}`
  (~5747)

### Search state — the pattern to copy

`Alfred`, `const [listSearch, setListSearch] = useState({})` (~1698). One plain
React state object keyed by page name, living in the top-level component:

```js
const [listSearch, setListSearch] = useState({});
const searchFor = (page) => listSearch[page] || "";
const setSearchFor = (page) => (value) => {
  setListSearch((prev) => ({ ...prev, [page]: value }));
  // Added Step 2b. See A2.
  setListTagsCollapsed((prev) => collapseOnSearch(prev, page, value));
};
```

Survives navigation because `Alfred` never unmounts; dies on reload. Keys in use:
`home`, `inbox`, `contexts`, `context-detail`, `schedule`, `intentions`,
`memories`, `collections`.

One extra rule in `Alfred` -> `viewContextDetail`, the
`setSearchFor("context-detail")("")` line (~4443): context-detail search clears
when a different context is opened.

Sort preference uses the opposite pattern — `useSortPreference` persists to
localStorage under keys like `alfred.sort.intentions`
(`src/utils/sortOrders.js`, `readStoredSort` / `writeStoredSort`, ~110-155).
Both patterns exist; search deliberately uses the in-memory one.

### Tag chips on cards

Four render sites, none sorted, all displaying stored array order, all in
`src/Alfred.jsx`:

- `ItemCard`, `item.tags.slice(0, 3)` — capped at 3 (~11215)
- `IntentionCard`, `intent.tags.slice(0, 3)` — capped at 3 (~12198)
- `DetailMeta`, `shown.map((tag) =>` — uncapped (~772)
- `Alfred`'s render, the collection-detail member row, `memberTags.map((tag) =>`
  (~6470)

The stored arrays are now alphabetically sorted at rest, so the capped cards
already show the alphabetically-first three. **Decision: leave the cap at 3.**

### The tag suggestion pool

`src/Alfred.jsx`, `function tagPoolFrom(...recordLists)` (~720), called from
`Alfred`, `const tagPool = useMemo(() => tagPoolFrom(items, intents)` (~1380),
over the **unfiltered** `items` and `intents` state arrays.
So the picker offers tags from archived rows that the filter bar hides. Nine such
tags exist today: `due`, `late`, `overdue`, `past`, `urgent`, `test tag`,
`another tag`, `outdoor maintenance`, `cleaning`.

### Inbox tag storage

`inbox.suggested_tags` is `jsonb`, default `'[]'::jsonb`, nullable.

Writes, normalised:
- `ai-enrich/index.ts`, the `submit_suggestions` update —
  `suggested_tags: normaliseTags(suggestions.suggested_tags)` (~582)
- `mcp/index.ts`, `createInboxItemTool` —
  `suggested_tags: normaliseTags(args.suggested_tags)` (~197)
- `tool-handlers.ts`, `createInboxItem` —
  `suggested_tags: normaliseTags(params.suggested_tags)` (~627)
- `tool-handlers.ts`, `updateInboxItem` —
  `updates.suggested_tags = normaliseTags(params.suggested_tags)` (~710)

Writes that bypass normalisation, both writing a literal empty array:
- `email-capture/index.ts`, the `inboxRecord` literal — `suggested_tags: []` (~207)
- `Alfred` -> `handleCapture`, `suggestedTags: []` (~2802)

Reads:
- `mcp/index.ts`, `getInboxTool` — the hand-typed `.select(...)` string listing
  21 columns, `suggested_tags` among them (~334). This will not fail at compile
  time. It fails at request time, in production.
- `ai-enrich/index.ts`, `buildPreviousSuggestions` — the `fields` array, which
  echoes the stored value back into the re-enrich prompt (~379).
- Triage UI in `src/Alfred.jsx` as camelCase `suggestedTags` — **ten locations,
  enumerated one per line in the Step 5 checklist of
  `docs/progress-tag-ux.md`**, which is the operational list. Two of the ten are
  the `JSON.stringify` dirty-checks inside `InboxCard`'s `isDirty` effect.

Triage writes tags through to `items.tags` / `intents.tags` in `Alfred` ->
`handleInboxSave` — `tags: triageData.itemData.tags || []` (~2962) and
`tags: triageData.intentionData.tags || []` (~3009) — as a plain JS array. Nothing
converts between shapes; PostgREST coerces to whatever the destination column is.
**This boundary needs no code change.**

### The normaliser

Deliberate twins: `src/utils/tags.js` (browser) and
`supabase/functions/_shared/tags.ts` (Deno). Edge Functions cannot import from
`src/`, so the duplication is intentional and both files carry a boxed header
saying they must be edited together.

Both export `normaliseTag`, `normaliseTags`, `MAX_TAG_LENGTH` (50), `MAX_TAGS` (20).

`normaliseTag` (`src/utils/tags.js`, `export function normaliseTag`, ~104):
lowercase, delete apostrophes,
replace anything outside letters/digits/space/hyphen/underscore with a space,
fold hyphens and underscores to spaces, collapse whitespace, trim.
`normaliseTags` then dedupes first-occurrence-wins, preserves order, caps at 20.

The load-bearing rule, stated in both headers: **normalise on write, never on
load.** Normalising on load breaks the `JSON.stringify` dirty-checks and produces
phantom unsaved-changes prompts.

`normaliseTagsArray` (`src/utils/collectionMembers.js`,
`function normaliseTagsArray(tags)`, ~304) is a third
function but not a duplicate — it coerces shape only and never touches tag text.

Note: `src/Alfred.jsx` does not import `src/utils/tags.js` at all. The only
browser caller is `TagPicker`, `const candidate = normaliseTag(query)` (~181).

## Design decisions

### A1 — Collapse behaviour — IMPLEMENTED, Steps 2b and 2c, 2026-09-21

Expanded by default. Collapses the moment the user types a character into that
screen's search box. Does not auto-expand when the search box is cleared; the
user re-expands by hand.

**Threshold (Step 2c).** A bar collapses only when it holds **four or more
distinct tags** — `COLLAPSE_MIN_TAGS`, exported from `src/TagFilter.jsx`. Below
that there is no toggle, every pill always shows, and typing cannot collapse it.

Four, because three pills fit on one row on a phone: collapsing a one-row bar
cannot save a row, since the toggle would occupy the row it was meant to free.
The case that prompted it is the grocery collection, which carries two tags —
and collection detail has no search box, so nothing could ever fire its toggle
anyway, leaving a control whose only purpose would be to undo itself.

The check is in the RENDER, not in `collapseOnSearch`. Consequences, both
deliberate:

- A bar whose tag count drops below the threshold **while collapsed** shows its
  pills again on the next render. A hidden bar with no way to reopen it is the
  one outcome that must be impossible, and this makes it so by construction
  rather than by a separate mechanism.
- Typing on a sub-threshold screen still records `collapsed: true`. Nothing
  happens, because the render ignores it — but if that screen later grows past
  four tags the bar opens collapsed. Kept rather than scrubbed (Alex,
  2026-09-21): the user did perform the gesture that means collapse, and
  discarding their intent over a tag count they were not thinking about is the
  more surprising behaviour.

### A2 — Collapse state storage — IMPLEMENTED, Step 2b, 2026-09-21

A sibling of `listSearch`: a `listTagsCollapsed` state object keyed by the same
page names, in the same top-level component. Survives navigation, dies on reload.

As built: `Alfred`,
`const [listTagsCollapsed, setListTagsCollapsed] = useState({})` (~1722), with
`tagsCollapsedFor(page)` and `toggleTagsFor(page)` beside it. Absent means
expanded, so `{}` is the state a fresh load starts in.

The collapse-on-typing rule is `collapseOnSearch`, exported from
`src/TagFilter.jsx` rather than inlined, so `TagFilter.test.jsx` tests the same
function `Alfred` calls — `Alfred` itself cannot be rendered in a test.

One extra key beyond the `listSearch` set: `collection-detail`. That view has no
search box, so its bar only ever collapses by hand.

This deliberately matches search rather than sort. Note that `/contexts/detail`
carries no id in its URL (`src/viewPaths.js`, `VIEW_TO_PATH`, the
`"context-detail": "/contexts/detail"` entry, ~31) — a reload lands on a context
view with no context selected — so reload persistence is moot on the page where
the bar is worst.

### A3 — What stays visible when collapsed — IMPLEMENTED, Step 2b, 2026-09-21

Applies only to a bar large enough to collapse — see the threshold in A1.

The active filter pill, if a filter is applied, plus the expand control and
`Clear`. An
active filter that is invisible while still filtering would silently empty a list
with no visible cause.

When no filter is active, only the toggle shows. The toggle sits FIRST in the
row so it is in the same place open or shut, and it carries the count of hidden
tags — `Tags (22)`.

The active pill is shown **even when no visible row carries that tag** (Alex,
2026-09-21): that is the case where the list is emptiest and "why" is loudest.
Its count is dropped rather than printed as `(0)`, because the pill answers what
is filtering, not how many matched.

### A4 — Ordering — IMPLEMENTED, Step 1, 2026-09-21

`TagFilter` sorts alphabetically by tag name, ascending, using `localeCompare`.
Counts still render in each pill; only the ordering changes.

`tagPoolFrom` — the tag PICKER's suggestion list — deliberately stays
frequency-first. Different question: the picker offers a tag not yet named, the
bar helps find one already in mind. Both docblocks now say so.

Card chips need no change — the stored arrays are already sorted, and the
existing render sites display stored order.

### A5 — Filter reset on navigation

`filterTag` currently persists across the three screens that share it. Clear it
when navigating between them, following the pattern already at
`Alfred` -> `viewContextDetail`, the `setSearchFor("context-detail")("")` line
(~4443). `collectionFilterTag` stays separate and untouched.

### A6 — Suggestion pool excludes archived

`tagPool` (`Alfred`, `const tagPool = useMemo(() => tagPoolFrom(items, intents)`,
~1380) filters archived rows out of `items` and
`intents` before calling `tagPoolFrom`, matching what the filter bar already
does. `tagPoolFrom` itself is unchanged — its frequency-plus-alphabetical
ordering is correct for a suggestion list and should not become alphabetical-only.

### B1 — Hard cutover, no transition period

Single-user app. Migrate the column, update every touchpoint, deploy together.
No dual-write period, no compatibility shim.

**Sequencing risk, accepted deliberately:** the migration drops the `jsonb`
column while the deployed function still names `suggested_tags` in a hand-typed
string. There is a window between running the migration and deploying the
function where the inbox read fails in production. Run the migration and deploy
back to back, and do not capture anything to the inbox in between.

### B2 — Normalise during migration

Existing values pass through a SQL normaliser that mirrors `normaliseTag`. It is
an approximation in one respect: the JavaScript version uses Unicode property
classes (`\p{L}`, `\p{N}`), which Postgres regex does not support. The SQL uses
`[[:alnum:]]`, which under a UTF-8 collation handles accented letters correctly.
Acceptable for a one-time pass over staging data.

The SQL normaliser is created as a `pg_temp` function and dies with the session,
so it does not become a permanent third copy of the rule.

### B3 — Column shape after cutover

`text[] NOT NULL DEFAULT '{}'`, matching `items.tags` and `intents.tags`. The old
column was nullable; every read site already coalesces, so `NOT NULL` is safe and
removes a null check.

### B4 — The two unnormalised writers

`email-capture/index.ts`'s `inboxRecord` literal (~207) and `Alfred` ->
`handleCapture` (~2802) both
write a literal empty array. Harmless today, but both must change from `[]` to
`[]` typed as a text array — in practice a no-op in JS, but both lines must be
visited to confirm no jsonb-specific handling surrounds them.

### C1 — Tag shape rule

The purpose of a recipe tag is to find a recipe fast, or to decide what to make.
It is not to describe the dish. A new tag is only proposed when it fits one of
four shapes:

1. **Cuisine** — italian, mexican, indian, chinese, middle eastern
2. **Protein** — chicken, beef, pork, beans, lentils, tofu, fish
3. **Core carb** — pasta, rice, potato
4. **Dish role** — soup, salad, side, dessert, sauce, stir fry

Everything else reuses an existing tag or adds nothing.

Explicitly excluded, with the reasoning: cooking method, equipment, source or
author, season, and incidental ingredients. `corn`, `squash`, `mushroom` and
`cheese` were all considered and rejected — you do not decide what to cook based
on them.

## Success criteria

1. On the Recipes context page on a phone, typing in the search box collapses the
   tag bar and the results are visible without scrolling.
2. The tag bar renders tags in alphabetical order on all four screens.
3. An active tag filter remains visible when the bar is collapsed.
4. Navigating from the Memories list to a context page does not carry a tag
   filter with it.
5. The tag picker no longer suggests `urgent`, `test tag`, or any other tag whose
   only home is an archived row.
6. `inbox.suggested_tags` is `text[] NOT NULL DEFAULT '{}'`.
7. Capture, enrich, re-enrich and triage all work end to end, and a tag entered
   with mixed case or an underscore arrives in `items.tags` normalised.
8. `check_platform_conformance` returns CONFORMANT.

## Out of scope — captured separately

- **Post-limit filtering bug — `getIntents` only.** Its tag filter
  (`tool-handlers.ts`, `getIntents`, the `params.tags` filter over `intents`,
  ~267) runs after the query, and the query carries
  `.limit(limit)` which `clampLimit` hard-caps at 50 whatever the caller asks.
  So it filters a page rather than the table: a match on row 51 is invisible,
  and `include_archived: true` makes it worse by crowding the window. Real bug,
  unrelated to these changes, filed as its own Alfred item.

  **Scope corrected 2026-09-21.** This bullet previously also named
  `searchItems`, and pointed at a line then numbered 60. Both were wrong, and both
  errors are mine from the original investigation. Line 60 was inside `getItems`
  (now line 68), not `searchItems` — and `getItems` has no `.limit()` at all, so
  filtering after the fetch sees every row and it is not affected. `searchItems`
  (`tool-handlers.ts`, `export async function searchItems`, ~79) has no tag
  filter of any kind; its `.limit(20)` is a
  plain result cap, not a filter-after-limit. **`getIntents` is the only
  affected function.** Worth narrowing the filed Alfred item to match.
- **Context detail URL carries no id** (`src/viewPaths.js`, `VIEW_TO_PATH`, the
  `"context-detail"` entry, ~31). Already known,
  scheduled for a later routing slice.
- **Orphaned items.** Sixteen items have a null `context_id`; three point at
  context ids that no longer exist.
- **Card tag cap.** Staying at 3. Revisit only if it proves annoying in use.
