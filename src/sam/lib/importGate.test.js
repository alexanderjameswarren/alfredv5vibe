// End-to-end check of the import gate on the real failing document.
//
// OLD Someone Like You is the row that motivated the error/warning split: 73
// measures, 371 placed lyrics, 7 real audio offsets, and 15 measures the old
// parser left overlong. Before the split it could not be re-imported at all.
// After it, the document is valid and the 15 measures arrive as approvable
// warnings.
//
// The fixture is the exported file itself, checked in so this does not depend
// on anything in Downloads.

import fs from "fs";
import path from "path";
import { validateSongDocument } from "./songSchema";
import { durationWarningsToStructured } from "../components/SongLoader";

const FIXTURE = path.join(__dirname, "__fixtures__", "old-someone-like-you.export.json");

describe("OLD Someone Like You — the document that used to be unimportable", () => {
  let doc;
  let result;

  beforeAll(() => {
    doc = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    result = validateSongDocument(doc);
  });

  test("the export carries everything Phase 0 needs to prove", () => {
    expect(doc.formatVersion).toBe(2);
    expect(doc.measures).toHaveLength(73);
    expect(doc.lyrics).toHaveLength(371);
    expect(doc.fifths).toBe(3);
    expect(doc.key).toBe("A major");
    // Nulls preserved as nulls; the seven real offsets intact.
    expect(doc.measures.every((m) => "audioOffsetMs" in m)).toBe(true);
    expect(doc.measures.filter((m) => m.audioOffsetMs !== null).map((m) => m.audioOffsetMs))
      .toEqual([0, 14800, 26000, 33000, 36800, 43833, 74000]);
    // word_order is carried, not regenerated — 1..371 with no gaps.
    expect(doc.lyrics.map((l) => l.word_order)).toEqual(
      Array.from({ length: 371 }, (_, i) => i + 1)
    );
  });

  test("it is now importable: zero errors", () => {
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("the 15 malformed measures survive as warnings, not rejections", () => {
    expect(result.warnings).toHaveLength(17); // 17 hands across 15 measures
    const measures = [...new Set(result.warnings.map((w) => w.measureNumber))].sort((a, b) => a - b);
    expect(measures).toEqual([27, 29, 30, 37, 38, 39, 46, 51, 53, 54, 56, 57, 58, 66, 68]);
    // Every one runs long — none of this song's problems are short bars.
    expect(result.warnings.every((w) => w.kind === "overflow")).toBe(true);
  });

  test("they group into one approvable BLOCK entry for the M8 dialog", () => {
    const structured = durationWarningsToStructured(result.warnings, doc.measures);
    expect(structured).toHaveLength(1);
    expect(structured[0]).toMatchObject({ kind: "overflow", tag: "overflow" });
    // count is distinct MEASURES — m51 and m53 fail in both hands and must not
    // be double-counted in the sentence the dialog renders.
    expect(structured[0].count).toBe(15);
    expect(structured[0].measures).toHaveLength(15);
  });
});
