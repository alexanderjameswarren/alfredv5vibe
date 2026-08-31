// "Release" audit — how far does the label-as-artist defect reach in dj_tracks?
// Paste into the browser console on the Alfred tab. READ-ONLY.
//
// CONTEXT. artist_disagreements fired on five Oscar Peterson tracks stored under
// artist "Release". The export is not at fault: the YouTube channel really is
// named "Release - Topic", so the parser did exactly the right thing with wrong
// source data.
//
// The export side is already measured: 61 rows, 42 distinct tracks, spread over
// TWENTY different channel ids — Miles Davis, Oscar Peterson, Dave Brubeck,
// Christmas carols and a Dr. Seuss soundtrack, all collapsed into one phantom
// act. This script measures the DATABASE side, which the export cannot answer:
// which rows actually landed, and whether the poll introduced any of its own.
//
// WHAT WOULD MAKE THIS INTERESTING, stated before the numbers:
//   - If the label-artist tracks are ALL source=takeout, the defect entered by
//     one path and the poll is clean.
//   - If ANY are source=poll, the live feed produces the same label and this
//     will keep happening daily, which changes it from a backfill question into
//     a guard-at-write-time question.
//   - If the count materially exceeds the export's 42, the poll has contributed
//     tracks the export never saw.

(async () => {
  const sb = window.supabase;
  if (!sb) return console.error("window.supabase not found — are you on the Alfred tab?");

  const LABELS = ["Release", "Album", "Single", "Song", "Video", "Playlist",
                  "Topic", "EP", "Mix", "Track", "Audio", "Music", "Various Artists"];

  // --- Q3: every track whose artist is exactly a page-label word --------------
  const { data: sus, error: e1 } = await sb
    .from("dj_tracks")
    .select("id,video_id,title,artist,match_key")
    .in("artist", LABELS);
  if (e1) return console.error("suspect query failed:", e1);

  console.log(`%cTracks whose artist is exactly a page label: ${sus.length}`,
    "font-weight:bold");
  const byArtist = {};
  for (const r of sus) byArtist[r.artist] = (byArtist[r.artist] ?? 0) + 1;
  console.table(byArtist);

  // ⚠️ "Live" is deliberately NOT in LABELS. It is a real band — "I Alone",
  // "Selling The Drama" — and including it would have produced a false positive
  // that a naive fix would then have "corrected" into nonsense. Any rule built
  // from this list must be a list of KNOWN-BAD names, never a pattern.

  // --- Q1: what wrote them? source lives on dj_plays, not dj_tracks -----------
  const ids = sus.map((r) => r.id);
  const bySource = {};
  const perTrack = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb
      .from("dj_plays")
      .select("track_id,source,played_on")
      .in("track_id", ids.slice(i, i + 100));
    if (error) return console.error("plays query failed:", error);
    for (const p of data) {
      bySource[p.source] = (bySource[p.source] ?? 0) + 1;
      (perTrack[p.track_id] ??= new Set()).add(p.source);
    }
  }
  console.log("\n%cPlay rows on those tracks, by source:", "font-weight:bold");
  console.table(bySource);
  const pollTracks = sus.filter((r) => perTrack[r.id]?.has("poll"));
  console.log(pollTracks.length === 0
    ? "%cNo poll rows — the defect entered entirely through the Takeout import."
    : `%c${pollTracks.length} track(s) have POLL plays — the LIVE FEED produces this too, so it will recur.`,
    `color:${pollTracks.length === 0 ? "green" : "red"};font-weight:bold`);
  if (pollTracks.length) console.table(pollTracks);

  // --- the frozen keys, which is what actually costs us ----------------------
  console.log("\n%cThe frozen match_keys — insert-only, so these are permanent:",
    "font-weight:bold");
  console.table(sus.slice(0, 50).map((r) => ({
    video_id: r.video_id, title: r.title, artist: r.artist, match_key: r.match_key,
  })));

  // --- is any REAL artist already present under the right name? --------------
  // Decides whether a repair would be a merge into an existing group or a new one.
  const { data: op, error: e3 } = await sb
    .from("dj_tracks")
    .select("video_id,title,artist")
    .or("artist.ilike.%Oscar Peterson%,artist.ilike.%Miles Davis%,artist.ilike.%Brubeck%");
  if (e3) return console.error("comparison query failed:", e3);
  console.log(`\n%cTracks already stored under the real artist names: ${op.length}`,
    "font-weight:bold");
  console.table(op.slice(0, 40));
})();
