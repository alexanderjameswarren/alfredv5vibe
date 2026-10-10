import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import RecordLinks from "./RecordLinks";

test("context pill, intention and item by name, execution by icon only", () => {
  const open = { context: jest.fn(), intention: jest.fn(), item: jest.fn(), execution: jest.fn() };
  render(
    <RecordLinks
      context={{ name: "Home", onOpen: open.context }}
      intention={{ name: "Water plants", onOpen: open.intention }}
      item={{ name: "Plant list", onOpen: open.item }}
      execution={{ title: "Open execution", onOpen: open.execution }}
    />,
  );
  fireEvent.click(screen.getByTitle("Open context: Home"));
  fireEvent.click(screen.getByRole("button", { name: "Open intention: Water plants" }));
  fireEvent.click(screen.getByRole("button", { name: "Open item: Plant list" }));
  const exec = screen.getByRole("button", { name: "Open execution" });
  expect(exec.textContent).toBe("");
  fireEvent.click(exec);
  for (const fn of Object.values(open)) expect(fn).toHaveBeenCalled();
});

test("a context with no handler is a plain pill; nothing given renders nothing", () => {
  const { container, rerender } = render(<RecordLinks context={{ name: "Home" }} />);
  expect(screen.getByText("Home").closest("button")).toBeNull();
  rerender(<RecordLinks />);
  expect(container.textContent).toBe("");
});
