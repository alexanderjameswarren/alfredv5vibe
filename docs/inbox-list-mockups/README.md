# Inbox list mockups

Approved by Alex, 2026-09-24. Static pictures made in a claude.ai canvas; ignore
any console error about support.js.

## The list, top to bottom

1. "Inbox" heading, styled like the Items and Intentions pages.
2. Source filter TABS — revised 2026-09-24 (Step 21b). They were pills reusing the
   tag filter; that read wrong, because they sat directly above cards carrying real
   tag pills and two different things looked identical. A tab says "this is a view
   of one list"; a pill says "this is a property of these rows".

   The underline tab component from the front page ("Active (1) | Today (4)"),
   now `UnderlineTabs` and shared by three screens. Left to right, in a FIXED
   order that never changes: **All**, Capture, Claude, Clipboard, Task, CLI,
   Email. Each carries its source icon and a count.

   - "All" is always shown and is the default.
   - A source tab appears only while that source has items, so CLI and Email
     usually do not.
   - If the selected tab's source empties — after processing its last item, say —
     the selection falls back to All.
   - The order is deliberately NOT sorted by count or alphabetically, unlike the
     tag pills: six sources never change, so the row can be learned by position.
   - "All" carries the same Inbox glyph the top navigation's Inbox tab uses.
   - **Below `lg` each tab shows only its icon and its count** (Step 21c), the same
     rule and the same breakpoint the top navigation uses for its ten tabs. The
     full name stays as the accessible name and as a hover title. The row wraps
     rather than scrolling sideways — a tab you have to swipe to find is not one
     tap away.
3. The existing search, "Sort by" and direction button.
4. Cards, styled like the Schedule cards:
   - Title, at most two lines, at the Schedule cards' weight — `font-medium`, not
     bold. It shipped bold in Step 21 and was corrected in Step 22: it was not
     wrong in isolation, it was wrong beside every other list in the app.
   - What the title SAYS, in this order:
     - A **task**: `"<task name> · <run date>"` from `source_metadata` — e.g.
       "Weekly DJ review · Sep 25" — falling back to the captured text if
       `task_name` is missing. Added 2026-09-25 (Step 22). A task's text is the
       run's OUTPUT, written for a Claude session to pick up, so its first fifty
       characters are the least identifying part of it: two runs of the same
       weekly task read identically and are not the same row. This wins over the
       suggestion below, because a task can be enriched later and would otherwise
       lose the only thing that told it apart from last week's.
     - An **enriched** row: Claude's suggested name — the suggested item name, else
       the suggested intention name. Revised 2026-09-24 (Step 21b): the suggestion
       is what the row will become and what Process is about to create, so the
       title and the action agree.
     - **Anything else**: the captured text.
   - Meta line: source icon and name, time, status ("Enriched", "Not enriched",
     or for tasks "Needs a Claude session").
   - Preview line (enriched items): context chip (beige, folder icon), "New item"
     in brown with the item icon and/or "New intention" in sage with the
     intention icon, a date chip if one is set, and tag pills.
   - Right side: one action button plus the trash icon. Enriched: Process
     (brown, check icon), which files the item in one tap using Claude's
     suggestions. Task: Copy (sage, copy icon). Not enriched: no button; tapping
     the card opens the detail page.
5. "Recently archived (n)": a collapsible section styled like "Items (26)",
   covering the last seven days, with "Show all" on the right. Each row is
   muted, shows the source icon, the title, what happened ("Processed",
   "Processed into an intention", "Discarded" in red) and when, with an Undo
   button.

   Built 2026-09-25 (Step 22), with these decisions, all recorded in
   `src/utils/inboxArchive.js`:

   - It sits OUTSIDE the empty-inbox branch. An empty inbox is when it matters
     most — you have just processed the last capture, and "Empty inbox — this is
     success, not failure" with no way back would make a mistaken tap
     unrecoverable on the one screen that celebrates it.
   - It is NOT filtered by the source tabs or the search box. Those belong to the
     live list; a history that hid the row you were looking for because a tab was
     still selected is the trap the derived source selection exists to avoid.
   - Newest departure first — the opposite of the live inbox, which is a queue
     worked from the front. This is a history, and the only row you are likely to
     want is the one you just archived.
   - The date is the DEPARTURE, not the capture. A capture made in June and
     discarded this morning belongs at the top.
   - Collapsed by default, and "Show all" is hidden when there is nothing older to
     show.
   - ⚠️ **The Undo warns on a processed row.** Un-archiving puts the capture back;
     it cannot remove the item, intention or event it turned into, so processing it
     again would give you two copies of everything. This is why `handleInboxSave`
     never offered an Undo of its own. The button is here as asked, and it asks
     first, naming what is already out there. A discarded capture created nothing,
     so it just goes back.
   - "What happened" is read from `source_inbox_id` on the records themselves,
     regardless of whether those have since been archived — it is a history. A
     processed row with nothing pointing back reads as plain "Processed" rather
     than guessing; that happens honestly, because triage can add a capture to a
     collection and because the FK is ON DELETE SET NULL.
   - A row archived with no reason at all — from before migration 066 gave the
     column a job — reads "Archived", and sits behind "Show all" because it has no
     timestamp to place it in the window.
6. The capture bar. Its Capture button carries the Capture source glyph before its
   label, so the button and the Capture tab match — Step 21b.

   That glyph is `Send` — the paper aeroplane — as of Step 21c, and it has been two
   other things: a pencil, which is also the EDIT control on the detail page, and
   then StickyNote, which at 14px is nearly indistinguishable from the item icon on
   the same card. An aeroplane is a silhouette rather than an outlined rectangle, so
   it survives 14px, and it reads as the gesture: you typed something and sent it to
   Alfred. Do not change it back — the reasoning is in docs/design-system.md.

Phone: one column in the same order; each card's action button and trash icon sit
on a row beneath the card's text.
