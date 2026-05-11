import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import ScoreRenderer from "./components/ScoreRenderer";
import ScrollEngine from "./components/ScrollEngine";
import SongLoader from "./components/SongLoader";
import SettingsBar from "./components/SettingsBar";
import StatsBar from "./components/StatsBar";
import SnippetPanel from "./components/SnippetPanel";
import AudioControls from "./components/AudioControls";
import useMIDI from "./lib/useMIDI";
import usePracticeSession from "./lib/usePracticeSession";
import useLyricEditor from "./lib/useLyricEditor";
import useAudioSync from "./lib/useAudioSync";
import useNumericInput from "./lib/useNumericInput";
import { DEFAULTS } from "./lib/samConstants";
import { matchChord, findClosestBeat } from "./lib/noteMatching";
import { colorBeatEls, midiDisplayName } from "./lib/vexflowHelpers";
import { normalizeMeasure } from "./lib/measureUtils";
import { loadAudio } from "./lib/audioPlayer";
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
  const [song, setSong] = useState(null);
  const [songDbId, setSongDbId] = useState(null);
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

  const { startSession, endSession, recordEvent, setLoopIteration, stats: sessionStats } = usePracticeSession();

  const {
    lyricPlacements,
    setLyricPlacements,
    lyricsDirty,
    lyricsSaving,
    lyricEditHandlers,
    saveLyrics,
  } = useLyricEditor({ song, songDbId, skipTiedNotes, supabase });

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

  // Sync mute state to audio element
  useEffect(() => {
    if (audioElement) audioElement.muted = audioMuted;
  }, [audioElement, audioMuted]);

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

  function handleSettingsOverride(settings) {
    if (settings.bpm) bpm.set(settings.bpm);
    if (settings.windowMs) timingWindowMs.set(settings.windowMs);
    if (settings.chordGroupMs) chordMs.set(settings.chordGroupMs);
    if (settings.measureWidth) measureWidth.set(settings.measureWidth);
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
      settings: { bpm: bpm.value, windowMs: timingWindowMs.value, chordGroupMs: chordMs.value, measureWidth: measureWidth.value },
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
    clearTimers();
    if (playbackState === "playing") endSession();
    if (audioElement) audioElement.pause();
    setAudioElement(null);
    setAudioFilePath(null);
    setPlaybackState("stopped");
    setPausedMeasure(null);
    setSong(null);
  }

  function handleExport() {
    if (!song) return;

    const exportData = {
      title: song.title,
      artist: song.artist,
      defaultBpm: song.defaultBpm || bpm.value,
      measures: song.measures,
    };

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
        {!song ? (
          <SongLoader onSongLoaded={handleSongLoaded} onSongSaved={setSongDbId} />
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
            />

            <AudioControls audioElement={audioElement} playbackState={playbackState} />

            {audioElement && (
              <div className="flex items-center gap-4 px-3 mb-3">
                {playbackState !== "playing" && (
                  <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={audioMuted}
                      onChange={(e) => setAudioMuted(e.target.checked)}
                      className="w-4 h-4 accent-primary"
                    />
                    Mute audio
                  </label>
                )}
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
            />

            {playbackState !== "playing" && (
              <SnippetPanel
                songDbId={songDbId}
                totalMeasures={song.measures.length}
                snippet={snippet}
                onSnippetChange={setSnippet}
                bpm={bpm.value}
                timingWindowMs={timingWindowMs.value}
                chordMs={chordMs.value}
                onSettingsOverride={handleSettingsOverride}
              />
            )}

            {playbackState === "stopped" ? (
              <>
                <ScoreRenderer
                  measures={activeMeasures}
                  onBeatEvents={handleBeatEvents}
                  onTap={handleScoreTap}
                  measureWidth={measureWidth.value}
                  lyricPlacements={lyricPlacements}
                  onLyricEdit={lyricEditHandlers}
                  showAudioOffset={!!song?.audioFilePath}
                  onAudioOffsetChange={handleAudioOffsetChange}
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
                onBeatEvents={handleBeatEvents}
                onLoopCount={handleLoopCount}
                onBeatMiss={handleBeatMiss}
                scrollStateExtRef={scrollStateExtRef}
                onTap={handleScoreTap}
                measureWidth={measureWidth.value}
                metronome={metronome}
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
