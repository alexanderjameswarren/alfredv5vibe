import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import RecordLinkScreen from "./RecordLinkScreen";

jest.mock("../supabaseClient", () => ({ supabase: {} }));

const resolveTo = (data, error = null) => jest.fn(async () => ({ data, error }));

const lookup = {
  inbox: (id) => (id === "x1" ? { id, archived: false } : id === "a1" ? { id, archived: true } : null),
  item: () => false,
  intention: () => false,
  context: () => false,
  collection: () => false,
  archivedTarget: () => null,
};

describe("RecordLinkScreen", () => {
  it("shows loading, then opens a mapped record", async () => {
    const onOpen = jest.fn();
    const resolve = resolveTo({ table: "inbox", row: { id: "x1" }, match_count: 1 });
    render(<RecordLinkScreen recordId="x1" onOpen={onOpen} lookup={lookup} resolve={resolve} />);
    screen.getByText(/Looking up/);
    await screen.findByText("Opening…");
    expect(resolve).toHaveBeenCalledWith("x1");
    expect(onOpen).toHaveBeenCalledWith({ kind: "path", path: "/inbox/detail/x1" });
  });

  it("renders the generic page with collapsed large fields", async () => {
    const onOpen = jest.fn();
    const row = { id: "d1", name: "Bill Evans", meta: { a: 1 } };
    render(
      <RecordLinkScreen
        recordId="d1"
        onOpen={onOpen}
        lookup={lookup}
        resolve={resolveTo({ table: "dj_artists", row, match_count: 2 })}
      />
    );
    await screen.findByText("Record from dj_artists");
    screen.getByText(/matches 2 records/);
    screen.getByText("Bill Evans");
    expect(screen.queryByText(/"a": 1/)).toBeNull();
    fireEvent.click(screen.getByText("Show"));
    screen.getByText(/"a": 1/);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("archived inbox with no successor shows the generic page, not the list", async () => {
    const onOpen = jest.fn();
    const row = { id: "a1", archived: true, captured_text: "old capture" };
    render(
      <RecordLinkScreen
        recordId="a1"
        onOpen={onOpen}
        lookup={lookup}
        resolve={resolveTo({ table: "inbox", row, match_count: 1 })}
      />
    );
    await screen.findByText("Record from inbox");
    screen.getByText("old capture");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders not found for null", async () => {
    render(<RecordLinkScreen recordId="z9" onOpen={jest.fn()} lookup={lookup} resolve={resolveTo(null)} />);
    await screen.findByText("No record with this ID");
  });
});
