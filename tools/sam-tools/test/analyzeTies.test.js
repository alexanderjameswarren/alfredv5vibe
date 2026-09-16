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
const { voltaSeamSources, isVoltaSeamStart } = await import("../lib/voltaSeams.js");
const { validate } = await import("../lib/validate.js");
const fs = await import("node:fs");

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
  assert.deepEqual(t.unclosedStarts, [{ hand: "rh", midi: 65, measure: 1, eventIndex: 0, kind: "orphan" }]);
  assert.deepEqual(t.crossings, [{ hand: "rh", midi: 65, from: 2, to: 3 }]);
});

test("every chain still open is reported, not just the newest", () => {
  const t = ties(synth([[["start"]], [["start"]], [["start"]]]));
  assert.deepEqual(t.unclosedStarts.map((x) => x.measure), [1, 2, 3]);
});

test("The Entertainer: 5 unclosed starts, all labelled seam", () => {
  // 3 before the fix (rh m151, printed m87 -> X4). The single slot was hiding
  // two more at rh m67 (printed m35 -> X2), where the second ending re-opens
  // the same pitches instead of closing them. validate.js reports both places
  // as volta_seam_tie.
  const t = ties(ENTERTAINER);
  assert.deepEqual(
    t.unclosedStarts.map((x) => `${x.hand} m${x.measure} ${x.midi}`),
    ["rh m67 64", "rh m67 72", "rh m151 64", "rh m151 67", "rh m151 72"]
  );
  assert.deepEqual(t.unclosedStarts.map((x) => x.kind), ["seam", "seam", "seam", "seam", "seam"]);
  for (const x of t.unclosedStarts) {
    assert.equal(ENTERTAINER.measures[x.measure].sourceMeasure.startsWith("X"), true,
      `m${x.measure} should be followed by a volta ending`);
  }
  assert.deepEqual(t.unmatchedEnds, []);
});

