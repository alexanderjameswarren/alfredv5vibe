// Scoring rules shared by the live display and the stored session summary.
// Practice plans spec §7.1: what the screen shows must match what the
// database stores.

// Accuracy of a set of counters: hits against hits + misses. Partials sit
// outside the ratio.
//
// Null — not 0 — when nothing was measured: no MIDI note arrived
// (`notesPlayed` 0, e.g. playback with no keyboard, where ScrollEngine still
// raises a miss on every beat), or no beat was scored. This is the same rule as
// the generated column `sam_passes.accuracy_percent`:
//   null when notes_played = 0 or hits + misses = 0,
//   else round(hits * 100 / (hits + misses)).
// The division is done in that order (hits * 100 first) so the result rounds
// exactly as Postgres does; (hits / total) * 100 can land a hair under .5.
//
// A null accuracy means "unmeasured". Never display it as 0% and never count
// it as 0 in an average or a best-of.
export function accuracyOf({ hits = 0, misses = 0, notesPlayed = 0 } = {}) {
  const total = hits + misses;
  if (!notesPlayed || total === 0) return null;
  return Math.round((hits * 100) / total);
}

// Best of a list of accuracies, ignoring nulls. Null when none is measured.
export function bestAccuracy(values) {
  const measured = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  return measured.length ? Math.max(...measured) : null;
}

// "85%", or "—" when the accuracy is unmeasured (null or undefined).
export function formatAccuracy(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value}%` : "—";
}

// ONE PASS'S WORTH OF SCOREABLE BEATS, per hand mode — the denominator
// `bestAchievableAccuracy` needs, and the reason it can be known before a note
// is played.
//
// WHERE THE NUMBER COMES FROM. ScrollEngine builds the beat events for the
// loaded range the moment the score renders, long before Play, and hands them
// over through `onBeatEvents`. Two things about that list have to be handled
// here, and both are the reason this is not simply `events.length`:
//
//   1. It holds THREE COPIES of the range when looping (ScrollEngine renders
//      copies for a seamless wrap), so the same beat appears three times.
//      Counting distinct measure:beat keys collapses them back to one pass.
//   2. A beat with no notes in the ACTIVE HAND is never scored — ScrollEngine
//      marks it "skipped" and it raises no miss — so rests, and the other hand's
//      notes in LH/RH mode, must not be counted. That is also what makes rest
//      measures fall out on their own: they carry no notes.
//
// All three hands are counted in one pass over the list, so the answer does not
// go stale when the hand mode changes without the score re-rendering.
export function scoreableBeatsPerPass(events) {
  const seen = { both: new Set(), rh: new Set(), lh: new Set() };
  for (const e of events || []) {
    const key = `${e.meas}:${e.beat}`;
    if (e.allMidi?.length) seen.both.add(key);
    if (e.rhMidi?.length) seen.rh.add(key);
    if (e.lhMidi?.length) seen.lh.add(key);
  }
  return { both: seen.both.size, rh: seen.rh.size, lh: seen.lh.size };
}

// "met" | "short" | null — how a measured accuracy stands against the target it
// is being judged by. Null when there is no target, or nothing was measured; the
// readout then says nothing about a bar rather than guessing at one.
export function goalState(accuracyPercent, target) {
  if (!Number.isFinite(target) || !Number.isFinite(accuracyPercent)) return null;
  return accuracyPercent >= target ? "met" : "short";
}

// THE BEST ACCURACY THIS PASS CAN STILL REACH, with every remaining scoreable
// beat a hit. Null when it cannot be worked out.
//
// PARTIALS ARE THE CARE POINT. Accuracy is hits/(hits+misses) with partials
// OUTSIDE the ratio, so a partial does not count against him — it removes a beat
// from the denominator. A beat still to come can therefore land in one of three
// ways, and this takes the kindest: a hit lifts the ratio, a partial leaves it
// where it is, a miss lowers it. So `(hits + remaining) / (hits + remaining +
// misses)` is a true CEILING, not an estimate — no future beat can beat it.
//
// `scoreable` is one pass's worth of scoreable beats in the loaded range. Beats
// already played are counted out of it including partials, because a partial has
// been played: it is not still available to be a hit.
export function bestAchievableAccuracy({ hits = 0, misses = 0, partials = 0 } = {}, scoreable) {
  if (!Number.isFinite(scoreable) || scoreable <= 0) return null;
  const remaining = scoreable - hits - misses - partials;
  // More beats played than the range is supposed to hold: the count and reality
  // disagree, so this says nothing rather than something wrong.
  if (remaining < 0) return null;
  const willHit = hits + remaining;
  const total = willHit + misses;
  if (total === 0) return null;
  // Same order as accuracyOf, so the two round identically.
  return Math.round((willHit * 100) / total);
}

// Whether the target is out of reach for the pass in progress (warm-up spec §6,
// practice plans §7.1): worth saying, because finishing a pass that cannot
// qualify costs him the time of a whole playthrough.
//
// ERRS TOWARD SAYING NOTHING, deliberately. A false "give up" is much worse than
// a missed one, so it stays quiet whenever anything is unknown: no target, no
// beat count, nothing struck yet (an unmeasured pass is not a failing one — it is
// a pass with no keyboard attached), no misses yet, or a beat count that
// disagrees with what has been played. It also uses the ROUNDED ceiling, so a
// pass that can still round up to the target is not written off.
export function targetUnreachable(playthrough, { target, scoreable } = {}) {
  if (!Number.isFinite(target) || target <= 0) return false;
  if (!playthrough || !(playthrough.notesPlayed > 0)) return false;
  if (!(playthrough.misses > 0)) return false;
  const best = bestAchievableAccuracy(playthrough, scoreable);
  return best != null && best < target;
}

// Whether a chord result adds to the on-screen Hits or Misses counter. Only a
// full hit is a Hit, matching `sam_passes.hits`; a partial is neither (it is
// still recorded as a partial in the session counters and summary).
export function onScreenTally(result) {
  if (result === "hit") return "hit";
  if (result === "partial") return null;
  return "miss";
}
