import React, { useState } from "react";
import LineChart from "./LineChart";
import { getNetWorth } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import { NET_WORTH_GROUPS, daysBefore, formatDay, formatMoney, pacificToday, toNumber } from "./moneyFormat";

export const RANGES = [
  { key: "3m", label: "3 months", days: 92 },
  { key: "1y", label: "1 year", days: 366 },
  { key: "all", label: "All", days: null },
];

export default function NetWorthScreen() {
  const [range, setRange] = useState("3m");
  const days = RANGES.find((r) => r.key === range).days;
  const { data, error, loading } = useLoad(
    () => getNetWorth({ from: days ? daysBefore(pacificToday(), days) : null }),
    [days],
  );

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Range" className="flex gap-2">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            aria-pressed={range === r.key}
            onClick={() => setRange(r.key)}
            className={`min-h-[44px] px-3 py-2 rounded text-sm ${
              range === r.key
                ? "bg-primary text-white shadow-sm"
                : "bg-white text-foreground border border-border hover:border-primary"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {loading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {data && (
        <>
          <section className="bg-card border border-border rounded-lg p-4">
            <LineChart label="Net worth" data={data.map((d) => ({ day: d.as_of, value: d.net_worth }))} />
          </section>
          {data.length > 0 && <LatestTable row={data[data.length - 1]} />}
        </>
      )}
    </div>
  );
}

function LatestTable({ row }) {
  const groups = NET_WORTH_GROUPS.filter((g) => g.always || toNumber(row[g.key]));
  return (
    <section className="bg-card border border-border rounded-lg p-4">
      <h3 className="text-sm text-muted-foreground mb-1">{formatDay(row.as_of)}</h3>
      <dl className="divide-y divide-border">
        {groups.map((g) => (
          <div key={g.key} className="flex justify-between py-2">
            <dt>{g.label}</dt>
            <dd className="tabular-nums">{formatMoney(row[g.key], { whole: true })}</dd>
          </div>
        ))}
        <div className="flex justify-between py-2 font-medium">
          <dt>Net worth</dt>
          <dd className="tabular-nums">{formatMoney(row.net_worth, { whole: true })}</dd>
        </div>
        {toNumber(row.unassigned) ? (
          <div className="flex justify-between py-2 text-sm text-muted-foreground">
            <dt>Unassigned (not counted)</dt>
            <dd className="tabular-nums">{formatMoney(row.unassigned, { whole: true })}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
