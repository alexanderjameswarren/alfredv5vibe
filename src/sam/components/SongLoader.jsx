import React, { useState, useEffect } from "react";
import { supabase } from "../../supabaseClient";
import { parseMusicXML } from "../lib/songParser";
import { fanOutMeasures, isMeasuresStale, recompileMeasures } from "../lib/measureCompiler";
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
function lineageFields(doc) {
  return {
    song_type: doc.songType || "original",
    parent_song_id: doc.parentSongId || null,
    difficulty_tier: doc.difficultyTier ?? null,
    generation_notes: doc.generationNotes || null,
  };
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

  function handlePastedText(text) {
    setError(null);

    if (!text.trim()) {
      setError("Please paste JSON or MusicXML content");
      return;
    }

    let song;
    let source;

    // Try parsing as JSON first
    try {
      song = JSON.parse(text);
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

    // Load song immediately
    onSongLoaded(song);

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
