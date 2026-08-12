// Round-trip proof for the song export format.
//
// The interesting claim is not "buildSongExport emits some keys" — it is that
// export → import → recompile returns exactly what went in. So this suite runs
// the REAL write path (fanOutMeasures, importLyrics, importMusicxmlFingerings,
// recompileMeasures) against an in-memory stand-in for Supabase, and diffs the
// result against the original song.

import { buildSongExport, SONG_EXPORT_FORMAT_VERSION } from "./songExport";
import { fifthsFromKeyLabel } from "./keySignature";
import { validateSongDocument } from "./songSchema";
import { fanOutMeasures, recompileMeasures } from "./measureCompiler";

// --- in-memory Supabase --------------------------------------------------
// Enough of the query builder for the four functions under test: select /
// insert / delete / update, .eq, .not(col,'is',null), .order, and await.

let db;
const fakeSupabase = {
  from(table) {
    const st = { table, op: null, payload: null, eq: [], notNull: [], order: [] };
    const b = {
      select: () => ((st.op = "select"), b),
      insert: (rows) => ((st.op = "insert"), (st.payload = rows), b),
      delete: () => ((st.op = "delete"), b),
      update: (patch) => ((st.op = "update"), (st.payload = patch), b),
      eq: (c, v) => (st.eq.push([c, v]), b),
      not: (c) => (st.notNull.push(c), b),
      order: (c) => (st.order.push(c), b),
      single: () => b,
      then: (res, rej) => Promise.resolve().then(() => run(st)).then(res, rej),
    };
    return b;
  },
};

function matches(row, st) {
  return (
    st.eq.every(([c, v]) => row[c] === v) &&
    st.notNull.every((c) => row[c] !== null && row[c] !== undefined)
  );
}

function run(st) {
  const rows = (db[st.table] = db[st.table] || []);
  if (st.op === "insert") {
    rows.push(...(Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ ...r })));
    return { data: null, error: null };
  }
  if (st.op === "delete") {
    db[st.table] = rows.filter((r) => !matches(r, st));
    return { data: null, error: null };
  }
  if (st.op === "update") {
    for (const r of rows) if (matches(r, st)) Object.assign(r, st.payload);
    return { data: null, error: null };
  }
  const out = rows.filter((r) => matches(r, st));
  for (const c of [...st.order].reverse()) {
    out.sort((a, x) => (a[c] > x[c] ? 1 : a[c] < x[c] ? -1 : 0));
  }
  return { data: out, error: null };
}

jest.mock("../../supabaseClient", () => ({
  get supabase() {
    return global.__fakeSupabase;
  },
}));

// Imported after the mock so the sidecar writers pick it up.
const { importLyrics } = require("./lyricsApi");
const { importMusicxmlFingerings } = require("./fingeringsApi");

const SONG_ID = "11111111-1111-1111-1111-111111111111";

// A song built to hit every field that has ever been lost: a common-time
// symbol, a tuplet, a tie across a seam, a chord, a section label, a
// non-numeric printed measure number, an audio offset that is 0 (falsy but
// real), an offset that is genuinely null, an inline lyric injected by
// recompile, and fingerings from both sources at one coordinate.
function makeSong() {
  return {
    title: "Round Trip",
    artist: "Test",
    defaultBpm: 60,
    key: "Eb major",
    timeSignature: "4/4",
    sourceXmlPath: "user/song.musicxml",
    songType: "simplified",
    parentSongId: "22222222-2222-2222-2222-222222222222",
    difficultyTier: 3,
    generationNotes: { plan: "halve the LH" },
    measures: [
      {
        number: 1,
        rh: [
          { duration: "q", notes: [{ midi: 72, name: "C5" }], lyric: "in-" },
          { duration: "q", notes: [{ midi: 74, name: "D5", tie: "start" }] },
          { duration: "h", notes: [{ midi: 76, name: "E5" }] },
        ],
        lh: [{ duration: "w", notes: [{ midi: 48, name: "C3" }, { midi: 52, name: "E3" }] }],
        timeSignature: { beats: 4, beatType: 4, symbol: "common" },
        audioOffsetMs: 0,
        chord: "Cmaj7",
        section: "A",
        sourceMeasure: "X1",
      },
      {
        number: 2,
        rh: [
          { duration: "q", notes: [{ midi: 74, name: "D5", tie: "end" }] },
          { duration: "q", notes: [], },
          { duration: "8", notes: [{ midi: 76, name: "E5" }], tuplet: { actual: 3, normal: 2, position: "start" } },
          { duration: "8", notes: [{ midi: 77, name: "F5" }], tuplet: { actual: 3, normal: 2, position: "middle" } },
          { duration: "8", notes: [{ midi: 79, name: "G5" }], tuplet: { actual: 3, normal: 2, position: "end" } },
          { duration: "q", notes: [{ midi: 72, name: "C5" }] },
        ],
        lh: [{ duration: "w", notes: [] }],
        timeSignature: { beats: 4, beatType: 4 },
        // audioOffsetMs deliberately absent — must export as null.
      },
    ],
  };
}

