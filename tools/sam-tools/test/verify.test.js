// M2 — identity transform and invariant harness.
//
// Songs are parsed from the .mxl fixtures with the vendored parser, so these
// tests are self-contained: no exported JSON checked in, nothing read from
// Downloads, no database.
//
// The mutation tests are the point. Four deliberate corruptions, four catches.
// An invariant that has never failed has not been tested — it may be comparing
// nothing at all and passing for that reason.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const shim = new JSDOM("", { contentType: "text/html" });
globalThis.DOMParser = shim.window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const { loadPlan } = await import("../lib/plan.js");
const { simplifyMeasures, NotImplementedYet } = await import("../lib/simplify.js");
const { verify, assertVerified, formatViolations, InvariantError } =
  await import("../lib/verify.js");

const FIXTURES = {
  laCandeur: "fixtures/etude-in-c-major-la-candeur-op100-no-1-burgmuller.mxl",
  someoneLikeYou: "fixtures/someone-like-you-easy-piano.mxl",
};

/**
 * Parse a fixture into a song document shaped like an export.
 *
 * The JSON round-trip is NOT cosmetic. The parser's repeat flattening reuses
 * event arrays between repeated measures — in La Candeur, m9's `rh` IS m1's
 * `rh`, the same object — and `structuredClone` preserves that aliasing
 * faithfully, so mutating one measure silently mutates the other. A real
 * export cannot have this because downloading serialises through JSON, so we
 * serialise too and test against what the CLI will actually be handed.
 */
function song(fixture) {
  const parsed = parseMusicXML(readScoreXml(fixture));
  const doc = {
    ...parsed,
    // Mirror the stored blob: a null offset is absent, not null.
    measures: parsed.measures.map((m) => {
      const o = { ...m };
      if (o.audioOffsetMs == null) delete o.audioOffsetMs;
      return o;
    }),
  };
  return JSON.parse(JSON.stringify(doc));
}

// --- synthetic songs for tie semantics ------------------------------------
//
// Tie matching is keyed by pitch within a hand, so corrupting a tie in a real
// song can be absorbed by another chain on the same pitch. These fixtures use
// one pitch, one event per measure, and explicit sourceMeasure values, so a
// test asserts exactly the rule it names and nothing else.
const NOTE = (tie) => (tie ? { midi: 72, name: "C5", tie } : { midi: 72, name: "C5" });

/** `sourceMeasures` drives seam placement: a jump means a seam at that index. */
function tieSong(sourceMeasures, ties = []) {
  return {
    title: "tie fixture",
    measures: sourceMeasures.map((src, i) => ({
      number: i + 1,
      sourceMeasure: String(src),
      timeSignature: { beats: 4, beatType: 4 },
      rh: [{ duration: "w", notes: [NOTE(ties[i])] }],
      lh: [{ duration: "w", notes: [] }],
    })),
  };
}

const LA_CANDEUR = song(FIXTURES.laCandeur);
const SLY = song(FIXTURES.someoneLikeYou);

const identityPlan = (doc) =>
  loadPlan({ planVersion: 1, default: {} }, { measureCount: doc.measures.length });

const runIdentity = (doc) => ({ ...doc, measures: simplifyMeasures(doc, identityPlan(doc)).measures });

/** Deep clone with one measure mutated by `fn`. */
function mutate(doc, measureIndex, fn) {
  const out = structuredClone(doc);
  fn(out.measures[measureIndex], out);
  return out;
}

/** Assert exactly this invariant number fires, and say so when it doesn't. */
function assertCaught(input, output, invariantNumber, pattern) {
  const v = verify(input, output);
  assert.ok(v.length > 0, "the mutation was NOT caught — verify() found nothing");
  const hit = v.filter((x) => x.invariant === invariantNumber);
  assert.ok(
    hit.length > 0,
    `expected invariant ${invariantNumber} to fire, got: ${formatViolations(v)}`
  );
  if (pattern) assert.match(hit[0].detail, pattern);
  return hit;
}

// --- identity -------------------------------------------------------------

test("La Candeur: the fixture is the song we think it is", () => {
  assert.equal(LA_CANDEUR.measures.length, 38);
  assert.equal(LA_CANDEUR.fifths, 0);
});

test("Someone Like You: the fixture is the song we think it is", () => {
  assert.equal(SLY.measures.length, 82);
  assert.equal(SLY.fifths, 3);
  const tupletMeasures = SLY.measures.filter((m) =>
    [...(m.rh || []), ...(m.lh || [])].some((e) => e.tuplet)
  ).length;
  assert.equal(tupletMeasures, 16, "16 tuplet measures");
  const tied = SLY.measures.reduce(
    (n, m) =>
      n + [...(m.rh || []), ...(m.lh || [])].filter((e) => (e.notes || []).some((x) => x.tie)).length,
    0
  );
  assert.equal(tied, 229, "229 tied events");
});

test("identity run on La Candeur — zero differences", () => {
  const out = runIdentity(LA_CANDEUR);
  assert.deepEqual(verify(LA_CANDEUR, out), []);
  assert.deepEqual(out.measures, LA_CANDEUR.measures, "measures are bit-identical");
});

