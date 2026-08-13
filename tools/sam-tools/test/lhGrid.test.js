// M3 — LH grid quantization.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { readScoreXml } = await import("../lib/mxl.js");
const { loadPlan } = await import("../lib/plan.js");
const { simplifyMeasures } = await import("../lib/simplify.js");
const { verify, formatViolations } = await import("../lib/verify.js");
const { quantizeHand, applyCap, GRID_BEATS } = await import("../lib/lhGrid.js");
const { sumEvents } = await import("../lib/durations.js");

const SLY = JSON.parse(
  JSON.stringify(parseMusicXML(readScoreXml("fixtures/someone-like-you-easy-piano.mxl")))
);
const m = (n) => SLY.measures[n - 1];

const settings = (o = {}) => ({
  lhGrid: "quarter", lhFill: "onset", lhCap: 2, lhKeep: "root-third", ...o,
});
const shape = (evs) =>
  evs.map((e) => `${e.duration}:${e.notes.map((n) => n.name).join("+") || "rest"}`);
const note = (midi, name) => ({ midi, name });
const ev = (duration, notes, extra) => ({ duration, notes, ...extra });

// --- cell division and duration preservation ------------------------------

test("`none` is a no-op and returns the same array", () => {
  const r = quantizeHand(m(1).lh, settings({ lhGrid: "none" }), m(1).timeSignature);
  assert.equal(r.changed, false);
  assert.equal(r.events, m(1).lh);
});

test("per-hand duration sum is preserved at every grid size", () => {
  for (const grid of ["whole", "half", "quarter", "eighth"]) {
    for (const measure of SLY.measures) {
      const before = sumEvents(measure.lh || []);
      const r = quantizeHand(measure.lh || [], settings({ lhGrid: grid }), measure.timeSignature);
      const after = sumEvents(r.events);
      assert.ok(
        Math.abs(before - after) < 1e-9,
        `${grid} m${measure.number}: ${before} beats became ${after}`
      );
    }
  }
});

test("a measure whose LH overruns its signature keeps its own span", () => {
  // Old-parser damage: several Someone Like You measures have an LH running
  // longer than the bar. Gridding to the signature would rewrite the sum and
  // trip invariant 4; gridding to the hand's actual span preserves it.
  const overrun = SLY.measures.filter(
    (x) => Math.abs(sumEvents(x.lh || []) - 4) > 1e-9 && (x.lh || []).length > 0
  );
  assert.ok(overrun.length > 0, "expected at least one overrunning LH");
  for (const x of overrun) {
    const before = sumEvents(x.lh);
    const r = quantizeHand(x.lh, settings(), x.timeSignature);
    assert.ok(Math.abs(sumEvents(r.events) - before) < 1e-9, `m${x.number}`);
  }
});

test("cell count follows the grid size", () => {
  for (const [grid, cells] of [["whole", 1], ["half", 2], ["quarter", 4], ["eighth", 8]]) {
    const r = quantizeHand(m(1).lh, settings({ lhGrid: grid }), m(1).timeSignature);
    assert.equal(r.events.length, cells, `${grid} should give ${cells} cell(s)`);
    assert.equal(r.events[0].duration, { whole: "w", half: "h", quarter: "q", eighth: "8" }[grid]);
  }
});

// --- fills ----------------------------------------------------------------

test("SLY m1 at quarter/onset/cap2/root-third — four quarter events", () => {
  const r = quantizeHand(m(1).lh, settings(), m(1).timeSignature);
  assert.equal(r.changed, true);
  assert.equal(r.events.length, 4);
  // NOTE: this is A3 alone, NOT the A3+C#4 the tracker's exit criterion names.
  // m1's LH is sixteen single sixteenths (A3 C#4 E4 C#4 …), so the only pitch
  // sounding AT beat 0 is A3 — which is what spec §4.2 defines `onset` to take.
  // Raised for decision; see the progress Notes.
  assert.deepEqual(shape(r.events), ["q:A3", "q:A3", "q:A3", "q:A3"]);
});

test("SLY m1 at quarter/union/cap2/root-third — four A3+C#4 quarter events", () => {
  const r = quantizeHand(m(1).lh, settings({ lhFill: "union" }), m(1).timeSignature);
  assert.deepEqual(shape(r.events), ["q:A3+C#4", "q:A3+C#4", "q:A3+C#4", "q:A3+C#4"]);
});

test("onset and union differ on SLY m1 — the cell is arpeggiated", () => {
  const on = quantizeHand(m(1).lh, settings(), m(1).timeSignature);
  const un = quantizeHand(m(1).lh, settings({ lhFill: "union" }), m(1).timeSignature);
  assert.notDeepEqual(shape(on.events), shape(un.events));
});