const LYRICS = [
  { word_order: 1, syllable: "in-", measure_num: 1, rh_index: 0 },
  { word_order: 2, syllable: "side", measure_num: 2, rh_index: 0 },
  { word_order: 3, syllable: "unplaced", measure_num: null, rh_index: null },
];

const BY_COORD = {
  "1:0:0": {
    manual: { finger: 2, source: "manual" },
    musicxml: { finger: 3, source: "musicxml" },
  },
  "2:5:0": { manual: null, musicxml: { finger: 1, source: "musicxml" } },
};

beforeEach(() => {
  db = {};
  global.__fakeSupabase = fakeSupabase;
});

describe("buildSongExport", () => {
  test("keeps the pre-existing fields byte-identical and first", () => {
    const song = makeSong();
    const doc = buildSongExport({ song, fallbackBpm: 99 });
    expect(doc.title).toBe("Round Trip");
    expect(doc.artist).toBe("Test");
    expect(doc.defaultBpm).toBe(60);
    // Additive: the four original keys still lead the document.
    expect(Object.keys(doc).slice(0, 4)).toEqual([
      "formatVersion", "title", "artist", "defaultBpm",
    ]);
    expect(Object.keys(doc).at(-1)).toBe("measures");
    expect(doc.formatVersion).toBe(SONG_EXPORT_FORMAT_VERSION);
  });

  test("falls back to the live bpm exactly as before", () => {
    const doc = buildSongExport({ song: { ...makeSong(), defaultBpm: null }, fallbackBpm: 99 });
    expect(doc.defaultBpm).toBe(99);
  });

  test("emits absent song-level fields as null, never omitted", () => {
    const doc = buildSongExport({ song: { title: "Bare", measures: [] } });
    for (const k of ["artist", "key", "fifths", "timeSignature", "sourceXmlPath",
                     "songType", "parentSongId", "difficultyTier", "generationNotes"]) {
      expect(doc).toHaveProperty(k);
      expect(doc[k]).toBeNull();
    }
    expect(doc.lyrics).toEqual([]);
    expect(doc.fingerings).toEqual([]);
  });

  test("audioOffsetMs is present on every measure, null preserved, 0 preserved", () => {
    const doc = buildSongExport({ song: makeSong() });
    expect(doc.measures[0]).toHaveProperty("audioOffsetMs", 0);
    expect(doc.measures[1]).toHaveProperty("audioOffsetMs", null);
  });

  test("strips inline lyric without mutating player state", () => {
    const song = makeSong();
    const doc = buildSongExport({ song, lyricPlacements: LYRICS });
    expect(doc.measures[0].rh[0]).not.toHaveProperty("lyric");
    expect(doc.measures[0].rh[0].notes).toEqual([{ midi: 72, name: "C5" }]);
    // The live song object is untouched.
    expect(song.measures[0].rh[0].lyric).toBe("in-");
  });

  test("carries lyrics top-level, word_order verbatim, unplaced included", () => {
    const doc = buildSongExport({ song: makeSong(), lyricPlacements: LYRICS });
    expect(doc.lyrics).toEqual(LYRICS);
  });

  test("flattens both fingering sources at one coordinate", () => {
    const doc = buildSongExport({ song: makeSong(), fingeringsByCoord: BY_COORD });
    expect(doc.fingerings).toEqual([
      { measureNum: 1, rhIndex: 0, noteIndex: 0, finger: 2, source: "manual" },
      { measureNum: 1, rhIndex: 0, noteIndex: 0, finger: 3, source: "musicxml" },
      { measureNum: 2, rhIndex: 5, noteIndex: 0, finger: 1, source: "musicxml" },
    ]);
  });

  test("prefers parser fifths, else inverts the label, else null", () => {
    expect(buildSongExport({ song: { ...makeSong(), fifths: 2 } }).fifths).toBe(2);
    expect(buildSongExport({ song: makeSong() }).fifths).toBe(-3); // "Eb major"
    expect(buildSongExport({ song: { ...makeSong(), key: "A minor" } }).fifths).toBeNull();
  });

  test("the exported document passes the authoring schema", () => {
    const doc = buildSongExport({
      song: makeSong(), lyricPlacements: LYRICS, fingeringsByCoord: BY_COORD,
    });
    const { valid, errors } = validateSongDocument(doc);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });
});

describe("fifthsFromKeyLabel", () => {
  test("inverts every label the parser can emit", () => {
    expect(fifthsFromKeyLabel("C major")).toBe(0);
    expect(fifthsFromKeyLabel("Cb major")).toBe(-7);
    expect(fifthsFromKeyLabel("C# major")).toBe(7);
    expect(fifthsFromKeyLabel("  eb   MAJOR ")).toBe(-3);
  });
  test("never guesses", () => {
    for (const bad of ["A minor", "D dorian", "", null, undefined, 3, "H major"]) {
      expect(fifthsFromKeyLabel(bad)).toBeNull();
    }
  });
});

