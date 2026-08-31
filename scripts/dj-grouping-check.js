// Canonical grouping check. Paste into the browser console on the Alfred tab.
//
// READ-ONLY. It issues SELECTs and nothing else.
//
// ===========================================================================
// WHAT WOULD MAKE THIS FAIL - stated before the numbers, per spec 11.1
// ===========================================================================
//
// The invariant, from dj-tracks.ts: within one match_key, EXACTLY ONE row has
// canonical_track_id = null (the leader, earliest inserted) and every other row
// points directly at it.
//
// !! WHAT THIS CHECK CANNOT TELL YOU (spec 11.12). It proves the grouping is
//    INTERNALLY CONSISTENT given the match_keys. It cannot prove the match_keys
//    are RIGHT, because it derives its expectation from the same column it is
//    checking. A wrong match_key, consistently applied, passes everything below.
//
//    That is not hypothetical: `release|deck the halls` groups two different
//    acts under a YouTube fallback channel label, has exactly one leader, no
//    chains and no cross-key pointers - and this check passed it.
//
//    Correctness needs a source OUTSIDE dj_tracks. Do not report a clean run
//    here as "grouping verified".
//
// This check FAILS, loudly and by name, if any of these is non-empty:
//
//   UNDER-FIRED  a match_key with 2+ tracks that has more than one leader.
//                Variants sitting in separate groups - the thing we are
//                actually looking for.
//   CROSS-KEY    a row pointing at a leader with a DIFFERENT match_key.
//                Mechanical over-firing: two songs merged that never shared a key.
//   CHAINED      a row pointing at another row that itself points elsewhere.
//                The code points at the group leader, never at a variant.
//   DANGLING     a row pointing at an id that is not in dj_tracks.
//
// If grouping had never run at all, EVERY multi-track match_key would appear
// under UNDER-FIRED - so a clean result is informative rather than vacuous.
// A count on its own is not: 255 groups would be reported whether or not the
// links were written, which is why the invariant is checked per group and the
// links are counted separately.
//
// EXPECTED, computed offline from the batch files with the real buildMatchKey,
// independently of whatever the database says:
//
//        match_keys with >1 track   255
//        tracks inside those         556
//        links (members - leaders)   301
//
// The database also holds poll-only tracks absent from the export, so its
// numbers may be slightly HIGHER. Materially LOWER means under-firing.
// ===========================================================================

(async () => {
  const sb = window.supabase;
  if (!sb) return console.error("window.supabase not found - are you on the Alfred tab, signed in?");

  // Page explicitly. PostgREST caps a request at 1000 rows and would otherwise
  // silently hand back a truncated table, which every count below would then
  // be computed from.
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("dj_tracks")
      .select("id,video_id,title,artist,match_key,canonical_track_id")
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) return console.error("query failed:", error);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`dj_tracks rows read: ${rows.length}`);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const byKey = new Map();
  for (const r of rows) {
    if (!r.match_key) continue;
    if (!byKey.has(r.match_key)) byKey.set(r.match_key, []);
    byKey.get(r.match_key).push(r);
  }

  const underFired = [], crossKey = [], chained = [], dangling = [];

  for (const r of rows) {
    if (!r.canonical_track_id) continue;
    const target = byId.get(r.canonical_track_id);
    if (!target) { dangling.push({ video_id: r.video_id, title: r.title, points_at: r.canonical_track_id }); continue; }
    if (target.canonical_track_id) {
      chained.push({ video_id: r.video_id, title: r.title, points_at: target.video_id, which_points_at: target.canonical_track_id });
    }
    if (target.match_key !== r.match_key) {
      crossKey.push({ video_id: r.video_id, title: r.title, key: r.match_key, target: target.title, target_key: target.match_key });
    }
  }

  const groups = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    groups.push({ key, members });
    const leaders = members.filter((m) => !m.canonical_track_id);
    if (leaders.length !== 1) {
      underFired.push({
        key,
        members: members.length,
        leaders: leaders.length,
        titles: members.map((m) => `${m.video_id} ${JSON.stringify(m.title)}${m.canonical_track_id ? "" : "  <-LEADER"}`),
      });
    }
  }

  const tracksInGroups = groups.reduce((a, g) => a + g.members.length, 0);
  const links = rows.filter((r) => r.canonical_track_id).length;

  console.log("\n=== COUNTS ===");
  console.table({
    "match_keys with >1 track": { actual: groups.length, expected: 255 },
    "tracks inside those groups": { actual: tracksInGroups, expected: 556 },
    "canonical links (non-null)": { actual: links, expected: 301 },
    "tracks with null match_key": { actual: rows.filter((r) => !r.match_key).length, expected: "2 (+poll)" },
  });

  console.log("\n=== FAILURE LISTS - all four must be empty ===");
  const fails = { UNDER_FIRED: underFired, CROSS_KEY: crossKey, CHAINED: chained, DANGLING: dangling };
  let bad = 0;
  for (const [name, list] of Object.entries(fails)) {
    bad += list.length;
    if (list.length) { console.error(`${name}: ${list.length}`); console.log(list); }
    else console.log(`${name}: 0  ok`);
  }
  console.log(bad === 0
    ? "%cGROUPING IS INTERNALLY CONSISTENT - the invariant holds for every group"
    : `%cGROUPING BROKEN - ${bad} violation(s) above`,
    `color:${bad === 0 ? "green" : "red"};font-weight:bold`);
  if (bad === 0) {
    console.log("%cThis is NOT a correctness result. See spec 11.12.",
      "color:#b58900;font-weight:bold");
    console.log("A WRONG match_key, consistently applied, passes every check above:");
    console.log("  e.g. `release|deck the halls` groups two different acts, has exactly");
    console.log("  one leader, no chains and no cross-key pointers - and is wrong.");
    console.log("Correctness needs a source OUTSIDE dj_tracks: the channel id, YouTube");
    console.log("Music's own artist metadata, or a human reading the groups below.");
  }

  console.log("\n=== THE 15 LARGEST GROUPS - eyeball these for OVER-FIRING ===");
  console.log("Live/acoustic/remaster folding into the studio track is intended.");
  console.log("What to look for: DIFFERENT SONGS sharing a key, or a cover by the");
  console.log("same artist merged with the original.");
  for (const g of groups.sort((a, b) => b.members.length - a.members.length).slice(0, 15)) {
    console.groupCollapsed(`${g.members.length}x  ${g.key}`);
    console.table(g.members.map((m) => ({
      video_id: m.video_id, title: m.title, artist: m.artist,
      role: m.canonical_track_id ? "variant" : "LEADER (what you will see)",
    })));
    console.groupEnd();
  }
})();