test("union gathers a harmony that changes mid-cell; onset takes only the downbeat", () => {
  // Half grid over an arpeggio: the union of beats 0–2 is the whole triad.
  const on = quantizeHand(m(1).lh, settings({ lhGrid: "half", lhCap: 3 }), m(1).timeSignature);
  const un = quantizeHand(
    m(1).lh, settings({ lhGrid: "half", lhFill: "union", lhCap: 3 }), m(1).timeSignature
  );
  assert.deepEqual(shape(on.events), ["h:A3", "h:A3"]);
  assert.deepEqual(shape(un.events), ["h:A3+C#4+E4", "h:A3+C#4+E4"]);
});

test("onset fallback: a cell starting mid-note takes the note holding through it", () => {
  // A half note across beats 0–2, then four eighths. Five events into four
  // cells, so the density floor allows it. The cell at beat 1 begins inside the
  // half note and must inherit it rather than emitting a rest.
  const lh = [
    ev("h", [note(48, "C3")]),
    ev("8", [note(50, "D3")]), ev("8", [note(52, "E3")]),
    ev("8", [note(53, "F3")]), ev("8", [note(55, "G3")]),
  ];
  const r = quantizeHand(lh, settings(), { beats: 4, beatType: 4 });
  assert.equal(r.changed, true);
  assert.deepEqual(shape(r.events), ["q:C3", "q:C3", "q:D3", "q:F3"]);
});

test("onset fallback: a cell landing in a rest emits a rest", () => {
  // A rest is not a sounding event, so nothing carries into it.
  const lh = [
    ev("8", [note(48, "C3")]), ev("8", [note(48, "C3")]),
    ev("h", []),
    ev("8", [note(52, "E3")]), ev("8", [note(53, "F3")]),
  ];
  const r = quantizeHand(lh, settings(), { beats: 4, beatType: 4 });
  assert.equal(r.changed, true);
  assert.deepEqual(shape(r.events), ["q:C3", "q:rest", "q:rest", "q:E3"]);
});

// --- cap and keep ---------------------------------------------------------

test("root-third keeps the lowest `cap` notes", () => {
  const chord = [note(48, "C3"), note(52, "E3"), note(55, "G3"), note(60, "C4")];
  assert.deepEqual(applyCap(chord, 2, "root-third").map((n) => n.name), ["C3", "E3"]);
  assert.deepEqual(applyCap(chord, 3, "root-third").map((n) => n.name), ["C3", "E3", "G3"]);
});

test("root-fifth keeps the outer pair, then fills inward from the bottom", () => {
  const chord = [note(48, "C3"), note(52, "E3"), note(55, "G3"), note(60, "C4")];
  assert.deepEqual(applyCap(chord, 2, "root-fifth").map((n) => n.name), ["C3", "C4"]);
  assert.deepEqual(applyCap(chord, 3, "root-fifth").map((n) => n.name), ["C3", "E3", "C4"]);
});

test("a chord already within the cap is untouched, and output stays pitch-ascending", () => {
  const chord = [note(55, "G3"), note(48, "C3")];
  assert.deepEqual(applyCap(chord, 4, "root-third").map((n) => n.midi), [48, 55]);
});

test("cap applies through the grid", () => {
  const r = quantizeHand(
    m(1).lh, settings({ lhFill: "union", lhCap: 1 }), m(1).timeSignature
  );
  assert.deepEqual(shape(r.events), ["q:A3", "q:A3", "q:A3", "q:A3"]);
});

// --- density floor --------------------------------------------------------

test("DENSITY FLOOR: a sustained whole-note LH is unchanged at quarter grid", () => {
  // SLY m79 is one whole-note LH dyad. Four repeated quarter chords would be
  // harder to play than the original, not easier.
  assert.equal(m(79).lh.length, 1);
  const r = quantizeHand(m(79).lh, settings(), m(79).timeSignature);
  assert.equal(r.changed, false);
  assert.match(r.reason, /density floor/);
  assert.equal(r.events, m(79).lh);
});

test("DENSITY FLOOR: an equal count is refused too — the grid must strictly reduce", () => {
  const lh = [
    ev("q", [note(48, "C3")]), ev("q", [note(50, "D3")]),
    ev("q", [note(52, "E3")]), ev("q", [note(53, "F3")]),
  ];
  const r = quantizeHand(lh, settings(), { beats: 4, beatType: 4 });
  assert.equal(r.changed, false, "4 events gridded to 4 cells is not a reduction");
});

test("DENSITY FLOOR: the same measure IS quantized at a coarser grid", () => {
  const lh = [
    ev("q", [note(48, "C3")]), ev("q", [note(50, "D3")]),
    ev("q", [note(52, "E3")]), ev("q", [note(53, "F3")]),
  ];
  const r = quantizeHand(lh, settings({ lhGrid: "half" }), { beats: 4, beatType: 4 });
  assert.equal(r.changed, true);
  assert.deepEqual(shape(r.events), ["h:C3", "h:E3"]);
});

