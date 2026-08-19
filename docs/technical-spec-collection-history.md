# Technical Spec — Collection Membership Rows and Removal History

## Overview

Alfred stores collection membership inside a single `items jsonb` column on
`item_collections`. Every edit rewrites the whole column, so when two people edit
the same collection at once, the second save silently overwrites the first — one
person's additions disappear. The blob also has nowhere to record when something
was removed, so an accidental removal is unrecoverable.

Migration 005 has already been applied and verified CONFORMANT. It added two
tables. This spec covers the application-side work to move onto them.

## Current database state (already done — do not re-create)

**`public.collection_items`** — one row per member.

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key, defaults to a generated id |
| `collection_id` | text | references `item_collections(id)`, cascades on delete |
| `item_id` | text | the `items.id`; deliberately not a foreign key |
| `quantity` | text | free text; empty string was normalised to null on backfill |
| `position` | integer | display order, zero-based |
| `added_at` | timestamptz | defaults to now() |
| `added_by` | uuid | `auth.uid()`; null for backfilled rows |

Unique index on `(collection_id, item_id)` — an item appears at most once per
collection. Index on `(collection_id, position)`.

**`public.collection_item_removals`** — append-only history.

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `collection_id` | text | references `item_collections(id)`, cascades |
| `item_id` | text | used to re-add |
| `item_name` | text | captured at removal time, not looked up live |
| `quantity` | text | so re-adding restores the original amount |
| `position` | integer | position at removal time |
| `reason` | text | `'manual'` or `'completed'`, constrained |
| `removed_at` | timestamptz | bulk removals share one timestamp |
| `removed_by` | uuid | the actual user |

Index on `(collection_id, removed_at desc)`.

Row-level security on both tables is inherited from the parent collection: the
owner has full access, and a collection flagged `shared = true` is accessible to
any signed-in user. This mirrors `item_collections` exactly.

**The old `item_collections.items` jsonb column still exists and still holds
data.** It is not dropped by this work. Once the UI has fully moved over it
becomes a frozen backup snapshot that nothing reads or writes. Dropping it is a
separate later migration, deliberately deferred so there is a rollback path.

## Key case — resolved in Step 1

The jsonb array elements use the key `item_id`. React state uses `itemId`. **Both
are correct, at different layers**, and neither should be "fixed" to match the
other.

The conversion layer was confirmed from source: `toSnakeCase` and `toCamelCase`,
methods on the `storage` object at `src/Alfred.jsx:56-72` and
`src/Alfred.jsx:75-90`. Both recurse into arrays as well as nested objects, which
is what converts the keys *inside* the jsonb array. Applied on write at
`src/Alfred.jsx:130` and on read at `src/Alfred.jsx:908` / `src/Alfred.jsx:958`.
Verified against live data: `get_collections` performs no conversion
(`tool-handlers.ts:399` is a bare `return { data };`) and returns
`{ "item_id": "...", "quantity": "2" }`.

The failed backfill was caused by an investigation describing the in-memory
JavaScript shape as though it were the persisted shape, without mentioning the
conversion. The rule that generalises: **below the `storage` layer, snake_case is
the truth.**

Step 2 extracted these functions verbatim into `src/utils/caseConvert.js` so new
modules share one implementation. `storage` keeps its own copy until Step 3.

## Scope

### In scope

- A data access layer for collection membership and removals.
- Moving every read and write of collection membership onto `collection_items`.
- A "recently removed" panel on the collection detail view: the last 5 manual
  removals, each with a timestamp and a control to put the item back.
- A full history view: the last 50 removals of both kinds.
- Fixing the raw-id fallback so an unreadable or deleted item is visibly flagged
  rather than rendering an opaque id styled as a name.

- Fixing the stale-snapshot bug in `updateCollection`, which closes over
  `collections` instead of using React's functional updater. This is a second,
  independent cause of lost concurrent edits that row storage does not fix on its
  own. Every state update the new layer triggers uses `setX((prev) => ...)`.

### Out of scope

- A general undo system. Re-adding from the panel is a plain insert, not a
  restore with undo semantics.
- Reorder conflict resolution. If two people reorder at once, one wins. Accepted.
- Dropping the jsonb column.
- Any MCP tool work. The MCP surface is read-only for collections (`get_collections`)
  and stays that way for now.
