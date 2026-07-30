// MCP notation-authoring tools for SAM. Two tools, both tier 3:
//
//   create_sam_song      — insert an empty song row with `measures: []`.
//                          NO notation writes; append_sam_measures does that.
//   append_sam_measures  — append validated measures to an existing song's
//                          sam_song_measures rows. Continues numbering from
//                          max(number). Sets measures_edited_at and leaves
//                          measures_compiled_at NULL so the React app
//                          self-heals via isMeasuresStale() on next open.
//
// Platform contract (docs/technical-spec-platform-layer.md §7 + mcp-platform
// skill): database access ONLY via `ctx.db`. This file does NOT import a
// Supabase client. Every field the handlers read appears in the input
// schemas registered alongside these tools in mcp/index.ts.
//
// Validation uses the same JSON Schema React does (single source of truth
// at repo root; prebuild copies to _shared/). Semantic helpers (nameToMidi,
// eventBeats) are duplicated from src/sam/lib/songSchema.js — ~30 lines,
// stable, and the ESM-vs-Deno boundary rules out clean sharing at runtime.
// If either helper changes in the app, mirror it here.

import Ajv from "ajv";
import { defineTool, envelope } from "../platform.ts";
import schema from "../sam-drill-format.schema.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Ajv setup — compile the Measure sub-schema so append_sam_measures can
// validate each incoming measure individually rather than wrapping every
// batch in a synthetic full-document envelope.
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
// `Ajv.addSchema` registers the whole document once; then `getSchema(ref)`
// returns a compiled validator for the sub-schema we want.
ajv.addSchema(schema, schema.$id);
const validateMeasure = ajv.compile({
  $ref: `${schema.$id}#/definitions/Measure`,
});

// ---------------------------------------------------------------------------
// Semantic helpers — mirror src/sam/lib/songSchema.js. Duplicated
// intentionally; the JSON schema is what's actually shared. See file
// header.
// ---------------------------------------------------------------------------

const STEP_SEMITONES: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};
const ACCIDENTAL_ALTER: Record<string, number> = {
  "": 0, "#": 1, "b": -1, "##": 2, "bb": -2,
};
const NAME_RE = /^([A-G])(##|bb|#|b)?(-)?(\d)$/;
const DURATION_RE = /^(w|h|q|8|16|32)(d*)$/;
const BASE_BEATS: Record<string, number> = {
  w: 4, h: 2, q: 1, "8": 0.5, "16": 0.25, "32": 0.125,
};

function nameToMidi(name: string): number | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const step = STEP_SEMITONES[m[1]];
  const alter = ACCIDENTAL_ALTER[m[2] || ""];
  const octave = (m[3] ? -1 : 1) * parseInt(m[4], 10);
  return (octave + 1) * 12 + step + alter;
}

