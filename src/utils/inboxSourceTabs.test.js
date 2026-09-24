import {
  ALL_SOURCES,
  SOURCE_ORDER,
  sourceTabsFor,
  effectiveSource,
  matchesSource,
} from "./inboxSourceTabs";
import { sourceLabel, SOURCE_GLYPHS } from "../CaptureMeta";

const rows = (...types) => types.map((sourceType, i) => ({ id: `i${i}`, sourceType }));
const keys = (tabs) => tabs.map((t) => t.key);

describe("the order of the tabs", () => {
  it("is fixed, and never sorted by count", () => {
    // The one place this differs from the tag pills, which sort alphabetically because a
    // tag vocabulary grows. Six sources never change, so the row can be learned by
    // position — and a row that reorders as counts change is one you must read afresh
    // every time.
    expect(SOURCE_ORDER).toEqual(["manual", "mcp", "clipboard", "task", "cli", "email"]);
  });

  it("holds whatever the counts are", () => {
    const many = sourceTabsFor(rows("email", "email", "email", "manual", "mcp"), sourceLabel);
    expect(keys(many)).toEqual([ALL_SOURCES, "manual", "mcp", "email"]);
  });
});

describe("which tabs are drawn", () => {
  it("always has All, first, counting everything", () => {
    const tabs = sourceTabsFor(rows("mcp", "manual", "task"), sourceLabel);
    expect(tabs[0]).toMatchObject({ key: ALL_SOURCES, label: "All", count: 3 });
  });

  it("has All even with an empty inbox", () => {
    // There must always be a way back, and the count tells the truth.
    expect(sourceTabsFor([], sourceLabel)).toEqual([
      { key: ALL_SOURCES, label: "All", count: 0, icon: undefined },
    ]);
  });

  it("shows a source only while it has items", () => {
    // A tab reading "(0)" is a control that does nothing. CLI and Email usually have
    // none, which is why they are last in the order and absent most of the time.
    const tabs = sourceTabsFor(rows("mcp", "mcp", "clipboard"), sourceLabel);
    expect(keys(tabs)).toEqual([ALL_SOURCES, "mcp", "clipboard"]);
    expect(keys(tabs)).not.toContain("cli");
    expect(keys(tabs)).not.toContain("email");
  });

  it("counts each source, and names it the way the rest of the app does", () => {
    const tabs = sourceTabsFor(rows("mcp", "mcp", "task"), sourceLabel);
    expect(tabs.find((t) => t.key === "mcp")).toMatchObject({ label: "Claude", count: 2 });
    expect(tabs.find((t) => t.key === "task")).toMatchObject({ label: "Task", count: 1 });
  });

  it("gives every source tab its icon FROM the shared map, and All none", () => {
    // By reference, not by type: lucide icons are forwardRef objects rather than plain
    // functions, and what matters anyway is that the tab reads the same map `SourceIcon`
    // does — a second list is how one source came to render differently on two screens.
    const tabs = sourceTabsFor(rows("mcp", "task"), sourceLabel);
    expect(tabs[0].icon).toBeUndefined();
    expect(tabs.find((t) => t.key === "mcp").icon).toBe(SOURCE_GLYPHS.mcp);
    expect(tabs.find((t) => t.key === "task").icon).toBe(SOURCE_GLYPHS.task);
  });

  it("folds an unrecognised source onto Capture rather than inventing a tab", () => {
    // `source_type` has no constraint in the database, and its icon and label already
    // fold an unknown value onto manual. A tab nobody can name would be worse.
    const tabs = sourceTabsFor(rows("something-new", "manual"), sourceLabel);
    expect(keys(tabs)).toEqual([ALL_SOURCES, "manual"]);
    expect(tabs[1].count).toBe(2);
  });

  it("survives junk rows", () => {
    expect(keys(sourceTabsFor([{}, null, { sourceType: undefined }], sourceLabel))).toEqual([
      ALL_SOURCES,
      "manual",
    ]);
    expect(sourceTabsFor(null, sourceLabel)[0].count).toBe(0);
  });
});

describe("falling back to All", () => {
  it("keeps a chosen source while it still has a tab", () => {
    const tabs = sourceTabsFor(rows("mcp", "manual"), sourceLabel);
    expect(effectiveSource("mcp", tabs)).toBe("mcp");
  });

  it("falls back when the chosen source has emptied", () => {
    // 🛑 THE CASE THIS EXISTS FOR: process the last Claude item and the Claude tab goes.
    // A stored selection would leave the list filtered to a source with no tab to unset
    // it — a list silently emptied with no visible cause.
    const tabs = sourceTabsFor(rows("manual"), sourceLabel);
    expect(effectiveSource("mcp", tabs)).toBe(ALL_SOURCES);
  });

  it("treats All, nothing and an unknown key alike", () => {
    const tabs = sourceTabsFor(rows("mcp"), sourceLabel);
    expect(effectiveSource(ALL_SOURCES, tabs)).toBe(ALL_SOURCES);
    expect(effectiveSource(null, tabs)).toBe(ALL_SOURCES);
    expect(effectiveSource("nonsense", tabs)).toBe(ALL_SOURCES);
  });

  it("is derived, so an Undo brings the selection back", () => {
    // The row returns, the tab returns, and the filter the user set is the filter they
    // get. Clearing the stored value on empty would have lost that.
    const chosen = "mcp";
    const emptied = sourceTabsFor(rows("manual"), sourceLabel);
    expect(effectiveSource(chosen, emptied)).toBe(ALL_SOURCES);
    const restored = sourceTabsFor(rows("manual", "mcp"), sourceLabel);
    expect(effectiveSource(chosen, restored)).toBe("mcp");
  });
});

describe("matchesSource", () => {
  it("lets everything through under All", () => {
    expect(matchesSource({ sourceType: "mcp" }, ALL_SOURCES)).toBe(true);
    expect(matchesSource({ sourceType: "cli" }, null)).toBe(true);
  });

  it("matches one source exactly", () => {
    expect(matchesSource({ sourceType: "mcp" }, "mcp")).toBe(true);
    expect(matchesSource({ sourceType: "task" }, "mcp")).toBe(false);
  });

  it("puts an unrecognised source under Capture, agreeing with the tab that counted it", () => {
    expect(matchesSource({ sourceType: "something-new" }, "manual")).toBe(true);
    expect(matchesSource({ sourceType: undefined }, "manual")).toBe(true);
  });
});
