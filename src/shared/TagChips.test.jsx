import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import TagChips, { RowMetaLine, tagsThatFit, minTagWidth, FALLBACK_TAGS } from "./TagChips";

describe("tagsThatFit", () => {
  const more = (n) => (n > 0 ? 50 : 0);

  test("all fit", () => {
    expect(tagsThatFit(200, [40, 40, 40], more)).toBe(3);
  });

  test("as many as leave room for +N more", () => {
    // 40 + 8 + 40 = 88, then 8 + 50 for "+1 more" = 146 <= 150; a third tag would not leave room.
    expect(tagsThatFit(150, [40, 40, 40, 40], more)).toBe(2);
  });

  test("none when even one tag and +N more do not fit", () => {
    expect(tagsThatFit(60, [40, 40], more)).toBe(0);
  });

  test("the tag area's minimum always fits one tag", () => {
    const tags = [60, 40, 40, 40];
    const min = minTagWidth(tags, 50); // 60 + 8 + 50
    expect(min).toBe(118);
    expect(tagsThatFit(min, tags, more)).toBe(1);
    expect(minTagWidth([60], 50)).toBe(60);
    expect(minTagWidth([], 50)).toBe(0);
  });
});

test("plain mode: three, then +N more", () => {
  render(<TagChips tags={["a", "b", "c", "d"]} />);
  expect(screen.getByText("+1 more")).toBeInTheDocument();
});

test("fit mode falls back to two tags where widths cannot be measured", () => {
  render(<TagChips tags={["a", "b", "c", "d"]} fit />);
  // The off-screen copy holds every tag; the visible ones are the first FALLBACK_TAGS.
  expect(screen.getAllByText("a")).toHaveLength(2);
  expect(screen.getAllByText("c")).toHaveLength(1);
  expect(screen.getByText(`+${4 - FALLBACK_TAGS} more`)).toBeInTheDocument();
});

test("line 2 never wraps, and a long context label truncates with its full name as a tooltip", () => {
  const { container } = render(
    <RowMetaLine statusRow={{ status: "active" }} contextName="Alex (body, mind, spirit)" tags={["x"]} />,
  );
  expect(container.firstChild.className).toContain("flex-nowrap");
  const label = screen.getByText("Alex (body, mind, spirit)");
  expect(label.className).toContain("truncate");
  expect(label.parentElement).toHaveAttribute("title", "Alex (body, mind, spirit)");
});