function eventBeats(evt: { duration?: string; tuplet?: { actual: number; normal: number } }): number | null {
  const m = DURATION_RE.exec(evt.duration || "");
  if (!m) return null;
  const base = BASE_BEATS[m[1]];
  const dots = m[2].length;
  let value = base;
  let add = base;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    value += add;
  }
  if (evt.tuplet) {
    value *= evt.tuplet.normal / evt.tuplet.actual;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Per-measure validation. Runs Ajv structural + midi/name + duration-sum.
// Returns an array of error strings; empty means valid.
// ---------------------------------------------------------------------------

interface Measure {
  timeSignature?: { beats: number; beatType: number };
  rh?: Array<{ duration: string; notes?: Array<{ midi: number; name: string }>; tuplet?: { actual: number; normal: number; position: string } }>;
  lh?: typeof Measure.prototype.rh; // deliberately loose — same shape as rh
  chord?: string;
  section?: string;
  audioOffsetMs?: number;
}

function validateOneMeasure(m: Measure, prefix: string): string[] {
  const errors: string[] = [];

  // Structural
  if (!validateMeasure(m)) {
    for (const e of (validateMeasure.errors || [])) {
      // Reword the two intentional-not clauses to match the React side.
      const s = e.schema as unknown;
      if (
        e.keyword === "not" &&
        s && typeof s === "object" &&
        Array.isArray((s as { required?: unknown[] }).required)
      ) {
        const req = (s as { required: string[] }).required;
        if (req.includes("beats")) {
          errors.push(`${prefix}${e.instancePath}: measure must not include \`beats[]\` — use rh[]/lh[] instead (legacy format, unsupported).`);
          continue;
        }
        if (req.includes("lyric")) {
          errors.push(`${prefix}${e.instancePath}: voice event must not include \`lyric\` — authored documents cannot carry inline lyrics.`);
          continue;
        }
      }
      errors.push(`${prefix}${e.instancePath || ""}: ${e.message}`);
    }
    // Structural failure — skip semantic checks; they may crash on malformed input.
    return errors;
  }

  // Semantic — midi/name agreement AND duration-sum per hand.
  const measureHasTuplet = (["rh", "lh"] as const).some((h) =>
    (m[h] || []).some((e) => e.tuplet)
  );

  for (const hand of ["rh", "lh"] as const) {
    const events = m[hand] || [];
    let handBeats = 0;

    for (let ei = 0; ei < events.length; ei++) {
      const evt = events[ei];
      for (let ni = 0; ni < (evt.notes || []).length; ni++) {
        const note = evt.notes![ni];
        const expected = nameToMidi(note.name);
        if (expected == null) {
          errors.push(`${prefix} ${hand}[${ei}].notes[${ni}]: unparseable name "${note.name}"`);
        } else if (expected !== note.midi) {
          errors.push(`${prefix} ${hand}[${ei}].notes[${ni}]: midi=${note.midi} does not agree with name="${note.name}" (expected midi=${expected}).`);
        }
      }
      const b = eventBeats(evt);
      if (b != null) handBeats += b;
    }

    if (!measureHasTuplet) {
      const ts = m.timeSignature!;
      const expected = (ts.beats / ts.beatType) * 4;
      if (Math.abs(handBeats - expected) > 0.001) {
        errors.push(`${prefix} ${hand}: durations sum to ${handBeats} beats but time signature ${ts.beats}/${ts.beatType} expects ${expected} beats.`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Per-call cap on measures. A drill or scale is single-digits; a full song
// import belongs in the paste UI. Truncation is surfaced via meta.truncated
// so the model knows it was cut, not silently dropped.
const MEASURES_CAP = 100;

// Mirror fanOutMeasures — the sam_song_measures table is bulk-writable up
// to a few hundred rows per insert; 500 is comfortable and matches the app.
const INSERT_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// create_sam_song — tier 3
// ---------------------------------------------------------------------------

export const createSamSongTool = defineTool({
  name: "create_sam_song",
  tier: 3,
  handler: async (args: Record<string, unknown>, ctx) => {
    const title = args.title as string | undefined;
    const songType = args.songType as string | undefined;
    if (!title) throw new Error("create_sam_song: `title` is required.");
    if (!songType) throw new Error("create_sam_song: `songType` is required (original|simplified|drill).");
    if (!["original", "simplified", "drill"].includes(songType)) {
      throw new Error(`create_sam_song: invalid songType "${songType}"; must be original|simplified|drill.`);
    }

    // Lineage sanity per spec §3 (simplified ⇒ parent required).
    const parentSongId = (args.parentSongId as string | null | undefined) || null;
    if (songType === "simplified" && !parentSongId) {
      throw new Error("create_sam_song: songType='simplified' requires a parentSongId.");
    }

    const record = {
      title,
      artist: (args.artist as string | null | undefined) || null,
      song_type: songType,
      parent_song_id: parentSongId,
      difficulty_tier: (args.difficultyTier as number | null | undefined) ?? null,
      generation_notes: (args.generationNotes as Record<string, unknown> | null | undefined) || null,
      key_signature: (args.key as string | null | undefined) || null,
      time_signature: (args.timeSignature as string | null | undefined) || "4/4",
      default_bpm: (args.defaultBpm as number | null | undefined) || 68,
      // measures is NOT NULL; empty array is the correct initial value.
      // measures_compiled_at stays null — no fan-out has happened yet.
      measures: [],
      source: "mcp_create",
    };

    const { data, error } = await ctx.db
      .from("sam_songs")
      .insert(record)
      .select("id, title, song_type, parent_song_id")
      .single();
    if (error) throw new Error(`create_sam_song: ${error.message}`);
    return data;
  },
});

// ---------------------------------------------------------------------------
// append_sam_measures — tier 3
// ---------------------------------------------------------------------------

export const appendSamMeasuresTool = defineTool({
  name: "append_sam_measures",
  tier: 3,
  handler: async (args: Record<string, unknown>, ctx) => {
    const songId = args.songId as string | undefined;
    const measures = args.measures as Measure[] | undefined;
    if (!songId) throw new Error("append_sam_measures: `songId` is required.");
    if (!Array.isArray(measures) || measures.length === 0) {
      throw new Error("append_sam_measures: `measures` must be a non-empty array.");
    }

    // Cap first — truncation is surfaced via meta so the model knows the
    // request was cut. Never silently drop.
    const truncated = measures.length > MEASURES_CAP;
    const toWrite = truncated ? measures.slice(0, MEASURES_CAP) : measures;

    // Validate ALL measures BEFORE writing anything. Reject the whole batch
    // on any failure; the caller gets one error message with every problem
    // to fix in one pass rather than iterating.
    const errors: string[] = [];
    for (let i = 0; i < toWrite.length; i++) {
      errors.push(...validateOneMeasure(toWrite[i], `measures[${i}]`));
    }
    if (errors.length > 0) {
      // Cap at ~20 lines so the terminal message is readable; the count in
      // the header tells the caller if there was more.
      const shown = errors.slice(0, 20);
      const more = errors.length - shown.length;
      throw new Error(
        `append_sam_measures: ${errors.length} validation error(s). No rows written. Fix these and re-invoke:\n` +
          shown.join("\n") +
          (more > 0 ? `\n(+${more} more)` : "")
      );
    }

    // Continue numbering from max(number) for this song.
    const { data: maxRow, error: maxErr } = await ctx.db
      .from("sam_song_measures")
      .select("number")
      .eq("song_id", songId)
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw new Error(`append_sam_measures: max(number) lookup failed: ${maxErr.message}`);
    const startNumber = ((maxRow?.number as number | undefined) ?? 0) + 1;

    // Build rows. Same shape as measureCompiler.fanOutMeasures — `?? []`
    // preserves intentional silent-hand `[]`; time_signature has a real
    // fallback so NOT NULL is satisfied even if a measure omits it.
    const rows = toWrite.map((m, i) => ({
      song_id: songId,
      number: startNumber + i,
      rh: m.rh ?? [],
      lh: m.lh ?? [],
      time_signature: m.timeSignature
        ? {
            beats: m.timeSignature.beats,
            beatType: m.timeSignature.beatType,
          }
        : { beats: 4, beatType: 4 },
      ...(m.audioOffsetMs != null ? { audio_offset_ms: m.audioOffsetMs } : {}),
      ...(m.chord != null ? { chord: m.chord } : {}),
      ...(m.section != null ? { section: m.section } : {}),
    }));

    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
      const { error } = await ctx.db.from("sam_song_measures").insert(batch);
      if (error) throw new Error(`append_sam_measures: batch insert (rows ${i}-${i + batch.length - 1}) failed: ${error.message}`);
    }

    // Set measures_edited_at, leave measures_compiled_at UNTOUCHED — this
    // is the whole self-healing story. isMeasuresStale() returns true when
    // edited_at > compiled_at (or compiled_at is null), so the React app
    // recompiles the blob from rows on next handleLoadFromLibrary. The
    // tool never touches the blob directly.
    const { error: updateErr } = await ctx.db
      .from("sam_songs")
      .update({ measures_edited_at: new Date().toISOString() })
      .eq("id", songId);
    if (updateErr) throw new Error(`append_sam_measures: measures_edited_at update failed: ${updateErr.message}`);

    const result = {
      appended: toWrite.length,
      first_number: startNumber,
      last_number: startNumber + toWrite.length - 1,
    };
    // Envelope with truncation meta. runToolForMcp prepends the "N of M"
    // NOTE block when meta.truncated is set.
    return envelope(result, {
      truncated,
      ...(truncated ? { total: measures.length } : {}),
    });
  },
});
