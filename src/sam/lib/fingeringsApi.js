// Data layer for RH fingering cues (sam_song_fingerings).
//
// Fingerings live ONLY in this sidecar table — never inside sam_song_measures.rh
// event objects and never in the sam_songs.measures blob (see spec §1). A row is
// keyed by the coordinate (song_id, measure_num, rh_index, note_index, source);
// `source` is 'manual' or 'musicxml' and both may coexist on one notehead.
//
// Frontend-only module: it imports the shared authenticated client directly (like
// AudioToolbar). measureCompiler takes `supabase` as a param instead only because
// it is reused server-side by a Node script with a service-role client; the edit
// screen has no such second caller.
import { supabase } from "../../supabaseClient";

// Coordinate ↔ key. `noteIndex` defaults to 0 (single-note events). The key is
// source-agnostic on purpose: one coordinate can hold a manual AND a musicxml
// row, and resolution (below) picks between them.
export function fingeringKey(coord) {
  return `${coord.measureNum}:${coord.rhIndex}:${coord.noteIndex ?? 0}`;
}

// Load every fingering for a song into a coordinate-keyed lookup:
//   { "measure:rhIndex:noteIndex": { manual: row|null, musicxml: row|null } }
// Holding both sources per coordinate is what lets clearing a manual override
// re-reveal an imported fingering (spec §3) without a second fetch.
export async function loadFingerings(songId) {
  const { data, error } = await supabase
    .from("sam_song_fingerings")
    .select("measure_num, rh_index, note_index, finger, source, updated_at")
    .eq("song_id", songId)
    .order("measure_num", { ascending: true })
    .order("rh_index", { ascending: true });

  if (error) throw new Error("Failed to load fingerings: " + error.message);

  const byCoord = {};
  for (const row of data || []) {
    const key = fingeringKey({
      measureNum: row.measure_num,
      rhIndex: row.rh_index,
      noteIndex: row.note_index,
    });
    if (!byCoord[key]) byCoord[key] = { manual: null, musicxml: null };
    byCoord[key][row.source] = row;
  }
  return byCoord;
}

// Upsert a manual fingering at a coordinate. Conflict target is the FULL
// coordinate including source, so this only ever touches the 'manual' row and
// leaves any 'musicxml' row at the same coordinate untouched (spec §3).
//
// updated_at is set explicitly: the column defaults to now() on INSERT, but no
// trigger bumps it on UPDATE (spec §3), so re-setting a finger would otherwise
// leave updated_at stale. Returns the persisted row.
export async function setFingering(songId, coord, finger) {
  const row = {
    song_id: songId,
    measure_num: coord.measureNum,
    rh_index: coord.rhIndex,
    note_index: coord.noteIndex ?? 0,
    finger,
    source: "manual",
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("sam_song_fingerings")
    .upsert(row, { onConflict: "song_id,measure_num,rh_index,note_index,source" })
    .select("measure_num, rh_index, note_index, finger, source, updated_at")
    .single();

  if (error) throw new Error("Failed to set fingering: " + error.message);
  return data;
}

// Delete the MANUAL row at a coordinate only. An imported ('musicxml') row at the
// same coordinate is deliberately left in place — clearing means "remove my
// override", not "suppress the source" (spec §3).
export async function clearFingering(songId, coord) {
  const { error } = await supabase
    .from("sam_song_fingerings")
    .delete()
    .eq("song_id", songId)
    .eq("measure_num", coord.measureNum)
    .eq("rh_index", coord.rhIndex)
    .eq("note_index", coord.noteIndex ?? 0)
    .eq("source", "manual");

  if (error) throw new Error("Failed to clear fingering: " + error.message);
}

// Write imported fingerings for a song (spec §6). Replaces this song's
// 'musicxml' rows and never touches 'manual' rows, so a re-import refreshes
// the source cues while manual overrides survive. `fingerings` is the parser's
// parallel array: [{ measureNum, rhIndex, noteIndex, finger }]. Returns the
// number of rows written.
//
// A row MAY additionally carry `source`, which is then honoured. Parser output
// never does, so MusicXML import is unchanged; a JSON export does, so a
// round-tripped song keeps its manual fingerings manual instead of having them
// silently relabelled as editorial. Note the delete above only clears
// 'musicxml' — a document carrying manual rows is by definition an import into
// a fresh song, which has no rows to collide with.
export async function importMusicxmlFingerings(songId, fingerings) {
  const { error: delErr } = await supabase
    .from("sam_song_fingerings")
    .delete()
    .eq("song_id", songId)
    .eq("source", "musicxml");
  if (delErr) throw new Error("Failed to clear imported fingerings: " + delErr.message);

  if (!fingerings || fingerings.length === 0) return 0;

  const rows = fingerings.map((f) => ({
    song_id: songId,
    measure_num: f.measureNum,
    rh_index: f.rhIndex,
    note_index: f.noteIndex ?? 0,
    finger: f.finger,
    source: f.source === "manual" ? "manual" : "musicxml",
    updated_at: new Date().toISOString(),
  }));
  const { error: insErr } = await supabase
    .from("sam_song_fingerings")
    .insert(rows);
  if (insErr) throw new Error("Failed to write imported fingerings: " + insErr.message);
  return rows.length;
}

// Render precedence for one coordinate entry (spec §3):
//   - a manual row always wins, regardless of the toggle;
//   - a musicxml row shows only when show_imported_fingerings is on AND no manual
//     row exists at the coordinate.
// Returns the finger number to render, or null if nothing should render.
export function resolveFinger(entry, showImported) {
  if (!entry) return null;
  if (entry.manual) return entry.manual.finger;
  if (entry.musicxml && showImported) return entry.musicxml.finger;
  return null;
}

// Resolve a whole loadFingerings() map into a flat render lookup
// { "measure:rhIndex:noteIndex": finger }, omitting coordinates that resolve to
// nothing. This is what the overlay layer (Step 3) consumes.
export function resolveFingerings(byCoord, showImported) {
  const out = {};
  for (const [key, entry] of Object.entries(byCoord || {})) {
    const finger = resolveFinger(entry, showImported);
    if (finger != null) out[key] = finger;
  }
  return out;
}
