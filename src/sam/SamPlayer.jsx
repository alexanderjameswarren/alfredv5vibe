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
import { colorBeatEls, midiDisplayName, getMeasureWidth } from "./lib/vexflowHelpers";
import { normalizeMeasure, getMeasDurationQ } from "./lib/measureUtils";
import { loadAudio } from "./lib/audioPlayer";
import { recompileMeasures } from "./lib/measureCompiler";
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
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioLeadInMs, setAudioLeadInMs] = useState(0);
  const [audioLeadInMsInput, setAudioLeadInMsInput] = useState("0");
  const [defaultBpm, setDefaultBpm] = useState(68);
  const [defaultBpmInput, setDefaultBpmInput] = useState("68");
  const beatEventsRef = useRef([]);
  const scrollStateExtRef = useRef(null);
  const hitCountRef = useRef(0);
  const missCountRef = useRef(0);
  const audioCtxRef = useRef(null);
  const audioDelayTimerRef = useRef(null);
  const scrollDelayTimerRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const [lyricPlacements, setLyricPlacements] = useState(null); // [{word_order, syllable, measure_num, rh_index}]
  const [lyricsDirty, setLyricsDirty] = useState(false);
  const [lyricsSaving, setLyricsSaving] = useState(false);
  const [skipTiedNotes, setSkipTiedNotes] = useState(false);

  const { startSession, endSession, recordEvent, setLoopIteration, stats: sessionStats } = usePracticeSession();

  // Fetch lyrics from sam_song_lyrics when song is loaded
  useEffect(() => {
    if (!songDbId) {
      setLyricPlacements(null);
      setLyricsDirty(false);
      return;
    }
    supabase
      .from("sam_song_lyrics")
      .select("word_order, syllable, measure_num, rh_index")
      .eq("song_id", songDbId)
      .order("word_order", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error("[Sam] Failed to fetch lyrics:", error);
          setLyricPlacements(null);
        } else {
          setLyricPlacements(data && data.length > 0 ? data : null);
        }
        setLyricsDirty(false);
      });
  }, [songDbId]);

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

  // Flat sequence of all non-rest RH note positions for lyric navigation
  // isTiedCont: true if ALL notes have tie='end' or tie='both' (continuation of a tied note)
  const rhNoteSequence = useMemo(() => {
    if (!song?.measures) return [];
    const seq = [];
    for (const m of song.measures) {
      const rh = m.rh || [];
      for (let i = 0; i < rh.length; i++) {
        if (rh[i].notes && rh[i].notes.length > 0) {
          const isTiedCont = rh[i].notes.every(n => n.tie === "end" || n.tie === "both");
          seq.push({ measureNum: m.number, rhIndex: i, isTiedCont });
        }
      }
    }
    return seq;
  }, [song]);

  // Map from "measureNum-rhIndex" → sequence index for O(1) lookup
  const rhSeqIdxMap = useMemo(() => {
    const map = {};
    for (let i = 0; i < rhNoteSequence.length; i++) {
      const n = rhNoteSequence[i];
      map[`${n.measureNum}-${n.rhIndex}`] = i;
    }
    return map;
  }, [rhNoteSequence]);

  function findRhSeqIdx(measureNum, rhIndex) {
    return rhSeqIdxMap[`${measureNum}-${rhIndex}`] ?? -1;
  }

  // Navigate to next/prev position, skipping tied continuations when skipTiedNotes is on
  function nextNavIdx(fromSeqIdx, direction) {
    let idx = fromSeqIdx + direction;
    if (!skipTiedNotes) return idx;
    while (idx >= 0 && idx < rhNoteSequence.length) {
      if (!rhNoteSequence[idx].isTiedCont) return idx;
      idx += direction;
    }
    return idx; // out of bounds
  }

  // --- Lyric editing handlers ---
  // wordOrders: array of word_orders at the clicked position (group moves together)

  function handleLyricPullBack(wordOrders) {
    if (!lyricPlacements) return;
    const first = lyricPlacements.find(lp => lp.word_order === wordOrders[0]);
    if (!first || first.measure_num == null) return;
    const seqIdx = findRhSeqIdx(first.measure_num, first.rh_index);
    const prevIdx = nextNavIdx(seqIdx, -1);
    if (prevIdx < 0) return;
    const prevPos = rhNoteSequence[prevIdx];
    // When multiple syllables share a position, only move the earliest (min word_order)
    const moveWO = wordOrders.length > 1 ? Math.min(...wordOrders) : wordOrders[0];
    setLyricPlacements(lyricPlacements.map(lp =>
      lp.word_order === moveWO
        ? { ...lp, measure_num: prevPos.measureNum, rh_index: prevPos.rhIndex }
        : lp
    ));
    setLyricsDirty(true);
  }

  function handleLyricPushForward(wordOrders) {
    if (!lyricPlacements) return;
    // When multiple syllables share a position, only move the latest (max word_order)
    const moveWOs = wordOrders.length > 1 ? [Math.max(...wordOrders)] : [...wordOrders];
    const first = lyricPlacements.find(lp => lp.word_order === moveWOs[0]);
    if (!first || first.measure_num == null) return;
    const seqIdx = findRhSeqIdx(first.measure_num, first.rh_index);
    const targetIdx = nextNavIdx(seqIdx, 1);
    if (targetIdx >= rhNoteSequence.length) {
      alert("Cannot push forward — already at the last note.");
      return;
    }

    // Build seqIdx → [word_orders] map for collision detection
    const posMap = {};
    for (const lp of lyricPlacements) {
      if (lp.measure_num == null) continue;
      const si = findRhSeqIdx(lp.measure_num, lp.rh_index);
      if (si >= 0) {
        if (!posMap[si]) posMap[si] = [];
        posMap[si].push(lp.word_order);
      }
    }

    // Collect displacement chain: move clicked group forward, cascade until gap found
    const moves = []; // [{wordOrders, toIdx}]
    moves.push({ wordOrders: moveWOs, toIdx: targetIdx });
    const alreadyMoving = new Set(moveWOs);

    let checkIdx = targetIdx;
    while (checkIdx < rhNoteSequence.length) {
      const occupants = (posMap[checkIdx] || []).filter(wo => !alreadyMoving.has(wo));
      if (occupants.length === 0) break; // gap found
      const nextIdx = nextNavIdx(checkIdx, 1);
      if (nextIdx >= rhNoteSequence.length) {
        alert("Cannot push forward — would exceed available notes.");
        return;
      }
      moves.push({ wordOrders: occupants, toIdx: nextIdx });
      for (const wo of occupants) alreadyMoving.add(wo);
      checkIdx = nextIdx;
    }

    // Apply moves
    const moveMap = {};
    for (const move of moves) {
      const targetPos = rhNoteSequence[move.toIdx];
      for (const wo of move.wordOrders) {
        moveMap[wo] = targetPos;
      }
    }
    setLyricPlacements(lyricPlacements.map(lp => {
      const target = moveMap[lp.word_order];
      return target ? { ...lp, measure_num: target.measureNum, rh_index: target.rhIndex } : lp;
    }));
    setLyricsDirty(true);
  }

  function handleLyricCascadePullBack(wordOrders) {
    if (!lyricPlacements) return;
    const minWO = Math.min(...wordOrders);
    const toMove = lyricPlacements.filter(lp =>
      lp.word_order >= minWO && lp.measure_num != null
    );
    const toMoveWOs = new Set(toMove.map(lp => lp.word_order));
    const nonMoving = lyricPlacements.filter(lp =>
      !toMoveWOs.has(lp.word_order) && lp.measure_num != null
    );

    // Check all moving syllables: can they go back without collision?
    const moveTargets = {};
    for (const lp of toMove) {
      const seqIdx = findRhSeqIdx(lp.measure_num, lp.rh_index);
      const prevIdx = nextNavIdx(seqIdx, -1);
      if (prevIdx < 0) return;
      const prevPos = rhNoteSequence[prevIdx];
      if (nonMoving.some(nm => nm.measure_num === prevPos.measureNum && nm.rh_index === prevPos.rhIndex)) {
        return; // would create multiples
      }
      moveTargets[lp.word_order] = prevPos;
    }

    setLyricPlacements(lyricPlacements.map(lp => {
      const target = moveTargets[lp.word_order];
      return target ? { ...lp, measure_num: target.measureNum, rh_index: target.rhIndex } : lp;
    }));
    setLyricsDirty(true);
  }

  function handleLyricCascadePushForward(wordOrders) {
    if (!lyricPlacements) return;
    const minWO = Math.min(...wordOrders);
    const toMove = lyricPlacements.filter(lp =>
      lp.word_order >= minWO && lp.measure_num != null
    );

    // Check none would exceed bounds and compute targets
    const moveTargets = {};
    for (const lp of toMove) {
      const seqIdx = findRhSeqIdx(lp.measure_num, lp.rh_index);
      const nextIdx = nextNavIdx(seqIdx, 1);
      if (nextIdx >= rhNoteSequence.length) {
        alert("Cannot push forward — would exceed available notes.");
        return;
      }
      moveTargets[lp.word_order] = rhNoteSequence[nextIdx];
    }

    setLyricPlacements(lyricPlacements.map(lp => {
      const target = moveTargets[lp.word_order];
      return target ? { ...lp, measure_num: target.measureNum, rh_index: target.rhIndex } : lp;
    }));
    setLyricsDirty(true);
  }

  const lyricEditHandlers = useMemo(() => ({
    onPullBack: handleLyricPullBack,
    onPushForward: handleLyricPushForward,
    onCascadePullBack: handleLyricCascadePullBack,
    onCascadePushForward: handleLyricCascadePushForward,
  }), [lyricPlacements, rhNoteSequence, rhSeqIdxMap, skipTiedNotes]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const match = findClosestBeat(beatEventsRef.current, scrollState, timingWindowMs, hm);
    if (!match) {
      console.log(`[PLAY] No pending beat found within ±${timingWindowMs}ms`);
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
  }, [playbackState, recordEvent, timingWindowMs, snippet?.handMode]);

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

  async function handleSaveLyrics() {
    if (!songDbId || !lyricPlacements || !lyricsDirty) return;
    setLyricsSaving(true);
    try {
      for (const lp of lyricPlacements) {
        const { error } = await supabase
          .from("sam_song_lyrics")
          .update({ measure_num: lp.measure_num, rh_index: lp.rh_index })
          .eq("song_id", songDbId)
          .eq("word_order", lp.word_order);
        if (error) throw new Error("Failed to save: " + error.message);
      }
      // Recompile so playback blob has updated lyrics
      const newMeasures = await recompileMeasures(songDbId, supabase);
      setSong(prev => ({ ...prev, measures: newMeasures }));
      setLyricsDirty(false);
      console.log("[Sam] Lyrics saved and recompiled.");
    } catch (err) {
      console.error("[Sam] Save lyrics failed:", err);
      alert("Save lyrics failed: " + err.message);
    } finally {
      setLyricsSaving(false);
    }
  }

  function handleSongLoaded(loadedSong) {
    setSong(loadedSong);
    setSongDbId(null);
    setSnippet(null);
    setAudioFilePath(loadedSong.audioFilePath || null);
    const activeBpm = loadedSong.playbackBpm || loadedSong.defaultBpm || 68;
    setBpm(activeBpm);
    setBpmInput(String(activeBpm));
    const tw = loadedSong.defaultTimingWindowMs ?? 300;
    setTimingWindowMs(tw);
    setTimingWindowMsInput(String(tw));
    const cm = loadedSong.defaultChordMs ?? 80;
    setChordMs(cm);
    setChordMsInput(String(cm));
    const mw = loadedSong.defaultMeasureWidth ?? 300;
    setMeasureWidth(mw);
    setMeasureWidthInput(String(mw));
    const li = loadedSong.audioLeadInMs ?? 0;
    setAudioLeadInMs(li);
    setAudioLeadInMsInput(String(li));
    const db = loadedSong.defaultBpm || 68;
    setDefaultBpm(db);
    setDefaultBpmInput(String(db));
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

  // Sync audio playback rate: playback_bpm / default_bpm
  useEffect(() => {
    if (!audioElement || !defaultBpm) return;
    const rate = bpm / defaultBpm;
    audioElement.playbackRate = rate;
    audioElement.preservesPitch = true;
  }, [audioElement, bpm, defaultBpm]);

  // Sync mute state to audio element
  useEffect(() => {
    if (audioElement) audioElement.muted = audioMuted;
  }, [audioElement, audioMuted]);

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

  // Calculate audio seek position (ms) for snippet start measure.
  // Uses audio_offset_ms if set on the target measure, else derives from BPM.
  function getSnippetAudioSeekMs() {
    if (!snippet || !song) return 0;
    const targetMeas = song.measures[snippet.startMeasure - 1];
    if (targetMeas?.audioOffsetMs != null) return targetMeas.audioOffsetMs;
    // Sum beat durations of measures before snippet start at default (recording) BPM
    const msPerBeat = 60000 / defaultBpm;
    let totalBeats = 0;
    for (let i = 0; i < snippet.startMeasure - 1; i++) {
      totalBeats += getMeasDurationQ(song.measures[i]);
    }
    return audioLeadInMs + totalBeats * msPerBeat;
  }

  // Audio file timestamp (ms) where the snippet's real measures end.
  // Audio should be silent during rest measures that follow.
  function getSnippetAudioEndMs() {
    if (!snippet || !song) return null;
    const startMs = getSnippetAudioSeekMs();
    const msPerBeat = 60000 / defaultBpm;
    let totalBeats = 0;
    for (let i = snippet.startMeasure - 1; i < snippet.endMeasure; i++) {
      totalBeats += getMeasDurationQ(song.measures[i]);
    }
    return startMs + totalBeats * msPerBeat;
  }

  function clearDelayTimers() {
    if (audioDelayTimerRef.current) {
      clearTimeout(audioDelayTimerRef.current);
      audioDelayTimerRef.current = null;
    }
    if (scrollDelayTimerRef.current) {
      clearTimeout(scrollDelayTimerRef.current);
      scrollDelayTimerRef.current = null;
    }
  }

  // Calculate the visual approach time (ms) for the first note to reach the target line.
  // Must match ScrollEngine's approach calculation: leadInPx = viewportWidth * 0.25.
  function getApproachMs() {
    const viewportWidth = scrollContainerRef.current?.clientWidth || 800;
    const leadInPx = viewportWidth * 0.25;
    const msPerBeat = 60000 / bpm;
    const firstMeas = activeMeasures[0];
    if (!firstMeas) return 0;
    const firstDurationQ = getMeasDurationQ(firstMeas);
    const firstMeasWidth = getMeasureWidth(firstMeas.timeSignature, false, measureWidth);
    const pxPerBeat = firstMeasWidth / firstDurationQ;
    const pxPerMs = pxPerBeat / msPerBeat;
    return leadInPx / pxPerMs;
  }

  function playAudioOrDelay(seekMs = 0) {
    if (!audioElement) return;
    const approach = getApproachMs();
    const audioDelay = Math.max(0, approach - audioLeadInMs);

    audioElement.currentTime = seekMs / 1000;

    if (audioDelay > 0) {
      audioDelayTimerRef.current = setTimeout(() => {
        audioElement.play();
        audioDelayTimerRef.current = null;
      }, audioDelay);
    } else {
      audioElement.play();
    }
  }

  function handlePlay() {
    ensureAudioContext();
    resetCounters();
    setPausedMeasure(null);
    beginSession();
    clearDelayTimers();

    const approach = getApproachMs();
    const scrollDelay = Math.max(0, audioLeadInMs - approach);
    const seekMs = snippet ? getSnippetAudioSeekMs() : 0;

    if (audioElement) {
      playAudioOrDelay(seekMs);
    }

    if (scrollDelay > 0) {
      // Delay scrolling — audio starts first (long audio intro)
      scrollDelayTimerRef.current = setTimeout(() => {
        setPlaybackState("playing");
        scrollDelayTimerRef.current = null;
      }, scrollDelay);
    } else {
      setPlaybackState("playing");
    }
  }

  function handlePause() {
    clearDelayTimers();
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
    if (audioElement) audioElement.play();
    setPlaybackState("playing");
  }

  function handleRestart() {
    ensureAudioContext();
    resetCounters();
    setPausedMeasure(null);
    beginSession();
    clearDelayTimers();

    const approach = getApproachMs();
    const scrollDelay = Math.max(0, audioLeadInMs - approach);
    const seekMs = snippet ? getSnippetAudioSeekMs() : 0;

    if (audioElement) {
      playAudioOrDelay(seekMs);
    }

    if (scrollDelay > 0) {
      scrollDelayTimerRef.current = setTimeout(() => {
        setPlaybackState("playing");
        scrollDelayTimerRef.current = null;
      }, scrollDelay);
    } else {
      setPlaybackState("playing");
    }
  }

  function handleStop() {
    clearDelayTimers();
    setPlaybackState("stopped");
    endSession();
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
  }

  function handleFullStop() {
    clearDelayTimers();
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
    clearDelayTimers();
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

      <div ref={scrollContainerRef} className="mx-auto px-3 sm:px-4 py-6">
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
              audioLeadInMs={audioLeadInMs} audioLeadInMsInput={audioLeadInMsInput} setAudioLeadInMs={setAudioLeadInMs} setAudioLeadInMsInput={setAudioLeadInMsInput}
              defaultBpm={defaultBpm} defaultBpmInput={defaultBpmInput} setDefaultBpm={setDefaultBpm} setDefaultBpmInput={setDefaultBpmInput}
              playbackState={playbackState} songDbId={songDbId}
              onPlay={handlePlay} onPause={handlePause} onResume={handleResume} onRestart={handleRestart} onStop={handleFullStop}
              onChangeSong={handleChangeSong}
              onExport={handleExport}
              midiConnected={midiConnected} midiDevice={midiDevice}
              pausedMeasure={pausedMeasure}
              onSongUpdate={setSong}
              onAudioUploaded={handleAudioUploaded}
              onFullSong={() => setSnippet(null)}
              onLyricsChanged={(placements) => { setLyricPlacements(placements); setLyricsDirty(false); }}
              skipTiedNotes={skipTiedNotes}
            />

            <AudioControls audioElement={audioElement} playbackState={playbackState} />

            {audioElement && playbackState !== "playing" && (
              <label className="flex items-center gap-2 px-3 mb-3 text-sm text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={audioMuted}
                  onChange={(e) => setAudioMuted(e.target.checked)}
                  className="w-4 h-4 accent-primary"
                />
                Mute audio
              </label>
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
                bpm={bpm}
                timingWindowMs={timingWindowMs}
                chordMs={chordMs}
                onSettingsOverride={handleSettingsOverride}
              />
            )}

            {playbackState === "stopped" ? (
              <>
                <ScoreRenderer
                  measures={activeMeasures}
                  onBeatEvents={handleBeatEvents}
                  onTap={handleScoreTap}
                  measureWidth={measureWidth}
                  lyricPlacements={lyricPlacements}
                  onLyricEdit={lyricEditHandlers}
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
                audioLeadInMs={snippet && audioElement ? getSnippetAudioSeekMs() : audioLeadInMs}
                audioEndMs={snippet && audioElement ? getSnippetAudioEndMs() : null}
                handMode={snippet?.handMode || "both"}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
