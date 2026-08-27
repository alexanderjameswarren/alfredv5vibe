// M4 — hand assignment.
//
// Two things live here, and they are deliberately different in kind.
//
//   1. The EXPECTATION test. §3.6's run-length threshold is a tunable policy
//      constant, so it is pinned here against the real corpus rather than in
//      the oracle. This is the test that fails if someone changes AWAY_RUN_MIN.
//
//   2. The INVARIANT tests. validate.js's handAssignmentInvariants checks
//      properties that hold for ANY correct assignment, whatever policy
//      produced it. They are driven with synthetic routings, including bad
//      ones — an invariant that has never fired has not been tested.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("", { contentType: "text/html" }).window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");
const { buildTruth } = await import("../lib/xmlTruth.js");
const { readScoreXml } = await import("../lib/mxl.js");
const { handAssignmentInvariants, validate } = await import("../lib/validate.js");

const FIXTURES = [
  "Carol_of_the_Bells_easy_piano.mxl",
  "The_Entertainer_-_Scott_Joplin_-_1902.mxl",
  "auld-lang-syne.mxl",
  "beverly-hills-weezer.mxl",
  "burgmuller-arabesque-op-100-no-2.mxl",
  "burgmuller-etude-3-pastorale.mxl",
  "etude-in-c-major-la-candeur-op100-no-1-burgmuller.mxl",
  "fur-elise-beethoven.mxl",
  "js-bach-invention-no-1-in-c-major.mxl",
  "prelude-in-c-minor-bwv-999-bach.mxl",
  "say-it-aint-so-by-weezer.mxl",
  "someone-like-you-easy-piano.mxl",
  "sonate-no-14-moonlight-1st-movement.mxl",
];

const parsedOf = (f) => parseMusicXML(readScoreXml(`fixtures/${f}`));

