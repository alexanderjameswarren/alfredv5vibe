// Duration vocabulary — the single source of truth for token <-> beats.
// Beats are in quarter-note units.

const BASE = {
  w: 4, h: 2, q: 1, 8: 0.5, 16: 0.25, 32: 0.125, 64: 0.0625,
};

/**
 * Parse a VexFlow-style duration token into beats.
 * Dots are a 'd' suffix, repeatable: "q" = 1, "qd" = 1.5, "qdd" = 1.75.
 * Returns null for tokens outside the vocabulary.
 */
export function tokenToBeats(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  let dots = 0;
  let base = token;
  while (base.endsWith("d")) {
    dots += 1;
    base = base.slice(0, -1);
  }
  const b = BASE[base];
  if (b === undefined) return null;
  // Each dot adds half of the previous increment: b * (2 - 2^-dots)
  let total = b;
  let add = b;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    total += add;
  }
  return total;
}

/** Every representable token, ascending by beats. */
export const ALL_TOKENS = (() => {
  const out = [];
  for (const base of Object.keys(BASE)) {
    for (const dots of ["", "d", "dd"]) out.push(base + dots);
  }
  return out.sort((a, b) => tokenToBeats(a) - tokenToBeats(b));
})();

/** Exact single-token match for a beat value, or null. */
export function beatsToToken(beats) {
  for (const t of ALL_TOKENS) {
    if (Math.abs(tokenToBeats(t) - beats) < 1e-9) return t;
  }
  return null;
}

/**
 * Decompose a beat value into a minimal sequence of representable tokens
 * (largest-first, greedy). Returns null if it cannot be expressed exactly —
 * which for the standard vocabulary only happens below a 64th.
 */
export function beatsToTokens(beats) {
  const out = [];
  let remaining = beats;
  const desc = [...ALL_TOKENS].reverse();
  let guard = 0;
  while (remaining > 1e-9 && guard++ < 64) {
    const t = desc.find((tok) => tokenToBeats(tok) <= remaining + 1e-9);
    if (!t) return null;
    out.push(t);
    remaining -= tokenToBeats(t);
  }
  return remaining > 1e-9 ? null : out;
}

/** Measure length in quarter-note beats for a {beats, beatType} signature. */
export function measureBeats(timeSignature) {
  if (!timeSignature) return null;
  const { beats, beatType } = timeSignature;
  if (!beats || !beatType) return null;
  return (beats * 4) / beatType;
}

/**
 * Sum an array of SAM voice events ({duration, tuplet?}) in beats.
 * Returns null if any token is unknown.
 *
 * Tuplet-aware: MusicXML <duration> is already sounded (tuplet-scaled) time,
 * but the SAM vocabulary can't represent 1/3-of-a-beat exactly, so the parser
 * stores the DISPLAY token ("8" for a triplet-eighth) plus a tuplet marker
 * `{actual, normal}`. Sounded beats for such an event = tokenToBeats * normal /
 * actual. Per spec §4.2: "Beat math multiplies by `normal/actual`."
 * A caller doing beat math should not have to re-implement this.
 */
export function sumEvents(events) {
  let total = 0;
  for (const e of events || []) {
    const b = tokenToBeats(e.duration);
    if (b === null) return null;
    total += e.tuplet ? (b * e.tuplet.normal) / e.tuplet.actual : b;
  }
  return total;
}

export const isKnownToken = (t) => tokenToBeats(t) !== null;
