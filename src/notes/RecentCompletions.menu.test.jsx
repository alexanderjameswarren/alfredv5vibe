import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import RecentCompletions, { withCookInfo } from "./RecentCompletions";
import { listCookParents, listCookRecipes, listMenuSkips } from "../executions/menuHistory";
import { GroupsProvider } from "../groups/GroupsContext";
import { storage } from "../utils/storage";
import * as api from "./notesApi";

jest.mock("../executions/menuHistory", () => ({ listCookParents: jest.fn(), listCookRecipes: jest.fn(), listMenuSkips: jest.fn() }));
jest.mock("../utils/storage", () => ({ storage: { get: jest.fn() } }));
jest.mock("./notesApi", () => ({
  currentUserId: jest.fn(),
  listRecentCompletions: jest.fn(),
  listRecentSkips: jest.fn(),
  countRecentExecutions: jest.fn(),
  onNotesChanged: jest.fn(),
}));

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

test("a recipe skipped inside a menu sits in line: 'skipped in <menu>', opening the menu's cook", async () => {
  api.currentUserId.mockResolvedValue("me");
  api.listRecentCompletions.mockResolvedValue([]);
  api.listRecentSkips.mockResolvedValue([]);
  api.countRecentExecutions.mockResolvedValue(1);
  api.onNotesChanged.mockReturnValue(() => {});
  listMenuSkips.mockResolvedValue([{ id: "r2", parentExecutionId: "c1", groupId: "g", closedAt: "2026-10-23T18:00:00Z" }]);
  storage.get.mockResolvedValue({ id: "c1" });
  const onOpenExecution = jest.fn();
  render(
    <GroupsProvider itemGroups={[{ id: "g", groupTypeId: "menu", name: "P5 Test Menu" }]} groupTypes={[]} groupMembers={[]} items={[]} intents={[]} onOpenGroup={() => {}}>
      <RecentCompletions itemId="dal" intentIds={[]} onOpenExecution={onOpenExecution} />
    </GroupsProvider>,
  );
  const row = await screen.findByText(/skipped in P5 Test Menu/);
  expect(listMenuSkips).toHaveBeenCalledWith("dal", 5);
  expect(screen.queryByText(/\(skipped\)/)).toBeNull();
  fireEvent.click(row.closest("button"));
  await waitFor(() => expect(storage.get).toHaveBeenCalledWith("execution:c1"));
  expect(onOpenExecution).toHaveBeenCalledWith({ id: "c1" });
});
