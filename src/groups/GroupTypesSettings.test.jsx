import React from "react";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import GroupTypesSettings from "./GroupTypesSettings";

const TYPES = [
  { id: "menu", labelSingular: "Menu", labelPlural: "Menus", icon: "UtensilsCrossed", executionMode: "together" },
  { id: "trip", labelSingular: "P5 Test Type", labelPlural: "P5 Test Types", icon: "Plane", executionMode: "separately" },
];
const GROUPS = [{ id: "g1", groupTypeId: "menu" }];

function setup() {
  const writer = {
    set: jest.fn(async (_key, row) => row),
    delete: jest.fn(async () => true),
  };
  const setGroupTypes = jest.fn();
  render(<GroupTypesSettings groupTypes={TYPES} itemGroups={GROUPS} setGroupTypes={setGroupTypes} writer={writer} newId={() => "new1"} />);
  return { writer, setGroupTypes };
}

test("lists types; Delete only on one no group uses", () => {
  setup();
  expect(screen.getByText("Cooked together (one tap starts every member) · 1 group")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Menu" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete P5 Test Type" })).toBeInTheDocument();
});

test("Add writes a new type with the chosen icon and mode", async () => {
  const { writer, setGroupTypes } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Trip" } });
  fireEvent.change(screen.getByLabelText("Plural"), { target: { value: "Trips" } });
  fireEvent.click(screen.getByRole("button", { name: "Sprout" }));
  fireEvent.click(screen.getByLabelText("Cooked together (one tap starts every member)"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(setGroupTypes).toHaveBeenCalled());
  expect(writer.set).toHaveBeenCalledWith("group_type:new1", {
    id: "new1", labelSingular: "Trip", labelPlural: "Trips", icon: "Sprout", executionMode: "together",
  });
});

test("Edit refuses a clashing name and keeps the form", () => {
  const { writer } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Edit P5 Test Type" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Menu" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("There is already a type called Menu.")).toBeInTheDocument();
  expect(writer.set).not.toHaveBeenCalled();
});

test("Delete asks first, with a real Cancel", async () => {
  const { writer, setGroupTypes } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Delete P5 Test Type" }));
  const dialog = screen.getByRole("dialog", { name: "Delete group type" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(writer.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete P5 Test Type" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(writer.delete).toHaveBeenCalledWith("group_type:trip"));
  expect(setGroupTypes).toHaveBeenCalled();
});
