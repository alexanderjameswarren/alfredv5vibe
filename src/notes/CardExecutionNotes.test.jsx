import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import CardExecutionNotes from "./CardExecutionNotes";
import { _resetCardNotesCache } from "./useCardExecutionNotes";
import * as api from "./notesApi";

jest.mock("./notesApi", () => ({ listNotesForExecutions: jest.fn(), onNotesChanged: jest.fn() }));

const note = (id, executionId, body) => ({ id, executionId, body });

beforeEach(() => _resetCardNotesCache());

test("a whole list of cards costs one query; each shows at most two notes, one line each", async () => {
  api.listNotesForExecutions.mockResolvedValue([
    note("a3", "a", "newest a"),
    note("a2", "a", "middle a"),
    note("a1", "a", "oldest a"),
    note("b1", "b", "only b"),
  ]);
  render(
    <>
      <CardExecutionNotes executionId="a" />
      <CardExecutionNotes executionId="b" />
      <CardExecutionNotes executionId="c" />
    </>,
  );
  expect(await screen.findByText("newest a")).toBeTruthy();
  expect(screen.getByText("middle a").className).toMatch(/truncate/);
  expect(screen.queryByText("oldest a")).toBeNull();
  expect(screen.getByText("only b")).toBeTruthy();
  await waitFor(() => expect(api.listNotesForExecutions).toHaveBeenCalledTimes(1));
  expect(api.listNotesForExecutions.mock.calls[0][0].sort()).toEqual(["a", "b", "c"]);
});
