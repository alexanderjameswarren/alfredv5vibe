import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import StatusMenu from "./StatusMenu";

function open(status) {
  const onChoose = jest.fn();
  render(<StatusMenu row={{ status }} onChoose={onChoose} />);
  fireEvent.click(screen.getByRole("button", { name: /^Status:/ }));
  return onChoose;
}

test("shows the current status on the pill and checks it in the menu", () => {
  open("active");
  expect(screen.getByRole("menuitemradio", { name: "Active" }).getAttribute("aria-checked")).toBe("true");
});

test("someday is offered only while the row is someday", () => {
  open("active");
  expect(screen.queryByRole("menuitemradio", { name: "Someday" })).toBeNull();
});

test("choosing another status reports it and closes", () => {
  const onChoose = open("active");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Closed" }));
  expect(onChoose).toHaveBeenCalledWith("closed");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("choosing the current status does nothing", () => {
  const onChoose = open("background");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Background" }));
  expect(onChoose).not.toHaveBeenCalled();
});
