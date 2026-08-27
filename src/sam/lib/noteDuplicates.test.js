// M2 — the shared duplicate-pitch predicate and the write paths that call it.
//
// M1's merge behaviour is covered in songParser.dedupe.test.js. This file
// covers the predicate itself, the two write paths that live in the browser
// bundle, the schema keyword, and — the one that stops the rule quietly
// diverging — behavioural parity with the Deno port the Edge Function uses.

import {
  isContinuation,
  duplicatePitches,
  duplicatePitchErrors,
  duplicatePitchMessage,
  scanMeasuresForDuplicatePitches,
} from "./noteDuplicates";
import { validateSongDocument } from "./songSchema";
import { validateMusicXmlSong } from "../components/SongLoader";

const note = (midi, name, tie) => (tie ? { midi, name, tie } : { midi, name });

const measure = (rh, lh = []) => ({
  number: 1,
  timeSignature: { beats: 4, beatType: 4 },
  rh,
  lh,
});

const doc = (measures) => ({ title: "T", measures });

describe("duplicatePitches — the predicate", () => {
  test("a repeated fresh pitch is reported once, by midi", () => {
    expect(duplicatePitches([
      note(62, "D4"), note(65, "F4", "start"), note(65, "F4"), note(69, "A4"),
    ])).toEqual([65]);
  });

  test("a pitch held by one voice and struck by another is not a duplicate", () => {
    expect(duplicatePitches([note(61, "C#4"), note(61, "C#4", "end")])).toEqual([]);
    expect(duplicatePitches([note(61, "C#4"), note(61, "C#4", "both")])).toEqual([]);
  });

  test("three fresh copies still report the pitch once", () => {
    expect(duplicatePitches([
      note(65, "F4"), note(65, "F4"), note(65, "F4"),
    ])).toEqual([65]);
  });

  test("two fresh plus one held: still a duplicate", () => {
    expect(duplicatePitches([
      note(65, "F4"), note(65, "F4"), note(65, "F4", "end"),
    ])).toEqual([65]);
  });

  test("several duplicated pitches come back in first-appearance order", () => {
    expect(duplicatePitches([
      note(69, "A4"), note(62, "D4"), note(69, "A4"), note(62, "D4"),
    ])).toEqual([69, 62]);
  });

  test("clean events, short arrays and junk return empty", () => {
    expect(duplicatePitches([note(60, "C4"), note(64, "E4")])).toEqual([]);
    expect(duplicatePitches([note(60, "C4")])).toEqual([]);
    expect(duplicatePitches([])).toEqual([]);
    expect(duplicatePitches(undefined)).toEqual([]);
    expect(duplicatePitches([null, undefined, { name: "no midi" }])).toEqual([]);
  });

  test("the message names the pitch and the reason", () => {
    const m = duplicatePitchMessage([note(65, "F4")], 65);
    expect(m).toContain("F4");
    expect(m).toContain("midi 65");
    expect(m).toContain("tie continuation");
  });

  test("error lines carry the caller's location", () => {
    const errs = duplicatePitchErrors(
      [note(65, "F4"), note(65, "F4")], "measure 7 rh[2]"
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("measure 7 rh[2]");
  });
});

describe("scanMeasuresForDuplicatePitches", () => {
  test("finds duplicates in both hands and locates them", () => {
    const errs = scanMeasuresForDuplicatePitches([
      measure([{ duration: "q", notes: [note(65, "F4"), note(65, "F4")] }]),
      measure(
        [{ duration: "q", notes: [note(60, "C4")] }],
        [{ duration: "q", notes: [note(48, "C3"), note(48, "C3")] }]
      ),
    ]);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toContain("measure 1 rh[0]");
    expect(errs[1]).toContain("measure 2 lh[0]");
  });

  test("legitimate pairs are not reported", () => {
    expect(scanMeasuresForDuplicatePitches([
      measure([{ duration: "q", notes: [note(61, "C#4"), note(61, "C#4", "end")] }]),
    ])).toEqual([]);
  });

  test("tolerates missing hands and empty input", () => {
    expect(scanMeasuresForDuplicatePitches([{ number: 1 }])).toEqual([]);
    expect(scanMeasuresForDuplicatePitches(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Write path 1 — MusicXML import (SongLoader.validateMusicXmlSong)
// ---------------------------------------------------------------------------

describe("write path: validateMusicXmlSong", () => {
  test("rejects a parsed song carrying a duplicate", () => {
    const err = validateMusicXmlSong(doc([
      measure([{ duration: "q", notes: [note(65, "F4", "start"), note(65, "F4")] }]),
    ]));
    expect(err).not.toBeNull();
    expect(err).toContain("F4");
    expect(err).toContain("measure 1 rh[0]");
  });

  test("accepts a legitimate hold-plus-restrike pair", () => {
    expect(validateMusicXmlSong(doc([
      measure([{ duration: "q", notes: [note(61, "C#4"), note(61, "C#4", "end")] }]),
    ]))).toBeNull();
  });

  test("still accepts parser output carrying an inline lyric", () => {
    // The reason this path does not run the strict schema. If that ever
    // changed, every MusicXML import with lyrics would start failing.
    expect(validateMusicXmlSong(doc([
      measure([{ duration: "q", notes: [note(60, "C4")], lyric: "la-" }]),
    ]))).toBeNull();
  });

  test("the pre-existing shape checks still fire", () => {
    expect(validateMusicXmlSong(null)).toContain("no object");
    expect(validateMusicXmlSong({ measures: [] })).toContain("no measures");
  });
});

// ---------------------------------------------------------------------------
// Write path 2 — JSON import / paste (songSchema.validateSongDocument)
// ---------------------------------------------------------------------------

describe("write path: validateSongDocument", () => {
  test("rejects a duplicate as an ERROR, not a warning", () => {
    const r = validateSongDocument(doc([
      measure([{ duration: "w", notes: [note(65, "F4", "start"), note(65, "F4")] }]),
    ]));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toContain("duplicate pitch");
    expect(r.errors.join("\n")).toContain("F4");
  });

  test("accepts a legitimate hold-plus-restrike pair", () => {
    const r = validateSongDocument(doc([
      measure([{ duration: "w", notes: [note(61, "C#4"), note(61, "C#4", "end")] }]),
    ]));
    expect(r.valid).toBe(true);
  });

  test("a clean document is still valid", () => {
    const r = validateSongDocument(doc([
      measure([{ duration: "w", notes: [note(60, "C4"), note(64, "E4")] }],
              [{ duration: "w", notes: [note(48, "C3")] }]),
    ]));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("the duplicate is caught even when the document is otherwise perfect", () => {
    // Guards against the check being skipped by an early return that only
    // triggers on some other failure.
    const r = validateSongDocument(doc([
      measure(
        [{ duration: "h", notes: [note(60, "C4")] },
         { duration: "h", notes: [note(64, "E4"), note(64, "E4")] }],
        [{ duration: "w", notes: [note(48, "C3")] }]
      ),
    ]));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toContain("duplicate pitch");
  });
});

// ---------------------------------------------------------------------------
// Deno-copy predicate parity — the drift guard for write path 3.
//
// supabase/functions/_shared/noteDuplicates.ts is a hand-kept port, because
// Deno cannot import from src/ (same constraint and same resolution as
// durations.ts, spec §M9). A comment saying "mirror this" is not a guarantee,
// so: read the Deno file, strip its type annotations, evaluate the marked
// block, and run a shared table of cases through both implementations.
//
// This asserts BEHAVIOUR, not text — the two files are allowed to differ in
// formatting and typing, and required to agree on every verdict.
// ---------------------------------------------------------------------------

describe("Deno-copy predicate parity (spec M2)", () => {
  const fs = require("fs");
  const path = require("path");
  const denoFile = path.resolve(
    __dirname,
    "../../../supabase/functions/_shared/noteDuplicates.ts"
  );

  // Exactly the annotations the marked block is allowed to use. An unfamiliar
  // one fails loudly below rather than silently skipping the parity check.
  const ANNOTATIONS = /\s*\??\s*:\s*(?:unknown|boolean|string|number\[\]|number|NoteLike(?:\s*\|\s*null)?)/g;

  function loadDenoPredicate() {
    let text;
    try {
      text = fs.readFileSync(denoFile, "utf8");
    } catch (e) {
      throw new Error(
        `Could not read the Deno port at ${denoFile}: ${e.message}. ` +
        `Both files are expected to exist — append_sam_measures imports it.`
      );
    }
    const m = text.match(/PARITY-MARKER-START[^\n]*\n([\s\S]*?)\/\/ PARITY-MARKER-END/);
    if (!m) {
      throw new Error(
        `Could not find the PARITY-MARKER-START/END block in the Deno ` +
        `noteDuplicates port. If you edited that file, keep the marker ` +
        `comments around isContinuation + duplicatePitches.`
      );
    }
    const js = m[1].replace(/\bexport\s+/g, "").replace(ANNOTATIONS, "");
    if (/:\s*[A-Za-z_$]/.test(js)) {
      throw new Error(
        `The Deno marked block uses a type annotation this test does not know ` +
        `how to strip:\n${js}\nEither keep the block to the existing ` +
        `annotations or extend ANNOTATIONS in this test.`
      );
    }
    // eslint-disable-next-line no-new-func
    return new Function(
      `${js}\nreturn { isContinuation, duplicatePitches };`
    )();
  }

  const CASES = [
    [],
    [note(60, "C4")],
    [note(60, "C4"), note(64, "E4"), note(67, "G4")],
    [note(65, "F4"), note(65, "F4")],
    [note(65, "F4", "start"), note(65, "F4")],
    [note(65, "F4"), note(65, "F4", "start")],
    [note(61, "C#4"), note(61, "C#4", "end")],
    [note(61, "C#4", "end"), note(61, "C#4")],
    [note(61, "C#4"), note(61, "C#4", "both")],
    [note(61, "C#4", "end"), note(61, "C#4", "both")],
    [note(65, "F4", "start"), note(65, "F4"), note(65, "F4", "end")],
    [note(62, "D4", "start"), note(65, "F4", "start"), note(65, "F4"), note(69, "A4", "start")],
    [note(69, "A4"), note(62, "D4"), note(69, "A4"), note(62, "D4")],
    [note(65, "F4"), note(65, "F4"), note(65, "F4")],
    [null, undefined, { name: "no midi" }],
    [{ midi: "65", name: "F4" }, { midi: "65", name: "F4" }],
  ];

  test("the Deno port agrees with this module on every case", () => {
    const deno = loadDenoPredicate();
    for (const notes of CASES) {
      expect(deno.duplicatePitches(notes)).toEqual(duplicatePitches(notes));
    }
  });

  test("the Deno port agrees on what counts as a continuation", () => {
    const deno = loadDenoPredicate();
    for (const tie of ["start", "end", "both", undefined, null, "stop"]) {
      const n = { midi: 60, name: "C4", tie };
      expect(deno.isContinuation(n)).toBe(isContinuation(n));
    }
    expect(deno.isContinuation(undefined)).toBe(isContinuation(undefined));
    expect(deno.isContinuation(null)).toBe(isContinuation(null));
  });

  test("the parity harness actually discriminates", () => {
    // A parity test that cannot fail has not been tested. Mutate the extracted
    // source and confirm the comparison notices.
    const deno = loadDenoPredicate();
    const broken = new Function(
      `function isContinuation(n){return false;}
       ${deno.duplicatePitches.toString()}
       return duplicatePitches;`
    )();
    const legitimate = [note(61, "C#4"), note(61, "C#4", "end")];
    expect(duplicatePitches(legitimate)).toEqual([]);
    expect(broken(legitimate)).toEqual([61]);
  });
});
