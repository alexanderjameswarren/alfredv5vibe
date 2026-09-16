// SAM difficulty scores — the read behind get_sam_song_scores (M5).
//
// Spec: docs/technical-spec-analyzer-port.md §4 M5. The MCP tool wrapper lives
// in _shared/tools/sam-scores.ts; this file is the logic, with the database
// client passed in (ctx.db) and no Supabase or platform import, so it can be
// tested directly.
//
// What a read does, in order:
//   1. validate arguments
//   2. read the song (title, goal_effective_bpm) and resolve the tempo —
//      before anything is written, so a tempo error costs nothing
//   3. bring the stored scores up to date (computeSongScores: one cheap call
//      when fresh, a recompute when stale). THIS IS A WRITE inside a get_*
//      tool — see the tool description; it only refreshes derived rows.
//   4. read the requested measure range, filters pushed into the query
//      before the limit
//   5. derive notes-per-second, the per-beat rates and the flags at the
//      resolved tempo (measureAtTempo — the analyzer's own derivation)
//   6. roll up over every ANALYZED measure; only then filter the returned
//      rows if flagged_only was asked for
//
// THE CAP. A whole-song read is this tool's normal case, so the default is the
// whole requested range, clamped to MAX_MEASURES (200; the longest song is
// 160). A truncated list says it is partial; a rollup over a fragment does not
// — its median, p90 and flagged list look like a whole-song answer. So the cap
// is set high enough that whole songs are never cut, and when it does bite the
// response names the range the rollup actually covers.

import { measureAtTempo, quantile, SUMMARY_METRICS, THRESHOLDS } from "./analyze.ts";
import type { MeasureAnalysis, MeasureFacts } from "./analyze.ts";
import { computeSongScores } from "./samScores.ts";
import type { ScoresDb } from "./samScores.ts";

/** Most measures one read analyzes. Longest song today: 160. */
export const MAX_MEASURES = 200;

export class SongScoresError extends Error {
  constructor(message: string) {
    super(`get_sam_song_scores: ${message}`);
    this.name = "SongScoresError";
  }
}

