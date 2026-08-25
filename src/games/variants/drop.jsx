import React, { useState } from "react";
import NoteTile, { TILE, GRID, GAP } from "../noteTile";

// Drop — horizontal chains only, survivors fall into the gaps.
//
// Cascade's drifting chain, cut down to one dimension and then compacted.
// Matching ignores vertical neighbours entirely, so you are reading rows; but
// gravity keeps rewriting which tiles share a row, so the board you cleared is
// never the board you get back. Holes still never refill — the board only ever
// shrinks — the question is whether packing the survivors downward keeps a run
// alive longer or just drags the ending out.
//
// Board is a flat array of GRID * GRID cells; a cell is a pitch index or null
// for an empty cell. In-memory only — nothing persists between sessions.

const CELLS = GRID * GRID;

// --- tuning knobs ----------------------------------------------------------
// Inclusive range of pitch indices a fresh cell can be seeded with.
const SEED_RANGE = [0, 6];
// Two horizontally adjacent cells are linked when their pitches differ by at
// most this.
const STEP_TOLERANCE = 1;
// How many steps the tapped tile rises, given the length of the chain cleared.
const PROMOTION = (chainLength) => Math.max(1, Math.floor(chainLength / 2));
// Rerolls available per board.
const SHUFFLES_PER_BOARD = 20;
// ---------------------------------------------------------------------------

function seed() {
  const [lo, hi] = SEED_RANGE;
  const span = hi - lo + 1; // inclusive
  return Array.from(
    { length: CELLS },
    () => lo + Math.floor(Math.random() * span)
  );
}

// A seed with no linked pair in any row would open the board already finished
// and read as a bug rather than a rule. Reseeding is the only interference:
// the run-over check below is meant to end a run, not to greet one.
function newBoard() {
  let board = seed();
  while (!hasMove(board)) board = seed();
  return board;
}

// Is the edge between two cells traversable? Both must be filled, and they are
// compared to EACH OTHER — never to the originally tapped pitch. That single
// detail is what lets the chain drift. Callers only ever pass row-neighbours;
// vertical adjacency plays no part in matching.
function linked(board, a, b) {
  return (
    board[a] != null &&
    board[b] != null &&
    Math.abs(board[a] - board[b]) <= STEP_TOLERANCE
  );
}

// The chain running left and right from `start` along its own row, tapped cell
// included. Each step is judged against the neighbour it just came from, so the
// chain drifts; it stops at the row edge, at an empty cell, or at the first gap
// wider than STEP_TOLERANCE. Returns just [start] when nothing links to it,
// which is how an invalid tap is detected.
function rowChain(board, start) {
  if (board[start] == null) return [];

  const rowStart = Math.floor(start / GRID) * GRID;
  const rowEnd = rowStart + GRID - 1;
  const chain = [start];

  for (let i = start; i > rowStart && linked(board, i, i - 1); i--) {
    chain.unshift(i - 1);
  }
  for (let i = start; i < rowEnd && linked(board, i, i + 1); i++) {
    chain.push(i + 1);
  }
  return chain;
}

// Every tile falls straight down within its own column, order preserved, until
// the column is a contiguous stack resting on the bottom row with all its empty
// cells above. Rebuilt from scratch rather than shuffled in place, so the
// invariant "no tile has an empty cell below it" holds by construction.
function applyGravity(board) {
  const next = Array(CELLS).fill(null);

  for (let col = 0; col < GRID; col++) {
    const stack = [];
    for (let row = 0; row < GRID; row++) {
      const pitch = board[row * GRID + col];
      if (pitch != null) stack.push(pitch);
    }
    let row = GRID - 1;
    for (let k = stack.length - 1; k >= 0; k--, row--) {
      next[row * GRID + col] = stack[k];
    }
  }
  return next;
}

