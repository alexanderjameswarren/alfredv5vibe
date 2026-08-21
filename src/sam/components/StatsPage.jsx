import React from "react";
import { ArrowLeft } from "lucide-react";

// Stub /stats view. Milestone 6 wires the tap surfaces (week strip +
// FamilySheet Practice history button) to this page; a later milestone
// will fill in the actual per-session and per-family analytics.
//
// Renders inside the SamPlayer sticky-header shell — no header of its
// own; a light Back button routes back to the SAM landing view. The URL is
// /sam/stats while this is showing.

export default function StatsPage({ onBack }) {
  return (
    <div className="max-w-lg mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-dark min-h-[44px] px-2 -ml-2"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>
      <h2 className="text-2xl font-bold text-dark mt-2">Practice history</h2>
      <p className="text-sm text-muted-foreground mt-4">
        Session history and per-family analytics will land here in a later
        milestone. For now this is a stub route so the week strip and the
        Practice history button on the family sheet have somewhere to go.
      </p>
    </div>
  );
}
