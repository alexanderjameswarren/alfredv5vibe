import React, { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import NoteTile, { TILE, GRID, GAP } from "../noteTile";
import { readSave, writeSave, clearSave } from "../gameStorage";

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
// for an empty cell. The run is saved to localStorage under a per-variant key,
// so navigating away and back resumes exactly where you left off; nothing
// leaves the device.

const CELLS = GRID * GRID;

// --- tuning knobs ----------------------------------------------------------
// Inclusive range of pitch indices a fresh cell can be seeded with.
const SEED_RANGE = [0, 6];
// Two horizontally adjacent cells are linked when their pitches differ by at
// most this.
const STEP_TOLERANCE = 1;
// How many steps the tapped tile rises. Flat: chain length buys reach and
// board space, never a bigger promotion.
const PROMOTION_STEPS = 1;
// Reroll budget per board. null means unlimited — shuffle is no longer a
// strategic resource, only the way out of a stuck board.
const SHUFFLE_LIMIT = null;
// How many rearrangements to try before concluding that none is playable.
const SHUFFLE_TRIES = 200;
// How many moves can be taken back. Enforced everywhere, not just on save, so
// undo depth is identical in-session and after navigating away and back.
const UNDO_DEPTH = 5;
// ---------------------------------------------------------------------------

// --- row banding -----------------------------------------------------------
// Flip this to compare treatments.
const BAND_STYLE = "tinted"; // 'tinted' | 'bordered' | 'paired'

// Banding is texture, not information: row position carries no matching signal,
// so tinting by row cannot help anyone match without reading the staff — which
// is why the tiles themselves stay black and white. Every treatment below stays
// well under the contrast of the staff lines, let alone the noteheads.
//
// Colours come only from Alfred's tokens: --accent and --secondary are the warm
// surfaces, --success-light is the cool one Alfred already pairs against them,
// --border is the hairline, --card the raised surface. Nothing is invented.
//
// Written as explicit color-mix rather than Tailwind's `bg-accent/45`, because
// this palette is bare `var(--x)` values with no `<alpha-value>` placeholder.
// Tailwind 3 cannot inject alpha into those, so slash-opacity utilities compile
// to nothing at all and the band would simply not appear.
const tint = (token, percent) =>
  `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;

// Each treatment says what fills a row, what outlines it, how round the ends
// are, and how much vertical padding it wants.
//
// `border` is declared separately because the row hands its padding back as a
// negative margin to keep the tiles at full width — the margin has to absorb
// the border too, or a bordered treatment would quietly cost the board 2px.
//
// `padY` varies so a treatment can choose flush bands or separated ones. The
// row gap is whatever is left over, which keeps tile-to-tile spacing at exactly
// GAP in every treatment.
const BAND_TREATMENTS = {
  // Alternating intensity of one hue: neutral against a firmer accent tint.
  tinted: {
    border: 0,
    outline: null,
    radius: "var(--radius)",
    padY: GAP / 2,
    fill: (row) => (row % 2 === 1 ? tint("--accent", 45) : "transparent"),
  },
  // Each row a defined band: consistent hairline, rounded ends, fill alternates.
  // Slightly less padding, so the leftover gap separates the bands.
  //
  // The radius is 12px rather than a full stadium. The band only reaches
  // GAP/2 + 1px past the tiles, and a corner arc that big would cut inside the
  // first and last tile's top corner and leave them visibly poking out of their
  // own band. 12px is just under the largest radius that keeps every tile
  // enclosed — a true stadium would need ~35px of horizontal overhang, which
  // does not fit a 390px phone.
  bordered: {
    border: 1,
    outline: "var(--border)",
    radius: "12px",
    padY: GAP / 4,
    fill: (row) => (row % 2 === 1 ? tint("--accent", 30) : "var(--card)"),
  },
  // Warm against cool, both held low: Alfred's accent against its success-light.
  paired: {
    border: 0,
    outline: null,
    radius: "var(--radius)",
    padY: GAP / 2,
    fill: (row) =>
      row % 2 === 1 ? tint("--success-light", 38) : tint("--accent", 26),
  },
};

// How long a fallen tile takes to slide into place. This is a fidget game —
// by the hundredth tap anything slower reads as lag, so it stays well under
// the 200ms ceiling and never blocks input: the board state is already final
// when the animation starts, so tapping straight through it is safe.
const DROP_MS = 140;

// One fresh pitch from SEED_RANGE, inclusive at both ends. Shared by the
// initial seed and by refill so the range is read in exactly one place.
function spawnPitch() {
  const [lo, hi] = SEED_RANGE;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function seed() {
  return Array.from({ length: CELLS }, () => spawnPitch());
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

// Does this chain account for every occupied cell in its row? Judged on the
// board as it stood BEFORE anything was cleared. A chain that does is what arms
// the surviving tile.
//
// A chain cannot cross an empty cell, so a row with a gap between two occupied
// cells can never satisfy this: the chain stops at the gap and leaves the far
// side standing. Leading and trailing empties are not gaps — a row holding
// three tiles in its last three columns can cover its row, which is what makes
// the sparse upper rows worth clearing at all.
function coversRow(board, chain) {
  const rowStart = Math.floor(chain[0] / GRID) * GRID;
  let occupied = 0;
  for (let col = 0; col < GRID; col++) {
    if (board[rowStart + col] != null) occupied += 1;
  }
  return chain.length === occupied;
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

// How far each tile fell in a gravity pass, in rows, indexed by its cell in the
// settled board. Zero for a tile that did not move and for empty cells.
//
// No tile identity is needed to work this out. applyGravity preserves order
// within a column, so the k-th survivor counting down the column before the
// pass is the k-th counting down after it — pairing them off gives the distance
// directly.
function fallDistances(preGravity, postGravity) {
  const fall = new Array(CELLS).fill(0);

  for (let col = 0; col < GRID; col++) {
    const from = [];
    const to = [];
    for (let row = 0; row < GRID; row++) {
      if (preGravity[row * GRID + col] != null) from.push(row);
      if (postGravity[row * GRID + col] != null) to.push(row);
    }
    for (let k = 0; k < to.length; k++) {
      fall[to[k] * GRID + col] = to[k] - from[k];
    }
  }
  return fall;
}

const NO_FALL = Object.freeze(new Array(CELLS).fill(0));

// Where the tile at `index` in a pre-gravity board comes to rest. Its column
// never changes and gravity packs downward, so its settled row is fixed by how
// many tiles remain beneath it.
//
// For an arming tap this provably returns `index` unchanged — the chain lies in
// one row, so nothing below the survivor was removed and it has nowhere to
// fall; the tiles that move are the ones dropping in around it from above. It
// is computed properly anyway, so a future change to how chains are shaped
// cannot silently strand the arm on the wrong cell.
function settledIndexOf(preGravity, index) {
  const col = index % GRID;
  let below = 0;
  for (let row = Math.floor(index / GRID) + 1; row < GRID; row++) {
    if (preGravity[row * GRID + col] != null) below += 1;
  }
  return (GRID - 1 - below) * GRID + col;
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

// A shuffle that leaves you with no move is not a move, so it is never handed
// back. Rearrange and re-test until the board is playable, giving up after
// SHUFFLE_TRIES attempts and returning null — which the caller reads as true
// game over.
//
// The search is random rather than constructive, per spec. That makes
// exhaustion strong evidence rather than proof: see the note in the progress
// file on how often a playable arrangement exists but goes unfound.
function playableShuffle(board) {
  for (let attempt = 0; attempt < SHUFFLE_TRIES; attempt++) {
    const candidate = shuffleBoard(board);
    if (hasMove(candidate)) return candidate;
  }
  return null;
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

// A board is cleared when no column holds more than one tile — equivalently,
// since gravity keeps every column packed to the bottom, when every surviving
// tile is resting on the bottom row. Zero tiles satisfies it and is the best
// finish available.
//
// Counting per column rather than checking "everything is on row 4" states the
// rule as the spec does and does not lean on the packing invariant to be true.
//
// Note this can fire on a board that still has chains on it: a full bottom row
// of five linked tiles is cleared. That is the intent — you have drained the
// board down to a single layer, and Refill builds the next board on top of
// those survivors.
function isCleared(board) {
  for (let col = 0; col < GRID; col++) {
    let count = 0;
    for (let row = 0; row < GRID; row++) {
      if (board[row * GRID + col] != null) count += 1;
      if (count > 1) return false;
    }
  }
  return true;
}

// Why a finished board finished. Ordered most absolute cause first, because
// the three overlap otherwise:
//
//   no adjacent pairs remain — the survivors are scattered so far apart that
//     no two occupied cells touch in a row. No arrangement of them helps.
//   pitches too far apart    — cells do touch, but no two pitches anywhere on
//     the board are within STEP_TOLERANCE of each other, so no rearrangement
//     could ever link a pair. Terminal whatever you do.
//   no playable arrangement found — neither of the above holds, so an
//     arrangement offering a move does provably exist, and the random search
//     in playableShuffle failed to land on it within SHUFFLE_TRIES. Rare, and
//     the only one of the three that is a limit of the search rather than a
//     property of the board.
//
// "Out of shuffles" is gone with the budget: the run no longer ends by running
// down a resource.
//
// The middle case is judged against the whole multiset, not against the pairs
// currently adjacent. Judging it on current adjacency alone would name it for
// every dead board and swallow the third case entirely. Together the first two
// are exactly the condition "no arrangement can help": a move needs some
// adjacent pair of occupied cells AND some two pitches close enough to sit in
// it, and pitches can be permuted freely among the occupied cells.
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

  return "no playable arrangement found";
}

const filled = (board) => board.reduce((n, p) => (p == null ? n : n + 1), 0);

// Push a move, dropping the oldest once the stack is full.
const pushMove = (history, entry) => [...history, entry].slice(-UNDO_DEPTH);

// --- persistence -----------------------------------------------------------
//
// This variant's save key. Per variant, so a future variant's save can never be
// mistaken for this one's.
const VARIANT_ID = "drop";

// A saved board comes from an arbitrary past build and cannot be trusted. The
// checks below are what stands between a corrupted save and a board that
// renders wrong, so they are deliberately total: a save either passes every one
// or is thrown away whole.
//
// Well above anything reachable — flat promotion tops out around 9 on a 5x5
// board — but low enough to catch a number that has been mangled rather than
// merely grown.
const MAX_SANE_PITCH = 20;

const isCount = (v) => Number.isInteger(v) && v >= 0;
const isPitch = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_SANE_PITCH;

function isSaneBoard(b) {
  if (!Array.isArray(b) || b.length !== CELLS) return false;
  if (!b.every((v) => v === null || isPitch(v))) return false;

  // Gravity's invariant: no tile may sit above an empty cell in its column. A
  // save that breaks it would render a board this game could never produce.
  for (let col = 0; col < GRID; col++) {
    let seenEmpty = false;
    for (let row = GRID - 1; row >= 0; row--) {
      if (b[row * GRID + col] === null) seenEmpty = true;
      else if (seenEmpty) return false;
    }
  }
  return true;
}

// An arm must point at a real cell of its own board that actually holds a tile.
const isSaneArm = (v, board) =>
  v === null || (Number.isInteger(v) && v >= 0 && v < CELLS && board[v] !== null);

function isSaneEntry(e) {
  return (
    e !== null &&
    typeof e === "object" &&
    (e.kind === "tap" || e.kind === "destroy" || e.kind === "shuffle") &&
    isSaneBoard(e.board) &&
    isSaneArm(e.armedBefore, e.board) &&
    isCount(e.tapsBefore) &&
    isCount(e.largestChainBefore) &&
    (e.kind !== "tap" || isCount(e.chainLength))
  );
}

function isSaneSave(s) {
  return (
    s !== null &&
    typeof s === "object" &&
    isSaneBoard(s.board) &&
    isSaneArm(s.armed, s.board) &&
    typeof s.searchExhausted === "boolean" &&
    isCount(s.bankedClears) &&
    isCount(s.taps) &&
    isCount(s.largestChain) &&
    Array.isArray(s.history) &&
    s.history.length <= UNDO_DEPTH &&
    s.history.every(isSaneEntry)
  );
}

// A restored run, or a fresh one if there is nothing usable saved.
function initialRun() {
  return (
    readSave(VARIANT_ID, isSaneSave) || {
      board: newBoard(),
      history: [],
      armed: null,
      taps: 0,
      largestChain: 0,
      bankedClears: 0,
      searchExhausted: false,
    }
  );
}

// The game-over modal. Board cleared is deliberately NOT a modal — clearing a
// board is the good outcome and interrupting it every time would wear out fast,
// so that one is an inline Refill button instead. Only the end of a session
// stops the player.
//
// Follows the modal pattern already used across Alfred and SAM (see
// sam/components/FamilySheet.jsx): full-viewport backdrop, tap outside to
// dismiss, Escape to dismiss, a bg-card panel with role="dialog". Position is
// fixed, so opening and closing cannot move the board underneath.
//
// Copy is flat on purpose. A fidget game gets played hundreds of times and
// anything congratulatory would wear out inside a day.
function ResultModal({
  title,
  detail,
  figures,
  primaryLabel,
  onPrimary,
  onDismiss,
  returnFocusTo,
}) {
  const panelRef = useRef(null);

  // Handlers live in refs so the effect can run exactly once per open. With
  // them in the dependency list a parent re-render would re-run it, stealing
  // focus back to the panel and firing the focus-return cleanup mid-life.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const returnRef = useRef(returnFocusTo);
  returnRef.current = returnFocusTo;

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement;
    panel.focus();

    function onKey(e) {
      if (e.key === "Escape") {
        dismissRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      // Focus trap: Tab off either end wraps to the other.
      const focusable = panel.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const target = returnRef.current?.current || previouslyFocused;
      if (target && typeof target.focus === "function") target.focus();
    };
  }, []);

  return (
    <div
      onClick={onDismiss}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-card border border-border rounded-xl shadow-lg w-full max-w-sm"
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            {detail && (
              <p className="text-xs text-muted-foreground mt-1">{detail}</p>
            )}
          </div>
          {/* Dismiss only — it closes the modal without acting, leaving the
              finished board visible and still refusing taps. */}
          <button
            type="button"
            onClick={onDismiss}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground rounded shrink-0"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4">
          <dl className="space-y-1">
            {figures.map(({ label, value }) => (
              <div key={label} className="flex justify-between gap-3 text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="p-4 border-t border-border">
          <button
            type="button"
            onClick={onPrimary}
            className="w-full px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm"
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Drop() {
  // Read once, lazily, on mount. A restored run and a fresh one have exactly
  // the same shape, so nothing downstream knows which it got.
  const [restored] = useState(initialRun);

  const [board, setBoard] = useState(restored.board);

  // The move stack. Each entry is { kind, board }: the whole board as it stood
  // before a tap — before promotion, before clearing, before gravity — or
  // before a shuffle, so one undo restores the exact prior position rather than
  // an un-fallen or re-rolled approximation of it. `kind` is what lets undo
  // tell a reroll from a move. Depth is unlimited within a run; "New board"
  // clears it. A game-move stack, nothing to do with Alfred's 5-second archive
  // undo.
  const [history, setHistory] = useState(restored.history);

  // Boards banked by a refill. Kept as real state rather than derived, because
  // refill clears the move stack and there would be nothing left to derive them
  // from. Session-scoped: "New board" resets it.
  const [bankedClears, setBankedClears] = useState(restored.bankedClears);

  // Set only when playableShuffle exhausts SHUFFLE_TRIES on this exact board.
  // It cannot be derived — it is the outcome of a random search, not a property
  // of the position — so it is cleared by hand anywhere the board changes
  // underneath it: undo, refill and reset. A tap cannot stale it, because a
  // board with no chains has no valid tap to make.
  const [searchExhausted, setSearchExhausted] = useState(restored.searchExhausted);

  // How far each tile fell on the move that produced the current board, purely
  // so the drop can be seen. Presentation only — nothing reads it but the
  // render. Reset to zeros by every board change that is not a gravity pass, so
  // undo, shuffle and refill land without a phantom fall.
  const [fall, setFall] = useState(NO_FALL);

  // The modal opens when true game over is live and has not been dismissed.
  // Dismissal is cleared by every action that leaves that state — undo, refill,
  // reset — so re-entering it counts as a fresh firing and opens again. Nothing
  // else reopens it.
  const [resultDismissed, setResultDismissed] = useState(false);

  // The one armed cell, or null. Armed is a property of a specific tile, not of
  // a row: it survives the gravity pass that created it and the tiles that fall
  // in around it. Only ever one at a time.
  const [armed, setArmed] = useState(restored.armed);

  // Real state, not derived from the stack. They used to be counted off the
  // history, which only worked while it held the whole run — capped at
  // UNDO_DEPTH it would report the last five moves and call it the total. Each
  // stack entry carries the pair as they stood before that move, so undo still
  // rewinds them exactly, and entries that fall off the bottom are ones we can
  // no longer undo past anyway.
  const [taps, setTaps] = useState(restored.taps);
  const [largestChain, setLargestChain] = useState(restored.largestChain);

  // Save on any change to the run, rather than from inside each of tap,
  // destroy, shuffle, refill and undo. One place cannot fall out of step with
  // the mutators, and a future move type is persisted without anyone
  // remembering to add a call.
  //
  // `cleared` is deliberately absent: it is `isCleared(board)`, so the restored
  // board reproduces it. Saving it too would create a second source of truth
  // that could come back disagreeing with the board it describes.
  useEffect(() => {
    writeSave(VARIANT_ID, {
      board,
      history,
      armed,
      taps,
      largestChain,
      bankedClears,
      searchExhausted,
    });
  }, [board, history, armed, taps, largestChain, bankedClears, searchExhausted]);

  // Where focus lands when the modal closes.
  const boardRef = useRef(null);


  // Undoing a shuffle pops its entry, which refunds it for free. With
  // SHUFFLE_LIMIT null there is nothing to refund, but the budget path is kept
  // wired so reinstating one is a single-constant change.
  const shufflesUsed = history.filter((e) => e.kind === "shuffle").length;
  const shufflesLeft =
    SHUFFLE_LIMIT == null ? Infinity : SHUFFLE_LIMIT - shufflesUsed;

  const remaining = filled(board);

  // Recomputed from `board` on every render, so a tap, a shuffle, an undo and
  // a new board all refresh it without anyone having to remember to.
  const chains = availableChains(board);

  // The count reaching zero IS the dead-board check — not a parallel one.
  const boardDead = chains.length === 0;

  // Checked after gravity has resolved, which is guaranteed because `board` is
  // only ever set to the output of applyGravity (or to a seed, or to a board
  // pulled back off the move stack, both of which are already settled).
  const cleared = isCleared(board);

  // Clearing beats dying. A cleared board can also be a dead one — five
  // survivors on the bottom row with no linked pair among them is both — and in
  // that case it is a win, not a game over, so the summary stays away.
  // The run ends when the search says no arrangement can save this board — not
  // when a resource runs out. Clearing still beats dying.
  const over = !cleared && searchExhausted;

  // Shuffle is not a strategic resource any more: it exists only to unstick a
  // dead board, so it is offered exactly when there is nothing else to do.
  const canShuffle = boardDead && !cleared && !over && shufflesLeft > 0;

  // Banked at refill time (Step 3), so it survives the undo history being
  // cleared. The board currently on screen counts as soon as it is cleared and
  // stops counting if you undo back out of it — which is what stops the counter
  // being farmed by clearing and undoing on the spot.
  const boardsCleared = bankedClears + (cleared ? 1 : 0);

  // Either terminal state. Both refuse taps; only their own action moves on.
  // They are handled quite differently though — `cleared` puts a Refill button
  // in the button row, `over` raises the modal.
  const terminal = cleared || over;

  function tap(i) {
    // Both terminal states refuse taps, including a cleared board waiting on
    // Refill — the board is finished either way.
    if (terminal) return;

    // Tapping the armed tile destroys it, whatever else is true of that tile.
    // This is checked before chains, so an armed tile that has since gained a
    // neighbour still destroys rather than chaining.
    if (armed === i) {
      // Named `next` rather than `cleared` so it cannot shadow the
      // cleared-board flag above — the early return reads it, and a shadowing
      // const here would put that read in the temporal dead zone.
      const next = board.slice();
      next[i] = null; // no promotion, the tile simply goes

      const settled = applyGravity(next);
      setHistory((h) =>
        pushMove(h, {
          kind: "destroy",
          board,
          armedBefore: armed,
          tapsBefore: taps,
          largestChainBefore: largestChain,
        })
      );
      setTaps((n) => n + 1);
      setFall(fallDistances(next, settled));
      setArmed(null);
      setBoard(settled);
      return;
    }

    const chain = rowChain(board, i);
    // An invalid tap does nothing at all — no error, no flash, no sound, and
    // deliberately no disarm either.
    if (chain.length < 2) return;

    // Judged before anything is cleared: this is what arms the survivor.
    const arms = coversRow(board, chain);

    const next = board.slice();
    for (const cell of chain) next[cell] = null;
    next[i] = board[i] + PROMOTION_STEPS; // flat, whatever the chain length

    const settled = applyGravity(next);
    setHistory((h) =>
      pushMove(h, {
        kind: "tap",
        board,
        chainLength: chain.length,
        armedBefore: armed,
        tapsBefore: taps,
        largestChainBefore: largestChain,
      })
    );
    setTaps((n) => n + 1);
    setLargestChain((m) => Math.max(m, chain.length));
    setFall(fallDistances(next, settled));
    // Any valid chain tap clears the standing arm before resolving; this tap
    // may then arm its own survivor.
    setArmed(arms ? settledIndexOf(next, i) : null);
    setBoard(settled);
  }

  // Occupancy is unchanged, so no gravity pass follows this.
  function shuffle() {
    if (!canShuffle) return;

    const next = playableShuffle(board);
    if (next === null) {
      // Nothing found in SHUFFLE_TRIES: true game over. The board is left
      // exactly as it stands — the failed search is not a move, so it does not
      // go on the stack and there is nothing to undo.
      setSearchExhausted(true);
      return;
    }

    setHistory((h) =>
      pushMove(h, {
        kind: "shuffle",
        board,
        armedBefore: armed,
        tapsBefore: taps,
        largestChainBefore: largestChain,
      })
    );
    setFall(NO_FALL);
    setArmed(null);
    setBoard(next);
  }

  // Undo stays live after the board is finished, so a dead end can be backed
  // out of rather than only restarted.
  function undo() {
    if (history.length === 0) return;
    const entry = history[history.length - 1];
    setBoard(entry.board);
    setHistory((h) => h.slice(0, -1));
    // Every entry carries the arm as it stood before that action, so undoing a
    // destroy restores the tile still armed, and undoing anything else puts
    // back whatever arm it cleared.
    setArmed(entry.armedBefore);
    setTaps(entry.tapsBefore);
    setLargestChain(entry.largestChainBefore);
    setFall(NO_FALL);
    setResultDismissed(false);
    setSearchExhausted(false); // different board, so the old verdict is void
  }

  // Survivors stay exactly where they are, at their current pitches — this is
  // the whole session arc, since the tiles that carry forward are the high ones
  // you worked up to. Every empty cell takes a fresh spawn, which leaves the
  // board full and therefore already settled: no gravity pass, because there is
  // nothing left for anything to fall into.
  //
  // The clear is banked here rather than at detection because this is the point
  // of no return. Once the move stack is cleared there is no history left to
  // derive earlier clears from, so it has to become real state now.
  function refill() {
    if (!cleared) return;
    setBoard(board.map((pitch) => (pitch == null ? spawnPitch() : pitch)));
    setBankedClears((n) => n + 1);
    setHistory([]); // no undoing back across a refill
    setTaps(0);
    setLargestChain(0);
    setArmed(null);
    setFall(NO_FALL);
    setResultDismissed(false);
    setSearchExhausted(false);
  }

  function reset() {
    setBoard(newBoard());
    setHistory([]);
    setBankedClears(0);
    setTaps(0);
    setLargestChain(0);
    setArmed(null);
    // Drop the save before the effect writes the fresh run. If that write then
    // fails — storage full or disabled — we are left with nothing rather than
    // with the finished run, which is what you would otherwise come back to.
    clearSave(VARIANT_ID);
    setFall(NO_FALL);
    setResultDismissed(false);
    setSearchExhausted(false);
  }

  const boardWidth = TILE * GRID + GAP * (GRID - 1);
  const band = BAND_TREATMENTS[BAND_STYLE];

  return (
    <div>
      {/* Kept local to this file rather than added to index.css: round 2 lands
          in drop.jsx and the Games tab, and nothing else needs these rules.

          The tile is already in its final cell when the animation starts — the
          board state is settled and only the paint is catching up — so taps
          during the drop hit the right tile and nothing is queued or blocked.
          Reduced-motion turns it off outright; the position is correct either
          way, only the travel is lost. */}
      <style>{`
        @keyframes drop-fell {
          from { transform: translateY(var(--drop-from, 0)); }
          to   { transform: translateY(0); }
        }
        .drop-fell { animation: drop-fell ${DROP_MS}ms ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .drop-fell { animation: none; }
        }
      `}</style>

      {/* One element per row, so each band is a real box behind its own row
          rather than a stripe painted on the container that the opaque tiles
          would simply hide.

          Board geometry is frozen, so the bands must not cost the tiles any
          width. Each row takes half a gap of padding and gives it straight back
          as a negative horizontal margin: with border-box sizing the content
          box comes out exactly the container width, so the five columns and
          four gaps are unchanged to the pixel, while the tinted box reaches
          half a gap past each edge. Vertically the padding is kept, and the
          rows carry no gap between them — that puts a full gap between tiles,
          same as before, and leaves the bands meeting edge to edge. The board
          is one gap taller than it was; nothing else moves. */}
      <div
        ref={boardRef}
        tabIndex={-1}
        className="mx-auto"
        style={{
          width: `min(${boardWidth}px, 100%)`,
          display: "grid",
          rowGap: `${GAP - 2 * band.padY}px`,
        }}
      >
        {Array.from({ length: GRID }, (_, row) => (
          <div
            key={row}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${GRID}, 1fr)`,
              columnGap: `${GAP}px`,
              padding: `${band.padY}px ${GAP / 2}px`,
              marginLeft: `-${GAP / 2 + band.border}px`,
              marginRight: `-${GAP / 2 + band.border}px`,
              backgroundColor: band.fill(row),
              border: band.outline
                ? `${band.border}px solid ${band.outline}`
                : undefined,
              borderRadius: band.radius,
            }}
          >
            {Array.from({ length: GRID }, (_, col) => {
              const i = row * GRID + col;
              const pitch = board[i];
              return (
                <button
                  // Keyed by the move count so a tile that falls the same
                  // distance twice running still remounts and replays the
                  // animation. Without it the second drop would sit still,
                  // because nothing about the element would have changed.
                  key={`${col}-${history.length}`}
                  type="button"
                  onClick={() => tap(i)}
                  disabled={pitch == null || over || cleared}
                  className={`aspect-square p-0 bg-transparent border-0 disabled:opacity-100${
                    fall[i] > 0 ? " drop-fell" : ""
                  }`}
                  // The drop offset is expressed in the tile's own height, so
                  // it stays exact at any board scale: one row is 100% of the
                  // tile plus one gap.
                  //
                  // The armed ring is drawn as a box-shadow rather than a
                  // border, so it costs no layout and cannot nudge the board.
                  // --primary is Alfred's action colour; it says "this tile is
                  // the next thing you can act on", and since exactly one tile
                  // is ever armed and it moves every time, it cannot be read as
                  // encoding pitch. The staff and notehead are untouched.
                  style={{
                    ...(fall[i] > 0
                      ? {
                          "--drop-from": `calc(${-fall[i]} * (100% + ${GAP}px))`,
                        }
                      : null),
                    ...(armed === i
                      ? {
                          borderRadius: "var(--radius)",
                          boxShadow: "0 0 0 3px var(--primary)",
                        }
                      : null),
                  }}
                  aria-label={
                    pitch == null
                      ? "empty"
                      : `note ${pitch}${armed === i ? ", armed" : ""}`
                  }
                >
                  <NoteTile pitch={pitch} size={TILE} />
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* It reports, it does not point: no icon, no colour, and nothing on the
          board is highlighted to match. */}
      <p className="mt-4 text-sm text-muted-foreground text-center">
        {chains.length === 0
          ? "No chains available"
          : `${chains.length} chain${chains.length === 1 ? "" : "s"} available`}
      </p>

      {/* Each button is present only when it does something. The row keeps a
          fixed height regardless, so nothing on the page moves as they come and
          go — h-11 is the buttons' own 44px min-height, so an empty row is
          exactly as tall as a full one. */}
      <div className="mt-4 flex items-center justify-center gap-2 h-11">
        {history.length > 0 && (
          <button
            type="button"
            onClick={undo}
            className="px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground"
          >
            Undo
          </button>
        )}
        {/* Filled in --primary, the same brown as Alfred's Start Now and Add
            Intention buttons, and the same treatment the modal's Refill and New
            board use here. Shuffle only ever appears when it is the one thing
            left to do, so it reads as the primary action. Alfred pairs this
            fill with a darkening hover state; that half is deliberately left
            off, since nothing here depends on hover. */}
        {canShuffle && (
          <button
            type="button"
            onClick={shuffle}
            className="px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm"
          >
            Shuffle
          </button>
        )}
        {/* Clearing a board is the good outcome, so it gets a button rather
            than an overlay. Same hide-when-irrelevant pattern as the other two,
            in the same fixed-height row, so nothing moves. Taps stay refused
            until it is pressed. */}
        {cleared && (
          <button
            type="button"
            onClick={refill}
            className="px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm"
          >
            Refill
          </button>
        )}
      </div>

      {/* Fixed height again, so the reopen control appearing cannot move the
          board or the row above it. */}
      <div className="mt-2 flex items-center justify-center h-11">
        {over && resultDismissed && (
          <button
            type="button"
            onClick={() => setResultDismissed(false)}
            className="px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground"
          >
            Show summary
          </button>
        )}
      </div>

      {/* True game over only. Dismissing touches no board state: the finished
          board stays exactly as it is and still refuses taps, and only New
          board acts. Boards cleared leads the figures — it is the score. */}
      {over && !resultDismissed && (
        <ResultModal
          title="Game over"
          detail={`${finishCause(board)}.`}
          figures={[
            { label: "Boards cleared this session", value: boardsCleared },
            { label: "Tiles remaining", value: remaining },
            { label: "Taps taken", value: taps },
            { label: "Largest chain cleared", value: largestChain },
          ]}
          primaryLabel="New board"
          onPrimary={reset}
          onDismiss={() => setResultDismissed(true)}
          returnFocusTo={boardRef}
        />
      )}
    </div>
  );
}
