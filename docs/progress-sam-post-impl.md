# Progress: Sam Post-Implementation Changes

## Status: Not Started

---

## Phase 1: Schema Migration (Manual — Supabase Dashboard)

- [ ] Step 1.1: Run migration SQL — add `playback_bpm` and `audio_lead_in_ms` to `sam_songs`
- [ ] Step 1.2: Verify — confirm columns exist and `playback_bpm` backfilled from `default_bpm`

## Phase 2: BPM-Driven Playback Speed

- [ ] Step 2.1: Remove playback speed slider from AudioControls
- [ ] Step 2.2: Add `playback_bpm` field to the song form (alongside existing `default_bpm`)
- [ ] Step 2.3: Implement playback rate calculation: `audioElement.playbackRate = playback_bpm / default_bpm` with `preservesPitch = true`
- [ ] Step 2.4: Wire BPM to scroll engine — scroll speed derives from `playback_bpm`, audio speed matches automatically
- [ ] Step 2.5: Verify — change playback BPM on a song with audio, confirm audio and scroll both adjust together

## Phase 3: Audio Lead-In

- [ ] Step 3.1: Add `audio_lead_in_ms` field to the song form
- [ ] Step 3.2: Display elapsed milliseconds on audio controls when in stopped mode (for calibration)
- [ ] Step 3.3: Implement lead-in logic — on Play, start audio immediately, delay notation start by `audio_lead_in_ms` milliseconds
- [ ] Step 3.4: When starting from a snippet (e.g., measure 13), calculate audio seek position: `audio_lead_in_ms + time_to_measure_from_bpm` (or use `audio_offset_ms` if set on that measure)
- [ ] Step 3.5: Verify — set lead-in on a song, press Play, confirm notation starts after the audio intro. Test snippet start mid-song.

## Phase 4: Audio State Tied to Play/Pause/Stop

- [ ] Step 4.1: Remove independent play/pause controls from audio during Play and Pause modes
- [ ] Step 4.2: Audio playback follows the existing state machine: Play = audio plays, Pause = audio pauses, Stop = audio stops
- [ ] Step 4.3: In Stopped mode only: show audio seek bar and play/pause for calibration workflow
- [ ] Step 4.4: Verify — confirm no separate audio controls visible during Play/Pause. Confirm audio scrub works in Stopped mode.

## Phase 5: Mute Checkbox

- [ ] Step 5.1: Add mute checkbox to audio area, visible in Stopped and Pause modes only
- [ ] Step 5.2: Default unchecked (audio on). When checked, `audioElement.muted = true` (audio continues for sync, just silent)
- [ ] Step 5.3: Not a persisted setting — resets to unchecked on song load
- [ ] Step 5.4: Verify — check mute, play, confirm no audio but notation still scrolls correctly. Uncheck, confirm audio returns.

## Phase 6: Snippet Hand Mode

- [ ] Step 6.1: Add radio button group to snippet UI: "Both" | "LH" | "RH" — defaults to "Both"
- [ ] Step 6.2: Store selection in `sam_song_snippets.settings` JSONB as `handMode: 'both' | 'lh' | 'rh'`
- [ ] Step 6.3: When snippet is active with LH or RH mode, note matching only evaluates beats from the selected hand. Inactive hand notes render normally but produce no hit/miss feedback and no color changes.
- [ ] Step 6.4: Verify — create snippet with LH mode, play it, confirm only left hand notes trigger feedback. Play right hand notes alongside — confirm no penalty or color change on those notes.

## Phase 7: Snippet Label Spacing Bug

- [ ] Step 7.1: Fix missing space between snippet name and measure range (e.g., "Intro m.1-4" not "Introm.1-4")
- [ ] Step 7.2: Verify — check snippet labels display correctly

---

## Notes
_Space for notes during execution_

