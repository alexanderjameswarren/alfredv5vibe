// Unit tests for M1 — parse-time duplicate-pitch merge (the "continuation
// rule", technical-spec-import-duplicate-notes.md revision 2).
//
// Three levels, because the rule has to hold at each of them:
//   1. mergeDuplicatePitches — the predicate and the property union, tested
//      against the literal arrays the spec names.
//   2. mergeStaff — that the rule actually runs where the flattening happens,
//      and that it sees the ties mergeStaff DERIVES rather than source ties.
//   3. parseMusicXML — end to end from MusicXML text, since that is the path
//      that produced the bad rows in the first place.
//
// The preservation cases matter as much as the merge case. Moonlight m60 and
// Someone Like You m27 are legitimate hold-plus-restrike encodings that
// noteTimeline.js's resolveTieChain depends on; a "fix" that collapses them
// changes what is heard.

import { mergeStaff, parseMusicXML } from "./songParser";
// The predicate moved to its own module in M2 so the parse-time fix and the
// write-path checks share one definition. mergeStaff still owns the wiring.
import { isContinuation, mergeDuplicatePitches } from "./noteDuplicates";

describe("isContinuation", () => {
  test("'end' and 'both' are continuations", () => {
    expect(isContinuation({ midi: 65, name: "F4", tie: "end" })).toBe(true);
    expect(isContinuation({ midi: 65, name: "F4", tie: "both" })).toBe(true);
  });

  test("'start' and no tie are not", () => {
    expect(isContinuation({ midi: 65, name: "F4", tie: "start" })).toBe(false);
    expect(isContinuation({ midi: 65, name: "F4" })).toBe(false);
  });
});

