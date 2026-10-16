import React, { useEffect, useState } from "react";
import { getAccounts, getTagTree, listTransactions, PAGE_SIZE } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import HelpButton from "./HelpButton";
import { KIND_LABELS, KIND_ORDER, accountLabel, formatDay, formatMoney } from "./moneyFormat";

const FIELD = "w-full min-h-[44px] px-3 py-2 rounded-lg border border-border bg-background text-sm";
const EMPTY = { accountId: "", month: "", kind: "", tag: "", text: "", needsReview: false };

/** A kind chip; muted for investments and transfers, which are not spending. */
export function KindChip({ kind }) {
  if (!kind) return <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">unprocessed</span>;
  const quiet = kind === "transfer" || kind === "investment";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${quiet ? "bg-muted text-muted-foreground" : "bg-primary-light text-primary-dark"}`}>
      {KIND_LABELS[kind] || kind}
    </span>
  );
}

/** One row of a transaction list; the whole row is the tap target. */
export function TransactionRow({ t, onOpen, showAccount = true }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(t.id)}
        className={`w-full text-left flex items-start justify-between gap-3 py-3 min-h-[44px] ${t.pending ? "text-muted-foreground" : ""}`}>
        <span className="min-w-0">
          <span className="block break-words">{t.clean_description || t.payee || t.description || "—"}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-muted-foreground">
            <span>{formatDay(t.txn_date || (t.posted_at || t.transacted_at || "").slice(0, 10))}</span>
            {showAccount && t.account_label && <span className="break-words">{t.account_label}</span>}
            {t.merchant_name && <span className="break-words">· {t.merchant_name}</span>}
            {t.pending && <span className="font-medium">pending</span>}
          </span>
          <span className="flex flex-wrap items-center gap-1 mt-1">
            <KindChip kind={t.kind} />
            {(t.tag_names || []).map((n) => (
              <span key={n} className="text-xs px-2 py-0.5 rounded-full border border-border">{n}</span>
            ))}
            {t.needs_review && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">review</span>}
          </span>
        </span>
        <span className="tabular-nums shrink-0">{formatMoney(t.amount)}</span>
      </button>
    </li>
  );
}

export default function TransactionsScreen({ onOpen }) {
  const [filters, setFilters] = useState(EMPTY);
  const [text, setText] = useState("");
  const [pages, setPages] = useState({ rows: [], total: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const options = useLoad(async () => {
    const [accounts, tree] = await Promise.all([getAccounts(), getTagTree()]);
    return { accounts: accounts.filter((a) => a.source === "simplefin"), tags: tree.tags.filter((t) => t.is_active !== false) };
  }, []);

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.text === text ? f : { ...f, text })), 300);
    return () => clearTimeout(t);
  }, [text]);

  // A new filter starts from the first page.
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    listTransactions(filters, { offset: 0 }).then(
      (page) => { if (live) { setPages(page); setBusy(false); } },
      (err) => { if (live) { setError(err.message); setBusy(false); } },
    );
    return () => { live = false; };
  }, [filters]);

  async function loadMore() {
    setBusy(true);
    try {
      const next = await listTransactions(filters, { offset: pages.rows.length });
      setPages({ rows: [...pages.rows, ...next.rows], total: next.total });
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const accounts = options.data?.accounts || [];
  const tagNames = [...new Set((options.data?.tags || []).map((t) => t.name))].sort();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input type="search" placeholder="Search" aria-label="Search" value={text} onChange={(e) => setText(e.target.value)} className={FIELD} />
        <select aria-label="Account" value={filters.accountId} onChange={set("accountId")} className={FIELD}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{accountLabel(a)}</option>)}
        </select>
        <input type="month" aria-label="Month" value={filters.month} onChange={set("month")} className={FIELD} />
        <select aria-label="Kind" value={filters.kind} onChange={set("kind")} className={FIELD}>
          <option value="">All kinds</option>
          {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
        <select aria-label="Tag" value={filters.tag} onChange={set("tag")} className={FIELD}>
          <option value="">All tags</option>
          {tagNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <div className="flex items-center gap-2 min-h-[44px] text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={filters.needsReview} onChange={set("needsReview")} className="w-5 h-5" />
            <span>Needs review only</span>
          </label>
          <HelpButton helpKey="transactions.needs_review" />
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">
        {busy && pages.rows.length === 0 ? "Loading…" : `${pages.total} transaction${pages.total === 1 ? "" : "s"}`}
      </p>
      <ul className="divide-y divide-border bg-card border border-border rounded-lg px-4">
        {pages.rows.map((t) => <TransactionRow key={t.id} t={t} onOpen={onOpen} />)}
      </ul>
      {pages.rows.length < pages.total && (
        <button type="button" onClick={loadMore} disabled={busy}
          className="w-full min-h-[44px] rounded-lg border border-border text-sm disabled:opacity-50">
          {busy ? "Loading…" : `Load ${Math.min(PAGE_SIZE, pages.total - pages.rows.length)} more`}
        </button>
      )}
    </div>
  );
}
