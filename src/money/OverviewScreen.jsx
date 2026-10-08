import React from "react";
import { AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { getAccounts, getLatestNetWorth, getLatestSyncRun } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import {
  NET_WORTH_GROUPS, formatDateTime, formatDay, formatMoney, syncStatus, toNumber,
} from "./moneyFormat";

export function SyncLine({ status }) {
  if (status.ok) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="w-4 h-4 shrink-0 text-success" aria-hidden="true" />
        Synced {formatDateTime(status.last)}
      </p>
    );
  }
  return (
    <div role="status" className="flex items-start gap-2 text-sm rounded-lg bg-warning-light text-warning p-3">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div>
        <p className="font-medium">
          {status.last ? `Last synced ${formatDateTime(status.last)}` : "Not synced yet"}
        </p>
        <ul className="mt-1 space-y-0.5">
          {status.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </div>
    </div>
  );
}

export default function OverviewScreen({ onOpenAccounts }) {
  const { data, error, loading } = useLoad(async () => {
    const [accounts, latest, run] = await Promise.all([getAccounts(), getLatestNetWorth(), getLatestSyncRun()]);
    return { accounts, latest, run };
  }, []);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const { accounts, latest, run } = data;
  const status = syncStatus(accounts, run);
  const unassigned = accounts.filter((a) => a.role === "unassigned" && !a.is_hidden).length;
  const rows = NET_WORTH_GROUPS.filter((g) => g.always || toNumber(latest?.[g.key]));

  return (
    <div className="space-y-4">
      <section className="bg-card border border-border rounded-lg p-4">
        <p className="text-sm text-muted-foreground">
          Net worth{latest ? ` · ${formatDay(latest.as_of)}` : ""}
        </p>
        <p className="text-3xl font-medium tabular-nums mt-1">
          {latest ? formatMoney(latest.net_worth, { whole: true }) : "—"}
        </p>
        <dl className="mt-4 divide-y divide-border">
          {rows.map((g) => (
            <div key={g.key} className="flex items-center justify-between py-2">
              <dt className="text-foreground">{g.label}</dt>
              <dd className="tabular-nums">{formatMoney(latest?.[g.key] ?? null, { whole: true })}</dd>
            </div>
          ))}
        </dl>
      </section>

      <SyncLine status={status} />

      {unassigned > 0 && (
        <button
          type="button"
          onClick={onOpenAccounts}
          className="w-full text-left p-4 min-h-[44px] rounded-lg bg-warning-light text-warning flex items-center justify-between gap-3"
        >
          <span>
            {unassigned} account{unassigned > 1 ? "s have" : " has"} no role and {unassigned > 1 ? "are" : "is"} left
            out of net worth. Assign a role.
          </span>
          <ChevronRight className="w-5 h-5 shrink-0" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
