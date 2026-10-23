import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import LogMenuDialog from "./LogMenuDialog";
import { getTodayDate } from "../utils/eventDates";

const recipes = [{ id: "rice", name: "Instant Pot Spanish Rice" }, { id: "dal", name: "Butternut Squash Red Lentil Dal" }];

test("every recipe starts ticked; unticked ones go as skipped, with the note and Completed on", async () => {
  const onLog = jest.fn(async () => true);
  render(<LogMenuDialog recipes={recipes} onLog={onLog} onCancel={jest.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Log execution" });
  expect(within(dialog).getByText("Completed on:", { exact: false })).toBeInTheDocument();
  const boxes = within(dialog).getAllByRole("checkbox");
  expect(boxes.map((b) => b.checked)).toEqual([true, true]);
  fireEvent.click(within(dialog).getByLabelText("Butternut Squash Red Lentil Dal"));
  fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "Quick one" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Log" }));
  await waitFor(() => expect(onLog).toHaveBeenCalledWith({ note: "Quick one", completedOn: getTodayDate(), doneIds: ["rice"] }));
});
