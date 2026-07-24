import React from "react";
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Play,
  Clock,
  LayoutList,
  Repeat,
  VolumeX,
  Expand,
  Circle,
  Shrink,
  Dot,
} from "lucide-react";

// Position-cycling defaults: index 0 → grow, 1 → hold-large, 2 → shrink,
// 3 → hold-small, 4 → grow, ... Applied only at add time; overrides and
// reorders never re-derive.
const ANIMATION_DEFAULTS = ["grow", "hold-large", "shrink", "hold-small"];

// Order = display order in the segmented selector. Value is the canonical
// mode string consumed by TimerRun's scale derivation.
const ANIMATION_OPTIONS = [
  { value: "grow", label: "Grow", Icon: Expand },
  { value: "hold-large", label: "Hold large", Icon: Circle },
  { value: "shrink", label: "Shrink", Icon: Shrink },
  { value: "hold-small", label: "Hold small", Icon: Dot },
];

// Builder mode. Owns per-row draft strings inside each phase object
// (`secondsInput`) rather than one useNumericInput per row — hooks can't
// live inside an array map, so the same commit-on-blur pattern is inlined
// per row instead.
//
// Validation: Start is enabled only when total duration > 0 AND at least one
// phase exists AND every phase has seconds > 0.
export default function TimerBuilder({
  totalMinutes,
  totalSecondsIn,
  phases,
  onPhasesChange,
  loop,
  onLoopChange,
  muted,
  onMuteChange,
  onStart,
}) {
  const totalSeconds = totalMinutes.value * 60 + totalSecondsIn.value;
  const cycleSeconds = phases.reduce((s, p) => s + p.seconds, 0);
  const cycleCount = cycleSeconds > 0 ? Math.floor(totalSeconds / cycleSeconds) : 0;

  const hasValidPhases = phases.length > 0 && phases.every((p) => p.seconds > 0);
  const canStart = totalSeconds > 0 && hasValidPhases;

  function addPhase() {
    onPhasesChange([
      ...phases,
      {
        id: crypto.randomUUID(),
        label: "",
        seconds: 0,
        secondsInput: "0",
        animation: ANIMATION_DEFAULTS[phases.length % ANIMATION_DEFAULTS.length],
      },
    ]);
  }

  function updatePhase(id, patch) {
    onPhasesChange(phases.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removePhase(id) {
    onPhasesChange(phases.filter((p) => p.id !== id));
  }

  function movePhase(id, delta) {
    const idx = phases.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const j = idx + delta;
    if (j < 0 || j >= phases.length) return;
    const copy = [...phases];
    [copy[idx], copy[j]] = [copy[j], copy[idx]];
    onPhasesChange(copy);
  }

  function commitPhaseSeconds(p) {
    let n = Number(p.secondsInput);
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (n > 3600) n = 3600;
    n = Math.round(n);
    updatePhase(p.id, { seconds: n, secondsInput: String(n) });
  }

  return (
    <div className="space-y-4">
      {/* Total duration */}
      <section className="p-4 bg-card border border-border rounded-lg">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground mb-3">
          <Clock className="w-4 h-4 text-muted-foreground" />
          Total duration
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-foreground flex items-center gap-1.5">
            <input
              type="number"
              value={totalMinutes.input}
              onFocus={(e) => e.target.select()}
              onChange={(e) => totalMinutes.setInput(e.target.value)}
              onBlur={() => totalMinutes.commit({ min: 0, fallback: 0 })}
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={0}
              max={180}
            />
            min
          </label>
          <label className="text-sm text-foreground flex items-center gap-1.5">
            <input
              type="number"
              value={totalSecondsIn.input}
              onFocus={(e) => e.target.select()}
              onChange={(e) => totalSecondsIn.setInput(e.target.value)}
              onBlur={() => totalSecondsIn.commit({ min: 0, max: 59, fallback: 0 })}
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={0}
              max={59}
            />
            sec
          </label>
          <span className="text-xs text-muted-foreground">= {totalSeconds}s</span>
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer ml-auto">
            <input
              type="checkbox"
              checked={loop}
              onChange={(e) => onLoopChange(e.target.checked)}
              className="w-4 h-4 accent-primary"
            />
            <Repeat className="w-4 h-4 text-muted-foreground" />
            Loop
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={muted}
              onChange={(e) => onMuteChange(e.target.checked)}
              className="w-4 h-4 accent-primary"
            />
            <VolumeX className="w-4 h-4 text-muted-foreground" />
            Mute
          </label>
        </div>
      </section>

      {/* Phase list */}
      <section className="p-4 bg-card border border-border rounded-lg">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground mb-3">
          <LayoutList className="w-4 h-4 text-muted-foreground" />
          Phases
        </h2>
        {phases.length === 0 ? (
          <p className="text-sm text-muted-foreground mb-3">
            No phases yet. Add one below to build your sequence.
          </p>
        ) : (
          <div className="flex flex-col gap-2 mb-3">
            {phases.map((p, i) => (
              <div
                key={p.id}
                className="flex items-center gap-2 p-2 bg-background border border-border rounded-lg flex-wrap"
              >
                <span className="text-xs text-muted-foreground w-6 text-right tabular-nums">
                  {i + 1}.
                </span>
                <input
                  type="text"
                  value={p.label}
                  onChange={(e) => updatePhase(p.id, { label: e.target.value })}
                  placeholder="e.g. Breathe in"
                  className="flex-1 min-w-0 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
                />
                <label className="text-sm text-foreground flex items-center gap-1.5">
                  <input
                    type="number"
                    value={p.secondsInput}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) =>
                      updatePhase(p.id, { secondsInput: e.target.value })
                    }
                    onBlur={() => commitPhaseSeconds(p)}
                    className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
                    min={0}
                    max={3600}
                  />
                  s
                </label>
                <div className="flex items-center gap-1" role="group" aria-label="Animation">
                  {ANIMATION_OPTIONS.map((opt) => {
                    const active = p.animation === opt.value;
                    const Icon = opt.Icon;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => updatePhase(p.id, { animation: opt.value })}
                        title={opt.label}
                        aria-label={opt.label}
                        aria-pressed={active}
                        className={`p-2 border rounded flex items-center justify-center transition-colors ${
                          active
                            ? "border-primary bg-primary-light text-primary"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => movePhase(p.id, -1)}
                  disabled={i === 0}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed rounded"
                  title="Move up"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button
                  onClick={() => movePhase(p.id, 1)}
                  disabled={i === phases.length - 1}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed rounded"
                  title="Move down"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
                <button
                  onClick={() => removePhase(p.id)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive rounded"
                  title="Remove phase"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={addPhase}
          className="flex items-center gap-1.5 px-3 py-2 rounded min-h-[44px] text-sm font-medium border border-border text-foreground hover:bg-secondary/50 transition-colors"
        >
          <Plus className="w-4 h-4" /> Add phase
        </button>
      </section>

      {/* Summary + Start */}
      <section className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
        <p className="text-sm text-muted-foreground flex-1">
          {cycleSeconds === 0
            ? "Add phases to see how many cycles fit."
            : cycleCount === 0
            ? `Cycle: ${cycleSeconds}s · Total is shorter than one cycle.`
            : `Cycle: ${cycleSeconds}s · ~${cycleCount} ${
                cycleCount === 1 ? "cycle" : "cycles"
              } fit in ${totalSeconds}s.`}
        </p>
        <button
          onClick={onStart}
          disabled={!canStart}
          className={`flex items-center justify-center gap-1.5 px-5 py-2 rounded min-h-[44px] font-medium text-sm transition-colors ${
            canStart
              ? "bg-primary hover:bg-primary-hover text-white shadow-sm"
              : "bg-secondary text-muted-foreground cursor-not-allowed"
          }`}
        >
          <Play className="w-4 h-4" /> Start
        </button>
      </section>
    </div>
  );
}
