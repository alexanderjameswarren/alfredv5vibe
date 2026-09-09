# Technical Spec: Alfred UI Action Standardization

**Revision 2** — rewritten after the codebase survey. Revision 1 assumed things about
card markup and form layout that turned out to be wrong; the corrections are noted
inline where they matter.

## Overview

Alfred's action buttons are placed inconsistently: some sit at the top of a page,
some at the bottom, and several workflow actions are reachable only from inside an
edit form. This phase rationalizes placement, adds a shared sort control to the
list pages, corrects inbox disposal semantics, and fixes five defects the survey
turned up.

**No new verbs.** Every action placed here already exists somewhere in the app. Done,
Reschedule, and Enrich-from-collapsed-row are deferred.

## Governing rules

1. **Actions on the record** (Start, Clone, Edit, Archive) live at the **top right** of
   a view page.
2. **Actions on the form** (Save, Cancel) sit in a consistent bottom row, sticky where
   the layout permits.
3. **Archive is never more than one click away** and never sits behind a confirmation
   dialog or an overflow menu. Safety comes from a 5-second Undo message.
4. **Workflow actions never live only inside an edit form.** An action that changes a
   record's state rather than its content belongs on the view page.
5. **Actions look like actions.** Anything that performs an operation gets a visible
   border or fill. Anything that navigates is plain text or a plain icon. These are
   currently indistinguishable and will diverge further as the routing work lands.

## Decisions already made

- Row actions are always visible, never hover-revealed. The primary device is a
  touchscreen Surface; hover does not exist there.
- Sort preference is remembered per page in browser local storage. No database column.
- Overdue items sort normally rather than being grouped.
- Inbox captures are deleted; everything downstream of the inbox is archived.

---

## Part 0 — Defect repairs (do these first)

These are live bugs found during the survey. They are cheap, they touch the same code
this phase edits anyway, and two of them cause data loss.

### 0.1 Archive on a new-item form creates a phantom item

`ItemCard`'s Archive button (~:7935) has no guard on `item.id`. On Context detail's
"Add Item" form, clicking Archive calls `handleSaveNewItem(null, {archived: true})`,
which reaches `onAddItem(undefined, …)` and creates a real archived item named
"New Item".

`IntentionCard` guards this correctly at ~:8866 with `onArchive && intent.id`. Apply
the same guard to `ItemCard`. Archive should not render in add mode.

### 0.2 One edit path has no unsaved-changes guard

Item detail → Related Intentions renders `IntentionCard` at ~:7016 without
`onViewDetail` **or** `onDirtyChange`. Clicking that card opens inline edit rather
than navigating, and because `onDirtyChange` is missing, navigating away discards
typed changes with no warning. It is the only edit path in the app with no guard
behind it.

Pass `onViewDetail` so the card navigates like the other IntentionCard sites, which
resolves both halves. If navigation is wrong for that context, pass `onDirtyChange`
at minimum.

### 0.3 Nested cards double-fire

`IntentionCard` renders its related events as nested `EventCard`s inside its own
`onClick` div (~:8946–8968). `EventCard`'s title region has no `stopPropagation`, so
clicking a nested event's text fires both `EventCard`'s `setIsEditing(true)` and the
parent's handler. Reproducible today on the Intentions list and Context detail.

Add `stopPropagation` to `EventCard`'s clickable title region.

### 0.4 Archiving an intention navigates unexpectedly

`archiveIntention` (~:1903) ends with an unconditional
`setSelectedIntentionId(null); setView(previousView)`. Archiving from a list card
therefore moves you to another screen, and it reads `previousView` rather than
`intentionReturnView`, so the destination is often wrong.

Archive from a list row should leave you on the list. Only navigate when archiving
from the intention detail page, and use `intentionReturnView` when you do.

### 0.5 The logo bypasses the unsaved-changes guard

