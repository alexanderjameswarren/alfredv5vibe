# Technical Spec — Tag UX and Inbox Tag Storage

## Overview

Three related changes, plus one prerequisite.

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

**Prerequisite — redeploy the MCP function.** `get_intents` with a `tags` filter
returns nothing in production even when matching intents exist. The repo code
looks correct and its comment still claims the column is `jsonb`, so the deployed
function almost certainly predates migration 039. This must be resolved before
Change B, because Change B modifies the same function and nobody should be
debugging two deploy states at once.

## Current state — established by investigation, not assumption

### The tag filter bar

`TagFilter` is a local function declaration at `src/Alfred.jsx:690-727`. It is not
exported and has no file of its own. `src/Alfred.jsx` is 539 KB.

Four call sites:

| Line | Screen | Route | Entities |
|---|---|---|---|
| 6083 | Intentions list | `/intentions` | `intentionsWithoutActiveEvent` |
| 6143 | Memories list | `/memories` | `memoriesWithoutContext` |
| 6426 | Collection detail | `/collections/detail` | collection members |
| 9196 | Context detail, Items accordion | `/contexts/detail` | that context's items |

The tag list is derived client-side inside `TagFilter` from whatever array it is
handed. There is no query and no RPC. It is therefore already scoped to the
current context. Ordering is frequency descending with **no tie-break**, so
equal-count tags land in row order.

Three of the four call sites share one `filterTag` state value. Collection detail
deliberately uses a separate `collectionFilterTag` — reasoning at
`src/Alfred.jsx:1442-1448`: collection tags are store labels, a different
vocabulary, and a leaked filter would silently empty a context page.

Archived rows are excluded, but not inside `TagFilter`. Each array is filtered
before it is handed over, at three separate places: `src/Alfred.jsx:5140`,
`src/Alfred.jsx:5145`, `src/Alfred.jsx:5783`.

### Search state — the pattern to copy

`src/Alfred.jsx:1732-1735`. One plain React state object keyed by page name,
living in the top-level component:

```js
const [listSearch, setListSearch] = useState({});
const searchFor = (page) => listSearch[page] || "";
const setSearchFor = (page) => (value) =>
  setListSearch((prev) => ({ ...prev, [page]: value }));
```

Survives navigation because `Alfred` never unmounts; dies on reload. Keys in use:
`home`, `inbox`, `contexts`, `context-detail`, `schedule`, `intentions`,
`memories`, `collections`.

One extra rule at `src/Alfred.jsx:4477`: context-detail search clears when a
different context is opened.

Sort preference uses the opposite pattern — `useSortPreference` persists to
localStorage under keys like `alfred.sort.intentions` (`src/utils/sortOrders.js:110-155`).
Both patterns exist; search deliberately uses the in-memory one.

### Tag chips on cards

Four render sites, none sorted, all displaying stored array order:
`src/Alfred.jsx:11247` (ItemCard, capped at 3), `src/Alfred.jsx:12232`
(IntentionCard, capped at 3), `src/Alfred.jsx:804` (DetailMeta, uncapped),
`src/Alfred.jsx:6478` (collection member rows).

The stored arrays are now alphabetically sorted at rest, so the capped cards
already show the alphabetically-first three. **Decision: leave the cap at 3.**

### The tag suggestion pool

`tagPoolFrom` at `src/Alfred.jsx:754-771`, called via `tagPool` at
`src/Alfred.jsx:1414` over the **unfiltered** `items` and `intents` state arrays.
So the picker offers tags from archived rows that the filter bar hides. Nine such
tags exist today: `due`, `late`, `overdue`, `past`, `urgent`, `test tag`,
`another tag`, `outdoor maintenance`, `cleaning`.

### Inbox tag storage

`inbox.suggested_tags` is `jsonb`, default `'[]'::jsonb`, nullable.

Writes, normalised:
- `supabase/functions/ai-enrich/index.ts:582`
- `supabase/functions/mcp/index.ts:197`
- `supabase/functions/_shared/alfred-tools/tool-handlers.ts:606`
- `supabase/functions/_shared/alfred-tools/tool-handlers.ts:689`

Writes that bypass normalisation, both writing a literal empty array:
- `supabase/functions/email-capture/index.ts:207`
- `src/Alfred.jsx:2836`

