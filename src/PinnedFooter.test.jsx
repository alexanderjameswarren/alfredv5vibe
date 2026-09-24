import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import PinnedFooter, { FooterSpacer } from "./PinnedFooter";
import { FOOTER_INSETS, PINNED_FOOTER_PAD_Y } from "./utils/pinnedFooterGeometry";

// ── What these tests can and cannot establish ────────────────────────────────
//
// jsdom loads no stylesheet, so nothing here can measure a Tailwind class. Each part
// of the geometry is therefore checked where it actually lives:
//
//   the space ABOVE AND BELOW the buttons is an inline style, so `getComputedStyle`
//     reports it — a rendered result, not a class name someone read;
//   the CANCELLING MARGINS are one `!important` rule in index.css, so the rule is
//     read and asserted directly, including the `!important` that is the whole point;
//   the PAIRING between each screen's inset and its container's real padding is in
//     pinnedFooterGeometry.test.js, which reads both out of the source.

const footer = () => screen.getByTestId("footer-children").parentElement;

function renderFooter(props = {}) {
  return render(
    <PinnedFooter {...props}>
      <span data-testid="footer-children">Save</span>
    </PinnedFooter>,
  );
}

describe("equal space above and below the buttons", () => {
  it("is measured the same on every screen, because it is one constant used twice", () => {
    for (const [name, inset] of Object.entries(FOOTER_INSETS)) {
      const { unmount } = renderFooter({ inset });
      const style = window.getComputedStyle(footer());
      expect(style.paddingTop).toBe(`${PINNED_FOOTER_PAD_Y}px`);
      expect(style.paddingBottom).toBe(`${PINNED_FOOTER_PAD_Y}px`);
      // The thing that actually matters, stated as itself.
      expect(style.paddingTop).toBe(style.paddingBottom);
      unmount();
      expect(name).toBeTruthy();
    }
  });

  it("is 12px, which is what `py-3` used to be", () => {
    // Pinned as a number so a change to the constant is a deliberate act.
    expect(PINNED_FOOTER_PAD_Y).toBe(12);
  });
});

describe("the inset that makes a released footer finish on the container's border", () => {
  it("publishes both breakpoints as custom properties", () => {
    renderFooter({ inset: FOOTER_INSETS.itemCard });
    const el = footer();
    expect(el.style.getPropertyValue("--pf-inset")).toBe("12px");
    expect(el.style.getPropertyValue("--pf-inset-sm")).toBe("16px");
  });

  it("consumes them from ONE rule, so the three sides cannot disagree", () => {
    // 🛑 THE BUG THIS COMPONENT EXISTS FOR, asserted where it actually lives.
    //
    // `space-y-3` on a container compiles to
    // `.space-y-3 > :not([hidden]) ~ :not([hidden]) { margin-bottom: 0 }` at
    // specificity (0,3,0) — each `:not([hidden])` carries an attribute selector's
    // weight — which beat the old `-mb-3` utility at (0,1,0). Three screens silently
    // kept their card's bottom padding under a released footer because of it.
    //
    // jsdom loads no stylesheet, so this reads index.css and checks the rule itself:
    // all three margins cancel `--pf-now`, and all three carry `!important`, which is
    // what outranks the container. A future edit that drops the `!important` reopens
    // the exact hole this closed, and fails here.
    const css = fs.readFileSync(path.join(__dirname, "index.css"), "utf8");
    const rule = css.slice(css.indexOf(".pinned-footer {"), css.indexOf("@media (min-width: 640px)"));
    for (const side of ["margin-left", "margin-right", "margin-bottom"]) {
      expect(rule).toContain(`${side}: calc(-1 * var(--pf-now)) !important;`);
    }
    // And the padding it undid is replaced from the same value.
    expect(rule).toContain("padding-left: var(--pf-now);");
    expect(rule).toContain("padding-right: var(--pf-now);");
    // margin-TOP is deliberately NOT set: the container's own spacing puts the gap
    // above the footer, and that is wanted.
    expect(rule).not.toContain("margin-top");
  });

  it("switches inset at the sm breakpoint, and only there", () => {
    const css = fs.readFileSync(path.join(__dirname, "index.css"), "utf8");
    const media = css.slice(css.indexOf("@media (min-width: 640px)"));
    expect(media).toContain("--pf-now: var(--pf-inset-sm, 0px);");
    expect(media).toContain("bottom: 83px;");
  });

  it("has nothing to cancel when there is no card around it", () => {
    renderFooter({ inset: FOOTER_INSETS.onPageBackground });
    const el = footer();
    expect(el.style.getPropertyValue("--pf-inset")).toBe("0px");
    expect(el.style.getPropertyValue("--pf-inset-sm")).toBe("0px");
  });
});

describe("every screen gets identical geometry", () => {
  it("differs ONLY in the inset", () => {
    // The whole point of extracting this: "do the six screens agree" stops being a
    // question anybody has to check by reading six class lists.
    const shapes = Object.values(FOOTER_INSETS).map((inset) => {
      const { unmount } = renderFooter({ inset });
      const el = footer();
      const style = { ...el.style };
      const shape = {
        className: el.className,
        paddingTop: el.style.paddingTop,
        paddingBottom: el.style.paddingBottom,
      };
      unmount();
      expect(style).toBeTruthy();
      return shape;
    });
    for (const shape of shapes) {
      expect(shape).toEqual(shapes[0]);
    }
  });

  it("carries the sticky class and the top border on all of them", () => {
    renderFooter({ inset: FOOTER_INSETS.inboxDetail });
    expect(footer()).toHaveClass("pinned-footer", "border-t", "border-border");
  });

  it("lets a screen add a surface without touching the geometry", () => {
    renderFooter({ inset: FOOTER_INSETS.inboxDetail, className: "bg-card rounded-b-xl" });
    const el = footer();
    expect(el).toHaveClass("bg-card", "rounded-b-xl", "pinned-footer");
    expect(el.style.paddingTop).toBe("12px");
  });
});

describe("the unpinned form", () => {
  it("is a plain row with none of the pinned geometry", () => {
    // Three screens render in two places: one where the form owns the screen, and one
    // where it is a panel above other content that a pinned footer would hover over.
    renderFooter({ pinned: false, inset: FOOTER_INSETS.itemCard });
    const el = footer();
    expect(el).not.toHaveClass("pinned-footer");
    expect(el.getAttribute("style")).toBeNull();
  });

  it("keeps whatever spacing that screen had there", () => {
    // ItemCard and ContextForm had `pt-2`; IntentionCard had none. Preserved exactly
    // rather than unified, because nothing asked for those screens to change.
    renderFooter({ pinned: false, unpinnedClassName: "pt-2" });
    expect(footer()).toHaveClass("pt-2");
    renderFooter({ pinned: false });
    expect(screen.getAllByTestId("footer-children")[1].parentElement).not.toHaveClass("pt-2");
  });
});

describe("FooterSpacer", () => {
  it("pushes what follows it to the far end", () => {
    render(
      <PinnedFooter inset={FOOTER_INSETS.inboxDetail}>
        <span data-testid="footer-children">Process</span>
        <FooterSpacer />
        <span>Discard</span>
      </PinnedFooter>,
    );
    expect(footer().querySelector(".flex-1")).toBeInTheDocument();
  });
});
