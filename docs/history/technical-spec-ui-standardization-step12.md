# Technical Spec Addendum: Step 12 — Remaining Action-Placement Gaps

Companion to `technical-spec-ui-standardization.md` (Revision 2). Everything here
came out of a review of the Alfred context's captured items after Steps 1–11.

Nine items. Two are unfinished rows in the original spec rather than new requests —
those are marked. 12.8 and 12.9 were added later, both on 2026-09-09: 12.8 out of what
12.3 turned up, 12.9 out of what 12.2 turned up. The governing rules and the deferred
list in the main spec still apply unchanged.

Build order, fixed by Alex: **12.1, 12.3, 12.4, 12.5, 12.2, 12.6, 12.7, then 12.8 and
12.9.**

---

## 12.1 IntentionCard rows have no Archive — spec gap

**This is our omission, not a new request.**

The spec's row-action table listed Home, Schedule, Inbox, Contexts, and Collections.
It never listed the Intentions page or IntentionCard's list rows. So Step 8 gave
EventCard an always-visible Archive and left its sibling behind. IntentionCard's
Archive still lives only inside its edit form, which is exactly the governing rule 4
violation this phase set out to remove.

**Target:** IntentionCard display mode gets the same right-aligned strip EventCard
received in Step 8a.

Existing display-mode actions are Do Today and Start Now, both gated on the intention
having no events. Archive is not gated that way — an intention with events should
still be archivable, and `archiveIntention` already cascades to its events with a
compound Undo built in Step 2.

Archive **is** gated on there being no running execution, matching the guard on both
cards. Step 8a converted that guard from a per-card query to the `executions` prop.

**The invariant is "every site that passes `onArchive` also passes `executions`", and
it holds at 4 of 4.** An earlier draft of this addendum said "six of seven sites
receive `executions`"; that was wrong. Four of the seven receive it — the Intentions
list, Context detail's Intentions, Item detail's Related Intentions, and Intention
detail. The other three are add-forms that pass neither `onArchive` nor a saved
`intent.id`, and the Archive button renders under `onArchive && intent.id`, so the
fail-open guard is unreachable there. Nothing is currently wrong.

**Recheck the invariant after this step, do not assume it.** 12.1 changes precisely
which sites render Archive, which is the thing the invariant is about: any site given
a row strip must also be given `executions`.

Render sites to cover: the Intentions list, Context detail's Intentions, and Item
detail's Related Intentions — the three that already receive `executions` and pass
`onArchive`. Intention detail is the fourth such site but is the detail page, not a
row. The add-form sites must not get a strip — Step 1's defect 0.1 was precisely an
Archive rendering in add mode.

Apply Step 8c's spacing: 12px between adjacent controls, `self-end sm:self-auto` so
the strip right-aligns in column mode.

Per the rule settled in 8b, no Edit button — clicking the row already navigates to
the intention's detail page.

## 12.2 Execution screen has no way to edit the item — spec gap

**Also our omission.** The main spec's screen table gives the execution screen
"Edit underlying item" at top right. Step 5 covered item, intention, and context
detail; the execution screen was never revisited.

The practical case: you are cooking from a recipe, you change something, and there is
currently no way to record it without abandoning the execution.

**Target:** an Edit action on the execution detail screen that opens the underlying
item for editing and returns to the running execution afterwards.

**Scope settled 2026-09-09: this is a LINK, not an edit surface.** A link on the
execution screen that opens the underlying item already in edit mode, skipping the
extra tap on "Edit Item". That is the whole feature. No in-place editing, and no
"applies next time" note — a link that visibly navigates to an edit page leaves no
ambiguity about what it changed.

**The snapshot question is settled — it was already answered by the code.**
Element-based executions snapshot the item's elements at start: `startExecution`
copies each element (`{ ...el }`), flattens it, stamps fresh completion fields, and
writes the result onto the execution row. Nothing re-reads the item afterwards, so a
mid-execution item edit does not propagate. That is the safe default this addendum
was hoping for, already in place and needing no work. Collection-based executions are
the opposite: they resolve live, with `onRefreshCollection` re-fetching on an
interval.

### CORRECTION — executions DO carry their id in the URL

An earlier draft of this section said `activeExecution` "lives as a whole object
rather than an id, so it is not reconstructible from a URL." **That is false, and it
was the load-bearing premise of the question.**

Executions are the ONE detail view that carries its id in the URL, deliberately.
`executionPath(id)` produces `/schedule/execution/:id`, and `useExecutionRoute`
cold-loads it via `storage.get`. `detailStateMissing` exempts execution-detail for
exactly this reason. `viewPaths.js` states the intent outright: the other detail views
can afford to redirect to a parent on a cold load, but "an execution cannot afford
that: a chained notification links back to the execution it came from."

