import React from "react";
import { render, screen } from "@testing-library/react";
import ExecutionBadge from "./ExecutionBadge";
import { GroupsProvider } from "../groups/GroupsContext";

function card(status) {
  const { container, unmount } = render(
    <ExecutionBadge
      exec={{ id: "x", intentId: "i1", status }}
      intents={[{ id: "i1", text: "Water plants" }]}
      contexts={[]}
      getIntentDisplay={(i) => i.text}
      onOpen={() => {}}
    />,
  );
  const cls = container.firstChild.className;
  unmount();
  return cls;
}

test("an active run is teal, not brown", () => {
  const cls = card("active");
  expect(cls).toMatch(/border-success/);
  expect(cls).toMatch(/bg-success-light/);
  expect(cls).not.toMatch(/primary/);
});

test("card radius follows the design-system rule (rounded-lg)", () => {
  expect(card("active")).toMatch(/\brounded-lg\b/);
});

test("a paused run stays amber", () => {
  expect(card("paused")).toMatch(/border-warning/);
  render(
    <ExecutionBadge exec={{ id: "x", status: "paused" }} intents={[]} contexts={[]} getIntentDisplay={() => ""} onOpen={() => {}} />,
  );
  expect(screen.getByText(/Paused/)).toBeTruthy();
});

test("a menu's own card is titled with the menu's name and has no group line repeating it", () => {
  const { container } = render(
    <GroupsProvider
      itemGroups={[{ id: "g", groupTypeId: "menu", name: "P5 Test Menu" }]}
      groupTypes={[{ id: "menu", icon: "UtensilsCrossed" }]}
      groupMembers={[]}
      items={[]}
      intents={[]}
      onOpenGroup={() => {}}
    >
      <ExecutionBadge
        exec={{ id: "mr", intentId: "o", groupId: "g", status: "active" }}
        intents={[{ id: "o", groupId: "g", text: "Old name" }]}
        contexts={[]}
        getIntentDisplay={(i) => i.text}
        onOpen={() => {}}
      />
    </GroupsProvider>,
  );
  expect(screen.getByText("P5 Test Menu")).toBeTruthy();
  expect(screen.queryByText("Old name")).toBeNull();
  expect(container.querySelectorAll("[data-group-line]")).toHaveLength(0);
});