- **Live cross-user refresh.** There is no realtime channel for `item_collections`
  (six channels exist at `Alfred.jsx:1206-1310`; none covers collections) and no
  polling on the collection detail view — the only poll is a 5-second one in the
  execution view at `Alfred.jsx:6402-6410`. Two people will both keep their
  additions, but will not see each other's without a reload. Accepted for now.
  **Do not add a channel or a poll.**

## Error handling

`withLoading` (`Alfred.jsx:741-753`) catches, alerts, and does **not** rethrow. An
exception raised inside a wrapped call site is therefore swallowed and the caller
carries on as though the write succeeded.

So the data layer must not signal failure by throwing. Every function returns
`{ data, error }` with `error` null on success and a string on failure, and each
call site must inspect it and surface the failure in the UI. A silent failure here
is worse than a crash: the user believes the item was added.

## The five jsonb write paths

Step 1 established the authoritative list. An earlier draft of this spec was
written against an incomplete one. **Every one of these moves onto the new tables
across Steps 3 and 4.**

| Line | Path | Via | Step |
|---|---|---|---|
| `1623-1624` | Triage: add item to collection | `storage.set` direct | 3 |
| `2022-2023` | Execution completion: remove checked items | `storage.set` direct | 4 |
| `2164-2165` | `updateCollectionItemQty` — dead code, no call sites | `storage.set` direct | 3 (delete it) |
| `2357-2360` | `addCollection` seeds `items: []` | `storage.set` direct | 3 |
| `2371` | `updateCollection` — the shared helper | `storage.set` | 3 |

`updateCollection` is reached from 8 call sites: `3600` name, `3609` context,
`3623` shared, `3633` pinned, `3684` reorder, `3701` quantity, `3708` remove,
`3754` bulk add, `3782` create-then-add. Only the membership ones move; the name,
context, shared and pinned writes stay on `item_collections` where they belong.

## The two removal paths

There is no single choke point today. Both must route through the new layer.

**Manual removal.** The X button on a row in the collection detail view, at
`Alfred.jsx:3705-3712`, filtering by array index via `updateCollection`. Writes
`reason = 'manual'`. Verified in Step 1.

**Execution completion.** When an execution wired to a collection is closed with
"Complete", every checked item is cleared from the collection in one go. At
`Alfred.jsx:2013-2029`, filtering by item id and calling `storage.set` directly,
bypassing `updateCollection`. Writes `reason = 'completed'`. Verified in Step 1.

The bypass is deliberate: `closeExecution` (`Alfred.jsx:1966`) already runs inside
`withLoading('Completing...')`, and a nested non-silent `updateCollection` would
clear the loading overlay mid-operation.

The distinction matters because a single "Complete" tap can remove a dozen items
at once. If both kinds landed in the same list, one bulk clear-out would push a
genuine mistake off the bottom of a five-item panel. The panel therefore shows
manual removals only; the full history view shows both.

`deleteCollection` (`Alfred.jsx:2381`) removes the whole collection. The database
cascade handles both child tables — no history rows should be written for it, and
no application code is needed. Verify the cascade works rather than assuming.

## Implementation approach

### Step 1 — Verify current shape (read-only)

No code changes. Confirm from source:

- How Supabase rows reach React state, and whether keys are converted between
  snake_case and camelCase. Quote the code that does it, or establish that none
  exists.
- Every read and write of `item_collections.items` in the codebase, with file and
  line references. The two removal paths above are reported but were derived from
  an investigation that has already proven wrong once.
- How `storage.set` differs from `updateCollection` and why the execution path
  uses the former.
- Whether `deleteCollection` relies on any application-side cleanup that the
  database cascade now duplicates.

Output findings before writing anything.

### Step 2 — Data access layer (complete)

`src/utils/collectionMembers.js`, with `src/utils/caseConvert.js` alongside it.
Exports `loadMembers`, `loadRemovals`, `addMember`, `addMembers`,
`updateMemberQuantity`, `reorderMembers`, `removeMember`, `removeMembers`,
`reAddRemoval`, and the `REMOVAL_MANUAL` / `REMOVAL_COMPLETED` constants.

Holds no React state and triggers no re-renders; the caller owns state. Returns
`{ data, error }` throughout — see Error handling above.

