import React, { useState } from "react";
import { getSubscriptionChoices, updateSubscription } from "./moneyApi";
import { useLoad } from "./useMoneyData";
import { BILLING_CHOICES, OWNER_LABELS, billingChoice, billingFields, parseAmountInput } from "./moneyFormat";

const FIELD = "w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm";
const LABEL = "block text-sm font-medium mb-1";

const text = (v) => (v === null || v === undefined ? "" : String(v));
const orNull = (s) => (s.trim() === "" ? null : s.trim());

/** Edit a subscription's own fields; only changed fields are saved. Status has its own buttons. */
export default function SubscriptionForm({ sub, onCancel, onSaved }) {
  const choices = useLoad(() => getSubscriptionChoices(), []);
  const start = billingChoice(sub);
  const [f, setF] = useState({
    name: text(sub.name), plan: text(sub.plan), merchant_id: text(sub.merchant_id),
    billing: start.choice, count: start.count,
    expected_amount: text(sub.expected_amount), amount_tolerance: text(sub.amount_tolerance),
    term_end_date: text(sub.term_end_date), auto_renew: sub.auto_renew === null || sub.auto_renew === undefined ? "" : String(sub.auto_renew),
    review_date: text(sub.review_date), owner: text(sub.owner),
    bundle_id: text(sub.bundle_id), billed_through_id: text(sub.billed_through_id), notes: text(sub.notes),
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function patchFromForm() {
    if (!f.name.trim()) throw new Error("A subscription needs a name.");
    const billing = billingFields(f.billing, f.count);
    if (!billing) throw new Error("The number of weeks or months must be a whole number from 1 to 104.");
    const expected = f.expected_amount.trim() === "" ? null : parseAmountInput(f.expected_amount);
    if (expected !== null && !(expected > 0)) throw new Error("The expected price must be more than zero.");
    if (f.expected_amount.trim() !== "" && expected === null) throw new Error("The expected price is not a number.");
    const tolerance = f.amount_tolerance.trim() === "" ? 0 : parseAmountInput(f.amount_tolerance);
    if (tolerance === null || tolerance < 0) throw new Error("The tolerance must be zero or more.");
    const next = {
      name: f.name.trim(), plan: orNull(f.plan), merchant_id: orNull(f.merchant_id), ...billing,
      expected_amount: expected, amount_tolerance: tolerance,
      term_end_date: orNull(f.term_end_date), auto_renew: f.auto_renew === "" ? null : f.auto_renew === "true",
      review_date: orNull(f.review_date), owner: orNull(f.owner),
      bundle_id: orNull(f.bundle_id), billed_through_id: orNull(f.billed_through_id), notes: orNull(f.notes),
    };
    const was = {
      ...sub, expected_amount: sub.expected_amount === null ? null : Number(sub.expected_amount),
      amount_tolerance: Number(sub.amount_tolerance ?? 0),
    };
    return Object.fromEntries(Object.entries(next).filter(([k, v]) => (was[k] ?? null) !== v));
  }

  async function save(e) {
    e.preventDefault();
    setError(null);
    let patch;
    try { patch = patchFromForm(); } catch (err) { setError(err.message); return; }
    if (Object.keys(patch).length === 0) { onCancel(); return; }
    setSaving(true);
    try {
      await updateSubscription(sub, patch);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const others = (choices.data?.subscriptions || []).filter((s) => s.id !== sub.id);
  return (
    <form onSubmit={save} className="bg-card border border-border rounded-lg p-4 space-y-3" aria-label="Edit subscription">
      <div><label className={LABEL} htmlFor="sub-name">Name</label><input id="sub-name" className={FIELD} value={f.name} onChange={set("name")} /></div>
      <div><label className={LABEL} htmlFor="sub-plan">Plan</label><input id="sub-plan" className={FIELD} value={f.plan} onChange={set("plan")} /></div>
      <div>
        <label className={LABEL} htmlFor="sub-merchant">Merchant</label>
        <select id="sub-merchant" className={FIELD} value={f.merchant_id} onChange={set("merchant_id")}>
          <option value="">None</option>
          {(choices.data?.merchants || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[12rem]">
          <label className={LABEL} htmlFor="sub-billing">Billing</label>
          <select id="sub-billing" className={FIELD} value={f.billing} onChange={set("billing")}>
            {BILLING_CHOICES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </div>
        {(f.billing === "weeks" || f.billing === "months") && (
          <div className="w-28">
            <label className={LABEL} htmlFor="sub-count">N</label>
            <input id="sub-count" inputMode="numeric" className={FIELD} value={f.count} onChange={set("count")} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[10rem]">
          <label className={LABEL} htmlFor="sub-expected">Expected price</label>
          <input id="sub-expected" inputMode="decimal" className={FIELD} value={f.expected_amount} onChange={set("expected_amount")} />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className={LABEL} htmlFor="sub-tolerance">Tolerance (dollars)</label>
          <input id="sub-tolerance" inputMode="decimal" className={FIELD} value={f.amount_tolerance} onChange={set("amount_tolerance")} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[10rem]">
          <label className={LABEL} htmlFor="sub-term">Prepaid until</label>
          <input id="sub-term" type="date" className={FIELD} value={f.term_end_date} onChange={set("term_end_date")} />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className={LABEL} htmlFor="sub-renew">Auto-renews</label>
          <select id="sub-renew" className={FIELD} value={f.auto_renew} onChange={set("auto_renew")}>
            <option value="">Not known</option><option value="true">Yes</option><option value="false">No</option>
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[10rem]">
          <label className={LABEL} htmlFor="sub-review">Review date</label>
          <input id="sub-review" type="date" className={FIELD} value={f.review_date} onChange={set("review_date")} />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className={LABEL} htmlFor="sub-owner">Owner</label>
          <select id="sub-owner" className={FIELD} value={f.owner} onChange={set("owner")}>
            <option value="">Unassigned</option>
            {Object.entries(OWNER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={LABEL} htmlFor="sub-bundle">Part of bundle</label>
        <select id="sub-bundle" className={FIELD} value={f.bundle_id} onChange={set("bundle_id")}>
          <option value="">None</option>
          {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <label className={LABEL} htmlFor="sub-billed">Billed through</label>
        <select id="sub-billed" className={FIELD} value={f.billed_through_id} onChange={set("billed_through_id")}>
          <option value="">None</option>
          {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <label className={LABEL} htmlFor="sub-notes">Notes</label>
        <textarea id="sub-notes" rows={3} className={`${FIELD} py-2`} value={f.notes} onChange={set("notes")} />
      </div>
      {choices.error && <p role="alert" className="text-sm text-destructive">{choices.error.message}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving} className="min-h-[44px] px-4 rounded-lg bg-primary text-primary-foreground text-sm">
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="min-h-[44px] px-4 rounded-lg border border-border text-sm">Cancel</button>
      </div>
    </form>
  );
}
