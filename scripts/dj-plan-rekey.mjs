// Turn 074's dump into the backfill migration. READ-ONLY: it touches no
// database, it writes one .sql file for Alex to run by hand.
//
// ⚠️ WHY THIS EXISTS RATHER THAN SQL. The new match_key must be computed by the
// SAME functions the deployed code uses — splitArtistByline (with its
// COMMA_ARTIST_NAMES exception), canonicalArtist (the alias map) and
// normalisePart. 073 approximated normalisePart in SQL and proposed
// "Earth, Wind & Fire" -> `earth`, which is the §14.6 two-runtimes drift
// arriving exactly where it does the most damage: a frozen key.
//
//   node --experimental-strip-types scripts/dj-plan-rekey.mjs <074-result.json>
//
// The input is the single `result` cell from 074, saved to a file. Either the
// bare object or {"result": {...}} is accepted.

import { readFileSync, writeFileSync } from "node:fs";
import {
  buildMatchKey,
  splitArtistByline,
} from "../supabase/functions/_shared/tools/dj-normalise.ts";

// The six from migration 072. Their stored artist is repaired by 072, so the
// dump may still show "Various Artists" and the new key must be computed from
// the CORRECTED byline. 072 MUST run first; a guard below checks the dump.
const VARIOUS_SIX = new Set([
  "onvLuR7E5sM", "eapPwd8v5Xg", "5TvNzAe3oGo", "Pkn2rDQx0Ok", "GbEM3eJ5Isk", "dUt4eBkHWkY",
]);
const VARIOUS_SIX_ARTIST = "Charlie Parker, Dizzy Gillespie, Bud Powell, Max Roach";

// A byline that is a DATE, a view count, or another scraped page run rather
// than an act (§14.9). Re-keying "Dec 29, 2023" to `dec 29` is meaningless, so
// these are reported and EXCLUDED rather than repaired — the artist itself is
// wrong, and repairing it is a different migration with hand-built values.
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const NOT_AN_ARTIST = [
  new RegExp("^(?:" + MONTHS + ")[a-z]*\\.?\\s+\\d{1,2},\\s*\\d{4}$", "i"), // Dec 29, 2023
  /^\d[\d.,]*[km]?\s+views$/i,                                             // 1.7M views
  /^\d+\s+(?:songs?|videos?|tracks?)$/i,
];
const isNotAnArtist = (s) => NOT_AN_ARTIST.some((re) => re.test(String(s ?? "").trim()));

const [, , inPath, ...rest] = process.argv;
if (!inPath) {
  console.error("usage: node --experimental-strip-types scripts/dj-plan-rekey.mjs <074-result.json> [--out f.sql]");
  process.exit(1);
}
const outPath = rest.includes("--out")
  ? rest[rest.indexOf("--out") + 1]
  : "supabase/migrations/075_dj_tracks_rekey_album_bylines.sql";

const raw = JSON.parse(readFileSync(inPath, "utf-8"));
const d = raw.result ?? raw;
const candidates = d.candidates ?? [];
const neighbours = d.neighbours ?? [];
const albumWritten = new Set((d.album_written_video_ids ?? []).map((r) => r.video_id ?? r));

// A truncated dump would silently produce a partial re-key against a frozen key
// space, which is worse than no re-key at all.
if (candidates.length >= 1000 || neighbours.length >= 1000) {
  console.error("🛑 the dump is CAPPED at 1000 rows. Re-run 074 with a higher cap.");
  process.exit(1);
}
const sizes = (d.sizes ?? [])[0];
if (sizes && (sizes.candidates !== candidates.length || sizes.neighbours !== neighbours.length)) {
  console.error(`🛑 size mismatch: query counted ${sizes.candidates}/${sizes.neighbours}, dump carries ${candidates.length}/${neighbours.length}.`);
  process.exit(1);
}

