// Duration vocabulary unit tests. Run via `npm test` (Jest, from CRA).
//
// Spec §8.2 requires: `tokenToBeats("qdd") === 1.75` — double-dot math
// exists in the corpus (Someone Like You m47). The rest of the tests
// exercise the vocabulary contract callers depend on.

import {
  tokenToBeats,
  beatsToToken,
  beatsToTokens,
  measureBeats,
  sumEvents,
  toTimeline,
  fromTimeline,
  ALL_TOKENS,
  isKnownToken,
} from "./durations";

describe("tokenToBeats — vocabulary", () => {
  test("undotted bases in quarter-note units", () => {
    expect(tokenToBeats("w")).toBe(4);
    expect(tokenToBeats("h")).toBe(2);
    expect(tokenToBeats("q")).toBe(1);
    expect(tokenToBeats("8")).toBe(0.5);
    expect(tokenToBeats("16")).toBe(0.25);
    expect(tokenToBeats("32")).toBe(0.125);
    expect(tokenToBeats("64")).toBe(0.0625);
  });

  test("single dot adds half the base", () => {
    expect(tokenToBeats("qd")).toBe(1.5);
    expect(tokenToBeats("hd")).toBe(3);
    expect(tokenToBeats("8d")).toBe(0.75);
  });

  test("double dot: q -> 1.75  (spec §8.2)", () => {
    expect(tokenToBeats("qdd")).toBe(1.75);
    expect(tokenToBeats("hdd")).toBe(3.5);
    expect(tokenToBeats("8dd")).toBe(0.875);
  });

  test("triple-dot IS computed (loop strips arbitrary dot suffixes)", () => {
    // Behaviour deliberately allows unlimited dots: q with 3 dots = 1.875.
    // ALL_TOKENS caps at 2 dots for the round-trip vocabulary, but
    // tokenToBeats accepts more so a hand-constructed token doesn't
    // silently return null.
    expect(tokenToBeats("qddd")).toBe(1.875);
  });

  test("unknown tokens return null (not 0)", () => {
    expect(tokenToBeats("")).toBeNull();
    expect(tokenToBeats("x")).toBeNull();
    expect(tokenToBeats("quarter")).toBeNull(); // MusicXML name, not a vex token
    expect(tokenToBeats(null)).toBeNull();
    expect(tokenToBeats(0.5)).toBeNull();       // numbers aren't tokens
  });
});

describe("beatsToToken — exact single-token lookup", () => {
  test("round-trip every vocabulary token", () => {
    for (const t of ALL_TOKENS) {
      expect(beatsToToken(tokenToBeats(t))).toBe(t);
    }
  });

  test("non-representable beats return null", () => {
    expect(beatsToToken(1 / 3)).toBeNull(); // triplet-eighth not a single token
    expect(beatsToToken(0.083)).toBeNull();
  });
});

describe("beatsToTokens — greedy decomposition", () => {
  test("exact decomposition of standard rests", () => {
    expect(beatsToTokens(1.5)).toEqual(["qd"]);
    expect(beatsToTokens(2.5)).toEqual(["h", "8"]);
    expect(beatsToTokens(0.75)).toEqual(["8d"]);
  });

  test("non-representable returns null (not a lossy approximation)", () => {
    expect(beatsToTokens(1 / 3)).toBeNull();
  });
});

describe("measureBeats — time signature length", () => {
  test("common time and compound", () => {
    expect(measureBeats({ beats: 4, beatType: 4 })).toBe(4);
    expect(measureBeats({ beats: 3, beatType: 8 })).toBe(1.5);   // Für Elise
    expect(measureBeats({ beats: 2, beatType: 2 })).toBe(4);     // cut time
    expect(measureBeats({ beats: 6, beatType: 8 })).toBe(3);
  });

  test("null when signature is incomplete", () => {
    expect(measureBeats(null)).toBeNull();
    expect(measureBeats({})).toBeNull();
    expect(measureBeats({ beats: 4 })).toBeNull();
  });
});

describe("sumEvents — tuplet-aware beat math (spec §4.2)", () => {
  test("no tuplet: naive sum", () => {
    const evs = [{ duration: "q" }, { duration: "q" }, { duration: "h" }];
    expect(sumEvents(evs)).toBe(4);
  });

  test("triplet-eighth × 3 sounds for one beat, not 1.5", () => {
    // Three triplet-eighths stored as "8" with tuplet={3,2}
    // Sounded time each = 0.5 × 2/3 = 1/3. Three of them = 1.
    const evs = Array.from({ length: 3 }, () => ({
      duration: "8",
      tuplet: { actual: 3, normal: 2 },
    }));
    expect(sumEvents(evs)).toBeCloseTo(1, 10);
  });

  test("mixed tuplet and non-tuplet events", () => {
    // qd (1.5) + three triplet-eighths (each 1/3, sum 1) = 2.5
    const evs = [
      { duration: "qd" },
      { duration: "8", tuplet: { actual: 3, normal: 2 } },
      { duration: "8", tuplet: { actual: 3, normal: 2 } },
      { duration: "8", tuplet: { actual: 3, normal: 2 } },
    ];
    expect(sumEvents(evs)).toBeCloseTo(2.5, 10);
  });

  test("returns null if any token unknown (never silently drops)", () => {
    expect(sumEvents([{ duration: "q" }, { duration: "??" }])).toBeNull();
  });
});

