# Investigation — tags on collection items, tag autocomplete, and "removed since midnight"

Read-only investigation. No code changed, no SQL run, no database contacted.
Date: 2026-09-14. Branch `main` at `cce1398`.

Everything below is from the repository only. Where the repository cannot answer
a question — which is more often than expected, see **§E** — that is stated
rather than guessed.

---

## Executive summary — the five things that will bite

1. **The lowercase/punctuation rule exists, but it is a *rejection* rule, not a
   normaliser — and it forbids spaces.** `"whole foods"` is not lowercased into
   a tag; it is **thrown away** with an error toast. Your two motivating tags
   (`tjs`, `whole foods`) are one accepted and one rejected by today's code.
   See **§A.2**.

2. **`platform_search_items` filters tags with the jsonb `?|` operator, and its
   definition does not exist anywhere in this repository.** It is live-only SQL.
   Migrating `items.tags` to `text[]` breaks `get_items` over MCP the moment it
   is applied, and the repo gives you nothing to edit. See **§E.1**.

3. **The migrations are *not* a picture of the live schema, and this is already
   documented in-tree.** Only 6 of 29 registered tables have a `CREATE TABLE`
   anywhere. `collection_items` and `collection_item_removals` — the two tables
   at the centre of this work — have **no DDL in the repo at all**. See **§E.4**.

4. **Tag normalisation is *not* currently a twin site, but the change makes it
   one.** Tags are compared raw in every dirty-check. The moment normalisation
   moves to load/save, four dirty-check effects start lying. See **§A.3**.

5. **The "create new" affordance you want to copy only appears when the list is
   *empty*, not at the bottom of results.** `CollectionAddItems` shows
   `Create "X"` only on `filtered.length === 0`. "Select an existing one **or**
   create a new one from the bottom of the list" is a genuine behaviour change,
   not a port. See **§C.1**.

**Good news:** tags do *not* leak through the recipe→collection flow today
(**§D.5**), `removed_at` is reliable and nothing prunes it (**§D.2**), no test
anywhere has a tag fixture (**§E.3**), and `matchesQuery` has already been
extracted (**§C.3**).

---

## A. Tag storage and normalisation

### A.1 Every column that stores tags

