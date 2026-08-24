import React from "react";

// A grid of note tiles: five-line treble staff, one notehead, nothing else.
//
// This exists to answer one question — at what tile size can a staff position
// be read at a glance on a phone? So it is deliberately inert: no state, no
// handlers, no colour coding. Every tile is the same colour, because the whole
// experiment is whether *position alone* carries the signal. Colouring by
// pitch would answer a different, easier question.

// Pitch index 0 is the bottom staff line (E4); each +1 is one diatonic step
// up, so even indices land on lines and odd indices in spaces. Index 8 is the
// top line, index 10 the first ledger line above the staff.
const STAFF_LINE_COUNT = 5;
const FIRST_LEDGER_INDEX = 10;

// All tile geometry as fractions of the tile size S, so a tile is resolution-
// independent and the three sizes below are the same drawing at three scales.
function tileGeometry(S) {
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

// One tile. Rendered as inline SVG with a viewBox in tile units, so the tile
// scales with whatever width its grid cell ends up at (see NotesBoard).
export function NoteTile({ pitch, size }) {
  const g = tileGeometry(size);
  const cy = g.bottomLine - (g.spacing / 2) * pitch;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width="100%"
      height="100%"
      className="block rounded-lg border border-border bg-card"
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

// A 5x5 board at a fixed tile size, captioned with that size.
//
// The natural width is 5 tiles plus 4 gaps of S/9. At S = 68 that is 370px,
// which is wider than a 390px phone's content box once page padding is taken
// off — so the grid is capped at 100% and the tiles, being 1fr cells holding
// percentage-width SVGs, shrink to fit rather than wrapping or clipping. The
// caption states the nominal size; on a narrow phone the largest board renders
// a hair under it.
export function NotesBoard({ rows, size, label }) {
  const gap = size / 9;
  const naturalWidth = size * 5 + gap * 4;

  return (
    <section className="mb-8">
      <p className="text-xs text-muted-foreground text-center mb-2">
        {label} — {size}px tiles
      </p>
      <div
        className="grid mx-auto"
        style={{
          width: `min(${naturalWidth}px, 100%)`,
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: `${gap}px`,
        }}
      >
        {rows.flatMap((row, r) =>
          row.map((pitch, c) => (
            <div key={`${r}-${c}`} className="aspect-square">
              <NoteTile pitch={pitch} size={size} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// Hard-coded, not generated. Identical output across reloads is the point —
// otherwise the six grids below are not comparable to each other.
export const LOW_BOARD = [
  [1, 3, 0, 2, 4],
  [0, 2, 2, 4, 1],
  [3, 1, 2, 0, 3],
  [2, 4, 1, 3, 0],
  [4, 0, 3, 1, 2],
];

export const HIGH_BOARD = [
  [8, 6, 9, 7, 10],
  [7, 10, 6, 9, 6],
  [10, 8, 7, 10, 8],
  [6, 9, 10, 6, 9],
  [9, 7, 8, 8, 7],
];

export const TILE_SIZES = [44, 56, 68];