**Removal ordering.** supabase-js cannot open a transaction from the browser, so
the two halves cannot be made atomic. The history row is inserted **first**, then
the membership row deleted. If the delete fails, the item is still in the
collection carrying a spurious history entry — visible and correctable. The other
order would lose the item with no record it ever existed. The error message says
so explicitly.

**Name snapshot.** The item's name is captured at removal time. An unresolvable
name stores null and never blocks the removal. The client cannot distinguish
"deleted" from "hidden by RLS" and does not need to.

**Shared timestamp.** All removal rows go in one INSERT, so `now()` is
transaction-stable and a bulk removal shares one exact `removed_at` — which is
what lets Step 6 group them. The timestamp is the server's, not the client's.

**Duplicate tolerance.** Adds use `ON CONFLICT DO NOTHING` against
`collection_items_unique_member`, and a raw `23505` is absorbed as a fallback.
Already-a-member is a no-op success reported as `alreadyPresent: true`, never an
error, so the re-add control can be double-tapped safely.

### Step 3 — Cut collection editing over

Split into three sub-steps so no piece gets stranded inside a larger change.

**3a (complete).** Deduplicate the case converters — `storage` imports from
`src/utils/caseConvert.js`. One implementation in the codebase.

**3b.** Move membership READS onto `collection_items` via `loadMembers()`. Writes
stay on the jsonb column. This is the first contact between the layer and the real
database, and it is what makes three things verifiable that a stub could not:
that the child-table RLS permits the read, that the backfilled rows match what the
jsonb holds, and that PostgREST returns the shape the layer expects.

Reads and writes are deliberately inconsistent during 3b. **Do not bridge it with
a dual write** — that is more code than the cutover it protects and is thrown away
immediately. Two consequences, recorded here because they are not obvious:

- An edit made while 3b is live lands in the jsonb only. `collection_items` was
  backfilled once, before Step 1, and nothing propagates into it during 3b, so
  such an edit is **not** picked up at 3c — it is lost unless the backfill is
  re-run. Avoid editing collections between 3b and 3c, or re-backfill first.
- The detail list renders from `collection_items` while its write handlers still
  index into the jsonb array. Those two agree exactly today. One edit during 3b
  desynchronises them, after which an index-based write can hit the wrong element
  and corrupt the jsonb rollback copy. Same mitigation: do not edit during 3b.

**3c (complete).** Write paths moved: triage add, `addCollection`'s `items: []`
seed removed, reorder, quantity, the X-button removal (`reason='manual'`), bulk
add, create-then-add, and the execution checklist's quantity box. The four
metadata `updateCollection` call sites — name, context, shared, pinned — stay on
`item_collections` where they belong.

`updateCollectionItemQty` was recorded in Step 1 as dead and was not: it reached
the execution checklist through the `onUpdateCollectionItemQty` prop, which a grep
for the function name does not find. It is gone, with the prop repointed at
`saveMemberQuantity`.

After 3c the jsonb column is a frozen rollback snapshot. Execution completion is
its last writer and moves in Step 4; until then, completing a collection-based
execution will neither clear the checklist nor leave the snapshot faithful.

Also in 3c, per the table above: the triage add (`1623-1624`),
`addCollection`'s `items: []` seed (`2357-2360`), and the deletion of the dead
`updateCollectionItemQty` (`2158-2167`).

Every state update must use the functional updater form. `updateCollection`'s
closed-over `collections` snapshot is fixed here, not deferred.

Point `storage`'s `toSnakeCase` / `toCamelCase` at `src/utils/caseConvert.js`
instead of its inline copies, so there is one implementation.

After this step the jsonb column stops being updated and begins to drift. That is
expected and safe.

### Step 4 — Cut the execution path over (complete)

The checklist read moved in 3b and the checklist quantity write in 3c, so this
step was the completion handler alone: `closeExecution` now calls
`clearCompletedFromCollection`, which is one `removeMembers` call with
`reason='completed'`.

**One call, never a loop.** All items cleared by a single completion must land in
one INSERT so they share the server's transaction timestamp exactly — Step 6
groups a bulk clear-out by timestamp equality, and N singular removals would
produce N headings.

No nested `withLoading`: the outer one clears the overlay in its `finally` and
never rethrows, so the failure is read off the returned result. Cancel returns
before any collection code and Pause never reaches `closeExecution`.