test("identity run on Someone Like You — zero differences", () => {
  const out = runIdentity(SLY);
  assert.deepEqual(verify(SLY, out), []);
  assert.deepEqual(out.measures, SLY.measures, "measures are bit-identical");
});

test("identity does not mutate the input document", () => {
  const before = JSON.stringify(LA_CANDEUR);
  runIdentity(LA_CANDEUR);
  assert.equal(JSON.stringify(LA_CANDEUR), before);
});

test("`settings: null` measures come through untouched and are reported", () => {
  const plan = loadPlan(
    { planVersion: 1, default: {}, ranges: [{ measures: "37,57-61", settings: null }] },
    { measureCount: 82 }
  );
  const r = simplifyMeasures(SLY, plan);
  assert.deepEqual(r.untouched, [37, 57, 58, 59, 60, 61]);
  assert.deepEqual(r.measures, SLY.measures);
});

test("asking for an unimplemented transform is loud, never a silent no-op", () => {
  // lhGrid landed in M3. rhStack is still unbuilt, and until M4 lands a plan
  // requesting it must fail rather than quietly returning an unchanged song.
  for (const rhStack of ["melody-only", "melody-plus-one"]) {
    const plan = loadPlan({ planVersion: 1, default: { rhStack } }, { measureCount: 38 });
    assert.throws(() => simplifyMeasures(LA_CANDEUR, plan), NotImplementedYet);
    assert.throws(() => simplifyMeasures(LA_CANDEUR, plan), /M4/);
  }
});

test("assertVerified throws on a bad output and passes a good one", () => {
  assert.equal(assertVerified(LA_CANDEUR, runIdentity(LA_CANDEUR)), true);
  const broken = mutate(LA_CANDEUR, 0, (m) => { m.audioOffsetMs = 999; });
  assert.throws(() => assertVerified(LA_CANDEUR, broken), InvariantError);
});

// --- the four mutation tests ----------------------------------------------

test("MUTATION 1: a broken LH duration sum is caught (invariant 4)", () => {
  // m1 LH is a whole-note chord in La Candeur; make it a half note. The measure
  // now sums to 2 beats instead of 4.
  const broken = mutate(LA_CANDEUR, 0, (m) => { m.lh[0].duration = "h"; });
  assertCaught(LA_CANDEUR, broken, 4, /lh: 4 beats became 2 beats/);
});

test("MUTATION 1b: the tuplet-scaled sum is checked, not the raw token", () => {
  // Drop the tuplet marker off a triplet in Someone Like You. The token is
  // unchanged, so only tuplet-aware math notices: 3 × 1/3 beat becomes 3 × 1/2.
  const i = SLY.measures.findIndex((m) => (m.rh || []).some((e) => e.tuplet));
  assert.ok(i >= 0, "expected a tuplet measure");
  const broken = mutate(SLY, i, (m) => {
    for (const e of m.rh) delete e.tuplet;
  });
  assertCaught(SLY, broken, 4, /rh: /);
});

test("MUTATION 2: a removed RH top note is caught (invariant 5)", () => {
  // Find an RH event with a chord and strip its highest note — exactly what a
  // buggy melody-only would do if it took the wrong end of the array.
  let idx = -1;
  let ev = -1;
  SLY.measures.forEach((m, i) => {
    if (idx >= 0) return;
    (m.rh || []).forEach((e, k) => {
      if (idx < 0 && (e.notes || []).length > 1) { idx = i; ev = k; }
    });
  });
  assert.ok(idx >= 0, "expected an RH chord somewhere");

  const broken = mutate(SLY, idx, (m) => {
    const notes = m.rh[ev].notes;
    const top = Math.max(...notes.map((n) => n.midi));
    m.rh[ev].notes = notes.filter((n) => n.midi !== top);
  });
  assertCaught(SLY, broken, 5, /top note .* became/);
});

test("MUTATION 3: a changed audioOffsetMs is caught (invariant 3)", () => {
  // Give the input a real offset first — the fixtures carry none, and a check
  // that only ever compares null-to-null proves nothing.
  const withOffset = structuredClone(LA_CANDEUR);
  withOffset.measures[4].audioOffsetMs = 14800;

  const good = runIdentity(withOffset);
  assert.deepEqual(verify(withOffset, good), [], "identity preserves a real offset");

  const broken = mutate(withOffset, 4, (m) => { m.audioOffsetMs = 14801; });
  assertCaught(withOffset, broken, 3, /14800 became 14801/);

  // Nulled-out is caught too — the case the export format cares most about.
  const nulled = mutate(withOffset, 4, (m) => { delete m.audioOffsetMs; });
  assertCaught(withOffset, nulled, 3, /14800 became null/);
});

test("MUTATION 4: a dropped measure is caught (invariant 1)", () => {
  const broken = structuredClone(SLY);
  broken.measures.splice(40, 1);
  assertCaught(SLY, broken, 1, /82 measures, output has 81/);
});

// --- seam-aware tie check -------------------------------------------------

