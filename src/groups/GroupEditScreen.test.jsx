import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import GroupEditScreen from "./GroupEditScreen";

const contexts = [
  { id: "recipes", name: "Recipes", defaultGroupTypeId: "menu" },
  { id: "alfred", name: "Alfred" },
];
const groupTypes = [
  { id: "menu", contextId: "recipes", labelSingular: "Menu", icon: "UtensilsCrossed" },
  { id: "proj", contextId: "alfred", labelSingular: "Project", icon: "SquareKanban" },
];
const items = [
  { id: "rice", name: "Rice", contextId: "recipes" },
  { id: "beans", name: "Beans", contextId: "recipes" },
  { id: "bug", name: "Bug list", contextId: "alfred" },
];
const intents = [{ id: "fix", text: "Fix the bug", contextId: "alfred" }];

function renderNew(onSave = jest.fn(async () => {})) {
  render(
    <GroupEditScreen
      initialContextId="recipes"
      groupTypes={groupTypes}
      contexts={contexts}
      items={items}
      intents={intents}
      groupMembers={[]}
      onSave={onSave}
      onCancel={jest.fn()}
    />,
  );
  return onSave;
}

test("a new group defaults to the context's type and searches only that context", () => {
  renderNew();
  expect(screen.getByRole("heading", { name: "New Menu" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Rice/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Bug list/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /Search all contexts/ }));
  expect(screen.getByRole("button", { name: /Bug list/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Fix the bug/ })).toBeInTheDocument();
});

test("added members leave the results, name the group, and save in order", async () => {
  const onSave = renderNew();
  fireEvent.click(screen.getByRole("button", { name: /Rice/ }));
  fireEvent.click(screen.getByRole("button", { name: /Beans/ }));
  expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Rice + Beans");
  expect(screen.queryByRole("button", { name: /^Rice/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove Rice" }));
  expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Beans");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0]).toMatchObject({
    name: "",
    groupTypeId: "menu",
    contextId: "recipes",
    members: [{ memberType: "item", memberId: "beans" }],
  });
});

test("a failed save shows its error and stays on the page", async () => {
  renderNew(jest.fn(async () => { throw new Error("A member was not added. Nothing was saved."); }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("A member was not added. Nothing was saved.")).toBeInTheDocument();
});

test("the members button shows a plus only while the search is closed", () => {
  renderNew();
  const open = screen.getByRole("button", { name: "Done adding" });
  expect(open.querySelector("svg")).toBeNull();
  fireEvent.click(open);
  expect(screen.getByRole("button", { name: "Add Members" }).querySelector("svg")).not.toBeNull();
});

function renderEdit({ onArchive = jest.fn(), onOpenHistory = jest.fn(), members } = {}) {
  const group = { id: "g", groupTypeId: "menu", contextId: "recipes", name: "Taco night" };
  render(
    <GroupEditScreen
      group={group}
      groupTypes={groupTypes}
      contexts={contexts}
      items={items}
      intents={intents}
      groupMembers={members || [{ id: "m1", groupId: "g", memberType: "item", memberId: "rice", position: 1 }]}
      onSave={jest.fn()}
      onCancel={jest.fn()}
      onArchive={onArchive}
      onOpenHistory={onOpenHistory}
    />,
  );
  return { onArchive, onOpenHistory };
}

test("archive is on the edit page only, behind a pop-up with a real Cancel", () => {
  const { onArchive } = renderEdit();
  expect(screen.getByLabelText("Name")).toHaveValue("Taco night");
  fireEvent.click(screen.getByRole("button", { name: "Archive Menu" }));
  const dialog = screen.getByRole("dialog", { name: "Archive menu" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Archive Menu" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(onArchive).toHaveBeenCalledTimes(1);
});

test("removed members are hidden, and the history link appears once there are any", () => {
  const live = { id: "m1", groupId: "g", memberType: "item", memberId: "rice", position: 1 };
  const { onOpenHistory } = renderEdit({
    members: [live, { id: "m0", groupId: "g", memberType: "item", memberId: "beans", position: 2, removedAt: "t" }],
  });
  expect(screen.getByText("Members (1)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View removal history" }));
  expect(onOpenHistory).toHaveBeenCalledTimes(1);
});

test("no history link while nothing was removed", () => {
  renderEdit();
  expect(screen.queryByRole("button", { name: "View removal history" })).not.toBeInTheDocument();
});
