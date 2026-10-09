// Pasted lyrics → syllables, in the shape load_sam_lyrics stores: every
// syllable but a word's last ends in "-" (["Nev-", "er", "mind"]).
//
// Words are looked up in the Moby Hyphenator list (public/sam-syllables.txt,
// built by scripts/build-syllable-dict.mjs), with suffix rules for forms it
// lacks (loves, wanted, lovin'). Only a word it cannot place falls back to
// hyphen's TeX patterns, which split for typesetting, not singing.

const SOFT = "­";

// "[Chorus]" / "(Verse 2)" lines from lyric sites are labels, not sung words.
const LABEL_LINE = /^\s*[[(].*[\])]\s*$/;

export function parseSyllableDict(text) {
  const dict = new Map();
  for (const line of text.split("\n")) {
    if (line) dict.set(line.split("|").join(""), line);
  }
  return dict;
}

// Both pieces load on first use — the Lyrics sheet opening — never with the app.
let splitterPromise = null;
export function loadSplitter() {
  if (!splitterPromise) {
    splitterPromise = Promise.all([
      Promise.resolve().then(() => fetch(`${process.env.PUBLIC_URL || ""}/sam-syllables.txt`)).then((r) => {
        if (!r.ok) throw new Error(`Could not load the syllable list (${r.status}).`);
        return r.text();
      }),
      import("hyphen/en-us"),
    ]).then(([text, mod]) => ({
      dict: parseSyllableDict(text),
      hyphenate: (mod.default || mod).hyphenateSync,
    }));
    splitterPromise.catch(() => { splitterPromise = null; });
  }
  return splitterPromise;
}

const withLast = (syls, fn) => [...syls.slice(0, -1), fn(syls[syls.length - 1])];

// Lowercase syllables for a lowercase key, or null. Dictionary first, then a
// suffix stripped and looked up again.
function lookup(key, dict) {
  const hit = dict.get(key);
  if (hit) return hit.split("|");
  const base = (n, add = "") => (key.length - n > 1 ? lookup(key.slice(0, -n) + add, dict) : null);
  let b;

  if (key.endsWith("in'") && (b = base(1, "g")) && b[b.length - 1].endsWith("ing")) {
    return withLast(b, (s) => s.slice(0, -1) + "'");
  }
  if (/n't$/.test(key) && (b = base(3))) {
    return /[aeiouy]$/.test(key.slice(0, -3)) ? withLast(b, (s) => s + "n't") : [...b, "n't"];
  }
  const tail = key.match(/('s|s'|'ll|'re|'ve|'d|'m)$/);
  if (tail && (b = base(tail[1] === "s'" ? 1 : tail[1].length))) return withLast(b, (s) => s + tail[1].replace(/^s'$/, "'"));
  if (key.endsWith("ies") && (b = base(3, "y"))) return withLast(b, (s) => s.slice(0, -1) + "ies");
  // Only -es after a sibilant adds a syllable: box-es, wish-es, ros-es, pag-es.
  if (/(s|x|z|ch|sh)es$/.test(key) && (b = base(2))) return [...b, "es"];
  if (/(se|ze|ge|ce)s$/.test(key) && (b = base(1))) return [...withLast(b, (s) => s.slice(0, -1)), "es"];
  // Any other -s joins the last syllable: loves, stars.
  if (key.endsWith("s") && !key.endsWith("ss") && (b = base(1))) return withLast(b, (s) => s + "s");
  if (key.endsWith("ied") && (b = base(3, "y"))) return withLast(b, (s) => s.slice(0, -1) + "ied");
  if (key.endsWith("ed")) {
    if ((b = base(1)) || (b = base(2))) {
      const stem = key.slice(0, -2);
      return /[td]$/.test(stem) ? [...b.slice(0, -1), b[b.length - 1].replace(/e$/, ""), "ed"].filter(Boolean)
        : withLast(b, (s) => (s.endsWith("e") ? s + "d" : s + "ed"));
    }
  }
  if (key.endsWith("ing")) {
    const doubled = key.length > 5 && key[key.length - 4] === key[key.length - 5];
    if (doubled && (b = base(4))) return [...b, key.slice(-4)];
    if ((b = base(3)) || (b = base(3, "e"))) return [...withLast(b, (s) => s.replace(/e$/, "")), "ing"];
  }
  return null;
}

// Safety net, whatever made the split: a syllable with no vowel joins the one
// before it (or after, if first). The list has ~1,000 such entries — "is" is
// only there as "I|s". "n't" stays its own syllable (could-n't).
function mergeVowelless(syls) {
  const out = [];
  for (const s of syls) {
    if (out.length && !/[aeiouy]/.test(s) && !s.endsWith("n't")) out[out.length - 1] += s;
    else out.push(s);
  }
  if (out.length > 1 && !/[aeiouy]/.test(out[0]) && !out[0].endsWith("n't")) out.splice(0, 2, out[0] + out[1]);
  return out;
}

// Cut `original` into pieces the lengths of `syls`, so case and curly
// apostrophes survive the lowercase lookup.
function reshape(original, syls) {
  if (syls.join("").length !== original.length) return [original];
  let at = 0;
  return syls.map((s) => original.slice(at, (at += s.length)));
}

function splitPart(part, { dict, hyphenate }) {
  const [, pre, core, post] = part.match(/^([^\p{L}\p{N}']*)(.*?)([^\p{L}\p{N}']*)$/u);
  if (!core) return [part];
  const key = core.toLowerCase().replace(/’/g, "'");
  let syls = lookup(key, dict);
  // Quote marks round a word: 'hello' — try again without them.
  if (!syls && /^'|'$/.test(key)) {
    const inner = key.replace(/^'+|'+$/g, "");
    const found = inner && lookup(inner, dict);
    if (found) {
      const lead = key.length - key.replace(/^'+/, "").length;
      syls = withLast([key.slice(0, lead) + found[0], ...found.slice(1)], (s) => s + key.slice(lead + inner.length));
    }
  }
  if (!syls) syls = hyphenate(key, { hyphenChar: SOFT, minWordLength: 1 }).split(SOFT).filter(Boolean);
  const pieces = reshape(core, mergeVowelless(syls));
  pieces[0] = pre + pieces[0];
  pieces[pieces.length - 1] += post;
  return pieces;
}

function splitWord(word, splitter) {
  // A written hyphen ("well-known") is already a syllable break.
  const pieces = word.split("-").filter(Boolean).flatMap((p) => splitPart(p, splitter));
  return pieces.map((s, i) => (i < pieces.length - 1 ? s + "-" : s));
}

export function splitLyrics(text, splitter) {
  return (text || "")
    .split(/\r?\n/)
    .filter((line) => !LABEL_LINE.test(line))
    .flatMap((line) => line.split(/\s+/).filter(Boolean))
    .flatMap((w) => splitWord(w, splitter));
}
