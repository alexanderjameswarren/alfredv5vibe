# Progress: Drive Mix

Project code: `drive_mix-v7r`
Spec: docs/technical-spec-drive_mix-v7r.md

## Status: In Progress — Step 4 deployed (mcp v141), awaiting fresh-thread test

### Development Steps
- [x] Step 1: Read-only plan — files, database items, claims check (s1)
- [x] Step 2: Confirm and claim (s2)
- [x] Step 3: Database — tables, picker, simulator and sweep functions; register_table; CONFORMANT (just-in-time database step, Checkpoint) — migration 095 applied 2026-10-07; CONFORMANT (51 tables); drive_mix_pick on the empty pool returns []
- [ ] Step 4: Alfred MCP tools (section 5 of the spec); deploy; verify in a fresh thread — 8 tools in dj-drive-mix.ts, deployed 2026-10-07 as mcp v141 (verify_jwt false); tests green (15 handler, 25 index, 2092 app, 174 scripts); fresh-thread test pending
- [ ] Step 5: Workshop `get_dj_artist_top_songs` tool (Workshop repo, own prompt)
- [ ] Step 6: Seed the pool in chat — playlists, artist list, heavy-play artists; Alex reviews
- [ ] Step 7: Dry runs in chat — simulate 60 days, tune artist cap and quotas
- [ ] Step 8: Go live — create Drive Mix playlist; set up the daily scheduled task
- [ ] Step 9: Feedback — test whether skips appear in history; check whether thumbs-down can be read

### Testing Steps
- [ ] Picker returns 50 songs with correct slice counts and no adjacent same artist
- [ ] Dry run and recorded serving for the same date match
- [ ] Sweep skips jazz-tagged artists, "Release", and songs already pooled
- [ ] Simulation numbers match the expected repeat interval

### Notes
- 2026-10-07: Spec corrected before step 3. The sweep trusts only active jazz tags, matched on the exact dj_tracks.artist. A serving records the video_ids that were sent, with no re-pick and no replace (tier 2). The simulator is stable and in-memory, passing p_recency to the picker. p_quotas holds counts. A trigger, drive_mix_songs_set_artist_key, fills artist_key.
- Step 4 tool file is supabase/functions/_shared/tools/dj-drive-mix.ts: the dj- prefix keeps it real in mcp/index.test.mjs.
