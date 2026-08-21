# Progress: Collection Membership Rows and Removal History

## Status: Step 7 code complete — awaiting in-app verification. Final step.

Spec: `docs/technical-spec-collection-history.md`

## Prerequisites (complete — do not redo)

- [x] Migration 005 applied: `collection_items` and `collection_item_removals`
      created, registered, policies written
- [x] Backfill from the jsonb column verified — all four collections match
      (Amazon 1, Groceries 0, Star Nursery 3, Trader Joe's 1)
- [x] `check_platform_conformance` returned CONFORMANT, 16 tables, no drift

## Development steps

- [x] Step 1: Verify current shape — key conversion, all jsonb touchpoints,
      storage.set vs updateCollection, delete cascade. Read-only, no code changes.
      Findings recorded below. No files changed.
- [x] Step 2: Data access layer for membership and removals — `src/utils/collectionMembers.js`
      and `src/utils/caseConvert.js`. Two new files, no existing file touched.
      40 behavioural tests pass; `npm run build` compiles clean.
- [x] Step 3a: Deduplicate the case converters — `storage` now imports from
      `src/utils/caseConvert.js`. One implementation in the codebase.
- [x] Step 3b: Move collection membership READS onto `collection_items` via
      `loadMembers()`. **Verified in the app 2026-08-19: 5 rows visible under RLS,
      MATCH on all four collections including Trader Joe's — the shared-collection,
      non-owner read. Child-table RLS, backfill fidelity and PostgREST shape are
      all confirmed against the real database.**
- [x] Step 3c: Move collection membership WRITES onto `collection_items` — add,
      remove, quantity, reorder, triage add, the `addCollection` seed, and the
      functional-updater fix. **Verified in the app and the SQL editor
      2026-08-19 — all seven checks passed, see below.**
- [x] Step 4: Cut the execution completion path over
      (`reason='completed'`, one bulk call, one shared timestamp). **Verified in
      the app 2026-08-19 — all seven completion checks and all three cancel checks
      passed, including exact timestamp equality across a two-item removal.**
- [x] Step 5: Recently removed panel — last 5 manual, with re-add. **Verified in
      the app 2026-08-19 — all six checks passed, see below.**
- [x] Step 6: Full history view — last 50, both kinds, bulk removals grouped.
      **Verified in the app 2026-08-19 — 8 rows, 7 blocks, correct order, the
      two-item completion under one heading, all five re-added items still
      present. One display fix applied after review; see below.**
- [~] Step 7: Missing item display — apply the existing warning pattern. Code
      complete, builds clean. **In-app verification outstanding — walkthrough
      below.**

## Verification steps

- [ ] Two browsers, same shared collection, simultaneous adds — both survive
- [x] X button removal appears in the panel with correct timestamp — 2026-08-19
- [x] Re-add from the panel restores the original quantity — 2026-08-19
- [ ] Re-add twice in a row does not crash on the unique index
- [x] Execution completion clears checked items — verified 2026-08-19 (panel
      flooding is prevented by the Step 5 `reason='manual'` filter, checked there)
- [x] History view groups a bulk removal under one heading — 2026-08-19, the
      two-item completion rendered as one block, 8 rows collapsing to 7 blocks
- [x] Deleting a collection leaves no orphaned membership or removal rows —
      SQL editor, 2026-08-19: `0` and `0` on both child tables, cascade confirmed
- [x] Re-add twice in a row does not crash on the unique index — `dupTest` PASS,
      two `201`s, member count `3 -> 3`, `ON CONFLICT DO NOTHING` honoured by
      PostgREST (2026-08-19)

## Follow-up: live refresh on the collection detail view (2026-08-19)

**Supersedes Amendment 4**, which banned both a channel and a poll. That existed to
keep the migration steps focused, not because live refresh was unwanted. A poll is
now in place; **still no realtime channel**.

Status: code complete, builds clean (+242 B). Not exercised in a browser from here —
two-window testing needs a logged-in session.

### The poll

`src/Alfred.jsx:911-936`. Five seconds, the same cadence and shape as the execution
view's poll at `6971-6981`, which is untouched. The only other `setInterval` in the
file is the execution view's element timer.

Scoped exactly as required: the effect is keyed on `[view, selectedCollectionId]`
and returns early unless `view === "collection-detail"`. The interval is created on
entry and cleared on navigate away, so no collection other than the one on screen is
ever polled.

The on-open effect now also loads membership (it previously loaded only removals and
history, with members arriving via the global load), so opening a collection gives a
fresh read immediately rather than waiting up to five seconds.

### What refreshes, and what does not

**Membership and the manual-removal panel refresh. The full history does not.**

Including the panel was the call worth making. Seeing the other person's removal
land in *Recently removed* is the point of that panel — without it an item would
simply vanish from the list with no explanation and no way to put it back, which is
the accidental-removal case the panel exists for. That is worth the second query.

History is excluded: it is a record rather than a live surface, it would be a third
query every five seconds, and it reloads on entry to the history view anyway.

One consequence needed a fix. The *View all* link was gated on `history.length > 0`,
so a removal polled in while `history` was empty would show in the panel with no way
through to the full view. The link is now shown when either `history` or the panel
has rows (`src/Alfred.jsx:4067-4073`) — no extra query, and the history view reloads
on entry regardless.

### Not disturbing edits in progress

Both hazards are real: the typed quantity and the dragged order live in
`collectionMembers` until they are saved, and that is exactly the state a poll tick
overwrites. **The poll skips rather than merges.** Reconciling server data against a
half-finished edit is subtle and easy to get wrong; a skipped tick costs five
seconds.

The guard is a ref, not state — the interval callback closes over the render that
created it, so reading state there would read stale values. `pollPausedRef` is kept
current by its own effect (`src/Alfred.jsx:900-904`) and is true when:

| Condition | Covers |
|---|---|
| `collDragIdx !== null` | a drag is in progress |
| `editingQuantityItemId !== null` | a quantity field has focus |
| `isLoading` | any `withLoading` write — add, remove, put back |

Focus is the trigger for the quantity guard, and it is **not lifted until the save
has settled**: `onBlur` awaits `saveMemberQuantity` before clearing
`editingQuantityItemId`. Otherwise a tick could land in the window between blur and
the write committing, and revert the value the user just typed.

Drag needed a different fix, because `collDragIdx` is also what fades the dragged
row — holding it past `dragEnd` would leave the row visibly stuck. Instead the two
writes that are **not** wrapped in `withLoading` — `saveMemberQuantity` and
`saveMemberOrder` — increment `memberWriteInFlight` for their own duration, in a
`try/finally`. The poll checks that counter too. Every other membership write is
already covered by `isLoading`.

### Failure handling

Both loaders take `{ quiet }`, passed only by the poll. A failed tick logs to the
console and **does not raise the error banner**: it means what is on screen is five
seconds old, not that it is wrong, and a banner flickering every five seconds would
be worse than the staleness. A foreground load still raises it, and a later
successful tick still clears one. No alert on any path — this fires 720 times an
hour.

Amendments 2 and 3 hold: every loader inspects `{ data, error }`, and all state goes
through `setCollectionMembers((prev) => ...)` / `setCollectionRemovals((prev) => ...)`.

### Verification — what to click

Run the app (`npm start`) and open the same **shared** collection in a normal window
and an incognito window, both signed in. Star Nursery works. Give each change up to
five seconds.

1. **Membership propagates.** In window A, add an item. Within five seconds it
   appears in window B's list. Remove one in A; it disappears from B.
2. **The panel propagates.** That removal should also appear in B's *Recently
   removed* panel, with a relative timestamp — and, if the panel was previously
   empty, the *View all* link should appear alongside it.
3. **Typing is not clobbered.** In B, click into a quantity box, type a new value
   and **do not click away**. Wait fifteen seconds — three ticks. The value must
   stay exactly as typed. Then click away; it saves, and A picks it up within five
   seconds.
4. **Dragging is not clobbered.** In B, pick up a row and hold it mid-drag for ten
   seconds before dropping. The order must not snap back. After the drop the new
   order persists and reaches A.
5. **The poll stops on navigate away.** Open DevTools → Network, filter on
   `collection_items`. While the detail view is open you should see a request roughly
   every five seconds. Go **Back to Collections** and the requests must stop
   entirely. Open a *different* collection and only that one should be requested.
6. **Failure is quiet.** In DevTools set the network to Offline for fifteen seconds
   while the detail view is open. No alert, no red banner — just console errors.
   Restore the network and the list catches up within five seconds.

Point (5) is the one worth being fussy about: a leaked interval would keep polling
after navigation and is invisible without the Network tab.

## Follow-up: `get_collections` repointed at `collection_items` (2026-08-19)

**Status: code complete, type-checked and unit-tested. NOT deployed — see below.**

One file touched: `supabase/functions/_shared/alfred-tools/tool-handlers.ts`,
`getCollections` only (now `404-476`). `mcp/index.ts` is untouched, so the tool's
name, parameters, tier and description are unchanged and **no connector
disconnect/re-add is required**.

### What it does now

Three RLS-filtered reads, assembled in the handler:

1. `item_collections` → `id, name, context_id, shared, is_capture_target`.
   **The `items` jsonb is no longer selected at all.**
2. `collection_items` → `collection_id, item_id, quantity, position`, filtered by
   the collections just fetched, ordered by `collection_id` then `position`.
3. `items` → `id, name` for the distinct member ids, one batched lookup.

Output keeps the `items` key, so the shape is familiar, but each entry is now:

```json
{ "item_id": "mm43m5lqv0p6ygkyob9", "name": "Compost", "quantity": "3" }
```

and for a member whose item cannot be resolved:

```json
{ "item_id": "abc123", "name": null, "quantity": "1", "unavailable": true }
```

**Never the bare id in the `name` slot.** An unmatched id means the item was
deleted *or* is unreadable to this caller — indistinguishable from here, and
neither is an error. This mirrors the `⚠ Item unavailable` treatment the UI got in
Step 7; `name: null` plus an explicit `unavailable` flag is the machine-readable
form of the same honesty, and it stops a model downstream from printing the id as
though it were a product name.

### Platform rules

- **Rule 1 satisfied without change.** The handler already takes `client` as a
  parameter and imports no Supabase client. Both callers pass a user-scoped
  client — `ctx.db` from `defineTool` in `mcp/index.ts`, and `createUserClient` in
  `ai-enrich/index.ts`. The service role is not involved. RLS is the gate.
- **Tier unchanged** (1, read). Params unchanged (`context_id`).
- **Envelope unchanged** — still bare `data`, no `{data, meta}` leak.

### Deviation worth recording

The tool remains an **unbounded read**, which Rule 4 says no `get_*` should be.
That is pre-existing, but this change adds two more unbounded queries beneath it.
It was left alone deliberately: clamping *membership* would make the tool silently
under-report what is in a collection, which is exactly the false belief the rule
exists to prevent, and clamping the collection list is outside this scope.
Practical ceiling today is 4 collections × the app's own 200-member cap. Worth
fixing properly — with a `limit` param and a truncation notice — if collections
ever grow.

### Verification

Type-checked with the repo's `tsc` under `--strict` (isolated from `@types/node`
noise): clean. The only error in the file is `crypto` in `createInboxItem`, a Deno
global unrelated to this change.

