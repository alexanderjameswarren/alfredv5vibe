import React from "react";
import { Pause, Play, Square, Check, Volume2, VolumeX } from "lucide-react";
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

// Circle scale is driven by the phase's explicit `animation` mode. Shared
// MIN/MAX constants across all four modes guarantee continuity across
// transitions: a `grow` ends at MAX == `hold-large` at MAX, `shrink` ends
// at MIN == `hold-small` at MIN, so the circle never jumps.
const CIRCLE_MIN = 0.4;
const CIRCLE_MAX = 1.0;

// Smoothstep — symmetric ease-in-out with zero derivative at both ends.
// Slow start, quick middle, slow finish — reads as breathing rather than
// linear machine motion.
function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

function computePacingScale(phase, phaseFraction) {
  const mode = phase?.animation || "hold-large";
  const t = easeInOut(Math.max(0, Math.min(1, phaseFraction)));
  switch (mode) {
    case "grow":
      return CIRCLE_MIN + (CIRCLE_MAX - CIRCLE_MIN) * t;
    case "shrink":
      return CIRCLE_MAX - (CIRCLE_MAX - CIRCLE_MIN) * t;
    case "hold-small":
      return CIRCLE_MIN;
    case "hold-large":
    default:
      return CIRCLE_MAX;
  }
}

export default function TimerRun({
  totalSeconds,
  phases,
  loop,
  muted,
  onMuteChange,
  onStop,
}) {
  const engine = useTimerEngine({ totalSeconds, phases, loop });

  const {
    status,
    elapsedMs,
    effectiveEndMs,
    currentPhaseIdx,
    absolutePhaseIdx,
    currentPhase,
    phaseElapsedMs,
    phaseRemainingMs,
    phaseTotalMs,
    pause,
    resume,
  } = engine;

  usePhaseCues({ phaseKey: absolutePhaseIdx, status, muted });

  const paused = status === "paused";
  const ended = status === "ended";

  const phaseFraction =
    phaseTotalMs > 0 ? Math.min(1, phaseElapsedMs / phaseTotalMs) : 0;
  const scale = ended
    ? (CIRCLE_MIN + CIRCLE_MAX) / 2
    : computePacingScale(currentPhase, phaseFraction);

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
        {!ended && (
          <button
            onClick={() => onMuteChange(!muted)}
            title={muted ? "Unmute" : "Mute"}
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
            className={`p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded border transition-colors ${
              muted
                ? "border-primary bg-primary-light text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
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