// --- classify --------------------------------------------------------------
const rekey = [], unchanged = [], excluded = [];
for (const c of candidates) {
  const isSix = VARIOUS_SIX.has(c.video_id);
  const artist = isSix ? VARIOUS_SIX_ARTIST : c.artist;
  if (isSix && c.artist !== "Various Artists" && c.artist !== VARIOUS_SIX_ARTIST) {
    console.error(`🛑 ${c.video_id}: expected "Various Artists" or the repaired byline, found ${JSON.stringify(c.artist)}. Stop and re-check 072.`);
    process.exit(1);
  }
  const parts = splitArtistByline(artist);
  if (isNotAnArtist(artist) || parts.some(isNotAnArtist)) {
    excluded.push({ ...c, why: "scraped page run, not an act (§14.9)" });
    continue;
  }
  if (!isSix && !albumWritten.has(c.video_id)) {
    excluded.push({ ...c, why: "no dj_album_tracks row — the album path did not write it" });
    continue;
  }
  const newKey = buildMatchKey(parts, c.title);
  if (!newKey) { excluded.push({ ...c, why: "title normalises to nothing; no key derivable" }); continue; }
  if (newKey === c.match_key) { unchanged.push(c); continue; }
  rekey.push({ ...c, artist_used: artist, new_key: newKey });
}

// --- groups: what merges, and who leads afterwards -------------------------
const all = [...candidates, ...neighbours];
const keyAfter = new Map(all.map((r) => [r.video_id, r.match_key]));
for (const r of rekey) keyAfter.set(r.video_id, r.new_key);

const groupsAfter = new Map();
for (const r of all) {
  const k = keyAfter.get(r.video_id);
  if (!groupsAfter.has(k)) groupsAfter.set(k, []);
  groupsAfter.get(k).push(r);
}
const touchedKeys = new Set();
for (const r of rekey) { touchedKeys.add(r.match_key); touchedKeys.add(r.new_key); }

const merges = [];
for (const r of rekey) {
  const joining = (groupsAfter.get(r.new_key) ?? []).filter((x) => x.video_id !== r.video_id);
  if (joining.length > 0) {
    merges.push({ video_id: r.video_id, new_key: r.new_key, joins: joining.map((x) => x.video_id) });
  }
}

// --- report ----------------------------------------------------------------
const say = (h, rows, f) => {
  console.log(`\n${h} (${rows.length})`);
  for (const r of rows) console.log("  " + f(r));
};
console.log(`candidates ${candidates.length} | neighbours ${neighbours.length} | album-written ${albumWritten.size}`);
say("RE-KEY", rekey, (r) => `${r.video_id}  ${JSON.stringify(r.artist_used)}  ${r.match_key} -> ${r.new_key}`);
say("ALREADY CORRECT (no change)", unchanged, (r) => `${r.video_id}  ${JSON.stringify(r.artist)}  ${r.match_key}`);
say("EXCLUDED", excluded, (r) => `${r.video_id}  ${JSON.stringify(r.artist)}  - ${r.why}`);
say("MERGES INTO AN EXISTING GROUP", merges, (m) => `${m.video_id} -> ${m.new_key}  joins ${m.joins.join(", ")}`);

if (rekey.length === 0) { console.log("\nNothing to re-key. No migration written."); process.exit(0); }

// --- emit ------------------------------------------------------------------
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const ts = new Date().toISOString().slice(0, 10);

