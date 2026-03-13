# Progress: Audio Sync Redesign

## Status: Not Started

### Prerequisites (Manual — do before CLI)
- [ ] Run SQL migration: migrate audio_lead_in_ms to audio_offset_ms on measure 1
- [ ] Run SQL migration: migrate playback_bpm to playback_speed
- [ ] Run SQL: add playback_speed column
- [ ] Run SQL: drop playback_bpm and audio_lead_in_ms columns
- [ ] Verify schema changes

### Development Steps
- [ ] Step 1: Update SamPlayer — remove deprecated state (audioLeadInMs, defaultBpm as separate state), add playbackSpeed state, update audio playback rate to use playbackSpeed/100
- [ ] Step 2: Update SamPlayer — build audioAnchors array from activeMeasures, compute audioDurationMs from audioElement
- [ ] Step 3: Update SettingsBar — replace Playback BPM and Lead-In ms fields with Playback Speed %. Conditionally show Default BPM only when no audio.
- [ ] Step 4: Update SongLoader/handleSongLoaded — read playback_speed from song, stop reading playback_bpm and audio_lead_in_ms
- [ ] Step 5: Update ScrollEngine — accept new props (playbackSpeed, audioAnchors, audioDurationMs), remove deprecated props (audioLeadInMs, scrollPrerollMs)
- [ ] Step 6: Update ScrollEngine init — build segments array from anchors, compute per-segment pxPerMs, compute per-beat targetTimeMs using segments
- [ ] Step 7: Update ScrollEngine frame() — audio mode derives scroll position from audioElement.currentTime via segment interpolation
- [ ] Step 8: Update ScrollEngine frame() — no-audio mode unchanged, uses global pxPerMs from BPM
- [ ] Step 9: Update SamPlayer play/pause/resume — rework audio delay and approach time for anchor-based sync
- [ ] Step 10: Test with Someone Like You (audio, one anchor on measure 1)
- [ ] Step 11: Test with Someone Like You (audio, multiple anchors)
- [ ] Step 12: Test with a no-audio song (BPM mode)
- [ ] Step 13: Test snippet playback with audio
- [ ] Step 14: Clean up — remove any remaining references to playback_bpm, audio_lead_in_ms, scrollPrerollMs

### Notes
[Space for notes during execution]
