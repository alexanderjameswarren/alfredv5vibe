// The Deno analyzer (supabase/functions/_shared/analyze.ts) produces exactly
// what the CLI analyzer (lib/analyze.js) produces — per measure, per metric,
// byte for byte — on the four reference songs.
//
// Compared three ways, strictest last:
//   1. numerically, per measure, per metric (Object.is — no tolerance), so a
//      failure names the song, measure and metric instead of "JSON differs"
//   2. structurally, for the whole-song fields (summary, flags, ties, …)
//   3. JSON bytes of the entire result
//
// Reference songs are self-contained: Someone Like You is parsed from its .mxl
// fixture (82 measures, 22 tuplet groups — the tuplet case), the other three
// are the committed exports. Nothing is read from Downloads or the database.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const CLI = await import("../lib/analyze.js");
const PORT = await import("../../../supabase/functions/_shared/analyze.ts");
const LIB_DUR = await import("../lib/durations.js");
const DENO_DUR = await import("../../../supabase/functions/_shared/durations.ts");

const readJson = (f) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const fromFixture = (f) =>
  JSON.parse(JSON.stringify(parseMusicXML(readScoreXml(`fixtures/${f}`))));

const SONGS = {
  "Someone Like You": { doc: fromFixture("someone-like-you-easy-piano.mxl"), measures: 82 },
  "Say It Ain't So": { doc: readJson("sayitaintso.json"), measures: 160 },
  "The Entertainer": { doc: readJson("entertainer.json"), measures: 152 },
  "The Scientist": { doc: readJson("scientist.json"), measures: 73 },
};

// The player's working tempos and a spread around them, plus a non-integer
// value so a tempo-dependent division that differs only in operand order
// cannot hide behind a round number.
const TEMPOS = [30, 60, 67, 90, 152, 72.5];

const METRICS = [
  "number", "sourceMeasure", "beats", "rhOnsets", "lhOnsets", "seconds", "notesPerSecond",
  "rhNotesPerBeat", "lhNotesPerBeat", "rhStack", "lhStack", "rhStretch",
  "lhStretch", "rhJump", "lhJump", "rhythmVariety", "accidentals",
];

test("the reference songs are the songs we think they are", () => {
  for (const [name, { doc, measures }] of Object.entries(SONGS)) {
    assert.equal(doc.measures.length, measures, name);
  }
  assert.equal(CLI.analyzeSong(SONGS["Someone Like You"].doc, { bpm: 67 }).tuplets.length, 22);
});

test("the port exports the same analyzer surface as the CLI", () => {
  // TypeScript interfaces are erased, so the runtime exports should match 1:1.
  assert.deepEqual(Object.keys(PORT).sort(), Object.keys(CLI).sort());
  assert.deepEqual(PORT.THRESHOLDS, CLI.THRESHOLDS);
  assert.deepEqual(PORT.SUMMARY_METRICS, CLI.SUMMARY_METRICS);
});

/** Every metric of every measure, compared exactly. Returns the count checked. */
function compareMeasures(song, bpm, a, b) {
  assert.equal(b.measures.length, a.measures.length, `${song} @${bpm}: measure count`);
  let checked = 0;
  a.measures.forEach((ma, i) => {
    const mb = b.measures[i];
    // Every key the CLI emits must be one we compare, so a new metric cannot
    // slip past this test unchecked.
    assert.deepEqual(Object.keys(mb), Object.keys(ma), `${song} @${bpm} m${ma.number}: keys`);
    const unchecked = Object.keys(ma).filter((k) => k !== "flags" && !METRICS.includes(k));
    assert.deepEqual(unchecked, [], `${song}: per-measure keys the comparison does not cover`);
    for (const k of METRICS) {
      if (!Object.is(mb[k], ma[k])) {
        assert.fail(`${song} @${bpm} m${ma.number} ${k}: CLI=${ma[k]} port=${mb[k]}`);
      }
      checked++;
    }
    assert.deepEqual(mb.flags, ma.flags, `${song} @${bpm} m${ma.number} flags`);
  });
  return checked;
}

