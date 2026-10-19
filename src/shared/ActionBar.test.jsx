import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import ActionBar, { actionsThatFit } from "./ActionBar";

describe("actionsThatFit", () => {
  // Gaps of 8, the ⋯ button 44 wide.
  test("everything fits: no ⋯", () => {
    expect(actionsThatFit(400, [100, 100, 100])).toBe(3);
  });

  test("otherwise as many as fit beside ⋯", () => {
    // 100 + 8 + 100 + 8 + 44 = 260 <= 300; a third would need 368.
    expect(actionsThatFit(300, [100, 100, 100, 100])).toBe(2);
  });

  test("never fewer than the pinned ones", () => {
    expect(actionsThatFit(120, [100, 100, 100], { pinned: 2 })).toBe(2);
  });

  test("menu-only entries always leave room for ⋯", () => {
    expect(actionsThatFit(316, [100, 100, 100], { menuOnly: true })).toBe(2);
  });
});

test("where it cannot measure, every action is a button; menu-only ones sit in ⋯", () => {
  render(
    <ActionBar
      actions={[
        { key: "a", button: <button>Alpha</button>, menu: { label: "Alpha", onClick: () => {} } },
        { key: "b", button: <button>Beta</button>, menu: { label: "Beta", onClick: () => {} } },
      ]}
      menuOnly={[{ label: "Gamma", onClick: () => {} }]}
    />,
  );
  expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
});

test("no ⋯ when there is nothing for it", () => {
  render(<ActionBar actions={[{ key: "a", button: <button>Alpha</button>, menu: null, pinned: true }]} />);
  expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
});
