import { groupsUsingType, modeLabel, typeDraft, typeProblem, typeRow, TYPE_ICON_CHOICES } from "./groupTypes";
import { groupRowSummary } from "./GroupRowCard";

const types = [{ id: "menu", labelSingular: "Menu" }];

test("the icon choices are the four seeds plus a few extras", () => {
  expect(TYPE_ICON_CHOICES.slice(0, 4)).toEqual(["UtensilsCrossed", "SquareKanban", "ListOrdered", "Boxes"]);
  expect(TYPE_ICON_CHOICES.length).toBeGreaterThan(4);
});

test("modes read in plain words", () => {
  expect(modeLabel("together")).toBe("Cooked together (one tap starts every member)");
  expect(modeLabel("separately")).toBe("Worked separately (members on their own)");
});

test("a draft needs names, an unused name, a known icon and a mode", () => {
  const ok = { ...typeDraft(), labelSingular: "Trip", labelPlural: "Trips", icon: "Plane" };
  expect(typeProblem(ok, types)).toBeNull();
  expect(typeProblem({ ...ok, labelSingular: " " }, types)).toBe("Give it a name.");
  expect(typeProblem({ ...ok, labelPlural: "" }, types)).toBe("Give it a plural name.");
  expect(typeProblem({ ...ok, labelSingular: "menu" }, types)).toBe("There is already a type called Menu.");
  expect(typeProblem({ ...ok, labelSingular: "Menu" }, types, "menu")).toBeNull();
  expect(typeProblem({ ...ok, icon: "Rocket" }, types)).toBe("Pick an icon.");
  expect(typeRow({ ...ok, labelSingular: " Trip " })).toEqual({ labelSingular: "Trip", labelPlural: "Trips", icon: "Plane", executionMode: "separately" });
});

test("a type in use counts its groups, archived ones included", () => {
  expect(groupsUsingType("menu", [{ groupTypeId: "menu" }, { groupTypeId: "menu", archived: true }, { groupTypeId: "proj" }])).toBe(2);
  expect(groupsUsingType("trip", [])).toBe(0);
});

test("group rows end like item rows: count, last done, last updated", () => {
  const menu = { executionMode: "together" };
  expect(
    groupRowSummary({ type: menu, memberCount: 2, lastCompletedAt: "2026-10-21T18:00:00", updatedAt: "2026-10-23T09:00:00" }),
  ).toBe("2 recipes · last done: Oct 21, 2026 · last updated: Oct 23, 2026");
  expect(groupRowSummary({ type: { executionMode: "separately" }, memberCount: 1, updatedAt: "2026-10-23T09:00:00" })).toBe(
    "1 member · last updated: Oct 23, 2026",
  );
});
