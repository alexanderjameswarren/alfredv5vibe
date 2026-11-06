import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SignalActionDialog, { actionError } from "./SignalActionDialog";

// Invented data only.
const QUEUED = { id: "s1", title: "Bank sync failed", state: "queued" };

const open = (signal, act, extra = {}) => {
  const onDone = jest.fn();
  const onCancel = jest.fn();
  render(<SignalActionDialog signal={signal} act={act} onDone={onDone} onCancel={onCancel} {...extra} />);
  return { onDone, onCancel };
};

test("a queued signal: its title, then hold, drop and the two sends, in plain words", () => {
  open(QUEUED, jest.fn());
  const dialog = screen.getByRole("dialog", { name: "Actions for Bank sync failed" });
  expect(dialog).toHaveTextContent("Bank sync failed");
  const labels = screen.getAllByRole("button").map((b) => b.textContent);
  expect(labels).toEqual(["Hold", "Drop", "Send now as a notification", "Send now as an inbox item", "Cancel"]);
  expect(dialog.textContent).not.toMatch(/pop|deliver/i);
});

test("a held signal has no Hold", () => {
  open({ ...QUEUED, state: "held" }, jest.fn());
  expect(screen.queryByRole("button", { name: "Hold" })).toBeNull();
  expect(screen.getByRole("button", { name: "Drop" })).toBeInTheDocument();
});

test("each choice calls the right action, and hands back the result", async () => {
  const act = jest.fn().mockResolvedValue({ state: "delivered", as: "notification" });
  const { onDone } = open(QUEUED, act);
  fireEvent.click(screen.getByRole("button", { name: "Send now as a notification" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({ state: "delivered", as: "notification" }));
  expect(act).toHaveBeenCalledWith("s1", "deliver", "notification");
});

test("hold, drop and inbox map to their actions", async () => {
  for (const [label, args] of [["Hold", ["s1", "hold", null]], ["Drop", ["s1", "drop", null]],
    ["Send now as an inbox item", ["s1", "deliver", "inbox"]]]) {
    const act = jest.fn().mockResolvedValue({ state: "x" });
    const { onDone } = open(QUEUED, act);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(act).toHaveBeenCalledWith(...args);
    cleanup();
  }
});

test("an action that no longer applies reads 'Already …. Nothing changed.'", () => {
  expect(actionError("The signal is dropped, so it cannot be dropped. Only a queued or held signal can.")).toBe(
    "Already dropped. Nothing changed.");
  expect(actionError("The signal is sent, so it cannot be held. Only a queued signal can.")).toBe("Already sent. Nothing changed.");
  expect(actionError("The signal is merged, so it cannot be sent. Only a queued or held signal can.")).toBe(
    "Already sent. Nothing changed.");
  expect(actionError("The signal is held, so it cannot be held. Only a queued signal can.")).toBe("Already held. Nothing changed.");
  expect(actionError("Push is not configured: Missing edge function secret(s). Nothing was sent.")).toBe(
    "Push is not configured: Missing edge function secret(s). Nothing was sent.");
});

test("an error shows in the dialog and keeps it open", async () => {
  const act = jest.fn().mockRejectedValue(new Error("The signal is sent, so it cannot be dropped. Only a queued or held signal can."));
  const { onDone } = open(QUEUED, act);
  fireEvent.click(screen.getByRole("button", { name: "Drop" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Already sent. Nothing changed.");
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Drop" })).not.toBeDisabled();
});

test("Cancel closes with nothing done", () => {
  const act = jest.fn();
  const { onCancel } = open(QUEUED, act);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
});
