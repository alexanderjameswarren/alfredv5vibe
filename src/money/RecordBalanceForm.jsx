import React, { useState } from "react";
import { recordBalance } from "./moneyApi";
import { pacificToday, parseAmountInput } from "./moneyFormat";

const INPUT = "w-full px-3 py-2 border border-border rounded text-base";
const LABEL = "block text-sm font-medium text-foreground mb-1";

/** Record one balance on a manual account. Rewards accounts take a count of points or miles. */
export default function RecordBalanceForm({ account, onRecorded }) {
  const [asOf, setAsOf] = useState(pacificToday());
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("manual");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const rewards = account.role === "rewards";

  async function submit(e) {
    e.preventDefault();
    const balance = parseAmountInput(amount);
    if (balance === null) {
      setMessage({ error: true, text: rewards ? "Enter a number." : "Enter an amount, e.g. 1250.00 or -300." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const { replaced } = await recordBalance(account, { asOf, balance, source, notes: notes.trim() || null });
      setMessage({ error: false, text: replaced ? `Replaced the ${replaced} balance for that date.` : "Recorded." });
      setAmount("");
      setNotes("");
      onRecorded?.();
    } catch (err) {
      setMessage({ error: true, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <label htmlFor="wb-as-of" className={LABEL}>Date</label>
          <input id="wb-as-of" type="date" value={asOf} max={pacificToday()}
            onChange={(e) => setAsOf(e.target.value)} className={INPUT} />
        </div>
        <div className="flex-1">
          <label htmlFor="wb-amount" className={LABEL}>
            {rewards ? `Balance (${account.reward_unit || "units"})` : "Balance ($, debts negative)"}
          </label>
          <input id="wb-amount" inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value)} className={INPUT} />
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="sm:w-40">
          <label htmlFor="wb-source" className={LABEL}>Source</label>
          <select id="wb-source" value={source} onChange={(e) => setSource(e.target.value)} className={INPUT}>
            <option value="manual">Manual</option>
            <option value="import">Import</option>
          </select>
        </div>
        <div className="flex-1">
          <label htmlFor="wb-balance-notes" className={LABEL}>Notes</label>
          <input id="wb-balance-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className={INPUT} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy}
          className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors disabled:opacity-50">
          Record balance
        </button>
        {message && (
          <p role="status" className={`text-sm ${message.error ? "text-destructive" : "text-muted-foreground"}`}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
