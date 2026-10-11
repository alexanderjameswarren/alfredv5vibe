import React, { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { replaceSplits } from "./moneyApi";
import { formatMoney, parseAmountInput, splitRemainder, toNumber } from "./moneyFormat";

const FIELD = "min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm";

/**
 * Edit a transaction's parts. Amounts are signed like the transaction and must
 * add up to it; each part can carry one Category. Saving replaces the splits in
 * one step (wb_replace_splits), so a half-saved split cannot happen.
 *
 * categoryOptions: [{id, label}] from the Category group; categoryGroupId tells
 * which of a part's existing tags is its Category.
 */
export default function SplitEditor({ txn, categoryOptions, categoryGroupId, tagsById, onSaved, onCancel }) {
  const start = txn.splits.length > 1
    ? txn.splits.map((s) => ({
      amount: String(toNumber(s.amount)),
      description: s.description || "",
      categoryId: (s.tags || []).map((t) => t.tag_id).find((id) => tagsById.get(id)?.group_id === categoryGroupId) || "",
    }))
    : [{ amount: String(toNumber(txn.amount)), description: "", categoryId: "" }, { amount: "", description: "", categoryId: "" }];
  const [parts, setParts] = useState(start);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const parsed = parts.map((p) => ({ ...p, value: parseAmountInput(p.amount) }));
  const left = splitRemainder(txn.amount, parsed.map((p) => ({ amount: p.value ?? 0 })));
  const valid = parsed.every((p) => p.value !== null) && left === 0;

  const set = (i, k) => (e) => setParts(parts.map((p, j) => (j === i ? { ...p, [k]: e.target.value } : p)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await replaceSplits(txn.id, parsed.map((p) => ({
        amount: p.value,
        description: p.description.trim() || null,
        tag_ids: p.categoryId ? [p.categoryId] : [],
      })));
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Parts must add up to {formatMoney(txn.amount)}. Use the same sign as the transaction.
        Saving replaces the tags on the parts with the categories chosen here.
      </p>
      {parts.map((p, i) => (
        <div key={i} className="grid grid-cols-1 sm:grid-cols-[8rem_1fr_1fr_auto] gap-2 items-center border-b border-border pb-3">
          <input aria-label={`Part ${i + 1} amount`} inputMode="decimal" value={p.amount} onChange={set(i, "amount")}
            className={`${FIELD} tabular-nums`} />
          <input aria-label={`Part ${i + 1} description`} placeholder="What it was for" value={p.description}
            onChange={set(i, "description")} className={FIELD} />
          <select aria-label={`Part ${i + 1} category`} value={p.categoryId} onChange={set(i, "categoryId")} className={FIELD}>
            <option value="">No category</option>
            {categoryOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <button type="button" onClick={() => setParts(parts.filter((_, j) => j !== i))} disabled={parts.length <= 1}
            aria-label={`Remove part ${i + 1}`}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-muted-foreground disabled:opacity-30">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => setParts([...parts, { amount: left ? String(left) : "", description: "", categoryId: "" }])}
          className="inline-flex items-center gap-1.5 min-h-[44px] px-3 text-sm text-primary">
          <Plus className="w-4 h-4" aria-hidden="true" /> Add a part
        </button>
        <span className={`text-sm tabular-nums ${left === 0 ? "text-muted-foreground" : "text-destructive"}`}>
          {left === 0 ? "Adds up" : `${formatMoney(left)} left to place`}
        </span>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-3">
        <button type="button" onClick={save} disabled={busy || !valid}
          className="min-h-[44px] px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm disabled:opacity-50">
          Save parts
        </button>
        <button type="button" onClick={onCancel} className="min-h-[44px] px-4 py-2 rounded-lg border border-border text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