// Reassign the pitches already on the board among the cells already occupied.
// Occupancy is deliberately untouched — the same cells stay filled, the same
// cells stay empty, and every column keeps its exact height. That is precisely
// why gravity must not run afterwards: the board is already settled, and a
// gravity pass would be a no-op at best. Nothing is added, removed, promoted
// or demoted; only the arrangement changes.
function shuffleBoard(board) {
  const cells = [];
  const pitches = [];
  board.forEach((pitch, i) => {
    if (pitch != null) {
      cells.push(i);
      pitches.push(pitch);
    }
  });

  for (let i = pitches.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pitches[i], pitches[j]] = [pitches[j], pitches[i]];
  }

  const next = board.slice();
  cells.forEach((cell, k) => {
    next[cell] = pitches[k];
  });
  return next;
}

// Every distinct move on the board, as the lengths of the maximal runs that
// make them. A run is maximal when it cannot be extended further left or right,
// so a run of four is ONE move of length four — not three overlapping pairs,
// and not four tiles you could tap. Tapping anywhere inside a run clears that
// same run; only the promotion lands on a different tile.
//
// This is the single source of truth for "is there a move". hasMove below is a
// thin predicate over it rather than a second scan, so the count on screen and
// the end-of-run check can never disagree.
function availableChains(board) {
  const runs = [];
  for (let row = 0; row < GRID; row++) {
    let length = 1;
    for (let col = 1; col < GRID; col++) {
      const i = row * GRID + col;
      if (linked(board, i - 1, i)) {
        length += 1;
      } else {
        if (length >= 2) runs.push(length);
        length = 1;
      }
    }
    if (length >= 2) runs.push(length);
  }
  return runs;
}

// The run ends when no row holds a horizontally adjacent linked pair.
function hasMove(board) {
  return availableChains(board).length > 0;
}

// Why a finished board finished. Ordered most absolute cause first, because
// the three overlap otherwise:
//
//   no adjacent pairs remain — the survivors are scattered so far apart that
//     no two occupied cells touch in a row. No arrangement of them helps.
//   pitches too far apart    — cells do touch, but no two pitches anywhere on
//     the board are within STEP_TOLERANCE of each other, so no rearrangement
//     could ever link a pair. Terminal whatever you do.
//   out of shuffles          — neither of the above: some arrangement of this
//     multiset in these cells would have offered a move. You simply had no
//     reroll left to look for it.
//
// The middle case is judged against the whole multiset, not against the pairs
// currently adjacent. Judging it on current adjacency alone would name it for
// every dead board and swallow the third case entirely.
function finishCause(board) {
  let touching = false;
  for (let row = 0; row < GRID && !touching; row++) {
    for (let col = 0; col < GRID - 1; col++) {
      const i = row * GRID + col;
      if (board[i] != null && board[i + 1] != null) {
        touching = true;
        break;
      }
    }
  }
  if (!touching) return "no adjacent pairs remain";

  const pitches = board.filter((p) => p != null).sort((a, b) => a - b);
  const anyClose = pitches.some(
    (p, i) => i > 0 && p - pitches[i - 1] <= STEP_TOLERANCE
  );
  if (!anyClose) return "pitches too far apart";

  return "out of shuffles";
}

const filled = (board) => board.reduce((n, p) => (p == null ? n : n + 1), 0);

