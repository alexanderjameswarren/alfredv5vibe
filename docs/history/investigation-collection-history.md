# Investigation — "Recently removed" history for Alfred collections

Read-only investigation. No code changed, no migration written. Source of truth for the
database section is the live `get_database_schema` and `get_platform_contract` MCP output
(table/column comments, RLS policies, registry metadata), cross-checked against
`supabase/migrations/002_phase6_collections_tags.sql` and the platform-layer design docs
under `docs/history/`.

---

## 1. Database — is removal already recorded anywhere?

### The tables involved

There is exactly one collections table, `public.item_collections`, and there is **no
membership join table at all**. Its table comment states the design decision outright:

> ALFRED (Phase 6). Named groupings of items — grocery lists, packing lists, reading
> lists. The items jsonb holds ordered member ids rather than a join table, keeping
> list reads to a single row fetch.
>
> RLS is deliberately three-policy: owner has full control; anyone may read a shared
> collection; anyone may UPDATE a shared collection but WITH CHECK (shared = true)
> prevents a non-owner un-sharing it. This is the shared grocery-list mechanism and
> is load-bearing — do not simplify it to owner-only.
>
> ACCEPTED RESIDUAL RISK: WITH CHECK cannot compare against the pre-update row, so a
> non-owner could in principle reassign user_id on a shared collection. Closing this
> would need a BEFORE UPDATE trigger. Not worth it against a two-person email
> allowlist; revisit if the allowlist ever grows.

Columns of `public.item_collections`, exactly as reported:

| Column | Type | Default | Nullable | Comment |
|---|---|---|---|---|
| `id` | `text` | — | no | *(none)* |
| `user_id` | `uuid` | `auth.uid()` | no | *(none)* |
| `name` | `text` | — | no | *(none)* |
| `context_id` | `text` | — | yes | *(none)* |
| `shared` | `boolean` | `false` | yes | *(none)* |
| `is_capture_target` | `boolean` | `false` | yes | `True = captures can be appended straight into this collection from the inbox.` |
| `items` | `jsonb` | `'[]'::jsonb` | yes | `jsonb array of item ids, order-significant.` |
| `created_at` | `timestamptz` | `now()` | yes | *(none)* |
| `pinned` | `boolean` | `false` | yes | *(none)* |
| `updated_at` | `timestamptz` | `now()` | yes | *(none)* |

Constraints: `item_collections_pkey PRIMARY KEY (id)` and
`item_collections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT`.
Indexes: `idx_item_collections_user_id`, `idx_item_collections_context_id`,
`idx_item_collections_shared`, `item_collections_pkey`. There is no index on `items`.

The member side is `public.items`, whose comment reads:

> ALFRED. Reusable reference material — recipes, checklists, project notes, anything
> consulted more than once. Distinct from intents (things to DO). Items are composable:
> an item can be referenced by many intents and events.

RLS policies on `item_collections`, exactly three:

- `item_collections_owner` — command `ALL`, `USING (user_id = auth.uid())`, `WITH CHECK (user_id = auth.uid())`
- `item_collections_shared_read` — command `SELECT`, `USING (shared = true)`
- `item_collections_shared_update` — command `UPDATE`, `USING (shared = true)`, `WITH CHECK (shared = true)`

`public.items` has an `archived boolean` column whose comment is worth quoting because it
is easy to mistake for a removal record:

> Soft delete. NOTE the Alfred principle "data reflects reality": genuinely cancelled or
> abandoned records are DELETED, not archived. archived is for things that are done and
> kept for reference, not for things that never happened.

That flag governs the *item itself*, not its membership of any collection. Archiving an
item does not remove it from a collection, and removing it from a collection does not set
`archived`. The two are unrelated.

Note a discrepancy worth recording: the `items` column comment says "jsonb array of item
ids", but every write path in the application stores an array of **objects** shaped
`{ itemId, quantity }` — see `src/Alfred.jsx:1615-1622`, `src/Alfred.jsx:3780-3782`, and the
`toggleItem` builder in `CollectionAddItems` at `src/Alfred.jsx:552-559`. The comment is
stale relative to the actual payload.

### Hard delete or soft delete?

**Hard delete, and not even a row delete — a whole-column overwrite.**

