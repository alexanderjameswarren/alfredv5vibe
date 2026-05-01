# SAM Refactor — Technical Specification

## Overview

`SamPlayer.jsx` (1,015 lines) and `SettingsBar.jsx` (806 lines) have grown beyond
their seams. Logic for audio sync, lyric editing, and settings UI is co-located
with orchestration code that should remain in the parent. `ScrollEngine.jsx`
(960 lines) bundles ~400 lines of pure VexFlow rendering with React-bound
animation logic.

This refactor extracts cohesive subsystems into hooks and modules without
changing user-visible behavior. After completion, `SamPlayer` becomes a thin
orchestrator, `SettingsBar` becomes a layout component composed of focused
children, and the audio-sync math lives in one named place.

**Non-goals:** No behavior changes. No new features. No changes to the
`measureCompiler`, `useMIDI`, `usePracticeSession`, or Supabase schema. No
changes to the lyric storage architecture (`sam_song_lyrics` table + merge at
compile time).

## Architecture Decisions

### What stays as-is
- `AudioControls.jsx`, `StatsBar.jsx`, `SnippetPanel.jsx`, `ScoreRenderer.jsx`
  — appropriate size, single-purpose.
- The component graph: `SamPlayer` orchestrates, subcomponents render.
- The lyric-storage architecture (separate table, merge at compile time).
- All MCP-write boundaries (`rh`/`lh`/`time_signature` read-only via MCP).

### What changes
1. **Extract `useLyricEditor` hook.** All `rhNoteSequence`,
   `rhSeqIdxMap`, `nextNavIdx`, the four cascade handlers, and
   `handleSaveLyrics` move into a hook that takes `(song, songDbId,
   skipTiedNotes)` and returns `{ lyricPlacements, lyricsDirty,
   lyricsSaving, lyricEditHandlers, saveLyrics, setLyricPlacements }`.
2. **Split `SettingsBar` into 4 focused components.**
   - `<TransportControls>` — play/pause/resume/restart/stop buttons.
   - `<NumericSettings>` — bpm, timing window, chord ms, measure width,
     playback speed inputs.
   - `<SongMetadataEditor>` — title/artist/defaults edit modal.
   - `<AudioToolbar>` — audio upload, auto-match, refresh, lyrics.
   - `SettingsBar` becomes a thin layout shell composing the four.
3. **Extract `useAudioSync` hook.** All audio-timestamp math
   (`getApproachMs`, `getAudioSeekMsForMeasure`, `getSnippetAudioSeekMs`,
   `getSnippetAudioEndMs`, `audioAnchors` derivation, `handleScrollStart`
   delay-timer dance) consolidates into a hook taking `(song, snippet,
   activeMeasures, bpm, playbackSpeed, audioElement, scrollContainerRef,
   measureWidth)` and exposing `{ audioAnchors, getSeekForMeasure,
   getSnippetAudioEndMs, scheduleAudioStart, cancel }`.
4. **Move `renderCopy` and helpers to `lib/scoreRender.js`.**
   `padVoice`, `renderCopy`, `drawStaveTies`, and the tie-tracking
   become a pure module imported by `ScrollEngine`. No React inside.
5. **Add `useNumericInput` helper hook.** Replaces every
   `[value, valueInput]` state pair with one hook returning
   `{ value, input, set, setInput, commit }`.

### Implementation order rationale
Lyric editor first (highest ROI, lowest blast radius — pure logic
extraction). SettingsBar split second (independent of audio work, sets
up cleaner SamPlayer prop-passing). Audio sync third (depends on a
clean SamPlayer to land in). ScrollEngine extraction fourth
(mechanical, unchanged behavior). NumericInput last (cosmetic, can
land anytime).

## Components Affected

| File | Change |
|------|--------|
| `SamPlayer.jsx` | -180 lines (lyrics) -150 lines (audio sync) -50 lines (numeric inputs); becomes ~600 lines of orchestration + JSX |
| `SettingsBar.jsx` | Becomes ~80-line layout shell |
| `ScrollEngine.jsx` | -400 lines (extracted to lib); becomes ~550 lines |
| `lib/useLyricEditor.js` | NEW |
| `lib/useAudioSync.js` | NEW |
| `lib/useNumericInput.js` | NEW |
| `lib/scoreRender.js` | NEW |
| `components/TransportControls.jsx` | NEW |
| `components/NumericSettings.jsx` | NEW |
| `components/SongMetadataEditor.jsx` | NEW |
| `components/AudioToolbar.jsx` | NEW |

## Implementation Approach

Each milestone is a self-contained PR-sized chunk that ends with a
working app. Verification involves loading "Someone Like You", running
through stop/play/pause/snippet/lyrics flows, and confirming MIDI
matching still works against the existing measures 1-4 pattern.