Reads:
- `supabase/functions/mcp/index.ts:334` — a hand-typed string listing 21 columns.
  This will not fail at compile time. It fails at request time, in production.
- `supabase/functions/ai-enrich/index.ts:379` — echoed into the re-enrich prompt.
- Triage UI in `src/Alfred.jsx` as camelCase `suggestedTags`: lines 7333, 7393,
  7434, 7470, 7487, 7770, 7877, 7894, plus dirty-checks at 7514 and 7519 that
  compare with `JSON.stringify`.

Triage writes tags through to `items.tags` / `intents.tags` at
`src/Alfred.jsx:2996` and `src/Alfred.jsx:3043` as a plain JS array. Nothing
converts between shapes; PostgREST coerces to whatever the destination column is.
**This boundary needs no code change.**

### The normaliser

Deliberate twins: `src/utils/tags.js` (browser) and
`supabase/functions/_shared/tags.ts` (Deno). Edge Functions cannot import from
`src/`, so the duplication is intentional and both files carry a boxed header
saying they must be edited together.

Both export `normaliseTag`, `normaliseTags`, `MAX_TAG_LENGTH` (50), `MAX_TAGS` (20).

`normaliseTag` (`src/utils/tags.js:104-116`): lowercase, delete apostrophes,
replace anything outside letters/digits/space/hyphen/underscore with a space,
fold hyphens and underscores to spaces, collapse whitespace, trim.
`normaliseTags` then dedupes first-occurrence-wins, preserves order, caps at 20.

The load-bearing rule, stated in both headers: **normalise on write, never on
load.** Normalising on load breaks the `JSON.stringify` dirty-checks and produces
phantom unsaved-changes prompts.

`normaliseTagsArray` in `src/utils/collectionMembers.js:304-311` is a third
function but not a duplicate — it coerces shape only and never touches tag text.

Note: `src/Alfred.jsx` does not import `src/utils/tags.js` at all. The only
browser caller is `src/components/TagPicker.jsx:181`.

## Design decisions

### A1 — Collapse behaviour

Expanded by default. Collapses the moment the user types a character into that
screen's search box. Does not auto-expand when the search box is cleared; the
user re-expands by hand.

### A2 — Collapse state storage

A sibling of `listSearch`: a `listTagsCollapsed` state object keyed by the same
page names, in the same top-level component. Survives navigation, dies on reload.

This deliberately matches search rather than sort. Note that `/contexts/detail`
carries no id in its URL (`src/viewPaths.js:31`) — a reload lands on a context
view with no context selected — so reload persistence is moot on the page where
the bar is worst.

### A3 — What stays visible when collapsed

The active filter pill, if a filter is applied, plus the expand control. An
active filter that is invisible while still filtering would silently empty a list
with no visible cause.

When no filter is active, only the expand control shows.

### A4 — Ordering

`TagFilter` sorts alphabetically by tag name, ascending, using `localeCompare`.
Counts still render in each pill; only the ordering changes.

Card chips need no change — the stored arrays are already sorted, and the
existing render sites display stored order.

### A5 — Filter reset on navigation

`filterTag` currently persists across the three screens that share it. Clear it
when navigating between them, following the pattern already at
`src/Alfred.jsx:4477`. `collectionFilterTag` stays separate and untouched.

### A6 — Suggestion pool excludes archived

`tagPool` at `src/Alfred.jsx:1414` filters archived rows out of `items` and
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

`supabase/functions/email-capture/index.ts:207` and `src/Alfred.jsx:2836` both
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
9. `get_intents` with a `tags` filter returns matching intentions.

## Out of scope — captured separately

- **Post-limit filtering bug.** `searchItems` (`tool-handlers.ts:60`) and the
  `get_intents` tag filter (`tool-handlers.ts:245-251`) both filter a page of
  results rather than the table, so a match on row 51 is invisible at a limit of
  50. Real bug, unrelated to these changes, filed as its own Alfred item.
- **Context detail URL carries no id** (`src/viewPaths.js:31`). Already known,
  scheduled for a later routing slice.
- **Orphaned items.** Sixteen items have a null `context_id`; three point at
  context ids that no longer exist.
- **Card tag cap.** Staying at 3. Revisit only if it proves annoying in use.
