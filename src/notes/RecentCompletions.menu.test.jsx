import { withCookInfo } from "./RecentCompletions";
import { listCookParents, listCookRecipes } from "../executions/menuHistory";

jest.mock("../executions/menuHistory", () => ({ listCookParents: jest.fn(), listCookRecipes: jest.fn() }));
jest.mock("./notesApi", () => ({}));

const done = (id, intentId = "o") => ({ id, kind: "done", intentId });

test("a menu's page: each cook gets its recipes' tally", async () => {
  listCookRecipes.mockResolvedValue([
    { parentExecutionId: "c1", outcome: "done" },
    { parentExecutionId: "c1", outcome: "skipped" },
    { parentExecutionId: "c2", outcome: "done" },
  ]);
  const rows = await withCookInfo([done("c1"), done("c2"), { id: "s", kind: "skipped" }], { cooks: true });
  expect(listCookRecipes).toHaveBeenCalledWith(["c1", "c2"]);
  expect(rows.map((r) => r.cook)).toEqual(["1 done · 1 skipped", "1 done", undefined]);
});

test("a recipe's page: a cook from inside a menu names its menu run and group; its own runs are untouched", async () => {
  listCookParents.mockResolvedValue([{ id: "r1", parentExecutionId: "c1", groupId: "g" }]);
  const rows = await withCookInfo([done("own", "i1"), done("r1", null)]);
  expect(listCookParents).toHaveBeenCalledWith(["r1"]);
  expect(rows[0].inMenu).toBeUndefined();
  expect(rows[1].inMenu).toEqual({ parentId: "c1", groupId: "g" });
});

test("nothing from a menu: no lookup", async () => {
  jest.clearAllMocks();
  await withCookInfo([done("own", "i1")]);
  expect(listCookParents).not.toHaveBeenCalled();
});
