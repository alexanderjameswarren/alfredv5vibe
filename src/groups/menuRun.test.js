import { cookSummary, isMenuRun, isRecipeRun, orderedRecipes, recipeOutcome, recipeRunsOf, shownRuns } from "./menuRun";

const menuRun = { id: "m", intentId: "o", groupId: "g", status: "active" };
const rice = { id: "r1", intentId: null, groupId: "g", parentExecutionId: "m", itemIds: ["rice"], status: "active" };
const dal = { id: "r2", intentId: null, groupId: "g", parentExecutionId: "m", itemIds: ["dal"], status: "paused", outcome: "skipped" };
const other = { id: "x", intentId: "i", status: "active" };

test("a recipe run has a group and no intention; running lists never show one", () => {
  expect(isRecipeRun(rice)).toBe(true);
  expect(isRecipeRun(menuRun)).toBe(false);
  expect(shownRuns([menuRun, rice, other, dal])).toEqual([menuRun, other]);
});

test("a menu run's recipe runs are the ones pointing at it, never another cook's", () => {
  const otherCook = { ...rice, id: "old", parentExecutionId: "m-earlier", status: "closed" };
  expect(recipeRunsOf(menuRun, [menuRun, rice, dal, otherCook, other])).toEqual([rice, dal]);
  expect(recipeRunsOf(other, [rice])).toEqual([]);
});

test("a cook's summary counts done and skipped", () => {
  expect(cookSummary([{ outcome: "done" }, { outcome: "skipped" }, { outcome: "done" }])).toBe("2 done · 1 skipped");
  expect(cookSummary([{ outcome: "skipped" }])).toBe("1 skipped");
  expect(cookSummary([])).toBe("");
});

test("a menu run is one on a together group's own intention", () => {
  const lists = { groups: [{ id: "g", groupTypeId: "menu" }, { id: "p", groupTypeId: "proj" }], groupTypes: [{ id: "menu", executionMode: "together" }, { id: "proj", executionMode: "separately" }] };
  expect(isMenuRun(menuRun, lists)).toBe(true);
  expect(isMenuRun({ ...menuRun, groupId: "p" }, lists)).toBe(false);
  expect(isMenuRun(rice, lists)).toBe(false);
});

test("skipped stays skipped on completion, the rest are done", () => {
  expect(recipeOutcome(dal)).toBe("skipped");
  expect(recipeOutcome(rice)).toBe("done");
});

test("recipes in the menu's member order, with their items", () => {
  const members = [
    { groupId: "g", memberType: "item", memberId: "dal", position: 1 },
    { groupId: "g", memberType: "item", memberId: "rice", position: 2 },
  ];
  const items = [{ id: "rice", name: "Rice" }, { id: "dal", name: "Dal" }];
  expect(orderedRecipes([rice, dal], { members, items, groupId: "g" }).map((r) => r.item.name)).toEqual(["Dal", "Rice"]);
});