Then the **real handler was transpiled and run** against a scripted client — not a
reimplementation. 23 assertions, all passing: position ordering, quantity carried
through, `unavailable` flag only on unresolved members, the id never appearing as a
name, empty collections yielding `[]`, the jsonb column absent from the select, one
batched deduplicated name lookup, `context_id` filtering short-circuiting before the
membership query, and each of the three queries propagating its error.

### To deploy and verify

**1. Deploy. Two functions, not one.** `tool-handlers.ts` is shared code and is
bundled into each function separately, so deploying only `mcp` leaves `ai-enrich`
running the old copy:

```
npx supabase functions deploy mcp --no-verify-jwt
npx supabase functions deploy ai-enrich
```

`mcp` needs `--no-verify-jwt` because it handles its own OAuth. `ai-enrich` has
`verify_jwt = true` in `config.toml` and should keep it.

**2. Get ground truth** — paste in the console of the logged-in app. This computes,
from the same tables, exactly what `get_collections` should return:

```js
(async () => {
  const URL = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo';
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const token = JSON.parse(localStorage.getItem(k)).access_token;
  const H = { apikey: ANON, Authorization: 'Bearer ' + token };
  const get = p => fetch(URL + '/rest/v1/' + p, { headers: H }).then(r => r.json());

  const cols = await get('item_collections?select=id,name,items&order=name');
  const mems = await get('collection_items?select=collection_id,item_id,quantity,position&order=collection_id,position');
  const ids = [...new Set(mems.map(m => m.item_id))];
  const items = ids.length ? await get(`items?id=in.(${ids.join(',')})&select=id,name`) : [];
  const names = new Map(items.map(i => [i.id, i.name ?? null]));

  for (const c of cols) {
    const rows = mems.filter(m => m.collection_id === c.id).map(m => {
      const name = names.get(m.item_id) ?? null;
      return name === null
        ? { item_id: m.item_id, name: null, quantity: m.quantity, unavailable: true }
        : { item_id: m.item_id, name, quantity: m.quantity };
    });
    console.log(`\n=== ${c.name.trim()} — get_collections should return these ${rows.length} items, in this order ===`);
    console.table(rows);
    console.log('stale jsonb it used to return (for contrast):',
      (c.items || []).map(x => x.item_id + '=' + (x.quantity ?? '')));
  }
})();
```

**3. Call `get_collections` from a fresh Claude conversation** and compare.

### What to expect for Star Nursery and Trader Joe's

I cannot state their exact contents: there is still no MCP read tool for
`collection_items`, and RLS means I cannot query it from here. The jsonb figures
recorded earlier in this file are the *pre-migration snapshot* and are stale by
construction — Steps 4 through 7 added, removed, completed and re-added items. The
console block above is the ground truth; these are the invariants to check against
it.

