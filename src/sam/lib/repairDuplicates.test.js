// M3 — the repair tool's planning logic.
//
// scripts/sam-repair-duplicates.js runs in the DevTools console, because the
// database is only reachable with Alex's own session (see the memory note on
// service-role keys). That is a bad place for untested logic, so the tool keeps
// its decision-making in one pure function, `__samPlanSong`, and this suite
// drives that function against hand-built rows. Only the fetch/PATCH shell is
// unexercised here.
//
// The last block is the parity check: the tool inlines noteDuplicates.js rather
// than restating the rule, and this asserts the inlined copy is still the
// module.

const fs = require("fs");
const path = require("path");

const SCRIPT = path.resolve(__dirname, "../../../scripts/sam-repair-duplicates.js");

let planSong;
beforeAll(() => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const log = console.log;
  console.log = () => {};          // the tool announces itself on load
  try {
    // eslint-disable-next-line no-new-func
    new Function(src)();
  } finally {
    console.log = log;
  }
  planSong = window.__samPlanSong;
});

const note = (midi, name, tie) => (tie ? { midi, name, tie } : { midi, name });
const ev = (notes, extra) => Object.assign({ duration: "q", notes }, extra || {});
const song = { id: "song-1", title: "Test Song" };

// A duplicated F4 in a D4/F4/A4 chord — the reference case's shape.
const dupChord = () => [
  note(62, "D4", "start"), note(65, "F4", "start"), note(65, "F4"), note(69, "A4", "start"),
];
// Moonlight m60's shape — a hold and a fresh strike on one pitch.
const legitPair = () => [note(61, "C#4"), note(61, "C#4", "end")];

const measureRow = (id, number, rh, lh = []) => ({ id, number, rh, lh });

describe("planSong — finding duplicates", () => {
  test("a clean song produces no findings and no updates", () => {
    const p = planSong(song, [
      measureRow("m1", 1, [ev([note(60, "C4"), note(64, "E4")])], [ev([note(48, "C3")])]),
    ], [], []);
    expect(p.findings).toEqual([]);
    expect(p.updates).toEqual([]);
    expect(p.blockers).toEqual([]);
  });

  test("reports song, measure, hand, event index and pitch", () => {
    const p = planSong(song, [measureRow("m1", 7, [ev(dupChord())])], [], []);
    expect(p.songId).toBe("song-1");
    expect(p.title).toBe("Test Song");
    expect(p.findings).toEqual([
      { measureNumber: 7, hand: "rh", eventIndex: 0, midi: 65, name: "F4", copies: 2 },
    ]);
  });

  test("finds duplicates in the left hand too", () => {
    const p = planSong(song, [
      measureRow("m1", 3, [ev([note(60, "C4")])], [ev([note(48, "C3"), note(48, "C3")])]),
    ], [], []);
    expect(p.findings).toHaveLength(1);
    expect(p.findings[0].hand).toBe("lh");
    expect(p.updates[0].lh).toBeDefined();
    expect(p.updates[0].rh).toBeUndefined();   // the clean hand is not rewritten
  });

  test("a legitimate hold-plus-restrike is not a finding", () => {
    const p = planSong(song, [measureRow("m1", 60, [ev(legitPair())])], [], []);
    expect(p.findings).toEqual([]);
    expect(p.updates).toEqual([]);
  });

  test("only changed measure rows appear in updates", () => {
    const p = planSong(song, [
      measureRow("m1", 1, [ev([note(60, "C4")])]),
      measureRow("m2", 2, [ev(dupChord())]),
      measureRow("m3", 3, [ev([note(67, "G4")])]),
    ], [], []);
    expect(p.updates.map((u) => u.id)).toEqual(["m2"]);
    expect(p.updates[0].number).toBe(2);
  });

  test("the merged event keeps its duration and any other fields", () => {
    const p = planSong(song, [
      measureRow("m1", 1, [ev(dupChord(), { duration: "8", tuplet: { actual: 3, normal: 2 } })]),
    ], [], []);
    const merged = p.updates[0].rh[0];
    expect(merged.duration).toBe("8");
    expect(merged.tuplet).toEqual({ actual: 3, normal: 2 });
    expect(merged.notes.map((n) => n.midi)).toEqual([62, 65, 69]);
    expect(merged.notes[1].tie).toBe("start");   // the union, per the M1 rule
  });

  test("counts every copy when a pitch appears three times", () => {
    const p = planSong(song, [
      measureRow("m1", 1, [ev([note(65, "F4"), note(65, "F4"), note(65, "F4")])]),
    ], [], []);
    expect(p.findings[0].copies).toBe(3);
    expect(p.updates[0].rh[0].notes).toHaveLength(1);
  });
});

