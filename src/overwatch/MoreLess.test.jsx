import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import FrictionSection from "./FrictionSection";
import IdeasSection from "./IdeasSection";

// jsdom does no layout, so the clamp is simulated: text over 40 characters "overflows".
let heights;
beforeAll(() => {
  heights = {
    scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true, get() { return this.textContent.length > 40 ? 80 : 40; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 40; } });
});
afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", heights.scroll || { configurable: true, value: 0 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", heights.client || { configurable: true, value: 0 });
});

const LONG = "The testing steps put two actions in one step, so the second was missed and the run had to be redone";
const entry = (id, text) => ({ id, process: "todos", occurred_at: "2026-10-25T18:00:00Z", what_happened: text });

test("friction: More only where the text is clamped or cut to its first line; Less collapses", () => {
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
  render(<FrictionSection entries={[entry("a", LONG), entry("b", "Short one"), entry("c", "First line\nsecond line")]}
    settings={{}} />);
  const mores = screen.getAllByRole("button", { name: "More" });
  expect(mores).toHaveLength(2);
  expect(screen.getByText("First line").tagName).toBe("P");
  fireEvent.click(mores[1]);
  expect(screen.getByText(/First line\s+second line/)).toHaveClass("whitespace-pre-line");
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Less" }));
  expect(screen.getByText("First line")).toHaveClass("line-clamp-2");
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

test("ideas: More on a long name expands it in place and never follows the row's link", () => {
  render(
    <MemoryRouter initialEntries={["/overwatch"]}>
      <Routes>
        <Route path="/overwatch" element={<IdeasSection data={{ records: [], projects: [
          { group_id: "g1", name: LONG, group_status: "someday", created_at: null },
          { group_id: "g2", name: "Short", group_status: "someday", created_at: null },
        ] }} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  const heading = screen.getByRole("button", { name: /Someday and parked Projects \(2\)/ });
  fireEvent.click(heading);
  expect(screen.getAllByRole("button", { name: "More" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(heading).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByTestId("where")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: LONG })).not.toHaveClass("line-clamp-2");
  expect(screen.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
});
