# Progress: Notes game — round 2

## Status: All 8 steps complete. Step 8 awaiting verification.

Spec: `docs/technical-spec-notes-game-round2.md`

All work lands in `src/games/variants/drop.jsx` and the Games tab.
Shared tile renderer and board geometry are not to be touched.

### Development steps

- [x] Step 1: Row clear. If a chain covers every occupied cell in its row, remove the
      whole chain including the tapped tile, with no promotion. Confirm gravity drops
      everything above by one row.
- [x] Step 2: Board cleared detection. A board is cleared when no column holds more
      than one tile, zero tiles included. Stop accepting taps and show a Refill button.
      Add a session boards-cleared counter.
- [x] Step 3: Refill. Bottom-row survivors stay in place at their pitches; every empty
      cell takes a fresh spawn from SEED_RANGE. Clear undo history, keep the counter.
- [x] Step 4: Shuffle rework. Only available when zero chains exist. Reshuffle and
      re-test up to SHUFFLE_TRIES until a chain exists. Remove the shuffle budget, the
      count display, and the "out of shuffles" end cause.
- [x] Step 5: True game over. Fires when the shuffle retry loop exhausts. Summary shows
      highest pitch, taps, largest chain, tiles remaining, boards cleared. "New board"
      resets everything including the counter.
- [x] Step 6: Alternating row bands. Low-contrast background banding by row. Tiles stay
      black and white.
- [x] Step 7: Drop feedback. Moved tiles visibly distinguishable after gravity. Under
      about 200ms.
- [x] Step 8: Games tab reorganisation. Drop at the top, earlier variants in a collapsed
      section. Registry gains a current/archived field.

### Verification steps

- [x] Chain an entire row and confirm the promoted tile dies with it
- [x] Confirm a row with a gap in it cannot trigger a row clear
- [x] Clear a board and confirm Refill preserves the bottom-row pitches
- [x] Get stuck and confirm shuffle appears, and that it always yields a playable board
- [x] Confirm true game over only fires when no arrangement can help
- [ ] Play ten minutes on the phone and confirm the animation is not annoying at speed

Ticked items were confirmed at each step's handover. The ten-minute soak is the one
outstanding check — it is a sustained-play judgement that no per-step verification covers.

### Notes

**Step 1 (row clear) — decisions taken**

- The test is `clearsRow(board, chain)`: chain length equals the count of occupied cells
  in that row. It is deliberately not "the row is full". A row holding three tiles in its
  last three columns, with the first two columns empty, does row-clear. Leading and
  trailing empties are not gaps; only an empty *between* occupied cells blocks a clear,
  and that case is already impossible because a chain cannot cross an empty cell. Sparse
  upper rows are therefore the cheap clears, which is what makes Step 2's cleared-board
  condition reachable at all.
- Gravity is unchanged. A cleared row leaves a hole in exactly the columns that held a
  tile there, and the existing column repack drops everything above by one row. No new
  gravity code path.
- Two existing derivations had to be repaired, because row clear breaks assumptions they
  were resting on. Both were silent wrong-number bugs, not crashes:
  - **Largest chain** was inferred from the drop in tile count (`before - after + 1`),
    which held only while every tap left exactly one tile standing. A row clear leaves
    none, so it would have reported the chain one longer than it was. Now recorded as
    `chainLength` on the move-stack entry at the moment of the tap. It still rewinds with
    undo — the length is popped along with the board it belongs to.
  - **Highest pitch reached** was read off the current board, which was sound only while
    the board maximum could never fall. A row clear can delete the highest tile, promoted
    ones included, so it now scans every board in the timeline for a true high-water mark.
    Also guards the now-reachable zero-tile board, which would otherwise have rendered
    `Math.max()` of nothing as `-Infinity` in the summary.
- Verified by simulation before handing over: targeted cases for a full-row clear, a
  gapped row refusing to clear, and a leading-empty partial row clearing; then 30,000
  random runs with row clears and undos interleaved, 354,922 assertions, checking tile
  accounting, column packing, and both repaired figures against an independent oracle
  (high-water = seed max vs. the promoted value of every still-standing tap). The board
  maximum genuinely fell after a row clear 272 times in that sample — the exact case the
  old derivation would have got wrong.

**Step 1's transitional gap: closed by Step 2.** An emptied board is now a cleared
board, so it no longer falls through to the dead-board path.

**Step 2 (board cleared detection) — decisions taken**

- `isCleared(board)` counts tiles per column and fails on the first column holding two.
  Stated that way rather than as "every tile is on the bottom row" so it matches the spec
  wording and does not lean on the gravity packing invariant being true. The two
  formulations were checked against each other on 300,000 packed boards and agreed
  every time.
