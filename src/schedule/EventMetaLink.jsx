import React from "react";

/**
 * One metadata link in an EventCard's chip row — Step 12.9.
 *
 * Shared by the intention and item links because they differ only in icon and
 * wording, and because the name-collapsing rule has to be applied identically
 * to both or the row starts contradicting itself.
 *
 * The icon carries the record TYPE, replacing an "Intention:" / "Item:" word
 * prefix. It comes from OBJECT_ICONS, the one vocabulary the nav, the cards
 * and the page headers all read from — so the glyph on this chip is the same
 * glyph on the tab that lists these records and on the header of the record
 * itself. That repetition is the point: it is what makes the association
 * learnable.
 *
 * `name` is dropped when it equals the card's own title, leaving the icon
 * alone. Most events carry no `text` of their own — `moveToPlanner` does not
 * set one — so their title IS the intention display, and an intention with no
 * text displays as its linked item's name. Spelling the name out would
 * therefore print the same string twice on the majority of rows. The link
 * stays, because reaching the record is the whole point; only the redundant
 * half goes. `title`/`aria-label` always name the destination in full, which
 * is what keeps the collapsed form readable to a screen reader and on hover.
 *
 * `guard` is for the edit form, where leaving the screen discards whatever is
 * typed. Display mode passes none.
 *
 * Deliberately not 44px tall, unlike every button in the row strip. Inline
 * metadata cannot be without wrecking the line, and these are secondary
 * affordances: the whole card and Start/Continue remain the touch targets, and
 * `py-1` buys enough slop that a near-miss lands on the card — which opens the
 * event — rather than between two links.
 */
export default function EventMetaLink({ icon, name, showName, onClick, guard, title }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (guard && !guard()) return;
        onClick();
      }}
      title={title}
      aria-label={title}
      className="inline-flex items-center gap-1 py-1 text-left text-primary hover:text-primary-hover"
    >
      {icon}
      {/* max-w + truncate because the row is the card's third line, not a
          paragraph: a long item name wraps the chips onto two rows and then
          still overflows. The full name stays in the tooltip either way. */}
      {showName && <span className="max-w-[14rem] truncate">{name}</span>}
    </button>
  );
}