Both logo links (~:3039, ~:3146) are raw `<a href="/">` with no handler. A plain click
triggers a full page reload, skipping `confirmDiscardIfDirty()` entirely. Only the
browser's generic `beforeunload` dialog catches it.

Route the logo through `AppLink` like the nav tabs, so the guard applies and
middle-click still works.

---

## Part A — Action placement

### View pages

| Page | Top-right actions |
|---|---|
| Item detail | Start Now · Clone · Edit · Archive |
| Intention detail | Do Today · Schedule Later · Start Now · Edit · Archive |
| Context detail | Edit · Archive |

**Item detail** already has Start Now, Clone, and Edit correctly placed. It needs
Archive added.

**Intention detail** is the main correction. Today it offers only "Edit Intention."
Do Today and Start Now exist on the intention *card* but not on the detail page.

**Context detail** needs Archive, and it needs an honest Edit. Today "Edit Context"
sets modal state and then navigates you back to the Contexts list to render the form
there. It should edit in place. Note that there is currently no way to archive or
delete a context anywhere in the app.

### Fix "Schedule Later" while you are in there

The two buttons that sit side by side in the intention edit form are of opposite
kinds, which is the root of the "feels off" complaint:

- **Do Today** writes immediately, then navigates you to the Schedule page.
- **Schedule Later** writes nothing. It toggles a date input into view; the date is
  applied only when Save runs.

There is a commented-out `handleScheduleLater` at ~:8612 that is the immediate-write
version — someone started this and stopped. Make them symmetrical:

- Both open a small date popover. "Do Today" pre-fills today's date.
- Both commit on selection, immediately.
- **Neither navigates.** The current jump to the Schedule page on "Do Today" is
  disorienting when you are working through a list. Show the 5-second confirmation
  message instead, with the scheduled date in it.

### Edit forms

Revision 1 called for a sticky footer on every form. The survey shows that does not
work uniformly, for two reasons: the Capture bar is already permanently docked at the
bottom of every screen, and three of the five forms are in-place card edits inside a
scrolling list, where two cards can be open at once and "sticky to the viewport" is
meaningless.

Revised approach:

**Full-screen forms** (Context form, Collection add-items) get a sticky footer that
sits directly above the Capture bar.

**The test is: does this card own the rest of the screen?** _(reworded 2026-08-24 —
the original phrasing was "is it inside a scrolling list", which misleads.)_ Pin the
footer when nothing else renders below the form; leave it inline when anything does.

That draws the line in the right place, and "inside a scrolling list" did not:

- **Item detail and intention detail edit modes** render a Back button and one card,
  nothing else. They own the screen, so they pin — and item detail's is the long
  recipe form that opened this phase, with Save ~2,000px below the fold.
- **The add-item and add-intention forms** also render one card, alone, at the top of
  a page — so by the old wording they would pin. They must not: Context detail's
  add-item form sits above that context's Items, Intentions and Collections, and a
  pinned bar would hover over content it has nothing to do with. Same reason
  `ContextForm` pins on the Contexts list but not on context detail.

Sticky is therefore **opt-in, defaulting to inline**, at every card and form: seven of
nine card render sites sit inside lists, so the common case must be the safe one and
the exception must be written out loud at the call site.

**In-place card edits inside a list** (`ItemCard`, `IntentionCard`, `EventCard`,
`InboxCard`) keep their inline footer, but the footer is standardized:

- Order is always: primary action, then Cancel, then a gap, then Archive pushed right.
- `EventCard` currently renders Save · Archive · Close — Archive sits between the two.
  Fix to match.
- `IntentionCard`'s footer is a single wrapping row holding up to six controls and
  already wraps to two lines on mobile. Moving Do Today and Schedule Later to a date
  popover (above) removes two of them and fixes this.

### List rows

Every list row gets a right-aligned action strip, always visible, same order
everywhere.

