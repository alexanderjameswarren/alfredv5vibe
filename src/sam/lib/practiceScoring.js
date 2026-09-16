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

// Whether a chord result adds to the on-screen Hits or Misses counter. Only a
// full hit is a Hit, matching `sam_passes.hits`; a partial is neither (it is
// still recorded as a partial in the session counters and summary).
export function onScreenTally(result) {
  if (result === "hit") return "hit";
  if (result === "partial") return null;
  return "miss";
}
