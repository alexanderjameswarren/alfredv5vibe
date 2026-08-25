import React, { useState } from "react";
import NoteTile, { TILE, GRID, GAP } from "../noteTile";

// Vanish — merged tiles leave permanent holes.
//
// The tweak under test: nothing refills. No gravity, no new tiles. Every merge
// costs you board space forever, so the interesting question is whether the
// shrinking board makes the run tense or just kills it early.
//
// Board is a flat array of GRID * GRID cells; a cell is a pitch index or null
// for a hole. In-memory only — nothing persists between sessions.

const CELLS = GRID * GRID;
const SEED_PITCHES = 5; // initial seed is limited to indices 0-4

function seed() {
  return Array.from({ length: CELLS }, () =>
    Math.floor(Math.random() * SEED_PITCHES)
  );
}

// About one seed in 5000 has no two same-pitch tiles adjacent anywhere, which
// would open the board already finished and read as a bug rather than a rule.
// Reseeding is the only interference: the run-over check below is meant to end
// a run, not to greet one.
function newBoard() {
  let board = seed();
  while (!hasMove(board)) board = seed();
  return board;
}

// Orthogonal adjacency only — no diagonals, anywhere in this file.
function neighbours(i) {
  const row = Math.floor(i / GRID);
  const col = i % GRID;
  const out = [];
  if (row > 0) out.push(i - GRID);
  if (row < GRID - 1) out.push(i + GRID);
  if (col > 0) out.push(i - 1);
  if (col < GRID - 1) out.push(i + 1);
  return out;
}

// The connected same-pitch group containing `start`, tapped cell included.
// Returns just [start] for a lone tile, which is how an invalid tap is
// detected: a group of one has nothing to merge with.
function connectedGroup(board, start) {
  const pitch = board[start];
  if (pitch == null) return [];

  const seen = new Set([start]);
  const stack = [start];
  const group = [];

  while (stack.length) {
    const i = stack.pop();
    group.push(i);
    for (const n of neighbours(i)) {
      if (!seen.has(n) && board[n] === pitch) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return group;
}

// The run ends when no cell anywhere has a same-pitch orthogonal neighbour.
// Checking pairs is enough — any group of two or more contains such a pair.
function hasMove(board) {
  return board.some(
    (pitch, i) => pitch != null && neighbours(i).some((n) => board[n] === pitch)
  );
}

export default function Vanish() {
  const [board, setBoard] = useState(newBoard);

  // The move stack: each entry is the whole board as it stood before a tap.
  // Boards are 25 small values and a run is a handful of moves, so storing
  // them whole is cheaper than replaying deltas and cannot desync. Depth is
  // unlimited within a run; "New board" clears it.
  //
  // This is a game-move stack, nothing to do with Alfred's 5-second archive
  // undo — no timer, no toast, no expiry.
  const [history, setHistory] = useState([]);

  // merges === history.length by construction: a merge pushes exactly one
  // entry and an undo pops exactly one. Deriving it stops the two drifting.
  const merges = history.length;

  // Read off the board rather than tracked separately. A merge removes tiles
  // of pitch p and adds one of p + 1, so playing forward this only ever rises,
  // and it counts the seed too. Undo rewinds it, which is the point: taking a
  // merge back should take back the pitch it earned.
  const highest = Math.max(...board.filter((p) => p != null));

  const over = !hasMove(board);

  function tap(i) {
    if (over) return;

    const group = connectedGroup(board, i);
    // An invalid tap does nothing at all — no error, no flash, no sound.
    if (group.length < 2) return;

    const merged = board[i] + 1;
    const next = board.slice();
    for (const cell of group) next[cell] = null; // holes are permanent
    next[i] = merged; // the tapped tile is the one that survives and climbs

    setHistory((h) => [...h, board]);
    setBoard(next);
  }

  // Undo stays live after the board is finished, so a dead end can be backed
  // out of rather than only restarted.
  function undo() {
    if (history.length === 0) return;
    setBoard(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
  }

  function reset() {
    setBoard(newBoard());
    setHistory([]);
  }

  const boardWidth = TILE * GRID + GAP * (GRID - 1);

  return (
    <div>
      <div
        className="grid mx-auto"
        style={{
          // Capped at 100% so the board scales down rather than overflowing a
          // narrow phone; see the readability sweep.
          width: `min(${boardWidth}px, 100%)`,
          gridTemplateColumns: `repeat(${GRID}, 1fr)`,
          gap: `${GAP}px`,
        }}
      >
        {board.map((pitch, i) => (
          <button
            key={i}
            type="button"
            onClick={() => tap(i)}
            disabled={pitch == null || over}
            className="aspect-square p-0 bg-transparent border-0 disabled:opacity-100"
            aria-label={pitch == null ? "empty" : `note ${pitch}`}
          >
            <NoteTile pitch={pitch} size={TILE} />
          </button>
        ))}
      </div>

      {/* Permanently visible, disabled rather than hidden, so the depth of the
          stack is never a surprise. */}
      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={undo}
          disabled={history.length === 0}
          className="px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-40"
        >
          Undo
        </button>
      </div>

      {over && (
        <div className="mt-6 mx-auto max-w-xs p-4 bg-card border border-border rounded-lg text-center">
          <p className="text-sm font-medium text-foreground">
            Board finished — no valid group left.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Highest pitch reached: {highest}
          </p>
          <p className="text-sm text-muted-foreground">Merges: {merges}</p>
          <button
            type="button"
            onClick={reset}
            className="mt-4 px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm"
          >
            New board
          </button>
        </div>
      )}
    </div>
  );
}
