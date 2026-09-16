import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Save, Archive, ArchiveRestore } from "lucide-react";
import RestControl from "./RestControl";
import { supabase } from "../../supabaseClient";
import { formatSnippetTitle, findMatchingSnippet, ensureSnippetSaved } from "../lib/snippetsApi";
import useSnippetPracticeSummary from "../lib/useSnippetPracticeSummary";
import PracticeFigures from "./PracticeFigures";

// Practice figures for one snippet row, in exactly the wording, order and
// spacing used by the "This song" entry on the stats row — same
// `PracticeFigures` component, so the two cannot drift. They flow left to right
// after the title; nothing is right-aligned and nothing is abbreviated beyond
// the "min" and "h" units.
//
// `pointer-events-none` matters: these sit inside the row's load button, and a
// stray click target over them would swallow clicks meant to load the snippet.
function SnippetRowFigures({ stats }) {
  const s = stats || {
    passesToday: 0,
    passesTotal: 0,
    practiceTodaySeconds: 0,
    practiceTotalSeconds: 0,
  };

  return (
    <span className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground font-normal pointer-events-none">
      <PracticeFigures
        passesToday={s.passesToday}
        passesAllTime={s.passesTotal}
        timeTodayMinutes={s.practiceTodaySeconds / 60}
        timeAllTimeMinutes={s.practiceTotalSeconds / 60}
      />
    </span>
  );
}