describe("export → import → recompile round trip", () => {
  async function roundTrip(song, lyricPlacements, fingeringsByCoord) {
    const doc = JSON.parse(
      JSON.stringify(buildSongExport({ song, lyricPlacements, fingeringsByCoord }))
    );
    await fanOutMeasures(SONG_ID, doc.measures, fakeSupabase);
    if (doc.lyrics.length) await importLyrics(SONG_ID, doc.lyrics);
    if (doc.fingerings.length) await importMusicxmlFingerings(SONG_ID, doc.fingerings);
    const measures = await recompileMeasures(SONG_ID, fakeSupabase);
    return { doc, measures };
  }

  test("measure count, time signatures, rh/lh events and offsets survive", async () => {
    const song = makeSong();
    const { measures } = await roundTrip(song, LYRICS, BY_COORD);

    expect(measures).toHaveLength(song.measures.length);

    for (let i = 0; i < song.measures.length; i++) {
      const before = song.measures[i];
      const after = measures[i];

      expect(after.number).toBe(before.number);
      expect(after.timeSignature.beats).toBe(before.timeSignature.beats);
      expect(after.timeSignature.beatType).toBe(before.timeSignature.beatType);

      // Pitches, durations, ties and tuplets, hand by hand.
      for (const hand of ["rh", "lh"]) {
        expect(after[hand]).toHaveLength(before[hand].length);
        for (let e = 0; e < before[hand].length; e++) {
          const b = before[hand][e];
          const a = after[hand][e];
          expect(a.duration).toBe(b.duration);
          expect(a.notes).toEqual(b.notes);
          expect(a.tuplet).toEqual(b.tuplet);
        }
      }

      // Null stays null, 0 stays 0 — the blob convention is "key absent when
      // null", so compare through ?? rather than by key presence.
      expect(after.audioOffsetMs ?? null).toBe(before.audioOffsetMs ?? null);
      expect(after.chord ?? null).toBe(before.chord ?? null);
      expect(after.section ?? null).toBe(before.section ?? null);
      expect(after.sourceMeasure ?? null).toBe(before.sourceMeasure ?? null);
    }
  });

  test("audio offsets land in the measure rows including the null", async () => {
    await roundTrip(makeSong(), LYRICS, BY_COORD);
    const rows = db.sam_song_measures.sort((a, b) => a.number - b.number);
    expect(rows.map((r) => r.audio_offset_ms ?? null)).toEqual([0, null]);
  });

  test("lyric rows round trip with word_order and unplaced state intact", async () => {
    await roundTrip(makeSong(), LYRICS, BY_COORD);
    const rows = db.sam_song_lyrics
      .sort((a, b) => a.word_order - b.word_order)
      .map(({ word_order, syllable, measure_num, rh_index }) => ({
        word_order, syllable, measure_num, rh_index,
      }));
    expect(rows).toEqual(LYRICS);
  });

  test("recompile re-injects the inline lyric it stripped on export", async () => {
    const { measures } = await roundTrip(makeSong(), LYRICS, BY_COORD);
    expect(measures[0].rh[0].lyric).toBe("in-");
    expect(measures[1].rh[0].lyric).toBe("side");
  });

  test("fingerings keep their source — manual does not become editorial", async () => {
    await roundTrip(makeSong(), LYRICS, BY_COORD);
    const rows = db.sam_song_fingerings
      .map(({ measure_num, rh_index, note_index, finger, source }) => ({
        measure_num, rh_index, note_index, finger, source,
      }))
      .sort((a, b) =>
        a.measure_num - b.measure_num || a.rh_index - b.rh_index ||
        a.source.localeCompare(b.source));
    expect(rows).toEqual([
      { measure_num: 1, rh_index: 0, note_index: 0, finger: 2, source: "manual" },
      { measure_num: 1, rh_index: 0, note_index: 0, finger: 3, source: "musicxml" },
      { measure_num: 2, rh_index: 5, note_index: 0, finger: 1, source: "musicxml" },
    ]);
  });

  test("a second export of the round-tripped song is byte-identical", async () => {
    const song = makeSong();
    const { doc, measures } = await roundTrip(song, LYRICS, BY_COORD);

    // Rebuild the song object the way SongLoader would after re-opening it.
    const reopened = {
      ...song,
      measures,
      // sourceXmlPath is NOT written by any import path — see the report.
      sourceXmlPath: null,
    };
    const again = buildSongExport({
      song: reopened,
      lyricPlacements: db.sam_song_lyrics,
      fingeringsByCoord: BY_COORD,
    });

    expect(again.lyrics).toEqual(doc.lyrics);
    expect(again.fingerings).toEqual(doc.fingerings);

    // The common-time symbol survives the rebuild — recompileMeasures now
    // reads it back out of the column fanOutMeasures wrote it to. Before that
    // fix a 𝄴 score silently became 4/4 on the first recompile and every
    // export after it was missing the symbol.
    expect(doc.measures[0].timeSignature).toEqual({ beats: 4, beatType: 4, symbol: "common" });
    expect(again.measures[0].timeSignature).toEqual({ beats: 4, beatType: 4, symbol: "common" });

    expect(again.measures).toEqual(doc.measures);
  });
});
