// M4 — RH thinning.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const { loadPlan } = await import("../lib/plan.js");
const { simplifyMeasures } = await import("../lib/simplify.js");
const { verify, formatViolations } = await import("../lib/verify.js");
const { keepIndices, thinRightHand, PitchOrderError } = await import("../lib/rhThin.js");

const SLY = JSON.parse(
  JSON.stringify(parseMusicXML(readScoreXml("fixtures/someone-like-you-easy-piano.mxl")))
);

const plan = (settings, ranges) =>
  loadPlan(
    { planVersion: 1, sourceSongId: "test-source", default: settings, ...(ranges ? { ranges } : {}) },
    { measureCount: SLY.measures.length }
  );
const run = (settings, ranges) => simplifyMeasures(SLY, plan(settings, ranges));

const note = (midi, tie) => (tie ? { midi, name: `n${midi}`, tie } : { midi, name: `n${midi}` });
const ev = (notes) => ({ duration: "q", notes });
const stackOf = (measures) => Math.max(0, ...measures.flatMap((m) => (m.rh || []).map((e) => e.notes.length)));

/** A song whose RH is fully specified, for tie cases. */
function tinySong(rhPerMeasure) {
  return {
    measures: rhPerMeasure.map((rh, i) => ({
      number: i + 1,
      sourceMeasure: String(i + 1),
      timeSignature: { beats: 4, beatType: 4 },
      rh,
      lh: [{ duration: "w", notes: [] }],
    })),
  };
}
const thinTiny = (doc, settingsFor) => {
  const measures = structuredClone(doc.measures);
  const r = thinRightHand(measures, settingsFor);
  return { measures, ...r };
};
const melodyOnly = () => ({ rhStack: "melody-only", lhGrid: "none" });

// --- the three modes ------------------------------------------------------

test("`all` changes nothing", () => {
  const r = run({ rhStack: "all" });
  assert.deepEqual(r.measures, SLY.measures);
});

test("melody-only drops RH stack to 1 throughout", () => {
  const r = run({ rhStack: "melody-only" });
  assert.equal(stackOf(r.measures), 1);
  const over = r.measures.filter((m) => (m.rh || []).some((e) => e.notes.length > 1));
  assert.equal(over.length, 0);
});

test("melody-plus-one keeps at most two, and never more than were there", () => {
  const r = run({ rhStack: "melody-plus-one" });
  assert.ok(stackOf(r.measures) <= 2);
  r.measures.forEach((m, i) => {
    (m.rh || []).forEach((e, k) => {
      const was = SLY.measures[i].rh[k].notes.length;
      assert.ok(e.notes.length <= Math.min(2, was), `m${m.number} rh[${k}]`);
    });
  });
});

test("keepIndices picks by max(midi), never by array position", () => {
  const at = { measure: 1, eventIndex: 0 };
  const chord = ev([note(60), note(64), note(67)]);
  assert.deepEqual([...keepIndices(chord, "melody-only", at)], [2]);
  assert.deepEqual([...keepIndices(chord, "melody-plus-one", at)].sort(), [1, 2]);
  assert.equal(keepIndices(chord, "all", at).size, 3);
  // A single note is its own melody; melody-plus-one cannot invent a second.
  assert.deepEqual([...keepIndices(ev([note(60)]), "melody-plus-one", at)], [0]);
  // Rests keep nothing and stay rests.
  assert.equal(keepIndices(ev([]), "melody-only", at).size, 0);
});

test("a non-ascending notes array is a hard error, not a silent mis-pick", () => {
  assert.throws(
    () => keepIndices(ev([note(67), note(60)]), "melody-only", { measure: 4, eventIndex: 2 }),
    PitchOrderError
  );
  assert.throws(
    () => keepIndices(ev([note(67), note(60)]), "melody-only", { measure: 4, eventIndex: 2 }),
    /m4 rh\[2\].*not pitch-ascending/s
  );
});

// --- event count and the melody rule --------------------------------------

test("RH event count is identical on all 82 measures", () => {
  for (const rhStack of ["melody-only", "melody-plus-one"]) {
    const r = run({ rhStack });
    r.measures.forEach((m, i) => {
      assert.equal((m.rh || []).length, (SLY.measures[i].rh || []).length, `${rhStack} m${m.number}`);
    });
  }
});

test("the highest note of every RH event is identical to the original", () => {
  for (const rhStack of ["melody-only", "melody-plus-one"]) {
    const r = run({ rhStack });
    r.measures.forEach((m, i) => {
      (m.rh || []).forEach((e, k) => {
        const src = SLY.measures[i].rh[k];
        if (!src.notes.length) return assert.equal(e.notes.length, 0);
        assert.equal(
          Math.max(...e.notes.map((n) => n.midi)),
          Math.max(...src.notes.map((n) => n.midi)),
          `m${m.number} rh[${k}]`
        );
      });
    });
  }
});

