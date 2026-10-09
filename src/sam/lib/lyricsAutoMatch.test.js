import { matchSyllablesToNotes } from "./lyricsAutoMatch";

const note = (tie) => ({ duration: "q", notes: [{ pitch: "C4", ...(tie ? { tie } : {}) }] });
const rest = { duration: "q", notes: [] };
const MEASURES = [
  { number: 1, rh: [note(), rest, note("start")] },
  { number: 2, rh: [note("end"), note()] },
];
const lyrics = (n) => Array.from({ length: n }, (_, i) => ({ word_order: i + 1 }));

test("skips rests and tied continuations", () => {
  const { placements, unplaced } = matchSyllablesToNotes(MEASURES, lyrics(3));
  expect(placements.map((p) => [p.measure_num, p.rh_index])).toEqual([[1, 0], [1, 2], [2, 1]]);
  expect(unplaced).toBe(0);
});

test("places tied continuations when skipTiedNotes is off", () => {
  const { placements } = matchSyllablesToNotes(MEASURES, lyrics(4), { skipTiedNotes: false });
  expect(placements.map((p) => [p.measure_num, p.rh_index])).toEqual([[1, 0], [1, 2], [2, 0], [2, 1]]);
});

test("counts syllables that do not fit", () => {
  const { placements, unplaced } = matchSyllablesToNotes(MEASURES, lyrics(5));
  expect(placements).toHaveLength(3);
  expect(unplaced).toBe(2);
});
