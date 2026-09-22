import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Music } from "lucide-react";
import { SAM_PATH, samSongPath, samSongIdFromPath } from "../viewPaths";
import ScoreRenderer from "./components/ScoreRenderer";
import ScrollEngine from "./components/ScrollEngine";
import SongLoader from "./components/SongLoader";
import BackButton from "./components/BackButton";
import SettingsBar from "./components/SettingsBar";
import StatsBar from "./components/StatsBar";
import SnippetPanel from "./components/SnippetPanel";
import AudioControls from "./components/AudioControls";
import FocusedPlaybackBar from "./components/FocusedPlaybackBar";
import PracticeBar from "./components/PracticeBar";
import useMIDI from "./lib/useMIDI";
import usePracticeSession from "./lib/usePracticeSession";
import useSamPasses from "./lib/useSamPasses";
import usePassCounts from "./lib/usePassCounts";
import { ensureSnippetSaved, sameLoadedRange, snippetFromRow } from "./lib/snippetsApi";
import useActivePlan from "./lib/useActivePlan";
import {
  firstIncompleteItem, heardTempo, itemForLoadedRange, itemState, matchPlanItem,
  nextIncompleteItem, planBadgeText, planSongFor, snippetTagText,
} from "./lib/activePlan";
import PlanLine from "./components/PlanLine";
import usePracticeStats from "./lib/usePracticeStats";
import useLyricEditor from "./lib/useLyricEditor";
import useFingeringEditor from "./lib/useFingeringEditor";
import FingeringBar from "./components/FingeringBar";
import useAudioSync from "./lib/useAudioSync";
import useNumericInput from "./lib/useNumericInput";
import { DEFAULTS } from "./lib/samConstants";
import { matchChord, findClosestBeat, nearestBeat, elapsedAt } from "./lib/noteMatching";
import { onScreenTally } from "./lib/practiceScoring";
import { colorBeatEls, midiDisplayName } from "./lib/vexflowHelpers";
import { normalizeMeasure } from "./lib/measureUtils";
import { loadAudio } from "./lib/audioPlayer";
import { buildSongExport } from "./lib/songExport";
import { fetchSongById } from "./lib/songLoad";
import { supabase } from "../supabaseClient";

// How far from a beat an unattached keystroke may be and still have its offset
// recorded, as a multiple of the session's matching window. Beyond it the
// offset is stored as null: the pitch and the measure are still the answer to
// "what am I hitting", but the number would mean nothing.
const EXTRA_TIMING_REACH = 2;

