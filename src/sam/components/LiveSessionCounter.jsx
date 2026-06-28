import React, { useEffect, useState } from "react";
import { formatMinutesLong } from "../lib/practiceTimeFormat";

// Live playback-row companion to the audio ms counter:
//   Session — M:SS since the current play started, in an oversized
//             monospace badge sized for at-a-glance reading while playing
//   Today   — all-songs running total for today (PT), live-incremented
//             by the in-progress session so it matches the stopped/paused
//             PracticeTimeIndicator's "Today:" exactly the moment play
//             stops and the post-end refetch lands.
//
// Captures start as state (not just a ref) so the first render after
// entering "playing" shows "0:00" immediately. Elapsed time is computed
// as `Date.now() - startMs` at render time, so a throttled/dropped tick
// doesn't accumulate drift.
//
// On transition into "playing" (whether from "stopped" or "paused"), the
// effect re-runs and resets startMs — Session counter snaps back to 0:00,
// the Today total continues smoothly from the just-refetched value.
export default function LiveSessionCounter({ playbackState, todayMinutes }) {
  const [startMs, setStartMs] = useState(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (playbackState !== "playing") {
      setStartMs(null);
      return undefined;
    }
    setStartMs(Date.now());
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [playbackState]);

  if (playbackState !== "playing" || startMs == null) return null;

  const elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  const sessionLabel = `${m}:${String(s).padStart(2, "0")}`;

  const liveTodayMin = todayMinutes + elapsedSec / 60;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-secondary/40 border border-border">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          Session
        </span>
        <span className="text-2xl font-mono font-bold text-primary tabular-nums leading-none">
          {sessionLabel}
        </span>
      </div>
      <span className="text-sm text-muted-foreground">
        Today: <strong className="text-dark">{formatMinutesLong(liveTodayMin)}</strong>
      </span>
    </>
  );
}
