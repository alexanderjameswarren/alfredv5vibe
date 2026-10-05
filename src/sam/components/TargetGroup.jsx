import React from "react";

// One group on a targets strip: what a pass has to reach, and how many of them
// are banked.
//
//   95% (28) ●○        accuracy target, tempo target, one mark per pass
//
// ACCURACY FIRST, TEMPO IN PARENTHESES (2026-09-28). The strip used to show the
// rung's percent OF TARGET TEMPO — "70% ○○" — which is the one number he is not
// aiming at: the ladder moves the tempo box for him, so the tempo is context,
// and accuracy is the thing he has to play. The percent of target is not shown
// at all any more; the BPM it works out to says the same thing and is what the
// tempo box will read.
//
// Shared by the warm-up ladder's strip and the in-a-row strip so the two lines
// are the same shape by construction rather than by two people remembering.
// The marks mean whatever the caller's `filled` means — passes at this rung for
// the ladder, the current run for a consecutive item.
//
// READABILITY: body size, full `foreground` contrast for the live group and
// `muted-foreground` for what is done or still to come, exactly as PlanLine.
// The tempo is a step smaller, which is the only thing that makes "95%" the
// figure the eye lands on.
export default function TargetGroup({
  accuracy = null,
  effectiveBpm = null,
  target = 0,
  filled = 0,
  state = "current",
  label = null,
  // "large": the plan goal line's dots — bigger, and filled green as passes
  // count, so they can be read at a glance from the keyboard.
  marksStyle = "glyph",
}) {
  const marks = marksStyle === "large"
    ? Array.from({ length: target }, (_, n) => (
        <span
          key={n}
          data-mark={n < filled ? "filled" : "empty"}
          className={`inline-block w-4 h-4 rounded-full border-2 align-middle ml-1 ${
            n < filled ? "bg-done-strong border-done-strong" : "border-current opacity-60"
          }`}
        />
      ))
    : Array.from({ length: target }, (_, n) =>
        state === "done" ? "✓" : n < filled ? "●" : "○"
      ).join("");

  // A free-play item has no accuracy target, so the tempo is all there is and it
  // carries the group on its own rather than sitting in brackets after nothing.
  const accuracyText = Number.isFinite(accuracy) ? `${accuracy}%` : null;
  const tempoText = Number.isFinite(effectiveBpm) ? `${effectiveBpm}` : null;

  const spoken = [
    accuracyText ? `${accuracy} percent accuracy` : null,
    tempoText ? `at ${effectiveBpm} BPM` : null,
    `${filled} of ${target} passes`,
  ].filter(Boolean).join(", ");

  return (
    <span
      data-state={state}
      aria-label={label ? `${label}: ${spoken}` : spoken}
      className={state === "current" ? "text-foreground font-medium" : "text-muted-foreground"}
    >
      {accuracyText ? (
        <>
          {accuracyText}
          {tempoText && <span className="text-xs"> ({tempoText})</span>}
        </>
      ) : (
        tempoText && <span>{tempoText} BPM</span>
      )}{" "}
      <span aria-hidden="true" data-testid={marksStyle === "large" ? "goal-dots" : undefined}>{marks}</span>
    </span>
  );
}
