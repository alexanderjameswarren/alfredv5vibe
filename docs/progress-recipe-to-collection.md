# Progress: Recipe → Collection

## Status: Steps 1-9 verified. Step 10 verified statically; awaiting a device run.

Spec: `docs/technical-spec-recipe-to-collection.md`

One step per prompt. Alex verifies in the running app before the next step
begins. Do not batch steps.

### Development Steps

- [x] **Step 1 — Parser pass-through.** Carry `collectable` through the
      duplicated `{type, text}` maps in `InboxCard`. **There are four, not
      three** — 5399 (initial `useState`), 5477 (sync effect), 5520
      (dirty-check comparison), 5823 (reset-to-suggestions). All four must
      stay identical; the dirty-check copy is 5520.
      *Verify:* enrich a capture with a collectable element, open triage, save,
      confirm the flag survives into `items.elements` and that the form does not
      report false unsaved changes.

- [x] **Step 2 — Element editor checkbox.** A `collectable` checkbox ("Can buy")
      on bullet rows in `ItemCard`'s element editor. Bullet rows only. Also
      fixed the two `ItemCard` rebuilds (8408 mount normaliser, 8433
      dirty-check baseline) that were stripping the flag.
      *Verify:* toggle it on a recipe ingredient, save, reopen, confirm it stuck
      and that no other element changed.

- [x] **Step 3 — Ingredient parsing and matching.** New
      `src/utils/ingredientMatch.js` + `ingredientMatch.test.js`: split an
      ingredient line into quantity and product, match a product to an item in a
      context. Pure functions, 43 tests, no UI. Fixtures are real corpus lines.
      Measured match rate: **213 / 473 (45.0%)** against the 215 Shopping items.
      *Verify:* tests pass, including the spec's three worked examples plus
      `"2-3 dried chipotles"`, `"1 small clove garlic, grated"`, and
      `"Salt and black pepper"` (which should no longer exist in the data).

- [x] **Step 4 — Merge-aware membership write.** `addOrMergeMembers` in
      `src/utils/collectionMembers.js`, following the module's
      `{ data, error }` / never-throw contract. 15 tests in
      `collectionMembers.test.js` (Supabase mocked at the module boundary).
      *Verify:* from the existing Add Items flow, add an item already on the
      list with a quantity; confirm one row with concatenated quantity, not a
      skip and not a duplicate.

- [x] **Step 5 — Route scaffolding.** `item-add-to-collection` in
      `VIEW_TO_PATH` (`/memories/add-to-collection`) and `DETAIL_VIEW_STATE`
      (keyed on `selectedItemId`); the Add to Collection button in
      `ItemDetailView`'s action row; an empty page that renders and returns.
      *Verify:* button appears and wraps correctly at phone width; page loads;
      back lands on the source item; a cold load of the URL redirects to the
      parent instead of rendering empty.

- [x] **Step 6 — The picker.** `ItemAddToCollection` in `Alfred.jsx`: collection
      `<select>` with defaulting, element list capped at 50vh, resolution
      display, quantity prefill, frozen ordering (unmatched first, then recipe
      order), near-miss suggestion chips, change-target modal, inert sticky
      footer. `findNearMisses` added to `ingredientMatch.js` with 7 tests.
      No writes.
      *Verify:* open BBQ Bean Salad, confirm every ingredient appears with a
      sensible product and quantity, unmatched ones sort to the top, and the
      50vh list scrolls independently on a phone.

- [x] **Step 7 — The write path.** `addElementsToCollection` in `Alfred.jsx`:
      create-new items (deduplicated by name within a submission), write
      `collectable` and `collectableItemId` back to the source elements in one
      save, add or merge membership via `addOrMergeMembers`, navigate back on
      success and stay put on failure.
      *Verify:* add five ingredients to Groceries; check the collection; reopen
      the recipe's picker and confirm every row is now pre-resolved.
      **Also, carrying debt from Step 4:** add an ingredient that is *already* on
      Groceries with a quantity, and confirm the live database ends with **one**
      row holding a concatenated quantity — not a duplicate row and not a silent
      skip. `addOrMergeMembers` has never run against a real database; its tests
      mock PostgREST and encode an assumption about how `upsert(...).select()`
      behaves with `ignoreDuplicates: true`. Those tests pass whether or not that
      assumption is correct. This is the check that settles it.

- [x] **Step 8 — Default collection.** `default_collection_id` through
      `ContextForm` → `saveContext` → `saveContextRecord`; `ContextDetailView`
      forwards with `(...args)` and needed no change. Added to the `isDirty`
      comparison. Preselection was already implemented at Step 6.
      *Verify:* set Recipes → Groceries, open any recipe's picker, confirm
      Groceries is preselected. Confirm editing a context and changing nothing
      still reports clean.