describe("isKnownToken", () => {
  test("every ALL_TOKENS entry is known", () => {
    for (const t of ALL_TOKENS) expect(isKnownToken(t)).toBe(true);
  });
  test("garbage isn't", () => {
    expect(isKnownToken("quarter")).toBe(false);
    expect(isKnownToken("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toTimeline / fromTimeline round-trip — spec §3.3
// A round-trip test that ONLY covers plain durations would pass on twelve
// fixtures and hide the one case that matters (tuplet reconstruction).
// Both plain and tuplet-bearing measures required.
// ---------------------------------------------------------------------------

// Compare a re-serialised event array against the original, ignoring key
// order and dropping any lint-added identity fields the round trip might
// have introduced. Deep-equal by value.
function normaliseEvent(e) {
  const out = { duration: e.duration, notes: (e.notes || []).map((n) => ({ ...n })) };
  if (e.tuplet) out.tuplet = { actual: e.tuplet.actual, normal: e.tuplet.normal };
  if (e.lyric !== undefined) out.lyric = e.lyric;
  if (e.voice !== undefined) out.voice = e.voice;
  return out;
}

describe("toTimeline / fromTimeline round-trip", () => {
  test("plain-duration measure — quarter + half + quarter in 4/4", () => {
    const events = [
      { duration: "q", notes: [{ midi: 60, name: "C4" }] },
      { duration: "h", notes: [{ midi: 62, name: "D4" }] },
      { duration: "q", notes: [{ midi: 64, name: "E4" }] },
    ];
    const round = fromTimeline(toTimeline(events)).map(normaliseEvent);
    expect(round).toEqual(events.map(normaliseEvent));
  });

  test("Someone Like You m51 pattern — mixed tokens + triplet-eighths", () => {
    // Reduced-but-representative slice of SLY m51 rh: three regular tokens
    // followed by three triplet-eighths (sounded 1.0 beats, displayed as
    // three "8" tokens with tuplet {3,2}).
    const events = [
      { duration: "16", notes: [{ midi: 72, name: "C5" }] },
      { duration: "16", notes: [{ midi: 74, name: "D5" }] },
      { duration: "8",  notes: [{ midi: 76, name: "E5" }] },
      { duration: "8", tuplet: { actual: 3, normal: 2 }, notes: [{ midi: 74, name: "D5" }] },
      { duration: "8", tuplet: { actual: 3, normal: 2 }, notes: [{ midi: 76, name: "E5" }] },
      { duration: "8", tuplet: { actual: 3, normal: 2 }, notes: [{ midi: 77, name: "F5" }] },
    ];
    const tl = toTimeline(events);
    // Onsets should be 0, 0.25, 0.5, 1.0, 1.333, 1.667 — the last three
    // reflect tuplet-scaled sounding time.
    expect(tl[3].onsetBeats).toBeCloseTo(1.0, 10);
    expect(tl[4].onsetBeats).toBeCloseTo(1 + 1 / 3, 10);
    expect(tl[5].onsetBeats).toBeCloseTo(1 + 2 / 3, 10);
    // Round trip preserves both display token AND tuplet marker.
    const round = fromTimeline(tl).map(normaliseEvent);
    expect(round).toEqual(events.map(normaliseEvent));
    // And sum matches the pattern's actual measure contribution:
    // 0.25 + 0.25 + 0.5 + 1.0 = 2.0
    expect(sumEvents(events)).toBeCloseTo(2, 10);
  });

  test("Moonlight m5 pattern — dotted-quarter + four triplet-eighths in 4/4", () => {
    // A representative sub-pattern from Moonlight m5's arpeggio texture:
    // a triplet-eighth sequence of four fragments (across two triplet
    // groups) with a dotted-quarter melody note carrying over the same
    // beat range. This shape exercises the tuplet-carry mechanism
    // through the round trip.
    const events = [
      { duration: "qd", notes: [{ midi: 68, name: "G#4" }] },
      { duration: "8", tuplet: { actual: 3, normal: 2 }, notes: [{ midi: 56, name: "G#3" }] },
      { duration: "8", tuplet: { actual: 3, normal: 2 }, notes: [{ midi: 61, name: "C#4" }] },
      { duration: "8", tuplet: { actual: 3, normal: 2 }, notes: [{ midi: 64, name: "E4" }] },
    ];
    const tl = toTimeline(events);
    // qd = 1.5, then three triplet-eighths at 1/3 each. Total sounded = 2.5.
    expect(sumEvents(events)).toBeCloseTo(2.5, 10);
    // Round trip preserves each triplet event's marker.
    const round = fromTimeline(tl).map(normaliseEvent);
    expect(round).toEqual(events.map(normaliseEvent));
    for (let i = 1; i < 4; i++) {
      expect(round[i].tuplet).toEqual({ actual: 3, normal: 2 });
    }
  });

  test("round trip preserves tie annotations", () => {
    const events = [
      { duration: "q", notes: [{ midi: 60, name: "C4", tie: "start" }] },
      { duration: "q", notes: [{ midi: 60, name: "C4", tie: "end" }] },
    ];
    const round = fromTimeline(toTimeline(events)).map(normaliseEvent);
    expect(round).toEqual(events.map(normaliseEvent));
  });

  test("round trip preserves rest (empty notes[])", () => {
    const events = [
      { duration: "q", notes: [] },
      { duration: "h", notes: [{ midi: 60, name: "C4" }] },
    ];
    const round = fromTimeline(toTimeline(events)).map(normaliseEvent);
    expect(round).toEqual(events.map(normaliseEvent));
  });

  test("fromTimeline pushes a warning on tuplet-boundary-span segment", () => {
    // Handcraft a segment whose tuplet ratio cannot cleanly explain the
    // duration — e.g., a 5-beat segment with a {3,2} tuplet marker attached
    // (displayBeats = 5 * 3/2 = 7.5, not a single token). This is the
    // spec §M2 tuplet-boundary case. Two warnings are emitted: the primary
    // tuplet-boundary diagnostic, then a best-effort fallback note when
    // the raw duration also isn't a single token.
    const warnings = [];
    fromTimeline(
      [{ onsetBeats: 0, durBeats: 5, notes: [{ midi: 60, name: "C4" }], tuplet: { actual: 3, normal: 2 } }],
      warnings,
      "test"
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatch(/tuplet-boundary/);
  });
});

// ---------------------------------------------------------------------------
// Deno-copy BASE parity — spec §M9
//
// supabase/functions/_shared/durations.ts is a Deno/TS port of this file for
// the sam-authoring Edge Function tool (Alex, 2026-08-06: opted for a
// duplicate + parity-test over build-time codegen). Both files must agree
// on the BASE mapping token-for-token; a divergence here means one side
// gained a token the other doesn't know about, and duration math on that
// token will silently disagree between the app and the Edge Function.
//
// The Deno file marks its BASE object with `PARITY-MARKER-START` /
// `PARITY-MARKER-END` comment lines. This test reads the file, extracts
// the entries between the markers, and asserts every token's beat value
// matches this file's tokenToBeats result.
// ---------------------------------------------------------------------------
describe("Deno-copy BASE parity (spec §M9)", () => {
  const fs = require("fs");
  const path = require("path");
  const denoFile = path.resolve(
    __dirname,
    "../../../supabase/functions/_shared/durations.ts"
  );

  test("supabase/functions/_shared/durations.ts BASE matches this file", () => {
    let denoText;
    try {
      denoText = fs.readFileSync(denoFile, "utf8");
    } catch (e) {
      throw new Error(
        `Could not read Deno durations copy at ${denoFile}: ${e.message}. ` +
        `Both files are expected to exist per spec §M9.`
      );
    }
    const m = denoText.match(/PARITY-MARKER-START[\s\S]*?BASE[^{]*{([^}]+)}[\s\S]*?PARITY-MARKER-END/);
    if (!m) {
      throw new Error(
        `Could not locate PARITY-MARKER-START/END block or BASE object ` +
        `inside it in the Deno durations file. If you edited that file, ` +
        `keep the marker comments and the BASE literal between them.`
      );
    }
    const denoEntries = [...m[1].matchAll(/["']?([A-Za-z0-9]+)["']?\s*:\s*([0-9.]+)/g)]
      .map(([, token, val]) => [token, Number(val)]);
    expect(denoEntries.length).toBeGreaterThan(0);

    // Every Deno BASE token must resolve to the same beat value in this file.
    for (const [token, denoBeats] of denoEntries) {
      const jsBeats = tokenToBeats(token);
      expect({ token, jsBeats, denoBeats }).toEqual({ token, jsBeats: denoBeats, denoBeats });
    }
    // And every undotted base token in this file must appear in the Deno
    // BASE — asymmetry the other way is just as bad (a new token added
    // here but forgotten in Deno = Edge Function rejects it as unknown).
    const undottedHere = ALL_TOKENS.filter((t) => !t.endsWith("d"));
    const denoTokens = new Set(denoEntries.map(([t]) => t));
    for (const t of undottedHere) {
      expect({ token: t, inDeno: denoTokens.has(t) }).toEqual({ token: t, inDeno: true });
    }
  });
});
