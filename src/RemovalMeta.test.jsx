import React from "react";
import { render, screen } from "@testing-library/react";
import RemovalMeta from "./RemovalMeta";

// The one component behind all three places a removal renders: the "recently
// removed" panel, a single entry in the history view, and a row inside a
// grouped bulk entry. Testing it once is what makes those three agree.

const chipTexts = () =>
  Array.from(document.querySelectorAll("span.rounded-full")).map(
    (el) => el.textContent,
  );

describe("RemovalMeta", () => {
  test("shows the quantity when there is one", () => {
    render(<RemovalMeta quantity="2 cans" tags={[]} />);
    expect(screen.getByText("2 cans")).toBeTruthy();
  });

  test("shows the quantity verbatim, as the member row does", () => {
    // Quantity is free text and always has been — "6 + 3" is a real value that
    // addOrMergeMembers produces. Nothing here parses or reformats it.
    render(<RemovalMeta quantity="6 + 3" tags={[]} />);
    expect(screen.getByText("6 + 3")).toBeTruthy();
  });

  test("shows tags as chips", () => {
    render(<RemovalMeta quantity={null} tags={["tjs", "whole foods"]} />);
    expect(chipTexts()).toEqual(["tjs", "whole foods"]);
  });

  test("shows both together", () => {
    render(<RemovalMeta quantity="1 dozen" tags={["tjs"]} />);
    expect(screen.getByText("1 dozen")).toBeTruthy();
    expect(chipTexts()).toEqual(["tjs"]);
  });

  test("renders nothing at all when there is neither", () => {
    const { container } = render(<RemovalMeta quantity={null} tags={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing for an empty-string quantity", () => {
    // Empty quantities are stored as null, but a '' would render an empty
    // muted span and an unexplained gap.
    const { container } = render(<RemovalMeta quantity="" tags={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("survives a missing or malformed tags value", () => {
    // Rows predating Migration B have no tags at all.
    expect(() => render(<RemovalMeta quantity="1" />)).not.toThrow();
    expect(() => render(<RemovalMeta quantity="1" tags={null} />)).not.toThrow();
    expect(() =>
      render(<RemovalMeta quantity="1" tags="not an array" />),
    ).not.toThrow();
  });

  test("the chips are READ-ONLY — no × and nothing tappable", () => {
    // A removal is a record of something that happened. Editing it here would
    // be editing history; tags are edited on the member row, where the item is.
    render(<RemovalMeta quantity="2" tags={["tjs", "whole foods"]} />);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  test("chips use the app's standard read-only tag styling", () => {
    // Same fill and shape as an item card, an intention card, and a collection
    // member row's chips minus the × only a removable one needs — so a tag
    // reads as a tag wherever you meet it.
    render(<RemovalMeta quantity={null} tags={["tjs"]} />);
    const chip = screen.getByText("tjs");
    for (const cls of [
      "bg-warning-light",
      "text-accent-foreground",
      "text-xs",
      "rounded-full",
    ]) {
      expect(chip.className).toContain(cls);
    }
  });

  test("renders every tag, with no cap", () => {
    // Unlike the list-view cards, which stop at three. A removal panel is
    // already a short list and the whole point is recognising what went.
    const many = ["a", "b", "c", "d", "e", "f"];
    render(<RemovalMeta quantity={null} tags={many} />);
    expect(chipTexts()).toEqual(many);
  });
});

describe("RemovalMeta — the shapes the two views hand it", () => {
  // Both views read from the same `loadRemovals`, so a removal row is the same
  // object in each. These are the states a real row can be in.
  const removal = (over) => ({
    id: "r1",
    itemName: "Eggs",
    quantity: null,
    tags: [],
    ...over,
  });

  test("a tagged removal with a quantity — the shopping case", () => {
    const r = removal({ quantity: "1 dozen", tags: ["tjs"] });
    render(<RemovalMeta quantity={r.quantity} tags={r.tags} />);

    expect(screen.getByText("1 dozen")).toBeTruthy();
    expect(chipTexts()).toEqual(["tjs"]);
  });

  test("an untagged removal with a quantity", () => {
    const r = removal({ quantity: "2 cans" });
    render(<RemovalMeta quantity={r.quantity} tags={r.tags} />);

    expect(screen.getByText("2 cans")).toBeTruthy();
    expect(chipTexts()).toEqual([]);
  });

  test("a tagged removal with no quantity", () => {
    const r = removal({ tags: ["whole foods"] });
    render(<RemovalMeta quantity={r.quantity} tags={r.tags} />);

    expect(chipTexts()).toEqual(["whole foods"]);
  });

  test("a bare removal adds no row at all", () => {
    const r = removal();
    const { container } = render(
      <RemovalMeta quantity={r.quantity} tags={r.tags} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