export default function Drop() {
  const [board, setBoard] = useState(newBoard);

  // The move stack. Each entry is { kind, board }: the whole board as it stood
  // before a tap — before promotion, before clearing, before gravity — or
  // before a shuffle, so one undo restores the exact prior position rather than
  // an un-fallen or re-rolled approximation of it. `kind` is what lets undo
  // tell a reroll from a move. Depth is unlimited within a run; "New board"
  // clears it. A game-move stack, nothing to do with Alfred's 5-second archive
  // undo.
  const [history, setHistory] = useState([]);

  const taps = history.filter((e) => e.kind === "tap").length;
  const shufflesUsed = history.filter((e) => e.kind === "shuffle").length;

  // Derived, not stored. Undoing a shuffle pops its entry, which refunds it for
  // free — there is no counter that can drift out of step with the stack, and
  // therefore no way for undo to become an unlimited reroll.
  const shufflesLeft = SHUFFLES_PER_BOARD - shufflesUsed;

  const remaining = filled(board);
  const highest = Math.max(...board.filter((p) => p != null));

  // Largest chain is read off the timeline rather than tracked separately: a
  // tap clears (chainLength - 1) tiles and gravity moves tiles without adding
  // or removing any, so the drop in filled cells across that entry gives the
  // chain that caused it. Shuffle entries are skipped — they move no tiles in
  // or out, so their delta is zero and would report a phantom chain of 1.
  // Derived this way it rewinds with undo, like everything else here.
  let largestChain = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].kind !== "tap") continue;
    const after = i + 1 < history.length ? history[i + 1].board : board;
    largestChain = Math.max(
      largestChain,
      filled(history[i].board) - filled(after) + 1
    );
  }

  // Recomputed from `board` on every render, so a tap, a shuffle, an undo and
  // a new board all refresh it without anyone having to remember to.
  const chains = availableChains(board);
  const longestChain = chains.length > 0 ? Math.max(...chains) : 0;

  // The count reaching zero IS the dead-board check — not a parallel one.
  const boardDead = chains.length === 0;

  // A dead board with rerolls in hand is not a finished run — the shuffle is
  // still a move, so the summary stays away until it is spent.
  const over = boardDead && shufflesLeft === 0;

  function tap(i) {
    if (over) return;

    const chain = rowChain(board, i);
    // An invalid tap does nothing at all — no error, no flash, no sound.
    if (chain.length < 2) return;

    // Order matters: promote, then clear, then fall.
    const promoted = board[i] + PROMOTION(chain.length);
    const cleared = board.slice();
    for (const cell of chain) cleared[cell] = null;
    cleared[i] = promoted; // the tapped tile survives, and falls with the rest

    setHistory((h) => [...h, { kind: "tap", board }]);
    setBoard(applyGravity(cleared));
  }

  // Occupancy is unchanged, so no gravity pass follows this.
  function shuffle() {
    if (shufflesLeft === 0) return;
    setHistory((h) => [...h, { kind: "shuffle", board }]);
    setBoard(shuffleBoard(board));
  }

  // Undo stays live after the board is finished, so a dead end can be backed
  // out of rather than only restarted.
  function undo() {
    if (history.length === 0) return;
    setBoard(history[history.length - 1].board);
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

      {/* It reports, it does not point: no icon, no colour, and nothing on the
          board is highlighted to match. */}
      <p className="mt-4 text-sm text-muted-foreground text-center">
        {chains.length === 0
          ? "No chains available"
          : `${chains.length} chain${chains.length === 1 ? "" : "s"} available · longest ${longestChain}`}
      </p>

      {/* Both permanently visible, disabled rather than hidden, so what is
          left is never a surprise. */}
      <div className="mt-4 flex justify-center gap-2">
        <button
          type="button"
          onClick={undo}
          disabled={history.length === 0}
          className="px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={shuffle}
          disabled={shufflesLeft === 0 || over}
          className="px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-40"
        >
          Shuffle ({shufflesLeft})
        </button>
      </div>

      {over && (
        <div className="mt-6 mx-auto max-w-xs p-4 bg-card border border-border rounded-lg text-center">
          <p className="text-sm font-medium text-foreground">
            Board finished — {finishCause(board)}.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Highest pitch reached: {highest}
          </p>
          <p className="text-sm text-muted-foreground">Taps: {taps}</p>
          <p className="text-sm text-muted-foreground">
            Largest chain cleared: {largestChain}
          </p>
          <p className="text-sm text-muted-foreground">
            Tiles remaining: {remaining}
          </p>
          <p className="text-sm text-muted-foreground">
            Shuffles used: {shufflesUsed}
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
