import React from "react";
import { Pause, Play } from "lucide-react";

/**
 * A project's or series' small marker (Restructure P5 step 15): teal "In progress"
 * when a live member is running, amber "Paused" when one is paused and none runs.
 * The colours are the run cards'. Nothing for `null`.
 */
export default function MemberRunMarker({ state, className = "" }) {
  if (!state) return null;
  const active = state === "active";
  return (
    <span
      data-member-run={state}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
        active ? "bg-success-light border-success text-foreground" : "bg-warning-light border-warning text-foreground"
      } ${className}`}
    >
      {active ? <Play className="w-3 h-3" aria-hidden="true" /> : <Pause className="w-3 h-3" aria-hidden="true" />}
      {active ? "In progress" : "Paused"}
    </span>
  );
}
