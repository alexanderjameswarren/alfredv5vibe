// Duration vocabulary — the single source of truth for token <-> beats.
// Beats are in quarter-note units. Ported from tools/sam-tools/lib/durations.js
// and kept behaviourally identical: any beat-math consumer that reaches for
// either copy sees the same rules. Keep the two files in sync.

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
 * `{actual, normal}`. Sounded beats for such an event
 *   = tokenToBeats * normal / actual.
 * Per spec §4.2: "Beat math multiplies by `normal/actual`." A caller doing
 * beat math should not have to re-implement this.
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

// ---------------------------------------------------------------------------
// Timeline lift / lower — spec §3.3
//
// Storage stays token-based (spec §3.3: "position stays implied in storage").
// In-memory transforms — voice merging, gap filling, everything downstream in
// the simplification pipeline — operate on a timeline shape that makes onset
// and sounded duration explicit and float-explicit:
//     [{ onsetBeats, durBeats, notes, rest?, tuplet?, lyric?, voice? }]
//
// `toTimeline` walks events accumulating onset from tuplet-aware beats.
// `fromTimeline` reconstructs tokens, using the segment's carried tuplet to
// pick token + ratio when applicable. Round-trip is exact for well-formed
// input; a tuplet-boundary-span segment (see §M2 progress notes) is a
// legitimate parse warning surfaced through the caller-supplied array.
// ---------------------------------------------------------------------------

// Onset comparison epsilon. 1e-6 is loose enough to survive accumulated
// triplet-of-triplet drift across a Moonlight bar without masking real bugs
// (a whole-token unit is at least 0.0625; a real mismatch would be far
// larger). Tighter than 1e-6 has bitten in practice — 1e-9 (xmlTruth's
// original value) is uncomfortably close to triple-nested-tuplet drift.
export const ONSET_EPS = 1e-6;

/**
 * Lift SAM voice events into a timeline of {onsetBeats, durBeats, ...}.
 * onset starts at 0 and accumulates tuplet-aware sounded beats.
 */
export function toTimeline(events) {
  const out = [];
  let onset = 0;
  for (const e of events || []) {
    const b = tokenToBeats(e.duration);
    if (b === null) {
      throw new Error(`toTimeline: unknown duration token "${e.duration}"`);
    }
    const durBeats = e.tuplet ? (b * e.tuplet.normal) / e.tuplet.actual : b;
    const seg = {
      onsetBeats: onset,
      durBeats,
      notes: (e.notes || []).map((n) => ({ ...n })),
      rest: (e.notes || []).length === 0,
    };
    if (e.tuplet) seg.tuplet = { actual: e.tuplet.actual, normal: e.tuplet.normal };
    if (e.lyric !== undefined) seg.lyric = e.lyric;
    if (e.voice !== undefined) seg.voice = e.voice;
    out.push(seg);
    onset += durBeats;
  }
  return out;
}

/**
 * Lower a timeline back into SAM voice events.
 * Uses the carried tuplet to pick token + ratio: displayBeats = durBeats *
 * actual/normal, then beatsToToken. Pushes a warning if the ratio doesn't
 * cleanly explain the segment length (tuplet-boundary span, spec §M2 notes).
 *
 * `parseWarnings` and `context` are optional; when provided, warnings are
 * appended with location info instead of returned. When omitted, the
 * function still returns tokenised events but silently on ambiguity — used
 * by the toTimeline/fromTimeline round-trip test in unit code.
 */
export function fromTimeline(timeline, parseWarnings, context) {
  const warn = (msg) => {
    if (parseWarnings) parseWarnings.push(context ? `${context}: ${msg}` : msg);
  };

  return (timeline || []).map((seg) => {
    const dur = seg.durBeats;
    const notes = (seg.notes || []).map((n) => ({ ...n }));

    if (seg.tuplet) {
      const { actual, normal } = seg.tuplet;
      const displayBeats = (dur * actual) / normal;
      const token = beatsToToken(displayBeats);
      if (token) {
        const out = { duration: token, notes };
        out.tuplet = { actual, normal };
        if (seg.lyric !== undefined) out.lyric = seg.lyric;
        if (seg.voice !== undefined) out.voice = seg.voice;
        return out;
      }
      // Tuplet ratio doesn't cleanly explain the segment length. This is
      // the tuplet-boundary-span case flagged in spec §M2: a note held
      // across the end of a triplet group produces a fragment that's
      // partly inside and partly outside the ratio. FLAG and fall through
      // to the non-tuplet path so the reader gets SOMETHING legible.
      warn(
        `tuplet-boundary span at onset ${dur.toFixed(4)} beat: ratio ` +
        `${actual}:${normal} does not cleanly explain segment length ` +
        `${dur.toFixed(4)} (display would be ${displayBeats.toFixed(4)})`
      );
    }

    const token = beatsToToken(dur);
    if (token) {
      const out = { duration: token, notes };
      if (seg.lyric !== undefined) out.lyric = seg.lyric;
      if (seg.voice !== undefined) out.voice = seg.voice;
      return out;
    }

    // Not representable as a single token. Try greedy decomposition; if
    // that also fails, emit a best-effort "q" and warn loudly. In practice
    // this branch is unreachable for the current corpus (verified in M2
    // exit — no fixture triggers it), but a future score with a genuine
    // 5-beat measure or a bare 1/3-beat rest would land here.
    const tokens = beatsToTokens(dur);
    if (tokens && tokens.length > 0) {
      warn(
        `segment of ${dur.toFixed(4)} beats not a single token; best-` +
        `effort using first-token "${tokens[0]}" (would need multi-event ` +
        `emission to represent exactly)`
      );
      const out = { duration: tokens[0], notes };
      if (seg.lyric !== undefined) out.lyric = seg.lyric;
      if (seg.voice !== undefined) out.voice = seg.voice;
      return out;
    }

    warn(`segment of ${dur.toFixed(4)} beats not representable in vocabulary`);
    return { duration: "q", notes };
  });
}
