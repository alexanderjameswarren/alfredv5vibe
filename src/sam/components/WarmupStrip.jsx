import React from "react";
import { sourceLabel } from "../lib/warmupLadder";

// The warm-up ladder while it runs (spec §7.2). One compact line, directly above
// the plan line:
//
//   Warm-up  50% ✓✓ · 70% ●○ · 100% ○○○              from the plan
//   Warm-up complete — looping at 40 BPM             from the plan
//
// One group per rung: its percent, and a mark per required pass, filled as the
// count rises. The current rung is emphasised and completed rungs are muted, so
// where he is in the ramp is readable from the piano bench without counting.
//
// THE RIGHT-HAND LABEL IS NOT DECORATION. A ladder can come from four places
// (§4) and a plan item's ladder overrides the snippet's, so without the label a
// ramp he did not expect has no explanation. It says which level supplied this
// one, every time it runs.
//
// The tempo box already shows the actual BPM, so this strip deliberately does not
// repeat it — except on completion, where the BPM is the news: the ladder has
// stopped moving and this is what it settled at.
//
// READABILITY: same rules as PlanLine — body size, full `foreground` contrast for
// the live rung, `muted-foreground` for what is finished or still to come.
export default function WarmupStrip({ view }) {
  if (!view) return null;
  const { rungs, complete, suggest, source, effectiveBpm } = view;

  return (
    <div className="mb-2 px-1 text-sm" aria-label="Warm-up ladder">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-medium text-foreground shrink-0">Warm-up</span>

        {complete ? (
          <span className="text-foreground" data-state="complete">
            {" "}complete{Number.isFinite(effectiveBpm) ? ` — looping at ${effectiveBpm} BPM` : ""}
          </span>
        ) : (
          <span className="flex items-baseline gap-1 flex-wrap">
            {rungs.map((r, i) => (
              <span key={r.percent} className="flex items-baseline gap-1">
                {i > 0 && <span className="text-muted-foreground" aria-hidden="true">·</span>}
                <span
                  data-state={r.state}
                  aria-label={`${r.percent} percent, ${r.filled} of ${r.target} passes`}
                  className={
                    r.state === "current"
                      ? "text-foreground font-medium"
                      : "text-muted-foreground"
                  }
                >
                  {r.percent}%{" "}
                  <span aria-hidden="true">
                    {/* Done rungs keep a tick rather than going blank: the ramp he
                        has already climbed is the encouraging part. */}
                    {Array.from({ length: r.target }, (_, n) =>
                      r.state === "done" ? "✓" : n < r.filled ? "●" : "○"
                    ).join("")}
                  </span>
                </span>
              </span>
            ))}
          </span>
        )}

        {source && (
          <span className="text-muted-foreground ml-auto shrink-0">{sourceLabel(source)}</span>
        )}
      </div>

      {/* §6.7. A suggestion, never an adjustment: a rung that keeps failing is
          information the next plan conversation should get, and moving the ladder
          by itself would destroy that evidence. */}
      {suggest && !complete && (
        <div className="text-muted-foreground" data-state="suggest">
          Three misses at this rung — try starting lower, or shortening the range.
        </div>
      )}
    </div>
  );
}
