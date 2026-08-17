// M6 — regression check.
//
// The mutation tests are the point. A check that only ever passes has not been
// tested — it may be comparing nothing at all.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const { loadPlan } = await import("../lib/plan.js");
const { simplifyMeasures } = await import("../lib/simplify.js");
const { analyzeSong, THRESHOLDS } = await import("../lib/analyze.js");
const {
  regressionCheck, assertNoRegression, formatRegressions,
  RegressionError, REGRESSION_METRICS,
  affectedMetrics, formatRegressionContext,
} = await import("../lib/regression.js");
const { buildRunReport } = await import("../lib/report.js");

const song = (f) => JSON.parse(JSON.stringify(parseMusicXML(readScoreXml(`fixtures/${f}`))));
const SLY = song("someone-like-you-easy-piano.mxl");
const LA_CANDEUR = song("etude-in-c-major-la-candeur-op100-no-1-burgmuller.mxl");

const BASE = { lhGrid: "quarter", lhCap: 2, lhKeep: "root-third", rhStack: "melody-only" };
const NULL_RANGE = [{ measures: "37,57-61,68,79-82", settings: null }];

function run(def, ranges = NULL_RANGE) {
  const plan = loadPlan(
    { planVersion: 1, sourceSongId: "030333d9", default: def, ranges },
    { measureCount: SLY.measures.length }
  );
  const result = simplifyMeasures(SLY, plan);
  return { ...SLY, measures: result.measures };
}

// --- the metric fix -------------------------------------------------------

test("rhythmVariety counts tokens PER HAND and reports the max, not the union", () => {
  // Four LH quarters against eight RH eighths is two values per hand, which is
  // what a player deals with — not two pooled into one count of two.
  const doc = {
    measures: [{
      number: 1, timeSignature: { beats: 4, beatType: 4 },
      rh: Array.from({ length: 8 }, () => ({ duration: "8", notes: [{ midi: 72, name: "C5" }] })),
      lh: Array.from({ length: 4 }, () => ({ duration: "q", notes: [{ midi: 48, name: "C3" }] })),
    }],
  };
  assert.equal(analyzeSong(doc, { bpm: 60 }).measures[0].rhythmVariety, 1,
    "one token in each hand is a variety of 1, not 2");

  const mixed = {
    measures: [{
      number: 1, timeSignature: { beats: 4, beatType: 4 },
      rh: [
        { duration: "q", notes: [{ midi: 72, name: "C5" }] },
        { duration: "8", notes: [{ midi: 74, name: "D5" }] },
        { duration: "8", notes: [{ midi: 76, name: "E5" }] },
        { duration: "h", notes: [{ midi: 77, name: "F5" }] },
      ],
      lh: [{ duration: "w", notes: [{ midi: 48, name: "C3" }] }],
    }],
  };
  assert.equal(analyzeSong(mixed, { bpm: 60 }).measures[0].rhythmVariety, 3,
    "RH has q/8/h = 3; LH has w = 1; the max is 3");
});

test("quantizing the LH no longer LOOKS like a rhythm regression", () => {
  // The bug this fixed: sixteen LH 16ths becoming four quarters genuinely
  // simplifies, but a pooled count rose because `q` was new to the bar.
  const worse = regressionCheck(SLY, run({ ...BASE, lhFill: "onset" }), { bpm: 67 })
    .filter((w) => w.metric === "rhythmVariety");
  assert.deepEqual(worse, []);
});

test("the VAR>3 threshold still separates the calibration corpus", () => {
  // Phase 1.5's line must survive the metric change, or the constant needs
  // retuning. The comfortable band tops out at 3, so >3 still sits just above.
  const over = (doc, bpm) =>
    analyzeSong(doc, { bpm }).measures.filter((m) => m.rhythmVariety > THRESHOLDS.rhythmVariety).length;
  assert.equal(over(LA_CANDEUR, 60), 0, "La Candeur");
  assert.ok(over(SLY, 67) > 0, "Someone Like You must still flag");
});

// --- the check itself -----------------------------------------------------