**Star Nursery** — the ordinary case. Every member should carry a real `name` and
its `quantity`, in `position` order. If the old stale jsonb figures come back
(`Compost`/`3`, plus the two items Step 4's completion removed), the deploy did not
take.

**Trader Joe's** — the case worth the attention. It is a shared collection, and its
membership is reached through the child-table policy as a non-owner. Two outcomes
are both **correct**:

- a resolved `name` — the item sits in a shared context, so it is readable; or
- `{ "name": null, "unavailable": true }` — the item has no context or a private
  one, so RLS hides it. This is the exact scenario that started this whole piece of
  work.

What must **not** happen either way: an error, a missing collection, an empty
`items` array where membership exists, or the item id appearing in the `name` field.

## Step 1 findings (verified from source, 2026-08-19)

### 1. Key conversion — confirmed, and the earlier error explained

A conversion layer does exist. It is two methods on the `storage` object in
`src/Alfred.jsx`:

- `toSnakeCase(obj)` — `src/Alfred.jsx:56-72`
- `toCamelCase(obj)` — `src/Alfred.jsx:75-90`

Both recurse into **arrays as well as nested objects**, which is what makes them
reach inside the `items` jsonb array:

```js
toSnakeCase(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => this.toSnakeCase(item));
  ...
      result[snakeKey] =
        typeof value === "object" && value !== null
          ? this.toSnakeCase(value)
          : value;
```

Applied on write at `src/Alfred.jsx:130` (`const dbValue = this.toSnakeCase(value);`
inside `storage.set`, which begins at `src/Alfred.jsx:120`), and on read at
`src/Alfred.jsx:908` and `src/Alfred.jsx:958`
(`setCollections((collectionsData || []).map(d => storage.toCamelCase(d)))`).

**So both the spec and the React code are correct, at different layers.** The
database jsonb genuinely stores `item_id`; React state genuinely holds `itemId`.
`collItem.itemId` in the JSX is right and must not be "fixed".

Verified against live data rather than inferred. `get_collections` performs no
conversion — `supabase/functions/_shared/alfred-tools/tool-handlers.ts:399` is a
bare `return { data };` — and the tool returns:

```json
{ "item_id": "mqx4zfxfe0nd6wv3xu4", "quantity": "2" }
```

Live jsonb counts are Amazon 1, Groceries 0, Star Nursery 3, Trader Joe's 1,
matching the recorded backfill. Trader Joe's sole member has `"quantity": ""`,
consistent with the note that empty string was normalised to null on backfill.

**Root cause of the failed backfill:** the earlier report described the in-memory
JavaScript shape (`{ itemId, quantity }`) as though it were the persisted shape.
It never mentioned the conversion layer, so a SQL backfill reading `->>'itemId'`
got NULL. The lesson generalises — for anything below the `storage` layer, snake_case
is the truth.

### 2. Every read and write of `item_collections.items`

All of it is in `src/Alfred.jsx`. No other file in `src/` touches the column.
Server-side, only `getCollections` reads it
(`supabase/functions/_shared/alfred-tools/tool-handlers.ts:383-402`); nothing outside
the browser writes it.

**Writes (5 — all via `storage.set`, all full-column rewrites):**

| Line | Path | Via |
|---|---|---|
| `1623-1624` | Triage: add item to collection | `storage.set` direct |
| `2022-2023` | Execution completion: remove checked items | `storage.set` direct |
| `2164-2165` | `updateCollectionItemQty` | `storage.set` direct |
| `2357-2360` | `addCollection` (seeds `items: []`) | `storage.set` direct |
| `2371` | `updateCollection` (the shared helper) | `storage.set` |

`updateCollection` is reached from 8 call sites: `3600` name, `3609` context,
`3623` shared, `3633` pinned, `3684` reorder, `3701` quantity, `3708` **remove**,
`3754` bulk add, `3782` create-then-add.

**Reads (13):** `1616` triage append; `2019` completion filter; `2161` quantity map;
`3055` home pinned-collection count; `3548` collections-list count; `3642`, `3653`,
`3654`, `3656`, `3660`, `3664` collection detail header/warnings/list; `3744` add-items
exclusion set; `3753`, `3781`, `3788` add paths; `5724` context-detail count;
`6469-6485` execution checklist.

**Correction to the earlier report, which the spec inherited:** it cited the manual
removal as `Alfred.jsx:3705-3712` and completion as `Alfred.jsx:2013-2029`. Both are
right. But it described `updateCollection` as having "nine" other call sites and
implied the two removal paths were the only writes — there are **five distinct write
sites**, and `updateCollectionItemQty` (`2158-2167`) is a third direct `storage.set`
caller that bypasses `updateCollection`. It appears to be dead code (no call site
found), but it must not be missed if it is ever wired up.

### 3. `storage.set` vs `updateCollection`

`storage.set` (`src/Alfred.jsx:120-160`) is the raw persistence primitive: snake_case
the whole object, `UPDATE ... eq("id", id)`, insert if zero rows matched. It touches
no React state and swallows errors, returning `false`.

`updateCollection` (`src/Alfred.jsx:2366-2379`) adds three things: it merges the patch
against the `collections` state snapshot, calls `storage.set`, and then updates state.
Its `silent` flag picks the error path — `try/catch` + `console.error` when silent,
`withLoading('Saving...')` otherwise.

**Why the execution path bypasses it:** `closeExecution` (`src/Alfred.jsx:1966`) is
already wrapped in `withLoading('Completing...')`. `withLoading`
(`src/Alfred.jsx:741-753`) sets a global overlay and, in its `finally`, clears it:

```js
    } catch (error) {
      console.error('Operation failed:', error);
      alert('Operation failed: ' + error.message);
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
```

A nested non-silent `updateCollection` would clear the overlay while the outer
operation was still running, and would `alert()` and swallow the error instead of
letting it propagate. Bypassing is therefore defensible, though nothing in the code
says so.

Two things to carry into Step 2:

- **`withLoading` never rethrows.** Every write wrapped in it silently succeeds from
  the caller's point of view. A data access layer that reports failure by throwing
  will have that signal eaten unless the call sites change.
- **`updateCollection` closes over `collections`**, not the functional updater form,
  so it can write a stale snapshot. `refreshCollection` (`2169-2176`) uses
  `setCollections((prev) => ...)` correctly. This inconsistency is part of why
  concurrent edits lose data today, independently of the jsonb blob.

### 4. `deleteCollection` and the cascade

`deleteCollection` (`src/Alfred.jsx:2381-2386`) calls `storage.delete`, which is a
single `supabase.from(table).delete().eq("id", id)` (`src/Alfred.jsx:182-200`), then
filters React state.

**There is no application-side child cleanup, so the cascade duplicates nothing.**
Nothing needs removing. Both new FKs are confirmed `ON DELETE CASCADE`:

```
collection_items_collection_id_fkey
  FOREIGN KEY (collection_id) REFERENCES item_collections(id) ON DELETE CASCADE
collection_item_removals_collection_id_fkey
  FOREIGN KEY (collection_id) REFERENCES item_collections(id) ON DELETE CASCADE
```

Caveat for the "no orphans" success criterion: `intents.collection_id`,
`events.collection_id`, `executions.collection_id` and `inbox.suggested_collection_id`
have **no foreign key** to `item_collections` (confirmed — the only FK on each of those
tables is `user_id → auth.users`). They dangle after a delete today and will continue
to. Pre-existing and out of scope, but the criterion should be read as "no orphaned
membership or removal rows", not "no dangling references anywhere".

## Step 2 findings (2026-08-19)

Two new files. **No existing file was modified**, so the app behaves exactly as it
did — nothing imports the new layer yet. `npm run build` compiles successfully.

- `src/utils/caseConvert.js` — `toSnakeCase` / `toCamelCase` lifted verbatim from
  the `storage` object so new modules share one implementation. Alfred.jsx keeps
  its own copy until Step 3, when that file is being edited anyway. Verified the
  two produce byte-identical output on real collection, member and removal rows.
- `src/utils/collectionMembers.js` — the layer itself.

Exports: `loadMembers`, `loadRemovals`, `addMember`, `addMembers`,
`updateMemberQuantity`, `reorderMembers`, `removeMember`, `removeMembers`,
`reAddRemoval`, plus `REMOVAL_MANUAL` / `REMOVAL_COMPLETED`.

### Decisions

**Result objects, not exceptions.** Every function returns `{ data, error }`,
`error` being null or a string. Some add `alreadyPresent`, `skipped`, or
`removed`. Driven by Amendment 2 — `withLoading` swallows throws, so an exception
is invisible to both caller and user.

**Bulk-first, singular as wrappers.** `removeMembers` and `addMembers` take arrays;
`removeMember` and `addMember` delegate. The execution path in Step 4 needs bulk
removal sharing one timestamp, and building that in from the start avoided a
second code path later.

**Shared timestamp comes from the server, not the client.** All removal rows go in
one INSERT and `removed_at` is left to the column default. `now()` is
transaction-stable, so every row in the statement gets an identical timestamp —
exact equality, which is what Step 6's grouping needs — with no client clock skew.

**Insert-then-delete.** supabase-js cannot open a transaction from the browser.
History is written first; a failed delete leaves the item present with a spurious
history entry, which is visible and correctable. The error message says so rather
than reporting a success the user can see is wrong.

**Name snapshot via one batched lookup.** `fetchItemNames` does a single
`.in('id', ids)` against `items`. RLS filters unreadable rows out, so they map to
null naturally. A failed lookup is logged and treated as all-null rather than
blocking the removal.

**Reorder updates only rows that moved**, each scoped by `id` AND `collection_id`.
Dragging one row in a ten-item list writes two or three rows, not ten. Scoping by
collection means a member deleted by somebody else mid-drag matches nothing —
a reorder cannot resurrect a removed row. This is why I did not use a bulk upsert,
which would have been one request but could resurrect.

**Re-add appends rather than restoring the old position**, since the list has moved
on and the stored position no longer means anything reliable.

**Duplicate tolerance is belt and braces.** Adds use
`ON CONFLICT DO NOTHING` via `upsert(..., { ignoreDuplicates: true })`, and a raw
`23505` is also caught. Already-a-member returns `alreadyPresent: true` with
`error: null`.

**`userId` is a parameter, not read from auth inside the layer.** Matches how
Alfred already passes `user.id`, and avoids a round trip per call. Callers must
pass it or `added_by` / `removed_by` land null.

**Quantity: empty string normalises to null**, consistent with what the backfill
did.

### Surprises

**`reAddRemoval` leaves the removal record in place**, so a re-added item still
shows in the panel. The table is append-only and re-adding is an insert, not an
undo — the item genuinely was removed at that time. Whether the panel filters out
removals whose item is currently a member, or shows them marked as back, is a
display decision for Step 5. Recorded in the spec as an open question. The layer
supports either.

**Amendment 3 does not bind this file.** The layer holds no React state and
triggers no re-renders, which is the right shape — a data module reaching into
component state would be worse. The functional-updater requirement therefore
applies at the Step 3 call sites, and is written into the module header and the
spec's Step 3 so it cannot be lost.

### Verification

40 tests against a scripted Supabase stub, plus 9 converter-parity checks. Covered:
camelCase round trip and that `item_id` / `itemId` land on the correct side;
position append from max+1 and 0 on an empty collection; `skipped` computation;
double-tap re-add via both the DO NOTHING path and a raw 23505; insert-before-delete
ordering asserted on actual call order; one INSERT for a bulk removal with no
client `removed_at`; null name for an unreadable item; quantity/position/reason/
removed_by snapshotting; delete-failure message; invalid reason rejected before any
write; reorder writing only moved rows and scoping by collection; limit clamping and
reason filtering. Harness is in the scratchpad, not committed — these are not wired
into `react-scripts test` and were run directly under node.

Not covered, and only provable against the real database in Step 3: that
`ignoreDuplicates` reaches PostgREST as expected, that RLS on the child tables
behaves as read, and the delete cascade.

## Step 7 findings (2026-08-19) — final step

One file touched: `src/Alfred.jsx`. Builds clean, bundle +108 B. **No collection
member anywhere renders a raw id as though it were a name.**

### The existing pattern, and where it was wrong to copy verbatim

Located at `src/Alfred.jsx:7006-7011` — the element-based execution branch,
`text-muted-foreground italic` with a `⚠` marker. The *treatment* is right and is
what got applied. Its *wording* is not reusable: it says `(item deleted)`, which
claims knowledge the client does not have. A missing item is equally likely to be
one this viewer simply cannot read.

### One component, four sites

`RemovedItemLabel` was renamed to **`ItemNameLabel`** and now covers both
provenances. A component called "Removed…" rendering a live collection member
would have been actively misleading, and a fourth variant was explicitly not
wanted.

| Site | Name source |
|---|---|
| Recently-removed panel | `item_name` snapshot |
| History view — single entry | `item_name` snapshot |
| History view — grouped rows | `item_name` snapshot |
| Collection detail item list | live `items.find(...)` |
| Execution checklist | live `items.find(...)` |

Wording changed from `⚠ Item no longer available` to **`⚠ Item unavailable`**.
"No longer" implies something changed, which is wrong for the RLS case — an item
in another person's private context was never visible to you, so nothing was lost.
This also corrects the panel and history text verified in Steps 5 and 6.

### Controls beside an unresolvable member — the call

**Remove stays enabled. Quantity is disabled. Drag and the checklist checkbox stay
enabled.**

- *Remove* — a member you cannot see is precisely the one you may need to get rid
  of. Disabling it would trap the row permanently, since nothing else in the UI can
  clear it.
- *Quantity* — disabled, with a `title` explaining why and
  `disabled:opacity-50 disabled:cursor-not-allowed`. Setting an amount on something
  you cannot identify is a guess, and it is a silent edit to data the *owner* can
  see and you cannot. Refusing is the honest answer.
- *Drag* — reordering is positional and needs no knowledge of what the item is.
  Disabling it would make the list awkward to reorder around a broken row.
- *Checklist checkbox* — stays enabled. Ticking it is the first half of clearing the
  row on completion, which is the same legitimate act as the X button.

### No raw id is shown

Considered and rejected showing the id as a muted secondary line. It is meaningless
to the reader, and reintroducing the opaque string is most of what this step exists
to remove. Two unavailable rows in one collection read identically, which is a real
but small cost; position distinguishes them, and the console helpers can resolve ids
when anyone genuinely needs them.

### Verification — creating an unresolvable member safely

**There is no UI path to delete an item.** Items can only be *archived*, and
archived items are still fetched by `select("*")`, so archiving does **not** produce
an unresolvable member. The only way to make one is to delete the `items` row while
the membership row survives — which works because `collection_items.item_id` is
deliberately not a foreign key, exactly so that an item readable by its owner but
not by a collaborator does not break the membership.

The procedure below touches **only a throwaway collection and a throwaway item**.
Nothing in Amazon, Groceries, Star Nursery or Trader Joe's is involved, and the
script refuses to run against those four by name.

**Setup**

1. **Collections → new collection**, name it `Scratch`. Leave the context as
   *No context* — that is what makes the item context-less, mirroring the real
   cause.
2. Open `Scratch` → **Add Items** → type `ZZ Test Item` → click the
   **Add as new item** button that appears. It is created and added.
3. Note its quantity box works normally at this point.
4. Paste the helper below, then run `alfredBreak("Scratch")`.
5. **Reload the page** — the app holds items in memory, so the deletion is not
   visible until it refetches.

**Expect, in `Scratch`**

- The row reads **⚠ Item unavailable** in muted italics — not a truncated id, and
  visibly different from a real item name.
- The quantity box is greyed out and will not accept typing; hovering shows
  *"This item cannot be shown, so its quantity cannot be edited"*.
- The **X** still removes the row.
- The drag handle still reorders.

**Then the checklist**

6. **Intentions** → open any intention → **Edit Intention** → set
   **Linked Collection** to `Scratch` → save → **Start Now**.
7. The checklist shows the same **⚠ Item unavailable** label, the quantity box
   disabled, and the checkbox still tickable.
8. Press **Cancel** to end that execution without removing anything.

**Cleanup**

9. Collections → `Scratch` → **Delete Collection**. The cascade takes its
   membership and removal rows; the throwaway item row is already gone. Nothing
   else was touched.
10. Optionally set that intention's **Linked Collection** back to *None*.

```js
(() => {
  const URL = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo';
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const token = JSON.parse(localStorage.getItem(k)).access_token;
  const H = { apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const get = p => fetch(URL + '/rest/v1/' + p, { headers: H }).then(r => r.json());

  // Real collections this must never touch.
  const PROTECTED = ['amazon', 'groceries', 'star nursery', "trader joe's"];

  window.alfredBreak = async (collectionName) => {
    const key = (collectionName || '').trim().toLowerCase();
    if (PROTECTED.includes(key)) {
      return console.error(`REFUSED: "${collectionName}" is real data. Use a throwaway collection.`);
    }
    const cols = await get('item_collections?select=id,name');
    const c = cols.find(x => (x.name || '').trim().toLowerCase() === key);
    if (!c) return console.error('No collection named ' + collectionName);

    const mems = await get(`collection_items?collection_id=eq.${c.id}&select=item_id`);
    if (!mems.length) return console.error('That collection has no members. Add one first.');

    const ids = mems.map(m => m.item_id);
    const items = await get(`items?id=in.(${ids.join(',')})&select=id,name`);
    // Only ever delete items explicitly named as throwaways.
    const targets = items.filter(i => (i.name || '').startsWith('ZZ Test'));
    if (!targets.length) {
      return console.error(
        'No member item named "ZZ Test…" found. Members are: ' +
        items.map(i => i.name).join(', ') + '. Refusing to delete anything else.'
      );
    }

    for (const t of targets) {
      const r = await fetch(`${URL}/rest/v1/items?id=eq.${t.id}`, { method: 'DELETE', headers: H });
      console.log(`deleted item "${t.name}" (${t.id}) → HTTP ${r.status}`);
    }
    const after = await get(`collection_items?collection_id=eq.${c.id}&select=item_id`);
    console.log(`membership rows still present: ${after.length} (the row survives — item_id is deliberately not a foreign key)`);
    console.log('Now RELOAD the page and open the collection.');
  };
  console.log('Ready: alfredBreak("Scratch")');
})();
```

### What remains after this work

- **The `item_collections.items` jsonb column still exists**, holding its frozen
  pre-migration snapshot. Nothing in `src/` reads or writes it. It is the rollback
  path and is deliberately left in place; **dropping it is a separate future
  migration** and should only happen once there is confidence the new tables are
  sound.
- ~~`getCollections` still returns the stale jsonb column~~ — **done, see the
  follow-up section at the top of this file. Awaiting deploy and verification.**
- **No MCP read tool exists for either new table.** Every verification in this
  project needed a browser console or the SQL editor. Worth adding if this data is
  going to be inspected regularly.
- **No realtime channel or poll for collections** (Amendment 4). Two people keep
  each other's additions, but neither sees the other's without a reload.
- `collection_item_removals` is append-only by intent but its RLS policy permits
  DELETE. Flagged in Step 1, unchanged, consistent with the accepted residual risk
  already documented on `item_collections`.

## Step 6 findings (2026-08-19)

One file touched: `src/Alfred.jsx`. Builds clean, no warnings, bundle +558 B.

### Navigation — pattern verified, not assumed

Re-checked: `CollectionAddItems` renders an `ArrowLeft` + **"Back to Collection"**
button, then an `<h2 className="text-lg font-medium mb-3">`, and exits via
`setView("collection-detail")`. The new view copies that exactly.

New `view` value: **`collection-history`**, consistent with the existing
`collection-detail` / `collection-add-items` naming. It reuses `selectedCollectionId`
rather than adding parallel state, so going back leaves the collection selected.

### Entry point — including when the panel is empty

This needed a decision. The panel renders nothing when there are no *manual*
removals, but a collection can have plenty of history worth reading — every removal
was a completion, or every manual one has been put back. Leaving the entry point
inside the panel would hide the history exactly in those cases.

So the removal region now has three states:

1. **Manual removals exist** — the panel renders, with a **View all** link on the
   right of its header, mirroring the Items section's header idiom (heading left,
   action right).
