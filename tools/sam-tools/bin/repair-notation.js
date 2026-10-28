#!/usr/bin/env node
//
// sam_xml_import step 6: repair stored songs in place with the new parser.
// Reads files only; touches no database. It writes SQL for Alex to run.
//
//   node bin/repair-notation.js <export> <xml-dir> [--song <id>] [--sql <file>] [--verify <file>] [--report <file>]
//
//   export       the `result` cell of supabase/tests/sam_xml_import-g4w/1_export_for_repair.sql,
//                as JSON or as the SQL editor's CSV download
//   --song       repair only this song id
//   xml-dir      the songs' stored source files, named <song id>.musicxml (as in the
//                sam-scores bucket) or by the song's original source_file name
//
// For each song: re-parse, compare each played measure with the stored rh/lh
// (notes, durations, tuplets, markings, unscored), and for changed measures only
// emit an UPDATE guarded on the stored value and on exactly one row. Fingering
// and lyric rows in changed measures move to the new rh_index of the same note
// (same onset and pitch); a row that cannot be matched is listed, never deleted.
// A song whose re-parse changes the measure count or numbering is skipped.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { readScoreXml } from "../lib/mxl.js";
import { tokenToBeats } from "../lib/durations.js";

globalThis.DOMParser ??= new JSDOM("").window.DOMParser;
const { parseMusicXML } = await import("../vendor/songParser.js");

const EPS = 1e-6;
const NOTE_KEYS = ["midi", "name", "tie", "tremolo", "gliss", "unscored"];

// What "the same measure" means: notes, durations, tuplets, markings and the
// unscored flag. Voice, lyric and anything else stored on an event are ignored.
export function normEvent(e) {
  const out = { duration: e.duration };
  if (e.tuplet) out.tuplet = { actual: e.tuplet.actual, normal: e.tuplet.normal };
  out.notes = (e.notes || []).map((n) => {
    const o = {};
    for (const k of NOTE_KEYS) if (n[k] !== undefined) o[k] = n[k];
    return o;
  });
  return out;
}

const stable = (v) => JSON.stringify(v, (k, x) =>
  x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]))
    : x);

export const sameEvents = (a, b) => stable((a || []).map(normEvent)) === stable((b || []).map(normEvent));

const beatsOf = (e) => {
  const t = tokenToBeats(e.duration) || 0;
  return e.tuplet ? (t * e.tuplet.normal) / e.tuplet.actual : t;
};
export function onsets(events) {
  let t = 0;
  return (events || []).map((e) => { const o = t; t += beatsOf(e); return o; });
}

// What a stored event becomes: the parser's event minus `lyric` (lyrics live
// in sam_song_lyrics and are injected at recompile).
const toStored = (events) => events.map(({ lyric, ...rest }) => rest);

/** Find the new rh event (and note) for a fingering or lyric row. */
export function remapRow(oldRh, newRh, rhIndex, noteIndex) {
  const oldEvt = oldRh[rhIndex];
  if (!oldEvt) return null;
  const at = onsets(oldRh)[rhIndex];
  const newOnsets = onsets(newRh);
  const candidates = newRh.map((e, i) => i).filter((i) => Math.abs(newOnsets[i] - at) < EPS && (newRh[i].notes || []).length);
  if (noteIndex == null) {
    // Lyric: same onset; prefer the event still holding the old top note.
    const top = Math.max(...(oldEvt.notes || []).map((n) => n.midi));
    const i = candidates.find((c) => newRh[c].notes.some((n) => n.midi === top)) ?? candidates[0];
    return i == null ? null : { rhIndex: i };
  }
  const midi = oldEvt.notes?.[noteIndex]?.midi;
  if (midi == null) return null;
  for (const i of candidates) {
    const k = newRh[i].notes.findIndex((n) => n.midi === midi);
    if (k >= 0) return { rhIndex: i, noteIndex: k };
  }
  return null;
}

const label = (e) => `${e.duration}${e.tuplet ? `(${e.tuplet.actual}:${e.tuplet.normal})` : ""}`;
const names = (ns) => [...new Set(ns.map((n) => n.name))].join(" ");

