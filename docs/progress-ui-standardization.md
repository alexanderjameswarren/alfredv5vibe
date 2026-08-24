# Progress: Alfred UI Action Standardization

## Status: Steps 1–9a verified. Step 9b done, awaiting verification.

**Deferred to its own step:** Context Archive. `contexts.archived` does not exist yet;
the migration is being run separately by Alex. When it lands, Context Archive arrives
as its own step including the Recycle Bin Contexts tab and an empty-context guard.
**Write no SQL.**

Confirmations: only the Recycle Bin's two permanent-delete dialogs remain, kept
permanently by decision (spec Undo section, exception 1).

**Routing tripwire:** `setView(` is now **37**, down from 39 at slice-1 close. Both
removals were deliberate — see Step 5 and Step 6 findings.

Spec: `docs/technical-spec-ui-standardization.md` (Revision 2)

Step 1 of the original plan — the codebase survey — is complete. Its findings are
folded into Revision 2 of the spec. Steps below start from that baseline.

### Development Steps

- [x] **Step 1 — Defect repairs.** _(done 2026-08-21 — see "Step 1 findings" below)_
      Spec Part 0, all five: ItemCard phantom-item
      archive, missing dirty guard on Related Intentions, nested EventCard
      double-fire, archiveIntention's unwanted navigation, and the unguarded logo
      link. Small and independent; do them as one step but verify each separately.