- [x] **Step 9 — Capture target checkbox.** `is_capture_target` in the
      collection form, below Pin to home, with a line explaining what the flag
      does.
      *Verify:* toggle it on Trader Joe's, confirm it persists, then toggle it
      back off.

- [~] **Step 10 — End-to-end.** Verified statically; **the run on real hardware
      has not happened.** Criteria 2, 3 and 5 were confirmed live during earlier
      steps; 1 is met by measurement after adding bulk selection; 4 is verified
      in code only; 6 is Alex to run.
      *Still to do:* full run on a phone, plus a second recipe sharing an
      ingredient with the first.

### Notes

Traps recorded during design — read before the step they touch:

- `toSnakeCase` recurses into `elements`, so `collectableItemId` is
  `collectable_item_id` in Postgres. Readers handle both. (Steps 1, 7)
- Never reuse the `itemId` element key — `flattenElements` rewrites those
  elements to `displayType: "header"` inside every execution. (Steps 6, 7)
- `collectionMembers.js` exports never throw for expected failures;
  `withLoading` swallows exceptions silently. (Step 4)
- `addMembers` upserts with `ignoreDuplicates: true` — do not build merge on top
  of it without handling that. (Step 4)
- Seven detail views redirect to their parent on cold load because ids are not
  yet in URLs; the new route must join `DETAIL_VIEW_STATE` or it will render
  blank. (Step 5)
- `previousView` is a single shared slot any navigation can clobber. (Step 5)
- Governing rule 5: actions carry a visible fill or border. Rule 1: record
  actions live top-right. (Step 5)
- Sticky footers sit at `bottom-28 sm:bottom-32` to clear the Capture bar; the
  two numbers mirror the main wrapper's padding and move together. (Steps 6, 8)

### Step 1 notes (completed)

- **The spec undercounted the maps.** It lists three sites (~5265, ~5341,
  ~5685) and calls the third a dirty-check comparison. With the +134 line
  drift since the survey those map to 5399, 5477 and 5823 — and 5823 is the
  *reset-to-suggestions* handler, not the dirty check. The real dirty check
  is a fourth copy at 5520 that the survey missed entirely. Updating only the
  three listed sites would have produced exactly the false "unsaved changes"
  bug the spec warns about, because 5520 would rebuild its baseline without
  `collectable` and never match state. All four were updated identically.
  Worth correcting in the spec's "Also in scope" section.
- **Used a conditional spread**, `...(el.collectable ? { collectable: true } : {})`,
  rather than `collectable: el.collectable`. A plain assignment materialises
  `collectable: undefined` on every header and step; the spread leaves
  non-ingredient elements byte-identical to their current shape, which is the
  conservative choice in a code path a dirty check depends on. It also
  normalises any truthy value to boolean `true`.
- **Only the `el.name` false branch needed changing.** When `el.name` is
  already set the element passes through whole, so that branch preserved
  `collectable` before this change.
- `collectable` is spelled the same in JS and Postgres, so unlike
  `collectableItemId` it needs no dual-spelling read here.
- Verified: all four map bodies hash identically; the file parses under the
  project's Babel preset; and a simulation confirms no false-dirty on load for
  both annotated and legacy (unannotated) elements.
- **Verified in the app 2026-08-26.** The first verification attempt showed a
  false "unsaved changes" dialog, but the cause was a **stale dev bundle**, not
  a code fault — a browser reload cleared it. *If a future step fails
  verification, rule out the build before reading the code:* hard-reload
  (Ctrl+Shift+R), and if that fails restart `npm start`. CRA's dev server can
  serve a stale chunk after a large edit to `Alfred.jsx`, which is a 10k-line
  single file and therefore especially prone to it.

### Step 2 notes (completed — verified in the app 2026-08-26)

- **Full write trace of `ItemCard`'s elements state (nine sites).** Only two
  rebuild from a fixed field list: the mount normaliser (~8408) and the
  `originalElements` baseline inside the dirty-check effect (~8433). The other
  seven — cancel-reset, addElement, insertElementAbove, updateElement,
  the name-overflow split, deleteElement and the drag reorder — either spread
  the existing element or move whole references, so they preserve unknown keys.
  All four editor inputs (display-type, name, quantity, description) and both
  item-link buttons funnel through `updateElement` / `handleElementNameChange`,
  both of which spread. **The predicted edit-time strip does not exist.**
