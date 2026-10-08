import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// Invented data only.
jest.mock("./moneyApi", () => ({
  getAccounts: jest.fn(),
  getLatestNetWorth: jest.fn(),
  getLatestSyncRun: jest.fn(),
  getNetWorth: jest.fn(),
  getAccount: jest.fn(),
  createManualAccount: jest.fn(),
}));
const api = require("./moneyApi");
const MoneyPage = require("./MoneyPage").default;

// CRA resets mocks before each test, so the answers are set here.
beforeEach(() => {
  api.getAccounts.mockResolvedValue([]);
  api.getLatestNetWorth.mockResolvedValue({ as_of: "2026-01-05", net_worth: 1234, spending_cash: 1000, reserve_cash: 234 });
  api.getLatestSyncRun.mockResolvedValue(null);
  api.getNetWorth.mockResolvedValue([]);
  api.getAccount.mockResolvedValue(null);
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function at(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="*" element={<><MoneyPage /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
}

it("opens the overview at /money", async () => {
  at("/money");
  expect(await screen.findByText("$1,234")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
});

it("routes the tabs and the add form by URL", async () => {
  at("/money/accounts/new");
  expect(screen.getByText("Add manual account")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Net worth" }));
  expect(screen.getByTestId("where")).toHaveTextContent("/money/net-worth");
  expect(await screen.findByText(/not enough history/i)).toBeInTheDocument();
});

it("opens an account by id", async () => {
  at("/money/accounts/abc");
  expect(await screen.findByText("No such account.")).toBeInTheDocument();
});
