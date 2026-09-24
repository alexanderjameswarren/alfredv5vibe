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
3. The existing search, "Sort by" and direction button.
4. Cards, styled like the Schedule cards:
   - Title, at most two lines. For an ENRICHED item it is Claude's suggested name —
     the suggested item name, else the suggested intention name — falling back to
     the captured text. Unenriched items and tasks show the captured text. Revised
     2026-09-24 (Step 21b): the suggestion is what the row will become and what
     Process is about to create, so the title and the action agree.
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
6. The capture bar. Its Capture button carries the StickyNote icon before its
   label, matching the Capture source tab — Step 21b. The source icon for a
   hand-typed capture is StickyNote, NOT a pencil: the pencil is reserved for
   editing (the capture-text pencil on the detail page), and one glyph meaning two
   things on adjacent screens was the problem.

Phone: one column in the same order; each card's action button and trash icon sit
on a row beneath the card's text.