for (const [song, { doc }] of Object.entries(SONGS)) {
  test(`${song}: identical per measure, per metric, at every tempo`, () => {
    let checked = 0;
    for (const bpm of TEMPOS) {
      const a = CLI.analyzeSong(doc, { bpm });
      const b = PORT.analyzeSong(doc, { bpm });
      checked += compareMeasures(song, bpm, a, b);
    }
    assert.equal(checked, doc.measures.length * METRICS.length * TEMPOS.length);
  });

  test(`${song}: identical whole-song results, and identical JSON bytes`, () => {
    for (const bpm of TEMPOS) {
      const a = CLI.analyzeSong(doc, { bpm });
      const b = PORT.analyzeSong(doc, { bpm });
      for (const k of ["title", "artist", "key", "fifths", "bpm", "measureCount",
                       "summary", "flagged", "seams", "ties", "tuplets", "blips"]) {
        assert.deepEqual(b[k], a[k], `${song} @${bpm}: ${k}`);
      }
      assert.deepEqual(Object.keys(b), Object.keys(a), `${song}: top-level keys`);
      assert.equal(JSON.stringify(b), JSON.stringify(a), `${song} @${bpm}: JSON bytes`);
    }
  });
}

test("the port does not mutate its input", () => {
  for (const [song, { doc }] of Object.entries(SONGS)) {
    const before = JSON.stringify(doc);
    PORT.analyzeSong(doc, { bpm: 67 });
    assert.equal(JSON.stringify(doc), before, song);
  }
});

test("the port rejects what the CLI rejects, with the same message", () => {
  for (const [doc, opts] of [[null, { bpm: 60 }], [{}, { bpm: 60 }], [SONGS["The Scientist"].doc, { bpm: 0 }],
                             [SONGS["The Scientist"].doc, { bpm: -5 }], [SONGS["The Scientist"].doc, { bpm: NaN }]]) {
    let cliErr;
    try { CLI.analyzeSong(doc, opts); } catch (e) { cliErr = e.message; }
    assert.ok(cliErr, "the CLI should reject this input");
    assert.throws(() => PORT.analyzeSong(doc, opts), { message: cliErr });
  }
});

// --- the tempo-free facts ----------------------------------------------------

// What a stored score row holds. Nothing here may depend on tempo.
const FACT_KEYS = [
  "number", "sourceMeasure", "beats", "rhOnsets", "lhOnsets", "rhStack", "lhStack",
  "rhStretch", "lhStretch", "rhJump", "lhJump", "rhythmVariety", "accidentals",
];

test("analyzeSongFacts is identical in both copies, and takes no tempo", () => {
  for (const [song, { doc }] of Object.entries(SONGS)) {
    const a = CLI.analyzeSongFacts(doc);
    const b = PORT.analyzeSongFacts(doc);
    assert.equal(JSON.stringify(b), JSON.stringify(a), song);
    assert.equal(a.measures.length, doc.measures.length, song);
    for (const f of a.measures) {
      assert.deepEqual(Object.keys(f), FACT_KEYS, `${song} m${f.number}: fact keys`);
      assert.ok(Number.isInteger(f.rhOnsets) && Number.isInteger(f.lhOnsets),
        `${song} m${f.number}: onsets are counts`);
    }
  }
  // The entry point has one parameter: there is nowhere to pass a tempo.
  assert.equal(CLI.analyzeSongFacts.length, 1);
  assert.equal(PORT.analyzeSongFacts.length, 1);
});

test("the facts are the same whatever tempo analyzeSong is later asked for", () => {
  const doc = SONGS["Someone Like You"].doc;
  const facts = CLI.analyzeSongFacts(doc);
  for (const bpm of TEMPOS) {
    const digest = CLI.analyzeSong(doc, { bpm });
    digest.measures.forEach((m, i) => {
      for (const k of FACT_KEYS) assert.ok(Object.is(m[k], facts.measures[i][k]), `@${bpm} m${m.number} ${k}`);
    });
  }
});

test("analyzeSong is exactly measureAtTempo over analyzeSongFacts, in both copies", () => {
  for (const [name, lib] of [["CLI", CLI], ["PORT", PORT]]) {
    for (const [song, { doc }] of Object.entries(SONGS)) {
      for (const bpm of [60, 72.5]) {
        const direct = lib.analyzeSong(doc, { bpm }).measures;
        const viaFacts = lib.analyzeSongFacts(doc).measures.map((f) => lib.measureAtTempo(f, bpm));
        assert.equal(JSON.stringify(viaFacts), JSON.stringify(direct), `${name} ${song} @${bpm}`);
      }
    }
  }
});

