// Duration math: every copy agrees, numerically, on every shared function.
//
// There are four copies of the token <-> beats rules:
//
//   LIB     tools/sam-tools/lib/durations.js          the original; the CLI
//                                                     analyzer imports THIS one
//   SRC     src/sam/lib/durations.js                  the app's copy (a superset)
//   VENDOR  tools/sam-tools/vendor/durations.js       `npm run sync` copy of SRC
//   DENO    supabase/functions/_shared/durations.ts   the Edge Function port
//
// The app's jest suite used to be the only guard, and it compared nothing but
// the BASE map between SRC and DENO — LIB, the file the analyzer runs on, was
// untested. This compares every function each pair of copies shares, over
// inputs chosen to hit the edges (dots, tuplets, unknown tokens, odd time
// signatures, non-representable beat values), with exact equality: a rounding
// difference is a failure, not a tolerance.
//
// The DENO copy is loaded through Node's built-in TypeScript type stripping
// (Node >= 23.6), which runs the same JavaScript Deno would.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const LIB = await import("../lib/durations.js");
const SRC = await import("../../../src/sam/lib/durations.js");
const VENDOR = await import("../vendor/durations.js");
const DENO = await import("../../../supabase/functions/_shared/durations.ts");

const COPIES = { LIB, SRC, VENDOR, DENO };

// What each copy exports. Pinned so that a function added to any copy fails
// here until it is either covered below or deliberately listed as local.
const SHARED = ["tokenToBeats", "measureBeats", "sumEvents", "ALL_TOKENS", "beatsToToken", "beatsToTokens", "isKnownToken"];
const EXPECTED_EXPORTS = {
  LIB: SHARED,
  SRC: [...SHARED, "ONSET_EPS", "toTimeline", "fromTimeline"], // timeline helpers: app-only
  VENDOR: [...SHARED, "ONSET_EPS", "toTimeline", "fromTimeline"],
  DENO: ["BASE", "tokenToBeats", "measureBeats", "sumEvents"],
};

test("each copy exports exactly the expected surface", () => {
  for (const [name, mod] of Object.entries(COPIES)) {
    assert.deepEqual(Object.keys(mod).sort(), [...EXPECTED_EXPORTS[name]].sort(), name);
  }
});

test("VENDOR is a byte-identical copy of SRC (run `npm run sync` if not)", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(read("../vendor/durations.js"), read("../../../src/sam/lib/durations.js"));
});

// --- inputs ----------------------------------------------------------------

const BASES = ["w", "h", "q", "8", "16", "32", "64", "1", "2", "4", "128", "", "x", "hh", "qx", "dq"];
const TOKENS = [
  ...BASES.flatMap((b) => ["", "d", "dd", "ddd"].map((d) => b + d)),
  "d", "dd", " q", "q ", "Q", "8.", null, undefined, 4, 0.5, {}, [], true,
];

const BEAT_VALUES = [
  ...Array.from({ length: 8 * 64 + 1 }, (_, k) => k / 64),
  1 / 3, 2 / 3, 0.1, 0.3, 1e-10, 1e-8, 4.000000001, 7.75, 12, 13.5,
  -1, -0.5, NaN, Infinity,
];

const TIME_SIGNATURES = [
  null, undefined, {}, { beats: 3 }, { beatType: 8 }, { beats: 0, beatType: 4 },
  { beats: 4, beatType: 0 }, { beats: "6", beatType: "8" },
  ...Array.from({ length: 17 }, (_, beats) =>
    [0, 1, 2, 3, 4, 8, 16, 32].map((beatType) => ({ beats, beatType }))
  ).flat(),
  { beats: 4, beatType: 4, symbol: "common" },
  { beats: 2, beatType: 2, symbol: "cut" },
];

// Deterministic pseudo-random event lists, so a failure reproduces.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const TUPLETS = [undefined, { actual: 3, normal: 2 }, { actual: 5, normal: 4 },
  { actual: 7, normal: 4 }, { actual: 6, normal: 4, position: "start" }, { actual: 2, normal: 3 }];
const EVENT_TOKENS = ["w", "h", "hd", "q", "qd", "qdd", "8", "8d", "16", "32", "64", "64d", "zz"];
const rand = prng(20260916);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const EVENT_LISTS = [
  null, undefined, [],
  [{ duration: "q", notes: [] }],
  [{ duration: "8", notes: [], tuplet: { actual: 3, normal: 2 } }],
  ...Array.from({ length: 400 }, () =>
    Array.from({ length: 1 + Math.floor(rand() * 12) }, () => {
      const e = { duration: pick(EVENT_TOKENS), notes: [] };
      const t = pick(TUPLETS);
      if (t) e.tuplet = t;
      return e;
    })
  ),
];