test("an empty LH is left alone", () => {
  const r = quantizeHand([], settings(), { beats: 4, beatType: 4 });
  assert.equal(r.changed, false);
});

// --- tuplet guard ---------------------------------------------------------

test("TUPLET GUARD: an eighth boundary inside a triplet group leaves it verbatim", () => {
  // SLY m51 LH is twelve 16ths then a triplet-eighth group over beats 3–4. At
  // eighth grid the boundary at 3.5 falls inside the group.
  const src = m(51);
  assert.equal(src.lh.filter((e) => e.tuplet).length, 3);

  const r = quantizeHand(src.lh, settings({ lhGrid: "eighth" }), src.timeSignature);
  assert.equal(r.changed, true);
  const kept = r.events.filter((e) => e.tuplet);
  assert.equal(kept.length, 3, "the triplet group survived");
  assert.deepEqual(kept.map((e) => e.duration), ["8", "8", "8"]);
  assert.deepEqual(kept.map((e) => e.tuplet), src.lh.filter((e) => e.tuplet).map((e) => e.tuplet));
  assert.ok(Math.abs(sumEvents(r.events) - sumEvents(src.lh)) < 1e-9);
});

test("TUPLET GUARD: a boundary on the group EDGE is not inside it, so it grids", () => {
  // The same group at quarter grid — boundaries at 1, 2, 3 — is untouched by
  // the guard, because 3 is the group's start, not a point within it.
  const src = m(51);
  const r = quantizeHand(src.lh, settings({ lhGrid: "quarter" }), src.timeSignature);
  assert.equal(r.events.filter((e) => e.tuplet).length, 0);
  assert.equal(r.events.length, 4);
});

// --- full-song runs -------------------------------------------------------

const gridPlan = (o) =>
  loadPlan({ planVersion: 1, default: settings(o) }, { measureCount: SLY.measures.length });

test("every §5 invariant passes on a full-song grid run, at every grid size and both fills", () => {
  for (const lhGrid of ["whole", "half", "quarter", "eighth"]) {
    for (const lhFill of ["onset", "union"]) {
      const r = simplifyMeasures(SLY, gridPlan({ lhGrid, lhFill }));
      const v = verify(SLY, { ...SLY, measures: r.measures });
      assert.deepEqual(v, [], `${lhGrid}/${lhFill}: ${formatViolations(v)}`);
    }
  }
});

test("a full-song quarter grid reduces LH events and records every skip", () => {
  const r = simplifyMeasures(SLY, gridPlan());
  const before = SLY.measures.reduce((n, x) => n + (x.lh || []).length, 0);
  const after = r.measures.reduce((n, x) => n + (x.lh || []).length, 0);
  assert.ok(after < before, `LH events ${before} -> ${after}`);

  // Skips are recorded with a reason — never silent (§7).
  assert.ok(r.skipped.length > 0);
  for (const s of r.skipped) {
    assert.equal(s.hand, "lh");
    assert.ok(s.reason && s.reason.length > 0, `m${s.measure} skipped with no reason`);
  }
  // Every skipped measure's LH is bit-identical to the original.
  for (const s of r.skipped) {
    assert.deepEqual(r.measures[s.measure - 1].lh, SLY.measures[s.measure - 1].lh);
  }
});

test("LH ties do not survive quantization half-removed", () => {
  // SLY's only LH tie chains are m79->m80->m81, all sustained whole notes that
  // the density floor protects, so they come through intact rather than being
  // half-stripped. Invariant 7 is what would catch it otherwise.
  const r = simplifyMeasures(SLY, gridPlan());
  const v = verify(SLY, { ...SLY, measures: r.measures }).filter((x) => x.invariant === 7);
  assert.deepEqual(v, []);
  for (const n of [79, 80, 81]) {
    assert.deepEqual(r.measures[n - 1].lh, SLY.measures[n - 1].lh);
  }
});

test("quantization does not write through into the input", () => {
  const before = JSON.stringify(SLY);
  const r = simplifyMeasures(SLY, gridPlan());
  r.measures.forEach((x) => { if (x.lh?.[0]) x.lh[0].duration = "w"; });
  assert.equal(JSON.stringify(SLY), before);
});

test("rhStack is still a loud error while M4 is unbuilt", () => {
  const plan = loadPlan(
    { planVersion: 1, default: { lhGrid: "quarter", rhStack: "melody-only" } },
    { measureCount: SLY.measures.length }
  );
  assert.throws(() => simplifyMeasures(SLY, plan), /M4/);
});

test("GRID_BEATS covers exactly the lhGrid vocabulary", () => {
  assert.deepEqual(Object.keys(GRID_BEATS), ["none", "whole", "half", "quarter", "eighth"]);
  assert.equal(GRID_BEATS.none, null);
});
