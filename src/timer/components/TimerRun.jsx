import React from "react";
import { Pause, Play, Square, Check } from "lucide-react";
import useTimerEngine from "../lib/useTimerEngine";
import usePhaseCues from "../lib/usePhaseCues";

// Polished Run mode. Big centered phase label + expanding/contracting
// pacing circle keyed off the phase label, monospace countdown, overall
// progress bar, transport controls. Step 5 layers chime + haptics on top
// of the phase index emitted by the engine.

// One tenth-second resolution — reads smoothly without the countdown
// flickering the whole-second digit every frame.
function formatCountdown(ms) {
  const totalTenths = Math.max(0, Math.ceil(ms / 100));
  const s = Math.floor(totalTenths / 10);
  const t = totalTenths % 10;
  return `${s}.${t}`;
}

function formatSeconds(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${r}s`;
}

// Very small classifier — presence check on the label after lowercasing.
// "out" is checked before "in" because the "in" substring appears in most
// out-labels ("out"/"exhale" don't overlap with "in", but simpler check
// order avoids false positives if someone writes "in and out" etc.).
// Anything not matching either falls through as "hold".
function classifyPhase(label) {
  const s = (label || "").toLowerCase();
  if (s.includes("out") || s.includes("exhale")) return "out";
  if (s.includes("in") || s.includes("inhale")) return "in";
  return "hold";
}

// Circle scale for the pacing cue.
// - "in" phases expand from CIRCLE_MIN → CIRCLE_MAX over the phase.
// - "out" phases contract from CIRCLE_MAX → CIRCLE_MIN over the phase.
// - "hold" phases hold at whatever size the most recent non-hold phase
//   left us at (natural for breathing — "hold in" stays large, "hold out"
//   stays small). If there's no prior non-hold phase, sit at the midpoint.
const CIRCLE_MIN = 0.4;
const CIRCLE_MAX = 1.0;

function computePacingScale(phases, currentPhaseIdx, phaseFraction) {
  const kind = classifyPhase(phases[currentPhaseIdx]?.label);
  if (kind === "in") {
    return CIRCLE_MIN + (CIRCLE_MAX - CIRCLE_MIN) * phaseFraction;
  }
  if (kind === "out") {
    return CIRCLE_MAX - (CIRCLE_MAX - CIRCLE_MIN) * phaseFraction;
  }
  for (let i = currentPhaseIdx - 1; i >= 0; i--) {
    const prev = classifyPhase(phases[i].label);
    if (prev === "in") return CIRCLE_MAX;
    if (prev === "out") return CIRCLE_MIN;
  }
  return (CIRCLE_MIN + CIRCLE_MAX) / 2;
}

export default function TimerRun({ totalSeconds, phases, loop, muted, onStop }) {
  const engine = useTimerEngine({ totalSeconds, phases, loop });

  const {
    status,
    elapsedMs,
    effectiveEndMs,
    currentPhaseIdx,
    currentPhase,
    phaseElapsedMs,
    phaseRemainingMs,
    phaseTotalMs,
    pause,
    resume,
  } = engine;

  usePhaseCues({ currentPhaseIdx, status, muted });

  const paused = status === "paused";
  const ended = status === "ended";

  const phaseFraction =
    phaseTotalMs > 0 ? Math.min(1, phaseElapsedMs / phaseTotalMs) : 0;
  const scale = ended
    ? (CIRCLE_MIN + CIRCLE_MAX) / 2
    : computePacingScale(phases, currentPhaseIdx, phaseFraction);

  const overallPct =
    effectiveEndMs > 0 ? Math.min(100, (elapsedMs / effectiveEndMs) * 100) : 0;

  const statusPill = ended
    ? "Complete"
    : `Phase ${currentPhaseIdx + 1} of ${phases.length}${
        loop ? " · looping" : ""
      }${paused ? " · paused" : ""}`;

  const bigLabel = ended
    ? "Done"
    : currentPhase?.label?.trim() || `Phase ${currentPhaseIdx + 1}`;

  return (
    <div className="flex flex-col items-center gap-6 pt-2">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        {statusPill}
      </p>

      <p className="text-4xl sm:text-5xl font-bold text-foreground text-center">
        {bigLabel}
      </p>

      {/* Pacing cue. Fixed-size container so the scaled child never affects
          layout — only its transform changes each frame. */}
      <div
        className="flex items-center justify-center"
        style={{ width: "18rem", height: "18rem" }}
      >
        {ended ? (
          <div className="w-44 h-44 rounded-full bg-primary/15 border-4 border-primary flex items-center justify-center shadow-sm">
            <Check className="w-20 h-20 text-primary" strokeWidth={3} />
          </div>
        ) : (
          <div
            className="rounded-full bg-primary/15 border-4 border-primary flex items-center justify-center shadow-sm"
            style={{
              width: "16rem",
              height: "16rem",
              transform: `scale(${scale})`,
              transformOrigin: "center",
            }}
          >
            <div className="w-3/4 h-3/4 rounded-full border border-primary/40" />
          </div>
        )}
      </div>

      {!ended && (
        <p className="text-6xl font-mono font-bold text-primary tabular-nums leading-none">
          {formatCountdown(phaseRemainingMs)}
          <span className="text-3xl text-muted-foreground ml-1">s</span>
        </p>
      )}

      <div className="w-full max-w-md space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{formatSeconds(elapsedMs)} elapsed</span>
          <span>
            {formatSeconds(effectiveEndMs)} {ended ? "total" : "target"}
          </span>
        </div>
        <div className="h-2 bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full"
            style={{ width: `${overallPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        {!ended && paused && (
          <button
            onClick={resume}
            className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm bg-primary hover:bg-primary-hover text-white"
          >
            <Play className="w-4 h-4" /> Resume
          </button>
        )}
        {!ended && !paused && (
          <button
            onClick={pause}
            className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm bg-amber-500 hover:bg-amber-600 text-white"
          >
            <Pause className="w-4 h-4" /> Pause
          </button>
        )}
        <button
          onClick={onStop}
          className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm bg-secondary hover:bg-secondary text-foreground border border-border"
        >
          <Square className="w-4 h-4" /> {ended ? "Back to Builder" : "Stop"}
        </button>
      </div>
    </div>
  );
}
