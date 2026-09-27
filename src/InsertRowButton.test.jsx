// The shared inline plus that inserts a row at a position. Extracted from the two
// identical copies in Alfred.jsx and InboxDetailView.jsx, and now also used by the
// warm-up ladder editor.

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import InsertRowButton from "./InsertRowButton";

test("a plus, named by where the new row lands", () => {
  render(<InsertRowButton onClick={() => {}} title="Insert element below" />);
  const button = screen.getByRole("button", { name: "Insert element below" });
  expect(button).toHaveTextContent("+");
  // A lone "+" says nothing to a screen reader, so the title is the name too.
  expect(button).toHaveAttribute("title", "Insert element below");
});

test("it calls back on click", () => {
  const onClick = jest.fn();
  render(<InsertRowButton onClick={onClick} title="Insert element below" />);
  fireEvent.click(screen.getByRole("button", { name: "Insert element below" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("disabled: refused, and the tooltip carries the reason while the name keeps the position", () => {
  const onClick = jest.fn();
  render(
    <InsertRowButton
      onClick={onClick}
      disabled
      title="A ladder can have at most 6 rungs"
      label="Insert a rung above rung 2 — a ladder can have at most 6 rungs"
    />
  );
  const button = screen.getByRole("button", { name: /Insert a rung above rung 2/ });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", "A ladder can have at most 6 rungs");
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

test("it sits in the gap between rows rather than claiming a row of its own", () => {
  const { container } = render(<InsertRowButton onClick={() => {}} title="Insert element below" />);
  // `-my-1` is the whole reason this is a component and not a plain button: it is
  // what lets the control overlap the gap it sits in.
  // eslint-disable-next-line testing-library/no-node-access
  expect(container.firstChild.className).toMatch(/-my-1/);
});