2. **No manual removals but history exists** — no panel, just a single
   **View removal history** link with an `Archive` icon.
3. **No history at all** — the whole region renders nothing, as before.

That required knowing whether *any* history exists while on the detail view, so the
detail view now loads both: manual removals for the panel and the full history for
the link. Two queries on open rather than one.

**Why two queries and not one.** Deriving both from a single unfiltered 50-row
fetch looked tempting, but the panel wants the most recent *manual* removals: a
collection with heavy completion churn could push every manual row out of a mixed
50-row window while manual removals still exist. Separate fetches keep both correct.

### Grouping

`groupRemovalsByAction` collapses consecutive rows sharing an exact `removedAt`
**and** `reason`. Exact string equality, no rounding and no time-window bucketing —
Step 4 proved microsecond equality holds for a real multi-item completion, and a
window would fuse genuinely separate actions that happened to land close together.
`reason` is in the key too: it costs nothing and stops a manual removal and a
completion that coincided from being presented as one action.

**A group of one gets no group treatment.** It renders as a single card with the
timestamp inline underneath the name — the same shape as a panel row, so the two
views read alike — with the reason label on the right. A heading over one item
would be ceremony for nothing.

**A bulk action gets a heading** reading `Checked off · 3 items · Today at 8:29 PM`,
with its items listed in one card beneath. The timestamp is stated once instead of
repeated on every row, which is the point of grouping.

### Display

- `friendlyDate()` throughout; no new date formatting.
- Names come from the `item_name` snapshot, never a live lookup.
- The null-name treatment from Step 5 is now a shared `RemovedItemLabel` component
  — three usages (panel, single history entry, bulk history row) justified pulling
  it out, and it gives Step 7 one place to work rather than three.
- Manual vs completed is a plain `text-xs text-muted-foreground` label —
  **Removed** or **Checked off** — not a coloured badge. "Checked off" reads as the
  tail of a shopping trip; "Removed" reads as deliberate.

### Re-add is not here, and I agree it should not be

The panel is the right home for it. This view is a record, not a workspace: it shows
re-added items too, so a re-add control here would need to know which entries are
already back and would end up duplicating the panel's filtering logic to avoid
offering a pointless button. Two controls doing the same job in two places is worse
than one.

### Constraints

- **Amendment 2.** `loadCollectionHistory` inspects `error` and sets
  `collectionHistoryError`, rendered as a destructive line — in the history view,
  and also on the detail view so a failed load cannot hide behind a missing link.
  Following the Step 5 precedent: a visible line, not an alert, for a read that
  fires on view open.
- **Amendment 3.** `setCollectionHistory((prev) => ({ ...prev, ... }))`.
- **Amendment 4.** One-shot loads on view open, plus a refresh after a manual
  removal. No channel, no poll.

### Verification — what to click

**Star Nursery needs nothing added first.** 8 removal rows including two separate
bulk completions is exactly the mix this view is for.

1. **Reaching it.** Collections → Star Nursery. If the panel is showing, click
   **View all** at the right of the *Recently removed* heading. If the panel is
   empty, you should instead see a **View removal history** link with an archive
   icon. Either way you land on **Removal history** with a *Back to Collection*
   header.
2. **Both kinds present.** Manual removals show **Removed**, completion clear-outs
   show **Checked off**. Both must appear — this view filters nothing.
3. **Bulk under one heading.** Each of the two bulk completions appears as a single
   heading like `Checked off · 2 items · <time>` with its items listed beneath —
   not as two separate entries repeating the same timestamp.
4. **Ordering.** Newest first, top to bottom.
5. **Re-added items still listed.** Anything you put back in Step 5 still appears
   here. That is the point: the panel hides resolved entries, the history does not.
6. **No history at all.** Open **Amazon** or **Groceries** — no panel and no history
   link. There is no way in, because there is nothing to see.
7. **The 50 cap.** Star Nursery has 8 rows, so the cap will not bite. The subtitle
   reads `newest first`; it only says `most recent 50` once 50 rows come back.
   Confirm the count with the console helper.

### Console helper

Standalone. Prints the exact grouping the view should render.

```js
(() => {
  const URL = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo';
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const token = JSON.parse(localStorage.getItem(k)).access_token;
  const H = { apikey: ANON, Authorization: 'Bearer ' + token };
  const get = p => fetch(URL + '/rest/v1/' + p, { headers: H }).then(r => r.json());

  window.alfredHistory = async (name) => {
    const cols = await get('item_collections?select=id,name');
    const c = cols.find(x => (x.name || '').trim().toLowerCase() === name.trim().toLowerCase());
    if (!c) return console.log('No collection named ' + name + '. Have: ' + cols.map(x => x.name.trim()).join(', '));
    const rows = await get(`collection_item_removals?collection_id=eq.${c.id}&select=id,item_name,reason,removed_at&order=removed_at.desc&limit=50`);

    const groups = [];
    for (const r of rows) {
      const g = groups[groups.length - 1];
      if (g && g.removed_at === r.removed_at && g.reason === r.reason) g.rows.push(r);
      else groups.push({ removed_at: r.removed_at, reason: r.reason, rows: [r] });
    }

    console.log(`=== ${c.name.trim()} — ${rows.length} rows, ${groups.length} groups ===`);
    if (rows.length === 50) console.log('NOTE: hit the 50 cap; subtitle should read "most recent 50".');
    groups.forEach((g, i) => {
      const label = g.reason === 'completed' ? 'Checked off' : 'Removed';
      if (g.rows.length === 1) {
        console.log(`${i + 1}. [single] ${g.rows[0].item_name ?? '(null name → ⚠ Item no longer available)'} — ${label} — ${g.removed_at}`);
      } else {
        console.log(`${i + 1}. [GROUP] ${label} · ${g.rows.length} items · ${g.removed_at}`);
        g.rows.forEach(r => console.log(`      - ${r.item_name ?? '(null name → ⚠ Item no longer available)'}`));
      }
    });
    const bulk = groups.filter(g => g.rows.length > 1);
    console.log(`bulk groups: ${bulk.length} (expect 2 for Star Nursery)`, bulk.map(g => g.rows.length));
  };
  console.log('Ready: alfredHistory("Star Nursery")');
})();
```

