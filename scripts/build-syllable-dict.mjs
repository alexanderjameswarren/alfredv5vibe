#!/usr/bin/env node
// Builds public/sam-syllables.txt, the Lyrics sheet's syllable lookup, from the
// Moby Hyphenator II word list (public domain by grant of Grady Ward, 2001;
// https://www.gutenberg.org/ebooks/3204).
//
//   node scripts/build-syllable-dict.mjs [mhyph.txt] [output]
//
// With no input path it downloads the list. Output: one lowercase word per
// line, syllables joined by "|"; single-word entries only (letters and
// apostrophes). Where the list has a word twice ("over", "o|ver"), the version
// with the most breaks wins — singing wants every syllable.
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "https://www.gutenberg.org/files/3204/files/mhyph.txt";
const MARK = "¥"; // the list's break mark, byte 165 read as latin1

export function buildSyllableDict(raw) {
  const best = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const word = line.toLowerCase();
    const key = word.split(MARK).join("");
    if (!/^[a-z']+$/.test(key)) continue;
    const syl = word.split(MARK).join("|");
    const prev = best.get(key);
    if (!prev || syl.split("|").length > prev.split("|").length) best.set(key, syl);
  }
  return [...best.keys()].sort().map((k) => best.get(k)).join("\n") + "\n";
}

const [input, output = "public/sam-syllables.txt"] = process.argv.slice(2);
const raw = input
  ? readFileSync(input, "latin1")
  : Buffer.from(await (await fetch(SOURCE)).arrayBuffer()).toString("latin1");
const dict = buildSyllableDict(raw);
writeFileSync(output, dict);
console.log(`${output}: ${dict.split("\n").length - 1} words, ${(dict.length / 1024).toFixed(0)} KB`);
