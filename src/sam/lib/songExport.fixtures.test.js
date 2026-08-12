// Round-trip verification against the REAL scores behind the two songs named
// in the task — parsed from the same MusicXML that produced them in the
// database (sam_songs.source_xml_path points at these uploads):
//
//   La Candeur        b7bf882c-9256-48d5-9c0e-926e79744173  — 38 measures
//   Someone Like You  030333d9-1b9f-4f74-80fb-7fbed587fda6  — 82 measures
//
// This exercises everything the live round trip does except the network write:
// parser output → buildSongExport → schema validation → JSON → fanOutMeasures
// → sidecar writes → recompileMeasures → diff. Common time, ties, tuplets, a
// D.S. seam and real editorial fingerings all pass through unaltered inputs,
// so a regression here is a regression in the format.

import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { parseMusicXML } from "./songParser";
import { buildSongExport } from "./songExport";
import { validateSongDocument } from "./songSchema";
import { fanOutMeasures, recompileMeasures } from "./measureCompiler";

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
const { importMusicxmlFingerings } = require("./fingeringsApi");

const FIXTURES = path.join(__dirname, "..", "..", "..", "tools", "sam-tools", "fixtures");

async function readMxl(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, file)));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || name === "META-INF/container.xml") continue;
    if (/\.(musicxml|xml)$/i.test(name)) return entry.async("text");
  }
  throw new Error("no score in " + file);
}

// The blob convention is "omit the key when null", which is what a DB-loaded
// song looks like. Simulate that so the fixture matches production input.
function asStoredSong(parsed) {
  return {
    ...parsed,
    measures: parsed.measures.map((m) => {
      const out = { ...m };
      if (out.audioOffsetMs == null) delete out.audioOffsetMs;
      return out;
    }),
  };
}

const CASES = [
  { name: "La Candeur", file: "etude-in-c-major-la-candeur-op100-no-1-burgmuller.mxl", measures: 38 },
  { name: "Someone Like You", file: "someone-like-you-easy-piano.mxl", measures: 82 },
];

