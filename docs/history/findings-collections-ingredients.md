# Findings: Collections, Items, Elements — what exists today

Read-only survey for the "add recipe ingredients to a collection" feature. No code was
changed.

**State surveyed:** working tree on `main` at commit `178837c`, with uncommitted edits
present. `src/Alfred.jsx` was modified by an editor save **during** this survey (HEAD
10,083 lines → working copy 10,144 lines). **All line numbers below are from the
working copy as of the survey**, not from HEAD, and every one has been verified by
direct search rather than derived by offset. The changed hunks were confined to the
inbox disposal region (~1858–2019, where `archiveInboxItem` became `deleteInboxItem`)
and `InboxCard`; no collection code changed in content, only in position.

Where something does not exist, it is called out as **DOES NOT EXIST** rather than
guessed at. Findings only — no recommendations.

---

## A. Collections

### A1. Every read and write path for `collection_items`

All of them live in one module: [src/utils/collectionMembers.js](src/utils/collectionMembers.js).
Nothing else in `src/` touches the table. Confirmed by search: the only files
mentioning `collection_items` are `collectionMembers.js`, `Alfred.jsx` (comments and
imports only), `supabase/functions/_shared/alfred-tools/tool-handlers.ts`, and four
history docs.

The module's contract is stated at [collectionMembers.js:1-42](src/utils/collectionMembers.js#L1-L42):
every export resolves to `{ data, error }` and **never throws for an expected
failure**, because Alfred's `withLoading` swallows exceptions without rethrowing — so
a thrown error inside a wrapped call site is invisible and the user believes the write
succeeded.

**Data layer** ([src/utils/collectionMembers.js](src/utils/collectionMembers.js)):

