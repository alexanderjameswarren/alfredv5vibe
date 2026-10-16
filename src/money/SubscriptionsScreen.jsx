import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { dismissSubscription, getSubscriptions, setSubscriptionStatus } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import HelpButton, { HelpAfter } from "./HelpButton";
import {
  OWNER_LABELS, formatDay, formatMoney, groupSubscriptions, intervalLabel, pacificToday, reviewSoon, subscriptionBreakdown,
} from "./moneyFormat";

const SMALL = "min-h-[44px] px-3 rounded-lg border border-border text-sm";
const BADGE = "inline-block px-2 py-0.5 rounded-full text-xs";

export function SubscriptionBadges({ sub, today }) {
  return (
    <>
      {sub.status === "active" && sub.overdue && (
        <span className={`${BADGE} border border-destructive text-destructive`}>Overdue {sub.days_past_expected} days</span>
      )}
      {reviewSoon(sub, today) && <span className={`${BADGE} bg-primary-light text-primary-dark`}>Review {formatDay(sub.review_date)}</span>}
      {sub.term_end_date && sub.term_end_date >= today && (
        <span className={`${BADGE} border border-border text-muted-foreground`}>Prepaid to {formatDay(sub.term_end_date)}</span>
      )}
    </>
  );
}

/** Live working for the monthly total: how many counted, and why the rest were not. */
export function TotalWorking({ totals }) {
  return (
    <>
      <p>{totals.rows.length} active subscription{totals.rows.length === 1 ? "" : "s"} counted.</p>
      {totals.notCounted.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {totals.notCounted.map((n) => <li key={n.sub.id}>{n.sub.name}: not counted, {n.reason.toLowerCase()}.</li>)}
        </ul>
      )}
    </>
  );
}

/** Live working for Overdue: each one's expected date and how far past it is. */
export function OverdueWorking({ rows }) {
  return (
    <ul className="list-disc pl-5">
      {rows.map((s) => (
        <li key={s.id}>
          {s.name}: last charged {formatDay(s.last_charged_on)}, expected {formatDay(s.next_expected_on)},
          {" "}{s.days_past_expected} days ago.
        </li>
      ))}
    </ul>
  );
}

const OWNER_KEYS = ["alex", "elise", "joint", "unassigned"];
const ownerName = (k) => OWNER_LABELS[k] || "Unassigned";
const CELL = "py-2 pr-3 align-top";
const NUM = "py-2 text-right tabular-nums align-top whitespace-nowrap";

/**
 * Every subscription in the monthly total, high to low. Below sm the owner,
 * price, billing and multiplier columns fold into a second line under the name,
 * so the table never scrolls sideways.
 */
