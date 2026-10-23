import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import MemberExecutions from "./MemberExecutions";
import { listMemberExecutions } from "./groupHistory";
import { memberFilter, memberNameFor } from "./groupHistory";
import { storage } from "../utils/storage";

jest.mock("./groupHistory", () => ({ ...jest.requireActual("./groupHistory"), listMemberExecutions: jest.fn() }));
jest.mock("../utils/storage", () => ({ storage: { get: jest.fn() } }));
jest.mock("../notes/notesApi", () => ({ onNotesChanged: () => () => {} }));
jest.mock("../notes/RecentCompletions", () => ({ RECENT_LIMIT: 5 }));

const lists = {
  members: [
    { id: "m1", groupId: "p", memberType: "item", memberId: "undo", position: 1 },
    { id: "m2", groupId: "p", memberType: "intention", memberId: "retire", position: 2 },
  ],
  items: [{ id: "undo", name: "P5 Undo test" }],
  intents: [
    { id: "retire", text: "Retire the ai-enrich edge function" },
    { id: "undo-once", text: "P5 Undo test", itemId: "undo" },
  ],
};

test("the filter covers member intentions, intentions of member items, and carried items", () => {
  expect(memberFilter(["retire", "undo-once"], ["undo"])).toBe('intent_id.in.("retire","undo-once"),item_ids.cs.["undo"]');
  expect(memberFilter([], [])).toBeNull();
});

test("each row names its member: an intention, an item through its intention or item_ids, else the group", () => {
  const live = [
    { memberType: "item", record: { id: "undo" }, name: "P5 Undo test" },
    { memberType: "intention", record: { id: "retire" }, name: "Retire the ai-enrich edge function" },
  ];
  const ctx = { live, intents: lists.intents, ownIntentionId: "own", groupName: "P5 Test Project" };
  expect(memberNameFor({ intentId: "retire" }, ctx)).toBe("Retire the ai-enrich edge function");
  expect(memberNameFor({ intentId: "undo-once" }, ctx)).toBe("P5 Undo test");
  expect(memberNameFor({ intentId: null, itemIds: ["undo"] }, ctx)).toBe("P5 Undo test");
  expect(memberNameFor({ intentId: "own" }, ctx)).toBe("P5 Test Project");
});

test("one dated list, newest first, naming members; Show all beyond five; a row opens its execution", async () => {
  listMemberExecutions.mockResolvedValue({
    rows: [
      { id: "x2", intentId: "undo-once", outcome: "done", day: "2026-10-23" },
      { id: "x1", intentId: "retire", outcome: "skipped", day: "2026-10-21" },
    ],
    total: 7,
  });
  storage.get.mockResolvedValue({ id: "x2" });
  const onOpenExecution = jest.fn();
  render(<MemberExecutions groupId="p" lists={lists} groupName="P5 Test Project" onOpenExecution={onOpenExecution} />);
  const first = await screen.findByText(/^P5 Undo test · /);
  expect(screen.getByText(/^Retire the ai-enrich edge function · .*\(skipped\)$/)).toBeInTheDocument();
  expect(listMemberExecutions).toHaveBeenCalledWith({ intentIds: expect.arrayContaining(["retire", "undo-once"]), itemIds: ["undo"], limit: 5 });
  fireEvent.click(screen.getByRole("button", { name: "Show all (2 older)" }));
  await waitFor(() => expect(listMemberExecutions).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50 })));
  fireEvent.click(first.closest("button"));
  await waitFor(() => expect(onOpenExecution).toHaveBeenCalledWith({ id: "x2" }));
});