test("measureAtTempo matches across copies and rejects a missing tempo the same way", () => {
  const facts = CLI.analyzeSongFacts(SONGS["Say It Ain't So"].doc).measures;
  for (const bpm of TEMPOS) {
    for (const f of facts) {
      assert.equal(JSON.stringify(PORT.measureAtTempo(f, bpm)), JSON.stringify(CLI.measureAtTempo(f, bpm)));
    }
  }
  for (const bad of [undefined, null, 0, -60, NaN]) {
    assert.throws(() => CLI.measureAtTempo(facts[0], bad), /A positive --bpm is required/);
    assert.throws(() => PORT.measureAtTempo(facts[0], bad), /A positive --bpm is required/);
  }
});

test("rates are derived from the stored counts, not the other way round", () => {
  // A 7/8 bar with 5 RH onsets: 5 / 3.5 is not a round number, and the count
  // must survive untouched while the rate is computed from it.
  const doc = {
    measures: [{
      number: 1,
      timeSignature: { beats: 7, beatType: 8 },
      rh: Array.from({ length: 5 }, (_, i) => ({ duration: i < 3 ? "8" : "q", notes: [{ midi: 60 + i, name: "x" }] })),
      lh: [{ duration: "qdd", notes: [] }, { duration: "q", notes: [{ midi: 48, name: "C3" }] }],
    }],
  };
  for (const lib of [CLI, PORT]) {
    const [f] = lib.analyzeSongFacts(doc).measures;
    assert.equal(f.rhOnsets, 5);
    assert.equal(f.lhOnsets, 1, "a rest is not an onset");
    assert.equal(f.beats, 3.5);
    const m = lib.measureAtTempo(f, 70);
    assert.equal(m.rhNotesPerBeat, 5 / 3.5);
    assert.equal(m.notesPerSecond, 6 / ((3.5 * 60) / 70));
  }
});

// --- tuplets ----------------------------------------------------------------

test("Someone Like You survives an export round trip with tuplet beat math intact", () => {
  const doc = SONGS["Someone Like You"].doc;
  const roundTripped = JSON.parse(JSON.stringify(doc));
  for (const bpm of [67, 72.5]) {
    const direct = JSON.stringify(PORT.analyzeSong(doc, { bpm }));
    assert.equal(JSON.stringify(PORT.analyzeSong(roundTripped, { bpm })), direct);
    assert.equal(JSON.stringify(CLI.analyzeSong(roundTripped, { bpm })), direct);
  }

  const groups = PORT.analyzeSong(roundTripped, { bpm: 67 }).tuplets;
  assert.equal(groups.length, 22);
  assert.equal(new Set(groups.map((g) => g.measure)).size, 16);

  // Every tuplet measure: each non-empty hand sums, tuplet-scaled, to the bar
  // length — in both copies of the duration math. `startBeat` rides on the
  // same accumulation, and is compared exactly above.
  const tupletMeasures = roundTripped.measures.filter((m) =>
    [...(m.rh || []), ...(m.lh || [])].some((e) => e.tuplet)
  );
  assert.equal(tupletMeasures.length, 16);
  for (const m of tupletMeasures) {
    const bar = LIB_DUR.measureBeats(m.timeSignature);
    assert.equal(DENO_DUR.measureBeats(m.timeSignature), bar);
    for (const hand of ["rh", "lh"]) {
      const events = m[hand] || [];
      if (!events.some((e) => e.tuplet)) continue;
      const lib = LIB_DUR.sumEvents(events);
      assert.ok(Object.is(DENO_DUR.sumEvents(events), lib), `m${m.number} ${hand}`);
      assert.ok(Math.abs(lib - bar) < 1e-9, `m${m.number} ${hand}: ${lib} beats in a ${bar}-beat bar`);
    }
  }
});

// --- the comparison can fail ---------------------------------------------------

test("the per-metric comparison catches a floating-point-only difference", () => {
  // `beats * 60 / bpm` and `beats / (bpm / 60)` are the same formula and can
  // differ in the last bit. If the port ever drifted like that, this is the
  // check that has to notice — so prove it does.
  const doc = SONGS["Someone Like You"].doc;
  const bpm = 72.5;
  const a = CLI.analyzeSong(doc, { bpm });
  const b = structuredClone(a);
  const target = b.measures.find((m) => m.beats > 0 && m.beats * 60 / bpm !== m.beats / (bpm / 60));
  assert.ok(target, "expected at least one measure where the two orderings differ");
  target.seconds = target.beats / (bpm / 60);
  assert.throws(() => compareMeasures("Someone Like You", bpm, a, b), /seconds: CLI=/);
});