The printed list should match the screen group for group, in order. `[GROUP]` lines
must render as one card with its header and items inside it; `[single]` lines as one
card with the timestamp inline.

### Verification result — PASSED (2026-08-19)

| Check | Result |
|---|---|
| Both kinds present | manual and completed rows both shown |
| Bulk under one heading | the two-item completion rendered as a single block |
| Row-to-block collapse | 8 rows → 7 blocks |
| Ordering | newest first |
| Re-added items still listed | all five present — the history does not filter what the panel hides |
| Shared timestamp on the group | one timestamp for the two-item completion |
| Entry-point states | all three working |
| Group heading placement | after the fix, inside the card, matching single-entry structure |

### Display fix after review

The group heading rendered as bare text *above* the card rather than inside it.
Every single-removal block is a self-contained bordered card carrying its reason
label inside on the right, so the group was the only block whose heading floated
outside its own border — reading as a stray line — and the only card on screen with
no label.

The heading moved inside the card. A group is now one bordered block like every
other entry, using the same `p-3 bg-card border border-border rounded-lg` treatment,
with an internal header that mirrors a single entry's structure exactly:

| | Single entry | Group |
|---|---|---|
| Left, upper | item name (`font-medium text-sm`) | `N items` (`font-medium text-sm`) |
| Left, lower | timestamp (`text-xs` muted) | timestamp (`text-xs` muted) |
| Right | reason label (`text-xs` muted, `shrink-0`) | reason label (identical) |
| Below | — | `border-b` divider, then the item names |

The count occupies the slot a lone item's name occupies, which is right: a group's
identity is the action, and for a single entry the action *is* that one item. Item
names inside a group render `text-sm` rather than `font-medium`, one level down from
the block's own headline — they are the payload, not the title.

**Presentation only.** The grouping logic, ordering, 50 cap and entry-point states
are untouched; the 11 grouping tests still pass and the bundle moved +7 B. The seven
blocks and their contents are unchanged — only the group's appearance differs.

## Step 5 findings (2026-08-19)

One file touched: `src/Alfred.jsx`. Builds clean, no warnings, bundle +691 B.

### Placement — verified, not assumed

The structure was re-checked rather than taken from the earlier line references,
which have shifted every step. The `space-y-4` stack opens at `3789`; the Items
section's `<h3>` is at `3841`; the panel now sits at `3928-3972`; the
`pt-4 border-t border-border` Delete Collection block follows at `3973`. The panel
is a sibling inside the same stack and borrows the delete block's own
`pt-4 border-t border-border` treatment, which is this view's existing idiom for a
subordinate section.

### Behaviour

- **Manual removals only.** `loadCollectionRemovals` passes
  `reason: REMOVAL_MANUAL`, so a completion clear-out cannot reach the panel.
- **Re-added items filtered out.** Any removal whose `item_id` is currently a
  member is dropped at render. The record stays in the table; it is a resolved
  problem leaving a panel meant for unresolved ones.
- **Fetch window is wider than the display.** The loader asks for 25 and the panel
  slices 5 *after* filtering. Asking for exactly 5 would show fewer than five
  whenever recent entries had been put back.
- **Empty renders nothing.** No header, no placeholder — the whole block is
  conditional on there being something to show.
- **Timestamps** use the existing `friendlyDate()`; no new date formatting.
- **Names come from the `item_name` snapshot**, never a live lookup. A null name
  renders `⚠ Item no longer available` in muted italics — deliberately worded to
  cover both causes (deleted, or unreadable to this viewer) without claiming to
  know which. Kept minimal so Step 7 can generalise the pattern.

### Re-add

`putBackRemoval` calls `reAddRemoval`, then reloads members and removals. The
removal record is **not** deleted — the table is append-only and the item genuinely
was removed at that time. The entry leaves the panel because the item is a member
again, not because history was rewritten.

Double-tap is handled twice over: a `reAddingRemovalId` guard disables the buttons
while one is in flight, and `alreadyPresent` from the layer is treated as a quiet
success rather than an error. That covers both a fast double-click and the case
where the other person restored it first.

### Constraints

- **Amendment 2.** `putBackRemoval` inspects `error` and alerts through
  `reportMembershipError`. The history *read* is different: a failed load sets
  `collectionRemovalsError`, rendered as a destructive line inside the panel, and
  the panel renders for an error even when it has no rows. An alert on every visit
  to a collection would be intolerable, but a silent empty panel would hide a
  failure, so it gets a visible line instead.
- **Amendment 3.** `setCollectionRemovals((prev) => ({ ...prev, ... }))`.
- **Amendment 4.** History loads once when the detail view opens, via an effect
  keyed on `[view, selectedCollectionId]`, plus after any removal or put-back. No
  channel, no poll. Consequence: if the other person removes something while you
  have the collection open, you will not see it until you navigate away and back.

### Verification — what to click

**Star Nursery is a usable starting state; nothing needs adding first.** It has 3
members, manual removal rows (`Basil` from the 3c test) and completed rows
(`Tomato`, `Tomato cages` from Step 4).

One caveat: if you re-added `Basil` after an earlier test, the panel will correctly
hide it and may start out empty. In that case just do check 1 first — a fresh
removal — and the rest follows.

1. **Manual removal appears.** Collections → Star Nursery. Remove an item with the
   X button. A **Recently removed** section appears between the item list and
   Delete Collection, showing that item's name and `Today at H:MM`.
2. **Completion-cleared items do not appear.** `Tomato` and `Tomato cages` were
   cleared by the Step 4 execution. Neither may appear in the panel, ever. Confirm
   with the console helper below.
3. **Re-add restores quantity and clears the entry.** Note the quantity before
   removing something (say `3`). Remove it, then press **Put back**. It returns to
   the item list — at the *end*, not its old position, which is intended — with
   quantity `3`. Its panel entry disappears.
4. **The record survives.** Run `alfredPanel("Star Nursery")` after the put-back:
   the row is still in the table, listed under "hidden because the item is back".
5. **Double tap.** Remove an item, then click **Put back** twice quickly. Expect no
   alert and no error; the button disables while in flight and the entry simply
   goes. Reload and confirm the item appears once, not twice.
6. **No panel when empty.** Open **Amazon** or **Groceries**. Neither has manual
   removals, so there should be no "Recently removed" heading at all — not an empty
   one.

### Console helper

Standalone; does not depend on the earlier scripts.

```js
(() => {
  const URL = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo';
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const token = JSON.parse(localStorage.getItem(k)).access_token;
  const H = { apikey: ANON, Authorization: 'Bearer ' + token };
  const get = p => fetch(URL + '/rest/v1/' + p, { headers: H }).then(r => r.json());

  window.alfredPanel = async (name) => {
    const cols = await get('item_collections?select=id,name');
    const c = cols.find(x => (x.name || '').trim().toLowerCase() === name.trim().toLowerCase());
    if (!c) return console.log('No collection named ' + name + '. Have: ' + cols.map(x => x.name.trim()).join(', '));
    const [mems, rems] = await Promise.all([
      get(`collection_items?collection_id=eq.${c.id}&select=item_id,quantity&order=position`),
      get(`collection_item_removals?collection_id=eq.${c.id}&select=id,item_id,item_name,quantity,reason,removed_at&order=removed_at.desc`),
    ]);
    const memberIds = new Set(mems.map(m => m.item_id));
    const manual = rems.filter(r => r.reason === 'manual');
    const completed = rems.filter(r => r.reason === 'completed');
    const shown = manual.filter(r => !memberIds.has(r.item_id)).slice(0, 5);

    console.log(`=== ${c.name.trim()} ===`);
    console.log(`members: ${mems.length} | removal rows: ${rems.length} (${manual.length} manual, ${completed.length} completed)`);
    console.log('PANEL SHOULD SHOW exactly these, newest first:'); console.table(shown);
    console.log('manual rows hidden because the item is back (records still present):',
      manual.filter(r => memberIds.has(r.item_id)).map(r => r.item_name || r.item_id));
    console.log('completed rows — must NEVER appear in the panel:',
      completed.map(r => r.item_name || r.item_id));
  };
  console.log('Ready: alfredPanel("Star Nursery")');
})();
```

Compare the `PANEL SHOULD SHOW` table against what is on screen — they must match
row for row and in order.

### Verification result — PASSED (2026-08-19)

| Check | Result |
|---|---|
| Manual removal appears | shown with a relative timestamp |
| Completed rows never appear | 4 completed rows present, panel showed 2 manual |
| Re-add restores quantity | quantity restored, entry left the panel immediately |
| Record survives re-add | `White Onion` and `Basil` listed as hidden-because-back; manual rows went `3 -> 4` while displayed rows stayed `2` |
| Double tap | no error, no duplicate |
| Empty collections | no panel rendered at all |

The manual-rows `3 -> 4` against displayed-rows `2` is the result that matters: it
shows the filter is hiding resolved entries at render rather than the history being
rewritten. Both filters — `reason='manual'` and re-added-item exclusion — are doing
their jobs independently.

## Step 4 findings (2026-08-19)

One file touched: `src/Alfred.jsx`. Builds clean, no warnings.

**`item_collections.items` now has no readers and no writers anywhere in `src/`.**
It is a frozen rollback snapshot. Nothing keeps it in sync and nothing should.

### What was actually left

Verified rather than trusted: the completion block had moved to `1999-2012` inside
`closeExecution` (which now starts at `1947`), not the `2001-2004` the 3c notes
recorded. It was the only remaining `coll.items` touchpoint.

The rest of the execution view was already done — checklist read moved in 3b,
quantity write in 3c. I re-audited `ExecutionDetailView`'s whole prop surface
rather than grepping function names, per the 3c lesson. The remaining collection
props are `onToggleCollectionItem` (writes `executions.completed_item_ids`, not
collection membership), `onUpdateCollectionItemQty` (→ `saveMemberQuantity`, moved
in 3c) and `onRefreshCollection` (→ `refreshCollection`, a read that already loads
members). Nothing else touched the jsonb.

### The change

New helper `clearCompletedFromCollection(collectionId, itemIds)` beside the other
membership helpers, calling `removeMembers(...)` with `reason: REMOVAL_COMPLETED`
and `userId: user.id`, then reloading members.

