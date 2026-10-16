import React, { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import NumberInput, { parseWhole } from "./NumberInput";

test("parseWhole: whole numbers in range only", () => {
  expect(parseWhole("3")).toBe(3);
  expect(parseWhole("")).toBeNull();
  expect(parseWhole("0")).toBeNull();
  expect(parseWhole("2.5")).toBeNull();
  expect(parseWhole("40", { max: 31 })).toBeNull();
});

function Box({ initial = "1", max }) {
  const [value, setValue] = useState(initial);
  return <NumberInput aria-label="n" value={value} onChange={setValue} max={max} />;
}

test("may be emptied while typing, with no snap back, and then says Required", () => {
  render(<Box />);
  const box = screen.getByLabelText("n");
  fireEvent.change(box, { target: { value: "" } });
  expect(box).toHaveValue("");
  expect(screen.getByText("Required")).toBeInTheDocument();
  fireEvent.change(box, { target: { value: "3" } });
  expect(box).toHaveValue("3");
  expect(screen.queryByText("Required")).toBeNull();
});

test("ignores anything that is not a digit", () => {
  render(<Box />);
  fireEvent.change(screen.getByLabelText("n"), { target: { value: "1a" } });
  expect(screen.getByLabelText("n")).toHaveValue("1");
});

test("over the maximum says so", () => {
  render(<Box initial="40" max={31} />);
  expect(screen.getByText("At most 31")).toBeInTheDocument();
});

test("focus selects the whole value, so typing replaces it", () => {
  render(<Box initial="12" />);
  const box = screen.getByLabelText("n");
  fireEvent.focus(box);
  expect(box.selectionStart).toBe(0);
  expect(box.selectionEnd).toBe(2);
});
