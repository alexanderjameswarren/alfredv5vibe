// Recover the MusicXML `fifths` integer from a stored key-signature label.
//
// `sam_songs.key_signature` is TEXT holding a display label, not the integer
// the score actually carries. The parser reads <fifths> and then derives that
// label through a MAJOR-ONLY table (songParser.js KEY_NAMES) — which is why
// several songs report the wrong mode: a piece engraved in A minor has
// fifths=0 and gets stored as "C major". The MODE is unreliable. The fifths
// count behind it is not, because label-from-fifths is a pure function we can
// invert exactly.
//
// This table deliberately mirrors ONLY the 15 labels songParser can emit. A
// hand-typed "A minor", an MCP-authored "D dorian", or a typo returns null:
// an export must never guess a key signature it cannot prove. Callers should
// prefer a `fifths` value carried on the song object (fresh parser output)
// and fall back to this inversion only for DB-loaded songs, which have no
// stored integer.
//
// Kept out of songParser.js on purpose — the parser is frozen for this change.

const FIFTHS_BY_LABEL = {
  "cb major": -7,
  "gb major": -6,
  "db major": -5,
  "ab major": -4,
  "eb major": -3,
  "bb major": -2,
  "f major": -1,
  "c major": 0,
  "g major": 1,
  "d major": 2,
  "a major": 3,
  "e major": 4,
  "b major": 5,
  "f# major": 6,
  "c# major": 7,
};

/**
 * @param {string|null|undefined} label - e.g. "Eb major"
 * @returns {number|null} the fifths integer, or null when the label is not one
 *   the parser could have produced (never a guess).
 */
export function fifthsFromKeyLabel(label) {
  if (typeof label !== "string") return null;
  const key = label.trim().toLowerCase().replace(/\s+/g, " ");
  const fifths = FIFTHS_BY_LABEL[key];
  return fifths === undefined ? null : fifths;
}
