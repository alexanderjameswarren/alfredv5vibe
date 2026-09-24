import fs from "fs";
import path from "path";
import { FOOTER_INSETS, PINNED_FOOTER_PAD_Y } from "./pinnedFooterGeometry";

// ── The drift this catches ───────────────────────────────────────────────────
//
// A pinned footer reaches its container's edges by cancelling exactly as much margin
// as the container has padding. The footer is told that number; the container states
// it as a Tailwind class. Nothing connects the two but agreement.
//
// Change a card from `p-3 sm:p-4` to `p-4 sm:p-6` and the footer keeps cancelling 12
// and 16, so a released footer either leaves a strip of card below it or hangs past
// the border — and it is invisible until somebody scrolls to the bottom of that one
// screen. Which is precisely how the item, intention and context forms carried the
// same bug through three rounds of fixes.
//
// So both halves are read out of the source and compared.

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

/** Tailwind's default spacing scale, for the steps these containers use. */
const SPACING_PX = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32 };

/**
 * Each pinned footer, the container whose padding it cancels, and the inset it is
 * given. The container is identified by a distinctive slice of its own class list.
 */
const SCREENS = [
  {
    what: "the item edit screen (ItemCard)",
    file: "Alfred.jsx",
    container: "p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md",
    inset: FOOTER_INSETS.itemCard,
  },
  {
    what: "the intention edit screen (IntentionCard)",
    file: "Alfred.jsx",
    container: "p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md",
    inset: FOOTER_INSETS.intentionCard,
  },
  {
    what: "the Context form",
    file: "Alfred.jsx",
    container: "p-4 sm:p-6 bg-white border-2 border-primary rounded-lg shadow-lg",
    inset: FOOTER_INSETS.contextForm,
  },
  {
    what: "the inbox detail page",
    file: "InboxDetailView.jsx",
    container: "rounded-xl p-4 sm:p-7",
    inset: FOOTER_INSETS.inboxDetail,
  },
];

describe("each screen's inset matches its container's actual padding", () => {
  for (const screen of SCREENS) {
    it(screen.what, () => {
      const source = read(screen.file);
      // Presence, not a count: several components share a card style, and counting
      // them would break whenever an unrelated screen reused one. What matters is
      // that THIS padding still exists — change it and the string disappears.
      expect(source).toContain(screen.container);

      const base = /p-(\d)(?!\d)/.exec(screen.container);
      const sm = /sm:p-(\d)(?!\d)/.exec(screen.container);
      expect(base).not.toBeNull();
      expect(sm).not.toBeNull();
      expect(screen.inset).toEqual([SPACING_PX[base[1]], SPACING_PX[sm[1]]]);
    });
  }

  it("gives the two add-to-collection pages no inset, because they have no card", () => {
    // Their footers sit on the page background. Nothing to cancel, nothing to replace.
    expect(FOOTER_INSETS.onPageBackground).toEqual([0, 0]);
  });
});

describe("every pinned footer goes through the one component", () => {
  const alfred = read("Alfred.jsx");
  const inbox = read("InboxDetailView.jsx");

  it("has all six call sites, and no seventh hand-rolled one", () => {
    // Five in Alfred.jsx — both add pages, the Context form, ItemCard, IntentionCard —
    // and the inbox detail page in its own file.
    expect(alfred.split("<PinnedFooter").length - 1).toBe(5);
    expect(inbox.split("<PinnedFooter").length - 1).toBe(1);
  });

  it("leaves no trace of the class lists it replaced", () => {
    // Any of these coming back means a screen has started doing its own geometry
    // again, which is the thing this component exists to prevent.
    for (const source of [alfred, inbox]) {
      expect(source).not.toContain("sticky-above-bar");
      expect(source).not.toContain("bottom-28");
      expect(source).not.toContain("bottom-32");
    }
  });

  it("does not let a call site pass its own padding", () => {
    // `className` is for the surface. A padding utility there would fight the
    // component's own and reintroduce an unequal top and bottom.
    const calls = [...alfred.matchAll(/<PinnedFooter[^>]*>/gs), ...inbox.matchAll(/<PinnedFooter[^>]*>/gs)];
    expect(calls).toHaveLength(6);
    for (const [call] of calls) {
      expect(call).not.toMatch(/className="[^"]*\bp[xytblr]?-\d/);
    }
  });

  it("states the vertical padding once", () => {
    // Not duplicated into any call site or stylesheet rule.
    expect(PINNED_FOOTER_PAD_Y).toBe(12);
    expect(read("PinnedFooter.jsx")).toContain("PINNED_FOOTER_PAD_Y");
  });
});
