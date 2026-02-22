import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Save, Scissors, Disc, Archive, ArchiveRestore } from "lucide-react";
import { supabase } from "../../supabaseClient";

export default function SnippetPanel({
  songDbId, totalMeasures, snippet, onSnippetChange,
  bpm, timingWindowMs, chordMs, onSettingsOverride,
}) {
  const [open, setOpen] = useState(false);
  const [startMeas, setStartMeas] = useState(snippet?.startMeasure || 1);
  const [startInput, setStartInput] = useState(String(snippet?.startMeasure || 1));
  const [endMeas, setEndMeas] = useState(snippet?.endMeasure || totalMeasures);
  const [endInput, setEndInput] = useState(String(snippet?.endMeasure || totalMeasures));
  const [restMeasures, setRestMeasures] = useState(snippet?.restMeasures ?? 1);
  const [saving, setSaving] = useState(false);
  const [savedSnippets, setSavedSnippets] = useState([]);
  const [archivedSnippets, setArchivedSnippets] = useState([]);
  const [showArchived, setShowArchived] = useState(false);

  const maxMeas = totalMeasures;

  // Load saved snippets for this song
  useEffect(() => {
    if (!songDbId) return;
    supabase
      .from("sam_snippets")
      .select("*")
      .eq("song_id", songDbId)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          console.error("[Sam] Failed to load snippets:", error);
        } else {
          const all = data || [];
          setSavedSnippets(all.filter((s) => !s.archived));
          setArchivedSnippets(all.filter((s) => s.archived));
        }
      });
  }, [songDbId]);

  function handleApply() {
    onSnippetChange({
      startMeasure: startMeas,
      endMeasure: endMeas,
      restMeasures,
      dbId: null,
    });
  }

  function handleFullSong() {
    setStartMeas(1);
    setStartInput("1");
    setEndMeas(totalMeasures);
    setEndInput(String(totalMeasures));
    setRestMeasures(0);
    onSnippetChange(null);
  }

  function handleLoadSnippet(s) {
    setStartMeas(s.start_measure);
    setStartInput(String(s.start_measure));
    setEndMeas(s.end_measure);
    setEndInput(String(s.end_measure));
    setRestMeasures(s.rest_measures ?? 1);

    onSnippetChange({
      startMeasure: s.start_measure,
      endMeasure: s.end_measure,
      restMeasures: s.rest_measures ?? 1,
      dbId: s.id,
      title: s.title,
    });

    // Override settings if snippet has saved settings
    if (s.settings && onSettingsOverride) {
      onSettingsOverride(s.settings);
    }
  }

  async function handleArchiveSnippet(e, s) {
    e.stopPropagation();
    const { error } = await supabase
      .from("sam_snippets")
      .update({ archived: true })
      .eq("id", s.id);

    if (error) {
      console.error("[Sam] Snippet archive failed:", error);
    } else {
      setSavedSnippets((prev) => prev.filter((x) => x.id !== s.id));
      setArchivedSnippets((prev) => [{ ...s, archived: true }, ...prev]);
      if (snippet?.dbId === s.id) onSnippetChange(null);
    }
  }

  async function handleRestoreSnippet(e, s) {
    e.stopPropagation();
    const { error } = await supabase
      .from("sam_snippets")
      .update({ archived: false })
      .eq("id", s.id);

    if (error) {
      console.error("[Sam] Snippet restore failed:", error);
    } else {
      setArchivedSnippets((prev) => prev.filter((x) => x.id !== s.id));
      setSavedSnippets((prev) => [{ ...s, archived: false }, ...prev]);
    }
  }

  async function handleSave() {
    const title = prompt("Snippet title:", `Measures ${startMeas}–${endMeas}`);
    if (!title) return;

    setSaving(true);
    const row = {
      song_id: songDbId,
      title,
      start_measure: startMeas,
      end_measure: endMeas,
      rest_measures: restMeasures,
      settings: { bpm, windowMs: timingWindowMs, chordGroupMs: chordMs },
    };

    supabase
      .from("sam_snippets")
      .insert(row)
      .select("*")
      .single()
      .then(({ data, error }) => {
        setSaving(false);
        if (error) {
          console.error("[Sam] Snippet save error:", error);
        } else {
          console.log("[Sam] Snippet saved:", data.id);
          setSavedSnippets((prev) => [data, ...prev]);
          onSnippetChange({
            startMeasure: startMeas,
            endMeasure: endMeas,
            restMeasures,
            dbId: data.id,
          });
        }
      })
      .catch((e) => {
        setSaving(false);
        console.error("[Sam] Snippet save failed:", e);
      });
  }

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-sm font-medium text-muted hover:text-dark min-h-[44px] px-1"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        Snippet
        {snippet && (
          <span className="text-xs text-primary ml-1">
            (m.{snippet.startMeasure}–{snippet.endMeasure})
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 p-3 bg-white border border-gray-200 rounded-lg text-sm">
          {/* Measure range controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-muted">
              Start:{" "}
              <input
                type="number"
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                onBlur={() => {
                  let n = Number(startInput);
                  if (!n || n < 1) n = 1;
                  if (n > endMeas) n = endMeas;
                  setStartMeas(n);
                  setStartInput(String(n));
                }}
                onFocus={(e) => e.target.select()}
                className="w-14 px-2 py-1 border border-gray-300 rounded text-sm min-h-[44px]"
                min={1} max={endMeas}
              />
            </label>
            <label className="text-muted">
              End:{" "}
              <input
                type="number"
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                onBlur={() => {
                  let n = Number(endInput);
                  if (!n || n < startMeas) n = startMeas;
                  if (n > maxMeas) n = maxMeas;
                  setEndMeas(n);
                  setEndInput(String(n));
                }}
                onFocus={(e) => e.target.select()}
                className="w-14 px-2 py-1 border border-gray-300 rounded text-sm min-h-[44px]"
                min={startMeas} max={maxMeas}
              />
            </label>
            <div className="flex items-center gap-1 text-muted">
              Rest:
              <button
                onClick={() => setRestMeasures(Math.max(0, restMeasures - 1))}
                className="w-8 h-8 flex items-center justify-center border border-gray-300 rounded text-lg min-h-[44px] min-w-[44px]"
              >
                −
              </button>
              <span className="w-6 text-center font-medium text-dark">{restMeasures}</span>
              <button
                onClick={() => setRestMeasures(restMeasures + 1)}
                className="w-8 h-8 flex items-center justify-center border border-gray-300 rounded text-lg min-h-[44px] min-w-[44px]"
              >
                +
              </button>
            </div>
            <button
              onClick={handleSave}
              disabled={saving || !songDbId}
              className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded text-sm text-muted hover:text-dark min-h-[44px] disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={handleApply}
              className="flex items-center gap-1 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white rounded text-sm font-medium min-h-[44px]"
            >
              <Scissors className="w-3.5 h-3.5" />
              Apply m.{startMeas}–{endMeas}
            </button>
            {snippet && (
              <button
                onClick={handleFullSong}
                className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded text-sm text-muted hover:text-dark min-h-[44px]"
              >
                <Disc className="w-3.5 h-3.5" />
                Full Song
              </button>
            )}
          </div>

          {/* Saved snippets list */}
          {savedSnippets.length > 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <div className="text-xs text-muted mb-2 font-medium">Saved snippets</div>
              <div className="flex flex-col gap-1">
                {savedSnippets.map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-center gap-1 rounded text-sm min-h-[44px] transition-colors group ${
                      snippet?.dbId === s.id
                        ? "bg-primary-light text-primary font-medium"
                        : "hover:bg-gray-50 text-dark"
                    }`}
                  >
                    <button
                      onClick={() => handleLoadSnippet(s)}
                      className="flex-1 text-left px-3 py-2"
                    >
                      <span className="font-medium">{s.title}</span>
                      <span className="text-muted ml-2">
                        m.{s.start_measure}–{s.end_measure}
                        {s.settings?.bpm && ` · ${s.settings.bpm} BPM`}
                        {s.rest_measures > 0 && ` · ${s.rest_measures} rest`}
                      </span>
                    </button>
                    <button
                      onClick={(e) => handleArchiveSnippet(e, s)}
                      className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-300 hover:text-amber-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Archive snippet"
                    >
                      <Archive className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

            </div>
          )}

          {/* Archived snippets toggle + list */}
          {archivedSnippets.length > 0 && (
            <div className={`text-center ${savedSnippets.length > 0 ? "mt-2" : "mt-3 border-t border-gray-100 pt-3"}`}>
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="text-xs text-muted hover:text-dark min-h-[44px] px-2"
              >
                {showArchived ? "Hide archived snippets" : `View archived snippets (${archivedSnippets.length})`}
              </button>

              {showArchived && (
                <div className="mt-1 text-left">
                  <div className="flex flex-col gap-1">
                    {archivedSnippets.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-1 rounded text-sm min-h-[44px] opacity-60"
                      >
                        <div className="flex-1 px-3 py-2">
                          <span className="font-medium">{s.title}</span>
                          <span className="text-muted ml-2">
                            m.{s.start_measure}–{s.end_measure}
                          </span>
                        </div>
                        <button
                          onClick={(e) => handleRestoreSnippet(e, s)}
                          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted hover:text-green-600 transition-colors"
                          title="Restore snippet"
                        >
                          <ArchiveRestore className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
