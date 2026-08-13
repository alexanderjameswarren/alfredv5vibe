// M1 — plan format and validation.
//
// Run: npm test    (node --test, no test framework dependency)
//
// The rejection cases matter more than the acceptance case. The settings
// vocabulary is the line between "a model picked from a list" and "a model
// wrote music"; a typo that degrades silently to a default would erode it, so
// every one of these must throw rather than warn.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadPlan, parseMeasureList, PlanError, SETTING_KEYS,
  effectiveSettings, SETTING_DEFAULTS, inertSettings, lhActive, rhActive,
} from "../lib/plan.js";

// The reference plan from spec §3.
const REFERENCE_PLAN = {
  planVersion: 1,
  sourceSongId: "030333d9-1b9f-4f74-80fb-7fbed587fda6",
  label: "melody only · quarter chords",
  default: {
    lhGrid: "quarter",
    lhFill: "onset",
    lhCap: 2,
    lhKeep: "root-third",
    rhStack: "melody-only",
  },
  ranges: [{ measures: "37,57-61,68,79-82", settings: null }],
};

const load = (plan, measureCount = 82) => loadPlan(plan, { measureCount });

/** Assert the call throws a PlanError whose text matches every pattern. */
function assertRejects(fn, ...patterns) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "expected a PlanError, but nothing was thrown");
  assert.equal(thrown.name, "PlanError", `expected PlanError, got ${thrown.name}: ${thrown.message}`);
  for (const p of patterns) {
    assert.match(thrown.message, p);
  }
  return thrown;
}

// --- acceptance -----------------------------------------------------------

test("the reference plan parses", () => {
  const p = load(REFERENCE_PLAN);
  assert.equal(p.planVersion, 1);
  assert.equal(p.label, "melody only · quarter chords");
  assert.equal(p.sourceSongId, "030333d9-1b9f-4f74-80fb-7fbed587fda6");
  assert.deepEqual(p.defaultSettings, REFERENCE_PLAN.default);
});

test("the reference plan's untouched measures are exactly the ten comfortable ones", () => {
  const p = load(REFERENCE_PLAN);
  assert.deepEqual(p.untouchedMeasures, [37, 57, 58, 59, 60, 61, 68, 79, 80, 81, 82]);
});

test("settings: null resolves to untouched, everything else to the default", () => {
  const p = load(REFERENCE_PLAN);
  assert.equal(p.settingsFor(37), null, "m37 is in a null range");
  assert.equal(p.settingsFor(59), null, "m59 is inside 57-61");
  assert.deepEqual(p.settingsFor(1), effectiveSettings(REFERENCE_PLAN.default), "m1 is not in any range");
  assert.deepEqual(p.settingsFor(82), null, "m82 is the last measure of 79-82");
});

test("gating settings default to OFF, so `default: {}` is the identity transform", () => {
  const p = load({ planVersion: 1, sourceSongId: "test-source", default: {} });
  const s = p.settingsFor(1);
  assert.equal(s.lhGrid, "none", "LH quantization must be off when unasked for");
  assert.equal(s.rhStack, "all", "RH thinning must be off when unasked for");
  assert.equal(lhActive(s), false);
  assert.equal(rhActive(s), false);
});

test("modifier settings keep their §4 defaults", () => {
  const s = load({ planVersion: 1, sourceSongId: "test-source", default: {} }).settingsFor(1);
  assert.equal(s.lhFill, "onset");
  assert.equal(s.lhCap, 2);
  assert.equal(s.lhKeep, "root-third");
});

test("a modifier without its parent active is inert, not an error", () => {
  // {"lhFill": "union"} with no lhGrid is accepted and does nothing.
  const p = load({ planVersion: 1, sourceSongId: "test-source", default: { lhFill: "union", lhCap: 4 } });
  assert.equal(lhActive(p.settingsFor(1)), false);
  assert.deepEqual(inertSettings({ lhFill: "union", lhCap: 4 }).sort(), ["lhCap", "lhFill"]);
});

