# Recipe → Collection

## Overview

From an item, add selected elements to a collection. The driving case: Alex and
Elise decide on BBQ bean salad, and the ingredients need to reach the Groceries
list in a few taps, on a phone, without leaving the recipe for long.

The feature is one new route reached from item detail. It shows the item's
collectable elements as a checkbox list, resolves each to a Shopping item,
and writes the checked ones into the chosen collection.

## Before you edit — two rules earned the hard way

**1. Every normaliser has a twin inside a dirty-check effect. Find it first.**

This codebase converts element shapes in several places, and each conversion has
a shadow copy inside an `isDirty` comparison that rebuilds the same baseline.
Patch one without the other and you get one of two failures: the state copy
keeps a key the baseline lacks, so the form reports permanent phantom "unsaved
changes"; or the mount copy strips a key that `handleSave` then writes back
whole, so the data is silently destroyed on save.

Three for three so far:

| Where | Copies | The twin that was missed |
|---|---|---|
| `InboxCard` suggestion maps | 4 | the dirty-check at ~5520 |
| `ItemCard` element editor | 2 | the `originalElements` baseline at ~8433 |
| `ItemCard` (again) | — | the mount normaliser stripped `collectable`, wiping it on every save |

Before editing any element normaliser: grep for the *behaviour*, count the
copies, and confirm which one lives inside an `isDirty` effect. Change them
identically, then verify they hash the same.

**2. The line numbers in this document are hints, not addresses.**

They have been wrong or incomplete three times — the file drifts, and the
original survey undercounted. Never patch by line number. Search for the
construct, enumerate every hit, and confirm the count before editing. If the
count disagrees with this document, the document is wrong: fix it and say so.

## Prerequisites (already done — do not redo)

- All 31 recipes in the Recipes context have real header elements, one
  purchasable product per ingredient line, and `collectable: true` on every
  ingredient bullet.
- `contexts.default_collection_id` exists (text, FK to `item_collections.id`,
  `ON DELETE SET NULL`). No context has a value set yet.
- `ai-enrich`, both MCP tool descriptions, and the `alfred-enrich` skill all
  enforce the element contract. Deployed.
- Groceries is `is_capture_target = true`.
- Rollback snapshot of all recipe elements lives in
  `backups.recipes_elements_backup_20260825`. Leave it alone.

## Data model

### Element keys

Two keys on an element in `items.elements`:

| JS key | DB key | Meaning |
|---|---|---|
| `collectable` | `collectable` | This element is a thing you can buy. Set on ingredient bullets only. |
| `collectableItemId` | `collectable_item_id` | The `items.id` this element resolves to in the collection's context. |

**`toSnakeCase` recurses into the elements array** — that is why the DB shows
`display_type` while the JS uses `displayType`. So `collectableItemId` lands in
Postgres as `collectable_item_id`, and every normaliser must read both spellings,
exactly as it already does for `displayType` / `display_type`. There are ~14
normalisation sites; the canonical one is `ItemCard`'s initial state.

**Do not reuse the existing `itemId` key.** `flattenElements` resolves `itemId`
references and rewrites the element's `displayType` to `"header"`, which would
silently corrupt every execution of the recipe. `collectableItemId` is a separate
key with no such behaviour.

No migration is needed for either key. `ItemCard.handleSave` writes `elements`
through whole, so new element-level keys persist automatically.

### Collection membership

Members are rows in `collection_items`, each pointing at a real `items.id`.
There is a unique index on `(collection_id, item_id)`. Collections cannot hold
free text — every ingredient must resolve to an item, created if absent.

## Behaviour

### Entry

A fifth button, **Add to Collection**, in `ItemDetailView`'s action row
(`flex flex-wrap justify-end gap-2`). It already wraps by design. `min-h-[44px]`,
visible fill or border per governing rule 5. Navigates to the new route.

The button is present on every item, not just recipes — the flag is generic and
a packing list should work the same way.

### The route

One page, not a modal. There is no shared modal component in the app, no focus
trap and no scroll lock, and the existing "Add Items to Collection" surface is
already a full route. Matching it.

- View name: `item-add-to-collection`
- Path: `/memories/add-to-collection`
- Add to `VIEW_TO_PATH` in `src/viewPaths.js` and to `DETAIL_VIEW_STATE` in
  `Alfred.jsx` keyed on `selectedItemId`, so a cold load redirects to the parent
  rather than rendering an empty page.