// Exact equality that treats NaN as equal to NaN and descends into arrays.
function same(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  return Object.is(a, b);
}

/** Every copy that has `fn` agrees with LIB on every input. */
function assertAgree(fn, inputs, { label = (x) => JSON.stringify(x) } = {}) {
  const holders = Object.entries(COPIES).filter(([, m]) => typeof m[fn] === "function");
  assert.ok(holders.length >= 2, `${fn} is shared by fewer than two copies`);
  let checked = 0;
  for (const input of inputs) {
    const want = LIB[fn](input);
    for (const [name, mod] of holders) {
      const got = mod[fn](input);
      if (!same(got, want)) {
        assert.fail(`${fn}(${label(input)}): LIB=${JSON.stringify(want)} but ${name}=${JSON.stringify(got)}`);
      }
      checked++;
    }
  }
  return checked;
}

// --- the shared functions -----------------------------------------------------

test("tokenToBeats agrees across LIB, SRC, VENDOR and DENO", () => {
  assert.ok(assertAgree("tokenToBeats", TOKENS, { label: String }) > 0);
  // Sanity on the reference itself, so agreement is not agreement on nonsense.
  assert.equal(LIB.tokenToBeats("qd"), 1.5);
  assert.equal(LIB.tokenToBeats("8dd"), 0.875);
  assert.equal(LIB.tokenToBeats("zz"), null);
});

test("measureBeats agrees across all four copies — a 6/8 bar is 3.0 quarter beats", () => {
  assert.ok(assertAgree("measureBeats", TIME_SIGNATURES) > 0);
  for (const [name, mod] of Object.entries(COPIES)) {
    assert.equal(mod.measureBeats({ beats: 6, beatType: 8 }), 3, name);
    assert.equal(mod.measureBeats({ beats: 7, beatType: 8 }), 3.5, name);
  }
});

test("sumEvents agrees across all four copies, tuplets included", () => {
  assert.ok(assertAgree("sumEvents", EVENT_LISTS) > 0);
  for (const [name, mod] of Object.entries(COPIES)) {
    const triplet = Array.from({ length: 3 }, () => ({ duration: "8", notes: [], tuplet: { actual: 3, normal: 2 } }));
    assert.equal(mod.sumEvents(triplet), 1, `${name}: a triplet of eighths is one beat`);
    assert.equal(mod.sumEvents([{ duration: "zz", notes: [] }]), null, `${name}: unknown token`);
  }
});

test("beatsToToken, beatsToTokens and isKnownToken agree across the JS copies", () => {
  assert.ok(assertAgree("beatsToToken", BEAT_VALUES) > 0);
  assert.ok(assertAgree("beatsToTokens", BEAT_VALUES) > 0);
  assert.ok(assertAgree("isKnownToken", TOKENS, { label: String }) > 0);
});

test("ALL_TOKENS is identical across the JS copies", () => {
  for (const name of ["SRC", "VENDOR"]) {
    assert.deepEqual(COPIES[name].ALL_TOKENS, LIB.ALL_TOKENS, name);
  }
  assert.equal(LIB.ALL_TOKENS.length, 21);
});

test("DENO's BASE map is exactly the base vocabulary the JS copies know", () => {
  const jsBases = LIB.ALL_TOKENS.filter((t) => !t.endsWith("d"));
  assert.deepEqual(Object.keys(DENO.BASE).sort(), [...jsBases].sort());
  for (const [token, beats] of Object.entries(DENO.BASE)) {
    assert.equal(beats, LIB.tokenToBeats(token), token);
  }
});

test("the comparison itself fails on a one-ulp difference", () => {
  // A parity check that cannot fail proves nothing. Feed it a near-copy that
  // differs by the smallest representable amount and require a failure.
  const tampered = { ...LIB, measureBeats: (ts) => {
    const v = LIB.measureBeats(ts);
    return v === 3 ? 3 + Number.EPSILON * 2 : v;
  } };
  const saved = COPIES.DENO;
  COPIES.DENO = { ...DENO, measureBeats: tampered.measureBeats };
  try {
    assert.throws(() => assertAgree("measureBeats", TIME_SIGNATURES), /DENO=3\.0000000000000004/);
  } finally {
    COPIES.DENO = saved;
  }
});