test("a modifier WITH its parent active is not inert", () => {
  assert.deepEqual(inertSettings({ lhGrid: "quarter", lhFill: "union" }), []);
});

test("effectiveSettings fills the whole vocabulary", () => {
  assert.deepEqual(effectiveSettings({}), SETTING_DEFAULTS);
  assert.deepEqual(effectiveSettings({ lhGrid: "half" }), { ...SETTING_DEFAULTS, lhGrid: "half" });
});

test("a range's partial settings override the default key by key", () => {
  const p = load({
    planVersion: 1, sourceSongId: "test-source",
    default: { lhGrid: "quarter", lhCap: 2, rhStack: "melody-only" },
    ranges: [{ measures: "5-6", settings: { lhCap: 4 } }],
  });
  assert.deepEqual(p.settingsFor(5), effectiveSettings({ lhGrid: "quarter", lhCap: 4, rhStack: "melody-only" }));
  assert.deepEqual(p.settingsFor(4), effectiveSettings({ lhGrid: "quarter", lhCap: 2, rhStack: "melody-only" }));
});

test("resolved settings always carry the whole vocabulary", () => {
  const p = load({ planVersion: 1, sourceSongId: "test-source", default: {} });
  for (const k of SETTING_KEYS) {
    assert.ok(k in p.settingsFor(1), `${k} should be resolved`);
  }
  assert.deepEqual(p.defaultSettings, {}, "the raw plan default is preserved unfilled");
});

test("ranges are optional", () => {
  const p = load({ planVersion: 1, sourceSongId: "test-source", default: { lhGrid: "none" } });
  assert.deepEqual(p.ranges, []);
  assert.deepEqual(p.untouchedMeasures, []);
});

test("every setting in the vocabulary is accepted at each of its values", () => {
  const vocab = {
    lhGrid: ["none", "whole", "half", "quarter", "eighth"],
    lhFill: ["onset", "union"],
    lhCap: [1, 2, 3, 4],
    lhKeep: ["root-third", "root-fifth"],
    rhStack: ["all", "melody-plus-one", "melody-only"],
  };
  assert.deepEqual(Object.keys(vocab).sort(), [...SETTING_KEYS].sort());
  for (const [key, values] of Object.entries(vocab)) {
    for (const v of values) {
      assert.doesNotThrow(
        () => load({ planVersion: 1, sourceSongId: "test-source", default: { [key]: v } }),
        `${key}: ${JSON.stringify(v)} should be accepted`
      );
    }
  }
});

