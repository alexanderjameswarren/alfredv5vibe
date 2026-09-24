import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import EditCard, {
  EDIT_CARD_CLASS,
  EDIT_CARD_INSET,
  EDIT_CARD_FOOTER_RADIUS,
} from "./EditCard";

const read = (...parts) => fs.readFileSync(path.join(__dirname, ...parts), "utf8");

/** Tailwind's default spacing scale, for the steps this card uses. */
const SPACING_PX = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32 };

describe("the card's own look", () => {
  it("is one class list, applied wherever it is used", () => {
    render(<EditCard>content</EditCard>);
    const card = screen.getByText("content");
    for (const cls of EDIT_CARD_CLASS.split(/\s+/)) {
      expect(card).toHaveClass(cls);
    }
  });

  it("is the app's card look, not a fifth variant", () => {
    // The choice, recorded as an assertion. `rounded-xl` appeared 0 times in
    // Alfred.jsx and `rounded-lg` 92; `shadow-md` 53 times against `shadow-lg`'s 4.
    // Three of the four cards were already `rounded-lg shadow-md`, so adopting the
    // inbox page's `rounded-xl` would have made these four agree with each other and
    // disagree with everything else.
    expect(EDIT_CARD_CLASS).toContain("rounded-lg");
    expect(EDIT_CARD_CLASS).toContain("shadow-md");
    expect(EDIT_CARD_CLASS).toContain("border-2 border-primary");
    expect(EDIT_CARD_CLASS).toContain("bg-card");
    expect(EDIT_CARD_CLASS).not.toContain("rounded-xl");
  });

  it("takes layout from the caller without letting it restyle the card", () => {
    render(<EditCard className="max-w-[860px] mx-auto flex flex-col gap-5">content</EditCard>);
    const card = screen.getByText("content");
    expect(card).toHaveClass("max-w-[860px]", "mx-auto", "flex", "flex-col", "gap-5");
    expect(card).toHaveClass("rounded-lg", "shadow-md");
  });
});

describe("the two numbers the footer depends on", () => {
  it("derives the inset from the card's OWN padding classes", () => {
    // 🛑 THE DRIFT THIS CLOSES. The footer cancels exactly as much margin as the card
    // has padding. Change `p-4 sm:p-6` and forget the inset and a released footer
    // either leaves a strip of card below it or hangs past the border — invisible until
    // somebody scrolls to the bottom of that one screen, which is how three screens
    // carried the same bug through three rounds of fixes.
    const base = /(?:^|\s)p-(\d)(?!\d)/.exec(EDIT_CARD_CLASS);
    const sm = /(?:^|\s)sm:p-(\d)(?!\d)/.exec(EDIT_CARD_CLASS);
    expect(base).not.toBeNull();
    expect(sm).not.toBeNull();
    expect(EDIT_CARD_INSET).toEqual([SPACING_PX[base[1]], SPACING_PX[sm[1]]]);
  });

  it("matches the footer's bottom radius to the card's radius", () => {
    // `rounded-lg` on the card, `rounded-b-lg` on the footer. The footer is stretched
    // to the card's edges, so it has to round where the card rounds.
    const radius = /(?:^|\s)rounded-(\w+)(?!\S)/.exec(EDIT_CARD_CLASS);
    expect(radius).not.toBeNull();
    expect(EDIT_CARD_FOOTER_RADIUS).toBe(`rounded-b-${radius[1]}`);
  });
});

// ── The guard ────────────────────────────────────────────────────────────────
//
// Four screens are a form that owns the screen. If one stops using the shared card, it
// starts drifting again — and the drift is invisible until somebody looks at two
// screens side by side, or scrolls to the bottom of the one that broke.
describe("every full-screen edit form uses the shared card", () => {
  const alfred = read("Alfred.jsx");
  const inbox = read("InboxDetailView.jsx");

  it("has exactly the four call sites", () => {
    // ItemCard, IntentionCard and ContextForm in Alfred.jsx; the inbox detail page in
    // its own file.
    expect(alfred.split("<EditCard").length - 1).toBe(3);
    expect(inbox.split("<EditCard").length - 1).toBe(1);
  });

  it("leaves no hand-rolled edit card behind", () => {
    // The class lists these four used to carry. Any of them coming back means a form
    // has started styling itself again.
    const gone = [
      "p-4 sm:p-6 bg-white border-2 border-primary rounded-lg shadow-lg",
      "border-2 border-primary rounded-xl",
    ];
    for (const source of [alfred, inbox]) {
      for (const cls of gone) {
        expect(source).not.toContain(cls);
      }
    }
  });

  it("does not let a call site restyle the card through className", () => {
    // `className` is for layout. A border, radius, shadow or padding there would
    // reintroduce exactly the divergence this removed.
    const calls = [
      ...alfred.matchAll(/<EditCard[^>]*>/gs),
      ...inbox.matchAll(/<EditCard[^>]*>/gs),
    ];
    expect(calls).toHaveLength(4);
    for (const [call] of calls) {
      expect(call).not.toMatch(/className="[^"]*\b(?:rounded|shadow|border)/);
      expect(call).not.toMatch(/className="[^"]*\bp[xytblr]?-\d/);
    }
  });

  it("leaves the cards this was NOT meant to touch alone", () => {
    // EventCard shares the old class list and is a card in a LIST, not a full-screen
    // form. Alex asked for it to stay as it is, along with the context detail panel.
    expect(alfred).toContain("p-3 sm:p-4 bg-card border-2 border-primary rounded-lg shadow-md");
  });

  it("keeps every pinned footer inside a card, except the two with no card", () => {
    // A footer inside an EditCard gets its inset from context. One outside gets [0, 0],
    // which is right only for the two add-to-collection pages.
    expect(alfred.split("<PinnedFooter").length - 1).toBe(5);
    expect(inbox.split("<PinnedFooter").length - 1).toBe(1);
    // Neither file states an inset any more; the card is the only source.
    for (const source of [alfred, inbox]) {
      expect(source).not.toContain("inset={");
    }
  });
});
