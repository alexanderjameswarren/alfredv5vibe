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
  getTagTree: jest.fn(),
  listTransactions: jest.fn(),
  getReviewQueue: jest.fn(),
  getTransactionDetail: jest.fn(),
  getSpending: jest.fn(),
  getCashFlow: jest.fn(),
  getSubscriptions: jest.fn(),
  getSubscriptionDetail: jest.fn(),
  getPlanOverview: jest.fn(),
  getProjectDetail: jest.fn(),
  getPlannedItemDetail: jest.fn(),
  getProjectChoices: jest.fn(),
  PAGE_SIZE: 50,
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
  api.getTagTree.mockResolvedValue({ groups: [], tags: [] });
  api.listTransactions.mockResolvedValue({ rows: [], total: 0 });
  api.getReviewQueue.mockResolvedValue([]);
  api.getTransactionDetail.mockResolvedValue(null);
  api.getSpending.mockResolvedValue([]);
  api.getCashFlow.mockResolvedValue([]);
  api.getSubscriptions.mockResolvedValue([]);
  api.getSubscriptionDetail.mockResolvedValue(null);
  api.getPlanOverview.mockResolvedValue({ projects: [], items: [], confirmed: [], missed: [] });
  api.getProjectChoices.mockResolvedValue([]);
});

it("routes the Plan tab, and a project or item link never lands on a blank screen", async () => {
  at("/money/spending");
  fireEvent.click(await screen.findByRole("tab", { name: "Plan" }));
  expect(screen.getByTestId("where")).toHaveTextContent("/money/plan");
  expect(await screen.findByText("No projects yet.")).toBeInTheDocument();
});

it("opens item detail by URL; Back goes to the Plan list, or to the project it was opened from", async () => {
  api.getPlannedItemDetail.mockResolvedValue(null);
  at("/money/plan/items/i-1");
  expect(await screen.findByText(/planned item no longer exists/)).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: /Back/ }));
  expect(screen.getByTestId("where")).toHaveTextContent(/^\/money\/plan$/);
});

it("goes back from an item opened in Review to Review", async () => {
  api.getPlannedItemDetail.mockResolvedValue(null);
  render(
    <MemoryRouter initialEntries={[{ pathname: "/money/plan/items/i-1", state: { from: "review" } }]}>
      <Routes><Route path="*" element={<><MoneyPage /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Back/ }));
  expect(screen.getByTestId("where")).toHaveTextContent(/^\/money\/review$/);
});

it("goes back from an item to the project it came from", async () => {
  api.getPlannedItemDetail.mockResolvedValue(null);
  render(
    <MemoryRouter initialEntries={[{ pathname: "/money/plan/items/i-1", state: { projectId: "p-7" } }]}>
      <Routes><Route path="*" element={<><MoneyPage /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Back/ }));
  expect(screen.getByTestId("where")).toHaveTextContent("/money/plan/projects/p-7");
});

it("opens project detail by URL, and a project nobody can see says so with a way back", async () => {
  api.getProjectDetail.mockResolvedValue(null);
  at("/money/plan/projects/p-1");
  expect(await screen.findByText(/no longer exists, or you can't see it/)).toBeInTheDocument();
  expect(api.getProjectDetail).toHaveBeenCalledWith("p-1");
  fireEvent.click(screen.getByRole("button", { name: /Plan/ }));
  expect(screen.getByTestId("where")).toHaveTextContent(/^\/money\/plan$/);
});

it("routes the Subscriptions tab and a subscription by URL", async () => {
  at("/money/spending");
  fireEvent.click(await screen.findByRole("tab", { name: "Subscriptions" }));
  expect(screen.getByTestId("where")).toHaveTextContent("/money/subscriptions");
  expect(await screen.findByText("No subscriptions yet.")).toBeInTheDocument();
});

it("opens a subscription by id", async () => {
  at("/money/subscriptions/s-404");
  expect(await screen.findByText("No such subscription.")).toBeInTheDocument();
});

it("routes the Phase 2 tabs and a transaction by URL", async () => {
  at("/money/transactions");
  expect(await screen.findByText("0 transactions")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByTestId("where")).toHaveTextContent("/money/review");
  expect(await screen.findByText(/Nothing to review/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Spending" }));
  expect(await screen.findByText(/No spending recorded/)).toBeInTheDocument();
});

it("opens a transaction by id", async () => {
  at("/money/transactions/t-404");
  expect(await screen.findByText("No such transaction.")).toBeInTheDocument();
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