- **Clearing beats dying.** A board can be both cleared and dead — five survivors on the
  bottom row with no linked pair among them — and in that case it is a win, so `over` is
  now `!cleared && boardDead && shufflesLeft === 0` and the game-over summary stays away.
- **A cleared board can still have chains on it.** A full bottom row of five linked tiles
  is cleared, and taps stop even though moves are visibly available. This follows the
  spec's definition and is believed to be the intent — the board has been drained to a
  single layer and Refill builds the next one on top of those survivors. Confirmed at
  Step 2 verification: keep as is.
- **Counter shape:** `boardsCleared = bankedClears + (cleared ? 1 : 0)`. `bankedClears` is
  real state incremented at refill time (Step 3), because refill wipes the move stack and
  there would be nothing left to derive earlier clears from. The board on screen counts
  the moment it is cleared and stops counting if you undo back out of it, which is what
  stops the counter being farmed by clearing and undoing on the spot. No effects, no
  counter that can drift from the stack.
- Taps and Shuffle are both blocked while cleared. Undo deliberately stays live, so a
  cleared board can be backed out of.
- **Bug caught during the edit:** the outer `cleared` flag collided with a local
  `const cleared` inside `tap()`. The early return reads the flag, so the shadowing
  declaration would have put that read in the temporal dead zone and thrown a
  ReferenceError on every tap. The local is now named `next`.
- Reachability under random play: 6.7% of runs reach a cleared board, averaging 16 taps.
  Deliberate play should be well above that; random play never reached zero tiles, which
  needs row clears aimed on purpose.

**Step 2 verification result.** Verified by Alex. A screenshot pair initially looked like a
failed row clear — a two-tile top row losing only one tile — but reproducing both candidate
boards against the real code showed it was gravity: a length-2 chain lower down in the same
two columns removes a tile from one of them, and everything above it falls by one row,
emptying the top of that column. The surviving top tile was untouched, not promoted. A
genuine two-tile top row does row-clear (both tiles removed, top row emptied). No defect;
no change made.

**Step 3 (refill) — decisions taken**

- `spawnPitch()` extracted so SEED_RANGE is read in exactly one place, shared by the initial
  seed and by refill. Refill is then `board.map(p => p == null ? spawnPitch() : p)`.
- Survivors are preserved by leaving non-null cells untouched, rather than by copying the
  bottom row somewhere and rebuilding. Nothing can shift, and it stays correct if a future
  rule leaves a survivor off the bottom row.
- **No gravity pass after refill.** Every cell is occupied afterwards, so there is nothing
  for anything to fall into. The board is settled by construction.
- **The clear is banked in `refill()`, not at detection.** Refill is the point of no return:
  once the move stack is cleared there is no history left to derive earlier clears from, so
  that is exactly where the count has to become real state. The displayed total is
  continuous across the transition — `banked + 1` before, `banked + 1` with `cleared` false
  after.
- Undo history is cleared, so there is no undoing back across a refill, per spec.
- Verified on 200,000 refills / 4.5M spawns: every spawn inside SEED_RANGE, no survivor ever
  moved or changed pitch, every refilled board full and no longer reporting cleared. 123,316
  of those refills carried a survivor above SEED_RANGE — that is the session arc working.

**Step 4 (shuffle rework) — decisions taken**

- Constants replaced: `SHUFFLES_PER_BOARD = 20` is gone; `SHUFFLE_LIMIT = null` and
  `SHUFFLE_TRIES = 200` are in. The budget path is still wired
  (`SHUFFLE_LIMIT == null ? Infinity : ...`) so reinstating a budget is a one-constant
  change, but with null there is nothing to spend.
- `playableShuffle(board)` rearranges and re-tests up to `SHUFFLE_TRIES`, returning the
  first playable board or null. A shuffle that leaves you stuck is not a move, so it is
  never handed back.
- Availability is `canShuffle = boardDead && !cleared && !over && shufflesLeft > 0`. The
  button stays permanently visible and disabled, matching the file's existing convention
  rather than being hidden — the spec allows either.
- Button label is now plain "Shuffle" and the "Shuffles used" line is gone from the
  summary. Both were the count display the spec asked to remove.
- `over` is now `!cleared && searchExhausted`, no longer a resource check.
  `searchExhausted` is the one piece of genuinely underivable state in this file — it is
  the outcome of a random search, not a property of the position — so it is cleared by
  hand in `undo`, `refill` and `reset`. A tap cannot stale it: a board with no chains has
  no valid tap to make, which is checked rather than assumed.
- A failed search does not go on the move stack. The board is unchanged, so there is
  nothing to undo, and putting it there would let Undo consume a phantom move.
- **"Out of shuffles" removed as an end cause.** Its slot is taken by "no playable
  arrangement found", which now means something different and much rarer: the two
  structural causes did *not* apply, so an arrangement provably exists and the random
  search simply failed to land on it.

