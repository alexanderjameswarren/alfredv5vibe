import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LyricsSheet from "./LyricsSheet";

function setup(hasLyrics) {
  const props = {
    songTitle: "Song",
    hasLyrics,
    onSave: jest.fn(async () => {}),
    onDelete: jest.fn(async () => {}),
    onClose: jest.fn(),
  };
  render(<LyricsSheet {...props} />);
  return props;
}

const type = (t) => fireEvent.change(screen.getByLabelText("Lyrics text"), { target: { value: t } });

test("no existing lyrics: saves straight away", async () => {
  const p = setup(false);
  expect(screen.queryByRole("button", { name: "Delete lyrics" })).toBeNull();
  type("hello");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(p.onClose).toHaveBeenCalled());
  expect(p.onSave).toHaveBeenCalledWith("hello");
});

test("existing lyrics: save confirms, and cancel writes nothing", () => {
  const p = setup(true);
  type("hello");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  screen.getByText("This will replace the existing lyrics.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(p.onSave).not.toHaveBeenCalled();
  expect(p.onClose).toHaveBeenCalled();
});

test("existing lyrics: replace after confirm", async () => {
  const p = setup(true);
  type("hello");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(p.onSave).toHaveBeenCalledWith("hello"));
});

test("delete confirms first", async () => {
  const p = setup(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete lyrics" }));
  expect(p.onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(p.onDelete).toHaveBeenCalled());
});

test("save is disabled with empty text", () => {
  setup(false);
  expect(screen.getByRole("button", { name: "Save" }).disabled).toBe(true);
});
