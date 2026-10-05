import React, { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import TargetGroup from "./TargetGroup";

// The one line that answers "am I done?" mid-play, for any plan item that is
// not a warm-up item (spec: docs/technical-spec-sam_glance-p7k.md).
//
//   In a row  90% (60) ●●○○  ·  best 2 of 4 today  ·  Plan 2/4
//   Goal      90% (60) ●●○○  ·  Plan 2/4
//
// In a row: the dots are the CURRENT run and "best" is the day's longest, which
// never rolls back (see SamPlayer's liveItemState). Otherwise the dots are the
// day's qualifying count, the same number as Plan n/m.
//
// Everything here is already final at the moment the music ends — SamPlayer
// folds the live pass in before the database answers — because the rest bar is
// the only time he can look.
export const PULSE_MS = 450;

export default function PlanGoalLine({ view, flash = null }) {
  // A pass that counted pulses green; a broken run flashes amber. Only a change
  // of `seq` fires one, so remounting after a pause does not replay the last.
  const seenSeq = useRef(flash?.seq ?? 0);
  const [pulse, setPulse] = useState(null);
  useEffect(() => {
    if (!flash || flash.seq === seenSeq.current) return undefined;
    seenSeq.current = flash.seq;
    setPulse(flash.kind);
    const t = setTimeout(() => setPulse(null), PULSE_MS);
    return () => clearTimeout(t);
  }, [flash]);

  if (!view) return null;
  const { consecutive, accuracy, effectiveBpm, target, filled, best, done, planText } = view;

  // Box shadow and colour only, so neither the pulse nor the done state moves
  // anything; the fixed min-height leaves room for the check.
  const tone = done
    ? "bg-done text-done-foreground"
    : pulse === "qualified" ? "bg-done-light"
    : pulse === "broke" ? "bg-amber-100"
    : "bg-transparent";
  const ring = pulse === "qualified" ? "ring-done-strong"
    : pulse === "broke" ? "ring-amber-500"
    : "ring-transparent";

  return (
    <div
      aria-label="Plan goal"
      data-done={done ? "true" : "false"}
      data-pulse={pulse || "none"}
      className={`mb-2 px-2 py-1 min-h-9 rounded-md ring-2 transition-all duration-300 text-sm flex items-center gap-2 flex-wrap ${tone} ${ring}`}
    >
      {done && <Check className="w-7 h-7 shrink-0" strokeWidth={3} role="img" aria-label="Plan item done" />}
      <span className="font-medium shrink-0">{consecutive ? "In a row" : "Goal"}</span>
      <TargetGroup
        accuracy={accuracy}
        effectiveBpm={effectiveBpm}
        target={target}
        filled={done ? target : filled}
        state="current"
        label={consecutive ? "current run" : "passes today"}
        marksStyle="large"
      />
      {consecutive && (
        <span className={done ? "" : "text-muted-foreground"} data-testid="consecutive-best">
          · best {best} of {target} today
        </span>
      )}
      <span className="font-medium" data-testid="goal-plan">· {planText}</span>
    </div>
  );
}
