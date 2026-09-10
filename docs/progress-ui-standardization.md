# Progress: Alfred UI Action Standardization

## Status: Steps 1–11 done. Step 12 now **eight** sub-items — 12.8 was added
2026-09-09 out of what 12.3 turned up. **12.1 verified** (all nine checks).
**12.3 verified for items**, and extended afterwards to the edit paths — see the
correction in "Step 12.3 fix". **12.2, 12.4, 12.4b, 12.5 and 12.6 verified** (12.6 including the scroll-position
check). **12.7 verified.** **12.8 done, awaiting verification** — sort controls on
Intentions and Memories, a "last updated" line on IntentionCard, and the page
inventory counted properly for the first time: **7 list pages, 7 controls**. Step 12
is nine sub-items. **12.9 is the only one left.**

Inbox purged by Alex 2026-08-25: **151 archived rows deleted, 10 live remain.** That
closes the gap Step 10 recorded — the count is now zero and the column is no longer
written.

Confirmations: only the Recycle Bin's two permanent-delete dialogs remain, kept
permanently by decision (spec Undo section, exception 1).

**Routing tripwire:** `setView(` is now **35**. It was 37 at Step 11's close, down
from 39 at slice-1 close; those two removals were deliberate — see Step 5 and Step 6
findings. The further 37→35 drop happened in the commits between Step 11 and Step 12
(the games and notification-chain work), **not** in this phase. Unexplained, and worth
a look by whoever owns the routing thread — Step 12.1 changed no routing at all.

Spec: `docs/technical-spec-ui-standardization.md` (Revision 2), plus
`docs/technical-spec-ui-standardization-step12.md` for Step 12. Both live in
`docs/` alongside this file — the phase is active, not history.

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
- [x] **Step 10 — Inbox delete.** _(done 2026-08-25 — see "Step 10 findings"
      below)_ Discard and successful triage both hard delete.
      Relabel to "Delete". Extend Undo to re-insert with the original id.
      **Open:** Inbox's default order flipped from oldest-first to newest-first
      in Step 9b. Alex is judging it in use; his lean is oldest-first — an inbox
      is a queue being drained, and newest-first buries the item that has waited
      longest. One line in `INBOX_SORT_OPTIONS`' default either way.
- [x] **Step 11 — Context archive.** _(done 2026-08-25 — see "Step 11 findings"
      below. `contexts.archived` applied by Alex; CONFORMANT across 16 tables.)_
      Split out of Step 5.
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

