// Goal tempo on song creation — which goal columns an insert should carry.
//
// goal_bpm is deliberately separate from default_bpm: default_bpm is the tempo
// a song loads at and drifts whenever practice tempo is saved; goal_bpm only
// changes when deliberately edited. The database trigger
// sam_songs_fill_goal_tempo fills goal_bpm from default_bpm when an insert
// omits it, and that trigger is the ONLY place that copy happens on insert —
// the creation rule below never reads defaultBpm. (The Edit Song modal, at the
// bottom of this file, is the one deliberate exception: for an audio song the
// user edits a goal SPEED, and the goal BPM is by definition the calibrated
// default BPM being saved alongside it.)
//
// The rule, applied to one source document (an import file, or the MCP
// tool's args in the same camelCase shape):
//
//   1. The source names a goalBpm       -> use it, plus its goalPlaybackSpeed
//                                          when given (else the column default).
//   2. A simplified song with a parent,
//      and no goalBpm of its own        -> inherit the parent's goal PAIR.
//   3. Anything else (originals,
//      drills, a failed parent lookup)  -> omit both; the trigger decides.
//
// The two fields travel as a pair: a source that sets its own goalBpm never
// picks up the parent's speed. Drills never inherit, even with a parent — a
// drill bears no notational relationship to it.
//
// Mirrored in supabase/functions/_shared/tools/sam-authoring.ts for
// create_sam_song (Deno cannot import from src/). Keep the two in step.

const isSet = (v) => v !== undefined && v !== null;

/** Should this source take its goal from its parent? */
export function inheritsGoalTempo(doc) {
  return (
    doc?.songType === "simplified" &&
    Boolean(doc?.parentSongId) &&
    !isSet(doc?.goalBpm)
  );
}

/**
 * sam_songs insert fields for the goal tempo — possibly none.
 *
 * @param {object} doc - source document ({goalBpm?, goalPlaybackSpeed?, songType?, parentSongId?})
 * @param {{goal_bpm?: number, goal_playback_speed?: number}|null} parentGoal -
 *   the parent row's goal columns, already fetched; only consulted when
 *   `inheritsGoalTempo(doc)` is true
 * @returns {{goal_bpm?: number, goal_playback_speed?: number}}
 */
export function goalTempoInsertFields(doc, parentGoal = null) {
  if (isSet(doc?.goalBpm)) {
    return {
      goal_bpm: doc.goalBpm,
      ...(isSet(doc.goalPlaybackSpeed) ? { goal_playback_speed: doc.goalPlaybackSpeed } : {}),
    };
  }
  if (inheritsGoalTempo(doc) && isSet(parentGoal?.goal_bpm)) {
    return {
      goal_bpm: parentGoal.goal_bpm,
      ...(isSet(parentGoal.goal_playback_speed)
        ? { goal_playback_speed: parentGoal.goal_playback_speed }
        : {}),
    };
  }
  return {};
}

/**
 * The parent's goal columns when `doc` inherits them, else null.
 *
 * Never rejects: a parent that cannot be read (deleted, not yours, network)
 * falls back to rule 3 rather than failing the import.
 *
 * @param {object} doc
 * @param {object} supabase - an authenticated client
 */
export async function fetchParentGoalTempo(doc, supabase) {
  if (!inheritsGoalTempo(doc)) return null;
  try {
    const { data, error } = await supabase
      .from("sam_songs")
      .select("goal_bpm, goal_playback_speed")
      .eq("id", doc.parentSongId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (e) {
    console.warn("[Sam] Parent goal tempo lookup failed; the trigger will fill it:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Editing the goal (Edit Song modal).
//
// The goal field is required. A blank or bad value is an error the user must
// fix — never replaced with the default tempo, because goal_bpm is NOT NULL
// and a silent fallback would overwrite a deliberate goal with the practice
// tempo.
// ---------------------------------------------------------------------------

/**
 * Parse a goal input box: a positive whole number, or an error message.
 *
 * @param {string} text - raw input value
 * @returns {{value: number, error: null} | {value: null, error: string}}
 */
export function parseGoalInput(text) {
  const t = String(text ?? "").trim();
  if (t === "") return { value: null, error: "Required — enter a whole number above 0." };
  if (!/^\d+$/.test(t)) return { value: null, error: "Must be a whole number above 0." };
  const n = Number(t);
  if (!(n > 0)) return { value: null, error: "Must be a whole number above 0." };
  return { value: n, error: null };
}

/**
 * The tempo actually heard at the goal — mirrors the database's generated
 * goal_effective_bpm: round(goal_bpm * goal_playback_speed / 100).
 * Null when either input is not a positive number.
 */
export function heardGoalTempo(goalBpm, goalPlaybackSpeed) {
  if (!(goalBpm > 0) || !(goalPlaybackSpeed > 0)) return null;
  return Math.round((goalBpm * goalPlaybackSpeed) / 100);
}

/**
 * The goal pair the modal saves, from the one goal field it shows.
 *
 *   no audio : the field is Goal BPM   -> {goal_bpm: field, goal_playback_speed: 100}
 *   audio    : the field is Goal Speed -> {goal_bpm: defaultBpm, goal_playback_speed: field}
 *
 * With audio, default_bpm is the scroll-sync calibration, so the goal is
 * expressed as a speed of that calibrated tempo.
 *
 * @returns {{goal_bpm: number|null, goal_playback_speed: number|null, error: string|null}}
 */
export function goalFromEditor({ hasAudio, goalText, defaultBpm }) {
  const { value, error } = parseGoalInput(goalText);
  if (error) return { goal_bpm: null, goal_playback_speed: null, error };
  if (hasAudio) {
    return {
      goal_bpm: defaultBpm > 0 ? defaultBpm : null,
      goal_playback_speed: value,
      error: null,
    };
  }
  return { goal_bpm: value, goal_playback_speed: 100, error: null };
}
