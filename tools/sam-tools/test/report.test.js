// M5 — ranges, skip-and-flag, reporting, output document.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const { loadPlan } = await import("../lib/plan.js");
const { simplifyMeasures } = await import("../lib/simplify.js");
const {
  buildRunReport, buildOutputDoc, OutputDocError, confirmationNeeded,
  shortUntouchedRuns, repeatedRanges,
} = await import("../lib/report.js");

const SLY = JSON.parse(
  JSON.stringify(parseMusicXML(readScoreXml("fixtures/someone-like-you-easy-piano.mxl")))
);
SLY.title = "Someone Like You";

// The reference plan (spec §3).
const REFERENCE = {
  planVersion: 1,
  sourceSongId: "030333d9-1b9f-4f74-80fb-7fbed587fda6",
  label: "melody only · quarter chords",
  default: {
    lhGrid: "quarter", lhFill: "onset", lhCap: 2, lhKeep: "root-third", rhStack: "melody-only",
  },
  ranges: [
    { measures: "37,57-61,68,79-82", settings: null },
    // Added to the spec's §3 reference plan in Phase 2 M7: without it the run
    // fails the §6 regression check on m32's LH jump.
    { measures: "32", settings: { lhGrid: "half" } },
  ],
};

const load = (p = REFERENCE) => loadPlan(p, { measureCount: SLY.measures.length });
const runPlan = (p = REFERENCE) => {
  const plan = load(p);
  const result = simplifyMeasures(SLY, plan);
  const output = { ...SLY, measures: result.measures };
  return { plan, result, output, report: buildRunReport({ plan, analyzerTempo: 67, result, input: SLY, output }) };
};

// --- ranges ---------------------------------------------------------------

test("`settings: null` measures are bit-identical to the original", () => {
  const { result } = runPlan();
  // The reference plan's range covers ELEVEN measures. Spec §10 lists ten
  // "already-comfortable" measures and omits m58, but the range string
  // "57-61" includes it — see the progress Notes.
  const expected = [37, 57, 58, 59, 60, 61, 68, 79, 80, 81, 82];
  assert.deepEqual(result.untouched, expected);
  for (const n of expected) {
    assert.deepEqual(result.measures[n - 1], SLY.measures[n - 1], `m${n} was modified`);
  }
});

test("a range's partial settings override only its own measures", () => {
  const { result } = runPlan({
    planVersion: 1,
    sourceSongId: "x",
    default: { lhGrid: "quarter", rhStack: "melody-only" },
    ranges: [{ measures: "5-6", settings: { rhStack: "all" } }],
  });
  // m5/m6 keep their RH chords; a measure outside the range does not.
  for (const n of [5, 6]) {
    assert.deepEqual(result.measures[n - 1].rh, SLY.measures[n - 1].rh, `m${n} RH was thinned`);
  }
  const m1 = result.measures[0].rh;
  assert.ok(m1.every((e) => e.notes.length <= 1), "m1 RH should be thinned");
});

// --- skip-and-flag --------------------------------------------------------

test("every skip carries a machine-readable code, and none is silent", () => {
  const { result } = runPlan();
  for (const row of [...result.unable, ...result.unneeded]) {
    assert.ok(row.code, `m${row.measure} has no code`);
    assert.ok(row.reason, `m${row.measure} has no reason`);
    assert.ok(row.hand);
  }
});

test("the reference plan has zero `unable` — the floor is `unneeded`", () => {
  const { result } = runPlan();
  assert.equal(result.unable.length, 0);
  assert.equal(result.unneeded.length, 14);
  for (const u of result.unneeded) assert.equal(u.code, "density-floor");
});

// --- confirmation threshold ----------------------------------------------

test("confirmation is gated on `unable` only, never on `unneeded`", () => {
  // 14 of 82 unneeded is 17%, but even at 100% it must not gate.
  assert.equal(confirmationNeeded({ unableCount: 0, measureCount: 82 }), false);
  assert.equal(confirmationNeeded({ unableCount: 20, measureCount: 82 }), false, "24% is under");
  assert.equal(confirmationNeeded({ unableCount: 21, measureCount: 82 }), true, "25.6% is over");
  // Exactly at the threshold does not prompt — §7 says "more than 25%".
  assert.equal(confirmationNeeded({ unableCount: 25, measureCount: 100 }), false);
  assert.equal(confirmationNeeded({ unableCount: 26, measureCount: 100 }), true);
  assert.equal(confirmationNeeded({ unableCount: 0, measureCount: 0 }), false);
});

// --- advisories -----------------------------------------------------------

