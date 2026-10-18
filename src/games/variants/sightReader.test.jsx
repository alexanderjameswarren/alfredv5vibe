import React from "react";
import { render, screen } from "@testing-library/react";
import SightReader from "./sightReader";

const at = (url) => window.history.pushState({}, "", url);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test("stave extremes preview renders with the flag", () => {
  at("/games?staveExtremes");
  render(<SightReader />);
  expect(screen.getByText("Dev preview")).toBeTruthy();
  expect(screen.getAllByTestId("stave-extreme")).toHaveLength(4);
});

test("absent without the flag", () => {
  at("/games");
  render(<SightReader />);
  expect(screen.queryByText("Dev preview")).toBeNull();
});