/** voice -> sorted list of 1-based source measures routed to `staff`. */
function measuresOnStaff(parsed, staff) {
  const out = new Map();
  (parsed.handRouting || []).forEach((map, i) => {
    for (const [voice, s] of Object.entries(map || {})) {
      if (s !== staff) continue;
      if (!out.has(voice)) out.set(voice, []);
      out.get(voice).push(i + 1);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 1. The expectation test — this is where the run-length constant is pinned.
// ---------------------------------------------------------------------------

test("EXPECTATION: only Moonlight changes hand mid-song; the other 12 never do", () => {
  for (const f of FIXTURES) {
    if (f === "sonate-no-14-moonlight-1st-movement.mxl") continue;
    const parsed = parsedOf(f);
    const onLh = measuresOnStaff(parsed, "2");
    const onRh = measuresOnStaff(parsed, "1");
    for (const voice of new Set([...onLh.keys(), ...onRh.keys()])) {
      const inBoth = onLh.has(voice) && onRh.has(voice);
      assert.equal(inBoth, false,
        `${f}: voice ${voice} was routed to both hands — no fixture but Moonlight should`);
    }
  }
});

test("EXPECTATION: Moonlight voice 1 goes left-hand exactly at m38-41 and m66-67", () => {
  const onLh = measuresOnStaff(parsedOf("sonate-no-14-moonlight-1st-movement.mxl"), "2");
  assert.deepEqual(onLh.get("1"), [38, 39, 40, 41, 66, 67]);
});

test("EXPECTATION: Moonlight voice 2 goes left-hand exactly at m13-14, 21-22, 37-40, 58-59, 68-69", () => {
  const onLh = measuresOnStaff(parsedOf("sonate-no-14-moonlight-1st-movement.mxl"), "2");
  assert.deepEqual(onLh.get("2"), [13, 14, 21, 22, 37, 38, 39, 40, 58, 59, 68, 69]);
});

test("EXPECTATION: Moonlight's isolated single bars m31, m63, m65 stay right-hand", () => {
  // The run-length threshold is what keeps these where they are. Alex:
  // in all three the left hand is holding a bass octave through the whole bar
  // and has no capacity, and the arpeggio figure doesn't break — a momentary
  // right-hand cross, engraved on the bass staff to avoid ledger lines.
  const routing = parsedOf("sonate-no-14-moonlight-1st-movement.mxl").handRouting;
  for (const m of [31, 63, 65]) {
    for (const voice of ["1", "2"]) {
      const staff = routing[m - 1][voice];
      if (staff === undefined) continue;   // voice not sounding in that bar
      assert.equal(staff, "1",
        `m${m} voice ${voice} should stay right-hand; a run of 1 must not flip`);
    }
  }
});

test("EXPECTATION: The Entertainer's m1 pickup keeps voice 5 in the left hand", () => {
  // Both hands play the same figure an octave apart and the whole bar is
  // engraved on the treble staff. Voice 5 is genuinely the left hand, written
  // high. This is the case the run-length rule exists to protect: following the
  // engraving here would put both lines in the right hand.
  const parsed = parsedOf("The_Entertainer_-_Scott_Joplin_-_1902.mxl");
  assert.equal(parsed.handRouting[0]["5"], "2");
  assert.equal(parsed.handRouting[0]["1"], "1");
});

test("EXPECTATION: Moonlight m6's cross-staff arpeggio stays whole in the right hand", () => {
  // The case §3.6 exists for: voice 2 is one arpeggio written D#4/F#4 on the
  // treble staff and G#3 on the bass. A split measure is never re-routed.
  const routing = parsedOf("sonate-no-14-moonlight-1st-movement.mxl").handRouting;
  assert.equal(routing[5]["2"], "1");
  assert.equal(routing[5]["1"], "1");
});

test("EXPECTATION: every fixture validates with no hand-assignment finding", () => {
  for (const f of FIXTURES) {
    const result = validate(readScoreXml(`fixtures/${f}`), f);
    const hits = result.findings.filter((x) => x.defect === "hand_assignment_mismatch");
    assert.deepEqual(hits, [], `${f} produced ${hits.length} hand-assignment finding(s)`);
  }
});

// ---------------------------------------------------------------------------
// 2. The invariants — driven with deliberately broken routings.
// ---------------------------------------------------------------------------

const MOON = "sonate-no-14-moonlight-1st-movement.mxl";

function moonlight() {
  const xml = readScoreXml(`fixtures/${MOON}`);
  const parsed = parseMusicXML(xml);
  const routing = parsed.handRouting.map((o) => new Map(Object.entries(o)));
  return { parsed, truth: buildTruth(xml, { routing }) };
}

test("the real Moonlight routing satisfies every invariant", () => {
  const { parsed, truth } = moonlight();
  assert.deepEqual(handAssignmentInvariants(parsed, truth), []);
});

test("I1 fires when one voice lands in both hands inside one measure", () => {
  const { parsed, truth } = moonlight();
  const broken = {
    ...parsed,
    measures: parsed.measures.map((m, i) =>
      i !== 0 ? m : {
        ...m,
        rh: [{ duration: "q", voice: "9", notes: [{ midi: 60, name: "C4" }] }],
        lh: [{ duration: "q", voice: "9", notes: [{ midi: 48, name: "C3" }] }],
      }
    ),
  };
  const hits = handAssignmentInvariants(broken, truth);
  assert.ok(hits.some((h) => /BOTH hands within one measure/.test(h.detail)),
    `expected an I1 finding, got: ${JSON.stringify(hits)}`);
});

test("I2 fires when a voice is routed somewhere the source gives no basis for", () => {
  const { parsed, truth } = moonlight();
  // Voice 5 is engraved only on the bass staff and lives there. Move it to the
  // treble for two bars: no engraving basis, and not its home staff.
  const routing = parsed.handRouting.map((o) => ({ ...o }));
  routing[4]["5"] = "1";
  routing[5]["5"] = "1";
  const hits = handAssignmentInvariants({ ...parsed, handRouting: routing }, truth);
  assert.ok(hits.some((h) => /no basis for that placement/.test(h.detail)),
    `expected an I2 finding, got: ${JSON.stringify(hits)}`);
});

test("I2 does NOT fire when a voice returns from an away run to its home staff", () => {
  // Moonlight m23: voice 2 comes back to the right hand after the m21-22 run,
  // and m23 is a split measure. The return is legitimate and must stay silent.
  const { parsed, truth } = moonlight();
  const hits = handAssignmentInvariants(parsed, truth);
  assert.deepEqual(hits.filter((h) => h.measure === 23), []);
});

test("I3 fires when a single-staff voice is routed off its staff", () => {
  const { parsed, truth } = moonlight();
  const routing = parsed.handRouting.map((o) => ({ ...o }));
  // Voice 6 appears only on the bass staff all song. Send one bar to the treble.
  const idx = routing.findIndex((m) => m["6"] !== undefined);
  assert.ok(idx >= 0, "expected voice 6 somewhere in Moonlight");
  routing[idx]["6"] = "1";
  const hits = handAssignmentInvariants({ ...parsed, handRouting: routing }, truth);
  assert.ok(hits.some((h) => /engraved only ever on staff/.test(h.detail)),
    `expected an I3 finding, got: ${JSON.stringify(hits)}`);
});

test("I4 fires when a voice's dominant hand is inverted", () => {
  const { parsed, truth } = moonlight();
  // Voice 1 is engraved mostly on the treble staff. Route the whole song to the
  // bass and the dominant hand no longer matches the majority engraving.
  const routing = parsed.handRouting.map((o) =>
    o["1"] === undefined ? { ...o } : { ...o, 1: "2" }
  );
  const hits = handAssignmentInvariants({ ...parsed, handRouting: routing }, truth);
  assert.ok(hits.some((h) => /dominant hand is inverted/.test(h.detail)),
    `expected an I4 finding, got: ${JSON.stringify(hits)}`);
});

test("the invariants are skipped for sources §3.6 does not apply to", () => {
  const { parsed } = moonlight();
  const hits = handAssignmentInvariants(parsed, {
    applyThreeSix: false,
    measures: [],
    voiceStaffTallies: new Map(),
  });
  assert.deepEqual(hits, []);
});