| Page | Row actions |
|---|---|
| Home → **Today only** | Start / Continue · Archive |
| Schedule | Start / Continue · Archive |
| Inbox | Delete |
| Contexts | Edit · Archive |
| Collections | Archive |

_(Table corrected 2026-08-24; Revision 2 said "Home (all tabs)" and gave every row an
Edit. Both were wrong — see the two rules below.)_

**Home's Active and Paused tabs are excluded deliberately.** They render
`ExecutionBadge`, not event rows, and the strip does not map: the badge already *is*
the continue affordance, "Edit" means nothing for a running execution, and the nearest
thing to Archive is `closeExecution("cancelled")`, which **hard-deletes with no Undo**.
One stray tap on a touchscreen would destroy a running session. That action already
lives inside the execution screen beside Pause and Complete, which is the right place
for a destructive action on a running thing. **Do not give `ExecutionBadge` an action
strip.**

**Rule: a row action never duplicates the row click.** Where clicking the row already
lands on the edit surface, the strip carries no Edit button:

- **`EventCard`** — the row click opens its edit form.
- **`CollectionCard`** — the row click opens collection detail, which auto-saves on
  blur and has no Save button, so it genuinely *is* the collection's edit surface.
- **`ContextCard` keeps its gear.** The row opens context detail; the gear skips a
  step to the form. That is a shortcut, not a duplicate.

**"Add a row action strip" is not uniform work.** _(Recorded 2026-08-24 after
building it — the table above reads as one job repeated five times, and it is not.)_
Each row type needed something different, and a later reader should not assume
otherwise:

| Card | What the work actually was |
|---|---|
| `CollectionCard` | **Gained an action.** Archive did not exist on a collection row at all; the handler had to be threaded through `ContextDetailView` to reach the third render site. |
| `InboxCard` | **Gained reach to an existing action.** The collapsed row was a pure expand target — every action lived behind expansion. The same archive call now has two entry points. |
| `EventCard` | **Relocated an action.** Archive existed, but only inside the edit form, which governing rule 4 forbids. |
| `ContextCard` | **Nothing.** Its gear was already an always-visible, right-aligned action — the right shape all along. |

**Spacing is part of the strip, not a detail.** All icon-button strips keep **≥12px**
between the button and its nearest neighbouring tap outcome. 8px is Material's
documented floor rather than a comfortable value, and these buttons are destructive and
sit inside a fully-clickable card, so the neighbour is often the row's own click.
Two shapes both collapse below that without help:

- `flex items-center gap-2` — 8px, needs `gap-3`.
- `flex items-center justify-between` with no gap — generous on a wide row, **0px**
  once the title fills the width. Needs an explicit `gap-3` floor.

Strips inside a `flex-col sm:flex-row` row also need `self-end sm:self-auto`:
`justify-between` governs the vertical axis in column mode, so without it a
"right-aligned" strip is left-aligned on phones.

### Row click targets — deferred, deliberately

Revision 1 specified a stretched-link pattern so rows would be middle-clickable. **The
survey shows this cannot be built yet.** Detail screens have addresses, but *which
record* you are viewing lives in React state, not the URL — so a cold load of
`/item-detail` redirects to the parent list. A row-title anchor would open the wrong
screen in a new tab.

Until detail routes carry ids, rows stay `onClick` handlers. Action buttons remain
siblings using `stopPropagation`, which is what the working cards already do.

Two things to make consistent now, so the eventual conversion is mechanical:

- **Cards disagree about what "clickable" means.** `ItemCard`, `IntentionCard`, and
  `ExecutionBadge` respond to the whole surface. `ContextCard` and `EventCard` respond
  only to the title block, so clicking the right half of a ContextCard does nothing.
  Standardize on whole-card clickable.
