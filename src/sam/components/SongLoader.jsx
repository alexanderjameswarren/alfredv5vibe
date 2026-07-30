import React, { useState, useRef, useEffect } from "react";
import { Archive, ArchiveRestore, Music, Pencil } from "lucide-react";
import { supabase } from "../../supabaseClient";
import { parseMusicXML } from "../lib/songParser";
import { fanOutMeasures, isMeasuresStale, recompileMeasures } from "../lib/measureCompiler";
import { validateSongDocument } from "../lib/songSchema";
import JSZip from "jszip";
import PracticeWeekSnapshot from "./PracticeWeekSnapshot";

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
function lineageFields(doc) {
  return {
    song_type: doc.songType || "original",
    parent_song_id: doc.parentSongId || null,
    difficulty_tier: doc.difficultyTier ?? null,
    generation_notes: doc.generationNotes || null,
  };
}

// Group the (visible, non-archived) library into a tree per spec §Step 5:
//   roots            — songs shown at the top level of "Your songs":
//                        · original / simplified / drill with no VISIBLE parent
//                          (parent_song_id null, OR parent archived/deleted)
//                        · MINUS parentless drills, which go to their own section
//   childrenByParent — map from parent id → child songs, one visible level
//                      deep (spec: tree depth arbitrary in data, flat in UI)
//   parentlessDrills — song_type='drill' AND no visible parent → own section
// "Orphan" here means parent_song_id is set but points at a song that's
// archived or deleted (FK ON DELETE SET NULL makes deletes look like
// parent=null; archived parents are filtered out of `visibleSongs`). Both
// cases render as roots rather than being hidden.
function buildLibraryTree(visibleSongs) {
  const byId = new Map(visibleSongs.map((s) => [s.id, s]));
  const childrenByParent = new Map();
  for (const s of visibleSongs) {
    if (s.parent_song_id && byId.has(s.parent_song_id)) {
      const arr = childrenByParent.get(s.parent_song_id) || [];
      arr.push(s);
      childrenByParent.set(s.parent_song_id, arr);
    }
  }
  const roots = [];
  const parentlessDrills = [];
  for (const s of visibleSongs) {
    const hasVisibleParent = s.parent_song_id && byId.has(s.parent_song_id);
    if (hasVisibleParent) continue; // rendered under its parent
    if (s.song_type === "drill") {
      parentlessDrills.push(s);
    } else {
      roots.push(s);
    }
  }
  return { roots, childrenByParent, parentlessDrills };
}

