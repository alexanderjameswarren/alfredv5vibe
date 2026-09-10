import React, { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import ItemPicker, { ITEM_PICKER_CAP } from "./ItemPicker";

const CONTEXTS = [
  { id: "shop", name: "Shopping" },
  { id: "rec", name: "Recipes" },
];

const ITEMS = [
  { id: "1", name: "Salt", contextId: "shop" },
  { id: "2", name: "Kosher salt", contextId: "rec" },
  { id: "3", name: "Pepper", contextId: "shop", description: "salt's friend" },
  { id: "4", name: "Old salt", contextId: "shop", archived: true },
];

// The picker is controlled; this owns the query the way every caller does.
function Harness({ initialQuery = "", ...props }) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <ItemPicker
      items={ITEMS}
      contexts={CONTEXTS}
      onPick={() => {}}
      {...props}
      query={query}
      onQueryChange={setQuery}
    />
  );
}

const box = () => screen.getByPlaceholderText("Search for an item...");
const type = (text) => fireEvent.change(box(), { target: { value: text } });
const rowNames = () =>
  screen
    .queryAllByRole("button")
    .map((b) => b.querySelector(".font-medium")?.textContent);

describe("ItemPicker", () => {
  afterEach(() => jest.useRealTimers());

  test("dropdown shows nothing until you type, even when focused", () => {
    render(<Harness variant="dropdown" />);
    fireEvent.focus(box());
    expect(rowNames()).toEqual([]);
    type("salt");
    expect(rowNames()).toEqual(["Salt", "Kosher salt"]);
  });

  test("archived items never appear", () => {
    render(<Harness variant="inline" />);
    expect(rowNames()).not.toContain("Old salt");
    expect(rowNames()).toEqual(["Salt", "Kosher salt", "Pepper"]);
  });

  test("matches name only, not description", () => {
    render(<Harness variant="popup" initialQuery="friend" />);
    expect(rowNames()).toEqual([]);
    expect(screen.getByText("No matching items")).toBeTruthy();
  });

  test("trims the query", () => {
    render(<Harness variant="popup" initialQuery="  pepper  " />);
    expect(rowNames()).toEqual(["Pepper"]);
  });

  test("dropdown says so when a search matches nothing", () => {
    render(<Harness variant="dropdown" />);
    fireEvent.focus(box());
    type("zzq");
    expect(screen.getByText("No matching items")).toBeTruthy();
  });

  test("says when there is nothing to pick at all", () => {
    render(<Harness variant="popup" exclude={() => true} />);
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  test("exclude removes site-specific rows", () => {
    render(<Harness variant="inline" exclude={(i) => i.id === "1"} />);
    expect(rowNames()).toEqual(["Kosher salt", "Pepper"]);
  });

  test("caps results and says how many were cut", () => {
    const many = Array.from({ length: 25 }, (_, n) => ({
      id: `m${n}`,
      name: `Item ${n}`,
    }));
    render(<Harness variant="popup" items={many} />);
    expect(rowNames()).toHaveLength(ITEM_PICKER_CAP);
    expect(
      screen.getByText(`Showing ${ITEM_PICKER_CAP} of 25 — keep typing to narrow`),
    ).toBeTruthy();
  });

  test("shows the context name unless turned off", () => {
    const { unmount } = render(<Harness variant="popup" initialQuery="salt" />);
    expect(screen.getByText("Shopping")).toBeTruthy();
    expect(screen.getByText("Recipes")).toBeTruthy();
    unmount();
    render(<Harness variant="popup" initialQuery="salt" showContext={false} />);
    expect(screen.queryByText("Shopping")).toBeNull();
  });

  test("inline list hides 200ms after the box loses focus, and returns on focus", () => {
    jest.useFakeTimers();
    render(<Harness variant="inline" />);
    expect(rowNames().length).toBeGreaterThan(0);
    fireEvent.blur(box());
    act(() => jest.advanceTimersByTime(199));
    expect(rowNames().length).toBeGreaterThan(0);
    act(() => jest.advanceTimersByTime(1));
    expect(rowNames()).toEqual([]);
    fireEvent.focus(box());
    expect(rowNames().length).toBeGreaterThan(0);
  });

  test("popup list does not hide when the box loses focus", () => {
    jest.useFakeTimers();
    render(<Harness variant="popup" />);
    fireEvent.blur(box());
    act(() => jest.advanceTimersByTime(1000));
    expect(rowNames()).toEqual(["Salt", "Kosher salt", "Pepper"]);
  });

  test("tapping a row picks that item", () => {
    const onPick = jest.fn();
    render(<Harness variant="inline" onPick={onPick} />);
    fireEvent.click(screen.getByText("Pepper"));
    expect(onPick).toHaveBeenCalledWith(ITEMS[2]);
  });
});
