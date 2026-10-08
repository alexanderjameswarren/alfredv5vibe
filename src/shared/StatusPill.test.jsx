import React from "react";
import { render, screen } from "@testing-library/react";
import StatusPill from "./StatusPill";

test("shows Active too, and someday for a row with no status yet", () => {
  render(<><StatusPill row={{ status: "active" }} /><StatusPill row={{}} /></>);
  expect(screen.getByText("Active")).toBeTruthy();
  expect(screen.getByText("Someday")).toBeTruthy();
});