export function Breakdown({ breakdown }) {
  const { rows, total, byOwner, notCounted } = breakdown;
  return (
    <div className="mt-3">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className={CELL}>Subscription</th>
            <th className={`${CELL} hidden sm:table-cell`}>Owner</th>
            <th className={`${CELL} hidden sm:table-cell text-right`}>Price</th>
            <th className={`${CELL} hidden sm:table-cell`}>Billing</th>
            <th className={`${CELL} hidden sm:table-cell`}>Monthly ×</th>
            <th className={`${NUM}`}>Per month</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.sub.id}>
              <td className={`${CELL} break-words`}>
                {r.sub.name}
                <span className="block text-xs text-muted-foreground sm:hidden">
                  {ownerName(r.owner)} · {formatMoney(r.sub.current_price)} {intervalLabel(r.sub).toLowerCase()} · {r.multiplier}
                </span>
              </td>
              <td className={`${CELL} hidden sm:table-cell`}>{ownerName(r.owner)}</td>
              <td className={`${CELL} hidden sm:table-cell text-right tabular-nums`}>{formatMoney(r.sub.current_price)}</td>
              <td className={`${CELL} hidden sm:table-cell`}>{intervalLabel(r.sub)}</td>
              <td className={`${CELL} hidden sm:table-cell tabular-nums`}>{r.multiplier}</td>
              <td className={NUM}>{formatMoney(r.monthly)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-border">
          {OWNER_KEYS.filter((k) => byOwner[k]).map((k) => (
            <tr key={k} className="text-muted-foreground">
              <td className={CELL}>{ownerName(k)}</td>
              <td className="hidden sm:table-cell" colSpan={4} />
              <td className={NUM}>{formatMoney(byOwner[k])}</td>
            </tr>
          ))}
          <tr className="font-medium">
            <td className={CELL}>Total ({rows.length})</td>
            <td className="hidden sm:table-cell" colSpan={4} />
            <td className={NUM}>{formatMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="text-xs text-muted-foreground mt-2">
        Each row is today's price times the multiplier, rounded to the cent; the total is the sum of those rounded rows.
      </p>
      {notCounted.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium">Not counted</p>
          <ul className="text-sm divide-y divide-border">
            {notCounted.map((n) => (
              <li key={n.sub.id} className="py-1.5 flex flex-wrap justify-between gap-x-3">
                <span className="break-words">{n.sub.name}</span>
                <span className="text-muted-foreground">{n.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The Subscriptions tab (spec §7.5): every subscription grouped by status, with
 * Overdue first and Cancelled collapsed, and the monthly-equivalent cost of the
 * active ones on top, split by owner. Detected (watching) rows can be confirmed
 * or dismissed here as in Review.
 */
export default function SubscriptionsScreen({ onOpen }) {
  const { data, error, loading, reload } = useLoad(() => getSubscriptions(), []);
  const [showCancelled, setShowCancelled] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (data.length === 0) return <p className="text-sm text-muted-foreground">No subscriptions yet.</p>;

  const today = pacificToday();
  const totals = subscriptionBreakdown(data);
  const groups = groupSubscriptions(data);

  async function act(id, fn) {
    setBusyId(id);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err.message);
    }
    setBusyId(null);
  }

  return (
    <div className="space-y-6">
      <section className="bg-card border border-border rounded-lg p-4">
        <p className="text-sm text-muted-foreground">
          Active subscriptions, per{" "}
          <HelpAfter helpKey="subscriptions.monthly_total" working={<TotalWorking totals={totals} />}>month</HelpAfter>
        </p>
        <p className="text-2xl font-medium tabular-nums">{formatMoney(totals.total)}</p>
        <p className="text-sm text-muted-foreground mt-1 flex flex-wrap gap-x-4">
          {OWNER_KEYS.filter((k) => totals.byOwner[k]).map((k) => (
            <span key={k}>{ownerName(k)} <span className="tabular-nums">{formatMoney(totals.byOwner[k])}</span></span>
          ))}
        </p>
        {totals.notCounted.length > 0 && !showBreakdown && (
          <p className="text-xs text-muted-foreground mt-2 break-words">
            Not counted (no regular interval or price): {totals.notCounted.map((n) => n.sub.name).join(", ")}
          </p>
        )}
        <button type="button" onClick={() => setShowBreakdown(!showBreakdown)} aria-expanded={showBreakdown}
          className="min-h-[44px] mt-1 text-sm text-primary inline-flex items-center gap-1">
          {showBreakdown ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          {showBreakdown ? "Hide breakdown" : "Show breakdown"}
        </button>
        {showBreakdown && <HelpButton helpKey="subscriptions.breakdown" />}
        {showBreakdown && <Breakdown breakdown={totals} />}
      </section>

      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

      {groups.map((g) => {
        const collapsed = g.key === "cancelled" && !showCancelled;
        return (
          <section key={g.key}>
            <h3 className="font-medium mb-2">
              {g.key === "cancelled" ? (
                <>
                  <button type="button" onClick={() => setShowCancelled(!showCancelled)} aria-expanded={!collapsed}
                    className="min-h-[44px] inline-flex items-center gap-1 align-middle">
                    {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    {g.label} <span className="text-muted-foreground font-normal">({g.rows.length})</span>
                  </button>
                  <HelpButton helpKey={`subscription.status.${g.key}`} />
                </>
              ) : (
                <>
                  {g.label}{" "}
                  <HelpAfter helpKey={`subscription.status.${g.key}`}
                    working={g.key === "overdue" ? <OverdueWorking rows={g.rows} /> : null}>
                    <span className="text-muted-foreground font-normal">({g.rows.length})</span>
                  </HelpAfter>
                </>
              )}
            </h3>
            {!collapsed && (
              <ul className="divide-y divide-border bg-card border border-border rounded-lg px-4">
                {g.rows.map((s) => (
                  <li key={s.id} className="py-3">
                    <button type="button" onClick={() => onOpen(s.id)}
                      className="w-full text-left flex items-start justify-between gap-3 min-h-[44px]">
                      <span className="min-w-0">
                        <span className="block break-words">{s.name}{s.plan ? ` · ${s.plan}` : ""}</span>
                        <span className="block text-xs text-muted-foreground break-words">
                          {intervalLabel(s)}
                          {s.next_expected_on ? ` · next ${formatDay(s.next_expected_on)}` : ""}
                          {s.owner ? ` · ${OWNER_LABELS[s.owner]}` : ""}
                        </span>
                        <span className="flex flex-wrap gap-1 mt-1"><SubscriptionBadges sub={s} today={today} /></span>
                      </span>
                      <span className="tabular-nums shrink-0">{formatMoney(s.current_price)}</span>
                    </button>
                    {s.status === "watching" && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        <button type="button" disabled={busyId === s.id} className={SMALL}
                          onClick={() => act(s.id, () => setSubscriptionStatus(s.id, "active"))}>
                          Confirm
                        </button>
                        <button type="button" disabled={busyId === s.id} className={SMALL}
                          onClick={() => act(s.id, () => dismissSubscription(s.id))}>
                          Not a subscription
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