/** One plain line describing how a hand's events changed. */
export function describeChange(oldEvents, newEvents) {
  const parts = [];
  const oldNotes = oldEvents.flatMap((e) => e.notes || []);
  const newNotes = newEvents.flatMap((e) => e.notes || []);
  const struck = (ns) => ns.filter((n) => n.tie !== "end" && n.tie !== "both").map((n) => n.midi);
  const left = [...struck(newNotes)];
  const dropped = [];
  for (const n of oldNotes.filter((x) => x.tie !== "end" && x.tie !== "both")) {
    const i = left.indexOf(n.midi);
    if (i >= 0) left.splice(i, 1); else dropped.push(n);
  }
  const trem = newNotes.filter((n) => n.tremolo && !oldNotes.some((o) => o.midi === n.midi && o.tremolo));
  if (trem.length) {
    parts.push(`tremolo ${oldEvents.map(label).join(" ")} → ${newEvents.map(label).join(" ")} (${names(trem)})`);
  } else if (oldEvents.map(label).join(" ") !== newEvents.map(label).join(" ")) {
    parts.push(`rhythm ${oldEvents.map(label).join(" ")} → ${newEvents.map(label).join(" ")}`);
  }
  if (dropped.length) parts.push(`${names(dropped)} dropped`);
  const unscored = newNotes.filter((n) => n.unscored && !oldNotes.some((o) => o.midi === n.midi && o.unscored));
  if (unscored.length) parts.push(`${names(unscored)} marked unscored`);
  const gliss = newNotes.filter((n) => n.gliss && !oldNotes.some((o) => o.midi === n.midi && o.gliss));
  if (gliss.length) parts.push(`${gliss[0].gliss.kind} line on ${names(gliss)}`);
  return parts.join("; ") || "markings changed";
}

/**
 * Plan one song. `stored` is the export's song object; `parsed` the parser's song.
 * @returns {{ skip?: string, changes: [], fingerings: [], lyrics: [], unmatched: [] }}
 */
