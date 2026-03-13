# Project Context

We're redesigning SAM's audio sync system. Currently, scroll speed is derived from a `playbackBpm / defaultBpm` ratio, with `audio_lead_in_ms` controlling where notation starts in the audio. This causes drift because the recording's tempo isn't perfectly constant.

The new design uses audio anchor points (`audio_offset_ms` on individual measures) to derive scroll speed per-section, plus a single `playback_speed` percentage control (100 = original speed). Songs without audio still use BPM-driven scrolling.

# Reference Documents
- Technical spec: docs/06-spec-audio-sync-redesign.md
- Progress tracking: docs/07-progress-audio-sync-redesign.md

# Your Task
1. Read the technical specification to understand the full scope
2. Review the progress tracking file
3. Execute the first incomplete step
4. After completing the step, update the progress file
5. Provide verification instructions

# Key Files
- `src/sam/SamPlayer.jsx` — main player component, handles play/pause/resume, audio coordination
- `src/sam/components/ScrollEngine.jsx` — scroll animation, frame loop, miss detection
- `src/sam/components/SettingsBar.jsx` — BPM, speed, and timing controls UI
- `src/sam/components/SongLoader.jsx` — loads songs from Supabase
- `src/sam/lib/measureUtils.js` — getMeasDurationQ and normalizeMeasure
- `src/sam/lib/audioPlayer.js` — loadAudio and uploadAudio
- `src/sam/lib/measureCompiler.js` — fan-out and recompile

# Critical Constraints
- Two distinct scroll modes: audio mode (anchor-based) and no-audio mode (BPM-based)
- In audio mode, scroll speed is derived from anchor points, NOT from BPM
- `playback_speed` is an integer percentage (100 = original). The audio playback rate is `playbackSpeed / 100`
- `default_bpm` is only used for no-audio mode scroll speed. In audio mode it's informational only.
- The `audioAnchors` array should be built in SamPlayer and passed to ScrollEngine as a prop
- If a song has audio but no audio_offset_ms on any measure, fall back to no-audio BPM mode
- The end anchor is always `audioElement.duration * 1000` — do not store it
- Miss detection must still work — precompute targetTimeMs per beat using per-segment speeds

# Verification Pattern
After completing each step, ask me to:
- Open the app and load a specific song
- Perform specific actions (be explicit about what to click/check)
- Confirm expected behavior

Only proceed to the next step after I confirm verification is successful.

# Important
- Mark steps complete in the progress file as you finish them
- Add notes about any decisions or issues encountered
- If you need clarification, stop and ask
- The `playback_bpm` and `audio_lead_in_ms` columns have already been dropped from the database. References to these fields in the code will cause errors — remove or replace them all.
- The `playback_speed` column has been added to `sam_songs` with default 100.
