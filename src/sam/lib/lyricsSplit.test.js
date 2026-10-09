import { readFileSync } from "fs";
import { hyphenateSync } from "hyphen/en-us";
import { parseSyllableDict, splitLyrics } from "./lyricsSplit";

// The real list, as served. SYLLABLES_PATH points at another copy if needed.
const splitter = {
  dict: parseSyllableDict(readFileSync(process.env.SYLLABLES_PATH || "public/sam-syllables.txt", "utf8")),
  hyphenate: hyphenateSync,
};
const split = (t) => splitLyrics(t, splitter);

test.each([
  ["every", ["eve-", "ry"]],
  ["over", ["o-", "ver"]],
  ["city", ["cit-", "y"]],
  ["among", ["a-", "mong"]],
  ["Jupiter", ["Ju-", "pi-", "ter"]],
  ["adore,", ["a-", "dore,"]],
  ["baby", ["ba-", "by"]],
  ["open", ["o-", "pen"]],
  ["lady", ["la-", "dy"]],
  ["into", ["in-", "to"]],
  ["Water.", ["Wa-", "ter."]],
])("%s", (word, out) => {
  expect(split(word)).toEqual(out);
});

test.each(["is", "as", "us", "was", "has", "his", "this", "rhythm", "loves", "Is"])("%s stays whole", (w) => {
  expect(split(w)).toEqual([w]);
});

test("-es adds a syllable only after a sibilant", () => {
  expect(split("boxes wishes roses kisses pages")).toEqual(
    ["box-", "es", "wish-", "es", "ros-", "es", "kiss-", "es", "pag-", "es"]
  );
});

test("no syllable without a vowel, whatever the source", () => {
  for (const w of ["acres", "is", "Andrew", "rhythms", "hymns"]) {
    for (const s of split(w)) expect(s).toMatch(/[aeiouy]/i);
  }
});

test("contractions", () => {
  expect(split("don't I'm couldn't lovin'")).toEqual(["don't", "I'm", "could-", "n't", "lov-", "in'"]);
});

test("inflections the list lacks", () => {
  expect(split("loves wanted cities")).toEqual(["loves", "want-", "ed", "cit-", "ies"]);
});

test("hyphenated compound and curly apostrophe", () => {
  expect(split("brand-new")).toEqual(["brand-", "new"]);
  expect(split("Don’t")).toEqual(["Don’t"]);
});

test("unknown words fall back to hyphen, keeping case", () => {
  const out = split("Zorblatter");
  expect(out.join("").replace(/-/g, "")).toBe("Zorblatter");
  expect(out.length).toBeGreaterThan(1);
});

test("one-syllable words stay whole; label lines and blanks skipped", () => {
  expect(split("[Chorus]\nfire and love\n(Verse 2)\n")).toEqual(["fire", "and", "love"]);
  expect(split("")).toEqual([]);
});
