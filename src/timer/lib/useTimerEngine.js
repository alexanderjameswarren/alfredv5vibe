import { useState, useEffect, useRef, useMemo, useCallback } from "react";

// Timestamp-based multi-phase timer. Not tick-counted — every frame reads
// `performance.now()` and derives elapsed as `accum + (now - startTs)` so a
// throttled or dropped rAF doesn't accumulate drift; the display snaps to
// true elapsed on the next frame.
//
// Pause freezes accumulated elapsed (fold `now - startTs` into `accum`,
// clear `startTs`). Resume re-anchors `startTs` at the current instant so
// paused wall-clock time is invisible to the schedule.
//
// Graceful end: `effectiveEndMs` is the smallest phase-boundary time >=
// `totalMs`. The engine keeps running past `totalMs` until the current
// phase's natural boundary, then transitions to "ended". Loop=false caps
// this at one cycle regardless of totalMs.

function computeEffectiveEndMs(phases, totalMs, loop) {
  const durations = phases.map((p) => p.seconds * 1000);
  const cycleMs = durations.reduce((a, b) => a + b, 0);
  if (cycleMs === 0) return 0;

  if (!loop) {
    // Single pass — end at whichever comes first: the phase containing
    // totalMs, or the end of the cycle.
    let t = 0;
    for (const d of durations) {
      t += d;
      if (t >= totalMs) return t;
    }
    return cycleMs;
  }

  // Loop — snap totalMs up to the next phase boundary within the cycle
  // containing it.
  const fullCycles = Math.floor(totalMs / cycleMs);
  const remainder = totalMs - fullCycles * cycleMs;
  if (remainder === 0) return totalMs; // exact boundary
  const base = fullCycles * cycleMs;
  let t = base;
  for (const d of durations) {
    t += d;
    if (t >= base + remainder) return t;
  }
  return t; // unreachable if remainder < cycleMs
}

function computePhase(elapsedMs, phases, loop) {
  const durations = phases.map((p) => p.seconds * 1000);
  const cycleMs = durations.reduce((a, b) => a + b, 0);
  if (cycleMs === 0 || phases.length === 0) {
    return { idx: 0, phaseElapsedMs: 0 };
  }

  let t;
  if (loop) {
    t = elapsedMs % cycleMs;
  } else {
    t = Math.min(elapsedMs, cycleMs);
  }
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    if (t < acc + durations[i]) {
      return { idx: i, phaseElapsedMs: t - acc };
    }
    acc += durations[i];
  }
  // t sits exactly at cycleMs — treat as last phase fully consumed.
  return {
    idx: durations.length - 1,
    phaseElapsedMs: durations[durations.length - 1],
  };
}

export default function useTimerEngine({ totalSeconds, phases, loop }) {
  const [status, setStatus] = useState("running");
  const [elapsedMs, setElapsedMs] = useState(0);

  const totalMs = totalSeconds * 1000;
  const effectiveEndMs = useMemo(
    () => computeEffectiveEndMs(phases, totalMs, loop),
    [phases, totalMs, loop]
  );

  const startTsRef = useRef(null);
  const accumMsRef = useRef(0);

  useEffect(() => {
    if (status !== "running") return undefined;
    startTsRef.current = performance.now();
    let cancelled = false;
    let rafId = null;

    function tick() {
      if (cancelled) return;
      const now = performance.now();
      const running = accumMsRef.current + (now - startTsRef.current);
      if (running >= effectiveEndMs) {
        setElapsedMs(effectiveEndMs);
        // Fold final leg into accum so a subsequent pause/resume would
        // read a consistent elapsed even though status is now "ended".
        accumMsRef.current = effectiveEndMs;
        startTsRef.current = null;
        setStatus("ended");
        return;
      }
      setElapsedMs(running);
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [status, effectiveEndMs]);

  const { idx: currentPhaseIdx, phaseElapsedMs } = useMemo(
    () => computePhase(elapsedMs, phases, loop),
    [elapsedMs, phases, loop]
  );

  const currentPhase = phases[currentPhaseIdx] || null;
  const phaseTotalMs = (currentPhase?.seconds ?? 0) * 1000;
  const phaseRemainingMs = Math.max(0, phaseTotalMs - phaseElapsedMs);
  const remainingMs = Math.max(0, effectiveEndMs - elapsedMs);

  const pause = useCallback(() => {
    setStatus((prev) => {
      if (prev !== "running") return prev;
      if (startTsRef.current != null) {
        accumMsRef.current += performance.now() - startTsRef.current;
        startTsRef.current = null;
      }
      return "paused";
    });
  }, []);

  const resume = useCallback(() => {
    // The rAF effect re-anchors `startTsRef` on entry when status flips to
    // "running" — no need to touch it here.
    setStatus((prev) => (prev === "paused" ? "running" : prev));
  }, []);

  return {
    status,
    elapsedMs,
    remainingMs,
    effectiveEndMs,
    currentPhaseIdx,
    currentPhase,
    phaseElapsedMs,
    phaseRemainingMs,
    phaseTotalMs,
    pause,
    resume,
  };
}