**After this step `item_collections.items` has no readers and no writers.** It is
a frozen rollback snapshot. Do not delete it and do not add code to keep it in
sync; dropping it is a separate later migration.

### Step 5 — Recently removed panel

On the collection detail view, between the Items section and the Delete
Collection block, inside the existing `space-y-4` stack. Shows the last 5 manual
removals with a relative timestamp and a control to put each item back. Reuse
`friendlyDate()` (reported at `Alfred.jsx:4015`) rather than writing new date
formatting.

When there are no manual removals, render nothing — an empty panel on a fresh
collection is noise.

**Open question — settled.** Re-added items are **filtered out** of the panel. Any
removal whose `item_id` is currently a member is dropped at render. The record
stays in `collection_item_removals` — the table is append-only and the item
genuinely was removed at that time — but a resolved problem does not sit in a panel
meant for unresolved ones.

Consequence: the loader fetches a wider window (25) than the panel shows (5), and
slices after filtering. Fetching exactly five would display fewer than five
whenever recent entries had been put back.

A null `item_name` renders `⚠ Item no longer available` in muted italics — worded
to cover both causes without claiming which. Step 7 generalises the pattern.

### Step 6 — Full history view (complete)

View value `collection-history`, following the `collection-add-items` pattern —
`ArrowLeft` "Back to Collection" header, reusing `selectedCollectionId`.

**Entry point.** The panel renders nothing without manual removals, but a
collection can have history worth reading anyway (all completions, or every manual
removal already put back). Three states: panel present → **View all** in its
header; no panel but history exists → a standalone **View removal history** link;
no history at all → nothing. The detail view therefore loads both the manual list
and the full history, as two separate queries — deriving both from one unfiltered
50-row fetch would let completion churn push every manual row out of the window
while manual removals still exist.

**Grouping** is exact string equality on `removed_at` *and* `reason`, never a
rounded window.

Both shapes are one bordered card. A group of one renders its item name, timestamp
beneath, reason label on the right. A bulk action renders the same header with the
item count in the name's slot, then a divider and its item names. The heading lives
*inside* the card — a heading floating above the border reads as a stray line, and
leaves the card as the only one on screen with no label.

**Re-add stays out.** This view shows re-added items too, so a control here would
have to duplicate the panel's filtering to avoid offering a pointless button.



A secondary view showing the last 50 removals of both kinds. Follow the existing
`collection-add-items` pattern — a full view with an `ArrowLeft` "Back to
Collection" header, not a modal. Alfred uses a flat `view` string rather than a
router; add a new value to it consistent with the existing naming.

Removals that share a timestamp came from one bulk action and should be grouped
under a single heading rather than repeating the same time a dozen times.

### Step 7 — Missing item display (complete)

The existing treatment is at `Alfred.jsx:7006-7011` — `⚠`, muted italics. The
*treatment* transferred; the *wording* did not, because it says `(item deleted)`
and the client cannot know that.

`ItemNameLabel` (renamed from `RemovedItemLabel`, since it now covers live members
as well as removal snapshots) renders `⚠ Item unavailable` for a missing name,
across five sites: the panel, both history shapes, the collection detail list and
the execution checklist. "No longer available" was dropped — it implies something
changed, which is wrong for an item that was never visible to this viewer.

**Controls beside an unresolvable member.** Remove stays enabled — a member you
cannot see is the one you may most need to clear, and nothing else could. Quantity
is disabled with an explanatory `title`: setting an amount on something you cannot
identify is a guess, and a silent edit to data its owner *can* see. Drag and the
checklist checkbox stay enabled; neither requires knowing what the item is.

No raw id is shown anywhere. It is meaningless to the reader and reintroduces the
opaque string this step exists to remove.

## Success criteria

- Two people adding items to the same shared collection at the same time both
  keep their additions.
- Removing an item with the X button makes it appear in the recently-removed
  panel with a sensible timestamp, and the control puts it back with its original
  quantity.
- Completing an execution clears the checked items without flooding the panel.
- The full history view shows both kinds of removal, most recent first, with bulk
  removals grouped.
- An unreadable or deleted item reads as a problem rather than as a strange name.
- Deleting a collection removes its membership and removal rows via the cascade,
  with no orphans left behind.
