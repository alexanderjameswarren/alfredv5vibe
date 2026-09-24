import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import PinnedFooter, { FooterSpacer, PINNED_FOOTER_PAD_Y } from "./PinnedFooter";
import EditCard, { EDIT_CARD_INSET, EDIT_CARD_FOOTER_RADIUS } from "./EditCard";

// ── What these tests can and cannot establish ────────────────────────────────
//
// jsdom loads no stylesheet, so nothing here can measure a Tailwind class. Each part
// of the geometry is therefore checked where it actually lives:
//
//   the space ABOVE AND BELOW the buttons is an inline style, so `getComputedStyle`
//     reports it — a rendered result, not a class name someone read;
//   the CANCELLING MARGINS are one `!important` rule in index.css, so the rule is read
//     and asserted directly, including the `!important` that is the whole point;
//   the INSET and the BOTTOM RADIUS come from the card through context, so they are
//     checked by rendering inside a real EditCard.

const footer = () => screen.getByTestId("footer-children").parentElement;

const renderBare = (props = {}) =>
  render(
    <PinnedFooter {...props}>
      <span data-testid="footer-children">Save</span>
    </PinnedFooter>,
  );

const renderInCard = (props = {}) =>
  render(
    <EditCard>
      <div>fields</div>
      <PinnedFooter {...props}>
        <span data-testid="footer-children">Save</span>
      </PinnedFooter>
    </EditCard>,
  );

describe("equal space above and below the buttons", () => {
  it("is the same whether or not there is a card, and equal either way", () => {
    for (const mount of [renderBare, renderInCard]) {
      const { unmount } = mount();
      const style = window.getComputedStyle(footer());
      expect(style.paddingTop).toBe(`${PINNED_FOOTER_PAD_Y}px`);
      expect(style.paddingBottom).toBe(`${PINNED_FOOTER_PAD_Y}px`);
      // The thing that actually matters, stated as itself.
      expect(style.paddingTop).toBe(style.paddingBottom);
      unmount();
    }
  });

  it("is 12px, which is what `py-3` used to be", () => {
    expect(PINNED_FOOTER_PAD_Y).toBe(12);
  });
});

describe("what it takes from the card", () => {
  it("publishes the card's padding as the inset, both breakpoints", () => {
    // Not passed at any call site. The card knows its own padding; the footer has to
    // cancel exactly that much to reach its edges, so it asks the card.
    renderInCard();
    const el = footer();
    expect(el.style.getPropertyValue("--pf-inset")).toBe(`${EDIT_CARD_INSET[0]}px`);
    expect(el.style.getPropertyValue("--pf-inset-sm")).toBe(`${EDIT_CARD_INSET[1]}px`);
  });

  it("takes the card's bottom corner radius", () => {
    // 🛑 THE DEFECT THIS CLOSED. A released footer is stretched to the card's edges, so
    // its SQUARE bottom corners painted over the card's ROUNDED ones and the card
    // looked like it had lost its corner. It showed on the item edit screen and not on
    // the inbox detail page, purely because that one footer carried a matching radius
    // by hand.
    renderInCard();
    expect(footer()).toHaveClass(EDIT_CARD_FOOTER_RADIUS);
  });

  it("takes the card's surface, so it cannot be a different white", () => {
    renderInCard();
    expect(footer()).toHaveClass("bg-card");
  });

  it("has nothing to cancel and no corner to match outside a card", () => {
    // Which is right for the two add-to-collection pages: their footers sit on the page
    // background, with no card around them.
    renderBare({ className: "bg-background" });
    const el = footer();
    expect(el.style.getPropertyValue("--pf-inset")).toBe("0px");
    expect(el.style.getPropertyValue("--pf-inset-sm")).toBe("0px");
    expect(el.className).not.toMatch(/rounded/);
    expect(el).toHaveClass("bg-background");
  });
});

describe("the cancelling margins", () => {
  const css = fs.readFileSync(path.join(__dirname, "index.css"), "utf8");
  const rule = css.slice(css.indexOf(".pinned-footer {"), css.indexOf("@media (min-width: 640px)"));

  it("cancel the inset on all three sides, from one value", () => {
    for (const side of ["margin-left", "margin-right", "margin-bottom"]) {
      expect(rule).toContain(`${side}: calc(-1 * var(--pf-now)) !important;`);
    }
  });

  it("keep the `!important` that is the entire point", () => {
    // `space-y-3` on a container compiles to
    // `.space-y-3 > :not([hidden]) ~ :not([hidden]) { margin-bottom: 0 }` at
    // specificity (0,3,0) — each `:not([hidden])` carries an attribute selector's
    // weight — which beat the old `-mb-3` utility at (0,1,0). Three screens silently
    // kept their card's bottom padding under a released footer because of it. An edit
    // that drops these reopens that exact hole.
    // Counted as DECLARATIONS, not as the word: the comment above them explains the
    // trap at length and says "!important" twice itself.
    const declarations = rule.match(/^\s*[a-z-]+:[^;]*!important;$/gm) || [];
    expect(declarations).toHaveLength(3);
    for (const d of declarations) {
      expect(d).toMatch(/^\s*margin-(left|right|bottom):/);
    }
  });

  it("replace the horizontal padding they undid", () => {
    expect(rule).toContain("padding-left: var(--pf-now);");
    expect(rule).toContain("padding-right: var(--pf-now);");
  });

  it("leave margin-top alone, because the container's own spacing sets that gap", () => {
    expect(rule).not.toContain("margin-top");
  });

  it("switch inset and offset at the sm breakpoint, and only there", () => {
    const media = css.slice(css.indexOf("@media (min-width: 640px)"));
    expect(media).toContain("--pf-now: var(--pf-inset-sm, 0px);");
    expect(media).toContain("bottom: 83px;");
  });
});

describe("the unpinned form", () => {
  it("is a plain row with none of the pinned geometry", () => {
    // Three screens render in two places: one where the form owns the screen, and one
    // where it is a panel above other content that a pinned footer would hover over.
    renderInCard({ pinned: false });
    const el = footer();
    expect(el).not.toHaveClass("pinned-footer");
    expect(el.getAttribute("style")).toBeNull();
  });

  it("keeps whatever spacing that screen had there", () => {
    // ItemCard and ContextForm had `pt-2`; IntentionCard had none. Preserved exactly
    // rather than unified, because nothing asked for those screens to change.
    renderInCard({ pinned: false, unpinnedClassName: "pt-2" });
    expect(footer()).toHaveClass("pt-2");
  });
});

describe("FooterSpacer", () => {
  it("pushes what follows it to the far end", () => {
    render(
      <EditCard>
        <PinnedFooter>
          <span data-testid="footer-children">Process</span>
          <FooterSpacer />
          <span>Discard</span>
        </PinnedFooter>
      </EditCard>,
    );
    expect(footer().querySelector(".flex-1")).toBeInTheDocument();
  });
});
