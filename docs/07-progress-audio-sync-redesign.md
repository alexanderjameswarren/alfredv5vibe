# Progress: Audio Sync Redesign

## Status: In Progress

### Prerequisites (Manual — do before CLI)
- [x] Run SQL migration: migrate audio_lead_in_ms to audio_offset_ms on measure 1
- [x] Run SQL migration: migrate playback_bpm to playback_speed
- [x] Run SQL: add playback_speed column
- [x] Run SQL: drop playback_bpm and audio_lead_in_ms columns
- [x] Verify schema changes

### Development Steps
- [x] Step 1: Update SamPlayer — remove deprecated state (audioLeadInMs, defaultBpm as separate state), add playbackSpeed state, update audio playback rate to use playbackSpeed/100
- [x] Step 2: Update SamPlayer — build audioAnchors array from activeMeasures, compute audioDurationMs from audioElement
- [x] Step 3: Update SettingsBar — replace Playback BPM and Lead-In ms fields with Playback Speed %. Conditionally show Speed % only when audio exists.
- [x] Step 4: Update SongLoader/handleSongLoaded — read playback_speed from song, stop reading playback_bpm and audio_lead_in_ms
- [x] Step 5: Update ScrollEngine — accept new props (audioAnchors), remove deprecated prop (audioLeadInMs)
- [x] Step 6: Update ScrollEngine init — build audioMsToBeatPos function from anchors (piecewise-linear interpolation)
- [x] Step 7: Update ScrollEngine frame() — audio mode derives elapsed from audioElement.currentTime via audioMsToBeatPos → beatPos * msPerBeat
- [x] Step 8: Update ScrollEngine frame() — no-audio mode unchanged, uses global pxPerMs from BPM
- [x] Step 9: Update SamPlayer play/pause/resume — verified compatible with anchor-based sync (audioSyncOffset bridge handles timing)
- [ ] Step 10: Test with Someone Like You (audio, one anchor on measure 1)
- [ ] Step 11: Test with Someone Like You (audio, multiple anchors)
- [ ] Step 12: Test with a no-audio song (BPM mode)
- [ ] Step 13: Test snippet playback with audio
- [ ] Step 14: Clean up — remove any remaining references to playback_bpm, audio_lead_in_ms, scrollPrerollMs

### Notes
- Steps 1, 3, 4 completed together since they are tightly coupled (removing deprecated DB columns that are already dropped would break the app if done piecemeal)
- audioLeadInMs references in SamPlayer replaced with `activeMeasures[0]?.audioOffsetMs ?? 0` (measure 1's audio_offset_ms)
- defaultBpm references replaced with `song.defaultBpm || bpm` (read from song object, not separate state)
- SettingsBar: Speed % input only shown when audioElement exists; edit modal now has "Playback Speed %" instead of "Playback BPM"
- SongLoader: library query and edit modal updated to use playback_speed instead of playback_bpm/audio_lead_in_ms
- ScrollEngine now receives audioAnchors prop instead of audioLeadInMs. audioMsToBeatPos() converts audio timestamps to beat positions via piecewise-linear interpolation between anchors (1 anchor = BPM rate, 2+ = per-segment rate). Loop seek uses audioAnchors[0].audioMs.