describe.each(CASES)("$name — real score round trip", ({ name, file, measures: expectedCount }) => {
  let song;
  let doc;
  let recompiled;

  beforeAll(async () => {
    db = {};
    global.__fakeSupabase = fakeSupabase;

    song = asStoredSong(parseMusicXML(await readMxl(file)));
    doc = JSON.parse(JSON.stringify(buildSongExport({ song, fallbackBpm: 68 })));

    const id = "00000000-0000-0000-0000-00000000000" + (name === "La Candeur" ? "1" : "2");
    await fanOutMeasures(id, doc.measures, fakeSupabase);
    if (doc.fingerings.length) await importMusicxmlFingerings(id, doc.fingerings);
    recompiled = await recompileMeasures(id, fakeSupabase);
  });

  test("parses to the measure count the database holds", () => {
    expect(song.measures).toHaveLength(expectedCount);
    expect(doc.measures).toHaveLength(expectedCount);
    expect(recompiled).toHaveLength(expectedCount);
  });

  test("the export validates against the authoring schema", () => {
    // Inline lyrics are what would have made this fail before the change:
    // the parser attaches them from <lyric>, and the schema rejects them.
    const { valid, errors } = validateSongDocument(doc);
    expect(errors.slice(0, 5)).toEqual([]);
    expect(valid).toBe(true);
  });

  // NOTE: neither of these two .mxl files contains a <lyric>, so this is a
  // regression guard, not proof that stripping works — it would pass on a
  // no-op exporter. The real coverage for inline-lyric stripping and
  // re-injection is the synthetic case in songExport.test.js, which asserts
  // both directions on a measure that actually carries one.
  test("no inline lyric survives into the export (guard — these scores have none)", () => {
    const inline = doc.measures.flatMap((m, i) =>
      [...(m.rh || []), ...(m.lh || [])]
        .filter((e) => "lyric" in e)
        .map(() => i + 1)
    );
    expect(inline).toEqual([]);
  });

  test("every measure carries an explicit audioOffsetMs", () => {
    for (const m of doc.measures) expect(m).toHaveProperty("audioOffsetMs");
    // Freshly parsed scores have no offsets — all null, none omitted.
    expect(doc.measures.every((m) => m.audioOffsetMs === null)).toBe(true);
  });

  test("fifths is the integer from the score, not a mode guess", () => {
    expect(doc.fifths).toBe(song.fifths);
    expect(Number.isInteger(doc.fifths)).toBe(true);
  });

  test("every measure's time signature survives the round trip, symbol included", () => {
    for (let i = 0; i < song.measures.length; i++) {
      // Whole object, so a dropped `symbol` fails here rather than needing a
      // separate guard. La Candeur is common-time on all 38 measures.
      expect(recompiled[i].timeSignature).toEqual(song.measures[i].timeSignature);
    }
    const rows = db.sam_song_measures.filter((r) => r.time_signature.symbol);
    const parsedWithSymbol = song.measures.filter((m) => m.timeSignature.symbol);
    expect(rows).toHaveLength(parsedWithSymbol.length);
  });

  test("every rh/lh event survives — pitches, durations, ties, tuplets", () => {
    const strip = (e) => {
      const { lyric, ...rest } = e; // eslint-disable-line no-unused-vars
      return rest;
    };
    for (let i = 0; i < song.measures.length; i++) {
      for (const hand of ["rh", "lh"]) {
        expect(recompiled[i][hand].map(strip)).toEqual((song.measures[i][hand] || []).map(strip));
      }
    }
  });

  test("audio offsets, chords, sections and printed numbers survive", () => {
    for (let i = 0; i < song.measures.length; i++) {
      const b = song.measures[i];
      const a = recompiled[i];
      expect(a.audioOffsetMs ?? null).toBe(b.audioOffsetMs ?? null);
      expect(a.chord ?? null).toBe(b.chord ?? null);
      expect(a.section ?? null).toBe(b.section ?? null);
      expect(String(a.sourceMeasure ?? "")).toBe(String(b.sourceMeasure ?? ""));
    }
  });

  test("editorial fingerings survive with their source intact", () => {
    expect(db.sam_song_fingerings || []).toHaveLength(doc.fingerings.length);
    for (const row of db.sam_song_fingerings || []) {
      expect(row.source).toBe("musicxml");
      expect(row.finger).toBeGreaterThanOrEqual(1);
      expect(row.finger).toBeLessThanOrEqual(5);
    }
  });
});

// Locks in the concrete shape of both scores. These are the numbers quoted in
// the change report; if the parser or the exporter shifts, this fails loudly
// rather than letting a silently different export ship.
describe.each([
  { name: "La Candeur", file: CASES[0].file, measures: 38, key: "C major", fifths: 0,
    tupletMeasures: 0, tiedEvents: 18, commonTimeMeasures: 38 },
  { name: "Someone Like You", file: CASES[1].file, measures: 82, key: "A major", fifths: 3,
    tupletMeasures: 16, tiedEvents: 229, commonTimeMeasures: 0 },
])("$name — locked shape", (exp) => {
  test("matches the recorded export shape", async () => {
    db = {};
    global.__fakeSupabase = fakeSupabase;
    const song = asStoredSong(parseMusicXML(await readMxl(exp.file)));
    const doc = JSON.parse(JSON.stringify(buildSongExport({ song, fallbackBpm: 68 })));

    const events = (m) => [...(m.rh || []), ...(m.lh || [])];
    expect({
      measures: doc.measures.length,
      key: doc.key,
      fifths: doc.fifths,
      tupletMeasures: doc.measures.filter((m) => events(m).some((e) => e.tuplet)).length,
      tiedEvents: doc.measures.reduce(
        (n, m) => n + events(m).filter((e) => (e.notes || []).some((x) => x.tie)).length, 0),
      commonTimeMeasures: doc.measures.filter((m) => m.timeSignature.symbol).length,
    }).toEqual({
      measures: exp.measures, key: exp.key, fifths: exp.fifths,
      tupletMeasures: exp.tupletMeasures, tiedEvents: exp.tiedEvents,
      commonTimeMeasures: exp.commonTimeMeasures,
    });

    // Every measure offset is an explicit null on a freshly parsed score.
    expect(doc.measures.filter((m) => m.audioOffsetMs === null)).toHaveLength(exp.measures);
  });
});
