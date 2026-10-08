import React, { useState } from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import EditCard from "../shared/EditCard";
import LineChart from "./LineChart";
import RecordBalanceForm from "./RecordBalanceForm";
import AccountFields, { fromForm, toForm } from "./AccountFields";
import {
  getAccount, getBalanceHistory, getHoldings, getTransactions, updateAccount,
} from "./moneyApi";
import { useLoad } from "./useMoneyData";
import {
  OWNER_LABELS, ROLE_LABELS, accountLabel, accountSubtitle, costBasisLabel, daysBefore,
  formatDay, formatMoney, holdingGain, pacificToday, rewardDisplay,
} from "./moneyFormat";

const INVESTMENT_ROLES = ["retirement", "taxable_investment"];
const SECTION = "bg-card border border-border rounded-lg p-4";

function Transactions({ rows }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No transactions stored yet.</p>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((t) => (
        <li key={t.id} className={`flex items-start justify-between gap-3 py-2 ${t.pending ? "text-muted-foreground" : ""}`}>
          <span className="min-w-0">
            <span className="block break-words">{t.payee || t.description || "—"}</span>
            <span className="block text-xs text-muted-foreground">
              {formatDay((t.posted_at || t.transacted_at || "").slice(0, 10))}
              {t.pending && <span className="ml-2 font-medium">pending</span>}
            </span>
          </span>
          <span className="tabular-nums shrink-0">{formatMoney(t.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

function Holdings({ rows }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No holdings reported.</p>;
  return (
    <>
      <p className="text-xs text-muted-foreground mb-2">As of {formatDay(rows[0].as_of)}</p>
      <ul className="divide-y divide-border">
        {rows.map((h) => {
          const gain = holdingGain(h);
          return (
            <li key={h.id} className="py-2">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-medium">{h.symbol || "—"}</span>
                  <span className="block text-xs text-muted-foreground break-words">{h.description}</span>
                </span>
                <span className="tabular-nums shrink-0">{formatMoney(h.market_value)}</span>
              </div>
              <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                {h.shares ?? "—"} shares · cost basis {costBasisLabel(h)}
                {gain !== null && <> · {gain >= 0 ? "gain" : "loss"} {formatMoney(Math.abs(gain))}</>}
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Facts({ account }) {
  const items = [
    ["Role", ROLE_LABELS[account.role]],
    ["Owner", OWNER_LABELS[account.owner] || "Not set"],
    ["Source", account.source === "manual" ? "Entered by hand" : "Synced (SimpleFIN)"],
    account.credit_limit !== null && ["Credit limit", formatMoney(account.credit_limit)],
    account.expires_on && ["Expires", formatDay(account.expires_on)],
    (account.active_from || account.active_until) &&
      ["Counts", `${account.active_from ? formatDay(account.active_from) : "from the start"} to ${account.active_until ? formatDay(account.active_until) : "never (no end date)"}`],
    account.is_hidden && ["Hidden", "Yes"],
  ].filter(Boolean);
  return (
    <dl className="divide-y divide-border">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 py-2 text-sm">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
      {account.notes && <p className="pt-2 text-sm whitespace-pre-wrap">{account.notes}</p>}
    </dl>
  );
}

function EditAccount({ account, onSaved, onCancel }) {
  const [form, setForm] = useState(toForm(account));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await updateAccount(account.id, fromForm(form));
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <EditCard>
      <form onSubmit={save} className="space-y-3">
        <AccountFields form={form} setForm={setForm} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-3">
          <button type="submit" disabled={busy}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors disabled:opacity-50">
            Save
          </button>
          <button type="button" onClick={onCancel}
            className="min-h-[44px] px-4 py-2 rounded-lg border border-border text-sm text-foreground">
            Cancel
          </button>
        </div>
      </form>
    </EditCard>
  );
}

export default function AccountDetailView({ accountId, onBack }) {
  const [editing, setEditing] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    const account = await getAccount(accountId);
    if (!account) return { account: null };
    const synced = account.source === "simplefin";
    const [history, transactions, holdings] = await Promise.all([
      getBalanceHistory(accountId, { from: daysBefore(pacificToday(), 90) }),
      synced ? getTransactions(accountId) : Promise.resolve([]),
      synced && INVESTMENT_ROLES.includes(account.role) ? getHoldings(accountId) : Promise.resolve([]),
    ]);
    return { account, history, transactions, holdings };
  }, [accountId]);

  const header = (title, subtitle) => (
    <div className="flex items-center gap-3 mb-4">
      <button type="button" onClick={onBack} title="Back to Accounts"
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground rounded">
        <ArrowLeft className="w-5 h-5" />
      </button>
      <div className="min-w-0">
        <h3 className="text-lg font-medium break-words">{title}</h3>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );

  if (loading && !data) return <>{header("Account")}<p className="text-sm text-muted-foreground">Loading…</p></>;
  if (error) return <>{header("Account")}<p className="text-sm text-destructive">{error.message}</p></>;
  if (!data.account) return <>{header("Account")}<p className="text-sm text-muted-foreground">No such account.</p></>;

  const { account, history, transactions, holdings } = data;
  const rewards = account.role === "rewards";
  const r = rewards ? rewardDisplay(account) : null;

  return (
    <div>
      {header(accountLabel(account), accountSubtitle(account))}
      <div className="space-y-4">
        <section className={SECTION}>
          <p className="text-sm text-muted-foreground">
            Balance{account.as_of ? ` · ${formatDay(account.as_of)}` : ""}
          </p>
          <p className="text-2xl font-medium tabular-nums mt-1">{rewards ? r.units : formatMoney(account.balance)}</p>
          {rewards && r.dollars && <p className="text-sm text-muted-foreground">≈ {r.dollars}</p>}
          {rewards && r.expires && <p className="text-sm text-muted-foreground">Expires {formatDay(r.expires)}</p>}
          <div className="mt-3">
            <LineChart
              label="Balance, last 90 days"
              data={history.map((h) => ({ day: h.as_of, value: h.balance }))}
              valueFormat={rewards ? (v) => rewardDisplay({ ...account, balance: v }).units : undefined}
            />
          </div>
        </section>

        {account.source === "manual" && (
          <section className={SECTION}>
            <h4 className="font-medium mb-3">Record a balance</h4>
            <RecordBalanceForm account={account} onRecorded={reload} />
          </section>
        )}

        {editing ? (
          <EditAccount account={account} onCancel={() => setEditing(false)}
            onSaved={() => { setEditing(false); reload(); }} />
        ) : (
          <section className={SECTION}>
            <div className="flex items-center justify-between mb-1">
              <h4 className="font-medium">Details</h4>
              <button type="button" onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-3 text-sm text-primary">
                <Pencil className="w-4 h-4" aria-hidden="true" /> Edit
              </button>
            </div>
            <Facts account={account} />
          </section>
        )}

        {account.source === "simplefin" && INVESTMENT_ROLES.includes(account.role) && (
          <section className={SECTION}>
            <h4 className="font-medium mb-2">Holdings</h4>
            <Holdings rows={holdings} />
          </section>
        )}

        {account.source === "simplefin" && (
          <section className={SECTION}>
            <h4 className="font-medium mb-2">Recent transactions</h4>
            <Transactions rows={transactions} />
          </section>
        )}
      </div>
    </div>
  );
}