**One call, not a loop.** Every item cleared by a single completion goes into one
`removeMembers` call, so all their history rows land in one INSERT and share the
server's transaction timestamp exactly. Step 6 groups a bulk clear-out by exact
timestamp equality, and a loop of singular removals would produce N distinct
timestamps and N separate headings.

`closeExecution` now calls that helper in place of the jsonb filter-and-write.

### Constraints honoured

- **No nested `withLoading`.** `closeExecution` is already inside
  `withLoading('Completing...')`, which clears the overlay in its `finally` and
  never rethrows. The helper inspects the returned `{ data, error }` and reports
  through `reportMembershipError`; nothing depends on an exception propagating.
- **Amendment 3.** State updates go through `setCollectionMembers((prev) => ...)`
  inside `loadCollectionMembers`. The old code's
  `setCollections(collections.map(...))` — a render-time snapshot — is gone.
- **Amendment 4.** No channel, no poll added.
- **Cancel and Pause unaffected.** The `outcome === "cancelled"` branch returns at
  `1953-1958`, before any collection code. Pause is `pauseExecution`, a different
  function that never reaches `closeExecution`. The `outcome === "done" &&
  activeExecution.collectionId` guard is intact at `2002`.

### How to set up a collection-based execution

The flow is not obvious — an execution only shows a collection checklist if its
intention has a **Linked Collection**. Steps:

1. **Nav → Intentions** (lightbulb icon).
2. Click any intention to open its detail view. (If there are none, add one from a
   context first.)
3. Click **Edit Intention** (gear icon, top right).
4. Scroll to **"Linked Collection (optional)"** and pick e.g. *Star Nursery*. Save.
5. Go back to **Intentions**. That intention's card now has a **Start Now** button
   (play icon). Click it.
   - *Alternative:* **Do Today**, then **Schedule → Start** on the event card.
6. You are now in the execution detail view. Instead of the usual step list it
   shows the collection as a checklist, headed `Star Nursery (0/3)`.
7. Tick one or two items — click the square checkbox at the left of a row. Leave at
   least one unticked, so the "unchecked items still present" check means something.
8. Click the green **Complete** button at the bottom right.

For the cancel test, repeat 5–7 and click the grey **Cancel** button instead.
Cancel deletes the execution and must remove nothing from the collection.

### Verification script — Step 4

This supersedes the 3c script; it includes everything from it. Paste once, then use
`alfred.mark()` before an execution and `alfred.checkCompletion()` /
`alfred.checkCancel()` after.

```js
(() => {
  const URL = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo';
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const token = JSON.parse(localStorage.getItem(k)).access_token;
  const H = { apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const get = p => fetch(URL + '/rest/v1/' + p, { headers: H }).then(r => r.json());
  const norm = q => (q === null || q === undefined ? '' : String(q));
  const ok = (b, msg) => console.log((b ? '%cPASS' : '%cFAIL') + '%c  ' + msg,
    'color:' + (b ? 'green' : 'red') + ';font-weight:bold', 'color:inherit');

  async function byName(name) {
    const cols = await get('item_collections?select=id,name,items');
    const c = cols.find(x => (x.name || '').trim().toLowerCase() === name.trim().toLowerCase());
    if (!c) throw new Error('No collection named ' + name + '. Have: ' + cols.map(x => x.name.trim()).join(', '));
    return c;
  }

  async function state(c) {
    const [mems, rems] = await Promise.all([
      get(`collection_items?collection_id=eq.${c.id}&select=item_id,quantity,position&order=position`),
      get(`collection_item_removals?collection_id=eq.${c.id}&select=id,item_id,item_name,quantity,position,reason,removed_at,removed_by&order=removed_at.desc`),
    ]);
    return { mems, rems, jsonb: (c.items || []).map(x => x.item_id + '=' + norm(x.quantity)) };
  }

  const marks = {};

  window.alfred = {
    async snapshot(name) {
      const c = await byName(name);
      const s = await state(c);
      console.log(`=== ${c.name.trim()} (${c.id}) ===`);
      console.log('collection_items — live membership:'); console.table(s.mems);
      console.log('collection_item_removals — history:'); console.table(s.rems.slice(0, 10));
      console.log('frozen jsonb (must NOT change any more):', s.jsonb);
      return s;
    },

    async mark(name) {
      const c = await byName(name);
      marks[c.id] = await state(c);
      console.log(`marked "${c.name.trim()}" — ${marks[c.id].mems.length} members, ${marks[c.id].rems.length} removal rows`);
    },

    async checkCompletion(name) {
      const c = await byName(name);
      const before = marks[c.id];
      if (!before) return console.log(`Run alfred.mark("${name}") before the execution.`);
      const after = await state(c);

      const beforeIds = before.mems.map(m => m.item_id);
      const afterIds = after.mems.map(m => m.item_id);
      const gone = beforeIds.filter(i => !afterIds.includes(i));
      const known = new Set(before.rems.map(r => r.id));
      const fresh = after.rems.filter(r => !known.has(r.id));
      const stamps = [...new Set(fresh.map(r => r.removed_at))];

      console.log(`=== ${c.name.trim()} — completion ===`);
      console.log('members', beforeIds.length, '->', afterIds.length, '| removed:', gone);
      console.table(fresh);

      ok(gone.length > 0, 'checked items removed from collection_items');
      ok(fresh.length === gone.length, `one removal row per removed item (${fresh.length} rows / ${gone.length} removed)`);
      ok(fresh.length > 0 && fresh.every(r => r.reason === 'completed'), "every new row has reason='completed'");
      ok(stamps.length === 1, `all rows share one removed_at → ${stamps.join(' | ') || '(none)'}`);
      ok(fresh.every(r => r.item_name), 'item_name captured on every row');
      ok(beforeIds.filter(i => !gone.includes(i)).every(i => afterIds.includes(i)), 'unchecked items still present');
      ok(JSON.stringify(before.jsonb) === JSON.stringify(after.jsonb), 'frozen jsonb unchanged');
    },

    async checkCancel(name) {
      const c = await byName(name);
      const before = marks[c.id];
      if (!before) return console.log(`Run alfred.mark("${name}") before the execution.`);
      const after = await state(c);
      const ids = s => JSON.stringify(s.mems.map(m => m.item_id));
      console.log(`=== ${c.name.trim()} — cancel ===`);
      ok(ids(before) === ids(after), 'membership unchanged');
      ok(before.rems.length === after.rems.length, 'no removal rows written');
      ok(JSON.stringify(before.jsonb) === JSON.stringify(after.jsonb), 'frozen jsonb unchanged');
    },

    async dupTest(name) {
      const c = await byName(name);
      const before = await get(`collection_items?collection_id=eq.${c.id}&select=item_id&order=position`);
      if (!before.length) { console.log('Add an item to this collection first.'); return; }
      const body = JSON.stringify([{ collection_id: c.id, item_id: before[0].item_id, position: 999 }]);
      const send = () => fetch(`${URL}/rest/v1/collection_items?on_conflict=collection_id,item_id`, {
        method: 'POST',
        headers: { ...H, Prefer: 'return=representation,resolution=ignore-duplicates' },
        body,
      }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
      const first = await send(); const second = await send();
      const after = await get(`collection_items?collection_id=eq.${c.id}&select=item_id`);
      console.log('insert #1:', first, '\ninsert #2:', second);
      ok(first.status < 300 && second.status < 300 && after.length === before.length,
        `duplicates absorbed, count ${before.length} -> ${after.length}`);
    },
  };
  console.log('Ready: alfred.mark("Star Nursery") → run the execution → alfred.checkCompletion("Star Nursery")');
})();
```

**Sequence to run:**

1. `alfred.mark("Star Nursery")`
2. Do steps 1–8 above, ticking some but not all items, and press **Complete**.
3. `alfred.checkCompletion("Star Nursery")` — expect seven `PASS` lines. The
   `removed_at` line should print exactly one timestamp; two or more means the
   rows did not share an INSERT and Step 6's grouping will not work.
4. `alfred.mark("Star Nursery")` again, start another execution, tick something,
   and press **Cancel**.
5. `alfred.checkCancel("Star Nursery")` — expect three `PASS` lines.

The collection will be emptier afterwards; re-add items from the collection detail
view when you are done.

### Verification result — PASSED (2026-08-19)

| Check | Result |
|---|---|
| Checked items removed | 5 members → 3, two items removed |
| One row per removed item | two rows, both `reason='completed'` |
| Shared `removed_at` | both exactly `2026-08-19T20:29:30.475241+00:00` |
| `item_name` captured | `'Tomato'`, `'Tomato cages'` |
| Unchecked items | still present |
| Frozen jsonb | unchanged |
| Cancel | membership unchanged, no removal rows written, jsonb unchanged |

The timestamp result is the important one: this was a **two-item** removal, so it
proves the single-INSERT design actually yields exact equality. The earlier
single-item manual removal could not distinguish that from per-row `now()`. Step 6
can safely group a bulk clear-out by `removed_at` equality.

## Step 3c findings (2026-08-19)

One file touched: `src/Alfred.jsx`. Builds clean, no warnings. **The
`item_collections.items` jsonb is no longer written by any membership path** — the
sole remaining writer is execution completion, deliberately deferred to Step 4.

### Correction to a Step 1 finding — `updateCollectionItemQty` was NOT dead

Step 1 recorded it as dead code with no call sites, and the Step 3c brief inherited
that and asked for it to be deleted. **It was live.** It reaches the execution
checklist's quantity box through a prop, which a grep for `updateCollectionItemQty(`
does not see:

```
2143  async function updateCollectionItemQty(collectionId, itemId, quantity)
3324  onUpdateCollectionItemQty={updateCollectionItemQty}      <- passed to ExecutionDetailView
6426  onUpdateCollectionItemQty,                               <- destructured prop
6553  onUpdateCollectionItemQty(execution.collectionId, collItem.itemId, e.target.value)
```

Deleting it outright would have silently broken quantity editing during a
collection-based execution. The function is gone as asked, and the prop now points
at `saveMemberQuantity` — identical `(collectionId, itemId, quantity)` signature, so
the checklist keeps working and its quantity write moves onto `collection_items`
along with everything else.