Because membership lives inside `item_collections.items`, there is no row per membership
that could carry a flag. Removing an item is a `filter()` in JavaScript followed by an
`UPDATE item_collections SET items = <new array>`. The removed element simply ceases to
exist in the current row. There is no `deleted_at`, no `removed_at`, no `status`, no
tombstone entry left behind in the array, and no per-member timestamp of any kind — the
array elements carry only `itemId` and `quantity`. Nothing in the live schema records when
an item joined a collection either, so "when was it removed" has no counterpart "when was
it added".

`updated_at` on the collection is the only timestamp touched, and it is a single scalar
overwritten on every edit — rename, re-context, share toggle, pin, reorder, quantity edit,
add, and remove all move the same value. It cannot distinguish a removal from a rename,
and it retains only the most recent one.

### Existing audit capture

There is one, and it is the only mechanism that could reconstruct removals after the fact.

`public.item_collections` is registered with the platform layer and is **audited**. From
`get_platform_contract`, its registry entry reads:

```
table:       public.item_collections
exempt:      false
audited:     true
policy_mode: none
notes:       Alfred: 3-policy shared-collection RLS, load-bearing (00e)
```

and from the schema dump, `registered_at: 2026-07-24T16:42:35.924253+00:00`,
`contract_version: 1`. All fourteen non-exempt public tables are currently `CONFORMANT`.

The `platform` schema comment — the contract itself — describes what registration attaches:

> Every migration that creates a table MUST end with a schema-qualified call:
> `select platform.register_table('public.my_table');`
> This enables RLS, creates the owner policy, issues the grants required by
> Supabase from Oct-2026 onward, strips all privileges from anon, attaches the
> audit trigger, and records the table in `platform.registry`.

