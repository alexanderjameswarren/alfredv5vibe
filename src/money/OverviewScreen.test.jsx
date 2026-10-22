import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SyncLine } from "./OverviewScreen";
import { SIMPLEFIN_BRIDGE_URL } from "./moneyFormat";

// Invented data only.
const last = new Date("2026-03-10T13:05:00Z");

it("keeps the bank and the reason, and links to SimpleFIN Bridge when a connection needs attention", () => {
  render(<SyncLine status={{ ok: false, last, needsBridge: true,
    problems: ["Last sync partial: Connection to Example Bank may need attention. Auth required"] }} />);
  expect(screen.getByText(/Example Bank may need attention\. Auth required/)).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "SimpleFIN Bridge" });
  expect(link).toHaveAttribute("href", SIMPLEFIN_BRIDGE_URL);
  expect(link).toHaveAttribute("target", "_blank");
});

it("shows no Bridge link for other problems", () => {
  render(<SyncLine status={{ ok: false, last, needsBridge: false, problems: ["Last sync is over 36 hours old"] }} />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
