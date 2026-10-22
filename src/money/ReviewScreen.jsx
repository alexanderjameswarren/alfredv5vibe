import React, { useState } from "react";
import AlwaysDoThisSheet from "./AlwaysDoThisSheet";
import { HelpAfter } from "./HelpButton";
import {
  applyTags, confirmPlannedMatch, dismissSubscription, getReviewQueue, getSubscriptionDetail, getSubscriptions, getTagTree,
  recordSubscriptionPrice, rejectPlannedMatch, reprocess, setKind, setReviewed,
} from "./moneyApi";
import { useLoad } from "./useMoneyData";
import { formatDay, formatMoney, groupQueue, leftOf, parseAmountInput, tagOptions, toNumber } from "./moneyFormat";

const SMALL = "min-h-[44px] px-3 rounded-lg border border-border text-sm";

/** Live working for price changes: each charge against the price expected on its date, and the tolerance. */
export function PriceChangeWorking({ rows }) {
  const { data, error } = useLoad(() => getSubscriptions(), []);
  if (error) return <p>{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  const subs = new Map(data.map((s) => [s.id, s]));
  return (
    <ul className="list-disc pl-5 space-y-1">
      {rows.map((r) => {
        const sub = subs.get(r.subscription_id);
        const tolerance = toNumber(sub?.amount_tolerance) || 0;
        return (
          <li key={r.transaction_id}>
            {formatDay(r.txn_date)}: charged {formatMoney(-toNumber(r.amount))}. {r.detail}.
            {" "}{tolerance > 0 ? `Tolerance ± ${formatMoney(tolerance)}.` : "No tolerance: it must match to the cent."}
          </li>
        );
      })}
    </ul>
  );
}

function ChargeDates({ subscriptionId }) {
  const { data } = useLoad(() => getSubscriptionDetail(subscriptionId), [subscriptionId]);
  if (!data) return null;
  return <>: {data.charges.slice().reverse().map((c) => formatDay(c.txn_date)).join(", ")}</>;
}

/** Live working for possible subscriptions: the charges that made each one look monthly. */
export function NewRecurringWorking({ rows }) {
  return (
    <ul className="list-disc pl-5 space-y-1">
      {rows.map((r) => (
        <li key={r.transaction_id}>
          {r.detail || r.merchant_name}: charges linked
          {r.subscription_id ? <ChargeDates subscriptionId={r.subscription_id} /> : null}.
        </li>
      ))}
    </ul>
  );
}

const daysApart = (a, b) => Math.round(Math.abs(new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);

/** Live working for suggested matches: payment against plan, with the item's tolerance and window. */
export function PlannedMatchWorking({ rows }) {
  return (
    <ul className="list-disc pl-5 space-y-1">
      {rows.map((r) => {
        const gap = Math.abs(Math.abs(toNumber(r.amount)) - Math.abs(toNumber(r.planned_amount)));
        return (
          <li key={r.planned_match_id}>
            {r.planned_item_name}: planned {formatMoney(r.planned_amount)} due {formatDay(r.planned_on)}; paid
            {" "}{formatMoney(r.amount)} on {formatDay(r.txn_date)}. That is {formatMoney(gap)} apart (tolerance
            {" "}{formatMoney(r.planned_tolerance)}) and {daysApart(r.txn_date, r.planned_on)} days apart (window
            {" "}{r.planned_window_days} days either side).
          </li>
        );
      })}
    </ul>
  );
}

const WORKING = { price_change: PriceChangeWorking, new_recurring: NewRecurringWorking, planned_match: PlannedMatchWorking };

/**
 * What confirming this suggestion leaves on the planned item (or, for a repeating item,
 * on that due date), with the item's sign, and whether it is then covered. Within the
 * tolerance counts as covered (A45), the same rule as the database.
 */
export function matchOutcome(row) {
  const full = Math.abs(toNumber(row.planned_amount) ?? 0);
  const paid = (toNumber(row.planned_already) ?? 0) + Math.abs(toNumber(row.match_amount) ?? 0);
  const left = leftOf(full, paid, toNumber(row.planned_tolerance) ?? 0);
  const sign = Math.sign(toNumber(row.planned_amount) ?? 0);
  return { left: left === 0 ? 0 : Math.round(sign * left * 100) / 100, covered: left === 0, withinTolerance: left === 0 && paid < full };
}

function outcomeLine(row) {
  const o = matchOutcome(row);
  if (!o.covered) return `After this payment, ${formatMoney(o.left)} is still left${row.planned_repeating ? " for that date" : ""}.`;
  const why = o.withinTolerance ? " What is left is within its tolerance, so it counts as covered." : "";
  return row.planned_repeating ? `Confirming covers that date.${why}` : `Confirming marks it paid.${why}`;
}

/** The full card for a suggested match (spec A18): planned against paid, side by side. */
function PlannedMatchCard({ row, onOpen, onOpenItem }) {
  const box = "w-full text-left rounded-lg border border-border p-3 min-h-[44px] flex flex-col gap-0.5";
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button type="button" className={box} onClick={() => onOpenItem(row.planned_item_id)}>
          <span className="text-xs text-muted-foreground">Planned</span>
          <span className="break-words font-medium">{row.planned_item_name}</span>
          <span className="text-xs text-muted-foreground break-words">
            Due {formatDay(row.planned_on)}{row.planned_project_name ? ` · ${row.planned_project_name}` : ""}
          </span>
          <span className="tabular-nums">{formatMoney(row.planned_amount)}</span>
        </button>
        <button type="button" className={box} onClick={() => onOpen(row.transaction_id)}>
          <span className="text-xs text-muted-foreground">Paid</span>
          <span className="break-words font-medium">{row.merchant_name || row.clean_description || row.payee || "—"}</span>
          <span className="text-xs text-muted-foreground break-words">{formatDay(row.txn_date)} · {row.account_label}</span>
          <span className="tabular-nums">
            {formatMoney(row.amount)}
            {toNumber(row.match_amount) !== toNumber(row.amount) && (
              <span className="text-xs text-muted-foreground"> · {formatMoney(row.match_amount)} for this item</span>
            )}
          </span>
        </button>
      </div>
      <p className="text-sm break-words">
        <HelpAfter helpKey="review.match_card">{outcomeLine(row)}</HelpAfter>
      </p>
    </div>
  );
}

/** Confirm (optionally for a lower amount) or turn down one suggested planned match. */
function PlannedMatchActions({ row, busy, act }) {
  const [lowering, setLowering] = useState(false);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState(null);
  const confirmLower = () => {
    const n = parseAmountInput(amount);
    if (n === null || n === 0) { setError("Type the amount for the planned item, e.g. 120.00."); return; }
    setError(null);
    act(row.transaction_id, () => confirmPlannedMatch(row.planned_match_id, n));
  };
  return (
    <>
      {!lowering && (
        <button type="button" disabled={busy} className={SMALL}
          onClick={() => act(row.transaction_id, () => confirmPlannedMatch(row.planned_match_id))}>
          Confirm
        </button>
      )}
      {!lowering && (
        <button type="button" disabled={busy} className={SMALL} onClick={() => setLowering(true)}>
          Lower amount…
        </button>
      )}
      {lowering && (
        <span className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`lower-${row.planned_match_id}`}>Amount for the planned item</label>
          <input id={`lower-${row.planned_match_id}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder={String(Math.abs(toNumber(row.match_amount)))}
            className="min-h-[44px] w-28 px-3 rounded-lg border border-border bg-background text-sm" />
          <button type="button" disabled={busy} className={SMALL} onClick={confirmLower}>Confirm amount</button>
          <button type="button" disabled={busy} className={SMALL} onClick={() => { setLowering(false); setError(null); }}>Cancel</button>
        </span>
      )}
      <button type="button" disabled={busy} className={SMALL}
        onClick={() => act(row.transaction_id, () => rejectPlannedMatch(row.planned_match_id))}>
        Not this one
      </button>
      {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
    </>
  );
}

/**
 * The review queue (spec §7.3), newest first, grouped by reason, with one tap
 * per fix: reprocess an unprocessed row; pick a Category (then offer "always do
 * this"); "Not a transfer", or open it to find the other side; open the split
 * editor; or mark it reviewed. Subscription rows: record a changed price, or
 * say whether a detected subscription is one ("Keep watching") or not.
 */
export default function ReviewScreen({ onOpen, onOpenItem = () => {} }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [rows, tree] = await Promise.all([getReviewQueue(), getTagTree()]);
    return { rows, tree };
  }, []);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [sheet, setSheet] = useState(null); // {txn, tagId, tagName}

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const groups = groupQueue(data.rows);
  const category = data.tree.groups.find((g) => g.name === "Category");
  const categoryOptions = category ? tagOptions(data.tree.tags, category.id) : [];

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

  function pickCategory(row, tagId) {
    act(row.transaction_id, async () => {
      await applyTags([row.transaction_id], [tagId], []);
      const tag = data.tree.tags.find((t) => t.id === tagId);
      setSheet({ txn: { id: row.transaction_id }, tagId, tagName: tag?.name, label: row.merchant_name || row.payee });
    });
  }

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to review. Every transaction has its kind, category and transfer settled.</p>;
  }

  return (
    <div className="space-y-6">
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      {groups.map((g) => (
        <section key={g.reason}>
          <h3 className="font-medium mb-2">
            {g.label}{" "}
            <HelpAfter helpKey={`review.${g.reason}`} working={WORKING[g.reason] ? React.createElement(WORKING[g.reason], { rows: g.rows }) : null}>
              <span className="text-muted-foreground font-normal">({g.rows.length})</span>
            </HelpAfter>
          </h3>
          <ul className="divide-y divide-border bg-card border border-border rounded-lg px-4">
            {g.rows.map((r) => {
              const busy = busyId === r.transaction_id;
              return (
                <li key={`${r.reason}-${r.transaction_id}-${r.planned_match_id || r.detail || ""}`} className="py-3">
                  {r.reason === "planned_match" ? <PlannedMatchCard row={r} onOpen={onOpen} onOpenItem={onOpenItem} /> : (
                  <button type="button" onClick={() => onOpen(r.transaction_id)}
                    className="w-full text-left flex items-start justify-between gap-3 min-h-[44px]">
                    <span className="min-w-0">
                      <span className="block break-words">{r.clean_description || r.payee || "—"}</span>
                      <span className="block text-xs text-muted-foreground break-words">
                        {formatDay(r.txn_date)} · {r.account_label}{r.merchant_name ? ` · ${r.merchant_name}` : ""}
                        {r.detail && r.reason === "missing_required_tag" ? ` · needs ${r.detail}` : ""}
                        {r.detail && (r.reason === "price_change" || r.reason === "new_recurring") ? ` · ${r.detail}` : ""}
                      </span>
                    </span>
                    <span className="tabular-nums shrink-0">{formatMoney(r.amount)}</span>
                  </button>
                  )}
                  <div className="flex flex-wrap gap-2 mt-2">
                    {r.reason === "no_kind" && (
                      <button type="button" disabled={busy} onClick={() => act(r.transaction_id, () => reprocess([r.transaction_id]))} className={SMALL}>
                        Process now
                      </button>
                    )}
                    {r.reason === "missing_required_tag" && r.detail === "Category" && (
                      <select aria-label="Choose a category" disabled={busy} value=""
                        onChange={(e) => e.target.value && pickCategory(r, e.target.value)}
                        className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm max-w-full">
                        <option value="">Choose a category…</option>
                        {categoryOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                    )}
                    {r.reason === "transfer_candidate" && (
                      <>
                        <button type="button" disabled={busy}
                          onClick={() => act(r.transaction_id, () => setKind({ id: r.transaction_id, transfer_pair_id: null }, "spend"))}
                          className={SMALL}>
                          Not a transfer
                        </button>
                        <button type="button" onClick={() => onOpen(r.transaction_id)} className={SMALL}>Find the other side</button>
                      </>
                    )}
                    {r.reason === "planned_match" && r.planned_match_id && (
                      <PlannedMatchActions row={r} busy={busy} act={act} />
                    )}
                    {r.reason === "split_mismatch" && (
                      <button type="button" onClick={() => onOpen(r.transaction_id)} className={SMALL}>Fix the parts</button>
                    )}
                    {r.reason === "price_change" && r.subscription_id && (
                      <button type="button" disabled={busy}
                        onClick={() => act(r.transaction_id, () => recordSubscriptionPrice(r.subscription_id, r))}
                        className={SMALL}>
                        Record new price
                      </button>
                    )}
                    {r.reason === "new_recurring" && r.subscription_id && (
                      <>
                        <button type="button" disabled={busy}
                          onClick={() => act(r.transaction_id, () => dismissSubscription(r.subscription_id))}
                          className={SMALL}>
                          Not a subscription
                        </button>
                        <button type="button" disabled={busy}
                          onClick={() => act(r.transaction_id, () => setReviewed([r.transaction_id], true))}
                          className={SMALL}>
                          Keep watching
                        </button>
                      </>
                    )}
                    {!["no_kind", "split_mismatch", "new_recurring", "planned_match"].includes(r.reason) && (
                      <button type="button" disabled={busy} onClick={() => act(r.transaction_id, () => setReviewed([r.transaction_id], true))} className={SMALL}>
                        Mark reviewed
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {sheet && (
        <AlwaysDoThisSheet
          txn={sheet.txn}
          tags={[{ id: sheet.tagId, name: sheet.tagName, picked: true }]}
          onClose={() => setSheet(null)}
          onDone={() => { setSheet(null); reload(); }}
        />
      )}
    </div>
  );
}