**How reliable is the search?** A playable arrangement exists iff two occupied cells are
horizontally adjacent AND two pitches are within `STEP_TOLERANCE` — pitches permute freely
among occupied cells, so those conditions are jointly sufficient as well as necessary. That
decision procedure was validated against exhaustive permutation search on 40,000 boards.
Measured over 280,976 stuck boards in real play:

- the search succeeded in **2.23 attempts on average, worst case 99** of the 200 allowed
- **zero false game overs** — never once did it exhaust while an arrangement existed
- every game over reported a structural cause (53,513 "no adjacent pairs remain", 2,103
  "pitches too far apart"); "no playable arrangement found" never fired

So 200 tries has a comfortable margin at this board size, and true game over means what it
says. Worth re-measuring if `GRID`, `SEED_RANGE` or `STEP_TOLERANCE` ever change.

**Step 5 (true game over) — decisions taken**

- The trigger was already wired by Step 4 (`over = !cleared && searchExhausted`), so Step 5
  is the summary itself: added boards cleared, and reworded the heading.
- **Heading changed from "Board finished" to "Game over".** The spec is explicit that the
  two terminal states are different things, and "Board finished" sat too close to "Board
  cleared" to tell them apart at a glance. "Board cleared" = the win, session continues.
  "Game over" = the session is done.
- "Taps" relabelled "Taps taken" to match the spec's wording.
- `reset()` already zeroed everything when Step 2 and Step 4 added their state, so "New
  board" needed no change: board reseeded, history emptied, `bankedClears` to 0,
  `searchExhausted` to false. That is the complete state of this component — there is no
  fifth thing to forget.
- Verified by simulating 40,000 complete sessions through the real state machine: the two
  terminal states never coexisted, the summary's counter always equalled the refills
  actually performed, and every "New board" produced a playable board with a zeroed
  counter. Sessions ran up to 3 boards; game over averages ~15 taps on the final board.
  Causes split 38,377 "no adjacent pairs remain" to 1,623 "pitches too far apart".

**Step 5 verification result.** Verified. The per-board scoping of highest pitch / taps /
largest chain was raised at handover and accepted as is — treated as settled unless
revisited.

**Step 6 (alternating row bands) — decisions taken**

- **Tailwind slash-opacity does not work in this project.** The palette is bare `var(--x)`
  values with no `<alpha-value>` placeholder, and Tailwind 3 cannot inject alpha into
  those, so `bg-muted/30` and friends compile to *nothing at all*. Confirmed against the
  built stylesheet: only `bg-primary`, `bg-primary-hover` and `bg-primary-light` exist —
  no slash variants. A band written that way would silently not appear. The tint is
  therefore an explicit `color-mix(in srgb, var(--muted) 30%, transparent)`, which still
  derives from an existing surface token. Renders about #F3EEE8 over the #FAFAF8 page.
- **Pre-existing latent issue, left alone:** `bg-primary/15` in `timer/components/
  TimerRun.jsx`, and `hover:bg-primary/5`, `hover:bg-muted/80`, `text-muted-foreground/60`
  in `Alfred.jsx`, are all silently doing nothing today for the same reason. Out of scope
  for this round; noted so it is not rediscovered from scratch.
- **Structure:** one element per row, rather than a stripe painted on the container. The
  tiles are opaque white, so a container-level background would only ever show in the
  gaps — thin slivers, not bands.
- **Board geometry preserved exactly.** The obvious version of this (padding on each row)
  cost the tiles width: on a 390px phone it took them from 67.16px to 65.6px, which walks
  away from the confirmed 68. Each row now takes half a gap of padding and gives it
  straight back as a negative horizontal margin, so with border-box sizing the content box
  lands on exactly the container width. Verified arithmetically: tile size, column gap and
  vertical tile spacing are identical before and after at both phone and desktop widths
  (67.156px on a 390px phone, 68.000px with room to spare). The band reaches 3.78px past
  each edge, comfortably inside the page's 12px padding, so nothing overflows. The board
  is one gap (7.56px) taller; nothing else moves.
- Banded rows are the odd-indexed ones (2nd and 4th), leaving the outer rows on the page
  background so the effect stays light.

**Step 7 (drop feedback) — decisions taken**

- Took the spec's **preferred** option, a real position transition, not the colour/opacity
  fallback. Tiles slide down from where they fell.
- **No tile identity was needed.** `applyGravity` preserves order within a column, so the
  k-th survivor counting down a column before the pass is the k-th after it. Pairing them
  off gives each tile's fall distance directly, with no ids to thread through state.
  `fallDistances(preGravity, postGravity)` does exactly that.