test("every analyzer metric is covered by the check", () => {
  const keys = REGRESSION_METRICS.map((m) => m.key);
  for (const k of ["notesPerSecond", "lhNotesPerBeat", "rhNotesPerBeat", "rhStack", "lhStack",
                   "rhStretch", "lhStretch", "rhJump", "lhJump", "rhythmVariety", "accidentals"]) {
    assert.ok(keys.includes(k), `${k} is not checked for regression`);
  }
});

test("an identity output has no regressions", () => {
  assert.deepEqual(regressionCheck(SLY, SLY, { bpm: 67 }), []);
  assert.equal(assertNoRegression(SLY, SLY, { bpm: 67 }), true);
});

test("a metric getting BETTER is not a regression", () => {
  const easier = run({ ...BASE, lhFill: "onset" }, [
    ...NULL_RANGE, { measures: "32", settings: { lhGrid: "half" } },
  ]);
  const before = analyzeSong(SLY, { bpm: 67 }).summary.lhNotesPerBeat.median;
  const after = analyzeSong(easier, { bpm: 67 }).summary.lhNotesPerBeat.median;
  assert.ok(after < before, "the transform did make the LH easier");
  assert.deepEqual(regressionCheck(SLY, easier, { bpm: 67 }), []);
});

// --- MUTATION TESTS -------------------------------------------------------

test("MUTATION: a hand-made worse measure is caught, naming measure, metric and both values", () => {
  // Add a note to one LH event: stack 1 -> 2 in that measure and nothing else.
  const worseDoc = structuredClone(SLY);
  worseDoc.measures[4].lh[0].notes.push({ midi: 64, name: "E4" });

  const worse = regressionCheck(SLY, worseDoc, { bpm: 67 });
  assert.ok(worse.length > 0, "the mutation was NOT caught");
  const stack = worse.find((w) => w.metric === "lhStack");
  assert.ok(stack, `expected lhStack, got ${JSON.stringify(worse)}`);
  assert.equal(stack.measure, 5);
  assert.equal(stack.before, 1);
  assert.equal(stack.after, 2);
  assert.match(formatRegressions(worse), /m5 LH stack: 1 → 2/);
});

test("MUTATION: assertNoRegression throws RegressionError", () => {
  const worseDoc = structuredClone(SLY);
  worseDoc.measures[0].rh[0].notes.push({ midi: 90, name: "F#6" });
  assert.throws(() => assertNoRegression(SLY, worseDoc, { bpm: 67 }), RegressionError);
});

test("MUTATION (required): `lhFill: union` FIRES the check", () => {
  // §4.2's warning came from hand-prototyping and had never been verified in
  // the real engine. It is real, and larger than recorded: union raises LH
  // stack and LH stretch across most of the song.
  const worse = regressionCheck(SLY, run({ ...BASE, lhFill: "union" }), { bpm: 67 });
  assert.ok(worse.length > 0, "union did not fire the check — the check is not working");

  const byMetric = {};
  for (const w of worse) (byMetric[w.metric] ??= []).push(w.measure);
  assert.ok(byMetric.lhStack?.length > 40, `expected widespread lhStack regressions, got ${byMetric.lhStack?.length}`);
  assert.ok(byMetric.lhStretch?.length > 40, `expected widespread lhStretch regressions`);
  assert.ok(byMetric.lhJump?.includes(32), "m32's LH jump regression should appear under union too");
});

test("onset fires on exactly one measure — m32's LH jump", () => {
  const worse = regressionCheck(SLY, run({ ...BASE, lhFill: "onset" }), { bpm: 67 });
  assert.deepEqual(worse.map((w) => ({ measure: w.measure, metric: w.metric, before: w.before, after: w.after })), [
    { measure: 32, metric: "lhJump", before: 7, after: 16 },
  ]);
});

test("onset beats union by a wide margin — the fill default is settled by numbers", () => {
  const onset = regressionCheck(SLY, run({ ...BASE, lhFill: "onset" }), { bpm: 67 });
  const union = regressionCheck(SLY, run({ ...BASE, lhFill: "union" }), { bpm: 67 });
  assert.ok(union.length > onset.length * 20, `onset ${onset.length} vs union ${union.length}`);
});