- **The real bug was worse and pre-existing.** Because the mount normaliser
  stripped `collectable` and `handleSave` writes `elements` state whole, simply
  opening an item in `ItemCard` and saving it wiped the flag from every element.
  That was live before this step and would have silently de-annotated the 31
  recipes on the next edit of each. Fixed by the same conditional-spread
  pass-through used in Step 1. `toSnakeCase` is not implicated — it enumerates
  all keys and preserves unknowns.
- **The survey missed a paired site for the third time.** Step 1: the dirty
  check at 5520. Step 2: the dirty-check baseline at 8433. The pattern is
  consistent — every place this codebase normalises elements has a twin inside
  an `isDirty` effect, and the twin must be edited identically or the form
  reports false "unsaved changes". Check for the twin first in later steps.
- **Display-type change clears the flag.** Changing a row away from `bullet`
  deletes `collectable`, handled centrally in `updateElement`. Chosen because
  the checkbox only renders on bullet rows: a flag left on a header or step
  would be invisible and unclearable, yet would still surface that row in the
  Add to Collection picker (Step 6 shows "elements with collectable"). Changing
  back to bullet leaves the row unticked rather than restoring the old value.
- **Unticking sets `undefined` rather than `false`**, matching the existing
  item-link unlink at ~8803 (`updateElement(index, "itemId", undefined)`).
  `JSON.stringify` drops undefined keys, so the dirty check stays honest and no
  dead `collectable: false` keys reach the database.
- Label is "Can buy" with a title tooltip, deliberately not phrased as a display
  option. `min-h-[44px]` on the label for the mobile touch target.

### Step 3 notes (completed — verified 2026-08-26; 45% and the directional tier-3 restriction both accepted)

- **Match rate on the real corpus: 213 of 473 collectable elements (45.0%)**
  resolve to an existing Shopping item; 260 (55.0%) return null and would create
  a new item. By tier: 111 exact name, 12 plural/punctuation, 90 token
  containment. Measured over every collectable element in the Recipes context,
  not a sample.
- **Fixtures are real.** All test cases except the spec's three worked examples
  are literal lines pulled from the Recipes context via
  `npx supabase db query --linked`. The corpus supplied the awkward shapes:
  unicode fractions (¼, ½), en-dash ranges (`2–3`), dual units
  (`750g / 1.5 lb`), additive quantities (`3/4 cup + 1 tbsp`), 129 lines with
  parentheticals and 169 with commas.
- **The spec's trailing-clause rule does not produce the spec's own example.**
  It says drop the clause "when it starts with a participle (diced, chopped,
  …)", but the worked example `"8 oz smoked Gouda, small dice"` → `smoked Gouda`
  requires dropping `", small dice"`, which starts with "small". Resolved by
  peeling leading adverbs and size words off the clause before testing the first
  word against the preparation vocabulary. Both the rule and the example now
  hold. **The spec text should be corrected.**
- **Tier 3 is one-directional, deliberately.** Allowing the reverse containment
  (product tokens ⊆ item tokens) raises the rate to 48.6% but adds 36 matches of
  which roughly 21 are wrong: `water → Soda water` (×8), `ginger → Ginger ale`,
  `beer → Root Beer`, `red wine → Red Wine Vinegar`, `onion → Green onion` (×3),
  `sugar → Brown sugar`. Precision beats rate here because a wrong match puts
  the wrong product on a real shopping list. 45.0% with the strict rule is the
  chosen trade. There is a regression test for the water case.
- **Head-noun requirement** stops `chicken stock` collapsing onto `Chicken`.
- **Known tier-3 false positives that survive**, worth a decision at Step 6:
  `black pepper → Peppers` (~17 occurrences), `lemon juice → Juice` (×6),
  `cayenne pepper → Peppers`. These are lexically indistinguishable from correct
  matches like `ground cumin → Cumin` without food knowledge. Mitigation: the
  picker shows the resolved target on every row and lets the user change it, so
  these are visible and correctable rather than silent.
- **Product-defining modifiers are kept, preparation is stripped.** "smoked",
  "dried", "ground", "roasted", "salted" survive because smoked Gouda is a
  different purchase than Gouda; "chopped", "diced", "toasted" etc. do not.
- **Trailing quantities are captured, not discarded** — `"Limes x6"` yields
  quantity `x6`, `"Olive Oil 1 cup"` yields `1 cup`. Several Recipes lines are
  written in this shopping-list style.
- Data pulled read-only with `npx supabase db query --linked`. Nothing written;
  `backups.recipes_elements_backup_20260825` untouched.

### Step 4 notes (completed)