The audit design is specified in `docs/history/technical-spec-platform-layer.md` (§ "Audit
and rollback", lines 71-88):

> `platform.audit_log` captures before/after images via a single generic trigger, attached
> by `register_table`. Two details make it actually useful:
>
> **`old_row` is the point.** A log without the before image records that something
> happened; it can't undo it. `platform.rollback_audit_entry(id)` reverses a single change
> — INSERT→delete, DELETE→reinsert, UPDATE→restore old values.
>
> **The `actor` column is what makes it an undo.** ... Rollback is intentionally **not**
> exposed as an MCP tool. It's a human operation.

### Shape of the audit trail, and its limits for this feature

**What it captures.** `platform.audit_log` holds, per the verification queries in
`docs/history/progress-platform-layer.md:48` and `:201`, at least the columns `id`, `actor`,
`op`, and `table_name`, plus the `old_row` / `new_row` images the spec describes. `op` takes
`INSERT` / `UPDATE` / `DELETE`. `table_name` is stored **schema-qualified** — the value is
`public.item_collections`, not `item_collections`. This is called out twice, in
`docs/history/progress-sam-drills-and-lineage.md:124` and `:175`:

> `platform.registry.table_name` AND `platform.audit_log.table_name` both store
> **schema-qualified** names (`public.sam_songs`), not bare (`sam_songs`). Any filter query
> needs the schema prefix.

**Whether it records the acting user.** Not directly. The `actor` column records the
*channel*, not the person: it is set to the literal string `'claude'` for MCP writes and
`'ui'` for browser writes. The value rides the `x-actor` PostgREST request header, set in
`supabase/functions/_shared/platform.ts:82` (`"x-actor": "claude"`), and the comment above
it at lines 51-56 explains why a transaction-scoped GUC could not be used:

> The `x-actor` header is what lets `platform.audit_row()` distinguish AI writes from UI
> writes — it MUST be set here, and it MUST ride on every request as a PostgREST header
> (transaction-scoped GUCs do not survive between supabase-js calls; that lesson is baked in).

The human identity is only available indirectly, as the `user_id` embedded inside the
`old_row` / `new_row` JSON images of the collection row itself. Since a shared collection can
be edited by a non-owner (the `item_collections_shared_update` policy exists precisely so the
partner can edit the shared grocery list), that embedded `user_id` is the collection's owner,
not the person who did the removal. **The audit log cannot currently tell you which of the
two people removed an item from a shared collection.**

**Retention.** Bounded, opportunistically, by a prune whose window the repo does not state.
`docs/history/progress-platform-layer.md:91-92` records:

> Opportunistic pruning wired (02c): `platform.maybe_prune()` runs ~1% from
> `check_conformance`. No pg_cron dependency.

So audit rows are deleted on an unspecified schedule driven by how often conformance is
checked. That is fine for a rollback tool and actively unsuitable as the backing store for a
user-facing history panel: the panel would silently lose entries, and the retention window is
not stated anywhere in the repository.

**Whether it is queryable per-collection.** Only awkwardly, and it does not answer the actual
question. Three problems, in increasing severity:

1. There is no index supporting it. You would filter
   `table_name = 'public.item_collections'` and then reach into the JSON image for the
   collection id — a scan.
2. Every audit row for this table is `op = 'UPDATE'` on the *whole collection row*. A removal
   is not recorded as a removal; it is recorded as "the `items` array used to be A and is now
   B". Reconstructing "item X was removed" requires diffing `old_row->'items'` against
   `new_row->'items'` in application code, for every audit row.
3. That diff is ambiguous with the other writes that touch the same column. Drag-reorder
   (`src/Alfred.jsx:3673-3685`) and quantity edits (`src/Alfred.jsx:3695-3701`) also rewrite
   `items` wholesale, so the log contains many `items` deltas that are not removals. The diff
   would have to compare membership sets, not arrays, to avoid reporting reorders as churn.

Finally, the DDL for `platform.audit_log` is **not in this repository**. `supabase/migrations/`
contains only `001_sam_tables.sql`, `002_phase6_collections_tags.sql`,
`003_get_schema_info_function.sql`, and `004_drop_sam_sessions_duration_seconds.sql`. The
platform migrations (`01_platform_core.sql`, `02_call_budget.sql`, `02b`, `02c`,
`03_document_existing_schema.sql`, `04`) were run directly in the Supabase SQL editor and are
tracked only as checklist items in `docs/history/progress-platform-layer.md:24-33`. The exact
column list, types, and any retention interval of `platform.audit_log` therefore could not be
verified from source during this investigation — the statements above are drawn from the spec
and from the verification queries quoted in the progress log. A public wrapper
`platform_recent_audit` reportedly exists (`docs/history/progress-platform-layer.md:122`) but
is deliberately not wired to any MCP tool, so it could not be called to confirm the shape.

---

## 2. Application code — where does removal happen?

The entire Alfred front end is a single file, `src/Alfred.jsx` (8,479 lines). There is no
service layer and no hooks directory for Alfred; the only abstraction is the `storage` object
defined at `src/Alfred.jsx:43-190`, which maps key prefixes to tables via `storage.tableMap`
(`item_collections: "item_collections"` at line 52) and does camelCase/snake_case translation.
`storage.set` at `src/Alfred.jsx:118-160` is an update-then-insert-on-zero-rows upsert — it
issues `supabase.from(table).update(dbValue).eq("id", id)` and only inserts if no rows matched.

**There is no single choke point.** Two distinct paths remove items from a collection, and
they do not share code.

### Path 1 — the X button in the collection detail view

`src/Alfred.jsx:3705-3712`:

```jsx
<button
  onClick={() => {
    const newItems = coll.items.filter((_, i) => i !== index);
    updateCollection(coll.id, { items: newItems });
  }}
  className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive"
>
  <X className="w-4 h-4" />
</button>
```

This is the user-facing "remove from collection" action and the one the feature is really
about. It filters by array index, calls `updateCollection`, and there is no confirmation
dialog. The mutation ultimately issued is an `UPDATE item_collections SET items = ...` via
`storage.set`.

`updateCollection` is at `src/Alfred.jsx:2366-2379`:

```js
async function updateCollection(collId, updates, silent = false) {
  const coll = collections.find((c) => c.id === collId);
  if (!coll) return;
  const doSave = async () => {
    const updated = { ...coll, ...updates };
    await storage.set(`item_collections:${coll.id}`, updated);
    setCollections(collections.map((c) => (c.id === collId ? updated : c)));
  };
  ...
}
```

It is generic — it takes an arbitrary `updates` patch and has no idea whether it is applying a
rename or a removal. Its other call sites (`src/Alfred.jsx:3600, 3609, 3623, 3633, 3684, 3701,
3754, 3782`) cover name, context, shared, pinned, reorder, quantity, and two add paths. It is
the nearest thing to a choke point but is not removal-specific.

### Path 2 — execution completion sweeps completed items out

`src/Alfred.jsx:2013-2029`, inside the execution-completion handler:

```js
// Remove completed items from collection
if (outcome === "done" && activeExecution.collectionId) {
  const completedIds = activeExecution.completedItemIds || [];
  if (completedIds.length > 0) {
    const coll = collections.find((c) => c.id === activeExecution.collectionId);
    if (coll) {
      const remainingItems = (coll.items || []).filter(
        (ci) => !completedIds.includes(ci.itemId)
      );
      const updatedColl = { ...coll, items: remainingItems };
      await storage.set(`item_collections:${coll.id}`, updatedColl);
      setCollections(collections.map((c) =>
        c.id === coll.id ? updatedColl : c
      ));
    }
  }
}
```

This is the "finish the grocery run, checked items disappear off the list" path. It is almost
certainly the *bulk* of real-world removals, and it **bypasses `updateCollection` entirely** —
it calls `storage.set` directly. Any instrumentation added only to `updateCollection` or only
to the X button would miss it. It filters by `itemId` rather than by index, so the two paths
do not even agree on how a member is identified.

The items being removed here are staged in `executions.completed_item_ids` (a jsonb array,
added in `supabase/migrations/002_phase6_collections_tags.sql`), toggled by
`toggleCollectionItem` at `src/Alfred.jsx:2142-2157` and rendered in `ExecutionDetailView` at
`src/Alfred.jsx:6466-6500`. That column is the one place in the system that transiently knows
"these specific items are about to leave this collection" — but it is scoped to a single
execution and is not history.

### Path 3 — deleting the whole collection

`src/Alfred.jsx:2381-2386`:

```js
async function deleteCollection(collId) {
  return withLoading('Deleting...', async () => {
    await storage.delete(`item_collections:${collId}`);
    setCollections(collections.filter((c) => c.id !== collId));
  });
}
```

A genuine row `DELETE`, fired from the "Delete Collection" button at `src/Alfred.jsx:3719-3729`
behind a `window.confirm("Delete this collection?")`. Every membership vanishes at once. Worth
noting for whatever a history feature does when its parent collection is gone.

### Adjacent writes to the same column that are *not* removals

- Drag-to-reorder, `src/Alfred.jsx:3673-3685` — splices `coll.items` and saves on `onDragEnd`.
- Quantity edit, `src/Alfred.jsx:3695-3701` — rewrites the element and saves on blur.
- `updateCollectionItemQty`, `src/Alfred.jsx:2158-2167` — a second, apparently unused quantity
  writer that also calls `storage.set` directly.
- Adds: triage (`src/Alfred.jsx:1607-1628`), bulk add (`src/Alfred.jsx:3753-3754`), and
  create-then-add (`src/Alfred.jsx:3781-3782`).

These matter because they make the audit log's `items` deltas ambiguous, as noted in §1.

### Edge Functions and MCP tools

**No server-side write path to collections exists.** The MCP surface is read-only for
collections:

- `getCollections` — `supabase/functions/_shared/alfred-tools/tool-handlers.ts:383-395`, a
  plain `.from("item_collections")` select. This is the only reference to the table in the
  entire `supabase/` tree outside the migration.
- Tool schema — `supabase/functions/_shared/alfred-tools/tool-definitions.ts:160-170`.
- Registration — `getCollectionsTool` at `supabase/functions/mcp/index.ts:250-258`, exposed as
  `get_collections` at `supabase/functions/mcp/index.ts:656-665`.

`supabase/functions/ai-enrich/index.ts` reads collections (lines 174-175) but writes only
`inbox.suggested_collection_id` (line 497). Nothing outside the browser mutates
`item_collections.items`. Consequently, every removal that exists today carries
`actor = 'ui'` in the audit log.

---

## 3. Current collection UI — where would history go?

### Structure

There is no router and no component directory for Alfred. Navigation is a single flat string
in React state — `view` — switched with `setView(...)`, with `selectedCollectionId` and
`previousView` as the supporting state (declared at `src/Alfred.jsx:679-683`). The complete
set of view values is: `home`, `inbox`, `schedule`, `contexts`, `context-detail`,
`intention-detail`, `item-detail`, `execution-detail`, `collections`, `collection-detail`,
`collection-add-items`, `sam`, `timer`.

Three views are collection-related, all inlined as IIFE blocks in the main render:

- **`collections`** — the list, `src/Alfred.jsx:3474` onward. A context filter `<select>`, then
  a `space-y-2` stack of cards. Each card (`src/Alfred.jsx:3530-3563`) is
  `p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary
  shadow-sm hover:shadow-md transition-shadow`, showing name, an item count, a context chip,
  and a shared badge. Clicking sets `previousView`, `selectedCollectionId`, and
  `view = "collection-detail"`.
- **`collection-detail`** — `src/Alfred.jsx:3569` onward. This is the page in question.
- **`collection-add-items`** — `src/Alfred.jsx:3737-3792`, which renders the
  `CollectionAddItems` component defined at `src/Alfred.jsx:534-676`.

### How `collection-detail` is laid out

An `ArrowLeft` "Back" button (`src/Alfred.jsx:3576-3586`, `min-h-[44px] text-primary
hover:text-primary-hover`, returning to `previousView || "collections"`), then a single
`<div className="space-y-4">` containing, in order:

1. **Name** — labelled text input, saved on blur via `updateCollection(..., true)` (silent).
2. **Context** — labelled `<select>`.
3. **Shared collection** — checkbox in a `flex items-center gap-2` label.
4. **Pin to home** — same shape.
5. **Items** — a header row `flex items-center justify-between` with
   `<h3 className="text-base font-medium">Items (N)</h3>` on the left and a primary
   "Add Items" button on the right (`src/Alfred.jsx:3639-3650`); then two conditional warning
   lines at 50 and 200 items (`text-xs text-warning` / `text-xs text-destructive`); then either
   an empty state (`text-muted-foreground text-sm py-4 text-center`) or a `space-y-2` list of
   rows. Each row is `flex items-center gap-2 p-3 bg-card border border-border rounded-lg`
   holding a `GripVertical` drag handle, the item name, a quantity input, and the X remove
   button. Rows fall back to rendering the raw `collItem.itemId` when the linked item no longer
   exists (`src/Alfred.jsx:3665-3667`).
6. **Delete Collection** — a `<div className="pt-4 border-t border-border">` at
   `src/Alfred.jsx:3717-3730` holding a destructive button.

Styling throughout is Tailwind against semantic tokens — `bg-card`, `border-border`,
`text-muted-foreground`, `text-primary` / `bg-primary`, `text-warning`, `text-destructive`,
`bg-secondary/50` — with `rounded-lg`, `shadow-sm hover:shadow-md`, and a consistent
`min-h-[44px]` / `min-w-[44px]` touch-target floor on interactive elements.

### Where a "recently removed" panel fits

The natural slot is a new sibling inside the existing `space-y-4` stack, between the close of
the Items section (`src/Alfred.jsx:3714-3715`) and the `pt-4 border-t border-border` Delete
Collection block (`src/Alfred.jsx:3717`). That position disturbs nothing: the stack already
supplies vertical rhythm, the section would sit below the primary content and above the
destructive footer, and it can borrow the Items section's own header idiom — an
`<h3 className="text-base font-medium">` on the left with a secondary action on the right —
so a "View all" link occupies the same place the "Add Items" button does one section up. The
`pt-4 border-t border-border` treatment already used by the delete block is the established way
to mark a subordinate section in this view. Existing row styling (`flex items-center gap-2 p-3
bg-card border border-border rounded-lg`) transfers directly, and the empty state has a
precedent to copy verbatim.

For the timestamp, `friendlyDate(timestamp)` at `src/Alfred.jsx:4015-4037` is the existing
helper and already renders exactly the register this feature wants — `Today at 3:42 PM`,
`Yesterday at 9:15 AM`, otherwise `Tue, Mar 4 at 6:20 PM`. `formatEventDate` at
`src/Alfred.jsx:336-349` is the other date helper but is scheduled-event oriented;
`friendlyDate` is the right one.

### The existing "view all" pattern to follow

There is a clear precedent, and it is not a modal. `collection-add-items` is a **full secondary
view** reached from the collection detail page:

- Entry — `onClick={() => setView("collection-add-items")}` at `src/Alfred.jsx:3644`, leaving
  `selectedCollectionId` untouched so the child view re-derives the collection itself
  (`src/Alfred.jsx:3739-3740`).
- The child is a real named component, `CollectionAddItems` (`src/Alfred.jsx:534`), taking
  callback props rather than reaching into parent state.
- Its header is an `ArrowLeft` button reading **"Back to Collection"**
  (`src/Alfred.jsx:565-572`) with the identical classes as the detail view's Back button,
  followed by an `<h2 className="text-lg font-medium mb-3">` title.
- Exit — `onCancel={() => setView("collection-detail")}` at `src/Alfred.jsx:3789`.

A "last 50 removed" page should follow this exact shape: a new `view` value, a new named
component with an `ArrowLeft` "Back to Collection" header, entered from a link in the
recently-removed panel and exiting back to `collection-detail`. There is no modal/dialog
pattern in the collections area to follow instead — the only dialogs anywhere near this code
are `window.confirm` calls (`src/Alfred.jsx:3721`), and the richer dialog components that do
exist (`CustomRecurrenceDialog` at `src/Alfred.jsx:7338`, `IntervalRecurrenceDialog` at
`src/Alfred.jsx:7585`) belong to the recurrence editor and are a different interaction class.
Inventing a modal here would break with the surrounding convention.

---

## Gaps

What does **not** exist today and would have to be built:

1. **Any record of removal, anywhere.** Membership lives in `item_collections.items` as a jsonb
   array; removing an item overwrites that array. There is no membership row, so no
   `deleted_at` / `removed_at` / status flag is even possible in the current shape. Nothing is
   left behind.

2. **Any per-member timestamp at all.** The array elements carry only `itemId` and `quantity`.
   There is no "added at" either, so the history feature has no existing temporal data to build
   on. `item_collections.updated_at` is a single scalar shared by every kind of edit and retains
   only the most recent one.

3. **A storage location for removal events.** No table, column, or jsonb field exists for this.
   `platform.audit_log` is the only after-the-fact reconstruction route and is unfit as a
   backing store for a user-facing panel: it records whole-row `UPDATE`s rather than removals,
   requires diffing `old_row->'items'` against `new_row->'items'` to infer what left, cannot
   distinguish a removal from a reorder or a quantity edit without a set-based diff, has no
   index supporting a per-collection query, and is pruned on an unspecified schedule by
   `platform.maybe_prune()`.

4. **Attribution of the human who removed something.** `platform.audit_log.actor` records the
   channel (`'ui'` or `'claude'`), not the person. On a shared collection — the case that
   matters, since `item_collections_shared_update` exists precisely so both people can edit the
   grocery list — the audit log cannot say which of the two did the removal. Nothing in the
   application sends a per-user identity on a write beyond the JWT that RLS consumes.

5. **A single choke point to instrument.** Removal happens in two unrelated places:
   `src/Alfred.jsx:3705-3712` (the X button, via `updateCollection`) and
   `src/Alfred.jsx:2013-2029` (execution completion, calling `storage.set` directly and
   bypassing `updateCollection`). They identify members differently — by array index versus by
   `itemId`. `deleteCollection` at `src/Alfred.jsx:2381-2386` is a third, whole-row case. Any
   history capture must cover all of them or silently under-report, and the execution path is
   likely the highest-volume one.

6. **Any server-side write surface for collections.** The MCP layer exposes only
   `get_collections` (read). There is no `defineTool`-based collection write tool and therefore
   no existing server-side place where a removal event could be recorded; today all collection
   mutation happens in the browser through `storage.set`.

7. **A resilient display name for a removed item.** Rows render `items.find(...)` and fall back
   to the bare `collItem.itemId` when the item is gone (`src/Alfred.jsx:3665-3667`). A history
   panel showing items removed weeks ago will hit this often — and more so if the underlying
   `items` row was itself deleted — so it needs a name captured at removal time rather than a
   live lookup.

8. **The `platform.audit_log` DDL is not in this repository.** `supabase/migrations/` holds only
   `001`–`004`; the platform migrations were applied via the Supabase SQL editor and exist here
   only as checklist entries in `docs/history/progress-platform-layer.md`. The audit log's exact
   columns and its retention window could not be verified from source, and
   `platform_recent_audit` is deliberately unwired from MCP
   (`docs/history/progress-platform-layer.md:122`), so it could not be queried to confirm. Any
   decision that leans on the audit log should start by confirming its actual shape and prune
   interval directly in the database.

9. **Stale documentation on the membership shape.** The `item_collections.items` column comment
   says "jsonb array of item ids" while the code stores `{ itemId, quantity }` objects. Anything
   built from the comment alone will be wrong.

10. **A `view` value and component for the "last 50" page.** The pattern to copy exists
    (`collection-add-items` / `CollectionAddItems`), but the view itself, its entry point, and
    its back-navigation do not.