- **`ContextCard`'s gear `stopPropagation` must be KEPT.** _(corrected 2026-08-24;
  Revision 2 said to remove it.)_ That instruction was written against the
  pre-standardization markup, where the gear was a **sibling** of the clickable title
  block and so had nothing to stop. Making the card root-clickable — the bullet above —
  turns the gear into a **descendant** of the clickable region, at which point the
  guard is the only thing stopping a gear click from opening the context *and* the edit
  form. Removing it now reintroduces defect 0.3 by hand. This is not a deferral: there
  is no later state in which removing it is correct while the card stays
  root-clickable. Same applies to `EventCard`'s Start/Continue buttons, which were
  already guarded defensively and are now load-bearing for the same reason.

### Execution screen

Keeps its bottom bar (`Cancel · Pause · Complete`) — correct as-is.

The checkbox and "Start" are genuinely different operations: the checkbox marks a step
done; Start marks the step you are currently on and shows elapsed time. That is
reasonable, but nothing in the UI says so. Add a tooltip or label to Start clarifying
it is a timer.

Note for a later phase, not this one: the checkbox is a `<span>`, not an
`<input type="checkbox">` — not focusable, not keyboard-operable, no accessible role.
There are three checkbox idioms in the file. Out of scope here.

---

## Part B — Standard list sort control

### What already exists

SAM's sort logic is already a standalone, dependency-free, tested module —
`src/sam/lib/samSort.js` with `samSort.test.js` beside it. It exports `comparatorFor`,
`compareValues`, and the direction-reset behaviour. The hard parts (total ordering,
tiebreakers, missing-value handling) are solved.

The *UI* is inline JSX in `BrowseTabs.jsx` (~:404–433), not a component.

### The job

**Accessible names are API, not decoration.** _(Recorded 2026-08-24 during the
extraction.)_ `BrowseTabs`' 28 tests reach the sort control through
`getByLabelText(/sort by/i)` and `getByRole("button", { name: /^Sort (a|de)scending —
currently/ })`. Extracting a component whose tests bind that way means the associated
label text and the `aria-label` are part of its contract: change either and the tests
fail, correctly, because a screen-reader user just lost the same information. Any
component pulled out of a tested surface should have its accessible names reproduced
first and restyled second.

1. Extract the dropdown + direction-arrow markup into a shared `<SortControl>` that
   takes its option list as a prop.
2. Promote `comparatorFor` out of `src/sam/lib/` to a shared location.
3. Leave SAM's song-specific option list and accessors where they are — those do not
   generalize. Have SAM consume the shared control.

Carry these conventions forward; they are documented at `samSort.js:8–18` and were
arrived at deliberately:

- Every comparator falls through to a title tiebreaker, so no two rows compare equal.
  Without it, sort stability makes results depend on incoming order.
- The tiebreaker stays A→Z regardless of direction, except when title is the sort key.
- Missing values sort last in both directions.

### Rule: list pages, not sub-lists inside detail pages

_(Stated as a rule rather than a one-off answer, 2026-08-25 — it governs every list
added from here on.)_ The control governs the five **list pages** below. It does
not go on sub-lists inside detail pages — Context detail alone holds three (Items,
Intentions, Collections), and Intention detail and Item detail one each. Those keep
their fixed orders: Context detail's Items stays `updatedAt` descending, the rest keep
arrival order. Giving five sub-lists their own controls and their own storage keys is a
separate decision, not a consequence of this one.

**Home's Today tab only.** Active and Paused render `ExecutionBadge`, are ordered
`started_at` descending by the database, and share none of these fields. The control is
rendered *inside* the Today panel rather than above the tab bar, so its scope is
visible. Same reasoning that excluded those two tabs from the row strips.

### Options per page

Show only applicable options; do not render disabled ones.

| Page | Options | Default |
|---|---|---|
| Home, Schedule | Scheduled date · Created · Last modified · Name | Scheduled date, ascending |
| Inbox | Created · Last modified · Suggested date · Name | Created, descending |
| Contexts | Name · Created · Last modified | Name, ascending |
| Collections | Name · Created · Last modified | Name, ascending |