Layout, top to bottom:

1. Back button. Returns to item detail.
2. Collection `<select>`, defaulted per below.
3. The element list.
4. Sticky footer: `Add (N) to Collection` / `Cancel`, at `bottom-28 sm:bottom-32`
   to clear the Capture bar.

**The list does not scroll internally.** An earlier draft of this spec capped it
at `maxHeight: 50vh` with its own scrollbar, matching `CollectionAddItems`. That
was wrong: an inner scroller nested inside the page scroller is unusable on a
phone, and a 32-row recipe squeezed into a half-screen box is the case that
breaks it. The page scrolls once. The sticky footer, which `CollectionAddItems`
notes "will rarely engage", now genuinely does — which is what it is for.

### Default collection

Preselect in this order: the item's context's `default_collection_id`; else the
first `is_capture_target` collection in that context; **else the first
`is_capture_target` collection in any context**; else the first collection; else
nothing selected and the footer disabled.

The third rule was missing from the first draft and the feature does not work
without it. Groceries is the capture target but lives in Shopping, while recipes
live in Recipes — so rule two can never match for the driving case, and an
arbitrary "first collection" would win. A capture target anywhere beats an
arbitrary collection.

**The `<select>` offers every non-archived collection, unfiltered by context.**
A recipe lives in Recipes; its groceries go to a Shopping-context collection, so
filtering by the item's context would hide exactly the collection the user wants.
Earlier drafts of this line tried to express that as a filter and only managed a
tautology ("collections whose contextId matches the collection's own context").
There is no filter.

### Which elements appear

- If the item has any elements with `collectable`, show only those.
- If it has none, show every `bullet` element, so an un-annotated item still
  works. Checking a row in this state sets `collectable: true` on it.

Headers, steps, and notes bullets never appear when collectable flags exist.

### Resolving an element to an item

Each row resolves its element text to an item in the target collection's context.

Parse the ingredient line into a quantity and a product:

- `"1/4 cup coarsely chopped fresh basil"` → qty `1/4 cup`, product `basil`
- `"8 oz smoked Gouda, small dice"` → qty `8 oz`, product `smoked Gouda`
- `"Salt"` → qty empty, product `Salt`

Rules: strip a leading numeric quantity (including fractions, ranges like `2-3`,
and unicode fractions) plus a unit token if present; drop a trailing preparation
clause after the last comma; drop parentheticals. Keep the result's original
capitalisation.

**Testing a trailing clause for preparation:** peel any leading adverbs
(`finely`, `thinly`, `roughly`, `coarsely`, `freshly`, `lightly`) and size words
(`small`, `medium`, `large`) off the clause *first*, then test the next word
against the preparation vocabulary (`diced`, `dice`, `chopped`, `grated`,
`sliced`, `minced`, `crushed`, `rinsed`, `peeled`, `torn`, `toasted`, …).

The peel is what makes the worked example above come out right: `", small dice"`
starts with "small", not with a participle, so testing the first word alone would
keep it and yield `smoked Gouda, small dice`. It is also what keeps
`", skin-on chicken thighs"` and `", or mushroom stock"` — neither reduces to a
preparation word, so both survive as part of the product.

Product-defining modifiers are deliberately **not** preparation: `smoked`,
`dried`, `ground`, `roasted`, `salted` all survive, because smoked Gouda is a
different purchase from Gouda.

Then match the product against non-archived items in the target context:
case-insensitive exact match on name first, then a normalised match ignoring
plurals and punctuation, then a token-overlap match. First hit wins. Matching is
a pure function — put it in `src/utils/ingredientMatch.js` with unit tests, not
inline in the component.

**If the element already has `collectableItemId`, skip matching entirely and use
it.** That is the whole point of storing it: the second time you cook something,
the page is already right.

### Each row shows

- Checkbox, unchecked by default. Nothing is pre-checked in v1.
- The full original element text, so the user can see what the recipe asked for.
- The resolved target: either an existing item name, or `Create "basil"` when
  nothing matched.

  **Create-new is the common case, not the exception.** Measured on the real
  corpus at Step 3, 260 of 473 collectable elements (55%) resolve to nothing and
  must create an item. So creating must cost **one tap on the row itself** — the
  checkbox alone is enough to commit to creating it. No confirmation step, no
  dialog, no detour into a picker. A flow that treats creation as the exception
  gets the majority case wrong.

