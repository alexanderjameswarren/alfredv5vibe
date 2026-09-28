import React from "react";
import { sourceLabel } from "../lib/warmupLadder";
import TargetGroup from "./TargetGroup";

// The warm-up ladder while it runs (spec §7.2). One compact line, directly above
// the plan line:
//
//   Warm-up  95% (28) ✓✓ · 95% (34) ●○ · 95% (40) ○○   from the plan
//   Warm-up complete — looping at 40 BPM               from the plan
//
// One group per rung: the accuracy a pass must reach, the tempo it must reach it
// at, and a mark per required pass, filled as the count rises. The current rung
// is emphasised and completed rungs are muted, so where he is in the ramp is
// readable from the piano bench without counting.
//
// The rung's percent OF TARGET TEMPO is deliberately gone (2026-09-28): it was
// the only thing the strip said, and it is the one number he does not play to.
// The accuracy is what he is aiming at; the BPM in brackets is the same fact the
// percent carried, in the units the tempo box uses.
//
// THE RIGHT-HAND LABEL IS NOT DECORATION. A ladder can come from four places
// (§4) and a plan item's ladder overrides the snippet's, so without the label a
// ramp he did not expect has no explanation. It says which level supplied this
// one, every time it runs.
//
// Each rung names its own tempo, so the strip says where the next one goes
// rather than only where the box is now. On completion the line collapses to the
// settled tempo, which is then the only news: the ladder has stopped moving.
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
            {/* Done rungs keep a tick rather than going blank (TargetGroup): the
                ramp he has already climbed is the encouraging part. */}
            {rungs.map((r, i) => (
              <span key={r.percent} className="flex items-baseline gap-1">
                {i > 0 && <span className="text-muted-foreground" aria-hidden="true">·</span>}
                <TargetGroup
                  accuracy={r.accuracy}
                  effectiveBpm={r.effectiveBpm}
                  target={r.target}
                  filled={r.filled}
                  state={r.state}
                  label={`rung ${i + 1}`}
                />
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
