import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { SAM_PATH, samSongPath, samSongIdFromPath } from "../viewPaths";
import { ArrowLeft } from "lucide-react";
import ScoreRenderer from "./components/ScoreRenderer";
import ScrollEngine from "./components/ScrollEngine";
import SongLoader from "./components/SongLoader";
import SettingsBar from "./components/SettingsBar";
import StatsBar from "./components/StatsBar";
import SnippetPanel from "./components/SnippetPanel";
import AudioControls from "./components/AudioControls";
import FocusedPlaybackBar from "./components/FocusedPlaybackBar";
import useMIDI from "./lib/useMIDI";
import usePracticeSession from "./lib/usePracticeSession";
import usePracticeStats from "./lib/usePracticeStats";
import useLyricEditor from "./lib/useLyricEditor";
import useFingeringEditor from "./lib/useFingeringEditor";
import FingeringBar from "./components/FingeringBar";
import useAudioSync from "./lib/useAudioSync";
import useNumericInput from "./lib/useNumericInput";
import { DEFAULTS } from "./lib/samConstants";
import { matchChord, findClosestBeat } from "./lib/noteMatching";
import { colorBeatEls, midiDisplayName } from "./lib/vexflowHelpers";
import { normalizeMeasure } from "./lib/measureUtils";
import { loadAudio } from "./lib/audioPlayer";
import { buildSongExport } from "./lib/songExport";
import { fetchSongById } from "./lib/songLoad";
import { supabase } from "../supabaseClient";

function AudioMsCounter({ audioElement }) {
  const [ms, setMs] = useState(0);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!audioElement) return;
    function tick() {
      setMs(Math.round(audioElement.currentTime * 1000));
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [audioElement]);

  return (
    <span className="text-sm font-mono font-medium text-foreground tabular-nums whitespace-nowrap">
      {ms} ms
    </span>
  );
}