export interface SongScoresArgs {
  song_id?: unknown;
  start_measure?: unknown;
  end_measure?: unknown;
  bpm?: unknown;
  limit?: unknown;
  flagged_only?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";

function wholeNumber(name: string, v: unknown): number | undefined {
  if (!isSet(v)) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new SongScoresError(`${name} must be a whole number of 1 or more, got ${JSON.stringify(v)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

export type TempoSource = "argument" | "goal";

/** The bpm argument, validated; undefined when not given. */
function explicitBpm(v: unknown): number | undefined {
  if (!isSet(v)) return undefined;
  const bpm = Number(v);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new SongScoresError(`bpm must be a positive number, got ${JSON.stringify(v)}`);
  }
  return bpm;
}

/**
 * The tempo to derive notes-per-second and flags at, and where it came from.
 * Order: explicit `bpm` argument -> the song's goal_effective_bpm -> error.
 *
 * 🛑 NEVER goal_bpm, NEVER default_bpm.
 *   - default_bpm drifts: it is whatever the tempo box was last saved at, not
 *     a target.
 *   - goal_bpm is WRONG on songs with audio. There, default_bpm is the
 *     scroll-sync calibration, goal_bpm is forced equal to it, and the real
 *     goal is expressed through goal_playback_speed. Reading goal_bpm gives a
 *     plausible number that is wrong, and nothing errors.
 *   - goal_effective_bpm = round(goal_bpm * goal_playback_speed / 100) is the
 *     goal tempo actually heard, and is right for both kinds of song.
 * The song read below selects goal_effective_bpm and nothing else tempo-shaped,
 * so the wrong columns are not even available here.
 *
 * All tempos are quarter notes per minute (a 6/8 bar is 3 quarter beats).
 */
export function resolveTempo(
  bpmArg: unknown,
  song: { goal_effective_bpm?: number | null },
): { bpm: number; source: TempoSource } {
  const explicit = explicitBpm(bpmArg);
  if (explicit !== undefined) return { bpm: explicit, source: "argument" };
  const goal = song.goal_effective_bpm;
  if (typeof goal === "number" && Number.isFinite(goal) && goal > 0) {
    return { bpm: goal, source: "goal" };
  }
  // GUARDS A STATE THE DATABASE CURRENTLY PREVENTS — do not delete as dead
  // code. goal_bpm is NOT NULL and the sam_songs_fill_goal_tempo trigger fills
  // it on insert, so every live song has a goal_effective_bpm today. If that
  // ever stops being true (a nullable goal, a dropped trigger, a column
  // change), this is what stops the tool from inventing a tempo. Covered by
  // unit tests only, because no live song can reach it.
  throw new SongScoresError(
    "this song has no goal tempo and no bpm was given — pass bpm. Refusing to guess " +
      "(default_bpm is the load tempo, not a target).",
  );
}

// ---------------------------------------------------------------------------
// Rows and rollup
// ---------------------------------------------------------------------------

const SCORE_COLUMNS =
  "measure_number, beats, rh_onsets, lh_onsets, rh_stack, lh_stack, rh_stretch, lh_stretch, " +
  "rh_jump, lh_jump, rhythm_variety, accidentals";

interface StoredRow {
  measure_number: number;
  beats: number;
  rh_onsets: number;
  lh_onsets: number;
  rh_stack: number;
  lh_stack: number;
  rh_stretch: number;
  lh_stretch: number;
  rh_jump: number;
  lh_jump: number;
  rhythm_variety: number;
  accidentals: number | null;
}

/** Stored columns back into the analyzer's facts. */
export function factsFromRow(r: StoredRow): MeasureFacts {
  return {
    number: r.measure_number,
    sourceMeasure: null,
    beats: r.beats,
    rhOnsets: r.rh_onsets,
    lhOnsets: r.lh_onsets,
    rhStack: r.rh_stack,
    lhStack: r.lh_stack,
    rhStretch: r.rh_stretch,
    lhStretch: r.lh_stretch,
    rhJump: r.rh_jump,
    lhJump: r.lh_jump,
    rhythmVariety: r.rhythm_variety,
    accidentals: r.accidentals,
  };
}

/** Display rounding. Flags and the rollup are computed before rounding. */
const r2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100);

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * The lean row returned per measure. beats and the onset counts are left out:
 * they are the inputs to the rates returned here, and the stored rows keep them.
 */
export function leanRow(m: MeasureAnalysis) {
  return {
    measure: m.number,
    notes_per_second: r2(m.notesPerSecond),
    rh_notes_per_beat: r2(m.rhNotesPerBeat),
    lh_notes_per_beat: r2(m.lhNotesPerBeat),
    rh_stack: m.rhStack,
    lh_stack: m.lhStack,
    rh_stretch: m.rhStretch,
    lh_stretch: m.lhStretch,
    rh_jump: m.rhJump,
    lh_jump: m.lhJump,
    rhythm_variety: m.rhythmVariety,
    accidentals: m.accidentals,
    flags: m.flags,
  };
}

/** median / p90 / max per metric — the same computation as analyzeSong's summary. */
export function rollup(measures: MeasureAnalysis[]) {
  const metrics: Record<string, { median: number | null; p90: number | null; max: number | null }> = {};
  for (const [, key] of SUMMARY_METRICS) {
    const values = measures.map((m) => m[key]).filter((x) => x != null) as number[];
    metrics[snake(key)] = {
      median: r2(quantile(values, 0.5)),
      p90: r2(quantile(values, 0.9)),
      max: values.length ? r2(Math.max(...values)) : null,
    };
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export async function readSongScores(db: ScoresDb, args: SongScoresArgs) {
  // 1. Arguments.
  const songId = args.song_id;
  if (typeof songId !== "string" || !UUID.test(songId)) {
    throw new SongScoresError("song_id must be a UUID");
  }
  const start = wholeNumber("start_measure", args.start_measure);
  const end = wholeNumber("end_measure", args.end_measure);
  if (start !== undefined && end !== undefined && start > end) {
    throw new SongScoresError(`start_measure (${start}) is after end_measure (${end})`);
  }
  const requestedLimit = wholeNumber("limit", args.limit);
  const limit = Math.min(requestedLimit ?? MAX_MEASURES, MAX_MEASURES);
  if (isSet(args.flagged_only) && typeof args.flagged_only !== "boolean") {
    throw new SongScoresError("flagged_only must be true or false");
  }
  const flaggedOnly = args.flagged_only === true;
  explicitBpm(args.bpm); // a bad bpm fails here, before any call

  // 2. The song, and the tempo — before any write.
  const { data: song, error: songError } = await db
    .from("sam_songs")
    .select("id, title, goal_effective_bpm")
    .eq("id", songId)
    .maybeSingle();
  if (songError) throw new SongScoresError(`sam_songs: ${songError.message}`);
  if (!song) throw new SongScoresError(`song ${songId} not found`);
  const tempo = resolveTempo(args.bpm, song);

  // 3. Fresh scores. A write when stale — see the file header.
  const refresh = await computeSongScores(db, songId);

  // 4. The range. Every filter is applied in the query, before the limit, so
  //    the rows returned are exactly the first `limit` measures of the range
  //    — never a capped read filtered afterwards.
  let query = db
    .from("sam_song_scores")
    .select(SCORE_COLUMNS, { count: "exact" })
    .eq("song_id", songId);
  if (start !== undefined) query = query.gte("measure_number", start);
  if (end !== undefined) query = query.lte("measure_number", end);
  const { data: stored, count, error: rowsError } = await query
    .order("measure_number", { ascending: true })
    .limit(limit);
  if (rowsError) throw new SongScoresError(`sam_song_scores: ${rowsError.message}`);

  const rows = (stored ?? []) as StoredRow[];
  const total = typeof count === "number" ? count : rows.length;
  const truncated = total > rows.length;

  // 5. Tempo-dependent view, via the analyzer's own derivation.
  const analyzed = rows.map((r) => measureAtTempo(factsFromRow(r), tempo.bpm));
  const flagged = analyzed.filter((m) => m.flags.length > 0);
  const first = analyzed[0]?.number ?? null;
  const last = analyzed.at(-1)?.number ?? null;

  // 6. Roll up over everything analyzed; filter the rows only afterwards.
  const returned = flaggedOnly ? flagged : analyzed;

  const data = {
    song: { id: song.id, title: song.title },
    tempo: {
      bpm: tempo.bpm,
      source: tempo.source,
      note: tempo.source === "goal"
        ? "No bpm was given, so this is the song's goal tempo (goal_effective_bpm). notes_per_second and flags are at this tempo."
        : "The bpm argument. notes_per_second and flags are at this tempo.",
    },
    scores: {
      status: refresh.status === "computed" ? "recomputed" : refresh.status,
      scores_version: refresh.scores_version,
      computed_from_edited_at: refresh.computed_from_edited_at,
    },
    range: {
      requested: { start_measure: start ?? null, end_measure: end ?? null },
      measures_in_range: total,
      analyzed: { first_measure: first, last_measure: last, count: analyzed.length },
      truncated,
      ...(truncated
        ? {
            note:
              `Only measures ${first}–${last} of the ${total} in the requested range were analyzed ` +
              `(limit ${limit}). The rollup below describes THOSE measures, not the whole range. ` +
              `Ask again with start_measure=${(last ?? 0) + 1} for the rest.`,
          }
        : {}),
    },
    thresholds: {
      note: "A measure is flagged when a metric EXCEEDS its threshold. NS = notes_per_second, " +
        "LH = lh_notes_per_beat, STK = rh_stack, STR = rh_stretch, VAR = rhythm_variety.",
      notes_per_second: THRESHOLDS.notesPerSecond,
      lh_notes_per_beat: THRESHOLDS.lhNotesPerBeat,
      rh_stack: THRESHOLDS.rhStack,
      rh_stretch: THRESHOLDS.rhStretch,
      rhythm_variety: THRESHOLDS.rhythmVariety,
    },
    rollup: {
      covers: truncated
        ? `the ${analyzed.length} analyzed measures (${first}–${last}) — NOT the whole requested range`
        : `all ${analyzed.length} measures in the requested range`,
      metrics: rollup(analyzed),
      flagged_measures: flagged.map((m) => m.number),
      flagged_count: flagged.length,
    },
    rows: {
      filter: flaggedOnly ? "flagged_only" : "all",
      ...(flaggedOnly
        ? {
            note:
              `Only the ${flagged.length} flagged measures are listed. The rollup above still ` +
              `covers all ${analyzed.length} analyzed measures.`,
          }
        : {}),
      count: returned.length,
      measures: returned.map(leanRow),
    },
  };

  return {
    data,
    meta: { truncated, total, limit_applied: limit },
  };
}