const lines = [];
const p = (s) => lines.push(s);
p("-- 075 - re-key the album-written bylines in dj_tracks (spec 4.1.2)");
p("--");
p("-- MOVED HEADER: ONE-OFF DATA REPAIR, applied once, in order, by hand.");
p("--");
p(`-- 🛑 GENERATED by scripts/dj-plan-rekey.mjs from 074's dump on ${ts}. Every`);
p("-- new_key below was computed by the DEPLOYED functions - splitArtistByline");
p("-- (with COMMA_ARTIST_NAMES), canonicalArtist, normalisePart - never by SQL.");
p("-- Do not hand-edit a key here; change the code and regenerate.");
p("--");
p("-- 🛑 RUN 072 FIRST. Six of these rows take their key from the byline 072");
p('-- writes. Running this first would key them from "Various Artists".');
p("--");
p(`-- SCOPE: ${rekey.length} rows re-keyed, ${touchedKeys.size} keys rebuilt, ${merges.length} joining an`);
p(`-- existing group. ${excluded.length} candidates EXCLUDED and not touched - listed at the end.`);
p("--");
p("-- HOW TO ROLL BACK: STEP 1 snapshots every affected row's id, match_key and");
p("-- canonical_track_id into a permanent table. To reverse:");
p("--   update public.dj_tracks t set match_key = s.old_match_key,");
p("--          canonical_track_id = s.old_canonical_track_id");
p("--     from public.dj_rekey_075_snapshot s where s.track_id = t.id;");
p("-- then re-run STEP 3. Nothing is deleted at any point.");
p("--");
p("-- AFTER RUNNING: node scripts/dj-grouping-check.js - CROSS_KEY MUST BE 0.");
p("");
p("-- ============================================================================");
p(`-- STEP 1 of 4 - snapshot. Nothing is changed. Expect: SELECT ${rekey.length}`);
p("-- ============================================================================");
p("create table if not exists public.dj_rekey_075_snapshot as");
p("select id as track_id, video_id, artist, match_key as old_match_key,");
p("       canonical_track_id as old_canonical_track_id, now() as snapshot_at");
p("from public.dj_tracks");
p("where video_id in (");
p(rekey.map((r) => "  " + q(r.video_id)).join(",\n"));
p(");");
p("");
p("-- ============================================================================");
p(`-- STEP 2 of 4 - re-key. Expect: UPDATE ${rekey.length}`);
p("-- Guarded on the OLD key, so a re-run cannot re-apply and a row that moved");
p("-- underneath us is skipped rather than overwritten.");
p("-- ============================================================================");
p("update public.dj_tracks t");
p("set match_key = v.new_key");
p("from (values");
// ⚠️ THE COMMA GOES BEFORE THE COMMENT. Joining these with ",\n" put the
// separator at the END of the trailing `-- <byline>`, where SQL reads it as
// part of the comment and the VALUES list loses its separators entirely.
p(rekey.map((r, i) =>
  `  (${q(r.video_id)}, ${q(r.match_key)}, ${q(r.new_key)})${i < rekey.length - 1 ? "," : ""}  -- ${r.artist_used}`
).join("\n"));
p(") as v(video_id, old_key, new_key)");
p("where t.video_id = v.video_id and t.match_key = v.old_key;");
p("");
p("-- ============================================================================");
p("-- STEP 3 of 4 - rebuild canonical grouping for the touched keys ONLY.");
p("-- Both the keys JOINED and the keys VACATED: a vacated key can lose its");
p("-- leader, and rebuilding around a stale leader is 007's Deck the Halls case.");
p("-- The rule is dj-tracks.ts's own - earliest created leads, id breaks a tie.");
p("-- ============================================================================");
p("with leaders as (");
p("  select distinct on (match_key) match_key, id");
p("  from public.dj_tracks");
p("  where match_key in (");
p([...touchedKeys].sort().map((k) => "    " + q(k)).join(",\n"));
p("  )");
p("  order by match_key, created_at asc, id asc");
p(")");
p("update public.dj_tracks t");
p("set canonical_track_id = case when t.id = l.id then null else l.id end");
p("from leaders l");
p("where t.match_key = l.match_key;");
p("");
p("-- ============================================================================");
p("-- STEP 4 of 4 - verify. Every column below must come back true.");
p("-- ============================================================================");
p("select");
p("  (select count(*) from public.dj_tracks t join public.dj_rekey_075_snapshot s");
p("     on s.track_id = t.id where t.match_key = s.old_match_key) = 0 as no_row_left_on_its_old_key,");
p(`  (select count(*) from public.dj_rekey_075_snapshot) = ${rekey.length} as snapshot_is_complete,`);
p("  (select count(*) from public.dj_tracks a join public.dj_tracks b");
p("     on a.canonical_track_id = b.id where a.match_key <> b.match_key) = 0 as no_cross_key_grouping,");
p("  (select count(*) from public.dj_tracks t where t.canonical_track_id = t.id) = 0 as no_self_reference;");
p("");
p("-- ============================================================================");
p(`-- EXCLUDED, and deliberately not touched (${excluded.length})`);
p("-- ============================================================================");
p(excluded.length === 0
  ? "-- (none)"
  : excluded.map((e) => `--   ${e.video_id}  ${JSON.stringify(e.artist)}  - ${e.why}`).join("\n"));
p("");

writeFileSync(outPath, lines.join("\n"));
console.log(`\nwrote ${outPath} - ${rekey.length} re-keys, ${touchedKeys.size} keys rebuilt, ${excluded.length} excluded`);