test("Someone Like You: the volta start at rh m77 is reported, and labelled seam", () => {
  // Printed m54 -> m69: the second pass opens A3 again rather than closing it.
  const t = ties(SLY);
  assert.deepEqual(t.unclosedStarts, [{ hand: "rh", midi: 57, measure: 77, eventIndex: 10, kind: "seam" }]);
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

// --- M2: unclosed starts are labelled seam or orphan ------------------------
//
// The rule is voltaSeams.js, shared with validate.js's volta_seam_tie. A start
// is a seam iff its printed measure is played more than once, the next printed
// measure differs between those plays, and the start is the final event of its
// hand in that measure.

// One RH event list per measure, with explicit printed labels.
function labelled(pairs) {
  return {
    measures: pairs.map(([label, events], i) => ({
      number: i + 1,
      ...(label === undefined ? {} : { sourceMeasure: label }),
      timeSignature: { beats: 4, beatType: 4 },
      rh: events.map((marks) => ({ duration: "q", notes: marks.map(F4) })),
      lh: [{ duration: "w", notes: [] }],
    })),
  };
}

test("a synthetic volta: the start held into the first ending is `seam`", () => {
  // Printed 1 2 X1 1 2 X2 — bar 2 is played twice, into X1 then X2. The tie
  // into X1 is closed; on the second pass X2 does not close it.
  const doc = labelled([
    ["1", [[null]]], ["2", [[null], ["start"]]], ["X1", [["end"]]],
    ["1", [[null]]], ["2", [[null], ["start"]]], ["X2", [[null]]],
  ]);
  const t = ties(doc);
  assert.deepEqual(t.unmatchedEnds, []);
  assert.deepEqual(t.unclosedStarts, [{ hand: "rh", midi: 65, measure: 5, eventIndex: 1, kind: "seam" }]);
});

test("a synthetic orphan away from any seam is still `orphan`", () => {
  const doc = labelled([["1", [[null]]], ["2", [["start"], [null]]], ["3", [[null]]]]);
  assert.deepEqual(ties(doc).unclosedStarts.map((x) => x.kind), ["orphan"]);
});

test("each seam condition is required", () => {
  // (3) not the final event of the bar, even though the bar is a volta seam.
  const notLast = labelled([
    ["1", [["start"], [null]]], ["X1", [["end"]]],
    ["1", [["start"], [null]]], ["X2", [[null]]],
  ]);
  assert.deepEqual(ties(notLast).unclosedStarts.map((x) => x.kind), ["orphan"]);

  // (2) played twice, but continuing to the same bar both times — a plain repeat.
  const sameNext = labelled([
    ["1", [[null], ["start"]]], ["2", [["end"]]],
    ["1", [[null], ["start"]]], ["2", [[null]]],
  ]);
  assert.deepEqual(ties(sameNext).unclosedStarts.map((x) => x.kind), ["orphan"]);

  // (1) played once.
  const once = labelled([["1", [[null], ["start"]]], ["2", [[null]]]]);
  assert.deepEqual(ties(once).unclosedStarts.map((x) => x.kind), ["orphan"]);
});

test("a measure with no printed number is never a seam", () => {
  // Hand-authored and MCP-created songs carry no sourceMeasure. Without the
  // guard, every such bar would share one "label" played many times.
  const doc = labelled([
    [undefined, [[null], ["start"]]], [undefined, [[null]]], [undefined, [[null], ["start"]]],
  ]);
  assert.equal(voltaSeamSources(doc.measures).size, 0);
  assert.deepEqual(ties(doc).unclosedStarts.map((x) => x.kind), ["orphan", "orphan"]);
});

test("the seam test does not parse labels: X-labels and numeric labels both work", () => {
  const measures = [
    { sourceMeasure: 7 }, { sourceMeasure: "X1" }, { sourceMeasure: "7" }, { sourceMeasure: "X2" },
  ];
  assert.deepEqual([...voltaSeamSources(measures)], ["7"]);
  assert.equal(isVoltaSeamStart(voltaSeamSources(measures), { sourceMeasure: 7, rh: [{}] }, "rh", 0), true);
});

// --- the corpus -------------------------------------------------------------

const CORPUS = {
  ...Object.fromEntries(fs.readdirSync("fixtures").map((f) => [f, song(f)])),
  ...Object.fromEntries(["entertainer.json", "sayitaintso.json", "scientist.json"].map((f) =>
    [f, JSON.parse(fs.readFileSync(f, "utf8"))])),
};

test("no unexplained orphan anywhere in the corpus", () => {
  const orphans = [];
  for (const [name, doc] of Object.entries(CORPUS)) {
    const t = ties(doc);
    for (const x of [...t.unmatchedEnds, ...t.unclosedStarts]) {
      if (x.kind !== "seam") orphans.push(`${name}: ${x.hand} m${x.measure} midi ${x.midi}`);
    }
  }
  assert.deepEqual(orphans, []);
  assert.equal(Object.keys(CORPUS).length, 16);
});

test("analyzeTies and validate.js agree on which pitches are volta-seam ties", () => {
  // Same rule, different granularity: validate reports a pitch as
  // volta_seam_tie when every open start on it is a seam, orphan_tie otherwise.
  let compared = 0;
  for (const fixture of fs.readdirSync("fixtures")) {
    const report = validate(readScoreXml(`fixtures/${fixture}`), fixture);
    const fromValidate = report.findings
      .filter((f) => f.defect === "volta_seam_tie" || (f.defect === "orphan_tie" && /never closed/.test(f.detail)))
      .map((f) => `${f.hand} ${f.detail.match(/midi (\d+)/)[1]} ${f.defect === "volta_seam_tie" ? "seam" : "orphan"}`)
      .sort();

    const byPitch = new Map();
    for (const x of ties(song(fixture)).unclosedStarts) {
      const k = `${x.hand} ${x.midi}`;
      byPitch.set(k, (byPitch.get(k) ?? true) && x.kind === "seam");
    }
    const fromAnalyzer = [...byPitch].map(([k, allSeam]) => `${k} ${allSeam ? "seam" : "orphan"}`).sort();

    assert.deepEqual(fromAnalyzer, fromValidate, fixture);
    compared += fromValidate.length;
  }
  // Entertainer's three pitches and Someone Like You's one — not a vacuous pass.
  assert.equal(compared, 4);
});
