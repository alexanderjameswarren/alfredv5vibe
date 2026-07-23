import { useEffect, useRef } from "react";

// Fires a short chime + optional haptic buzz on every phase transition
// (including the initial phase when Run mounts) and a distinct two-tone
// chime + longer buzz when the timer reaches its graceful end. Silent on
// pause/resume — those don't change `currentPhaseIdx`, so the guard trips.
//
// AudioContext is created lazily on the first cue. Because Run mounts as
// a downstream effect of the user's Start-button click, the browser's
// autoplay policy allows resuming a suspended context here without an
// extra gesture. If the API isn't available (very old browser), or if
// resume() rejects for any reason, the cue silently no-ops.
//
// navigator.vibrate is feature-detected — desktop browsers either lack it
// or treat it as a no-op; either way we swallow the effect.

function classifyStatusChange(prev, next) {
  if (next === "ended" && prev !== "ended") return "ended";
  return null;
}

export default function usePhaseCues({ currentPhaseIdx, status, muted = false }) {
  const ctxRef = useRef(null);
  const prevIdxRef = useRef(null);
  const prevStatusRef = useRef(null);

  useEffect(() => {
    function ensureCtx() {
      if (ctxRef.current) return ctxRef.current;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctxRef.current = new AC();
      } catch {
        return null;
      }
      return ctxRef.current;
    }

    function chime(frequency, duration, delay = 0) {
      // Mute suppresses only audio — haptics still fire per the user's
      // "no audio" intent, so a phone in a pocket still buzzes silently.
      if (muted) return;
      const ctx = ensureCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") {
        // resume() returns a promise; ignore failures — chime just won't sound.
        ctx.resume().catch(() => {});
      }
      const startAt = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      // Short attack + exponential decay keeps the tone from clicking on
      // start and stop while staying crisp enough to hear over a breath.
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(0.15, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.05);
    }

    function vibrate(pattern) {
      if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
      try {
        navigator.vibrate(pattern);
      } catch {
        // Some browsers throw on invalid patterns; safe to swallow.
      }
    }

    const prevStatus = prevStatusRef.current;
    const prevIdx = prevIdxRef.current;

    const statusChange = classifyStatusChange(prevStatus, status);
    if (statusChange === "ended") {
      // "Ding-dong" — a rising two-note cue distinct from the phase blip.
      chime(660, 0.15);
      chime(990, 0.2, 0.18);
      vibrate([60, 40, 80]);
    } else if (status === "running" && currentPhaseIdx !== prevIdx) {
      chime(880, 0.12);
      vibrate(40);
    }

    prevIdxRef.current = currentPhaseIdx;
    prevStatusRef.current = status;
  }, [currentPhaseIdx, status, muted]);
}
