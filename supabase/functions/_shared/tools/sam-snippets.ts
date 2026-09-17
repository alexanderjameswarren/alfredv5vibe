// ============================================================================
// supabase/functions/_shared/tools/sam-snippets.ts
//
// create_sam_snippet — tier 1. Find or create the SAM snippet for a measure
// range, exactly as the app's Save New / Play does (src/sam/lib/snippetsApi.js
// `ensureSnippetSaved`), so a snippet made here is indistinguishable from one
// made in the app. Its id is what create_sam_practice_plan takes as snippet_id.
//
// What the app writes, and so what this writes: song_id, title,
// start_measure, end_measure, rest_measures, and settings = { handMode }.
// Everything else (id, user_id, archived, tags, notes, timestamps) takes the
// column defaults. Tempo, timing window and chord grouping are never stored on
// a snippet: playing one always uses the song's own defaults.
//
// There is no uniqueness constraint in the database. Duplicates are prevented
// only by matching first, with the app's identity rule, archived rows included.
//
// Database access ONLY through ctx.db (platform contract).
// ============================================================================

import { defineTool } from "../platform.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const HAND_MODES = ["both", "lh", "rh"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNIPPET_COLS = "id, song_id, title, start_measure, end_measure, rest_measures, settings, archived, created_at";

/**
 * PORT of formatSnippetTitle in src/sam/lib/snippetsApi.js — the Edge Function
 * cannot import that file (it imports the browser Supabase client). Keep the
 * two identical: sam-snippets.test.mjs runs the app's own function against this
 * one and fails on any difference.
 */
export function formatSnippetTitle(
  { startMeasure, endMeasure, handMode, restMeasures }:
    { startMeasure: number; endMeasure: number; handMode?: string; restMeasures?: number },
): string {
  const handLabel =
    handMode === "lh" ? "LH" :
    handMode === "rh" ? "RH" : "Both";
  const restLabel = (restMeasures ?? 0) > 0 ? `Rest: ${restMeasures}` : "No Rest";
  return `Measures ${startMeasure}-${endMeasure} ${handLabel} ${restLabel}`;
}

/** The app's identity rule: a row as the four properties that define it. */
function identityOfRow(row: Row) {
  return {
    start: row.start_measure,
    end: row.end_measure,
    rest: row.rest_measures ?? 0,
    hand: row.settings?.handMode || "both",
  };
}

/**
 * The saved row for this identity, or null. A live row wins over an archived
 * one — the app's `findMatchingSnippet`, including its preference.
 */
export function findMatchingSnippet(
  rows: Row[],
  want: { start: number; end: number; rest: number; hand: string },
): Row | null {
  const matches = rows.filter((r) => {
    const id = identityOfRow(r);
    return id.start === want.start && id.end === want.end && id.rest === want.rest && id.hand === want.hand;
  });
  return matches.find((r) => !r.archived) || matches[0] || null;
}

function fail(message: string): Error {
  return new Error(`create_sam_snippet: ${message}`);
}

function dbFail(what: string, error: { message?: string; code?: string }): Error {
  return fail(`${what} failed: ${error.message ?? "(no message)"}${error.code ? ` [${error.code}]` : ""}`);
}

function wholeNumber(name: string, v: unknown, min: number): number {
  if (!Number.isInteger(v) || (v as number) < min) {
    throw fail(`\`${name}\` must be a whole number of ${min} or more, got ${JSON.stringify(v)}.`);
  }
  return v as number;
}

/** The snippet as this tool returns it: id first. */
function view(row: Row, flags: { created: boolean; restored: boolean }) {
  return {
    id: row.id,
    song_id: row.song_id,
    title: row.title,
    start_measure: row.start_measure,
    end_measure: row.end_measure,
    rest_measures: row.rest_measures ?? 0,
    hand_mode: row.settings?.handMode || "both",
    archived: row.archived ?? false,
    created_at: row.created_at,
    created: flags.created,
    restored: flags.restored,
  };
}

export const createSamSnippetTool = defineTool({
  name: "create_sam_snippet",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    // --- arguments -------------------------------------------------------------
    const songId = args.song_id;
    if (typeof songId !== "string" || !UUID_RE.test(songId)) {
      throw fail(`\`song_id\` must be a UUID, got ${JSON.stringify(songId)}.`);
    }
    const start = wholeNumber("start_measure", args.start_measure, 1);
    const end = wholeNumber("end_measure", args.end_measure, 1);
    if (end < start) {
      throw fail(`\`end_measure\` (${end}) must not be before \`start_measure\` (${start}).`);
    }
    const hand = args.hand_mode ?? "both";
    if (typeof hand !== "string" || !HAND_MODES.includes(hand)) {
      throw fail(`\`hand_mode\` must be one of ${HAND_MODES.join(" | ")}, got ${JSON.stringify(args.hand_mode)}.`);
    }
    const rest = args.rest_measures === undefined || args.rest_measures === null
      ? 0
      : wholeNumber("rest_measures", args.rest_measures, 0);

    // --- the song ----------------------------------------------------------------
    const { data: song, error: songErr } = await ctx.db
      .from("sam_songs").select("id, title, archived").eq("id", songId).maybeSingle();
    if (songErr) throw dbFail("song lookup", songErr);
    if (!song) throw fail(`song ${songId} not found.`);
    if (song.archived) throw fail(`"${song.title}" is archived; restore it before adding snippets.`);

    const { data: last, error: lastErr } = await ctx.db
      .from("sam_song_measures").select("number").eq("song_id", songId)
      .order("number", { ascending: false }).limit(1).maybeSingle();
    if (lastErr) throw dbFail("measure count lookup", lastErr);
    if (!last) throw fail(`"${song.title}" has no measures, so it has no range to make a snippet from.`);
    if (end > last.number) {
      throw fail(`\`end_measure\` (${end}) is past the last measure of "${song.title}" (${last.number}). ` +
        "Measure numbers are played numbers, with repeats written out.");
    }

    // --- match first (archived included), exactly as the app does ----------------
    const { data: rows, error: findErr } = await ctx.db
      .from("sam_snippets").select(SNIPPET_COLS)
      .eq("song_id", songId).eq("start_measure", start).eq("end_measure", end);
    if (findErr) throw dbFail("snippet lookup", findErr);
    const match = findMatchingSnippet((rows ?? []) as Row[], { start, end, rest, hand });

    if (match && !match.archived) {
      return view(match, { created: false, restored: false });
    }

    if (match) {
      // Restore rather than duplicate: the id is what every existing pass and
      // session references. created_at is left alone.
      const { data: restoredRow, error: restoreErr } = await ctx.db
        .from("sam_snippets").update({ archived: false }).eq("id", match.id)
        .select(SNIPPET_COLS).single();
      if (restoreErr) throw dbFail("snippet restore", restoreErr);
      return view(restoredRow, { created: false, restored: true });
    }

    const { data: inserted, error: insertErr } = await ctx.db
      .from("sam_snippets")
      .insert({
        song_id: songId,
        title: formatSnippetTitle({ startMeasure: start, endMeasure: end, handMode: hand, restMeasures: rest }),
        start_measure: start,
        end_measure: end,
        rest_measures: rest,
        settings: { handMode: hand },
      })
      .select(SNIPPET_COLS)
      .single();
    if (insertErr) throw dbFail("snippet insert", insertErr);
    return view(inserted, { created: true, restored: false });
  },
});
