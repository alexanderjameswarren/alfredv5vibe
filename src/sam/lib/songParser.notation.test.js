// Tremolo, glissando/slide, cue, hidden, grace and out-of-range handling.

import fs from "fs";
import path from "path";
import { parseMusicXML } from "./songParser";
import { getEventBeats } from "./measureUtils";

const load = (name) =>
  parseMusicXML(fs.readFileSync(path.join(__dirname, "__fixtures__/notation", name), "utf8"));
const beats = (events) => events.reduce((s, e) => s + getEventBeats(e), 0);
const midis = (events) => events.map((e) => e.notes.map((n) => n.midi));
const tags = (song) => (song.parseWarningsStructured || []).map((w) => `${w.kind}:${w.tag}`);

test("single tremolo stays one held note with a marking", () => {
  const { rh } = load("tremolo-single.musicxml").measures[0];
  expect(rh).toHaveLength(1);
  expect(rh[0].duration).toBe("w");
  expect(rh[0].notes[0].tremolo).toEqual({ type: "single", marks: 3 });
});

test("two-note tremolo with 2:1 becomes two halves, no ratio", () => {
  const song = load("tremolo-two-note-ratio.musicxml");
  const { rh } = song.measures[0];
  expect(rh.map((e) => e.duration)).toEqual(["h", "h"]);
  expect(rh.some((e) => e.tuplet)).toBe(false);
  expect(midis(rh)).toEqual([[108], [103]]);
  expect(rh.map((e) => e.notes[0].tremolo.type)).toEqual(["start", "stop"]);
  expect(tags(song)).toContain("marking:tremolo");
});

test("two-note tremolo at full length is halved, second note kept", () => {
  const song = load("tremolo-two-note-full.musicxml");
  const { rh } = song.measures[0];
  expect(beats(rh)).toBe(4);
  expect(midis(rh)).toEqual([[72, 76], [79]]);
  expect(rh[0].notes.every((n) => n.tremolo?.type === "start")).toBe(true);
  expect(tags(song)).not.toContain("cut:cut");
});

test("glissando keeps start and end notes, marked", () => {
  const { rh } = load("glissando.musicxml").measures[0];
  expect(midis(rh)).toEqual([[60], [84]]);
  expect(rh.map((e) => e.notes[0].gliss)).toEqual([
    { kind: "glissando", type: "start" },
    { kind: "glissando", type: "stop" },
  ]);
});

test("slide chain and out-of-range notes are unscored and warned", () => {
  const song = load("slide-out-of-range.musicxml");
  const { rh, lh } = song.measures[0];
  expect(rh.map((e) => e.notes[0].gliss.type)).toEqual(["start", "both", "stop"]);
  expect(rh[0].notes[0]).toMatchObject({ midi: 110, unscored: true });
  expect(rh[1].notes[0].unscored).toBeUndefined();
  expect(lh[0].notes[0]).toMatchObject({ midi: 19, unscored: true });
  const range = song.parseWarningsStructured.find((w) => w.kind === "range");
  expect(range).toMatchObject({ count: 2, measures: ["1"] });
});

test("octave-shift is not applied to sounding pitch", () => {
  const { rh } = load("octave-shift.musicxml").measures[0];
  expect(midis(rh)).toEqual([[100], [108]]);
  expect(rh[1].notes[0].unscored).toBeUndefined();
});

test("triplet inside a triplet folds to one triplet eighth", () => {
  const song = load("nested-triplet.musicxml");
  const { rh } = song.measures[0];
  expect(beats(rh)).toBeCloseTo(4, 6);
  expect(rh[0]).toMatchObject({ duration: "8", tuplet: { actual: 3, normal: 2 } });
  expect(midis(rh).slice(0, 2)).toEqual([[68, 72], [65]]);
  const w = song.parseWarningsStructured.find((x) => x.tag === "nested-tuplet");
  expect(w).toMatchObject({ kind: "dropped", count: 2, measures: ["1"] });
});

test("grace dropped; cue and hidden notes become rests; hidden rest unchanged", () => {
  const song = load("grace-cue-hidden.musicxml");
  const { rh } = song.measures[0];
  expect(beats(rh)).toBe(4);
  expect(midis(rh)).toEqual([[72], [], [], []]);
  const byTag = Object.fromEntries(song.parseWarningsStructured.map((w) => [w.tag, w]));
  expect(byTag.cue).toMatchObject({ kind: "dropped", count: 2 });
  expect(byTag.hidden).toMatchObject({ kind: "dropped", count: 1 });
  expect(byTag.grace.count).toBe(1);
});
