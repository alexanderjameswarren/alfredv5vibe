import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import RecentlyArchived from "./RecentlyArchived";
import { archiveOutcome } from "./utils/inboxArchive";

const ROWS = [
  {
    id: "inbox-1",
    capturedText: "Retire the ai-enrich edge function",
    sourceType: "mcp",
    archived: true,
    archiveReason: "processed",
    triagedAt: "2026-09-25T09:00:00.000Z",
    createdAt: "2026-09-24T08:00:00.000Z",
  },
  {
    id: "inbox-2",
    capturedText: "Buy a second kettle",
    sourceType: "manual",
    archived: true,
    archiveReason: "discarded",
    triagedAt: "2026-09-24T17:00:00.000Z",
    createdAt: "2026-09-20T08:00:00.000Z",
  },
];

const RECORDS = { items: [{ id: "item-1", sourceInboxId: "inbox-1" }], intents: [], events: [] };

function setup(props = {}) {
  const onUndo = jest.fn();
  const onToggleExpanded = jest.fn();
  const onToggleShowAll = jest.fn();
  const utils = render(
    <RecentlyArchived
      rows={ROWS}
      olderCount={0}
      showAll={false}
      expanded
      onToggleExpanded={onToggleExpanded}
      onToggleShowAll={onToggleShowAll}
      outcomeFor={(row) => archiveOutcome(row, RECORDS)}
      onUndo={onUndo}
      {...props}
    />,
  );
  return { onUndo, onToggleExpanded, onToggleShowAll, ...utils };
}

const header = () => screen.getByRole("button", { name: /Recently archived/ });