So the round trip was never blocked. What it costs is narrower and specific:

- `viewToPath("execution-detail")` is always the bare, **id-less**
  `/schedule/execution` — the view map is kept a bijection. Returning via `setView`
  renders the right screen under an address that has lost the id. **Return with
  `goToExecution`.**
- `previousView` is a single shared slot any navigation clobbers, which is why
  `intentionReturnView` exists. **The return trip needs its own slot.**
- Progress is durable either way: element and collection ticks both write to the
  execution row on every toggle, so navigating away cannot lose a partly-done
  checklist. Back landing correctly is convenience, not correctness.

### Decisions

- **Exactly one item, or no link.** `itemIds` is an array and `flattenElements` pulls
  in nested referenced items, so the underlying item is neither guaranteed to exist
  nor guaranteed to be singular. Rather than guess, the link is absent unless the
  answer is unambiguous.
- **Collection-based executions get no link.** They carry `itemIds: []` by
  construction and resolve live from the collection; there is no underlying item.
  Tappable collection rows are **12.9**, separate.

## 12.3 New items sort to the bottom

Captured as: a brand-new item lands at the end of the list instead of the top.

Context detail's Items sorts by `updatedAt` descending
([Alfred.jsx:4973](../src/Alfred.jsx#L4973)). A fresh row should
have `updated_at` equal to `created_at` via the column default, which would put it
first. If it lands last, something else is happening.

Candidates worth checking in order:

- `updated_at` is nullable, and the comparator sorts missing values last in both
  directions. A null on insert would produce exactly this symptom.
- The client's insert path may omit the column in a way that skips the default.
- The `set_updated_at` BEFORE UPDATE trigger does not fire on INSERT, so anything
  relying on it for new rows gets nothing.

Diagnose before fixing. If the answer is that new rows carry a null `updated_at`,
the fix is a default or a backfill, not a change to the sort — and a backfill would
be a migration, which is a stop-and-ask.

Check whether this affects intents, events, and collections too, since they share
the column shape.

## 12.4 Remove the saving indicator on collections

Collection detail auto-saves on blur with no Save button — that was the basis for
omitting an Edit action from CollectionCard rows in Step 8b. The saving indicator is
reported as unwanted.

Confirm what it currently communicates before removing it. If it is the only signal
that an auto-save happened, removing it leaves a silent write. The Undo message
pattern built in Step 2 is the established way to confirm something happened; a brief
message may be a better replacement than nothing.

## 12.5 The teal top

Captured as: "find out why alfred has a teal top."

Same class as the Start Now colour split settled in 8b. `bg-success` now carries a
specific meaning — Do Today and Complete — and a teal element in the app chrome
dilutes that. Identify what it is, whether it is deliberate, and either give it a
neutral colour or record why it stays.

## 12.6 Add-an-item should open a full page

Adding an item currently happens inline, with the rest of the list still visible
below. It should open a dedicated page like the edit screen.

This is the near-miss recorded in Step 7b. The add-forms render one card alone at the
top of a page, which looks like the whole-page case, but content follows them — so
they correctly did not take the sticky footer. Making them real pages resolves the
ambiguity rather than working around it, and lets them take the footer.

Sites: Context detail's Add Item, Context detail's Add Intention, Intentions' Add
Intention, Item detail's Create Intention.

Two things this must not break:

- **Defect 0.1.** Archive must not render in add mode. A full page makes the card
  look more like the edit screen, which is exactly the confusion that produced the
  phantom "New Item".
- **Detail routes carry no record ids.** A new page needs an address, and a cold load
  of it has to do something sensible. Check how `detailStateMissing` handles a route
  with no backing state before adding routes.

If this turns out to need routing work that belongs to the routing thread's slice 2
or 3, say so and stop rather than reaching into it.

## 12.7 Edit an inbox capture without triaging it

Captured as: sometimes a partial note is captured, and there is no way to correct or
extend it so Claude can enrich it properly. Today the only way to change a capture is
to triage it into something.

This is new behaviour rather than relocated behaviour — flagged because the rest of
this phase is placement work.

**Target:** the capture text is editable in the expanded inbox card, saved without
creating an item, intention, or event, and the row stays in the inbox.

Three constraints:

- **Do not touch the MCP tool schemas.** They are frozen. `update_inbox_item` writes
  the `ai_*` and `suggested_*` fields; this edits `captured_text`, which is a
  different column and needs no schema change.
- **Step 10's disposal rule.** A capture is deleted on successful triage. Editing is
  not triage — the row must survive, with `triaged_at` still null.
- **Re-enrichment.** If a capture was already enriched and its text then changes, the
  existing suggestions describe text that no longer exists. Decide whether editing
  clears `ai_status` back to `not_started`, leaves the stale suggestions, or prompts
  for re-enrichment. Clearing is the honest option; say what you chose.

## 12.8 — Intentions page parity

**Build after the existing seven.** Added 2026-09-09, after 12.3 showed the page had
nothing to observe a timestamp fix on.

The Intentions page was omitted from Step 9b's sort work the same way it was omitted
from Step 8's row-action table. Two gaps:

- **No sort control.** Options: Name, Created, Last modified. **No scheduled date** —
  the list is `intentionsWithoutActiveEvent`, so a scheduled intention drops out of it
  entirely and the field would be null on every row present. Default: **Last modified
  descending.**
- **`IntentionCard` renders no "last updated" line.** `ItemCard` does, at
  [Alfred.jsx:10151-10157](../src/Alfred.jsx#L10151-L10157) — a
  `text-xs text-muted-foreground mt-1 block` span below the description, combining an
  element count and `last updated: <Mon D, YYYY>` with a `·` separator. Add the
  timestamp half to IntentionCard's display mode, matching that format and placement.

### Inventory finding — it is not just Intentions

**Memories was missed the same way, and worse.** Checked as instructed, and the
suspicion behind the instruction was right: the spec's page inventory was never
complete.

| Page | Sort control | Underlying order |
|---|---|---|
| Home | yes (9b) | `EVENT_SORT_OPTIONS` |
| Schedule | yes (9b) | `EVENT_SORT_OPTIONS` |
| Inbox | yes (9b) | `INBOX_SORT_OPTIONS` |
| Contexts | yes (9b) | `NAMED_RECORD_SORT_OPTIONS` |
| Collections | yes (9b) | `NAMED_RECORD_SORT_OPTIONS` |
| **Intentions** | **none** | **none** — `intentionsWithoutActiveEvent` is a bare `.filter()` |
| **Memories** | **none** | **none** — `memoriesWithoutContext` is a bare `.filter()` |

Neither omitted page has a *hardcoded* order either, which is the part worth pausing
on. Context detail's Items at least sorted by `updatedAt` deliberately. These two
render in whatever order `loadData`'s `select("*")` returned, which carries no
`ORDER BY` — so the order is arbitrary and may change between sessions for reasons
nothing in the app controls. Step 9b's stated goal was that order be stable across
reloads; on these two pages it was never stable to begin with.

`memoriesWithoutContext` is `items.filter((i) => !i.contextId && !i.archived)` and
`intentionsWithoutActiveEvent` is a filter over `intents`. Both take
`NAMED_RECORD_ACCESSORS` unchanged — items and intents both have `createdAt` and
`updatedAt`, and `title` maps to `name` for items and would need `text` for intents,
so intents need a small accessor bag of their own.

**So 12.8 covers both pages**, not just Intentions. Two omissions of the same page
across two separate steps was the signal; a third page with the identical gap
confirms the inventory rather than the page was the problem.

Whether Memories also needs the "last updated" line is already answered: it renders
`ItemCard`, which has one.

---

## 12.9 — Tappable collection rows

**Added 2026-09-09, out of 12.2.** Collection rows inside an execution are the only
list rows in Alfred that are not tappable: the checkbox reacts, the quantity input
reacts, and the item name is plain text. Every other list in the app opens a detail
view on a row tap.

Deliberately NOT folded into 12.2, which is about an execution's single underlying
item. This is about the rows of a collection-based execution, which has none — a
different target, a different gesture, and a different execution type.

Watch the tap-target collision with the checkbox and the quantity field, which
already occupy the row. Step 8c's 12px spacing rule applies.

---

## Success criteria

- IntentionCard list rows have an always-visible Archive, correctly guarded, absent
  from add and edit forms.
- The execution screen links to its underlying item, opening it already in edit
  mode, and only when there is exactly one such item.
- Back from that item returns to the running execution, with its id intact in the URL.
- A newly created item appears at the top of a list sorted by last modified.
- The collections saving indicator is gone, or replaced with something better.
- Nothing in the app chrome is teal without a recorded reason.
- Add-an-item opens a dedicated page, with Archive still absent in add mode.
- An inbox capture's text can be edited and saved without triaging it.
- The Intentions and Memories pages each have a sort control, and their order is
  stable across a reload.
- IntentionCard shows a "last updated" line in display mode, matching ItemCard's.

## Out of scope

Everything in the main spec's Deferred list still stands. Additionally, these were
reviewed and belong elsewhere:

- **CustomRecurrenceDialog wipes an intention's end date on reopen.** Live data loss,
  not a placement problem. Its own thread.
- The schema-snapshot / Docker gap, the jsonb → `text[]` tags migration, the daily
  planner, cross-context search, per-store collection tags, and Alfred.jsx test
  coverage — all separate workstreams.
