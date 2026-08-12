import React, { useState, useEffect } from "react";
import { supabase } from "../../supabaseClient";
import { parseMusicXML } from "../lib/songParser";
import { fanOutMeasures, isMeasuresStale, recompileMeasures } from "../lib/measureCompiler";
import { importMusicxmlFingerings } from "../lib/fingeringsApi";
import { importLyrics } from "../lib/lyricsApi";
import { validateSongDocument } from "../lib/songSchema";
import usePracticeStats from "../lib/usePracticeStats";
import useSongLibrary from "../lib/useSongLibrary";
import JSZip from "jszip";
import PracticeWeekSnapshot from "./PracticeWeekSnapshot";
import ContinueSection from "./ContinueSection";
import FamilySheet from "./FamilySheet";
import BrowseTabs from "./BrowseTabs";
import AddImportSheet from "./AddImportSheet";
import StatsPage from "./StatsPage";

// Very small path-based dispatch for the /stats stub. The app doesn't use
// react-router; App.js does one hard-coded pathname check for /oauth/consent
// and delegates everything else to Alfred. To satisfy the M6 requirement
// that /stats be a real URL (browser Back should return to the landing
// page), we manage it inside the landing subtree with pushState + popstate.
// Constraint: SamPlayer.jsx must not be touched — routing lives here.
function readSamPath() {
  if (typeof window === "undefined") return "landing";
  return window.location.pathname === "/stats" ? "stats" : "landing";
}

// Legacy MusicXML output — the parseMusicXML path emits voice events that
// may carry inline `lyric` fields (extracted from <lyric> in the source
// document). The strict schema validator (validateSongDocument) rejects
// inline lyrics per spec §4. Route MusicXML output through this lightweight
// sanity check instead; the strict schema gates hand-authored JSON only.
function validateMusicXmlSong(song) {
  if (!song || typeof song !== "object") return "Invalid MusicXML: parse produced no object";
  if (!Array.isArray(song.measures) || song.measures.length === 0)
    return "Invalid MusicXML: parse produced no measures";
  return null;
}

// Format schema/semantic errors as a single multi-line string for the red
// banner. Cap at 5 so a document with dozens of issues doesn't wall of
// text; spec §Step 2 says "shows first ~5 errors".
function formatValidationErrors(errors) {
  const shown = errors.slice(0, 5);
  const more = errors.length - shown.length;
  const suffix = more > 0 ? `\n(+${more} more)` : "";
  return `Document invalid — fix and re-import:\n• ${shown.join("\n• ")}${suffix}`;
}

// Fields added by the lineage migration. Every insert path pulls the same
// shape from the doc; centralize so file/paste paths can't drift.
//
// M8 — generation_notes now merges the drill's original generationNotes
// (if any) with an `importer` namespace holding the parser's
// parseWarnings + parseWarningsStructured. Written raw so a taxonomy
// change doesn't require re-import; the UI classifies on render.
function lineageFields(doc) {
  const existingNotes =
    doc.generationNotes && typeof doc.generationNotes === "object"
      ? doc.generationNotes
      : null;
  const hasParserWarnings =
    (doc.parseWarnings && doc.parseWarnings.length > 0) ||
    (doc.parseWarningsStructured && doc.parseWarningsStructured.length > 0);
  const importerNote = hasParserWarnings
    ? {
        importer: {
          parseWarnings: doc.parseWarnings || [],
          parseWarningsStructured: doc.parseWarningsStructured || [],
          importedAt: new Date().toISOString(),
        },
      }
    : null;
  // M4 open item, landed 2026-08-05. Persist the repeat/navigation
  // structure resolved at parse time so consumers can regenerate an
  // unflattened variant of the song without re-parsing the source.
  // Spec §3.4: recordings frequently skip the repeats. The `playback`
  // key is separate from `importer` — different concerns, different
  // lifetimes; drill authors get neither, imported MusicXML gets both.
  const playbackNote = doc.playback ? { playback: doc.playback } : null;
  const merged =
    existingNotes || importerNote || playbackNote
      ? {
          ...(existingNotes || {}),
          ...(importerNote || {}),
          ...(playbackNote || {}),
        }
      : null;
  return {
    song_type: doc.songType || "original",
    parent_song_id: doc.parentSongId || null,
    difficulty_tier: doc.difficultyTier ?? null,
    generation_notes: merged,
  };
}

