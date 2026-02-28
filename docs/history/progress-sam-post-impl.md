# Progress: Sam Post-Implementation Changes

## Status: Complete

---

## Phase 1: Schema Migration (Manual — Supabase Dashboard)

- [x] Step 1.1: Run migration SQL — add `playback_bpm` and `audio_lead_in_ms` to `sam_songs`
- [x] Step 1.2: Verify — confirm columns exist and `playback_bpm` backfilled from `default_bpm`

## Phase 2: BPM-Driven Playback Speed

- [x] Step 2.1: Remove playback speed slider from AudioControls
- [x] Step 2.2: Add `playback_bpm` field to the song form (alongside existing `default_bpm`)
- [x] Step 2.3: Implement playback rate calculation: `audioElement.playbackRate = playback_bpm / default_bpm` with `preservesPitch = true`
- [x] Step 2.4: Wire BPM to scroll engine — scroll speed derives from `playback_bpm`, audio speed matches automatically
- [x] Step 2.5: Verify — change playback BPM on a song with audio, confirm audio and scroll both adjust together

## Phase 3: Audio Lead-In

- [x] Step 3.1: Add `audio_lead_in_ms` field to the song form
- [x] Step 3.2: Display elapsed milliseconds on audio controls when in stopped mode (for calibration)
- [x] Step 3.3: Implement lead-in logic — on Play, start audio immediately, delay notation start by `audio_lead_in_ms` milliseconds
- [x] Step 3.4: When starting from a snippet (e.g., measure 13), calculate audio seek position: `audio_lead_in_ms + time_to_measure_from_bpm` (or use `audio_offset_ms` if set on that measure)
- [x] Step 3.5: Verify — set lead-in on a song, press Play, confirm notation starts after the audio intro. Test snippet start mid-song.

## Phase 4: Audio State Tied to Play/Pause/Stop

- [x] Step 4.1: Remove independent play/pause controls from audio during Play and Pause modes
- [x] Step 4.2: Audio playback follows the existing state machine: Play = audio plays, Pause = audio pauses, Stop = audio stops
- [x] Step 4.3: In Stopped mode only: show audio seek bar and play/pause for calibration workflow
- [x] Step 4.4: Verify — confirm no separate audio controls visible during Play/Pause. Confirm audio scrub works in Stopped mode.

## Phase 5: Mute Checkbox

- [x] Step 5.1: Add mute checkbox to audio area, visible in Stopped and Pause modes only
- [x] Step 5.2: Default unchecked (audio on). When checked, `audioElement.muted = true` (audio continues for sync, just silent)
- [x] Step 5.3: Not a persisted setting — resets to unchecked on song load
- [x] Step 5.4: Verify — check mute, play, confirm no audio but notation still scrolls correctly. Uncheck, confirm audio returns.

## Phase 6: Snippet Hand Mode

- [x] Step 6.1: Add radio button group to snippet UI: "Both" | "LH" | "RH" — defaults to "Both"
- [x] Step 6.2: Store selection in `sam_song_snippets.settings` JSONB as `handMode: 'both' | 'lh' | 'rh'`
- [x] Step 6.3: When snippet is active with LH or RH mode, note matching only evaluates beats from the selected hand. Inactive hand notes render normally but produce no hit/miss feedback and no color changes.
- [x] Step 6.4: Verify — create snippet with LH mode, play it, confirm only left hand notes trigger feedback. Play right hand notes alongside — confirm no penalty or color change on those notes.

## Phase 7: Snippet Label Spacing Bug

- [x] Step 7.1: Fix missing space between snippet name and measure range (e.g., "Intro m.1-4" not "Introm.1-4")
- [x] Step 7.2: Verify — check snippet labels display correctly

---

## Notes

**Step 2.1** — Removed the standalone tempo slider (+/- buttons and percentage input) from `AudioControls.jsx`. Removed `tempo`/`tempoInput` state, `applyTempo`/`handleTempoInput`/`handleTempoBlur` functions, and the `Minus`/`Plus` icon imports. The playback rate will be driven by `playback_bpm / default_bpm` ratio in Step 2.3.

**Step 2.2** — Added `playback_bpm` field to both song edit modals (SongLoader + SettingsBar). Both show "Default BPM" and "Playback BPM" side-by-side with a hint label. Supabase queries updated to select/save `playback_bpm`. Song object carries `playbackBpm`. SamPlayer initializes the active `bpm` from `playbackBpm` (falling back to `defaultBpm`).

**Step 2.3** — Added a `useEffect` in SamPlayer that sets `audioElement.playbackRate = bpm / song.defaultBpm` with `preservesPitch = true`. Runs whenever `audioElement`, `bpm`, or `song.defaultBpm` changes. When playback_bpm equals default_bpm, rate is 1.0 (normal). Half the BPM → 0.5 rate (half speed), etc.