export default function SongLoader({ onSongLoaded, onSongSaved, onImportError }) {
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [library, setLibrary] = useState([]);
  const [archived, setArchived] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [editingSong, setEditingSong] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editBpm, setEditBpm] = useState("");
  const [editPlaybackSpeed, setEditPlaybackSpeed] = useState("");
  const [editTimingWindow, setEditTimingWindow] = useState("");
  const [editChordMs, setEditChordMs] = useState("");
  const [editMeasureWidth, setEditMeasureWidth] = useState("");
  const [sessionStats, setSessionStats] = useState({}); // { [songId]: { count, lastPlayed } }
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  // `report` surfaces errors that fire AFTER onSongLoaded — by then this
  // component has unmounted and setError targets a dead node, so we also
  // fire onImportError which lives at the SamPlayer level and survives
  // the swap. Keep the local setError call for the pre-load window when
  // SongLoader is still mounted.
  const report = (msg) => {
    setError(msg);
    if (onImportError) onImportError(msg);
  };

  function formatLastPlayed(dateStr) {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    const now = new Date();
    const opts = { month: "long", day: "numeric" };
    if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return date.toLocaleDateString("en-US", opts);
  }

  // Fetch song library and session stats on mount
  useEffect(() => {
    Promise.all([
      supabase
        .from("sam_songs")
        .select("id, title, artist, song_type, parent_song_id, difficulty_tier, default_bpm, playback_speed, default_timing_window_ms, default_chord_ms, default_measure_width, created_at, archived")
        .order("updated_at", { ascending: false }),
      supabase
        .from("sam_sessions")
        .select("song_id, started_at")
        .order("started_at", { ascending: false }),
    ]).then(([{ data: songsData, error: songsError }, { data: sessData }]) => {
      setLoadingLibrary(false);
      if (songsError) {
        console.error("[Sam] Failed to load song library:", songsError);
      } else {
        const all = songsData || [];
        setLibrary(all.filter((s) => !s.archived));
        setArchived(all.filter((s) => s.archived));
      }
      const stats = {};
      for (const sess of (sessData || [])) {
        if (!stats[sess.song_id]) {
          stats[sess.song_id] = { count: 0, lastPlayed: null };
        }
        stats[sess.song_id].count++;
        if (!stats[sess.song_id].lastPlayed) {
          stats[sess.song_id].lastPlayed = sess.started_at;
        }
      }
      setSessionStats(stats);
    });
  }, []);

  async function handleLoadFromLibrary(row) {
    setError(null);
    setLoadingLibrary(true);

    const { data, error: dbError } = await supabase
      .from("sam_songs")
      .select("*")
      .eq("id", row.id)
      .single();

    setLoadingLibrary(false);

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
      measures,
    };
    onSongLoaded(song);
    if (onSongSaved) onSongSaved(data.id);
  }

  async function handleArchive(e, row) {
    e.stopPropagation();
    const { error: dbError } = await supabase
      .from("sam_songs")
      .update({ archived: true })
      .eq("id", row.id);

    if (dbError) {
      console.error("[Sam] Archive failed:", dbError);
    } else {
      setLibrary((prev) => prev.filter((s) => s.id !== row.id));
      setArchived((prev) => [{ ...row, archived: true }, ...prev]);
    }
  }

  async function handleRestore(e, row) {
    e.stopPropagation();
    const { error: dbError } = await supabase
      .from("sam_songs")
      .update({ archived: false })
      .eq("id", row.id);

    if (dbError) {
      console.error("[Sam] Restore failed:", dbError);
    } else {
      setArchived((prev) => prev.filter((s) => s.id !== row.id));
      setLibrary((prev) => [{ ...row, archived: false }, ...prev]);
    }
  }

  function handleEditClick(e, row) {
    e.stopPropagation();
    setEditingSong(row);
    setEditTitle(row.title || "");
    setEditArtist(row.artist || "");
    setEditBpm(String(row.default_bpm || 68));
    setEditPlaybackSpeed(String(row.playback_speed ?? 100));
    setEditTimingWindow(row.default_timing_window_ms != null ? String(row.default_timing_window_ms) : "");
    setEditChordMs(row.default_chord_ms != null ? String(row.default_chord_ms) : "");
    setEditMeasureWidth(row.default_measure_width != null ? String(row.default_measure_width) : "");
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
    } else {
      // Update local state
      const updatedSong = {
        ...editingSong,
        title: editTitle.trim(),
        artist: editArtist.trim() || null,
        default_bpm: bpmNum,
        playback_speed: psNum,
        default_timing_window_ms: timingNum,
        default_chord_ms: chordNum,
        default_measure_width: widthNum,
      };

      if (editingSong.archived) {
        setArchived((prev) => prev.map((s) => (s.id === editingSong.id ? updatedSong : s)));
      } else {
        setLibrary((prev) => prev.map((s) => (s.id === editingSong.id ? updatedSong : s)));
      }

      handleCancelEdit();
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

    if (isJson) {
      try {
        song = JSON.parse(text);
      } catch {
        setError("Invalid JSON — could not parse file");
        return;
      }
      // Strict schema for hand-authored / MCP-authored JSON.
      const { valid, errors } = validateSongDocument(song);
      if (!valid) {
        setError(formatValidationErrors(errors));
        return;
      }
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

    // Load song immediately — don't block on Supabase save
    onSongLoaded(song);

    // Save to Supabase in the background (fire-and-forget)
    const source = isJson ? "json_import" : "musicxml_import";
    supabase
      .from("sam_songs")
      .insert({
        title: song.title || file.name.replace(/\.(json|musicxml|xml|mxl)$/i, ""),
        artist: song.artist || null,
        source,
        source_file: file.name,
        key_signature: song.key || null,
        time_signature: song.timeSignature || "4/4",
        default_bpm: song.defaultBpm || 68,
        measures: song.measures,
        ...lineageFields(song),
      })
      .select("id")
      .single()
      .then(async ({ data, error: dbError }) => {
        if (dbError) {
          console.error("[Sam] Supabase save error:", dbError);
          report(`Song save failed: ${dbError.message}`);
          return;
        }
        console.log("[Sam] Song saved to Supabase, id:", data.id);
        if (onSongSaved) onSongSaved(data.id);
        try {
          await fanOutMeasures(data.id, song.measures, supabase);
        } catch (e) {
          // Song row saved; blob playback works from memory, but no
          // sam_song_measures rows exist. Any feature that reads rows
          // (lyric placement, MCP tools, backfill) will misbehave.
          console.error("[Sam] Measure fan-out failed:", e);
          report(
            `Song saved but measure fan-out failed: ${e.message}. ` +
            `Try re-importing.`
          );
        }
      })
      .catch((e) => {
        console.error("[Sam] Supabase save failed:", e);
        report(`Song save failed: ${e.message}`);
      });
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragging(false);
  }

  function handleFileInput(e) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handlePastedText() {
    setError(null);

    if (!pastedText.trim()) {
      setError("Please paste JSON or MusicXML content");
      return;
    }

    let song;
    let source;

    // Try parsing as JSON first
    try {
      song = JSON.parse(pastedText);
      source = "json_paste";

      const { valid, errors } = validateSongDocument(song);
      if (!valid) {
        setError(formatValidationErrors(errors));
        return;
      }
    } catch {
      // JSON.parse threw — treat as MusicXML. Schema failures don't reach
      // here (they returned inside the try above).
      try {
        song = parseMusicXML(pastedText);
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

    // Load song immediately
    onSongLoaded(song);
    setPastedText(""); // Clear the text area

    // Save to Supabase in the background
    supabase
      .from("sam_songs")
      .insert({
        title: song.title || "Pasted Song",
        artist: song.artist || null,
        source,
        source_file: null,
        key_signature: song.key || null,
        time_signature: song.timeSignature || "4/4",
        default_bpm: song.defaultBpm || 68,
        measures: song.measures,
        ...lineageFields(song),
      })
      .select("id")
      .single()
      .then(async ({ data, error: dbError }) => {
        if (dbError) {
          console.error("[Sam] Supabase save error:", dbError);
          report(`Song save failed: ${dbError.message}`);
          return;
        }
        console.log("[Sam] Song saved to Supabase, id:", data.id);
        if (onSongSaved) onSongSaved(data.id);
        try {
          await fanOutMeasures(data.id, song.measures, supabase);
        } catch (e) {
          console.error("[Sam] Measure fan-out failed:", e);
          report(
            `Song saved but measure fan-out failed: ${e.message}. ` +
            `Try re-importing.`
          );
        }
      })
      .catch((e) => {
        console.error("[Sam] Supabase save failed:", e);
        report(`Song save failed: ${e.message}`);
      });
  }

  return (
    <div className="max-w-lg mx-auto">
      <div
        onClick={() => fileInputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
          dragging
            ? "border-primary bg-primary-light"
            : "border-border hover:border-primary-light bg-card"
        }`}
      >
        <div className="text-4xl mb-3">🎵</div>
        <p className="text-dark font-medium mb-1">
          Drop a song file here
        </p>
        <p className="text-sm text-muted-foreground">
          .json, .musicxml, or .mxl — or click to browse
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.musicxml,.xml,.mxl"
          onChange={handleFileInput}
          className="hidden"
        />
      </div>

      {/* Text paste section */}
      <div className="mt-6">
        <label className="block text-sm font-medium text-foreground mb-2">
          Or paste JSON / MusicXML directly
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          To author a drill, include <code className="font-mono">"songType": "drill"</code> in
          the JSON. Optional <code className="font-mono">"parentSongId"</code> nests it under
          an existing song; omit to file it under the standalone Drills section.
        </p>
        <textarea
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
          placeholder="Paste your JSON or MusicXML content here..."
          className="w-full p-3 border border-border rounded-lg text-sm font-mono resize-y min-h-[120px] focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
        />
        <button
          onClick={handlePastedText}
          disabled={!pastedText.trim()}
          className="mt-2 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Load from Paste
        </button>
      </div>

      {error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* 7-day practice snapshot */}
      <PracticeWeekSnapshot />

      {/* Song Library */}
      {loadingLibrary ? (
        <div className="mt-6 text-center text-sm text-muted-foreground">Loading library...</div>
      ) : library.length > 0 && (() => {
        const { roots, childrenByParent, parentlessDrills } = buildLibraryTree(library);

        // Row renderer — shared by root/child/drill. `indent` shifts children
        // right by one level; spec says "flat in UI" so grandchildren never
        // stack past level 1 in practice. `badge` is a small "variant, tier N"
        // / "drill" label for children so the type is obvious out of context.
        function renderSongRow(row, { indent = 0, badge = null } = {}) {
          const stats = sessionStats[row.id];
          return (
            <div
              key={row.id}
              onClick={() => handleLoadFromLibrary(row)}
              className={`flex items-center gap-3 w-full text-left px-4 py-3 bg-card border border-border rounded-lg hover:bg-secondary transition-colors min-h-[44px] group cursor-pointer ${indent > 0 ? "ml-6" : ""}`}
            >
              <Music className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-medium text-dark">{row.title}</span>
                {row.artist && (
                  <span className="text-muted-foreground ml-1">— {row.artist}</span>
                )}
                {badge && (
                  <span className="ml-2 inline-block text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground align-middle">
                    {badge}
                  </span>
                )}
                {!stats || stats.count === 0 ? (
                  <span className="text-xs text-muted-foreground mt-0.5 block">never played</span>
                ) : (
                  <span className="text-xs text-muted-foreground mt-0.5 block">
                    last played {formatLastPlayed(stats.lastPlayed)} • {stats.count} {stats.count === 1 ? "session" : "sessions"}
                  </span>
                )}
              </div>
              <button
                onClick={(e) => handleEditClick(e, row)}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                title="Edit song"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => handleArchive(e, row)}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-warning opacity-0 group-hover:opacity-100 transition-opacity"
                title="Archive song"
              >
                <Archive className="w-4 h-4" />
              </button>
            </div>
          );
        }

        // Small badge string for children of a parent. Originals never appear
        // as children (only as roots) so they don't need a badge.
        function badgeFor(child) {
          if (child.song_type === "simplified") {
            return child.difficulty_tier ? `variant · tier ${child.difficulty_tier}` : "variant";
          }
          if (child.song_type === "drill") return "drill";
          return null;
        }

        return (
          <>
            {roots.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">Your songs</h3>
                <div className="flex flex-col gap-1">
                  {roots.map((root) => (
                    <React.Fragment key={root.id}>
                      {renderSongRow(root)}
                      {(childrenByParent.get(root.id) || []).map((child) =>
                        renderSongRow(child, { indent: 1, badge: badgeFor(child) })
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            {parentlessDrills.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">Drills</h3>
                <div className="flex flex-col gap-1">
                  {parentlessDrills.map((d) => renderSongRow(d))}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Archived songs toggle + list */}
      {!loadingLibrary && archived.length > 0 && (
        <div className="mt-6 text-center">
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="text-sm text-muted-foregroundhover:text-dark min-h-[44px] px-2"
          >
            {showArchived ? "Hide archived songs" : `View archived songs (${archived.length})`}
          </button>

          {showArchived && (
            <div className="mt-3 text-left">
              <div className="flex flex-col gap-1">
                {archived.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-3 w-full px-4 py-3 bg-secondary border border-border rounded-lg min-h-[44px] opacity-60"
                  >
                    <Music className="w-4 h-4 text-muted-foregroundflex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-dark">{row.title}</span>
                      {row.artist && (
                        <span className="text-muted-foregroundml-1">— {row.artist}</span>
                      )}
                    </div>
                    <button
                      onClick={(e) => handleRestore(e, row)}
                      className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foregroundhover:text-success transition-colors"
                      title="Restore song"
                    >
                      <ArchiveRestore className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
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