// M8 — severity split for the import dialog.
//
// BLOCK kinds mean playback differs from the score in a way the user
// should approve before committing: ornaments not applied (pitches
// shown ≠ performed), grace notes dropped (silently missing), truncated
// tuplet (measure actually short), low-majority hand assignment
// (§3.6 boundary case suggesting a weird source).
//
// FYI kinds are CARRIED — the parser stored the tag's presence for a
// future renderer but nothing is missing from playback. No approval
// needed; shown as a dismissible toast on import success.
//
// Classification lives here (in the UI), not in the parser, because
// changing the taxonomy shouldn't require re-parsing every stored song.
// Raw parseWarnings strings and parseWarningsStructured both go into
// generation_notes.importer verbatim; classify-on-render.
const BLOCK_KINDS = new Set([
  "ornament", "grace", "truncated", "overflow", "hand-assignment",
]);

// Fold validateSongDocument's duration-sum warnings into the same structured
// shape the parser emits, so the M8 gate renders them with no special-casing.
// `overflow` and `truncated` are already BLOCK kinds with sentences written for
// them — a bar that doesn't add up is the same finding whether the parser
// noticed it on the way in or the validator noticed it on the way back.
//
// `count` is distinct MEASURES, not occurrences: composeBlockSentence's
// overflow/truncated wording is "Measure(s) ... at printed m…", so a measure
// where both hands run long must not read as two.
export function durationWarningsToStructured(warnings, measures) {
  const byKind = new Map();
  for (const w of warnings || []) {
    if (!byKind.has(w.kind)) {
      byKind.set(w.kind, { kind: w.kind, tag: w.kind, count: 0, measures: [] });
    }
    const entry = byKind.get(w.kind);
    // Printed number where the document has one — the M8 convention is that
    // warnings reference the engraved score, not the array position.
    const printed = measures?.[w.measureIndex]?.sourceMeasure ?? w.measureNumber;
    if (!entry.measures.includes(printed)) entry.measures.push(printed);
  }
  for (const entry of byKind.values()) entry.count = entry.measures.length;
  return [...byKind.values()];
}

function classifyWarnings(structured) {
  const block = [];
  const fyi = [];
  for (const w of structured || []) {
    (BLOCK_KINDS.has(w.kind) ? block : fyi).push(w);
  }
  return { block, fyi };
}

// M8 — compose a human sentence from a structured warning. Uses
// PRINTED source measure numbers (spec §M8: warnings reference the
// engraved score, not the parser's internal 1-based array position).
function composeBlockSentence(w) {
  const measPreview = w.measures.slice(0, 8).join(", ");
  const more = w.measures.length > 8 ? `, +${w.measures.length - 8} more` : "";
  const at = w.measures.length > 0 ? ` at printed m${measPreview}${more}` : "";
  if (w.kind === "ornament") {
    return `${w.tag} ×${w.count}${at}`;
  }
  if (w.kind === "grace") {
    return `${w.count} grace note${w.count > 1 ? "s" : ""} dropped — silently missing from playback`;
  }
  if (w.kind === "truncated") {
    return `Measure${w.count > 1 ? "s" : ""}${at} left short — parser could not decompose the gap into rest tokens`;
  }
  if (w.kind === "overflow") {
    return `Measure${w.count > 1 ? "s" : ""}${at} overflow — sum exceeds the time signature`;
  }
  if (w.kind === "hand-assignment") {
    return `Hand assignment used a low-majority fallback in ${w.count} measure${w.count > 1 ? "s" : ""} — score is unusual`;
  }
  return `${w.tag} ×${w.count}${at}`;
}

// Extended settings columns needed only by the edit modal. useSongLibrary
// keeps its list query lean (never the measures blob, and no per-song
// timing knobs either); we fetch these on-demand when the pencil is tapped.
const EDIT_COLUMNS =
  "id, title, artist, default_bpm, playback_speed, default_timing_window_ms, default_chord_ms, default_measure_width, archived";