describe("planSong — refusing to invalidate a stored fingering", () => {
  // rh[0] is [C4, F4, F4, A4] → merges to [C4, F4, A4].
  // note_index 0 still means C4, 1 still means F4, 2 was F4 and becomes A4,
  // 3 was A4 and falls off the end.
  const rows = () => [measureRow("m1", 4, [ev([
    note(60, "C4"), note(65, "F4"), note(65, "F4"), note(69, "A4"),
  ])])];

  const fingering = (noteIndex, id = `f${noteIndex}`) => ({
    id, measure_num: 4, rh_index: 0, note_index: noteIndex, finger: 3, source: "manual",
  });

  test("an index below the removed note is safe", () => {
    const p = planSong(song, rows(), [fingering(0), fingering(1)], []);
    expect(p.blockers).toEqual([]);
    expect(p.updates).toHaveLength(1);
  });

  test("an index that would start addressing a different pitch blocks the song", () => {
    const p = planSong(song, rows(), [fingering(2)], []);
    expect(p.blockers).toHaveLength(1);
    const b = p.blockers[0];
    expect(b.kind).toBe("fingering");
    expect(b.id).toBe("f2");
    expect(b.measureNumber).toBe(4);
    expect(b.rhIndex).toBe(0);
    expect(b.noteIndex).toBe(2);
    expect(b.wasName).toBe("F4");
    expect(b.nowName).toBe("A4");
  });

  test("an index that would fall off the end blocks the song", () => {
    const p = planSong(song, rows(), [fingering(3)], []);
    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0].nowMidi).toBeNull();
  });

  test("a fingering already pointing past the end is reported, not blamed", () => {
    const p = planSong(song, rows(), [fingering(9)], []);
    expect(p.blockers).toEqual([]);
    expect(p.dangling).toHaveLength(1);
    expect(p.dangling[0].noteIndex).toBe(9);
    expect(p.dangling[0].eventSize).toBe(4);
  });

  test("a fingering on an unaffected event is irrelevant", () => {
    const p = planSong(song, [
      measureRow("m1", 4, [ev([note(60, "C4"), note(64, "E4")]), ev(dupChord())]),
    ], [{ id: "f", measure_num: 4, rh_index: 0, note_index: 1, finger: 2, source: "manual" }], []);
    expect(p.blockers).toEqual([]);
    expect(p.findings).toHaveLength(1);
  });

  test("blockers still let the rest of the report be produced", () => {
    // The caller skips the song, but the human needs to see what it found.
    const p = planSong(song, rows(), [fingering(2)], []);
    expect(p.findings).toHaveLength(1);
    expect(p.updates).toHaveLength(1);
    expect(p.blockers).toHaveLength(1);
  });
});

describe("planSong — lyrics", () => {
  test("syllables on affected events are counted but never block", () => {
    const p = planSong(song, [measureRow("m1", 2, [ev(dupChord())])], [], [
      { id: "l1", word_order: 0, syllable: "some", measure_num: 2, rh_index: 0 },
      { id: "l2", word_order: 1, syllable: "one", measure_num: 2, rh_index: 0 },
    ]);
    // A syllable addresses the event, not the notehead, and merging inside an
    // event leaves the event count alone — so rh_index still points where it did.
    expect(p.lyricsOnAffected).toBe(2);
    expect(p.blockers).toEqual([]);
  });

  test("unplaced syllables are ignored", () => {
    const p = planSong(song, [measureRow("m1", 2, [ev(dupChord())])], [], [
      { id: "l1", word_order: 0, syllable: "some", measure_num: null, rh_index: null },
    ]);
    expect(p.lyricsOnAffected).toBe(0);
  });

  test("the event count is asserted, not assumed", () => {
    // The guarantee lyrics rely on. If a merge ever dropped an event, every
    // rh_index after it would shift and this would have to become a blocker.
    const p = planSong(song, [
      measureRow("m1", 1, [ev(dupChord()), ev([note(60, "C4")]), ev(legitPair())]),
    ], [], []);
    expect(p.updates[0].rh).toHaveLength(3);
    expect(p.blockers).toEqual([]);
  });
});

describe("planSong — input tolerance", () => {
  test("missing hands, empty rows and absent index tables are fine", () => {
    expect(planSong(song, [], [], []).findings).toEqual([]);
    expect(planSong(song, [{ id: "m", number: 1 }], null, null).findings).toEqual([]);
    expect(planSong(song, [measureRow("m", 1, [ev([])])], [], []).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inlined-copy parity.
//
// The console tool must be one paste-able file, so it cannot import the shared
// module — scripts/inline-note-duplicates.js splices the source in instead.
// This asserts the spliced copy is still exactly that module, so "uses the same
// predicate" stays true rather than becoming true-at-the-time-of-writing.
// ---------------------------------------------------------------------------

describe("inlined noteDuplicates parity (M3)", () => {
  const gen = require("../../../scripts/inline-note-duplicates.js");

  function inlinedRegion() {
    const text = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf(gen.BEGIN);
    const end = text.indexOf(gen.END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return text.slice(start + gen.BEGIN.length, end).replace(/^\n/, "").trimEnd();
  }

  test("the inlined copy matches src/sam/lib/noteDuplicates.js", () => {
    expect(inlinedRegion()).toBe(gen.build());
  });

  test("the inlined copy carries no ESM export keywords", () => {
    // It runs inside an IIFE in the console; a stray `export` is a syntax error
    // at paste time, which is a miserable way to find out.
    expect(inlinedRegion()).not.toMatch(/^\s*export\s/m);
  });

  test("the parity check actually discriminates", () => {
    const tampered = gen.build().replace("count > 1", "count > 99");
    expect(tampered).not.toBe(gen.build());
    expect(inlinedRegion()).not.toBe(tampered);
  });
});
