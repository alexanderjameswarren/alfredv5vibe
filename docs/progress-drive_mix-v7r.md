# Progress: Drive Mix

Project code: `drive_mix-v7r`
Spec: docs/technical-spec-drive_mix-v7r.md

## Status: Live (2026-10-08) — step 9 open

### Development Steps
- [x] Step 1: Read-only plan — files, database items, claims check (s1)
- [x] Step 2: Confirm and claim (s2)
- [x] Step 3: Database — tables, picker, simulator and sweep functions; register_table; CONFORMANT — migration 095 applied 2026-10-07
- [x] Step 4: Alfred MCP tools (spec §5) — 8 tools in supabase/functions/_shared/tools/dj-drive-mix.ts; first deployed 2026-10-07 as mcp v141, now v143
- [x] Step 5: Workshop `get_dj_artist_top_songs` (spec §6) — in this repo's workshop/ folder (workshop/workshop/tools/dj_write.py), not a separate repo; live on the Surface
- [x] Step 6: Seed the pool in chat — playlists, artist list, heavy-play artists, history sweep; Alex reviewed
- [x] Step 7: Dry runs in chat — simulations used to tune quotas, cooldown and carry-over (see build log, spec §4)
- [x] Step 8: Go live (2026-10-08)
  - The YouTube playlist "Drive Mix", id `PLbtyzvGuByeU`, PRIVATE. It is recorded in DJ as kind `utility` (dj_playlists id 5dffb7c9-fa3f-4490-8b5c-4cc53a772485).
  - The first serving was recorded for 2026-10-08.
  - The daily scheduled task "Drive Mix daily refresh" runs at 4:54 am Pacific: sweep, tag, pick, replace the playlist, record the serving. It posts an inbox item only on problems.
  - Chat procedures are in `.claude/skills/drive-mix/SKILL.md`.
- [ ] Step 9: Feedback — test whether skips appear in history; check whether thumbs-down can be read

### Build log (CLI rounds after the plan steps)
- **5d/5e (2026-10-07):** top-songs ranking reworked to YouTube Music play counts, with dedupe, variant flags, original_candidate and suggested thresholds. Then concurrent lookups with a time budget. Workshop tests 261.
- **6 (2026-10-07/08):**
  - Workshop: scan 30, concurrency 8, a 20s budget covering the whole call, and guest credits never suggested. Workshop tests 265.
  - Picker: the oldest slice became 1980s-and-earlier and fill_only went (migration 097). mcp v142.
- **7 (2026-10-08):** carry-over, a listening-driven artist cooldown (a preference, with a last-resort pass), quotas 6/10/12/22, and length independence (count 1–200, quotas scale, cap ceil(count/25)), in migration 098. `get_drive_mix_simulation` refuses days × count > 6,000. mcp v143.
- **8 (2026-10-08):** `get_drive_mix_pick` timed out through MCP: about 10 s as authenticated. Step 7's 451 ms had been measured as postgres, so RLS was bypassed.
  - The cause was the per-song correlated recency, whose OR join seq-scanned `dj_tracks` once per song.
  - Migration 099 makes recency set-based, with explicit user_id filters. As authenticated: pick 50 in 461 ms, pick 170 in 42 ms, a 30-day simulation in 1,150 ms.
  - Output hashes were identical to 098. No TypeScript change.

### Testing Steps
- [x] Picker returns the scaled slice counts (6/10/12/22 at 50, 20/34/41/75 at 170) — verified 2026-10-08
- [ ] Dry run and recorded serving for the same date match — superseded: a serving records the video_ids actually sent, not a re-pick
- [ ] Sweep skips jazz-tagged artists, "Release", and songs already pooled
- [x] Simulation numbers match the expected repeat interval — 60 days at heard 50: repeat_gap min 17, median 23

### Open items
- **(a) Afternoon and evening plays count a day late.** The DJ history sync runs at 10 am, so plays after that only reach dj_plays the next morning, after the 4:54 am refresh. Recency, carry-over and the cooldown see them a day late. If it matters in practice, the fix is an extra history sync before 4:54 am.
- **(b) The register_table owner policy uses an unwrapped `auth.uid()`.** It reads `user_id = auth.uid()`, not `(select auth.uid())`, so Postgres may evaluate it per row. That is a platform-wide performance fix, to scope as its own project; not changed here.

### Notes
- 2026-10-07: Spec corrected before step 3. The sweep trusts only active jazz tags, matched on the exact dj_tracks.artist. A serving records the video_ids that were sent, with no re-pick and no replace (tier 2). The simulator is stable and in-memory.
- The tool file is supabase/functions/_shared/tools/dj-drive-mix.ts: the dj- prefix keeps it real in mcp/index.test.mjs.
- Time picker and simulator queries as `authenticated` (spec §4, Performance), never as postgres.
