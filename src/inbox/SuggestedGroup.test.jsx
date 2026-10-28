import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import SuggestedGroup, { groupLabel } from "./SuggestedGroup";

const GROUPS = [
  { id: "g-ow", name: "Overwatch", typeLabel: "Project", typeIcon: "SquareKanban", contextId: "ctx-alfred" },
  { id: "g-sam", name: "SAM import", typeLabel: "Project", typeIcon: "SquareKanban", contextId: "ctx-alfred" },
  { id: "g-menu", name: "Pinto Beans and Spanish Rice", typeLabel: "Menu", typeIcon: "UtensilsCrossed", contextId: "ctx-recipes" },
];

const renderPicker = (props) => {
  const onChange = jest.fn();
  render(<MemoryRouter><SuggestedGroup groups={GROUPS} onChange={onChange} {...props} /></MemoryRouter>);
  return onChange;
};
const optionNames = () => screen.getAllByRole("option").map((o) => o.textContent);

test("groupLabel is the type, then the name", () => {
  expect(groupLabel(GROUPS[2])).toBe("Menu: Pinto Beans and Spanish Rice");
});

test("the context's groups first, with a way to see them all", () => {
  renderPicker({ contextId: "ctx-alfred", value: "" });
  expect(optionNames()).toEqual(["No group", "Project: Overwatch", "Project: SAM import"]);
  fireEvent.click(screen.getByRole("button", { name: "Show all groups (3)" }));
  expect(optionNames()).toEqual(["No group", "Menu: Pinto Beans and Spanish Rice", "Project: Overwatch", "Project: SAM import"]);
  fireEvent.click(screen.getByRole("button", { name: "Only this context's groups" }));
  expect(optionNames()).toHaveLength(3);
});

test("with no context every group shows, and no toggle", () => {
  renderPicker({ contextId: "", value: "" });
  expect(optionNames()).toHaveLength(4);
  expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
});

test("a chosen group outside the context stays listed, and links to its page", () => {
  const onChange = renderPicker({ contextId: "ctx-alfred", value: "g-menu" });
  expect(screen.getByLabelText("Group")).toHaveValue("g-menu");
  expect(optionNames()[1]).toBe("Menu: Pinto Beans and Spanish Rice");
  expect(screen.getByRole("link", { name: "Open Pinto Beans and Spanish Rice" })).toHaveAttribute("href", "/groups/detail/g-menu");
  fireEvent.change(screen.getByLabelText("Group"), { target: { value: "" } });
  expect(onChange).toHaveBeenCalledWith("");
});

test("a suggestion that is no longer open says so", () => {
  renderPicker({ contextId: "", value: "g-closed" });
  expect(screen.getByLabelText("Group")).toHaveValue("g-closed");
  expect(screen.getByRole("option", { name: "Suggested group (no longer open)" })).toBeInTheDocument();
  expect(screen.getByText(/closed or archived now/)).toBeInTheDocument();
});
