# Project Context

Sam is a React piano practice app with Supabase backend. We recently implemented a data layer normalization (measure fan-out, session events, audio upload/caching, scroll sync). This round of changes refines audio controls, adds BPM-driven playback speed, and adds hand-mode filtering for snippets.

The Supabase schema migration has already been run. Two new columns exist on `sam_songs`: `playback_bpm` (int, backfilled from default_bpm) and `audio_lead_in_ms` (int, default 0).

# Reference Documents

- Progress tracking: docs/progress-sam-post-impl.md

# Your Task

1. Review the progress tracking file
2. Execute the first incomplete step (Phase 2, Step 2.1)
3. After completing each step, update the progress file
4. Provide clear verification instructions for the human
5. Wait for verification before proceeding to the next step

# Key Implementation Details

## Phase 2: BPM-Driven Playback Speed

The core concept: each song has two BPM values.
- `default_bpm` = the native tempo of the MP3 recording (e.g., 68 for Someone Like You)
- `playback_bpm` = the tempo the user wants to practice at (starts equal to default_bpm)

The audio playback rate is always: `playbackRate = playback_bpm / default_bpm`

When `playback_bpm === default_bpm`, rate is 1.0 (normal speed). User sets playback_bpm to 34, rate becomes 0.5 (half speed). Always set `audioElement.preservesPitch = true`.

Changes needed:
- Remove any standalone playback speed / tempo slider from AudioControls
- Add `playback_bpm` as an editable field in the song form (wherever default_bpm is edited)
- Song form should show both fields: "Default BPM" (native recording tempo) and "Playback BPM" (practice tempo)
- The scroll engine should use `playback_bpm` for scroll speed calculation
- The audio element playback rate should be derived from the ratio

## Phase 3: Audio Lead-In + Elapsed Time Display

`audio_lead_in_ms` is stored on `sam_songs`. It represents how many milliseconds from the start of the audio file until measure 1, beat 1 of the notation begins.

- Positive value (common): audio has an intro before the piano part starts. Audio plays first, notation waits.
- Negative value (rare): notation starts before the audio.
- Zero: audio and notation start simultaneously.

**Song form:** Add `audio_lead_in_ms` as an editable field (labeled something like "Audio Lead-In (ms)").

**Elapsed time display:** When in Stopped mode, the audio controls area should display the current elapsed time in milliseconds as the audio plays or is scrubbed. This is for the calibration workflow: user plays audio in stopped mode, listens for the downbeat, pauses, reads the ms value, enters it into the lead-in field.

**Play from top:** When user hits the main Play button:
1. Start audio from position 0 (or wherever it was seeked to in stopped mode)
2. Start a timer for `audio_lead_in_ms` milliseconds
3. After the timer fires, begin notation scrolling

**Play from snippet:** When starting from a snippet at measure N:
1. Calculate the audio position for measure N: `audio_lead_in_ms_ms + time_to_measure_N`
   - `time_to_measure_N` can be calculated from BPM and time signatures of preceding measures
   - Or if measure N has a non-null `audio_offset_ms` in `sam_song_measures`, use: `audio_lead_in_ms + audio_offset_ms`
2. Seek audio to that position
3. Start both audio and notation simultaneously (no lead-in delay needed, we're past the intro)

## Phase 4: Audio State Machine

Audio playback is fully subordinate to the existing play/pause/stop state:

**Stopped mode:**
- Audio controls visible: play/pause button, seek bar, elapsed ms display
- User can play audio independently for calibration
- User can scrub/seek to any position
- Notation does NOT scroll in this mode

**Play mode:**
- NO independent audio controls visible
- Audio plays automatically (started by the play action, respecting lead-in)
- Audio speed = playback_bpm / default_bpm

**Pause mode:**
- NO independent audio controls visible
- Audio pauses when the user pauses
- Audio resumes when the user resumes (hits Play again)

**Stop action (from Play or Pause):**
- Audio stops and resets
- Returns to Stopped mode with full audio controls

## Phase 5: Mute Checkbox

- Simple checkbox in the audio area
- Visible in Stopped mode and Pause mode only. Hidden during Play mode.
- Default: unchecked (audio plays normally)
- When checked: `audioElement.muted = true` — audio still plays in background to maintain sync, but user hears only their own piano
- NOT a persisted setting — resets to unchecked every time a song loads
- Use case: user wants to practice a tricky section hearing only their own playing

## Phase 6: Snippet Hand Mode

Add a radio button group to the snippet panel/editor with three options: "Both", "LH", "RH". Defaults to "Both".

**Storage:** Save in the existing `sam_song_snippets.settings` JSONB column as `handMode`. Example:
```json
{ "handMode": "lh" }
```

If `settings` is null or `handMode` is missing, treat as "both" (backward compatible).

**Behavior when LH or RH is selected:**
- Score rendering is UNCHANGED — both hands still display normally
- Note matching/evaluation only applies to beats from the selected hand
- Only the selected hand's notes change color on hit/miss
- The other hand's notes remain in their default color regardless of what the user plays
- Session events should still record which hand mode was active (add to the event or session metadata for analytics)

**How to determine which hand a beat belongs to:**
- The measures data has separate `rh` and `lh` voice arrays
- When building the expected notes for matching, filter by the active hand mode
- "Both" = all notes from both voices (current behavior)
- "LH" = only notes from the `lh` voice array
- "RH" = only notes from the `rh` voice array

## Phase 7: Snippet Label Spacing Bug

There's a missing space between the snippet title and the measure range indicator. For example it currently shows "Introm.1-4" instead of "Intro m.1-4". Find where the snippet label is rendered (likely in SnippetPanel.jsx) and add the space.

# Verification Pattern

After each step, ask me to:
- Open the app in browser
- Perform specific actions
- Confirm expected behavior in the UI
- Check Supabase if relevant

Only proceed to the next step after I confirm verification is successful.

# Important

- Update the progress file after each step
- Add notes about any decisions or issues encountered
- The app uses Vite for dev server
- Supabase client is already configured
- The existing play/pause/stop state machine should not be restructured — audio hooks into it
- `sam_song_snippets.settings` is an existing JSONB column — just add handMode to it
- Stop and ask if anything is unclear
