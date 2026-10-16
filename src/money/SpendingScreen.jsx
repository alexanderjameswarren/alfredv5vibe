import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getCashFlow, getSpending, getTagTree } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import { HelpAfter } from "./HelpButton";
import { addMonths, formatMonth, formatMoney, monthOf, pacificToday, spendingForMonth, toNumber } from "./moneyFormat";

/** Live working for cash flow: the six months added up, and which ran negative. */
export function CashFlowWorking({ flow }) {
  if (!flow.length) return <p>No months recorded yet.</p>;
  const sum = (k) => flow.reduce((t, f) => t + (toNumber(f[k]) || 0), 0);
  const negative = flow.filter((f) => toNumber(f.net) < 0).map((f) => formatMonth(f.month));
  const unprocessed = sum("unprocessed");
  return (
    <>
      <p>
        {formatMonth(flow[0].month)} to {formatMonth(flow[flow.length - 1].month)}: in {formatMoney(sum("income"), { whole: true })},
        {" "}out {formatMoney(-sum("spending"), { whole: true })}, net {formatMoney(sum("net"), { whole: true })}.
      </p>
      <p className="mt-1">
        {negative.length ? `More went out than came in during ${negative.join(", ")}.` : "No month had more going out than coming in."}
      </p>
      {unprocessed > 0 && <p className="mt-1">{unprocessed} transaction{unprocessed === 1 ? " is" : "s are"} not processed yet, so not counted.</p>}
    </>
  );
}

const SECTION = "bg-card border border-border rounded-lg p-4";

/**
 * Spending (spec §7.4): Category totals for a month, top level, each expandable
 * to its children; and a cash-flow strip for the last six months. Spending and
 * refunds keep the sign rule (money out negative); totals here are shown as the
 * amounts spent.
 */
export default function SpendingScreen() {
  const thisMonth = monthOf(pacificToday());
  const [month, setMonth] = useState(thisMonth);
  const [open, setOpen] = useState(() => new Set());

  const { data, error, loading } = useLoad(async () => {
    const [rows, tree, flow] = await Promise.all([
      getSpending(month, month),
      getTagTree(),
      getCashFlow(addMonths(thisMonth, -5)),
    ]);
    return { rows, tree, flow };
  }, [month]);

  const toggle = (id) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpen(next);
  };
  const spent = (n) => formatMoney(-n);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"
          className="min-h-[44px] min-w-[44px] rounded-lg border border-border">‹</button>
        <input type="month" aria-label="Month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" />
        <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month" disabled={month >= thisMonth}
          className="min-h-[44px] min-w-[44px] rounded-lg border border-border disabled:opacity-40">›</button>
      </div>

      {loading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}

      {data && (() => {
        const view = spendingForMonth(data.rows, data.tree.tags, month);
        return (
          <>
            <section className={SECTION}>
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <h3 className="font-medium">
                  Spending by category,{" "}
                  <HelpAfter helpKey="spending.by_category" working={
                    <p>
                      {formatMonth(month)}: {spent(view.total)} in all
                      {view.untagged !== 0 ? `, of which ${spent(view.untagged)} has no category yet` : ", all of it with a category"}.
                    </p>
                  }>{formatMonth(month)}</HelpAfter>
                </h3>
                <span className="tabular-nums font-medium">{spent(view.total)}</span>
              </div>
              {view.groups.length === 0 && view.untagged === 0 ? (
                <p className="text-sm text-muted-foreground">No spending recorded for this month.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {view.groups.map((g) => (
                    <li key={g.tagId}>
                      <button type="button" onClick={() => toggle(g.tagId)} aria-expanded={open.has(g.tagId)}
                        disabled={g.children.length === 0}
                        className="w-full flex items-center justify-between gap-3 py-2 min-h-[44px] text-left">
                        <span className="flex items-center gap-1 min-w-0">
                          {g.children.length > 0
                            ? (open.has(g.tagId) ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />)
                            : <span className="w-4 shrink-0" />}
                          <span className="break-words">{g.name}</span>
                        </span>
                        <span className="tabular-nums shrink-0">{spent(g.amount)}</span>
                      </button>
                      {open.has(g.tagId) && (
                        <ul className="pl-6 pb-2">
                          {g.children.map((c) => (
                            <li key={c.tagId} className="flex justify-between gap-3 py-1 text-sm text-muted-foreground">
                              <span className="break-words">{c.name}</span>
                              <span className="tabular-nums shrink-0">{spent(c.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                  {view.untagged !== 0 && (
                    <li className="flex justify-between gap-3 py-2 min-h-[44px] items-center">
                      <span className="pl-5 text-muted-foreground">No category yet</span>
                      <span className="tabular-nums">{spent(view.untagged)}</span>
                    </li>
                  )}
                </ul>
              )}
            </section>

            <section className={SECTION}>
              <h3 className="font-medium mb-2">
                Cash flow, last 6{" "}
                <HelpAfter helpKey="spending.cash_flow" working={<CashFlowWorking flow={data.flow.slice(-6)} />}>months</HelpAfter>
              </h3>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
                <span className="text-muted-foreground">Month</span>
                <span className="text-muted-foreground text-right">In</span>
                <span className="text-muted-foreground text-right">Out</span>
                <span className="text-muted-foreground text-right">Net</span>
                {data.flow.slice(-6).map((f) => (
                  <React.Fragment key={f.month}>
                    <span>{formatMonth(f.month)}</span>
                    <span className="text-right">{formatMoney(f.income, { whole: true })}</span>
                    <span className="text-right">{formatMoney(-toNumber(f.spending), { whole: true })}</span>
                    <span className={`text-right ${toNumber(f.net) < 0 ? "text-destructive" : ""}`}>{formatMoney(f.net, { whole: true })}</span>
                  </React.Fragment>
                ))}
              </div>
              {data.flow.length === 0 && <p className="text-sm text-muted-foreground">No cash flow recorded yet.</p>}
              <p className="text-xs text-muted-foreground mt-2">Transfers and investments are left out.</p>
            </section>
          </>
        );
      })()}
    </div>
  );
}