describe("mergeDuplicatePitches — the reference case", () => {
  // The Scientist - Coldplay (f3bb321f-aa95-4c73-bfdc-bdf3d36f8096), measure
  // 69, right hand, event 0, exactly as the spec records it. The two F4
  // entries are NOT identical — one carries a tie — which is why the key is
  // `midi` alone and not the whole object.
  const scientistM69 = () => [
    { midi: 62, name: "D4", tie: "start" },
    { midi: 65, name: "F4", tie: "start" },
    { midi: 65, name: "F4" },
    { midi: 69, name: "A4", tie: "start" },
  ];

  test("collapses the duplicate F4 and keeps the tie", () => {
    expect(mergeDuplicatePitches(scientistM69())).toEqual([
      { midi: 62, name: "D4", tie: "start" },
      { midi: 65, name: "F4", tie: "start" },
      { midi: 69, name: "A4", tie: "start" },
    ]);
  });

  test("the tie survives regardless of which copy carries it", () => {
    // Ordering luck must not decide the outcome. Dropping the later entry
    // would discard the tie here.
    const reversed = [
      { midi: 65, name: "F4" },
      { midi: 65, name: "F4", tie: "start" },
    ];
    expect(mergeDuplicatePitches(reversed)).toEqual([
      { midi: 65, name: "F4", tie: "start" },
    ]);
  });

  test("does not mutate the input array or its notes", () => {
    const input = scientistM69();
    const before = JSON.stringify(input);
    mergeDuplicatePitches(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("mergeDuplicatePitches — legitimate pairs are preserved", () => {
  test("Moonlight m60: C#4 + C#4:end is left alone", () => {
    const notes = [
      { midi: 61, name: "C#4" },
      { midi: 61, name: "C#4", tie: "end" },
    ];
    // Reference-equal: "left alone" is stronger than "deep-equal after a
    // rebuild", and it is what tells a caller nothing was rewritten.
    expect(mergeDuplicatePitches(notes)).toBe(notes);
  });

  test("Someone Like You m27: F#4 + F#4:end is left alone", () => {
    const notes = [
      { midi: 66, name: "F#4" },
      { midi: 66, name: "F#4", tie: "end" },
    ];
    expect(mergeDuplicatePitches(notes)).toBe(notes);
  });

  test("continuation first, fresh strike second: still left alone", () => {
    const notes = [
      { midi: 61, name: "C#4", tie: "end" },
      { midi: 61, name: "C#4" },
    ];
    expect(mergeDuplicatePitches(notes)).toBe(notes);
  });

  test("'both' counts as a continuation", () => {
    const notes = [
      { midi: 61, name: "C#4", tie: "both" },
      { midi: 61, name: "C#4" },
    ];
    expect(mergeDuplicatePitches(notes)).toBe(notes);
  });

  test("two continuations on one pitch are also left alone", () => {
    // Not expected from the parser, but the rule is 'merge only when neither
    // is a continuation' — two continuations fail that test just as surely.
    const notes = [
      { midi: 61, name: "C#4", tie: "end" },
      { midi: 61, name: "C#4", tie: "both" },
    ];
    expect(mergeDuplicatePitches(notes)).toBe(notes);
  });

  test("three entries: the two non-continuations merge, the hold survives", () => {
    const notes = [
      { midi: 65, name: "F4", tie: "start" },
      { midi: 65, name: "F4" },
      { midi: 65, name: "F4", tie: "end" },
    ];
    expect(mergeDuplicatePitches(notes)).toEqual([
      { midi: 65, name: "F4", tie: "start" },
      { midi: 65, name: "F4", tie: "end" },
    ]);
  });
});

describe("mergeDuplicatePitches — property union and conflicts", () => {
  test("a property on one entry and absent on the other is carried across", () => {
    const notes = [
      { midi: 65, name: "F4" },
      { midi: 65, name: "F4", tie: "start", fingering: 3 },
    ];
    expect(mergeDuplicatePitches(notes)).toEqual([
      { midi: 65, name: "F4", tie: "start", fingering: 3 },
    ]);
  });

  test("no 'both' is ever synthesised — the union of merged ties is 'start'", () => {
    // Spec: a merged pair can never contain 'end' or 'both', so the "both"
    // union branch is unreachable on this path and is deliberately absent.
    const notes = [
      { midi: 65, name: "F4", tie: "start" },
      { midi: 65, name: "F4", tie: "start" },
    ];
    expect(mergeDuplicatePitches(notes)).toEqual([
      { midi: 65, name: "F4", tie: "start" },
    ]);
  });

  test("enharmonic name disagreement keeps the first and warns", () => {
    const warnings = [];
    const notes = [
      { midi: 70, name: "A#4" },
      { midi: 70, name: "Bb4" },
    ];
    const out = mergeDuplicatePitches(notes, (m) => warnings.push(m));
    expect(out).toEqual([{ midi: 70, name: "A#4" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("midi 70");
    expect(warnings[0]).toContain("A#4");
    expect(warnings[0]).toContain("Bb4");
  });

  test("a non-name conflict keeps the first, warns, and does not throw", () => {
    const warnings = [];
    const notes = [
      { midi: 65, name: "F4", fingering: 2 },
      { midi: 65, name: "F4", fingering: 4 },
    ];
    const out = mergeDuplicatePitches(notes, (m) => warnings.push(m));
    expect(out).toEqual([{ midi: 65, name: "F4", fingering: 2 }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("fingering");
  });

  test("a clean merge is silent", () => {
    const warnings = [];
    mergeDuplicatePitches(
      [{ midi: 65, name: "F4", tie: "start" }, { midi: 65, name: "F4" }],
      (m) => warnings.push(m)
    );
    expect(warnings).toEqual([]);
  });

  test("distinct pitches and short arrays pass straight through", () => {
    const chord = [
      { midi: 62, name: "D4" },
      { midi: 65, name: "F4" },
      { midi: 69, name: "A4" },
    ];
    expect(mergeDuplicatePitches(chord)).toBe(chord);
    const single = [{ midi: 60, name: "C4" }];
    expect(mergeDuplicatePitches(single)).toBe(single);
    expect(mergeDuplicatePitches([])).toEqual([]);
  });
});

describe("mergeStaff — the rule runs where the flattening happens", () => {
  const evt = (onset, dur, notes, voice) => ({
    onset, dur, notes, rest: notes.length === 0, voice,
  });

  test("two voices striking the same pitch over the same span merge to one note", () => {
    const voices = new Map([
      ["1:1", [evt(0, 4, [{ midi: 65, name: "F4", tie: "start" }], "1")]],
      ["1:2", [evt(0, 4, [{ midi: 65, name: "F4" }], "2")]],
    ]);
    const out = mergeStaff(voices, "1", 4);
    expect(out).toHaveLength(1);
    expect(out[0].notes).toEqual([{ midi: 65, name: "F4", tie: "start" }]);
  });

  test("a voice HOLDING through the segment while another strikes is preserved", () => {
    // voice 1 spans the whole bar; voice 2 strikes the same pitch on beat 2.
    // mergeStaff derives tie 'both' for the held fragment, which makes it a
    // continuation — so the pair survives. This is the Moonlight m60 shape
    // arising from the segmentation itself rather than from a source tie.
    const voices = new Map([
      ["1:1", [evt(0, 4, [{ midi: 61, name: "C#4" }], "1")]],
      ["1:2", [evt(1, 1, [{ midi: 61, name: "C#4" }], "2")]],
    ]);
    const out = mergeStaff(voices, "1", 4);
    const seg = out.find((s) => Math.abs(s.onset - 1) < 1e-9);
    expect(seg.notes).toEqual([
      { midi: 61, name: "C#4", tie: "both" },
      { midi: 61, name: "C#4" },
    ]);
  });

  test("the rule tests DERIVED ties, not source ties", () => {
    // Both source notes are untied. Only the segmentation makes one of them a
    // continuation. If the rule read source ties it would merge these two and
    // silently fuse a re-articulation into a held tone.
    const voices = new Map([
      ["1:1", [evt(0, 2, [{ midi: 61, name: "C#4" }], "1")]],
      ["1:2", [evt(1, 1, [{ midi: 61, name: "C#4" }], "2")]],
    ]);
    const out = mergeStaff(voices, "1", 4);
    const seg = out.find((s) => Math.abs(s.onset - 1) < 1e-9);
    expect(seg.notes).toHaveLength(2);
  });

  test("conflicts are reported with hand, measure, event index and pitch", () => {
    const warnings = [];
    const voices = new Map([
      ["1:1", [evt(0, 4, [{ midi: 70, name: "A#4" }], "1")]],
      ["1:2", [evt(0, 4, [{ midi: 70, name: "Bb4" }], "2")]],
    ]);
    mergeStaff(voices, "1", 4, warnings, "m12 rh");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("m12 rh");
    expect(warnings[0]).toContain("event 0");
    expect(warnings[0]).toContain("midi 70");
  });

  test("omitting the warnings array is allowed and silent", () => {
    const voices = new Map([
      ["1:1", [evt(0, 4, [{ midi: 70, name: "A#4" }], "1")]],
      ["1:2", [evt(0, 4, [{ midi: 70, name: "Bb4" }], "2")]],
    ]);
    expect(() => mergeStaff(voices, "1", 4)).not.toThrow();
  });
});

describe("parseMusicXML — minimal two-voice same-pitch score", () => {
  // Measure 1: voice 1 plays F4 (tied onward) + A4; voice 2 plays the same F4.
  //            Both strike on beat 1 — a genuine duplicate. Expect one F4.
  // Measure 2: voice 1 holds the tied F4 through the bar; voice 2 re-strikes
  //            F4 on beat 1. Legitimate. Expect both to survive.
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration>
        <voice>1</voice><type>whole</type><tie type="start"/></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration>
        <voice>1</voice><type>whole</type></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration>
        <voice>2</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration>
        <voice>1</voice><type>whole</type><tie type="stop"/></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration>
        <voice>2</voice><type>quarter</type></note>
      <note><rest/><duration>3</duration><voice>2</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

  const song = parseMusicXML(XML);

  test("m1: the duplicated F4 collapses, the chord keeps its other member", () => {
    expect(song.measures[0].rh).toHaveLength(1);
    expect(song.measures[0].rh[0].notes).toEqual([
      { midi: 65, name: "F4", tie: "start" },
      { midi: 69, name: "A4" },
    ]);
  });

  test("m2: the held F4 and the fresh strike both survive", () => {
    const first = song.measures[1].rh[0];
    expect(first.notes).toHaveLength(2);
    expect(first.notes.filter((n) => n.tie === "both" || n.tie === "end")).toHaveLength(1);
    expect(first.notes.filter((n) => n.tie === undefined)).toHaveLength(1);
    expect(first.notes.every((n) => n.midi === 65)).toBe(true);
  });

  test("no event anywhere contains a non-continuation duplicate", () => {
    // The M1 exit condition, stated the same way the detection query states it.
    for (const m of song.measures) {
      for (const hand of ["rh", "lh"]) {
        for (const evt of m[hand]) {
          const fresh = evt.notes
            .filter((n) => n.tie !== "end" && n.tie !== "both")
            .map((n) => n.midi);
          expect(new Set(fresh).size).toBe(fresh.length);
        }
      }
    }
  });
});
