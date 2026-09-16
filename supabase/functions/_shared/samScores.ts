// SAM difficulty scores — compute one song's rows and store them (M4).
//
// Spec: docs/technical-spec-analyzer-port.md §4 M4.
//
// No Supabase import: the caller hands in its client (the sam-scores Edge
// Function builds one from the caller's JWT; an MCP tool would pass ctx.db),
// so RLS always confines the work to the caller's own songs.
//
// ORDER IS THE POINT:
//   1. freshness — one RPC, reads sam_songs and sam_song_scores only. If the
//      stored rows carry SCORES_VERSION and were computed from the song's
//      current measures_edited_at, return at once. NOT ONE measure row is
//      read. Lyric placement stamps measures_edited_at per syllable, so this
//      path runs hundreds of times in a session and must stay one call.
//   2. only when stale: read the song's key label and its measures, run the
//      tempo-free analyzer, and replace the rows in one transaction.
//
// No tempo anywhere. Stored rows are tempo-independent facts
// (analyzeSongFacts); notes-per-second and flags are derived on read. If this
// file ever seems to need a bpm, that is a design error, not a missing
// parameter.

import { analyzeSongFacts } from "./analyze.ts";
import type { Measure, MeasureFacts } from "./analyze.ts";
// The app's own key-label inversion, imported rather than copied — the same
// cross-tree import push-send already makes for vapidFingerprint.js. Exports
// of DB-loaded songs derive `fifths` through exactly this function, so the
// stored accidentals match the CLI run on an export.
import { fifthsFromKeyLabel } from "../../../src/sam/lib/keySignature.js";

/**
 * Version of the metric DEFINITIONS. Bump whenever measureFacts changes what a
 * number means; every stored row with an older version then reads as stale and
 * is recomputed on its next check.
 *   1 — the definitions at the analyzer port (analyzer-port, M2).
 */
export const SCORES_VERSION = 1;

/** Rows per page when reading measures (PostgREST caps a response at 1000). */
export const MEASURE_PAGE_SIZE = 1000;

// The slice of a supabase-js client this module uses. A SupabaseClient
// satisfies it; tests pass a fake.
// deno-lint-ignore no-explicit-any
type Query = any;
export interface ScoresDb {
  from(table: string): Query;
  rpc(fn: string, args: Record<string, unknown>): Query;
}

export class SongNotFoundError extends Error {
  constructor(songId: string) {
    super(`song ${songId} not found`);
    this.name = "SongNotFoundError";
  }
}

export type ComputeStatus =
  | "fresh"       // stored rows are current; nothing read, nothing written
  | "computed"    // rows replaced
  | "no-measures" // the song has no measures and no stored rows; nothing written
  | "cleared";    // the song has no measures; its old rows were removed

export interface ComputeResult {
  song_id: string;
  status: ComputeStatus;
  scores_version: number;
  computed_from_edited_at: string | null;
  measures_read: number;
  rows_written: number;
}

/** One sam_song_scores row, as sent to replace_sam_song_scores. */
export interface ScoreRow {
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

/** Analyzer facts -> table columns. The only place the mapping lives. */
export function toScoreRow(f: MeasureFacts): ScoreRow {
  return {
    measure_number: f.number,
    beats: f.beats,
    rh_onsets: f.rhOnsets,
    lh_onsets: f.lhOnsets,
    rh_stack: f.rhStack,
    lh_stack: f.lhStack,
    rh_stretch: f.rhStretch,
    lh_stretch: f.lhStretch,
    rh_jump: f.rhJump,
    lh_jump: f.lhJump,
    rhythm_variety: f.rhythmVariety,
    accidentals: f.accidentals,
  };
}

/** A sam_song_measures row, as selected below. */
export interface MeasureRow {
  number: number;
  rh: Measure["rh"];
  lh: Measure["lh"];
  time_signature: Measure["timeSignature"];
  source_measure: string | null;
}

/**
 * The analyzer document for a song read from the database — the same shape an
 * export of that song has: measures in played order, and `fifths` recovered
 * from the stored key label (DB-loaded songs carry no fifths integer).
 */
export function documentFromRows(
  song: { title: string | null; key_signature: string | null },
  rows: MeasureRow[],
) {
  return {
    title: song.title,
    key: song.key_signature,
    fifths: fifthsFromKeyLabel(song.key_signature),
    measures: rows.map((r): Measure => ({
      number: r.number,
      sourceMeasure: r.source_measure,
      timeSignature: r.time_signature,
      rh: r.rh,
      lh: r.lh,
    })),
  };
}

async function readMeasures(db: ScoresDb, songId: string, pageSize: number): Promise<MeasureRow[]> {
  const rows: MeasureRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("sam_song_measures")
      .select("number, rh, lh, time_signature, source_measure")
      .eq("song_id", songId)
      .order("number", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`sam_song_measures: ${error.message}`);
    const page = (data ?? []) as MeasureRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/**
 * Bring one song's stored scores up to date. Cheap when they already are.
 *
 * @throws SongNotFoundError when the caller cannot see the song
 */
export async function computeSongScores(
  db: ScoresDb,
  songId: string,
  { pageSize = MEASURE_PAGE_SIZE }: { pageSize?: number } = {},
): Promise<ComputeResult> {
  // 1. Freshness first. Nothing below runs for a current song.
  const { data: stateRows, error: stateError } = await db.rpc("sam_song_scores_freshness", {
    p_song_id: songId,
    p_scores_version: SCORES_VERSION,
  });
  if (stateError) throw new Error(`sam_song_scores_freshness: ${stateError.message}`);
  const state = Array.isArray(stateRows) ? stateRows[0] : stateRows;
  if (!state) throw new SongNotFoundError(songId);

  // Kept as the string PostgREST returned (microsecond precision) and passed
  // back verbatim, so the stored stamp equals the song's exactly.
  const editedAt: string | null = state.measures_edited_at ?? null;
  const result = (status: ComputeStatus, measuresRead: number, rowsWritten: number): ComputeResult => ({
    song_id: songId,
    status,
    scores_version: SCORES_VERSION,
    computed_from_edited_at: editedAt,
    measures_read: measuresRead,
    rows_written: rowsWritten,
  });

  if (state.fresh === true) return result("fresh", 0, 0);

  // 2. Stale (or never computed): read, analyze, replace.
  const { data: song, error: songError } = await db
    .from("sam_songs")
    .select("title, key_signature")
    .eq("id", songId)
    .maybeSingle();
  if (songError) throw new Error(`sam_songs: ${songError.message}`);
  if (!song) throw new SongNotFoundError(songId);

  const measureRows = await readMeasures(db, songId, pageSize);

  if (measureRows.length === 0 && Number(state.stored_rows ?? 0) === 0) {
    return result("no-measures", 0, 0);
  }

  const facts = analyzeSongFacts(documentFromRows(song, measureRows));
  const rows = facts.measures.map(toScoreRow);

  const { data: written, error: writeError } = await db.rpc("replace_sam_song_scores", {
    p_song_id: songId,
    p_scores_version: SCORES_VERSION,
    p_computed_from: editedAt,
    p_rows: rows,
  });
  if (writeError) throw new Error(`replace_sam_song_scores: ${writeError.message}`);

  return result(
    measureRows.length === 0 ? "cleared" : "computed",
    measureRows.length,
    Number(written ?? rows.length),
  );
}