- [x] **Step 2 — Undo message.** _(done and verified 2026-08-22 — see "Step 2
      findings" below)_ Shared 5-second bottom message with Undo, sitting
      above the Capture bar, wired to all four archive paths.
      **Delete Collection's `window.confirm` deliberately left in place** — see
      the resolution under Step 2 findings. It closes in Step 4.
- [x] **Step 3 — Card click consistency.** _(done 2026-08-22 — see "Step 3
      findings" below)_ Make ContextCard and EventCard
      whole-card clickable to match ItemCard/IntentionCard/ExecutionBadge. Remove
      ContextCard's phantom stopPropagation. Do NOT convert rows to anchors — see
      spec, "Row click targets — deferred." **The stopPropagation was KEPT — the
      first half of this step makes it load-bearing. See findings.**
- [x] **Step 4a — Extract CollectionCard.** _(done 2026-08-24 — see "Step 4a
      findings" below)_ One component replacing three drifted copies. Props:
      `showContextBadge`, `onOpen`, `memberCount`, `contexts`. Home's
      unconditional Pin becomes conditional. Pure refactor. The spec's third
      prop, `showPin`, was dropped on review — no caller varied it.
- [x] **Step 4b — Collection soft delete.** _(done 2026-08-24 — see "Step 4b
      findings" below)_ Split out from Step 4 because it is
      an independent job on the same files:
      - `deleteCollection` becomes an archive — sets `archived = true` on
        `item_collections` — wired to the Undo message like the other four paths,
        and its `window.confirm` goes at the same time
      - all three collection list sites filter out archived collections
      - the Recycle Bin gains a **Collections** tab alongside Items / Intents /
        Events / Executions / Songs / Snippets
      - **Report what the Collections tab's permanent delete will do BEFORE
        wiring it.** It is the one remaining hard delete and it cascades to
        `collection_items` and `collection_item_removals`. Its two existing
        confirms stay, per the recorded decision.
      The `archived` column is **already applied**; write no SQL.
- [x] **Step 5 — View page action bars.** _(done 2026-08-24, verified — see
      "Step 5 findings" below)_ Top-right actions on item, intention, and
      context detail per spec. Add Archive to item detail. Make Context detail's
      Edit work in place rather than bouncing to the Contexts list.
      **Done:** Item detail Archive; Intention detail Do Today · Start Now ·
      Edit · Archive; Context detail edits in place.
      **Split out by decision:** Context detail Archive and the Recycle Bin
      Contexts tab — now their own step, pending the migration. See Step 11.
      **Delivered by Step 6:** Intention detail's Schedule Later.
- [x] **Step 6 — Do Today / Schedule Later symmetry.** _(done 2026-08-24 — see
      "Step 6 findings" below)_ Both become date popovers
      that commit immediately; neither navigates. Remove or repurpose the
      commented-out `handleScheduleLater`.
- [x] **Step 7 — Form footers.** _(done 2026-08-24 — see "Step 7 findings"
      below)_ Sticky footer for the two full-screen forms.
      Standardize inline footer order on the four card edits; fix EventCard's
      Save · Archive · Close ordering.
- [x] **Step 7b — Sticky footers for whole-page card edits.** _(done 2026-08-24
      — see "Step 7b findings" below)_ Added after Step 7 review. Revision 2
      excluded in-place card edits from sticky footers because siblings can be
      open at once — but that does not apply where a card renders **alone as the
      whole page**. `stickyFooter` passed at exactly two sites: item detail's
      edit mode and intention detail's edit mode. Every card inside a list keeps
      the default. This is the recipe-form case the phase started from.
- [x] **Step 7c — `getTodayDate()` returned tomorrow after 4pm Pacific.**
      _(done 2026-08-24 — see "Step 7c findings" below)_ Promoted from Step 12
      on review. Fixed via a shared `toLocalDateString` helper, which also fixed
      a **second, opposite-direction instance** of the same bug in
      `triggerRecurrence`. **11 existing rows carry a wrong stored date** — see
      findings for the list and the query to count the rest.
- [x] **Step 8a — Event row strips and execution guards.** _(done 2026-08-24 —
      see "Step 8a findings" below)_ Split from Step 8 because `EventCard`
      renders on both Home and Schedule, so a page-based split would touch one
      component twice. Axis confirmed by Alex.
      - `EventCard` (4 sites): right-aligned **Start/Continue · Archive**, always
        visible. **No Edit** — the row click already opens the edit form.
      - Archive moves out of the edit form per governing rule 4.
      - `EventCard`'s missing `hover:border-primary`, settled with the nested
        double-highlight (deferred from Step 3).
      - Both redundant per-row executions queries — `EventCard`'s and
        `IntentionCard`'s — derived from the `executions` prop instead.
- [x] **Step 8b — Record-only row strips and the visual sweep.** _(done
      2026-08-24 — see "Step 8b findings" below)_
- [x] **Step 8c — Tap-target spacing on the row strips.** _(done 2026-08-24 —
      see "Step 8c findings" below)_ Every icon-button strip gets ≥12px to its
      nearest neighbouring tap outcome, and strips right-align in column mode.
      Four sites, previously carrying three different values.
      - `ContextCard`: **Edit only** — Archive lands with Step 11.
      - `CollectionCard`: **Archive only** — the row click already opens
        collection detail, which auto-saves and is the edit surface.
      - `InboxCard`: move the existing **Archive** button to the collapsed row.
        Behaviour unchanged; the relabel to Delete and the hard delete are
        Step 10.
      - **Pin redundancy on Home** — both pinned sections or neither (Step 4a).
      - **Start Now's colour split** — `bg-success` on item detail vs
        `bg-primary` on intention detail (Step 5).
- [x] **Step 9a — Shared sort foundation, SAM consuming it.** _(done 2026-08-24
      — see "Step 9a findings" below)_ Split from Step 9 because the control has
      to exist before five Alfred pages can use it, and because this is the half
      that touches SAM.
      - **New** `src/utils/sortOrders.js` — `comparatorFor` generalised,
        `defaultDirectionFor` driven by a caller's option list, persistence
        helpers. 21 tests.
      - **New** `src/SortControl.jsx` — the extracted control plus
        `useSortPreference`.
      - `samSort.js` keeps its song-specific options and accessors, delegates
        the machinery. Its 26 tests pass **unchanged**.
      - `BrowseTabs` consumes the control and **gains persistence**.
- [x] **Step 9b — Apply to the five Alfred list pages.** _(done 2026-08-24 —
      see "Step 9b findings" below)_ Home → Today, Schedule,
      Inbox, Contexts, Collections, with the spec's documented options,
      defaults, and one local-storage key each.
      - **Schedule has no sort at all today** — a bare alias over an unordered
        `SELECT`. Confirm the new order is stable **across a reload**, not
        merely sorted once.
      - **Home → Today already sorts by time ascending**, deliberately, with a
        comment. Default the control to the same thing so day-one behaviour is
        unchanged.
- [ ] **Step 10 — Inbox delete.** Discard and successful triage both hard delete.
      Relabel to "Delete". Extend Undo to re-insert with the original id.
- [ ] **Step 11 — Context archive.** _(added 2026-08-24; blocked until the
      migration lands — write no SQL.)_ Split out of Step 5.
      - Archive permitted **only when the context is empty**: no items, no
        intentions, no events, no collections. Contexts are taxonomy, not
        content, so nothing cascades and restore brings back only the context.
        The shared-context problem largely dissolves — an empty shared context
        has nothing for the other person to lose.
      - Top-right Archive on Context detail, wired to the Undo message.
      - Recycle Bin gains a **Contexts** tab. Remember the `refreshData` gate:
        there IS a realtime channel on `contexts`, unlike `item_collections`,
        but the gate should still include it for consistency.
      - The no-op filter at [Alfred.jsx:4061](src/Alfred.jsx#L4061) becomes
        correct for free. **Leave it alone until then** — per Alex, 2026-08-24.

### Verification Steps

- [x] Context detail → Add Item → Archive does NOT create an item named "New Item"
- [x] Item detail → Related Intentions: typing then navigating away warns
- [x] Clicking a nested event inside an intention card fires one handler, not two
- [ ] Archiving an intention from a list leaves you on the list _(NOT YET TESTABLE —
      after Step 1's 0.2 fix there is no reachable list-row archive for intentions.
      Becomes exercisable at Step 8. The destination half was verified.)_
- [x] Clicking the logo with a dirty form shows Alfred's warning, not the browser's
- [x] Undo restores an archived record within 5 seconds
- [x] Clicking the right half of a ContextCard opens it
- [ ] All three collection row sites render identically apart from the pin and badge
- [x] Intention detail: Do Today works without entering edit mode and does not
      navigate away
- [ ] Recipe edit form: Save reachable without scrolling _(Step 7b — this is
      the original complaint from the screenshot that opened the phase, NOT a
      Revision 1 leftover to strike. See Step 7b findings.)_
- [ ] Every list row: Archive/Delete reachable in one click _(Contexts rows
      still pending — no `contexts.archived` column until Step 11)_
- [ ] Sort choice survives a page reload, independently per page
- [ ] Schedule's order is identical across two separate sessions _(proved in
      unit tests over all 120 permutations of a 5-row list; still worth the
      real two-session check)_
- [ ] Discarded inbox capture is gone from the database, not flagged
- [ ] Undo restores a deleted inbox capture with its original id

---

## Step 1 findings — the five defect repairs (2026-08-21)

**No SQL migration needed.** All five are client-side. Nothing touched the data layer,
any MCP tool schema, or any table.

### What changed

| Defect | File | Change |
|---|---|---|
| 0.1 | [Alfred.jsx:7966](src/Alfred.jsx#L7966) | `ItemCard`'s Archive wrapped in `{item.id && …}` |
| 0.2 | [:6620](src/Alfred.jsx#L6620), [:7058](src/Alfred.jsx#L7058), [:3699](src/Alfred.jsx#L3699) | New `onViewIntentionDetail` prop on `ItemDetailView`, passed to the Related-Intentions card as `onViewDetail`, wired in Alfred |
| 0.3 | [:9136](src/Alfred.jsx#L9136) | `e.stopPropagation()` on `EventCard`'s title region |
| 0.4 | [:1904](src/Alfred.jsx#L1904) | `archiveIntention`'s navigation gated on `view === "intention-detail"`, destination changed to `intentionReturnView` |
| 0.5 | [:3050](src/Alfred.jsx#L3050), [:3167](src/Alfred.jsx#L3167) | Both logos converted from raw `<a href="/">` to `<AppLink>` |

### Checks run

- Full suite — **13 suites, 245 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 262.61 kB gzip (**+22 B**)
- **CSS bundle hash unchanged** (`main.42a04503.css`) — confirms 0.5 changed no styling,
  which was the risk with the logo swap
- Routing tripwires: `setView(` **39** (unchanged), `guardedSetView(` 12 → **14** (+2 logos),
  `<AppLink` 9 → **11** (+2 logos), confirm blocks **3** (unchanged)

### Decisions

- **0.2 — `onViewDetail` only, not `onDirtyChange` as well.** The spec offered
  `onDirtyChange` as a fallback "if navigation is wrong for that context." It isn't —
  navigating matches the other two `IntentionCard` list sites. And once `onViewDetail`
  is present, `isEditing` can never become true at that site (`initialEditing` is
  false and the click no longer falls through), so `onDirtyChange` would be a prop
  that can never fire. Adding it would re-create exactly the dead-prop noise the
  survey flagged. The unguarded form is removed rather than guarded.
- **0.4 — gated on `view` rather than a new parameter.** `view` is derived from the
  URL, so it already reports which screen the click came from; a
  `archiveIntention(id, {navigateBack})` overload would have meant editing every
  `onArchive` call site to say something the app already knows. Kept `previousView`
  untouched — the Step 10 back-stack audit asked for **no new writers** to it, and
  this adds none.

### Surprises

- **0.1 was worse than "creates a phantom item."** The add-form path also called
  `setIsEditing(false)` unconditionally, so after creating the junk item the card
  flipped to display mode while the parent still had `showAddItemForm` true —
  rendering a half-dead form. Both symptoms come from the one missing guard and both
  are fixed by it.
- **0.3's `stopPropagation` is inert at four of `EventCard`'s five render sites.** Only
  the nested-in-`IntentionCard` site had an ancestor handler to stop. Worth knowing
  before Step 3 makes `EventCard` whole-card clickable — that change moves the handler
  to the root, and this `stopPropagation` has to move with it or the nested double-fire
  comes straight back.
- **0.5 needed no `inline-flex items-center`.** Step 7 of the routing work had to add
  that when converting `<button>` to `<a>`, because a button centres its own content
  via the UA stylesheet and an anchor does not. The logos were *already* anchors, so
  `AppLink` is a like-for-like swap. The unchanged CSS hash confirms it.
- **0.4 changes what "Archive" means on the intention detail page's edit form.** That
  form is reached via Edit Intention, so `view` is `intention-detail` and it still
  navigates — but now to `intentionReturnView` instead of `previousView`. Where you
  land after archiving from detail will differ from before in exactly the cases the
  spec called "often wrong."

### Two corrections to Part 0's text — flagged, not acted on

**1. 0.2 removes the only surface 0.4's list branch could fire from.**

`IntentionCard`'s Archive lives solely in its edit form, and edit mode is only
reachable when `onViewDetail` is absent. Tracing all four `onArchive={archiveIntention}`
sites:

| Site | `onViewDetail`? | Archive reachable? |
|---|---|---|
| Intentions list [:3855](src/Alfred.jsx#L3855) | yes | no — click navigates |
| Context detail [:6377](src/Alfred.jsx#L6377) | yes | no — click navigates |
| Intention detail edit [:6502](src/Alfred.jsx#L6502) | n/a (`isEditing`) | **yes**, `view === "intention-detail"` |
| Item detail → Related Intentions [:7067](src/Alfred.jsx#L7067) | **added by 0.2** | was yes, now no |

So the "list card" 0.4 describes was the Related-Intentions card — the same surface
0.2 converts to navigation. After both fixes the only reachable archive path is from
the detail page, where 0.4 still navigates (now to `intentionReturnView`).

**The non-navigating branch is therefore correct but currently dead.** It goes live at
Step 8, which puts Archive on every list row. Left in place deliberately: writing Step 8
against a handler that yanks the user off the list would reintroduce the defect.
Consequence for verification — 0.4's "stays on the list" half cannot be exercised
through the UI today; only its "correct destination from detail" half can.

**2. The nested-EventCard double-fire was never reproducible on the Intentions list.**

Part 0.3 says "reproducible today on the Intentions list and Context detail." The
Intentions list renders `intentionsWithoutActiveEvent`, which excludes any intent with
a non-archived event [:2977](src/Alfred.jsx#L2977), and passes `events={validEvents}` —
the same predicate `IntentionCard` filters `relatedEvents` with. The two predicates are
identical, so `relatedEvents` is always empty there and no nested `EventCard` can render.

Reachable only from **Context detail** (passes unfiltered `events`, no event-based
exclusion) and **Item detail → Related Intentions**. Does not change the fix.

---

## Step 2 findings — the Undo message (2026-08-22)

**No SQL migration needed.** Client-side only.

### What changed

| File | Change |
|---|---|
| [src/UndoMessage.jsx](src/UndoMessage.jsx) | **New.** `useUndo()` hook (single slot, timer, expiry) + `UndoMessage` component |
| [src/UndoMessage.test.jsx](src/UndoMessage.test.jsx) | **New.** 13 tests |
| [Alfred.jsx:798](src/Alfred.jsx#L798) | Hook mounted; `offerUndoFor` wraps restores in `withLoading` |
| [Alfred.jsx:4693](src/Alfred.jsx#L4693) | Capture bar re-parented into a shared bottom dock, message above it |
| [Alfred.jsx:1702](src/Alfred.jsx#L1702) | `archiveInboxItem` offers undo |
| [Alfred.jsx:1935](src/Alfred.jsx#L1935) | `archiveIntention` offers undo — intention **and** its cascaded events |
| [Alfred.jsx:2000](src/Alfred.jsx#L2000) | `updateItem` offers undo when `updates.archived === true` |
| [Alfred.jsx:2076](src/Alfred.jsx#L2076) | `updateEvent` likewise, and removes the recurrence successor |
| [Alfred.jsx:2181](src/Alfred.jsx#L2181) | `triggerRecurrence` now returns the event it created |

### Checks run

- Full suite — **14 suites, 258 tests, pass** (+1 suite, +13 tests)
- `CI=true npm run build` — **compiled successfully**, 263.42 kB gzip (+810 B)

### The design, and why it is a closure rather than a payload

The spec names two undo shapes. The app turns out to need three:

| Shape | Case | Restore |
|---|---|---|
| flip a flag back | archive | rewrite the record with `archived: false` |
| put the row back | hard delete (Step 10) | rewrite the whole row, id and all |
| compound | archive that cascades | several of the above **plus a delete** |

The third is not hypothetical: `archiveIntention` archives an intention *and* every
event hanging off it, and archiving a recurring event *creates* its successor — so
undoing that archive has to insert and delete in one go. A `{record, flag}` payload
covers only the first shape; `offerUndo(message, restore)` covers all three, and the
restore is written where the relevant state setters are already in scope.

**The "preserve the original id" requirement is already satisfied and needs no new
code.** `storage.set` UPDATEs by id and INSERTs only when that matched no rows — it is
an id-preserving upsert. So re-inserting a deleted row in Step 10 is the same one-line
call as any other write. This was the main thing worth knowing before Step 10.

### Positioning: structural, not arithmetic

The Capture bar's textarea grows to `50vh`, so any `bottom-N` offset on a separate
fixed element would be correct only while the capture box is one line tall. Instead
both now live in **one** bottom-anchored container, message first:

```
<div className="fixed bottom-0 left-0 right-0 z-20">
  <UndoMessage … />
  <div className="bg-white border-t …">  ← the Capture bar, classes unchanged
```

"Above the Capture bar" is now document order. Nothing to keep in sync.

### Surprises

- **Archiving a recurring event created a successor that undo would have orphaned.**
  `triggerRecurrence` fires on archive and writes a *new* event. Restoring the archived
  one without removing the successor leaves the intention with two live events — a
  worse state than before the undo. `triggerRecurrence` now returns what it created so
  the restore can delete it. It deletes rather than archives: the successor was never
  a real event the user saw, and an archived ghost would show up in the recycle bin as
  something they never scheduled.
- **`storage.set` was already an upsert.** Nobody has to build "re-insert preserving
  id" for Step 10.
- **The inbox restore closure is already Step-10-shaped.** `archiveInboxItem` removes
  the row from the array rather than flagging it in place, so undo already has to
  re-insert in `createdAt` order. When Step 10 swaps the archive for a delete, only the
  `storage.set` line's meaning changes; the closure does not.
- **`cancelExecutionForEvent` is a no-op on the event-archive path**, so undo does not
  need to restore an execution. `handleCancelEvent` refuses outright when any execution
  has `closed_at IS NULL`, and `activeExecutions`/`pausedExecutions` only ever hold
  such rows — so by the time it calls through, there is nothing left to find.
- **Two `window.confirm`s outside this step's scope, deliberately left.** The Recycle
  Bin's permanent-delete confirms ([:1270](src/Alfred.jsx#L1270),
  [:1348](src/Alfred.jsx#L1348)) guard the genuinely irreversible final step, *after* a
  record has already been archived. The recycle bin is itself the undo for those.
  **Confirmed by Alex 2026-08-22: these stay permanently.** "No confirmation dialogs"
  meant the normal flow, where archive is reversible and a dialog is friction for
  nothing. Recorded as exception 1 in the spec's Undo section so a later step does not
  remove them.

### RESOLVED — Delete Collection becomes a soft delete _(Alex, 2026-08-22)_

**The cascade is confirmed, not asserted.** An orphan check run in the Supabase SQL
editor during the collection-history work deleted a throwaway collection and found
zero orphans in either `collection_items` or `collection_item_removals`. So the code
comment at [:2863](src/Alfred.jsx#L2863) is accurate and my caveat below is closed.

That makes hard delete worse than the analysis below assumed:
`collection_item_removals` is an append-only history table built specifically as the
recovery path for accidental removals during shopping, and a full history view is
still to come. Option 1 (partial undo) is therefore rejected outright — it would
destroy the recovery path behind a button labelled Undo.

**Decision: option 2.** Collections become soft-deletable like every other Alfred
entity. `item_collections.archived boolean not null default false` **is already
applied**, with a column comment recording why hard delete is forbidden;
`check_platform_conformance` returned CONFORMANT across 16 tables. **No SQL is to be
written or re-run by this work.**

**Client-side work moved to Step 4**, whose scope above now carries it — Step 4 already
touches all three collection render sites, so splitting it across two steps would mean
editing them twice.

**Until Step 4, Delete Collection keeps its `window.confirm`. This is a known temporary
exception, not an oversight.** It is the one place in the app still guarded by a dialog
rather than by Undo, and it closes when `deleteCollection` becomes an archive.

The original analysis is kept below because the restorability table is what ruled out
the cheaper option.

### The analysis that led there

The spec asks for the `window.confirm` at [:4339](src/Alfred.jsx#L4339) to be replaced
with Undo. It is not, because **an Undo there would silently lose data.**

`deleteCollection` deletes one row from `item_collections`. Per the comment at
[:2863](src/Alfred.jsx#L2863), `collection_items` (membership) and
`collection_item_removals` (removal history) go with it via `ON DELETE CASCADE`. The
spec's "Delete undo re-inserts the row" is a single-row model — correct for inbox,
wrong here. Re-inserting the collection row alone gives back an **empty** collection
under a button that says Undo.

What could and could not be restored:

| | Restorable? | Notes |
|---|---|---|
| The collection row | **Yes**, id preserved | `storage.set` upsert |
| Membership | **Partly** | `collectionMembers[id]` is fully loaded on the detail page, so items/quantities/order survive — but `addMembers` generates fresh row ids and positions and resets `added_by`/`added_at`. No id-preserving path exists. |
| Removal history | **No** | The client holds at most a capped slice (5 for the panel, 50 for the history view) and only for the selected collection. There is no app-side way to put it back. |

Migration 005 is not in this repo, so the cascade is asserted by that code comment
rather than verified against the schema — the DB was unreachable this session
(`get_database_schema` → JWT expired). Worth confirming before deciding.

Three ways forward, none of which I should pick unilaterally:

1. **Accept a partial undo** — restore collection + members, tell the user the removal
   history is gone in the message. Cheapest; the button still lies a little.
2. **Soft-delete collections instead** — add `archived` to `item_collections` and treat
   it like every other entity, which makes undo a flag flip and nothing cascades. This
   is the consistent answer, but it needs a migration, so it is a stop-and-ask by the
   ground rules.
3. **Leave the confirm on this one action** and note the exception in the spec.

---

## Step 3 findings — card click consistency (2026-08-22)

**No SQL migration needed.** Two components, no new files. **No rows converted to
anchors** — detail routes still carry no record ids.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:6186](src/Alfred.jsx#L6186) | `ContextCard`'s `onClick` moved from the title block to the card root |
| [Alfred.jsx:9237](src/Alfred.jsx#L9237) | `EventCard`'s `onClick` moved to the card root, `stopPropagation` moved with it, `cursor-pointer` added |

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**
- Audited all six shared cards: every display-mode root now owns its click handler
  (`ItemCard`, `IntentionCard`, `ContextCard`, `EventCard`, `ExecutionBadge`,
  `InboxCard` collapsed). The three collection row sites were already root-clickable.

### The step's two bullets contradict each other — resolved in favour of the first

The spec asks for both "make `ContextCard` whole-card clickable" and "remove
`ContextCard`'s phantom `stopPropagation`". **Doing both produces a bug.**

The gear button is currently a *sibling* of the clickable title block, which is
exactly why its `stopPropagation` is phantom — there is no ancestor handler between it
and the card root. Moving the handler **to** the root makes the gear a **descendant**
of the clickable region, at which point the guard is the only thing preventing a click
on the gear from opening the context *and* the edit form. That is defect 0.3 rebuilt
by hand.

**The `stopPropagation` is kept**, with a comment recording that its premise flipped.
The spec's rationale — "it advertises a conflict that does not exist" — was accurate
only before this step's other half; the conflict now exists. Nothing else in the step
changes, and the removal is not deferred, it is cancelled: there is no later state in
which removing it is correct while the card stays root-clickable.

Spec sentence that is now stale: **"`ContextCard` has a `stopPropagation` on a sibling
element (~:6087), where there is nothing to stop … remove it."**

### Surprises

- **The prediction in Step 1's notes held.** That entry warned that Step 3 would move
  `EventCard`'s handler to the root and that the `stopPropagation` had to travel with
  it or the nested double-fire would return. It did, and it did.
- **`ContextCard` already looked clickable across its whole surface.** The root
  carried `cursor-pointer` and `hover:border-primary` while only the left column
  responded — so the card was actively lying about its hit area, not merely
  inconsistent. The fix makes the behaviour match the styling that was already there,
  which is why this half needed no CSS change at all.
- **`EventCard`'s Start / Continue buttons needed no edit.** Both already carried
  `stopPropagation` defensively while sitting outside the clickable region; moving the
  handler to the root silently promoted them to load-bearing. Same promotion as the
  `ContextCard` gear, but this one was already correct.
- **`EventCard` gained `cursor-pointer` on the root and lost it from the title.** The
  affordance had to cover the newly live area, otherwise the right half would be
  clickable while showing a text cursor. `hover:text-primary` stays on the title.
- **Deliberately not added: `hover:border-primary` on `EventCard`.** Every other
  whole-card-clickable card has it, so this is a real inconsistency left standing —
  but `EventCard` also renders *nested inside* `IntentionCard`, whose own
  `hover:border-primary` already fires when you hover the nested child. Adding a
  second highlight would light up two borders for one click target that resolves to
  the inner card. Left for the Step 8 row-action work, which touches this markup
  anyway and can settle nested-row styling as a whole.

---

## Step 4a findings — CollectionCard extracted (2026-08-24)

**No SQL. No behaviour change.** Pure refactor.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:6188](src/Alfred.jsx#L6188) | **New** `CollectionCard`, placed with the other shared cards |
| [Alfred.jsx:3531](src/Alfred.jsx#L3531) | Home → Pinned Collections consumes it |
| [Alfred.jsx:3999](src/Alfred.jsx#L3999) | Collections list consumes it |
| [Alfred.jsx:6535](src/Alfred.jsx#L6535) | Context detail → Collections consumes it |

Net **−2 B** gzip and **~90 lines removed** from the three call sites.

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 263.37 kB gzip (−2 B)
- **CSS bundle hash unchanged** (`main.dedbff16.css`) — no class string moved or
  differed, which is the strongest cheap evidence that a markup refactor is faithful
- Grepped for leftovers: no inline collection-row markup remains; the two surviving
  `membersOf(coll.id)` calls are in collection **detail** and **add-items**, which are
  different views

### Which differences were drift and which were adaptation

| Axis | Verdict | Resolution |
|---|---|---|
| Pin icon | **drift** | Home rendered it unconditionally; now `collection.pinned` everywhere |
| Member count | **drift** | Home/Collections used `membersOf`, Context detail inlined the same lookup only because `membersOf` is out of its scope. Component takes `memberCount`, so the shape stops mattering |
| Context badge | **adaptation** | `showContextBadge={false}` on Context detail — every row shares that context, so the chip repeats the heading |
| Click handler | **adaptation** | `onOpen`, since each site returns to a different screen |

### Surprises

- **Home's pin fix is invisible, exactly as the spec predicted.** `pinnedCollections`
  is `collections.filter((c) => c.pinned)`, so `collection.pinned` is true for every
  row it renders. Making it conditional changes no pixel today; it removes a landmine
  for whenever that section's filter changes.
- **`showPin` was added, then removed on review (Alex, 2026-08-24).** All three
  callers wanted the pin, so it was a never-varied prop — exactly the noise the survey
  flagged. The `collection.pinned` conditional is hardcoded in the component instead.
  The spec's "three props absorb all of it" is therefore two props plus `memberCount`.
- **`contexts` is passed rather than a precomputed `contextName`.** Every other card
  in this file (`ItemCard`, `IntentionCard`, `EventCard`) takes the `contexts` array
  and resolves the name itself, so following that removed the duplicated
  `contexts.find(...)` from both call sites instead of leaving it in two places.
  Context detail passes no `contexts` at all — the default `[]` is never read, because
  `showContextBadge` short-circuits first.
- **No test file added, deliberately.** `CollectionCard` is module-private like the
  other five shared cards; `AppLink` and `UndoMessage` have tests because they are
  separate exported modules. Exporting this one purely to test it would be a change
  beyond "pure refactor". If the card grows behaviour in Step 8, revisit.

### Resolved — the pin stays visible, and the prop goes _(Alex, 2026-08-24)_

Literal reading kept: the icon renders iff `collection.pinned`, so **no visible change
on Home**. Hiding it was rejected for a reason worth recording — Home's "Pinned
Contexts" section sits directly below "Pinned Collections" and shows a pin on every row
too, so suppressing one would leave two adjacent sections inconsistent. If that
redundancy is ever worth removing, both go together. Carried to **Step 8**.

`showPin` itself is deleted — see the surprise above.

---

## Step 4b findings — collection soft delete (2026-08-24)

**No SQL written.** The `archived` column was already applied and CONFORMANT.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:2913](src/Alfred.jsx#L2913) | New derived `activeCollections`; `pinnedCollections` now derives from it |
| [Alfred.jsx:2933](src/Alfred.jsx#L2933) | `deleteCollection` → **`archiveCollection`**, sets `archived: true`, offers Undo |
| [Alfred.jsx:4374](src/Alfred.jsx#L4374) | Button relabelled **"Archive Collection"**, `window.confirm` removed |
| [Alfred.jsx:2887](src/Alfred.jsx#L2887) | `addCollection` sets `archived: false` explicitly |
| [Alfred.jsx:1174](src/Alfred.jsx#L1174) | New `permanentDeleteWarning(tab, count)` |
| [Alfred.jsx:1246](src/Alfred.jsx#L1246) | `loadRecycleBin` gains a `collections` case |
| [:1290](src/Alfred.jsx#L1290), [:1390](src/Alfred.jsx#L1390) | Both restore paths map the tab **and** include it in the `refreshData` gate |
| [:1325](src/Alfred.jsx#L1325), [:1408](src/Alfred.jsx#L1408) | Both delete paths map the tab and use the new warning |
| [Alfred.jsx:4563](src/Alfred.jsx#L4563), [:4653](src/Alfred.jsx#L4653) | Collections tab + row title/subtitle |
| 7 prop sites | `collections={activeCollections}` |

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 263.58 kB gzip (−1 B)
- **CSS bundle hash unchanged** (`main.dedbff16.css`)
- `deleteCollection` references: **0**
- `window.confirm` sites: **5** → 3 unsaved-changes guards + 2 permanent-delete
  dialogs. **The destructive-action confirm is gone**; the two that remain are the
  kept exception.

### Where raw `collections` survives, and why

`activeCollections` goes to anything that offers a **choice**; raw `collections` stays
for anything that resolves an **id**, because an archived row must still resolve —
during the archive itself, and for Undo.

| Raw, on purpose | Reason |
|---|---|
| `updateCollection`, `archiveCollection` | `.find` by id; Undo needs the archived row |
| Collection detail / history / add-items | `.find` by `selectedCollectionId` |
| `ExecutionDetailView` | `.find` by `execution.collectionId` — an execution already running against a collection that gets archived must keep showing its name |
| Recycle Bin | reads archived rows from the database directly |

All seven `IntentionCard` sites, both `<select>` pickers (`InboxCard`, `IntentionCard`),
and all three list sites end up filtered — the four detail views forward the filtered
prop they receive, so only the seven top-level sites needed editing.

### The permanent-delete wording

`permanentDeleteWarning(tab, count)` produces, for collections:

> Permanently delete this collection? **Its item list and removal history will be
> destroyed.** This cannot be undone.

and for the other six tabs the two pre-existing strings **verbatim** — `count === null`
yields "this record" rather than counting to one, which is what the single-row path
said before. Checked all six combinations by hand.

### Surprises

- **The rename was the honest part.** `deleteCollection` no longer deletes, and a
  button reading "Delete Collection" that archives would be the same class of lie as
  the inbox's "Archive" that Part C is relabelling to "Delete". Both renamed.
- **Membership is no longer dropped from `collectionMembers` state.** The old delete
  cleared the cache entry because the rows were gone. A soft delete does not touch
  `collection_items`, so the cache stays correct and Undo has nothing to rebuild.
- **Archiving a collection mid-execution degrades gracefully, unchecked.**
  `EventCard` and `IntentionCard` both refuse to archive while an execution is open;
  collections have no such guard and I did not add one, because nothing breaks:
  `collectionMembers` is untouched, and `ExecutionDetailView` looks the collection up
  in raw `collections`, so a running shop keeps working. Flagged rather than guarded —
  if that should be blocked, it belongs with the other two guards, not here.
- **The `refreshData` gate was the real trap.** It is easy to read as a performance
  nicety. For collections it is correctness: there is **no realtime channel on
  `item_collections`** (six channels exist — inbox, contexts, items, intents, events,
  executions), so a restored collection would have stayed invisible until a manual
  refresh. Items and events would have self-healed; collections do not.
- **`loadCollectionMembers` still loads members for archived collections** on every
  `loadData` / `refreshData`, because it maps over the raw array. Mildly wasteful, and
  left alone deliberately — it is what makes an Undo or a Recycle Bin restore show the
  right item count immediately instead of after a second round trip.

---

## Step 5 findings — view page action bars (2026-08-24)

**Partial. No SQL written — and that is the finding.**

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:6916](src/Alfred.jsx#L6916) | Item detail: **Archive** added; bar becomes `flex-wrap justify-end` |
| [Alfred.jsx:6741](src/Alfred.jsx#L6741) | Intention detail: **Do Today · Start Now · Edit · Archive** bar |
| [Alfred.jsx:6690](src/Alfred.jsx#L6690) | `hasActiveExecutions` derived from the `executions` prop |
| [Alfred.jsx:2707](src/Alfred.jsx#L2707) | `saveContext` split into `saveContextRecord(existing, …)` + a page wrapper |
| [Alfred.jsx:6300](src/Alfred.jsx#L6300) | Context detail: renders `ContextForm` **in place** |
| — | `handleEditContextFromDetail` **deleted** |

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 263.91 kB gzip (+1 B)
- CSS bundle hash unchanged (`main.dedbff16.css`)
- `setView(` **39 → 38.** Deliberate: the only removed call is the
  `setView("contexts")` inside the deleted `handleEditContextFromDetail`, which
  *was* the dishonest navigation. Recording it because the routing thread tracks
  this number as a tripwire.

### BLOCKED — Context detail's Archive needs a migration

`contexts` has **no `archived` column.** Queried directly this session:

```
id · name · description · keywords · shared · pinned · user_id · tags
· updated_at · created_at
```

That is the whole table. Compare `item_collections`, which now carries
`archived boolean not null default false` with the comment from Step 4b's migration.

So Context detail's Archive, and the Recycle Bin Contexts tab that would pair with
it, are both blocked. Per the ground rules I stopped rather than writing SQL.

**A live bug falls out of the same fact.** [Alfred.jsx:4061](src/Alfred.jsx#L4061) —
the Collections page's context filter — reads:

```js
{contexts.filter((c) => !c.archived).map((ctx) => ( … ))}
```

`c.archived` is always `undefined` on a context, so `!undefined` is `true` and **the
filter has never excluded anything.** It is a no-op written against a column that was
never added. Harmless today precisely because contexts cannot be archived; it becomes
correct for free the moment the column exists. Left in place — changing it now would
only mean changing it back.

Deciding this needs three answers, and none of them are mine:

1. **Does archiving a context cascade?** A context owns items, intentions, events and
   collections. Archiving it while its children stay live means those children keep
   pointing at an invisible parent — and an item in an archived context vanishes from
   Contexts without appearing under Memories, which filters on `!i.contextId`. It
   would be orphaned from the UI entirely. That is a worse failure than having no
   Archive at all.
2. **What does the Recycle Bin restore?** Just the context, or the subtree?
3. **Shared contexts.** `contexts.shared` is the sharing mechanism between the two
   users, and the RLS on items, intents, events and executions is written against it.
   Archiving a shared context is a two-person action, not a one-person one.

### Intention detail — four of five, and why not five

Prop-passing for four; the fifth has nothing to relocate.

| Action | Cost |
|---|---|
| Edit | already there |
| Archive | `onArchiveIntention` already passed — only needed placing |
| Do Today | one new prop, `onSchedule={moveToPlanner}` |
| Start Now | one new prop, `onStartNow={startNowFromIntention}` |
| **Schedule Later** | **no behaviour exists anywhere to move** |

Schedule Later lives only inside `IntentionCard`'s **edit form**, where it toggles a
date input whose value is applied on Save. There is no committing "schedule later"
action in the app. Placing a button here would have meant either reproducing that
asymmetry on a brand-new surface — the exact thing the spec calls the root of the
"feels off" complaint — or building Step 6's popover early, which the step brief
forbade. **The slot is left for Step 6.**

Two behaviours inherited rather than introduced, both fixed by Step 6:

- **Do Today navigates you to Schedule.** `moveToPlanner` ends with
  `setView("schedule")` when the date is `"today"`. On a list that is merely abrupt;
  from a detail page it is worse. Step 6's "neither navigates" fixes it globally.
- **Do Today and Start Now are gated on `intentionEvents.length === 0`**, matching
  `IntentionCard`. Once something is scheduled, both disappear.

### Context detail — in place, and one small refactor

`saveContext` read `editingContext` — Alfred's *modal* slot — to decide update vs
create. Editing in place would have meant the detail page setting that slot first,
giving two sources of truth for "what am I editing". Instead the core became
`saveContextRecord(existing, …)` with the target passed in, and `saveContext` is now a
thin wrapper that binds `editingContext` and clears the modal state. One new call
site, one changed one.

`handleEditContextFromDetail` is deleted rather than deprecated. It was the whole bug:
set two pieces of state, then navigate to a different screen to render the form. The
Step 10 back-stack audit had already flagged it as the case where browser Back leaves
a modal open on a page that never asked for it — **that is now gone too**, incidentally.

### Surprises

- **`hasActiveExecutions` needed no database round trip here.** `IntentionCard` runs
  its own `supabase.from('executions')` query on mount to decide whether Archive is
  disabled, even though it receives an `executions` prop. Intention detail gets
  `allLiveExecutions` — active plus paused, exactly the set that query returns — so
  the guard is one `.some()`. The card's round trip now looks redundant; not touched,
  out of scope.
- **Start Now is `bg-success` on item detail and `bg-primary` on intention detail.**
  Pre-existing, inherited from the two surfaces this step copied from. Same verb, two
  colours. Not unified — this step is placement, and picking a winner is a palette
  decision. Worth settling in Step 8 alongside the row strips.

### OPEN QUESTION carried from Step 4b

**Should archiving a collection be blocked while an execution is running against it?**
`EventCard` and `IntentionCard` both refuse to archive with an open execution;
collections have no such guard. Nothing breaks today — membership is untouched and
`ExecutionDetailView` resolves from the raw array — so it degrades gracefully. Recorded
as a question, not a decision. If it should be blocked, it belongs with the other two
guards rather than bolted onto `archiveCollection`.

---

## Step 6 findings — Do Today / Schedule Later symmetry (2026-08-24)

**No SQL.** One new component, one behaviour removed from a shared function.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:8735](src/Alfred.jsx#L8735) | **New** `SchedulePopover` |
| [Alfred.jsx:1918](src/Alfred.jsx#L1918) | `moveToPlanner` no longer navigates; offers the message instead |
| [Alfred.jsx:9330](src/Alfred.jsx#L9330) | `IntentionCard` edit form: both buttons become popovers |
| [Alfred.jsx:6820](src/Alfred.jsx#L6820) | Intention detail: Step 5's empty slot filled |
| — | `showDatePicker` / `selectedDate` state **deleted**; commented-out `handleScheduleLater` **deleted** |

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 264.22 kB gzip (+1 B)
- `setView(` **38 → 37.** The one removal is `moveToPlanner`'s jump to the schedule.
  Recording it for the routing thread's tripwire; combined with Step 5's deletion the
  count is 37 against a slice-1 baseline of 39, both deliberate.
- `showDatePicker`, `selectedDate`, `handleScheduleLater` — **0 references each.**

### The blast radius of removing the navigation, checked before changing it

`moveToPlanner` had **six** entry points, not the two this step targets:

| Caller | Effect of losing the jump |
|---|---|
| `IntentionCard` edit form, via `updateIntent` | intended — this step |
| Intention detail | intended — this step |
| `IntentionCard` display mode (list rows) | you stay on the list you were working through, which is the spec's stated motivation |
| Intentions page add-form | form closes, you stay on Intentions |
| Context detail add-form | you stay in the context |
| Item detail add-form | you stay on the item |

All six improve. The three add-form paths were not in the step brief but were silently
teleporting you to Schedule after creating an intention — arguably the worst instance
of the behaviour, since you also lose the page you were building on.

One consequence worth knowing: **on the Intentions page, scheduling makes the row
disappear.** The list is `intentionsWithoutActiveEvent`, so an intention that now has
an event correctly drops out. Previously the navigation hid that; now you watch it go.
The message naming the date is what tells you it worked, which is exactly the job the
spec gave it.

### Design decisions

- **A confirm button, not commit-on-change.** The spec says "commit on selection,
  immediately". Taken literally against `<input type="date">` that would mean
  committing on the change event — which fires **per keystroke** during keyboard entry
  in several browsers, so typing `2026-09-01` would write `0002-09-01` on the way past.
  The popover commits on an explicit Schedule button (or Enter). "Immediately" is
  honoured in the sense that mattered: no separate Save step.
- **Both surfaces route through their own commit path.** In the edit form both
  popovers call `handleSave(date)`, so each still saves the form *and* schedules in one
  action — which is what the old Do Today did and the old Schedule Later did not.
  Intention detail has no form, so it calls `onSchedule` directly.
- **Undo deletes the event rather than archiving it.** It was created seconds ago and
  never seen; an archived ghost in the Recycle Bin would be a record of something that
  never happened. Same reasoning as Step 2's recurrence successor.
- **`placement` prop.** The edit-form footer opens **upward** — a downward popover
  there would open beneath the fixed Capture bar. The detail-page header opens
  downward.

### Surprises

- **My first comment on `moveToPlanner` broke the routing tripwire.** Writing the
  removed navigation call in prose put the literal call syntax back into the file and
  the grep count stayed at 38. The routing spec had already established the convention
  — its own bridge comment says so explicitly — and I rediscovered it the hard way.
  Comment reworded; count now correct.
- **The edit form's Do Today was never just "schedule".** It called `handleSave("today")`,
  which saves the intention *and* schedules it. Had the popover committed only the
  schedule, typed edits would have been silently dropped and the dirty guard would then
  have fired on the way out. Both popovers go through `handleSave` for this reason.
- **`Save Changes` got simpler for free.** It used to read
  `handleSave(showDatePicker && selectedDate ? selectedDate : null)` — Save doubling as
  the commit for a date the other button had merely revealed. With Schedule Later
  committing on its own, that collapses to `handleSave(null)`.

### Deliberately not changed

**List-row Do Today stays a single click.** `IntentionCard`'s display mode keeps its
one-click commit rather than becoming a popover. It is a quick action beside Start Now,
there is no Schedule Later next to it to be asymmetric with, and making the common case
two clicks on a row you are scanning past is a worse trade. It still picks up the rest
of the step: no navigation, and the date reported in the message.

**This does mean "Do Today" is one click on a list row and two on a detail page.** The
asymmetry the spec set out to kill was *commits vs. does not commit*, and that is gone
everywhere. If the click-count difference is itself unwanted, Step 8 owns row actions
and is the place to settle it.

### Recorded, not actioned _(Alex, 2026-08-24)_

- `IntentionCard` runs its own executions query despite receiving an `executions`
  prop — **Step 8**.
- Start Now is `bg-success` on item detail, `bg-primary` on intention detail —
  **Step 8**.
- Intention detail's archive-while-execution-running guard — **keep**.

---

## Step 7 findings — form footers (2026-08-24)

**No SQL.** Layout and ordering only.

### The date check — `formatEventDate` is fine, `getTodayDate` is not

Alex spotted "Monday, August 25" in the Step 6 write-up. **That was a typo in my
prose** — an invented example, not app output. `formatEventDate` is correct:

| Input | App renders | Independent UTC-parsed truth |
|---|---|---|
| `2026-08-24` | Today, August 24 | Monday, August 24 |
| `2026-08-25` | **Tuesday**, August 25 | Tuesday, August 25 |
| `2026-09-01` | Tuesday, September 1 | Tuesday, September 1 |
| `2026-12-31` | Thursday, December 31 | Thursday, December 31 |

It appends `T00:00:00` before parsing, which forces **local** interpretation. Without
that suffix a date-only string parses as UTC midnight — exactly the bug Alex described.
The guard is already there and works, including across month and year boundaries.

**But the check found the same bug class in `getTodayDate()`, in the opposite
direction.** [Alfred.jsx:325](src/Alfred.jsx#L325):

```js
return new Date().toISOString().split("T")[0];   // toISOString() is UTC
```

Measured on `America/Los_Angeles`, 24 Aug 2026:

| Local time | `getTodayDate()` | Message it produces |
|---|---|---|
| 09:30 | 2026-08-24 | "Today, August 24" |
| 16:30 | 2026-08-24 | "Today, August 24" |
| **17:30** | **2026-08-25** | **"Tuesday, August 25"** |
| 21:30 | 2026-08-25 | "Tuesday, August 25" |

From 17:00 PDT (16:00 PST) the app's idea of "today" is tomorrow. Consequences:

- **Do Today schedules for tomorrow**, and the message says so — visibly contradicting
  the button that was just pressed. Step 6 made this more prominent, since the popover
  pre-fills `getTodayDate()` and the message now names the date out loud.
- **Home's Today tab** filters `e.time <= getTodayDate()`, so it pulls in tomorrow.
- `startNowFromIntention` stamps the event with tomorrow's date.
- It **disagrees with `triggerRecurrence`**, which computes today from local `new Date()`
  with `setHours(0,0,0,0)`. So the file holds two different notions of "today" that
  agree until the evening and then diverge.

The fix is one line — build the string from `getFullYear`/`getMonth`/`getDate` instead
of `toISOString`. **Not applied.** It changes what "today" means for event membership
and recurrence anchoring, which deserves its own verification pass rather than riding
along in a footer-layout step. Logged as **Step 12**.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:9572](src/Alfred.jsx#L9572) | `EventCard`: Save · **Archive** · Close → Save · **Cancel** · gap · Archive Event |
| [Alfred.jsx:9407](src/Alfred.jsx#L9407) | `IntentionCard`: Archive gains `ml-auto` |
| [Alfred.jsx:6109](src/Alfred.jsx#L6109) | `ContextForm`: opt-in `stickyFooter` prop |
| [Alfred.jsx:3745](src/Alfred.jsx#L3745) | Contexts list passes `stickyFooter`; **context detail deliberately does not** |
| [Alfred.jsx:660](src/Alfred.jsx#L660) | `CollectionAddItems`: sticky footer |

`ItemCard` needed nothing — it was already Save · Cancel · Archive with `ml-auto`.
`InboxCard` needed nothing — `justify-between` already splits Archive to the right.

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 264.33 kB gzip (−1 B)
- All four card footers now push Archive right: ItemCard
  [:8374](src/Alfred.jsx#L8374), IntentionCard [:9407](src/Alfred.jsx#L9407),
  EventCard [:9632](src/Alfred.jsx#L9632), InboxCard via `justify-between`

### The Context form renders in two places, and they want different treatment

Alex flagged this and it is right. `stickyFooter` is **opt-in, defaulting to false**:

- **Contexts list** — the form *replaces* the list, so it owns the screen. Sticky.
- **Context detail** — the form is a panel with the context's items, intentions and
  collections below it. A pinned footer would hover over that content and read as
  belonging to whatever you had scrolled to. Not sticky.

Defaulting to false means a future third render site gets the safe behaviour and has
to ask for the other.

The offsets are `bottom-28 sm:bottom-32`, mirroring the main content wrapper's
`pb-28 sm:pb-32` — the space already reserved for the Capture bar. Same two numbers,
commented at both ends so they cannot drift apart silently.

### Does IntentionCard still wrap? Yes — measured, not assumed

Modelled at ~7.6px/char plus padding and gaps:

| Footer | Total | 375px | 414px | 768px |
|---|---|---|---|---|
| IntentionCard **before** Step 6 (6 controls) | 776px | 3 lines | 3 lines | 2 lines |
| IntentionCard **after** Step 6 (5 controls) | 629px | **3 lines** | 2 lines | 1 line |
| ItemCard | 289px | 1 line | 1 line | 1 line |
| EventCard | 335px | 2 lines | 1 line | 1 line |

So the spec's claim that moving Do Today and Schedule Later to a popover "fixes this"
is **half right**. It removes ~150px and drops the row from 2 lines to 1 on tablet —
the Surface, which is the primary device. On a 375px phone it still takes three lines.

**Left as is.** `flex-wrap` handles it, `ml-auto` still pushes Archive to the right of
whichever line it lands on, and the remaining five controls are all things the spec
wants present. Cutting further would mean removing an action, which is a scope
decision rather than a layout one. Worth an eye on the actual device during
verification — the model is an estimate, not a render.

### Surprise — one verification line cannot be met by the revised approach

The checklist carries **"Recipe edit form: Save reachable without scrolling."** A
recipe is an item with many elements, so that form is `ItemCard`'s edit mode — which
is an **in-place card edit**, and Revision 2 explicitly excludes those from sticky
footers ("two cards can be open at once and 'sticky to the viewport' is meaningless").

So the one form where "Save reachable without scrolling" genuinely bites is the one
the revised approach deliberately leaves inline. The line looks like a leftover from
Revision 1, written before the survey changed the approach. Flagging rather than
quietly ticking it or quietly changing the spec: either it should be struck, or
long in-place card edits need their own answer, which is not what this step built.

---

## Step 7b findings — sticky footers where a card is the page (2026-08-24)

**No SQL.** One prop on two components, passed at two sites.

### The correction this step encodes

Step 7 reported that the checklist line "Recipe edit form: Save reachable without
scrolling" could not be met, and suggested striking it as a Revision 1 leftover.
**Half right, and the wrong half was the conclusion** (Alex, 2026-08-24): that line is
the *original complaint* — the screenshot that opened this phase was a recipe edit form
with Save roughly 2,000px below the fold. Revision 2 excluded in-place card edits from
sticky footers and quietly dropped the problem it was written to solve.

The exclusion's reasoning is sound but narrower than its wording:

> "three of the five forms are in-place card edits inside a scrolling list, where two
> cards can be open at once and 'sticky to the viewport' is meaningless"

The load-bearing phrase is **inside a scrolling list**. Two sites render a card *alone
as the whole page*, exactly like the Contexts-list form:

| Site | What renders |
|---|---|
| [Alfred.jsx:7063](src/Alfred.jsx#L7063) | `ItemCard`, item detail edit mode |
| [Alfred.jsx:6824](src/Alfred.jsx#L6824) | `IntentionCard`, intention detail edit mode |

Both early-return from their detail view — a Back button and the card, nothing else.
No siblings, so no ambiguity about whose footer is pinned.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:7880](src/Alfred.jsx#L7880) | `ItemCard` gains `stickyFooter = false` |
| [Alfred.jsx:8364](src/Alfred.jsx#L8364) | `ItemCard` footer applies it |
| [Alfred.jsx:9077](src/Alfred.jsx#L9077) | `IntentionCard` gains `stickyFooter = false` |
| [Alfred.jsx:9383](src/Alfred.jsx#L9383) | `IntentionCard` footer applies it |
| [:7063](src/Alfred.jsx#L7063), [:6824](src/Alfred.jsx#L6824) | the two whole-page sites opt in |

Same offsets as Step 7's forms — `bottom-28 sm:bottom-32`, mirroring the main
wrapper's `pb-28 sm:pb-32`. Negative margins are `-mx-3 sm:-mx-4` here rather than
`-mx-4 sm:-mx-6`, because these cards pad `p-3 sm:p-4` where `ContextForm` pads
`p-4 sm:p-6`.

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 264.39 kB gzip (+2 B)
- **Verified the other seven card render sites did NOT opt in** — the two add-item /
  add-intention forms on Context detail, the add-intention form on Item detail, the
  add form on Intentions, and every list site. All keep the `false` default.

### Why `false` is the default, again

Same reasoning as `ContextForm`'s: the dangerous direction is a *new* render site
silently inheriting pinned behaviour it cannot support. Seven of nine card render
sites are inside lists, so the common case must be the safe one and the exception
must be written out loud at the call site.

### Surprise

**The add-intention and add-item forms are the interesting near-miss.** They render
one card, alone, at the top of a page — which sounds like the whole-page case. But
content *follows* them: Context detail's add-item form sits above that context's
Items, Intentions and Collections lists. That is the `ContextForm`-on-context-detail
situation from Step 7, and it gets the same answer — no pinning, because a pinned bar
would hover over content it has nothing to do with. The test is not "is this card
alone in its container" but "does this card own the rest of the screen".

---

## Step 7c findings — the local-date fix (2026-08-24)

**No SQL written.** A read-only query for Alex is at the end; it writes nothing.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:344](src/Alfred.jsx#L344) | **New** `toLocalDateString(date)` |
| [Alfred.jsx:351](src/Alfred.jsx#L351) | `getTodayDate` built from local fields |
| [Alfred.jsx:2312](src/Alfred.jsx#L2312) | `triggerRecurrence` uses the same helper |

`grep 'toISOString().split("T")[0]'` across `src/` now returns **nothing**. One helper,
so a third caller cannot reach for the broken idiom again.

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**

### `triggerRecurrence` coincided by luck, and was broken the other way

Alex asked whether it derives its date some other way that happens to agree. It does.

`calculateNextEventDate` returns a **local-midnight** Date — it normalises with
`ref.setHours(0,0,0,0)` and its helpers parse through `parseLocalDate`, which carries
its own comment about avoiding the UTC pitfall. So the *input* was always right.
The *output* then went through `toISOString().split("T")[0]`, which is only correct
west of Greenwich:

| Zone | local midnight 25 Aug, serialised the old way |
|---|---|
| America/Los_Angeles (−7) | 2026-08-25 ok |
| America/New_York (−4) | 2026-08-25 ok |
| UTC | 2026-08-25 ok |
| Europe/London (+1) | **2026-08-24** — off by one, backwards |
| Europe/Berlin (+2) | **2026-08-24** |
| Asia/Tokyo (+9) | **2026-08-24** |

So the file held the same bug twice, pointing in opposite directions:
`getTodayDate` shifted **forwards** in the evening in the Americas; `triggerRecurrence`
shifted **backwards** all day east of Greenwich. Both are now the one helper, and they
agree by construction rather than by luck.

### Every caller, and what changes

| Caller | Persists? | Change |
|---|---|---|
| `moveToPlanner` [:1932](src/Alfred.jsx#L1932) — `"today"` | **yes** → `events.time` | evening Do Today now writes today |
| `startNowFromItem` [:3081](src/Alfred.jsx#L3081) | **yes** → `events.time` | same |
| `startNowFromIntention` [:3147](src/Alfred.jsx#L3147) | **yes** → `events.time` | same |
| `triggerRecurrence` [:2312](src/Alfred.jsx#L2312) | **yes** → `events.time` | no change in Pacific; correct everywhere else now |
| `todayEvents` filter [:3028](src/Alfred.jsx#L3028) | no | **visible membership change — see below** |
| `SchedulePopover initialDate` ×2 [:6893](src/Alfred.jsx#L6893), [:9429](src/Alfred.jsx#L9429) | via commit | popover pre-fills today, not tomorrow |

### Home's Today tab will look emptier in the evening — and that is the fix working

The filter is `e.time <= getTodayDate()`. Before, from 16:00 Pacific it compared
against **tomorrow**, so every event scheduled for tomorrow appeared under "Today" for
the last eight hours of every day. After the fix it compares against today and they
drop out.

Two consequences worth expecting rather than being surprised by:

1. **The tab count falls in the evening** relative to what you are used to. That is
   tomorrow's work leaving a tab that never should have shown it.
2. **It no longer changes at 4pm.** Previously the tab's contents shifted at the UTC
   day boundary for no reason a user could see.

The filter is `<=`, not `==`, so genuinely overdue events still appear. Nothing that
belongs there leaves.

### Stored rows: 11 confirmed, and the count is a floor not a total

The persisting callers wrote the bad value into `events.time`, so this is inherited,
not merely displayed. Sampled two windows through the MCP `get_events` tool — the
oldest 50 rows and everything from 2026-07-01 — and looked for the signature
**`time` == the UTC date of `created_at` but ≠ its Pacific date**:

| Sample | Rows | Same local day (fine) | Other day (deliberate) | **Bug signature** |
|---|---|---|---|---|
| Oldest 50 | 50 | 27 | 13 | **10** |
| From 2026-07-01 | 17 | 12 | 4 | **1** |

The eleven:

```
mlhaho1e737rgtu5q32  stored 2026-02-11  created 2026-02-10 16:26 PT  "make Pasta Recipe is archived?"
mlhamzvstosrrdsvj7q  stored 2026-02-11  created 2026-02-10 16:30 PT  "Pasta Recipe"
mlhasfmv4srmgffppei  stored 2026-02-11  created 2026-02-10 16:34 PT  "Weekly Pasta Recipe update"
mlhauaujy9eyyp4mo5j  stored 2026-02-11  created 2026-02-10 16:36 PT  "Weekly Pasta Recipe update"
mlhb17oesth02xiated  stored 2026-02-11  created 2026-02-10 16:41 PT  "Weekly Pasta Recipe update"
mlzxxtswe27f9ngs6    stored 2026-02-24  created 2026-02-23 17:42 PT  "Chinese Stir-Fry"
mm2qbjjpk4vxu2fpceo  stored 2026-02-26  created 2026-02-25 16:32 PT  "Dental Recovery Painkiller Schedule"
mm5okow79ja4sdvn3lw  stored 2026-02-28  created 2026-02-27 18:07 PT  "Daily Medications"
mmbe2sr7vexk0bgjj4p  stored 2026-03-04  created 2026-03-03 17:59 PT  "Daily Medications"
mmbe0dkdbq1hft1ifvk  stored 2026-03-04  created 2026-03-03 17:58 PT  "Andes-Style Mint Ganache"
msl2eeswufy5ssvvco   stored 2026-08-09  created 2026-08-08 17:28 PT  "Ina Garten Tomato Feta Pasta Salad"
```

Every one falls after the local UTC-rollover boundary — 16:00 PST or 17:00 PDT — which
is exactly the predicted window and strong corroboration that these are the bug rather
than coincidence.

**Two honest limits on that number.**

1. **It is a sample.** `get_events` caps at 50 rows and orders by `time` ascending, so
   the two windows do not cover March–June. The real total is higher.
2. **The signature cannot separate the bug from a deliberate "schedule for tomorrow"
   made in the same evening window.** Both produce `time` = tomorrow. The five
   Feb-10 rows inside fifteen minutes of each other, and the recurring "Daily
   Medications" rows, read strongly as the bug; a one-off recipe scheduled for tomorrow
   at 5:30pm would look identical and be perfectly correct.

**Not corrected, and my recommendation is to leave them.** They are historical events,
mostly long archived; rewriting them means guessing which were deliberate, and a wrong
guess silently moves a real record. The fix stops new ones. If you want the full count
first, this read-only query gives it — **it writes nothing**:

```sql
select id, time, created_at,
       (created_at at time zone 'America/Los_Angeles')::date as created_local_date
from   events
where  time = (created_at at time zone 'UTC')::date
  and  time <> (created_at at time zone 'America/Los_Angeles')::date
order  by created_at;
```

---

## Step 7c closeout — the 11 stored rows (2026-08-24)

Two questions from Alex, both answered from data already in hand plus two read-only
tool calls. **Neither is bad news.**

### All 11 are archived. Zero live.

Re-queried `get_events` **without** `include_archived`, which filters
`archived = false`:

- `2026-02-10 → 2026-03-05` returns **[]**. All ten rows in that window are archived.
- `2026-08-01 → 2026-08-31` returns two live events, and neither is
  `msl2eeswufy5ssvvco`. The eleventh is archived too.

So none of them is showing on Schedule under the wrong day. They are history.

### No recurrence chain is anchored on any of them

`triggerRecurrence` computes its successor from **`today`**, not from the event it was
handed ([:2299](src/Alfred.jsx#L2299)); `archivedEvent` supplies only `itemIds`. So the
chain re-bases on the current date every time an event is archived, and a bad ancestor
cannot propagate.

The one date that *could* persist a cadence origin is `config.anchorDate`, used for
`interval > 1`. It is typed by hand in the Custom Recurrence dialog's "Anchor week of"
field ([:8620](src/Alfred.jsx#L8620)) and is never derived from an event row.

**Live corroboration.** "Daily Medications" (intent `mm5okiuii6ch3zu88r8`) owns **two**
of the eleven bad rows. Its current live successor `mt2xj5ih45813farcbo` is dated
`2026-08-22` from a trigger at `2026-08-21 05:32` Pacific — exactly right for a daily
cadence. The chain corrected itself despite bad ancestors.

**"Historical" is accurate.** Leaving them stands.

### Worth keeping verbatim, per Alex

> The file held the same bug twice, pointing in opposite directions: `getTodayDate`
> shifted **forwards** in the evening in the Americas; `triggerRecurrence`'s
> serialisation shifted **backwards** all day east of Greenwich. Both are now the one
> helper, and they agree by construction rather than by luck.

---

## Step 8a findings — event row strips (2026-08-24)

**No SQL.** Two components.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:9745](src/Alfred.jsx#L9745) | `EventCard`: row strip, **Start/Continue · Archive** |
| [Alfred.jsx:9715](src/Alfred.jsx#L9715) | `EventCard`: `hover:border-primary`, gated on `nested` |
| [Alfred.jsx:9616](src/Alfred.jsx#L9616) | `EventCard`: guard derived from the `executions` prop; per-row query **deleted** |
| [Alfred.jsx:9100](src/Alfred.jsx#L9100) | `IntentionCard`: same, per-card query **deleted** |
| [Alfred.jsx:6838](src/Alfred.jsx#L6838) | intention detail's edit-mode card now receives `executions` |
| spec | row table corrected; two new rules recorded |

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 264.49 kB gzip (+2 B)
- `from('executions')` in `Alfred.jsx`: **3 → 1**, and the survivor is
  `handleCancelEvent`'s at-the-moment-of-write check, kept on purpose
- All four `stopPropagation` sites in `EventCard` present: root (Step 3's), Continue,
  Start, and the new Archive

### The redundant queries were asking a question already answered

Both cards received an `executions` prop **and** ran their own query on mount:

| Card | Query | The prop already held |
|---|---|---|
| `EventCard` | `event_id = … AND closed_at IS NULL` | `execution` — the `.find()` two lines above |
| `IntentionCard` | `intent_id = … AND closed_at IS NULL` | `allLiveExecutions` = active + paused, both `closed_at` null |

Callers pass `allLiveExecutions`, which **is** the set those queries select. On Schedule
with N events that was N round trips to recompute a value already in memory.

`handleCancelEvent`'s check stays. It runs at the moment of the write to guard against
a stale client, which is a different job from deciding whether to grey a button out.

**One site had to be fixed before the swap was safe.** Audited all seven
`IntentionCard` render sites: six that pass `onArchive` also pass `executions`, but
intention detail's edit mode ([:6838](src/Alfred.jsx#L6838)) passed `onArchive` alone.
Deriving the guard from a prop that site never received would have silently read "no
executions" and left Archive **enabled mid-execution** — turning a performance cleanup
into a data bug. It now receives `executions`.

### The nested double-highlight, settled

`EventCard` gets `hover:border-primary` **except when `nested`**.

The problem deferred from Step 3: `IntentionCard`'s own `hover:border-primary` already
fires when you hover a nested child, so giving the child one too lights **two** borders
for a single click target that `stopPropagation` resolves to the inner card.

Suppressing the *parent's* highlight instead would need a `has-[…]` variant reaching
into a child's hover state. Tailwind is `^3.4.1` so that is available — but it is a
fragile selector to leave behind for one row type, and it inverts the usual direction
of CSS specificity. Gating on `nested`, a prop that already exists for exactly this
distinction, reaches the same outcome in one expression.

**The nested row loses no affordance**, because 8a is what makes that true: every
`EventCard` now carries always-visible Start/Continue and Archive buttons, so
interactivity is advertised by controls rather than by hover. That is also the
project's stated position — "row actions are always visible, never hover-revealed. The
primary device is a touchscreen; hover does not exist there."

### Decision — Archive is on the row AND still in the edit form

Governing rule 4 says a workflow action must not live **only** inside an edit form. It
is now on the row, so the rule is satisfied. I left the form's **Archive Event** in
place rather than removing it, because Step 7 standardized all four card footers as
*primary · Cancel · gap · Archive* and Alex verified that; stripping EventCard's would
make it the odd one out one step later. One line to remove if the duplication is
unwanted.

### Surprise

**The nested `EventCard` gets an Archive button too**, and that is new reach: from the
Intentions list or Context detail you can now archive an intention's scheduled event
without opening anything. Correct per the spec — the strip is "same order everywhere" —
but it is the one place 8a adds an action to a surface that previously had none,
rather than relocating one. Worth a look during verification.

---

## Step 8b findings — record-only rows and the visual sweep (2026-08-24)

**No SQL.** Three components plus one colour.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:6293](src/Alfred.jsx#L6293) | `CollectionCard` gains `onArchive` + an archive button |
| 3 sites | Home pinned, Collections list, Context detail all pass it |
| [Alfred.jsx:6420](src/Alfred.jsx#L6420) | `ContextDetailView` threads `onArchiveCollection` |
| [Alfred.jsx:5470](src/Alfred.jsx#L5470) | `InboxCard`: archive button on the **collapsed** row |
| [Alfred.jsx:7180](src/Alfred.jsx#L7180) | Item detail's Start Now: `bg-success` → `bg-primary` |

**`ContextCard` needed no change.** Its gear is already an always-visible,
right-aligned action, which is the whole of "Edit only". Archive arrives with Step 11.

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 264.54 kB gzip (+1 B)

### Decision — pin redundancy: keep both. Agreed, plus a concrete reason.

Alex's read was keep both, on the grounds that the pin would distinguish pinned from
unpinned if those sections ever showed mixed content. Agreed, and there is a second
argument that settles it independently of any future change:

**Hiding the pin on Home would mean re-introducing exactly the prop deleted in Step
4a.** `showPin` was removed on review because no caller varied it — it was
never-varied-prop noise. Adding it back so one of two adjacent sections can suppress
an icon would trade a real simplification for a cosmetic one, and would make
`CollectionCard` render differently in the one place it sits beside
`ContextCard`, which has no such switch.

The two sections stay consistent with each other and each card stays consistent with
itself across pages. Closed.

### Decision — Start Now is `bg-primary` everywhere

Audited every instance of the verb and its neighbours:

| Button | Fill | Where |
|---|---|---|
| Start Now | `bg-primary` | intention detail, `IntentionCard` row |
| Start Now | **`bg-success`** | item detail — the outlier |
| Start | `bg-primary` | `EventCard` row |
| Do Today | `bg-success` | everywhere |
| Complete | `bg-success` | execution screen |

Took **`bg-primary`**, for three reasons in ascending order of weight:

1. It was already 3 of 4 sites.
2. `EventCard`'s **Start** is literally the same action — create and open an execution
   — so the same verb on a row and on a detail page should not differ.
3. **`bg-success` is already spoken for.** It carries *Do Today* and *Complete*. On
   intention detail, Do Today sits two buttons from Start Now; giving them the same
   fill would erase the only visual difference between "schedule it for later today"
   and "begin it right now" — the two actions on that bar most easily confused.

That third point answers the "success reads as go" argument directly: it would, if
success were free. It is not.

### Reported, not fixed — the 8a tap-target check

Alex asked whether the nested Archive is cramped. Measured:

| Adjacent pair | Spacing |
|---|---|
| Start ↔ Archive | **8px** (`gap-2`) |
| Archive ↔ the card's own onClick area | **0px** |

Targets themselves are 44×44 and compliant. The **spacing is at Material's floor** —
8px is the documented minimum, not a comfortable value, and the neighbour is
destructive. On a touchscreen a thumb landing between Start and Archive is a coin flip.

**A second finding fell out of the same measurement.** Below the `sm` breakpoint the
row container is `flex flex-col sm:flex-row`, so the strip drops onto its own line
under the title and sits **left-aligned** — `justify-between` governs the vertical axis
in column mode and does nothing horizontally. So on a phone the "right-aligned action
strip" is not right-aligned. Pre-existing, but 8a made it visible by putting two
buttons there instead of one.

Both are one-line changes and neither was applied, per "say so and we'll space them":

- `gap-2` → `gap-3` on the strip (8px → 12px)
- add `self-end sm:self-auto` to the strip so it right-aligns in column mode too

### Surprise

**`ContextCard` was already compliant and needed nothing** — the one card in the set
that did. Worth noting because it means the "add a strip" work was really three
different jobs: `CollectionCard` gained a genuinely new action, `InboxCard` gained
reach to an existing one, and `ContextCard` gained nothing because its gear had been
the right shape all along. The spec's uniform row-table phrasing hid that.

---

## Step 8c findings — tap-target spacing (2026-08-24)

**No SQL.** Four class strings.

### The measurement found four sites carrying three values

Measured the gap between each icon button and its nearest neighbouring **tap outcome**
— which inside a fully-clickable card is often the row's own click, not another button:

| Site | Was | Neighbour | Why it collapsed |
|---|---|---|---|
| `EventCard` strip | **8px** | Start (a real 44px button) | `gap-2` — Material's floor |
| `InboxCard` collapsed | **8px** | the source icon | `gap-2`; that icon *looks* static but is card-click |
| `CollectionCard` | **0px** | the name/badge block | `justify-between`, no gap — generous until the name fills the width |
| `ContextCard` gear | **0px** | the name/description block | same shape, pre-existing |

All four now sit at **12px**.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:9812](src/Alfred.jsx#L9812) | `EventCard` strip: `gap-2` → `gap-3`, plus `self-end sm:self-auto` |
| [Alfred.jsx:5487](src/Alfred.jsx#L5487) | `InboxCard` archive: `ml-1` on top of the row's `gap-2` |
| [Alfred.jsx:6300](src/Alfred.jsx#L6300) | `CollectionCard` container: explicit `gap-3` |
| [Alfred.jsx:6205](src/Alfred.jsx#L6205) | `ContextCard` container: explicit `gap-3` |

### Checks run

- Full suite — **14 suites, 258 tests, pass**
- `CI=true npm run build` — **compiled successfully**

### Two shapes collapse, for different reasons

Worth separating, because the fix differs:

- **`flex items-center gap-2`** is *uniformly* 8px. It never gets worse, it is just at
  the floor. `gap-3` fixes it outright.
- **`flex items-center justify-between` with no gap** is *conditionally* 0px. On a wide
  row the free space is generous and the problem is invisible; it collapses only once
  the title grows to fill the width. That is the more dangerous of the two, because it
  passes casual inspection and fails on exactly the records with the longest names.
  An explicit `gap-3` sets a floor the collapse cannot cross.

### The column-mode bug was the more interesting half

Below the `sm` breakpoint `EventCard`'s row is `flex flex-col sm:flex-row`. In column
mode `justify-between` governs the **vertical** axis and does nothing horizontally, so
the strip sat **left-aligned** — the "right-aligned action strip" was right-aligned on
desktop only, and wrong on the touchscreen the whole spec is written for.

`self-end sm:self-auto` fixes it on the cross axis. Pre-existing since the card was
built, but invisible while the strip held one button; 8a's second button is what made
it legible.

### `ContextCard` was fixed despite being out of the stated scope

Alex scoped 8c to "the strips 8b added". `ContextCard` is neither — its gear predates
this phase and 8b touched it not at all. Including it anyway, because the brief's actual
instruction was **"fix them to match rather than leaving three different spacings"**,
and leaving the gear at 0px while its three neighbours moved to 12px would have
recreated exactly the inconsistency this step exists to remove — with the added trap
that the one left behind is the one nobody would think to check.

---

## Step 9a findings — shared sort foundation (2026-08-24)

**No SQL.** Two new modules, one rewired, one consumer.

### The SAM risk question, answered before building

Alex asked whether touching `BrowseTabs` endangers the daily piano practice flow.
**It does not, and the reasons are structural rather than hopeful:**

1. **`BrowseTabs` is a leaf.** `SongLoader` passes data down and callbacks up
   ([SongLoader.jsx:740](src/sam/components/SongLoader.jsx#L740)) and reads nothing back
   out of it. `onLoad`, `onEdit`, `onArchive`, `onRestore`, `onAddClick` pass straight
   through untouched.
2. **It is the song *selection* screen, not the practice flow.** Playback is
   `SamPlayer` / `ScoreRenderer` / the timing engine — none of which this step opens.
   The worst credible failure is "the song list mis-renders", not "practice breaks
   mid-session".
3. **It is the best-tested component in SAM** — 28 existing tests across three
   describes, all behavioural, all binding to accessible names rather than internals.

That third point set the actual constraint. The tests reach the control through
`getByLabelText(/sort by/i)` and `getByRole("button", { name: /^Sort (a|de)scending —
currently/ })`, so `SortControl` had to reproduce **both accessibility hooks exactly**
— the associated "Sort by" label, and a direction button whose `aria-label` names the
action *and* the current state. Those are load-bearing, not decoration, and are
commented as such in the new component.

### What changed

| File | Change |
|---|---|
| [src/utils/sortOrders.js](src/utils/sortOrders.js) | **New.** The promoted machinery |
| [src/utils/sortOrders.test.js](src/utils/sortOrders.test.js) | **New.** 21 tests |
| [src/SortControl.jsx](src/SortControl.jsx) | **New.** Control + `useSortPreference` |
| [src/sam/lib/samSort.js](src/sam/lib/samSort.js) | Keeps options + accessors; delegates the rest |
| [BrowseTabs.jsx](src/sam/components/BrowseTabs.jsx) | Consumes the control; gains persistence |
| [BrowseTabs.test.jsx](src/sam/components/BrowseTabs.test.jsx) | Storage hygiene + 4 persistence tests |

### Checks run

- Full suite — **15 suites, 283 tests, pass** (+1 suite, +25 tests)
- `CI=true npm run build` — **compiled successfully**, 264.89 kB gzip (−1 B)
- **`samSort.test.js`'s 26 tests pass completely unchanged**, which is the evidence
  that the promotion preserved behaviour rather than merely compiling

### The promotion was not a pure move

`comparatorFor` looked SAM-shaped on the surface and was SAM-shaped underneath:

```js
const field = key === "added" ? get.added : get.played;   // exactly two fields
```

That ternary allowed precisely two non-title orders — enough for SAM's three options,
useless for Inbox's four. It is now `get[key]`, which resolves identically for SAM's
keys and admits any number for everyone else.

`defaultDirectionFor` had the same shape: it read a module-level `SORT_OPTIONS`, so
"the natural direction for this field" was hardwired to SAM's list. It now takes the
option list as an argument, and `samSort` re-exports a one-argument version bound to
its own — so SAM's call sites did not change.

One consequence worth noting: because the shared comparator no longer defaults its own
direction, `sortSongs`/`sortFamilies` resolve `dir ?? defaultDirectionFor(key)`
themselves. That kept `sortSongs(songs, key)` working for the tests that call it with
two arguments.

### Five SAM tests failed, and they were right to

Adding persistence broke five existing `BrowseTabs` tests. **Not a logic error —
state leaking between test cases**, because jsdom's `localStorage` lives for the whole
file and those tests were written when the control reset on every mount.

Fixed with `beforeEach(() => window.localStorage.clear())` — standard hygiene for a
component that persists — and then **covered the new behaviour** rather than merely
accommodating it: four tests asserting that a chosen field and a flipped direction each
survive a remount, and that malformed or retired stored values fall back to the default.

Worth being explicit: the tests were changed because the *behaviour they asserted*
changed, by request. The five that failed were all of the form "after a fresh render
the order is the default", and a persisted preference is precisely the thing that makes
that untrue.

### If the Recent tab's persistence turns out to grate

Alex is judging this in daily use. **If it needs fixing, per-tab storage keys is the
likely answer rather than exempting Recent** — "New" implies an order the same way, so
carving out one tab would leave the same problem next door. Four keys under
`alfred.sort.sam.<tab>` would let Recent stay recency-ordered while All songs keeps
whatever you last chose.

### Behavioural change to expect in SAM

**The sort no longer resets.** `BrowseTabs` unmounts every time a song is opened, so
until now the control returned to "Last played" constantly. It now survives.

That is what was asked for, and it has one edge worth knowing: `samSort`'s
`DEFAULT_SORT` was chosen so that "switching this feature on changes NOTHING about how
any of the four tabs already looked" — Recent and Drills were already last-practiced
first. With persistence, sorting by Title once leaves the **Recent tab title-ordered
across sessions**, which sits oddly with that tab's name. Not a bug, and not something
to fix here; flagged because it is the one way persistence can make a tab look wrong.

### Surprise

**`comparatorFor` and `compareValues` had no external consumers at all.** The spec
describes `samSort` as exporting them, and it did — but grepping every import showed
only `SORT_OPTIONS`, `SORT_VALUES`, `DEFAULT_SORT`, `defaultDirectionFor`, `sortSongs`
and `sortFamilies` in use. So the two functions being promoted were module-private in
practice, which is why the move needed no compatibility shim and why `samSort`'s public
surface is byte-identical afterwards.

---

## Step 9b findings — the five Alfred list pages (2026-08-24)

**No SQL.** Every field was already on the client.

### The three questions, answered before building

**1. Home's three tabs → Today only.** Active and Paused render `ExecutionBadge`, come
from the database ordered `started_at` descending, and share none of the event fields
the options name. The control renders **inside the Today panel**, not above the tab
bar, so it cannot imply it governs the other two. Same reasoning that excluded those
tabs from the row strips in Step 8a, and the spec's row table has been corrected the
same way.

**2. Inbox's "Suggested date" — kept, but it is inert on today's data.** Queried the
live inbox: **all six rows have `suggested_event_date: null`**, and all six are
`ai_status: "not_started"` — the field is only ever populated by AI enrichment. So
today the option sorts every row into the missing-values bucket and collapses to the
title tiebreaker.

Kept anyway, for two reasons. It becomes meaningful the moment enrichment runs, and
hiding options based on runtime data would make the dropdown's contents change
underneath the user — a stored preference could then name an option that had vanished.
Worth knowing that until enrichment is used, choosing it looks like "sorted by name",
which is correct but surprising. **If enrichment stays unused, this option is worth
dropping.**

**3. Contexts — the control replaces the list sort, and leaves detail alone.** The
hardcoded `.sort(a.name.localeCompare(b.name))` at the Contexts *list* is gone; that
order is now this page's default. Context **detail**'s Items keeps its `updatedAt`
descending sort untouched.

The line is "list pages, not sub-lists inside detail pages", and it is worth stating
because detail pages hold **five** such sub-lists between them — Context detail's
Items, Intentions and Collections; Intention detail's Scheduled Events; Item detail's
Related Intentions. Adding a control to one invites all five, each with its own storage
key. Recorded in the spec.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:355](src/Alfred.jsx#L355) | Three option lists + two module-level accessor bags |
| [Alfred.jsx:896](src/Alfred.jsx#L896) | Five `useSortPreference` calls, one key each |
| [Alfred.jsx:3130](src/Alfred.jsx#L3130) | `sortedTodayEvents` / `sortedScheduleEvents`; Home's hardcoded sort removed |
| 5 render sites | `<SortControl>` on Home → Today, Schedule, Inbox, Contexts, Collections |
| [sortOrders.test.js](src/utils/sortOrders.test.js) | +6 tests on order stability |

### Checks run

- Full suite — **15 suites, 289 tests, pass**
- `CI=true npm run build` — **compiled successfully**
- Six storage keys, all distinct: `alfred.sort.{home,schedule,inbox,contexts,collections,sam}`

### Schedule's stability — proved, not asserted

Alex asked for stability across two *sessions*, not one sort within one session. Two
sessions differ precisely in **the order Postgres returned the rows in**, so the test
that matters is whether the output depends on the input order.

`sortRows` is now run over **all 120 permutations** of a five-event list, for four
different key/direction combinations, asserting a single distinct answer each time.
That is the property "stable across sessions" actually means, and it holds because
every comparator falls through to the title tiebreaker — without it, three events
sharing a date would tie, and `Array.prototype.sort`'s stability would preserve
whatever order they arrived in.

A real two-session check is still worth doing, because it also exercises the
persistence layer the unit tests stub out.

### Home → Today looks identical on day one

Its `.sort((a, b) => a.time.localeCompare(b.time))` and its "Sort by oldest date first"
comment are gone, replaced by `EVENT_SORT_OPTIONS`' default of **Scheduled date,
ascending** — the same order, now reachable as one of four rather than fixed.

### Surprise

**"Name" has to be the key `title` on every page, whether or not the page offers it.**
The shared comparator uses `get.title` as the tiebreaker for *every* order, so the name
accessor must live under that key even on a page whose dropdown never shows Name. That
is invisible from the spec's option table, which lists Name as one choice among four,
and it would be an easy thing for a later page to omit — the symptom would be a
`TypeError` inside the comparator rather than anything sort-shaped. Commented at the
option lists.

---

### Notes

- `updated_at` is maintained by a `set_updated_at` BEFORE UPDATE trigger on all six
  Alfred tables — confirmed by `pg_trigger` query, including `contexts` and
  `item_collections` which the survey could not verify. "Last modified" sort is
  trustworthy. Some client write paths send a stale `updated_at`; the trigger
  corrects it. Do not remove the trigger.
- Deleted inbox rows are captured by the `audit_row` AFTER DELETE trigger in
  `platform.audit_log`, so deletion is recoverable.
- MCP tool schemas are frozen per conversation. Do not change any tool schema.
- No SQL migrations are expected. If a step seems to need one, stop and ask.
- Detail routes do not carry record ids yet. That blocks middle-clickable rows and
  is why Step 3 stops short of converting rows to anchors.
