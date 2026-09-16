// Duration vocabulary — Deno/TS port of src/sam/lib/durations.js.
//
// Spec §M9 (Alex, 2026-08-06): the browser and the Edge Function need
// the same token → beats mapping so `append_sam_measures`'s duration-
// sum validation agrees with the parser and with the schema validator
// in the app. Deno can't import from `src/`, so this is a straight
// port — kept byte-for-byte identical in the BASE map so the parity
// test (src/sam/lib/durations.test.js "Deno-copy BASE parity") fails
// loudly on drift instead of letting the two definitions grow apart.
//
// If you add a token here (or change a base value), MIRROR IT in
// src/sam/lib/durations.js — the parity test enforces this both ways.
// This copy carries what the Edge Functions need: BASE + tokenToBeats +
// sumEvents (append_sam_measures' duration check) and measureBeats (the
// difficulty analyzer, _shared/analyze.ts). Anything richer belongs in the
// browser copy only (no timeline lift/lower work happens here).
//
// Every function here is checked numerically against all three JS copies —
// tools/sam-tools/lib/durations.js (the original, which the CLI analyzer
// imports), src/sam/lib/durations.js and tools/sam-tools/vendor/durations.js
// — by tools/sam-tools/test/durationsParity.test.js.

// PARITY-MARKER-START — do not remove, the parity test reads between markers
export const BASE: Record<string, number> = {
  w: 4, h: 2, q: 1, "8": 0.5, "16": 0.25, "32": 0.125, "64": 0.0625,
};
// PARITY-MARKER-END

export function tokenToBeats(token: string | null | undefined): number | null {
  if (typeof token !== "string" || token.length === 0) return null;
  let dots = 0;
  let base = token;
  while (base.endsWith("d")) {
    dots += 1;
    base = base.slice(0, -1);
  }
  const b = BASE[base];
  if (b === undefined) return null;
  let total = b;
  let add = b;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    total += add;
  }
  return total;
}

/**
 * Measure length in quarter-note beats for a {beats, beatType} signature.
 * A 6/8 bar is 3.0: BPM throughout SAM means quarter notes per minute.
 * Mirrors tools/sam-tools/lib/durations.js#measureBeats.
 */
export function measureBeats(
  timeSignature: { beats?: number; beatType?: number } | null | undefined,
): number | null {
  if (!timeSignature) return null;
  const { beats, beatType } = timeSignature;
  if (!beats || !beatType) return null;
  return (beats * 4) / beatType;
}

type EvtLike = {
  duration?: string;
  tuplet?: { actual: number; normal: number };
};

/**
 * Sum an array of SAM voice events in quarter-note beats, tuplet-aware.
 * Mirrors src/sam/lib/durations.js#sumEvents (spec §4.2).
 */
export function sumEvents(events: EvtLike[] | null | undefined): number | null {
  let total = 0;
  for (const e of events || []) {
    const b = tokenToBeats(e.duration);
    if (b === null) return null;
    total += e.tuplet ? (b * e.tuplet.normal) / e.tuplet.actual : b;
  }
  return total;
}
