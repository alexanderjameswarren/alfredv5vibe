# Progress: Drive Mix

Project code: `drive_mix-v7r`
Spec: docs/technical-spec-drive_mix-v7r.md

## Status: In Progress — Step 5 built, awaiting Checkpoint and Surface refresh

### Development Steps
- [x] Step 1: Read-only plan — files, database items, claims check (s1)
- [x] Step 2: Confirm and claim (s2)
- [x] Step 3: Database — tables, picker, simulator and sweep functions; register_table; CONFORMANT (just-in-time database step, Checkpoint) — migration 095 applied 2026-10-07; CONFORMANT (51 tables); drive_mix_pick on the empty pool returns []
- [ ] Step 4: Alfred MCP tools (section 5 of the spec); deploy; verify in a fresh thread — 8 tools in dj-drive-mix.ts, deployed 2026-10-07 as mcp v141 (verify_jwt false); tests green (15 handler, 25 index, 2092 app, 174 scripts); fresh-thread test pending
- [ ] Step 5: Workshop `get_dj_artist_top_songs` tool — lives in this repo's workshop/ folder (not a separate repo), in workshop/workshop/tools/dj_write.py beside search_dj_music. Built 2026-10-07 and live on the Surface. Live testing found duplicates, re-recordings and an empty year field, so it was reworked to rank by YouTube Music play counts: dedupe, variant flags, representative choice, original_candidate, and suggested thresholds (spec §6). Then made concurrent (5 at a time) with a 25s time budget: live calls now take 6-8s instead of 20-24s. Workshop tests 261/261 pass.
- [ ] Step 6: On the Surface, calls took 23-27s. Fix: scan default 30, concurrency 8, and a 20s budget covering the whole call; guest credits are never suggested; Workshop tests 265/265. The picker's oldest slice becomes 1980s-and-earlier (decade ≤ 1980), and fill_only is gone. Migration 097 applied 2026-10-08: CONFORMANT; today's pick is 1980s-and-earlier 8, 1990s-2000s 27, 2010s-2020s 10, country_rap 5. Active pool by slice: 68 / 500 / 334 / 163 (about 1,065). mcp deployed as v142 (verify_jwt false). Checkpointed.
- [ ] Step 7: Picker gains carry-over (unheard songs from the last serving go first), an artist cooldown driven by listening (default 2 days), and new quotas 6/10/22/12. The simulator models both and reports days_appeared and heard_gap. Then made length-independent (count 1–200, quotas scale, cap ceil(count/25)), with the cooldown changed to a preference with a last-resort pass. Migration 098 applied 2026-10-08: CONFORMANT. Simulations at heard 50 and 15, and a 170-song pick, are recorded in spec §4. Timing: pick 451 ms; simulate about 0.8 ms per song-day. get_drive_mix_simulation refuses days × count > 6,000 (8s role timeout). mcp deployed as v143 (verify_jwt false). Tests 45/45, app 2092, scripts 174. Awaiting Checkpoint. Awaiting Checkpoint, Refresh Workshop, and the fresh-thread check.
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
