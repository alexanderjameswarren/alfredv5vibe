import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { getAccounts, getActionItems, getLatestNetWorth, getLatestSyncRun } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import HelpButton, { HelpTitle } from "./HelpButton";
import {
  NET_WORTH_GROUPS, SIMPLEFIN_BRIDGE_URL, accountLabel, formatDateTime, formatDay, formatMoney, syncStatus, toNumber,
} from "./moneyFormat";
import { ACTION_BIG_DAYS, ACTION_DAYS } from "./ruleNumbers";
import {
  MONEY_REVIEW_PATH, inboxDetailPath, intentionDetailPath, moneyAccountPath, moneyPlannedItemPath,
  moneySubscriptionPath, moneyTransactionPath,
} from "../viewPaths";

// The Money patterns (PlanScreen's list and badge, PlannedItemDetailView's buttons, the
// Subscriptions breakdown toggle), reused here per A48.
const CARD = "bg-card border border-border rounded-lg p-4";
const LIST = "divide-y divide-border bg-card border border-border rounded-lg px-4";
const ROW = "w-full text-left flex items-start justify-between gap-3 min-h-[44px] py-3";
const BADGE = "inline-block px-2 py-0.5 rounded-full text-xs";
// The page's links, as "See every item".
const TEXT_LINK = "min-h-[44px] text-sm text-primary inline-flex items-center gap-1";
const NEXT_DAYS_SHOWN = 12;

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
        {status.needsBridge && (
          <p className="mt-2">
            Fix it in{" "}
            <a href={SIMPLEFIN_BRIDGE_URL} target="_blank" rel="noopener noreferrer" className="underline font-medium">
              SimpleFIN Bridge
            </a>
            : sign in, open that bank's connection and sign in to the bank again. The next daily sync picks it up.
          </p>
        )}
      </div>
    </div>
  );
}

/** Where a row's link goes (A52). Rule health has no screen, so a merchant opens Review. */
export function linkTarget(row) {
  const id = row?.link_id;
  switch (row?.link_kind) {
    case "planned_item": return id ? { path: moneyPlannedItemPath(id), state: { from: "overview" } } : null;
    case "subscription": return id ? { path: moneySubscriptionPath(id) } : null;
    case "transaction": return id ? { path: moneyTransactionPath(id), state: { from: "overview" } } : null;
    case "account": return id ? { path: moneyAccountPath(id), state: { from: "overview" } } : null;
    case "intention": return id ? { path: intentionDetailPath(id) } : null;
    case "inbox_item": return id ? { path: inboxDetailPath(id) } : null;
    case "review_reason":
    case "merchant": return { path: MONEY_REVIEW_PATH };
    default: return null;
  }
}

/** The small label on a To do row. */
export function todoKind(row, section) {
  if (section === "card_bills") return "Card";
  if (section === "money_intentions") return "Intention";
  if (section === "money_inbox") return "Someday";
  if (row.type === "rule_health") return "Rule";
  if (row.link_kind === "account" || row.type === "sync_problem") return "Account";
  return "Review";
}

const TODO_SECTIONS = ["overdue", "reconcile", "card_bills", "needs_attention", "money_intentions", "money_inbox"];

const sum = (rows, pick) => rows.reduce((t, r) => t + (pick(toNumber(r.amount) ?? 0)), 0);
const signed = (n, opts) => (toNumber(n) > 0 ? `+${formatMoney(n, opts)}` : formatMoney(n, opts));
const tone = (n) => (toNumber(n) > 0 ? "text-success" : toNumber(n) < 0 ? "text-destructive" : "");
// The late suffix the SQL adds to a title; the row's own "late" badge says it instead.
const plainTitle = (row) => (row.late ? row.title.replace(/ \(late, due [^)]*\)$/, "") : row.title);

function LinkRow({ row, onNavigate, children }) {
  const target = linkTarget(row);
  if (!target) return <div className={ROW}>{children}</div>;
  return (
    <button type="button" className={ROW} onClick={() => onNavigate(target.path, target.state)}>{children}</button>
  );
}

