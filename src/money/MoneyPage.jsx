import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CalendarClock, ClipboardCheck, LayoutDashboard, List, PieChart, Receipt, Repeat, TrendingUp } from "lucide-react";
import UnderlineTabs from "../shared/UnderlineTabs";
import OverviewScreen from "./OverviewScreen";
import AccountsScreen from "./AccountsScreen";
import AccountDetailView from "./AccountDetailView";
import ManualAccountForm from "./ManualAccountForm";
import NetWorthScreen from "./NetWorthScreen";
import TransactionsScreen from "./TransactionsScreen";
import TransactionDetailView from "./TransactionDetailView";
import ReviewScreen from "./ReviewScreen";
import SpendingScreen from "./SpendingScreen";
import SubscriptionsScreen from "./SubscriptionsScreen";
import SubscriptionDetailView from "./SubscriptionDetailView";
import PlanScreen from "./PlanScreen";
import ProjectDetailView from "./ProjectDetailView";
import PlannedItemDetailView from "./PlannedItemDetailView";
import {
  MONEY_ACCOUNTS_PATH, MONEY_NET_WORTH_PATH, MONEY_NEW_ACCOUNT_PATH, MONEY_PATH, MONEY_PLAN_PATH, MONEY_REVIEW_PATH,
  MONEY_SPENDING_PATH, MONEY_SUBSCRIPTIONS_PATH, MONEY_TRANSACTIONS_PATH, moneyAccountPath, moneyPlannedItemPath,
  moneyProjectPath, moneyRouteFromPath, moneySubscriptionPath, moneyTransactionPath,
} from "../viewPaths";

const TABS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, path: MONEY_PATH },
  { key: "accounts", label: "Accounts", icon: List, path: MONEY_ACCOUNTS_PATH },
  { key: "transactions", label: "Transactions", icon: Receipt, path: MONEY_TRANSACTIONS_PATH },
  { key: "review", label: "Review", icon: ClipboardCheck, path: MONEY_REVIEW_PATH },
  { key: "spending", label: "Spending", icon: PieChart, path: MONEY_SPENDING_PATH },
  { key: "subscriptions", label: "Subscriptions", icon: Repeat, path: MONEY_SUBSCRIPTIONS_PATH },
  { key: "plan", label: "Plan", icon: CalendarClock, path: MONEY_PLAN_PATH },
  { key: "net-worth", label: "Net worth", icon: TrendingUp, path: MONEY_NET_WORTH_PATH },
];

// The Money section (Warren Buffet, Phase 1 spec §9 and Phase 2 spec §7). One
// Alfred view; the screen beneath it is read from the URL, as SAM does, so Back
// and reload both work.
export default function MoneyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = moneyRouteFromPath(location.pathname)
    || { tab: "overview", accountId: null, transactionId: null, subscriptionId: null, projectId: null, plannedItemId: null, adding: false };
  const go = (path) => navigate(path);
  // A transaction opened from Review or a subscription goes back there.
  const from = location.state?.from;
  const st = location.state || {};
  const backFromTransaction = from === "review" ? MONEY_REVIEW_PATH
    : st.subscriptionId ? moneySubscriptionPath(st.subscriptionId)
    : st.plannedItemId ? moneyPlannedItemPath(st.plannedItemId)
    : st.projectId ? moneyProjectPath(st.projectId)
    : MONEY_TRANSACTIONS_PATH;
  // Back to an item keeps where the item itself was opened from (a project, or the Plan list).
  const backStateFromTransaction = st.plannedItemId && (st.itemProjectId || st.itemFrom)
    ? { ...(st.itemProjectId ? { projectId: st.itemProjectId } : {}), ...(st.itemFrom ? { from: st.itemFrom } : {}) }
    : undefined;
  const backFromItem = from === "review" ? MONEY_REVIEW_PATH : st.projectId ? moneyProjectPath(st.projectId) : MONEY_PLAN_PATH;

  let body;
  if (route.adding) {
    body = <ManualAccountForm onCancel={() => go(MONEY_ACCOUNTS_PATH)} onCreated={(id) => go(moneyAccountPath(id))} />;
  } else if (route.accountId) {
    body = <AccountDetailView accountId={route.accountId} onBack={() => go(MONEY_ACCOUNTS_PATH)}
      onOpenTransaction={(id) => go(moneyTransactionPath(id))} />;
  } else if (route.transactionId) {
    body = <TransactionDetailView transactionId={route.transactionId}
      onBack={() => navigate(backFromTransaction, backStateFromTransaction ? { state: backStateFromTransaction } : undefined)}
      onOpenTransaction={(id) => go(moneyTransactionPath(id))} />;
  } else if (route.subscriptionId) {
    body = <SubscriptionDetailView key={route.subscriptionId} subscriptionId={route.subscriptionId}
      onBack={() => go(MONEY_SUBSCRIPTIONS_PATH)}
      onOpenSubscription={(id) => go(moneySubscriptionPath(id))}
      onOpenTransaction={(id) => navigate(moneyTransactionPath(id), { state: { subscriptionId: route.subscriptionId } })} />;
  } else if (route.projectId) {
    body = <ProjectDetailView key={route.projectId} projectId={route.projectId} onBack={() => go(MONEY_PLAN_PATH)}
      onOpenItem={(id) => navigate(moneyPlannedItemPath(id), { state: { projectId: route.projectId } })}
      onOpenTransaction={(id) => navigate(moneyTransactionPath(id), { state: { projectId: route.projectId } })} />;
  } else if (route.plannedItemId) {
    body = <PlannedItemDetailView key={route.plannedItemId} plannedItemId={route.plannedItemId} onBack={() => go(backFromItem)}
      onOpenProject={(id) => go(moneyProjectPath(id))}
      onOpenTransaction={(id) => navigate(moneyTransactionPath(id),
        { state: { plannedItemId: route.plannedItemId, itemProjectId: st.projectId || null, itemFrom: from || null } })} />;
  } else if (route.tab === "plan") {
    body = <PlanScreen onOpenProject={(id) => go(moneyProjectPath(id))} onOpenItem={(id) => go(moneyPlannedItemPath(id))} />;
  } else if (route.tab === "accounts") {
    body = <AccountsScreen onOpen={(id) => go(moneyAccountPath(id))} onAdd={() => go(MONEY_NEW_ACCOUNT_PATH)} />;
  } else if (route.tab === "transactions") {
    body = <TransactionsScreen onOpen={(id) => go(moneyTransactionPath(id))} />;
  } else if (route.tab === "review") {
    body = <ReviewScreen onOpen={(id) => navigate(moneyTransactionPath(id), { state: { from: "review" } })}
      onOpenItem={(id) => navigate(moneyPlannedItemPath(id), { state: { from: "review" } })} />;
  } else if (route.tab === "spending") {
    body = <SpendingScreen />;
  } else if (route.tab === "subscriptions") {
    body = <SubscriptionsScreen onOpen={(id) => go(moneySubscriptionPath(id))} />;
  } else if (route.tab === "net-worth") {
    body = <NetWorthScreen />;
  } else {
    body = <OverviewScreen onOpenAccounts={() => go(MONEY_ACCOUNTS_PATH)} />;
  }

  return (
    <div>
      <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Money</h2>
      <UnderlineTabs
        tabs={TABS}
        activeKey={route.tab}
        onSelect={(key) => go(TABS.find((t) => t.key === key).path)}
        ariaLabel="Money sections"
      />
      {body}
    </div>
  );
}