export default function SamPlayer({ onBack }) {
  const location = useLocation();
  const navigate = useNavigate();
  // Which song the URL says is open. null on /sam and /sam/stats.
  const songIdFromUrl = samSongIdFromPath(location.pathname);

  const [song, setSong] = useState(null);
  const [songDbId, setSongDbId] = useState(null);
  // Phase 6 M1 — the parent of a simplified song, loaded READ-ONLY for the
  // ghost overlay. Deliberately a separate piece of state: the fingering and
  // lyric hooks stay keyed on `songDbId` and must not be re-pointed at it.
  const [parentSong, setParentSong] = useState(null);
  // Ghost overlay controls. Same shape as fingeringMode: plain local state,
  // layer-only effects in ScoreRenderer, button in the stopped branch.
  const [ghostMode, setGhostMode] = useState(false);
  const [ghostHands, setGhostHands] = useState("both"); // "both" | "rh" | "lh"
  const [ghostOpacity, setGhostOpacity] = useState(0.28);
  // Fingering entry mode (edit view). Off by default. When on, the tap-zone layer
  // is active, other score gestures are suppressed, and the number bar docks.
  const [fingeringMode, setFingeringMode] = useState(false);
  const [fingeringSelection, setFingeringSelection] = useState(null); // { measureNum, rhIndex, noteIndex }
  // Import-error banner. SongLoader unmounts the moment `song` is set (a new
  // song has loaded), so async failures inside its fan-out `.catch` land on
  // a dead component. This state lives at the SamPlayer level so the banner
  // survives the SongLoader unmount and reaches the user.
  const [importError, setImportError] = useState(null);
  const bpm = useNumericInput(DEFAULTS.bpm);
  const [playbackState, setPlaybackState] = useState("stopped"); // 'stopped' | 'playing' | 'paused'
  const [pausedMeasure, setPausedMeasure] = useState(null);
  const [loopCount, setLoopCount] = useState(0);
  const [missCount, setMissCount] = useState(0);
  const timingWindowMs = useNumericInput(DEFAULTS.timingWindowMs);
  const chordMs = useNumericInput(DEFAULTS.chordMs);
  const [hitCount, setHitCount] = useState(0);
  const measureWidth = useNumericInput(DEFAULTS.measureWidth);
  const [lastResult, setLastResult] = useState(null);
  const [snippet, setSnippet] = useState(null); // { startMeasure, endMeasure, restMeasures, dbId }
  const [metronome, setMetronome] = useState("off"); // "off" | "beat" | "halfbeat" | "quarterbeat"
  // Full score playback (spec D4). A separate dimension from `metronome`, not a
  // fifth value on it: the user may plausibly want the synth and a click at the
  // same time. Not persisted, not in DEFAULTS, not reset by handleSongLoaded —
  // matches how `metronome` is handled.
  // "off" | "lh" | "rh" | "full" — "full" is both hands. Independent of a
  // snippet's handMode: that picks the hand the player is SCORED on, this
  // picks the hand the synth SOUNDS, so "practise RH against a synth LH" works.
  const [scorePlayback, setScorePlayback] = useState("off");
  const [audioElement, setAudioElement] = useState(null);
  const [audioFilePath, setAudioFilePath] = useState(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const playbackSpeed = useNumericInput(DEFAULTS.playbackSpeed);
  const beatEventsRef = useRef([]);
  const scrollStateExtRef = useRef(null);
  const hitCountRef = useRef(0);
  const missCountRef = useRef(0);
  const audioCtxRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const [skipTiedNotes, setSkipTiedNotes] = useState(false);

  // Bumped each time a session's ended_at lands in the DB. Flows down to
  // StatsBar's `usePracticeStats` so the Today/Total totals refetch the
  // moment the just-ended session is committed.
  const [practiceStatsRefetchSignal, setPracticeStatsRefetchSignal] = useState(0);

  const { startSession, endSession, recordEvent, setLoopIteration, stats: sessionStats } = usePracticeSession({
    onSessionEnded: () => setPracticeStatsRefetchSignal((n) => n + 1),
  });

  // Hoisted from StatsBar so the playback-row LiveSessionCounter and the
  // stopped/paused PracticeTimeIndicator share one fetch.
  const { todayMinutes, perSongTotalSeconds } = usePracticeStats({
    currentSongId: songDbId,
    refetchSignal: practiceStatsRefetchSignal,
  });

  const {
    lyricPlacements,
    setLyricPlacements,
    lyricsDirty,
    lyricsSaving,
    lyricEditHandlers,
    saveLyrics,
  } = useLyricEditor({ song, songDbId, skipTiedNotes, supabase });

  // Fingering writes + resolved render map (load, optimistic set/clear, undo).
  // Imported (musicxml) fingerings default to SHOWN — `?? true` — so a
  // freshly imported score displays its editorial fingering without a toggle.
  const showImportedFingerings = song?.showImportedFingerings ?? true;
  const {
    fingerings,
    byCoord: fingeringsByCoord,
    hasImported,
    setFinger,
    clearFinger,
    undo: undoFingering,
    canUndo: canUndoFingering,
    error: fingeringError,
    dismissError: dismissFingeringError,
  } = useFingeringEditor({ songId: songDbId, showImported: showImportedFingerings });

  // Toggle "show imported fingerings" from the score toolbar. Updates the live
  // song immediately (the hook re-resolves) and persists to sam_songs. Same
  // effect as the settings-modal checkbox.
  const toggleShowImported = useCallback(() => {
    const next = !showImportedFingerings;
    setSong((s) => (s ? { ...s, showImportedFingerings: next } : s));
    if (songDbId) {
      supabase
        .from("sam_songs")
        .update({ show_imported_fingerings: next })
        .eq("id", songDbId)
        .then(({ error }) => {
          if (error) console.error("[Sam] Failed to toggle imported fingerings:", error);
        });
    }
  }, [showImportedFingerings, songDbId]);

  // A selection can't survive a song change (its coordinate references old measures).
  useEffect(() => { setFingeringSelection(null); }, [songDbId]);

  // Load the parent of a simplified song, read-only, for the ghost overlay.
  // `cancelled` guards against a slow fetch resolving after the user has moved
  // on to a different song.
  useEffect(() => {
    const parentId = song?.parentSongId;
    if (!parentId) { setParentSong(null); return; }
    let cancelled = false;
    fetchSongById(parentId, supabase)
      .then(({ song: parent }) => { if (!cancelled) setParentSong(parent); })
      .catch((e) => {
        console.error("[Sam] Failed to load parent song for the ghost overlay:", e);
        if (!cancelled) setParentSong(null);
      });
    return () => { cancelled = true; };
  }, [song?.parentSongId]);

  // Derive active measures from snippet range, appending rest measures.
  // normalizeMeasure ensures both voice format (lh[]/rh[]) and legacy beats[]
  // are converted to beats[] for the renderers.
  // When lyricPlacements state exists, it overrides blob lyrics as the source of truth.
  const activeMeasures = useMemo(() => {
    if (!song) return [];

    const baseMeasures = !snippet
      ? song.measures
      : song.measures.slice(snippet.startMeasure - 1, snippet.endMeasure);

    // Append empty rest measures (voice format — whole-note rests)
    const restCount = snippet?.restMeasures || 0;
    const restMeasures = [];
    const endNum = snippet?.endMeasure || baseMeasures.length;
    for (let i = 0; i < restCount; i++) {
      restMeasures.push({
        number: endNum + i + 1,
        lh: [{ duration: "w", notes: [] }],
        rh: [{ duration: "w", notes: [] }],
      });
    }

    let allMeasures = [...baseMeasures, ...restMeasures];

    // If we have lyric placements in state, inject them onto RH events
    // (overriding any lyrics baked into the blob)
    if (lyricPlacements) {
      const lyricsByMeasure = {};
      for (const lp of lyricPlacements) {
        if (lp.measure_num == null) continue;
        if (!lyricsByMeasure[lp.measure_num]) lyricsByMeasure[lp.measure_num] = [];
        lyricsByMeasure[lp.measure_num].push(lp);
      }

      allMeasures = allMeasures.map(m => {
        if (!m.rh) return m;
        // Strip existing lyrics, then inject from state
        const rh = m.rh.map(evt => {
          const { lyric, ...rest } = evt;
          return rest;
        });
        const measLyrics = lyricsByMeasure[m.number] || [];
        for (const lp of measLyrics) {
          if (lp.rh_index >= 0 && lp.rh_index < rh.length) {
            const existing = rh[lp.rh_index].lyric;
            rh[lp.rh_index] = {
              ...rh[lp.rh_index],
              lyric: existing ? existing + " " + lp.syllable : lp.syllable,
            };
          }
        }
        return { ...m, rh };
      });
    }

    return allMeasures.map(normalizeMeasure);
  }, [song, snippet, lyricPlacements]);

  // Parent measures for the ghost overlay, sliced IDENTICALLY to the child.
  //
  // This is the single most likely source of a wrong-looking diff. `activeMeasures`
  // applies the snippet slice before rendering, so a parent sliced differently —
  // or not at all — would draw ghosts under the wrong bars and the overlay would
  // look broken for reasons that have nothing to do with the simplifier. The
  // measure numbers are therefore asserted to match before anything is drawn,
  // and a mismatch returns null rather than drawing something misleading.
  const ghostMeasures = useMemo(() => {
    if (!ghostMode) return null;
    if (!parentSong?.measures || !song?.measures) return null;

    const sliced = !snippet
      ? parentSong.measures
      : parentSong.measures.slice(snippet.startMeasure - 1, snippet.endMeasure);

    // Compare against the child's base slice — activeMeasures may have empty
    // rest measures appended past the end, which the parent has no counterpart
    // for and which carry no ghosts anyway.
    for (let i = 0; i < sliced.length; i++) {
      const childNum = activeMeasures[i]?.number;
      if (childNum !== sliced[i].number) {
        console.error(
          "[Sam] Ghost overlay disabled: parent/child measures are misaligned at index " +
            `${i} (child m${childNum} vs parent m${sliced[i].number}). ` +
            "The two slices must match exactly or the diff is meaningless."
        );
        return null;
      }
    }

    return sliced;
  }, [ghostMode, parentSong, song, snippet, activeMeasures]);

  // Flat ordered sequence of non-rest RH events, for the number bar's "next" (›)
  // advance. Rests are skipped — you can't finger a rest.
  const rhNoteSeq = useMemo(() => {
    const seq = [];
    for (const m of activeMeasures) {
      (m.rh || []).forEach((evt, i) => {
        if ((evt.notes?.length || 0) > 0) {
          seq.push({ measureNum: m.number, rhIndex: i, noteheadCount: evt.notes.length });
        }
      });
    }
    return seq;
  }, [activeMeasures]);

  // Details of the currently selected event (for the number bar).
  const selectedSeqIndex = useMemo(() => {
    if (!fingeringSelection) return -1;
    return rhNoteSeq.findIndex(
      (e) => e.measureNum === fingeringSelection.measureNum && e.rhIndex === fingeringSelection.rhIndex
    );
  }, [rhNoteSeq, fingeringSelection]);
  const selectedNoteheadCount =
    selectedSeqIndex >= 0 ? rhNoteSeq[selectedSeqIndex].noteheadCount : 0;
  const selectedCurrentFinger = fingeringSelection
    ? fingerings[`${fingeringSelection.measureNum}:${fingeringSelection.rhIndex}:${fingeringSelection.noteIndex}`] ?? null
    : null;

  const handleFingeringNumber = useCallback((n) => {
    if (fingeringSelection) setFinger(fingeringSelection, n);
  }, [fingeringSelection, setFinger]);
  const handleFingeringClear = useCallback(() => {
    if (fingeringSelection) clearFinger(fingeringSelection);
  }, [fingeringSelection, clearFinger]);
  const handleFingeringAdvance = useCallback(() => {
    if (selectedSeqIndex < 0 || selectedSeqIndex >= rhNoteSeq.length - 1) return;
    const next = rhNoteSeq[selectedSeqIndex + 1];
    // Default to the top notehead (melody note) on the new event.
    setFingeringSelection({ measureNum: next.measureNum, rhIndex: next.rhIndex, noteIndex: Math.max(0, next.noteheadCount - 1) });
  }, [selectedSeqIndex, rhNoteSeq]);
  const handlePickNotehead = useCallback((ni) => {
    setFingeringSelection((sel) => (sel ? { ...sel, noteIndex: ni } : sel));
  }, []);

  const {
    audioAnchors,
    getSeekForMeasure,
    getSnippetAudioEndMs,
    scheduleAudioStartOnScroll,
    prepareAudioSeek,
    clearTimers,
  } = useAudioSync({
    song,
    snippet,
    activeMeasures,
    bpm: bpm.value,
    playbackSpeed: playbackSpeed.value,
    audioElement,
    scrollContainerRef,
    measureWidth: measureWidth.value,
  });

  const handleChord = useCallback((played) => {
    if (playbackState !== "playing") return;
    const scrollState = scrollStateExtRef.current;
    if (!scrollState) return;

    const now = performance.now();
    const elapsed = now - scrollState.scrollStartT;
    console.log(
      `[PLAY] midi=[${played}] at elapsed=${Math.round(elapsed)}ms`
    );

    // Hand mode filtering: only match notes from the active hand
    const hm = snippet?.handMode || "both";

    const match = findClosestBeat(beatEventsRef.current, scrollState, timingWindowMs.value, hm);
    if (!match) {
      console.log(`[PLAY] No pending beat found within ±${timingWindowMs.value}ms`);
      const names = played.map((m) => midiDisplayName(m)).join(", ");
      setLastResult({ result: "none", timingMs: 0, noteName: names });
      return;
    }

    const { beat, timingDeltaMs } = match;
    const activeMidi = hm === "lh" ? beat.lhMidi : hm === "rh" ? beat.rhMidi : beat.allMidi;

    console.log(
      `[MATCH] candidate: m${beat.meas} beat=${beat.beat} midi=[${activeMidi}]`,
      `| targetTime=${Math.round(beat.targetTimeMs)}ms`,
      `| delta=${Math.round(timingDeltaMs)}ms`,
      `| ${timingDeltaMs > 0 ? 'EARLY' : 'LATE'} by ${Math.abs(Math.round(timingDeltaMs))}ms`
    );

    const { result, missingNotes, extraNotes } = matchChord(played, activeMidi);

    console.log(
      `[RESULT] ${result}`,
      `| played=[${played}] expected=[${activeMidi}]`,
      `| missing=[${missingNotes}] extra=[${extraNotes}]`
    );

    // If player hit ONLY wrong notes (zero overlap with expected), don't consume the beat.
    // Leave it pending so the player can try again before the miss scanner catches it.
    if (result === "miss" && missingNotes.length === activeMidi.length) {
      console.log(`[SKIP] All notes wrong — beat NOT consumed, stays pending`);
      return;
    }

    // Color only the active hand's SVG elements; inactive hand stays black
    const activeEls = hm === "lh" ? [beat.bassSvgEl].filter(Boolean)
                    : hm === "rh" ? [beat.trebleSvgEl].filter(Boolean)
                    : beat.svgEls;

    if (result === "hit") {
      beat.state = "hit";
      colorBeatEls({ svgEls: activeEls }, "#16a34a");
      hitCountRef.current++;
      setHitCount(hitCountRef.current);
    } else if (result === "partial") {
      beat.state = "partial";
      colorBeatEls({ svgEls: activeEls }, "#d97706");
      hitCountRef.current++;
      setHitCount(hitCountRef.current);
    } else {
      beat.state = "wrong";
      colorBeatEls({ svgEls: activeEls }, "#dc2626");
      missCountRef.current++;
      setMissCount(missCountRef.current);
    }

    console.log(
      `[CONSUME] m${beat.meas} beat=${beat.beat} → ${result}`
    );

    recordEvent({ beatEvent: beat, played, timingDeltaMs, result });

    const sign = timingDeltaMs >= 0 ? "+" : "";
    setLastResult({
      result,
      timingMs: Math.round(timingDeltaMs),
      noteName: `${sign}${Math.round(timingDeltaMs)}ms`,
    });
  }, [playbackState, recordEvent, timingWindowMs.value, snippet?.handMode]);

  const { connected: midiConnected, deviceName: midiDevice, lastNote } = useMIDI({
    onChord: handleChord,
    chordGroupMs: chordMs.value,
  });

  const handleBeatEvents = useCallback((events) => {
    beatEventsRef.current = events;
    window.samBeatEvents = events;
    window.colorBeatEls = colorBeatEls;
  }, []);

  const handleLoopCount = useCallback((n) => {
    setLoopCount(n);
    setLoopIteration(n);
    if (n > 0) setPausedMeasure(null);
  }, [setLoopIteration]);

  const handleBeatMiss = useCallback((evt) => {
    missCountRef.current++;
    setMissCount(missCountRef.current);
    recordEvent({ beatEvent: evt, played: [], timingDeltaMs: null, result: "miss" });
  }, [recordEvent]);

  async function handleSaveLyrics() {
    const newMeasures = await saveLyrics();
    if (newMeasures) setSong((prev) => ({ ...prev, measures: newMeasures }));
  }

  function handleSongLoaded(loadedSong) {
    // A new successful load clears any stale import-error banner.
    setImportError(null);
    setSong(loadedSong);
    setSongDbId(null);
    setSnippet(null);
    setAudioFilePath(loadedSong.audioFilePath || null);
    bpm.reset(loadedSong.defaultBpm || DEFAULTS.bpm);
    timingWindowMs.reset(loadedSong.defaultTimingWindowMs ?? DEFAULTS.timingWindowMs);
    chordMs.reset(loadedSong.defaultChordMs ?? DEFAULTS.chordMs);
    measureWidth.reset(loadedSong.defaultMeasureWidth ?? DEFAULTS.measureWidth);
    playbackSpeed.reset(loadedSong.playbackSpeed ?? DEFAULTS.playbackSpeed);
    setPlaybackState("stopped");
    setPausedMeasure(null);
    setLoopCount(0);
    setMissCount(0);
    setHitCount(0);
    setLastResult(null);
    setAudioMuted(false);
    hitCountRef.current = 0;
    missCountRef.current = 0;
  }

  // Load audio when song has an audio_file_path
  useEffect(() => {
    if (audioElement) {
      audioElement.pause();
      setAudioElement(null);
    }
    if (!songDbId || !audioFilePath) return;

    let cancelled = false;
    loadAudio(songDbId, audioFilePath, supabase)
      .then((audio) => {
        if (!cancelled) setAudioElement(audio);
      })
      .catch((e) => console.error("[Sam] Failed to load audio:", e));

    return () => { cancelled = true; };
  }, [songDbId, audioFilePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync audio playback rate: playbackSpeed / 100
  useEffect(() => {
    if (!audioElement) return;
    audioElement.playbackRate = playbackSpeed.value / 100;
    audioElement.preservesPitch = true;
  }, [audioElement, playbackSpeed.value]);

  // Sync mute state to the audio element.
  //
  // Any active score-playback mode silences the MP3 for the duration of a run
  // (spec D6) — the synth IS the audio then. This includes the LH/RH modes:
  // the MP3 is the full recording, so letting it through would drown the single
  // hand the user asked to isolate and defeat the point of the mode.
  // It must be MUTED rather than paused:
  // ScrollEngine derives `elapsed` from audioElement.currentTime via anchor
  // interpolation, so pausing the element would take the scroll's clock away
  // with it. Only the output is silenced.
  //
  // Gated on "playing" so the mode doesn't leave the MP3 muted once stopped,
  // where AudioControls' scrubber is the only way to preview it. That also
  // gives the "restored on stop / on mode change" behaviour for free — this
  // effect re-runs on both.
  useEffect(() => {
    if (!audioElement) return;
    const mutedForScorePlayback = scorePlayback !== "off" && playbackState === "playing";
    audioElement.muted = audioMuted || mutedForScorePlayback;
  }, [audioElement, audioMuted, scorePlayback, playbackState]);

  // Snippet ↔ full-song transitions (and snippet → different snippet) reset
  // playback to the stopped state, mirroring the Stop button so the score is
  // scrollable again and only the Play button is visible.
  const prevSnippetRef = useRef(snippet);
  useEffect(() => {
    const prev = prevSnippetRef.current;
    prevSnippetRef.current = snippet;
    if (prev === snippet) return;
    handleFullStop();
  }, [snippet]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleAudioUploaded(path) {
    setAudioFilePath(path);
  }

  async function handleAudioOffsetChange(measureNumber, audioMs) {
    if (!song || !songDbId) return;

    const updatedMeasures = song.measures.map((m) => {
      if (m.number !== measureNumber) return m;
      if (audioMs == null) {
        const { audioOffsetMs, ...rest } = m;
        return rest;
      }
      return { ...m, audioOffsetMs: audioMs };
    });

    setSong({ ...song, measures: updatedMeasures });

    const { error } = await supabase
      .from("sam_songs")
      .update({ measures: updatedMeasures })
      .eq("id", songDbId);

    if (error) {
      console.error("[Sam] Audio offset update failed:", error);
    }
  }

  function resetCounters() {
    hitCountRef.current = 0;
    missCountRef.current = 0;
    setHitCount(0);
    setMissCount(0);
    setLastResult(null);
  }

  function beginSession() {
    startSession({
      songId: songDbId,
      snippetId: snippet?.dbId || null,
      settings: {
        bpm: bpm.value,
        windowMs: timingWindowMs.value,
        chordGroupMs: chordMs.value,
        measureWidth: measureWidth.value,
        playbackSpeed: playbackSpeed.value,
      },
    });
  }

  // Determine which measure is at the target line right now
  function getCurrentMeasure() {
    const scrollState = scrollStateExtRef.current;
    const events = beatEventsRef.current;
    if (!scrollState || !events.length) return null;
    // Use ScrollEngine's audio-synced elapsed (updated every frame) when available,
    // falling back to raw wall clock. This ensures correct measure detection
    // when playbackSpeed != 100 (where wall time diverges from content time).
    const elapsed = scrollState.elapsed ?? (performance.now() - scrollState.scrollStartT);
    let lastMeas = null;
    for (const evt of events) {
      if (evt.targetTimeMs <= elapsed) lastMeas = evt.meas;
      else break;
    }
    return lastMeas;
  }

  function ensureAudioContext() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }

  function handlePlay() {
    ensureAudioContext();
    resetCounters();
    setPausedMeasure(null);
    beginSession();
    clearTimers();

    const audioOffsetMs1 = activeMeasures[0]?.audioOffsetMs ?? 0;
    const seekMs = snippet ? getSeekForMeasure(snippet.startMeasure) : audioOffsetMs1;
    prepareAudioSeek(seekMs);

    setPlaybackState("playing");
  }

  function handlePause() {
    clearTimers();
    const meas = getCurrentMeasure();
    setPausedMeasure(meas);
    endSession();
    if (audioElement) audioElement.pause();
    setPlaybackState("paused");
  }

  function handleResume() {
    ensureAudioContext();
    resetCounters();
    beginSession();
    clearTimers();

    if (audioElement) {
      // Seek to the beginning of the paused measure so audio aligns with scroll
      const seekMs = pausedMeasure ? getSeekForMeasure(pausedMeasure) : audioElement.currentTime * 1000;
      prepareAudioSeek(seekMs);
    }

    setPlaybackState("playing");
  }

  function handleRestart() {
    ensureAudioContext();
    resetCounters();
    setPausedMeasure(null);
    beginSession();
    clearTimers();

    const audioOffsetMs1 = activeMeasures[0]?.audioOffsetMs ?? 0;
    const seekMs = snippet ? getSeekForMeasure(snippet.startMeasure) : audioOffsetMs1;
    prepareAudioSeek(seekMs);

    setPlaybackState("playing");
  }

  function handleStop() {
    clearTimers();
    setPlaybackState("stopped");
    endSession();
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
  }

  function handleFullStop() {
    clearTimers();
    endSession();
    resetCounters();
    setPausedMeasure(null);
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
    setPlaybackState("stopped");
  }

  function handleScoreTap() {
    if (playbackState === "stopped") return;
    if (playbackState === "playing") handlePause();
    else if (playbackState === "paused") handleResume();
  }

  function handleChangeSong() {
    // Closing a song is a route change now — the URL drops back to /sam and
    // the effect below does the teardown. Keeping the teardown in one place
    // is what makes the Back button and this button behave identically.
    navigate(SAM_PATH);
  }

  // The actual teardown, shared by the Change-song button and browser Back.
  function closeOpenSong() {
    clearTimers();
    if (playbackState === "playing") endSession();
    if (audioElement) audioElement.pause();
    setAudioElement(null);
    setAudioFilePath(null);
    setPlaybackState("stopped");
    setPausedMeasure(null);
    setSong(null);
    setSongDbId(null);
  }

  // --- URL <-> open song, the two directions (Step 8) ------------------------
  //
  // Direction 1: URL -> state. Runs only when the id in the URL actually
  // changes, which is what makes Back close the song: /sam/songs/x -> /sam is
  // an id going from set to null, so we tear the song down. A cold load of
  // /sam/songs/x is the same effect seeing an id with nothing loaded, so it
  // fetches. Both fall out of one rule.
  //
  // The dependency list is deliberately just [songIdFromUrl]. Adding `song`
  // or `songDbId` would re-run this while an import is mid-flight — an
  // imported song is open for a moment *before* its insert returns an id, so
  // the URL is legitimately /sam with a song loaded, and a re-run would read
  // that as "no id in the URL" and close the song the user just imported.
  useEffect(() => {
    let cancelled = false;

    if (!songIdFromUrl) {
      if (songDbId) closeOpenSong();
      return;
    }
    if (songIdFromUrl === songDbId) return;

    fetchSongById(songIdFromUrl, supabase)
      .then(({ song: loaded, row }) => {
        if (cancelled) return;
        handleSongLoaded(loaded);
        setSongDbId(row.id);
      })
      .catch((e) => {
        console.error("[Sam] Failed to load song from the URL:", e);
        if (cancelled) return;
        // A bad or deleted id must not strand the user on a blank player.
        setImportError("That song could not be loaded.");
        navigate(SAM_PATH, { replace: true });
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songIdFromUrl]);

  // Direction 2: state -> URL. A song opened from the library or finished
  // importing gets its address, pushed so Back closes it. Keyed on songDbId
  // only, for the same reason as above.
  useEffect(() => {
    if (!songDbId) return;
    if (samSongIdFromPath(location.pathname) === songDbId) return;
    navigate(samSongPath(songDbId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songDbId]);

  const handleSelectFingering = useCallback((coord) => setFingeringSelection(coord), []);
  const toggleFingeringMode = useCallback(() => {
    setFingeringMode((on) => {
      if (on) setFingeringSelection(null); // leaving the mode clears the selection
      return !on;
    });
  }, []);

  function handleExport() {
    if (!song) return;

    // buildSongExport is the whole format — see songExport.js for why lyrics
    // come out top-level rather than inline, and why every measure carries an
    // explicit audioOffsetMs. `song.measures` is passed untouched; the builder
    // copies before editing, so export never mutates player state.
    const exportData = buildSongExport({
      song,
      lyricPlacements,
      fingeringsByCoord,
      fallbackBpm: bpm.value,
    });

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${song.title || "song"}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-primary-bg">
      <header className="sticky top-0 z-10 bg-card border-b border-border shadow-sm">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
            title="Back to Alfred"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg sm:text-2xl font-bold text-dark">
            Sam — Piano Practice
          </h1>
        </div>
      </header>

      <div ref={scrollContainerRef} className="mx-auto px-3 sm:px-4 py-6">
        {importError && (
          <div className="mb-4 mx-3 sm:mx-4 p-3 bg-red-50 border border-red-200 rounded flex items-start justify-between gap-3 text-sm text-red-700">
            <span className="whitespace-pre-wrap">{importError}</span>
            <button
              onClick={() => setImportError(null)}
              className="text-red-500 hover:text-red-700 font-bold px-2"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {!song ? (
          <SongLoader
            onSongLoaded={handleSongLoaded}
            onSongSaved={setSongDbId}
            onImportError={setImportError}
          />
        ) : (
          <>
            {playbackState === "playing" ? (
              <FocusedPlaybackBar
                onPause={handlePause}
                todayMinutes={todayMinutes}
                loopCount={loopCount}
                hitCount={hitCount}
                missCount={missCount}
                accuracyPercent={sessionStats.accuracyPercent}
              />
            ) : (
              <>
                <SettingsBar
                  song={song} snippet={snippet}
                  bpm={bpm}
                  timingWindowMs={timingWindowMs}
                  chordMs={chordMs}
                  measureWidth={measureWidth}
                  playbackSpeed={playbackSpeed}
                  playbackState={playbackState} songDbId={songDbId}
                  onPlay={handlePlay} onPause={handlePause} onResume={handleResume} onRestart={handleRestart} onStop={handleFullStop}
                  onChangeSong={handleChangeSong}
                  onExport={handleExport}
                  midiConnected={midiConnected} midiDevice={midiDevice}
                  pausedMeasure={pausedMeasure}
                  onSongUpdate={setSong}
                  onAudioUploaded={handleAudioUploaded}
                  onFullSong={() => setSnippet(null)}
                  onLyricsChanged={setLyricPlacements}
                  skipTiedNotes={skipTiedNotes}
                  hasImportedFingerings={hasImported}
                />

                <AudioControls audioElement={audioElement} playbackState={playbackState} />

                {audioElement && (
                  <div className="flex items-center gap-4 px-3 mb-3">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={audioMuted}
                        onChange={(e) => setAudioMuted(e.target.checked)}
                        className="w-4 h-4 accent-primary"
                      />
                      Mute audio
                    </label>
                    <AudioMsCounter audioElement={audioElement} />
                  </div>
                )}

                <StatsBar
                  lastNote={lastNote}
                  loopCount={loopCount}
                  hitCount={hitCount}
                  missCount={missCount}
                  sessionStats={sessionStats}
                  lastResult={lastResult}
                  metronome={metronome}
                  setMetronome={setMetronome}
                  scorePlayback={scorePlayback}
                  setScorePlayback={setScorePlayback}
                  playbackState={playbackState}
                  todayMinutes={todayMinutes}
                  perSongTotalSeconds={perSongTotalSeconds}
                />

                <SnippetPanel
                  songDbId={songDbId}
                  totalMeasures={song.measures.length}
                  snippet={snippet}
                  onSnippetChange={setSnippet}
                />
              </>
            )}

            {playbackState === "stopped" ? (
              <>
                <div className="flex items-center gap-2 px-1 mb-2">
                  {fingeringMode && (
                    <FingeringBar
                      hasSelection={!!fingeringSelection}
                      currentFinger={selectedCurrentFinger}
                      noteheadCount={selectedNoteheadCount}
                      selectedNoteIndex={fingeringSelection?.noteIndex ?? 0}
                      canAdvance={selectedSeqIndex >= 0 && selectedSeqIndex < rhNoteSeq.length - 1}
                      onNumber={handleFingeringNumber}
                      onClear={handleFingeringClear}
                      onAdvance={handleFingeringAdvance}
                      onPickNotehead={handlePickNotehead}
                    />
                  )}
                  <div className="flex items-center gap-2 ml-auto">
                    {fingeringMode && (
                      <button
                        onClick={undoFingering}
                        disabled={!canUndoFingering}
                        className="min-h-[44px] px-4 rounded-lg text-sm font-medium border border-border bg-card text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        ↺ Undo
                      </button>
                    )}
                    {hasImported && (
                      <button
                        onClick={toggleShowImported}
                        aria-pressed={showImportedFingerings}
                        className="min-h-[44px] px-4 rounded-lg text-sm font-medium border border-border bg-card text-foreground hover:bg-muted transition-colors"
                      >
                        {showImportedFingerings ? "Hide Imported" : "Show Imported"}
                      </button>
                    )}
                    {parentSong && (
                      <button
                        onClick={() => setGhostMode((on) => !on)}
                        aria-pressed={ghostMode}
                        className={`min-h-[44px] px-4 rounded-lg text-sm font-medium border transition-colors ${
                          ghostMode
                            ? "bg-foreground text-background border-transparent"
                            : "bg-card text-foreground border-border hover:bg-muted"
                        }`}
                      >
                        {ghostMode ? "Diff: on" : "Diff"}
                      </button>
                    )}
                    <button
                      onClick={toggleFingeringMode}
                      aria-pressed={fingeringMode}
                      className={`min-h-[44px] px-4 rounded-lg text-sm font-medium border transition-colors ${
                        fingeringMode
                          ? "text-white border-transparent"
                          : "bg-card text-foreground border-border hover:bg-muted"
                      }`}
                      style={fingeringMode ? { backgroundColor: "var(--fingering-accent)" } : undefined}
                    >
                      {fingeringMode ? "Fingering mode: on" : "Fingering mode"}
                    </button>
                  </div>
                </div>
                {ghostMode && parentSong && (
                  <div className="flex flex-wrap items-center gap-4 mb-2 mx-1 p-2 rounded-lg border border-border bg-card text-sm">
                    <span className="text-muted-foreground">
                      Ghosts of <span className="text-foreground font-medium">{parentSong.title}</span>
                    </span>
                    <div className="flex items-center gap-1">
                      {[["both", "Both"], ["rh", "RH"], ["lh", "LH"]].map(([v, label]) => (
                        <button
                          key={v}
                          onClick={() => setGhostHands(v)}
                          aria-pressed={ghostHands === v}
                          className={`min-h-[36px] px-3 rounded-md text-sm border transition-colors ${
                            ghostHands === v
                              ? "bg-foreground text-background border-transparent"
                              : "bg-card text-foreground border-border hover:bg-muted"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 text-muted-foreground">
                      Opacity
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.01}
                        value={ghostOpacity}
                        onChange={(e) => setGhostOpacity(Number(e.target.value))}
                        className="w-40 accent-primary"
                      />
                      <span className="tabular-nums text-foreground w-10">
                        {ghostOpacity.toFixed(2)}
                      </span>
                    </label>
                  </div>
                )}
                {fingeringMode && fingeringError && (
                  <div className="mb-2 mx-1 p-2 bg-red-50 border border-red-200 rounded flex items-center justify-between gap-3 text-sm text-red-700">
                    <span>{fingeringError}</span>
                    <button onClick={dismissFingeringError} className="text-red-700 font-bold px-2" aria-label="Dismiss">×</button>
                  </div>
                )}
                <ScoreRenderer
                  measures={activeMeasures}
                  onBeatEvents={handleBeatEvents}
                  fingerings={fingerings}
                  fingeringMode={fingeringMode}
                  fingeringSelection={fingeringSelection}
                  onSelectFingering={handleSelectFingering}
                  onTap={handleScoreTap}
                  measureWidth={measureWidth.value}
                  lyricPlacements={lyricPlacements}
                  onLyricEdit={lyricEditHandlers}
                  showAudioOffset={!!song?.audioFilePath}
                  onAudioOffsetChange={handleAudioOffsetChange}
                  ghostMeasures={ghostMeasures}
                  ghostHands={ghostHands}
                  ghostOpacity={ghostOpacity}
                />
                {lyricPlacements && (
                  <div className="flex items-center justify-center gap-4 mt-2 mb-3">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={skipTiedNotes}
                        onChange={(e) => setSkipTiedNotes(e.target.checked)}
                        className="w-4 h-4 accent-primary"
                      />
                      One syllable per tied note
                    </label>
                    {lyricsDirty && (
                      <button
                        onClick={handleSaveLyrics}
                        disabled={lyricsSaving}
                        className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium min-h-[44px] disabled:opacity-50 transition-colors"
                      >
                        {lyricsSaving ? "Saving..." : "Save Lyrics"}
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <ScrollEngine
                measures={activeMeasures}
                bpm={bpm.value}
                playbackState={playbackState}
                fingerings={fingerings}
                onBeatEvents={handleBeatEvents}
                onLoopCount={handleLoopCount}
                onBeatMiss={handleBeatMiss}
                scrollStateExtRef={scrollStateExtRef}
                onTap={handleScoreTap}
                measureWidth={measureWidth.value}
                metronome={metronome}
                scorePlayback={scorePlayback}
                audioCtx={audioCtxRef.current}
                firstPassStart={
                  pausedMeasure != null
                    ? Math.max(0, activeMeasures.findIndex(m => m.number >= pausedMeasure))
                    : 0
                }
                loop={!!snippet}
                onEnded={handleStop}
                timingWindowMs={timingWindowMs.value}
                audioElement={audioElement}
                audioAnchors={audioAnchors}
                audioEndMs={snippet && audioElement ? getSnippetAudioEndMs() : null}
                handMode={snippet?.handMode || "both"}
                onScrollStart={scheduleAudioStartOnScroll}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