test("every §5 invariant passes on a full-song thin, both modes", () => {
  for (const rhStack of ["melody-only", "melody-plus-one"]) {
    const r = run({ rhStack });
    const v = verify(SLY, { ...SLY, measures: r.measures });
    assert.deepEqual(v, [], `${rhStack}: ${formatViolations(v)}`);
  }
});

test("rests stay rests", () => {
  const r = run({ rhStack: "melody-only" });
  r.measures.forEach((m, i) => {
    (m.rh || []).forEach((e, k) => {
      if (!SLY.measures[i].rh[k].notes.length) assert.deepEqual(e.notes, []);
    });
  });
});

// --- lyrics and fingerings ------------------------------------------------

test("lyrics and fingerings survive because rh_index is stable", () => {
  // Both are keyed on rh_index (§5.2). Thinning removes notes from within an
  // event and never removes an event, so every placement still lands on the
  // same event — and on the same melody note, since the top is retained.
  const withPlacements = {
    ...SLY,
    lyrics: [
      { word_order: 1, syllable: "I", measure_num: 5, rh_index: 1 },
      { word_order: 2, syllable: "heard", measure_num: 22, rh_index: 0 },
      { word_order: 3, syllable: "un-", measure_num: 47, rh_index: 6 },
    ],
    fingerings: [
      { measureNum: 22, rhIndex: 0, noteIndex: 0, finger: 1, source: "manual" },
      { measureNum: 47, rhIndex: 6, noteIndex: 0, finger: 3, source: "musicxml" },
    ],
  };
  const r = simplifyMeasures(withPlacements, plan({ rhStack: "melody-only" }));
  const out = { ...withPlacements, measures: r.measures };

  assert.deepEqual(out.lyrics, withPlacements.lyrics, "lyrics passed through unchanged");
  assert.deepEqual(out.fingerings, withPlacements.fingerings, "fingerings passed through unchanged");

  for (const l of out.lyrics) {
    const e = out.measures[l.measure_num - 1].rh[l.rh_index];
    assert.ok(e, `lyric ${l.word_order} points at a missing event`);
    const src = SLY.measures[l.measure_num - 1].rh[l.rh_index];
    assert.equal(Math.max(...e.notes.map((n) => n.midi)), Math.max(...src.notes.map((n) => n.midi)));
  }
  for (const f of out.fingerings) {
    assert.ok(out.measures[f.measureNum - 1].rh[f.rhIndex], `fingering points at a missing event`);
  }
});

// --- tie handling ---------------------------------------------------------

test("a chain whose notes are ALL inner voices is removed entirely", () => {
  const doc = tinySong([
    [ev([note(60, "start"), note(72)])],
    [ev([note(60, "end"), note(74)])],
  ]);
  const r = thinTiny(doc, () => melodyOnly());
  assert.deepEqual(r.measures[0].rh[0].notes.map((n) => n.midi), [72]);
  assert.deepEqual(r.measures[1].rh[0].notes.map((n) => n.midi), [74]);
  assert.deepEqual(verify(doc, { measures: r.measures }).filter((x) => x.invariant === 7), []);
});

test("a chain whose notes are ALL top notes survives intact, ties included", () => {
  const doc = tinySong([
    [ev([note(60), note(72, "start")])],
    [ev([note(62), note(72, "end")])],
  ]);
  const r = thinTiny(doc, () => melodyOnly());
  assert.equal(r.measures[0].rh[0].notes[0].tie, "start");
  assert.equal(r.measures[1].rh[0].notes[0].tie, "end");
  assert.deepEqual(r.strippedTies, []);
});

test("a MIXED chain keeps the melody note but loses the tie marker", () => {
  // The tied pitch is the top note in m1 and an inner voice in m2. The melody
  // rule (§4.4) forces the m1 note to stay; §5.1 forbids half a chain. Both
  // hold if the LINK is dropped rather than the note: no dangling marker, and
  // the melody survives. The re-articulation is audible and reported.
  const doc = tinySong([
    [ev([note(64, "start")])],
    [ev([note(64, "end"), note(72)])],
  ]);
  const r = thinTiny(doc, () => melodyOnly());

  assert.deepEqual(r.measures[0].rh[0].notes.map((n) => n.midi), [64], "melody note retained");
  assert.equal(r.measures[0].rh[0].notes[0].tie, undefined, "its tie marker was dropped");
  assert.deepEqual(r.measures[1].rh[0].notes.map((n) => n.midi), [72], "the inner voice went");
  assert.equal(r.strippedTies.length, 1);
  assert.deepEqual(r.strippedTies[0], { measure: 1, eventIndex: 0, midi: 64, side: "start" });
  assert.deepEqual(verify(doc, { measures: r.measures }).filter((x) => x.invariant === 7), []);
});

