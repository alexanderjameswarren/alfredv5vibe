// The warm-up ladder: resolution, tempo, and the rung engine.
// Spec: docs/technical-spec-sam-warmup-ladder.md §2, §3, §4, §6.
//
// A short range is played at a fraction of its target tempo until it is
// reliable, then faster, then at target. The rungs are data; this file is the
// rules that read them.
//
// Everything here is pure. The run state is a plain object threaded through
// `applyPass`, so the engine can be tested a pass at a time with no player, no
// timers and no database. `useWarmupLadder` owns the state; SamPlayer owns the
// tempo box and the transport.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO:
//   - It never counts plan progress. sam_plan_item_progress is the only thing
//     that counts passes (practice plans spec §5.7). The rung counters here
//     drive the tempo and the strip for one sitting and are never stored: ladder
//     progress lives in memory and pressing Warm up always starts at rung one
//     (§2.9).
//   - It holds no copy of the app default ladder. That constant lives in
//     sam_default_warmup_ladder() and is fetched over RPC, so there is exactly
//     one of it.

import { accuracyOf } from "./practiceScoring";
import { heardTempo } from "./activePlan";

// A rung with no accuracy target of its own uses the plan item's; off plan,
// where there is no item, this is the bar (§3).
export const OFF_PLAN_ACCURACY = 85;

// §4: a rung's heard tempo never drops below this, however low the percent.
export const MIN_RUNG_BPM = 20;

// §6.7: a rung that fails this many attempts in a row earns a suggestion. It
// never auto-adjusts — a rung that keeps failing is information for the next
// plan conversation.
export const FAILS_BEFORE_SUGGESTION = 3;

const SOURCE_LABELS = {
  plan: "from the plan",
  snippet: "from this snippet",
  song: "from the song",
  default: "default",
};

/** "from the plan" | "from this snippet" | "from the song" | "default". */
export function sourceLabel(source) {
  return SOURCE_LABELS[source] || "";
}

/**
 * §4: the ladder, and which level supplied it — plan item, then snippet, then
 * song, then the app default.
 *
 * null at a level means "fall through". An empty array does NOT: it means "no
 * warm-up here" and stops the chain, which is how a song or an item opts out of
 * a ladder it would otherwise inherit (§5.1). So `{ ladder: [], source: "song" }`
 * is a real answer and means there is no warm-up.
 *
 * `defaultLadder` is what sam_default_warmup_ladder() returned, or null when it
 * has not arrived. Nothing here substitutes a hard-coded default for it.
 */
export function resolveLadder({ planItem, snippet, song, defaultLadder } = {}) {
  const levels = [
    ["plan", planItem?.warmup_ladder],
    ["snippet", snippet?.warmupLadder],
    ["song", song?.warmupLadder],
    ["default", defaultLadder],
  ];
  for (const [source, ladder] of levels) {
    if (ladder == null) continue;
    // A malformed value is treated as absent rather than trusted. The database
    // validates on write (sam_warmup_ladder_is_valid), so this only catches a
    // shape that never came from the database.
    if (!Array.isArray(ladder)) continue;
    return { ladder, source };
  }
  return { ladder: null, source: null };
}

/**
 * §4: the target tempo the percents are percentages OF, as a heard tempo.
 *
 *   1. the plan item's target, when the loaded range matches an item
 *   2. the song's CONFIRMED goal — only when goal_set_at is set, because a
 *      placeholder goal is never a target (practice plans §2.17)
 *   3. whatever is in the tempo box right now
 *
 * Always the heard tempo. Never goal_bpm or target_bpm on their own: on a song
 * with audio those are the calibration, and the target lives in the speed
 * percent (practice plans §4).
 */
export function resolveTarget({ planItem, song, bpm, playbackSpeed } = {}) {
  if (Number.isFinite(planItem?.target_effective_bpm)) {
    return { effectiveBpm: planItem.target_effective_bpm, source: "plan" };
  }
  if (song?.goalSetAt && Number.isFinite(song?.goalEffectiveBpm)) {
    return { effectiveBpm: song.goalEffectiveBpm, source: "song" };
  }
  const heard = heardTempo(bpm, playbackSpeed);
  return Number.isFinite(heard) ? { effectiveBpm: heard, source: "box" } : { effectiveBpm: null, source: null };
}

/**
 * What to put in the tempo box for one rung: `{ bpm, playbackSpeed,
 * effectiveBpm }`, or null when the song cannot express it.
 *
 * The heard tempo is `round(target * percent / 100)`, floored at MIN_RUNG_BPM
 * (§4). HOW the box reaches it depends on the song, and this is the part that is
 * easy to get wrong: a song WITH AUDIO pins bpm to its default_bpm — that value
 * is the scroll-sync calibration — and expresses tempo through the speed percent
 * (practice plans §4). So a rung on an audio-backed song moves SPEED and leaves
 * BPM alone. A song without audio does the opposite: bpm is the tempo and speed
 * stays at 100.
 */
export function rungTempo({ targetEffectiveBpm, percent, song } = {}) {
  if (!Number.isFinite(targetEffectiveBpm) || !Number.isFinite(percent)) return null;
  const wanted = Math.max(MIN_RUNG_BPM, Math.round((targetEffectiveBpm * percent) / 100));
  if (!song?.audioFilePath) {
    return { bpm: wanted, playbackSpeed: 100, effectiveBpm: wanted };
  }
  const base = song.defaultBpm;
  if (!Number.isFinite(base) || base <= 0) return null;
  const speed = Math.max(1, Math.round((wanted * 100) / base));
  return { bpm: base, playbackSpeed: speed, effectiveBpm: Math.round((base * speed) / 100) };
}

