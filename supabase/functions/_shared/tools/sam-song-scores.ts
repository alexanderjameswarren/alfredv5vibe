// ============================================================================
// supabase/functions/_shared/tools/sam-song-scores.ts
//
// get_sam_song_scores — tier 1. Per-measure difficulty scores for one SAM song
// at a tempo, with a rollup. Analyzer port M5
// (docs/technical-spec-analyzer-port.md §4).
//
// ⚠ A get_* TOOL THAT WRITES. Before reading, it brings the song's
// sam_song_scores rows up to date (computeSongScores). Those rows are derived
// data — the table's own comment says they are safe to delete and recompute —
// and the table is not audited, so the refresh is invisible in the audit log.
// That departs from the verb naming convention on purpose: stale scores must
// never be returned silently, and a separate "compute first" call would be
// forgotten. The tool description says so too.
//
// The logic lives in ../samScoresRead.ts; this file only binds it to ctx.db.
// ============================================================================

import { defineTool, envelope } from "../platform.ts";
import { readSongScores } from "../samScoresRead.ts";

export const getSamSongScoresTool = defineTool({
  name: "get_sam_song_scores",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const { data, meta } = await readSongScores(ctx.db, args);
    return envelope(data, meta);
  },
});