export default function SnippetPanel({
  songDbId, totalMeasures, snippet, onSnippetChange, scoreTools = null,
}) {
  const [open, setOpen] = useState(false);
  const [startMeas, setStartMeas] = useState(snippet?.startMeasure || 1);
  const [startInput, setStartInput] = useState(String(snippet?.startMeasure || 1));
  const [endMeas, setEndMeas] = useState(snippet?.endMeasure || totalMeasures);
  const [endInput, setEndInput] = useState(String(snippet?.endMeasure || totalMeasures));
  const [restMeasures, setRestMeasures] = useState(snippet?.restMeasures ?? 0);
  const [handMode, setHandMode] = useState(snippet?.handMode || "both");
  const [saving, setSaving] = useState(false);
  const [savedSnippets, setSavedSnippets] = useState([]);
  const [archivedSnippets, setArchivedSnippets] = useState([]);
  const [showArchived, setShowArchived] = useState(false);

  const maxMeas = totalMeasures;

  // Saved snippets are shown newest-created first — the one you just made is
  // the one you most likely want to practise. The fetch below already asks for
  // that order; this keeps it true after local mutations, which the fetch does
  // not re-run for. Restoring an old snippet from the archive used to prepend
  // it, parking a months-old snippet above everything newer until a reload.
  function newestFirst(rows) {
    return [...rows].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
  }

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

  // Mirror whatever is actually loaded into the controls.
  //
  // This exists for Full Song: clearing a snippet used to leave Start and End
  // reading the old snippet's measures, so the panel looked like m.2-2 was still
  // active when it wasn't. Full Song now shows 1 and the song's last measure,
  // which doubles as the only place the song's real measure count is visible.
  //
  // It sets local state ONLY — it never calls `onSnippetChange`. That is the
  // whole point. The panel's defaults ARE the whole song expressed as a range,
  // so an effect that emitted them would silently convert Full Song into a
  // snippet spanning every measure: the exact trap M1.5 avoided by emitting only
  // from real user edits. Resetting these inputs stays inside Full Song state —
  // no snippet created, none adopted, and whole-song passes keep writing a null
  // `snippet_id`. Blurring the reset inputs is a no-op too, because every commit
  // handler returns early when the value has not changed.
  //
  // Running on every `snippet` change (not just on clear) is deliberate: it also
  // keeps the controls honest after a saved snippet is loaded, and it is a
  // no-op in the common case because React bails on identical state.
  useEffect(() => {
    const start = snippet?.startMeasure ?? 1;
    const end = snippet?.endMeasure ?? totalMeasures;
    setStartMeas(start);
    setStartInput(String(start));
    setEndMeas(end);
    setEndInput(String(end));
    setRestMeasures(snippet?.restMeasures ?? 0);
    setHandMode(snippet?.handMode || "both");
  }, [snippet, totalMeasures]);

  // The LIVE saved snippet the controls currently describe, if any. Recomputed
  // every render so it tracks the controls live. Drives whether Save New is
  // offered: there is nothing new to save when this combination is already a
  // visible row.
  //
  // `savedSnippets` deliberately holds only non-archived rows, and that is what
  // makes the archived case work. `findMatchingSnippet` itself is archive-blind
  // (M1.8) — archive state is visibility, not identity — so passing it the live
  // list only is what keeps Save New ON OFFER when the sole match is archived.
  // There is genuinely something to do then: pressing it restores that snippet
  // rather than inserting a twin. Do not "fix" this by passing every row.
  // Lazy, exactly as the removed breakdown section was: no query until the
  // panel is open. Because the panel unmounts during playback and remounts when
  // it stops, these numbers refetch on every stop and are current whenever they
  // are on screen.
  const { byId: practiceById } = useSnippetPracticeSummary({
    songId: songDbId,
    enabled: open,
  });

  const liveMatch = findMatchingSnippet(savedSnippets, {
    startMeasure: startMeas,
    endMeasure: endMeas,
    restMeasures,
    handMode,
  });

  // Load the given range for playback immediately.
  //
  // M1.5 removed the Apply button, so the controls in this panel ARE the
  // loading gesture: committing a measure input, stepping the rest count, or
  // picking a hand mode loads that range straight away. Every emit resolves the
  // range against the saved list first, so a range that has been saved arrives
  // carrying its id rather than as an anonymous copy of itself — the bug that
  // dropped every snippet pass and left `sam_sessions.snippet_id` null.
  //
  // A range with no saved counterpart still leaves here with `dbId: null`.
  // That is not the end of the story any more: pressing Play saves it (see
  // `ensureSnippetSaved`), which is what closes the ad-hoc hole for good.
  //
  // Nothing is emitted on mount or from the defaults — only from a real edit —
  // so opening this panel while the full song is loaded does not quietly select
  // a snippet spanning the whole song. Full Song stays Full Song until the user
  // changes something here.
  function emitRange(next) {
    const range = {
      startMeasure: startMeas,
      endMeasure: endMeas,
      restMeasures,
      handMode,
      ...next,
    };
    const match = findMatchingSnippet(savedSnippets, range);
    onSnippetChange({
      ...range,
      dbId: match ? match.id : null,
      title: match ? match.title : undefined,
    });
  }

  // Commit handlers for the range controls. Each one guards on the value
  // actually changing: RestControl's "−" at zero fires `onChange(0)`, and
  // tabbing through a measure input without editing it blurs unchanged. Either
  // would otherwise load a snippet the user never asked for — which, from the
  // full-song state, would look like Full Song spontaneously turning into a
  // whole-span snippet.
  function commitStart() {
    let n = Number(startInput);
    if (!n || n < 1) n = 1;
    if (n > endMeas) n = endMeas;
    setStartInput(String(n));
    if (n === startMeas) return;
    setStartMeas(n);
    emitRange({ startMeasure: n });
  }

  function commitEnd() {
    let n = Number(endInput);
    if (!n || n < startMeas) n = startMeas;
    if (n > maxMeas) n = maxMeas;
    setEndInput(String(n));
    if (n === endMeas) return;
    setEndMeas(n);
    emitRange({ endMeasure: n });
  }

  function commitRestMeasures(n) {
    if (n === restMeasures) return;
    setRestMeasures(n);
    emitRange({ restMeasures: n });
  }

  function commitHandMode(mode) {
    if (mode === handMode) return;
    setHandMode(mode);
    emitRange({ handMode: mode });
  }

  function handleLoadSnippet(s) {
    setStartMeas(s.start_measure);
    setStartInput(String(s.start_measure));
    setEndMeas(s.end_measure);
    setEndInput(String(s.end_measure));
    setRestMeasures(s.rest_measures ?? 0);
    const hm = s.settings?.handMode || "both";
    setHandMode(hm);

    onSnippetChange({
      startMeasure: s.start_measure,
      endMeasure: s.end_measure,
      restMeasures: s.rest_measures ?? 0,
      handMode: hm,
      dbId: s.id,
      title: s.title,
    });
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
      setArchivedSnippets((prev) => newestFirst([{ ...s, archived: true }, ...prev]));
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
      setSavedSnippets((prev) => newestFirst([{ ...s, archived: false }, ...prev]));
    }
  }

  // Bank the current range as a snippet without playing it.
  //
  // Match-first, exactly as Play's auto-save is: a range that already has a
  // saved snippet adopts it instead of inserting a second row. Pressing this
  // twice on the same range is therefore a no-op the second time, and the two
  // ways to save a range — this button and pressing Play — can never disagree
  // about whether one already exists.
  //
  // There is deliberately no "save over the selected snippet" counterpart. A
  // snippet IS its range, rests and hand mode; changing any of them makes it a
  // different snippet, which this path finds or creates. Overwriting a row in
  // place would retroactively rewrite every `sam_passes` and `sam_sessions` row
  // already pointing at that id — practice history changing under you, with no
  // record that it happened.
  async function handleSaveNew() {
    if (!songDbId) return;
    setSaving(true);

    const result = await ensureSnippetSaved({
      songDbId,
      range: { startMeasure: startMeas, endMeasure: endMeas, restMeasures, handMode },
    });

    if (result) {
      // Covers all three outcomes uniformly: a newly created row, an adopted row
      // this panel's list had not seen yet (auto-saved by Play in an earlier
      // run), and a restored row that was archived until a moment ago. The
      // restored case is why the archived list is filtered here too.
      //
      // `newestFirst` places a restored snippet by its ORIGINAL created_at, not
      // at the top — it is the same snippet it always was, and nothing about
      // restoring it makes it new.
      setArchivedSnippets((prev) => prev.filter((s) => s.id !== result.row.id));
      setSavedSnippets((prev) =>
        prev.some((s) => s.id === result.row.id)
          ? prev
          : newestFirst([result.row, ...prev])
      );
      onSnippetChange(result.snippet);
    }

    setSaving(false);
  }

  return (
    <div className="mb-3">
      {/* The Snippet toggle is a small control on an otherwise empty row, and
          this row is the last one before the score — so the score's own
          controls ride at the far end of it rather than claiming a row. Both
          sides are `min-h-[44px]`, so this costs no vertical space at all. */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-dark min-h-[44px] px-1"
        >
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          Snippet
          {snippet && (
            <span className="text-xs text-primary ml-1">
              (m.{snippet.startMeasure}–{snippet.endMeasure})
            </span>
          )}
        </button>
        {scoreTools && (
          <div className="ml-auto flex items-center gap-2 shrink-0">{scoreTools}</div>
        )}
      </div>

      {open && (
        <div className="mt-1 p-3 bg-card border border-border rounded-lg text-sm">
          {/* Measure range controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-muted-foreground">
              Start:{" "}
              <input
                type="number"
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                onBlur={commitStart}
                onFocus={(e) => e.target.select()}
                className="w-14 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
                min={1} max={endMeas}
              />
            </label>
            <label className="text-muted-foreground">
              End:{" "}
              <input
                type="number"
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                onBlur={commitEnd}
                onFocus={(e) => e.target.select()}
                className="w-14 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
                min={startMeas} max={maxMeas}
              />
            </label>
            <RestControl value={restMeasures} onChange={commitRestMeasures} />
            <div className="flex items-center gap-1 text-muted-foreground">
              Hand:
              {["both", "lh", "rh"].map((mode) => (
                <label key={mode} className={`px-2 py-1 border rounded text-sm min-h-[44px] flex items-center cursor-pointer ${handMode === mode ? "border-primary bg-primary-light text-primary font-medium" : "border-border"}`}>
                  <input
                    type="radio"
                    name="handMode"
                    value={mode}
                    checked={handMode === mode}
                    onChange={() => commitHandMode(mode)}
                    className="sr-only"
                  />
                  {mode === "both" ? "Both" : mode.toUpperCase()}
                </label>
              ))}
            </div>
            {/* Offered only when this combination is not already a LIVE
                snippet. Still offered when the only match is archived, because
                pressing it then restores that snippet (M1.8). */}
            {!liveMatch && (
              <button
                onClick={handleSaveNew}
                disabled={saving || !songDbId}
                className="flex items-center gap-1 px-3 py-1.5 border border-border rounded text-sm text-muted-foreground hover:text-dark min-h-[44px] disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving..." : "Save New"}
              </button>
            )}
          </div>

          {/* Saved snippets list */}
          {savedSnippets.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs text-muted-foreground mb-2 font-medium">Saved snippets</div>
              {/* DO NOT add a max-height or overflow-y here. This list renders
                  at full height by design (M1.7): collapsing the snippet panel
                  is the control over how much room it takes, and an inner
                  scrollbar inside an already-collapsible panel is two competing
                  controls for one thing.

                  It has been added back once already. M4.1 deleted the separate
                  "Snippet breakdown" table and carried its height cap onto this
                  list as a "good property worth keeping" — but that cap belonged
                  to the breakdown, which was NEW stacked vertical space. This
                  list is not: it only exists while the panel is open, and the
                  panel already closes. */}
              <div className="flex flex-col gap-1">
                {savedSnippets.map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-center gap-1 rounded text-sm min-h-[44px] transition-colors group ${
                      snippet?.dbId === s.id
                        ? "bg-primary-light text-primary font-medium"
                        : "hover:bg-secondary text-dark"
                    }`}
                  >
                    {/* The whole row stays one click to load the snippet; the
                        numbers ride inside that same button rather than beside
                        it, so there is no dead strip on the right of the row. */}
                    {/* The whole row stays one click to load the snippet; the
                        figures ride inside that same button rather than beside
                        it, so there is no dead strip on the right of the row.
                        Wrapping rather than truncating: the row may be wide, and
                        a cut-off figure is worse than a taller row. */}
                    <button
                      onClick={() => handleLoadSnippet(s)}
                      className="flex-1 min-w-0 flex items-center gap-3 flex-wrap text-left px-3 py-2"
                    >
                      <span className="font-medium">
                        {formatSnippetTitle({
                          startMeasure: s.start_measure,
                          endMeasure: s.end_measure,
                          handMode: s.settings?.handMode || "both",
                          restMeasures: s.rest_measures ?? 0,
                        })}
                      </span>
                      <SnippetRowFigures stats={practiceById[s.id]} />
                    </button>
                    <button
                      onClick={(e) => handleArchiveSnippet(e, s)}
                      className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-amber-600 opacity-0 group-hover:opacity-100 transition-opacity"
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
            <div className={`text-center ${savedSnippets.length > 0 ? "mt-2" : "mt-3 border-t border-border pt-3"}`}>
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="text-xs text-muted-foreground hover:text-dark min-h-[44px] px-2"
              >
                {showArchived ? "Hide archived snippets" : `View archived snippets (${archivedSnippets.length})`}
              </button>

              {showArchived && (
                <div className="mt-1 text-left">
                  <div className="text-xs text-muted-foreground mb-2 font-medium">Archived</div>
                  {/* Full height, same rule as the saved list above. */}
                  <div className="flex flex-col gap-1">
                    {archivedSnippets.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-1 rounded text-sm min-h-[44px] opacity-60"
                      >
                        {/* Same numbers, same format as a live row. An
                            archived snippet's history is still history, and the
                            existing show/hide toggle is the only filter over
                            it — including one with no history, which reads 0
                            rather than being quietly dropped. */}
                        <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap px-3 py-2">
                          <span className="font-medium">
                            {formatSnippetTitle({
                              startMeasure: s.start_measure,
                              endMeasure: s.end_measure,
                              handMode: s.settings?.handMode || "both",
                              restMeasures: s.rest_measures ?? 0,
                            })}
                          </span>
                          <SnippetRowFigures stats={practiceById[s.id]} />
                        </div>
                        <button
                          onClick={(e) => handleRestoreSnippet(e, s)}
                          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-success transition-colors"
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