- **On every create-new row, show the near-misses as accept-in-one-tap
  suggestions.** These are the candidates that directional tier-3 matching
  rejected: items whose name shares the product's head noun but is not contained
  in it — `Salt` and `Sea salt` for the product `kosher salt`, `Juice` for
  `lemon juice`.

  Without this the Shopping catalogue silently accumulates `Salt`, `kosher salt`
  and `Sea salt` as three separate items, which is the failure the directional
  restriction on tier 3 trades away rate to avoid. Rejecting a bad *automatic*
  match is right; hiding the candidate from the user is not. Show at most three,
  **closest first — most shared tokens, then the tightest name**, so `kosher
  salt` offers `Salt` ahead of `Sea salt`. An earlier draft said "most specific
  first", which is backwards: consolidating onto the generic item is the entire
  point, and ranking the more specific name first works against it. Each accepts
  in one tap, retargeting *and* checking the row.

  A shared head noun alone is too weak a test once the product has several
  words — it offered `Tomato Paste` for `vanilla bean extract or paste`. A
  majority of the product's own tokens must be shared.

  **API shape: a second export, `findNearMisses(product, items, opts)`, not an
  options flag on `matchProduct`.** A flag would make `matchProduct`'s return
  type depend on its arguments — today it is documented as `item | null`, and
  every existing call site relies on that. Near-misses are only needed on the
  minority of rows that failed to match, so paying for them should be opt-in at
  the call site by calling a different function. Keep `matchProduct` single
  purpose; it returns the answer, `findNearMisses` returns the alternatives.
- A quantity input, prefilled from the parsed quantity, editable. `w-20 sm:w-24`,
  `placeholder="Qty"`, matching the other three quantity inputs in the app.
- A way to change the resolved target — reuse the existing item picker pattern
  from `InboxCard`.

### Bulk selection

A header above the list shows `N of M selected` and a single toggle:
**`Select N existing`** / **`Select none`**.

**It selects only rows that already resolve to an existing item** — matched
automatically, or promoted by accepting a near-miss suggestion. Create-new rows
are excluded, and each stays one deliberate tap.

The reason is catalogue integrity, which is the same concern the near-miss
suggestions exist to serve. A create-new row mints a new item in the target
context; fifteen uninspected new items in a single tap is precisely how a
shopping catalogue fills with junk nobody looked at. Bulk-selecting *matched*
rows is safe because those resolve to items that already exist and have already
been reviewed once.

**The label must name what it does.** A plain "Select all" would be a lie — it
would claim to select every row while deliberately skipping some, and the user
would not discover the difference until the create-new rows failed to appear in
the collection. `Select N existing` states both the count and the restriction. A
second line appears only when create-new rows are present: "Rows that create a
new item are not included — tap those individually."

`Select none` clears everything, including any create-new rows selected by hand.
The button is hidden entirely when no row resolves to an existing item.

### Ordering

Unmatched rows first, then matched rows in recipe order. Unmatched rows are the
ones needing a decision; recipe order is familiar because the user was just
reading it.

Do **not** rank by purchase frequency. `collection_item_removals` tops out at
four removals for a single item and most sit at one — not enough signal, and
"bought often" is a different question from "needed now".

### On Add

For each checked row, in one pass:

1. Create the item if the row is a create-new. Shape follows the existing
   on-the-fly path in `CollectionAddItems`: `contextId` from the collection,
   empty `elements` and `tags`, `isCaptureTarget: false`, and `storage.set`'s
   shared flag from `context?.shared`.
2. Write `collectable: true` and `collectableItemId` back onto the source
   element, so the next visit skips matching. One save of the item's `elements`,
   not one per row.
3. Add or merge the membership row.

Then navigate back to item detail on success. **On failure, stay on the page** so
the selection is not lost — `CollectionAddItems` does this deliberately.

### Duplicates and quantity

`addMembers` currently upserts with `ignoreDuplicates: true`, so a re-add is
silently skipped and the `skipped` count is surfaced to the user. That is wrong
for this feature: adding BBQ bean salad and then a second recipe that also needs
limes should combine them.