- **`addOrMergeMembers(collectionId, entries, { userId })`** returns
  `{ data, error, inserted, merged, unchanged }`. `data` is every affected
  member row; the three id arrays say what happened to each entry. No throw path
  for an expected failure — every branch returns through `ok`/`fail`, matching
  the module contract, because `withLoading` swallows exceptions and the user
  would otherwise believe the write succeeded.
- **The `ignoreDuplicates` trap is handled explicitly.** Inserts still go through
  `addMembers`, so `ON CONFLICT DO NOTHING` still applies — but anything it
  reports as `skipped` became a member between our read and our write. Those ids
  are re-read and merged on a second pass. Without that pass a concurrent add
  from another device silently discards this caller's quantity, which is the
  exact bug the spec warns about. There is a test that simulates the race.
- **Repeats within one call are collapsed before any write.** Two ingredients
  resolving to the same item (limes twice in one recipe) merge with each other
  first, so one row is written, not two, and no quantity is lost.
- **Merge table**, all free text, no arithmetic: absent → insert; existing empty
  → take new; new empty → leave existing; identical (whitespace-insensitive) →
  leave as-is; otherwise concatenate with `" + "`. `"2 cans"` + `"1 lb"` →
  `"2 cans + 1 lb"`.
- **Partial failure is reported, not swallowed.** If a merge update fails after
  some writes landed, the error message states how many inserts and merges
  completed first, and the id arrays carry the detail — otherwise the user
  cannot reconcile the error with what they can see on the list. Mirrors how
  `removeMembers` reports its own half-done state.
- `mergeQuantities` and `collapseEntries` are deliberately **not** exported: the
  module contract is that every export returns `{ data, error }`, and a pure
  helper returning a string would break it. They are covered through
  `addOrMergeMembers`.
- Full suite green: 347 tests, 17 suites.

### Spec amendments recorded this step

- **Trailing-clause rule corrected** to match the Step 3 implementation: leading
  adverbs and size words are peeled off the clause *before* testing the next
  word against the preparation vocabulary. That is what makes the spec's own
  `"8 oz smoked Gouda, small dice"` example come out right while keeping
  `", skin-on chicken thighs"`.
- **Step 6 amended**: create-new is the common case (55% of elements), so it
  must cost one tap on the row — no dialog, no detour. Every create-new row also
  surfaces the tier-3 near-misses that directional matching rejected, as
  one-tap-accept suggestions, to stop the Shopping catalogue accumulating
  "Salt" / "kosher salt" / "Sea salt" as three items.
- **Near-miss API: a second export, `findNearMisses(product, items, opts)`**,
  not an options flag on `matchProduct`. A flag would make `matchProduct`'s
  return type depend on its arguments — it is documented as `item | null` and
  every call site relies on that. Near-misses are needed only on rows that
  failed to match, so paying for them should be opt-in by calling a different
  function. To be implemented in Step 6.

### Step 5 notes (completed — verified in the app 2026-08-26)

- **Return address: neither mechanism. Back is a bare `setView("item-detail")`.**
  - `previousView` holds where *item detail itself* came from. Overwriting it on
    the way in would destroy that address, so Back from the item would then land
    on this page instead of Memories — the exact clobbering the spec warns about.
  - `itemHistoryStack` is a stack of *item ids* for item-to-item navigation.
    This is a side trip on the same item, so pushing to it would make Back from
    the item pop to itself.
  - Neither is needed: `selectedItemId` is untouched by this navigation and the
    view is keyed on it in `DETAIL_VIEW_STATE`, so the item is still there.
    This is exactly what `collection-add-items` already does — it returns with a
    bare `setView("collection-detail")` and leans on `selectedCollectionId`.
    Following the established precedent rather than inventing a third pattern.
- **The twin-site rule caught a shadow assertion again — fourth time.**
  `viewPaths.test.js` hard-codes the view count (`toHaveLength(19)`) and the
  detail-path count (`toHaveLength(7)`). Adding a 20th view breaks both. Updated
  to 20 and 8. Anyone adding a route must update these two numbers; they are not
  derived. The new path satisfies the suite's structural rules: lowercase
  (`/^\/[a-z-/]*$/`), unique, round-trips, and its parent `/memories` is a real
  cold-loadable view.
- **Button placed before Archive, not after.** The spec says "fifth button", but
  the action row's own comment documents the order as ending in the destructive
  action. Destructive-last outranks append-at-the-end, so Add to Collection sits
  between Edit and Archive. `bg-secondary` fill matching Clone and Edit,
  `min-h-[44px]`, `ClipboardList` icon (already imported). Label collapses to
  "Collect" under `sm:` like its neighbours.
