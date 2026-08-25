import React, { useState } from "react";
import NoteTile, { TILE, GRID, GAP } from "../noteTile";

// Cascade — tap clears a drifting chain of near neighbours.
//
// Vanish's engine with one rule swapped: a chain is held together by *local*
// similarity, not by a single shared pitch. Each edge is judged against the
// two cells it joins, so the chain wanders away from what you tapped — a run
// of C D D E D C B is one chain. That makes reach unpredictable, which is the
// thing being tested.
//
// Board is a flat array of GRID * GRID cells; a cell is a pitch index or null
// for a hole. In-memory only — nothing persists between sessions.

const CELLS = GRID * GRID;

// --- tuning knobs ----------------------------------------------------------
// Inclusive range of pitch indices a fresh cell can be seeded with.
const SEED_RANGE = [0, 6];
// Two adjacent cells are linked when their pitches differ by at most this.
const STEP_TOLERANCE = 1;
// How many steps the tapped tile rises, given the length of the chain cleared.
const PROMOTION = (chainLength) => Math.max(1, Math.floor(chainLength / 2));
// ---------------------------------------------------------------------------

function seed() {
  const [lo, hi] = SEED_RANGE;
  const span = hi - lo + 1; // inclusive
  return Array.from(
    { length: CELLS },
    () => lo + Math.floor(Math.random() * span)
  );
}

// A seed with no linkable pair anywhere would open the board already finished
// and read as a bug rather than a rule. Reseeding is the only interference:
// the run-over check below is meant to end a run, not to greet one.
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

// Is the edge between two cells traversable? Both must be filled, and they are
// compared to EACH OTHER — never to the originally tapped pitch. That single
// detail is what lets the chain drift.
function linked(board, a, b) {
  return (
    board[a] != null &&
    board[b] != null &&
    Math.abs(board[a] - board[b]) <= STEP_TOLERANCE
  );
}

// The chain reachable from `start` across linked edges, tapped cell included.
// Returns just [start] when nothing links to it, which is how an invalid tap
// is detected: a chain of one has nothing to clear.
function connectedChain(board, start) {
  if (board[start] == null) return [];

  const seen = new Set([start]);
  const stack = [start];
  const chain = [];

  while (stack.length) {
    const i = stack.pop();
    chain.push(i);
    for (const n of neighbours(i)) {
      if (!seen.has(n) && linked(board, i, n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return chain;
}

// The run ends when no linked pair remains anywhere. Checking pairs is enough
// — any chain of two or more contains at least one linked edge.
function hasMove(board) {
  return board.some(
    (pitch, i) => pitch != null && neighbours(i).some((n) => linked(board, i, n))
  );
}

const filled = (board) => board.reduce((n, p) => (p == null ? n : n + 1), 0);

export default function Cascade() {
  const [board, setBoard] = useState(newBoard);

  // The move stack: each entry is the whole board as it stood before a tap.
  // Depth is unlimited within a run; "New board" clears it. A game-move stack,
  // nothing to do with Alfred's 5-second archive undo.
  const [history, setHistory] = useState([]);

  const merges = history.length;

  const highest = Math.max(...board.filter((p) => p != null));

  // Largest chain is read off the timeline rather than tracked separately: a
  // tap clears (chainLength - 1) tiles and leaves the promoted one, so the
  // drop in filled cells between two consecutive boards gives the chain that
  // caused it. Derived this way it rewinds with undo, like everything else.
  const timeline = [...history, board];
  let largestChain = 0;
  for (let i = 1; i < timeline.length; i++) {
    largestChain = Math.max(
      largestChain,
      filled(timeline[i - 1]) - filled(timeline[i]) + 1
    );
  }

  const over = !hasMove(board);

  function tap(i) {
    if (over) return;

    const chain = connectedChain(board, i);
    // An invalid tap does nothing at all — no error, no flash, no sound.
    if (chain.length < 2) return;

    const promoted = board[i] + PROMOTION(chain.length);
    const next = board.slice();
    for (const cell of chain) next[cell] = null; // holes stay put
    next[i] = promoted; // the tapped tile is the one that survives and climbs

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
            Board finished — no linked pair left.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Highest pitch reached: {highest}
          </p>
          <p className="text-sm text-muted-foreground">Merges: {merges}</p>
          <p className="text-sm text-muted-foreground">
            Largest chain cleared: {largestChain}
          </p>
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
