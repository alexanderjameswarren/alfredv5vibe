import { useMemo, useRef } from "react";
import { getMeasDurationQ } from "./measureUtils";
import { getMeasureWidth } from "./vexflowHelpers";

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

  // Audio anchors: map each measure with audioOffsetMs to its cumulative beat position.
  // Each anchor = { beatPos, audioMs } where beatPos is beats from activeMeasures[0].
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
    return anchors;
  }, [activeMeasures]);

  // Calculate audio file timestamp (ms) for a given measure number.
  // Uses audio_offset_ms if set on the target measure, else derives from BPM.
  function getSeekForMeasure(measNum) {
    if (!song || !measNum) return 0;
    const targetMeas = song.measures[measNum - 1];
    if (targetMeas?.audioOffsetMs != null) return targetMeas.audioOffsetMs;
    const defBpm = song.defaultBpm || bpm;
    const msPerBeat = 60000 / defBpm;
    const audioOffsetMs1 = song.measures[0]?.audioOffsetMs ?? 0;
    let totalBeats = 0;
    for (let i = 0; i < measNum - 1; i++) {
      totalBeats += getMeasDurationQ(song.measures[i]);
    }
    return audioOffsetMs1 + totalBeats * msPerBeat;
  }

  // Audio file timestamp (ms) where the snippet's real measures end.
  // Audio should be silent during rest measures that follow.
  function getSnippetAudioEndMs() {
    if (!snippet || !song) return null;
    const startMs = getSeekForMeasure(snippet.startMeasure);
    const defBpm = song.defaultBpm || bpm;
    const msPerBeat = 60000 / defBpm;
    let totalBeats = 0;
    for (let i = snippet.startMeasure - 1; i < snippet.endMeasure; i++) {
      totalBeats += getMeasDurationQ(song.measures[i]);
    }
    return startMs + totalBeats * msPerBeat;
  }

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