test("short untouched runs are reported; m37 has length 1", () => {
  const { report } = runPlan();
  const m37 = report.shortUntouchedRuns.find((r) => r.measures.includes(37));
  assert.ok(m37, "m37 is missing from shortUntouchedRuns");
  assert.equal(m37.length, 1);
  assert.deepEqual(m37.measures, [37]);
  // m68 is the other island; 57-61 and 79-82 are long enough to pass.
  assert.deepEqual(report.shortUntouchedRuns.map((r) => r.measures), [[37], [68]]);
});

test("shortUntouchedRuns groups consecutive measures and applies the length cut", () => {
  assert.deepEqual(shortUntouchedRuns([1, 2, 5, 9, 10, 11]), [
    { measures: [1, 2], length: 2 },
    { measures: [5], length: 1 },
  ]);
  assert.deepEqual(shortUntouchedRuns([]), []);
});

test("repeated ranges report the other places the same printed measures appear", () => {
  // Someone Like You's only repeat is printed 46-54, played at 46-54 and again
  // at 69-77 (the D.S.). NOTE: the tracker's exit criterion named 22-32 ->
  // 46-55 and 69-78; the data does not support it. Played 22-32 map to printed
  // 22-32, which occur exactly once. See the progress Notes.
  const plan = load({
    planVersion: 1, sourceSongId: "x", default: { rhStack: "melody-only" },
    ranges: [{ measures: "46-54", settings: null }],
  });
  const r = repeatedRanges(SLY.measures, plan.ranges);
  assert.equal(r.length, 1);
  assert.equal(r[0].range, "46-54");
  assert.deepEqual(r[0].alsoAppearsAt, ["69-77"]);
});

test("the reverse direction reports too", () => {
  const plan = load({
    planVersion: 1, sourceSongId: "x", default: { rhStack: "melody-only" },
    ranges: [{ measures: "69-77", settings: null }],
  });
  assert.deepEqual(repeatedRanges(SLY.measures, plan.ranges)[0].alsoAppearsAt, ["46-54"]);
});

test("a range whose printed measures occur once reports nothing", () => {
  const plan = load({
    planVersion: 1, sourceSongId: "x", default: { rhStack: "melody-only" },
    ranges: [{ measures: "22-32", settings: null }],
  });
  assert.deepEqual(repeatedRanges(SLY.measures, plan.ranges), []);
});

test("melody blips are carried into the report, not corrected", () => {
  const { report } = runPlan();
  assert.equal(report.melodyBlips.length, 18);
});

// --- the run report -------------------------------------------------------

test("the run report is structured — no prose fields", () => {
  const { report } = runPlan();
  // Every top-level value is a number, array or object. The only strings are
  // inside `reason`, which §8's own shape names, and each has a `code` beside it.
  for (const [k, v] of Object.entries(report)) {
    assert.notEqual(typeof v, "string", `report.${k} is a bare string`);
  }
  assert.equal(report.reportVersion, 1);
  assert.equal(report.analyzerTempo, 67);
  assert.deepEqual(report.plan, REFERENCE, "the plan is recorded as applied");
  for (const k of ["unable", "unneeded", "untouched", "strippedTies", "retainedForTies",
                   "transformNotes", "melodyBlips", "shortUntouchedRuns", "repeatedRanges"]) {
    assert.ok(Array.isArray(report[k]), `report.${k} should be an array`);
  }
  assert.ok(report.metrics.before && report.metrics.after);
});

test("the report carries before/after metrics at the same tempo", () => {
  const { report } = runPlan();
  assert.equal(report.metrics.before.measureCount, 82);
  assert.equal(report.metrics.after.measureCount, 82);
  // 69, not 72: the rhythmVariety metric now counts tokens per hand rather
  // than pooling both, so three measures that only flagged VAR no longer do.
  assert.equal(report.metrics.before.flaggedCount, 69);
  assert.ok(report.metrics.after.flaggedCount < report.metrics.before.flaggedCount);
  assert.ok(report.metrics.after.summary.lhNotesPerBeat.median <
            report.metrics.before.summary.lhNotesPerBeat.median);
});

test("the report is valid JSON and survives a round trip", () => {
  const { report } = runPlan();
  const round = JSON.parse(JSON.stringify(report));
  assert.deepEqual(round, report);
});

// --- the output document (§9) --------------------------------------------

test("the output document inherits and re-labels correctly", () => {
  const { plan, result, report } = runPlan();
  const doc = buildOutputDoc({ input: SLY, measures: result.measures, plan, report });

  assert.equal(doc.title, "Someone Like You (melody only · quarter chords)");
  assert.equal(doc.songType, "simplified");
  assert.equal(doc.parentSongId, REFERENCE.sourceSongId);
  assert.equal(doc.formatVersion, 2);
  // Inherited unchanged (§9).
  assert.equal(doc.artist, SLY.artist);
  assert.equal(doc.key, SLY.key);
  assert.equal(doc.fifths, SLY.fifths);
  assert.equal(doc.defaultBpm, SLY.defaultBpm);
  assert.equal(doc.measures.length, 82);
  assert.deepEqual(doc.generationNotes, report);
});

