// Unit tests for songParser's M3 short-measure classification and padding.
//
// These functions are pure — no parser state — so we test them in isolation
// against hand-constructed inputs. Spec §3.7 defines four verdicts; each is
// exercised here so a regression in the rule table is a red test, not a
// silently-wrong measure that gets caught only via fixture aggregate counts.

import {
  classifyShortMeasure,
  padWithRests,
} from "./songParser";

describe("classifyShortMeasure — spec §3.7 rule table", () => {
  test("full measure returns 'full' (exact sum)", () => {
    expect(classifyShortMeasure(5, 4, 4, null, false)).toBe("full");
    expect(classifyShortMeasure(5, 1.5, 1.5, 0.5, false)).toBe("full");
  });

  test("overflow returns 'overflow' (sum > mLen)", () => {
    expect(classifyShortMeasure(5, 4.5, 4, null, false)).toBe("overflow");
  });

  test("m1 with implicit='yes' is anacrusis-pickup", () => {
    expect(classifyShortMeasure(1, 0.5, 1.5, null, true)).toBe("anacrusis-pickup");
  });

  test("m1 that is short without implicit is anacrusis-pickup (spec §3.7: 'or measure 1 is short')", () => {
    expect(classifyShortMeasure(1, 0.5, 1.5, null, false)).toBe("anacrusis-pickup");
  });

  test("m1 full with implicit is 'full' (no space to be a pickup)", () => {
    // Odd but well-defined — implicit=true but sum matches mLen means the
    // <measure implicit="yes"> attribute has no observable effect. Prefer
    // 'full' since padding rules are about actual short-ness.
    expect(classifyShortMeasure(1, 1.5, 1.5, null, true)).toBe("full");
  });

  test("borrowed partner: sum + pickup = mLen (Für Elise m9)", () => {
    // Für Elise m9: sum 1.0, pickup 0.5, mLen 1.5. 1.0 + 0.5 == 1.5.
    expect(classifyShortMeasure(9, 1.0, 1.5, 0.5, false)).toBe("anacrusis-borrowed");
  });

  test("short measure with pickup that does NOT complete to mLen is incomplete", () => {
    // sum 0.75 + pickup 0.5 = 1.25, not 1.5 → not borrowed → incomplete.
    expect(classifyShortMeasure(9, 0.75, 1.5, 0.5, false)).toBe("incomplete");
  });

  test("short measure with no song-level pickup is always incomplete (Prelude m43)", () => {
    // Prelude has no anacrusis (m1 is full). m43 rh sums to 1 of 3.
    expect(classifyShortMeasure(43, 1, 3, null, false)).toBe("incomplete");
  });

  test("borrowed-partner check requires pickup > 0", () => {
    // Even if sum + 0 == mLen (which is same as sum == mLen), the classifier
    // should treat pickup=0 as 'no pickup' and NOT tag as borrowed. In
    // practice a sum-matches case hits the 'full' branch first, but be
    // explicit: pickup null and pickup 0 both mean 'no anacrusis in song'.
    expect(classifyShortMeasure(5, 3, 4, 0, false)).toBe("incomplete");
    expect(classifyShortMeasure(5, 3, 4, null, false)).toBe("incomplete");
  });

  test("m1 non-implicit and full: treated as normal full measure", () => {
    expect(classifyShortMeasure(1, 4, 4, null, false)).toBe("full");
  });
});