test("a plan loads from a file path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "samplan-"));
  const file = path.join(dir, "reference.json");
  fs.writeFileSync(file, JSON.stringify(REFERENCE_PLAN));
  const p = loadPlan(file, { measureCount: 82 });
  assert.equal(p.planVersion, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the five rejection cases ---------------------------------------------

test("rejection 1: an unknown enum value fails, naming the key and the value", () => {
  const e = assertRejects(
    () => load({ planVersion: 1, sourceSongId: "test-source", default: { lhFill: "banana" } }),
    /lhFill/,
    /banana/,
    /allowed: "onset", "union"/
  );
  assert.equal(e.errors.length, 1);
});

test("rejection 2: an unknown setting key fails, naming the offending key", () => {
  assertRejects(
    () => load({ planVersion: 1, sourceSongId: "test-source", default: { lhGrid: "quarter", lhWobble: 3 } }),
    /unknown key "lhWobble"/,
    /settings vocabulary/
  );
});

test("rejection 2b: an unknown TOP-LEVEL key fails too", () => {
  assertRejects(
    () => load({ planVersion: 1, sourceSongId: "test-source", default: {}, transpose: -2 }),
    /unknown key "transpose"/
  );
});

test("rejection 3: overlapping ranges are rejected, not resolved by order", () => {
  assertRejects(
    () => load({
      planVersion: 1, sourceSongId: "test-source",
      default: {},
      ranges: [
        { measures: "10-20", settings: null },
        { measures: "15", settings: { lhCap: 1 } },
      ],
    }),
    /measure 15 appears in more than one range/,
    /not resolved by order/
  );
});

test("rejection 4: a measure outside the song is rejected", () => {
  assertRejects(
    () => load({ planVersion: 1, sourceSongId: "test-source", default: {}, ranges: [{ measures: "80-90", settings: null }] }, 82),
    /outside the song, which has 82 measures/,
    /83/
  );
});

test("rejection 5: a malformed range string is rejected", () => {
  assertRejects(
    () => load({ planVersion: 1, sourceSongId: "test-source", default: {}, ranges: [{ measures: "5..9", settings: null }] }),
    /malformed entry "5\.\.9"/
  );
});

// --- further hard errors --------------------------------------------------

test("a descending range is rejected with the correction spelled out", () => {
  assertRejects(() => parseMeasureList("61-57"), /descending range "61-57"/, /"57-61"/);
});

test("a duplicate inside one range string is rejected", () => {
  assertRejects(() => parseMeasureList("37,37"), /measure 37 appears more than once/);
  assertRejects(() => parseMeasureList("10-12,11"), /measure 11 appears more than once/);
});

test("stray commas are rejected", () => {
  assertRejects(() => parseMeasureList("37,,39"), /empty entry/);
  assertRejects(() => parseMeasureList("37,"), /empty entry/);
});

test("measure 0 is rejected", () => {
  assertRejects(() => parseMeasureList("0-4"), /measure numbers start at 1/);
});

test("an omitted `settings` key is rejected — untouched must be explicit", () => {
  assertRejects(
    () => load({ planVersion: 1, sourceSongId: "test-source", default: {}, ranges: [{ measures: "5" }] }),
    /missing required key "settings"/
  );
});

test("a missing `default` is rejected", () => {
  assertRejects(() => load({ planVersion: 1 }), /missing required key "default"/);
});

test("an unknown planVersion is rejected", () => {
  assertRejects(() => load({ planVersion: 2, default: {} }), /planVersion/);
});

test("lhCap outside 1-4 is rejected", () => {
  assertRejects(() => load({ planVersion: 1, sourceSongId: "test-source", default: { lhCap: 0 } }), /lhCap/);
  assertRejects(() => load({ planVersion: 1, sourceSongId: "test-source", default: { lhCap: 5 } }), /lhCap/);
});

test("every error is collected, not just the first", () => {
  const e = assertRejects(() =>
    load({
      planVersion: 1, sourceSongId: "test-source",
      default: { lhFill: "banana", lhGrid: "octuple" },
    })
  );
  assert.ok(e.errors.length >= 2, `expected multiple errors, got ${e.errors.length}`);
});

test("settingsFor rejects a measure outside the song", () => {
  const p = load(REFERENCE_PLAN);
  assertRejects(() => p.settingsFor(83), /outside the song/);
  assertRejects(() => p.settingsFor(0), /outside the song/);
});

test("loadPlan requires a measureCount to range-check against", () => {
  assertRejects(() => loadPlan(REFERENCE_PLAN, {}), /measureCount must be a positive integer/);
});

// --- range parsing detail -------------------------------------------------

test("parseMeasureList handles singles, ranges and whitespace", () => {
  assert.deepEqual(parseMeasureList("37,57-61,68"), [37, 57, 58, 59, 60, 61, 68]);
  assert.deepEqual(parseMeasureList("  37 , 57 - 61 ,68  "), [37, 57, 58, 59, 60, 61, 68]);
  assert.deepEqual(parseMeasureList("5"), [5]);
  assert.deepEqual(parseMeasureList("5-5"), [5]);
});

test("parseMeasureList returns ascending order regardless of input order", () => {
  assert.deepEqual(parseMeasureList("68,37,57-58"), [37, 57, 58, 68]);
});
