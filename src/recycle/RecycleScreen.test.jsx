import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import RecycleScreen from "./RecycleScreen";

const noop = () => {};
const base = {
  contexts: [{ id: "alfred", name: "Alfred" }],
  intents: [{ id: "i1", text: "Retire the ai-enrich edge function" }],
  items: [{ id: "bugs", name: "Bug list" }],
  groupTypes: [{ id: "proj", labelSingular: "Project", icon: "SquareKanban" }],
  groupMembers: [
    { id: "m1", groupId: "g", memberType: "item", memberId: "bugs", position: 1 },
    { id: "m2", groupId: "g", memberType: "intention", memberId: "i1", position: 2 },
  ],
  setRecycleTab: noop,
  recycleLoading: false,
  recycleHasMore: false,
  recycleSelected: new Set(),
  loadRecycleBin: noop,
  recyclePermanentDelete: noop,
  recycleToggleSelect: noop,
  recycleSelectAll: noop,
  recycleBulkRestore: noop,
  recycleBulkDelete: noop,
};

test("an archived group is listed by its derived name, type and context, and restores", () => {
  const recycleRestore = jest.fn();
  render(
    <RecycleScreen
      {...base}
      recycleTab="groups"
      recycleData={[{ id: "g", name: null, groupTypeId: "proj", contextId: "alfred", archivedAt: "2026-10-23T15:00:00Z" }]}
      recycleRestore={recycleRestore}
    />,
  );
  expect(screen.getByRole("tab", { name: /Groups/ })).toBeInTheDocument();
  expect(screen.getByText("Bug list + Retire the ai-enrich edge function")).toBeInTheDocument();
  expect(screen.getByText(/Project · Alfred/)).toBeInTheDocument();
  expect(screen.getByText(/Archived Oct 23, 2026/)).toBeInTheDocument();
  fireEvent.click(screen.getByTitle("Restore"));
  expect(recycleRestore).toHaveBeenCalledWith("groups", "g");
});
