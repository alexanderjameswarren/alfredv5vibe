// Builds the song-export document written by the download button.
//
// Goal: the exported JSON is a COMPLETE representation of a song — everything
// needed to reconstruct it exactly, with nothing left behind in the database.
// The score-simplification pipeline reads an export, transforms it, and
// re-imports the result; any field missing here is silently lost on every
// generated version.
//
// Rules this file exists to enforce:
//
//   * ADDITIVE ONLY. title / artist / defaultBpm / measures keep their exact
//     prior shape and relative order, so every pre-existing consumer of an
//     unversioned export keeps working.
//   * NULLS ARE DATA. A field a song does not have is emitted as null, never
//     omitted — a reader must be able to tell "no value" from "key absent
//     because the exporter was older". audioOffsetMs in particular is emitted
//     on every measure, null included, because the blob only carries the key
//     when a value exists.
//   * NO INLINE LYRICS. recompileMeasures injects `lyric` onto rh events, but
//     the authoring schema rejects an inline lyric (it would vanish on the
//     next recompile), so an export carrying them could not be re-imported.
//     They are stripped here and re-emitted as the top-level `lyrics` array in
//     sam_song_lyrics's own shape, which the import path writes back verbatim.
//
// Pure function, no I/O — the caller supplies the three live sources (song
// state, lyric placements, fingering coordinate map).

import { fifthsFromKeyLabel } from "./keySignature";

// 1 == the original unversioned export {title, artist, defaultBpm, measures}.
// 2 == this document: key/fifths, lineage, source path, lyrics, fingerings,
//      and always-present audioOffsetMs.
export const SONG_EXPORT_FORMAT_VERSION = 2;

// Drop the inline `lyric` key from a voice-event list. Both hands are cleaned:
// recompileMeasures only injects into rh, but the PARSER can attach a lyric to
// any voice event, and the schema's rejection is not hand-specific.
function stripInlineLyrics(events) {
  return events.map((evt) => {
    if (!evt || typeof evt !== "object" || !("lyric" in evt)) return evt;
    const { lyric, ...rest } = evt; // eslint-disable-line no-unused-vars
    return rest;
  });
}

// sam_song_lyrics rows, snake_case verbatim. Unplaced syllables (measure_num
// null) are included on purpose: they are real rows in the table, and dropping
// them would lose typed-but-unplaced lyric work on every round trip.
function normalizeLyrics(lyricPlacements) {
  return (lyricPlacements || [])
    .map((lp) => ({
      word_order: lp.word_order,
      syllable: lp.syllable,
      measure_num: lp.measure_num ?? null,
      rh_index: lp.rh_index ?? null,
    }))
    .sort((a, b) => a.word_order - b.word_order);
}

// Flatten useFingeringEditor's byCoord map — { "m:rh:ni": {manual, musicxml} }
// — into the parser's parallel-array shape plus `source`, which the import
// path preserves. A coordinate can legitimately hold BOTH a manual and a
// musicxml row; both are emitted, because that is what the table holds and
// clearing the manual override must be able to re-reveal the imported one.
function flattenFingerings(byCoord) {
  const rows = [];
  for (const [coordKey, entry] of Object.entries(byCoord || {})) {
    const [measureNum, rhIndex, noteIndex] = coordKey.split(":").map(Number);
    for (const source of ["manual", "musicxml"]) {
      const row = entry?.[source];
      if (!row || row.finger == null) continue;
      rows.push({ measureNum, rhIndex, noteIndex, finger: row.finger, source });
    }
  }
  rows.sort(
    (a, b) =>
      a.measureNum - b.measureNum ||
      a.rhIndex - b.rhIndex ||
      a.noteIndex - b.noteIndex ||
      a.source.localeCompare(b.source)
  );
  return rows;
}

/**
 * @param {object} args
 * @param {object} args.song - live song state (SongLoader's shape)
 * @param {Array|null} args.lyricPlacements - sam_song_lyrics rows, or null
 * @param {object|null} args.fingeringsByCoord - useFingeringEditor's byCoord
 * @param {number} [args.fallbackBpm] - used only when the song carries no
 *   defaultBpm, matching the pre-existing `song.defaultBpm || bpm.value`.
 * @returns {object} the export document
 */
export function buildSongExport({
  song,
  lyricPlacements = null,
  fingeringsByCoord = null,
  fallbackBpm = undefined,
}) {
  const measures = (song.measures || []).map((m) => {
    // Spread first so every pre-existing key keeps its position and value;
    // the assignments below either overwrite in place or append.
    const out = { ...m };
    if (Array.isArray(m.rh)) out.rh = stripInlineLyrics(m.rh);
    if (Array.isArray(m.lh)) out.lh = stripInlineLyrics(m.lh);
    out.audioOffsetMs = m.audioOffsetMs ?? null;
    return out;
  });

  return {
    formatVersion: SONG_EXPORT_FORMAT_VERSION,

    // --- pre-existing fields, unchanged shape and order -------------------
    title: song.title,
    artist: song.artist ?? null,
    defaultBpm: song.defaultBpm || fallbackBpm,

    // --- song-level additions ---------------------------------------------
    // `key` is the stored label, kept so commitImport's key_signature write is
    // unaffected. `fifths` is the authoritative value: preferred straight off
    // the song when it came from the parser, otherwise inverted from the
    // label, and null when the label is not one the parser could have emitted.
    key: song.key ?? null,
    fifths: song.fifths ?? fifthsFromKeyLabel(song.key),
    timeSignature: song.timeSignature ?? null,
    sourceXmlPath: song.sourceXmlPath ?? null,
    songType: song.songType ?? null,
    parentSongId: song.parentSongId ?? null,
    difficultyTier: song.difficultyTier ?? null,
    generationNotes: song.generationNotes ?? null,

    // Sidecar tables. Empty array (not null) when the song has none — zero
    // rows is a fact, not an absent field.
    lyrics: normalizeLyrics(lyricPlacements),
    fingerings: flattenFingerings(fingeringsByCoord),

    measures,
  };
}