- Button is rendered on **every** item, not just recipes — `collectable` is a
  generic flag and a packing list should work the same way.
- Verified: full suite 347/347 green, and `react-scripts build` compiles
  successfully (+320 B).

### Step 6 notes (completed)

- **`findNearMisses(product, items, opts)` shipped as a second export**, as
  decided at Step 4. `matchProduct` keeps its `item | null` contract and every
  existing call site is untouched. A near-miss is an item sharing the product's
  head noun that containment rejected — the same head-noun test tier 3 uses, so
  these are precisely the candidates directional matching threw away, not loose
  keyword hits. Deduplicated by normalised name (the real Shopping context has
  genuine duplicates), capped at 3, ranked closest-first.
- **Ranking is generic-first, not "most specific first" as the spec says.** For
  the product `kosher salt` the order is `Salt` then `Sea salt`. Consolidating
  onto the generic item is the entire point of the feature; surfacing the more
  specific name first would work against it. The spec line should be corrected
  to "closest first: most shared tokens, then the tightest name".
- **A shared head noun alone proved too weak.** On the real corpus it suggested
  `Tomato Paste` for `vanilla bean extract or paste` and `Green onion` for
  `Crispy fried onions`. Now a majority of the product's own words must be
  shared (`shared * 2 >= productTokens`). Suggestion coverage fell from 35% to
  25% of create-new rows and the remaining suggestions are all plausibly the
  same product. 75% of create-new rows show no chips at all, which keeps the
  list quiet.
