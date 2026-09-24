# Inbox list mockups

Approved by Alex, 2026-09-24. Static pictures made in a claude.ai canvas; ignore
any console error about support.js.

## The list, top to bottom

1. "Inbox" heading, styled like the Items and Intentions pages.
2. Source filter pills: one per source type that currently has items, with a
   count (Claude, Task, Clipboard, Capture, Email, CLI). No "All" pill. Behaviour
   must copy the app's existing tag filter exactly: nothing selected shows
   everything; selecting one or more narrows the list; a "Clear" pill appears
   when anything is selected; a collapsing pill appears when there are more than
   four. Reuse the existing component rather than rebuilding it.
3. The existing search, "Sort by" and direction button.
4. Cards, styled like the Schedule cards:
   - Title: the capture, at most two lines.
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
6. The capture bar, unchanged.

Phone: one column in the same order; each card's action button and trash icon sit
on a row beneath the card's text.