- [ ] **Step 12 — Remaining action-placement gaps.** _(spec:
      `docs/technical-spec-ui-standardization-step12.md`)_ Seven sub-items from a
      review of the Alfred context's captured items after Steps 1–11. Two are
      unfinished rows in the original spec rather than new requests (12.1, 12.2).
      Sequence fixed by Alex 2026-09-09: **12.1, then 12.3, then 12.4 and 12.5,
      then 12.2, 12.6 and 12.7.**
  - [x] **12.1 — IntentionCard rows have no Archive.** _(done 2026-09-09 — see
        "Step 12.1 findings" below)_ Spec gap, not a new request: Step 8 gave
        EventCard an always-visible Archive and left its sibling behind, so
        IntentionCard's Archive still lived only inside its edit form — the
        governing-rule-4 violation this phase exists to remove.
  - [x] **12.3 — New items sort to the bottom.** _(diagnosed and fixed 2026-09-09 —
        see "Step 12.3 findings" and "Step 12.3 fix" below)_ **All three suspects in
        the addendum were wrong.** `updated_at` is `timestamptz DEFAULT now()` on all
        six Alfred tables and no row anywhere is null (counts run by Alex: 375 items,
        133 intents, 126 events, 9 contexts, 4 collections, 4 inbox — zero nulls).
        **No migration.** The cause was client-side: `storage.set` inserted without
        `.select()`, so the database-assigned columns were never read back and state
        kept the incomplete object the caller had built.
  - [x] **12.4 — Remove the saving overlay from the shopping path.** _(done
        2026-09-09, **retargeted** — see "Step 12.4 findings" below)_ The first pass
        silenced collection detail's four settings toggles; those were never the
        complaint and **have been reverted**. The real target was the full-screen
        overlay when **removing an item from a collection** — mid-aisle, one-handed,
        once per item — plus Put back on the removal panel. Both are now quiet.
        **The overlay was load-bearing:** `pollPausedRef` includes `isLoading`, so
        removing `withLoading` would have silently dropped the guard that stops the
        five-second membership poll landing mid-write. Both now hold the poll off
        themselves via `memberWriteInFlight`, as `saveMemberQuantity` already did.
        Kept from the first pass: the error handling, a real bug on any screen.
        **Verified 2026-09-09** — no dim, and the removed row survived two poll ticks.
  - [x] **12.4b — Optimistic removal.** _(done 2026-09-09 — see "Step 12.4b findings"
        below)_ The overlay was gone but the wait was not: the row was still gated on
        a write plus three reloads. Remove and Put back now update state first and
        write after, matching `toggleExecutionElement`. The poll guard moved **before**
        the optimistic update, because going optimistic is what opens the window where
        local state and the database disagree — the blocking version never needed it as
        much as this one does. `memberWriteInFlight` being a counter rather than a flag
        is what makes rapid taps safe, and this is the first step where that mattered.
        Adding items was checked: there is no single-item add on the shopping path, so
        bulk add stays blocking unchanged.
  - [x] **12.5 — The teal top.** _(done and **verified** 2026-09-09 — see "Step 12.5
        findings" below)_ Not a component: `public/manifest.json`'s `theme_color` was
        `#a2d8c8`, a leftover from the pre-redesign palette that appears nowhere in
        `index.css`. It painted the browser/OS chrome above the page. Retired to
        `#ffffff`, matching the header's `bg-white`. **`index.html` disagreed with the
        manifest** — it said `#000000` — so the top was black in a tab and teal once
        installed. Both now say the same thing.
  - [x] **12.6 — Save reachable on a long add form.** _(done 2026-09-09 as the small
        fix — see "Step 12.6 findings" below)_ **The dedicated page is deferred to the
        routing thread**, and what shipped is `stickyFooter` at the four add sites.
        **Step 7b's objection was ours and it was wrong:** "a pinned bar would hover
        over content it has nothing to do with" describes `position: fixed`, and the
        footer uses `position: sticky`, which is constrained by its parent's box and
        releases at the card's bottom edge. Corrected in the spec at the rule itself,
        since the wrong version is why the original complaint survived Step 7b.
        Deferral reasons: the page buys an address nothing links to (ids in URLs is
        slice 2), costs four return-address writers the routing thread has explicitly
        asked us not to add, and introduces a defect-0.1 confusion risk the current
        layout does not have. **Held in reserve, not built:** hide the sibling lists
        while an add form is open, if a tall form still reads badly.
  - [x] **12.6b — Add Item and Add Intention are real pages.** _(done 2026-09-09 —
        see "Step 12.6b findings" below)_ The deferral above was overturned: Alex
        asked for real pages, and **the routing work turned out not to need slice 2
        after all.** Two pages across four entry points, with the entry point as a
        target in the URL — `/memories/new/context/:id`,
        `/intentions/new/item/:id` — following the execution-route precedent so the
        view map stays a bijection. It stayed cheap because `loadData` already holds
        every context and item in state, so a target is a `.find()` rather than a
        fetch; the execution route needed a loading hook only because closed
        executions are *not* in state. **No return-address slot** — `navigate(-1)`
        with a `state.fromApp` flag for the cold-load caveat, which is exactly what
        the routing thread asked new screens to do. `dataLoaded` is the cold-load
        guard and is load-bearing. The sticky footer from 12.6 stays and is now
        unambiguously correct, since the pages own the screen.
  - [x] **12.6c — Cold-load Back follows the target.** _(done 2026-09-09 — see "Step
        12.6c findings" below)_ Verification check 7 passed as built and was wrong as
        designed: a pasted targeted URL sent Back to the record type's list. It now
        goes to **the target** — the context, or the item — because the address
        already says where the link conceptually came from. Only the bare form falls
        back to the list. Cold-load only; in-app `navigate(-1)` is unchanged, and a
        target that no longer resolves still redirects to the list. **`fromApp` is
        not redundant but its job has narrowed:** all four entry points now land in
        the same place either way, so the flag no longer decides *where* — it decides
        *how* (popping restores scroll and leaves `previousView` alone) and covers a
        target-is-not-origin case that does not exist yet. Recorded for slice 3 with
        the convergence table, so collapsing the two is an informed call.
  - [x] **12.7 — Edit an inbox capture without triaging it.** _(done 2026-09-09 —
        see "Step 12.7 findings" below)_ Editable in the expanded card; writes
        `captured_text` only, row stays with `triaged_at` null, no MCP schema
        touched. **The open question is answered: clear — and clear more than the
        status.** `ai_status` goes back to `not_started` and the `suggested_*`
        fields are nulled with it, because `InboxCard` seeds its triage fields
        `suggestedIntentText || capturedText`, so a stale suggestion is what the
        form PROPOSES rather than a column nobody reads. Only fires when the text
        actually changed; re-enrich is one tap and reads the new text server-side.
        The card's dirty guard now covers an open editor — the capture text was the
        one field here that could be lost by navigating away.
  - [x] **12.7b — One Save, one Cancel.** _(done 2026-09-09 — see "Step 12.7b
        findings" below)_ 12.7 gave the editor its own Save and Cancel, 250px above
        the card's existing pair and identically labelled — **and the outcomes are
        not symmetrical**: the footer's Save files the capture and deletes the row.
        The editor now has no buttons; the capture text is another dirty field, and
        the one Save commits text first and then triages if a section is open. Save
        is no longer disabled on "nothing to triage", which was exactly the state a
        text-only edit left the card in. **Blur-commit was rejected** — collection
        detail's blur-saves have no side effects and this one clears an enrichment;
        a blur is not a decision. The reseed moved into the textarea's `onChange`,
        which removes the 12.7 race rather than relocating it. Footer audited too:
        order already matched Step 7, but Enrich was a second `bg-primary` next to
        Save (now secondary, per 8b) and the row was `gap-2` (now `gap-3`, per 8c).
  - [x] **12.7c — Context is a dropdown everywhere.** _(done 2026-09-09 — see "Step
        12.7c findings" below)_ The same inbox card had Context as a search
        typeahead on its Intention section and a dropdown on its Item section. Nine
        contexts: a search field hides the list rather than showing it. Converted
        both typeaheads — InboxCard's Intention section and `IntentionCard`, the
        latter covering four render sites at once. **Nothing was lost, checked
        first:** neither typeahead created contexts on the fly or filtered on
        anything but `name`, both already excluded archived, and the `.slice(0, 10)`
        cap never bound at nine. **Linked Item stays a typeahead** — 375 items
        against 9 contexts, so the split is a size judgement, now written at both
        fields. Bundle got 60 B smaller; the diff is mostly deletions.
  - [x] **12.2 — Execution screen links to its underlying item.** _(done 2026-09-09
        — see "Step 12.2 findings" below)_ Scoped down by Alex to **a link, not an
        edit surface**: it opens the item already in edit mode, skipping the tap on
        "Edit Item". **The addendum's premise was false and is corrected there:**
        executions DO carry their id in the URL, deliberately, so a chained
        notification can link back. The link shows only when there is **exactly one**
        underlying item — verified against the data, where 42 of 50 executions have
        one, 8 have none, and **none has more than one**. Back returns via a
        dedicated `executionEditReturn` slot holding an ID, and via `goToExecution`
        rather than `setView`, because `viewToPath("execution-detail")` is always the
        id-less path. Collection-based executions get no link.
  - [ ] **12.9 — Tappable collection rows.** _(added 2026-09-09, out of 12.2)_
        Collection rows inside an execution are the only list rows in Alfred that are
        not tappable — the checkbox and quantity react, the item name is plain text.
        Separate from 12.2 on purpose: different target, different gesture, different
        execution type. Mind the tap-target collision with the checkbox and quantity
        field; Step 8c's 12px rule applies.
  - [x] **12.8 — Intentions and Memories parity.** _(done 2026-09-09 — see "Step
        12.8 findings" below)_ Both pages get the shared `SortControl` with their own
        storage keys. **Intentions:** Name, Created, Last modified — no scheduled
        date, since the list excludes intentions that have events, so the field would
        be null on every row present. **Memories:** the same three, defaulting to
        Last modified descending — my call, because it is a list of items like
        Context detail's, and 12.3 established that a newly touched record is
        expected at the top; Name was the alternative for consistency with Contexts
        and Collections. Intentions needed **its own accessor bag**: `title` maps to
        `text`, not `name`, and reusing the named-record bag would have made every
        tiebreaker `undefined` — which fails silently back to array order rather than
        throwing. `IntentionCard` gained the "last updated" line it was the only
        record type to lack. **Inventory counted properly: 7 list pages, 7 controls**,
        with every uncontrolled list uncontrolled on purpose and the reason recorded.

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
- [x] Recipe edit form: Save reachable without scrolling _(confirmed by Alex
      2026-09-09. Step 7b — this is
      the original complaint from the screenshot that opened the phase, NOT a
      Revision 1 leftover to strike. See Step 7b findings.)_
- [x] Every list row: Archive/Delete reachable in one click _(confirmed by Alex
      2026-09-09; Contexts rows landed with Step 11's `contexts.archived`, and
      IntentionCard rows — the last gap — with Step 12.1)_
- [x] Sort choice survives a page reload, independently per page _(confirmed by
      Alex 2026-09-09)_
- [ ] Schedule's order is identical across two separate sessions _(proved in
      unit tests over all 120 permutations of a 5-row list; still worth the
      real two-session check)_
- [x] Discarded inbox capture is gone from the database, not flagged _(confirmed
      by Alex 2026-09-09)_
- [x] Undo restores a deleted inbox capture with its original id _(confirmed by
      Alex 2026-09-09)_
- [ ] Intentions list row: Archive is visible without opening the row _(12.1)_
- [ ] Context detail and Item detail intention rows: same _(12.1)_
- [ ] Archiving an intention that HAS events works from the row, and Undo brings
      back the intention and its events together _(12.1 — this is the case Do Today
      and Start Now are gated out of, and Archive deliberately is not)_
- [ ] Row Archive is disabled, greyed, and titled while that intention has a running
      execution _(12.1 — the fail-open guard)_
- [ ] No Archive appears on any add-intention form: Intentions, Context detail, Item
      detail _(12.1 — defect 0.1 regression check)_
- [ ] Tapping row Archive archives without also opening the intention's detail page
      _(12.1 — stopPropagation against the Step 3 whole-card click)_
- [x] Intentions list row: Archive visible, guarded, absent from add forms, no stray
      navigation _(12.1 — all nine checks confirmed by Alex 2026-09-09)_
- [ ] A brand-new item appears at the TOP of Context detail's Items, not the bottom,
      with no reload _(12.3)_
- [ ] The new row shows a "last updated" line immediately, like every other row
      _(12.3 — the same missing value surfacing twice; Alex's corroboration)_
- [ ] New context, collection, intention, event and inbox capture all land in the
      right place under "Last modified" _(12.3 — one cause, six record types)_
- [ ] Collections especially: it has no realtime channel, so the insert path is the
      only thing that can fix it _(12.3)_
- [ ] EDITING a record updates its "Last modified" immediately, without a reload
      _(12.3 — the `.select("id")` half of the fix)_
- [ ] Two rows sharing a timestamp order by name rather than arbitrarily _(12.3 —
      the title tiebreaker Context detail's inline comparator never had)_
- [ ] A second device still shows one row, not two, when the first creates a record
      _(12.3 — the realtime dedupe was deliberately left in place)_
- [x] A new item lands at the TOP of Context detail's Items with a "last updated"
      line, no reload _(12.3 — confirmed by Alex 2026-09-09)_
- [ ] Editing an ITEM, INTENTION, EVENT or COLLECTION updates its "Last modified"
      without a reload _(12.3 correction — this was claimed before it was true; only
      contexts worked. Check a non-context record specifically)_
- [x] Collection detail: removing an item does NOT dim the screen _(12.4 — verified
      by Alex 2026-09-09)_
- [x] Removal panel: Put back does not dim the screen either _(12.4 — verified)_
- [x] **A removed item stays removed for at least ten seconds** _(12.4 — verified
      through two poll ticks)_
- [ ] The row disappears IMMEDIATELY on tapping ✕, with no perceptible wait _(12.4b —
      the whole point; compare against ticking an item off in an execution, which is
      the pattern being matched)_
- [ ] **Remove three or four items in quick succession.** All disappear immediately,
      all stay gone, and none reappears when the others' writes land _(12.4b — the
      counter and the functional updates. This is the shopping case)_
- [ ] After rapid removals, wait fifteen seconds. The list still shows exactly what
      you left _(12.4b — the guard must have returned to zero cleanly, not been
      cleared early by an earlier write finishing)_
- [ ] Put back is likewise immediate, and the entry leaves "Recently removed" at the
      same moment the item rejoins the list _(12.4b — one write drives both)_
- [ ] Offline: tap ✕. The row goes, then comes BACK, with an error _(12.4b — the
      rollback. A row that stays gone offline is the failure this guards against)_
- [x] Offline: Put back. The row appears, then disappears again, with an error
      _(12.4b — verified by Alex 2026-09-09, along with the whole optimistic path)_
- [ ] Execution with one item: an "Edit item" link appears beside the title, and
      opens that item ALREADY IN EDIT MODE — no second tap _(12.2)_
- [ ] Back from there lands on the running execution, not Memories or Schedule
      _(12.2 — the dedicated return slot)_
- [ ] **After that Back, the URL still contains the execution id** _(12.2 — the
      silent trap. `setView` would render the right screen under `/schedule/execution`
      with no id; refresh from there and you get sent to Schedule. Refresh after
      returning: you should stay on the execution)_
- [ ] The partly-ticked checklist is exactly as you left it after the round trip
      _(12.2 — durable, but worth seeing)_
- [ ] Editing the item does NOT change the running checklist _(12.2 — the snapshot.
      This is intended: the edit applies to the next execution)_
- [ ] An execution with NO underlying item shows no link _(12.2 — e.g. "Water
      Plants". 8 of the 50 executions in history are like this)_
- [ ] A collection-based execution shows no link _(12.2 — decided; rows become
      tappable in 12.9)_
- [ ] From the edited item, tap through to a related item, then Back twice: the first
      Back returns to the edited item, the second to the execution _(12.2 — the
      itemId check against the existing itemHistoryStack)_
- [ ] Open the same item from Memories and press Back: it returns to Memories, not to
      an execution _(12.2 — the stale-slot guard)_
- [x] 12.2 verified end to end, including the post-Back refresh keeping the execution
      id in the URL _(Alex, 2026-09-09)_
- [ ] **On a phone, open Context detail → Add Item and add a dozen-plus elements.**
      Save stays pinned above the Capture bar the whole way down the form _(12.6 —
      this is the case the complaint came from, and the only one that tests it. A
      short form on desktop proves nothing)_
- [ ] Keep scrolling past the end of that form: the footer RELEASES at the card's
      bottom edge and does not hover over the Items list _(12.6 — the whole
      sticky-vs-fixed distinction in one observation. A bar still floating over the
      item rows would mean Step 7b was right and this change is wrong)_
- [ ] Same check on Context detail → Add Intention, Intentions → Add Intention, and
      Item detail → Create Intention _(12.6 — four sites, one prop)_
- [ ] Open BOTH add forms on Context detail at once: each footer pins only within its
      own card, and only one is ever visible _(12.6 — the two-open-cards objection is
      also a `fixed` problem, not a `sticky` one)_
- [ ] The two whole-page forms still behave as before — item detail and intention
      detail edit modes _(12.6 — they had the prop since 7b; nothing should change)_
- [ ] No Archive button on any add form _(12.6 — defect 0.1, unchanged by this fix
      but re-checked because the forms now look more finished)_
- [ ] All four Add buttons open a full page, not an inline form _(12.6b — Context
      detail's Add Item and Add Intention, Intentions' Add Intention, Item detail's
      Create Intention)_
- [ ] Each page's heading reads **"New Item"** or **"New Intention"**, with a
      subtitle naming the target _(12.6b — defect 0.1's visible half. The page now
      looks like the edit screen, so the heading is what distinguishes them)_
- [ ] **Browser Back works from each add page** and lands on the screen you came
      from _(12.6b — the whole point of making them real pages)_
- [ ] The page's own Back button does the same, and PROMPTS if you have typed
      something _(12.6b — `confirmDiscardIfDirty`)_
- [ ] Cancel discards without a second prompt _(12.6b — the card clears the dirty
      flag first; existing behaviour, matched deliberately)_
- [ ] Saving returns you to where you came from, with no discard prompt _(12.6b)_
- [ ] **Copy an add-page URL, paste it into a fresh tab.** It opens the form with the
      right context preselected _(12.6b — cold load, the reason these are addresses
      at all)_
- [x] From that pasted tab, Back stays inside Alfred rather than leaving it _(12.6b —
      verified by Alex 2026-09-09; the destination was wrong, which 12.6c fixes)_
- [ ] **Paste `/intentions/new/context/:id`, press Back: you land on THAT CONTEXT**,
      not on the Intentions list _(12.6c — the fix)_
- [ ] Same for `/memories/new/context/:id` → that context, and
      `/intentions/new/item/:id` → that item _(12.6c)_
- [ ] Paste a BARE `/intentions/new` or `/memories/new`, press Back: you land on the
      Intentions or Memories list _(12.6c — the bare form names no target, so the
      list is all there is)_
- [ ] Back off that target page goes Home _(12.6c — `previousView` keeps its
      cold-load default deliberately, rather than adding a `setPreviousView` writer.
      Landing back on the add form would be the bug)_
- [ ] Browser Back from the target page does NOT return to the add form _(12.6c —
      `replace`. An empty form behind the Back button is the failure)_
- [x] 12.6 verified end to end, including the scroll-position check _(Alex,
      2026-09-09)_
- [ ] Expand an inbox capture: a pencil sits beside the text, and tapping it opens a
      textarea _(12.7)_
- [ ] Edit the text and Save. **The row stays in the inbox** — it is not filed, and
      no item, intention or event is created _(12.7 — Step 10's disposal rule applies
      to triage, and this is not triage)_
- [ ] The new text is there after a page reload _(12.7 — it actually wrote)_
- [ ] **On an ENRICHED capture, edit the text and save: the badge returns to "Not
      enriched" and the suggestions are gone** _(12.7 — the answer to the open
      question)_
- [ ] **Then open the triage form below: it proposes the NEW text, not the old
      suggestion** _(12.7 — the half that fails silently. The columns can be cleared
      correctly while the form still shows stale values, because those fields are
      seeded once at mount)_
- [ ] Re-enrich after editing: the new suggestions describe the corrected text
      _(12.7 — `ai-enrich` reads `captured_text` server-side)_
- [ ] Open the editor, change nothing, save: an enriched capture KEEPS its
      enrichment _(12.7 — the clear is gated on the text actually changing)_
- [ ] Type in the editor, then click a nav tab: you get the unsaved-changes warning
      _(12.7 — this field was outside the guard until now)_
- [ ] Cancel restores the original text and does NOT warn _(12.7 — an explicit
      discard)_
- [ ] Saving an empty capture is refused _(12.7)_
- [ ] **Count the buttons in an expanded card: exactly one Save and one Cancel**
      _(12.7b — the fix. Two of each was the defect)_
- [ ] Edit the text with NO triage section open, press Save: the text saves and the
      row stays in the inbox _(12.7b — Save used to be disabled in this exact state)_
- [ ] Edit the text AND open a triage section, press Save once: the capture is filed
      using the CORRECTED text, and the row is deleted _(12.7b — text is written
      first, so one press does both in the right order)_
- [ ] While typing in the editor, watch the intention/item fields below: they follow
      the text as you type, until you edit one of them yourself — after which they
      stop following _(12.7b — the reseed moved here, which is what removes the
      window where the form could propose replaced text)_
- [ ] Cancel with the editor open discards the text edit along with everything else
      _(12.7b — one Cancel, whole card)_
- [ ] Enrich is no longer the same blue as Save _(12.7b — one primary per row)_
- [ ] The Enrich/Save/Cancel row has 12px gaps and wraps rather than crushing on a
      narrow phone _(12.7b — Step 8c)_
- [ ] Delete is still pushed to the right, away from Cancel _(12.7b — Step 7's order
      was already correct; check it survived the spacing change)_
- [ ] **Inbox card: Context is a dropdown on BOTH the Intention and Item sections**
      _(12.7c — the two-patterns-one-card defect, and the quickest thing to see)_
- [ ] Opening it shows all nine contexts without typing _(12.7c — the point)_
- [ ] "No context" is selectable and clears a previous choice _(12.7c — this replaces
      the typeahead's X button)_
- [ ] An archived context does NOT appear in the list _(12.7c — parity with the old
      filter, which excluded them too)_
- [ ] Same dropdown on: intention edit, the add-intention page, Context detail's
      intentions, Item detail's related intentions _(12.7c — one component, four
      render sites)_
- [ ] Item edit, the add-item page and Collection detail are unchanged _(12.7c —
      they were already dropdowns)_
- [ ] **Linked Item is STILL a typeahead** and still filters as you type _(12.7c —
      375 items; converting it would be the wrong kind of consistency)_
- [x] 12.7 verified end to end, including the context dropdowns _(Alex, 2026-09-09)_
- [ ] Intentions and Memories each show a sort control above the list _(12.8)_
- [ ] Intentions offers Name, Created, Last modified — and **no** scheduled date
      _(12.8 — the list excludes intentions that have events, so that field would be
      null on every row)_
- [ ] Both default to Last modified, newest first, on a fresh browser _(12.8)_
- [ ] **Choose a different order on Intentions, reload: it survives. Then check
      Memories still has its own** _(12.8 — seven pages, seven independent keys)_
- [ ] **Sort Intentions by Created, and check two intentions created in the same
      minute order by NAME rather than jumping about between reloads** _(12.8 — the
      title tiebreaker. Intentions have `text`, not `name`; a wrong accessor bag makes
      every tiebreaker undefined and the order silently reverts to arbitrary, which
      looks like nothing being wrong)_
- [ ] Each intention row shows a "last updated" line, matching ItemCard's format
      _(12.8 — an intention was the only record you could sort by Last modified but
      not see it)_
- [ ] Tag filtering still works on both pages, and the order holds within the
      filtered set _(12.8 — the filter now runs before the sort)_
- [ ] The Recycle Bin, Home's Active/Paused tabs and the detail-page sub-lists still
      have no control _(12.8 — deliberate, each with a reason recorded; their absence
      is not an eighth omission)_
- [ ] Paste an add URL for a context you have since deleted: it redirects to the list
      rather than opening a form pointed at nothing _(12.6b)_
- [ ] Paste a malformed one — `/memories/new/context` or `/memories/new/nonsense/x` —
      and it redirects to home _(12.6b — not an address, rather than a bad target)_
- [ ] **Refresh an add page with a valid target.** It stays put and does NOT bounce to
      the list _(12.6b — the `dataLoaded` guard. Without it a cold load judges the
      target missing before the data arrives, and this is the check that catches it)_
- [ ] Add Intention from Item detail still pre-fills the intention text with the
      item's name _(12.6b — the inline form did this; it was kept)_
- [ ] Saving actually creates the record in the right context _(12.6b — all four
      entry points)_
- [ ] Execution checklist: ticking an item off still does not dim the screen _(12.4 —
      it never did; this confirms nothing regressed)_
- [ ] Quantity edits, in both the execution view and collection detail, stay quiet
      _(12.4 — already correct before this step)_
- [ ] Collection detail settings — Context, Shared, Pinned, Capture-target — DO still
      show the overlay _(12.4 — deliberately reverted; their absence would mean the
      revert did not land)_
- [ ] A FAILED collection save says so and re-reads _(12.4 — the error-handling fix,
      kept from the first pass. Go offline, toggle a setting)_
- [ ] Completing an execution with items ticked still shows "Completing..." _(12.4 —
      deliberately left blocking; once per shop, not once per item)_
- [x] Installed PWA: chrome above the header is white, not teal _(12.5 — verified by
      Alex 2026-09-09, after a reinstall with site data cleared)_

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

## Step 10 findings — inbox hard delete (2026-08-25)

**No SQL.** No MCP tool touched. `archived` and `triaged_at` still exist and are
still not dropped.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:1866](src/Alfred.jsx#L1866) | `archiveInboxItem` → **`deleteInboxItem`**; hard delete, Undo re-inserts |
| [Alfred.jsx:1896](src/Alfred.jsx#L1896) | `handleInboxSave` tracks write success |
| [Alfred.jsx:2035](src/Alfred.jsx#L2035) | Triage disposes only on success; no Undo there |
| [Alfred.jsx:5510](src/Alfred.jsx#L5510) | `InboxCard`'s `onArchive` prop → `onDelete` |
| [:5737](src/Alfred.jsx#L5737), [:6385](src/Alfred.jsx#L6385) | Both buttons relabelled **Delete**, `Archive` icon → `Trash2` |

### Checks run

- Full suite — **15 suites, 289 tests, pass**
- `CI=true npm run build` — **compiled successfully**
- `git diff -- supabase/` — **empty**, so no MCP schema moved
- Nothing writes `archived: true` or a `triagedAt` timestamp to `inbox` any more; the
  only surviving reference is the `triagedAt: null` stamped at capture time

### Check 1 — the Step 2 restore closure still holds. Confirmed, unchanged.

Step 2 predicted this closure would need no edit at Step 10. Eight steps later it
needed none:

```js
offerUndoFor("Capture deleted.", async () => {
  await storage.set(`inbox:${inboxItem.id}`, inboxItem);   // ← unchanged
  setInboxItems((prev) => [...].sort(byCreatedAt));
});
```

`storage.set` still UPDATEs by id and INSERTs only when that matches nothing
([:118](src/Alfred.jsx#L118)), so re-inserting a deleted row keeps its original id for
free. Swapping the archive for a delete changed *what the closure reverses*, not how.

One part of Step 2's reasoning **has expired**, though: it called the `createdAt`
re-sort "load-bearing". It no longer is — Step 9b made the inbox's display order a
function of the sort preference rather than of array order. Kept anyway so
`inboxItems` stays in a canonical order, but the comment is corrected in place so it
does not mislead later.

### Check 2 — the archived rows: reachable by nothing, and I cannot count them

**Nothing can reach them.** Three consumers, three exclusions:

| Consumer | What it does with an archived inbox row |
|---|---|
| React client | `select("*")` then `.filter(item => !item.archived)` in JS ([:1198](src/Alfred.jsx#L1198), [:1249](src/Alfred.jsx#L1249)) — **fetched into the browser on every load and every refresh, then discarded** |
| Recycle Bin | seven tabs, none of them Inbox |
| MCP `get_inbox` | `.eq("archived", false).is("triaged_at", null)` ([tool-handlers.ts:486](supabase/functions/_shared/alfred-tools/tool-handlers.ts#L486)) |

The client one is worth knowing: those rows are not merely invisible, they are
**downloaded on every page load and thrown away**. Whatever the count is, it is paid
for on each refresh.

**I cannot give you the number.** `get_inbox` is the only inbox reader available to me
and it filters archived rows out before returning; its one parameter is `ai_status`.
There is no raw-SQL tool in this connector. Read-only query, writes nothing:

```sql
select count(*) as archived_rows,
       min(created_at) as oldest,
       max(created_at) as newest
from   inbox
where  archived = true;
```

For reference, **6 live rows** remain (`archived = false`, un-triaged), all
`ai_status: "not_started"`.

### The substantive finding: "delete only on success" needed a check that did not exist

The spec asks for disposal "only on success". `handleInboxSave` had **no success check
at all**, and none of its writers throw:

- `storage.set` catches its own errors and returns `false` ([:155](src/Alfred.jsx#L155))
- `addItemsToCollection` alerts and returns `false` ([:2656](src/Alfred.jsx#L2656))
- `withLoading` catches and does not rethrow, so an exception would not reach the caller
  either

So a failed downstream write left execution running straight into the disposal line.
That was survivable while disposal set a flag — the row stayed in the table and could
be un-flagged. **With a hard delete it would destroy the capture and leave nothing
downstream to show for it.** Every write is now checked through a small `wrote()`
helper, and on any failure the row stays and the user is told.

The message says *"check what was created before filing it again"* rather than *"try
again"*, because partial success is possible: the item may be created and the intention
not, and a blind retry would duplicate the half that worked. That partial-failure
window is pre-existing and not closed here — closing it needs a transaction, which is
a data-layer change.

### Decision — successful triage offers no Undo

Discard does; triage does not. Undo on a triage would re-insert the inbox row but could
not remove the item, intention, event or collection membership it became — so it would
restore a capture that had already been filed, leaving both. A button labelled Undo
that half-undoes is worse than no button, and this is the same standard applied to
Delete Collection in Step 4b.

Discard has no such problem: nothing downstream exists to reverse, which is exactly why
it gets the Undo.

### Surprise

**The two paths were byte-identical, and one of them was mislabelled the whole time.**
Part C says discard and triage "run byte-identical code", which was true —
`{ ...inboxItem, archived: true, triagedAt: now() }` in both places. What that hid is
that a *successful triage* was being recorded as an *archive*, so `archived = true`
never meant "the user discarded this". Any future attempt to review "past discarded
captures" from that column would have been reading a mixture of both. Deleting both
kinds removes the ambiguity going forward, but **the existing archived rows carry it**
— which is worth knowing before anyone reviews them.

---

## Step 11 findings — context archive (2026-08-25)

**No SQL written.** `contexts.archived` was applied by Alex before this step.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:3167](src/Alfred.jsx#L3167) | `activeContexts`; `pinnedContexts` derives from it |
| [Alfred.jsx:3180](src/Alfred.jsx#L3180) | `contextChildCounts` + `contextArchiveBlockers` |
| [Alfred.jsx:3213](src/Alfred.jsx#L3213) | `archiveContext`, guarded, wired to Undo |
| Context detail | Guarded **Archive** beside Edit |
| 6 picker sites | Archived contexts no longer offered |
| Recycle Bin | **Contexts** tab; load, restore ×2, delete ×2, row rendering |

### Checks run

- Full suite — **15 suites, 289 tests, pass**
- `CI=true npm run build` — **compiled successfully**

### Check 1 — the empty rule: everything is in hand, and archived children count

All four counts come from state already loaded. `loadData` selects every row of
`items`, `intents`, `events` and `item_collections` with no filter, so
`contextChildCounts` is four `.filter().length` calls and **no query**.

**Archived children count as occupancy — agreed, and there is a concrete reason
beyond principle.** The Recycle Bin labels every archived row with its context name,
resolved through `contexts.find(...)`. If an archived item's context were itself
archivable, restoring that item would place it in a context with no page to reach it
from, and the recycle row would lose its label on the way. Emptiness means "no children
at all", not "no live children".

### Check 2 — permanent delete does NOT cascade. It orphans, which is worse.

This is the opposite of Collections, and it is the finding of this step.

Queried all four child tables. **None has a foreign key to `contexts`:**

| Table | Foreign keys |
|---|---|
| `items` | `items_user_id_fkey` → `auth.users` only |
| `intents` | `intents_user_id_fkey` → `auth.users` only |
| `events` | `events_user_id_fkey` → `auth.users` only |
| `item_collections` | `item_collections_user_id_fkey` → `auth.users` only |

`context_id` is a plain nullable `text` column with an index and no referential
constraint. So deleting a context destroys nothing — it leaves children pointing at a
row that no longer exists.

**An orphaned item is reachable from nowhere.** `memoriesWithoutContext` filters
`!i.contextId`, and an orphan *has* a `contextId` — it just points at nothing. There is
no context page to open. The item is in the database, owned, and invisible. Orphaned
events and intentions fare better: they still list on Schedule and Intentions, but
their context badge renders blank.

Alex asked whether children could appear between archive and purge. They can — another
device, an MCP tool, or Elise on a shared context. So **the empty rule is now enforced
at both ends**: `recyclePermanentDelete` and `recycleBulkDelete` both re-check and
refuse with a message naming what is in the way. A context reaching deletion is
therefore empty by construction, which is why its confirm keeps the generic wording —
unlike Collections, there is genuinely nothing to warn about destroying.

### Check 3 — what Elise sees, and one thing she can do

`contexts_access` is `USING (user_id = auth.uid() OR shared = true)`, and the child
tables' RLS reads `context_id IN (SELECT id FROM contexts WHERE shared = true)`.

- **Archiving a shared context leaves `shared = true`**, so RLS is untouched. Elise
  keeps access to everything that was in it — though by the empty rule there is nothing
  in it.
- **It vanishes from her Contexts list immediately**, via the realtime channel, with no
  notification. Since it must be empty to be archived, she loses a name and nothing else.
- **She can restore it.** Her RLS grants `ALL` on shared contexts, so an archived shared
  context appears in *her* Recycle Bin's Contexts tab and she can un-archive it. She can
  equally archive one of Alex's shared contexts. Symmetric, consistent with the shared
  -collection policy, and worth knowing rather than discovering.
- **Permanent deletion is the sharp edge**, and only in theory: deleting a shared
  context removes the row the child RLS subquery depends on, so every item, intent and
  event that referenced it would become invisible to Elise while remaining visible to
  Alex through `user_id = auth.uid()`. The empty rule plus the purge-time re-check means
  no such children can exist.

### Check 4 — six places offered a choice of context; five needed changing

| Site | Kind | Action |
|---|---|---|
| Contexts list page | choice | now `activeContexts` |
| Collection detail's Context select | choice | filtered inline |
| `InboxCard`'s item Context select | choice | filtered inline |
| `ItemCard`'s Context select | choice | filtered inline |
| `InboxCard`'s intent context autocomplete | choice | filtered inline |
| `IntentionCard`'s context autocomplete | choice | filtered inline |
| Collections page context filter | choice | **already correct** — the no-op filter |

**Filtered inline rather than by swapping the prop, which is the opposite of the
`activeCollections` approach and deliberately so.** Contexts are referenced by *name*
far more widely than collections are — roughly twenty `contexts.find(...)` lookups
render a badge on an item, an intention, an event, an execution or a Recycle Bin row.
Passing a filtered array to those cards would blank every badge belonging to an
archived context. So the prop stays raw and only the pickers filter.

**The no-op filter is now correct for free**, exactly as predicted at Step 5: it always
read `contexts.filter(c => !c.archived)` against a column that did not exist, so it
excluded nothing. It excludes something now, and needed no edit.

### The realtime question — included, but as redundancy not necessity

Alex asked whether contexts having a realtime channel changes the `refreshData` answer.
**It does.** For collections it was load-bearing: no channel exists, so without it a
restored collection stayed invisible until a manual refresh — a silent failure.
Contexts have `contexts-changes` → `handleContextChange`, which maps the UPDATE into
state, so a restore propagates without any refresh.

Included anyway, for two reasons: realtime can be disconnected — the header has an
indicator for exactly that state — and `items`, `intents` and `events` are all in that
list despite having channels of their own. Consistent, and correct when the socket is
down.

### Surprise

**The two soft-delete steps have opposite failure modes, and the safer-sounding one is
the dangerous one.** Deleting a collection *cascades*: membership and removal history
are destroyed, loudly and completely, which is why Step 4b gave it a confirm naming
exactly that. Deleting a context *orphans*: nothing is destroyed, every row survives
intact — and an orphaned item becomes unreachable from any screen while looking
perfectly healthy in the database. "Nothing cascades" reads like reassurance and is the
reason this step needed a guard at both ends rather than one.

## Step 12.1 findings — Archive on IntentionCard rows (2026-09-09)

**No SQL. No new props. No routing change.** Purely a render-location fix.

### What changed

| File | Change |
|---|---|
| [Alfred.jsx:11123](../src/Alfred.jsx#L11123) | Display-mode action strip restructured; Archive added |
| [Alfred.jsx:10742](../src/Alfred.jsx#L10742) | `hasActiveExecutions` comment now records the invariant and that it fails open |

The strip copies EventCard's 8a geometry exactly: `gap-3` (12px, per 8c — 8px is
Material's documented floor for adjacent targets, not a comfortable value, and the
neighbour is destructive) and `self-end sm:self-auto` (below `sm` the parent is
`flex-col`, where `justify-between` governs the vertical axis and does nothing
horizontally, so a "right-aligned" strip lands left on exactly the device this app
is built for). Icon-only `Archive`, `min-h-[44px] min-w-[44px]`, disabled state
`text-muted-foreground/40 cursor-not-allowed`. No Edit button — per 8b the row click
already opens detail, and a row action never duplicates the row click.

### Finding 1 — the restructure is the whole step, and it is about a gate, not a button

Do Today and Start Now sat inside `showScheduling && relatedEvents.length === 0`.
Archive must **not** carry that condition: an intention with events is still
archivable, and `archiveIntention` already cascades to its events with the compound
Undo built in Step 2. So the change is not "add a button to the existing div" — it is
"lift a strip container out, keep the scheduling pair's gate on the pair, and hang
Archive off the container with its own gate". Dropping Archive into the existing div
would have silently made it archivable only when the intention had no events, which
is the exact opposite of the intended rule and would have looked correct on the
Intentions page, where most rows have no events.

### Finding 2 — no prop plumbing was needed, and that was worth checking rather than assuming

All three row sites already passed **both** `onArchive` and `executions`:

| Site | `onArchive` | `executions` |
|---|---|---|
| Intentions list ([:5235](../src/Alfred.jsx#L5235)) | `archiveIntention` | `allLiveExecutions` |
| Context detail's Intentions ([:8159](../src/Alfred.jsx#L8159)) | `onArchiveIntention` | `executions` |
| Item detail's Related Intentions ([:8955](../src/Alfred.jsx#L8955)) | `onArchiveIntention` | `executions` |

They passed `onArchive` all along; it simply had nowhere to render outside edit mode.

### Finding 3 — the invariant, rechecked as instructed, and why it could not have broken here

The guard fails open: `executions = []` defaults to "no executions" and leaves
Archive enabled mid-execution. The invariant is **"every site that passes `onArchive`
also passes `executions`"**, and it holds at **4 of 4** — the three rows above plus
intention detail, which 8a had to give the prop.

The addendum's original "six of seven" figure was wrong and has been corrected in the
spec. Four of seven receive `executions`; the other three are add-forms passing
neither prop.

12.1 added **no new IntentionCard sites**. It turned three existing ones into Archive
renderers, and all three already satisfied the invariant — so the recheck confirmed
rather than repaired. Recheck again whenever a site gains `onArchive` or a strip.

### Finding 4 — defect 0.1 has two independent locks now

Archive renders under `onArchive && intent.id`. Separately, **all four add/edit-form
sites pass `isEditing={true}`** and so never reach display mode at all. Either lock
alone would prevent the phantom "New Item"; both are cheap and they fail
independently, which matters because 12.6 is about to make add-forms look even more
like the edit screen — precisely the confusion that produced defect 0.1.

### Surprise

**The card already had every ingredient and had had them since 8a.** `onArchive` was
wired at all three row sites, `executions` was wired at all three, and
`hasActiveExecutions` was computed on every render — display mode included, where it
was dead. The button was the only missing piece, and the reason it was missing is
that the spec's row-action table never listed the Intentions page. This was a
documentation gap that presented as a code gap, which is why 8's sweep passed over it
without anything looking wrong.

### Checks run

- Full suite — **29 suites, 726 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle +38 B gzipped

(The suite is much larger than the 15 suites / 289 tests recorded at Steps 9b–11;
the growth is the games and notification-chain work committed in between, not this
phase.)

---

## Step 12.3 findings — diagnosis only, no fix written (2026-09-09)

**Verdict: none of the three candidates in the addendum. The database is correct and
always has been; the bug is entirely in client state.** No migration is needed.

### The three candidates, each ruled out by evidence

| Candidate | Verdict | Evidence |
|---|---|---|
| `updated_at` nullable, comparator sorts nulls last | **Half right, wrong half** | The comparator does sort missing last (`compareValues`: `if (!a) return 1`) — that part is real and is *how* the symptom renders. But the column is not null on insert. |
| Insert path skips the column default | **Wrong** | `storage.set` omits the key, which is exactly what makes the `DEFAULT` fire. Omitting a column is how you *get* a default, not how you skip one. |
| `set_updated_at` is BEFORE UPDATE, never fires on INSERT | **True but irrelevant** | It genuinely does not fire on INSERT. It does not need to — the column default covers inserts, and the trigger covers updates. |

`updated_at` is `timestamp with time zone`, `DEFAULT now()`, nullable on **all six**
Alfred tables — `items`, `intents`, `events`, `contexts`, `item_collections`, `inbox`.
Confirmed by schema query, not assumed.

### The actual cause — a fourth thing, in three steps

1. Every create path builds its object with `createdAt: new Date().toISOString()` and
   **no `updatedAt`**. There are 18 `createdAt:` assignments in Alfred.jsx and
   **zero** `updatedAt:` assignments.
2. `storage.set` inserts it. The database assigns `updated_at = now()` correctly. But
   the insert is `.insert(dbValue)` with **no `.select()`**, so the assigned value is
   never returned.
3. The caller then does `setItems([...items, newItem])` — appending the *local*
   object, the one with no `updatedAt`. State now holds a row that disagrees with the
   database about a column the sort depends on.

The comparator then does exactly what it was designed to do: missing sorts last in
both directions. The new row goes to the bottom.

**This is a display-layer lie about a correct database row, not a data defect.** The
distinction decides the fix: a backfill would repair nothing, because the stored data
was never wrong.

### Finding — realtime should have healed this, and is the reason it does not

All four realtime INSERT handlers (`handleItemChange`, `handleIntentChange`,
`handleEventChange`, `handleContextChange`) are byte-identical in shape:

```js
setItems(prev => {
  if (prev.find(item => item.id === record.id)) return prev;   // <-- here
  return [...prev, record];
});
```

The INSERT payload **does** carry the database's `updated_at`. It arrives moments
after the optimistic add, finds the id already present, and returns `prev` — throwing
the authoritative row away in favour of the incomplete local one.

The dedupe guard is correct and necessary: without it the optimistic add and the
realtime echo would render the row twice. But it treats "already present" as "nothing
to learn", and for a row created locally that is precisely backwards — the local copy
is the one that is missing fields.

So the stale object survives **for the whole session**. It is not a momentary flicker
that realtime repairs a second later.

### Scope — wider than Context detail, and it is the same bug everywhere

Six surfaces, one cause:

| Surface | Sorts by | Affected |
|---|---|---|
| Context detail → Items | hardcoded `(b.updatedAt \|\| '').localeCompare(a.updatedAt \|\| '')` ([:4973](../src/Alfred.jsx#L4973)) | **Yes** — where Alex saw it |
| Home | `EVENT_SORT_OPTIONS` → "Last modified" | Yes, when that order is chosen |
| Schedule | `EVENT_SORT_OPTIONS` → "Last modified" | Yes, when chosen |
| Inbox | `INBOX_SORT_OPTIONS` → "Last modified" | Yes, when chosen |
| Contexts | `NAMED_RECORD_SORT_OPTIONS` → "Last modified" | Yes, when chosen |
| Collections | `NAMED_RECORD_SORT_OPTIONS` → "Last modified" | Yes, when chosen — **and no realtime channel at all**, so not even a reconnect helps |

All five sort-controlled pages offer "Last modified"; Context detail's Items sub-list
has no control and is hardcoded to it, which is why it is the one that shows the
symptom without anyone opting in. Note it uses its **own** inline comparator, not the
shared one — two independent comparators, same behaviour on a missing value, so
fixing one would not have fixed the other.

The Intentions page has no sort control and is unaffected.

### The two populations, which are genuinely different

- **New rows (this session).** Database correct, client wrong. Client-side fix.
  Reload repairs it, which is the diagnostic test.
- **Legacy rows predating the column.** **Unresolved — needs a query, not a guess.**
  `ALTER TABLE ... ADD COLUMN ... DEFAULT` backfills existing rows on PostgreSQL 11+,
  so these are *probably* fine, but the Alfred tables' `updated_at` was added outside
  this repo's migration history (only `001_sam_tables.sql` is present), so the form of
  that ALTER is not on record here. The Recycle Bin queries pass
  `nullsFirst: false` on every `updated_at` order, which suggests someone once
  expected nulls — defensive, not evidence. The MCP tools do not expose the column and
  their schemas are frozen, so this cannot be answered from the client.

**If that query returns non-zero anywhere, the fix is a backfill — a migration, and a
stop-and-ask.** It is a separate fix from the client-state one and neither substitutes
for the other.

### Surprise

**The safety convention and the optimistic-update convention are individually correct
and collide.** "Missing values sort last in both directions" was reasoned carefully in
Step 9a and is right — an unplayed song belongs at the bottom whichever way the arrow
points. Optimistic local append is right too; it is what makes creation feel instant.
Together they mean the newest row is indistinguishable from the most-stale one, and
the app confidently sorts it to the position that means the opposite of the truth. No
line of code is wrong on its own.

---
## Step 12.3 fix — read the row back instead of rebuilding it (2026-09-09)

**No SQL. No migration.** Alex's null counts came back zero on all six tables (375
items, 133 intents, 126 events, 9 contexts, 4 collections, 4 inbox rows), so the
legacy population the diagnosis flagged does not exist. Only the client needed work.

### The one-line change that does the work

`storage.set`'s insert was `.insert(dbValue)` with no `.select()`, so the row the
database produced was never returned. It is now
`.insert(dbValue).select().maybeSingle()`, and **`storage.set` returns the saved row
in camelCase** rather than `true`.

The update branch changed too: `.select("id")` became `.select()`. Same defect, other
half — the `set_updated_at` trigger stamps an `updated_at` the caller does not have,
so an *edited* record kept its old "Last modified" until a reload. Asking only for the
id threw that away exactly as the insert did.

`false` remains the only falsy return, so `if (!ok)` callers and `wrote`'s
`result === false` check are untouched. If the database returns no row, the value that
was written is returned instead, so the result is always safe to put into state.

**`updatedAt` is NOT stamped client-side, deliberately** — that is the twin-site trap.
The trigger is the single source of truth and the client reads it rather than racing
it. The rule is recorded in the docblock on `storage.set` so the next person does not
re-derive it.

### Fifteen call sites now use the returned row

Every create path takes `saved || local`: inbox capture, triage's item / intent /
event, `moveToPlanner`, item clone, the three recurrence-and-start event creations,
context save, `handleAddItemToContext`, `handleAddIntentionToContext`, collection
create, start-now intent, and the inline add-item-to-collection.

Context save was the interesting one: it is create **and** edit through one call, and
both branches now take the saved row, so an edited context also stops showing a stale
"Last modified".

### Decision 1 — the realtime dedupe stays, and this is why

The guard that discards the authoritative payload:

```js
if (prev.find(item => item.id === record.id)) return prev;
```

**Left exactly as it is.** With the insert returning the real row, the local object is
already correct by the time the echo arrives, so the dedupe has nothing left to teach.
Removing it would mean overwriting state on every echo, which would clobber a local
edit made in the window between insert and echo — trading a fixed bug for a rarer,
worse one.

It also could never have been the fix on its own: **collections have no realtime
channel at all**, so a dedupe change would have left the Collections page broken. The
insert path is the only place that fixes all six record types, which is the argument
for fixing it there and nowhere else.

Recorded rather than silently left: the guard is *correct given* that inserts now
return their row. If `storage.set` ever stops doing that, this becomes a bug again.

### Decision 2 — the two comparators are now one

Unified rather than paired. Context detail's hand-rolled
`(b.updatedAt || '').localeCompare(a.updatedAt || '')` now calls `sortRows` with
`NAMED_RECORD_ACCESSORS`, the same path every list page uses. Same order, one
implementation.

It also inherits the title tiebreaker, so items sharing a timestamp stop depending on
array order — convention 1 in `sortOrders.js`, which the inline version never had.

Context detail's sub-lists still get no sort *control*; that decision is unchanged.
What is gone is the second copy of the comparator, not the difference in UI.

### Finding — `updated_at` was not the only thing being dropped

The insert discarded **every** database-assigned column, not just this one. What each
create path was silently losing:

| Table | Columns the client never sent, and so never learned |
|---|---|
| `items` | `updated_at`, `tags` (`'[]'`), `archived` (`false`) |
| `intents` | `updated_at`, `tags` (`'[]'`) |
| `events` | `updated_at` |
| `contexts` | `updated_at`, `tags` (`'[]'`), `archived` (`false`) |
| `item_collections` | `updated_at`, `pinned` (`false`), `items` (`'[]'`) |
| `inbox` | `updated_at` only — its create object sets all 22 other fields explicitly |

All of them are fixed by the same line, because the cause was one line.

Most were harmless by luck rather than design: `undefined` and `false` are both falsy,
so an unpinned new collection and an unarchived new item rendered correctly while
carrying the wrong value. `tags` was the closest to a real second bug —
`intent.tags && intent.tags.includes(...)` is guarded everywhere it is read, which is
the only reason a missing array never threw.

### Surprise

**The codebase had already found this bug and worked around it one field at a time.**
`newColl` carries this comment, written well before Step 12:

> `archived: false` — *"Explicit rather than leaning on the column default, so the
> object in local state has the same shape as one read back from the database."*

That is a precise description of exactly this defect, and the fix chosen was to
hand-copy one default into one create path. It worked, for that field, in that
function. Six create paths and five tables later, `updated_at` was the field nobody
had hand-copied yet — and the first one whose absence was visible, because it was the
only one where `undefined` did not happen to look the same as the real default.

### Checks run

- Full suite — **29 suites, 726 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **−1 B** gzipped

---
### Correction — the edit half was claimed too early (2026-09-09)

The verification instructions issued with the first cut of this fix said an edited
record would show a new "Last modified" immediately. **That was true only for
contexts.** `storage.set` had been changed to *return* the updated row, but only
`saveContext` was changed to *use* it — `updateItem`, `updateIntent`, `updateEvent`
and `updateCollection` all still put their locally-rebuilt object into state, so an
edit anywhere else left the timestamp stale until a reload.

Found while confirming 12.3 had reached intents. Now fixed at all four: each takes
`saved || updated`.

`updateCollection` needed a different shape from the other three. Its functional
updater exists to avoid replacing the row with a render-time snapshot, so the saved
row goes in the MIDDLE of the spread — `{ ...c, ...savedColl, ...updates }` — where it
supplies the database-assigned columns while the user's patch stays the winner for the
fields they just edited. Replacing outright would have reintroduced the clobber that
updater was written to prevent.

Archive and Undo paths were deliberately left alone. They write an object and put that
same object into state, so their `updatedAt` is stale too — but an archived row leaves
the visible list, and the Recycle Bin reads `updated_at` from its own query rather than
from this state. Recorded so the asymmetry is a decision rather than an oversight.

### Confirmation — the fix reached intents, verified by inspection not inference

Asked for explicitly, because the Intentions page offers nothing to observe it on: it
has no sort control and `IntentionCard` renders no "last updated" line. That gap is
now 12.8.

All three intent CREATE paths take the saved row:

| Path | Line | Uses |
|---|---|---|
| Triage → create intention | [:2666](../src/Alfred.jsx#L2666) | `savedIntent \|\| newIntent` |
| `handleAddIntentionToContext` | [:3987](../src/Alfred.jsx#L3987) | `savedIntent \|\| newIntent` |
| Start Now on an item | [:4216](../src/Alfred.jsx#L4216) | `savedIntent \|\| newIntent` |

The remaining four intent writes are updates, archives and Undo restores, not creates.
`updateIntent` now takes the saved row per the correction above.

Intents were never a separate code path — `storage.set` is shared and table-agnostic,
so the insert fix could not have reached items without reaching intents. But "should
follow" is not "does follow", and the sites were checked rather than assumed.

---

## Step 12.4 findings — the saving overlay, aimed correctly the second time (2026-09-09)

**The first attempt hit the wrong target and is recorded here rather than quietly
replaced.** The addendum said "Collection detail auto-saves on blur with no Save
button… the saving indicator is reported as unwanted", so the four settings toggles on
collection detail were made quiet. Those were never the complaint.

**The actual complaint:** the full-screen overlay when **removing an item from a
collection** — mid-aisle at the supermarket, one-handed, once per item ticked off.
That is the use the collection exists for, and it is the one place a scrim over the
whole app is genuinely costly.

The lesson is not that the addendum was wrong; it is that "the saving indicator on
collections" named a component and not a moment, and the moment is what mattered.

### What changed, second pass

| Path | Before | After |
|---|---|---|
| Remove member (collection detail) | `withLoading('Removing...')` | **quiet** |
| Put back (removal panel) | `withLoading('Putting back...')` | **quiet** |
| Four settings toggles | `withLoading('Saving...')` | **`withLoading('Saving...')` — put back** |

### Decision — the settings toggles get their overlay back

Reverted rather than left changed. Context, Shared, Pinned and Capture-target are
configuration: changed rarely, at a desk, one at a time. The overlay there was not the
complaint, and leaving an unrequested behaviour change in the codebase because it was
already typed is how a phase about consistency accumulates inconsistency. The `silent`
flag stays, with its one caller.

**What did NOT get reverted is the error handling**, which was a real bug independent
of any screen: `storage.set` returns `false` rather than throwing, so the silent
branch's `catch` never fired for the failure that actually happens. A failed save left
the control showing a value the database did not have, with nothing on screen and
nothing in the console. Both branches now report and re-read.

### Finding — the overlay was load-bearing, and removing it would have taken a poll guard with it

This is the part that would have broken quietly.

Collection detail runs a **five-second poll** that reloads membership. Its pause
condition is:

```js
pollPausedRef.current = collDragIdx !== null || editingQuantityItemId !== null || isLoading;
```

`isLoading` is set by `withLoading`. So the remove path was holding the poll off **as a
side effect of raising the overlay** — and deleting the `withLoading` wrapper would
have silently removed that protection, letting a tick land mid-write and put the
removed row back until the next one.

There was already a comment naming `saveMemberQuantity` and `saveMemberOrder` as "the
two writes NOT wrapped in withLoading" that hold the poll off themselves via
`memberWriteInFlight`. `removeItemFromCollection` and `putBackRemoval` now do the same,
and the comment names all four. The guard is a property of the write, not of whether a
spinner is on screen — which is what it should have been all along.

Neither path lost error reporting: both already call `reportMembershipError` and return
`false` internally, so `withLoading` was contributing the spinner and the poll pause,
nothing else.

### The audit — everything else on the shopping path, as asked

Checked whether anything else dims the screen mid-shop. **Most of it was already
correct**, which is why the one that was not stood out.

| Action | Where | Blocking? | Verdict |
|---|---|---|---|
| Tick an item off the checklist | Execution view | **No** — `toggleCollectionItem` is optimistic, no `withLoading` | Already right |
| Edit a quantity | Execution view and collection detail | **No** — `saveMemberQuantity`, own poll guard and error report | Already right |
| Reorder by drag | Collection detail | **No** — `saveMemberOrder`, same shape | Already right |
| Remove an item | Collection detail | **Was yes** | **Fixed** |
| Put an item back | Removal panel | **Was yes** | **Fixed** |
| Refresh the open collection | Both, on a poll | No — `quiet: true` | Already right |
| **Completion sweep** | End of execution | **Yes — `withLoading('Completing...')`** | **Left deliberately** |
| Bulk add items | Add-items screen | **Yes — `withLoading('Saving...')`** | **Left deliberately** |

**The execution checklist's item toggle was already silent**, contrary to what the
report assumed — worth stating plainly rather than "fixing" something that was not
broken. It writes the execution row optimistically and never raises the overlay. If a
dim was seen while ticking, it came from the remove button on collection detail, not
from the checklist.

**The completion sweep stays blocking, deliberately.** It is once per shop, not once
per item, and it fans out across several writes — archive the intent or trigger
recurrence, then clear every completed item from the collection. A half-finished sweep
is worth blocking a moment to avoid, and there is no aisle-hand cost to a spinner at
the till.

**Bulk add stays blocking** for the same reason: once per trip, and it ends by
navigating away, so the overlay covers a screen that is about to be replaced anyway.

### Surprise

**Every per-item write on the shopping path was already silent except the one being
complained about, and that one was silent-by-accident's opposite: blocking-by-accident.**
`removeItemFromCollection` reports its own errors and reloads its own state — it needed
nothing from `withLoading` except, as it turned out, the poll pause nobody had noticed
it was borrowing. The wrapper looked like the boring kind of code you delete without
thinking. Deleting it without thinking would have introduced a five-second window in
which removed items came back.

### Checks run

- Full suite — **29 suites, 726 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **+28 B** gzipped

---

## Step 12.4b findings — optimistic removal (2026-09-09)

12.4 took the overlay off the remove path. The wait stayed, because the row was still
gated on a write plus three reloads. **Removing a spinner from a slow action makes it
feel broken rather than fast** — the two halves only work together, and 12.4 shipped
one of them.

The pattern was already in the codebase: `toggleExecutionElement` updates state, then
writes. That is why ticking items off inside an execution always felt instant while
removing them from the collection did not. Matched rather than reinvented.

### What changed

| Path | Before | After |
|---|---|---|
| Remove member | write → 3 reloads → row disappears | **row disappears → write → 2 reloads** |
| Put back | write → 2 reloads → row appears | **row appears → write → swap in real row** |

**Membership is no longer reloaded on success.** State already holds the right answer;
refetching it was a round trip whose only visible effect was confirming what the user
could already see. `loadCollectionRemovals` and `loadCollectionHistory` still run, but
they feed the "Recently removed" panel and the history view — nobody is waiting on
either, and they now happen behind an already-updated list.

### The four things, in order

**1. Failure puts the row back — by reloading, not by splicing a snapshot.**

The obvious implementation captures the removed row and re-inserts it at its old index.
Rejected: the server owns member order, and a partial failure is real — `removeMember`
reads the member rows, deletes them, and writes a removal-history record, so the row
can be gone while the log write fails. A snapshot would restore a row the database no
longer has. `loadCollectionMembers` is correct in every one of those cases where a
splice is correct in most. The cost is one round trip on a path that is rare.

`reportMembershipError` was already being called; what is new is that the list stops
showing a removal that did not happen.

**2. The poll race is sharper, and the guard moved to match.**

`memberWriteInFlight` is now raised **before** the optimistic update rather than around
the write. Going optimistic opens a window that did not previously exist: between "row
dropped from state" and "row deleted in Postgres". A poll tick landing in it would
refetch the pre-delete rows and put the row back under the user's thumb — the exact
symptom 12.4 was verified against, reintroduced by the change meant to improve it.

Raising the counter first closes the window at both ends.

**3. Rapid removals — the counter was already the right shape, and that is why.**

Three taps in an aisle raise `memberWriteInFlight` to 3; it returns to 0 only when the
last settles. **A boolean would have been wrong here**: the second removal's completion
would clear the first's guard while the first was still in flight, reopening the race
for the remaining writes. The existing code chose `useRef(0)` with `+= 1` / `-= 1`
rather than a flag, and this step is the first time that choice was load-bearing.

State updates are **functional** — `setMembersFor(id, prev => prev.filter(...))` — so
overlapping removals compose. Each filter runs against what the previous one left. A
handler that captured `membersOf(collectionId)` at creation time and wrote back a
filtered copy would have had the second tap resurrect the first tap's row.

No `setMembersFor` updater has a side effect. That was deliberate: an updater that
recorded the removed row as it ran would be double-invoked under React 18 StrictMode in
development, and the second invocation — receiving the already-filtered array — would
record `null`. The rollback would then silently do nothing, in dev only.

**4. Put back got the same treatment, for consistency as much as speed.**

It sits a few inches below the remove button on the same screen. One instant and one
laggy would read as a bug in whichever felt slower.

It inserts a provisional row carrying only what the member list renders — `id`,
`itemId`, `quantity` — then swaps in the real row the insert returns. The provisional
`id` is namespaced `pending:` so it cannot collide with a database id if something
fails before the swap.

**Adding the member row is all that is needed to clear the panel entry.**
`recentRemovals` already filters out removals whose item is back in the collection, so
the "Put back" row disappears as a consequence of the membership update rather than
needing an optimistic update of its own. One write, both halves of the feedback.

The `alreadyPresent` case — a double tap, or Elise restoring it first — returns
`data: null`, so there is no real row for the provisional to become. That branch falls
back to a reload. It stays a quiet success rather than a warning: the item is in the
collection, which is what the tap asked for.

### Adding items — checked, and it does not belong in this fix

There is **no single-item add on the shopping path.** Adding always leaves collection
detail for the `collection-add-items` screen and returns:

| Add path | Screen | Verdict |
|---|---|---|
| "Add Items" button | navigates to add-items screen | Not a write |
| Bulk add | add-items screen, `withLoading('Saving...')` | **Stays blocking** — once per trip, and it navigates away as it finishes, so the overlay covers a screen about to be replaced |
| Create item then add | add-items screen | Same, same reasoning |
| Triage → add to collection | inbox | Not the shopping path |

So the earlier reasoning holds unchanged, and there is nothing here to make optimistic.
Worth stating explicitly: the asymmetry between an instant remove and a blocking add is
not an inconsistency, because they happen on different screens at different moments —
removals are per-item mid-aisle, adds are once per trip at the start.

### Surprise

**The optimistic version needs the poll guard more than the blocking version did, which
is the opposite of how it looks.** A blocking write cannot disagree with the server: the
UI does not change until the write has returned, so a poll landing mid-write refetches
rows that still match what is on screen. Going optimistic is what creates a period where
local state and the database genuinely differ — so the version that removed the spinner
"for speed" is the one that actually depends on the guard the spinner used to provide by
accident. Both changes were needed, and doing either alone would have been worse than
doing neither: 12.4 alone was slow-with-no-feedback, and this alone would have been
fast-and-occasionally-wrong.

### Checks run

- Full suite — **31 suites, 765 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **+66 B** gzipped

(The suite grew from 29/726 to 31/765 between this step and the last — new tests
committed alongside other work, not from this phase.)

---

## Step 12.5 findings — the teal top (2026-09-09)

**It is not a component.** A case-insensitive search for "teal" over the entire source
tree returns one hit, in an unrelated comment in `games/variants/drop.jsx`. Nothing
renders it.

It is `public/manifest.json`: `"theme_color": "#a2d8c8"`, with
`"background_color": "#F8FFFE"` beside it.

`theme_color` is what the browser or OS paints in the chrome **above** the page — the
address bar on Android Chrome, the status bar in an installed PWA. Hence "top", and
hence why it could not be found in the app's own markup.

### Not deliberate — a leftover, and provably so

`#a2d8c8` is a mint-teal. The palette in `index.css` is warm browns and creams:
`--background: #FAFAF8`, `--primary: #7A4E37`, `--secondary: #E4D2C3`. Neither
`#a2d8c8` nor `#F8FFFE` (a cool near-white splash colour) appears anywhere in it.
Both predate the colour redesign and were never revisited.

The spec's reasoning holds: `bg-success` is `#7A9B9B`, a muted sage that now means Do
Today and Complete specifically. A teal-family colour in the app chrome dilutes a
meaning the palette works to keep narrow — and this one is not even the same teal.

### The second half, which is why the answer was confusing

`public/index.html` carried `<meta name="theme-color" content="#000000" />`.

The meta tag governs a normal browser tab; the manifest governs the installed app. So
**the top of Alfred was black in a tab and teal once installed**, and which one you saw
depended on how you opened it. Two sources of truth, disagreeing, neither matching the
palette.

Now both say `#ffffff`, matching the header's `bg-white` so the chrome is continuous
with the page rather than a band of colour above it. `background_color` — the splash
behind the icon before the app renders — becomes `#FAFAF8`, the app's `--background`.

### Surprise

**Two files disagreed about the same colour for long enough that the app had two
different tops, and the bug report could only ever describe one of them.** "Find out
why alfred has a teal top" is answerable only from an installed PWA; from a browser
tab the honest answer is "it doesn't, it has a black one". Neither answer would have
found the other without looking at both files.

### VERIFIED 2026-09-09 — and the thing that nearly hid it

Alex confirmed: chrome above the header is now white.

**The OS had cached the old `theme_color` at install time.** The new manifest was not
picked up until the PWA was **reinstalled after clearing site data**. A plain reload,
a hard reload, and a redeploy all left the teal in place.

**Record this for the next person to touch `theme_color`, because nothing in the app
can force it and the failure looks exactly like a change that did not work:**

- The manifest is read once, when the app is installed. An installed PWA keeps the
  values it was installed with.
- There is no client-side way to invalidate that. No service-worker trick, no cache
  header, no version bump in the manifest reaches it.
- The only reliable check is: uninstall, clear site data, reinstall.
- So a `theme_color` change is unverifiable in the browser and un-forceable from code.
  Ship it, then reinstall to confirm — and do not conclude it failed because the old
  colour is still there.

This is also why the meta-tag half was worth fixing at the same time: `index.html` is
re-read on every load, so that half takes effect immediately, and having the two agree
means a future reader comparing them cannot be misled by one being stale.

### Checks run

- Full suite — **29 suites, 726 tests, pass**
- `CI=true npm run build` — **compiled successfully**

Manifest and meta changes do not surface in tests at all — they are browser-chrome
metadata, and per the note above they do not even surface in a browser.

---

## Step 12.2 findings — a link, not an edit surface (2026-09-09)

Scoped down before building: **a link on the execution screen that opens the
underlying item already in edit mode**, skipping the extra tap on "Edit Item". No
in-place editing, no "applies next time" note. A link that visibly navigates to an
edit page has no ambiguity about what it changed, which is what makes the snapshot
question stop mattering rather than needing to be explained.

### The addendum's premise was false, and it was the load-bearing one

12.2 said `activeExecution` "lives as a whole object rather than an id, so it is not
reconstructible from a URL". **Executions are the one detail view that IS
reconstructible.** `executionPath(id)` produces `/schedule/execution/:id`;
`useExecutionRoute` cold-loads it with `storage.get`; `detailStateMissing` exempts
execution-detail for exactly that reason. `viewPaths.js` records why: the other detail
views can redirect to a parent on a cold load, but "an execution cannot afford that: a
chained notification links back to the execution it came from."

Corrected in the addendum rather than only here, since that sentence would otherwise
go on shaping decisions.

### What changed

| File | Change |
|---|---|
| `Alfred.jsx` — state | `executionEditReturn`, a dedicated return slot |
| `Alfred.jsx` — `editItemFromExecution` | opens the item, records where to return |
| `Alfred.jsx` — `viewItemDetail` | clears a stale slot on any other fresh visit |
| `Alfred.jsx` — `handleBackFromItemDetail` | returns via `goToExecution` |
| `ItemDetailView` | new `startInEditMode` prop, seeds `isEditing` |
| `ExecutionDetailView` | the link, and `soleItemId` deriving its target |

### Multi-item executions — the data says the strict rule costs nothing

`itemIds` is an array, the start loop iterates it, and `flattenElements` pulls in
nested referenced items. So "the underlying item" is guaranteed neither to exist nor
to be singular. **The link renders only when there is exactly one, and that item still
exists.** No guessing which of several the user meant.

Checked against real data rather than reasoned about. Across the **entire execution
history — 50 executions**:

| Underlying items | Count |
|---|---|
| Exactly one | **42** |
| None (intent with no linked item) | **8** |
| More than one | **0** |

So the strict rule covers every case that has ever occurred and declines only the
hypothetical. The eight zero-item executions — "Water Plants", "Go through Alfred
scheduled items and inbox", and six test rows — correctly get no link, because there
is nothing to open.

### Where Back goes

A **dedicated slot**, `executionEditReturn`, holding `{ executionId, itemId }`.

- **Not `previousView`.** That is shared by every detail view and any intervening
  navigation clobbers it — the reason `intentionReturnView` already exists. This one
  is written on the way out and read once on the way back.
- **An ID, never the execution object.** The URL carries the id and
  `useExecutionRoute` can refetch from it, so an id is sufficient, cannot go stale,
  and cannot resurrect an execution closed elsewhere in the meantime. Storing the
  object here would have re-created in a state slot exactly the shape 12.2 was
  complaining about.
- **`goToExecution`, not `setView`.** `viewToPath("execution-detail")` is always the
  bare, id-less `/schedule/execution` — the view map is deliberately a bijection. So
  `setView` would render the right screen under an address that had silently lost the
  id, and a refresh from there redirects to /schedule. This is the concrete trap the
  earlier report flagged, and it is a silent one: the screen looks right.
- **`itemId` is checked on the way back**, so tapping through to other items from the
  edited one pops the existing `itemHistoryStack` first and only lands on the
  execution once the user is actually back on the item they left for.
- **Cleared on any other fresh visit to item detail**, so a later Back off that same
  item cannot bounce into an execution the user was never in.

Progress is durable either way — element and collection ticks both write the execution
row on every toggle — so this is convenience, not correctness. Recorded because the
distinction is what made it safe to choose the simpler option.

### Two small things the link does that are not obvious

**It flushes notes first.** The textarea already saves on blur, and Back already
flushes, but a tap that lands on the link without blurring the textarea would
otherwise lose what was typed. The link does exactly what Back does.

**`startInEditMode` seeds `useState` rather than driving an effect.** `ItemDetailView`
is mounted conditionally on `view === "item-detail"`, so it unmounts on the way out and
remounts on the way in — the initialiser runs exactly once per visit, which is the only
moment the flag means anything. An effect would additionally have to decide what to do
on every later render, and the answer would be "nothing".

### Collection-based executions get no link, and 12.9 was split out

They carry `itemIds: []` by construction and resolve live from the collection. There is
no underlying item to open, so there is nothing for this link to point at.

While confirming that, one thing stood out and became **12.9**: collection rows inside
an execution are the only list rows in Alfred that are not tappable. The checkbox
reacts, the quantity input reacts, and the item name is plain text. Every other list in
the app opens a detail view on a row tap. Deliberately not folded in here — different
target, different gesture, different execution type.

### Surprise

**The feature got smaller every time the code was consulted, and the last cut removed
the only genuinely hard part.** The addendum posed three open questions. The first was
already answered by the snapshot. The second dissolved once the URL turned out to carry
the id. The third — what Edit means for a collection-based execution — stopped applying
the moment "edit surface" became "link", because a link with no target simply does not
render. What remained was one conditional, one state slot, and one prop.

### Checks run

- Full suite — **31 suites, 765 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **+310 B** gzipped

---

## Step 12.6 findings — the sticky footer, and the page deferred (2026-09-09)

The complaint: Add Item opens a form wedged between the section header and the item
list. With a dozen elements added and 28 items below, Save ends up buried mid-page with
content above and below it.

**The fix is one prop at four call sites.** The dedicated page is deferred to the
routing thread.

### The correction — `sticky` is not `fixed`, and this one misled us

Step 7b withheld the sticky footer from the add forms on this reasoning:

> "a pinned bar would hover over content it has nothing to do with"

**That is true of `position: fixed`. The footer uses `position: sticky`:**

```
sticky bottom-28 sm:bottom-32 -mx-3 sm:-mx-4 px-3 sm:px-4 pb-3 bg-card border-t border-border
```

A sticky element is constrained by its parent's box. It pins while the card is in view
and **releases at the card's bottom edge** — it cannot travel down the page and hover
over the Items list, because the card is its containing block. Checked for `overflow`
on the scroll ancestors that would break sticky containment: the only hits are modals,
textareas and dropdowns, none of them an ancestor of the add-form card. The page
scrolls on the document.

Recorded in the **spec**, not only here, at the rule it corrects. The struck wording is
why the original complaint survived Step 7b — the step written to fix it.

### What actually buries Save, which is worth being precise about

The 28 items below do **not** push Save down. Save is inside the card. What buries it
is the form growing tall as elements are added, with more page below so there is no
visual end to the form. Sticky addresses exactly that and nothing else — the page stays
as long as it was.

### What changed

`stickyFooter` at four sites: the Intentions page's add form, Context detail's Add Item
and Add Intention, and Item detail's Create Intention. Both `ItemCard` and
`IntentionCard` already had the prop from Step 7b; no component changed.

Both add forms on Context detail can be open at once. Each footer is constrained to its
own card, so they pin independently and only one is ever in view — the two-open-cards
objection from Revision 1 is also a `fixed` problem, not a `sticky` one.

### Build note — `{/* */}` is not valid between JSX attributes

The first attempt used `{/* … */}` comments in the attribute position and **failed the
build** with `Unexpected token, expected "..."`. JSX takes `//` line comments between
attributes, which is what the rest of this file uses. Worth recording because **the
test suite passed while the build failed**: no test imports `Alfred.jsx`, so a syntax
error in it is invisible to 765 passing tests. `npm run build` is the only gate on this
file.

### The page, deferred — three reasons, none of them preference

**1. It buys an address nothing links to.** Detail routes carry no record ids;
executions are the sole exception, as 12.2 established. An add-item page needs the
context id in its URL, and putting ids in URLs **is slice 2** of the routing thread by
name.

**2. It costs four return-address writers the routing thread has asked us not to add.**
Its progress file is explicit:

> "Until then, keep all three, and **add no new writers**. Every new `setPreviousView`
> call is another site to unpick later. If a new screen needs a return address after
> slice 2 lands, it should use `navigate(-1)`."

Four add pages need four return addresses. That is slice 3's job made larger by us.

**3. It introduces a defect-0.1 confusion risk the current layout does not have.** The
structural protection is unaffected either way — Archive renders under
`onArchive && intent.id`, and add forms pass neither with a null id. What a page changes
is the *visual* cue: today an add form is unmistakably a card sitting in a list, and
nothing like the edit screen. As a page it would look exactly like the edit screen,
which is the confusion that produced the phantom "New Item". Keeping them apart would
need a "New Item" heading and probably a different Save label — work the sticky footer
does not incur at all.

**Also worth saying:** four near-identical routes is the copy-paste drift that produced
the three collection rows in Step 4a. If it is ever built it should be one
parameterised route. The forms are already single components, so the duplication would
land entirely in route plumbing — the part slice 2 is going to rewrite anyway.

### Held in reserve, not built

If a tall form still reads badly, **hide the sibling lists while an add form is open.**
That makes the card genuinely own the screen — satisfying Step 7b's own test — with no
routing at all. Not built, per Alex: the sticky footer should be sufficient, and he will
say if it is not.

### Surprise

**The step written to fix this problem is the step that entrenched it.** Step 7b exists
because Step 7 wrongly proposed striking "Recipe edit form: Save reachable without
scrolling" as a stale requirement. 7b caught that, pinned the two whole-page forms —
and then withheld the same fix from the add forms using a sentence about a CSS
mechanism the codebase does not use. The requirement was reinstated and half-served in
the same step, and the wording that half-served it read as settled reasoning for
sixteen days.

### Checks run

- Full suite — **31 suites, 765 tests, pass**
- `CI=true npm run build` — **compiled successfully** (after the JSX-comment fix above)

Neither gate can see this change: it is CSS positioning with no test coverage on
`Alfred.jsx`. **It needs the eyeball check in the verification list — a genuinely tall
form on a phone, not a short one on desktop.**

---

## Step 12.6b findings — the add pages, built properly (2026-09-09)

12.6 shipped the sticky footer as the small fix. This replaces it with the real thing:
**two pages, four entry points, real addresses, browser Back working.** The sticky
footer stays — the pages own the screen, so it is now unambiguously correct there.

**No part of this needed the routing thread's work done wholesale.** The minimum was
smaller than feared, for a reason worth recording — see "why this was cheap" below.

### What changed

| File | Change |
|---|---|
| `viewPaths.js` | Two views, `item-add` and `intention-add`; `addPath`, `addRouteFromPath`; `pathToView` / `isKnownPath` / `parentPath` extended |
| `viewPaths.test.js` | Counts updated with a note, plus 8 new tests for the add routes |
| `Alfred.jsx` | `AddPageChrome`; route derivation and the missing-target guard; `openAddPage` / `leaveAddPage` / `closeAddPage`; two save handlers; two render blocks |
| `Alfred.jsx` | Four inline forms deleted, along with three `showAdd*Form` state pairs and `ContextDetailView`'s two seeds and two save handlers |

### The address grammar — two pages, not four

```
/memories/new                          bare: nothing preselected
/memories/new/context/:contextId       Context detail's Add Item
/intentions/new                        Intentions page's Add Intention
/intentions/new/context/:contextId     Context detail's Add Intention
/intentions/new/item/:itemId           Item detail's Create Intention
```

**The entry point is a target in the URL, not a separate screen.** One page per form
type serves every caller; the difference between callers is data. Four near-identical
routes is the copy-paste drift that produced the three collection rows in Step 4a.

Two target kinds and no more without a reason: `context` and `item`. The bare form is a
first-class address, which is what the Intentions page needs — its add form never had a
context to preselect.

This follows the **execution precedent** rather than inventing a second pattern: the
view map stays a bijection (`viewToPath("item-add")` is always `/memories/new`) while
`pathToView` resolves both the bare and targeted forms to the same view. That is
exactly how `/schedule/execution/:id` was added without touching every navigation.

### Why this was cheap, and it is not because we cut a corner

The worry was that ids-in-URLs is slice 2 and this would drag it in. It did not, and
the reason is specific: **`loadData` already selects every row of `contexts` and
`items` into state.** So resolving a target is `contexts.find(...)` — no fetch, no
`useExecutionRoute`-style loading hook, no per-view lookup machinery.

The execution route needed all of that because executions are **not** all in state:
only active and paused ones are, so a link to a closed execution has to fetch. Contexts
and items have no such gap.

**What that means for slice 2:** this is not a competing implementation of ids-in-URLs.
It is two new addresses that happen to carry ids, built on the existing map. Converting
`/contexts/detail` to `/contexts/:contextId` does not conflict with it and will not
have to undo it.

### Cold load

- **Bare form** — renders. Legitimate address; the form's own context picker does the
  rest.
- **Target that resolves** — renders with it preselected.
- **Target that no longer exists** — a deleted context, a stale shared link — redirects
  to the **list** (`/memories`, `/intentions`), not to the bare add form. Opening an add
  form with the target silently dropped would be worse than saying the address is no
  good.
- **Malformed target** — a bad kind, a missing id, an extra segment — is not an address
  at all. `isKnownPath` returns false and it redirects to home like any other nonsense
  path. Deliberately not "a target with a bad value": a half-read target would open an
  add form pointing somewhere unintended.

**`dataLoaded` is the whole cold-load guard, and it is not optional.** The redirect
effect runs on every render — hooks run before Alfred's `!dataLoaded` early return — so
without it every cold load would find an empty `contexts` array, decide the target was
gone, and bounce to the list before the data arrived. This is the same failure
`useExecutionRoute` documents at length; the fix is cheaper here only because the data
is already on its way rather than needing to be fetched.

### Back, Cancel, and the guard

**No return-address slot.** The routing thread asked for exactly this:

> "If a new screen needs a return address after slice 2 lands, it should use
> `navigate(-1)`."

These are new screens, so they use it now rather than adding a fifth thing for slice 3
to unpick. `executionEditReturn` remains the only new slot this phase added, and it is
already written up above for them.

The one piece of bookkeeping is `state: { fromApp: true }`, set when opening from inside
Alfred. It exists because `navigate(-1)` steps **out** of the app when there is nothing
to go back to — the caveat the routing thread recorded for cold-loaded deep links and
middle-clicked tabs. With the flag, Back returns to the entry screen; without it (a
pasted URL), it goes to the parent list. **Router state, not app state:** it lives on
the history entry, so it cannot go stale and there is nothing to clear.

| Route in | Back / Cancel lands on |
|---|---|
| Context detail → Add Item | that context |
| Context detail → Add Intention | that context |
| Intentions → Add Intention | Intentions |
| Item detail → Create Intention | that item |
| Pasted URL | the parent list |

**The guard:** `closeAddPage` calls `confirmDiscardIfDirty`, so the page's own Back
button prompts on a half-typed record. The card's Cancel clears the dirty flag before
calling back, so Cancel discards without a second prompt — existing behaviour, matched
deliberately. After a save the card has already cleared the flag, and `leaveAddPage`
skips the check rather than prompting about changes that were just committed.

**Known limitation, and it is pre-existing rather than new: browser Back bypasses the
guard.** `confirmDiscardIfDirty` only runs on in-app navigation, and `beforeunload`
only covers leaving the site. Item detail, intention detail and every other in-place
edit have had exactly this hole since the routing work landed; making these pages did
not create it and fixing it belongs with the routing thread, where `navigate(-1)` and
history blocking live in the same conversation.

### Defect 0.1

The structural guarantee is unchanged: the seed record has a null id and no `onArchive`
prop, and Archive renders under `onArchive && intent.id`. Nothing about a page changes
that.

What a page **does** change is the visual cue, which was the other half of the original
confusion. An add form now has the same width, chrome and sticky footer as the edit
screen. So the page carries a heading the edit screen does not have:

- **"New Item"** / **"New Intention"**, where the edit screen shows the record's own
  name.
- A subtitle naming the target — "in Recipes", "for Chicken Piccata" — so it is clear
  what is being added and where before anything is typed.

`AddPageChrome` exists to make that heading structural rather than something each page
remembers to render.

### For the routing thread — what they will want to change

Written for them rather than left to be found:

1. **`addRouteFromPath` will look like a smaller version of whatever slice 2 builds.**
   When `/contexts/:contextId` exists there will be one general id-bearing-path parser;
   these two routes should fold into it. The grammar (`base/kind/id`) was chosen to be
   easy to absorb, not to be permanent.
2. **`state.fromApp` should disappear** once there is a general answer to "did we get
   here from inside the app". It is a local fix to the `navigate(-1)` caveat they
   already documented, not a new idea.
3. **`AddPageChrome` is presentational** and has no routing in it. It should survive
   untouched.
4. **These pages add no `setPreviousView` writers and no new return-address slot.** The
   "add no new writers" rule is honoured.

### Surprise

**The expensive-looking half was free and the cheap-looking half needed the care.** The
routing — new views, a path grammar, `pathToView`/`isKnownPath`/`parentPath` — was
mechanical, because the execution route had already established the pattern and the
module is pure data plus two lookups. The part that actually needed thought was
`dataLoaded`: one boolean standing between this and a cold load that redirects away
from a perfectly valid address before the data arrives. The routing module has tests;
that boolean has none, because it lives in `Alfred.jsx`.

### Checks run

- Full suite — **31 suites, 773 tests, pass** (765 before; 8 new tests cover the add
  routes, including malformed targets and the parent-path rule)
- `CI=true npm run build` — **compiled successfully**, main bundle **+459 B** gzipped

`Alfred.jsx` still has no test coverage, so the pages themselves are verified by hand.
`viewPaths.js` does, and the new grammar is tested there.

---

## Step 12.6c findings — cold-load Back follows the target (2026-09-09)

Verification check 7 passed as built and was wrong as designed. A pasted
`/intentions/new/context/:id` sent Back to the **Intentions list**. It should send Back
to **that context**.

**The address already says where the link conceptually came from.** A pasted "add to
this context" link almost certainly arrived from someone pointing at that context, not
from a tour of the intentions list. The old fallback threw that information away and
guessed from the record type instead.

### The rule now

| Address | Cold-load Back |
|---|---|
| `/memories/new/context/:contextId` | **that context** |
| `/intentions/new/context/:contextId` | **that context** |
| `/intentions/new/item/:itemId` | **that item** |
| `/memories/new` | Memories |
| `/intentions/new` | Intentions |

Only the bare form, which names no target, falls back to the record type's list — there
is nothing else it could use.

**Cold load only.** In-app navigation still uses `navigate(-1)` with `state.fromApp`,
unchanged, and a target that no longer resolves still redirects to the list rather than
attempting to navigate to a deleted context.

### Deliberately not via `viewContextDetail` / `viewItemDetail`

Both write `previousView`, and called from here they would write `"intention-add"` — so
Back off the context would try to return to a form the user had just left, and the flag
would name a screen that is not on the way to anywhere. Setting the id and navigating
directly avoids that, and avoids adding a `setPreviousView` writer the routing thread
has asked us not to add.

**The consequence, stated rather than hidden:** `previousView` keeps its cold-load
default of `"home"`, so Back off the target page goes Home. That is right for a session
that began on a pasted link — there is genuinely nowhere else it came from.

`replace` throughout, because the add page is being *left* rather than navigated *from*.
Leaving it in history would put an empty form behind the Back button, the draft having
already been saved or discarded.

### Is `fromApp` now redundant? No — but its job has narrowed, and that is worth saying

**For all four entry points the two mechanisms now land in the same place.** Checked
rather than assumed:

| Entry point | in-app `navigate(-1)` | cold-load fallback | Same? |
|---|---|---|---|
| Context detail → Add Item | that context | that context | **yes** |
| Context detail → Add Intention | that context | that context | **yes** |
| Item detail → Create Intention | that item | that item | **yes** |
| Intentions → Add Intention | Intentions | Intentions (bare) | **yes** |

So the flag no longer decides *where* you land. Three things it still does:

1. **It pops rather than reconstructs.** `navigate(-1)` returns to the actual previous
   history entry, restoring scroll position. The fallback builds a fresh one at the top
   of the page. On a context with 28 items that is a visible difference.
2. **It leaves `previousView` alone.** In-app, Back off the target continues up the real
   chain the user walked. The cold-load path lands with `previousView` at its default.
   Both are correct for their situation, which is exactly why they are not
   interchangeable.
3. **It does not assume target == origin.** Today it always does, because all four
   openers pass the target they are sitting on. A future entry point that does not — a
   quick-add from Home, an add launched from inbox triage — would have the fallback
   send the user somewhere they have never been, while `navigate(-1)` stays right.

**Recommendation: keep both, and let slice 3 collapse them if it wants.** The
convergence above is the useful fact: if the routing thread builds a general answer to
"did we arrive from inside the app", the targeted case can drop the flag **with no
behaviour change for today's entry points**. That is a much easier call to make with the
table above in hand than by rediscovering it.

### Surprise

**Making the fallback smarter is what made the flag look redundant, and it is the same
information arriving twice by different routes.** `fromApp` records the origin as
history; the target records it as data in the URL. They agree today only because every
opener passes the target it is standing on — an invariant nothing enforces and nothing
writes down. It is written down now.

### Checks run

- Full suite — **31 suites, 773 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **+42 B** gzipped

The routing tests in `viewPaths.test.js` cover the address grammar and `parentPath`,
both unchanged by this. The fallback itself lives in `Alfred.jsx` and has no coverage,
so it needs the paste-and-Back checks below.

---

## Step 12.7 findings — editing a capture without triaging it (2026-09-09)

A capture often lands half-written, and until now the only way to change it was to
triage it into something. The expanded inbox card now edits `captured_text` directly:
no item, no intention, no event, and the row stays in the inbox.

### The enrichment question — clear, and clear more than the status

**Recommended and built: clear `ai_status` back to `not_started`, AND null the
`suggested_*` fields with it.** The addendum offered three options; the reason for this
one is specific and was not visible from the spec.

**"Clear `ai_status`" alone does not work**, and that is the finding. `InboxCard` seeds
its triage fields from the suggestions:

```js
const [intentText, setIntentText] = useState(
  inboxItem.suggestedIntentText || inboxItem.capturedText
);
```

So a stale suggestion is not a column nobody reads — **it is what the triage form
proposes.** Leave it and a user who corrected a capture is still offered the text they
corrected, with the status badge the only hint anything is wrong. That makes "leave the
stale suggestions" the worst of the three rather than the laziest.

**"Prompt for re-enrichment" conflicts with governing rule 3** — no confirmation
dialogs — unless the prompt is a message rather than a dialog. But a message leaves the
wrong prefill in place while the user decides, which is the actual harm. So it does not
solve the problem it is aimed at.

**The cost of clearing is a good enrichment lost to a typo fix**, and it is mitigated
twice:

- The clear only happens when the text **actually changed**. Opening the editor and
  saving an unchanged capture touches nothing.
- Re-enriching is one tap on a button already in this card, and `ai-enrich` takes an
  `inbox_id` and reads `captured_text` **server-side** — so a re-run after an edit
  describes the corrected text with no extra plumbing. That is what makes clearing
  cheap rather than destructive.

The editor says so before you commit: while a capture is enriched, the editor shows a
line explaining that saving clears the suggestions and inviting a re-enrich after.

**If this is overturned, `updateInboxCaptureText` is the only place to change** — the
cleared shape is a single named constant, `CLEARED_ENRICHMENT`, written out in full
rather than derived so a new `suggested_*` column that forgets it is visible as an
omission.

### The consequence nobody would have predicted from the spec

Clearing the suggestions is necessary but not sufficient, because those `useState`
initialisers run **once, at mount**. The card does not remount when the capture is
saved, so `intentText` and `itemName` would keep the values seeded from the old text
even after the columns behind them were nulled.

So the save handler reseeds them explicitly from what was just written. Without that,
the feature would appear to work — text updated, badge reset — while the triage form
below still proposed the sentence the user had just replaced.

### What changed

| Location | Change |
|---|---|
| `Alfred.jsx` — `CLEARED_ENRICHMENT` | the reset shape, beside the badge that renders its status |
| `Alfred.jsx` — `updateInboxCaptureText` | the write; spreads the row, so `triagedAt` survives |
| `InboxCard` | `editingCapture` / `captureDraft` state, the editor, a pencil on the static text |
| `InboxCard` | the dirty check now covers an open editor |
| Inbox render site | `onSaveCaptureText` wired |

### Step 10's disposal rule

Editing is not triage. The row is **spread** rather than rebuilt — `{ ...inboxItem,
capturedText, ...CLEARED_ENRICHMENT }` — so every column this step has no opinion
about, `triagedAt` among them, is carried through untouched. Nothing here deletes, and
`storage.set` UPDATEs by id, so there is no path from this function to a disposal.

### MCP schemas

Untouched, as required. `update_inbox_item` writes the `ai_*` and `suggested_*` fields;
this writes `captured_text`, a different column, through the ordinary client write path.
No tool definition was read or changed.

### The unsaved-changes guard — it did participate, and this was the hole in it

`InboxCard` has been in the guard since Step 7: it reports dirty for the triage fields
and clears on unmount. **The capture text was the one field on this card that could be
lost by navigating away**, because until now it was not a field at all.

The dirty check now includes `editingCapture && captureDraft !== inboxItem.capturedText`,
so an open editor with unsaved text warns on navigation exactly as a half-filled triage
form does. Cancel restores the draft from the row and closes, which is a discard and
correctly does not warn.

The pre-existing limitation stands unchanged: **browser Back still bypasses the guard**,
here as everywhere else in Alfred. Recorded in 12.6b; not made worse by this.

### Surprise

**The interesting part of this step was not the edit, it was what the edit invalidates —
and the invalidation reaches further than the column it obviously touches.** Changing
`captured_text` silently falsifies eleven other columns, and the mechanism by which that
becomes visible to the user is not the AI badge but two `useState` initialisers a
thousand lines away in a different component. A change to one text column had to be
followed through a server-side enrichment contract, a set of suggestion columns, and a
form-seeding rule before it was actually done.

### Checks run

- Full suite — **31 suites, 773 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **+505 B** gzipped

`Alfred.jsx` has no test coverage, so the reseeding behaviour in particular needs the
by-hand check below — it is the half that would fail silently.

---



## Step 12.7b findings — one Save, one Cancel (2026-09-09)

12.7 gave the capture editor its own Save and Cancel. The card already had a pair in
its footer, 250px below, identically labelled — and **the two outcomes are not
symmetrical**: the footer's Save files the capture and deletes the row, the editor's
saved a typo fix. Two identical labels, one recoverable and one disposing of the
record. That is precisely the inconsistency this phase exists to remove, and it was
introduced by the step that was meant to be tidying up.

### The fix — the capture text is just another field of the card

Of the three options, the middle one: **the footer's existing Save handles both.**

The editor now has no buttons. `captureDraft` is a dirty field of the card like
`intentText` or `itemName`, and the one Save commits whatever is pending:

```
Save = "commit what I changed on this card"
  ├─ capture text edited?     → write it; the row STAYS in the inbox
  └─ triage section open?     → file it; the row is deleted (Step 10)
```

Those are not alternatives — both can be pending, and the text is written **first**, so
a triage in the same press files the corrected text rather than the text being
corrected.

**The Save is no longer disabled on "nothing to triage" alone.** It was inert whenever
no section was open, which is exactly the state a text-only edit leaves the card in.
`canSave` is now `intentionOpen || itemOpen || collectionOpen || captureTextDirty`.

**Cancel** already reset every other field on the card; it now resets the editor too.

### Why not blur-commit

The first option — commit on blur, like collection detail's fields, no buttons at all —
is tempting and was rejected for one reason: **collection detail's blur-saves have no
side effects, and this one clears an enrichment.** A blur is not a decision. Losing an
Opus enrichment because focus moved is a worse trade than one extra field on a form the
user is already filling in.

It also removes the ability to abandon an edit: with no buttons and blur committing,
there is no way back. Recoverability would then have to come from an Undo message,
which is more machinery than making the text a form field.

### Both halves of 12.7 preserved — and the race is gone rather than handled

**The enrichment clear still fires only on a real change.** `updateInboxCaptureText` is
untouched: it compares the trimmed draft to the stored text and applies
`CLEARED_ENRICHMENT` only if they differ.

**The reseed moved, and moving it removed a race rather than relocating one.** 12.7
reseeded `intentText` and `itemName` *after* the save returned. That left a window —
small, but real — where the text was written and the form below still proposed the
sentence it replaced. They are now kept in step **as the user types**:

```js
if (intentText === captureDraft) setIntentText(next);
if (itemName === captureDraft) setItemName(next);
```

Comparing against the previous draft rather than the stored text is what makes this
work while typing: a field that is still showing the capture verbatim follows along; one
the user has edited is theirs and is left alone. There is no longer any moment at which
the two can disagree.

**The unsaved-changes guard still covers typed-but-unsaved capture text** — the dirty
check keeps `editingCapture && captureDraft !== inboxItem.capturedText`, and the field
is now inside the same commit path as everything else it sits beside.

### The rest of the footer, audited as asked

**Order was already right.** Enrich · Save · Cancel — gap — Delete matches Step 7's
standard: primary, Cancel, then a gap, then the destructive action pushed right.
`justify-between` is the gap, so Delete sits as far from Cancel as the row allows.

Two things were not right:

- **Two primaries.** Enrich carried `bg-primary`, identical to the Save beside it. Save
  is this card's primary action; Enrich is a tool. Enrich is now secondary — the same
  dilution Step 8b settled when Start Now and Do Today were both competing for the eye.
- **8px spacing.** The row was `gap-2`. Step 8c's rule is 12px between adjacent
  controls, 8px being Material's documented floor rather than a comfortable value — and
  this is a three-button row on a touchscreen. Now `gap-3`, with `flex-wrap` so it
  degrades on a narrow screen instead of crushing.

Delete keeps its `min-h-[44px]`; it is a text button so width is not at issue.

### Surprise

**The tidying step introduced the defect the phase exists to remove, and it did so by
following the local convention rather than the global one.** An editor with a Save and
a Cancel is the right shape for an editor — every card in Alfred looks like that. It was
wrong only because of what was already on screen 250px below it, which is not visible
from the code that renders the editor. The rule "one primary action per surface" cannot
be checked by looking at the thing you are building; it can only be checked by looking
at the thing you are building it into.

### Checks run

- Full suite — **31 suites, 773 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **+2 B** gzipped over
  12.7 (the buttons removed roughly paid for the logic added)
- **Counted by hand:** exactly one `Save` and one `Cancel` label in `InboxCard`.

---

## Step 12.7c findings — Context is a dropdown everywhere (2026-09-09)

The same inbox card offered Context as a **search typeahead** on its Intention section
and a **dropdown** on its Item section. Two patterns, one card, one field.

Nine contexts. A search field over nine options is friction for nothing — and worse
than nothing, because the typeahead rendered its list only once you had typed, so the
thing you were choosing from was hidden until you already knew its name.

### What was lost by removing the typeahead — checked before, not after

**Nothing.** Asked explicitly, and worth the check, but both typeaheads were pure
filters over `contexts`:

| Capability | Typeahead | Dropdown |
|---|---|---|
| Create a context on the fly | **no** | no |
| Filter on anything but `name` | **no** | n/a |
| Exclude archived contexts | yes | yes — same `!c.archived` |
| Cap the list | `.slice(0, 10)` | none — and the cap never bound at nine |
| Clear the selection | an X button | the "No context" option |
| Show the options before you type | **no** | **yes** |

The last row is the whole argument. The only real capability a typeahead has — typing
to narrow a long list — is the one that does not apply at this size.

### The inventory — five sites, two patterns, now one

| Site | Was | Now |
|---|---|---|
| InboxCard → Intention section | typeahead | **dropdown** |
| `IntentionCard` | typeahead | **dropdown** |
| InboxCard → Item section | dropdown | unchanged |
| `ItemCard` | dropdown | unchanged |
| Collection detail | dropdown | unchanged |

`IntentionCard` is one component with four render sites, so converting it covers the
intention edit form, the add-intention page, Context detail's intentions and Item
detail's related intentions in one change. `ItemCard` likewise already covered item edit
and the add-item page — both were already dropdowns, which is why the inconsistency was
visible on a single card rather than across screens.

Verified after: zero context typeaheads remain, five context dropdowns.

### Linked Item stays a typeahead — and yes, that is the reason

Confirmed rather than assumed. **375 items against 9 contexts.** A dropdown of 375
options is unusable on a phone, and typing to narrow is exactly the capability the
context field had no use for. The split is a size judgement, not an accident, and it is
now written at both fields so the next person does not "make them consistent" in the
wrong direction.

The same reasoning leaves the collection-item pickers alone.

### Surprise

**Removing the typeaheads made the bundle smaller and the diff mostly deletions.** The
dropdown is nine lines; the typeahead it replaced was fifty, plus two pieces of state,
a memoised filter, a blur timeout, and a manual clear button. The pattern that looked
more capable was carrying five mechanisms to do less than `<select>` does natively —
including a `setTimeout(..., 200)` on blur, which exists solely so a click on the
dropdown lands before the dropdown disappears. That is a bug class a native select
cannot have.

`CI=true` catching six unused-variable errors after the swap is what surfaced the full
extent of it: two `useState` pairs and two filters that nothing referenced any more.

### Checks run

- Full suite — **31 suites, 773 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **−60 B** gzipped
- `grep "Search for a context"` — **0 hits**; `grep "No context</option>"` — **5**

---

## Step 12.8 findings — Intentions and Memories parity (2026-09-09)

Both gaps came from one cause: **the spec's page inventory was never complete**, so
these two pages were skipped by Step 8's row-action sweep and again by Step 9b's sort
work. 12.1 closed the first half for Intentions; this closes the rest.

### What changed

| Location | Change |
|---|---|
| `INTENTION_SORT_OPTIONS` / `INTENTION_ACCESSORS` | new — intentions sort on their own shape |
| `intentionsSort`, `memoriesSort` | own storage keys |
| Intentions page | `SortControl`, list through `sortRows` |
| Memories page | `SortControl`, list through `sortRows` |
| `IntentionCard` | a "last updated" line in display mode |

### The order was not merely undocumented — there wasn't one

`intentionsWithoutActiveEvent` and `memoriesWithoutContext` are bare `.filter()` calls
over `loadData`'s `select("*")`, which carries **no `ORDER BY`**. So the row order was
whatever Postgres returned and could differ between sessions for reasons nothing in the
app controls.

Step 9b's stated goal was that order be **stable across a reload**. On these two pages it
was never stable to begin with, which is a stronger failure than the one 9b set out to
fix and had gone unnoticed because nobody had counted the pages.

### The options, and the two judgement calls

**Intentions — Name, Created, Last modified. Default: Last modified, newest first.**
Alex's call, and **no scheduled date**, deliberately: the list is
`intentionsWithoutActiveEvent`, so an intention that has an event drops out of it
entirely. The field would be null on every row present, the comparator would sort every
one of them "missing last", and the order would collapse to the title tiebreaker. An
option that can only ever do nothing is worse than an absent one.

**Memories — the same three, default Last modified, newest first.** My call, as asked:

- It is a list of **items**, and the only other list of items in Alfred — Context
  detail's Items — has always been `updatedAt` descending.
- 12.3 established that a newly touched record is expected at the **top**; that was the
  whole complaint, and defaulting this page to Name would reintroduce the same surprise
  by a different route.
- **Name was the alternative**, for consistency with Contexts and Collections, which
  share this exact option set and both default to Name. It lost because those two are
  things you *look up*, and Memories is a holding pen for what has not been filed yet —
  you arrive at it to deal with recent arrivals, not to find a specific one.

### `title` on both accessor bags — and why omitting it fails badly

`comparatorFor` falls through to `get.title(a)` as the universal tiebreaker for **every**
order, not only when Name is the chosen key. A bag without `title` therefore throws
inside the comparator on the first tie — not "sorts oddly", not "ignores the tiebreaker".
It fails in a way that has nothing to do with sorting, from a page that merely rendered a
list.

Memories reuses `NAMED_RECORD_ACCESSORS`, where `title` is `r.name`. Intentions needed
its own bag: **an intention has no `name`, it has `text`**, so `INTENTION_ACCESSORS` maps
`title: (r) => r.text`. Reusing the named-record bag would have made every intention's
tiebreaker `undefined`, which `text()` coerces to `""` — so all rows would compare equal
and the order would silently fall back to array order, i.e. back to the arbitrary order
this step exists to remove. That failure is quiet, which is worse than the throw.

### Storage keys

`alfred.sort.intentions` and `alfred.sort.memories`, independent of the other five.
Seven pages, seven keys, no sharing — changing the Intentions order must not reorder
Memories.

### The "last updated" line

`ItemCard` has carried one since Phase 6. `IntentionCard` never got one, so **an
intention was the only record in Alfred whose "Last modified" order you could now sort by
but not see**. Same format and placement as ItemCard's — a `text-xs` muted span below the
metadata row, `last updated: Mon D, YYYY`. No element count, because an intention has no
elements, so it is the timestamp alone.

### The inventory, counted properly this time

**Seven top-level Alfred list pages. All seven now have a sort control.**

| Page | Options | Default | Since |
|---|---|---|---|
| Home (Today tab) | `EVENT_SORT_OPTIONS` | Scheduled date ↑ | 9b |
| Schedule | `EVENT_SORT_OPTIONS` | Scheduled date ↑ | 9b |
| Inbox | `INBOX_SORT_OPTIONS` | Created ↓ | 9b |
| Contexts | `NAMED_RECORD_SORT_OPTIONS` | Name ↑ | 9b |
| Collections | `NAMED_RECORD_SORT_OPTIONS` | Name ↑ | 9b |
| **Intentions** | `INTENTION_SORT_OPTIONS` | **Last modified ↓** | **12.8** |
| **Memories** | `NAMED_RECORD_SORT_OPTIONS` | **Last modified ↓** | **12.8** |

**Remaining omissions, all deliberate, each with a reason on record:**

| Not controlled | Why |
|---|---|
| Recycle Bin | Ordered server-side, `updated_at desc nullsFirst:false`, in the query itself. Stable across reloads already, and "most recently deleted first" is the only order a recycle bin wants. |
| Home's Active / Paused tabs | `ExecutionBadge` rows, ordered `started_at desc` by the query. Recorded in 9b; they have none of the sortable fields. |
| Five detail-page sub-lists | Context detail's Items / Intentions / Collections, Item detail's Related Intentions, Collection detail's members. Step 9b's explicit scope call: "the spec covers list pages; detail pages hold five such sub-lists between them, and giving each a control is a different decision." Context detail's Items has a fixed order and, as of 12.3, runs through the shared comparator. |
| SAM library | Has its own control and its own option list from Step 9a — "Last played" does not generalise. |
| Timer, Games | Not lists of records. |

So: **7 of 7 controlled, and every uncontrolled list is uncontrolled on purpose.** The
inventory is now complete and written down, which it was not before — that is the actual
fix here, the two controls being the consequence.

### Surprise

**Both pages were skipped twice by two different sweeps, and the reason is that neither
sweep worked from a list.** Step 8 worked from the spec's row-action table and Step 9b
from "the five list pages"; both phrases were written from memory of the app rather than
from the nav, and both inherited the same blind spot. Nothing checked either count
against the seven entries in `VIEW_TO_PATH` that actually render a list of records —
which takes about a minute and would have caught it the first time.

### Checks run

- Full suite — **31 suites, 773 tests, pass**
- `CI=true npm run build` — **compiled successfully**, main bundle **+133 B** gzipped

The sort machinery itself is covered by `sortOrders`' and SAM's tests. The two new
call sites and the accessor bags are in `Alfred.jsx`, which has none, so the
`title`-tiebreaker behaviour needs the by-hand check below.

---

### For the routing thread — `executionEditReturn` is a fourth return-address mechanism

**Named here rather than left to be discovered at slice 3.**

Step 12.2 added `executionEditReturn` to `Alfred.jsx`: a slot holding
`{ executionId, itemId }`, written when the execution screen opens its underlying item
and read once when Back leaves that item.

The routing thread's own inventory lists three return-address mechanisms to unpick —
`itemHistoryStack`, `intentionReturnView`, and `previousView` — and instructs:

> "Until then, keep all three, and **add no new writers**. Every new `setPreviousView`
> call is another site to unpick later. If a new screen needs a return address after
> slice 2 lands, it should use `navigate(-1)`."

**This is not a new `setPreviousView` writer** — that rule is honoured. But it is a
fourth slot of the same kind, so it belongs on the same list.

Two things in its favour when slice 3 gets to it:

- **It holds an ID, not an object**, which is the direction slice 2's own list asks for
  ("`execution-detail` holds an object, not an id — convert to id-plus-lookup").
- **It should be the cheapest of the four to remove.** One writer, one reader, and its
  replacement already exists: the execution URL carries its id, so `navigate(-1)` — or
  an explicit `goToExecution` — covers it with no lookup to invent.

The one thing to preserve when it goes: the return must reach `goToExecution`, **not**
`setView("execution-detail")`. `viewToPath("execution-detail")` is deliberately always
the bare, id-less `/schedule/execution`, so `setView` renders the right screen under an
address that has lost the id, and a refresh from there redirects to Schedule. It looks
correct until the refresh, which is why it is written down.

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