The dropdown label must read **"Scheduled date"**, not "Date."

### Every accessor bag must supply `title`

Whether or not the page offers **Name** as an option. The shared comparator uses
`get.title` as the tiebreaker for *every* order — that is what makes each order total,
and it is the whole reason two rows sharing a date do not fall back to arrival order.

This is invisible from the option table above, which lists Name as one choice among
four, so a page offering only dates looks like it needs no title accessor. Omitting it
throws a `TypeError` **inside the comparator**, on the first sort, in a stack trace
that mentions nothing sort-shaped.

### Field mapping

The survey confirms every field needed is already in hand on the client. Alfred loads
each table with `select("*")`, so Home and Schedule rows carry the full event row —
`time`, `createdAt`, `updatedAt`, plus the looked-up intent object. No data-layer
changes are required.

- **Scheduled date** → `events.time` (a date, not a timestamp).
- **Created** → `created_at`. On Home and Schedule the row is an *event*, so this means
  when it was scheduled, not when the intention was conceived.
- **Last modified** → `updated_at`. Confirmed maintained by a `set_updated_at` BEFORE
  UPDATE trigger on all six Alfred tables, including `contexts` and `item_collections`
  (verified via `pg_trigger`; the survey could not confirm these two, but the trigger
  query did). Several client write paths spread the whole row and send a stale
  `updated_at`; the trigger overwrites it. Correct but fragile — do not remove it.
- **Suggested date** → `inbox.suggested_event_date`, which is `text`, not `date`. Values
  are `YYYY-MM-DD` and sort correctly as text, but nulls are common — sort nulls last.

### Fix Schedule's ordering

`allNonArchivedEvents` is a bare alias with no sort at all. Its render order is
whatever Postgres returned from an unordered `SELECT`, mutated by local appends — so
it is not merely "creation order," it is unstable across sessions and can reshuffle
after an edit. Applying the sort control fixes this by construction.

Note that Home's Today tab filters to `time <= today`, so **future events appear on
Schedule and not on Home**. The two lists differ in membership, not just order. Do not
"fix" this as part of the sort work — it is a product question, deferred below.

### Persistence

Local storage, one key per page (e.g. `alfred.sort.home`) holding field and direction.
Restore on mount; fall back to the page default if absent or malformed. SAM has no
persistence today and resets on every remount — give SAM the same treatment while the
shared control is being built.

---

## Part C — Inbox disposal semantics

### Current behaviour

The Archive button and a successful triage run byte-identical code: set
`archived = true` and `triaged_at = now()`. No inbox row is ever deleted. A discarded
capture and a triaged one are indistinguishable in the data, and archived captures are
unreachable from any UI — the recycle bin has no Inbox tab — so they accumulate
indefinitely.

### Target behaviour

The inbox is the gateway into Alfred. A capture that does not make it through never
happened; one that does has already become an item, intention, or event. Either way
the row has no further job.

- **Discard** → hard delete. Button relabelled from "Archive" to **"Delete"**.
- **Successful triage** → hard delete after the downstream records are created. Delete
  only on success; on failure leave the row intact.
- Both are captured by the existing `audit_row` AFTER DELETE trigger in
  `platform.audit_log`, so neither is unrecoverable.

### Filter mismatch

The React app filters the inbox on `archived` alone; the MCP `get_inbox` tool filters
on `archived = false` AND `triaged_at IS NULL`. These agree today only because the
client always writes both fields together. Once rows are deleted both filters become
redundant but harmless. **Do not change the MCP tool** — schemas are frozen per
conversation.

### Not in scope

Do not drop the `archived` or `triaged_at` columns, and do not purge existing archived
rows — they are the only record of past captures and need review first.

---

## Part D — Extract CollectionCard

Prerequisite for the routing work's slice 2, and a card-shape decision, so it belongs
here. The markup is copy-pasted at three sites and has drifted on four axes, with no
two identical:

| | Home pinned | Collections list | Context detail |
|---|---|---|---|
| Pin icon | always shown | conditional | conditional |
| Member count | `membersOf(id)` | `membersOf(id)` | inlined lookup |
| Context badge | yes | yes | absent |
| Click handler | inline | inline | callback prop |

Three props absorb all of it: `showPin`, `showContextBadge`, `onOpen`. The count lookup
unifies once the component takes `memberCount` directly.

**Home's unconditional Pin is drift, not adaptation** — every row in that section is
pinned, so the bug is invisible today. Make it conditional. The missing context badge
in Context detail *is* intentional (every row shares that context) and should stay a
prop.

---

## Undo

Archive and Delete both show a message at the bottom of the screen for 5 seconds with
an Undo action. It must sit above the Capture bar.

- **Archive undo** flips `archived` back to false.
- **Delete undo** re-inserts the row, so the full row is held in component state until
  the message expires. Preserve the original `id`.

No confirmation dialogs. The one existing `window.confirm` on Delete Collection
(~:4240) should be replaced with the same Undo pattern for consistency.

### Two recorded exceptions

**1. Recycle Bin permanent delete keeps its confirmations.** _(decided 2026-08-22)_
The two `window.confirm`s on permanent delete — single (~:1270) and bulk (~:1348) —
stay. "No confirmation dialogs" is about the normal flow, where archive is reversible
and a dialog is friction for nothing. Permanent delete is genuinely irreversible and
the Recycle Bin is itself the undo; there is nothing behind it. **Do not remove these
in a later step.**

**2. Collections become soft-deletable rather than getting a delete-undo.**
_(decided 2026-08-22)_ Hard-deleting a collection cascades to `collection_items` and
`collection_item_removals` — verified by an orphan check in the Supabase SQL editor
during the collection-history work, not merely asserted by the code comment.
`collection_item_removals` is an append-only history table built as the recovery path
for accidental removals during shopping, with a full history view still to come.
Destroying it behind a button labelled Undo is not acceptable.

`item_collections.archived boolean not null default false` **is already applied**, with
a column comment recording why hard delete is forbidden; `check_platform_conformance`
returned CONFORMANT across 16 tables. **No further SQL is to be written or re-run.**

The client-side work lands in **Step 4**, which touches the same three collection
render sites anyway. Until then Delete Collection keeps its `window.confirm` as a
known temporary exception.

---

## Success criteria

- All five Part 0 defects fixed and verified.
- Every view page has its record actions top-right, in the documented order.
- Archive (or Delete) reachable in one click from every list row and detail page.
- Do Today and Schedule Later behave symmetrically and neither navigates away.
- All list pages share one sort component with per-page persistence.
- Schedule has a deterministic order that survives a reload.
- Discarding an inbox capture removes the row from the database.
- No confirmation dialogs remain; Undo appears for 5 seconds.
- `CollectionCard` extracted, all three sites consuming it.

## Deferred

- **Row-title anchors / middle-clickable rows** — blocked on detail routes carrying
  record ids. Revisit with routing slice 2 or 3.
- **One-click Done** on Home/Schedule rows. Requires deciding whether it creates and
  immediately closes an execution, or marks the event complete with no session. A
  data-model decision.
- **Reschedule** on rows.
- **Enrich** from a collapsed inbox row.
- **Merging or differentiating Home's Today tab and Schedule** — they differ in
  membership as well as order, so this is a product decision, not a sort fix.
- **Accessible checkboxes** in the execution view; three checkbox idioms in one file.
- **Missing create buttons**: Memories has no "Add Memory"; Context detail has no
  "Add Collection" and its Collections section is not collapsible.
- **Purging historical archived inbox rows** and dropping the `archived` column.
- **Mobile drawer still uses buttons** while desktop nav uses anchors — belongs to the
  routing thread, but on a Surface the drawer is arguably the primary nav.