Confirmed from [002_phase6_collections_tags.sql:44-51](supabase/migrations/002_phase6_collections_tags.sql#L44-L51):

| Table | Column | Type | Default | Index |
|---|---|---|---|---|
| `items` | `tags` | `JSONB NOT NULL` | `'[]'::jsonb` | `idx_items_tags` GIN |
| `intents` | `tags` | `JSONB NOT NULL` | `'[]'::jsonb` | `idx_intents_tags` GIN |
| `contexts` | `tags` | `JSONB NOT NULL` | `'[]'::jsonb` | `idx_contexts_tags` GIN |

**Your brief named items and intents. There is a third: `contexts.tags`.**
It is jsonb with a GIN index exactly like the other two, it is selected by the
MCP `get_contexts` tool
([tool-handlers.ts:11](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L11)),
and it has **no UI entry point whatsoever** — `TagInput` is never rendered in
`ContextForm`. Decide explicitly whether it migrates with the other two or is
left on jsonb; leaving one of three behind is the kind of thing that is
invisible until something reads all three.

**Other tag columns in the database, out of scope but listed for completeness:**

| Table | Column / shape | Type | Source |
|---|---|---|---|
| `sam_songs` | `tags` | `TEXT[] DEFAULT '{}'` | [001_sam_tables.sql:38](supabase/migrations/001_sam_tables.sql#L38) |
| `dj_albums` | `tags` | `text[]` | [023_dj_albums_for_jazz.sql:107](supabase/migrations/023_dj_albums_for_jazz.sql#L107) |
| `dj_artists` | `tags` | array (unpopulated) | [013_dj_engagement_and_jazz.sql:116-117](supabase/migrations/013_dj_engagement_and_jazz.sql#L116-L117) |
| `dj_artist_tags` | one row per `(artist, tag)` | table, not a column | [016_dj_touch_days_and_jazz_tags.sql:256](supabase/migrations/016_dj_touch_days_and_jazz_tags.sql#L256) |
| `dj_tracks` | `tags` | array (unpopulated) | [013_dj_engagement_and_jazz.sql:116](supabase/migrations/013_dj_engagement_and_jazz.sql#L116) |

Note `sam_songs.tags` is **already `TEXT[]`**. So the target shape has
precedent in this codebase and the storage adapter already round-trips it —
see §E.2.

`collection_items` has **no** tags column today. Neither does
`collection_item_removals`. Both would need one.

### A.2 Does the "lowercase, no punctuation" rule exist?

**Yes — it exists, it is enforced in exactly one place, and it is stricter than
you remember.**

The whole of it is `processTags` inside `TagInput`,
[Alfred.jsx:688-694](src/Alfred.jsx#L688-L694):

```js
function processTags(raw) {
  return raw
    .split(",")
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length > 0 && t.length <= 50)
    .filter((t) => /^[a-z0-9_-]+$/.test(t));
}
```

Read that last line carefully. **It is a rejection filter, not a normaliser.**

- Lowercasing *is* normalisation — `"TJs"` becomes `"tjs"`. ✅
- Punctuation is **not stripped**. A tag containing punctuation fails the regex
  and is **discarded entirely**. `"tj's"` does not become `"tjs"`; it vanishes.
- **The character class has no space.** `"whole foods"` is rejected. The only
  way to express it today is `whole-foods` or `whole_foods`.

The user-facing consequence, [Alfred.jsx:700-705](src/Alfred.jsx#L700-L705):
anything rejected raises *"Invalid tags removed (use only letters, numbers,
hyphens, underscores)"* for three seconds and the typed text is dropped. There
is also a **20-tag cap** ([:706-712](src/Alfred.jsx#L706-L712)) and a **50-char
limit**.

> ⚠️ **This directly contradicts change #2 as briefed.** "Matching ignores case
> and punctuation" presumes tags *may contain* punctuation and spaces and are
> compared loosely. Today punctuation and spaces mean the tag cannot exist. You
> must decide whether the new picker (a) keeps the strict character class and
> normalises `whole foods` → `whole-foods` on entry, or (b) relaxes storage to
> allow spaces and compares with a punctuation-folding matcher. These give
> different stored data and only (b) supports `"whole foods"` displayed as typed.

**Where it is NOT enforced — the rule is not consistent.** Four gaps:

| Entry point | Goes through `processTags`? |
|---|---|
| `TagInput` typed entry (4 sites) | ✅ Yes |
| **AI-suggested tags (inbox)** | ❌ **No** |
| **MCP / `create_inbox_item` writes** | ❌ No |
| **Database constraint** | ❌ None exists |

The AI gap is real and reachable. `ai-enrich` asks the model for
`suggested_tags` with only a *prompt-level* instruction —
*"Suggested tags (lowercase, underscore-separated)"*
([ai-enrich/index.ts:136-140](supabase/functions/ai-enrich/index.ts#L136-L140)) —
and nothing validates the response. Those land in `inbox.suggested_tags`, are
loaded straight into component state
([Alfred.jsx:6930](src/Alfred.jsx#L6930), [:6971](src/Alfred.jsx#L6971)):

```js
const [intentTags, setIntentTags] = useState(inboxItem.suggestedTags || []);
const [itemTags,  setItemTags]  = useState(inboxItem.suggestedTags || []);
```

…and are written to `items.tags` / `intents.tags` verbatim on triage
([:7363](src/Alfred.jsx#L7363), [:7375](src/Alfred.jsx#L7375)) **if the user
never touches the tag box**. `processTags` only ever runs on text the user
types. So a model returning `"Whole Foods"` stores `"Whole Foods"`.

**There is no database-level CHECK constraint** on any tags column in the repo
migrations. Whether one exists live is unknown (§E.4).

**Conclusion for §A.2:** the rule exists but as an *input filter at one
component*, not as a normaliser and not as an invariant. **Existing data cannot
be assumed to satisfy it.** Any migration that assumes all stored tags match
`/^[a-z0-9_-]+$/` may be wrong — audit before relying on it (§G).

### A.3 Is tag normalisation a "twin site"?

**No — not today. But this change creates one, in four places.**

I confirmed the twin-site pattern is real and found its actual instances. It
applies to the **elements** normaliser, not tags. In `ItemDetail`:

- **Site 1** — the `useState` initialiser normalising `item.elements` into the
  canonical `{name, displayType, quantity, description, ...offsetPatch}` shape,
  [Alfred.jsx:10138-10153](src/Alfred.jsx#L10138-L10153).
- **Site 2 (the shadow)** — `originalElements`, the same mapping re-written
  inside the dirty-check effect,
  [Alfred.jsx:10169-10182](src/Alfred.jsx#L10169-L10182).

The same twinning exists in the inbox card: the element normaliser is repeated
inline inside its dirty-check at
[Alfred.jsx:7061-7069](src/Alfred.jsx#L7061-L7069).

**Tags are currently exempt** because they are compared *raw* on both sides:

| Location | Comparison |
|---|---|
| [Alfred.jsx:10187](src/Alfred.jsx#L10187) `ItemDetail` | `JSON.stringify(tags) !== JSON.stringify(item.tags \|\| [])` |
| [Alfred.jsx:11466](src/Alfred.jsx#L11466) `IntentionDetail` | `JSON.stringify(tags) !== JSON.stringify(intent.tags \|\| [])` |
| [Alfred.jsx:7051](src/Alfred.jsx#L7051) inbox (intent) | `JSON.stringify(intentTags) !== JSON.stringify(inboxItem.suggestedTags \|\| [])` |
| [Alfred.jsx:7056](src/Alfred.jsx#L7056) inbox (item) | `JSON.stringify(itemTags) !== JSON.stringify(inboxItem.suggestedTags \|\| [])` |

> ⚠️ **The trap.** Normalisation today happens *inside `TagInput` on the way in*,
> so state already holds normalised tags and the raw comparison happens to work.
> The moment you normalise at **load or save** instead — which an autocomplete
> picker with a canonical suggestion pool will push you toward — these four
> comparisons become twin sites, and a record whose stored tags are *not* in
> canonical form (which §A.2 shows is possible via the AI path) will report
> itself **permanently dirty**: open it, touch nothing, try to navigate away,
> and `confirmDiscardIfDirty` ([:1738](src/Alfred.jsx#L1738)) blocks you with an
> unsaved-changes prompt about changes that do not exist.
>
> **Four shadow sites, all of which must change together with whatever
> normaliser you introduce.** This is the pattern you were right to ask about;
> it just doesn't apply to tags *yet*.

---

## B. Every tag entry point

`TagInput` is rendered in exactly **four** places
(`grep -n "TagInput" src/Alfred.jsx`). All four are identical in mechanism —
free text, comma-separated, rendered back as removable chips, normalised only
by `processTags` at [:688](src/Alfred.jsx#L688).

| # | Where | File / line | Mechanism | Normalisation |
|---|---|---|---|---|
| 1 | Inbox → Intention section | [Alfred.jsx:7738-7742](src/Alfred.jsx#L7738-L7742) | `TagInput`, comma-separated free text → chips | `processTags` **only if typed**; AI-suggested values bypass it (§A.2) |
| 2 | Inbox → Item section | [Alfred.jsx:8008-8012](src/Alfred.jsx#L8008-L8012) | `TagInput` | same, same bypass |
| 3 | Item detail / add (`ItemDetail`) | [Alfred.jsx:10427-10429](src/Alfred.jsx#L10427-L10429) | `TagInput` | `processTags` |
| 4 | Intention detail / add (`IntentionDetail`) | [Alfred.jsx:11608-11610](src/Alfred.jsx#L11608-L11610) | `TagInput` | `processTags` |

The component itself: **[Alfred.jsx:684-762](src/Alfred.jsx#L684-L762)**.

Interaction details that matter for a picker rewrite:
- Commits on **Enter** ([:722-726](src/Alfred.jsx#L722-L726)) **and on blur**
  ([:735](src/Alfred.jsx#L735)). The blur commit is load-bearing — users expect
  a half-typed tag to stick when they tap Save.
- Dedupes against existing on merge via `new Set`
  ([:711](src/Alfred.jsx#L711)).
- Chip removal is exact string equality
  ([:716-718](src/Alfred.jsx#L716-L718)).

**Entry points that do NOT exist today** (worth stating, since your brief says
"everywhere in the app"):

- **Contexts** — `contexts.tags` is a real jsonb column with a GIN index, but
  `ContextForm` ([:8217](src/Alfred.jsx#L8217)) renders no `TagInput`. Tags on
  contexts are **write-only via API, unreachable in the UI**.
- **Collections / collection items** — nothing, as expected; this is change #1.
- **Recycle bin** shows tags read-only in a subtitle
  ([:6620](src/Alfred.jsx#L6620)).

**Read-only tag displays** to keep visually consistent if chips change:
`ItemCard` [:10763-10774](src/Alfred.jsx#L10763-L10774) and intention cards
[:11747-11756](src/Alfred.jsx#L11747-L11756) — both show the first 3 and a
`+N more`.

---

## C. Patterns to copy

### C.1 The add-item-to-collection picker

`CollectionAddItems`, **[Alfred.jsx:803-940](src/Alfred.jsx#L803-L940)**.

**Search/filter logic** ([:807-809](src/Alfred.jsx#L807-L809)) — already on the
shared helper:

```js
const filtered = availableItems.filter((item) =>
  matchesQuery(search, item.name, ...(Array.isArray(item.tags) ? item.tags : [])),
);
```

Note it already searches **name *and* tags**. Plain uncapped `.filter`, no
result cap (unlike `ItemPicker`'s 20), scrolled in a `50vh` box.

**The "create new" affordance** ([:855-868](src/Alfred.jsx#L855-L868)):

```js
{filtered.length === 0 && search.trim() ? (
  <button onClick={() => onCreateItem(search.trim())}>
    Create "{search.trim()}"  …Add as new item in {context}
  </button>
) : filtered.length === 0 ? ( …"No matching items" ) : ( …rows )}
```

> ⚠️ **This is the gap between what exists and what you described.** The
> create-new button is an **empty-state replacement**, not a row at the bottom
> of the list. It is *mutually exclusive* with showing results. Your brief says
> "select one, **or create a new one from the bottom of the list**" — that is a
> different control: create-new must be visible *alongside* matches, because for
> tags the common case is "I typed `tj` and want a brand-new `tjs` even though
> `tj-maxx` matched". Budget for this as new behaviour, not a port.

**Is it reusable as a generic component?** **No — it needs extraction, and it is
the wrong base anyway.** As written it is welded to items and collections:
`availableItems`, `contexts`, `collection`, per-row quantity inputs
([:898-910](src/Alfred.jsx#L898-L910)), a `maxItems` cap, checkbox multi-select
with a `selected` map keyed by item id, and a
`Add (N) to Collection` footer. For tags you want single-select, no quantity, no
context line.

`PROJECT.md` explicitly records it as *"the one deliberate exception"* to the
`ItemPicker` rule, *"multi-select with quantities"*.

**`ItemPicker` ([src/ItemPicker.jsx](src/ItemPicker.jsx), 205 lines) is the
better base** — it is already the extracted, shared, single-select picker with
three variants (`dropdown` / `inline` / `popup`), blur handling with a 200 ms
grace ([:73-75](src/ItemPicker.jsx#L73-L75)), a result cap with an overflow note,
and proper empty-vs-no-match states. **It has no create-new affordance** — that
is the one thing it would need to gain, and it is the thing `CollectionAddItems`
has. A `TagPicker` is most cheaply built as *`ItemPicker`'s structure* + 
*`CollectionAddItems`' create-new button*, generalised to render a bottom row.

### C.2 The Contexts view tag filter

Two components, one shared piece of state.

**The shared control — `TagFilter`,
[Alfred.jsx:765-800](src/Alfred.jsx#L765-L800).** Where it gets its tag list:
**it does not query anything.** It derives the pool client-side by counting tags
across whatever entity array it is handed
([:766-775](src/Alfred.jsx#L766-L775)):

```js
const tagCounts = {};
for (const entity of entities)
  if (entity.tags) for (const tag of entity.tags)
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
```

Rendered as pills reading `tag (count)`, sorted by **descending frequency**,
click to toggle, plus a `Clear` pill. Returns `null` when there are no tags.

**The Contexts view specifically** is `ContextDetail`
([:8544](src/Alfred.jsx#L8544) onward). It renders `TagFilter` over the
context's items at **[:8732](src/Alfred.jsx#L8732)**, and applies the filter at
**[:8603](src/Alfred.jsx#L8603)**:

```js
.filter((item) => !filterTag || (item.tags && item.tags.includes(filterTag)))
```

**Exact, case-sensitive `Array.includes`.** Which is safe *only* because
`processTags` lowercases on entry — and therefore is **not** safe for
AI-suggested tags (§A.2).

**`filterTag` is a single piece of Alfred-level state**, declared at
[:1423](src/Alfred.jsx#L1423), reset at [:1914](src/Alfred.jsx#L1914), and
**shared across three unrelated views**:

| View | `TagFilter` at | filter applied at |
|---|---|---|
| Intentions | [:5827](src/Alfred.jsx#L5827) | [:4919](src/Alfred.jsx#L4919) |
| Memories | [:5886](src/Alfred.jsx#L5886) | [:4927](src/Alfred.jsx#L4927) |
| Context detail | [:8732](src/Alfred.jsx#L8732) | [:8603](src/Alfred.jsx#L8603) |

> ⚠️ One `filterTag` for all views means a tag filter set on Intentions is still
> set when you open a Context. Adding a **fourth** consumer (collection detail)
> to the same single state extends that coupling — and collection tags are a
> *separate suggestion pool* per your brief, so a `tjs` filter leaking in from
> the item pool would be actively wrong. **Give the collection filter its own
> state.**

### C.3 The `matchesQuery` extraction — has it happened?

**Yes. It is done, landed, and tested.**
[`src/utils/search.js`](src/utils/search.js) exists (21 lines), exports
`matchesQuery(query, ...fields)`, and has a dedicated 41-line spec at
[`src/utils/search.test.js`](src/utils/search.test.js). `PROJECT.md` documents
it as *"the one search-matching helper"* and instructs that any new search
reuse it. Both `ItemPicker` ([:133](src/ItemPicker.jsx#L133)) and
`CollectionAddItems` ([:808](src/Alfred.jsx#L808)) already import it.

**However — it does not do what change #2 needs.**
[search.js:15-21](src/utils/search.js#L15-L21) is trimmed, lowercased,
**plain substring**:

```js
return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
```

`matchesQuery` **ignores case but NOT punctuation**, and
[search.test.js:22-25](src/utils/search.test.js#L22-L25) *pins* that inner
whitespace is significant:

```js
test("inner whitespace in the query is kept", () => {
  expect(matchesQuery("kosher  salt", "Kosher Salt")).toBe(false);
});
```

So "matching ignores case and punctuation" is **new capability**, and adding
punctuation-folding to `matchesQuery` itself would **break that existing test
and change every search in the app**. Do not widen it in place.

**There is already a punctuation-folding normaliser to reuse** —
[ingredientMatch.js:337-340](src/utils/ingredientMatch.js#L337-L340):

```js
/** Lowercase, drop punctuation, collapse whitespace. */
function normalize(s) {
  return collapse(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " "));
}
```

Exactly the required semantics. It is **private** (not exported). The clean move
is to extract it — either into `utils/search.js` alongside `matchesQuery` as a
second, opt-in export (e.g. `matchesLoosely`), or into its own module that both
`ingredientMatch` and the new tag picker import. That keeps the spirit of the
in-flight decision (one home for matching, no new inline copies) without
mutating the existing contract.

---

## D. Collections and removals

### D.1 Full schema

> ⚠️ **Neither table has a `CREATE TABLE` anywhere in this repository.** See
> **§E.4**. The columns below are **reconstructed** from the data-access layer
> that reads and writes every one of them,
> [`src/utils/collectionMembers.js`](src/utils/collectionMembers.js), plus
> foreign keys quoted from a live introspection recorded in
> [progress-collection-history.md:457-463](docs/history/progress-collection-history.md#L457-L463).
> **Types marked "inferred" are my reading of usage, not DDL I have seen.**

**`public.collection_items`** — one row per member.

| Column | Type | Evidence |
|---|---|---|
| `id` | pk (inferred) | deleted by `id`, [:559-563](src/utils/collectionMembers.js#L559-L563) |
| `collection_id` | text/uuid FK → `item_collections(id)` **ON DELETE CASCADE** | [progress:459-460](docs/history/progress-collection-history.md#L459-L460) |
| `item_id` | text/uuid FK → `items(id)` (inferred) | [:81-84](src/utils/collectionMembers.js#L81-L84) |
| `quantity` | text, nullable — **free text**, `''` → `NULL` | [:176-181](src/utils/collectionMembers.js#L176-L181) |
| `position` | integer | `.order("position")` [:84](src/utils/collectionMembers.js#L84) |
| `added_at` | timestamptz, column default (inferred) | returned as `addedAt` [:77](src/utils/collectionMembers.js#L77) |
| `added_by` | text/uuid, nullable | [:203](src/utils/collectionMembers.js#L203) |

Constraint: **unique index `collection_items_unique_member` on
`(collection_id, item_id)`** — named in the comment at
[:49-50](src/utils/collectionMembers.js#L49-L50), relied on by
`upsert(..., { onConflict: "collection_id,item_id", ignoreDuplicates: true })`
at [:210-214](src/utils/collectionMembers.js#L210-L214).

**`public.collection_item_removals`** — append-only removal history.

| Column | Type | Evidence |
|---|---|---|
| `id` | pk (inferred) | used as React key / `reAddingRemovalId` |
| `collection_id` | FK → `item_collections(id)` **ON DELETE CASCADE** | [progress:461-462](docs/history/progress-collection-history.md#L461-L462) |
| `item_id` | text/uuid | [:530](src/utils/collectionMembers.js#L530) |
| `item_name` | text, **nullable** — snapshot at removal time | [:531](src/utils/collectionMembers.js#L531) |
| `quantity` | text, nullable — snapshot | [:532](src/utils/collectionMembers.js#L532) |
| `position` | integer, nullable — snapshot | [:533](src/utils/collectionMembers.js#L533) |
| `reason` | text — `'manual'` \| `'completed'` | [:41-47](src/utils/collectionMembers.js#L41-L47) |
| **`removed_at`** | **timestamptz, column default `now()`** | [:526-527](src/utils/collectionMembers.js#L526-L527) |
| `removed_by` | text/uuid, nullable | [:535](src/utils/collectionMembers.js#L535) |

`item_name` is deliberately nullable: it is null when the item row was deleted
**or** when RLS hides it from the reader — the client cannot tell those apart
([:151-158](src/utils/collectionMembers.js#L151-L158)).

Also relevant: **`item_collections`** *does* have DDL,
[002:7-16](supabase/migrations/002_phase6_collections_tags.sql#L7-L16) — but the
`items JSONB` column there is the **legacy** membership blob that
`collection_items` replaced. `item_collections.archived` was added later
out-of-band ([technical-spec-ui-standardization.md:519](docs/technical-spec-ui-standardization.md#L519)
says *"is already applied"*), which is itself a drift example.

### D.2 Does the removals table have a timestamp? Is it reliable? Does anything prune it?

**Yes / yes / nothing in the repo.**

- **Name and type:** `removed_at`, timestamptz.
- **Populated reliably — by construction.** `removeMembers` deliberately
  **omits** `removed_at` from the insert payload so the **column default**
  supplies it. Verbatim, [:526-527](src/utils/collectionMembers.js#L526-L527):

  > *"removed_at is left to the column default so every row in this one
  > statement shares the server's transaction timestamp exactly."*

  And [:516-519](src/utils/collectionMembers.js#L516-L519):

  > *"All rows go in one INSERT, so a bulk removal shares a single `removed_at`
  > — `now()` is transaction-stable … **The timestamp is the server's, not the
  > client's.**"*

  This is the ideal property for change #3: it is a **server** clock, so
  "since midnight" cannot be spoofed or skewed by a device with a wrong clock,
  and a bulk removal is one atomic instant.

- **Nothing in this repository prunes, expires, TTLs, or archives
  `collection_item_removals`.** I searched migrations, `docs/sql/`, all Edge
  Functions, and `scripts/`. The only deletions that can ever reach it are:
  1. **`ON DELETE CASCADE`** when the parent `item_collections` row is
     hard-deleted — the one remaining hard delete in the app, reachable only
     from the Recycle Bin's terminal delete
     ([Alfred.jsx:2282-2284](src/Alfred.jsx#L2282-L2284),
     [:2384-2386](src/Alfred.jsx#L2384-L2386)), behind two confirms, and
     explicitly called out in the dialog copy
     ([:2101-2107](src/Alfred.jsx#L2101-L2107)).
  2. **RLS permits DELETE** on the table even though it is append-only by
     intent — a known, accepted residual risk, flagged at
     [progress-collection-history.md:735-737](docs/history/progress-collection-history.md#L735-L737).

  **Your observation that rows survive from early August is consistent with the
  code: the table is genuinely persistent.** I cannot verify the live retention
  without the database, but nothing in the repo would remove them.

> ⚠️ **But three *read-side* caps will hide old rows**, and all three must move
> for "uncapped since midnight":
> - `MAX_REMOVALS = 200` hard ceiling in `loadRemovals`
>   ([:53-55](src/utils/collectionMembers.js#L53-L55)) — clamps any request.
> - The panel's fetch asks for **`limit: 25`**
>   ([Alfred.jsx:3957-3960](src/Alfred.jsx#L3957-L3960)).
> - The render then takes **`.slice(0, 5)`** (§D.3).
>
> A heavy shopping day could exceed 25 removals before it exceeds 200. Changing
> only the `.slice(0, 5)` would silently keep a 25-row ceiling.

### D.3 How "last 5 removed" is computed, and where

One place: **[Alfred.jsx:6029-6032](src/Alfred.jsx#L6029-L6032)**, inline in the
`collection-detail` render branch.

```js
const memberItemIds = new Set(members.map((m) => m.itemId));
const recentRemovals = (collectionRemovals[coll.id] || [])
  .filter((r) => !memberItemIds.has(r.itemId))
  .slice(0, 5);
```

Three-stage pipeline, all three stages relevant:

1. **Fetch** — `loadCollectionRemovals`
   ([:3956-3960](src/Alfred.jsx#L3956-L3960)) calls `loadRemovals` with
   `reason: REMOVAL_MANUAL, limit: 25`. So `'completed'` bulk clears never
   reach the panel, by design. Ordered `removed_at DESC` in SQL
   ([collectionMembers.js:116-118](src/utils/collectionMembers.js#L116-L118)).
2. **Filter** — drops any removal whose item is **currently back in the
   collection**. This is how "Put back" clears the row without its own
   optimistic update ([:4013-4017](src/Alfred.jsx#L4013-L4017)).
3. **Cap** — `.slice(0, 5)`.

Separately, `loadCollectionHistory` ([:3986-3987](src/Alfred.jsx#L3986-L3987))
fetches `limit: 50` with **no reason filter** for the full-history view. Kept as
a distinct query deliberately ([:3980-3985](src/Alfred.jsx#L3980-L3985)): heavy
completion churn could otherwise push every manual row out of a mixed window.

The panel also refreshes on a **poll while the detail view is open**
([:1959-1961](src/Alfred.jsx#L1959-L1961)) — membership and removals, but not
history.

**For change #3, the edits are:** stage 1's `limit: 25` → uncapped (and
`MAX_REMOVALS` raised or bypassed), stage 3's `.slice(0, 5)` → a
`removedAt >= startOfLocalDay()` predicate. Stage 2's filter should almost
certainly stay.

### D.4 How restore-from-removed works, and what a tag needs

`reAddRemoval` ([collectionMembers.js:645-661](src/utils/collectionMembers.js#L645-L661))
is a thin wrapper:

```js
return addMember(removal.collectionId, removal.itemId, {
  quantity: removal.quantity,
  userId: options.userId,
});
```

→ `addMember` ([:591-605](src/utils/collectionMembers.js#L591-L605))
→ `addMembers` ([:196-230](src/utils/collectionMembers.js#L196-L230)), which
builds the row:

```js
toSnakeCase({ collectionId, itemId: entry.itemId,
              quantity: normaliseQuantity(entry.quantity),
              position: position + index, addedBy: userId || null })
```

**Columns copied back today: `item_id`, `quantity` only.** Plus a *fresh*
`position` (appended at `max+1`, not the snapshotted one — deliberate,
[:634-636](src/utils/collectionMembers.js#L634-L636)) and a fresh `added_by`.
The removal record is **left in place** — the table is append-only and re-adding
is a plain insert, not an undo ([:638-642](src/utils/collectionMembers.js#L638-L642)).

**To make a tag survive the round trip, five edits, all in `collectionMembers.js`:**

| # | Function | Line | Change |
|---|---|---|---|
| 1 | schema | — | `tags` column on **both** `collection_items` and `collection_item_removals` |
| 2 | `removeMembers` | [:528-536](src/utils/collectionMembers.js#L528-L536) | add `tags: member.tags ?? []` to the snapshot payload |
| 3 | `addMembers` | [:201-208](src/utils/collectionMembers.js#L201-L208) | accept and write `entry.tags` |
| 4 | `addMember` | [:597-601](src/utils/collectionMembers.js#L597-L601) | pass `options.tags` through |
| 5 | `reAddRemoval` | [:658-661](src/utils/collectionMembers.js#L658-L661) | pass `tags: removal.tags` |

> ⚠️ **Watch `addOrMergeMembers`** ([:365](src/utils/collectionMembers.js#L365)).
> It has a full merge policy for `quantity` (`mergeQuantities`,
> [:454-467](src/utils/collectionMembers.js#L454-L467) — concatenates with
> `" + "`) and a `collapseEntries` pre-pass. **Tags will need their own merge
> policy** (union? incoming wins? leave existing alone?) or adding an already-
> present item via the recipe flow will silently drop or duplicate tags. This is
> an unasked design question your brief does not answer — and note that per
> change #1 tags are *not* applied on first add, which argues for "leave
> existing tags alone" as the default.
>
> ⚠️ **`updateMemberQuantity` is a targeted `.update({ quantity })`**
> ([:472-478](src/utils/collectionMembers.js#L472-L478)) and will not clobber
> tags — good. But a tag edit needs its own equivalent function; do **not**
> widen this one, since `addOrMergeMembers` calls it in a loop.

### D.5 Does the `collectableItemId` / recipe→collection flow carry source tags?

**No. They do not come along today — the requirement is already satisfied.**

Traced end to end:

- `addElementsToCollection` ([Alfred.jsx:3876-3878](src/Alfred.jsx#L3876-L3878))
  builds `entries` as **`{ itemId, quantity }` only**
  ([:3843](src/Alfred.jsx#L3843)) and calls `addOrMergeMembers(collectionId,
  entries, { userId })`.
- `addOrMergeMembers` → `collapseEntries`
  ([:469-489](src/utils/collectionMembers.js#L469-L489)) rebuilds every entry as
  **`{ itemId, quantity }`**, discarding any other field even if one were passed.
- `addMembers` writes only the six columns listed in §D.4.

**There is no code path by which `items.tags` reaches `collection_items`.**
Additionally, items *newly created* by that flow are explicitly seeded with
`tags: []` ([Alfred.jsx:3834](src/Alfred.jsx#L3834)).

Same for the multi-select picker: `CollectionAddItems` emits
`{ itemId, quantity }` ([:826-828](src/Alfred.jsx#L826-L828)).

✅ **No work needed here — but add a regression test**, because once
`addMembers` learns to accept `entry.tags` (§D.4 edit #3), `collapseEntries`
becomes the only thing standing between source-item tags and collection rows,
and it is easy to "helpfully" widen it while implementing change #1.

---

## E. Migration blast radius

### E.1 What depends on the jsonb shape

**🔴 `platform_search_items` — the one genuine breaker.**

[mcp/index.ts:200-216](supabase/functions/mcp/index.ts#L200-L216), the `get_items`
MCP tool:

```js
// All filtering (including jsonb `?|` any-of-tags) runs in Postgres
// via public.platform_search_items …
const { data, error } = await ctx.db.rpc("platform_search_items", {
  p_context_id: contextId ?? null, p_search_text: searchText ?? null,
  p_tags: tags && tags.length > 0 ? tags : null, p_limit: LIMIT,
});
```

`?|` is the **jsonb "any key exists"** operator. It **does not exist for
`text[]`** — the array equivalent is the overlap operator `&&`. So the RPC's
tag filter fails the moment `items.tags` becomes `text[]`.

> ⚠️ **And the RPC's definition is not in this repository.** I searched all of
> `supabase/migrations/` and `docs/sql/`: `platform_search_items` appears
> **only** in the Edge Function that calls it and in a passing mention at
> [progress-dj.md:877](docs/progress-dj.md#L877). The `CREATE FUNCTION` exists
> only in the live database. **You must dump it before you can migrate it**, and
> a `CREATE OR REPLACE FUNCTION` for it has to ship in the same migration as the
> column type change or `get_items` breaks between the two.
>
> The comment even says *"See supabase migration adding platform_search_items"*
> — **that migration does not exist in the repo.**

**🟢 Everything else in the MCP / Edge layer is safe.** All other tag filtering
is **client-side JavaScript over the already-decoded array**, and supabase-js
decodes both `jsonb` string arrays and `text[]` into a plain JS `string[]`:

| Consumer | File / line | Why it survives |
|---|---|---|
| `getItems` | [tool-handlers.ts:53-57](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L53-L57) | `results.filter(item => tags.some(t => item.tags.includes(t)))` — pure JS. Comment at [:48](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L48) even says *"filter client-side for simplicity"* |
| `getIntents` | [:239-245](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L239-L245) | same pattern, `(row.tags \|\| []).includes(tag)` |
| `getTags` | [:502-541](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L502-L541) | `select("tags")` then JS `for…of` count over items + intents |
| `searchItems` | [:72](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L72) | selects `tags`, never filters on it |
| `getContexts` | [:11](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L11) | selects `tags`, never filters on it |
| `ai-enrich` | [ai-enrich/index.ts:164](supabase/functions/ai-enrich/index.ts#L164), [:177-178](supabase/functions/ai-enrich/index.ts#L177-L178) | delegates to the handlers above |
| types | [types.ts:10,23,37](supabase/functions/_shared/alfred-tools/types.ts#L10) | already `tags: string[]` — correct for both shapes |

**🟢 Frontend: no jsonb-specific syntax anywhere.** Every read is
`item.tags.includes(...)`, `entity.tags` iteration, or `JSON.stringify`
comparison. The two direct selects
([Alfred.jsx:2136](src/Alfred.jsx#L2136), [:2142](src/Alfred.jsx#L2142)) name
`tags` as a plain column. No `->>`, `->`, `@>`, `?|`, `jsonb_array_elements`, or
`.contains()` against tags anywhere in `src/`.

**🟢 `caseConvert` is transparent to the change.**
[caseConvert.js:23-37](src/utils/caseConvert.js#L23-L37) recurses into arrays,
but strings hit `typeof value === "object" && value !== null` → false and pass
through untouched. An array of strings round-trips identically either way. The
module's own header
([:11-14](src/utils/caseConvert.js#L11-L14)) warns that the recursion into jsonb
is "load-bearing" — that concerns `item_collections.items` (objects with
`item_id` keys), **not** tags.

**Precedent:** `sam_songs.tags` is already `TEXT[]`
([001_sam_tables.sql:38](supabase/migrations/001_sam_tables.sql#L38)) and is read
through the same storage adapter, so the target shape is proven in-tree.

### E.2 Indexes, constraints, RLS

**From the repo (migration 002):**

- **Indexes — must be dropped and recreated.** `idx_items_tags`,
  `idx_intents_tags`, `idx_contexts_tags` are all
  `USING GIN (tags)`
  ([002:45,48,51](supabase/migrations/002_phase6_collections_tags.sql#L45)).
  A GIN index on `jsonb` uses `jsonb_ops`; on `text[]` it uses `array_ops`.
  **`ALTER COLUMN … TYPE` will not silently convert the opclass** — drop each
  index first, alter, then `CREATE INDEX … USING GIN (tags)` again.
- **`NOT NULL DEFAULT '[]'::jsonb`** must become
  `NOT NULL DEFAULT '{}'::text[]` on all three columns.
- **Constraints:** no CHECK constraint on any tags column in the repo.
- **RLS:** the policies in 002
  ([:25-39](supabase/migrations/002_phase6_collections_tags.sql#L25-L39)) are on
  `item_collections` and key off `user_id` / `shared`. **No policy in the repo
  references `tags`.**

> ⚠️ **I can only speak for the repo.** Because of §E.4, there may be indexes,
> CHECK constraints, generated columns, triggers, or policies on these columns
> that were applied out-of-band and are invisible here. **Dump the live
> definitions of all three columns, their indexes, and their policies before
> writing the migration.**

Per the `mcp-platform` skill, a new table (or a changed one) also needs
`platform.register_table()` and a closing `check_platform_conformance` — and
`collection_items` / `collection_item_removals` are already registered
([progress-collection-history.md:9-13](docs/history/progress-collection-history.md#L9-L13)
records *"created, registered, policies written"* and a CONFORMANT check of
16 tables).

### E.3 Tests with hard-coded tag fixtures or counts

**None. Zero.** A repo-wide search for `tags` across every `*.test.js`,
`*.test.jsx`, and `*.test.mjs` returned **no matches**.

Confirmed absent from: `search.test.js`, `ItemPicker.test.jsx`,
`collectionMembers.test.js`, `ingredientMatch.test.js`, `sortOrders.test.js`,
`viewPaths.test.js`, `AppLink.test.jsx`, `UndoMessage.test.jsx`,
`manifest.test.js`, `executionColdLoad.test.jsx`, and every `utils/*.test.js`.

✅ **The migration cannot break a test by changing tag shape.** The flip side:
**there is no test coverage protecting tag behaviour at all**, so nothing will
catch a regression either. `collectionMembers.test.js` (270 lines) is the
natural home for new coverage — note its suite was described as *"23 assertions"*
run against a scratchpad harness, with removal-path tests
*"not wired"* into CI ([progress-collection-history.md:554-560](docs/history/progress-collection-history.md#L554-L560)).
Worth checking what actually runs in `npm test` before relying on it.

### E.4 Are the migrations a reliable picture of the live schema?

**No. Emphatically not — and this is already documented in-tree as a known,
repo-wide condition.**

From [progress-dj.md:986-1002](docs/progress-dj.md#L986-L1002), under a heading
reading **"⚠️ THE SCHEMA HAS NO SOURCE OUTSIDE THE DATABASE — REPO-WIDE, NOT A
DJ GAP"**:

> *"Only **six of 29 registered tables** have a `create table` anywhere in
> `supabase/migrations/`: `sam_songs`, `sam_sessions`, `sam_snippets`,
> `item_collections`, and the two reconstructed here. **Missing entirely:**
> `items`, `contexts`, `intents`, `events`, `executions`, `inbox`,
> `sam_song_measures`, … **`collection_items`**, **`collection_item_removals`**,
> and all nine remaining DJ tables."*
>
> *"**The existing migration files are documentation, not a runnable build.**
> Every original says 'Run this in the Supabase SQL Editor' in its header; the
> filenames are `001_`–`005_` rather than the CLI's required
> `<14-digit timestamp>_name.sql`, so **the CLI has never applied them and there
> is no remote migration history**; and `001_sam_tables.sql` uses bare
> `CREATE TABLE` with no `IF NOT EXISTS`, so it cannot be re-run."*

**Every table this project touches is in the missing list:** `items`, `intents`,
`contexts`, `collection_items`, `collection_item_removals`.

Independent corroboration of drift:

- [collectionMembers.js:4-6](src/utils/collectionMembers.js#L4-L6) says
  *"Migration 005 created both"* — but repo `005` is
  `005_dj_plays_dedupe_key.sql`. **The numbering has collided**; the real
  migration 005 was applied out-of-band and never committed.
- [002_phase6_collections_tags.sql:1-2](supabase/migrations/002_phase6_collections_tags.sql#L1-L2)
  literally reads *"Run this in the Supabase SQL Editor"*.
- `item_collections.archived` is *"already applied"*
  ([technical-spec-ui-standardization.md:519](docs/technical-spec-ui-standardization.md#L519))
  with no migration in the repo.
- `platform_search_items` — called in production, defined nowhere (§E.1).
- The remedy proposed in `progress-dj.md` was a snapshot via
  `supabase db dump --schema public,platform -f supabase/schema-snapshot.sql`.
  **I checked: `supabase/schema-snapshot.sql` does not exist.** The snapshot was
  planned and never taken.

> ⚠️ **Hard blocker for phase 0.** You cannot write a correct migration for a
> column whose current definition you have not seen, on tables whose DDL is not
> in the repo, alongside an RPC whose body is not in the repo. **Take the schema
> dump first.** It is also the single highest-leverage thing this project can
> leave behind.

---

## F. Timezone handling — "start of the local day"

**There is no general-purpose "start of local day" helper in Alfred.** There is
a well-built Pacific-time date toolkit, but it lives in **SAM**, returns
**date keys, not instants**, and Alfred's own date code uses **browser-local**
time.

**What exists — `src/sam/lib/practiceTimeFormat.js`:**

The file header states the policy plainly
([:7-8](src/sam/lib/practiceTimeFormat.js#L7-L8)):

> *"Pacific time (America/Los_Angeles) is hardcoded throughout — sessions are
> bucketed by their start day in PT, never by browser local time."*

| Helper | Line | Returns |
|---|---|---|
| `ptDateKey(dateInput)` | [:27-29](src/sam/lib/practiceTimeFormat.js#L27-L29) | `"YYYY-MM-DD"` for the **PT** calendar date of any instant (via `Intl.DateTimeFormat` `en-CA`) |
| `ptDayName` | [:34-36](src/sam/lib/practiceTimeFormat.js#L34-L36) | PT weekday name |
| `dateKeyMinusDays` | [:44-51](src/sam/lib/practiceTimeFormat.js#L44-L51) | key arithmetic, **DST-safe** (UTC components) |
| `ptDayNameFromKey` | [:58-61](src/sam/lib/practiceTimeFormat.js#L58-L61) | uses UTC-noon anchoring to stay clear of the midnight boundary |
| `daysBetween` | [:68-72](src/sam/lib/practiceTimeFormat.js#L68-L72) | integer day delta, DST-safe |

[`src/sam/lib/samFormat.js`](src/sam/lib/samFormat.js) builds on it and states
the rule ([:3-6](src/sam/lib/samFormat.js#L3-L6)):

> *"One rule: every 'today' / 'yesterday' / weekday check delegates to
> practiceTimeFormat.js. A hand-rolled Date comparison here would drift out of
> Pacific-time alignment at midnight and permanently if the user practises from
> another timezone."*

**Exactly the discipline change #3 needs.** It is tested
([samFormat.test.js](src/sam/lib/samFormat.test.js) pins assertions to
America/Los_Angeles).

**What Alfred does instead — browser-local, not LA:**

Alfred's date handling is `setHours(0, 0, 0, 0)` on a local `Date`:
[Alfred.jsx:512-513](src/Alfred.jsx#L512-L513),
[:3374](src/Alfred.jsx#L3374), and throughout
[`src/utils/recurrence.js`](src/utils/recurrence.js) (lines 50, 90, 109, 124,
253, 264, 294, 318, 341, 361). **`setHours` operates in the runtime's local
timezone** — correct while the browser is in PT, wrong the moment it is not.
Display formatters use `toLocaleDateString()` with **no `timeZone` option**
([:6839](src/Alfred.jsx#L6839), [:10788](src/Alfred.jsx#L10788),
[:11766](src/Alfred.jsx#L11766)), i.e. browser-local again.

**The gap.** `ptDateKey` gives a *key*, but the natural query for change #3 is
`removed_at >= <instant>`. Two viable approaches:

1. **Compare keys, client-side.** Fetch removals, keep those where
   `ptDateKey(r.removedAt) === ptDateKey(new Date())`. Reuses tested code
   verbatim, no new timezone maths, and is DST-correct by construction. Costs an
   over-fetch (must fetch enough rows to cover today — interacts with the caps
   in §D.2).
2. **Compute the PT-midnight instant and filter server-side**
   (`.gte("removed_at", iso)`). More efficient and truly uncapped, but needs a
   *new* helper — deriving the correct UTC instant for PT midnight requires
   resolving the offset for that date (PST vs PDT). **This is new, subtle,
   DST-sensitive code and must be unit-tested across a DST boundary** (e.g.
   2026-03-08 and 2026-11-01).

> ⚠️ Whichever is chosen, the helper belongs in **`src/utils/`**, not
> `src/sam/lib/` — Alfred importing from SAM's internals would be a new
> cross-app dependency. Cleanest: move/re-export the PT primitives into a shared
> `utils/` module that SAM continues to use, so there remains **one** definition
> of "the Pacific day".
>
> ⚠️ Note the `removed_at` default is **server** `now()` (§D.2) — a UTC
> timestamptz from Postgres, *not* the client's clock. That is good (it cannot
> be skewed), and it means the comparison is genuinely "server instant vs PT
> midnight", with no client-clock trust anywhere.

---

## G. Tag data audit

**The live data is not reachable from this codebase, and I did not attempt to
connect to the database.** Here is precisely what the repo can and cannot tell
you.

**There is no tag data in the repository at all:**

- **No seed or fixture data containing tags.** The only seed files are
  `017_dj_seed_jazz_tags.sql` (DJ artist tags — a different table, out of scope)
  and `docs/ken-seed-check-task-prompt.md` (Ken, unrelated).
- **No test fixture carries tags** (§E.3). The one realistic corpus in-tree,
  `SHOPPING` in
  [ingredientMatch.test.js:19](src/utils/ingredientMatch.test.js#L19) —
  described as *"a slice of the real Shopping context"* — has item names and ids
  but **no tags field**.
- **No `.sql` dump, snapshot, or export** containing `items`/`intents` rows
  (§E.4 — the planned snapshot was never taken).
- `src/sam/lib/__fixtures__/` holds only `old-someone-like-you.export.json`
  (SAM song data).

**What can be inferred about the shape, not the content:**

- Any tag written through `TagInput` matches `/^[a-z0-9_-]+$/`, ≤50 chars, ≤20
  per record.
- Any tag written via the **AI path or MCP** may violate all of that (§A.2) —
  so **do not assume the corpus is clean**.
- Counts are computable live but only over **non-archived** rows: both
  `getTags` ([tool-handlers.ts:508-517](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L508-L517))
  and `TagFilter` exclude archived records. An archived item's tags are
  invisible to every counter in the app but **still present in the column** and
  **still migrated**.

> **To pull this yourself**, the `get_tags` MCP tool already returns exactly
> `{tag, count}` sorted by frequency across items + intents
> ([tool-handlers.ts:502-541](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L502-L541)).
> It will **not** cover `contexts.tags` or archived rows. For the migration you
> want the unfiltered picture — something like, per column,
> `select tag, count(*) from items, jsonb_array_elements_text(tags) tag group by 1 order by 2 desc`
> **including archived**, plus a `where tag !~ '^[a-z0-9_-]+$'` pass to find
> anything the strict rule would reject. I have not run these.

---

## Flags — what will make this harder than expected

| # | Issue | Severity | Where |
|---|---|---|---|
| 1 | `platform_search_items` uses jsonb `?|`; **its source is not in the repo** and it breaks on `text[]` | 🔴 Blocker | §E.1 |
| 2 | **No DDL in the repo** for `items`, `intents`, `contexts`, `collection_items`, `collection_item_removals`; migrations are documentation, not a build | 🔴 Blocker | §E.4 |
| 3 | The tag rule **rejects spaces** — `"whole foods"` is impossible today; change #2's "ignore punctuation" contradicts the current model | 🔴 Design | §A.2 |
| 4 | Normalising at load/save turns **4 dirty-checks into twin sites** → phantom unsaved-changes prompts | 🟠 High | §A.3 |
| 5 | AI-suggested tags **bypass all validation**; existing data may be non-conforming | 🟠 High | §A.2 |
| 6 | "Create new" in `CollectionAddItems` is an **empty-state replacement**, not a bottom-of-list row — genuine new behaviour | 🟠 High | §C.1 |
| 7 | `matchesQuery` **ignores case but not punctuation**, and a test pins that. Do not widen it in place; extract `normalize` from `ingredientMatch.js` instead | 🟠 High | §C.3 |
| 8 | **Three** read caps hide old removals (`slice(0,5)`, `limit: 25`, `MAX_REMOVALS = 200`) — all must move | 🟠 High | §D.2 |
| 9 | `contexts.tags` is a **third** jsonb tags column with a GIN index and no UI — decide whether it migrates | 🟠 High | §A.1 |
| 10 | GIN indexes need **drop + recreate** (jsonb_ops → array_ops); `ALTER TYPE` alone is insufficient | 🟡 Medium | §E.2 |
| 11 | `addOrMergeMembers` needs a **tag merge policy** that does not exist | 🟡 Medium | §D.4 |
| 12 | PT-midnight-as-an-instant does not exist; only PT **date keys** do, and they live in SAM | 🟡 Medium | §F |
| 13 | Single shared `filterTag` across 3 views; a 4th consumer with a separate pool would leak | 🟡 Medium | §C.2 |
| 14 | **Zero** test coverage on tags anywhere — nothing will catch a regression | 🟡 Medium | §E.3 |
| 15 | Collection membership has **no realtime channel**, only a 5s poll while the view is open — a partner's tag edit is not live | 🟢 Low | §D.3 |

---

## Proposed phase breakdown

No implementation code here — sequence and exit criteria only. Phases 0 and 1
are ordered deliberately: **neither migration can be written safely until the
dump exists.**

### Phase 0 — Establish a schema source *(blocking; do before any code)*
- Take the dump that `progress-dj.md` proposed and never happened:
  `supabase db dump --schema public,platform -f supabase/schema-snapshot.sql`.
- Extract and commit the live definitions of: `items.tags`, `intents.tags`,
  `contexts.tags` (+ their indexes, constraints, policies), `collection_items`,
  `collection_item_removals`, and **`platform_search_items`**.
- **Exit:** §D.1's inferred types are replaced by real DDL, and you are holding
  the RPC body you must rewrite.

### Phase 1 — Tag data audit *(read-only; can run in parallel with Phase 0)*
- Frequency per tag per column, **including archived rows and `contexts`**.
- Count rows whose tags violate `/^[a-z0-9_-]+$/` — how much AI-path drift is
  actually in there (§A.2).
- **Exit:** a decision on Flag #3 — strict-with-normalisation vs allow-spaces —
  made against real data, since it determines the migration's data step.

### Phase 2 — Decide the tag model *(design; no code)*
- Resolve Flag #3, then: canonical form, display form, comparison rule.
- Decide `contexts.tags` in or out (Flag #9).
- Decide the `addOrMergeMembers` tag merge policy (Flag #11).
- **Exit:** a written rule that Phases 3 and 5 both implement.

### Phase 3 — Extract the shared matcher *(pure refactor, no behaviour change)*
- Lift `normalize` out of `ingredientMatch.js` into a shared home beside
  `matchesQuery`; **leave `matchesQuery`'s contract and its test untouched**
  (Flag #7).
- Add tests for the loose matcher.
- **Exit:** `ingredientMatch` uses the extracted helper, all existing tests green.

### Phase 4 — jsonb → text[] migration *(schema; ships with its RPC rewrite)*
- One migration: drop the three GIN indexes, `ALTER COLUMN … TYPE text[] USING …`,
  reset defaults to `'{}'::text[]`, recreate GIN indexes, **and
  `CREATE OR REPLACE platform_search_items` with `&&` in place of `?|` in the
  same transaction** (Flags #1, #10).
- Normalise existing data in the same migration if Phase 1 found violations.
- Close with `check_platform_conformance` per the `mcp-platform` house rules.
- **Exit:** `get_items` with a `tags` filter verified over MCP; frontend
  untouched and still working (§E.1 says it needs no changes).

### Phase 5 — The tag picker *(the largest UI phase)*
- Build `TagPicker` on `ItemPicker`'s structure + a **persistent** bottom
  create-new row (Flag #6), using Phase 3's matcher.
- Separate suggestion pools: collection tags vs item/intent tags.
- Replace all four `TagInput` sites (§B). **Preserve the blur-commit behaviour.**
- **Update the four dirty-check shadow sites together with whatever
  normalisation you introduce** (Flag #4).
- Close the AI-path bypass so suggested tags are normalised on load (Flag #5).
- **Exit:** every entry point normalises identically; no phantom
  unsaved-changes prompt on a record with legacy tags.

### Phase 6 — Tags on collection items
- Add `tags` to **both** `collection_items` and `collection_item_removals`.
- The five `collectionMembers.js` edits in §D.4, plus a dedicated
  `updateMemberTags` (do **not** widen `updateMemberQuantity`).
- Tag UI on the collection row; tag filter on the collection list with **its own
  filter state**, not the shared `filterTag` (Flag #13).
- **Regression test: recipe→collection must still not carry source-item tags**
  (§D.5) — `collapseEntries` is the only guard once `addMembers` accepts tags.
- **Exit:** a tag survives remove → restore round trip; first-add applies no tags.

### Phase 7 — "Removed since local midnight"
- Add a PT day-boundary helper in `src/utils/`, re-exported to SAM so there is
  one definition (Flag #12). **Test across a DST boundary.**
- Replace `.slice(0, 5)` with the midnight predicate, **and** lift `limit: 25`
  **and** `MAX_REMOVALS = 200` (Flag #8).
- **Exit:** uncapped list of today's removals, correct at 23:59 and 00:01 PT,
  from a browser set to a non-PT timezone.

### Phase 8 — Backfill coverage
- Tests for tag normalisation, the picker's matching, and the removal round
  trip — the areas Flag #14 shows are currently bare.
- Verify what `npm test` actually runs, given the collection-history harness was
  never wired in.
