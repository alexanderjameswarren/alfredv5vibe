import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ArchivedNotice, ArchivedPill, archivedOnLabel, byNewestArchive, restoreAction } from "./archivedRecord";
import ActionBar from "./ActionBar";

test("the pill, the line and the one action", () => {
  const onRestore = jest.fn();
  render(
    <>
      <ArchivedPill />
      <ArchivedNotice noun="menu" />
      <ActionBar actions={[restoreAction(onRestore)]} />
    </>,
  );
  expect(screen.getByText("Archived")).toHaveAttribute("data-archived");
  expect(screen.getByRole("status")).toHaveTextContent("This menu is archived.");
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(onRestore).toHaveBeenCalledTimes(1);
});

test("archived_at sorts newest first and labels the row; updated_at stands in until backfilled", () => {
  const rows = [
    { id: "old", archivedAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" },
    { id: "new", archivedAt: "2026-10-23T10:00:00Z" },
    { id: "unfilled", updatedAt: "2026-10-10T10:00:00Z" },
  ];
  expect([...rows].sort(byNewestArchive).map((r) => r.id)).toEqual(["new", "unfilled", "old"]);
  expect(archivedOnLabel(rows[1])).toBe("Archived Oct 23, 2026");
  expect(archivedOnLabel({})).toBeNull();
});

test("restoreAction is an ActionBar entry with a menu twin", () => {
  const a = restoreAction(() => {});
  expect(a.key).toBe("restore");
  expect(a.menu.label).toBe("Restore");
});