That does touch the execution view, which is otherwise Step 4's territory. It was
unavoidable: the function had to go somewhere, and leaving the only caller writing
jsonb would have defeated the point of the step. Execution **completion**
(`2001-2004`) is untouched and still on the jsonb path.

**Lesson for the remaining steps:** grepping a function name is not enough in this
file. Props carry functions across component boundaries under different names, so
a "no call sites" conclusion needs the prop name checked too.

### What moved

New helpers alongside the 3b read code, each inspecting `{ data, error }` and
surfacing failure:

- `setMembersFor(id, updater)` — local membership state, functional updater
- `reportMembershipError(action, message)` — `console.error` plus an `alert`
- `addItemsToCollection`, `removeItemFromCollection`, `saveMemberQuantity`,
  `saveMemberOrder`

Write paths now on `collection_items`:

| Was | Now |
|---|---|
| Triage add (jsonb append + `storage.set`) | `addItemsToCollection` |
| `addCollection` seeding `items: []` | seed removed entirely |
| Reorder (`updateCollection` silent) | `saveMemberOrder` → `reorderMembers` |
| Quantity (`updateCollection` silent) | `saveMemberQuantity` → `updateMemberQuantity` |
| X button (`updateCollection` by index) | `removeItemFromCollection` → `removeMember`, `reason='manual'` |
| Bulk add | `addItemsToCollection` → `addMembers` |
| Create-then-add | `addItemsToCollection` |
| Execution checklist quantity | `saveMemberQuantity` (see correction above) |

Reads 3b held back have moved too, now that a real unique constraint sits behind
them: the add-items `existingItemIds` exclusion set, the `maxItems` cap, and the
quantity input's `value` binding (now `member.quantity`, edited optimistically in
`collectionMembers` and saved on blur).

Removal is keyed by `itemId`, not by array index — the index-based delete is gone,
and with it the 3b hazard about desynchronised indices corrupting the jsonb.

### Amendment 2 — every call site inspects `error`

`withLoading` catches and never rethrows, so the layer returns rather than throws.
Each helper checks `error`, logs it, and puts an `alert` in front of the user —
matching `withLoading`'s own failure surface, so it cannot be mistaken for success.
Specific behaviours:

- A failed add leaves the user on the add-items screen so the selection is not lost.
- A failed removal or quantity save reloads members, so the list shows what is
  actually in the database rather than the optimistic guess.
- Items already present come back as `skipped`, not an error, and are reported as
  "already in this collection" — a no-op, not a failure.

### Amendment 3 — stale snapshots fixed

`updateCollection` now applies its patch through `setCollections((prev) => ...)`
rather than replacing the row with a render-time snapshot. `addCollection` and
`deleteCollection` had the identical defect on adjacent lines and were fixed the
same way; leaving two of the three would have been arbitrary. `deleteCollection`
also drops the collection's entry from `collectionMembers`.

### Verification script for Step 3c

Paste once into the console of the logged-in app. It defines `alfred.snapshot()`
and `alfred.dupTest()`; nothing runs until called.

```js
(() => {
  const URL = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo';
  const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const token = JSON.parse(localStorage.getItem(k)).access_token;
  const H = { apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const get = p => fetch(URL + '/rest/v1/' + p, { headers: H }).then(r => r.json());

  async function byName(name) {
    const cols = await get('item_collections?select=id,name,items');
    const c = cols.find(x => (x.name || '').trim().toLowerCase() === name.trim().toLowerCase());
    if (!c) throw new Error('No collection named ' + name + '. Have: ' + cols.map(x => x.name.trim()).join(', '));
    return c;
  }

  window.alfred = {
    async snapshot(name) {
      const c = await byName(name);
      const [mems, rems] = await Promise.all([
        get(`collection_items?collection_id=eq.${c.id}&select=item_id,quantity,position,added_at,added_by&order=position`),
        get(`collection_item_removals?collection_id=eq.${c.id}&select=item_id,item_name,quantity,position,reason,removed_at,removed_by&order=removed_at.desc&limit=10`),
      ]);
      console.log(`=== ${c.name.trim()} (${c.id}) ===`);
      console.log('collection_items — live membership:'); console.table(mems);
      console.log('collection_item_removals — last 10:'); console.table(rems);
      console.log('frozen jsonb (must NOT change any more):',
        (c.items || []).map(x => x.item_id + '=' + (x.quantity ?? '')));
      return { members: mems, removals: rems, jsonb: c.items };
    },

    // Fires the exact request supabase-js sends for an upsert with
    // ignoreDuplicates, twice, against a row that already exists. Adds nothing.
    async dupTest(name) {
      const c = await byName(name);
      const before = await get(`collection_items?collection_id=eq.${c.id}&select=item_id&order=position`);
      if (!before.length) { console.log('Add an item to this collection first.'); return; }
      const victim = before[0];
      const body = JSON.stringify([{ collection_id: c.id, item_id: victim.item_id, position: 999 }]);
      const send = () => fetch(`${URL}/rest/v1/collection_items?on_conflict=collection_id,item_id`, {
        method: 'POST',
        headers: { ...H, Prefer: 'return=representation,resolution=ignore-duplicates' },
        body,
      }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

      const first = await send();
      const second = await send();
      const after = await get(`collection_items?collection_id=eq.${c.id}&select=item_id&order=position`);
      console.log('duplicate insert #1:', first);
      console.log('duplicate insert #2:', second);
      console.log('member count before -> after:', before.length, '->', after.length);
      const ok = first.status < 300 && second.status < 300 && after.length === before.length;
      console.log(ok
        ? 'PASS — ON CONFLICT DO NOTHING absorbed both, nothing added, no error raised'
        : 'FAIL — see above');
    },
  };
  console.log('Ready: alfred.snapshot("Star Nursery"), alfred.dupTest("Star Nursery")');
})();
```

**What to exercise, and what to expect:**

1. **Add / remove / reorder / quantity.** Open a collection, do each, then
   `alfred.snapshot("<name>")`. Every change must appear in `collection_items` —
   `position` renumbering after a drag, the new `quantity`, the row gone after a
   removal. The `frozen jsonb` line must be **identical every time**; if it moves,
   something is still writing the old column.
2. **Manual removal history.** After removing an item, its row appears in
   `collection_item_removals` with `reason: "manual"`, `item_name` filled in, the
   `quantity` and `position` it had, and `removed_by` set to your uid.
3. **Duplicate handling.** `alfred.dupTest("<name>")` → `PASS`. This is the first
   real-database exercise of the `ignoreDuplicates` path; the Step 2 tests only
   proved the request we build, not that PostgREST honours it. Note the re-add
   *button* does not exist until Step 5, and the Add Items screen now filters out
   existing members, so this path is not otherwise reachable from the UI.

**Check 4 — orphans — cannot be done from the browser.** The child-table policies
are `EXISTS (SELECT 1 FROM item_collections c WHERE c.id = <child>.collection_id ...)`,
so a row whose parent is gone fails its own RLS check and is invisible to the
client. A browser query would return zero rows whether the cascade worked or not,
which is a false pass. Run this in the Supabase SQL editor instead, after deleting
a throwaway collection — both counts must be `0`:

```sql
select 'collection_items' as tbl, count(*) as orphans
  from public.collection_items ci
  left join public.item_collections c on c.id = ci.collection_id
 where c.id is null
union all
select 'collection_item_removals', count(*)
  from public.collection_item_removals r
  left join public.item_collections c on c.id = r.collection_id
 where c.id is null;
```

### Verification result — PASSED (2026-08-19)

Run by Alex in the app, plus the orphan query in the Supabase SQL editor.

| Check | Result |
|---|---|
| Add | new member row appeared with the correct `position` |
| Reorder | `position` renumbered correctly |
| Quantity | `4` → `2` persisted on blur |
| Manual removal | member row gone; `collection_item_removals` row written with `item_name` `'Basil'`, `reason='manual'`, `removed_by` set |
| Frozen jsonb | identical across three snapshots — nothing writes the old column |
| Duplicate handling | `dupTest` PASS — two `201`s, count `3 -> 3`, `ON CONFLICT DO NOTHING` honoured by PostgREST |
| Orphans (SQL editor) | `0` and `0` — cascade confirmed on both child tables |

Three things the Step 2 stub could not prove are now confirmed against the real
database: PostgREST honours `resolution=ignore-duplicates` with the `on_conflict`
target, the removal insert captures `item_name` and `reason` as designed, and
`ON DELETE CASCADE` reaches both child tables.

### Interim hazard — resolved by Step 4

Between 3c and 4, execution completion still rewrote the frozen jsonb from stale
state and did not clear `collection_items`. Step 4 removed that path. Nothing in
`src/` reads or writes `item_collections.items` any more.

## Step 3b findings (2026-08-19)

One file touched: `src/Alfred.jsx`, +83/−50. Reads only; every write path still
targets the jsonb column untouched.

### What moved

New state `collectionMembers` (a map of collection id → member rows) and
`collectionMembersError`, plus `loadCollectionMembers(ids)` and a `membersOf(id)`
accessor. Membership is loaded via `loadMembers()` from `loadData`, `refreshData`
and `refreshCollection`, one call per collection — four queries at current scale,
and it uses the API Step 2 actually specified rather than inventing a bulk loader.

Display reads now served from `collection_items`:

- Collection detail item list, count, and the 50/200 warnings
- Collections list count
- Home pinned-collections count
- Context detail collection count (new `collectionMembers` prop)
- Execution checklist and its completed count (new `collectionMembers` prop)

### What deliberately did NOT move

Reads whose result is fed straight into a jsonb write stay on the jsonb, because
the write they serve has not moved:

- Triage add, execution-completion filter, drag-reorder, quantity edit, remove,
  bulk add, create-then-add, and the dead `updateCollectionItemQty`.
- The add-items screen's `existingItemIds` exclusion set and `maxItems` cap.
  These guard a jsonb write. Pointing them at the new table while the add still
  appends to jsonb would let the same item be added twice, and the jsonb has no
  unique constraint to catch it.