export function planSong(stored, parsed) {
  const rows = stored.measures || [];
  const plays = parsed.measures || [];
  const out = { changes: [], fingerings: [], lyrics: [], unmatched: [] };
  if (rows.length !== plays.length) {
    return { ...out, skip: `measure count ${rows.length} stored, ${plays.length} re-parsed` };
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = plays[i];
    if (r.number !== p.number || String(r.source_measure ?? "") !== String(p.sourceMeasure ?? "")) {
      return { ...out, skip: `numbering differs at played m${r.number} (stored printed ${r.source_measure}, re-parsed m${p.number} printed ${p.sourceMeasure})` };
    }
  }
  rows.forEach((r, i) => {
    const p = plays[i];
    const rhSame = sameEvents(r.rh, p.rh);
    const lhSame = sameEvents(r.lh, p.lh);
    if (rhSame && lhSame) return;
    const newRh = toStored(p.rh || []);
    const newLh = toStored(p.lh || []);
    out.changes.push({
      number: r.number, printed: r.source_measure, oldRh: r.rh, oldLh: r.lh, rh: newRh, lh: newLh,
      what: [
        rhSame ? null : `RH: ${describeChange(r.rh || [], newRh)}`,
        lhSame ? null : `LH: ${describeChange(r.lh || [], newLh)}`,
      ].filter(Boolean).join(" · "),
    });
    if (rhSame) return;
    for (const f of (stored.fingerings || []).filter((x) => x.measure_num === r.number)) {
      const to = remapRow(r.rh || [], newRh, f.rh_index, f.note_index);
      if (!to) out.unmatched.push({ table: "sam_song_fingerings", id: f.id, measure: r.number, rh_index: f.rh_index, note_index: f.note_index });
      else if (to.rhIndex !== f.rh_index || to.noteIndex !== f.note_index) out.fingerings.push({ ...f, to });
    }
    for (const l of (stored.lyrics || []).filter((x) => x.measure_num === r.number)) {
      const to = remapRow(r.rh || [], newRh, l.rh_index, null);
      if (!to) out.unmatched.push({ table: "sam_song_lyrics", id: l.id, measure: r.number, rh_index: l.rh_index, syllable: l.syllable });
      else if (to.rhIndex !== l.rh_index) out.lyrics.push({ ...l, to });
    }
  });
  return out;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const j = (v) => `$j$${JSON.stringify(v)}$j$::jsonb`;
const guard = (what) =>
  `  get diagnostics n = row_count;\n  if n <> 1 then raise exception '${what.replace(/'/g, "''")}: % rows (expected 1; changed since the export?)', n; end if;\n`;

/** The repair, as one transaction. Every statement must touch exactly one row. */
export function repairSql(plans, header) {
  const body = [];
  for (const { song, plan } of plans) {
    if (plan.skip || !plan.changes.length) continue;
    body.push(`  -- ${song.title} (${song.id})`);
    for (const c of plan.changes) {
      body.push(
        `  update public.sam_song_measures set rh = ${j(c.rh)}, lh = ${j(c.lh)}, updated_at = now()\n` +
        `   where song_id = ${q(song.id)} and number = ${c.number} and rh = ${j(c.oldRh)} and lh = ${j(c.oldLh)};\n` +
        guard(`${song.title} m${c.number}`)
      );
    }
    for (const f of plan.fingerings) {
      body.push(
        `  update public.sam_song_fingerings set rh_index = ${f.to.rhIndex}, note_index = ${f.to.noteIndex}, updated_at = now()\n` +
        `   where id = ${q(f.id)} and rh_index = ${f.rh_index} and note_index = ${f.note_index};\n` +
        guard(`${song.title} fingering ${f.id}`)
      );
    }
    for (const l of plan.lyrics) {
      body.push(
        `  update public.sam_song_lyrics set rh_index = ${l.to.rhIndex}\n` +
        `   where id = ${q(l.id)} and rh_index = ${l.rh_index};\n` +
        guard(`${song.title} lyric ${l.id}`)
      );
    }
    // The app rebuilds sam_songs.measures from the rows when edited_at is newer.
    body.push(`  update public.sam_songs set measures_edited_at = now() where id = ${q(song.id)};\n` + guard(`${song.title} sam_songs`));
  }
  return `${header}\nbegin;\n\ndo $repair$\ndeclare n int;\nbegin\n${body.join("\n")}\nend\n$repair$;\n\ncommit;\n`;
}

/** Read-only check, one JSON result: every repaired row now holds what the repair wrote. */
export function verifySql(plans, header) {
  const ms = [], fs_ = [], ls = [], songs = [];
  for (const { song, plan } of plans) {
    if (plan.skip || !plan.changes.length) continue;
    songs.push(`(${q(song.id)}::uuid, ${(song.measures || []).length})`);
    for (const c of plan.changes) ms.push(`(${q(song.id)}::uuid, ${c.number}, ${j(c.rh)}, ${j(c.lh)})`);
    for (const f of plan.fingerings) fs_.push(`(${q(f.id)}::uuid, ${f.to.rhIndex}, ${f.to.noteIndex})`);
    for (const l of plan.lyrics) ls.push(`(${q(l.id)}::uuid, ${l.to.rhIndex})`);
  }
  if (!ms.length) return `${header}\nselect json_build_object('nothing_to_verify', true) as result;\n`;
  // Fingerings and lyrics may be empty while measures are not.
  const vals = (rows, cols) => rows.length
    ? `(values ${rows.join(",\n   ")}) v(${cols})`
    : `(select ${cols.split(",").map((c, i) => `${i ? "null::int" : "null::uuid"} as ${c.trim()}`).join(", ")} where false) v`;
  return `${header}
select json_build_object(
  'measures_not_matching', (select coalesce(json_agg(t), '[]'::json) from (
    select v.song_id, v.number, m.rh = v.rh as rh_ok, m.lh = v.lh as lh_ok
    from ${vals(ms, "song_id, number, rh, lh")}
    left join public.sam_song_measures m on m.song_id = v.song_id and m.number = v.number
    where m.id is null or m.rh <> v.rh or m.lh <> v.lh) t),
  'measure_counts_changed', (select coalesce(json_agg(t), '[]'::json) from (
    select v.song_id, v.expected, (select count(*) from public.sam_song_measures m where m.song_id = v.song_id) as now
    from ${vals(songs, "song_id, expected")}
    where (select count(*) from public.sam_song_measures m where m.song_id = v.song_id) <> v.expected) t),
  'fingerings_not_moved', (select coalesce(json_agg(t), '[]'::json) from (
    select v.id from ${vals(fs_, "id, rh_index, note_index")}
    left join public.sam_song_fingerings f on f.id = v.id
    where f.id is null or f.rh_index <> v.rh_index or f.note_index <> v.note_index) t),
  'lyrics_not_moved', (select coalesce(json_agg(t), '[]'::json) from (
    select v.id from ${vals(ls, "id, rh_index")}
    left join public.sam_song_lyrics l on l.id = v.id
    where l.id is null or l.rh_index <> v.rh_index) t),
  'songs_marked_for_recompile', (select coalesce(json_agg(t), '[]'::json) from (
    select s.id, s.title, s.measures_edited_at > coalesce(s.measures_compiled_at, '-infinity') as will_recompile
    from public.sam_songs s where s.id in (select song_id from ${vals(songs, "song_id, expected")})) t)
) as result;
`;
}

/**
 * The export as the SQL editor gives it: the bare JSON cell, or its CSV download
 * (a `result` header row, then the cell quoted with "" escapes).
 */
export function readExport(text) {
  let raw = text.replace(/^﻿/, "").trim();
  if (/^"?result"?\r?\n/.test(raw)) {
    raw = raw.replace(/^"?result"?\r?\n/, "");
    if (raw.startsWith('"')) raw = raw.slice(1, raw.lastIndexOf('"')).replace(/""/g, '"');
  }
  if (raw.startsWith('"')) raw = JSON.parse(raw);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function findSource(dir, song) {
  const names = [`${song.id}.musicxml`, song.source_xml_path && path.basename(song.source_xml_path), song.source_file].filter(Boolean);
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function reportMd(plans, missing) {
  const lines = ["# sam_xml_import repair plan", ""];
  for (const { song, plan } of plans) {
    const hist = `${song.passes} passes, ${song.snippets} snippets`;
    if (plan.skip) { lines.push(`## ${song.title} — SKIPPED (${hist})`, `- ${plan.skip}`, ""); continue; }
    if (!plan.changes.length) continue;
    lines.push(`## ${song.title} (${hist})`);
    for (const c of plan.changes) {
      const printed = c.printed != null && String(c.printed) !== String(c.number) ? ` (printed ${c.printed})` : "";
      lines.push(`- m${c.number}${printed}: ${c.what}`);
    }
    if (plan.fingerings.length || plan.lyrics.length) lines.push(`- remapped: ${plan.fingerings.length} fingering(s), ${plan.lyrics.length} lyric(s)`);
    for (const u of plan.unmatched) lines.push(`- NOT REMAPPED: ${u.table} ${u.id} at m${u.measure} rh_index ${u.rh_index}`);
    lines.push("");
  }
  const unchanged = plans.filter(({ plan }) => !plan.skip && !plan.changes.length).map(({ song }) => song.title);
  lines.push(`Unchanged: ${unchanged.length ? unchanged.join(", ") : "none"}`);
  if (missing.length) lines.push(`No source file found (not checked): ${missing.map((s) => s.title).join(", ")}`);
  return lines.join("\n") + "\n";
}

const HEADER = `-- Purpose: sam_xml_import-g4w step 6. Repair stored songs in place with the new MusicXML parser:
-- two-note tremolos as two halves, notes outside MIDI 21-108 unscored, cue and hidden notes dropped,
-- nested-triplet runs folded, tremolo/glissando/slide markings. Only measures whose re-parsed content
-- differs are updated; fingerings and lyrics in them move to the same note's new rh_index.
-- Kind: one-off data repair (no schema change)
-- Applied: NO
--
-- Generated by tools/sam-tools/bin/repair-notation.js from the export of
-- supabase/tests/sam_xml_import-g4w/1_export_for_repair.sql. Run as one block in the SQL editor.
-- Every statement is guarded: it must touch exactly one row and match what was exported, or the
-- whole transaction rolls back. Verify with supabase/tests/sam_xml_import-g4w/verify_repair.sql.
-- Spec: docs/technical-spec-sam_xml_import-g4w.md`;

const VERIFY_HEADER = `-- sam_xml_import-g4w: verify the notation repair. Read-only; run after the repair migration.
-- Every list should be empty except songs_marked_for_recompile, where will_recompile should be true
-- until each song is next opened in SAM. Generated by tools/sam-tools/bin/repair-notation.js.`;

function main(argv) {
  const [exportFile, xmlDir, ...rest] = argv;
  if (!exportFile || !xmlDir) {
    console.error("usage: repair-notation.js <export.json> <xml-dir> [--sql f] [--verify f] [--report f]");
    process.exit(2);
  }
  const opt = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "../../..");
  const sqlOut = opt("--sql", path.join(repo, "supabase/migrations/_pending_sam_xml_import-g4w_repair_notation_measures.sql"));
  const verifyOut = opt("--verify", path.join(repo, "supabase/tests/sam_xml_import-g4w/verify_repair.sql"));
  const reportOut = opt("--report", null);

  const data = readExport(fs.readFileSync(exportFile, "utf8"));
  const only = opt("--song", null);
  const plans = [], missing = [];
  for (const song of (data.songs || []).filter((s) => !only || s.id === only)) {
    const src = findSource(xmlDir, song);
    if (!src) { missing.push(song); continue; }
    plans.push({ song, plan: planSong(song, parseMusicXML(readScoreXml(src))) });
  }
  fs.writeFileSync(sqlOut, repairSql(plans, HEADER));
  fs.writeFileSync(verifyOut, verifySql(plans, VERIFY_HEADER));
  const report = reportMd(plans, missing);
  if (reportOut) fs.writeFileSync(reportOut, report);
  process.stdout.write(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
