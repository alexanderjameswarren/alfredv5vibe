#!/usr/bin/env node
// scripts/backfill-measures.mjs
//
// One-off backfill for songs whose `sam_songs.measures` blob is populated but
// which have ZERO rows in `sam_song_measures`. Victims of the pre-Step-1
// silent-fan-out bug: fan-out threw, the song row saved, no measure rows
// landed, no error surfaced. Step 1 stopped the bleeding; this script
// heals the historical rows.
//
// Usage (from repo root):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-measures.mjs
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-measures.mjs --apply
//
// Dry-run by default — prints affected songs, writes nothing.
// `--apply` runs the fan-out for real. Idempotent (fanOutMeasures deletes
// existing rows first), so safe to re-run.
//
// Uses the service-role key intentionally: the backfill spans all users'
// songs and RLS would filter the caller down to their own rows. This
// script is operator-only; do not embed the key in tracked files.

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(
    "Missing env. Required: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Get the service-role key from: Supabase dashboard → Project Settings → API → service_role.",
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// fanOutMeasures — inlined from src/sam/lib/measureCompiler.js
//
// Duplicated intentionally: the app module is ESM inside a CRA build tree
// with no `"type": "module"` in package.json, so Node treats its `.js`
// extension as CommonJS and fails to parse the `export` statements when
// imported from a `.mjs` script. The fan-out is small and stable; if the
// app-side logic changes, mirror it here.
//
// If this diverges from src/sam/lib/measureCompiler.js in a load-bearing
// way, prefer the app-side version — it's what production runs.
// ---------------------------------------------------------------------------
async function fanOutMeasures(songId, measuresArray, client) {
  // Idempotent — clear existing rows first.
  const { error: deleteError } = await client
    .from("sam_song_measures")
    .delete()
    .eq("song_id", songId);
  if (deleteError) throw deleteError;

  // Build rows. Uses `?? []` (not `||`) so an intentional empty-hand `[]`
  // survives. time_signature falls back to a real object so NOT NULL is
  // satisfied even if the blob's per-measure timeSignature is missing.
  const rows = measuresArray.map((m, i) => ({
    song_id: songId,
    number: i + 1,
    rh: m.rh ?? [],
    lh: m.lh ?? [],
    time_signature: m.timeSignature
      ? {
          beats: m.timeSignature.beats,
          beatType: m.timeSignature.beatType,
          ...(m.timeSignature.symbol ? { symbol: m.timeSignature.symbol } : {}),
        }
      : { beats: 4, beatType: 4 },
    ...(m.audioOffsetMs != null ? { audio_offset_ms: m.audioOffsetMs } : {}),
    ...(m.chord != null ? { chord: m.chord } : {}),
    ...(m.section != null ? { section: m.section } : {}),
  }));

  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await client
      .from("sam_song_measures")
      .insert(batch);
    if (insertError) throw insertError;
  }

  const now = new Date().toISOString();
  const { error: updateError } = await client
    .from("sam_songs")
    .update({ measures_compiled_at: now, measures_edited_at: now })
    .eq("id", songId);
  if (updateError) throw updateError;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}\n`);

  // Pull every song's id/title/measures. `measures` is a jsonb array; a
  // non-empty blob has array_length >= 1. Pulling the full blob is fine at
  // this repo's scale (single-digit hundreds of songs).
  const { data: songs, error } = await supabase
    .from("sam_songs")
    .select("id, title, measures")
    .order("title");
  if (error) {
    console.error("Failed to fetch songs:", error);
    process.exit(1);
  }

  const missing = []; // 0 rows — needs backfill per spec
  const partial = []; // 0 < rows < blob-length — reported, not touched
  const ok = []; // rows == blob-length

  for (const song of songs) {
    const blobLen = Array.isArray(song.measures) ? song.measures.length : 0;
    if (blobLen === 0) continue; // songs with empty blob are out of scope

    const { count, error: countErr } = await supabase
      .from("sam_song_measures")
      .select("id", { count: "exact", head: true })
      .eq("song_id", song.id);
    if (countErr) {
      console.error(`  ✗ count failed for ${song.id}:`, countErr.message);
      continue;
    }

    const rowCount = count ?? 0;
    const entry = { id: song.id, title: song.title, blob: blobLen, rows: rowCount };
    if (rowCount === 0) missing.push(entry);
    else if (rowCount < blobLen) partial.push(entry);
    else ok.push(entry);
  }

  // --- Report ---
  console.log(`Songs scanned: ${songs.length}`);
  console.log(`  OK (rows match blob):        ${ok.length}`);
  console.log(`  Partial (0 < rows < blob):   ${partial.length}`);
  console.log(`  Missing (0 rows, non-empty): ${missing.length}\n`);

  if (partial.length > 0) {
    console.log("Partial-backfill songs (not touched — inspect manually):");
    for (const s of partial) {
      console.log(
        `  ${s.title.padEnd(60)} blob=${s.blob} rows=${s.rows}  ${s.id}`,
      );
    }
    console.log();
  }

  if (missing.length === 0) {
    console.log("Nothing to backfill. Exiting.");
    return;
  }

  console.log(`${APPLY ? "Backfilling" : "Would backfill"} ${missing.length} song(s):`);
  for (const s of missing) {
    console.log(`  ${s.title.padEnd(60)} blob=${s.blob}  ${s.id}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply to write.");
    return;
  }

  // --- Apply ---
  console.log("\nWriting...");
  let succeeded = 0;
  let failed = 0;
  for (const s of missing) {
    // Re-fetch the blob for this song from the in-memory list we already
    // pulled; it's the same snapshot we counted against.
    const song = songs.find((x) => x.id === s.id);
    try {
      await fanOutMeasures(s.id, song.measures, supabase);
      console.log(`  ✓ ${s.title} — ${song.measures.length} measure(s) written`);
      succeeded++;
    } catch (e) {
      console.error(`  ✗ ${s.title}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\nDone. Succeeded: ${succeeded}. Failed: ${failed}.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