**Step 2.4** — Fixed ScrollEngine audio sync for non-1.0 playback rates. `audioElement.currentTime` is in the recording's timeline, not real-time. When playbackRate != 1.0, dividing by the rate converts to real-time, keeping scroll speed (which uses `playbackBpm`) in sync with the slowed/sped audio. The scroll engine already used `bpm` (= playbackBpm) for `msPerBeat`, so no other changes needed — the `bpm` prop was already the playback BPM since Step 2.2.

**Step 3.1** — Added `audio_lead_in_ms` field to both song edit modals (SongLoader + SettingsBar). Field labeled "Audio Lead-In (ms)" with hint "Milliseconds from audio start to measure 1, beat 1." Added to Supabase select query, song object (`audioLeadInMs`), and Supabase update. Default is 0.

**Step 3.2** — Added elapsed milliseconds display to AudioControls. Shows `Math.round(currentTime * 1000) ms` in monospace font to the right of the seek bar. Updates in real-time during playback and on scrub. Used for calibration: play audio, listen for downbeat, pause, read ms value, enter into Audio Lead-In field.

**Step 3.3** — Implemented lead-in logic. ScrollEngine now accepts `audioLeadInMs` prop and uses it as `audioBaseOffsetMs`. Fixed elapsed calculation order: subtract offset in audio-file-time BEFORE dividing by playback rate — critical for correct sync at non-1.0 rates. SamPlayer play handlers now control audio: Play/Restart seek to 0 and play, Pause pauses audio, Resume resumes audio, Stop/FullStop pause and reset to 0. During lead-in, `elapsed < 0` is clamped to 0, so notation sits still until audio reaches the downbeat.

**Step 3.4** — Added snippet-aware audio seek. New `getSnippetAudioSeekMs()` helper in SamPlayer calculates the audio-file-time position for a snippet's start measure: checks `audioOffsetMs` on the target measure first (per-measure override from `sam_song_measures.audio_offset_ms`), else computes `audioLeadInMs + totalBeats * (60000 / defaultBpm)` by summing beat durations of all preceding measures at the recording's BPM. `handlePlay` and `handleRestart` now seek audio to this position instead of 0 when a snippet is active. The `audioLeadInMs` prop to ScrollEngine is also set to the snippet seek position so that `elapsed` starts at 0 — no lead-in delay needed since we're past the intro. `measureCompiler.js` updated to include `audio_offset_ms` in both `recompileMeasures` (select + output) and `fanOutMeasures` (preserve on write).

**Steps 4.1–4.3** — AudioControls now accepts a `playbackState` prop and returns `null` when not in "stopped" mode. This hides the independent play/pause button and seek bar during Play and Pause — audio is controlled entirely by the state machine (handlePlay/handlePause/handleResume/handleStop, implemented in Step 3.3). In Stopped mode, the full calibration UI (play/pause, seek bar, elapsed ms) is visible for measuring audio lead-in.

**Steps 5.1–5.3** — Added `audioMuted` state to SamPlayer, default `false`, reset to `false` in `handleSongLoaded`. A `useEffect` syncs `audioElement.muted = audioMuted` whenever either changes. Mute checkbox renders in SamPlayer (not AudioControls) below the audio controls area, visible when `audioElement` exists and `playbackState !== "playing"` (i.e., stopped or paused). When muted, audio continues playing for scroll sync but is silent.

**Step 7.1** — Fixed 8 instances of missing spaces in CSS class strings in `SnippetPanel.jsx`. Pattern was `text-muted-foregroundml-2` instead of `text-muted-foreground ml-2` (and similar with `mb-2`, `hover:text-dark`, `hover:text-success`). The concatenated class names weren't being applied, causing missing margins (snippet label spacing) and missing hover styles.

**Steps 6.1–6.3** — Snippet hand mode implemented across 4 files. **ScrollEngine**: `renderCopy` now builds `rhMidi` and `lhMidi` arrays alongside `allMidi` in both voice-format and legacy-beats paths; these are carried through to beat events along with individual `trebleSvgEl`/`bassSvgEl` references. `handMode` prop added; miss scanner uses hand-filtered midi (skips beats with no active-hand notes) and colors only the active hand's SVG elements. **SnippetPanel**: Added `handMode` state with radio buttons ("Both" | "LH" | "RH"), included in `handleApply`, `handleLoadSnippet` (reads from `settings.handMode`), `handleSave` (writes to settings JSONB), and `handleFullSong` (resets to "both"). **SamPlayer**: `handleChord` uses `snippet.handMode` to select `activeMidi` from `beat.rhMidi`/`beat.lhMidi`/`beat.allMidi` for chord matching, and colors only the active hand's SVG elements on hit/partial/wrong. `findClosestBeat` updated to accept `handMode` param and skip beats where the active hand has no notes. **noteMatching.js**: `findClosestBeat` signature extended with optional `handMode` param.
