/**
 * The one full-screen edit card — Alfred Clipboard, Step 17h.
 *
 * Four screens are a form that owns the screen: the inbox detail page, the item edit
 * screen, the intention edit screen, and the Context form when it replaces the
 * Contexts list. They are all this component now.
 *
 * It also hands its geometry DOWN to the `PinnedFooter` inside it, through context.
 * The card's padding and the footer's inset are the same number, and they used to be
 * written out twice — so now neither is written at a call site at all.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The four cards had drifted: three radii, three shadows, three paddings, two ways of
 * spelling white. Nothing was making them agree, so nothing kept them agreeing.
 *
 * And the drift had a visible consequence beyond looking untidy. A released footer
 * stretches to the card's edges, and its square bottom corners painted over the
 * card's rounded ones — visible on the item edit screen, invisible on the inbox
 * detail page only because that footer happened to carry a matching `rounded-b-xl`.
 * One component now supplies both the radius and the footer's matching bottom radius,
 * so that cannot come apart.
 *
 * ── The look, and why this one ───────────────────────────────────────────────
 *
 * `border-2 border-primary rounded-lg shadow-md`, on `bg-card`.
 *
 * Alex offered the inbox detail page's `rounded-xl` for all four. The counts decided
 * against it: `rounded-xl` appeared **0** times in Alfred.jsx and `rounded-lg` **92**;
 * `shadow-md` 53 times against `shadow-lg`'s 4. Three of the four cards were already
 * `rounded-lg shadow-md`. Adopting `rounded-xl` would have made these four consistent
 * with each other and the odd ones out everywhere else, which is the opposite of the
 * point. The inbox detail page's mockup specified a 12px radius; 8px is a 4px
 * deviation from a canvas artboard in exchange for matching the whole app.
 *
 * ── 🛑 WHY NOT `overflow: clip` ──────────────────────────────────────────────
 *
 * Clipping the card to its own radius is the general fix, and it was the first
 * instruction. It would break the intention edit screen.
 *
 * `RecurrenceQuickSelect` opens an absolutely-positioned dropdown (`absolute z-50 mt-1
 * w-full`) and sits near the bottom of that form; `ItemPicker` does the same a few
 * fields above it. Overflow clipping applies to absolutely-positioned descendants
 * whose containing block is inside the clipped box, so both dropdowns would be cut off
 * at the card's edge. `overflow: clip` rather than `hidden` would have kept `position:
 * sticky` working — it establishes no scroll container — but it clips popovers either
 * way, and `overflow-clip-margin` cannot help a list of unknown height.
 *
 * So the equivalent: the footer is given the card's own bottom radius, from the same
 * constant, so its corners can never disagree with the card's. The problem was never
 * general overflow — it was one known element stretched to the card's edges — and this
 * fixes exactly that, with nothing else clipped.
 */

import { createContext } from "react";

/**
 * Border, radius, shadow, surface and padding. Not overridable: a caller that wants
 * different padding wants a different component, and the footer's inset below is
 * derived from this one.
 */
export const EDIT_CARD_CLASS =
  "bg-card border-2 border-primary rounded-lg shadow-md p-4 sm:p-6";

/**
 * The padding above, in px, as `[phone, sm]` — `p-4 sm:p-6`.
 *
 * ⚠️ MUST MATCH the padding classes in EDIT_CARD_CLASS. It is what the footer cancels
 * in order to reach the card's edges, so a mismatch shows as a strip of card below a
 * released footer, or a footer hanging past it. They are in the same module so the
 * pairing is visible, and `editCard.test.jsx` derives one from the other and fails if
 * they ever come apart.
 */
export const EDIT_CARD_INSET = [16, 24];

/**
 * The footer's bottom corners, matching the card's `rounded-lg`.
 *
 * This is the whole fix for the squared-off corner: the footer is stretched to the
 * card's edges, so it must round where the card rounds. One constant, two places that
 * cannot drift.
 */
export const EDIT_CARD_FOOTER_RADIUS = "rounded-b-lg";

/**
 * What a `PinnedFooter` inside this card needs to know about it.
 *
 * Supplied through context rather than as props at each call site, and that is the
 * whole guarantee: the footer takes its inset and its bottom radius FROM the card, so
 * no screen states either number and no screen can state it wrongly. A `PinnedFooter`
 * outside any `EditCard` — the two add-to-collection pages, which sit on the page
 * background — reads nothing and correctly has nothing to cancel.
 */
export const EditCardContext = createContext(null);

const CARD_GEOMETRY = {
  inset: EDIT_CARD_INSET,
  bottomRadiusClassName: EDIT_CARD_FOOTER_RADIUS,
};

/**
 * @param {string} [className]  Layout only — width, centring, how children are
 *   stacked. Not the look, which this component owns.
 */
export default function EditCard({ children, className = "" }) {
  return (
    <EditCardContext.Provider value={CARD_GEOMETRY}>
      <div className={`${EDIT_CARD_CLASS} ${className}`}>{children}</div>
    </EditCardContext.Provider>
  );
}
