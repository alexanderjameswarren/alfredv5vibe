import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import { Send, Inbox } from "lucide-react";
import UnderlineTabs from "./UnderlineTabs";

// The accessible name of a tab is its LABEL ALONE — `aria-label`, not the text content.
// That is the point of it: below `lg` the visible label is hidden and only the icon and
// the count remain, so the name has to come from somewhere that survives.
const tab = (name) => screen.getByRole("tab", { name });

const PLAIN = [
  { key: "active", label: "Active", count: 1 },
  { key: "today", label: "Today", count: 4 },
];

const WITH_ICONS = [
  { key: "all", label: "All", count: 6, icon: Inbox },
  { key: "manual", label: "Capture", count: 2, icon: Send },
];

describe("what it renders", () => {
  it("one tab per entry, with its count", () => {
    render(<UnderlineTabs tabs={PLAIN} activeKey="active" onSelect={jest.fn()} />);
    expect(tab("Active")).toHaveTextContent("Active(1)");
    expect(tab("Today")).toHaveTextContent("Today(4)");
  });

  it("omits the count only when there is none", () => {
    // The Recycle Bin's tabs have no counts: its contents are fetched per tab, so a
    // number would mean a query per tab on arrival.
    render(<UnderlineTabs tabs={[{ key: "items", label: "Items" }]} activeKey="items" onSelect={jest.fn()} />);
    expect(tab("Items")).toHaveTextContent("Items");
    expect(tab("Items")).not.toHaveTextContent("(");
  });

  it("renders a count of zero rather than hiding it", () => {
    // "All (0)" on an empty inbox is the truth, and the tab has to stay because it is the
    // way back.
    render(<UnderlineTabs tabs={[{ key: "all", label: "All", count: 0 }]} activeKey="all" onSelect={jest.fn()} />);
    expect(tab("All")).toHaveTextContent("All(0)");
  });

  it("renders an icon when one is given", () => {
    const { container } = render(
      <UnderlineTabs tabs={WITH_ICONS} activeKey="all" onSelect={jest.fn()} />,
    );
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });
});

// ── The compression, Step 21c ────────────────────────────────────────────────
//
// jsdom applies no stylesheet, so `hidden lg:inline` cannot be OBSERVED as a hidden
// element — what is asserted is that the class is on the label and that the name and the
// count survive it, which are the three things that make the compression safe.
describe("compressing on narrow screens", () => {
  it("hides the label below lg when a tab has an icon", () => {
    render(<UnderlineTabs tabs={WITH_ICONS} activeKey="all" onSelect={jest.fn()} />);
    // The same rule and the same breakpoint the top navigation uses for its ten tabs.
    expect(screen.getByText("Capture")).toHaveClass("hidden", "lg:inline");
  });

  it("keeps the full name reachable when the label is hidden", () => {
    render(<UnderlineTabs tabs={WITH_ICONS} activeKey="all" onSelect={jest.fn()} />);
    expect(tab("Capture")).toHaveAttribute("aria-label", "Capture");
    expect(tab("Capture")).toHaveAttribute("title", "Capture");
  });

  it("keeps the COUNT at every width", () => {
    // Following the nav: an inbox glyph on its own says nothing about whether there is
    // anything in it.
    render(<UnderlineTabs tabs={WITH_ICONS} activeKey="all" onSelect={jest.fn()} />);
    expect(screen.getByText("(6)")).not.toHaveClass("hidden");
  });

  it("NEVER hides a label on a tab with no icon", () => {
    // 🛑 There would be nothing left of it: a bare count, or on the Recycle Bin's tabs —
    // which have no counts either — nothing at all. This is what keeps Home and the
    // Recycle Bin exactly as they were.
    render(<UnderlineTabs tabs={PLAIN} activeKey="active" onSelect={jest.fn()} />);
    expect(screen.getByText("Active")).not.toHaveClass("hidden");
    expect(screen.getByText("Today")).not.toHaveClass("hidden");
  });

  it("wraps rather than scrolling sideways", () => {
    // It WAS `overflow-x-auto`, which hides tabs off the right edge — and a tab you have
    // to discover by swiping is not one tap away. Wrapping is the nav's safety net: a
    // wrapped tab is still reachable, a clipped one is not.
    render(<UnderlineTabs tabs={WITH_ICONS} activeKey="all" onSelect={jest.fn()} />);
    const list = screen.getByRole("tablist");
    expect(list).toHaveClass("flex-wrap");
    expect(list).not.toHaveClass("overflow-x-auto");
  });
});

describe("selection", () => {
  it("marks the active tab, and only it", () => {
    render(<UnderlineTabs tabs={PLAIN} activeKey="today" onSelect={jest.fn()} />);
    expect(tab("Today")).toHaveAttribute("aria-selected", "true");
    expect(tab("Active")).toHaveAttribute("aria-selected", "false");
  });

  it("underlines the active tab and not the others", () => {
    render(<UnderlineTabs tabs={PLAIN} activeKey="today" onSelect={jest.fn()} />);
    expect(tab("Today")).toHaveClass("border-primary", "text-primary");
    expect(tab("Active")).toHaveClass("border-transparent");
  });

  it("reports the key that was tapped", () => {
    const onSelect = jest.fn();
    render(<UnderlineTabs tabs={PLAIN} activeKey="active" onSelect={onSelect} />);
    fireEvent.click(tab("Today"));
    expect(onSelect).toHaveBeenCalledWith("today");
  });

  it("reports a tap on the already-active tab too", () => {
    // Left to the caller: the inbox treats it as a no-op, and nothing here should decide
    // that for a future screen.
    const onSelect = jest.fn();
    render(<UnderlineTabs tabs={PLAIN} activeKey="active" onSelect={onSelect} />);
    fireEvent.click(tab("Active"));
    expect(onSelect).toHaveBeenCalledWith("active");
  });
});

describe("the row itself", () => {
  it("is a tablist, named for what it filters", () => {
    render(<UnderlineTabs tabs={PLAIN} activeKey="active" onSelect={jest.fn()} ariaLabel="Executions" />);
    expect(screen.getByRole("tablist", { name: "Executions" })).toBeInTheDocument();
  });

  it("takes spacing from the caller without letting it restyle the tabs", () => {
    render(
      <UnderlineTabs tabs={PLAIN} activeKey="active" onSelect={jest.fn()} className="gap-4 mb-4 text-sm" />,
    );
    const list = screen.getByRole("tablist");
    expect(list).toHaveClass("gap-4", "mb-4", "text-sm", "border-b");
  });
});

// ── The guards ───────────────────────────────────────────────────────────────
describe("every underline tab row goes through this component", () => {
  const alfred = fs.readFileSync(path.join(__dirname, "Alfred.jsx"), "utf8");

  it("has all three call sites", () => {
    expect(alfred.split("<UnderlineTabs").length - 1).toBe(3);
  });

  it("leaves no hand-rolled tab row behind", () => {
    expect(alfred).not.toContain("pb-2 border-b-2");
  });

  it("uses the same breakpoint the top navigation hides its labels at", () => {
    // The whole point of reusing it rather than choosing one. If the nav's changes, this
    // fails and both should move together.
    const source = fs.readFileSync(path.join(__dirname, "UnderlineTabs.jsx"), "utf8");
    expect(alfred).toContain('<span className="hidden lg:inline">{item.label}</span>');
    expect(source).toContain('"hidden lg:inline"');
  });
});