export default function SongLoader({ onSongLoaded, onSongSaved, onImportError }) {
  const [error, setError] = useState(null);
  const [editingSong, setEditingSong] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editBpm, setEditBpm] = useState("");
  const [editPlaybackSpeed, setEditPlaybackSpeed] = useState("");
  const [editTimingWindow, setEditTimingWindow] = useState("");
  const [editChordMs, setEditChordMs] = useState("");
  const [editMeasureWidth, setEditMeasureWidth] = useState("");
  const [saving, setSaving] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [samView, setSamView] = useState(readSamPath);
  // M8 — import-time warning gate. When set, a modal blocks the
  // commit until user picks Import or Cancel. Contains everything
  // needed to complete the import (song, source, meta, warnings)
  // so Cancel just clears state — no side effects to reverse.
  const [pendingImport, setPendingImport] = useState(null);
  const [fyiExpanded, setFyiExpanded] = useState(false);
  // Dismissible toast for the FYI-only case. Auto-clears; the user
  // does not need to be reminded about a carried metronome mark on
  // every single import.
  const [importToast, setImportToast] = useState(null);
  useEffect(() => {
    if (!importToast) return;
    const t = setTimeout(() => setImportToast(null), 6000);
    return () => clearTimeout(t);
  }, [importToast]);

  // Browser Back / Forward buttons emit popstate; keep our view in sync
  // with the URL so back-from-stats lands on the landing page.
  useEffect(() => {
    function onPop() {
      setSamView(readSamPath());
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function openStats() {
    if (window.location.pathname !== "/stats") {
      window.history.pushState({ samView: "stats" }, "", "/stats");
    }
    setSamView("stats");
  }

  function closeStats() {
    // history.back() reverses the pushState above. Our popstate listener
    // then flips samView back to "landing", so we don't setState here.
    window.history.back();
  }

  // Single practice-stats fetch for the whole landing page. `PracticeWeekSnapshot`
  // and `useSongLibrary` both consume this shape via props — they no longer
  // call the hook themselves, so landing loads exactly one sam_sessions
  // request (spec § 6 success criterion). Named `practiceStats` (not `stats`)
  // so it doesn't shadow anything.
  const practiceStats = usePracticeStats({ currentSongId: null });
  const lib = useSongLibrary({
    perSongTotals: practiceStats.perSongTotals,
    lastPracticedBySong: practiceStats.lastPracticedBySong,
    statsLoading: practiceStats.loading,
  });

  // Family sheet modal state (Milestone 4). Setting a family opens the
  // sheet; setting null closes it. The sheet is a modal overlay, not a
  // route change, so landing-page scroll position survives naturally.
  const [familyForSheet, setFamilyForSheet] = useState(null);
  function handleOpenFamily(family) {
    setFamilyForSheet(family);
  }
  function handleCloseFamilySheet() {
    setFamilyForSheet(null);
  }
  function handleLoadFromFamilySheet(member) {
    setFamilyForSheet(null);
    handleLoadFromLibrary(member);
  }
  function handleStatsForFamily(family) {
    // Close the sheet first so React unmounts it cleanly, then open stats.
    // Family id isn't threaded to the stub page yet — a later milestone
    // that fleshes StatsPage out can accept it via history.state or a
    // query param. For now the button simply lands the user on /stats.
    // eslint-disable-next-line no-unused-vars
    void family;
    setFamilyForSheet(null);
    openStats();
  }
  function handleNewDrillFromFamily(family) {
    // "New drill from this" — spec §FamilySheet just names the button;
    // the drill-authoring flow isn't defined for this project pass. Log
    // for now; a later milestone or follow-up can define the flow.
    // eslint-disable-next-line no-console
    console.log("[SongLoader] new drill from family:", family.root.title, family.root.id);
  }

  // `report` surfaces errors that fire AFTER onSongLoaded — by then this
  // component has unmounted and setError targets a dead node, so we also
  // fire onImportError which lives at the SamPlayer level and survives
  // the swap. Keep the local setError call for the pre-load window when
  // SongLoader is still mounted.
  const report = (msg) => {
    setError(msg);
    if (onImportError) onImportError(msg);
  };

  async function handleLoadFromLibrary(row) {
    setError(null);

    const { data, error: dbError } = await supabase
      .from("sam_songs")
      .select("*")
      .eq("id", row.id)
      .single();

    if (dbError || !data) {
      console.error("[Sam] Failed to load song:", dbError);
      setError("Failed to load song");
      return;
    }

    let measures = data.measures;

    // Stale check: if measure rows were edited since last compile, recompile from rows
    if (isMeasuresStale(data)) {
      try {
        console.log("[Sam] Measures stale — recompiling from rows");
        measures = await recompileMeasures(data.id, supabase);
      } catch (e) {
        console.error("[Sam] Recompile failed, using existing blob:", e);
      }
    }

    const song = {
      title: data.title,
      artist: data.artist,
      defaultBpm: data.default_bpm,
      playbackSpeed: data.playback_speed ?? 100,
      defaultTimingWindowMs: data.default_timing_window_ms ?? null,
      defaultChordMs: data.default_chord_ms ?? null,
      defaultMeasureWidth: data.default_measure_width ?? null,
      audioFilePath: data.audio_file_path || null,
      showImportedFingerings: data.show_imported_fingerings ?? false,
      // Carried for the exporter, which must be able to reproduce the whole
      // song row. The `select("*")` above already fetched these — they were
      // simply being dropped on the floor, so this costs no extra query.
      // `fifths` has no column; songExport recovers it from the label.
      key: data.key_signature ?? null,
      timeSignature: data.time_signature ?? null,
      sourceXmlPath: data.source_xml_path ?? null,
      songType: data.song_type ?? null,
      parentSongId: data.parent_song_id ?? null,
      difficultyTier: data.difficulty_tier ?? null,
      generationNotes: data.generation_notes ?? null,
      measures,
    };
    onSongLoaded(song);
    if (onSongSaved) onSongSaved(data.id);
  }

  async function handleArchive(row) {
    const { error: dbError } = await supabase
      .from("sam_songs")
      .update({ archived: true })
      .eq("id", row.id);

    if (dbError) {
      console.error("[Sam] Archive failed:", dbError);
      setError(`Archive failed: ${dbError.message}`);
    } else {
      lib.refresh();
    }
  }

  async function handleRestore(row) {
    const { error: dbError } = await supabase
      .from("sam_songs")
      .update({ archived: false })
      .eq("id", row.id);

    if (dbError) {
      console.error("[Sam] Restore failed:", dbError);
      setError(`Restore failed: ${dbError.message}`);
    } else {
      lib.refresh();
    }
  }

  async function handleEditClick(row) {
    // useSongLibrary doesn't carry per-song timing knobs (spec: list query
    // stays lean). Fetch the extended shape on demand so the modal has
    // everything it needs to render + save.
    const { data, error: dbError } = await supabase
      .from("sam_songs")
      .select(EDIT_COLUMNS)
      .eq("id", row.id)
      .single();

    if (dbError || !data) {
      console.error("[Sam] Failed to fetch song for edit:", dbError);
      setError("Failed to load song settings");
      return;
    }

    setEditingSong(data);
    setEditTitle(data.title || "");
    setEditArtist(data.artist || "");
    setEditBpm(String(data.default_bpm || 68));
    setEditPlaybackSpeed(String(data.playback_speed ?? 100));
    setEditTimingWindow(
      data.default_timing_window_ms != null ? String(data.default_timing_window_ms) : ""
    );
    setEditChordMs(
      data.default_chord_ms != null ? String(data.default_chord_ms) : ""
    );
    setEditMeasureWidth(
      data.default_measure_width != null ? String(data.default_measure_width) : ""
    );
  }

  function handleCancelEdit() {
    setEditingSong(null);
    setEditTitle("");
    setEditArtist("");
    setEditBpm("");
    setEditPlaybackSpeed("");
    setEditTimingWindow("");
    setEditChordMs("");
    setEditMeasureWidth("");
  }

  async function handleSaveEdit() {
    if (!editingSong) return;

    const bpmNum = Number(editBpm);
    const psNum = Number(editPlaybackSpeed) || 100;
    if (!editTitle.trim() || !bpmNum || bpmNum <= 0) {
      alert("Please provide a valid title and BPM");
      return;
    }

    const timingNum = editTimingWindow !== "" ? Number(editTimingWindow) : null;
    const chordNum = editChordMs !== "" ? Number(editChordMs) : null;
    const widthNum = editMeasureWidth !== "" ? Number(editMeasureWidth) : null;

    setSaving(true);
    const { error: dbError } = await supabase
      .from("sam_songs")
      .update({
        title: editTitle.trim(),
        artist: editArtist.trim() || null,
        default_bpm: bpmNum,
        playback_speed: psNum,
        default_timing_window_ms: timingNum,
        default_chord_ms: chordNum,
        default_measure_width: widthNum,
      })
      .eq("id", editingSong.id);

    setSaving(false);

    if (dbError) {
      console.error("[Sam] Song update failed:", dbError);
      alert("Failed to update song");
      return;
    }

    lib.refresh();
    handleCancelEdit();
  }

  // M8 — shared commit path. Both handleFile and handlePastedText
  // parse + validate, then hand off here. Splits into two steps so
  // the dialog gate can inspect warnings BEFORE any side effect
  // (onSongLoaded, DB insert). Cancel just clears pendingImport;
  // nothing to reverse.
  function commitImport({ song, source, sourceFile, defaultTitle, rawXml }) {
    // Load into memory (this is the "commit" from the user's POV)
    onSongLoaded(song);

    // Fire-and-forget DB insert
    supabase
      .from("sam_songs")
      .insert({
        title: song.title || defaultTitle,
        artist: song.artist || null,
        source,
        source_file: sourceFile,
        key_signature: song.key || null,
        time_signature: song.timeSignature || "4/4",
        // Inherited from the document when it carries one. A simplified song
        // must point at the same score its parent came from, or the lineage
        // leads to a row that can no longer be traced back to a source
        // document. Overwritten below for MusicXML imports, which upload
        // their own copy and know the new path.
        source_xml_path: song.sourceXmlPath || null,
        default_bpm: song.defaultBpm || 68,
        measures: song.measures,
        // Imported fingerings shown by default (the DB column defaults to
        // false; override on import so editorial fingering is visible without
        // a toggle). No-op for imports that carry none.
        show_imported_fingerings: true,
        ...lineageFields(song),
      })
      .select("id, user_id")
      .single()
      .then(async ({ data, error: dbError }) => {
        if (dbError) {
          console.error("[Sam] Supabase save error:", dbError);
          report(`Song save failed: ${dbError.message}`);
          return;
        }
        console.log("[Sam] Song saved to Supabase, id:", data.id);
        try {
          await fanOutMeasures(data.id, song.measures, supabase);
        } catch (e) {
          console.error("[Sam] Measure fan-out failed:", e);
          report(
            `Song saved but measure fan-out failed: ${e.message}. ` +
            `Try re-importing.`
          );
        }
        // Imported RH fingerings (spec §6). Non-fatal on failure. Written
        // BEFORE onSongSaved so useFingeringEditor's load (keyed on the id
        // this signals) sees the musicxml rows on first render — otherwise
        // toggling "show imported fingerings" would find an empty set.
        try {
          if (song.fingerings?.length) {
            await importMusicxmlFingerings(data.id, song.fingerings);
          }
        } catch (e) {
          console.error("[Sam] Imported fingering write failed:", e);
        }
        // Placed lyrics (sam_song_lyrics). Same fire-and-forget, non-fatal
        // treatment as fingerings. An exported document carries these
        // top-level in the table's own shape — including word_order, the
        // stable syllable identity — because an inline `lyric` on an rh event
        // is rejected by the schema and would be stripped by the next
        // recompile anyway.
        //
        // recompileMeasures afterwards so the compiled blob carries the
        // syllables inline for renderers that read it, exactly as the lyric
        // editor's save path does. fanOutMeasures has just set
        // measures_compiled_at, so nothing would otherwise rebuild the blob
        // and the lyrics would not appear until an unrelated edit.
        try {
          if (song.lyrics?.length) {
            await importLyrics(data.id, song.lyrics);
            await recompileMeasures(data.id, supabase);
          }
        } catch (e) {
          console.error("[Sam] Lyric import failed:", e);
        }
        // Signal saved AFTER measures + fingerings exist.
        if (onSongSaved) onSongSaved(data.id);
        // Upload the raw MusicXML to sam-scores/{userId}/{songId}.musicxml
        // and populate sam_songs.source_xml_path. MusicXML paths only —
        // JSON imports don't have a source XML to store. Fire-and-forget
        // per the same pattern as fan-out; song is already saved and
        // playable from the compiled blob if this step fails.
        if (rawXml) {
          try {
            const path = `${data.user_id}/${data.id}.musicxml`;
            const blob = new Blob([rawXml], { type: "application/vnd.recordare.musicxml+xml" });
            const { error: upErr } = await supabase.storage
              .from("sam-scores")
              .upload(path, blob, { contentType: "application/vnd.recordare.musicxml+xml", upsert: true });
            if (upErr) throw upErr;
            const { error: pathErr } = await supabase
              .from("sam_songs")
              .update({ source_xml_path: path })
              .eq("id", data.id);
            if (pathErr) throw pathErr;
            console.log("[Sam] Source XML uploaded:", path);
          } catch (e) {
            console.error("[Sam] Source XML upload failed:", e);
            // Don't user-report — song is fully functional without the
            // stored source XML; source_xml_path stays null on this row
            // and can be backfilled by re-importing later.
          }
        }
      })
      .catch((e) => {
        console.error("[Sam] Supabase save failed:", e);
        report(`Song save failed: ${e.message}`);
      });
  }

  // M8 — Tier A gate. BLOCK warnings → dialog with Cancel/Import.
  // FYI-only → auto-dismissing toast on import success. No warnings
  // → silent import. Same commit path all three cases; the gate only
  // controls whether the user gets a proceed/cancel choice first.
  function gateAndCommit(commitPayload, extraStructured = []) {
    const { song } = commitPayload;
    const { block, fyi } = classifyWarnings([
      ...(song.parseWarningsStructured || []),
      ...extraStructured,
    ]);
    if (block.length > 0) {
      setPendingImport({ commitPayload, block, fyi });
      setFyiExpanded(false);
      return;
    }
    // No BLOCK warnings — proceed immediately.
    commitImport(commitPayload);
    if (fyi.length > 0) {
      setImportToast(
        `Imported ${commitPayload.defaultTitle}. ` +
        `${fyi.reduce((s, w) => s + w.count, 0)} notation${fyi.length > 1 ? "s" : ""} ` +
        `carried for the renderer (${fyi.map((w) => w.tag).join(", ")}).`
      );
    }
  }

  async function handleFile(file) {
    setError(null);

    const name = file.name.toLowerCase();
    const isJson = name.endsWith(".json");
    const isMusicXml = name.endsWith(".musicxml") || name.endsWith(".xml");
    const isMxl = name.endsWith(".mxl");

    if (!isJson && !isMusicXml && !isMxl) {
      setError("Supported formats: .json, .musicxml, .xml, .mxl");
      return;
    }

    let text;

    if (isMxl) {
      // Handle .mxl (zipped MusicXML)
      try {
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);

        // Find the first .musicxml or .xml file (skip META-INF/container.xml)
        let musicXmlFile = null;
        for (const [filename, zipEntry] of Object.entries(zip.files)) {
          if (zipEntry.dir) continue;
          if (filename === "META-INF/container.xml") continue;
          if (filename.toLowerCase().endsWith(".musicxml") || filename.toLowerCase().endsWith(".xml")) {
            musicXmlFile = zipEntry;
            break;
          }
        }

        if (!musicXmlFile) {
          setError("No MusicXML file found in .mxl archive");
          return;
        }

        text = await musicXmlFile.async("text");
      } catch (e) {
        setError("Could not read .mxl file: " + e.message);
        return;
      }
    } else {
      // Handle regular text files
      try {
        text = await file.text();
      } catch {
        setError("Could not read file");
        return;
      }
    }

    let song;
    // Duration-sum findings from the JSON path, surfaced through the M8 gate
    // rather than blocking. Empty for MusicXML, whose equivalent warnings the
    // parser already put on the song.
    let durationStructured = [];

    if (isJson) {
      try {
        song = JSON.parse(text);
      } catch {
        setError("Invalid JSON — could not parse file");
        return;
      }
      // Strict schema for hand-authored / MCP-authored JSON.
      const { valid, errors, warnings } = validateSongDocument(song);
      if (!valid) {
        setError(formatValidationErrors(errors));
        return;
      }
      durationStructured = durationWarningsToStructured(warnings, song.measures);
    } else {
      try {
        song = parseMusicXML(text);
      } catch (e) {
        setError("MusicXML parse error: " + e.message);
        return;
      }
      // Loose sanity for MusicXML output — parseMusicXML is trusted and
      // legitimately emits inline `lyric` fields the strict schema forbids.
      const validationError = validateMusicXmlSong(song);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    // M8 — gate on warnings before any side effect (onSongLoaded, DB
    // insert). Cancel from the dialog just clears state, no rollback.
    const source = isJson ? "json_import" : "musicxml_import";
    gateAndCommit({
      song,
      source,
      sourceFile: file.name,
      defaultTitle: file.name.replace(/\.(json|musicxml|xml|mxl)$/i, ""),
      // Pass the extracted MusicXML text to commitImport for upload
      // to sam-scores (spec §6 last outstanding manual prereq). For
      // .mxl files, `text` is what we unzipped, not the .mxl blob —
      // we store the unpacked XML so downstream (music21 difficulty
      // analysis, etc.) doesn't have to redo zip extraction.
      rawXml: isJson ? null : text,
    }, durationStructured);
  }

  function handlePastedText(text) {
    setError(null);

    if (!text.trim()) {
      setError("Please paste JSON or MusicXML content");
      return;
    }

    let song;
    let source;
    let durationStructured = [];

    // Try parsing as JSON first
    try {
      song = JSON.parse(text);
      source = "json_paste";

      const { valid, errors, warnings } = validateSongDocument(song);
      if (!valid) {
        setError(formatValidationErrors(errors));
        return;
      }
      durationStructured = durationWarningsToStructured(warnings, song.measures);
    } catch {
      // JSON.parse threw — treat as MusicXML. Schema failures don't reach
      // here (they returned inside the try above).
      try {
        song = parseMusicXML(text);
        source = "musicxml_paste";

        const validationError = validateMusicXmlSong(song);
        if (validationError) {
          setError(validationError);
          return;
        }
      } catch (e) {
        setError("Invalid format — could not parse as JSON or MusicXML: " + e.message);
        return;
      }
    }

    // M8 — same gate as file import.
    gateAndCommit({
      song,
      source,
      sourceFile: null,
      defaultTitle: "Pasted Song",
      // Same rawXml pass-through as handleFile for the MusicXML branch;
      // JSON pastes don't have a source XML to store.
      rawXml: source === "musicxml_paste" ? text : null,
    }, durationStructured);
  }

  if (samView === "stats") {
    return <StatsPage onBack={closeStats} />;
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* 7-day practice snapshot — compact bar strip at the top of the
          landing view (Milestone 6). Tapping opens /stats. Driven by the
          shared usePracticeStats call above so landing stays at one
          sam_sessions fetch. */}
      <PracticeWeekSnapshot
        sevenDayTotals={practiceStats.sevenDayTotals}
        loading={practiceStats.loading}
        onTap={openStats}
      />

      {/* Continue section — two cards, side-by-side above 900px viewport,
          stacked below. Renders nothing when the user has no practice
          history at all. */}
      <ContinueSection
        recentFamilies={lib.recentFamilies}
        onLoad={handleLoadFromLibrary}
        onOpenFamily={handleOpenFamily}
      />

      {error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Browse tabs — Recent / All songs / Drills + Add button. Replaces
          the pre-M5 flat "Your songs" + "Drills" + "Archived" sections. */}
      <BrowseTabs
        families={lib.families}
        familiesByRootId={lib.familiesByRootId}
        allSongsFlat={lib.allSongsFlat}
        newSongsFlat={lib.newSongsFlat}
        drillsFlat={lib.drillsFlat}
        archivedFamilies={lib.archivedFamilies}
        archivedCount={lib.archivedCount}
        loading={lib.loading}
        onLoad={handleLoadFromLibrary}
        onEdit={handleEditClick}
        onArchive={handleArchive}
        onRestore={handleRestore}
        onAddClick={() => setAddSheetOpen(true)}
      />

      {/* Family sheet — opened by ContinueSection card heading or
          "All N versions →" link. Renders nothing when familyForSheet
          is null. */}
      <FamilySheet
        family={familyForSheet}
        onClose={handleCloseFamilySheet}
        onLoad={handleLoadFromFamilySheet}
        onStats={handleStatsForFamily}
        onNewDrill={handleNewDrillFromFamily}
      />

      {/* Add sheet — file drop + paste box behind the + Add button. */}
      <AddImportSheet
        open={addSheetOpen}
        onClose={() => setAddSheetOpen(false)}
        onDropFile={handleFile}
        onPaste={handlePastedText}
      />

      {/* M8 — Import warning gate. Fires only when BLOCK-severity
          warnings exist. Cancel just clears state (no partial rows,
          no orphaned storage — commitImport hasn't been called yet).
          Import calls the shared commit path and clears state. FYI
          section collapsed by default per Alex's rule ("CARRIED is
          not something to approve"); revealed by clicking. */}
      {pendingImport && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
             role="dialog" aria-modal="true">
          <div className="bg-background text-foreground rounded-lg shadow-lg max-w-lg w-full max-h-[80vh] overflow-y-auto p-6">
            <h2 className="text-lg font-semibold mb-1">
              {pendingImport.commitPayload.defaultTitle}
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              {(() => {
                // Header count matches the bullets — occurrences, not
                // structured entries. Bach Invention: 3 inverted-mordent +
                // 2 mordent = 5 warnings (was 2 with the entries count).
                const occurrences = pendingImport.block.reduce((s, w) => s + w.count, 0);
                return `${occurrences} warning${occurrences !== 1 ? "s" : ""} you should see before import`;
              })()}
            </p>

            {/* BLOCK group — always visible. Grouped by kind so 5
                ornaments across 2 tags read as a coherent finding
                rather than a raw list. */}
            <div className="space-y-3 mb-4">
              {(() => {
                const ornaments = pendingImport.block.filter((w) => w.kind === "ornament");
                const others = pendingImport.block.filter((w) => w.kind !== "ornament");
                const sections = [];
                if (ornaments.length > 0) {
                  const total = ornaments.reduce((s, w) => s + w.count, 0);
                  sections.push(
                    <div key="orn" className="border-l-2 border-yellow-500 pl-3">
                      <div className="font-medium text-sm">
                        ⚠ {total} ornament{total !== 1 ? "s" : ""} not applied
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Pitches shown are as-written; performed audio will differ.
                      </div>
                      <ul className="text-sm mt-1 space-y-0.5">
                        {ornaments.map((w) => (
                          <li key={w.tag}>• {composeBlockSentence(w)}</li>
                        ))}
                      </ul>
                    </div>
                  );
                }
                for (const w of others) {
                  sections.push(
                    <div key={w.kind + "-" + w.tag} className="border-l-2 border-yellow-500 pl-3">
                      <div className="text-sm">⚠ {composeBlockSentence(w)}</div>
                    </div>
                  );
                }
                return sections;
              })()}
            </div>

            {/* FYI group — collapsed by default. Never gates. */}
            {pendingImport.fyi.length > 0 && (
              <div className="mb-4 border-t pt-3">
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setFyiExpanded((v) => !v)}
                >
                  {fyiExpanded ? "▾" : "▸"} {pendingImport.fyi.length} carried notation{pendingImport.fyi.length !== 1 ? "s" : ""}
                  {" "}({pendingImport.fyi.map((w) => w.tag).join(", ")}) — stored for the renderer
                </button>
                {fyiExpanded && (
                  <ul className="text-xs text-muted-foreground mt-2 space-y-0.5">
                    {pendingImport.fyi.map((w) => (
                      <li key={w.tag}>• {composeBlockSentence(w)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                className="px-4 py-2 text-sm border rounded hover:bg-muted"
                onClick={() => setPendingImport(null)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:opacity-90"
                onClick={() => {
                  const payload = pendingImport.commitPayload;
                  const fyi = pendingImport.fyi;
                  setPendingImport(null);
                  commitImport(payload);
                  if (fyi.length > 0) {
                    setImportToast(
                      `Imported ${payload.defaultTitle}. ` +
                      `${fyi.reduce((s, w) => s + w.count, 0)} notation${fyi.length > 1 ? "s" : ""} ` +
                      `carried for the renderer.`
                    );
                  }
                }}
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* M8 — dismissible toast for the FYI-only import case. Alex's
          rule: "dismissible-and-forgettable — I don't need to be told
          about a carried metronome mark on every single import."
          Auto-clears after 6s via the useEffect above. */}
      {importToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-md">
          <div className="bg-background border border-border shadow-lg rounded px-4 py-2 text-sm flex items-center gap-3">
            <span className="text-muted-foreground">{importToast}</span>
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setImportToast(null)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingSong && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-medium text-dark mb-4">Edit Song</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder="Song title"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Artist
                </label>
                <input
                  type="text"
                  value={editArtist}
                  onChange={(e) => setEditArtist(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder="Artist name (optional)"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Default BPM
                  </label>
                  <input
                    type="number"
                    value={editBpm}
                    onChange={(e) => setEditBpm(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="68"
                    min={20}
                    max={300}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Playback Speed %
                  </label>
                  <input
                    type="number"
                    value={editPlaybackSpeed}
                    onChange={(e) => setEditPlaybackSpeed(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="100"
                    min={10}
                    max={200}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">BPM = no-audio practice tempo. Speed = audio playback rate (100 = original).</p>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Timing ±ms
                  </label>
                  <input
                    type="number"
                    value={editTimingWindow}
                    onChange={(e) => setEditTimingWindow(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="300"
                    min={100}
                    max={2000}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Chord ms
                  </label>
                  <input
                    type="number"
                    value={editChordMs}
                    onChange={(e) => setEditChordMs(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="80"
                    min={10}
                    max={500}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Measure width
                  </label>
                  <input
                    type="number"
                    value={editMeasureWidth}
                    onChange={(e) => setEditMeasureWidth(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="300"
                    min={150}
                    max={600}
                    step={50}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">Leave blank to use app defaults (300ms / 80ms / 300px)</p>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCancelEdit}
                disabled={saving}
                className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium text-foreground hover:bg-secondary min-h-[44px] disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium min-h-[44px] disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
