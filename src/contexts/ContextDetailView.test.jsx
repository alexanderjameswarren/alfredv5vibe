import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContextDetailView from "./ContextDetailView";

jest.mock("../apps/useApps", () => ({
  __esModule: true,
  default: () => [{ id: "arnold", name: "Arnold", icon: "Dumbbell" }],
}));

const SORT = { sortKey: "name", sortDir: "asc" };

function renderDetail(context) {
  return render(
    <ContextDetailView
      contextId={context.id}
      context={context}
      items={[]}
      intents={[]}
      contexts={[context]}
      getIntentDisplay={(i) => i.text}
      sort={SORT}
    />,
  );
}

const CTX = { id: "c1", name: "Kitchen" };
const ITEMS = [
  { id: "fan", name: "Vent fan", contextId: "c1", status: "active", tags: ["repair"] },
  { id: "pot", name: "Stock pot", contextId: "c1", status: "someday", tags: [] },
];
const INTENTS = [
  { id: "fix", text: "Vent fan", itemId: "fan", contextId: "c1", status: "active", tags: [] },
  { id: "call", text: "Call the plumber", itemId: null, contextId: "c1", status: "active", tags: ["phone"] },
];

function renderRows(props = {}) {
  return render(
    <ContextDetailView
      contextId="c1"
      context={CTX}
      items={ITEMS}
      intents={INTENTS}
      contexts={[CTX]}
      getIntentDisplay={(i) => i.text}
      sort={{ sortKey: "title", sortDir: "asc" }}
      statusFilter={{ selected: ["someday", "active", "background", "closed"], toggle: () => {} }}
      onOpenAddItem={() => {}}
      onOpenAddIntention={() => {}}
      {...props}
    />,
  );
}

describe("ContextDetailView: one row per thing", () => {
  it("shows an item and its intention once", () => {
    renderRows();
    expect(screen.getAllByText("Vent fan")).toHaveLength(1);
    expect(screen.getByText("Items and intentions (3)")).toBeInTheDocument();
  });

  it("opens item detail from a merged row", () => {
    const onViewItemDetail = jest.fn();
    const onViewIntentionDetail = jest.fn();
    renderRows({ onViewItemDetail, onViewIntentionDetail });
    fireEvent.click(screen.getByText("Vent fan"));
    expect(onViewItemDetail).toHaveBeenCalledWith("fan");
    expect(onViewIntentionDetail).not.toHaveBeenCalled();
  });

  it("opens intention detail from an intention with no item", () => {
    const onViewIntentionDetail = jest.fn();
    renderRows({ onViewIntentionDetail });
    fireEvent.click(screen.getByText("Call the plumber"));
    expect(onViewIntentionDetail).toHaveBeenCalledWith("call");
  });

  it("gives every row Close and none Archive", () => {
    renderRows({ onCloseRecords: jest.fn(), onArchiveIntention: jest.fn() });
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(3);
    expect(screen.queryByTitle(/Archive this intention/)).toBeNull();
  });

  it("shows the item's status on a merged row, and Not scheduled when its intentions are closed", () => {
    renderRows({
      items: [{ id: "t3", name: "SomedayTest3", contextId: "c1", status: "active", tags: [] }],
      intents: [{ id: "x", text: "SomedayTest3", itemId: "t3", contextId: "c1", status: "closed", tags: [] }],
      onCloseRecords: jest.fn(),
    });
    expect(screen.getByText("Not scheduled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Closed (0)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("hides Close on rows that read Closed", () => {
    renderRows({
      items: [{ id: "s4", name: "SomeDay test 4", contextId: "c1", status: "closed", tags: [] }],
      intents: [{ id: "y", text: "Back arrow", itemId: null, contextId: "c1", status: "closed", tags: [] }],
      onCloseRecords: jest.fn(),
    });
    expect(screen.getByText("SomeDay test 4")).toBeInTheDocument();
    expect(screen.getByText("Back arrow")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("counts chips under the search text, a merged row once", () => {
    renderRows({
      search: "somed",
      items: [
        { id: "s4t", name: "Someday4 test", contextId: "c1", status: "closed", tags: [] },
        { id: "s3", name: "SomedayTest3", contextId: "c1", status: "active", tags: [] },
        { id: "other", name: "Kettle", contextId: "c1", status: "closed", tags: [] },
      ],
      intents: [{ id: "x", text: "Someday4 test", itemId: "s4t", contextId: "c1", status: "closed", tags: [] }],
    });
    expect(screen.getByRole("button", { name: "Closed (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active (1)" })).toBeInTheDocument();
  });

  it("counts tags under the search text, a merged row once", () => {
    renderRows({
      search: "fan",
      items: [{ id: "fan", name: "Vent fan", contextId: "c1", status: "active", tags: ["repair"] }],
      intents: [
        { id: "fix", text: "Vent fan", itemId: "fan", contextId: "c1", status: "active", tags: ["repair"] },
        { id: "call", text: "Call the plumber", itemId: null, contextId: "c1", status: "active", tags: ["repair", "phone"] },
      ],
    });
    expect(screen.getByRole("button", { name: "repair (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^phone/ })).toBeNull();
  });

  it("counts tags under the status chips that are on", () => {
    renderRows({
      statusFilter: { selected: ["active"], toggle: () => {} },
      items: [
        { id: "a", name: "A", contextId: "c1", status: "active", tags: ["ai"] },
        { id: "b", name: "B", contextId: "c1", status: "closed", tags: ["ai", "old"] },
      ],
      intents: [],
    });
    expect(screen.getByRole("button", { name: "ai (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^old/ })).toBeNull();
  });

  it("gives an item row with no live intention item detail's Start Now and Schedule", () => {
    const onStartNowItem = jest.fn();
    const item = { id: "sd", name: "Someday test", contextId: "c1", status: "active", tags: [] };
    renderRows({ items: [item], intents: [], onStartNowItem, onScheduleItem: jest.fn(), onCloseRecords: jest.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Start Now" }));
    expect(onStartNowItem).toHaveBeenCalledWith("sd");
    expect(screen.getByRole("button", { name: /Schedule/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("disables Start Now and Schedule on a Closed item row, with no Close", () => {
    renderRows({
      items: [{ id: "s4t", name: "Someday4 test", contextId: "c1", status: "closed", tags: [] }],
      intents: [],
      onStartNowItem: jest.fn(),
      onScheduleItem: jest.fn(),
      onCloseRecords: jest.fn(),
    });
    expect(screen.getByRole("button", { name: "Start Now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Schedule/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("applies the tag filter to intentions too, and counts follow it", () => {
    renderRows({ filterTag: "phone" });
    expect(screen.getByText("Call the plumber")).toBeInTheDocument();
    expect(screen.queryByText("Vent fan")).toBeNull();
    expect(screen.getByRole("button", { name: "Active (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Someday (0)" })).toBeInTheDocument();
  });
});

describe("ContextDetailView app line", () => {
  it("shows the linked app", () => {
    renderDetail({ id: "c1", name: "Body", appId: "arnold" });
    expect(screen.getByText("Arnold")).toBeInTheDocument();
    expect(screen.getByText("App:")).toBeInTheDocument();
  });

  it("shows nothing without an app", () => {
    renderDetail({ id: "c1", name: "Body", appId: null });
    expect(screen.queryByText("App:")).toBeNull();
  });
});