/** The accuracy a pass must reach at this rung: the rung's own, else the item's, else 85 (§3). */
export function rungAccuracyTarget(rung, itemAccuracyTarget) {
  if (Number.isFinite(rung?.accuracy_target)) return rung.accuracy_target;
  if (Number.isFinite(itemAccuracyTarget)) return itemAccuracyTarget;
  return OFF_PLAN_ACCURACY;
}

/** A fresh run of `ladder`, at rung one with every counter at zero (§2.9). */
export function startRun(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) return null;
  return {
    ladder,
    rung: 0,                          // 0-based here; 1-based in sam_passes.warmup_rung
    counts: ladder.map(() => 0),
    fails: 0,                         // consecutive failed ATTEMPTS at the current rung
    complete: false,
  };
}

/**
 * One completed playthrough, evaluated against the CURRENT rung (§6.3-§6.5).
 *
 * Returns `{ state, pass, outcome }`:
 *   state   — the run after this pass
 *   pass    — what the sam_passes row must say: { warmupRung, warmupTargetPercent }
 *   outcome — "credited" | "failed" | "advanced" | "completed" | "after-complete" | "ignored"
 *
 * WHAT COUNTS, AND WHY IT MATCHES THE DATABASE. sam_plan_item_progress is the
 * only thing that counts plan progress, and the strip must never disagree with
 * it, so the three cases are drawn exactly where that function draws them:
 *
 *   notesPlayed = 0   → NOT AN ATTEMPT. The function filters these out entirely
 *                       (notes_played > 0), so they cannot break a streak there
 *                       and must not break a rung here. A playback test with no
 *                       keyboard leaves the ladder exactly where it was.
 *   accuracy < bar,   → a failed attempt. It resets a consecutive rung to zero
 *   or unmeasurable     and leaves a cumulative one alone (§6.3). An accuracy of
 *   with notes played   null means unmeasured, which is not "good enough", and in
 *                       the database it is a non-qualifying attempt that breaks a
 *                       streak — so it breaks one here too.
 *   accuracy >= bar   → qualifies; the rung's counter goes up.
 *
 * A completed ladder keeps looping at target tempo and stops laddering (§6.5):
 * later passes are still recorded, still marked with the last rung.
 */
export function applyPass(state, { playthrough, itemAccuracyTarget } = {}) {
  if (!state) return { state, pass: null, outcome: "ignored" };
  const rung = state.ladder[state.rung];
  const pass = { warmupRung: state.rung + 1, warmupTargetPercent: rung.target_percent };

  const notesPlayed = playthrough?.notesPlayed ?? 0;
  if (notesPlayed <= 0) return { state, pass, outcome: "ignored" };
  if (state.complete) return { state, pass, outcome: "after-complete" };

  const accuracy = accuracyOf(playthrough);
  const bar = rungAccuracyTarget(rung, itemAccuracyTarget);
  const qualifies = Number.isFinite(accuracy) && accuracy >= bar;

  const counts = state.counts.slice();
  let fails = state.fails;
  if (qualifies) {
    counts[state.rung] += 1;
    fails = 0;
  } else {
    if (rung.consecutive) counts[state.rung] = 0;
    fails += 1;
  }

  // §6.4: the counter reaching target_passes is the advance. The completed
  // rung's count STAYS at its target, so the strip keeps showing it filled.
  if (counts[state.rung] >= rung.target_passes) {
    const isLast = state.rung === state.ladder.length - 1;
    return isLast
      ? { state: { ...state, counts, fails: 0, complete: true }, pass, outcome: "completed" }
      : { state: { ...state, counts, rung: state.rung + 1, fails: 0 }, pass, outcome: "advanced" };
  }

  return { state: { ...state, counts, fails }, pass, outcome: qualifies ? "credited" : "failed" };
}

/** Whether the current rung has earned the §6.7 suggestion. */
export function shouldSuggestEasier(state) {
  return !!state && !state.complete && state.fails >= FAILS_BEFORE_SUGGESTION;
}

/**
 * The strip, as data (§7.2). One group per rung: its percent, how many marks to
 * draw, how many are filled, and whether it is done, current or still to come.
 */
export function stripModel(state) {
  if (!state) return [];
  return state.ladder.map((rung, i) => ({
    percent: rung.target_percent,
    target: rung.target_passes,
    filled: Math.min(state.counts[i], rung.target_passes),
    consecutive: !!rung.consecutive,
    state: state.complete || i < state.rung ? "done" : i === state.rung ? "current" : "todo",
  }));
}

/** "50% → 70% → 100%" — the ladder as one line, for the plan line (§7.3). */
export function ladderSummaryText(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) return "";
  return ladder.map((r) => `${r.target_percent}%`).join(" → ");
}

/** "rung 2 of 3", or "complete" — for a warm-up item's plan line (§7.3). */
export function rungProgressText(state) {
  if (!state) return "";
  if (state.complete) return "warm-up complete";
  return `rung ${state.rung + 1} of ${state.ladder.length}`;
}