- **The offset is relative, not absolute.** `translateY(calc(-N * (100% + GAPpx)))` — one
  row is 100% of the tile's own height plus one gap, so it stays exact at any board scale,
  including the shrunk-to-fit phone width. No measuring, no layout reads.
- **Animation restart needed a key.** React reuses the DOM node, so a tile falling the same
  distance twice running would have sat still — nothing about the element changes. The
  button is keyed by `history.length`, which is guaranteed to differ between consecutive
  taps because a tap always pushes an entry. No extra state.
- `DROP_MS = 140`, comfortably under the 200ms ceiling. The board state is already final
  when the animation starts — only the paint is catching up — so taps during a drop hit the
  right tile and nothing is queued or blocked.
- Keyframes live in a local `<style>` in drop.jsx rather than index.css: round 2 lands in
  drop.jsx and the Games tab, and nothing else needs these rules.
- `prefers-reduced-motion: reduce` disables the animation outright. Position is correct
  either way; only the travel is lost.
- `fall` is reset to zeros by undo, shuffle, refill and reset, so only a gravity pass
  animates. It is presentation-only state — nothing but the render reads it.
- **Verified** against an independent oracle that labels every tile and tracks where it
  physically lands: agreement on 400,000 boards / 3.18M moved-tile readings. In 162,004
  real taps, 78.7% moved at least one tile, averaging 2.27 rows of total motion per tap,
  and no tile ever rose, changed column, or reported a fall on an empty cell.

**Step 8 (Games tab reorganisation) — decisions taken**

- Registry gains `status: "current" | "archived"`. The array stays in build order and the
  tab does the sorting, so a new round is one `status` flip plus one entry — no edits to
  `GamesPage`, `Alfred.jsx` or the router.
- **Anything not explicitly `"archived"` counts as current** (`status !== "archived"`).
  Forgetting the field puts a new variant at the top where it will be noticed rather than
  burying it in a collapsed section.
- `findVariant` still searches the whole registry: archived variants are superseded, not
  withdrawn, and remain playable.
- One shared `VariantRow` for both lists, so an earlier version looks and behaves exactly
  like the current one. Disclosure is a plain button with `aria-expanded` and a rotating
  chevron; collapsed by default; no hover styling anywhere.

**ROWS DOES NOT EXIST — spec discrepancy, carried through to the end of the round.** The
spec's "Current state (assumed built)" lists `src/games/variants/rows.jsx` (horizontal
chains, gravity plus refill, endless), and Step 8 asks for it in the earlier-versions
section. There is no such file and no such variant; the built set is Vanish, Cascade and
Drop. Flagged at Step 1 and again at Step 7; no decision received, so Step 8 shipped
reorganising the three variants that actually exist. Earlier versions therefore holds
Vanish and Cascade. If Rows was meant to be built, that is a separate piece of work — but
the registry pattern is exactly what the spec asked for, so slotting it in later is one
entry and one file, with nothing else to touch.

**RESOLVED — scope of the summary figures.** Accepted per-board at Step 5 verification.
Original note kept below for context.

**Earlier open question —** The spec does not say whether
highest pitch / taps / largest chain are per-board or per-session, and it matters once a
session spans several boards. They are currently **per-board**, because all three derive
from the move stack and the spec says "Undo history clears on refill" while singling out
only the boards-cleared counter as persisting. So after a refill they restart, and a
pitch-12 tile that was row-cleared two boards ago is not reported — though a surviving high
tile still is, because it is physically on the board. The alternative is to bank them at
refill the way `bankedClears` is banked, making the whole panel a session report. Cheap to
change; needs a decision, not a guess.

**Accepted risk, not guarded:** a refilled board can theoretically come back with no chain at
all (23 in 200,000, 0.01%). `newBoard()` reseeds until playable but refill deliberately does
not, since the spec does not ask for it and Step 4 makes Shuffle available exactly when zero
chains exist, which recovers it. Revisit if it is ever actually hit in play.

**Discrepancy with the spec's assumed current state**

The spec lists `src/games/variants/rows.jsx` (horizontal chains, gravity plus refill,
endless) under "Current state (assumed built)". No such file exists; the built variants
are `vanish.jsx`, `cascade.jsx` and `drop.jsx`. This does not affect Steps 1–7, but
Step 8 asks for Vanish, Cascade and Rows in the collapsed earlier-versions section —
that step needs a decision on whether Rows is meant to be built, was renamed, or should
simply be dropped from the list.

Deferred this round: smoosh (columns collapsing sideways). May be strategy rather than
defect — revisit after playing with row clears.

Open tuning questions to answer by playing, not by design:
- Is PROMOTION too generous now that row clears exist?
- Does the seed range need to rise with boards cleared, or do surviving high tiles
  carry the arc on their own?
