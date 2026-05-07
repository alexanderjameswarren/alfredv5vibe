import { useMemo, useRef } from "react";
import { getMeasDurationQ } from "./measureUtils";
import { getMeasureWidth } from "./vexflowHelpers";
import { SCROLL_GEOMETRY } from "./samConstants";

// Audio-sync subsystem: anchor derivation, seek-time math for arbitrary
// measures and snippet endpoints, and the delay-timer dance that fires
// `audioElement.play()` when ScrollEngine reports its scroll has begun.
//
// Transport handlers in SamPlayer call `prepareAudioSeek(seekMs)` before
// flipping playbackState to "playing"; the hook stows the seek and waits for
// `scheduleAudioStartOnScroll` (wired into <ScrollEngine onScrollStart>) to
// arm the delay timer so audio begins exactly when the first note crosses the
// target line, regardless of leadInPx and playbackSpeed.
export default function useAudioSync({
  song,
  snippet,
  activeMeasures,
  bpm,
  playbackSpeed,
  audioElement,
  scrollContainerRef,
  measureWidth,
}) {
  const audioDelayTimerRef = useRef(null);
  const scrollDelayTimerRef = useRef(null);
  const pendingAudioSeekRef = useRef(null);

  // Audio anchors derived from the FULL `song.measures` — consumed by
  // `getSeekForMeasure` / `getSnippetAudioEndMs`. We need song-relative
  // anchors here so a snippet that doesn't start at measure 1 still gets
  // accurate seeks: the seek functions reason in terms of measure numbers
  // from the full song, not the snippet slice.
  //
  // Declared before `audioAnchors` because the snippet-virtual-anchor
  // injection in `audioAnchors` calls `getSeekForMeasure`, which closes
  // over `songAudioAnchors`. If `songAudioAnchors` were declared after,
  // accessing it during `audioAnchors`'s memo would hit the TDZ.
  const songAudioAnchors = useMemo(() => {
    if (!song?.measures?.length) return [];
    const anchors = [];
    let cumulativeBeats = 0;
    for (const m of song.measures) {
      if (m.audioOffsetMs != null) {
        anchors.push({ beatPos: cumulativeBeats, audioMs: m.audioOffsetMs });
      }
      cumulativeBeats += getMeasDurationQ(m);
    }
    return anchors;
  }, [song]);

  // Inverse of ScrollEngine's `audioMsToBeatPos`: convert a beat position
  // (relative to song.measures[0]) into an audio file timestamp.
  // Mirrors the forward function exactly:
  // - 0 anchors  → virtual {beatPos:0, audioMs:0} anchor (BPM-based rate)
  // - 1 anchor   → BPM-based extrapolation from that anchor
  // - 2+ anchors → piecewise-linear, extrapolating beyond the bounds using
  //   the rate of the bounding segment
  function beatPosToAudioMs(beatPos, rawAnchors) {
    const anchors = rawAnchors.length > 0 ? rawAnchors : [{ beatPos: 0, audioMs: 0 }];
    const defBpm = song?.defaultBpm || bpm;
    const msPerBeat = 60000 / defBpm;
    if (anchors.length === 1) {
      return anchors[0].audioMs + (beatPos - anchors[0].beatPos) * msPerBeat;
    }
    if (beatPos <= anchors[0].beatPos) {
      const segRate = (anchors[1].audioMs - anchors[0].audioMs) / (anchors[1].beatPos - anchors[0].beatPos);
      return anchors[0].audioMs + (beatPos - anchors[0].beatPos) * segRate;
    }
    for (let i = 0; i < anchors.length - 1; i++) {
      if (beatPos <= anchors[i + 1].beatPos || i === anchors.length - 2) {
        const segRate = (anchors[i + 1].audioMs - anchors[i].audioMs) / (anchors[i + 1].beatPos - anchors[i].beatPos);
        return anchors[i].audioMs + (beatPos - anchors[i].beatPos) * segRate;
      }
    }
    return 0;
  }

  // Cumulative beat count from song.measures[0] up to (not including) measNum.
  function songBeatPosForMeasure(measNum) {
    let beats = 0;
    for (let i = 0; i < measNum - 1; i++) {
      beats += getMeasDurationQ(song.measures[i]);
    }
    return beats;
  }

  // Audio file timestamp (ms) for a given measure number.
  // If the target measure has its own anchor, return it directly; otherwise
  // interpolate via songAudioAnchors so multi-anchor songs respect tempo
  // drift between anchors.
  function getSeekForMeasure(measNum) {
    if (!song || !measNum) return 0;
    const targetMeas = song.measures[measNum - 1];
    if (targetMeas?.audioOffsetMs != null) return targetMeas.audioOffsetMs;
    return beatPosToAudioMs(songBeatPosForMeasure(measNum), songAudioAnchors);
  }

  // Audio file timestamp (ms) where the snippet's real measures end.
  // Audio should be silent during rest measures that follow. Maps the
  // snippet's end beatPos through `songAudioAnchors` so the end timestamp
  // honors anchors that fall inside or beyond the snippet range.
  function getSnippetAudioEndMs() {
    if (!snippet || !song) return null;
    let totalBeats = 0;
    for (let i = 0; i < snippet.endMeasure; i++) {
      totalBeats += getMeasDurationQ(song.measures[i]);
    }
    return beatPosToAudioMs(totalBeats, songAudioAnchors);
  }

  // Audio anchors derived from `activeMeasures` (snippet-sliced) — consumed
  // by ScrollEngine for runtime audioMs ↔ beatPos mapping during playback.
  // beatPos is in beats from `activeMeasures[0]`.
  const audioAnchors = useMemo(() => {
    if (!activeMeasures.length) return [];
    const anchors = [];
    let cumulativeBeats = 0;
    for (const m of activeMeasures) {
      if (m.audioOffsetMs != null) {
        anchors.push({ beatPos: cumulativeBeats, audioMs: m.audioOffsetMs });
      }
      cumulativeBeats += getMeasDurationQ(m);
    }
    // Snippet must have an anchor at beatPos 0 so ScrollEngine's
    // audioMsToBeatPos has a correct origin for the snippet's first
    // measure. Without this, audio↔beat mapping is wrong whenever the
    // snippet's first measure lacks an explicit audioOffsetMs.
    if (snippet && (anchors.length === 0 || anchors[0].beatPos !== 0)) {
      const startAudioMs = getSeekForMeasure(snippet.startMeasure);
      anchors.unshift({ beatPos: 0, audioMs: startAudioMs });
    }
    return anchors;
  }, [activeMeasures, snippet, song]); // eslint-disable-line react-hooks/exhaustive-deps

  function clearTimers() {
    if (audioDelayTimerRef.current) {
      clearTimeout(audioDelayTimerRef.current);
      audioDelayTimerRef.current = null;
    }
    if (scrollDelayTimerRef.current) {
      clearTimeout(scrollDelayTimerRef.current);
      scrollDelayTimerRef.current = null;
    }
    pendingAudioSeekRef.current = null;
  }

  // Calculate the visual approach time (ms) for the first note to reach the target line.
  // Must match ScrollEngine's approach calculation: leadInPx = viewportWidth * 0.25.
  function getApproachMs() {
    const viewportWidth = scrollContainerRef.current?.clientWidth || SCROLL_GEOMETRY.fallbackViewportWidth;
    const leadInPx = viewportWidth * SCROLL_GEOMETRY.leadInPct;
    const msPerBeat = 60000 / bpm;
    const firstMeas = activeMeasures[0];
    if (!firstMeas) return 0;
    const firstDurationQ = getMeasDurationQ(firstMeas);
    const firstMeasWidth = getMeasureWidth(firstMeas.timeSignature, false, measureWidth);
    const pxPerBeat = firstMeasWidth / firstDurationQ;
    const pxPerMs = pxPerBeat / msPerBeat;
    return leadInPx / pxPerMs;
  }

  // Stow a seek to be applied when scroll begins. Becomes a no-op when there
  // is no audioElement so transport handlers can call this unconditionally.
  function prepareAudioSeek(seekMs) {
    pendingAudioSeekRef.current = audioElement ? { seekMs } : null;
  }

  // Called by ScrollEngine when it initializes and sets scrollStartT.
  // Starts the audio delay timer synchronized with the scroll's start time.
  function scheduleAudioStartOnScroll(scrollStartT) {
    const pending = pendingAudioSeekRef.current;
    if (!pending || !audioElement) return;
    pendingAudioSeekRef.current = null;

    const approach = getApproachMs();
    const rate = playbackSpeed / 100 || 1;
    const audioDelay = approach / rate;

    // Adjust for any time already elapsed since ScrollEngine started
    const alreadyElapsed = performance.now() - scrollStartT;
    const remainingDelay = Math.max(0, audioDelay - alreadyElapsed);

    if (remainingDelay > 0) {
      audioDelayTimerRef.current = setTimeout(() => {
        audioElement.currentTime = pending.seekMs / 1000;
        audioElement.play();
        audioDelayTimerRef.current = null;
      }, remainingDelay);
    } else {
      audioElement.currentTime = pending.seekMs / 1000;
      audioElement.play();
    }
  }

  return {
    audioAnchors,
    getSeekForMeasure,
    getSnippetAudioEndMs,
    scheduleAudioStartOnScroll,
    prepareAudioSeek,
    clearTimers,
  };
}
