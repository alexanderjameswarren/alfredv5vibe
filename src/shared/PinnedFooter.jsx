/**
 * The one pinned action footer — Alfred Clipboard, Step 17g.
 *
 * Six screens end in a row of Save / Cancel / Archive-style buttons that sits flush
 * on top of the Capture bar while the page scrolls and releases at the bottom to sit
 * at the end of its card. They are all this component now.
 *
 * ── Why a component, after three rounds of fixing this in six places ─────────
 *
 * The geometry was six copies of the same class list. Each round of fixes had to
 * land in all six, and one round did not:
 *
 *   17d  the sticky offset was 112/128px over a bar 63/83px tall, so every footer
 *        floated with the page scrolling through the gap underneath.
 *   17e  `pt-2 pb-3` put 8px above the buttons and 12px below, and a `-mb-*` was
 *        added to cancel each card's bottom padding.
 *   17f  that `-mb-*` turned out to be losing a specificity fight (below). It was
 *        fixed on the inbox detail page only, because the claim that the other five
 *        were unaffected was WRONG: the item, intention and context forms all put
 *        their footer inside a `space-y-*` wrapper, and all three were affected.
 *
 * Three rounds, and the third was wrong about which screens had the bug. So the
 * geometry lives in one place, and "do the six screens agree" stops being a question
 * anybody has to check.
 *
 * ── 🛑 THE SPECIFICITY TRAP THIS EXISTS TO CLOSE ─────────────────────────────
 *
 * `space-y-3` on a container compiles to:
 *
 *   .space-y-3 > :not([hidden]) ~ :not([hidden]) { margin-bottom: calc(0.75rem * 0) }
 *
 * — specificity (0,3,0), because each `:not([hidden])` carries an attribute
 * selector's weight. A utility class like `.-mb-3` is (0,1,0). So the container's
 * spacing utility silently set `margin-bottom: 0` on the footer and won, leaving the
 * card's bottom padding stacked underneath it: equal padding above the buttons and
 * padding-plus-the-card's below.
 *
 * That `space-y-*` sets `margin-bottom` at all is the surprise. It is there to
 * support `space-y-reverse` and is zero in the normal direction, so it is invisible
 * until something else wants that property.
 *
 * So the cancelling margins carry `!important`, in ONE rule in index.css, which
 * beats those selectors and cannot be defeated by any utility a container happens to
 * carry — `space-y-*`, `space-x-*`, `divide-y-*`, or whatever the next one is.
 *
 * This component sets the two values that vary by screen as custom properties, and
 * the rule consumes them; a media query picks the right one per breakpoint, so the
 * whole thing stays responsive with no JavaScript measuring anything. The vertical
 * padding stays inline, because it is one constant and because that makes it
 * readable by `getComputedStyle` in a test — "equal above and below" is asserted as a
 * rendered result rather than as a class name.
 *
 * ── The one number each screen passes ────────────────────────────────────────
 *
 * `inset` is its container's own padding, and it is used for ALL of the left, right
 * and bottom cancellation — so those three can never disagree with each other. The
 * vertical padding is one constant used for both sides, so above and below are equal
 * by construction rather than by two numbers that happen to match.
 *
 * ⚠️ It assumes no wrapper BETWEEN the footer and the padded container adds bottom
 * padding of its own. That holds on all six screens: the wrappers in between are
 * spacing-only (`space-y-*`, `flex flex-col gap-*`). A wrapper with its own bottom
 * padding would need cancelling too, and this would not know about it.
 */

import { useContext } from "react";
import { EditCardContext } from "./EditCard";

/**
 * Space above and below the footer's buttons, in px.
 *
 * ONE constant, applied to both sides below, so "equal above and below" is a
 * property of the code rather than of two numbers that currently match. It was
 * `pt-2 pb-3` — 8px and 12px — until Step 17e.
 */
export const PINNED_FOOTER_PAD_Y = 12;

/**
 * The inset and the bottom radius are NOT props. They come from the `EditCard` this
 * footer is inside, through context — see that file. A footer with no card around it
 * has nothing to cancel and no corner to match.
 *
 * @param {boolean} [pinned]
 *   False renders a plain, unpinned button row. Three of the six screens render in
 *   two places: one where the form owns the screen and a pinned footer is right, and
 *   one where it is a panel above other content and a pinned footer would hover over
 *   things it does not belong to.
 * @param {string} [className]  The background, for a footer with no card around it.
 *   Ignored inside an `EditCard`, which supplies its own surface.
 * @param {string} [unpinnedClassName]  Extra classes for the unpinned row, so each
 *   screen keeps exactly the spacing it had there.
 */
export default function PinnedFooter({
  pinned = true,
  className = "",
  unpinnedClassName = "",
  children,
}) {
  // The card this footer belongs to, if any. Nothing here is passed in per screen:
  // the card knows its own padding and its own corner radius, and those are exactly
  // the two things the footer has to agree with it about.
  const card = useContext(EditCardContext);

  if (!pinned) {
    return <div className={`flex flex-wrap items-center gap-2 ${unpinnedClassName}`}>{children}</div>;
  }

  // No card means no padding to cancel and no corner to match — which is right for the
  // two add-to-collection pages, whose footers sit on the page background.
  const [base, sm] = card?.inset ?? [0, 0];
  const bottomRadiusClassName = card?.bottomRadiusClassName ?? "";
  const surface = card ? "bg-card" : className;

  return (
    <div
      className={`pinned-footer flex flex-wrap items-center gap-2 border-t border-border ${bottomRadiusClassName} ${surface}`}
      style={{
        // Read by the media query in index.css, which picks one of them as
        // `--pf-now`. Plain px so there is no unit arithmetic to get wrong.
        "--pf-inset": `${base}px`,
        "--pf-inset-sm": `${sm}px`,
        // The margins and horizontal padding that consume these live in
        // `.pinned-footer` in index.css, NOT here. They were inline at first, to beat
        // the container's spacing utilities on specificity alone — but jsdom's CSS
        // parser silently DISCARDS `calc(-1 * var(…))` from an inline style, so the
        // declarations vanished in tests while working in the browser. A mechanism
        // that cannot be asserted is a mechanism that will break quietly, so they
        // moved to the stylesheet with `!important`, which beats the same selectors
        // and is visible to a test that reads the rule.
        //
        // ONE value, used twice. Equal above and below by construction.
        paddingTop: `${PINNED_FOOTER_PAD_Y}px`,
        paddingBottom: `${PINNED_FOOTER_PAD_Y}px`,
      }}
    >
      {children}
    </div>
  );
}

/** Pushes whatever follows it to the far end of the footer. */
export function FooterSpacer() {
  return <span className="flex-1" />;
}