test("the title is unchanged when the plan has no label", () => {
  const { plan, result, report } = runPlan({ ...REFERENCE, label: undefined });
  const doc = buildOutputDoc({ input: SLY, measures: result.measures, plan, report });
  assert.equal(doc.title, "Someone Like You");
});

test("a plan with no sourceSongId is rejected at load (§3.1)", () => {
  // songType 'simplified' requires a parent, in §9 and in the database, so a
  // plan without one could only produce a file the UI rejects. The schema now
  // refuses it up front.
  assert.throws(
    () => load({ ...REFERENCE, sourceSongId: undefined }),
    /missing required key "sourceSongId"/
  );
});

test("buildOutputDoc refuses a parentless plan even if one reaches it", () => {
  // Belt and braces: the schema is the first line of defence, but the writer
  // must not emit an unimportable document if called directly.
  const { result, report } = runPlan();
  const parentless = { ...load(), sourceSongId: null };
  assert.throws(
    () => buildOutputDoc({ input: SLY, measures: result.measures, plan: parentless, report }),
    OutputDocError
  );
  assert.throws(
    () => buildOutputDoc({ input: SLY, measures: result.measures, plan: parentless, report }),
    /sourceSongId/
  );
});

test("the whole output document round-trips through JSON with the report inside", () => {
  const { plan, result, report } = runPlan();
  const doc = buildOutputDoc({ input: SLY, measures: result.measures, plan, report });
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round, doc);
  assert.deepEqual(round.generationNotes.plan, REFERENCE);
  assert.equal(round.generationNotes.melodyBlips.length, 18);
});

// --- M0: resolved per-measure settings (Phase 6 §3.1) --------------------

test("resolvedSettings has one entry per measure, in order", () => {
  const { report } = runPlan();
  const rs = report.resolvedSettings;
  assert.equal(rs.length, 82);
  rs.forEach((e, i) => assert.equal(e.measure, i + 1));
});

test("status is derived from what HAPPENED, not from what was asked", () => {
  const { report, result } = runPlan();
  const rs = report.resolvedSettings;
  const by = (s) => rs.filter((e) => e.status === s).map((e) => e.measure);

  assert.deepEqual(by("untouched"), result.untouched, "untouched mirrors the null range");
  assert.equal(by("unable").length, 0, "the reference plan has none");

  // The nuance this exists for: 14 measures hit the LH density floor, but only
  // 4 are `unneeded` overall — the other 10 still had their RH thinned, so the
  // measure DID change and is reported as transformed.
  const flooredMeasures = result.unneeded.map((u) => u.measure);
  assert.equal(flooredMeasures.length, 14);
  assert.equal(by("unneeded").length, 4);
  for (const m of by("unneeded")) {
    assert.ok(flooredMeasures.includes(m), `m${m} unneeded but not floored`);
  }
  assert.equal(by("transformed").length + by("unneeded").length + by("untouched").length, 82);
});

test("an `unneeded` measure really is bit-identical to its input", () => {
  const { report, result } = runPlan();
  for (const e of report.resolvedSettings.filter((x) => x.status === "unneeded")) {
    assert.deepEqual(result.measures[e.measure - 1], SLY.measures[e.measure - 1], `m${e.measure}`);
  }
});

test("settings carry the resolved vocabulary, and null when untouched", () => {
  const { report } = runPlan();
  const rs = report.resolvedSettings;
  assert.equal(rs[36].settings, null, "m37 is untouched");
  assert.deepEqual(rs[31].settings, {
    lhGrid: "half", lhFill: "onset", lhCap: 2, lhKeep: "root-third", rhStack: "melody-only",
  }, "m32 carries its half-grid override, fully resolved");
  assert.deepEqual(rs[0].settings, REFERENCE.default, "m1 carries the plan default");
});

test("nonDefault flags exactly the measures a range covers", () => {
  const { report } = runPlan();
  const flagged = report.resolvedSettings.filter((e) => e.nonDefault).map((e) => e.measure);
  assert.deepEqual(flagged, [32, 37, 57, 58, 59, 60, 61, 68, 79, 80, 81, 82]);
});

test("resolvedSettings survives the JSON round trip into generationNotes", () => {
  const { plan, result, report } = runPlan();
  const doc = buildOutputDoc({ input: SLY, measures: result.measures, plan, report });
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round.generationNotes.resolvedSettings, report.resolvedSettings);
  assert.equal(round.generationNotes.resolvedSettings.length, 82);
});
