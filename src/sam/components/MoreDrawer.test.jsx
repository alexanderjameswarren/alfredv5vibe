import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import MoreDrawer, { DrawerSection } from "./MoreDrawer";

function mount(open = true) {
  const onClose = jest.fn();
  const utils = render(
    <MoreDrawer open={open} onClose={onClose}>
      <DrawerSection title="Sound"><button>Beat</button></DrawerSection>
      <DrawerSection title="Stats"><span>Hits: 0</span></DrawerSection>
    </MoreDrawer>
  );
  return { onClose, ...utils };
}

test("closed renders nothing", () => {
  const { container } = mount(false);
  expect(container).toBeEmptyDOMElement();
});

test("open: a dialog with its sections, scrolling inside itself, beside the rail", () => {
  mount();
  const panel = screen.getByRole("dialog", { name: "More" });
  expect(panel).toHaveClass("overflow-y-auto", "w-[410px]");
  expect(screen.getByRole("region", { name: "Sound" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Stats" })).toBeInTheDocument();
  // eslint-disable-next-line testing-library/no-node-access
  expect(panel.parentElement).toHaveClass("left-[136px]", "overflow-hidden");
});

test("Escape closes it", () => {
  const { onClose } = mount();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

test("tapping the dim area closes it; tapping inside does not", () => {
  const { onClose } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Beat" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("more-drawer-dim"));
  expect(onClose).toHaveBeenCalled();
});

test("no Escape listener while closed", () => {
  const { onClose } = mount(false);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});
