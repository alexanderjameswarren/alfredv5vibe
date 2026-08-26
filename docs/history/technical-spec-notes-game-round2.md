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
PROMOTION_STEPS = 1             // flat, regardless of chain length
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

1. Every tile in the chain except the tapped tile becomes empty.
2. The tapped tile rises by `PROMOTION_STEPS` — flat, whatever the chain length. Chain
   length buys reach and board space, never a bigger promotion.
3. **Gravity.** Within each column independently, every tile falls as far as it can.
   After gravity, no tile may have an empty cell below it in its column.
4. **Arm test.** If the chain covered every occupied cell in its row *before* step 1,
   the promoted tile becomes **armed**. Otherwise nothing is armed. Because a chain
   cannot cross an empty cell, a row with a gap in it can never arm anything.

### Arm and destroy

Arming is a property of a specific tile, not of a row. It persists through the gravity
pass that created it: the armed tile keeps its state while other tiles fall in around
it. In practice the armed tile does not move at all — the chain lay in one row, so
nothing beneath the survivor was removed and it has nowhere to fall.

Only one tile can be armed at a time.

- **Destroy.** Tapping an armed tile destroys it. The cell empties, gravity runs,
  nothing promotes. This is the only way a promoted tile can die, and the only way the
  board can reach zero tiles. It is checked before chains, so an armed tile that has
  since gained a neighbour still destroys rather than chaining.
- **Disarm.** Any valid chain tap elsewhere clears the arm before resolving. Shuffle
  clears it. Refill and New board clear it. A tap on a tile with no chain does nothing
  and does **not** disarm.
- **Chain count and shuffle.** The chain readout ignores arming entirely. If a tile is
  armed and no chains exist, the count is zero and Shuffle appears as normal.
- **Undo.** A destroy goes on the undo stack; undoing it restores the tile and its
  armed state. A chain tap goes on the stack as before, including whether it armed the
  survivor. Arming by itself is not a separate stack entry.
- **Visual.** An armed tile is drawn with a ring in `--primary`, Alfred's action
  colour, as a box-shadow so it costs no layout. Exactly one tile is ever armed and it
  moves every time, so it cannot be read as encoding pitch. The staff and notehead are
  untouched.

### Board cleared

Checked after gravity resolves.

**A board is cleared when no column holds more than one tile.** Equivalently, every
remaining tile sits on the bottom row. Zero tiles counts as cleared and is the best
possible finish.

Reaching a cleared board does not require a destroy to have happened. A board that
grinds down to a single surviving tile also counts. This is rare and is accepted.

On a cleared board: increment the boards-cleared counter, stop accepting taps, and
show a **Refill** button inline in the button row below the board, alongside Undo and
Shuffle and following the same hide-when-irrelevant pattern. Clearing a board is the
good outcome, so it is deliberately not a modal — no overlay, no interruption. Taps
stay refused until Refill is pressed.

**Boards cleared is the game's score.**

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

Two terminal states, and they are handled quite differently:

- **Board cleared** — the win. An inline Refill button appears in the button row and
  the session continues. No modal.
- **True game over** — no chains and no shuffle can fix it. This one raises a modal,
  since it is the end of the session. It shows boards cleared this session, tiles
  remaining on the final board, taps taken, and largest chain. Offer "New board", which
  resets everything including the boards-cleared counter.

  The modal has a dismiss control — backdrop tap, Escape, or its close button — which
  closes without acting, leaving the finished board visible and still refusing taps. A
  "Show summary" button then appears below the board to reopen it, so the action is
  never lost. Nothing else reopens it.

**Highest pitch is not tracked.** It was reported in an earlier draft and has been
removed everywhere — from the summary, from any inline readout, and from state. Boards
cleared is the score.

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
arm-and-destroy, which changes the shape of the endgame considerably.

## Constraints

- No hover-dependent styling anywhere
- No timer during play
- No streaks, no encouragement copy, no toasts
- In-memory state only — no localStorage, no Supabase, no MCP tools, no migration
- Do not touch the platform layer
- Follow existing `Alfred.jsx` component and Tailwind patterns

## Success criteria

- Every chain tap promotes the survivor exactly one step, whatever the chain length
- A full-row chain arms the survivor, and tiles fall in around it
- Tapping an armed tile destroys it and its column drops
- A partial-row chain never arms anything, and an invalid tap never disarms
- Boards can be cleared, and clearing one shows a working inline Refill button with no
  modal and no layout shift
- True game over raises the modal; board cleared never does
- Refill preserves bottom-row survivors at their pitches
- Shuffle only appears when stuck, and always produces a playable board
- True game over fires when no arrangement can help, and only then
- Row bands read as texture, tiles stay black and white
- Falling tiles are visibly distinguishable from tiles that did not move
- Earlier variants are one tap away but out of the way
