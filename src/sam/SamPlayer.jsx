import React, { useState, useCallback, useRef, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import ScoreRenderer from "./components/ScoreRenderer";
import ScrollEngine from "./components/ScrollEngine";
import SongLoader from "./components/SongLoader";
import SettingsBar from "./components/SettingsBar";
import StatsBar from "./components/StatsBar";
import SnippetPanel from "./components/SnippetPanel";
import useMIDI from "./lib/useMIDI";
import usePracticeSession from "./lib/usePracticeSession";
import { matchChord, findClosestBeat } from "./lib/noteMatching";
import { colorBeatEls, midiDisplayName } from "./lib/vexflowHelpers";
import { normalizeMeasure } from "./lib/measureUtils";

export default function SamPlayer({ onBack }) {
  const [song, setSong] = useState(null);
  const [songDbId, setSongDbId] = useState(null);
  const [bpm, setBpm] = useState(68);
  const [bpmInput, setBpmInput] = useState("68");
  const [playing, setPlaying] = useState(false);
  const [loopCount, setLoopCount] = useState(0);
  const [missCount, setMissCount] = useState(0);
  const [windowMs, setWindowMs] = useState(500);
  const [windowMsInput, setWindowMsInput] = useState("500");
  const [chordMs, setChordMs] = useState(80);
  const [chordMsInput, setChordMsInput] = useState("80");
  const [hitCount, setHitCount] = useState(0);
  const [measureWidth, setMeasureWidth] = useState(300);
  const [measureWidthInput, setMeasureWidthInput] = useState("300");
  const [lastResult, setLastResult] = useState(null);
  const [snippet, setSnippet] = useState(null); // { startMeasure, endMeasure, restMeasures, dbId }
  const beatEventsRef = useRef([]);
  const scrollStateExtRef = useRef(null);
  const hitCountRef = useRef(0);
  const missCountRef = useRef(0);

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
    if (!playing) return;
    const scrollState = scrollStateExtRef.current;
    if (!scrollState) return;

    const match = findClosestBeat(beatEventsRef.current, scrollState, windowMs);
    if (!match) {
      const names = played.map((m) => midiDisplayName(m)).join(", ");
      setLastResult({ result: "none", timingMs: 0, noteName: names });
      return;
    }

    const { beat, timingDeltaMs } = match;
    const { result } = matchChord(played, beat.allMidi);

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

    recordEvent({ beatEvent: beat, played, timingDeltaMs, result });

    const sign = timingDeltaMs >= 0 ? "+" : "";
    setLastResult({
      result,
      timingMs: Math.round(timingDeltaMs),
      noteName: `${sign}${Math.round(timingDeltaMs)}ms`,
    });
  }, [playing, recordEvent, windowMs]);

  const { connected: midiConnected, deviceName: midiDevice, lastNote } = useMIDI({
    onChord: handleChord,
    chordGroupMs: chordMs,
  });

  const handleBeatEvents = useCallback((events) => {
    beatEventsRef.current = events;
    window.samBeatEvents = events;
    window.colorBeatEls = colorBeatEls;
    console.log(`[Sam] beatEvents ready: ${events.length} beats`, events);
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
    const defaultBpm = loadedSong.defaultBpm || 68;
    setBpm(defaultBpm);
    setBpmInput(String(defaultBpm));
    setPlaying(false);
    setLoopCount(0);
    setMissCount(0);
    setHitCount(0);
    setLastResult(null);
    hitCountRef.current = 0;
    missCountRef.current = 0;
  }

  function handleSettingsOverride(settings) {
    if (settings.bpm) {
      setBpm(settings.bpm);
      setBpmInput(String(settings.bpm));
    }
    if (settings.windowMs) {
      setWindowMs(settings.windowMs);
      setWindowMsInput(String(settings.windowMs));
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

  function handlePlayToggle() {
    if (!playing) {
      hitCountRef.current = 0;
      missCountRef.current = 0;
      setHitCount(0);
      setMissCount(0);
      setLastResult(null);
      startSession({
        songId: songDbId,
        snippetId: snippet?.dbId || null,
        settings: { bpm, windowMs, chordGroupMs: chordMs, measureWidth },
      });
    } else {
      endSession();
    }
    setPlaying(!playing);
  }

  function handleScoreTap() {
    if (!playing && !songDbId) return;
    handlePlayToggle();
  }

  function handleChangeSong() {
    setPlaying(false);
    setSong(null);
  }

  return (
    <div className="min-h-screen bg-primary-bg">
      <header className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 hover:text-dark rounded"
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
              windowMs={windowMs} windowMsInput={windowMsInput} setWindowMs={setWindowMs} setWindowMsInput={setWindowMsInput}
              chordMs={chordMs} chordMsInput={chordMsInput} setChordMs={setChordMs} setChordMsInput={setChordMsInput}
              measureWidth={measureWidth} measureWidthInput={measureWidthInput} setMeasureWidth={setMeasureWidth} setMeasureWidthInput={setMeasureWidthInput}
              playing={playing} songDbId={songDbId}
              onPlayToggle={handlePlayToggle} onChangeSong={handleChangeSong}
              midiConnected={midiConnected} midiDevice={midiDevice}
            />

            <StatsBar
              lastNote={lastNote}
              loopCount={loopCount}
              hitCount={hitCount}
              missCount={missCount}
              sessionStats={sessionStats}
              lastResult={lastResult}
            />

            {!playing && (
              <SnippetPanel
                songDbId={songDbId}
                totalMeasures={song.measures.length}
                snippet={snippet}
                onSnippetChange={setSnippet}
                bpm={bpm}
                windowMs={windowMs}
                chordMs={chordMs}
                onSettingsOverride={handleSettingsOverride}
              />
            )}

            {playing ? (
              <ScrollEngine
                measures={activeMeasures}
                bpm={bpm}
                playing={playing}
                onBeatEvents={handleBeatEvents}
                onLoopCount={handleLoopCount}
                onBeatMiss={handleBeatMiss}
                scrollStateExtRef={scrollStateExtRef}
                onTap={handleScoreTap}
                measureWidth={measureWidth}
              />
            ) : (
              <ScoreRenderer
                measures={activeMeasures}
                onBeatEvents={handleBeatEvents}
                onTap={handleScoreTap}
                measureWidth={measureWidth}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
