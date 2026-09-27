# Inbox detail page mockups

Approved by Alex, 2026-09-24. Designed in a claude.ai canvas; these files are the
artboard sources. They are static pictures: open them in a browser for the look,
or read the markup for exact colors, spacing and structure. They reference a
canvas runtime script that is not in this repo, so ignore any console error about
support.js.

## The page, top to bottom

1. "Back" link, then one centered form card with the brown outline, matching the
   existing item and intention edit screens.
2. Source pill (Capture, Claude, Clipboard, CLI, Email) and capture time.
3. Context: a dropdown, prominent and first. Tags directly underneath in the same
   section, using the existing "Search or add a tag..." control with removable pills.
4. Two push-button toggles side by side: "New Item" (brown, file icon) and
   "New Intention" (sage, the intentions icon). Either, both, or neither can be on.
   They are preselected from the enrichment (suggest_item, suggest_intent).
5. "New Item" section, shown only when that toggle is on: Name, Description, and
   the existing element editor, completely unchanged (drag handle, text, red x,
   description, Header/Bullet/Step, Qty, Can buy, per-step notify minutes, "+"
   between elements, "+ Add Element").
6. "New Intention" section, shown only when that toggle is on: Name, Details (a
   long-text description, new), and When: Someday, a date, or Repeat.
7. "Original capture": the full captured text, always shown, last.
8. Floating footer pinned to the bottom of the card, above the global capture
   bar, exactly like the existing edit screens: Process (brown) and Cancel (beige)
   on the left, Discard (red) on the right. Every button has an icon.

## Rules

- No instruction or explanatory text on the page.
- Collections are hidden on this page for now.
- No Enrich or Re-enrich buttons.
- Colors: brown #7A4B36 (item, primary), sage #6F918C (intention), beige #E5D3C6
  (secondary), red #C75B55 (discard). Reuse the app's existing tokens where they
  exist rather than these hex values.
- Phone: one column in the same order; the footer buttons stay pinned at the
  bottom.

## Files

- keep-reflection-note.html: New Item only.
- both-alfred-bug.html: New Item and New Intention.
- do-home-errand.html: New Intention only, with Details and a date.
- both-recurring-routine.html: both, with a daily repeat and elements.
- phone-alfred-bug.html: phone layout.
- full-recipe-duck-mole.html: a real 36-element recipe, to check the element
  editor at full length.
- full-routine-micro-workout.html: a long routine (exercise names are
  placeholders; the board is clipped at the bottom).
