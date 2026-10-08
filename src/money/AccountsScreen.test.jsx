import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({ getAccounts: jest.fn() }));
const { getAccounts } = require("./moneyApi");
const AccountsScreen = require("./AccountsScreen").default;

const row = (over) => ({
  account_id: over.account_id, source: "simplefin", institution: "Test Bank", last4: "0001",
  role: "spending_cash", owner: "joint", is_hidden: false, balance: 100, name: over.account_id, ...over,
});

beforeEach(() => {
  getAccounts.mockResolvedValue([
    row({ account_id: "new-one", role: "unassigned", owner: null }),
    row({ account_id: "chk", display_name: "Test Checking" }),
    row({ account_id: "pts", role: "rewards", source: "manual", balance: 2000, reward_unit: "points", last4: null }),
    row({ account_id: "mi", role: "rewards", source: "manual", balance: 1000, reward_unit: "miles",
      reward_value_per_unit: 0.01, expires_on: "2027-05-01", last4: null }),
    row({ account_id: "old", role: "closed", is_hidden: true }),
  ]);
});

it("puts unassigned accounts in an assign-a-role card and groups the rest by role", async () => {
  render(<AccountsScreen onOpen={() => {}} onAdd={() => {}} />);
  expect(await screen.findByText(/Assign a role/)).toBeInTheDocument();
  expect(screen.getByText("Test Checking")).toBeInTheDocument();
  expect(screen.getByText("Spending cash")).toBeInTheDocument();
  expect(screen.getAllByText("Test Bank ••0001")).toHaveLength(2);
});

it("shows rewards in units, dollars only with a rate, and the expiry", async () => {
  render(<AccountsScreen onOpen={() => {}} onAdd={() => {}} />);
  expect(await screen.findByText("2,000 points")).toBeInTheDocument();
  expect(screen.getByText("1,000 miles")).toBeInTheDocument();
  expect(screen.getByText("≈ $10.00")).toBeInTheDocument();
  expect(screen.getAllByText(/^≈/)).toHaveLength(1);
  expect(screen.getByText("expires May 1, 2027")).toBeInTheDocument();
});

it("keeps hidden accounts behind the toggle, and opens a row", async () => {
  const onOpen = jest.fn();
  render(<AccountsScreen onOpen={onOpen} onAdd={() => {}} />);
  await screen.findByText("Test Checking");
  expect(screen.queryByText("old")).toBeNull();
  fireEvent.click(screen.getByLabelText(/Show hidden accounts \(1\)/));
  expect(screen.getByText("old")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Test Checking"));
  expect(onOpen).toHaveBeenCalledWith("chk");
});
