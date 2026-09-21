import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import TagFilter, { collapseOnSearch, COLLAPSE_MIN_TAGS } from "./TagFilter";

// The safety net for the collapse work (Step 2b). Everything above the "Step 2b"
// divider was written BEFORE collapsing existed, against behaviour as it stood
// after the pure move out of Alfred.jsx — and all of it still passes unchanged,
// which is the evidence that 2b added rather than altered.
//
// None of those tests pass `onToggleCollapsed`, so none of them render the
// toggle. That is the component's own rule, not a test convenience: no handler
// means no toggle, and no toggle means `collapsed` is ignored.

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

// ─── Step 2b: collapsing, so the results are visible while typing ────────────
//
// The complaint this answers: on the Recipes page the bar is 22 pills, and
// typing in the search box under it pushes every match off screen.

describe("TagFilter — collapsed", () => {
  // Five tags, not three: at or above COLLAPSE_MIN_TAGS, which is what makes a
  // bar collapsible at all. Widened from three in Step 2c — every assertion
  // below is unchanged, it just needs a bar big enough to be worth collapsing.
  const FIVE = rows(["aioli"], ["beans"], ["carrot"], ["dill"], ["soup"]);
  const noop = () => {};

  test("collapsed with no filter shows the toggle and nothing else", () => {
    render(
      <TagFilter entities={FIVE} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["Tags (5)"]);
  });

  test("the toggle counts what is hidden, so you know what you are opening", () => {
    render(
      <TagFilter entities={rows(["a"], ["b"], ["c"], ["d"], ["e"])} activeTag={null}
        onFilter={noop} collapsed onToggleCollapsed={noop} />
    );
    expect(screen.getByRole("button", { name: "Show tags" }).textContent.trim()).toBe("Tags (5)");
  });

  test("collapsed WITH a filter keeps the active tag and Clear visible", () => {
    // A filter you cannot see is a list silently emptied with no visible cause.
    render(
      <TagFilter entities={FIVE} activeTag="beans" onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["Tags (5)", "beans (1)", "Clear"]);
  });

  test("the surviving pill still looks active, and still clears on tap", () => {
    const onFilter = jest.fn();
    render(
      <TagFilter entities={FIVE} activeTag="beans" onFilter={onFilter}
        collapsed onToggleCollapsed={noop} />
    );
    const pill = screen.getByRole("button", { name: "beans (1)" });
    expect(pill.className).toContain("bg-primary");
    fireEvent.click(pill);
    expect(onFilter).toHaveBeenCalledWith(null);
  });

  test("the active pill survives even when no visible row carries that tag", () => {
    // Alex, 2026-09-21. This is the case where the list is emptiest and the
    // question "why" is loudest, so the pill matters most here. No count is
    // printed, because it is answering what is filtering, not how many matched.
    // The bar is five tags wide so it can collapse at all; "beans" is not one
    // of them, which is the whole point — the filter outlived its tag.
    render(
      <TagFilter entities={rows(["aioli"], ["carrot"], ["dill"], ["soup"], ["thyme"])}
        activeTag="beans" onFilter={noop} collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["Tags (5)", "beans", "Clear"]);
  });

  test("expanding restores every pill, still in alphabetical order", () => {
    const { rerender } = render(
      <TagFilter entities={FIVE} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["Tags (5)"]);
    rerender(
      <TagFilter entities={FIVE} activeTag={null} onFilter={noop}
        collapsed={false} onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual([
      "Tags (5)", "aioli (1)", "beans (1)", "carrot (1)", "dill (1)", "soup (1)",
    ]);
  });

  test("the toggle fires, and says which way it goes", () => {
    const onToggleCollapsed = jest.fn();
    const { rerender } = render(
      <TagFilter entities={FIVE} activeTag={null} onFilter={noop}
        collapsed={false} onToggleCollapsed={onToggleCollapsed} />
    );
    const open = screen.getByRole("button", { name: "Hide tags" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(open);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

    rerender(
      <TagFilter entities={FIVE} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={onToggleCollapsed} />
    );
    const shut = screen.getByRole("button", { name: "Show tags" });
    expect(shut.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(shut);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(2);
  });

  test("the toggle sits first, so it is in the same place open or shut", () => {
    const { rerender } = render(
      <TagFilter entities={FIVE} activeTag="beans" onFilter={noop}
        collapsed={false} onToggleCollapsed={noop} />
    );
    expect(pills()[0]).toBe("Tags (5)");
    rerender(
      <TagFilter entities={FIVE} activeTag="beans" onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()[0]).toBe("Tags (5)");
  });

  test("no toggle handler means no toggle, and `collapsed` is ignored", () => {
    // A bar that cannot be reopened must never be closed.
    render(<TagFilter entities={FIVE} activeTag={null} onFilter={noop} collapsed />);
    expect(pills()).toEqual([
      "aioli (1)", "beans (1)", "carrot (1)", "dill (1)", "soup (1)",
    ]);
  });

  test("still nothing at all when no tag is in use, collapsed or not", () => {
    const { container, rerender } = render(
      <TagFilter entities={[]} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(container.innerHTML).toBe("");
    rerender(
      <TagFilter entities={[]} activeTag={null} onFilter={noop}
        collapsed={false} onToggleCollapsed={noop} />
    );
    expect(container.innerHTML).toBe("");
  });
});

// ─── The collapse-on-typing rule ─────────────────────────────────────────────
//
// `Alfred` cannot be rendered in a test (see executionColdLoad.test.jsx), and a
// harness that REPRODUCES a rule stays green while the shipping code drifts
// away from it. So the rule is exported and `Alfred` calls this exact function
// from `setSearchFor` — what is tested below is what ships.

describe("collapseOnSearch", () => {
  test("typing a character collapses that page's bar", () => {
    expect(collapseOnSearch({}, "memories", "t")).toEqual({ memories: true });
  });

  test("clearing the box does NOT expand it again", () => {
    // The deliberate asymmetry. A backspace is not a request to see the tags,
    // and springing back would shove the list down just as you finished reading.
    expect(collapseOnSearch({ memories: true }, "memories", "")).toEqual({ memories: true });
  });

  test("an empty value never collapses either — a programmatic clear is not typing", () => {
    // `viewContextDetail` blanks this box when a different context is opened.
    expect(collapseOnSearch({}, "context-detail", "")).toEqual({});
  });

  test("only the page that was typed in is touched", () => {
    expect(collapseOnSearch({ memories: true }, "intentions", "x")).toEqual({
      memories: true,
      intentions: true,
    });
  });

  test("a bar the user reopened collapses again on the next keystroke", () => {
    expect(collapseOnSearch({ memories: false }, "memories", "to")).toEqual({ memories: true });
  });

  test("returns the same object when nothing changes, so React skips the render", () => {
    const already = { memories: true };
    expect(collapseOnSearch(already, "memories", "soup")).toBe(already);
    expect(collapseOnSearch(already, "memories", "")).toBe(already);
  });
});

// ─── Step 2c: a small bar does not collapse at all ───────────────────────────
//
// A `Tags (2)` control that hides two pills saves nothing and adds a thing to
// look at — and on collection detail, which has no search box, nothing could
// ever fire it, so its only possible purpose would be to undo itself.

describe("TagFilter — below the collapse threshold", () => {
  const noop = () => {};
  /** A bar of exactly `n` distinct tags, one row each. */
  const bar = (n) => rows(...Array.from({ length: n }, (_, i) => [`tag ${i}`]));

  test("the threshold is four, and it is the component's own number", () => {
    // Imported, not copied: a literal here could drift from the component.
    expect(COLLAPSE_MIN_TAGS).toBe(4);
  });

  test("three tags: no toggle, ever", () => {
    render(
      <TagFilter entities={bar(3)} activeTag={null} onFilter={noop}
        onToggleCollapsed={noop} />
    );
    expect(screen.queryByRole("button", { name: "Hide tags" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Show tags" })).toBe(null);
    expect(pills()).toEqual(["tag 0 (1)", "tag 1 (1)", "tag 2 (1)"]);
  });

  test("four tags: the toggle appears — the boundary is >=, not >", () => {
    render(
      <TagFilter entities={bar(4)} activeTag={null} onFilter={noop}
        onToggleCollapsed={noop} />
    );
    expect(screen.getByRole("button", { name: "Hide tags" }).textContent.trim()).toBe("Tags (4)");
  });

  test("at three tags, typing cannot collapse the bar", () => {
    // The requirement is "below the threshold, typing must not collapse". The
    // guard for it lives in the RENDER, not in collapseOnSearch — which runs in
    // `Alfred` and cannot see the tag count. So collapseOnSearch still records
    // `true`...
    expect(collapseOnSearch({}, "memories", "x")).toEqual({ memories: true });
    // ...and the render ignores it. Nothing is hidden, which is the behaviour
    // that was actually asked for.
    render(
      <TagFilter entities={bar(3)} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["tag 0 (1)", "tag 1 (1)", "tag 2 (1)"]);
  });

  test("a bar collapsed at five tags that drops to three shows its pills again", () => {
    // THE OUTCOME THAT MUST BE IMPOSSIBLE: a hidden bar with no way to reopen
    // it. `collapsed` stays true across this rerender — the pills come back
    // because the render recomputes, not because anything reset the state.
    const { rerender } = render(
      <TagFilter entities={bar(5)} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["Tags (5)"]);
    rerender(
      <TagFilter entities={bar(3)} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["tag 0 (1)", "tag 1 (1)", "tag 2 (1)"]);
  });

  test("and collapses again by itself if the bar grows back", () => {
    // The stored `true` is left alone, so it starts mattering again. Deliberate
    // (Alex, 2026-09-21): the user did type in that screen's search box.
    const { rerender } = render(
      <TagFilter entities={bar(3)} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["tag 0 (1)", "tag 1 (1)", "tag 2 (1)"]);
    rerender(
      <TagFilter entities={bar(5)} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["Tags (5)"]);
  });

  test("a small bar with a filter on still shows the pills and Clear", () => {
    render(
      <TagFilter entities={bar(2)} activeTag="tag 1" onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["tag 0 (1)", "tag 1 (1)", "Clear"]);
  });

  test("a Recipes-sized bar is untouched by any of this", () => {
    render(
      <TagFilter entities={bar(22)} activeTag={null} onFilter={noop}
        collapsed onToggleCollapsed={noop} />
    );
    expect(pills()).toEqual(["Tags (22)"]);
  });
});
