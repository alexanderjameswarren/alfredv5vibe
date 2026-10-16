import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import HelpButton, { HelpAfter } from "./HelpButton";
import { HELP } from "./helpText";

test("opens the four headings and closes", () => {
  render(<HelpButton helpKey="transaction.kind" />);
  fireEvent.click(screen.getByRole("button", { name: "About Kind" }));
  const text = screen.getByRole("dialog", { name: "Kind" }).textContent;
  for (const h of ["What this is", "What's included", "What's left out", "What to do", HELP["transaction.kind"].todo]) {
    expect(text).toContain(h);
  }
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("shows live working when given", () => {
  render(<HelpButton helpKey="spending.by_category" working={<p>ZZ working</p>} />);
  fireEvent.click(screen.getByRole("button", { name: /About Spending by category/ }));
  expect(screen.getByRole("dialog").textContent).toContain("How this was worked out from your data");
  expect(screen.getByText("ZZ working")).toBeTruthy();
});

test("Escape closes", () => {
  render(<HelpButton helpKey="spending.cash_flow" />);
  fireEvent.click(screen.getByRole("button", { name: "About Cash flow" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the open panel is a child of document.body, not inside the title", () => {
  render(<h3 data-testid="title">Cash flow, last 6 <HelpAfter helpKey="spending.cash_flow">months</HelpAfter></h3>);
  fireEvent.click(screen.getByRole("button", { name: "About Cash flow" }));
  const dialog = screen.getByRole("dialog");
  expect(screen.getByTestId("title").contains(dialog)).toBe(false);
  expect(dialog.parentElement.parentElement).toBe(document.body);
});

test("a click inside the panel does not reach the title's ancestors", () => {
  const outer = jest.fn();
  render(<div onClick={outer}><HelpButton helpKey="spending.cash_flow" /></div>);
  fireEvent.click(screen.getByRole("button", { name: "About Cash flow" }));
  fireEvent.click(screen.getByRole("dialog"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(outer).not.toHaveBeenCalled();
});

test("an unknown key renders nothing", () => {
  const { container } = render(<HelpButton helpKey="no.such.key" />);
  expect(container.innerHTML).toBe("");
});
