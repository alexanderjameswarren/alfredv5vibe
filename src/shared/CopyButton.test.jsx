import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import CopyButton, { COPIED_MS } from "./CopyButton";

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
});

test("small: copies, turns into a check mark for a moment, then back", async () => {
  jest.useFakeTimers();
  render(<CopyButton getText={() => "the text"} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("the text");
  act(() => jest.advanceTimersByTime(COPIED_MS));
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  jest.useRealTimers();
});

test("large: labelled, with the same feedback", async () => {
  render(<CopyButton size="large" getText={() => "x"} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
});

test("a refused clipboard is said out loud", async () => {
  navigator.clipboard.writeText.mockRejectedValue(new Error("no"));
  window.alert = jest.fn();
  jest.spyOn(console, "error").mockImplementation(() => {});
  render(<CopyButton getText={() => "x"} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(window.alert).toHaveBeenCalled());
});
