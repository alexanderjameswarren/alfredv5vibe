import React, { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { getAccounts } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import {
  OWNER_LABELS, accountLabel, accountSubtitle, formatDay, formatMoney, groupAccounts, rewardDisplay,
} from "./moneyFormat";

function Balance({ account }) {
  if (account.role === "rewards") {
    const r = rewardDisplay(account);
    return (
      <span className="text-right tabular-nums">
        <span className="block">{r.units}</span>
        {r.dollars && <span className="block text-xs text-muted-foreground">≈ {r.dollars}</span>}
        {r.expires && <span className="block text-xs text-muted-foreground">expires {formatDay(r.expires)}</span>}
      </span>
    );
  }
  return <span className="tabular-nums">{formatMoney(account.balance)}</span>;
}

export function AccountRow({ account, onOpen }) {
  const subtitle = accountSubtitle(account);
  return (
    <button
      type="button"
      onClick={() => onOpen(account.account_id)}
      className="w-full text-left p-4 min-h-[44px] bg-card border border-border rounded-lg flex items-center justify-between gap-3"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-foreground">{accountLabel(account)}</span>
          {account.owner && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-foreground">
              {OWNER_LABELS[account.owner]}
            </span>
          )}
          {account.is_hidden && <span className="text-xs text-muted-foreground">hidden</span>}
        </span>
        {subtitle && <span className="block text-sm text-muted-foreground">{subtitle}</span>}
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <Balance account={account} />
        <ChevronRight className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
      </span>
    </button>
  );
}

export default function AccountsScreen({ onOpen, onAdd }) {
  const [showHidden, setShowHidden] = useState(false);
  const { data, error, loading } = useLoad(getAccounts, []);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const { unassigned, groups } = groupAccounts(data, { showHidden });
  const hiddenCount = data.filter((a) => a.is_hidden).length;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          Add manual account
        </button>
      </div>

      {unassigned.length > 0 && (
        <section className="rounded-lg bg-warning-light p-3 space-y-2">
          <h3 className="text-sm font-medium text-warning">
            Assign a role — these are left out of net worth until you do
          </h3>
          {unassigned.map((a) => <AccountRow key={a.account_id} account={a} onOpen={onOpen} />)}
        </section>
      )}

      {groups.map((g) => (
        <section key={g.role} className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">{g.label}</h3>
          {g.accounts.map((a) => <AccountRow key={a.account_id} account={a} onOpen={onOpen} />)}
        </section>
      ))}

      {hiddenCount > 0 && (
        <label className="flex items-center gap-2 min-h-[44px] text-sm text-muted-foreground">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden accounts ({hiddenCount})
        </label>
      )}
    </div>
  );
}
