import React, { useState } from "react";
import { ArrowLeft } from "lucide-react";
import SubscriptionForm from "./SubscriptionForm";
import { SubscriptionBadges } from "./SubscriptionsScreen";
import {
  dismissSubscription, findLinkCandidates, getSubscriptionDetail, linkCharges, recordPrice, setSubscriptionStatus,
} from "./moneyApi";
import { useLoad } from "./useMoneyData";
import {
  OWNER_LABELS, SUB_STATUS_LABELS, formatDay, formatMoney, intervalLabel, monthlyEquivalent, pacificToday, parseAmountInput,
} from "./moneyFormat";

const SECTION = "bg-card border border-border rounded-lg p-4";
const FIELD = "w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm";
const SMALL = "min-h-[44px] px-3 rounded-lg border border-border text-sm";
const LINK = "min-h-[44px] text-sm text-primary text-left";

function Fact({ label, children }) {
  return (
    <div className="py-1.5 flex flex-wrap justify-between gap-x-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm text-right break-words">{children}</dd>
    </div>
  );
}

function PriceForm({ sub, onDone }) {
  const [amount, setAmount] = useState("");
  const [on, setOn] = useState(pacificToday());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setError(null);
    const n = parseAmountInput(amount);
    if (n === null) { setError("Type the new price, e.g. 12.99."); return; }
    setBusy(true);
    try { await recordPrice(sub.id, Math.abs(n), on); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2 mt-3" aria-label="Record price">
      <div className="flex-1 min-w-[8rem]">
        <label className="block text-sm mb-1" htmlFor="price-amount">New price</label>
        <input id="price-amount" inputMode="decimal" className={FIELD} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="flex-1 min-w-[10rem]">
        <label className="block text-sm mb-1" htmlFor="price-on">From</label>
        <input id="price-on" type="date" className={FIELD} value={on} onChange={(e) => setOn(e.target.value)} />
      </div>
      <button type="submit" disabled={busy} className={SMALL}>Save price</button>
      {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}

function LinkPicker({ sub, onDone }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const found = useLoad(() => findLinkCandidates(sub, query), [sub.id, query]);
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState(null);
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  async function link() {
    setError(null);
    try { await linkCharges(picked, sub.id); onDone(); } catch (err) { setError(err.message); }
  }
  return (
    <div className="mt-3 space-y-2">
      <form onSubmit={(e) => { e.preventDefault(); setQuery(text); }} className="flex gap-2">
        <input aria-label="Search charges" placeholder={sub.merchant_id ? "Search other merchants too…" : "Search charges…"}
          className={FIELD} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className={SMALL}>Search</button>
      </form>
      {found.loading && <p className="text-sm text-muted-foreground">Looking…</p>}
      {found.error && <p role="alert" className="text-sm text-destructive">{found.error.message}</p>}
      {found.data && found.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {!sub.merchant_id && !query ? "This subscription has no merchant: search for the charges." : "No unlinked charges in the last 180 days."}
        </p>
      )}
      <ul className="divide-y divide-border">
        {(found.data || []).map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-3 py-2 min-h-[44px]">
              <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} className="w-5 h-5" />
              <span className="min-w-0 flex-1 text-sm">
                <span className="block break-words">{c.clean_description || c.payee || "—"}</span>
                <span className="block text-xs text-muted-foreground">{formatDay(c.txn_date)} · {c.account_label}</span>
              </span>
              <span className="tabular-nums text-sm">{formatMoney(c.amount)}</span>
            </label>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button type="button" disabled={!picked.length} onClick={link} className={SMALL}>
        Link {picked.length || ""} {picked.length === 1 ? "charge" : "charges"}
      </button>
    </div>
  );
}

/**
 * One subscription (spec §7.5): its facts, price history and linked charges,
 * with edit, status changes, record price, and link or unlink charges by hand.
 */
export default function SubscriptionDetailView({ subscriptionId, onBack, onOpenSubscription, onOpenTransaction }) {
  const { data, error, loading, reload } = useLoad(() => getSubscriptionDetail(subscriptionId), [subscriptionId]);
  const [mode, setMode] = useState(null); // "edit" | "price" | "link" | "dismiss"
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const header = (
    <button type="button" onClick={onBack} className="min-h-[44px] inline-flex items-center gap-1.5 text-sm text-primary mb-3">
      <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Subscriptions
    </button>
  );
  if (loading && !data) return <>{header}<p className="text-sm text-muted-foreground">Loading…</p></>;
  if (error) return <>{header}<p className="text-sm text-destructive">{error.message}</p></>;
  if (!data) return <>{header}<p className="text-sm text-muted-foreground">No such subscription.</p></>;

  const { sub, prices, charges } = data;
  const today = pacificToday();
  const monthly = monthlyEquivalent(sub);
  const done = () => { setMode(null); reload(); };

  async function act(fn, after = reload) {
    setBusy(true);
    setActionError(null);
    try { await fn(); after(); } catch (err) { setActionError(err.message); }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      {header}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-lg font-medium break-words">{sub.name}</h3>
          <p className="text-sm text-muted-foreground">{SUB_STATUS_LABELS[sub.status]}{sub.plan ? ` · ${sub.plan}` : ""}</p>
          <p className="flex flex-wrap gap-1 mt-1"><SubscriptionBadges sub={sub} today={today} /></p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sub.status === "watching" && (
            <>
              <button type="button" disabled={busy} className={SMALL} onClick={() => act(() => setSubscriptionStatus(sub.id, "active"))}>Confirm</button>
              <button type="button" disabled={busy} className={SMALL} onClick={() => setMode("dismiss")}>Not a subscription</button>
            </>
          )}
          {sub.status === "active" && (
            <>
              <button type="button" disabled={busy} className={SMALL} onClick={() => act(() => setSubscriptionStatus(sub.id, "paused"))}>Pause</button>
              <button type="button" disabled={busy} className={SMALL} onClick={() => act(() => setSubscriptionStatus(sub.id, "cancelled"))}>Cancel subscription</button>
            </>
          )}
          {(sub.status === "paused" || sub.status === "cancelled") && (
            <button type="button" disabled={busy} className={SMALL} onClick={() => act(() => setSubscriptionStatus(sub.id, "active"))}>Reactivate</button>
          )}
          <button type="button" className={SMALL} onClick={() => setMode(mode === "edit" ? null : "edit")}>Edit</button>
        </div>
      </div>

      {mode === "dismiss" && (
        <div role="alertdialog" aria-label="Dismiss" className={`${SECTION} space-y-2`}>
          <p className="text-sm">Not a subscription? Its charges are unlinked, this row is deleted, and the merchant is never detected again.</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} className={SMALL} onClick={() => act(() => dismissSubscription(sub.id), onBack)}>Yes, dismiss</button>
            <button type="button" className={SMALL} onClick={() => setMode(null)}>Keep it</button>
          </div>
        </div>
      )}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

      {mode === "edit" ? (
        <SubscriptionForm sub={sub} onCancel={() => setMode(null)} onSaved={done} />
      ) : (
        <section className={SECTION}>
          <dl className="divide-y divide-border">
            <Fact label="Price">{formatMoney(sub.current_price)}{monthly !== null && sub.interval_count !== 1 ? ` (${formatMoney(monthly)} a month)` : ""}</Fact>
            <Fact label="Billing">{intervalLabel(sub)}</Fact>
            <Fact label="Last charged">{formatDay(sub.last_charged_on)}</Fact>
            <Fact label="Next expected">
              {formatDay(sub.next_expected_on)}{sub.overdue ? ` · overdue ${sub.days_past_expected} days` : ""}
            </Fact>
            {sub.term_end_date && <Fact label="Prepaid until">{formatDay(sub.term_end_date)}</Fact>}
            <Fact label="Auto-renews">{sub.auto_renew === true ? "Yes" : sub.auto_renew === false ? "No" : "Not known"}</Fact>
            <Fact label="Review date">{formatDay(sub.review_date)}</Fact>
            <Fact label="Merchant">{sub.merchant_name || "None"}</Fact>
            <Fact label="Owner">{OWNER_LABELS[sub.owner] || "Unassigned"}</Fact>
            {Number(sub.amount_tolerance) > 0 && <Fact label="Tolerance">± {formatMoney(sub.amount_tolerance)}</Fact>}
            {sub.bundle_id && (
              <Fact label="Part of"><button type="button" className={LINK} onClick={() => onOpenSubscription(sub.bundle_id)}>{sub.bundle_name}</button></Fact>
            )}
            {sub.billed_through_id && (
              <Fact label="Billed through"><button type="button" className={LINK} onClick={() => onOpenSubscription(sub.billed_through_id)}>{sub.billed_through_name}</button></Fact>
            )}
          </dl>
          {sub.notes && <p className="text-sm mt-3 whitespace-pre-wrap break-words">{sub.notes}</p>}
        </section>
      )}

      <section className={SECTION}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">Price history</h4>
          <button type="button" className={SMALL} onClick={() => setMode(mode === "price" ? null : "price")}>Record price</button>
        </div>
        {mode === "price" && <PriceForm sub={sub} onDone={done} />}
        {prices.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-2">No prices recorded; the expected price is used.</p>
        ) : (
          <ul className="divide-y divide-border mt-2">
            {prices.map((p) => (
              <li key={p.id} className="py-2 flex justify-between gap-3 text-sm">
                <span>From {formatDay(p.effective_on)} <span className="text-muted-foreground">· {p.source}</span></span>
                <span className="tabular-nums">{formatMoney(p.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">Linked charges <span className="text-muted-foreground font-normal">({charges.length})</span></h4>
          <button type="button" className={SMALL} onClick={() => setMode(mode === "link" ? null : "link")}>Link charges</button>
        </div>
        {mode === "link" && <LinkPicker sub={sub} onDone={done} />}
        {charges.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-2">No charges linked.</p>
        ) : (
          <ul className="divide-y divide-border mt-2">
            {charges.map((c) => (
              <li key={c.id} className="py-2 flex items-center justify-between gap-3">
                <button type="button" onClick={() => onOpenTransaction(c.id)} className="min-w-0 text-left text-sm min-h-[44px]">
                  <span className="block break-words">{c.clean_description || c.payee || "—"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDay(c.txn_date)} · {c.account_label}{c.subscription_source === "manual" ? " · linked by hand" : ""}
                  </span>
                </button>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="tabular-nums text-sm">{formatMoney(c.amount)}</span>
                  <button type="button" disabled={busy} className={SMALL} aria-label={`Unlink ${formatDay(c.txn_date)}`}
                    onClick={() => act(() => linkCharges([c.id], null))}>
                    Unlink
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
