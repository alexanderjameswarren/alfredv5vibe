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
import { matchChord, findClosestBeat } from "./lib/noteMatching";
import { colorBeatEls, midiDisplayName } from "./lib/vexflowHelpers";
import { normalizeMeasure } from "./lib/measureUtils";
import { loadAudio } from "./lib/audioPlayer";
import { supabase } from "../supabaseClient";

export default function SamPlayer({ onBack }) {
  const [song, setSong] = useState(null);
  const [songDbId, setSongDbId] = useState(null);
  const [bpm, setBpm] = useState(68);
  const [bpmInput, setBpmInput] = useState("68");
  const [playbackState, setPlaybackState] = useState("stopped"); // 'stopped' | 'playing' | 'paused'
  const [pausedMeasure, setPausedMeasure] = useState(null);
  const [loopCount, setLoopCount] = useState(0);
  const [missCount, setMissCount] = useState(0);
  const [timingWindowMs, setTimingWindowMs] = useState(300);
  const [timingWindowMsInput, setTimingWindowMsInput] = useState("300");
  const [chordMs, setChordMs] = useState(80);
  const [chordMsInput, setChordMsInput] = useState("80");
  const [hitCount, setHitCount] = useState(0);
  const [measureWidth, setMeasureWidth] = useState(300);
  const [measureWidthInput, setMeasureWidthInput] = useState("300");
  const [lastResult, setLastResult] = useState(null);
  const [snippet, setSnippet] = useState(null); // { startMeasure, endMeasure, restMeasures, dbId }
  const [metronome, setMetronome] = useState("off"); // "off" | "beat" | "halfbeat" | "quarterbeat"
  const [audioElement, setAudioElement] = useState(null);
  const [audioFilePath, setAudioFilePath] = useState(null);
  const beatEventsRef = useRef([]);
  const scrollStateExtRef = useRef(null);
  const hitCountRef = useRef(0);
  const missCountRef = useRef(0);
  const audioCtxRef = useRef(null);

  const { startSession, endSession, recordEvent, setLoopIteration, stats: sessionStats } = usePracticeSession();

  // Derive active measures from snippet range, appending rest measures.
  // normalizeMeasure ensures both voice format (lh[]/rh[]) and legacy beats[]
  // are converted to beats[] for the renderers.
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

    return [...baseMeasures, ...restMeasures].map(normalizeMeasure);
  }, [song, snippet]);

  const handleChord = useCallback((played) => {
    if (playbackState !== "playing") return;
    const scrollState = scrollStateExtRef.current;
    if (!scrollState) return;

    const now = performance.now();
    const elapsed = now - scrollState.scrollStartT;
    console.log(
      `[PLAY] midi=[${played}] at elapsed=${Math.round(elapsed)}ms`
    );

    const match = findClosestBeat(beatEventsRef.current, scrollState, timingWindowMs);
    if (!match) {
      console.log(`[PLAY] No pending beat found within ±${timingWindowMs}ms`);
      const names = played.map((m) => midiDisplayName(m)).join(", ");
      setLastResult({ result: "none", timingMs: 0, noteName: names });
      return;
    }

    const { beat, timingDeltaMs } = match;

    console.log(
      `[MATCH] candidate: m${beat.meas} beat=${beat.beat} midi=[${beat.allMidi}]`,
      `| targetTime=${Math.round(beat.targetTimeMs)}ms`,
      `| delta=${Math.round(timingDeltaMs)}ms`,
      `| ${timingDeltaMs > 0 ? 'EARLY' : 'LATE'} by ${Math.abs(Math.round(timingDeltaMs))}ms`
    );

    const { result, missingNotes, extraNotes } = matchChord(played, beat.allMidi);

    console.log(
      `[RESULT] ${result}`,
      `| played=[${played}] expected=[${beat.allMidi}]`,
      `| missing=[${missingNotes}] extra=[${extraNotes}]`
    );

    // If player hit ONLY wrong notes (zero overlap with expected), don't consume the beat.
    // Leave it pending so the player can try again before the miss scanner catches it.
    if (result === "miss" && missingNotes.length === beat.allMidi.length) {
      console.log(`[SKIP] All notes wrong — beat NOT consumed, stays pending`);
      return;
    }

    if (result === "hit") {
      beat.state = "hit";
      colorBeatEls(beat, "#16a34a");
      hitCountRef.current++;
      setHitCount(hitCountRef.current);
    } else if (result === "partial") {
      beat.state = "partial";
      colorBeatEls(beat, "#d97706");
      hitCountRef.current++;
      setHitCount(hitCountRef.current);
    } else {
      beat.state = "wrong";
      colorBeatEls(beat, "#dc2626");
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
  }, [playbackState, recordEvent, timingWindowMs]);

  const { connected: midiConnected, deviceName: midiDevice, lastNote } = useMIDI({
    onChord: handleChord,
    chordGroupMs: chordMs,
  });

  const handleBeatEvents = useCallback((events) => {
    beatEventsRef.current = events;
    window.samBeatEvents = events;
    window.colorBeatEls = colorBeatEls;
  }, []);

  const handleLoopCount = useCallback((n) => {
    setLoopCount(n);
    setLoopIteration(n);
  }, [setLoopIteration]);

  const handleBeatMiss = useCallback((evt) => {
    missCountRef.current++;
    setMissCount(missCountRef.current);
    recordEvent({ beatEvent: evt, played: [], timingDeltaMs: null, result: "miss" });
  }, [recordEvent]);

  function handleSongLoaded(loadedSong) {
    setSong(loadedSong);
    setSongDbId(null);
    setSnippet(null);
    setAudioFilePath(loadedSong.audioFilePath || null);
    const defaultBpm = loadedSong.defaultBpm || 68;
    setBpm(defaultBpm);
    setBpmInput(String(defaultBpm));
    const tw = loadedSong.defaultTimingWindowMs ?? 300;
    setTimingWindowMs(tw);
    setTimingWindowMsInput(String(tw));
    const cm = loadedSong.defaultChordMs ?? 80;
    setChordMs(cm);
    setChordMsInput(String(cm));
    const mw = loadedSong.defaultMeasureWidth ?? 300;
    setMeasureWidth(mw);
    setMeasureWidthInput(String(mw));
    setPlaybackState("stopped");
    setPausedMeasure(null);
    setLoopCount(0);
    setMissCount(0);
    setHitCount(0);
    setLastResult(null);
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

  function handleAudioUploaded(path) {
    setAudioFilePath(path);
  }

  function handleSettingsOverride(settings) {
    if (settings.bpm) {
      setBpm(settings.bpm);
      setBpmInput(String(settings.bpm));
    }
    if (settings.windowMs) {
      setTimingWindowMs(settings.windowMs);
      setTimingWindowMsInput(String(settings.windowMs));
    }
    if (settings.chordGroupMs) {
      setChordMs(settings.chordGroupMs);
      setChordMsInput(String(settings.chordGroupMs));
    }
    if (settings.measureWidth) {
      setMeasureWidth(settings.measureWidth);
      setMeasureWidthInput(String(settings.measureWidth));
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
      settings: { bpm, windowMs: timingWindowMs, chordGroupMs: chordMs, measureWidth },
    });
  }

  // Determine which measure is at the target line right now
  function getCurrentMeasure() {
    const scrollState = scrollStateExtRef.current;
    const events = beatEventsRef.current;
    if (!scrollState || !events.length) return null;
    const elapsed = performance.now() - scrollState.scrollStartT;
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
    setPlaybackState("playing");
  }

  function handlePause() {
    const meas = getCurrentMeasure();
    setPausedMeasure(meas);
    endSession();
    setPlaybackState("paused");
  }

  function handleResume() {
    ensureAudioContext();
    resetCounters();
    beginSession();
    setPlaybackState("playing");
  }

  function handleRestart() {
    ensureAudioContext();
    resetCounters();
    setPausedMeasure(null);
    beginSession();
    setPlaybackState("playing");
  }

  function handleStop() {
    setPlaybackState("stopped");
    endSession();
  }

  function handleFullStop() {
    endSession();
    resetCounters();
    setPausedMeasure(null);
    setPlaybackState("stopped");
  }

  function handleScoreTap() {
    if (playbackState === "stopped" && !songDbId) return;
    if (playbackState === "stopped") handlePlay();
    else if (playbackState === "playing") handlePause();
    else if (playbackState === "paused") handleResume();
  }

  function handleChangeSong() {
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
      defaultBpm: song.defaultBpm || bpm,
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

      <div className="mx-auto px-3 sm:px-4 py-6">
        {!song ? (
          <SongLoader onSongLoaded={handleSongLoaded} onSongSaved={setSongDbId} />
        ) : (
          <>
            <SettingsBar
              song={song} snippet={snippet}
              bpm={bpm} bpmInput={bpmInput} setBpm={setBpm} setBpmInput={setBpmInput}
              timingWindowMs={timingWindowMs} timingWindowMsInput={timingWindowMsInput} setTimingWindowMs={setTimingWindowMs} setTimingWindowMsInput={setTimingWindowMsInput}
              chordMs={chordMs} chordMsInput={chordMsInput} setChordMs={setChordMs} setChordMsInput={setChordMsInput}
              measureWidth={measureWidth} measureWidthInput={measureWidthInput} setMeasureWidth={setMeasureWidth} setMeasureWidthInput={setMeasureWidthInput}
              playbackState={playbackState} songDbId={songDbId}
              onPlay={handlePlay} onPause={handlePause} onResume={handleResume} onRestart={handleRestart} onStop={handleFullStop}
              onChangeSong={handleChangeSong}
              onExport={handleExport}
              midiConnected={midiConnected} midiDevice={midiDevice}
              pausedMeasure={pausedMeasure}
              onSongUpdate={setSong}
              onAudioUploaded={handleAudioUploaded}
            />

            <AudioControls audioElement={audioElement} />

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
                bpm={bpm}
                timingWindowMs={timingWindowMs}
                chordMs={chordMs}
                onSettingsOverride={handleSettingsOverride}
              />
            )}

            {playbackState === "stopped" ? (
              <ScoreRenderer
                measures={activeMeasures}
                onBeatEvents={handleBeatEvents}
                onTap={handleScoreTap}
                measureWidth={measureWidth}
              />
            ) : (
              <ScrollEngine
                measures={activeMeasures}
                bpm={bpm}
                playbackState={playbackState}
                onBeatEvents={handleBeatEvents}
                onLoopCount={handleLoopCount}
                onBeatMiss={handleBeatMiss}
                scrollStateExtRef={scrollStateExtRef}
                onTap={handleScoreTap}
                measureWidth={measureWidth}
                metronome={metronome}
                audioCtx={audioCtxRef.current}
                firstPassStart={
                  pausedMeasure != null
                    ? Math.max(0, activeMeasures.findIndex(m => m.number >= pausedMeasure))
                    : 0
                }
                loop={!!snippet}
                onEnded={handleStop}
                timingWindowMs={timingWindowMs}
                audioElement={audioElement}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
