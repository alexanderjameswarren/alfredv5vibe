// analyzeTies: chains are matched by (hand, midi), which is not unique — two
// voices in unison hold two chains on one pitch. A stack per pitch, and ends
// before starts within an event, are what keep that from inventing orphans or
// hiding unclosed starts. See the KEYING comment in lib/analyze.js.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const { analyzeTies, findSeams } = await import("../lib/analyze.js");

const song = (fixture) =>
  JSON.parse(JSON.stringify(parseMusicXML(readScoreXml(`fixtures/${fixture}`))));
const ties = (doc) => analyzeTies(doc.measures, findSeams(doc.measures));

const SIAS = song("say-it-aint-so-by-weezer.mxl");
const ENTERTAINER = song("The_Entertainer_-_Scott_Joplin_-_1902.mxl");
const SLY = song("someone-like-you-easy-piano.mxl");

// One RH event per entry; each entry is a list of tie markers on F4 (null =
// untied). `sources` sets sourceMeasure per measure, so a jump makes a seam.
const F4 = (tie) => (tie ? { midi: 65, name: "F4", tie } : { midi: 65, name: "F4" });
function synth(measuresOfEvents, sources) {
  return {
    measures: measuresOfEvents.map((events, i) => ({
      number: i + 1,
      sourceMeasure: String(sources ? sources[i] : i + 1),
      timeSignature: { beats: 4, beatType: 4 },
      rh: events.map((marks) => ({ duration: "q", notes: marks.map(F4) })),
      lh: [{ duration: "w", notes: [] }],
    })),
  };
}

// --- the unison case ------------------------------------------------------

test("Say It Ain't So: the fixture still carries the unison at rh m70", () => {
  const m70 = SIAS.measures[69];
  const marks = m70.rh.slice(0, 5).map((e) => e.notes.map((n) => `${n.name}:${n.tie}`));
  assert.deepEqual(marks, [
    ["F4:start"], ["F4:start", "F4:end"], ["F4:both"], ["F4:both"], ["F4:end"],
  ]);
});

test("Say It Ain't So reports no orphan ends (the m70 false orphan is gone)", () => {
  const t = ties(SIAS);
  assert.deepEqual(t.unmatchedEnds.filter((x) => x.kind === "orphan"), []);
  assert.deepEqual(t.unclosedStarts, []);
  assert.equal(t.crossings.length, 67);
});

test("m70's shape resolves cleanly whichever order the event lists its notes", () => {
  for (const event1 of [["start", "end"], ["end", "start"]]) {
    const t = ties(synth([[["start"], event1, ["both"], ["both"], ["end"]]]));
    assert.deepEqual(t.unmatchedEnds, [], `event 1 = ${event1}`);
    assert.deepEqual(t.unclosedStarts, [], `event 1 = ${event1}`);
  }
});

// --- nothing is lost ------------------------------------------------------

test("two chains open on one pitch, one closed, reports exactly one unclosed start", () => {
  // Measure 1 opens a chain; measure 2 opens a second on the same pitch;
  // measure 3 closes one. The newest closes; the first is left open.
  const t = ties(synth([[["start"]], [["start"]], [["end"]]]));
  assert.deepEqual(t.unmatchedEnds, []);
  assert.deepEqual(t.unclosedStarts, [{ hand: "rh", midi: 65, measure: 1, eventIndex: 0 }]);
  assert.deepEqual(t.crossings, [{ hand: "rh", midi: 65, from: 2, to: 3 }]);
});

test("every chain still open is reported, not just the newest", () => {
  const t = ties(synth([[["start"]], [["start"]], [["start"]]]));
  assert.deepEqual(t.unclosedStarts.map((x) => x.measure), [1, 2, 3]);
});

test("The Entertainer: 5 unclosed starts, all at volta seams", () => {
  // 3 before the fix (rh m151, printed m87 -> X4). The single slot was hiding
  // two more at rh m67 (printed m35 -> X2), where the second ending re-opens
  // the same pitches instead of closing them. validate.js reports both places
  // as volta_seam_tie.
  const t = ties(ENTERTAINER);
  assert.deepEqual(
    t.unclosedStarts.map((x) => `${x.hand} m${x.measure} ${x.midi}`),
    ["rh m67 64", "rh m67 72", "rh m151 64", "rh m151 67", "rh m151 72"]
  );
  for (const x of t.unclosedStarts) {
    assert.equal(ENTERTAINER.measures[x.measure].sourceMeasure.startsWith("X"), true,
      `m${x.measure} should be followed by a volta ending`);
  }
  assert.deepEqual(t.unmatchedEnds, []);
});

test("Someone Like You: the hidden volta start at rh m77 is now reported", () => {
  // Printed m54 -> m69: the second pass opens A3 again rather than closing it.
  const t = ties(SLY);
  assert.deepEqual(t.unclosedStarts, [{ hand: "rh", midi: 57, measure: 77, eventIndex: 10 }]);
  assert.equal(SLY.measures[76].sourceMeasure, "54");
  assert.equal(SLY.measures[77].sourceMeasure, "69");
});

// --- seam vs orphan -------------------------------------------------------

test("an unmatched end at a seam is `seam`; the same end elsewhere is `orphan`", () => {
  const atSeam = ties(synth([[[null]], [["end"]]], [1, 5]));
  assert.deepEqual(atSeam.unmatchedEnds.map((x) => x.kind), ["seam"]);

  const noSeam = ties(synth([[[null]], [["end"]]], [1, 2]));
  assert.deepEqual(noSeam.unmatchedEnds.map((x) => x.kind), ["orphan"]);
});

test("a stack never lets an end borrow a chain from another hand", () => {
  const doc = synth([[["start"]], [[null]]]);
  doc.measures[1].lh = [{ duration: "w", notes: [F4("end")] }];
  const t = ties(doc);
  assert.deepEqual(t.unmatchedEnds.map((x) => `${x.hand}:${x.kind}`), ["lh:orphan"]);
  assert.deepEqual(t.unclosedStarts.map((x) => x.hand), ["rh"]);
});