/** The first path row under the floor: where the balance first drops below it (A53). */
export const firstBelowIndex = (path) => path.findIndex((p) => p.below === true);

/** A day's closing balance shows once, on its last row; the starting balance always shows. */
export const showsBalance = (path, i) => path[i].type === "start" || i === path.length - 1 || path[i + 1].on !== path[i].on;

// An intention or inbox title that stops mid-sentence is the first line of longer text: end it with "…".
const UNFINISHED = /([,;:\-–—]|\b(and|or|but|to|the|of|with|for|a|an|if|so|then|because|on|in|at|by|from))$/i;
export function displayTitle(row, section) {
  const title = (row.title || "").trimEnd();
  if (!["money_intentions", "money_inbox"].includes(section) || title.endsWith("…")) return title;
  return UNFINISHED.test(title) ? `${title}…` : title;
}

function FundsTransfer({ below, reserve, onNavigate }) {
  const [open, setOpen] = useState(false);
  const causes = below.causes || [];
  const path = below.path || null;
  const biggest = causes.find((c) => c.type !== "burn") || causes[0];
  const reserveName = reserve ? accountLabel(reserve) : "the reserve";
  const firstBelow = path ? firstBelowIndex(path) : -1;
  return (
    <section className="rounded-lg bg-warning-light text-warning p-4">
      <p className="text-xs font-medium tracking-wide">
        <HelpTitle helpKey="overview.funds_transfer" text="FUNDS TRANSFER REQUIRED" />
      </p>
      <p className="text-lg font-medium mt-1 text-foreground">
        Move {formatMoney(below.shortfall_30d)} from {reserveName} by {formatDay(below.first_below_on)}
      </p>
      <p className="text-sm mt-1">
        {biggest && <>Biggest: {biggest.title}, {formatMoney(biggest.amount)}{biggest.on ? ` on ${formatDay(biggest.on)}` : ""}. </>}
        Lowest {formatMoney(below.low_30d_balance)} on {formatDay(below.low_30d_on)}, against a floor of {formatMoney(below.floor)}
        <HelpButton helpKey="overview.safety_floor" />
      </p>
      <div className="flex flex-wrap items-center gap-x-4 mt-2">
        {path && (
          <button type="button" className={TEXT_LINK} onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Show the path to {formatDay(below.low_30d_on)}
          </button>
        )}
        {reserve && (
          <button type="button" className={TEXT_LINK}
            onClick={() => onNavigate(moneyAccountPath(reserve.account_id ?? reserve.id), { from: "overview" })}>
            Reserve {formatMoney(below.reserve_balance)}
          </button>
        )}
      </div>
      {open && path && (
        <ul className={`${LIST} mt-3 text-foreground`}>
          {path.map((p, i) => (
            <li key={`${p.type}-${p.link_id || ""}-${p.on || ""}-${i}`}
              className={i === firstBelow ? "bg-destructive-light -mx-4 px-4" : ""}>
              <LinkRow row={p} onNavigate={onNavigate}>
                <span className="min-w-0 break-words">
                  <span className="block text-xs text-muted-foreground">{formatDay(p.on)}</span>
                  {p.title}
                  {p.type === "burn" && <HelpButton helpKey="overview.burn_rate" />}
                  {i === firstBelow && <span className="block text-xs text-destructive">Below the floor of {formatMoney(below.floor)}</span>}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {p.amount !== null && p.amount !== undefined && <span className="block">{signed(p.amount)}</span>}
                  {showsBalance(path, i) && (
                    <span className={`block text-xs ${p.below ? "text-destructive" : "text-muted-foreground"}`}>{formatMoney(p.balance)}</span>
                  )}
                </span>
              </LinkRow>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// A flag whose refund came is info (A53): green until it is marked handled.
function RedFlags({ flags, onNavigate }) {
  return flags.map((f, i) => {
    const target = linkTarget(f);
    const refund = f.refund ? linkTarget(f.refund) : null;
    const colors = f.severity === "info" ? "bg-success-light text-success" : "bg-destructive-light text-destructive";
    return (
      <section key={`${f.link_id || f.type}-${i}`} className={`rounded-lg ${colors} p-4`}>
        <div className="flex items-center">
          {target ? (
            <button type="button" className="text-left font-medium underline min-h-[44px]" onClick={() => onNavigate(target.path, target.state)}>
              {f.title}
            </button>
          ) : <p className="font-medium">{f.title}</p>}
          <HelpButton helpKey="overview.red_flags" />
        </div>
        {f.refund && (
          <p className="text-sm mt-1 text-foreground">
            {refund ? (
              <button type="button" className="text-left underline min-h-[44px]" onClick={() => onNavigate(refund.path, refund.state)}>
                Refund received: {signed(f.refund.amount)} on {formatDay(f.refund.on)}
              </button>
            ) : <>Refund received: {signed(f.refund.amount)} on {formatDay(f.refund.on)}</>}
          </p>
        )}
        {f.note && <p className="text-sm mt-1 text-foreground">Note: {f.note}</p>}
        <p className="text-sm mt-1 text-foreground">{f.todo}</p>
      </section>
    );
  });
}

function ToDo({ items, onNavigate }) {
  const rows = TODO_SECTIONS.flatMap((s) => (items[s] || []).map((r) => ({ row: r, kind: todoKind(r, s), title: displayTitle(r, s) })));
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="font-medium mb-2"><HelpTitle helpKey="overview.todo" text={`To do (${rows.length})`} /></h3>
      <ul className={LIST}>
        {rows.map(({ row, kind, title }, i) => (
          <li key={`${row.type}-${row.link_id || ""}-${i}`}>
            <LinkRow row={row} onNavigate={onNavigate}>
              <span className="min-w-0 break-words">{title}</span>
              <span className={`${BADGE} shrink-0 border border-border text-muted-foreground`}>{kind}</span>
            </LinkRow>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MajorExpenses({ rows, days, onNavigate }) {
  if (!rows.length) return null;
  const counted = rows.filter((r) => !r.what_if);
  return (
    <section>
      <h3 className="font-medium mb-1">
        <HelpTitle helpKey="overview.major_expenses" text={`Major expenses, next ${days} days (${rows.length})`} />
      </h3>
      <p className="text-sm tabular-nums mb-2">
        Total {formatMoney(sum(counted, (n) => n), { whole: true })}
        {counted.length < rows.length && <span className="text-muted-foreground"> (what-ifs not counted)</span>}
      </p>
      <ul className={LIST}>
        {rows.map((r, i) => (
          <li key={`${r.link_id}-${r.on}-${i}`}>
            <LinkRow row={r} onNavigate={onNavigate}>
              <span className="min-w-0 break-words">
                <span className="block text-xs text-muted-foreground">{formatDay(r.on)}</span>
                {r.title}{" "}
                {r.what_if && <span className={`${BADGE} border border-dashed border-primary text-primary-dark`}>What if</span>}
              </span>
              <span className="shrink-0 tabular-nums">{formatMoney(r.amount)}</span>
            </LinkRow>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextDays({ rows, days, onNavigate }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const moneyIn = sum(rows, (n) => Math.max(n, 0));
  const moneyOut = sum(rows, (n) => Math.min(n, 0));
  const net = moneyIn + moneyOut;
  const shown = all ? rows : rows.slice(0, NEXT_DAYS_SHOWN);
  return (
    <section>
      <h3 className="font-medium mb-1"><HelpTitle helpKey="overview.next_days" text={`Next ${days} days (${rows.length})`} /></h3>
      <p className="text-sm tabular-nums mb-2">
        In {signed(moneyIn, { whole: true })} | Out {formatMoney(moneyOut, { whole: true })} |{" "}
        Net <span className={tone(net)}>{signed(net, { whole: true })}</span>
      </p>
      <ul className={LIST}>
        {shown.map((r, i) => (
          <li key={`${r.link_id}-${r.on}-${i}`} className={r.big ? "font-medium" : ""}>
            <LinkRow row={r} onNavigate={onNavigate}>
              <span className="min-w-0 break-words">
                <span className="block text-xs text-muted-foreground font-normal">{formatDay(r.on)}</span>
                {plainTitle(r)}{" "}
                {r.late && <span className={`${BADGE} bg-warning-light text-warning font-normal`}>late</span>}
              </span>
              <span className={`shrink-0 tabular-nums ${toNumber(r.amount) > 0 ? "text-success" : ""}`}>{signed(r.amount)}</span>
            </LinkRow>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="min-h-[44px] mt-1 text-sm text-primary">
          See every item ({rows.length})
        </button>
      )}
    </section>
  );
}

function CashFlow({ flow, reserve }) {
  const cols = [
    ["Last 30 days", flow.last_30_actual],
    ["Next 30 days", flow.next_30_projected],
    ["Typical month", flow.typical_month],
  ];
  return (
    <section className={CARD}>
      <p className="font-medium"><HelpTitle helpKey="overview.cash_flow" text="Cash flow" /></p>
      <p className="text-sm text-muted-foreground">money in less money out</p>
      <dl className="grid grid-cols-3 gap-2 mt-3">
        {cols.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">
              {label}{label === "Typical month" && <HelpButton helpKey="overview.true_cost" />}
            </dt>
            <dd className={`tabular-nums font-medium ${tone(value)}`}>{signed(value, { whole: true })}</dd>
          </div>
        ))}
      </dl>
      {flow.runway_months !== null && flow.runway_months !== undefined && (
        <p className="text-sm border-t border-border mt-3 pt-3">
          At this rate the {reserve ? accountLabel(reserve) : "reserve"} reserve covers about {flow.runway_months} months.
          <HelpButton helpKey="overview.reserve_cash" />
        </p>
      )}
    </section>
  );
}

function NetWorth({ latest }) {
  const rows = NET_WORTH_GROUPS.filter((g) => g.always || toNumber(latest?.[g.key]));
  return (
    <section className={CARD}>
      <p className="text-sm text-muted-foreground">
        <HelpTitle helpKey="overview.net_worth" text={`Net worth${latest ? ` · ${formatDay(latest.as_of)}` : ""}`} />
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
  );
}

/**
 * The Overview as the money to-do list (spec A49–A52): sync status, funds transfer, red flags,
 * To do, major expenses, the next 14 days, cash flow and net worth. Read-only; every row opens
 * its record. An action-items failure leaves the net worth card working.
 */
export default function OverviewScreen({ onNavigate }) {
  const { data, error, loading } = useLoad(async () => {
    const [accounts, latest, run, items] = await Promise.all([
      getAccounts(), getLatestNetWorth(), getLatestSyncRun(), getActionItems().catch((e) => ({ loadError: e })),
    ]);
    return { accounts, latest, run, items };
  }, []);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const { accounts, latest, run, items } = data;
  const status = syncStatus(accounts, run);
  const reserve = accounts.filter((a) => a.role === "reserve_cash" && !a.is_hidden)
    .sort((a, b) => (toNumber(b.balance) ?? 0) - (toNumber(a.balance) ?? 0))[0] || null;
  const below = items?.below_floor;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-1">
        <div className="flex-1 min-w-0"><SyncLine status={status} /></div>
        <HelpButton helpKey="overview.sync_status" />
      </div>

      {items?.loadError ? (
        <p className="text-sm text-destructive">{items.loadError.message}</p>
      ) : (
        <>
          {below?.first_below_on && <FundsTransfer below={below} reserve={reserve} onNavigate={onNavigate} />}
          <RedFlags flags={items.flags || []} onNavigate={onNavigate} />
          <ToDo items={items} onNavigate={onNavigate} />
          <MajorExpenses rows={items.big_bites || []} days={items.big_days ?? ACTION_BIG_DAYS} onNavigate={onNavigate} />
          <NextDays rows={items.coming_up || []} days={items.days ?? ACTION_DAYS} onNavigate={onNavigate} />
          {items.cash_flow && <CashFlow flow={items.cash_flow} reserve={reserve} />}
        </>
      )}

      <NetWorth latest={latest} />
    </div>
  );
}
