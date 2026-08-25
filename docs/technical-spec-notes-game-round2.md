# Notes game — round 2

## Overview

The Notes game is a variant harness inside Alfred's Games tab. The current playable
variant is Drop: horizontal-only chain matching on a draining 5x5 board with gravity
and no refill.

Round 2 turns Drop from a board that always grinds to a stop into a game with a real
win condition and a session-level arc. It also stops the shuffle button from wasting
the player's time, and adds the first cosmetic work.

The shared tile renderer and board geometry are unchanged and must not be forked.
Tile size stays 68px, grid stays 5x5, tiles stay black and white.

## Current state (assumed built)

- `src/games/noteTile.jsx` — shared tile renderer, staff geometry, ledger lines
- `src/games/variants.js` — variant registry
- `src/games/variants/vanish.jsx` — permanent holes, no gravity
- `src/games/variants/cascade.jsx` — omnidirectional drifting chains, no gravity
- `src/games/variants/rows.jsx` — horizontal chains, gravity plus refill, endless
- `src/games/variants/drop.jsx` — horizontal chains, gravity, no refill, shuffle
  budget, undo, live chain count, end-of-run cause classification

All round-2 work lands in `drop.jsx` and the Games tab. No new variant file.

## Rules after this round

Constants stay at the top of `drop.jsx` for tuning:

```
SEED_RANGE      = [0, 6]
STEP_TOLERANCE  = 1
PROMOTION       = (chainLength) => Math.max(1, Math.floor(chainLength / 2))
SHUFFLE_LIMIT   = null          // null means unlimited
SHUFFLE_TRIES   = 200
```

### Tap resolution

A tap is valid when the tile immediately left or right in the same row is within
`STEP_TOLERANCE`.

The chain is the maximal horizontal run through the tapped tile where every adjacent
pair differs by no more than `STEP_TOLERANCE`. Comparison is between neighbours, not
against the tapped pitch, so the chain drifts. It stops at a row edge or at the first
empty cell.

Then, in order:

1. **Row clear test.** If the chain contains every occupied cell in that row, the
   whole chain is removed — including the tapped tile. There is no promotion. This is
   the only way a promoted tile can die, and the only way the board can reach zero
   tiles. Note that because a chain cannot cross an empty cell, a row with a gap in it
   can never trigger a row clear.
2. **Otherwise.** The tapped tile rises by `PROMOTION(chainLength)`. Every other tile
   in the chain becomes empty.
3. **Gravity.** Within each column independently, every tile falls as far as it can.
   A cleared row leaves a hole in every column, so everything above drops by one row.
   After gravity, no tile may have an empty cell below it in its column.

### Board cleared

Checked after gravity resolves.

**A board is cleared when no column holds more than one tile.** Equivalently, every
remaining tile sits on the bottom row. Zero tiles counts as cleared and is the best
possible finish.

Reaching a cleared board does not require a row clear to have happened. A board that
grinds down to a single surviving tile also counts. This is rare and is accepted.

On a cleared board: increment the boards-cleared counter, stop accepting taps, and
show a **Refill** button.

### Refill

Bottom-row survivors stay exactly where they are, at their current pitches. Every
empty cell on the board takes a fresh spawn drawn from `SEED_RANGE`. The board is full
again and play resumes.

Undo history clears on refill. The boards-cleared counter persists for the session.

The seed range does not rise with boards cleared in this round. The long arc across
boards comes from surviving high tiles carrying forward, not from an escalating floor.

### Shuffle

Shuffle is **only available when zero chains exist**. It is hidden or disabled at all
other times. It is no longer a strategic resource.

Shuffle randomly reassigns the multiset of pitches currently on the board among the
currently occupied cells. Occupancy is untouched — same cells filled, same cells empty,
same column heights. Gravity does not run afterwards; the board is already settled.

**Shuffle must guarantee a playable board.** Reshuffle and re-test in a loop until at
least one chain exists, up to `SHUFFLE_TRIES` attempts.

If the loop exhausts without finding a playable arrangement, that is **true game over**
— no arrangement of the remaining pitches can produce a legal move. Show the summary
and disable further shuffling.

With `SHUFFLE_LIMIT` at null there is no budget. The end of a run is now determined by
true game over, not by running out of shuffles. Remove the shuffle-count display and
the "out of shuffles" end cause.

### End of run

Two terminal states, and they are different:

- **Board cleared** — the win. Refill button appears, session continues.
- **True game over** — no chains and no shuffle can fix it. Show highest pitch reached,
  taps taken, largest chain, tiles remaining, and boards cleared this session. Offer
  "New board", which resets everything including the boards-cleared counter.

## Cosmetics

### Alternating row bands

Subtle alternating background bands behind the five rows, to break up the monotony of
the grid. Use existing surface tokens; keep the contrast low enough that it reads as
texture rather than as information.

**Tiles themselves stay black and white.** Colour must never encode pitch — that is
what stops the player matching by colour without reading the staff. Row position
carries no matching information, so banding by row is safe.

### Drop feedback

After gravity runs, tiles that moved should be briefly distinguishable so the player
can see what fell and where it landed, rather than the board silently teleporting.

A short CSS transition on position is preferred. A brief colour or opacity delay on
moved tiles is an acceptable fallback. Keep it under about 200ms — this is a fidget
game and a slow animation will be infuriating by the hundredth tap.

## Games tab

The Games tab currently lists all variants flat. Reorganise:

- Current variant (Drop) at the top, always visible
- Earlier variants (Vanish, Cascade, Rows) inside a collapsed section labelled as
  earlier versions, expandable

The registry gains a field marking a variant as current or archived. Adding a variant
still means one entry and one file. Expect several more rounds of this, so the pattern
must stay cheap.

## Deferred — not built this round

**Smoosh.** Columns collapsing sideways when one empties, to prevent geometric
orphaning. Held back deliberately: the inability to reach across an empty column may
turn out to be part of the strategy rather than a defect. Revisit after playing with
row clears, which change the shape of the endgame considerably.

## Constraints

- No hover-dependent styling anywhere
- No timer during play
- No streaks, no encouragement copy, no toasts
- In-memory state only — no localStorage, no Supabase, no MCP tools, no migration
- Do not touch the platform layer
- Follow existing `Alfred.jsx` component and Tailwind patterns

## Success criteria

- A full-row chain clears the row and kills the promoted tile
- A cleared row drops everything above it by one row
- Boards can be cleared, and clearing one shows a working Refill button
- Refill preserves bottom-row survivors at their pitches
- Shuffle only appears when stuck, and always produces a playable board
- True game over fires when no arrangement can help, and only then
- Row bands read as texture, tiles stay black and white
- Falling tiles are visibly distinguishable from tiles that did not move
- Earlier variants are one tap away but out of the way
