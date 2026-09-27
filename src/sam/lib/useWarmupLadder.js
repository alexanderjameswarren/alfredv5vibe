// The warm-up ladder as the player runs it (spec §6, §7.2).
//
// State lives in a ref and is mirrored into React state for rendering, for the
// same reason `handleLoopCount` does: `creditPass` is reached from ScrollEngine's
// requestAnimationFrame frame through a callback captured in its scroll effect,
// so anything read there must be readable without a re-render.
//
// THE TEMPO IS NOT SET HERE. This hook says what the tempo box should hold and
// when; SamPlayer sets it, with the same `bpm.set` / `playbackSpeed.set` a human
// typing in the box uses. That matters: a mid-play tempo change re-runs
// ScrollEngine's scroll effect, and reusing the one path Alex already exercises
// by hand is how the ladder avoids inventing a second way to change tempo.
//
// WHY THE PENDING TEMPO WAITS FOR THE TELEPORT. A pass is credited at
// `onContentEnd`, which on a range with rest measures fires when the MUSIC ends —
// a bar before the loop wraps (d7d9c32). Setting the tempo there would re-run the
// scroll effect immediately and eat the rest bars, taking away the breath he has
// them for, exactly on the rep where the tempo jumps. So the rung advances and
// the strip moves at the credit — which is what §6.4 asks for — and the new tempo
// is applied at the wrap, which is what "the next cycle plays at the new tempo"
// means. With no rest measures the two instants are the same frame, so that case
// behaves exactly as the spec describes it.

import { useCallback, useRef, useState } from "react";
import { supabase } from "../../supabaseClient";
import { applyPass, rungTempo, shouldSuggestEasier, startRun, stripModel } from "./warmupLadder";

// sam_default_warmup_ladder() is the single source of the app default (§3), so it
// is fetched, never copied. Cached at module scope: it is a constant, one call
// per page load is plenty, and every player that mounts shares the answer.
let defaultLadderCache = null;
let defaultLadderInFlight = null;

export async function fetchDefaultLadder() {
  if (defaultLadderCache) return defaultLadderCache;
  if (defaultLadderInFlight) return defaultLadderInFlight;
  // Guarded because this runs in an effect on mount: a throw here would take the
  // whole player down, and the worst honest outcome of not reading the default is
  // that a range with no ladder of its own has no warm-up.
  if (typeof supabase?.rpc !== "function") return null;
  defaultLadderInFlight = supabase
    .rpc("sam_default_warmup_ladder")
    .then(({ data, error }) => {
      defaultLadderInFlight = null;
      if (error) {
        console.error("[Sam] Could not read the default warm-up ladder:", error);
        return null;
      }
      defaultLadderCache = Array.isArray(data) ? data : null;
      return defaultLadderCache;
    })
    .catch((e) => {
      defaultLadderInFlight = null;
      console.error("[Sam] Could not read the default warm-up ladder:", e);
      return null;
    });
  return defaultLadderInFlight;
}

// Test seam only: the cache is module-scoped, so a test that has asserted one
// answer must be able to forget it.
export function resetDefaultLadderCache() {
  defaultLadderCache = null;
  defaultLadderInFlight = null;
}

export default function useWarmupLadder() {
  const runRef = useRef(null);
  const targetRef = useRef({ effectiveBpm: null, song: null, itemAccuracyTarget: null });
  const pendingTempoRef = useRef(null);
  // What the strip draws. A plain object so a render is triggered by identity.
  const [view, setView] = useState(null);

  const publish = useCallback(() => {
    const run = runRef.current;
    setView(
      run
        ? {
            rungs: stripModel(run),
            complete: run.complete,
            suggest: shouldSuggestEasier(run),
            source: targetRef.current.source,
            effectiveBpm: targetRef.current.effectiveBpm,
            rung: run.rung,
            rungCount: run.ladder.length,
            ladder: run.ladder,
          }
        : null
    );
  }, []);

  /**
   * Arm a run and return the tempo for rung one, for the caller to apply before
   * playback starts. Null when there is nothing to run.
   */
  const start = useCallback(({ ladder, source, targetEffectiveBpm, song, itemAccuracyTarget }) => {
    const run = startRun(ladder);
    if (!run) return null;
    const first = rungTempo({ targetEffectiveBpm, percent: ladder[0].target_percent, song });
    if (!first) return null;
    runRef.current = run;
    targetRef.current = { effectiveBpm: targetEffectiveBpm, song, itemAccuracyTarget, source };
    pendingTempoRef.current = null;
    publish();
    return first;
  }, [publish]);

  /**
   * A pass has just been credited. Returns what the sam_passes row must carry —
   * `{ warmupRung, warmupTargetPercent }` — or null when no ladder is running.
   *
   * Called synchronously at the credit instant, BEFORE the row is written, so
   * the rung recorded is the rung the pass was played at rather than the one the
   * advance moved to.
   */
  const creditPass = useCallback((playthrough) => {
    const run = runRef.current;
    if (!run) return null;
    const { state, pass, outcome } = applyPass(run, {
      playthrough,
      itemAccuracyTarget: targetRef.current.itemAccuracyTarget,
    });
    runRef.current = state;
    if (outcome === "advanced") {
      const { effectiveBpm, song } = targetRef.current;
      pendingTempoRef.current = rungTempo({
        targetEffectiveBpm: effectiveBpm,
        percent: state.ladder[state.rung].target_percent,
        song,
      });
    }
    publish();
    return pass;
  }, [publish]);

  /** The tempo waiting to be applied at the next loop wrap, taken exactly once. */
  const takePendingTempo = useCallback(() => {
    const pending = pendingTempoRef.current;
    pendingTempoRef.current = null;
    return pending;
  }, []);

  /** Stop or pause ends the session and therefore the ladder (§6.6). */
  const stop = useCallback(() => {
    if (!runRef.current && !pendingTempoRef.current) return;
    runRef.current = null;
    pendingTempoRef.current = null;
    publish();
  }, [publish]);

  return { start, creditPass, takePendingTempo, stop, view };
}
