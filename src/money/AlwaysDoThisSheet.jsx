import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { applyFix, getFixPlan } from "./moneyApi";
import { KIND_LABELS } from "./moneyFormat";
import { HelpTitle } from "./HelpButton";

const BUTTON = "min-h-[44px] px-4 py-2 rounded-lg text-sm";

/**
 * "Always do this for <merchant>" (spec §6.1). Shows the merchant and its short
 * pattern (editable when the merchant is new or gains a pattern), how many past
 * transactions the rule would catch (warning at 1 or fewer), and, when the
 * merchant already has a rule, updates it by default instead of adding another.
 * All of it runs in the database (wb_fix_plan, wb_apply_fix), the same code the
 * MCP tool uses.
 *
 * kind:  the transaction's kind, offered as "set kind" (ticked when just changed)
 * tags:  [{id, name, picked}] the transaction's tags, ticked when just changed
 */
export default function AlwaysDoThisSheet({ txn, kind, kindPicked = false, tags = [], onClose, onDone }) {
  const [pattern, setPattern] = useState("");
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(true);
  const [useKind, setUseKind] = useState(kindPicked);
  const [picked, setPicked] = useState(() => new Set(tags.filter((t) => t.picked).map((t) => t.id)));
  const [mode, setMode] = useState("update");
  const [done, setDone] = useState(null);

  async function load(withPattern) {
    setBusy(true);
    setError(null);
    try {
      const p = await getFixPlan(txn.id, { pattern: withPattern || null });
      setPlan(p);
      if (!withPattern) setPattern(p.pattern || "");
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  useEffect(() => { load(null); }, [txn.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const existing = plan?.existing_rules || [];
  const merchant = plan?.merchant;
  const editablePattern = merchant && (!merchant.exists || merchant.add_pattern || plan.pattern);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await applyFix({
        transactionId: txn.id,
        setKind: useKind ? kind : null,
        tagIds: [...picked],
        pattern: plan.pattern ? pattern : null,
        updateRuleId: existing.length && mode === "update" ? existing[0].id : null,
        addNewRule: existing.length > 0 && mode === "add",
      });
      setDone(res);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  const toggle = (id) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/50" role="dialog"
      aria-modal="true" aria-label="Always do this">
      <div className="bg-background border border-border rounded-t-lg sm:rounded-lg shadow-xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="text-lg font-medium">
            <HelpTitle helpKey="always_do_this" text={`Always do this${merchant?.name ? ` for ${merchant.name}` : ""}`} />
          </h3>
          <button type="button" onClick={onClose} aria-label="Close"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {done ? (
          <div className="space-y-4">
            <p className="text-sm">
              Saved. {done.rule_updated ? "The rule was updated" : "A new rule was made"}
              {done.merchant_created ? ", with a new merchant" : ""}. It now matches {done.matched_now} transaction
              {done.matched_now === 1 ? "" : "s"}.
            </p>
            <button type="button" onClick={() => onDone(done)} className={`${BUTTON} bg-primary hover:bg-primary-hover text-white w-full`}>
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {busy && !plan && <p className="text-sm text-muted-foreground">Working out the rule…</p>}
            {plan && (
              <>
                <div className="text-sm space-y-1">
                  <p>
                    Merchant: <span className="font-medium">{merchant.name}</span>
                    {!merchant.exists && <span className="text-muted-foreground"> (new)</span>}
                  </p>
                  <p className="text-muted-foreground">The rule matches the merchant, not this exact description.</p>
                </div>

                {editablePattern && (
                  <div>
                    <label htmlFor="fix-pattern" className="block text-sm mb-1">
                      Matches bank text containing
                    </label>
                    <div className="flex gap-2">
                      <input id="fix-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)}
                        className="flex-1 min-w-0 min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" />
                      <button type="button" onClick={() => load(pattern)} disabled={busy}
                        className={`${BUTTON} border border-border disabled:opacity-50`}>
                        Check
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-sm">
                  Catches <span className="font-medium">{plan.dry_run.count}</span> past transaction
                  {plan.dry_run.count === 1 ? "" : "s"}.
                </p>
                {plan.dry_run.too_narrow && (
                  <p role="alert" className="text-sm text-amber-900 bg-amber-100 rounded-lg p-2">
                    That's probably too narrow to be useful. Try a shorter pattern.
                  </p>
                )}

                <fieldset className="space-y-1">
                  <legend className="text-sm mb-1">The rule will</legend>
                  {kind && (
                    <label className="flex items-center gap-2 min-h-[44px] text-sm">
                      <input type="checkbox" checked={useKind} onChange={(e) => setUseKind(e.target.checked)} className="w-5 h-5" />
                      Set kind to {KIND_LABELS[kind] || kind}
                    </label>
                  )}
                  {tags.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 min-h-[44px] text-sm">
                      <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} className="w-5 h-5" />
                      Tag {t.name}
                    </label>
                  ))}
                </fieldset>

                {existing.length > 0 && (
                  <fieldset className="space-y-1">
                    <legend className="text-sm mb-1">This merchant already has a rule</legend>
                    <label className="flex items-center gap-2 min-h-[44px] text-sm">
                      <input type="radio" name="fix-mode" checked={mode === "update"} onChange={() => setMode("update")} className="w-5 h-5" />
                      Update it ({existing[0].name}, {existing[0].hit_count} matches)
                    </label>
                    <label className="flex items-center gap-2 min-h-[44px] text-sm">
                      <input type="radio" name="fix-mode" checked={mode === "add"} onChange={() => setMode("add")} className="w-5 h-5" />
                      Add another rule
                    </label>
                  </fieldset>
                )}
              </>
            )}

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-3">
              <button type="button" onClick={save} disabled={busy || !plan || (!useKind && picked.size === 0)}
                className={`${BUTTON} flex-1 bg-primary hover:bg-primary-hover text-white disabled:opacity-50`}>
                Save rule
              </button>
              <button type="button" onClick={onClose} className={`${BUTTON} border border-border`}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
