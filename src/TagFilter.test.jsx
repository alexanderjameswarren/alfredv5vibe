import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import TagFilter from "./TagFilter";

// The safety net for the collapse work (Step 2b). Everything here is written
// against behaviour as it stands AFTER the pure move out of Alfred.jsx and
// BEFORE anything collapses, so a failure during 2b means 2b changed something
// it was not meant to.

/** Rows as the four call sites hand them over: anything with a `tags` array. */
const rows = (...tagLists) => tagLists.map((tags) => ({ tags }));

/** Every pill in the bar, in render order, exactly as it reads on screen. */
const pills = () =>
  screen.queryAllByRole("button").map((b) => b.textContent.trim());

describe("TagFilter — what it renders", () => {
  test("alphabetical by tag name, with each tag's count", () => {
    // Deliberately handed over in neither alphabetical nor frequency order, so
    // passing cannot be an accident of the input.
    render(
      <TagFilter
        entities={rows(["soup", "beans"], ["beans", "aioli"], ["beans"])}
        activeTag={null}
        onFilter={() => {}}
      />
    );
    expect(pills()).toEqual(["aioli (1)", "beans (3)", "soup (1)"]);
  });

  test("order is NOT frequency — the rarest tag leads when it sorts first", () => {
    // The exact regression Step 1 fixed. "aioli" appears once and "soup" four
    // times; alphabetical still puts aioli first.
    render(
      <TagFilter
        entities={rows(["soup"], ["soup"], ["soup"], ["soup"], ["aioli"])}
        activeTag={null}
        onFilter={() => {}}
      />
    );
    expect(pills()).toEqual(["aioli (1)", "soup (4)"]);
  });

  test("accented tags sort where a reader expects, not after z", () => {
    // `localeCompare` rather than `<`. normaliseTag preserves accents, so this
    // is a tag that can really exist.
    render(
      <TagFilter
        entities={rows(["zucchini"], ["café"], ["carrot"])}
        activeTag={null}
        onFilter={() => {}}
      />
    );
    expect(pills()).toEqual(["café (1)", "carrot (1)", "zucchini (1)"]);
  });

  test("counts tag OCCURRENCES, so a row carrying a tag twice counts twice", () => {
    // Recorded as-is, not endorsed. Two rows, three occurrences, "soup (3)" —
    // the pill therefore over-counts a row whose tags array holds a duplicate.
    // Harmless today because normaliseTags dedupes on every write path, so no
    // stored row can be in that shape. Left alone: this is a pure move, and
    // changing it would be a behaviour change. See the progress file.
    render(
      <TagFilter entities={rows(["soup", "soup"], ["soup"])} activeTag={null} onFilter={() => {}} />
    );
    expect(pills()).toEqual(["soup (3)"]);
  });

  test("rows without tags are skipped, not counted as blanks", () => {
    render(
      <TagFilter
        entities={[{ tags: ["soup"] }, {}, { tags: null }, { tags: [] }]}
        activeTag={null}
        onFilter={() => {}}
      />
    );
    expect(pills()).toEqual(["soup (1)"]);
  });
});

describe("TagFilter — when it renders nothing", () => {
  test("an empty entity list renders nothing at all", () => {
    const { container } = render(
      <TagFilter entities={[]} activeTag={null} onFilter={() => {}} />
    );
    expect(container.innerHTML).toBe("");
  });

  test("rows that exist but carry no tags render nothing at all", () => {
    // An empty bar would be a gap above the list with nothing to say.
    const { container } = render(
      <TagFilter entities={[{}, { tags: [] }]} activeTag={null} onFilter={() => {}} />
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("TagFilter — filtering", () => {
  const THREE = rows(["aioli"], ["beans"], ["soup"]);

  test("tapping a tag asks for that tag", () => {
    const onFilter = jest.fn();
    render(<TagFilter entities={THREE} activeTag={null} onFilter={onFilter} />);
    fireEvent.click(screen.getByRole("button", { name: "beans (1)" }));
    expect(onFilter).toHaveBeenCalledWith("beans");
  });

  test("tapping the ACTIVE tag clears it — a pill is its own toggle", () => {
    const onFilter = jest.fn();
    render(<TagFilter entities={THREE} activeTag="beans" onFilter={onFilter} />);
    fireEvent.click(screen.getByRole("button", { name: "beans (1)" }));
    expect(onFilter).toHaveBeenCalledWith(null);
  });

  test("tapping a DIFFERENT tag while one is active switches to it", () => {
    const onFilter = jest.fn();
    render(<TagFilter entities={THREE} activeTag="beans" onFilter={onFilter} />);
    fireEvent.click(screen.getByRole("button", { name: "soup (1)" }));
    expect(onFilter).toHaveBeenCalledWith("soup");
  });

  test("the active tag is the one that looks selected, and only it", () => {
    render(<TagFilter entities={THREE} activeTag="beans" onFilter={() => {}} />);
    const selected = screen
      .queryAllByRole("button")
      .filter((b) => b.className.includes("bg-primary"))
      .map((b) => b.textContent.trim());
    expect(selected).toEqual(["beans (1)"]);
  });

  test("ordering does not move when a tag becomes active", () => {
    const { rerender } = render(
      <TagFilter entities={THREE} activeTag={null} onFilter={() => {}} />
    );
    expect(pills()).toEqual(["aioli (1)", "beans (1)", "soup (1)"]);
    rerender(<TagFilter entities={THREE} activeTag="soup" onFilter={() => {}} />);
    expect(pills()).toEqual(["aioli (1)", "beans (1)", "soup (1)", "Clear"]);
  });
});

describe("TagFilter — Clear", () => {
  const THREE = rows(["aioli"], ["beans"], ["soup"]);

  test("there is no Clear while nothing is filtering", () => {
    render(<TagFilter entities={THREE} activeTag={null} onFilter={() => {}} />);
    expect(screen.queryByRole("button", { name: "Clear" })).toBe(null);
  });

  test("Clear appears once a tag is active, at the end of the row", () => {
    render(<TagFilter entities={THREE} activeTag="beans" onFilter={() => {}} />);
    expect(pills()).toEqual(["aioli (1)", "beans (1)", "soup (1)", "Clear"]);
  });

  test("tapping Clear clears the filter", () => {
    const onFilter = jest.fn();
    render(<TagFilter entities={THREE} activeTag="beans" onFilter={onFilter} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onFilter).toHaveBeenCalledWith(null);
  });

  test("Clear shows even for a tag no visible row carries any more", () => {
    // Current behaviour, recorded rather than endorsed: filter to "beans", then
    // the last beans row leaves the list. The bar keeps Clear, which is the only
    // way back from a list filtered to nothing. See the progress file.
    render(<TagFilter entities={rows(["soup"])} activeTag="beans" onFilter={() => {}} />);
    expect(pills()).toEqual(["soup (1)", "Clear"]);
  });
});
