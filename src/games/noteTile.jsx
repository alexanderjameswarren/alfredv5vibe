import React from "react";

// The one and only note tile renderer. Shared by every variant.
//
// NEVER FORK THIS FILE. If a variant needs a rendering change, it changes here
// and applies to all of them — the whole point of the harness is that variants
// differ in their rules, not in how a note looks. A forked tile makes two
// variants incomparable.
//
// Pitch index 0 is the bottom staff line (E4); each +1 is one diatonic step
// up, so even indices land on lines and odd indices in spaces. Index 8 is the
// top line, index 10 the first ledger line above the staff. Pitches are
// unbounded upward — merging climbs past the staff and the ledger rule keeps
// up on its own.
//
// The default geometry runs out: index 11 puts the notehead above the viewBox
// and it clips. Drop reached it — its survivors carry across refills — so Drop
// caps pitches at 12 (C6) and passes `maxPitch`, which lowers the staff and
// tightens the spacing until 0..maxPitch all fit. Without `maxPitch` the
// drawing is exactly as before, which is what the archived variants still get.

// Board geometry, confirmed by the readability sweep: 68px tiles, 5x5.
export const TILE = 68;
export const GRID = 5;
export const GAP = TILE / 9;

const STAFF_LINE_COUNT = 5;
const FIRST_LEDGER_INDEX = 10;

// Fitted layout: blank margin kept above the highest notehead and below the
// lowest, as a fraction of S. Notehead and ledger sizes are taken from the
// default geometry as multiples of the line spacing, so a tightened staff
// still reads as the same drawing, just smaller.
const FIT_MARGIN = 0.05;
const RY_PER_SPACING = 0.56; // 0.08 / (1/7)
const RX_PER_SPACING = 0.75; // 0.107 / (1/7)
const LEDGER_PER_SPACING = 1.372; // 0.196 / (1/7)

// All tile geometry as fractions of the tile size S, so a tile is resolution-
// independent and stays the same drawing at any scale.
export function tileGeometry(S, maxPitch = null) {
  if (maxPitch != null) {
    // Pitch 0 to maxPitch spans maxPitch half-spacings between notehead
    // centres, plus one notehead height; that fills S less two margins.
    const top = Math.max(maxPitch, STAFF_LINE_COUNT * 2 - 2);
    const spacing = (S * (1 - 2 * FIT_MARGIN)) / (top / 2 + 2 * RY_PER_SPACING);
    const bottomLine = S * (1 - FIT_MARGIN) - RY_PER_SPACING * spacing;
    return {
      spacing,
      topLine: bottomLine - (STAFF_LINE_COUNT - 1) * spacing,
      bottomLine,
      staffX1: 0.179 * S,
      staffX2: 0.821 * S,
      noteCx: S / 2,
      noteRx: RX_PER_SPACING * spacing,
      noteRy: RY_PER_SPACING * spacing,
      ledgerHalfWidth: LEDGER_PER_SPACING * spacing,
    };
  }
  const spacing = S / 7;
  const topLine = 0.25 * S;
  return {
    spacing,
    topLine,
    // 0.25 + 4/7 === 0.8214…, i.e. the specified 0.821 * S.
    bottomLine: topLine + (STAFF_LINE_COUNT - 1) * spacing,
    staffX1: 0.179 * S,
    staffX2: 0.821 * S,
    noteCx: S / 2,
    noteRx: 0.107 * S,
    noteRy: 0.08 * S,
    ledgerHalfWidth: 0.196 * S,
  };
}

// A notehead above the staff needs a ledger line for every line-position it
// has passed, not just the one it sits on — so 12 draws ledgers at 10 and 12.
// Odd (space) pitches hang off the last even ledger below them.
function ledgerIndices(pitch) {
  const lines = [];
  for (let i = FIRST_LEDGER_INDEX; i <= pitch; i += 2) lines.push(i);
  return lines;
}

// One tile: a five-line treble staff and a single notehead. `pitch` of null is
// an emptied cell, drawn as a faint outlined slot so the grid keeps its shape
// — a hole has to stay legible as a hole, not collapse the layout.
//
// Every tile is the same colour, deliberately. Staff position is the only
// signal; colour-coding by pitch would let you play without reading.
// Vertical extent of a pitch's notehead within its tile.
export function noteBounds(pitch, size = TILE, maxPitch = null) {
  const g = tileGeometry(size, maxPitch);
  const cy = g.bottomLine - (g.spacing / 2) * pitch;
  return { top: cy - g.noteRy, bottom: cy + g.noteRy };
}

export default function NoteTile({ pitch, size = TILE, maxPitch = null }) {
  const className = "block w-full h-full rounded-lg";

  if (pitch == null) {
    return (
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width="100%"
        height="100%"
        className={`${className} border border-dashed border-border opacity-50`}
        aria-hidden="true"
      />
    );
  }

  const g = tileGeometry(size, maxPitch);
  const cy = g.bottomLine - (g.spacing / 2) * pitch;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width="100%"
      height="100%"
      className={`${className} border border-border bg-card`}
      aria-hidden="true"
    >
      {/* Staff: thin, low opacity, muted — scaffolding, not the message. */}
      <g stroke="var(--muted-foreground)" strokeWidth="1" opacity="0.45">
        {Array.from({ length: STAFF_LINE_COUNT }, (_, i) => (
          <line
            key={i}
            x1={g.staffX1}
            x2={g.staffX2}
            y1={g.topLine + i * g.spacing}
            y2={g.topLine + i * g.spacing}
          />
        ))}
      </g>

      {/* Ledger lines belong to the note, so they take the note's colour. */}
      <g stroke="var(--foreground)" strokeWidth="1">
        {ledgerIndices(pitch).map((i) => {
          const y = g.bottomLine - (g.spacing / 2) * i;
          return (
            <line
              key={i}
              x1={g.noteCx - g.ledgerHalfWidth}
              x2={g.noteCx + g.ledgerHalfWidth}
              y1={y}
              y2={y}
            />
          );
        })}
      </g>

      <ellipse
        cx={g.noteCx}
        cy={cy}
        rx={g.noteRx}
        ry={g.noteRy}
        fill="var(--foreground)"
      />
    </svg>
  );
}
