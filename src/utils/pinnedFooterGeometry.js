/**
 * The numbers behind the pinned action footer — Alfred Clipboard, Step 17g.
 *
 * Pure data, in its own module, so the component, the six call sites and the tests
 * all read the same values rather than three sets that have to agree.
 */

/**
 * Space above and below the footer's buttons, in px.
 *
 * ONE constant, applied to both sides by `PinnedFooter`, so "equal above and below"
 * is a property of the code rather than of two numbers that currently match. It was
 * `pt-2 pb-3` — 8px and 12px — until Step 17e.
 */
export const PINNED_FOOTER_PAD_Y = 12;

/**
 * Each screen's container padding, in px, as `[phone, sm]`.
 *
 * ⚠️ THESE MUST MATCH THE CONTAINER'S OWN PADDING CLASSES. The footer cancels this
 * much margin to reach the container's edges, so a mismatch shows up as either a
 * strip of container below the released footer or the footer hanging past it.
 * `pinnedFooterGeometry.test.js` reads both out of the source and fails if they ever
 * drift apart — the check exists because the drift is invisible until someone
 * scrolls to the bottom of that one screen.
 *
 * `[0, 0]` is not "unset": it is a footer with no padded card around it, which has
 * nothing to cancel and nothing to replace.
 */
export const FOOTER_INSETS = {
  // ItemCard and IntentionCard: p-3 sm:p-4
  itemCard: [12, 16],
  intentionCard: [12, 16],
  // ContextForm: p-4 sm:p-6
  contextForm: [16, 24],
  // InboxDetailView: p-4 sm:p-7
  inboxDetail: [16, 28],
  // The two add-to-collection pages sit on the page background, not in a card.
  onPageBackground: [0, 0],
};
