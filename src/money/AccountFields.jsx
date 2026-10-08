import React from "react";
import { OWNER_LABELS, ROLE_LABELS, ROLE_ORDER, parseAmountInput } from "./moneyFormat";

const INPUT = "w-full px-3 py-2 border border-border rounded text-base";
const LABEL = "block text-sm font-medium text-foreground mb-1";

/** An account's human columns as form strings. */
export function toForm(account = {}) {
  const s = (v) => (v === null || v === undefined ? "" : String(v));
  return {
    display_name: s(account.display_name),
    owner: s(account.owner),
    role: account.role || "unassigned",
    credit_limit: s(account.credit_limit),
    reward_unit: s(account.reward_unit),
    reward_value_per_unit: s(account.reward_value_per_unit),
    expires_on: s(account.expires_on),
    active_from: s(account.active_from),
    active_until: s(account.active_until),
    is_hidden: Boolean(account.is_hidden),
    notes: s(account.notes),
  };
}

/** Form strings back to column values. Throws with a readable message on a bad number. */
export function fromForm(form) {
  const text = (v) => (v.trim() === "" ? null : v.trim());
  const limit = form.credit_limit.trim() === "" ? null : parseAmountInput(form.credit_limit);
  if (form.credit_limit.trim() !== "" && limit === null) throw new Error("Credit limit must be an amount.");
  const rateText = form.reward_value_per_unit.trim();
  const rate = rateText === "" ? null : Number(rateText);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
    throw new Error("Value per unit must be a non-negative number of dollars.");
  }
  if (form.active_from && form.active_until && form.active_from > form.active_until) {
    throw new Error("Active from is after active until.");
  }
  return {
    display_name: text(form.display_name),
    owner: form.owner || null,
    role: form.role,
    credit_limit: limit,
    reward_unit: text(form.reward_unit),
    reward_value_per_unit: rate,
    expires_on: form.expires_on || null,
    active_from: form.active_from || null,
    active_until: form.active_until || null,
    is_hidden: form.is_hidden,
    notes: text(form.notes),
  };
}

function Field({ id, label, children }) {
  return (
    <div className="flex-1">
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
    </div>
  );
}

/** The editable fields, shared by the edit card and the add-account form. */
export default function AccountFields({ form, setForm, idPrefix = "wb" }) {
  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const id = (k) => `${idPrefix}-${k}`;
  const role = form.role;

  return (
    <div className="space-y-3">
      <Field id={id("display_name")} label="Display name">
        <input id={id("display_name")} value={form.display_name} onChange={set("display_name")} className={INPUT} />
      </Field>
      <div className="flex flex-col sm:flex-row gap-3">
        <Field id={id("role")} label="Role">
          <select id={id("role")} value={form.role} onChange={set("role")} className={INPUT}>
            <option value="unassigned">{ROLE_LABELS.unassigned} (not in net worth)</option>
            {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </Field>
        <Field id={id("owner")} label="Owner">
          <select id={id("owner")} value={form.owner} onChange={set("owner")} className={INPUT}>
            <option value="">Not set</option>
            {Object.entries(OWNER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>
      {(role === "credit_card" || role === "emergency_credit" || form.credit_limit) && (
        <Field id={id("credit_limit")} label="Credit limit ($)">
          <input id={id("credit_limit")} inputMode="decimal" value={form.credit_limit}
            onChange={set("credit_limit")} className={INPUT} />
        </Field>
      )}
      {(role === "rewards" || form.reward_unit) && (
        <div className="flex flex-col sm:flex-row gap-3">
          <Field id={id("reward_unit")} label="Unit (points, miles)">
            <input id={id("reward_unit")} value={form.reward_unit} onChange={set("reward_unit")} className={INPUT} />
          </Field>
          <Field id={id("reward_value_per_unit")} label="Dollars per unit (blank = not counted)">
            <input id={id("reward_value_per_unit")} inputMode="decimal" value={form.reward_value_per_unit}
              onChange={set("reward_value_per_unit")} className={INPUT} />
          </Field>
        </div>
      )}
      <Field id={id("expires_on")} label="Expires / matures on">
        <input id={id("expires_on")} type="date" value={form.expires_on} onChange={set("expires_on")} className={INPUT} />
      </Field>
      {(role === "history_rollup" || form.active_from || form.active_until) && (
        <div className="flex flex-col sm:flex-row gap-3">
          <Field id={id("active_from")} label="Counts from">
            <input id={id("active_from")} type="date" value={form.active_from} onChange={set("active_from")} className={INPUT} />
          </Field>
          <Field id={id("active_until")} label="Counts until (required to count)">
            <input id={id("active_until")} type="date" value={form.active_until} onChange={set("active_until")} className={INPUT} />
          </Field>
        </div>
      )}
      <Field id={id("notes")} label="Notes">
        <textarea id={id("notes")} rows={3} value={form.notes} onChange={set("notes")} className={INPUT} />
      </Field>
      <label className="flex items-center gap-2 min-h-[44px] text-sm text-foreground">
        <input type="checkbox" checked={form.is_hidden} onChange={set("is_hidden")} />
        Hide this account (display only; totals are unchanged)
      </label>
    </div>
  );
}
