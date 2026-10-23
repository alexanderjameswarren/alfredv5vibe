import React, { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { moveItem, useDragReorder } from "./useDragReorder";

test("moveItem moves one row", () => {
  expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
});

function List({ onCommit }) {
  const [rows, setRows] = useState(["a", "b", "c"]);
  const { rowProps } = useDragReorder(setRows, onCommit);
  return rows.map((r, i) => (
    <div key={r} data-testid={r} {...rowProps(i)}>
      {r}
    </div>
  ));
}

test("drag-over follows the finger and drop commits once", () => {
  const onCommit = jest.fn();
  const { container } = render(<List onCommit={onCommit} />);
  fireEvent.dragStart(screen.getByTestId("a"), { dataTransfer: {} });
  fireEvent.dragOver(screen.getByTestId("b"));
  fireEvent.dragOver(screen.getByTestId("c"));
  expect(container.textContent).toBe("bca");
  fireEvent.dragEnd(screen.getByTestId("a"));
  expect(onCommit).toHaveBeenCalledTimes(1);
});