- **The quantity input's `value`.** Its `onChange` edits the jsonb array in place
  and `onBlur` saves it, so binding the field to the read source would make typing
  appear to do nothing. It stays bound to the jsonb entry, falling back to the
  member row. Both collapse onto `collection_items` in 3c.

### The build warning, investigated rather than silenced

The first build after this change reported
`react-hooks/exhaustive-deps: React Hook useEffect has a missing dependency: 'refreshData'`.
Earlier steps built clean, so it was new. Confirmed by building the HEAD version
of the file (clean) and then bisecting to the single line
`await loadCollectionMembers(...)` inside `refreshData` — with that line commented
out the warning disappears. Adding a call to another component-scope function
makes `refreshData` no longer provably static in the rule's model, so it starts
demanding to be declared.

Resolved with `// eslint-disable-next-line react-hooks/exhaustive-deps`, matching
the existing suppression on the init effect directly above. Adding `refreshData`
to the array instead would tear down and re-attach the `visibilitychange` listener
on every render, which is a real regression. The listener closes over nothing
render-scoped — only stable setters and module imports — so there is no staleness
being masked. Build is clean again.

### Verification done

- `npm run build` — compiled successfully, no warnings.
- `npm start` — dev server compiles and serves; `http://localhost:3000` returns
  HTTP 200 with the app title, bundle 4.2 MB HTTP 200.
- jsonb baseline re-read via the `get_collections` MCP tool and recorded below.

### Verification result — PASSED (2026-08-19)

Run by Alex in the logged-in app, since Google OAuth and the absence of a browser
driver put it out of reach from the agent side.

- `collection_items rows visible under RLS: 5`
- `MATCH` on all four collections, including **Trader Joe's** — a shared
  collection read as non-owner, which is the case the child-table policy most
  needed to prove.

All three things Step 3b existed to establish are now confirmed against the real
database rather than a stub: the child-table RLS permits the read, the backfilled
rows match the jsonb exactly (membership, quantities and order), and PostgREST
returns the shape `loadMembers` expects.

**jsonb baseline (via `get_collections`, 2026-08-19):**

| Collection | id | Members (item_id = quantity, in order) |
|---|---|---|
| Amazon | `mo773ha3uixpo3jaxvc` | `mqx4zfxfe0nd6wv3xu4` = 2 |
| Groceries | `mlsy44a9endmm8jt9tr` | *(none)* |
| Star Nursery | `mm43ldwtzb6sgoy1an` | `mm43m5lqv0p6ygkyob9` = 3, `mlzigrbveovbmaq8lgb` = 1, `mm43ndrmspiz71via98` = 4 |
| Trader Joe's | `msdbwlcvzrjil4z8nwg` | `msgumaa2ex7ihn1dprk` = *(empty)* |

**To verify** — with the app open and logged in, paste into the browser console.
It compares both sources including order, and treats empty string and null as the
same quantity because the backfill normalised `''` to null:

```js
(async () => {
  const URL = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo';
  const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  const token = JSON.parse(localStorage.getItem(key)).access_token;
  const h = { apikey: ANON, Authorization: 'Bearer ' + token };
  const get = p => fetch(URL + '/rest/v1/' + p, { headers: h }).then(r => r.json());
  const norm = q => (q === null || q === undefined ? '' : String(q));

  const [cols, mems] = await Promise.all([
    get('item_collections?select=id,name,items&order=name'),
    get('collection_items?select=collection_id,item_id,quantity,position&order=collection_id,position'),
  ]);

  console.log('collection_items rows visible under RLS:', mems.length);
  for (const c of cols) {
    const a = (c.items || []).map(x => x.item_id + '=' + norm(x.quantity));
    const b = mems.filter(m => m.collection_id === c.id).map(m => m.item_id + '=' + norm(m.quantity));
    const same = JSON.stringify(a) === JSON.stringify(b);
    console.log((same ? 'MATCH  ' : 'DIFFER ') + c.name.trim(), '| jsonb', a.length, '| rows', b.length);
    if (!same) console.log('   jsonb:', a, '\n   rows :', b);
  }
})();
```

`collection_items rows visible under RLS: 0` would mean the child-table policy is
not permitting the read — report it rather than working around it.

### Two hazards while 3b is live

1. **An edit made now is lost at 3c.** Writes land in the jsonb; `collection_items`
   was backfilled once before Step 1 and nothing propagates into it during 3b. At
   3c the jsonb stops being read, so anything added or removed in between simply
   is not there. Either avoid editing collections until 3c lands, or re-run the
   backfill first.
2. **An edit desynchronises the detail list from its own write handlers.** The
   list renders from `collection_items` while the drag, quantity and remove
   handlers index into the jsonb array. They agree exactly right now. After one
   edit they do not, and an index-based write can then hit the wrong element and
   corrupt the jsonb — which is the rollback path. Same mitigation.

Both are consequences of the no-dual-write decision, which stands; they are worth
recording because they make "don't edit collections between 3b and 3c" a real
instruction rather than a nicety.

### Note

The dev server used for the smoke test has been stopped; port 3000 is free. Start
it again with `npm start` when running the verification script above.

## Step 3a findings (2026-08-19)

Deduplication only, no behaviour change. One file touched: `src/Alfred.jsx`,
two edits, net −30 lines.

1. Added `import { toCamelCase, toSnakeCase } from "./utils/caseConvert";`
   (`src/Alfred.jsx:38`).
2. Replaced the two method bodies inside `storage` with ES6 shorthand properties
   referencing the imports (`src/Alfred.jsx:56-61`).

`grep` for the implementation now matches exactly one file, `src/utils/caseConvert.js`.

### Why properties rather than direct calls

`storage.toCamelCase(...)` is called from about 25 sites in this file — the two
load paths, `refreshCollection`, the realtime wrapper, the AI-enrich handler — and
`this.toCamelCase` / `this.toSnakeCase` from inside `storage.get` and `storage.set`
(now `src/Alfred.jsx:84` and `src/Alfred.jsx:101`). Keeping them as properties on
`storage` leaves every one of those call sites untouched, which is what makes this
a deduplication rather than a refactor. The imported functions recurse by name
rather than through `this`, so property dispatch resolves them correctly.

### Shadowing checked, not assumed

`setupRealtimeSubscriptions` declares a function-scoped
`const toCamelCase = (obj) => storage.toCamelCase(obj);` at `src/Alfred.jsx:1173`,
and six handler functions take `toCamelCase` as a parameter. These now shadow the
module-level import. Verified that no reference to the name occurs before that
`const` inside the function, so there is no temporal-dead-zone hazard, and the
wrapper still routes through `storage` explicitly. Behaviour unchanged.

### Verification

- `npm run build` — compiled successfully, no warnings. Bundle +7 B.
- 9 targeted tests replicating the post-dedupe `storage` shape: `this.`-dispatch
  through the property for both directions, jsonb array elements converting
  (`item_id` ⇄ `itemId`), lossless round trip on a real collection row, detached
  `storage.toCamelCase(d)` inside `.map()`, the realtime wrapper, and null/primitive
  pass-through.
- Re-ran the Step 2 suite against the now-shared module: 40 passed.

No collection read or write path was touched, and `collectionMembers.js` is still
not imported anywhere.

## Surprises and flags (Step 1)

1. **No realtime subscription for `item_collections`.** Six channels exist —
   `inbox-changes`, `contexts-changes`, `items-changes`, `intents-changes`,
   `events-changes`, `executions-changes` (`src/Alfred.jsx:1206-1310`) — and none
   covers collections. The only live-refresh mechanism is a 5-second poll that exists
   **only in the execution view** (`src/Alfred.jsx:6402-6410`, calling
   `refreshCollection`). The collection detail view has neither.

   This bears directly on success criterion #1. Moving to per-row `collection_items`
   stops the two users' writes from *destroying* each other, so both rows will survive
   in the database. But with no realtime and no poll on the detail view, User B still
   will not *see* User A's addition without a manual reload. Worth deciding before
   Step 3 whether that criterion means "both rows persist" or "both users see both
   rows", because the second needs work the spec does not currently scope.

2. **The new tables' RLS does not mirror `item_collections` exactly**, contrary to the
   spec's wording. `item_collections` grants a non-owner only `SELECT` and `UPDATE` on
   a shared collection. Both child tables grant command `ALL`:

   ```sql
   EXISTS (SELECT 1 FROM item_collections c
           WHERE c.id = <child>.collection_id
             AND (c.user_id = auth.uid() OR c.shared = true))
   ```

   The broadening is *necessary* — a collaborator now needs INSERT and DELETE on
   `collection_items` to do what used to be an UPDATE of the parent's jsonb — so this
   reads as correct, not as a defect. Recording it only because the spec claims exact
   mirroring and someone will otherwise trip over the difference.

   Consequence worth noting: `collection_item_removals` is described as append-only,
   but its policy permits DELETE. Nothing enforces append-only at the database level.
   Not blocking, and consistent with the existing accepted residual risk documented in
   the `item_collections` table comment; flagged rather than acted on.

3. **No MCP read tool exists for either new table**, so the backfill contents could not
   be independently re-verified here. The jsonb side matches the recorded counts
   exactly, which is corroborating but not proof that `collection_items` matches. If
   independent verification matters before Step 3, it needs a direct SQL check.

4. `updateCollectionItemQty` (`src/Alfred.jsx:2158-2167`) has no call sites — apparently
   dead. Quantity edits actually go through `updateCollection` at `3701`. It still writes
   the jsonb, so it must either be migrated or deleted in Step 3 rather than left behind.

## Notes

The earlier investigation report was wrong about the jsonb key name — it said
`itemId`, the actual key is `item_id`. Its claim about camelCase in React is
unverified. Treat its file and line references as leads to check, not as facts.

**Resolved in Step 1.** The conversion layer is real and quoted above. Both keys are
correct in their own layer: `item_id` on disk, `itemId` in React. The earlier report's
mistake was stating the JavaScript shape without noting the conversion, not
misreading the code. Its cited line numbers for the two removal paths and for
`friendlyDate`/`deleteCollection` were spot-checked and are accurate; its enumeration
of write sites was incomplete (see §2).
