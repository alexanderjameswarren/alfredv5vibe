import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, List, TrendingUp } from "lucide-react";
import UnderlineTabs from "../shared/UnderlineTabs";
import OverviewScreen from "./OverviewScreen";
import AccountsScreen from "./AccountsScreen";
import AccountDetailView from "./AccountDetailView";
import ManualAccountForm from "./ManualAccountForm";
import NetWorthScreen from "./NetWorthScreen";
import {
  MONEY_ACCOUNTS_PATH, MONEY_NET_WORTH_PATH, MONEY_NEW_ACCOUNT_PATH, MONEY_PATH,
  moneyAccountPath, moneyRouteFromPath,
} from "../viewPaths";

const TABS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, path: MONEY_PATH },
  { key: "accounts", label: "Accounts", icon: List, path: MONEY_ACCOUNTS_PATH },
  { key: "net-worth", label: "Net worth", icon: TrendingUp, path: MONEY_NET_WORTH_PATH },
];

// The Money section (Warren Buffet, spec §9). One Alfred view; the screen
// beneath it is read from the URL, as SAM does, so Back and reload both work.
export default function MoneyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = moneyRouteFromPath(location.pathname) || { tab: "overview", accountId: null, adding: false };
  const go = (path) => navigate(path);

  let body;
  if (route.adding) {
    body = <ManualAccountForm onCancel={() => go(MONEY_ACCOUNTS_PATH)} onCreated={(id) => go(moneyAccountPath(id))} />;
  } else if (route.accountId) {
    body = <AccountDetailView accountId={route.accountId} onBack={() => go(MONEY_ACCOUNTS_PATH)} />;
  } else if (route.tab === "accounts") {
    body = <AccountsScreen onOpen={(id) => go(moneyAccountPath(id))} onAdd={() => go(MONEY_NEW_ACCOUNT_PATH)} />;
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
