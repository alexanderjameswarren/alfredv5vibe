import React, { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import GroupHistoryScreen from "./GroupHistoryScreen";

const intents = [{ id: "i1", text: "Retire the ai-enrich edge function" }];
const removed = { id: "old", groupId: "g", memberType: "intention", memberId: "i1", position: 2, removedAt: "2026-10-22T10:00:00Z" };

function Harness() {
  const [members, setMembers] = useState([removed]);
  return (
    <GroupHistoryScreen
      groupName="P5 Test Project"
      groupId="g"
      groupMembers={members}
      items={[]}
      intents={intents}
      onBack={() => {}}
      onRestore={async (m) => setMembers((prev) => [...prev, { ...m, id: "new", removedAt: null, position: 1 }])}
    />
  );
}

test("Put back keeps the removal listed, now reading in the group again", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: /Put back/ }));
  expect(await screen.findByText(/in the group again/)).toBeInTheDocument();
  expect(screen.getByText("Retire the ai-enrich edge function")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Put back/ })).not.toBeInTheDocument();
});