- **The accepted 45% match rate is unchanged** (213/473 re-measured after this
  step's edits). `findNearMisses` is purely additive and the threshold only
  affects suggestions, never `matchProduct`.

#### Interaction decisions

- **Create-new costs one tap: the row checkbox is the commitment.** No dialog,
  no confirmation, no detour. A create-new row differs from a matched row only
  by a dashed border and `Create "basil"` where the item name would be.
- **Suggestion chips retarget *and* check the row in one tap**, so accepting a
  suggestion is also one tap rather than two.
- **Row ordering is frozen at resolution time.** It is computed from the initial
  resolve and deliberately does not depend on user overrides, because re-sorting
  when a row stops being "unmatched" would move rows out from under a thumb
  mid-tap. Ordering only recomputes when the collection changes.
- **Changing collection resets all row state.** Targets are context-specific, so
  carrying them across would leave stale cross-context targets.
- **`collectableItemId` short-circuits matching**, per the spec, so a second
  visit is pre-resolved. Nothing writes it until Step 7, so it is currently
  always absent.

#### Mobile trade-offs

- **Two lines per row, not one.** Element text wraps on its own line; target and
  quantity share the line beneath. One line would have forced truncating the
  recipe text, which is the one thing the user needs to read to decide.
- **Target name truncates rather than wrapping**, so quantity stays put and rows
  keep a predictable height. Full text is visible in the change-target modal.
- **Suggestion chips only render on create-new rows**, and only 25% of those, so
  the common row stays two lines.
- **Everything tappable is `min-h-[44px]`** except the suggestion chips, which
  are `min-h-[32px]` — they are secondary, and full height would push the list
  past a phone screen. Flagged as the one deliberate deviation from the 44px
  rule.

#### Deviations to review

- **Defaulting adds a third rule the spec does not have:** item context's
  `default_collection_id` → capture target in that context → **any capture
  target** → first collection. Without the third rule the driving case never
  fires: Groceries is the capture target but lives in Shopping while recipes
  live in Recipes, so rule two cannot match and an arbitrary first collection
  wins. Preferring a capture target anywhere over an arbitrary one is strictly
  better, but it is not what the spec says.
- **The collection `<select>` offers every collection.** The spec's phrasing —
  "collections whose contextId matches the collection's own context or is null"
  — is tautological as written; every collection matches its own context. The
  operative clause is "not the item's context", so no filtering is applied.
- **Two tier-3 false positives are visible in the driving case**, not just in
  the aggregate: BBQ Bean Salad resolves `2 tbsp lemon juice` to **Juice** and
  `1/2 tsp ground black pepper` to **Peppers**. Both are one tap to correct via
  the change-target control, but both are wrong by default. Still needs a call.
- **Parser gap surfaced by the driving case:** `Salt for the bean water
  (~1 tsp per quart)` yields the product `Salt for the bean water`. The
  parenthetical is stripped but the trailing purpose phrase is not, so it would
  create a junk item — and the same recipe separately yields `salt` from
  `1/4 tsp salt`. Stripping a trailing `for ...` phrase would fix it, but that
  changes `parseIngredient`, whose 45% was accepted at Step 3, so it is not
  applied unilaterally.

- Verified: full suite 354/354, `react-scripts build` compiles clean.

### Step 6 follow-ups (UI review) — applied

- **50vh cap removed.** The list no longer scrolls internally; the page scrolls
  once and the sticky footer genuinely engages. Spec corrected.
- **Trailing `for …` strip.** `"Salt for the bean water (~1 tsp per quart)"` now
  yields the product `Salt`. All 15 corpus lines containing " for " were checked
  individually — no collateral loss.
- **Tier 3 demote applied**, as instructed. A candidate matching only the final
  word of a multi-word product is demoted to a near-miss; one matching a
  non-final token or the whole product still wins.
- **`Juice of N limes` regression fixed at the parser, not the matcher.** A
  leading extraction phrase (`juice|zest|squeeze|splash|pinch|handful|dash|
  drizzle|grating` + `of`) is stripped before quantity extraction, so
  `"Juice of 3 limes"` parses to quantity `3`, product `limes`. What you buy is
  limes. This also rescued `"Squeeze of lemon"`, which demote would otherwise
  have cost.
- **`-ly` adverbs generalised** rather than enumerated: a token ending in `-ly`
  followed by a preparation word is stripped. `"diagonally sliced celery"` now
  reduces to `celery` and matches, instead of becoming a junk create-new.
- **Rate: 45.2% → 42.3%** (200/473). The drop is the intended cost of demote.

#### Measured before committing

63 of the 90 tier-3 matches were head-noun-only. Demote eliminates ~22 wrong
defaults (18 of them pepper variants) and costs ~31 correct ones, which become
one-tap near-miss chips rather than disappearing. All four MUST-FIX cases pass;
of the three MUST-NOT-BREAK cases, `smoked Gouda` and `dried navy beans` hold and
`ground cumin` is the accepted casualty — it is now a create-new offering `Cumin`
as a one-tap chip.

**A majority-coverage guard was tried and reverted.** Requiring a candidate to
cover half the product's tokens fixed `chicken, beef, or mushroom stock →
Mushroom` but cost 18 other matches (42.1% → 38.3%). Not worth it for one fix.

**Known false positives that remain**, all from admitting non-head candidates
(which is what lets `poblano peppers` reach `poblano`): `rice vinegar → Rice`,
`Plain whole milk yogurt → Whole Milk`, `Mung bean sprouts → Mung beans`,
`chicken, beef, or mushroom stock → Mushroom`. These are structurally identical
to the poblano case — `[modifier][head]` where the item is the modifier — so no
structural rule separates them. Fixing them needs either world knowledge or
accepting the loss of the poblano fix.

### Step 7 notes (completed)

- **`addElementsToCollection(collectionId, sourceItem, picks)`** in `Alfred.jsx`.
  Three phases: create any new items, then ONE save of the source item's
  elements, then `addOrMergeMembers`. Returns true only if all three succeed.
- **Deliberately does not call `updateItem`.** That helper ends with
  `setItems(items.map(...))` over a closed-over snapshot, so calling it after
  creating items would drop the newly created ones from local state — they would
  exist in Postgres but vanish from the UI until a refresh. The handler writes
  through `storage.set` directly and updates state **once**, functionally,
  covering both the created items and the amended source item. This is the exact
  hazard `collectionMembers.js`'s own docstring warns about.
- **`storage.set` throws**; the `{ data, error }` contract does not apply to it.
  The create/stamp phase is wrapped in try/catch, and on failure the handler
  reports and returns false **before** touching membership, so a failed item save
  cannot leave membership rows pointing at items that were never created.
- **Create-new is deduplicated by normalised name within a single submission.**
  BBQ Bean Salad yields both `"Salt for the bean water"` → `Salt` and
  `"1/4 tsp salt"` → `salt`; without this, one recipe would mint two salt items,
  which is precisely the pollution the feature exists to prevent. First creation
  wins, the second reuses its id, and both elements are stamped to it.
- **On failure the page stays put** so the selection is not lost; navigation back
  happens only on success. The footer shows "Adding…" and is disabled while the
  write is in flight, so a double-tap cannot submit twice.
- New item shape matches `CollectionAddItems` exactly: `contextId` from the
  collection, empty `elements` and `tags`, `isCaptureTarget: false`, shared flag
  from `context?.shared`.
- Verified: 361 tests pass, `react-scripts build` compiles clean.

#### Step 4 debt — DISCHARGED 2026-08-26

`addOrMergeMembers` had never run against a real database; its tests mock
PostgREST and encode an assumption about how `upsert(...).select()` behaves with
`ignoreDuplicates: true`, and would have passed whether or not that assumption
held. **Verified live at Step 7:** adding an ingredient already on Groceries with
a quantity produced one row with a concatenated quantity — not a duplicate row
and not a silent skip. The assumption holds and the mocked tests are trustworthy.

### Step 8 notes (completed — verified in the app 2026-08-26, re-verified after the context-filter removal)

- **Three of the four layers needed an explicit change, not four.**
  - `ContextForm`'s `onSave(...)` call — sixth positional argument added.
  - `saveContext` — parameter added and forwarded.
  - `saveContextRecord` — parameter added, plus the field in **both** object
    branches (existing and new). Missing the new-context branch would have made
    the field silently unsettable on creation.
  - `ContextDetailView`'s `onSave` is `async (...args) => onSaveContext(context,
    ...args)`. A rest-spread is positionally transparent, so the new argument
    flows through untouched. **Editing it was unnecessary**; a comment now
    records why, so the next person does not "fix" it.
- **The chain was executed, not eyeballed.** A shifted positional argument
  produces no error — it writes the wrong value to the wrong column. Both paths
  were replicated in isolation and asserted field-by-field: every value lands in
  its own column, `""` normalises to `null`, and an omitted argument defaults to
  `null`.
- **`""` → `null` is load bearing.** `default_collection_id` is a text FK to
  `item_collections.id` with `ON DELETE SET NULL` (verified against the live
  schema). The `<select>`'s "None" option is `""`, which would violate the
  constraint. Normalised once inside `saveContextRecord`, the single point every
  caller funnels through, rather than at each call site.
- **The dirty-check twin** is `ContextForm`'s own `isDirty` effect. Added the
  field to both the comparison and the dependency array — omitting the latter
  would have made the check stale rather than wrong, which is harder to notice.
  Fifth consecutive instance of the twin pattern.
- **The `<select>` constrains what the database does not.** It offers only
  collections whose `contextId` matches the context being edited or is null;
  nothing in Postgres prevents a cross-context pointer.
- **A duplicate-prop trap, caught by the compiler.** `ContextDetailView` already
  declared `collections = []` in its parameter list and already received
  `collections={activeCollections}` at its render site — both further down than
  the section I first read. Adding them again produced an "Argument name clash"
  at build time. Reading the *first* 25 lines of a prop list is not reading the
  prop list. The existing `activeCollections` wiring is used instead, which is
  also the better source since it excludes archived collections.
- Preselection in the picker needed no work: the full defaulting order,
  including `default_collection_id`, was implemented at Step 6 and has been
  reading a field that was always null until now.
- Verified: 361 tests pass, `react-scripts build` compiles clean, live schema
  confirms the column and FK.

### Step 8 correction — context filter removed

- **The Default collection dropdown now offers every non-archived collection.**
  The same-context-or-null filter was wrong and broke the feature's own driving
  case: a default collection names where a context's items *go*, which is
  normally a different context. Ingredients belong in Shopping with the other
  products, not polluting Recipes. Recipes must be able to point at Groceries.
- **Corrected in the spec in both places** it appeared: the picker's collection
  `<select>` (which had only ever managed a tautology — "collections whose
  contextId matches the collection's own context") and the `ContextForm` bullet
  under "Also in scope".
- **The Postgres column comment needed no correction.** It already reads
  "the collection this context's items are added to by default — Recipes ->
  Groceries", which is explicitly cross-context. The database never enforced
  same-context and the comment never implied it; the restriction was invented in
  the spec alone.
- With the filter gone, `default_collection_id` becomes the primary path for the
  driving case and the Step 6 "any capture target" fallback becomes what it
  should be — a fallback for contexts that have not set the field.

### Step 9 notes (completed — verified in the app 2026-08-26)

- **`is_capture_target` checkbox added to the collection form**, below "Pin to
  home", with a one-line explanation: Alfred files new captures here by default,
  and it is preselected when adding an item's ingredients to a collection. The
  flag's meaning is not guessable from its name, and this is the first time it
  has ever been visible in the UI.
- **No positional hazard and no dirty-check twin here.** `updateCollection` takes
  an `updates` object rather than positional arguments, and the collection form
  saves inline on change rather than tracking dirty state — so unlike Step 8
  there was nothing to keep in sync. Confirmed by checking that the four
  `isDirty` effects in the file cover inbox, context, item and intention only.
- **Key case verified by round-trip**, since a silent mismatch here would write
  nothing: `isCaptureTarget` → `is_capture_target` → `isCaptureTarget`. Same
  check for `defaultCollectionId` → `default_collection_id`.
- Live schema confirms the column is `boolean` defaulting to `false`, with the
  comment "True = captures can be appended straight into this collection from
  the inbox." Groceries is currently the only row with the flag set, which is the
  raw-SQL edit this UI replaces.
- Verified: 361 tests pass, `react-scripts build` compiles clean.

### Step 10 — blocked on hardware, pre-flight complete

The end-to-end run needs a physical phone. Everything checkable without one has
been done; the run itself has not.

**Criterion 1 does not hold as written**, and this was found by counting the tap
path rather than by using it. BBQ Bean Salad exposes 15 collectable rows. The
path is: 1 tap to open Add to Collection, Groceries preselected via
`default_collection_id` (0 taps), then **one tap per row**, then 1 tap to Add.

- 3 ingredients = 5 taps
- all 15 = 17 taps

The spec asks for "under five taps". That is reachable only for two ingredients.
There is no select-all, and the spec explicitly says nothing is pre-checked in
v1, so per-row tapping is the only path.

**Recommendation: a Select all / Select none control in the list header.** It
takes the full-recipe case from 17 taps to 3, and does not contradict the
no-pre-checking decision because it stays an explicit user action. Not
implemented — it is a scope change, and Step 10 is a verification step.

**Touch-target fix applied during the audit.** The change-target modal's close
button was a bare 20px icon with no minimum tap size. Now 44x44 with an
`aria-label`. Every other interactive element in the picker was already 44px,
with one deliberate exception: the near-miss suggestion chips at 32px, a
considered trade to keep the list compact.

**Layout invariants verified statically:** the sticky footer's
`bottom-28 sm:bottom-32` still mirrors the main wrapper's `pb-28 sm:pb-32` at
`Alfred.jsx` line 4370, and the Capture bar is `fixed bottom-0 z-20`, so the
footer sits above it rather than under it. The row checkbox is
`pointer-events-none` by design — the whole row is the tap target and is
comfortably over 44px.

**Criteria status without the device run:**

1. under five taps — **fails for more than two ingredients** (above)
2. second cook pre-resolved — code path verified, confirmed live at Step 7
3. shared ingredient merges — confirmed live at Step 7 (the Step 4 debt)
4. un-annotated item works and self-annotates — fallback and write path both
   verified in code, not yet exercised in the app
5. back lands on the source item — verified at Step 5
6. `check_platform_conformance` — Alex runs this

### Step 10 — bulk selection added; awaiting a device run

**Criterion 1 corrected in the spec.** The original wording was
self-contradictory: rows are unchecked by default (a deliberate v1 decision
stated elsewhere in the same document), so N ingredients cost at least N taps
and "under five taps" was unreachable for any real recipe. The target is now a
*typical* add, with the measured number recorded.

**`Select N existing` / `Select none` implemented**, with a `N of M selected`
count in the list header.

- **It selects only rows that already resolve to an existing item** — matched
  automatically, or promoted by accepting a near-miss suggestion. Create-new
  rows are excluded and each stays one deliberate tap, because a create-new row
  mints a new catalogue entry and fifteen uninspected ones in a single tap is
  how a catalogue fills with junk.
- **Labelled `Select N existing`, not "Select all".** A plain "Select all" would
  claim to select every row while deliberately skipping some, and the user would
  not find out until the create-new rows failed to arrive in the collection. The
  label carries the count and the restriction. A second line appears only when
  create-new rows are present: "Rows that create a new item are not included —
  tap those individually."
- `Select none` clears everything, including create-new rows ticked by hand. The
  button is hidden when no row resolves to an existing item.
- The "existing" set is computed from the row's **current** target, not its
  initial match, so accepting a suggestion moves that row into the bulk set and
  the count updates.

**Measured on BBQ Bean Salad** (15 collectable rows: 10 matched, 5 create-new):

| action | taps |
|---|---|
| add all 10 matched | **3** — open, Select 10 existing, Add |
| add all 15 | 8 — the 3 above plus one per create-new row |
| previously, add all 15 | 17 |

**Selection model verified by replicating it exactly:** bulk select checks 3 of
5 rows and leaves both create-new rows untouched; the label flips to "Select
none" once all existing rows are checked; "Select none" clears everything
including hand-ticked create-new rows; accepting a suggestion promotes a row
from create-new into the existing set and the count goes 3 to 4; and the button
is not rendered when every row is create-new.

**Status: verified statically, not on hardware.** The end-to-end run on a phone
has not happened and cannot happen from here. Criteria 2, 3 and 5 were confirmed
live during earlier steps; 1 is now met by measurement; 4 is verified in code
only; 6 is Alex's to run.
