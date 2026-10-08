import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Archive, Copy } from "lucide-react";
import OverflowMenu from "./OverflowMenu";

function setup() {
  const clone = jest.fn();
  const archive = jest.fn();
  render(
    <OverflowMenu
      actions={[
        { label: "Clone", icon: Copy, onClick: clone },
        { label: "Archive", icon: Archive, onClick: archive, disabled: true, title: "Cannot archive" },
      ]}
    />,
  );
  return { clone, archive };
}

test("closed until the ⋯ button is tapped", () => {
  setup();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Clone", "Archive"]);
});

test("a row runs its action and closes the menu", () => {
  const { clone } = setup();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Clone" }));
  expect(clone).toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("a disabled row keeps its reason", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  const row = screen.getByRole("menuitem", { name: "Archive" });
  expect(row.disabled).toBe(true);
  expect(row.title).toBe("Cannot archive");
});

test("Escape closes it", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
});
