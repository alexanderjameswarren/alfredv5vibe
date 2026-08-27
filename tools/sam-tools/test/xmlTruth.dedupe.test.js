// M1a — the oracle's own duplicate-pitch rule.
//
// xmlTruth is the validator's ground truth. It deliberately does NOT call the
// parser's mergeDuplicatePitches: if both sides ran one predicate, a bug inside
// it would cancel out and `sam validate` would report clean on a corpus the
// parser had just damaged. These tests pin the oracle's independent copy of the
// rule, so the two implementations can be compared rather than assumed equal.
//
// The preservation cases are the ones that matter. Collapsing a hold-plus-
// restrike into one note is the failure mode the whole continuation rule
// exists to avoid, and it is precisely the failure a shared predicate would
// hide.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const shim = new JSDOM("", { contentType: "text/html" });
globalThis.DOMParser = shim.window.DOMParser;

const { mergeStaff, buildTruth } = await import("../lib/xmlTruth.js");
const { readScoreXml } = await import("../lib/mxl.js");

const evt = (onset, dur, notes) => ({
  onset, dur, notes, rest: notes.length === 0, tuplet: null,
});

const midisAt = (segments, onset) =>
  segments.find((s) => Math.abs(s.onset - onset) < 1e-9).notes.map((n) => n.midi);

test("two voices striking one pitch over one span collapse to one note", () => {
  const voices = new Map([
    ["1:1", [evt(0, 4, [{ midi: 65, name: "F4", tie: "start" }])]],
    ["1:2", [evt(0, 4, [{ midi: 65, name: "F4" }])]],
  ]);
  const out = mergeStaff(voices, "1", 4);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].notes, [{ midi: 65, name: "F4", tie: "start" }],
    "one sounding pitch, and the tie survives the fold");
});

test("a chord keeps its other members while the duplicate collapses", () => {
  const voices = new Map([
    ["1:1", [evt(0, 4, [
      { midi: 62, name: "D4" }, { midi: 65, name: "F4" }, { midi: 69, name: "A4" },
    ])]],
    ["1:2", [evt(0, 4, [{ midi: 65, name: "F4" }])]],
  ]);
  const out = mergeStaff(voices, "1", 4);
  assert.deepEqual(out[0].notes.map((n) => n.midi), [62, 65, 69]);
});

test("a voice HOLDING while another strikes is preserved as two notes", () => {
  // voice 1 spans the bar, voice 2 strikes the same pitch on beat 2. The
  // segmentation forces tie "both" onto the held fragment, which is the signal
  // — derived here, not imported from the parser.
  const voices = new Map([
    ["1:1", [evt(0, 4, [{ midi: 61, name: "C#4" }])]],
    ["1:2", [evt(1, 1, [{ midi: 61, name: "C#4" }])]],
  ]);
  const out = mergeStaff(voices, "1", 4);
  assert.deepEqual(midisAt(out, 1), [61, 61],
    "hold plus restrike is two sounding events, not one");
});

test("a held fragment does not absorb a fresh strike of the same pitch", () => {
  // Same shape, source-tied rather than segmentation-tied.
  const voices = new Map([
    ["1:1", [evt(0, 2, [{ midi: 66, name: "F#4", tie: "end" }])]],
    ["1:2", [evt(0, 2, [{ midi: 66, name: "F#4" }])]],
  ]);
  const out = mergeStaff(voices, "1", 4);
  assert.equal(out[0].notes.length, 2);
});

test("three entries: the two fresh strikes fold, the hold survives", () => {
  const voices = new Map([
    ["1:1", [evt(0, 4, [{ midi: 65, name: "F4", tie: "start" }])]],
    ["1:2", [evt(0, 4, [{ midi: 65, name: "F4" }])]],
    ["1:3", [evt(0, 4, [{ midi: 65, name: "F4", tie: "end" }])]],
  ]);
  const out = mergeStaff(voices, "1", 4);
  assert.equal(out[0].notes.length, 2);
  assert.equal(out[0].notes.filter((n) => n.tie === "end").length, 1);
});

test("distinct pitches are untouched", () => {
  const voices = new Map([
    ["1:1", [evt(0, 4, [{ midi: 60, name: "C4" }, { midi: 64, name: "E4" }])]],
    ["1:2", [evt(0, 4, [{ midi: 67, name: "G4" }])]],
  ]);
  const out = mergeStaff(voices, "1", 4);
  assert.deepEqual(out[0].notes.map((n) => n.midi), [60, 64, 67]);
});

// --- against the real corpus ----------------------------------------------

const truthOf = (f) => buildTruth(readScoreXml(`fixtures/${f}`));

const freshDuplicates = (truth) => {
  const hits = [];
  for (const m of truth.measures) {
    for (const hand of ["rh", "lh"]) {
      (m[hand] || []).forEach((e, ei) => {
        const fresh = (e.notes || [])
          .filter((n) => n.tie !== "end" && n.tie !== "both")
          .map((n) => n.midi);
        if (new Set(fresh).size !== fresh.length) {
          hits.push(`m${m.number ?? "?"} ${hand} event ${ei}: [${fresh.join(",")}]`);
        }
      });
    }
  }
  return hits;
};

test("the oracle states no fresh duplicate anywhere in the corpus", () => {
  for (const f of [
    "sonate-no-14-moonlight-1st-movement.mxl",
    "The_Entertainer_-_Scott_Joplin_-_1902.mxl",
    "someone-like-you-easy-piano.mxl",
    "say-it-aint-so-by-weezer.mxl",
  ]) {
    assert.deepEqual(freshDuplicates(truthOf(f)), [], `${f} should be clean`);
  }
});

test("the oracle still expects the legitimate same-pitch pairs", () => {
  // If the collapse were too greedy these would vanish, and the validator
  // would then demand that the parser drop them too.
  const pairsIn = (truth) => {
    let n = 0;
    for (const m of truth.measures) {
      for (const hand of ["rh", "lh"]) {
        for (const e of m[hand] || []) {
          const byMidi = new Map();
          for (const note of e.notes || []) {
            byMidi.set(note.midi, (byMidi.get(note.midi) || 0) + 1);
          }
          for (const c of byMidi.values()) if (c > 1) n++;
        }
      }
    }
    return n;
  };
  assert.ok(pairsIn(truthOf("sonate-no-14-moonlight-1st-movement.mxl")) > 0,
    "Moonlight's hold-plus-restrike pairs must survive in the oracle");
  assert.ok(pairsIn(truthOf("someone-like-you-easy-piano.mxl")) > 0,
    "Someone Like You m27 must survive in the oracle");
});
