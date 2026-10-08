import React, { useState } from "react";
import { ArrowLeft } from "lucide-react";
import EditCard from "../shared/EditCard";
import AccountFields, { fromForm, toForm } from "./AccountFields";
import { createManualAccount } from "./moneyApi";

const INPUT = "w-full px-3 py-2 border border-border rounded text-base";
const LABEL = "block text-sm font-medium text-foreground mb-1";

/** Add an account SimpleFIN does not sync: a 401(k), a rewards balance, a history line. */
export default function ManualAccountForm({ onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [form, setForm] = useState(toForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const fields = fromForm(form);
      const account = await createManualAccount({ ...fields, name, institution: institution.trim() || null });
      onCreated(account.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button type="button" onClick={onCancel} title="Back to Accounts"
          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground rounded">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h3 className="text-lg font-medium">Add manual account</h3>
      </div>
      <EditCard>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label htmlFor="wb-new-name" className={LABEL}>Name</label>
              <input id="wb-new-name" value={name} onChange={(e) => setName(e.target.value)} required className={INPUT} />
            </div>
            <div className="flex-1">
              <label htmlFor="wb-new-institution" className={LABEL}>Institution</label>
              <input id="wb-new-institution" value={institution} onChange={(e) => setInstitution(e.target.value)} className={INPUT} />
            </div>
          </div>
          <AccountFields form={form} setForm={setForm} idPrefix="wb-new" />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors disabled:opacity-50">
              Create account
            </button>
            <button type="button" onClick={onCancel}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-border text-sm text-foreground">
              Cancel
            </button>
          </div>
        </form>
      </EditCard>
    </div>
  );
}
