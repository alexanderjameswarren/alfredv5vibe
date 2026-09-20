// What the app asks the player to STRIKE, when notes are tied over.
//
// THE DEFECT, fixed 2026-09-20. scoreRender decided this with
// `notes.every(n => n.tie === "end")`, per EVENT. Two shapes defeated it:
//
//   tie "both"   a middle link in a chain of three or more — already
//                sounding, but not "end", so the whole event counted as
//                struck and the app demanded a key for a held note;
//   mixed chord  one voice ties over while another re-articulates — `every`
//                is false, so BOTH were demanded, the tied one included.
//
// In both cases the score drew a tie arc (tieEndpoints handles "both"
// correctly) while the scorer punished the player for obeying it.

import { isContinuation, struckMidi } from "./measureUtils";
import { buildNoteTimeline } from "./noteTimeline";

const note = (midi, tie) => (tie ? { midi, name: `n${midi}`, tie } : { midi, name: `n${midi}` });
const evt = (notes, duration = "q") => ({ duration, notes });

describe("isContinuation — the one predicate", () => {
  test("a note already sounding: the tail of a chain, or a middle link", () => {
    expect(isContinuation(note(60, "end"))).toBe(true);
    expect(isContinuation(note(60, "both"))).toBe(true);
  });

  test("a note freshly struck: no tie, or the head of a chain", () => {
    expect(isContinuation(note(60))).toBe(false);
    expect(isContinuation(note(60, "start"))).toBe(false);
  });

  test("rubbish is not a continuation", () => {
    expect(isContinuation(null)).toBe(false);
    expect(isContinuation(undefined)).toBe(false);
    expect(isContinuation({})).toBe(false);
  });
});

describe("struckMidi — what the beat asks for", () => {
  // (a) Every note tied over with "end". Correct before the fix, and still.
  test("all tied over with 'end': nothing is asked for", () => {
    expect(struckMidi(evt([note(60, "end"), note(64, "end")]))).toEqual([]);
  });

  // (b) The case the old rule got wrong.
  test("all tied over with 'both': nothing is asked for either", () => {
    expect(struckMidi(evt([note(60, "both"), note(64, "both")]))).toEqual([]);
    // Mixed continuations — a chain tail beside a middle link — is still
    // entirely held.
    expect(struckMidi(evt([note(60, "end"), note(64, "both")]))).toEqual([]);
  });

  // (c) The other case the old rule got wrong.
  test("a mixed chord asks only for the note that re-articulates", () => {
    // One voice held over, another struck afresh.
    expect(struckMidi(evt([note(50, "end"), note(55)]))).toEqual([55]);
    expect(struckMidi(evt([note(50, "both"), note(55)]))).toEqual([55]);
    // ...and the head of a new chain counts as struck.
    expect(struckMidi(evt([note(50, "end"), note(55, "start")]))).toEqual([55]);
  });

  test("an ordinary chord and a rest are unchanged", () => {
    expect(struckMidi(evt([note(60), note(64), note(67)]))).toEqual([60, 64, 67]);
    expect(struckMidi(evt([]))).toEqual([]);
    expect(struckMidi(undefined)).toEqual([]);
  });
});

describe("the scorer and the synth agree", () => {
  // buildNoteTimeline is what the synth sounds; struckMidi is what the player
  // is asked to play. They must name the same notes as fresh onsets, or the
  // app plays one thing and scores another.
  const measures = [
    {
      number: 1,
      timeSignature: { beats: 4, beatType: 4 },
      rh: [
        evt([note(60, "start"), note(64)]),          // 60 begins a chain, 64 struck
        evt([note(60, "both"), note(67)]),           // 60 held on, 67 struck — MIXED
        evt([note(60, "end")]),                      // 60 finally released
        evt([note(72)]),                             // an ordinary note
      ],
      lh: [evt([note(48)], "w")],
    },
  ];

  test("every note the synth attacks is a note the scorer asks for", () => {
    const { notes, warnings } = buildNoteTimeline(measures);
    expect(warnings).toEqual([]);
    const sounded = notes
      .filter((n) => n.hand === "rh")
      .map((n) => n.midi)
      .sort((a, b) => a - b);
    const asked = measures[0].rh.flatMap(struckMidi).sort((a, b) => a - b);
    expect(sounded).toEqual(asked);
    // Concretely: 60 is attacked once, at the head of its chain.
    expect(asked).toEqual([60, 64, 67, 72]);
  });

  test("a held note is never asked for again, however long the chain", () => {
    const asked = measures[0].rh.map(struckMidi);
    expect(asked[0]).toEqual([60, 64]);
    expect(asked[1]).toEqual([67]);      // 60 is "both" here: held, not asked
    expect(asked[2]).toEqual([]);        // "end": the beat is unscoreable
    expect(asked[3]).toEqual([72]);
  });
});

describe("what this does to scoring", () => {
  // The beat's expected notes are what matchChord is given, so the fix is
  // only real if the right playing now scores a hit.
  const { matchChord } = require("./noteMatching");

  test("a mixed chord scores a HIT when only the re-articulated note is played", () => {
    const expected = struckMidi(evt([note(50, "end"), note(55)]));
    expect(matchChord([55], expected).result).toBe("hit");
  });

  test("...where before the fix that same playing scored a partial", () => {
    // The old rule demanded both notes.
    const oldExpected = [50, 55];
    expect(matchChord([55], oldExpected).result).toBe("partial");
  });

  test("striking the held note as well is still a hit, so nothing regresses", () => {
    const expected = struckMidi(evt([note(50, "end"), note(55)]));
    // Extra notes are tolerated by matchChord — he is not punished for the
    // habit the old rule taught him.
    expect(matchChord([50, 55], expected).result).toBe("hit");
  });

  test("an all-held beat asks for nothing, so it can never be a miss", () => {
    // An empty expected list is what makes the matcher skip the beat and the
    // scanner mark it "skipped" rather than reporting a miss.
    expect(struckMidi(evt([note(60, "both")]))).toHaveLength(0);
  });
});