### Milestone 1 — Extract `useLyricEditor`
1. Create `lib/useLyricEditor.js`.
2. Move state: `lyricPlacements`, `lyricsDirty`, `lyricsSaving`,
   `skipTiedNotes` stays in parent (it's a UI toggle).
3. Move derived: `rhNoteSequence`, `rhSeqIdxMap`, `findRhSeqIdx`,
   `nextNavIdx`.
4. Move handlers: all four cascade handlers, `handleSaveLyrics`,
   the `lyricEditHandlers` memo.
5. Move the `useEffect` that fetches from `sam_song_lyrics`.
6. Hook signature: `useLyricEditor({ song, songDbId, skipTiedNotes,
   supabase })` returns `{ lyricPlacements, setLyricPlacements,
   lyricsDirty, lyricsSaving, lyricEditHandlers, saveLyrics }`.
7. SamPlayer uses the hook; the `activeMeasures` lyric-injection
   logic stays in SamPlayer (it consumes `lyricPlacements`).

### Milestone 2 — Split `SettingsBar`
1. Create the four child components in `components/`.
2. Each takes only the props it needs (no prop-drilling pass-through).
3. Move state into the child that owns it:
   - Edit-modal state (`editingSong`, `editTitle`, `editArtist`,
     `editBpm`, `editPlaybackSpeed`, `editTimingWindow`, `editChordMs`,
     `editMeasureWidth`, `saving`) → `<SongMetadataEditor>`.
   - Audio-flow state (`uploading`, `hasLyrics`,
     `showAutoMatchConfirm`, `autoMatching`, `refreshing`) →
     `<AudioToolbar>`.
   - Settings-save state (`savingSettings`, `showBpmEdit`,
     `editShowBpm`) → `<NumericSettings>`.
4. `SettingsBar` becomes a layout shell ~80 lines, composing the
   four children with appropriate prop forwarding from `SamPlayer`.
5. Audit for dead state at end of milestone (a few `editShowBpm`-style
   flags may turn out unused).

### Milestone 3 — Extract `useAudioSync`
1. Create `lib/useAudioSync.js`.
2. Move: `audioAnchors` memo, `getApproachMs`,
   `getAudioSeekMsForMeasure`, `getSnippetAudioSeekMs`,
   `getSnippetAudioEndMs`, `audioDelayTimerRef`,
   `pendingAudioSeekRef`, `scrollDelayTimerRef`, `clearDelayTimers`,
   `handleScrollStart`.
3. Hook signature: `useAudioSync({ song, snippet, activeMeasures,
   bpm, playbackSpeed, audioElement, scrollContainerRef,
   measureWidth })` returns `{ audioAnchors, getSeekForMeasure,
   getSnippetAudioEndMs, scheduleAudioStartOnScroll,
   prepareAudioSeek, clearTimers }`.
4. Transport handlers in SamPlayer call `prepareAudioSeek(seekMs)`
   before `setPlaybackState("playing")`; `scheduleAudioStartOnScroll`
   is wired to `<ScrollEngine onScrollStart={...} />`.

### Milestone 4 — Extract `scoreRender.js` from `ScrollEngine`
1. Create `lib/scoreRender.js`.
2. Move: `DURATION_BEATS`, `padVoice`, `renderCopy`,
   `drawStaveTies`, all tie-tracking helpers, `playClick`.
3. `ScrollEngine` imports `renderCopy` and `playClick`.
4. The component becomes only: refs, the two big `useEffect`s
   (initial render + animation loop), `audioMsToBeatPos`, `frame`,
   and JSX.

### Milestone 5 — `useNumericInput` helper
1. Create `lib/useNumericInput.js` — hook returning
   `{ value, input, set, setInput, commit, reset }`.
2. Replace pairs in SamPlayer: bpm, timingWindowMs, chordMs,
   measureWidth, playbackSpeed.
3. Update `<NumericSettings>` to take the hook return values.

## Success Criteria

- `SamPlayer.jsx` under 700 lines.
- `SettingsBar.jsx` under 150 lines.
- `ScrollEngine.jsx` under 600 lines.
- All existing flows work identically:
  - Load "Someone Like You" via SongLoader.
  - Stopped state: scroll the score, edit lyric placements
    (pull/push/cascade), save lyrics, set audio offsets.
  - Playing state: play full song, play snippet (with lh/rh/both),
    pause/resume preserves measure position, restart works,
    stop returns to top.
  - Audio sync: audio starts when first note hits the target line,
    seeks correctly when starting from a snippet, stops at
    `audioEndMs` for snippet rest measures.
  - MIDI matching: closest-pending-beat logic still triggers
    hit/partial/miss colors with correct timing deltas.
  - Metronome: off/beat/halfbeat/quarterbeat all click correctly.
  - Snippet save/load/archive flow unchanged.
  - Settings save/dirty-detection unchanged.
- No new console errors or warnings.
- No regressions in measure 1-4 hit accuracy (the known-good baseline).
