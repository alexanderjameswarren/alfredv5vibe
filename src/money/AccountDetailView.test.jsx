import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({
  getAccount: jest.fn(),
  getBalanceHistory: jest.fn(),
  getTransactions: jest.fn(),
  getHoldings: jest.fn(),
  updateAccount: jest.fn(),
  recordBalance: jest.fn(),
}));
const api = require("./moneyApi");
const AccountDetailView = require("./AccountDetailView").default;

const base = {
  id: "acc1", institution: "Test Broker", name: "Test Brokerage", display_name: null, last4: "0002",
  owner: "alex", currency: "USD", credit_limit: null, reward_unit: null, reward_value_per_unit: null,
  expires_on: null, active_from: null, active_until: null, is_hidden: false, notes: null,
  as_of: "2026-01-05", balance: 1000,
};

beforeEach(() => {
  api.getBalanceHistory.mockResolvedValue([]);
  api.getTransactions.mockResolvedValue([
    { id: "t1", posted_at: null, transacted_at: "2026-01-05T10:00:00Z", amount: -12.5, payee: "Test Cafe", pending: true },
  ]);
  api.getHoldings.mockResolvedValue([
    { id: "h1", as_of: "2026-01-05", symbol: "TSTA", description: "Test Fund A", shares: 10, market_value: 600, cost_basis: 0 },
    { id: "h2", as_of: "2026-01-05", symbol: "TSTB", description: "Test Fund B", shares: 5, market_value: 400, cost_basis: 300 },
  ]);
});

it("shows a zero cost basis as not reported, never as a loss", async () => {
  api.getAccount.mockResolvedValue({ ...base, source: "simplefin", role: "retirement" });
  render(<AccountDetailView accountId="acc1" onBack={() => {}} />);
  expect(await screen.findByText(/cost basis not reported/)).toBeInTheDocument();
  expect(screen.getByText(/cost basis \$300\.00 · gain \$100\.00/)).toBeInTheDocument();
  expect(screen.queryByText(/loss/)).toBeNull();
});

it("marks pending transactions and offers no balance form on a synced account", async () => {
  api.getAccount.mockResolvedValue({ ...base, source: "simplefin", role: "spending_cash" });
  render(<AccountDetailView accountId="acc1" onBack={() => {}} />);
  expect(await screen.findByText("Test Cafe")).toBeInTheDocument();
  expect(screen.getByText("pending")).toBeInTheDocument();
  expect(screen.queryByText("Record a balance")).toBeNull();
  expect(api.getHoldings).not.toHaveBeenCalled();
});

it("offers the balance form on a manual rewards account and reads in units", async () => {
  api.getAccount.mockResolvedValue({
    ...base, source: "manual", role: "rewards", reward_unit: "miles", balance: 5000, expires_on: "2027-02-01",
  });
  render(<AccountDetailView accountId="acc1" onBack={() => {}} />);
  expect(await screen.findByText("Record a balance")).toBeInTheDocument();
  expect(screen.getByText("5,000 miles")).toBeInTheDocument();
  expect(screen.getByText("Expires Feb 1, 2027")).toBeInTheDocument();
  expect(screen.getByLabelText("Balance (miles)")).toBeInTheDocument();
  expect(api.getTransactions).not.toHaveBeenCalled();
});