// Practice passes no audio to ScrollEngine, so it passes no anchors either.
// Module-level so the identity is stable across renders.
const EMPTY_ANCHORS = [];

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
  // PRACTICE MODE — THE ONE FLAG (2026-09-22).
  //
  // Practice scrolls exactly like Play but records nothing, anywhere. Rather
  // than check that at each of the six recording call sites below, the ref is
  // handed to `usePracticeSession` and `useSamPasses`, which guard every
  // function of theirs that can reach the database. Nothing a future call site
  // does can write during a practice run.
  //
  // The ref and the state are two faces of one flag: the ref is the gate, and
  // it must be set SYNCHRONOUSLY because it is read from ScrollEngine's rAF
  // frame and from MIDI handlers that fire long before React re-renders; the
  // state is only what the UI paints. `setPractice` moves both together, and
  // is the only thing that should ever write either.
  const [practiceMode, setPracticeMode] = useState(false);
  const practiceModeRef = useRef(false);
  const setPractice = useCallback((on) => {
    practiceModeRef.current = on;
    setPracticeMode(on);
  }, []);
  // THE STUCK BEAT (practice mode, step 3).
  //
  // A ref because it is read from the MIDI handler and written from inside
  // ScrollEngine's rAF frame, both of which run long before React re-renders;
  // the state beside it is only what PracticeBar paints.
  //
  // It holds the BEAT EVENT OBJECT ITSELF, not an index or a copy. Step 4 has
  // to resume from this exact beat — its `targetTimeMs` is the clock value and
  // its `allMidi` / `rhMidi` / `lhMidi` are the notes that must be held — and
  // the loop teleport rewrites both of those on every event in the array. The
  // freeze skips the teleport, so holding the object keeps it intact.
  const stuckBeatRef = useRef(null);
  const [stuckBeat, setStuckBeat] = useState(null);
  const [pausedMeasure, setPausedMeasure] = useState(null);
  const [loopCount, setLoopCount] = useState(0);
  const [missCount, setMissCount] = useState(0);
  const timingWindowMs = useNumericInput(DEFAULTS.timingWindowMs);
  const chordMs = useNumericInput(DEFAULTS.chordMs);
  const [hitCount, setHitCount] = useState(0);
  const measureWidth = useNumericInput(DEFAULTS.measureWidth);
  const [lastResult, setLastResult] = useState(null);
  const [snippet, setSnippet] = useState(null); // { startMeasure, endMeasure, restMeasures, dbId }
  // Whole-song repeat. Session-only by design: never persisted, no column, no
  // localStorage — it resets whenever a song is loaded. Mutually exclusive with
  // a snippet's own loop (see `songRepeatActive`), because both would otherwise
  // compete over `loop`, `audioEndMs`, and the appended rest measures.
  const [songRepeat, setSongRepeat] = useState(false);
  const [songRestMeasures, setSongRestMeasures] = useState(0); // same default as a snippet's rest
  // The single source of truth for "whole-song repeat is driving playback".
  // The toggle is hidden while a snippet is selected, but a stale `true` from
  // before the snippet was picked must not leak into `loop` / `audioEndMs`.
  const songRepeatActive = !snippet && songRepeat;
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
  // Whether the song has audio, and where it lives, is `song.audioFilePath` —
  // the one value the Edit Song dialog, NumericSettings and the score's
  // audio-offset control already read. Derived rather than held in a second
  // state, which used to go stale: an upload updated only the copy, so those
  // three kept the no-audio layout until the song was reopened.
  const audioFilePath = song?.audioFilePath ?? null;
  const [audioMuted, setAudioMuted] = useState(false);
  const playbackSpeed = useNumericInput(DEFAULTS.playbackSpeed);

  // The tempo Practice actually scrolls at.
  //
  // `playbackSpeed` never reached the clock directly: it only ever set
  // `audioElement.playbackRate`, and ScrollEngine then read the rate back off
  // the element. With backing audio off that route is gone, so an audio-backed
  // song set to 70% would practise at 100% — the one place Practice could
  // silently disagree with Play about speed. Folding the percentage into the
  // bpm restores it, because `pxPerMs` is derived from bpm alone.
  const practiceBpm = useMemo(() => {
    const speed = Number.isFinite(playbackSpeed.value) ? playbackSpeed.value : 100;
    const scaled = bpm.value * (speed / 100);
    return Number.isFinite(scaled) && scaled > 0 ? scaled : bpm.value;
  }, [bpm.value, playbackSpeed.value]);

  const beatEventsRef = useRef([]);
  // Beat event -> the pitches struck at it in an all-wrong attempt, waiting for
  // the miss scanner to claim them. See handleChord's all-wrong branch.
  const attemptedNotesRef = useRef(new Map());
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

  const {
    startSession, endSession, recordEvent, setLoopIteration, getSessionId,
    getCurrentPlaythrough, noteTempo, noteMidiConnected, recordExtra, stats: sessionStats,
  } = usePracticeSession({
    onSessionEnded: () => setPracticeStatsRefetchSignal((n) => n + 1),
    practiceModeRef,
  });

  // Pass counting (spec: docs/technical-spec-pass-counter.md).
  //
  // `usePassCounts` reads today's count for the loaded range and seeds the
  // display from the database, so the number is right the instant Play is
  // pressed rather than counting up from zero each sitting. It is declared
  // first because `useSamPasses` increments it: `countPass` fires when a pass
  // row actually lands. Arming lives in the transport handlers below; the
  // credit itself hangs off ScrollEngine's end-of-range signals in
  // `handleLoopCount` and `handleRangeEnded`.
  const {
    rangeTodayCount: passesToday,
    songTodayCount: songPassesToday,
    songTotalCount: songPassesTotal,
    countPass,
  } = usePassCounts({ songId: songDbId, snippet });
  // The active practice plan (§7.2/§7.3). One copy for the whole of SAM: the
  // home page's checklist reads it, and every pass and session row is linked
  // through `getPlanLink`.
  const activePlan = useActivePlan();
  const { getLink: getPlanLink, refreshProgress: refreshPlanProgress } = activePlan;

  // What the plan says about what is loaded (§7.4). All counts come from
  // `activePlan.progress` — the database function — never from passes.
  const planItem = itemForLoadedRange(activePlan.plan, songDbId, snippet);
  const planItemState = planItem ? itemState(planItem, activePlan.progress) : null;
  const planSongNote = planSongFor(activePlan.plan, songDbId)?.song_note || null;
  // Where to go next, for the plan line's Next button. Null while nothing is
  // left to do — or while there is no plan at all — which is what hides the
  // button in both cases.
  //
  // On a plan item it is the next one after it; OFF the plan it is the first
  // incomplete item anywhere, because a range that is in no item has no
  // position to count from and the honest answer is "start of what's left"
  // (2026-09-21). PlanLine decides whether to draw it: on an item only once
  // that item is done, off the plan always.
  const nextPlanItem = planItem
    ? nextIncompleteItem(activePlan.plan, activePlan.progress, planItem)
    : firstIncompleteItem(activePlan.plan, activePlan.progress);
  const planTone = (st) => (st.done ? "done" : st.amber ? "amber" : "open");
  const planBadge = planItem
    ? { text: planBadgeText(planItemState), state: planTone(planItemState) }
    : null;
  // Snippet rows in the panel: a planned snippet of this song gets a tag.
  const planTagFor = (snippetId) => {
    const it = matchPlanItem(activePlan.plan, songDbId, snippetId);
    if (!it || !snippetId) return null;
    const st = itemState(it, activePlan.progress);
    return { text: snippetTagText(it, st), state: planTone(st) };
  };

  const { armPass, disarmPass, recordPass } = useSamPasses({
    practiceModeRef,
    onPassRecorded: (info) => {
      countPass(info);
      // Today's plan progress, from the database — never counted here.
      refreshPlanProgress();
    },
  });

  // Hoisted from StatsBar so the playback-row LiveSessionCounter and the
  // stopped/paused PracticeTimeIndicator share one fetch.
  const { todayMinutes, perSongTotalSeconds, perSongTodaySeconds } = usePracticeStats({
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

  // How many empty bars are appended after the music. A snippet's own rest
  // count wins; whole-song repeat only contributes rests when no snippet is
  // selected, so the two never stack.
  //
  // Its own memo because ScrollEngine needs it as well as `activeMeasures`:
  // it is what tells the engine where the music ends and the resting begins,
  // which is where a pass is credited (2026-09-20).
  const appendedRestCount = useMemo(() => {
    if (!song) return 0;
    return snippet ? (snippet.restMeasures || 0) : (songRepeat ? songRestMeasures : 0);
  }, [song, snippet, songRepeat, songRestMeasures]);

  // Derive active measures from snippet range, appending rest measures.
  // normalizeMeasure ensures both voice format (lh[]/rh[]) and legacy beats[]
  // are converted to beats[] for the renderers.
  // When lyricPlacements state exists, it overrides blob lyrics as the source of truth.
  const activeMeasures = useMemo(() => {
    if (!song) return [];

    const baseMeasures = !snippet
      ? song.measures
      : song.measures.slice(snippet.startMeasure - 1, snippet.endMeasure);

    // Append empty rest measures (voice format — whole-note rests).
    const restCount = appendedRestCount;
    const restMeasures = [];
    const endNum =
      snippet?.endMeasure ??
      (baseMeasures[baseMeasures.length - 1]?.number || baseMeasures.length);
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
    // Keyed on the snippet's RANGE rather than the snippet object. Play
    // auto-saves an ad-hoc range and swaps in a new snippet object carrying the
    // id (M1.5); keying on the object would make that swap produce a fresh
    // measures array, which tears down and rebuilds ScrollEngine's SVG
    // (`setSvgReady(false)` on cleanup) at the exact instant playback starts —
    // restarting the scroll after the audio start had already been scheduled.
    // Only these three properties change what is drawn, so they are the key.
  }, [song, snippet?.startMeasure, snippet?.endMeasure, appendedRestCount, songRepeat, songRestMeasures, lyricPlacements]); // eslint-disable-line react-hooks/exhaustive-deps

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
    getLoopAudioEndMs,
    scheduleAudioStartOnScroll,
    prepareAudioSeek,
    clearTimers,
  } = useAudioSync({
    song,
    snippet,
    songRepeat: songRepeatActive,
    activeMeasures,
    bpm: bpm.value,
    playbackSpeed: playbackSpeed.value,
    audioElement,
    scrollContainerRef,
    measureWidth: measureWidth.value,
  });

  // Stop the practice run on `beat`, which the grader has just marked as
  // anything other than a full hit.
  //
  // Idempotent by design: the first stop wins. A chord and the miss scanner can
  // both reach a beat within the same frame, and the run must stop where the
  // grader FIRST said so.
  //
  // Nothing is coloured here. The grader has already marked the beat in its own
  // colours — amber for a partial, red for a wrong note or a miss — and that
  // marking IS the highlight the spec asks for. The one exception is handled by
  // the caller: an all-wrong chord leaves its beat pending and unpainted.
  const practiceStopAt = useCallback((beat) => {
    if (!practiceModeRef.current) return;
    if (stuckBeatRef.current) return;
    const scrollState = scrollStateExtRef.current;
    if (!scrollState || !beat || beat.targetTimeMs == null) return;
    stuckBeatRef.current = beat;
    setStuckBeat({ meas: beat.meas, beat: beat.beat });
    // The whole of "stop the scroll, and put this beat on the play line".
    scrollState.frozenAtMs = beat.targetTimeMs;
    console.log(`[Practice] stopped at m${beat.meas} beat=${beat.beat}`,
      `| midi=[${beat.allMidi}] | targetTime=${Math.round(beat.targetTimeMs)}ms`);
  }, []);

  const clearStuckBeat = useCallback(() => {
    stuckBeatRef.current = null;
    setStuckBeat(null);
    const scrollState = scrollStateExtRef.current;
    if (scrollState) scrollState.frozenAtMs = null;
  }, []);

  // `pressedAtMs` is a performance.now() reading from when the chord's FIRST
  // key arrived, carried through useMIDI's chord buffer. Every timing decision
  // below uses it, so nothing is measured at flush time any more.
  const handleChord = useCallback((played, pressedAtMs) => {
    if (playbackState !== "playing") return;
    // Stopped on a beat: every key is ignored — not graded, not recorded, and
    // no obstacle to resuming. Until step 4 lands there is no way back out of
    // here except Pause or Stop, both of which clear the stuck beat.
    if (stuckBeatRef.current) return;
    const scrollState = scrollStateExtRef.current;
    if (!scrollState) return;

    const elapsed = elapsedAt(scrollState, pressedAtMs);
    console.log(
      `[PLAY] midi=[${played}] at elapsed=${Math.round(elapsed)}ms`
    );

    // Hand mode filtering: only match notes from the active hand
    const hm = snippet?.handMode || "both";

    const match = findClosestBeat(beatEventsRef.current, scrollState, timingWindowMs.value, hm, pressedAtMs);
    if (!match) {
      console.log(`[PLAY] No pending beat found within ±${timingWindowMs.value}ms`);
      const names = played.map((m) => midiDisplayName(m)).join(", ");
      // Nothing to score — but record WHAT was struck and where, as an `extra`
      // event. The nearest pending beat names the measure; it is used for
      // bookkeeping only and never consumed or marked.
      //
      // ITS OFFSET IS ONLY KEPT WHEN IT MEANS SOMETHING. A keystroke a beat and
      // a half from anything is not early or late, it is unattached, and
      // storing "4389 ms early" invites a reader to average it. The cutoff is
      // twice the session's own matching window: windowMs is already the app's
      // definition of "close enough to be an attempt at this beat", so twice it
      // is a near miss, and the rule scales with how strict the session was
      // rather than with the tempo.
      const near = nearestBeat(beatEventsRef.current, scrollState, hm, pressedAtMs);
      if (near) {
        const withinReach = Math.abs(near.timingDeltaMs) <= timingWindowMs.value * EXTRA_TIMING_REACH;
        recordExtra({
          measure: near.beat.meas,
          beat: near.beat.beat,
          played,
          timingDeltaMs: withinReach ? near.timingDeltaMs : null,
        });
      }
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
      // What was struck used to be thrown away here: the beat stays pending and
      // is later timed out by the scanner as a plain miss with `played: []`, so
      // the wrong keys vanished. Hold them against this beat instead, and let
      // the miss carry them — ONE BEAT, ONE ROW, with the wrong notes attached
      // to the beat they belong to. (Part 1 wrote a companion `extra` row here;
      // that made one fumble two rows, which a per-measure count could double.)
      //
      // If the player corrects it in time, the beat is consumed as a hit or a
      // partial and the held notes are dropped unused, which is right: nothing
      // was missed.
      const held = attemptedNotesRef.current.get(beat) || [];
      attemptedNotesRef.current.set(beat, [...held, ...played]);
      // In PRACTICE this is a wrong note and the scroll stops on it now, rather
      // than waiting the full timing window for the miss scanner to time the
      // beat out. The beat is deliberately LEFT PENDING, exactly as it is under
      // Play: step 4 resumes from it, and a beat that was never consumed is the
      // cleanest thing to resume from. It is the one failing outcome the grader
      // does not paint, so paint it here — red, the same red a miss gets.
      if (practiceModeRef.current) {
        const wrongEls = hm === "lh" ? [beat.bassSvgEl].filter(Boolean)
                       : hm === "rh" ? [beat.trebleSvgEl].filter(Boolean)
                       : beat.svgEls;
        colorBeatEls({ svgEls: wrongEls }, "#dc2626");
        practiceStopAt(beat);
      }
      return;
    }

    // Color only the active hand's SVG elements; inactive hand stays black
    const activeEls = hm === "lh" ? [beat.bassSvgEl].filter(Boolean)
                    : hm === "rh" ? [beat.trebleSvgEl].filter(Boolean)
                    : beat.svgEls;

    if (result === "hit") {
      beat.state = "hit";
      colorBeatEls({ svgEls: activeEls }, "#16a34a");
    } else if (result === "partial") {
      beat.state = "partial";
      colorBeatEls({ svgEls: activeEls }, "#d97706");
    } else {
      beat.state = "wrong";
      colorBeatEls({ svgEls: activeEls }, "#dc2626");
    }

    // On-screen Hits counts full hits only, like sam_passes.hits; a partial
    // adds to neither counter (recordEvent still tallies it as a partial).
    const tally = onScreenTally(result);
    if (tally === "hit") {
      hitCountRef.current++;
      setHitCount(hitCountRef.current);
    } else if (tally === "miss") {
      missCountRef.current++;
      setMissCount(missCountRef.current);
    }

    console.log(
      `[CONSUME] m${beat.meas} beat=${beat.beat} → ${result}`
    );

    recordEvent({ beatEvent: beat, played, timingDeltaMs, result });

    // PRACTICE: stop on anything that is not a full hit — a partial counts,
    // because an incomplete chord is precisely what this mode exists to drill.
    // The beat keeps the colour the grader just gave it: amber for a partial,
    // red for a wrong note.
    if (result !== "hit") practiceStopAt(beat);

    const sign = timingDeltaMs >= 0 ? "+" : "";
    setLastResult({
      result,
      timingMs: Math.round(timingDeltaMs),
      noteName: `${sign}${Math.round(timingDeltaMs)}ms`,
    });
  }, [playbackState, recordEvent, recordExtra, timingWindowMs.value, snippet?.handMode, practiceStopAt]);

  const { connected: midiConnected, deviceName: midiDevice, lastNote } = useMIDI({
    onChord: handleChord,
    chordGroupMs: chordMs.value,
  });

  const handleBeatEvents = useCallback((events) => {
    beatEventsRef.current = events;
    window.samBeatEvents = events;
    window.colorBeatEls = colorBeatEls;
  }, []);

  // Everything the pass writer needs, refreshed every render and read at the
  // instant a pass completes. It has to be a ref: ScrollEngine captures
  // `onLoopCount` inside its scroll effect, whose dep list does not include the
  // callback, so a `handleLoopCount` whose identity changed mid-playback would
  // simply never be called. Keeping that callback stable and reading mutable
  // values through here is what makes the row carry the tempo at the finish
  // line rather than the tempo the run started at.
  const passContextRef = useRef({ songId: null, snippet: null, bpm: null, playbackSpeed: null });
  passContextRef.current = {
    songId: songDbId,
    snippet,
    bpm: bpm.value,
    // Read here for the same reason as bpm: both can change mid-run, and the
    // pass must record what was true at the finish line.
    playbackSpeed: playbackSpeed.value,
  };

  // Credit one completed playthrough of the loaded range.
  //
  // Called from ScrollEngine's rAF frame, so it must not throw and must not
  // block — `recordPass` owns both guarantees.
  // `playthrough` may be passed in by a caller that had to read the counters
  // at a particular instant — `handleLoopCount` does, because it defers the
  // write off the teleport frame but must capture the counters BEFORE
  // `setLoopIteration` rotates them. Omitted, they are read here as before.
  const creditPass = useCallback((playthrough) => {
    const ctx = passContextRef.current;
    recordPass({
      songId: ctx.songId,
      snippet: ctx.snippet,
      sessionId: getSessionId(),
      bpm: ctx.bpm,
      playbackSpeed: ctx.playbackSpeed,
      handMode: ctx.snippet?.handMode || "both",
      playthrough: playthrough ?? getCurrentPlaythrough(),
      getPlanLink,
    });
  }, [recordPass, getSessionId, getCurrentPlaythrough, getPlanLink]);

  // ScrollEngine's loop signal is the end-of-range event for looped playback:
  // `n` is 0 when a run arms and increments by exactly one at each teleport,
  // and a teleport happens precisely when the range's last measure crosses the
  // target line. So every `n > 0` is one completed cycle.
  //
  // The `n !== lastLoopCountRef` guard exists because a mid-play setting change
  // (bpm, timing window, measure width) re-runs ScrollEngine's scroll effect,
  // which resets its internal counter and re-emits 0. The sequence can read
  // 1, 2, 3, 0, 1 across one sitting; comparing against the last value seen
  // counts that trailing 1 as the new cycle it is, instead of ignoring it as a
  // repeat of the earlier one.
  const lastLoopCountRef = useRef(0);
  // The last playthrough number banked, so one pass is credited exactly once
  // however many times the signal is re-emitted.
  const lastCreditedPassRef = useRef(0);

  const handleLoopCount = useCallback((n) => {
    setLoopCount(n);
    // Credit BEFORE advancing the loop. `setLoopIteration` rotates the
    // per-playthrough counters, and the pass needs the ones belonging to the
    // playthrough that just finished. Neither call depends on the other, so the
    // order is free to choose — and this order is the one that makes the hits
    // and misses on the pass row belong to the right pass.
    //
    // Detection is unchanged: the same signal credits the same passes, at the
    // same instant.
    setLoopIteration(n);
    if (n > 0) setPausedMeasure(null);
    // A fresh run (n === 0) restarts the pass numbering, so the credit guard
    // has to restart with it — otherwise the first pass of the new run would
    // look like a repeat of one already banked. This is the same reason
    // lastLoopCountRef compares rather than counts: a mid-play setting change
    // re-runs the scroll effect, and the sequence can read 1, 2, 3, 0, 1.
    if (n === 0) lastCreditedPassRef.current = 0;
    lastLoopCountRef.current = n;
  }, [setLoopIteration]);

  // The music of one playthrough has finished — the moment the pass is banked.
  //
  // For a snippet with rest bars this arrives when the scroll reaches the
  // first rest bar, so the pass counter and the plan line move while he is
  // still resting rather than a bar later (2026-09-20). With no rest bars
  // ScrollEngine fires it at the teleport instead, which is the same instant
  // the music ends, so nothing about that case changes.
  //
  // OFF THE FRAME (2026-09-19). `creditPass` reaches Supabase and this runs
  // inside ScrollEngine's rAF frame, so only the write is deferred to a
  // macrotask; the COUNTERS are read synchronously here, before anything can
  // rotate them, so the row carries the playthrough that just finished.
  const handleContentEnd = useCallback((n) => {
    if (!(n > 0) || n === lastCreditedPassRef.current) return;
    lastCreditedPassRef.current = n;
    const playthrough = getCurrentPlaythrough();
    setTimeout(() => creditPass(playthrough), 0);
  }, [creditPass, getCurrentPlaythrough]);

  // `handleStop` is a plain function declared further down the component, so it
  // is re-created every render. Reaching it through a ref keeps
  // `handleRangeEnded` stable for the same reason `handleLoopCount` has to be.
  const handleStopRef = useRef(null);

  // End-of-range for NON-looping playback (whole song, repeat off). ScrollEngine
  // fires `onEnded` at the same geometric instant it would otherwise teleport,
  // and the two paths are mutually exclusive — the teleport branch returns early
  // when `loop` is false — so there is no way for one completion to be counted
  // twice. Credit before stopping, because `handleStop` disarms.
  const handleRangeEnded = useCallback(() => {
    creditPass();
    handleStopRef.current?.();
  }, [creditPass]);

  const handleBeatMiss = useCallback((evt) => {
    // PRACTICE: the missed-note stop. The scanner only knows a beat was missed
    // once its window has closed, so the scroll is already `timingWindowMs`
    // past it — which is why freezing at the beat's own `targetTimeMs` moves
    // the score BACK. Nothing is counted and nothing is recorded; the beat has
    // already been marked "missed" and painted red by the scanner, and it stays
    // in that state, held by `stuckBeatRef`, for step 4 to resume from.
    if (practiceModeRef.current) {
      practiceStopAt(evt);
      return;
    }
    missCountRef.current++;
    setMissCount(missCountRef.current);
    // Any all-wrong attempt at this beat rides along as `attempted`, so the row
    // says which keys were struck. It stays a miss, and `attempted` is kept out
    // of `played` so no counter moves — see recordEvent.
    const attempted = attemptedNotesRef.current.get(evt);
    if (attempted) attemptedNotesRef.current.delete(evt);
    recordEvent({ beatEvent: evt, played: [], attempted, timingDeltaMs: null, result: "miss" });
  }, [recordEvent, practiceStopAt]);

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
    // Repeat is session-only state, so a reload drops it back to the default.
    setSongRepeat(false);
    setSongRestMeasures(0);
    bpm.reset(loadedSong.defaultBpm || DEFAULTS.bpm);
    timingWindowMs.reset(loadedSong.defaultTimingWindowMs ?? DEFAULTS.timingWindowMs);
    chordMs.reset(loadedSong.defaultChordMs ?? DEFAULTS.chordMs);
    measureWidth.reset(loadedSong.defaultMeasureWidth ?? DEFAULTS.measureWidth);
    playbackSpeed.reset(loadedSong.playbackSpeed ?? DEFAULTS.playbackSpeed);
    setPlaybackState("stopped");
    setPausedMeasure(null);
    clearStuckBeat();
    setPractice(false);
    disarmPass();
    setLoopCount(0);
    lastLoopCountRef.current = 0;
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
    // Resolving a range's database id is not a range change. Play auto-saves an
    // ad-hoc range and swaps in the saved snippet in the same breath as it
    // starts playback (M1.5); without this guard that swap would be read as
    // "the user picked a different snippet" and stop playback on the spot.
    // `sameLoadedRange` compares the four identity properties and ignores
    // `dbId`, so a genuine range change still falls through to the reset.
    if (sameLoadedRange(prev, snippet)) return;
    // Selecting a snippet clears whole-song repeat rather than parking it:
    // returning to the full song should not silently re-enable a loop the
    // user last touched several snippets ago.
    if (snippet) setSongRepeat(false);
    handleFullStop();
  }, [snippet]); // eslint-disable-line react-hooks/exhaustive-deps

  // A successful upload (or replacement) is already stored; mirror only the
  // path into the song in memory. Every audio check reads it from there, and
  // the load effect above picks up the new file. Nothing else on the song
  // changes — tempo, speed and goal stay exactly as they were.
  function handleAudioUploaded(path) {
    setSong((s) => (s ? { ...s, audioFilePath: path } : s));
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
    attemptedNotesRef.current = new Map();
    hitCountRef.current = 0;
    missCountRef.current = 0;
    setHitCount(0);
    setMissCount(0);
    setLastResult(null);
  }

  // `activeSnippet` is passed explicitly rather than read from state because
  // Play resolves an ad-hoc range to a saved one and then begins the session in
  // the same tick, before React has re-rendered with the new state.
  function beginSession(activeSnippet = snippet) {
    startSession({
      songId: songDbId,
      snippetId: activeSnippet?.dbId || null,
      // Resume opens a new session too, and links it by the same rule. A range
      // that could not be saved has no id and is not the whole song, so it
      // links to the plan but to no item.
      planLink: activeSnippet && !activeSnippet.dbId
        ? { ...getPlanLink(songDbId, null), plan_item_id: null }
        : getPlanLink(songDbId, activeSnippet?.dbId || null),
      settings: {
        bpm: bpm.value,
        windowMs: timingWindowMs.value,
        chordGroupMs: chordMs.value,
        measureWidth: measureWidth.value,
        playbackSpeed: playbackSpeed.value,
        // Which hand the player is SCORED on. Only a snippet carries one, so a
        // whole-song sitting is always "both" today — recording it explicitly
        // means a whole-song session stops being merely presumed to be both
        // hands, and it is already right if a whole-song hand toggle arrives.
        handMode: activeSnippet?.handMode || "both",
        // Whether a keyboard was attached when the sitting began. Decides, with
        // `summary.midi.everConnected`, whether this session's accuracy is a
        // measurement or an absence of one.
        midiConnected: !!midiConnected,
      },
    });
  }

  // Tempo and MIDI both change mid-sitting, so the session has to watch them
  // rather than snapshot them. Both observers are no-ops when no session is
  // open, so neither needs to know the playback state.
  useEffect(() => {
    noteTempo(bpm.value);
  }, [bpm.value, noteTempo]);

  useEffect(() => {
    noteMidiConnected(midiConnected);
  }, [midiConnected, noteMidiConnected]);

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

  // Guards the await inside `handlePlay`. Until the snippet lookup resolves the
  // Play button is still on screen, so a second click would run a second lookup
  // and — finding nothing saved yet — insert a duplicate snippet.
  const playStartingRef = useRef(false);

  // Shared tail of Play and Restart: both enter at the first measure of the
  // loaded range, so both arm a pass and both seek to the top.
  // `activeSnippet` is threaded through because Play may have just resolved it.
  //
  // `practice` is what separates the two transports, and it is deliberately
  // the ONLY difference: the range, the tempo, the repeat and rest settings and
  // the scroll are identical, so Practice cannot drift away from Play.
  //
  // Arming and the session are skipped rather than blocked here — the hooks
  // would refuse them anyway — because calling them would be a lie about intent.
  // The audio seek is skipped because backing audio is off in Practice: with no
  // seek stowed, `scheduleAudioStartOnScroll` has nothing to fire.
  function startFromTopOfRange(activeSnippet, { practice = false } = {}) {
    resetCounters();
    clearStuckBeat();
    setPausedMeasure(null);
    lastLoopCountRef.current = 0;
    if (!practice) {
      armPass();
      beginSession(activeSnippet);
    }
    clearTimers();

    if (practice) {
      // The element is never played in Practice, but it may be mid-preview from
      // the stopped screen's scrubber.
      if (audioElement) audioElement.pause();
    } else {
      const audioOffsetMs1 = activeMeasures[0]?.audioOffsetMs ?? 0;
      const seekMs = activeSnippet ? getSeekForMeasure(activeSnippet.startMeasure) : audioOffsetMs1;
      prepareAudioSeek(seekMs);
    }

    setPlaybackState("playing");
  }

  // Make sure the range about to be played has a `sam_snippets` row behind it,
  // and hand back the snippet to play (id attached when one could be resolved).
  //
  // M1.5: the snippet panel can still hand us a range with no id — a range the
  // user typed and never saved. Rather than leave it unattributable, Play saves
  // it. An identical saved snippet is adopted instead of duplicated, so playing
  // the same ad-hoc range twice yields one snippet, not two.
  //
  // The full song is never a snippet: `snippet` is null there and this returns
  // null untouched, so a whole-song pass keeps writing a null `snippet_id` and
  // no snippet is created, not even one spanning every measure.
  async function ensureRangeIsSaved(current) {
    if (!current || current.dbId || !songDbId) return current;

    const result = await ensureSnippetSaved({ songDbId, range: current });
    if (!result) {
      // Already logged. Play on without an id: losing one row of practice data
      // beats a Play button that doesn't play.
      return current;
    }
    // Same range, now carrying its id — `sameLoadedRange` keeps the reset
    // effect from reading this as a snippet switch and stopping playback.
    setSnippet(result.snippet);
    return result.snippet;
  }

  async function handlePlay() {
    if (playStartingRef.current) return;
    playStartingRef.current = true;
    try {
      setPractice(false);
      ensureAudioContext();
      const activeSnippet = await ensureRangeIsSaved(snippet);
      startFromTopOfRange(activeSnippet);
    } finally {
      playStartingRef.current = false;
    }
  }

  // Practice. Same range, same tempo, same scroll — no recording, no audio.
  //
  // `ensureRangeIsSaved` is deliberately NOT called: Practice attributes
  // nothing to anything, so it has no use for a snippet id, and saving a row
  // for a range the user only wanted to work through would be a write. An
  // unsaved ad-hoc range therefore practises fine and leaves no trace.
  //
  // Synchronous, unlike Play, precisely because that await is gone — but it
  // shares `playStartingRef` so it cannot interleave with a Play in flight.
  function handlePractice() {
    if (playStartingRef.current) return;
    setPractice(true);
    ensureAudioContext(); // the metronome still needs it
    startFromTopOfRange(snippet, { practice: true });
  }

  // Deliberately leaves pass eligibility alone: pause and resume are one
  // playthrough interrupted, not two (spec rule 4).
  function handlePause() {
    clearTimers();
    // Until step 4 exists, Pause and Stop are the only ways out of a stopped
    // practice run. Resume restarts the scroll with a fresh scroll state, so
    // the freeze must not outlive the pause.
    clearStuckBeat();
    const meas = getCurrentMeasure();
    setPausedMeasure(meas);
    endSession();
    if (audioElement) audioElement.pause();
    setPlaybackState("paused");
  }

  function handleResume() {
    ensureAudioContext();
    resetCounters();
    clearStuckBeat();
    if (!practiceModeRef.current) beginSession();
    clearTimers();

    if (audioElement && !practiceModeRef.current) {
      // Seek to the beginning of the paused measure so audio aligns with scroll
      const seekMs = pausedMeasure ? getSeekForMeasure(pausedMeasure) : audioElement.currentTime * 1000;
      prepareAudioSeek(seekMs);
    }

    setPlaybackState("playing");
  }

  // Restart re-enters at the first measure, so the abandoned playthrough is
  // dropped and a fresh one armed in the same breath. It is only reachable from
  // the paused state — where the snippet panel is still on screen and the range
  // may have been edited since Play — so it ensures the range is saved too.
  async function handleRestart() {
    if (playStartingRef.current) return;
    // Restart re-enters the mode it was already in, so a paused practice run
    // restarts as practice — and still saves no snippet.
    if (practiceModeRef.current) {
      ensureAudioContext();
      startFromTopOfRange(snippet, { practice: true });
      return;
    }
    playStartingRef.current = true;
    try {
      ensureAudioContext();
      const activeSnippet = await ensureRangeIsSaved(snippet);
      startFromTopOfRange(activeSnippet);
    } finally {
      playStartingRef.current = false;
    }
  }

  function handleStop() {
    clearTimers();
    clearStuckBeat();
    disarmPass();
    setPlaybackState("stopped");
    // Before the flag is cleared, so a practice run's `endSession` is still
    // refused. Pause deliberately does NOT clear it: pause and resume are one
    // practice run interrupted, exactly as they are one playthrough for Play.
    endSession();
    setPractice(false);
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
  }

  // Published for `handleRangeEnded`, which is created before `handleStop` and
  // must not re-create itself when `handleStop` does.
  handleStopRef.current = handleStop;

  function handleFullStop() {
    clearTimers();
    clearStuckBeat();
    disarmPass();
    endSession(); // refused while the flag is still set — see handleStop
    setPractice(false);
    resetCounters();
    setPausedMeasure(null);
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
    setPlaybackState("stopped");
  }

  // Selecting, clearing, or editing a snippet changes what "the loaded range"
  // means, so whatever playthrough was in flight belonged to a range that is no
  // longer loaded. Banked passes are untouched — they are rows.
  function handleSnippetChange(next) {
    disarmPass();
    setSnippet(next);
  }

  function handleScoreTap() {
    if (playbackState === "stopped") return;
    if (playbackState === "playing") handlePause();
    else if (playbackState === "paused") handleResume();
  }

  // Open a practice plan item from the home page checklist (§7.3): its song,
  // its snippet when that is still loadable, and the item's target tempo in
  // the tempo box for this sitting. Nothing is saved to the song — the tempo
  // box only saves through its own Save button.
  async function openPlanItem(item) {
    // Reached from the player too, via the plan line's Next button: end any
    // sitting in flight first so its events are flushed, exactly as closing
    // the song would. From the home page there is nothing to end.
    if (playbackState === "playing") endSession();
    let loaded;
    try {
      loaded = await fetchSongById(item.song_id, supabase);
    } catch (e) {
      console.error("[Sam] Failed to open plan item:", e);
      setImportError("That song could not be loaded.");
      return;
    }
    handleSongLoaded(loaded.song);
    setSongDbId(loaded.row.id);
    const sn = item.snippet;
    if (sn && !item.snippet_unavailable) setSnippet(snippetFromRow(sn));
    if (Number.isFinite(item.target_bpm)) bpm.set(item.target_bpm);
    if (Number.isFinite(item.target_playback_speed)) playbackSpeed.set(item.target_playback_speed);
  }

  // "Set tempo" on the plan line: the item's tempo, for this sitting only.
  function applyPlanTempo() {
    if (!planItem) return;
    if (Number.isFinite(planItem.target_bpm)) bpm.set(planItem.target_bpm);
    if (Number.isFinite(planItem.target_playback_speed)) playbackSpeed.set(planItem.target_playback_speed);
  }

  // Back to the song library. Closing a song is a route change: the URL drops
  // back to /sam and the effect below does the teardown, so every way out of a
  // song shares one code path. This used to back the "Change song" link as
  // well; that link was removed once the back arrow started coming here, since
  // the two did exactly the same thing.
  function handleBackToLibrary() {
    navigate(SAM_PATH);
  }

  // The actual teardown, shared by the Change-song button and browser Back.
  function closeOpenSong() {
    clearTimers();
    clearStuckBeat();
    disarmPass();
    if (playbackState === "playing") endSession();
    setPractice(false);
    if (audioElement) audioElement.pause();
    setAudioElement(null);
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

  // Controls that belong to the score: Fingering mode, Diff, Show Imported.
  //
  // They have moved twice. M3.5 took them off a row of their own and put them
  // in SettingsBar's top-right cluster; they now sit at the far end of the
  // Snippet toggle row, which is the last row before the score and was
  // otherwise empty. That reads as what they are — score controls, next to the
  // score — costs no vertical space, since both sides of that row are already
  // 44px tall, and gives the transport row its width back.
  //
  // Still gated on `stopped`, exactly as before, so nothing about WHEN they are
  // available has changed across any of the moves.
  const scoreToolButtons = playbackState === "stopped" ? (
    <>
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
    </>
  ) : null;

  return (
    <div className="min-h-screen bg-primary-bg">
      {/* The "Sam — Piano Practice" header row is gone (M4 part 1) — it cost
          ~68px, the tallest row on the page, for a title that says where you
          already know you are. Its back-to-Alfred button survives, moved to the
          far left of whichever control row is on screen. That rule matters:
          `onBack` appeared ONLY in that header, and the transport row does not
          exist while playing or before a song is open, so putting it there
          alone would have made Alfred unreachable from the song library and
          two clicks away (pause, then back) during playback. */}
      {/* The song library sits tighter to the top: its header row replaces the
          padding (practice plans M4 follow-up). The player keeps py-6. */}
      <div ref={scrollContainerRef} className={`mx-auto px-3 sm:px-4 ${song ? "py-6" : "pt-2 pb-6"}`}>
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
          <>
            {/* Same centered column as the library below it (SongLoader's
                max-w-lg). Three columns — back arrow, title, an empty spacer as
                wide as the arrow — keep the title centered in the column and
                make it impossible for it to slide under the arrow when narrow. */}
            <div className="max-w-lg mx-auto grid grid-cols-[44px_1fr_44px] items-center">
              {/* The only level above the song library is Alfred itself, and
                  this is the only route out of SAM — see BackButton. */}
              <BackButton onBack={onBack} title="Back to Alfred" />
              <div className="flex items-center justify-center gap-2 min-w-0">
                {/* Same icon Alfred's navigation uses for SAM. */}
                <Music className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
                <h2 className="text-lg sm:text-xl font-medium text-foreground truncate">SAM</h2>
              </div>
              <span aria-hidden="true" />
            </div>
            <SongLoader
              onSongLoaded={handleSongLoaded}
              onSongSaved={setSongDbId}
              onImportError={setImportError}
              activePlan={activePlan}
              onOpenPlanItem={openPlanItem}
            />
          </>
        ) : (
          <>
            {playbackState === "playing" ? (
              practiceMode ? (
                <PracticeBar onPause={handlePause} stuck={stuckBeat} />
              ) : (
              <FocusedPlaybackBar
                onPause={handlePause}
                todayMinutes={todayMinutes}
                passesToday={passesToday}
                loopCount={loopCount}
                hitCount={hitCount}
                missCount={missCount}
                accuracyPercent={sessionStats.accuracyPercent}
                playthroughPercent={sessionStats.playthroughAccuracyPercent}
                hasPlaythrough={sessionStats.hasPlaythrough}
                planBadge={planBadge}
              />
              )
            ) : (
              <>
                <SettingsBar
                  onBack={handleBackToLibrary}
                  song={song} snippet={snippet}
                  bpm={bpm}
                  timingWindowMs={timingWindowMs}
                  chordMs={chordMs}
                  measureWidth={measureWidth}
                  playbackSpeed={playbackSpeed}
                  playbackState={playbackState} songDbId={songDbId}
                  onPlay={handlePlay} onPractice={handlePractice} onPause={handlePause} onResume={handleResume} onRestart={handleRestart} onStop={handleFullStop}
                  onExport={handleExport}
                  midiConnected={midiConnected} midiDevice={midiDevice}
                  pausedMeasure={pausedMeasure}
                  onSongUpdate={setSong}
                  onAudioUploaded={handleAudioUploaded}
                  onFullSong={() => handleSnippetChange(null)}
                  onLyricsChanged={setLyricPlacements}
                  skipTiedNotes={skipTiedNotes}
                  hasImportedFingerings={hasImported}
                  songRepeat={songRepeat}
                  onSongRepeatChange={setSongRepeat}
                  songRestMeasures={songRestMeasures}
                  onSongRestMeasuresChange={setSongRestMeasures}
                  metronome={metronome}
                  setMetronome={setMetronome}
                  scorePlayback={scorePlayback}
                  setScorePlayback={setScorePlayback}
                  todayMinutes={todayMinutes}
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
                  playbackState={playbackState}
                  songTodaySeconds={perSongTodaySeconds}
                  songTotalSeconds={perSongTotalSeconds}
                  songPassesToday={songPassesToday}
                  songPassesTotal={songPassesTotal}
                />

                <PlanLine
                  item={planItem}
                  state={planItemState}
                  songNote={planSongNote}
                  heardTempo={heardTempo(bpm.value, playbackSpeed.value)}
                  onSetTempo={applyPlanTempo}
                  nextItem={nextPlanItem}
                  // The same path the home page checklist uses — one way in.
                  onOpenNext={openPlanItem}
                />

                <SnippetPanel
                  songDbId={songDbId}
                  totalMeasures={song.measures.length}
                  snippet={snippet}
                  onSnippetChange={handleSnippetChange}
                  scoreTools={scoreToolButtons}
                  planTagFor={planTagFor}
                />
              </>
            )}

            {playbackState === "stopped" ? (
              <>
                {/* Only the fingering-entry widgets remain on a row of their
                    own, and only while fingering mode is on — the row used to
                    render unconditionally, almost always holding nothing but
                    the Fingering mode button, which now sits in the top row. */}
                {fingeringMode && (
                  <div className="flex items-center gap-2 px-1 mb-2">
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
                    <button
                      onClick={undoFingering}
                      disabled={!canUndoFingering}
                      className="min-h-[44px] px-4 rounded-lg text-sm font-medium border border-border bg-card text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
                    >
                      ↺ Undo
                    </button>
                  </div>
                )}
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
                bpm={practiceMode ? practiceBpm : bpm.value}
                playbackState={playbackState}
                fingerings={fingerings}
                onBeatEvents={handleBeatEvents}
                onLoopCount={handleLoopCount}
                onContentEnd={handleContentEnd}
                restMeasureCount={appendedRestCount}
                onBeatMiss={handleBeatMiss}
                scrollStateExtRef={scrollStateExtRef}
                onTap={handleScoreTap}
                measureWidth={measureWidth.value}
                metronome={metronome}
                scorePlayback={practiceMode ? "off" : scorePlayback}
                audioCtx={audioCtxRef.current}
                firstPassStart={
                  pausedMeasure != null
                    ? Math.max(0, activeMeasures.findIndex(m => m.number >= pausedMeasure))
                    : 0
                }
                loop={!!snippet || songRepeatActive}
                onEnded={handleRangeEnded}
                timingWindowMs={timingWindowMs.value}
                audioElement={practiceMode ? null : audioElement}
                audioAnchors={practiceMode ? EMPTY_ANCHORS : audioAnchors}
                audioEndMs={practiceMode ? null : (audioElement ? getLoopAudioEndMs() : null)}
                handMode={snippet?.handMode || "both"}
                onScrollStart={practiceMode ? null : scheduleAudioStartOnScroll}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