// --- the reference plan ---------------------------------------------------

test("the reference plan passes clean once m32 is narrowed to a half grid", () => {
  // The fix is a PLAN change, not a code change — exactly what §11 says the
  // answer to a one-measure problem should be.
  const out = run({ ...BASE, lhFill: "onset" }, [
    ...NULL_RANGE, { measures: "32", settings: { lhGrid: "half" } },
  ]);
  const worse = regressionCheck(SLY, out, { bpm: 67 });
  assert.deepEqual(worse, [], formatRegressions(worse));
});

test("formatRegressions says nothing alarming when there is nothing wrong", () => {
  assert.match(formatRegressions([]), /no metric got worse/);
});

// --- the song-level context that accompanies the prompt --------------------
//
// The consequence of a regression is now a question, not an exit. Whoever
// answers it needs the second number: the per-measure list alone cannot say
// whether the song as a whole got easier.

const contextFor = (def, ranges = NULL_RANGE) => {
  const plan = loadPlan(
    { planVersion: 1, sourceSongId: "030333d9", default: def, ranges },
    { measureCount: SLY.measures.length }
  );
  const result = simplifyMeasures(SLY, plan);
  const output = { ...SLY, measures: result.measures };
  const worse = regressionCheck(SLY, output, { bpm: 67 });
  const report = buildRunReport({ plan, analyzerTempo: 67, result, input: SLY, output });
  return { worse, text: formatRegressionContext(worse, report.metrics) };
};

test("affectedMetrics lists each touched metric once, in SUMMARY_METRICS order", () => {
  const worse = [
    { metric: "lhJump" }, { metric: "lhStack" }, { metric: "lhJump" },
  ];
  assert.deepEqual(affectedMetrics(worse).map((m) => m.key), ["lhStack", "lhJump"]);
});

test("the context names only the metrics that regressed, with the measure count", () => {
  const { worse, text } = contextFor({ ...BASE, lhFill: "onset" });
  assert.equal(worse.length, 1, "expected the single m32 LH jump regression");
  assert.match(text, /LH jump\s+median .* → .*/);
  assert.match(text, /worse on 1 measure\b/, "singular for one measure");
  assert.doesNotMatch(text, /LH stack/, "a metric that did not regress must not appear");
});

test("the context carries the global figure the per-measure list cannot show", () => {
  // m32's LH jump went 7 → 16, but the song's LH jump median FELL. That second
  // number is the whole reason this is a question rather than a refusal.
  const { text } = contextFor({ ...BASE, lhFill: "onset" });
  const before = analyzeSong(SLY, { bpm: 67 }).summary.lhJump.median;
  const after = analyzeSong(run({ ...BASE, lhFill: "onset" }), { bpm: 67 }).summary.lhJump.median;
  assert.ok(after < before, `the song-level median should have improved (${before} → ${after})`);
  assert.match(text, new RegExp(`LH jump\\s+median ${before} → ${after}`));
});

test("plural agreement, and every regressed metric appears", () => {
  const { worse, text } = contextFor({ ...BASE, lhFill: "union" });
  const keys = new Set(worse.map((w) => w.metric));
  assert.ok(keys.size > 1, "union should regress more than one metric");
  for (const { key, label } of affectedMetrics(worse)) {
    assert.ok(text.includes(label), `${key} regressed but is missing from the context`);
  }
  assert.match(text, /worse on \d\d+ measures\b/, "plural for many measures");
});

test("no regressions means no context block at all", () => {
  assert.equal(formatRegressionContext([], { before: { summary: {} }, after: { summary: {} } }), "");
});

test("a missing metrics block degrades to empty rather than throwing", () => {
  // The context is decoration on a prompt; it must never be the reason a run
  // cannot be confirmed.
  const worse = [{ metric: "lhJump", label: "LH jump", measure: 32, before: 7, after: 16 }];
  assert.equal(formatRegressionContext(worse, undefined), "");
  assert.equal(formatRegressionContext(worse, { before: {}, after: {} }), "");
});