| Function | Lines | Operation |
|---|---|---|
| `loadMembers(collectionId)` | [80-91](src/utils/collectionMembers.js#L80-L91) | `SELECT * … ORDER BY position ASC` |
| `loadRemovals(collectionId, {reason, limit})` | [104-127](src/utils/collectionMembers.js#L104-L127) | `SELECT * FROM collection_item_removals … ORDER BY removed_at DESC LIMIT n` |
| `nextPosition(collectionId)` *(private)* | [138-149](src/utils/collectionMembers.js#L138-L149) | highest `position` + 1, or 0 for empty |
| `fetchItemNames(itemIds)` *(private)* | [160-176](src/utils/collectionMembers.js#L160-L176) | batched `items.id,name` lookup for removal snapshots |
| `normaliseQuantity(q)` *(private)* | [179-183](src/utils/collectionMembers.js#L179-L183) | trims; empty string → `null` |
| `addMembers(collectionId, entries, {userId})` | [200-248](src/utils/collectionMembers.js#L200-L248) | **INSERT** via `upsert`, `onConflict: "collection_id,item_id"`, `ignoreDuplicates: true` |
| `addMember(collectionId, itemId, {quantity,userId})` | [262-277](src/utils/collectionMembers.js#L262-L277) | singular wrapper over `addMembers` |
| `updateMemberQuantity(collectionId, itemId, quantity)` | [287-303](src/utils/collectionMembers.js#L287-L303) | **UPDATE quantity**, scoped by `collection_id` + `item_id` |
| `reorderMembers(collectionId, orderedMembers)` | [321-347](src/utils/collectionMembers.js#L321-L347) | **UPDATE position** — only rows whose index changed, each scoped by `id` **and** `collection_id` |
| `removeMembers(collectionId, itemIds, {reason,userId})` | [376-444](src/utils/collectionMembers.js#L376-L444) | **DELETE**, preceded by the removal-history INSERT |
| `removeMember(collectionId, itemId, opts)` | [453-456](src/utils/collectionMembers.js#L453-L456) | singular wrapper |
| `reAddRemoval(removal, {userId})` | [479-487](src/utils/collectionMembers.js#L479-L487) | re-INSERT from a removal record, restoring `quantity`, appended at the end |

Constants: table names at [39-40](src/utils/collectionMembers.js#L39-L40); the two
removal reasons `REMOVAL_MANUAL` / `REMOVAL_COMPLETED` at
[43-48](src/utils/collectionMembers.js#L43-L48); removal-read caps
(`MAX_REMOVALS = 200`, `DEFAULT_REMOVALS = 50`) at
[54-55](src/utils/collectionMembers.js#L54-L55); the unique-violation code `23505` at
[51](src/utils/collectionMembers.js#L51).

**How a removal writes to `collection_item_removals`** —
[collectionMembers.js:348-444](src/utils/collectionMembers.js#L348-L444):

1. `SELECT` the matching membership rows first, to snapshot `quantity` and `position`
   and to get row `id`s to delete by ([387-395](src/utils/collectionMembers.js#L387-L395)).
2. Resolve item names in one batched lookup ([398](src/utils/collectionMembers.js#L398));
   an unresolvable name is stored as `null` and never blocks the removal.
3. **INSERT the history rows FIRST** ([414-419](src/utils/collectionMembers.js#L414-L419)),
   then delete the membership rows ([421-429](src/utils/collectionMembers.js#L421-L429)).
   The order is deliberate and documented at
   [354-360](src/utils/collectionMembers.js#L354-L360): supabase-js cannot open a
   browser transaction, so if the second half fails the item is still on the list with
   a spurious history entry (visible, correctable) rather than gone with no record.
4. All rows go in **one INSERT** so they share the server's transaction-stable
   `removed_at` — `removed_at` is left to the column default
   ([400-401](src/utils/collectionMembers.js#L400-L401)) — which is what lets the
   history view group a bulk clear under one heading.
5. If the DELETE fails after the history INSERT succeeded, the function returns a
   failure whose message says so explicitly
   ([430-437](src/utils/collectionMembers.js#L430-L437)).

**Callers in Alfred.jsx** — all in one block headed "Collection membership writes"
([Alfred.jsx:2696-2704](src/Alfred.jsx#L2696-L2704)):

| Alfred function | Line | Calls | Notes |
|---|---|---|---|
| `loadCollectionMembers(ids, {quiet})` | [2654](src/Alfred.jsx#L2654) | `loadMembers` | `quiet` suppresses the error banner for the 5s poll |
| `membersOf(collectionId)` | [2685](src/Alfred.jsx#L2685) | — | reads `collectionMembers[id]` state |
| `setMembersFor(collectionId, updater)` | [2689](src/Alfred.jsx#L2689) | — | functional-updater state write |
| `reportMembershipError(action, msg)` | [2706](src/Alfred.jsx#L2706) | — | `console.error` + `window.alert` |
| `addItemsToCollection(collectionId, entries)` | [2711](src/Alfred.jsx#L2711) | `addMembers` | reloads members; alerts on `skipped` |
| `removeItemFromCollection(collectionId, itemId)` | [2728](src/Alfred.jsx#L2728) | `removeMember` (reason `manual`) | reloads members + removals + history **either way** |
| `loadCollectionRemovals(collectionId, {quiet})` | [2756](src/Alfred.jsx#L2756) | `loadRemovals` reason=`manual`, limit 25 | feeds the "Recently removed" panel |
| `loadCollectionHistory(collectionId)` | [2786](src/Alfred.jsx#L2786) | `loadRemovals` limit 50, both reasons | feeds the history view |
| `putBackRemoval(removal)` | [2804](src/Alfred.jsx#L2804) | `reAddRemoval` | guarded by `reAddingRemovalId` against double-tap |
| `saveMemberQuantity(collectionId, itemId, quantity)` | [2827](src/Alfred.jsx#L2827) | `updateMemberQuantity` | **not** wrapped in `withLoading`; bumps `memberWriteInFlight` to hold the poll off |
| `clearCompletedFromCollection(collectionId, itemIds)` | [2854](src/Alfred.jsx#L2854) | `removeMembers` (reason `completed`) | one call, not a loop, so rows share a timestamp |
| `saveMemberOrder(collectionId, orderedMembers)` | [2867](src/Alfred.jsx#L2867) | `reorderMembers` | also bumps `memberWriteInFlight` |
| `refreshCollection(collectionId)` | [2882](src/Alfred.jsx#L2882) | `loadMembers` | re-reads the collection row + members |

Membership state lives in `collectionMembers`, keyed by collection id
([Alfred.jsx:797](src/Alfred.jsx#L797)), with three sibling error slots
([798](src/Alfred.jsx#L798), [802](src/Alfred.jsx#L802), [806](src/Alfred.jsx#L806)).

**Live-refresh poll:** a 5-second interval runs only while `view === "collection-detail"`
([Alfred.jsx:1149](src/Alfred.jsx#L1149)). It skips a tick entirely if
`pollPausedRef.current` or `memberWriteInFlight.current > 0`. Any new membership write
needs the same guard or it will be clobbered mid-edit.

### A2. Legacy `item_collections.items` jsonb — remaining references

**No code reads or writes it.** Zero live references in `src/` or in the Edge
Functions. The column is a frozen pre-migration rollback snapshot.

Every remaining mention is a comment or docstring saying not to use it:

- [Alfred.jsx:795-796](src/Alfred.jsx#L795-L796) — a **stale comment** on the
  `collectionMembers` state declaration that still says *"Writes still land in the
  item_collections.items jsonb until Step 3c, so the two sources can diverge in
  between."* That is no longer true; the block comment at
  [2698-2699](src/Alfred.jsx#L2698-L2699) supersedes it. Comment only — no code
  behaves this way.
- [Alfred.jsx:2698-2699](src/Alfred.jsx#L2698-L2699) — "the `item_collections.items`
  jsonb is no longer written by any of them and is now a frozen rollback snapshot."
- [Alfred.jsx:3092-3093](src/Alfred.jsx#L3092-L3093) — `addCollection` explicitly does
  **not** seed an `items` key: "The jsonb column keeps its own `'[]'` default and is
  never written again."
- [collectionMembers.js:4-6](src/utils/collectionMembers.js#L4-L6) — module docstring:
  the two tables "replace the `item_collections.items` jsonb array. Migration 005
  created both."
- [tool-handlers.ts:386-390](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L386-L390)
  — `getCollections` docstring: the jsonb "is deliberately NOT selected, because
  reading it reports membership as it stood before the cutover and the stale data
  looks entirely plausible."

The `SELECT` list confirms it —
[tool-handlers.ts:409-412](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L409-L412)
selects `id, name, context_id, shared, is_capture_target` and nothing else.

The four docs that mention the column
(`docs/history/technical-spec-ui-standardization.md`,
`docs/history/progress-ui-standardization.md`,
`docs/history/technical-spec-collection-history.md`,
`docs/history/progress-collection-history.md`) are historical records of the migration.

### A3. How `quantity` is entered and displayed today

**A free-text `<input type="text">` in every case. There is no stepper, no numeric
input, no unit field, and no parsing or validation anywhere.**

`collection_items.quantity` is a nullable text column. `normaliseQuantity`
([collectionMembers.js:179-183](src/utils/collectionMembers.js#L179-L183)) trims,
converts `""` to `null`, and otherwise stores `String(quantity)` verbatim. The
docstring on `updateMemberQuantity` calls it "free-text quantity"
([collectionMembers.js:280](src/utils/collectionMembers.js#L280)).

Four entry points, all the same control:

1. **Collection detail row** — [Alfred.jsx:4570-4589](src/Alfred.jsx#L4570-L4589),
   `placeholder="Qty"` at [4581](src/Alfred.jsx#L4581), `className="w-20 sm:w-24 …"`.
   The typed value lives in `collectionMembers` state until blur; `onFocus` sets
   `editingQuantityItemId` to pause the poll, `onBlur` awaits `saveMemberQuantity`
   before clearing it. **Disabled when the linked item cannot be resolved**
   (`disabled={!linkedItem}`), with the reasoning at
   [4553-4558](src/Alfred.jsx#L4553-L4558).
2. **`CollectionAddItems` picker** — [Alfred.jsx:713-726](src/Alfred.jsx#L713-L726).
   Appears only once a row is checked. Same `w-20 sm:w-24`, `placeholder="Qty"`.
   Initialised to `""` on check ([640](src/Alfred.jsx#L640)).
3. **Execution detail, collection-based execution** —
   [Alfred.jsx:7966-7978](src/Alfred.jsx#L7966-L7978). Writes straight through on
   `onChange` (no blur debounce) via `onUpdateCollectionItemQty`, wired directly to
   `saveMemberQuantity` at [Alfred.jsx:4154](src/Alfred.jsx#L4154). Same
   `disabled={!linkedItem}` treatment.
4. **Inbox triage "Add to Collection" accordion** — a labelled "Quantity" text input,
   `w-32`, at [Alfred.jsx:6324-6333](src/Alfred.jsx#L6324-L6333). Its state
   `collectionQuantity` ([5290](src/Alfred.jsx#L5290)) **defaults to the string `'1'`**
   — the only default quantity anywhere in the app. Consumed at
   [5649](src/Alfred.jsx#L5649) and again with a `|| '1'` fallback at
   [2012](src/Alfred.jsx#L2012).

Display is equally plain: collection-detail and execution rows show the raw string
inside the same input. The only *read-only* rendering is in the item-detail element
list, where a bullet's quantity is prefixed in bold before the name —
[Alfred.jsx:7612-7614](src/Alfred.jsx#L7612-L7614).

`ItemCard`'s element editor also has a per-element `quantity` text input
([Alfred.jsx:8617-8623](src/Alfred.jsx#L8617-L8623)) — that is a field on
`items.elements`, a different thing from `collection_items.quantity`.

### A4. How an item gets added to a collection right now

**Two paths, and neither starts from an item.**

**Path 1 — from collection detail, via a dedicated full-page route.**

- Entry point: the "Add Items" button in the Items header of collection detail,
  [Alfred.jsx:4500-4506](src/Alfred.jsx#L4500-L4506). It calls
  `setView("collection-add-items")` ([4501](src/Alfred.jsx#L4501)) — a route, **not a
  modal**.
- The view renders `CollectionAddItems`
  ([Alfred.jsx:4798-4854](src/Alfred.jsx#L4798-L4854); component at
  [621-773](src/Alfred.jsx#L621-L773)).
- Candidate list, [4803](src/Alfred.jsx#L4803): `items` minus archived, minus existing
  members, **and filtered to the collection's context** when it has one
  (`!coll.contextId || i.contextId === coll.contextId`).
- `maxItems={200 - members.length}` ([4851](src/Alfred.jsx#L4851)) caps the selection.
- The picker itself: search matching name **or** tag
  ([625-630](src/Alfred.jsx#L625-L630)); `toggleItem` / `setQuantity`
  ([632-648](src/Alfred.jsx#L632-L648)); a checkbox list capped at `maxHeight: "50vh"`
  with its own scrollbar ([672](src/Alfred.jsx#L672)); a per-row Qty input revealed on
  check; a sticky footer with "Add (N) to Collection" / "Cancel"
  ([740-771](src/Alfred.jsx#L740-L771)).
- On success it returns to `collection-detail`; **on failure it deliberately stays put
  so the selection is not lost** ([4818](src/Alfred.jsx#L4818)).

The target item is chosen by an **existing-item picker with a create-new fallback** —
both (see A5).

**Path 2 — from inbox triage.**

The `InboxCard` "Add to Collection" accordion,
[Alfred.jsx:6228-6335](src/Alfred.jsx#L6228-L6335): a collection `<select>`
([6245-6256](src/Alfred.jsx#L6245-L6256)), an item autocomplete that is disabled and
overridden when the "Create Item" section is open
([6258-6270](src/Alfred.jsx#L6258-L6270)), and the Quantity input
([6324-6333](src/Alfred.jsx#L6324-L6333)). Handled in `handleInboxSave` at
[Alfred.jsx:2004-2015](src/Alfred.jsx#L2004-L2015), which resolves `targetItemId` to
the picked item **or the item just created in the same triage**, then calls
`addItemsToCollection` with a single entry.

**DOES NOT EXIST:** there is no "Add to collection" affordance on the item detail
view, on `ItemCard`, or anywhere else that starts from an item. Confirmed by
inspecting the full action row on `ItemDetailView`
([Alfred.jsx:7431-7488](src/Alfred.jsx#L7431-L7488)) — Start Now, Clone, Edit,
Archive, and nothing else. There is also no bulk or multi-select of *elements*
anywhere in the app.

### A5. "Create item on the fly" paths

**One exists, in exactly one place:** `CollectionAddItems`'s `onCreateItem`, wired at
[Alfred.jsx:4820-4849](src/Alfred.jsx#L4820-L4849).

It surfaces only when the search box is non-empty **and** filters to zero results —
the dashed `Create "<search>"` button at [Alfred.jsx:679-691](src/Alfred.jsx#L679-L691),
which already advertises the context it will land in.

The object it writes ([Alfred.jsx:4822-4832](src/Alfred.jsx#L4822-L4832)):

```js
const newItem = {
  id: uid(),
  user_id: user.id,
  name: itemName,
  description: '',
  contextId: coll.contextId,      // inherited from the collection; null if it has none
  elements: [],                   // empty
  tags: [],                       // empty
  isCaptureTarget: false,
  createdAt: new Date().toISOString(),
};
```

- **`context_id`**: inherited from `coll.contextId` unconditionally, including `null`
  when the collection has no context.
- **`tags`**: empty array. Nothing is inferred.
- **`elements`**: empty array.

Sharing is decided by the **context**, not the collection:
`isShared = context?.shared || false` at [4835-4836](src/Alfred.jsx#L4835-L4836),
passed as `storage.set`'s third argument. It then appends to local `items` state and
calls `addItemsToCollection` with `quantity: ''`.

For comparison, inbox-triage item creation
([Alfred.jsx:1925-1937](src/Alfred.jsx#L1925-L1937)) uses the same shape but carries
real `elements` and `tags` through from the triage form, under the same
`context?.shared` rule.

---

## B. Items and elements

### B6. The exact shape of an element object as the code writes it

Elements live in `items.elements` (jsonb array). There is **no schema, no validator,
and no shared constant** — the shape is asserted independently at each of the ~14
sites that normalise it.

**The canonical shape, as written by every writer:**

```js
{
  name: string,            // the label
  displayType: string,     // "header" | "bullet" | "step"; defaults to "step"
  quantity: string,        // free text, "" when unset
  description: string,     // free text, "" when unset
  itemId?: string,         // OPTIONAL — makes this element a reference to another item
}
```

The most complete normaliser is `ItemCard`'s initial state,
[Alfred.jsx:8236-8248](src/Alfred.jsx#L8236-L8248). Note `itemId` is spread in
**conditionally**, so an unlinked element genuinely has no `itemId` key:

```js
(item.elements || item.components || []).map((el) =>
  typeof el === "string"
    ? { name: el, displayType: "step", quantity: "", description: "" }
    : {
        name: el.name || "",
        displayType: el.displayType || el.display_type || "step",
        quantity: el.quantity || "",
        description: el.description || "",
        ...(el.itemId || el.item_id ? { itemId: el.itemId || el.item_id } : {}),
      },
)
```

Three legacy shapes are tolerated on read and never written:

- **A bare string** — every normaliser has a `typeof el === "string"` branch:
  [2376](src/Alfred.jsx#L2376), [3254](src/Alfred.jsx#L3254),
  [3346](src/Alfred.jsx#L3346), [7559](src/Alfred.jsx#L7559),
  [8238](src/Alfred.jsx#L8238), [8262](src/Alfred.jsx#L8262),
  [8317](src/Alfred.jsx#L8317).
- **snake_case keys** — `el.display_type`, `el.item_id`, read at
  [7562-7563](src/Alfred.jsx#L7562-L7563), [8241-8245](src/Alfred.jsx#L8241-L8245),
  [8265-8269](src/Alfred.jsx#L8265-L8269).
- **`item.components`** as an alias for `item.elements` — read at
  [3251](src/Alfred.jsx#L3251), [7546](src/Alfred.jsx#L7546),
  [8236](src/Alfred.jsx#L8236), and in `ItemCard`'s summary line
  [8782-8786](src/Alfred.jsx#L8782-L8786).

Four more keys are attached transiently and never persisted on the item:
`indent`, `missing`, `circular` (all by `flattenElements`,
[Alfred.jsx:204-231](src/Alfred.jsx#L204-L231)) and `sourceItemId` (on executions).

**Every `displayType` value the code produces or renders:**

| Value | Produced at | Rendered at |
|---|---|---|
| `"step"` | the default in **every** normaliser, plus `addElement` ([5412](src/Alfred.jsx#L5412), [8330](src/Alfred.jsx#L8330)) and `insertElementAbove` ([5427](src/Alfred.jsx#L5427), [8345](src/Alfred.jsx#L8345)) | item detail fall-through (after [7603](src/Alfred.jsx#L7603)); execution "step or any other displayType" ([8044](src/Alfred.jsx#L8044)) |
| `"header"` | `<option>` in both editors ([6146](src/Alfred.jsx#L6146), [8613](src/Alfred.jsx#L8613)); synthesised by `flattenElements` for a resolved item reference ([215](src/Alfred.jsx#L215)) | [7568](src/Alfred.jsx#L7568), [8015](src/Alfred.jsx#L8015) |
| `"bullet"` | `<option>` in both editors ([6147](src/Alfred.jsx#L6147), [8614](src/Alfred.jsx#L8614)); hard-coded when inbox triage back-links a new item into an existing one ([1953](src/Alfred.jsx#L1953)) | [7603](src/Alfred.jsx#L7603), [8025](src/Alfred.jsx#L8025) |

**Those three are the complete set the UI can produce.** Both `<select>` editors offer
exactly Header / Bullet / Step — [Alfred.jsx:6140-6149](src/Alfred.jsx#L6140-L6149)
(InboxCard) and [Alfred.jsx:8607-8616](src/Alfred.jsx#L8607-L8616) (ItemCard).

### Does `'ingredient'` appear anywhere?

**Yes — but only on the AI side, and only under the key `type`, never `displayType`.
Nothing in the React app produces it and nothing renders it specially.**

Live occurrences:

- [ai-enrich/index.ts:124](supabase/functions/ai-enrich/index.ts#L124) — the
  `submit_suggestions` tool schema: *"Each element: `{type: 'ingredient'|'step'|'header'|'bullet', text: '...'}`"*
- [ai-enrich/index.ts:264](supabase/functions/ai-enrich/index.ts#L264) — system prompt
  rule 10: *"For recipes: parse into structured elements with type \"ingredient\" and \"step\""*
- [ai-enrich/index.ts:265](supabase/functions/ai-enrich/index.ts#L265) — rule 11:
  *"use elements with type \"step\", \"header\", \"bullet\", or \"ingredient\""*
- [mcp/index.ts:739](supabase/functions/mcp/index.ts#L739) — the same string in
  `update_inbox_item`'s `suggested_item_elements` description
- [mcp/index.ts:708](supabase/functions/mcp/index.ts#L708) — `create_inbox_item`'s
  looser variant: "Structured elements array (steps, ingredients, checklist items)"
- [mcp/index.ts:578](supabase/functions/mcp/index.ts#L578) — `get_items` prose: "Items
  have elements (steps, ingredients, etc.)"

Plus historical copies in `docs/history/Alfred_Phase7_Implementation_Plan_v3.md:244,276,314`,
`docs/history/phase7-step6-exact-code.md:511`,
`docs/history/phase7.1-implementation-steps.md:233`, and
`docs/history/phase7.2-implementation-steps.md:217,357,358`.

**The consequence, in code:** the inbox parser maps `el.type` → `el.displayType` with
`el.type || 'step'` ([Alfred.jsx:5265](src/Alfred.jsx#L5265),
[5341](src/Alfred.jsx#L5341), [5383](src/Alfred.jsx#L5383),
[5685](src/Alfred.jsx#L5685)). So an AI-suggested `{type: 'ingredient'}` becomes
`{displayType: 'ingredient'}`, which:

- is **not** one of the three `<option>` values, so the triage `<select>` renders with
  no matching option;
- falls through every `=== "header"` / `=== "bullet"` check and renders **as a step**
  in item detail and in executions — the comment at
  [8044](src/Alfred.jsx#L8044) says "step or any other displayType";
- survives a save untouched, because `ItemCard`'s normaliser passes `el.displayType`
  straight through ([8241](src/Alfred.jsx#L8241)).

So `'ingredient'` can already exist in stored data, silently, as a `displayType` no UI
knows about — but only via AI-enriched inbox triage, never via the editors.

### B7. Where the recipe element format is enforced or assumed

**DOES NOT EXIST in the React app.** There is no code anywhere in `src/` that looks
for an "Ingredients" header, an "Ingredients → bullets" convention, a "Steps → steps"
convention, or any recipe-shaped structure. Verified: the strings `Ingredients` and
`Steps` do not appear in any `src/*.jsx` file.

The convention is **entirely a prompt instruction to the enrichment model**, in
[supabase/functions/ai-enrich/index.ts:255-273](supabase/functions/ai-enrich/index.ts#L255-L273):

- Rule 10 ([264](supabase/functions/ai-enrich/index.ts#L264)) — *"For recipes: parse
  into structured elements with type \"ingredient\" and \"step\""*
- Rule 11 ([265](supabase/functions/ai-enrich/index.ts#L265)) — the four permitted types
- Rule 3 ([257](supabase/functions/ai-enrich/index.ts#L257)) — *"If the captured text
  looks like a URL, call `fetch_url`"*, whose tool description
  ([101-103](supabase/functions/ai-enrich/index.ts#L101-L103)) names recipe pages
  explicitly and whose `User-Agent` is literally `"Alfred/1.0 (Recipe Parser)"`
  ([190](supabase/functions/ai-enrich/index.ts#L190))

`fetch_url` strips HTML and truncates to ~8000 chars
([185-217](supabase/functions/ai-enrich/index.ts#L185-L217)).

**The parser for `suggested_item_elements`** is inline in `InboxCard`, duplicated three
times: [Alfred.jsx:5260-5269](src/Alfred.jsx#L5260-L5269) (initial state),
[5336-5345](src/Alfred.jsx#L5336-L5345) (re-sync on enrichment), and
[5680-5689](src/Alfred.jsx#L5680-L5689) (dirty-check comparison):

```js
(inboxItem.suggestedItemElements || []).map((el) =>
  el.name ? el : {
    name: el.text || '',
    displayType: el.type || 'step',
    quantity: el.quantity || '',
    description: el.description || ''
  }
)
```

Three things to note: the `el.name ? el : …` guard passes an element that already has
a `name` key through **completely unmodified**, with no `type`/`displayType`
normalisation at all; `itemId` is dropped by the conversion branch; and the AI's
`{type, text}` contract has no `quantity` field, so `el.quantity` is always undefined
there.

### B8. The item detail view and the item edit form

**`ItemDetailView`** — [Alfred.jsx:7317-7828](src/Alfred.jsx#L7317-L7828).

Read-mode layout, top to bottom:

| Region | Lines |
|---|---|
| Back button | [7405-7411](src/Alfred.jsx#L7405-L7411) |
| Title `<h2>` + context-name badge | [7415-7423](src/Alfred.jsx#L7415-L7423) |
| **Action row (top right)** | [7431-7488](src/Alfred.jsx#L7431-L7488) |
| Clone dialog (conditional modal) | [7490-7530](src/Alfred.jsx#L7490-L7530) |
| Item description | [7532-7537](src/Alfred.jsx#L7532-L7537) |
| Capture-target badge | [7539-7546](src/Alfred.jsx#L7539-L7546) |
| **Elements section** | [7548](src/Alfred.jsx#L7548) onward |
| Related intentions, executions, collections | below the elements section |

The action row is `flex flex-wrap justify-end gap-2` ([7431](src/Alfred.jsx#L7431)) and
holds exactly four buttons, in the spec's order:

1. **Start Now** — [7444](src/Alfred.jsx#L7444), `bg-primary`. The comment at
   [7433-7443](src/Alfred.jsx#L7433-L7443) explains at length why it is primary and not
   success.
2. **Clone** — [7452-7455](src/Alfred.jsx#L7452-L7455), `bg-secondary`, label hidden
   below `sm`.
3. **Edit Item** — [7464](src/Alfred.jsx#L7464), `bg-secondary`, label shortens to
   "Edit" below `sm`.
4. **Archive** — [7478](src/Alfred.jsx#L7478), `bg-destructive`. Added by the
   UI-standardization phase; the comment at [7470-7475](src/Alfred.jsx#L7470-L7475)
   cites governing rule 4.

Every button is `min-h-[44px]`.

**Where a new action would go:** into that same
`flex flex-wrap justify-end gap-2` container at [7431](src/Alfred.jsx#L7431). It
already wraps by design — the comment just above it says *"flex-wrap because four
buttons no longer fit one line on a narrow screen."* A fifth is a mobile-width
consideration. Under rule 5 an "Add to collection" button must carry a visible fill or
border; under rule 1 it belongs here rather than in the edit form.

Each element in read mode also carries a per-element **Copy** button
(`copyElementToClipboard`, [7351-7358](src/Alfred.jsx#L7351-L7358)) — the existing
precedent for a per-element control. It is a bare icon with no border. A per-element
checkbox would sit in the same row.

**Edit mode is not a separate component:** `ItemDetailView` returns early at
[7372-7402](src/Alfred.jsx#L7372-L7402), rendering `ItemCard` with `isEditing` and
`stickyFooter` set. The comment at [7395-7398](src/Alfred.jsx#L7395-L7398) records why:
*"This card IS the page here … A long recipe puts Save thousands of pixels below the
fold; this is the case the phase started from."*

**`ItemCard` edit form** — [Alfred.jsx:8213-8813](src/Alfred.jsx#L8213-L8813), edit
branch begins at [8467](src/Alfred.jsx#L8467). Fields in order:

| Field | Control | Lines |
|---|---|---|
| Name | text input | ~[8470](src/Alfred.jsx#L8470) |
| Description | textarea, 2 rows | [8495-8502](src/Alfred.jsx#L8495-L8502) |
| Tags | `TagInput` | [8505-8510](src/Alfred.jsx#L8505-L8510) |
| Use as capture target | checkbox | [8512-8523](src/Alfred.jsx#L8512-L8523) |
| Context | `<select>` | [8525-8540](src/Alfred.jsx#L8525-L8540) |
| Elements | drag-reorderable list | [8542-8709](src/Alfred.jsx#L8542-L8709) |

Each element row holds a `GripVertical` drag handle, a name input with a 25/30-char
overflow counter, Copy, Delete (X), a description textarea, the Header/Bullet/Step
`<select>`, and a quantity input ([8556-8623](src/Alfred.jsx#L8556-L8623)). Below the
list: a dashed "+ Add Element" button ([8702-8707](src/Alfred.jsx#L8702-L8707)).

Form footer — [8711-8744](src/Alfred.jsx#L8711-L8744): **Save** / **Cancel** /
**Archive**, `flex flex-wrap gap-2`, made sticky at `bottom-28 sm:bottom-32`
([8714](src/Alfred.jsx#L8714)) when `stickyFooter` is set. Archive is guarded by
`item.id` so add-mode cannot create a phantom archived item
([8730-8733](src/Alfred.jsx#L8730-L8733)).

`handleSave` ([8286-8306](src/Alfred.jsx#L8286-L8306)) writes exactly
`{name, description, contextId, elements, tags, isCaptureTarget}` — so **a new
element-level key persists automatically**, since `elements` passes through whole. A
new *item-level* field would need adding here **and** to the dirty-check effect at
[8256-8283](src/Alfred.jsx#L8256-L8283).

### B9. How executions freeze `items.elements`, and what breaks if a `type` changes

Executions **deep-copy** the elements at start. There are two creation sites and they
do the same thing:

- **`activate(eventId)`** — [Alfred.jsx:2338-2409](src/Alfred.jsx#L2338-L2409). For an
  item-based execution it loops `event.itemIds`, normalises each element
  ([2373-2378](src/Alfred.jsx#L2373-L2378)), runs `flattenElements`
  ([2379](src/Alfred.jsx#L2379)), then stamps execution fields
  ([2380-2387](src/Alfred.jsx#L2380-L2387)):
  `{...el, isCompleted: false, completedAt: null, inProgress: false, startedAt: null, sourceItemId: el.sourceItemId || itemId}`.
- **`startNowFromItem(itemId)`** — [Alfred.jsx:3215-3285](src/Alfred.jsx#L3215-L3285),
  identical logic inline at [3248-3265](src/Alfred.jsx#L3248-L3265). The comment at
  [3247](src/Alfred.jsx#L3247) explains the duplication: *"Build execution inline
  (can't call activate — state hasn't updated yet)."*

The array is stored on the execution row and **never re-read from the item
afterwards**. Later writes (`toggleExecutionElement`
[2564](src/Alfred.jsx#L2564), `updateExecutionElement` [2593](src/Alfred.jsx#L2593))
mutate `activeExecution.elements` **by index** and persist the whole execution.

`flattenElements` ([Alfred.jsx:204-231](src/Alfred.jsx#L204-L231)) resolves `itemId`
references up to depth 3, **rewrites a resolved reference's `displayType` to
`"header"`** ([215](src/Alfred.jsx#L215)), and marks unresolvable/circular ones with
`missing` / `circular`.

**A collection-based execution stores `elements: []`** and works off live
`collection_items` instead ([2341-2356](src/Alfred.jsx#L2341-L2356),
[3298-3315](src/Alfred.jsx#L3298-L3315)). The two execution modes are mutually
exclusive, branched on `execution.collectionId` at
[Alfred.jsx:7900](src/Alfred.jsx#L7900) and [7987](src/Alfred.jsx#L7987).

**What breaks if an element's type value changed on an existing item:**

- **Running executions: nothing.** They hold their own frozen copy; changing the item
  does not reach them.
- **Executions started *after* the change** carry the new value.
- **A new `displayType` renders as a step, silently**, in both surfaces. Item detail
  falls through its two `===` checks ([7568](src/Alfred.jsx#L7568),
  [7603](src/Alfred.jsx#L7603)) to the step branch; execution detail does the same
  ([8015](src/Alfred.jsx#L8015), [8025](src/Alfred.jsx#L8025), with the explicit *"step
  or any other displayType"* comment at [8044](src/Alfred.jsx#L8044)). No error, no
  warning.
- **The step counter changes.** Both renderers keep a `stepCounter` incremented only on
  the step branch ([7555](src/Alfred.jsx#L7555), [7994](src/Alfred.jsx#L7994)), so
  moving elements out of "step" **renumbers the remaining steps** in both item detail
  and every future execution.
- **Both edit `<select>`s show a blank/unmatched value** for an unknown `displayType`,
  and touching the dropdown silently coerces the element to one of the three known
  values.
- **`ItemCard`'s dirty check compares `JSON.stringify(elements)` against a re-normalised
  original** ([8258-8283](src/Alfred.jsx#L8258-L8283)). The normaliser preserves unknown
  `displayType` values, so this stays consistent — but any change to normalisation key
  order would read as a false "dirty".
- **`flattenElements` overrides `displayType` to `"header"`** for any element with a
  resolvable `itemId` ([215](src/Alfred.jsx#L215)). An `ingredient` element that also
  linked to another item would lose its type inside every execution.

---

## C. Contexts

### C10. The context edit form

**`ContextForm`** — [Alfred.jsx:6476-6595](src/Alfred.jsx#L6476-L6595).
Props: `{editing, onSave, onCancel, onDirtyChange, stickyFooter = false}`.

**Every field it exposes — five, and that is the complete list:**

| Field | State | Control | Lines |
|---|---|---|---|
| `name` | [6477](src/Alfred.jsx#L6477) | text input, `autoFocus` | [6504-6516](src/Alfred.jsx#L6504-L6516) |
| `keywords` | [6479](src/Alfred.jsx#L6479) | text input, "comma separated" | [6518-6530](src/Alfred.jsx#L6518-L6530) |
| `description` | [6480](src/Alfred.jsx#L6480) | textarea, 3 rows | [6532-6544](src/Alfred.jsx#L6532-L6544) |
| `shared` | [6478](src/Alfred.jsx#L6478) | checkbox "Share this context" | [6546-6555](src/Alfred.jsx#L6546-L6555) |
| `pinned` | [6481](src/Alfred.jsx#L6481) | checkbox "Pin to home" | [6557-6566](src/Alfred.jsx#L6557-L6566) |

Footer: Save / Cancel at [6573-6592](src/Alfred.jsx#L6573-L6592), sticky at
`bottom-28 sm:bottom-32` ([6572](src/Alfred.jsx#L6572)) when `stickyFooter` is set. The
comment at [6568-6571](src/Alfred.jsx#L6568-L6571) records that those two offsets mirror
the main wrapper's `pb-28 sm:pb-32` Capture-bar reservation — *"Same two numbers, same
reason — if one moves the other has to."* Save is a no-op unless `name.trim()` is
truthy ([6577](src/Alfred.jsx#L6577)).

**Two render sites:** the Contexts list page ([3973](src/Alfred.jsx#L3973)) and
`ContextDetailView`'s in-place edit ([6869](src/Alfred.jsx#L6869); component at
[6760](src/Alfred.jsx#L6760)).

**How a new field would be added and saved.** The save path uses **positional
arguments**, not an object, through four layers — every one must change:

1. `ContextForm` — add `useState`, add the control, add it to the `isDirty` comparison
   at [6484-6493](src/Alfred.jsx#L6484-L6493), and extend the call at
   [6580](src/Alfred.jsx#L6580): `onSave(name, shared, keywords, description, pinned)`.
2. `saveContext(name, shared, keywords, description, pinned)` —
   [Alfred.jsx:2940-2957](src/Alfred.jsx#L2940-L2957). Thin wrapper: forwards to
   `saveContextRecord(editingContext, …)`, then clears `showContextForm` and
   `editingContext`.
3. `saveContextRecord(existing, name, shared, keywords, description, pinned)` —
   [Alfred.jsx:2896-2939](src/Alfred.jsx#L2896-L2939), the real save, wrapped in
   `withLoading('Saving context...')`. The comment at
   [2892-2895](src/Alfred.jsx#L2892-L2895) explains why the target is a parameter rather
   than read from `editingContext`: context detail edits in place and has its own notion
   of what it is editing.
4. `ContextDetailView`'s own `onSave` at [6869](src/Alfred.jsx#L6869) — it passes the
   same positional list through.

Persistence itself is free: `storage.set('context:<id>', …)` runs the object through
`toSnakeCase` ([Alfred.jsx:116](src/Alfred.jsx#L116)) and writes the whole row, so a new
key lands in the `contexts` table automatically **provided the column exists** — which
needs a migration, and per the `mcp-platform` skill any new table also needs
`platform.register_table()`.

---

## D. UI conventions

### D11. The five governing rules

Quoted verbatim from
[docs/history/technical-spec-ui-standardization.md:18-33](docs/history/technical-spec-ui-standardization.md#L18-L33):

> ## Governing rules
>
> 1. **Actions on the record** (Start, Clone, Edit, Archive) live at the **top right** of
>    a view page.
> 2. **Actions on the form** (Save, Cancel) sit in a consistent bottom row, sticky where
>    the layout permits.
> 3. **Archive is never more than one click away** and never sits behind a confirmation
>    dialog or an overflow menu. Safety comes from a 5-second Undo message.
> 4. **Workflow actions never live only inside an edit form.** An action that changes a
>    record's state rather than its content belongs on the view page.
> 5. **Actions look like actions.** Anything that performs an operation gets a visible
>    border or fill. Anything that navigates is plain text or a plain icon. These are
>    currently indistinguishable and will diverge further as the routing work lands.

Four supporting decisions from the same document,
[lines 35-40](docs/history/technical-spec-ui-standardization.md#L35-L40):

> - Row actions are always visible, never hover-revealed. The primary device is a
>   touchscreen Surface; hover does not exist there.
> - Sort preference is remembered per page in browser local storage. No database column.
> - Overdue items sort normally rather than being grouped.
> - Inbox captures are deleted; everything downstream of the inbox is archived.

The rules are cited in-code at [Alfred.jsx:906](src/Alfred.jsx#L906) (rule 3),
[4685](src/Alfred.jsx#L4685) (rule 3, Archive Collection), [7472](src/Alfred.jsx#L7472)
(rule 4, Archive on item detail), and [10116](src/Alfred.jsx#L10116) (rule 4). Rule 4's
practical reading is spelled out in
[progress-ui-standardization.md:1322](docs/history/progress-ui-standardization.md#L1322):
*"a workflow action must not live **only** inside an edit form."*

**Note:** both UI-standardization docs are currently modified in the working tree
(`+129` and `+16` lines). The Governing rules block itself is unchanged relative to HEAD.

### D12. The modal component(s) in use

**DOES NOT EXIST: there is no shared `Modal` component, no portal, and no
`role="dialog"` anywhere in the app.** Every dialog is hand-rolled `fixed inset-0`
markup at its use site. There is no focus trap, no Escape handler, and no scroll lock in
any of them.

The complete inventory:

| Dialog | Line | Overlay | Panel | Backdrop click | Mobile behaviour |
|---|---|---|---|---|---|
| `LoadingOverlay` | [488-497](src/Alfred.jsx#L488-L497) | `fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50` | small card | — (blocking) | fine; tiny |
| Mobile nav drawer | [3505-3508](src/Alfred.jsx#L3505-L3508) | `sm:hidden fixed inset-0 … z-30` + `fixed top-0 left-0 bottom-0 w-64 … z-40` | left drawer | closes | the one genuinely mobile-designed overlay |
| Item Picker (InboxCard) | [6392-6440](src/Alfred.jsx#L6392-L6440) | `fixed inset-0 bg-black/50 flex items-center justify-center z-50` | `bg-card p-6 rounded-lg max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto` | closes | **best mobile pattern in the app** — `w-full mx-4`, capped at 80vh with its own scroll |
| Clone dialog (`ItemDetailView`) | [7491-7530](src/Alfred.jsx#L7491-L7530) | `fixed inset-0 bg-black bg-opacity-50 … z-50 p-4` | `bg-white rounded-lg shadow-xl w-full max-w-md p-6` | **no** | fine; no height cap, but content is one input |
| `CustomRecurrenceDialog` | [8874](src/Alfred.jsx#L8874) | `fixed inset-0 z-[100] flex items-center justify-center bg-black/50` | `w-full max-w-sm mx-4` | closes | **no height cap** — tall content can overflow the viewport on a short screen |
| `IntervalRecurrenceDialog` | [9073](src/Alfred.jsx#L9073) | same as above | same | closes | same caveat |
| `SchedulePopover` dropdown | [9346](src/Alfred.jsx#L9346) | `absolute z-50 mt-1 w-full …` | inline | — | anchored popover, not a modal |

Two z-index tiers are in use: `z-50` for most, `z-[100]` for the two recurrence dialogs.
`p-4` / `mx-4` is the consistent mobile gutter; `max-w-md` or `max-w-sm` the consistent
width cap; `max-h-[80vh] overflow-y-auto` appears **only** on the Item Picker.

**Relevant precedent for this feature:** the existing "Add Items to Collection" surface
is deliberately **not** a modal — it is a full route (`/collections/add-items`,
`CollectionAddItems` at [621](src/Alfred.jsx#L621)) whose list is capped at
`maxHeight: "50vh"` with its own scrollbar ([672](src/Alfred.jsx#L672)). The comment at
[736-739](src/Alfred.jsx#L736-L739) notes that the sticky footer *"will rarely engage:
the item list above is capped at 50vh with its own scrollbar, so the page as a whole does
not usually exceed the viewport."*

### D13. The 5-second Undo pattern

Implemented in [src/UndoMessage.jsx](src/UndoMessage.jsx) (138 lines), tested in
[src/UndoMessage.test.jsx](src/UndoMessage.test.jsx) (204 lines).

- `UNDO_DURATION_MS = 5000` — [UndoMessage.jsx:32](src/UndoMessage.jsx#L32)
- `useUndo(durationMs)` hook — [UndoMessage.jsx:46-93](src/UndoMessage.jsx#L46-L93),
  returning `{pendingUndo, offerUndo, runUndo, dismissUndo}`
- `UndoMessage` presentational component — [UndoMessage.jsx:105-137](src/UndoMessage.jsx#L105-L137)

Three design constraints, stated at [UndoMessage.jsx:4-31](src/UndoMessage.jsx#L4-L31):

1. **Single slot.** `offerUndo` clears the previous timer before scheduling a new one
   ([73](src/UndoMessage.jsx#L73)), so exactly one timer is ever live — *"That is what
   makes a stale timer unable to expire a fresh offer."*
2. **The restore is an arbitrary async closure**, not a `{record, flag}` payload, because
   the app needs three shapes: flip a flag back (archive), put a whole row back (hard
   delete), and compound archive-plus-cascade.
3. **Nothing here talks to the database.** The caller owns its own state setters, so the
   restore closure is written where those setters are in scope.

`runUndo` ([87-93](src/UndoMessage.jsx#L87-L93)) dismisses **before** awaiting the
restore, so a second click cannot restore twice.

**Positioning is deliberately absent** from the component
([96-104](src/UndoMessage.jsx#L96-L104)): it must sit above the Capture bar, whose height
changes as its textarea grows, so any `bottom-N` here would break. Alfred renders it as
an ordinary block above the Capture bar inside the one shared fixed container —
*"structural instead of arithmetic."*

**How it is reused.** Alfred wires the hook once at
[Alfred.jsx:913](src/Alfred.jsx#L913) and wraps it in a single helper,
`offerUndoFor(message, restore)` at [Alfred.jsx:917](src/Alfred.jsx#L917), preceded by
the rule-3 comment at [906](src/Alfred.jsx#L906). There are exactly **six** call sites:

| Call site | Line | Message |
|---|---|---|
| `deleteInboxItem` | [1888](src/Alfred.jsx#L1888) | "Capture deleted." |
| `moveToPlanner` | [2099](src/Alfred.jsx#L2099) | "Scheduled for …" |
| `archiveIntention` | [2177](src/Alfred.jsx#L2177) | `Archived "…"` |
| `updateItem` (archive) | [2243](src/Alfred.jsx#L2243) | `Archived "…"` |
| `updateEvent` (archive) | [2322](src/Alfred.jsx#L2322) | `Archived "…"` — also deletes the recurrence successor it triggered |
| `archiveCollection` | [3143](src/Alfred.jsx#L3143) | `Archived "…"` |

(Inbox disposal is now a **delete**, not an archive —
[Alfred.jsx:1858-1897](src/Alfred.jsx#L1858-L1897). That is one of the hunks changed
during this survey.)

**Two documented exceptions where Undo is deliberately NOT offered:**

- **Successful inbox triage** — [Alfred.jsx:2035-2042](src/Alfred.jsx#L2035-L2042):
  *"Undo would put the inbox row back but could not remove the records it turned into …
  a button labelled Undo that half-undoes is worse than none."*
- **Hard-deleting a collection** — [Alfred.jsx:3122-3134](src/Alfred.jsx#L3122-L3134): a
  hard delete cascades to `collection_items` **and** `collection_item_removals`, and
  destroying that append-only recovery log behind a 5-second window was judged
  unacceptable. Collections are soft-deleted instead; the only hard delete left is the
  Recycle Bin's terminal one.

### D14. The shared sort control and its localStorage key convention

Component and hook: [src/SortControl.jsx](src/SortControl.jsx) (110 lines). Pure
persistence/comparison helpers: [src/utils/sortOrders.js](src/utils/sortOrders.js),
tested in [src/utils/sortOrders.test.js](src/utils/sortOrders.test.js).

- `useSortPreference(storageKey, options, defaultKey)` —
  [SortControl.jsx:32-64](src/SortControl.jsx#L32-L64). Returns
  `{sortKey, sortDir, chooseKey, toggleDir}`. Reads **synchronously on first render**
  ([37-39](src/SortControl.jsx#L37-L39)) so the first paint is already in the stored
  order. Choosing a field **resets direction to that field's natural one**
  ([54-56](src/SortControl.jsx#L54-L56)) — *"Going from 'Name, A→Z' to 'Last modified'
  should land on most-recent-first, not on the rows you have not touched since spring."*
- `SortControl` — [SortControl.jsx:66-110](src/SortControl.jsx#L66-L110). A
  `<label>Sort by</label>` + `<select>` + a direction toggle button. The direction button
  sits **outside** the label deliberately ([76-78](src/SortControl.jsx#L76-L78)) — a
  `<label>` forwards clicks to its control. Its `aria-label` names both the action and
  the current state ([104-106](src/SortControl.jsx#L104-L106)); the comment at
  [11-21](src/SortControl.jsx#L11-L21) marks both accessibility hooks as load-bearing,
  not decorative. Controls are `min-h-[36px]` — the only sub-44px touch targets found in
  this survey. Explicitly *"not styled per-page"*
  ([23-25](src/SortControl.jsx#L23-L25)).

**Key convention: `alfred.sort.<page>`, one per page.** All five, declared together at
[Alfred.jsx:898-902](src/Alfred.jsx#L898-L902):

```js
const homeSort        = useSortPreference("alfred.sort.home",        EVENT_SORT_OPTIONS,        "time");
const scheduleSort    = useSortPreference("alfred.sort.schedule",    EVENT_SORT_OPTIONS,        "time");
const inboxSort       = useSortPreference("alfred.sort.inbox",       INBOX_SORT_OPTIONS,        "created");
const contextsSort    = useSortPreference("alfred.sort.contexts",    NAMED_RECORD_SORT_OPTIONS, "title");
const collectionsSort = useSortPreference("alfred.sort.collections", NAMED_RECORD_SORT_OPTIONS, "title");
```

The comment at [Alfred.jsx:884-897](src/Alfred.jsx#L884-L897) records that they are
called unconditionally at the top level — Alfred renders every screen from one component
— and that `alfred.sort.home` governs Home's **Today tab only**.

Option sets are module-level constants: `EVENT_SORT_OPTIONS`
([385-394](src/Alfred.jsx#L385-L394)), `INBOX_SORT_OPTIONS`
([396-406](src/Alfred.jsx#L396-L406)), `NAMED_RECORD_SORT_OPTIONS`
([408-413](src/Alfred.jsx#L408-L413) — Name / Created / Last modified), with matching
accessor bags at [415-427](src/Alfred.jsx#L415-L427).

Storage holds **both field and direction in one JSON value**, `{key, dir}` —
`writeStoredSort` at [sortOrders.js:146-156](src/utils/sortOrders.js#L146-L156).
`readStoredSort` ([115-143](src/utils/sortOrders.js#L115-L143)) validates the stored key
against the options the page **currently** offers and falls back to the page default if
it is absent, malformed, or names a removed option
([135-140](src/utils/sortOrders.js#L135-L140)). Every access is try-wrapped because
*"localStorage throws rather than returning null when storage is disabled or the quota is
full, and a sort preference is not worth taking a page down for"*
([106-108](src/utils/sortOrders.js#L106-L108)).

**Note:** the collection **detail** page's member list has **no** sort control. It is
ordered by `position` and drag-reordered
([Alfred.jsx:4526-4545](src/Alfred.jsx#L4526-L4545)). `alfred.sort.collections` governs
the collections **list** page only.

---

## E. Routing

### E15. Do collection detail and item detail have an id in the URL?

**No. Neither does. No detail view carries an id in the URL.**

The two-way map is [src/viewPaths.js](src/viewPaths.js), tested in
[src/viewPaths.test.js](src/viewPaths.test.js). The relevant entries
([viewPaths.js:18-38](src/viewPaths.js#L18-L38)):

```
"item-detail":          "/memories/detail"
"collection-detail":    "/collections/detail"
"collection-history":   "/collections/history"
"collection-add-items": "/collections/add-items"
```

The reason is stated in the map's own header comment,
[viewPaths.js:12-17](src/viewPaths.js#L12-L17):

> Detail views carry no id this slice — the id-bearing navigations set their id via a
> separate React state call that has not flushed by the time `setView` runs, so
> threading an id into the URL would mean editing the call sites. Ids arrive in a later
> slice; the parent segment survives that change (`/contexts/detail` -> `/contexts/:contextId`).

`VIEW_TO_PATH` is a strict bijection reversed once at module load
([42-44](src/viewPaths.js#L42-L44)); `viewToPath` must tolerate any input because 11 of
39 `setView` call sites pass a runtime value ([66-73](src/viewPaths.js#L66-L73)).

**The id lives in React state instead**, and a cold load on a detail URL redirects to the
parent. `DETAIL_VIEW_STATE` at [Alfred.jsx:860-868](src/Alfred.jsx#L860-L868) maps each
detail view to the state that must be present:

```js
"item-detail":          selectedItemId,
"collection-detail":    selectedCollectionId,
"collection-history":   selectedCollectionId,
"collection-add-items": selectedCollectionId,
```

If missing, the effect at [Alfred.jsx:872-883](src/Alfred.jsx#L872-L883) navigates to
`parentPath(currentPath)` with `replace: true` — *"a path the app cannot render should
not become a history entry the Back button can return the user to."*

**Practical consequence for this feature:** all three collection views share
`selectedCollectionId`, and navigating between them is plain `setView` with no id
handoff — [4501](src/Alfred.jsx#L4501) (detail → add-items),
[4818](src/Alfred.jsx#L4818) (add-items → detail), [4621](src/Alfred.jsx#L4621) and
[4668](src/Alfred.jsx#L4668) (detail → history). A new "recipe → pick collection → pick
ingredients" flow inherits this: it cannot be deep-linked or reloaded, and any new route
needs an entry in `VIEW_TO_PATH` plus, if it is a detail view, an entry in
`DETAIL_VIEW_STATE`.

### Views still using `previousView` / `intentionReturnView` / `itemHistoryStack`

All three are still live React state, declared at
[Alfred.jsx:827-829](src/Alfred.jsx#L827-L829).

**`previousView`** — the shared, clobberable return address. Written at 17 sites
(including [935](src/Alfred.jsx#L935), [2362](src/Alfred.jsx#L2362),
[2410](src/Alfred.jsx#L2410), [2969](src/Alfred.jsx#L2969), [2996](src/Alfred.jsx#L2996),
[3210](src/Alfred.jsx#L3210), [3287](src/Alfred.jsx#L3287)). Read at seven back-handlers:

| Site | Line | Note |
|---|---|---|
| Intention detail (legacy) | [2465](src/Alfred.jsx#L2465), [2522](src/Alfred.jsx#L2522) | |
| `handleBackFromItemDetail` fallback | [3018](src/Alfred.jsx#L3018) | used only when `itemHistoryStack` is empty |
| Timer back | [3418](src/Alfred.jsx#L3418) | `setView(previousView \|\| "home")` |
| SAM back | [3426](src/Alfred.jsx#L3426) | `setView(previousView \|\| "home")` |
| Execution detail back | [4161](src/Alfred.jsx#L4161) | `setView(previousView)` |
| **Collection detail back** | **[4437](src/Alfred.jsx#L4437)** | `setView(previousView \|\| "collections")` — clears `selectedCollectionId` first |

**`intentionReturnView`** — [828](src/Alfred.jsx#L828). Introduced specifically because
`previousView` is unreliable; the comment at
[2190-2194](src/Alfred.jsx#L2190-L2194) says the return address *"is
`intentionReturnView` … rather than the shared `previousView`, which any intervening
navigation can clobber."* Set only by `viewIntentionDetail`
([2976](src/Alfred.jsx#L2976)), read at [2196](src/Alfred.jsx#L2196) and
[2988](src/Alfred.jsx#L2988). **Not used by any collection or item view.**

**`itemHistoryStack`** — [829](src/Alfred.jsx#L829). Item-detail only, and it exists
because item elements can link to other items. `viewItemDetail`
([2991-3001](src/Alfred.jsx#L2991-L3001)) pushes the current item when already on
item-detail ([2994](src/Alfred.jsx#L2994)) and resets the stack to `[]` otherwise
([2997](src/Alfred.jsx#L2997)). `handleBackFromItemDetail`
([3003-3022](src/Alfred.jsx#L3003-L3022)) pops the stack if non-empty
([3014](src/Alfred.jsx#L3014)), else falls back to `previousView`. Both back handlers
also run the unsaved-changes `window.confirm` guard.

**Bottom line:** collection detail uses `previousView` only. Item detail uses
`itemHistoryStack` with a `previousView` fallback. A flow navigating item →
collection-picker → back would thread through `previousView`, the one shared slot the
codebase already documents as clobberable.

---

## F. MCP server

### F16. Every Edge Function tool that touches collections or items

Two Edge Functions expose tools, and they are different systems.

**1. `supabase/functions/mcp/index.ts`** — the MCP server. All tools go through
`defineTool` from `../_shared/platform.ts`
([mcp/index.ts:9](supabase/functions/mcp/index.ts#L9)); handlers live in
`_shared/alfred-tools/tool-handlers.ts`. `Tier` is `1 | 2 | 3`
([platform.ts:37](supabase/functions/_shared/platform.ts#L37)); tier 3 requires an
explicit `confirmed` flag before the handler runs
([platform.ts:277-282](supabase/functions/_shared/platform.ts#L277-L282)).

Tools touching **collections** or **items**:

| Tool | Tier | `defineTool` | Handler | What it touches |
|---|---|---|---|---|
| `get_collections` | **1** | [mcp/index.ts:250-260](supabase/functions/mcp/index.ts#L250-L260) | [tool-handlers.ts:404-473](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L404-L473) | `item_collections` + `collection_items` + `items` (name resolution) — **read only** |
| `get_items` | **1** | [mcp/index.ts:157-188](supabase/functions/mcp/index.ts#L157-L188) | [tool-handlers.ts:27-64](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L27-L64) | `items` — read |
| `search_items` | **1** | [mcp/index.ts:190-198](supabase/functions/mcp/index.ts#L190-L198) | [tool-handlers.ts:65-106](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L65-L106) | `items` full-text — read |
| `get_tags` | **1** | [mcp/index.ts:307-315](supabase/functions/mcp/index.ts#L307-L315) | [tool-handlers.ts:502-543](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L502-L543) | `items` (+ intents) tag aggregation — read |
| `create_inbox_item` | **1** | [mcp/index.ts:100-148](supabase/functions/mcp/index.ts#L100-L148) | [tool-handlers.ts:544-616](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L544-L616) | writes `inbox` only; accepts `suggested_item_elements` |
| `update_inbox_item` | **2** | [mcp/index.ts:317-347](supabase/functions/mcp/index.ts#L317-L347) | [tool-handlers.ts:617-693](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L617-L693) | writes `inbox` only; documents `suggested_item_elements` as `{type: 'ingredient'\|'step'\|'header'\|'bullet', text}` ([739](supabase/functions/mcp/index.ts#L739)) |

`getCollections`'s membership read is at
[tool-handlers.ts:425-434](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L425-L434),
ordered by `collection_id` then `position`; item names are resolved in one batched
lookup at [440-451](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L440-L451),
and an unresolvable member is reported as `{name: null, unavailable: true}` rather than
falling back to its id ([454-459](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L454-L459)).

The complete registered set is **24 tools**
([mcp/index.ts:555](supabase/functions/mcp/index.ts#L555) onward): `get_contexts`,
`get_items`, `search_items`, `get_execution_history`, `get_intents`, `get_events`,
`get_collections`, `get_inbox`, `get_tags`, `create_inbox_item`, `update_inbox_item`,
`get_database_schema`, `check_platform_conformance`, `get_platform_contract`, plus ten
SAM tools. The only tier-2 tools are `update_inbox_item`, `place_sam_lyrics`,
`update_sam_song_measures`, `load_sam_lyrics`, `create_sam_song`, and
`append_sam_measures`. **No tier-3 tool exists.**

**2. `supabase/functions/ai-enrich/index.ts`** — the inbox enrichment agent. Its tools
are Anthropic tool-use definitions, **not** `defineTool`, and have no tier. It reuses
the same handler module (`executeTool` at
[150-186](supabase/functions/ai-enrich/index.ts#L150-L186)): `get_contexts`, `get_items`,
`search_items`, `get_execution_history`, **`get_collections`**, `get_tags`, `fetch_url`,
`submit_suggestions`. All reads. Its `submit_suggestions` schema
([111-147](supabase/functions/ai-enrich/index.ts#L111-L147)) includes
`suggested_collection_id` ([141](supabase/functions/ai-enrich/index.ts#L141)) and
`suggested_item_elements` ([121-125](supabase/functions/ai-enrich/index.ts#L121-L125)).

### F17. Can any tool add an item to a collection?

**No. DOES NOT EXIST.**

There is **no write tool for `collection_items`, `item_collections`, or `items`** in
either Edge Function. `get_collections` is read-only, and its `SELECT` lists
([tool-handlers.ts:409-412](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L409-L412),
[425-429](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L425-L429)) confirm it
never writes.

The only Alfred-side write tool of any kind is `update_inbox_item` (tier 2), and it
writes the `inbox` table only.

**The closest thing to an indirect path** is `suggested_collection_id` on an inbox row:
the AI sets it, and a **human** completing triage in the UI turns it into a real
membership row via `handleInboxSave` → `addItemsToCollection`
([Alfred.jsx:2004-2015](src/Alfred.jsx#L2004-L2015)). The MCP server cannot write the
membership row itself.

Per the `mcp-platform` skill, a new write tool would need `defineTool` with an
appropriate tier, `ctx.db` (never a directly-imported Supabase client), and a
`check_platform_conformance` run at the end of the migration block.

---

## G. Skill

### G18. The `alfred-enrich` skill

**DOES NOT EXIST as a skill.** Searched exhaustively and found nothing:

- No `.claude/skills/` directory in the repo — `.claude/` contains only
  `settings.local.json`.
- `~/.claude/skills/` contains exactly one skill: `mcp-platform/`.
- No file anywhere in the repo matches `*enrich*` except the Edge Function directory
  `supabase/functions/ai-enrich/`.
- A repo-wide content search for the literal string `alfred-enrich` returns **zero**
  matches.

**The functional equivalent is `supabase/functions/ai-enrich/index.ts`** — the inbox
enrichment agent. Reporting against that, since it is what actually decides element
types.

**Exactly where element types are decided — three places, all prompt/schema text, no
code:**

**1. The tool schema** —
[ai-enrich/index.ts:121-125](supabase/functions/ai-enrich/index.ts#L121-L125):

```ts
suggested_item_elements: {
  type: "array",
  description: "Structured elements (steps, ingredients, checklist items). Each element: {type: 'ingredient'|'step'|'header'|'bullet', text: '...'}",
},
```

Note it is `type: "array"` with a **free-text description and no `items` sub-schema** —
the four type values are enforced by nothing. The model is free to emit any string.

**2. System prompt rule 10** —
[ai-enrich/index.ts:264](supabase/functions/ai-enrich/index.ts#L264):

> 10. For recipes: parse into structured elements with type "ingredient" and "step"

**3. System prompt rule 11** —
[ai-enrich/index.ts:265](supabase/functions/ai-enrich/index.ts#L265):

> 11. For items with multiple steps/components, use elements with type "step", "header", "bullet", or "ingredient"

Two adjacent rules also bear on collections:

- Rule 12 ([266](supabase/functions/ai-enrich/index.ts#L266)) — *"Search collections to
  find capture targets (like grocery lists, shopping lists). Collections with
  `is_capture_target=true` are frequently used for quick capture. If the capture seems
  like it belongs in a collection, set `suggested_collection_id`."*
- Rule 13 ([267](supabase/functions/ai-enrich/index.ts#L267)) — prefer linking to items
  with `is_capture_target=true` over creating new ones.

The re-enrichment path appends a suffix
([270-275](supabase/functions/ai-enrich/index.ts#L270-L275)) but does **not** restate or
alter the element-type rules.

**What changes if ingredients get their own type or tag.** The type vocabulary is
declared in exactly **three string literals in one file** — the schema description at
[124](supabase/functions/ai-enrich/index.ts#L124) and prompt rules 10 and 11 at
[264-265](supabase/functions/ai-enrich/index.ts#L264-L265). There is no enum, no
constant, and no validation, so nothing else in that Edge Function needs touching.

Two further copies of the same vocabulary live in the **MCP server** and would drift if
only `ai-enrich` were edited: [mcp/index.ts:739](supabase/functions/mcp/index.ts#L739)
(`update_inbox_item`) and [mcp/index.ts:708](supabase/functions/mcp/index.ts#L708)
(`create_inbox_item`, looser wording).

The **consuming** side is the client, and the asymmetry there is the thing worth noting:
the AI speaks `{type, text}`, the app stores
`{name, displayType, quantity, description}`, and the only bridge is the three
duplicated inline `map`s in `InboxCard`
([Alfred.jsx:5260-5269](src/Alfred.jsx#L5260-L5269),
[5336-5345](src/Alfred.jsx#L5336-L5345), [5680-5689](src/Alfred.jsx#L5680-L5689)), which
do `displayType: el.type || 'step'` and drop `itemId`. Any new type value arrives in
`displayType` unchanged and unvalidated, is not offered by either editor's three-option
`<select>`, and renders as a step — see B6 and B9.