test("a `both` note loses only the broken side of its tie", () => {
  // C4 is inner in m1 (removed), top in m2 and m3 (kept). The m2 note is
  // "both": its END link is broken, its START link is not.
  const doc = tinySong([
    [ev([note(60, "start"), note(72)])],
    [ev([note(60, "both")])],
    [ev([note(60, "end")])],
  ]);
  const r = thinTiny(doc, () => melodyOnly());
  assert.equal(r.measures[1].rh[0].notes[0].tie, "start", "kept the intact side only");
  assert.equal(r.measures[2].rh[0].notes[0].tie, "end");
  assert.deepEqual(verify(doc, { measures: r.measures }).filter((x) => x.invariant === 7), []);
});

test("a chain reaching an UNTOUCHED measure retains the note rather than breaking", () => {
  // m2 is untouched and cannot be edited, so its tie end must keep its partner.
  // The m1 inner note is retained instead — less thinning, never a broken tie.
  const doc = tinySong([
    [ev([note(60, "start"), note(72)])],
    [ev([note(60, "end"), note(74)])],
  ]);
  const r = thinTiny(doc, (n) => (n === 2 ? null : melodyOnly()));
  assert.deepEqual(r.measures[0].rh[0].notes.map((n) => n.midi), [60, 72], "inner note retained");
  assert.equal(r.measures[0].rh[0].notes[0].tie, "start", "chain intact");
  assert.deepEqual(r.measures[1].rh[0].notes.map((n) => n.midi), [60, 74], "untouched measure unchanged");
  assert.equal(r.retainedForTies.length, 1);
  assert.deepEqual(verify(doc, { measures: r.measures }).filter((x) => x.invariant === 7), []);
});

test("on Someone Like You the four mixed chains are the only ones broken", () => {
  const r = run({ rhStack: "melody-only" });
  assert.equal(r.strippedTies.length, 4);
  assert.deepEqual(r.strippedTies.map((t) => t.measure), [22, 27, 46, 69]);
  assert.equal(r.retainedForTies.length, 0);
});

test("untouched measures stay bit-identical through an RH thin", () => {
  const r = run({ rhStack: "melody-only" }, [{ measures: "37,57-61", settings: null }]);
  for (const n of [37, 57, 58, 59, 60, 61]) {
    assert.deepEqual(r.measures[n - 1], SLY.measures[n - 1], `m${n}`);
  }
});

// --- melody blips ---------------------------------------------------------

test("all 18 melody blips are reported", () => {
  const r = run({ rhStack: "melody-only" });
  assert.equal(r.melodyBlips.length, 18);
  for (const b of r.melodyBlips) {
    assert.ok(Number.isInteger(b.measure));
    assert.ok(b.drop >= 5, "a blip is a dip of 5+ semitones below both neighbours");
  }
});

test("melody blips are NOT corrected — the top note is taken as always", () => {
  // A hiccup that can be heard is a fixable complaint; a silent guess about
  // which note was "really" the melody is not. The output at every blip is the
  // original top note, unchanged.
  const r = run({ rhStack: "melody-only" });
  for (const b of r.melodyBlips) {
    const src = SLY.measures[b.measure - 1].rh[b.eventIndex];
    const out = r.measures[b.measure - 1].rh[b.eventIndex];
    assert.equal(Math.max(...out.notes.map((n) => n.midi)), Math.max(...src.notes.map((n) => n.midi)));
    assert.equal(out.notes[out.notes.length - 1].midi, b.top, `m${b.measure} blip note was altered`);
  }
});

// --- combined with M3 -----------------------------------------------------

test("LH grid and RH thin together keep every invariant", () => {
  const r = run({ lhGrid: "quarter", lhFill: "onset", lhCap: 2, lhKeep: "root-third", rhStack: "melody-only" });
  const v = verify(SLY, { ...SLY, measures: r.measures });
  assert.deepEqual(v, [], formatViolations(v));
  assert.equal(stackOf(r.measures), 1);
});

test("thinning does not write through into the input", () => {
  const before = JSON.stringify(SLY);
  const r = run({ rhStack: "melody-only" });
  r.measures.forEach((m) => { if (m.rh?.[0]?.notes?.[0]) m.rh[0].notes[0].midi = 0; });
  assert.equal(JSON.stringify(SLY), before);
});