Add `addOrMergeMembers(collectionId, entries, {userId})` to
`src/utils/collectionMembers.js`. It reads existing members for the collection,
then per entry:

- Not present → insert, appended at the end via the existing `nextPosition`.
- Present, existing quantity null or empty → set the new quantity.
- Present, new quantity null or empty → leave existing untouched.
- Both present → concatenate with ` + `, e.g. `2 cans + 1 lb`.
- Both present and identical strings → leave as-is rather than doubling the text.

**No arithmetic.** Quantity is free text and always has been; `2 cans` and
`1 lb` have no sum. Concatenation is the decision.

The module contract is absolute: every export returns `{ data, error }` and never
throws for an expected failure, because `withLoading` swallows exceptions without
rethrowing and a thrown error is invisible to the user. Follow it.

### Poll interference

The 5-second membership poll only runs on `collection-detail`, so this route is
unaffected. But if any write lands while the user has navigated back, bump
`memberWriteInFlight` the way `saveMemberQuantity` and `saveMemberOrder` do.

### Back navigation

Collection detail and item detail both lean on `previousView`, the one shared
return slot the codebase documents as clobberable. Item detail also keeps
`itemHistoryStack`. Set the return address explicitly when entering this route
and verify that back lands on the source item, not on Memories.

## Also in scope

- **`InboxCard` parser** — three duplicated inline maps (~5265, ~5341, ~5685)
  convert `{type, text}` to `{name, displayType, quantity, description}` and drop
  every other key. Add `collectable` pass-through, or enrichment can never set it.
  The three copies must stay identical; the third is a dirty-check comparison and
  will report false "unsaved changes" if it diverges.
- **`ItemCard` element editor** — a `collectable` checkbox on bullet rows, so
  flags can be fixed by hand. Bullet rows only; meaningless on headers and steps.
- **Collection form** — an `is_capture_target` checkbox. The column exists and
  `ai-enrich` reads it, but there is no UI for it, so the only way to set a field
  the enricher depends on is raw SQL.
- **`ContextForm`** — a Default Collection `<select>`. Save runs through four
  layers of **positional** arguments (`ContextForm` → `saveContext` →
  `saveContextRecord`, plus `ContextDetailView`'s own `onSave`); every one must
  change, and the new field must join the `isDirty` comparison. Offer only
  **every non-archived collection, unfiltered by context.** A default collection
  names where a context's items *go*, which is normally a different context:
  ingredients belong in Shopping with the other products, not polluting Recipes.
  An earlier draft of this spec restricted the dropdown to same-context-or-null
  and that broke the feature's own driving case — Recipes could not point at
  Groceries. The database has never enforced same-context and should not; the
  column comment in Postgres already gives `Recipes -> Groceries` as the
  motivating example.

## Out of scope

- **Learned check state.** Remembering which ingredients were checked last time
  and pre-checking accordingly. Genuinely better than any ranking, and cheap once
  the mapping key exists — but ship v1 first and find out whether it is needed.
- Structured or unit-aware quantities.
- An MCP write tool for collection membership. No tool writes `collection_items`
  today and none should as part of this.
- Any change to `backups.recipes_elements_backup_20260825`.

## Success criteria

1. From BBQ Bean Salad on a phone, a **typical** add reaches Groceries in under
   five taps, with sensible quantities carried across. Measured: 3 taps — open
   the picker, **Select N existing**, Add. Groceries is preselected, so choosing
   the collection costs nothing.

   The original wording said "ingredients reach Groceries in under five taps"
   without qualification, which was self-contradictory: rows are unchecked by
   default (a deliberate v1 decision stated elsewhere in this spec), so N
   ingredients cost at least N taps. BBQ Bean Salad has 15 collectable rows and
   would have needed 17. The target is a typical add, not every possible recipe.

   Adding *every* row of a 15-ingredient recipe costs 8 taps, because the 5
   create-new rows are excluded from bulk selection by design — see below.
2. Cooking the same recipe a second time skips all matching — every row already
   resolved.
3. Adding limes from two different recipes yields one row reading `6 + 3`, not
   two rows and not a silent skip.
4. An item with no collectable flags still works, and annotates itself on use.
5. Back from the picker lands on the source item.
6. `check_platform_conformance` still returns CONFORMANT.