describe("what it shows", () => {
  it("a heading counting the rows on screen, like Items (26)", () => {
    setup();
    expect(header()).toHaveTextContent("Recently archived (2)");
  });

  it("each row's title, source, outcome and when it left", () => {
    setup();
    expect(screen.getByText("Retire the ai-enrich edge function")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Processed into an item")).toBeInTheDocument();
    expect(screen.getByText("Discarded")).toBeInTheDocument();
  });

  it("dates the DEPARTURE, not the capture", () => {
    // A capture made in March and discarded in November. A history titled "recently"
    // that showed March would be answering a different question.
    //
    // Both dates are years old on purpose, so `friendlyDate` gives each the weekday form
    // rather than "Today"/"Yesterday" — which depend on the real clock. The month alone
    // is asserted, because the rendered day shifts with the test machine's timezone.
    setup({
      rows: [{ ...ROWS[1], createdAt: "2020-03-05T08:00:00.000Z", triagedAt: "2021-11-18T09:00:00.000Z" }],
    });
    expect(screen.getByText(/Nov 1[78]/)).toBeInTheDocument();
    expect(screen.queryByText(/Mar/)).not.toBeInTheDocument();
  });

  it("colours a discard and mutes the rest", () => {
    setup();
    expect(screen.getByText("Discarded")).toHaveClass("text-destructive");
    expect(screen.getByText("Processed into an item")).toHaveClass("text-muted-foreground");
  });

  it("an Undo on every row, named so it is distinguishable", () => {
    // Two buttons reading only "Undo" are two buttons a screen reader cannot tell apart.
    setup();
    expect(screen.getAllByRole("button", { name: /^Put back:/ })).toHaveLength(2);
  });

  it("does NOT open the detail page — an archived capture has no route", () => {
    // It is not in `inboxItems`, so `routeInboxItem` resolves to nothing and bounces
    // back. Undo first, then open it.
    const { container } = setup();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    const rowText = screen.getByText("Buy a second kettle");
    expect(rowText.closest("[class*='cursor-pointer']")).toBeNull();
  });
});

describe("collapsing", () => {
  it("hides the rows but keeps the heading and its count", () => {
    setup({ expanded: false });
    expect(header()).toHaveTextContent("Recently archived (2)");
    expect(screen.queryByText("Buy a second kettle")).not.toBeInTheDocument();
  });

  it("reports its state to a screen reader", () => {
    const { unmount } = setup({ expanded: false });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    unmount();
    setup({ expanded: true });
    expect(header()).toHaveAttribute("aria-expanded", "true");
  });

  it("reports the tap", () => {
    const { onToggleExpanded } = setup();
    fireEvent.click(header());
    expect(onToggleExpanded).toHaveBeenCalled();
  });
});

describe("Show all", () => {
  it("is absent when it would reveal nothing", () => {
    // A control that shows exactly what is already on screen does nothing.
    setup({ olderCount: 0 });
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("says how many more there are", () => {
    setup({ olderCount: 12 });
    expect(screen.getByRole("button", { name: "Show all (12 older)" })).toBeInTheDocument();
  });

  it("offers the way back once it is on", () => {
    setup({ olderCount: 12, showAll: true });
    expect(screen.getByRole("button", { name: "Last 7 days" })).toBeInTheDocument();
  });

  it("reports the tap", () => {
    const { onToggleShowAll } = setup({ olderCount: 3 });
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(onToggleShowAll).toHaveBeenCalled();
  });
});

describe("Undo", () => {
  it("reports the row's id", () => {
    const { onUndo } = setup();
    fireEvent.click(screen.getAllByRole("button", { name: /^Put back:/ })[1]);
    expect(onUndo).toHaveBeenCalledWith("inbox-2");
  });
});

describe("when there is nothing to show", () => {
  it("renders NO section at all rather than an empty heading", () => {
    // "Recently archived (0)" on a fresh account is a heading explaining a feature
    // rather than using it.
    const { container } = setup({ rows: [], olderCount: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it("but stays, and names the way out, when the WINDOW is what emptied it", () => {
    setup({ rows: [], olderCount: 9 });
    expect(header()).toHaveTextContent("Recently archived (0)");
    expect(screen.getByText(/Nothing archived in the last 7 days/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all (9 older)" })).toBeInTheDocument();
  });
});

// ── The guards ───────────────────────────────────────────────────────────────
describe("it is wired into the inbox screen", () => {
  const alfred = fs.readFileSync(path.join(__dirname, "Alfred.jsx"), "utf8");

  it("renders OUTSIDE the empty-inbox branch", () => {
    // 🛑 An empty inbox is when this matters most: you have just processed the last
    // capture, and "Empty inbox — this is success, not failure" with no way back would
    // make a mistaken tap unrecoverable on the one screen that celebrates it. So the
    // section must not sit inside the `visibleInboxItems.length` branches.
    const inboxView = alfred.slice(
      alfred.indexOf("{/* Inbox View */}"),
      alfred.indexOf("{/* Inbox Detail View"),
    );
    expect(inboxView).toContain("<RecentlyArchived");
    const emptyBranch = inboxView.indexOf("Empty inbox.");
    const section = inboxView.indexOf("<RecentlyArchived");
    expect(section).toBeGreaterThan(emptyBranch);
    // The ternary chain that handles empty / no-matches / rows closes before it.
    expect(inboxView.slice(emptyBranch, section)).toContain("</div>\n            )}");
  });

  it("gives it the un-archive writer, not the discard one", () => {
    expect(alfred).toContain("onUndo={unarchiveInboxItem}");
  });

  it("is NOT narrowed by the source tab or the search box", () => {
    // Those belong to the live list. A history that hid the row you were looking for
    // because a tab was still selected is the trap `effectiveSource` exists to avoid.
    expect(alfred).toContain("rows={archivedInboxItems}");
    expect(alfred).toContain(
      "const archivedInboxItems = recentlyArchived(allInboxItems, { showAll: archivedShowAll });",
    );
  });
});

describe("the archived row is not rebuilt elsewhere", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const self = read("RecentlyArchived.jsx");
  const others = fs
    .readdirSync(__dirname)
    .filter((f) => /\.jsx$/.test(f) && !/\.test\.jsx$/.test(f) && f !== "RecentlyArchived.jsx")
    .map((f) => [f, read(f)]);

  it("owns the row", () => {
    const row = "flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-secondary/60";
    expect(self).toContain(row);
    for (const [f, src] of others) expect([f, src.includes(row)]).toEqual([f, false]);
  });

  it("owns the heading", () => {
    // The rendered heading, not the words: Alfred.jsx names the section in a dozen
    // comments, which is documentation rather than a second implementation.
    expect(self).toContain("Recently archived ({rows.length})");
    for (const [f, src] of others) expect([f, src.includes("Recently archived ({")]).toEqual([f, false]);
  });

  it("is the muted shape, not a card", () => {
    // A border or a card surface here would make history look actionable.
    expect(self).not.toContain("bg-card");
    expect(self).not.toContain("border-border");
  });
});
