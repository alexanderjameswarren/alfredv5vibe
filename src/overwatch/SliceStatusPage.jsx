import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import EditCard from "../shared/EditCard";
import PinnedFooter from "../shared/PinnedFooter";
import { overwatchPlanPath } from "../viewPaths";
import useLoad from "./useLoad";
import { getSlice, updateSliceStatus } from "./overwatchApi";
import { STATUS_WORDS, sliceTitle } from "./portfolioModel";

// A slice's status, on its own page (Step 56): what update_portfolio_slice does, for the active version only.
// The database guard has the last word; its refusals come back in plain words.

const STATUSES = ["planned", "in_progress", "done", "paused"];

export default function SliceStatusPage({ portfolioId, sliceId }) {
  const navigate = useNavigate();
  const { loading, error, data: slice } = useLoad(() => getSlice(sliceId), sliceId);
  const [status, setStatus] = useState(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const planPath = overwatchPlanPath(portfolioId);

  useEffect(() => {
    if (!slice) return;
    setStatus(slice.status);
    setReason(slice.paused_reason || "");
  }, [slice]);

  const back = (
    <Link to={planPath} className="inline-flex items-center gap-2 mb-3 min-h-[44px] text-primary hover:text-primary-hover">
      <ArrowLeft className="w-4 h-4" aria-hidden="true" />
      Plan
    </Link>
  );
  if (loading) return <div>{back}<p className="m-0 text-sm text-muted-foreground">Loading…</p></div>;
  if (error) return <div>{back}<p role="alert" className="m-0 text-sm text-destructive">{error}</p></div>;
  if (!slice) return <div>{back}<p className="m-0 text-sm text-muted-foreground">That slice was not found.</p></div>;
  const named = { ...slice, name: slice.group?.name || "Unnamed project" };
  if (!slice.plan?.active) {
    return (
      <div>
        {back}
        <p className="m-0 text-sm text-foreground">
          {sliceTitle(named)} belongs to an older version of the plan, which is read only.
        </p>
      </div>
    );
  }

  const save = async () => {
    if (status === "paused" && !reason.trim()) {
      setSaveError("A paused slice needs a reason.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await updateSliceStatus(slice.id, status, reason.trim());
      navigate(planPath);
    } catch (e) {
      setSaveError(e.message);
      setSaving(false);
    }
  };

  return (
    <div>
      {back}
      <EditCard className="mb-4 sm:mb-6">
        <h2 className="m-0 mb-1 font-medium text-lg">Slice status</h2>
        <p className="m-0 mb-4 text-sm text-muted-foreground">{sliceTitle(named)} · lane {slice.lane}</p>
        <fieldset className="m-0 p-0 border-0 space-y-1">
          <legend className="mb-1 text-sm font-medium text-foreground">Status</legend>
          {STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-3 min-h-[44px] text-sm text-foreground">
              <input type="radio" name="slice-status" value={s} checked={status === s} onChange={() => setStatus(s)} />
              {STATUS_WORDS[s]}
            </label>
          ))}
        </fieldset>
        {status === "paused" && (
          <div className="mt-3">
            <label htmlFor="paused-reason" className="block text-sm font-medium text-foreground mb-1">Why it is paused</label>
            <input id="paused-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] border border-border rounded-lg bg-background text-foreground" />
          </div>
        )}
        {saveError && <p role="alert" className="mt-3 mb-0 text-sm text-destructive">{saveError}</p>}
        <PinnedFooter unpinnedClassName="pt-2">
          <button type="button" onClick={save} disabled={saving}
            className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
          <button type="button" onClick={() => navigate(planPath)}
            className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200">
            Cancel
          </button>
        </PinnedFooter>
      </EditCard>
    </div>
  );
}
