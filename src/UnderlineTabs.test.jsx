import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import { StickyNote } from "lucide-react";
import UnderlineTabs from "./UnderlineTabs";

const TABS = [
  { key: "active", label: "Active", count: 1 },
  { key: "today", label: "Today", count: 4 },
];

const tab = (name) => screen.getByRole("tab", { name });

describe("what it renders", () => {
  it("one tab per entry, with its count in brackets", () => {
    render(<UnderlineTabs tabs={TABS} activeKey="active" onSelect={jest.fn()} />);
    expect(tab("Active (1)")).toBeInTheDocument();
    expect(tab("Today (4)")).toBeInTheDocument();
  });

  it("omits the brackets when a tab has no count", () => {
    // The Recycle Bin's tabs have none: its contents are fetched per tab, so a number
    // would mean a query per tab on arrival.
    render(<UnderlineTabs tabs={[{ key: "items", label: "Items" }]} activeKey="items" onSelect={jest.fn()} />);
    expect(tab("Items")).toBeInTheDocument();
  });

  it("renders a count of zero rather than hiding it", () => {
    // "All (0)" on an empty inbox is the truth, and the tab has to stay because it is
    // the way back.
    render(<UnderlineTabs tabs={[{ key: "all", label: "All", count: 0 }]} activeKey="all" onSelect={jest.fn()} />);
    expect(tab("All (0)")).toBeInTheDocument();
  });

  it("renders an icon when one is given", () => {
    const { container } = render(
      <UnderlineTabs
        tabs={[{ key: "manual", label: "Capture", count: 2, icon: StickyNote }]}
        activeKey="manual"
        onSelect={jest.fn()}
      />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("selection", () => {
  it("marks the active tab, and only it", () => {
    render(<UnderlineTabs tabs={TABS} activeKey="today" onSelect={jest.fn()} />);
    expect(tab("Today (4)")).toHaveAttribute("aria-selected", "true");
    expect(tab("Active (1)")).toHaveAttribute("aria-selected", "false");
  });

  it("underlines the active tab and not the others", () => {
    render(<UnderlineTabs tabs={TABS} activeKey="today" onSelect={jest.fn()} />);
    expect(tab("Today (4)")).toHaveClass("border-primary", "text-primary");
    expect(tab("Active (1)")).toHaveClass("border-transparent");
  });

  it("reports the key that was tapped", () => {
    const onSelect = jest.fn();
    render(<UnderlineTabs tabs={TABS} activeKey="active" onSelect={onSelect} />);
    fireEvent.click(tab("Today (4)"));
    expect(onSelect).toHaveBeenCalledWith("today");
  });

  it("reports a tap on the already-active tab too", () => {
    // Left to the caller: the inbox treats it as a no-op, and nothing here should decide
    // that for a future screen.
    const onSelect = jest.fn();
    render(<UnderlineTabs tabs={TABS} activeKey="active" onSelect={onSelect} />);
    fireEvent.click(tab("Active (1)"));
    expect(onSelect).toHaveBeenCalledWith("active");
  });
});

describe("the row itself", () => {
  it("is a tablist, named for what it filters", () => {
    render(<UnderlineTabs tabs={TABS} activeKey="active" onSelect={jest.fn()} ariaLabel="Executions" />);
    expect(screen.getByRole("tablist", { name: "Executions" })).toBeInTheDocument();
  });

  it("always scrolls sideways rather than wrapping", () => {
    // Eight tabs in the Recycle Bin, up to seven in the inbox on a phone. Wrapping would
    // put a second underlined row under the first.
    render(<UnderlineTabs tabs={TABS} activeKey="active" onSelect={jest.fn()} />);
    expect(screen.getByRole("tablist")).toHaveClass("overflow-x-auto", "border-b");
  });

  it("takes spacing from the caller without letting it restyle the tabs", () => {
    render(
      <UnderlineTabs tabs={TABS} activeKey="active" onSelect={jest.fn()} className="gap-4 mb-4 text-sm" />,
    );
    const list = screen.getByRole("tablist");
    expect(list).toHaveClass("gap-4", "mb-4", "text-sm", "border-b");
  });
});

// ── The guard ────────────────────────────────────────────────────────────────
describe("every underline tab row goes through this component", () => {
  const alfred = fs.readFileSync(path.join(__dirname, "Alfred.jsx"), "utf8");

  it("has all three call sites", () => {
    // Home's Active/Paused/Today, the Recycle Bin's record types, and the Inbox's source
    // filter.
    expect(alfred.split("<UnderlineTabs").length - 1).toBe(3);
  });

  it("leaves no hand-rolled tab row behind", () => {
    // The class string this replaced. It was written out in two places, once by hand
    // three times over and once through a .map — which is why the inbox would have been
    // a third copy.
    expect(alfred).not.toContain("pb-2 border-b-2");
  });
});