test("an unmatched tie end AT A SEAM passes", () => {
  // sourceMeasure 1,2,7 — the jump to 7 makes index 2 a seam. At a seam the
  // note the tie continued from is in a measure the flattening skipped.
  const input = tieSong([1, 2, 7]);
  const output = tieSong([1, 2, 7], [undefined, undefined, "end"]);
  assert.deepEqual(
    verify(input, output).filter((x) => x.invariant === 7),
    [],
    "an unmatched tie end at a seam is legitimate"
  );
});

test("the same unmatched tie end AWAY from a seam fails", () => {
  const input = tieSong([1, 2, 3]);
  const output = tieSong([1, 2, 3], [undefined, undefined, "end"]);
  assertCaught(input, output, 7, /tie end with no start/);
});

test("a half-removed tie chain is caught (invariant 7)", () => {
  // §5.1: a chain is removed whole or not at all. Delete only the `end` and
  // the surviving `start` must be reported.
  const input = tieSong([1, 2, 3], ["start", "end", undefined]);
  assert.deepEqual(verify(input, input).filter((x) => x.invariant === 7), [], "the chain is sound to begin with");
  const output = tieSong([1, 2, 3], ["start", undefined, undefined]);
  assertCaught(input, output, 7, /tie start with no end/);
});

test("a tie orphan already present in the input is not blamed on the transform", () => {
  const withOrphan = tieSong([1, 2, 3], [undefined, "end", undefined]);
  assert.deepEqual(
    verify(withOrphan, runIdentity(withOrphan)).filter((x) => x.invariant === 7),
    [],
    "identity on a song that already had an orphan must not fail"
  );
});

test("real songs produce no tie violations under identity", () => {
  // 229 tied events in Someone Like You, 21 chains crossing barlines.
  assert.deepEqual(verify(SLY, runIdentity(SLY)).filter((x) => x.invariant === 7), []);
  assert.deepEqual(verify(LA_CANDEUR, runIdentity(LA_CANDEUR)).filter((x) => x.invariant === 7), []);
});

// --- invariants 2, 6, 8 ---------------------------------------------------

test("a changed time signature is caught (invariant 2)", () => {
  const broken = mutate(LA_CANDEUR, 0, (m) => { m.timeSignature = { beats: 3, beatType: 4 }; });
  assertCaught(LA_CANDEUR, broken, 2, /became/);
});

test("a dropped common-time symbol is caught (invariant 2)", () => {
  assert.equal(LA_CANDEUR.measures[0].timeSignature.symbol, "common");
  const broken = mutate(LA_CANDEUR, 0, (m) => { delete m.timeSignature.symbol; });
  assertCaught(LA_CANDEUR, broken, 2, /symbol/);
});

test("a removed RH event is caught (invariant 6)", () => {
  const broken = mutate(SLY, 5, (m) => { m.rh.pop(); });
  assertCaught(SLY, broken, 6, /RH had .* events, output has/);
});

test("a changed passthrough field is caught (invariant 8)", () => {
  const withChord = structuredClone(SLY);
  withChord.measures[0].chord = "A";
  const broken = mutate(withChord, 0, (m) => { m.chord = "Am"; });
  assertCaught(withChord, broken, 8, /chord/);

  const srcChanged = mutate(SLY, 10, (m) => { m.sourceMeasure = "99"; });
  assertCaught(SLY, srcChanged, 8, /sourceMeasure/);
});

test("formatViolations names the invariant and the measure", () => {
  const broken = mutate(LA_CANDEUR, 2, (m) => { m.lh[0].duration = "h"; });
  const text = formatViolations(verify(LA_CANDEUR, broken));
  assert.match(text, /\[4: per-hand duration sum\] m3/);
});

// --- the clone guarantee --------------------------------------------------

test("mutating an OUTPUT measure leaves the INPUT measure untouched", () => {
  // Clone-per-measure is load-bearing, not incidental. The parser aliases event
  // arrays across flattened repeats, so a transform that returned the input's
  // own objects would let a later edit reach back into the source — and on a
  // repeated measure, into a DIFFERENT measure as well. Nothing else in the
  // suite fails if a refactor drops the clone, so this does.
  for (const doc of [LA_CANDEUR, SLY]) {
    const out = runIdentity(doc);
    const before = JSON.stringify(doc);

    out.measures.forEach((m) => {
      m.timeSignature.beats = 99;
      m.audioOffsetMs = 12345;
      if (m.rh?.[0]?.notes?.[0]) m.rh[0].notes[0].midi = 0;
      if (m.lh?.[0]) m.lh[0].duration = "w";
      m.chord = "MUTATED";
    });

    assert.equal(JSON.stringify(doc), before, "the input document was written through");
  }
});

test("output measures do not alias each other across repeats", () => {
  // La Candeur m9 is a flattened repeat of m1. In the parser's own output those
  // two share an `rh` array; after the transform they must not.
  const out = runIdentity(LA_CANDEUR);
  assert.notEqual(out.measures[0].rh, out.measures[8].rh, "m1 and m9 share an rh array");
  out.measures[8].rh[0].notes[0].midi = 0;
  assert.notEqual(out.measures[0].rh[0].notes[0].midi, 0, "editing m9 reached m1");
});
