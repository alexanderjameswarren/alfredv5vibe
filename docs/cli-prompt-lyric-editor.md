# Project Context

Sam is a React piano practice app with Supabase backend. Lyrics are stored in `sam_song_lyrics` with `word_order` (sequence), `syllable` (text), `measure_num` and `rh_index` (placement on RH notes). Syllables are loaded via Claude/MCP with `measure_num` and `rh_index` initially NULL (unplaced). This change adds an auto-match function and a visual editing UI for placing/adjusting syllables on the score.

# Reference

- Lyrics table: `sam_song_lyrics` — columns: `id`, `song_id`, `word_order`, `syllable`, `measure_num`, `rh_index`, `created_at`, `updated_at`
- Unique constraint on `(song_id, word_order)` — each syllable has a fixed position in the lyrics sequence
- Measures are in `sam_song_measures` with `rh` JSONB voice arrays
- RH voice events are arrays of `{ duration, notes: [...] }` — rh_index is the 0-based position in this array

# Change 1: Auto-Match Button

Add an **"Auto-Match Lyrics"** button to the song UI. 

**Visibility:** Only show this button if the song has lyrics in `sam_song_lyrics` (at least one row exists for this song_id).

**On click:** Show a confirmation dialog/warning: "This will overwrite all existing lyric placements. Continue?" with Cancel and Confirm buttons.

**Auto-match logic (client-side):**
1. Fetch all `sam_song_lyrics` rows for the song, ordered by `word_order`
2. Fetch all measures (from `sam_song_measures` or the loaded measures array)
3. Walk through all measures in order. For each measure, walk through the RH voice events in order (index 0, 1, 2, ...)
4. For each RH event that has actual pitched notes (skip rests — events where `notes` array is empty), assign the next unplaced syllable
5. Set `measure_num` and `rh_index` on that syllable row
6. If all syllables are placed before running out of RH notes: success
7. If syllables remain after all RH notes are exhausted: show an error — "X syllables unplaced. The song needs more measures or fewer lyrics."
8. Save all placements back to `sam_song_lyrics` in a batch update

# Change 2: Lyric Display on Score (Stopped Mode)

When in **stopped mode** and the song has lyrics with placements (`measure_num` IS NOT NULL):

- Render each syllable below its corresponding RH note on the score, using the existing lyric annotation rendering approach in ScrollEngine/ScoreRenderer
- Each syllable is interactive (not just text — has click targets for the control buttons)

**Display a "Save Lyrics" button** below the score. This button only appears if any placements have been modified since the last save. Clicking it batch-updates all changed `sam_song_lyrics` rows.

# Change 3: Lyric Editing Controls

Each placed syllable on the score gets two rows of small arrow buttons:

**Above the syllable — single-step operations:**
- **← (single pull backward):** Move this syllable to the previous RH note. If that note already has a syllable, ALLOW both syllables to share the same note (multiple syllables on one note). This is the ONLY operation that creates multiples. Use case: a whole note sustains through multiple lyric syllables.
- **→ (single push forward / fill gap):** Move this syllable to the next RH note. All subsequent syllables shift forward one RH note each, BUT only until an unmatched (empty) RH note is filled — then stop shifting. Syllables after the filled gap are untouched. Never creates multiples.

**Below the syllable — cascade operations:**
- **⇐ (cascade pull backward):** Move this syllable AND all subsequent syllables backward one RH note each. Never creates multiples — if pulling backward would create a conflict, stop or skip. Use case: closing a gap.
- **⇒ (cascade push forward):** Move this syllable AND all subsequent syllables forward one RH note each. Use case: inserting a gap for an instrumental note. Never creates multiples.

**Rules for all operations:**
- Forward operations never create multiple syllables per note
- Backward cascade never creates multiple syllables per note
- ONLY single backward pull (←) can create multiples
- Once multiples exist on a note, push/pull operations treat them as a group — they move together
- If any operation would push a syllable past the last RH note in the song, show an error and don't execute

# Change 4: Tied Note Checkbox

Add a checkbox to the lyric editing area: **"One syllable per tied note"**

When **checked:**
- During auto-match: if an RH note has `tie: 'start'` or `tie: 'both'`, it can receive at most one syllable. The continuation notes (`tie: 'end'` or `tie: 'both'` on the receiving end) are skipped — no syllable assigned to them.
- During push/pull operations: tied continuation notes are skipped (treated as if they don't exist for placement purposes). Syllables jump over them to the next non-tied note.

When **unchecked:**
- Tied notes are treated as regular RH notes for all operations. Default state.

# Implementation Notes

## Data Flow
- On song load (stopped mode): fetch `sam_song_lyrics` for the song
- Placements are edited in React state (not saved to DB on every click)
- "Save Lyrics" button performs a batch upsert to `sam_song_lyrics`
- Auto-match writes directly to DB then reloads

## Compile Trigger
- After saving lyrics, the app should trigger a recompile of the song measures blob so that lyrics appear during playback. This means updating `measures_edited_at` on `sam_songs` (or whichever mechanism triggers the stale check).
- Actually — check how lyrics currently render during playback. If they're pulled from the measures blob's `lyric` field on voice events, then saving lyrics needs to update those voice events. If they're pulled directly from `sam_song_lyrics` at render time, no recompile needed. Determine which approach is in use and handle accordingly.

## Arrow Button Styling
- Keep buttons small and unobtrusive — they're editing tools, not primary UI
- Single arrows (above): smaller, subtle
- Cascade arrows (below): slightly larger to communicate broader impact
- Consider using opacity/hover states so they don't clutter the score when not being used

## Scroll Position
- When editing lyrics in stopped mode, the score should be scrollable/pannable so the user can navigate to any measure. The user needs to see the full score, not just the viewport-width section.

# Verification

1. Load a song that has lyrics in `sam_song_lyrics` with NULL placements
2. Click Auto-Match — confirm warning dialog appears
3. Confirm — verify all syllables get placed sequentially on RH notes
4. See syllables rendered below notes on the score in stopped mode
5. Click → (fill gap) on a syllable mid-song — confirm it shifts forward and subsequent syllables fill to the next gap
6. Click ⇒ (cascade) on a syllable — confirm it and ALL subsequent syllables shift forward one
7. Click ← (single pull) on a syllable onto an occupied note — confirm both syllables now share that note
8. Click ⇐ (cascade pull) — confirm syllable and all subsequent move backward one
9. Check the tied-note checkbox, run auto-match again — confirm tied continuation notes are skipped
10. Make changes, confirm "Save Lyrics" button appears, click it, reload page, confirm changes persisted

# Important

- Update docs/progress file when complete
- The unique constraint on `(song_id, measure_num, rh_index)` likely needs to be dropped to allow multiple syllables per note — handle this in the implementation
- Don't modify the playback scroll behavior — lyric editing is stopped-mode only
- Stop and ask if the current lyric rendering approach is unclear
