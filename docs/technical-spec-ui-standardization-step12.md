# Technical Spec Addendum: Step 12 — Remaining Action-Placement Gaps

Companion to `technical-spec-ui-standardization.md` (Revision 2). Everything here
came out of a review of the Alfred context's captured items after Steps 1–11.

Seven items. Two are unfinished rows in the original spec rather than new requests —
those are marked. The governing rules and the deferred list in the main spec still
apply unchanged.

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

**The snapshot question is settled — it was already answered by the code.**
Element-based executions snapshot the item's elements at start: `startExecution`
copies each element (`{ ...el }`), flattens it, stamps fresh completion fields, and
writes the result onto the execution row. Nothing re-reads the item afterwards, so a
mid-execution item edit does not propagate. That is the safe default this addendum
was hoping for, already in place and needing no work. Collection-based executions are
the opposite: they resolve live, with `onRefreshCollection` re-fetching on an
interval.

Two things remain to work out:

- **Where the edit happens.** Navigating away to item detail and back has to preserve
  the execution's in-progress state — which lives in `activeExecution` as a whole
  object rather than an id, so it is not reconstructible from a URL. Editing in place
  on the execution screen may be simpler than navigating.
- **What Edit means for a collection-based execution.** This is now the substantive
  open question. Such an execution may have no single underlying item to edit, and it
  already resolves live rather than from a snapshot — so the action either targets
  something else, or is absent in that case. Report what it should do before building.

Report on both before writing code.

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

---

## Success criteria

- IntentionCard list rows have an always-visible Archive, correctly guarded, absent
  from add and edit forms.
- The execution screen offers a way to edit the underlying item, with the snapshot
  question answered explicitly.
- A newly created item appears at the top of a list sorted by last modified.
- The collections saving indicator is gone, or replaced with something better.
- Nothing in the app chrome is teal without a recorded reason.
- Add-an-item opens a dedicated page, with Archive still absent in add mode.
- An inbox capture's text can be edited and saved without triaging it.

## Out of scope

Everything in the main spec's Deferred list still stands. Additionally, these were
reviewed and belong elsewhere:

- **CustomRecurrenceDialog wipes an intention's end date on reopen.** Live data loss,
  not a placement problem. Its own thread.
- The schema-snapshot / Docker gap, the jsonb → `text[]` tags migration, the daily
  planner, cross-context search, per-store collection tags, and Alfred.jsx test
  coverage — all separate workstreams.
