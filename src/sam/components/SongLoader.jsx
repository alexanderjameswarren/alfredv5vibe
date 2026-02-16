import React, { useState, useRef, useEffect } from "react";
import { Archive, ArchiveRestore, Music } from "lucide-react";
import { supabase } from "../../supabaseClient";
import { parseMusicXML } from "../lib/songParser";

function validateSong(song) {
  if (!song || typeof song !== "object") return "Invalid JSON: not an object";
  if (!Array.isArray(song.measures) || song.measures.length === 0)
    return "Invalid song: must have a non-empty measures array";
  for (let i = 0; i < song.measures.length; i++) {
    const m = song.measures[i];
    const hasBeats = Array.isArray(m.beats) && m.beats.length > 0;
    const hasVoices = Array.isArray(m.rh) || Array.isArray(m.lh);
    if (!hasBeats && !hasVoices)
      return `Invalid song: measure ${i + 1} must have beats[] or rh[]/lh[] arrays`;
  }
  return null;
}

export default function SongLoader({ onSongLoaded, onSongSaved }) {
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [library, setLibrary] = useState([]);
  const [archived, setArchived] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const fileInputRef = useRef(null);

  // Fetch song library on mount
  useEffect(() => {
    supabase
      .from("sam_songs")
      .select("id, title, artist, default_bpm, created_at, archived, measures")
      .order("updated_at", { ascending: false })
      .then(({ data, error: dbError }) => {
        setLoadingLibrary(false);
        if (dbError) {
          console.error("[Sam] Failed to load song library:", dbError);
        } else {
          const all = data || [];
          setLibrary(all.filter((s) => !s.archived));
          setArchived(all.filter((s) => s.archived));
        }
      });
  }, []);

  function handleLoadFromLibrary(row) {
    const song = {
      title: row.title,
      artist: row.artist,
      defaultBpm: row.default_bpm,
      measures: row.measures,
    };
    onSongLoaded(song);
    if (onSongSaved) onSongSaved(row.id);
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

  async function handleFile(file) {
    setError(null);

    const name = file.name.toLowerCase();
    const isJson = name.endsWith(".json");
    const isMusicXml = name.endsWith(".musicxml") || name.endsWith(".xml");

    if (!isJson && !isMusicXml) {
      setError("Supported formats: .json, .musicxml, .xml");
      return;
    }

    let text;
    try {
      text = await file.text();
    } catch {
      setError("Could not read file");
      return;
    }

    let song;

    if (isJson) {
      try {
        song = JSON.parse(text);
      } catch {
        setError("Invalid JSON — could not parse file");
        return;
      }
      const validationError = validateSong(song);
      if (validationError) {
        setError(validationError);
        return;
      }
    } else {
      try {
        song = parseMusicXML(text);
      } catch (e) {
        setError("MusicXML parse error: " + e.message);
        return;
      }
      const validationError = validateSong(song);
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
        title: song.title || file.name.replace(/\.(json|musicxml|xml)$/i, ""),
        artist: song.artist || null,
        source,
        source_file: file.name,
        key_signature: song.key || null,
        time_signature: song.timeSignature || "4/4",
        default_bpm: song.defaultBpm || 68,
        measures: song.measures,
      })
      .select("id")
      .single()
      .then(({ data, error: dbError }) => {
        if (dbError) {
          console.error("[Sam] Supabase save error:", dbError);
        } else {
          console.log("[Sam] Song saved to Supabase, id:", data.id);
          if (onSongSaved) onSongSaved(data.id);
        }
      })
      .catch((e) => console.error("[Sam] Supabase save failed:", e));
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
            : "border-gray-300 hover:border-primary-light bg-white"
        }`}
      >
        <div className="text-4xl mb-3">🎵</div>
        <p className="text-dark font-medium mb-1">
          Drop a song file here
        </p>
        <p className="text-sm text-muted">
          .json or .musicxml — or click to browse
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.musicxml,.xml"
          onChange={handleFileInput}
          className="hidden"
        />
      </div>

      {error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Song Library */}
      {loadingLibrary ? (
        <div className="mt-6 text-center text-sm text-muted">Loading library...</div>
      ) : library.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-muted mb-2">Your songs</h3>
          <div className="flex flex-col gap-1">
            {library.map((row) => (
              <div
                key={row.id}
                onClick={() => handleLoadFromLibrary(row)}
                className="flex items-center gap-3 w-full text-left px-4 py-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors min-h-[44px] group cursor-pointer"
              >
                <Music className="w-4 h-4 text-muted flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-dark">{row.title}</span>
                  {row.artist && (
                    <span className="text-muted ml-1">— {row.artist}</span>
                  )}
                  <span className="text-xs text-muted ml-2">
                    {row.measures?.length || 0} measures · {row.default_bpm || 68} BPM
                  </span>
                </div>
                <button
                  onClick={(e) => handleArchive(e, row)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-300 hover:text-amber-600 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Archive song"
                >
                  <Archive className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Archived songs toggle + list */}
      {!loadingLibrary && archived.length > 0 && (
        <div className="mt-6 text-center">
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="text-sm text-muted hover:text-dark min-h-[44px] px-2"
          >
            {showArchived ? "Hide archived songs" : `View archived songs (${archived.length})`}
          </button>

          {showArchived && (
            <div className="mt-3 text-left">
              <div className="flex flex-col gap-1">
                {archived.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-3 w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg min-h-[44px] opacity-60"
                  >
                    <Music className="w-4 h-4 text-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-dark">{row.title}</span>
                      {row.artist && (
                        <span className="text-muted ml-1">— {row.artist}</span>
                      )}
                    </div>
                    <button
                      onClick={(e) => handleRestore(e, row)}
                      className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted hover:text-green-600 transition-colors"
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
    </div>
  );
}