describe("padWithRests — greedy trailing-rest decomposition", () => {
  test("no padding when extraBeats near zero", () => {
    const events = [{ duration: "q", notes: [{ midi: 60, name: "C4" }] }];
    expect(padWithRests(events, 0)).toBe(events);
    expect(padWithRests(events, 1e-12)).toBe(events);
  });

  test("single-token gap: 2 beats -> ['h']", () => {
    const events = [{ duration: "q", notes: [{ midi: 60, name: "C4" }] }];
    const padded = padWithRests(events, 2);
    expect(padded).toHaveLength(2);
    expect(padded[1]).toEqual({ duration: "h", notes: [] });
  });

  test("multi-token gap: 2.5 beats -> ['h', '8']", () => {
    const events = [{ duration: "q", notes: [{ midi: 60, name: "C4" }] }];
    const padded = padWithRests(events, 2.5);
    expect(padded).toHaveLength(3);
    expect(padded[1]).toEqual({ duration: "h", notes: [] });
    expect(padded[2]).toEqual({ duration: "8", notes: [] });
  });

  test("Prelude m43 case: 2-beat gap after a 1-beat chord", () => {
    // The literal scenario M3 targets. RH has one quarter chord in a 3/4
    // bar; the missing 2 beats become a half rest.
    const events = [{
      duration: "q",
      notes: [
        { midi: 59, name: "B4" }, { midi: 62, name: "D5" }, { midi: 67, name: "G5" }
      ],
    }];
    const padded = padWithRests(events, 2);
    expect(padded).toHaveLength(2);
    expect(padded[0].notes).toHaveLength(3);   // chord unchanged
    expect(padded[1]).toEqual({ duration: "h", notes: [] });
  });

  test("returns null when extraBeats not decomposable", () => {
    // 1/3 beat (triplet-eighth sounded) has no representation as standard
    // rest tokens. In corpus terms unreachable — mergeStaff produces
    // well-formed segments — but the caller must FLAG rather than fake it.
    const events = [{ duration: "q", notes: [] }];
    expect(padWithRests(events, 1 / 3)).toBeNull();
  });

  test("does not mutate input array", () => {
    const events = [{ duration: "q", notes: [] }];
    const before = JSON.stringify(events);
    padWithRests(events, 2);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("classify + pad end-to-end (spec §3.7 acid test)", () => {
  // Compose the two functions the way parseMusicXML's Phase C2 does. The
  // scenarios below are the spec §3.7 rule table — a green test row is a
  // guarantee that the rule holds regardless of what the corpus does.

  const runPad = (measureNumber, events, mLen, pickupBeats, isImplicit) => {
    const sum = events.reduce((acc, e) => {
      // Local mirror of sumEvents' tuplet-aware math (avoid importing here
      // to keep the test self-documenting on what the classify/pad pair
      // is supposed to see).
      const base = { w: 4, hd: 3, h: 2, qd: 1.5, q: 1, "8d": 0.75, "8": 0.5, "16": 0.25, "32": 0.125 }[e.duration] || 0;
      return acc + (e.tuplet ? (base * e.tuplet.normal) / e.tuplet.actual : base);
    }, 0);
    const clazz = classifyShortMeasure(measureNumber, sum, mLen, pickupBeats, isImplicit);
    if (clazz === "incomplete") return { clazz, events: padWithRests(events, mLen - sum) };
    return { clazz, events };
  };

  test("Prelude m43 rh: one chord in 3/4 → pads to full", () => {
    const events = [{ duration: "q", notes: [{ midi: 59, name: "B4" }] }];
    const result = runPad(43, events, 3, null, false);
    expect(result.clazz).toBe("incomplete");
    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toEqual({ duration: "h", notes: [] });
  });

  test("Für Elise m1 rh (pickup): stays at 2 events, sum 0.5", () => {
    const events = [
      { duration: "16", notes: [{ midi: 76, name: "E5" }] },
      { duration: "16", notes: [{ midi: 75, name: "D#5" }] },
    ];
    const result = runPad(1, events, 1.5, null, true);
    expect(result.clazz).toBe("anacrusis-pickup");
    expect(result.events).toBe(events);   // reference-equal — no change
  });

  test("Für Elise m9 rh (borrowed partner): stays at 1 event, sum 1.0", () => {
    const events = [{ duration: "q", notes: [{ midi: 69, name: "A4" }] }];
    const result = runPad(9, events, 1.5, 0.5, false);
    expect(result.clazz).toBe("anacrusis-borrowed");
    expect(result.events).toBe(events);
  });

  test("full measure passes through unchanged", () => {
    const events = [
      { duration: "q", notes: [{ midi: 60, name: "C4" }] },
      { duration: "q", notes: [{ midi: 62, name: "D4" }] },
      { duration: "h", notes: [{ midi: 64, name: "E4" }] },
    ];
    const result = runPad(5, events, 4, null, false);
    expect(result.clazz).toBe("full");
    expect(result.events).toBe(events);
  });

  test("even with a song-level pickup, m1's own classification is anacrusis-pickup, not borrowed", () => {
    // If the classifier checked borrowed BEFORE pickup, m1 with sum=0.5 and
    // pickup=1.0 would satisfy sum+pickup=mLen — but m1 IS the pickup, not
    // a borrower. Guard the order.
    const events = [{ duration: "8", notes: [{ midi: 60, name: "C4" }] }];
    const result = runPad(1, events, 1.5, 1.0, true);
    expect(result.clazz).toBe("anacrusis-pickup");
  });
});
