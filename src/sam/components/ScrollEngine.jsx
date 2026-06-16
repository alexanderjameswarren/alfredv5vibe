import React, { useEffect, useRef, useState } from "react";
import { colorBeatEls, getMeasureWidth } from "../lib/vexflowHelpers";
import { getMeasDurationQ } from "../lib/measureUtils";
import { renderCopy, playClick } from "../lib/scoreRender";
import { SCROLL_GEOMETRY, METRONOME_GAIN, SCORE_SCALE } from "../lib/samConstants";


export default function ScrollEngine({ measures, bpm, playbackState, onBeatEvents, onLoopCount, onBeatMiss, scrollStateExtRef, onTap, measureWidth, metronome = "off", audioCtx = null, firstPassStart = 0, loop = true, onEnded, timingWindowMs = 300, audioElement = null, audioAnchors = [], audioEndMs = null, handMode = "both", onScrollStart = null }) {
  const viewportRef = useRef(null);
  const scrollLayerRef = useRef(null);
  const rafRef = useRef(null);
  const scrollStateRef = useRef(null);
  const beatEventsRef = useRef([]);
  const copyWidthRef = useRef(0);
  const nextCheckRef = useRef(0);
  const hasLoopedRef = useRef(false);
  const [svgReady, setSvgReady] = useState(false);

  // Render copies of the score SVG into the scroll layer (1 copy for non-looping, 3 for looping)
  useEffect(() => {
    if (!measures || measures.length === 0) return;

    const VF = window.Vex?.Flow;
    if (!VF) return;

    const scrollLayer = scrollLayerRef.current;
    scrollLayer.innerHTML = "";

    // Use 1 copy for non-looping playback, 3 copies for seamless looping
    const numCopies = loop ? 3 : 1;

    // Precompute per-measure durations and cumulative start beats
    const measDurations = measures.map(m => getMeasDurationQ(m));
    const measStartBeats = [];
    let cumBeat = 0;
    for (let i = 0; i < measures.length; i++) {
      measStartBeats.push(cumBeat);
      cumBeat += measDurations[i];
    }

    // Calculate single copy width — proportional to time signature
    const singleMeasureWidths = measures.map((m) => getMeasureWidth(m.timeSignature, false, measureWidth));
    const singleCopyWidth = singleMeasureWidths.reduce((a, b) => a + b, 0);
    const totalWidth = singleCopyWidth * numCopies + 20;

    // copyWidth crosses into display-pixel space because the scroll layer's
    // CSS translateX consumes display pixels. singleCopyWidth is render-space
    // (sum of getMeasureWidth outputs), so apply SCORE_SCALE at this boundary.
    copyWidthRef.current = singleCopyWidth * SCORE_SCALE;

    const renderer = new VF.Renderer(scrollLayer, VF.Renderer.Backends.SVG);
    renderer.resize(totalWidth * SCORE_SCALE, SCROLL_GEOMETRY.staffHeight * SCORE_SCALE);
    const ctx = renderer.getContext();
    ctx.scale(SCORE_SCALE, SCORE_SCALE);

    // Render copies (1 for non-looping, 3 for looping)
    const allBeatMeta = [];
    const copyBeatCounts = [];
    for (let c = 0; c < numCopies; c++) {
      const xStart = 10 + c * singleCopyWidth;
      const { beatMeta } = renderCopy(VF, ctx, measures, c, xStart, measureWidth, measDurations, measStartBeats);
      copyBeatCounts.push(beatMeta.length);
      allBeatMeta.push(...beatMeta);
    }

    // Build beat events from all copies
    const totalMusicalBeatsPerCopy = cumBeat; // sum of all measure durationQ values
    let copyOffset = 0;
    let copyIdx = 0;
    const events = allBeatMeta.map((meta, globalIdx) => {
      // Track which copy this event belongs to
      while (copyIdx < copyBeatCounts.length - 1 && globalIdx >= copyOffset + copyBeatCounts[copyIdx]) {
        copyOffset += copyBeatCounts[copyIdx];
        copyIdx++;
      }
      const refNote = meta.trebleNote || meta.bassNote;
      // VexFlow's positions are render-space; scroll math operates in display
      // pixels. Cross the boundary here so downstream originPx/targetX math
      // stays uniform.
      const xPx = refNote ? (refNote.getAbsoluteX() + refNote.getXShift()) * SCORE_SCALE : 0;
      const svgEls = [];
      if (meta.trebleSvgEl) svgEls.push(meta.trebleSvgEl);
      if (meta.bassSvgEl) svgEls.push(meta.bassSvgEl);
      return {
        globalIdx,
        meas: meta.meas,
        beat: meta.beat,
        baseBeat: meta.musicalBeatInCopy,
        musicalBeat: copyIdx * totalMusicalBeatsPerCopy + meta.musicalBeatInCopy,
        allMidi: meta.allMidi,
        rhMidi: meta.rhMidi || [],
        lhMidi: meta.lhMidi || [],
        xPx,
        state: "pending",
        svgEls,
        trebleSvgEl: meta.trebleSvgEl,
        bassSvgEl: meta.bassSvgEl,
      };
    });

    beatEventsRef.current = events;
    console.log(beatEventsRef.current.slice(0, 8).map(e => ({meas: e.meas, beat: e.beat})));
    if (onBeatEvents) onBeatEvents(events);
    setSvgReady(true);

    return () => {
      setSvgReady(false);
    };
  }, [measures, measureWidth, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animation loop with seamless looping
  useEffect(() => {
    if (playbackState !== "playing" || !svgReady) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Only reset transform/scrollState when fully stopped — preserve on pause
      if (playbackState === "stopped") {
        if (scrollLayerRef.current) {
          scrollLayerRef.current.style.transform = "translateX(0px)";
        }
        scrollStateRef.current = null;
        if (scrollStateExtRef) scrollStateExtRef.current = null;
      }
      return;
    }

    const viewport = viewportRef.current;
    const scrollLayer = scrollLayerRef.current;
    if (!viewport || !scrollLayer) return;

    const viewportWidth = viewport.clientWidth;
    const targetX = viewportWidth * SCROLL_GEOMETRY.targetLinePct;
    const msPerBeat = 60000 / bpm;
    const firstDurationQ = getMeasDurationQ(measures[0]);
    // firstMeasWidth must be display pixels so pxPerMs comes out as
    // display-px-per-ms — that's the rate the scroll's translateX consumes.
    // getMeasureWidth returns render-space, so apply SCORE_SCALE at the boundary.
    const firstMeasWidth = getMeasureWidth(measures[0].timeSignature, false, measureWidth) * SCORE_SCALE;
    const pxPerBeat = firstMeasWidth / firstDurationQ;
    const pxPerMs = pxPerBeat / msPerBeat;
    const copyWidth = copyWidthRef.current;

    const events = beatEventsRef.current;

    // Reset from previous session: clear colors, states, and stale musicalBeat values.
    // musicalBeat is modified by teleport, so it must be restored to its original
    // copy-relative value before recomputing approachMs / targetTimeMs.
    const numCopies = loop ? 3 : 1;
    const beatsPerCopy = events.length / numCopies;
    let totalMusicalBeatsPerCopy = 0;
    for (const m of measures) totalMusicalBeatsPerCopy += getMeasDurationQ(m);
    for (let i = 0; i < events.length; i++) {
      const c = Math.floor(i / beatsPerCopy);
      events[i].musicalBeat = c * totalMusicalBeatsPerCopy + events[i].baseBeat;
      events[i].state = "pending";
      colorBeatEls(events[i], "#000000");
    }
    const svgEl = scrollLayer.querySelector("svg");
    if (svgEl) {
      svgEl.querySelectorAll('g.sam-measure[style]').forEach(el => {
        el.style.visibility = "";
      });
    }

    hasLoopedRef.current = false;

    // Find the first beat at the firstPassStart measure (for resume-from-measure)
    let startEvtIdx = 0;
    if (firstPassStart > 0 && measures[firstPassStart]) {
      const startMeasNum = measures[firstPassStart].number;
      const beatsPerCopyForStart = events.length / numCopies;
      for (let i = 0; i < beatsPerCopyForStart; i++) {
        if (events[i].meas >= startMeasNum) {
          startEvtIdx = i;
          break;
        }
      }
    }

    // Origin: position so that the startEvtIdx beat starts 25% of viewport width
    // to the right of the target line (short lead-in before first note arrives).
    const startBeatX = events[startEvtIdx]?.xPx || events[0]?.xPx || 0;
    const leadInPx = viewportWidth * SCROLL_GEOMETRY.leadInPct;
    const originPx = startBeatX - targetX - leadInPx;

    // Approach time adjusted for the start offset so that
    // targetTimeMs = approachMs + musicalBeat * msPerBeat matches the geometric scroll position.
    // The start beat (musicalBeat = S) reaches targetX at elapsed = baseApproach,
    // so approachMs = baseApproach - S * msPerBeat.
    const baseApproachMs = leadInPx / pxPerMs;
    const startMusicalBeat = events[startEvtIdx]?.musicalBeat || 0;
    const approachMs = baseApproachMs - startMusicalBeat * msPerBeat;

    // Compute targetTimeMs from each note's actual visual position.
    // This guarantees timing matches exactly when the note crosses the target line,
    // eliminating the offset caused by stave padding (noteStartX vs measWidth).
    for (let i = 0; i < events.length; i++) {
      events[i].targetTimeMs = (events[i].xPx - originPx - targetX) / pxPerMs;
    }

    // Mark beats before the start as skipped (not checked for miss or MIDI match).
    // Only applies on the first pass — after any loop teleport, all beats in copy 0
    // represent a fresh loop iteration and must remain "pending".
    if (!hasLoopedRef.current && startEvtIdx > 0) {
      for (let i = 0; i < startEvtIdx; i++) {
        events[i].state = "skipped";
      }
    }

    // On resume: hide measures before firstPassStart in copy 0 for blank lead-in.
    // Each measure is wrapped in a <g class="sam-measure" id="measure-{copy}-{meas}">.
    if (startEvtIdx > 0) {
      const svg = scrollLayer.querySelector("svg");
      if (svg) {
        for (let m = 0; m < firstPassStart; m++) {
          const el = svg.getElementById(`measure-0-${m}`);
          if (el) el.style.visibility = "hidden";
        }
      }
    }

    let loopCount = 0;
    nextCheckRef.current = startEvtIdx;

    // Metronome scheduling state — aligned to the musical grid.
    // First tick = approachMs % msPerBeat (so ticks land on quarter-note boundaries).
    let nextMetroBeatIdx = 0;
    const metroStartMs = approachMs % msPerBeat;
    // Convert audio file timestamp (ms) → musical beat position using anchors.
    // With 0 anchors: virtual anchor at beat 0, audioMs 0 (BPM-based rate).
    // With 1 anchor: BPM-based rate from the single anchor point.
    // With 2+ anchors: piecewise-linear interpolation between anchors.
    function audioMsToBeatPos(audioMs) {
      const anchors = audioAnchors.length > 0 ? audioAnchors : [{ beatPos: 0, audioMs: 0 }];
      if (anchors.length === 1) {
        return anchors[0].beatPos + (audioMs - anchors[0].audioMs) / msPerBeat;
      }
      if (audioMs <= anchors[0].audioMs) {
        const segRate = (anchors[1].audioMs - anchors[0].audioMs) / (anchors[1].beatPos - anchors[0].beatPos);
        return anchors[0].beatPos + (audioMs - anchors[0].audioMs) / segRate;
      }
      for (let i = 0; i < anchors.length - 1; i++) {
        if (audioMs <= anchors[i + 1].audioMs || i === anchors.length - 2) {
          const segRate = (anchors[i + 1].audioMs - anchors[i].audioMs) / (anchors[i + 1].beatPos - anchors[i].beatPos);
          return anchors[i].beatPos + (audioMs - anchors[i].audioMs) / segRate;
        }
      }
      return 0;
    }

    scrollStateRef.current = {
      scrollStartT: performance.now(),
      originPx,
      pxPerMs,
      targetX,
      copyWidth,
      audioSyncOffset: null, // set on first frame where audio is playing
      lastAudioMs: null,     // tracks audioElement.currentTime across frames; gates audioSyncOffset commit
      audioEndMs,            // audio file timestamp where snippet's real measures end
      audioRestPaused: false, // true when audio paused for rest measures
      playbackRate: audioElement ? (audioElement.playbackRate || 1) : 1,
    };
    if (scrollStateExtRef) scrollStateExtRef.current = scrollStateRef.current;

    if (onScrollStart) onScrollStart(scrollStateRef.current.scrollStartT);
    if (onLoopCount) onLoopCount(0);

    function frame() {
      const state = scrollStateRef.current;
      if (!state) return;
      const now = performance.now();

      // Audio sync: derive elapsed from audioElement.currentTime via anchor interpolation.
      // audioMsToBeatPos maps audio timestamps to beat positions, then
      // beatPos * msPerBeat gives "content time" (BPM-based elapsed ms).
      // audioSyncOffset bridges wall-clock time and content time so that elapsed
      // is continuous when audio first starts (which may be delayed by SamPlayer).
      const rate = state.playbackRate || 1;
      let elapsed;
      if (audioElement && !audioElement.paused) {
        const audioMs = audioElement.currentTime * 1000;

        // HTMLMediaElement's `paused` flips synchronously on play(), but
        // `currentTime` only advances once the audio engine starts producing
        // samples (~20-100ms after play()). Locking audioSyncOffset using a
        // pre-advance currentTime value freezes elapsed for the spin-up window
        // — the visible "scroll stall" at the target-line crossing. Wait for
        // currentTime to actually move before committing the offset; until
        // then, fall through to wall-clock elapsed (same formula as lead-in).
        const audioAdvancing =
          state.lastAudioMs != null && audioMs > state.lastAudioMs;
        state.lastAudioMs = audioMs;

        if (state.audioSyncOffset === null && !audioAdvancing) {
          elapsed = (now - state.scrollStartT) * rate;
        } else {
          const contentElapsed = audioMsToBeatPos(audioMs) * msPerBeat;
          if (state.audioSyncOffset === null) {
            state.audioSyncOffset =
              (now - state.scrollStartT) * rate - contentElapsed;
          }
          elapsed = state.audioSyncOffset + contentElapsed;
          if (elapsed < 0) elapsed = 0;
        }

        // Pause audio when snippet's real measures end (rest measures follow)
        if (state.audioEndMs != null && audioMs >= state.audioEndMs) {
          audioElement.pause();
          state.audioRestPaused = true;
          state.restWallAnchor = now;
          state.restElapsedAnchor = elapsed;
        }
      } else if (audioElement && audioElement.paused && state.audioRestPaused) {
        // Rest measures: audio paused, continue scrolling via wall clock (scaled)
        elapsed = state.restElapsedAnchor + (now - state.restWallAnchor) * rate;
      } else if (audioElement && audioElement.paused && state.audioSyncOffset !== null) {
        // User paused — freeze at audio-derived position
        const audioMs = audioElement.currentTime * 1000;
        const contentElapsed = audioMsToBeatPos(audioMs) * msPerBeat;
        elapsed = state.audioSyncOffset + contentElapsed;
        if (elapsed < 0) elapsed = 0;
      } else if (audioElement) {
        // Audio exists but hasn't started yet — scale wall clock by playback rate
        // so approach speed matches the audio-synced scroll speed
        elapsed = (now - state.scrollStartT) * rate;
      } else {
        // No audio — use wall clock at full speed
        elapsed = now - state.scrollStartT;
      }

      state.elapsed = elapsed;

      // Check for seamless loop teleport BEFORE computing final offset.
      // Copy 1 starts at world x = 10 + copyWidth.
      // Screen position = worldX - scrollOffset.
      // When copy 1's start crosses the target line, jump BACK by copyWidth
      // so copy 0 (identical content, freshly reset) takes its place later.
      const rawScrollOffset = state.originPx + elapsed * state.pxPerMs;
      const copy1ScreenX = (10 + copyWidth) - rawScrollOffset;
      if (copy1ScreenX <= targetX) {
        // If loop is false, stop playback instead of looping
        if (!loop) {
          if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          if (onEnded) onEnded();
          return;
        }

        state.originPx -= copyWidth;
        loopCount++;
        hasLoopedRef.current = true;
        if (onLoopCount) onLoopCount(loopCount);

        // Audio loop: seek back to snippet start, preserve elapsed continuity.
        // audioAnchors[0] may be at beatPos > 0 when the snippet's first measure
        // lacks audioOffsetMs; subtract that offset so contentElapsed restarts at 0
        // relative to audioSyncOffset on the next frame.
        if (audioElement) {
          audioElement.currentTime = (audioAnchors[0]?.audioMs ?? 0) / 1000;
          const anchorBeatOffsetMs = (audioAnchors[0]?.beatPos ?? 0) * msPerBeat;
          state.audioSyncOffset = elapsed - anchorBeatOffsetMs;
          if (state.audioRestPaused) {
            state.audioRestPaused = false;
            audioElement.play();
          }
        }

        // Reset ALL copies: copy 0 = current pass, copy 1 = next, copy 2 = after that
        // (This code only runs when loop=true, so numCopies=3)
        const numCopiesForLoop = 3;
        const beatsPerCopy = beatEventsRef.current.length / numCopiesForLoop;
        const totalMusicalBeats = totalMusicalBeatsPerCopy;
        for (let c = 0; c < numCopiesForLoop; c++) {
          const passOffset = (loopCount + c) * totalMusicalBeats;
          for (let i = 0; i < beatsPerCopy; i++) {
            const evt = beatEventsRef.current[c * beatsPerCopy + i];
            if (evt) {
              evt.state = "pending";
              evt._logged = false;
              colorBeatEls(evt, "#000000");
              evt.musicalBeat = passOffset + evt.baseBeat;
              evt.targetTimeMs = (evt.xPx - state.originPx - targetX) / pxPerMs;
            }
          }
        }
        console.log('[Teleport] elapsed:', Math.round(elapsed),
          'anchor0:', audioAnchors[0]
            ? { beatPos: audioAnchors[0].beatPos, audioMs: audioAnchors[0].audioMs }
            : null,
          'audioSyncOffset:', Math.round(state.audioSyncOffset ?? NaN),
          'first 4 reset events:',
          beatEventsRef.current.slice(0, 4).map(e => ({
            meas: e.meas, beat: e.beat,
            state: e.state,
            musicalBeat: e.musicalBeat,
            targetTimeMs: Math.round(e.targetTimeMs)
          })));
        // Copy 0 is back at the target line after teleport — scan from its start
        nextCheckRef.current = 0;
        // Unhide any hidden measures from the first-pass resume
        const svg = scrollLayer.querySelector("svg");
        if (svg) {
          svg.querySelectorAll('g.sam-measure[style]').forEach(el => {
            el.style.visibility = "";
          });
        }
      }

      // Compute final scroll offset (may have been adjusted by teleport)
      const scrollOffset = state.originPx + elapsed * state.pxPerMs;
      scrollLayer.style.transform = `translateX(${-scrollOffset}px)`;

      // --- Metronome: schedule clicks via Web Audio lookahead ---
      if (metronome !== "off" && audioCtx) {
        const LOOKAHEAD_MS = 100;

        // Calculate subdivision interval based on metronome setting
        let subdivisionMs = msPerBeat; // Default to beat (quarter note)
        if (metronome === "halfbeat") {
          subdivisionMs = msPerBeat / 2; // Eighth note
        } else if (metronome === "quarterbeat") {
          subdivisionMs = msPerBeat / 4; // Sixteenth note
        }

        while (true) {
          const tickElapsedMs = metroStartMs + nextMetroBeatIdx * subdivisionMs;
          if (tickElapsedMs > elapsed + LOOKAHEAD_MS) break;
          if (tickElapsedMs >= elapsed) {
            const delayS = (tickElapsedMs - elapsed) / 1000;

            // Determine if this tick lands on a beat (for gain adjustment)
            const isOnBeat = metronome === "beat" ||
              (nextMetroBeatIdx % (msPerBeat / subdivisionMs) === 0);
            const gainValue = isOnBeat ? METRONOME_GAIN.onBeat : METRONOME_GAIN.offBeat;

            // delayS is in content-time; convert to wall-time for audioCtx scheduling
            playClick(audioCtx, audioCtx.currentTime + delayS / rate, gainValue);
          }
          nextMetroBeatIdx++;
        }
      }

      // --- Miss detection: forward-scan from nextCheck (time-based) ---
      const evts = beatEventsRef.current;
      let nc = nextCheckRef.current;

      while (nc < evts.length) {
        const evt = evts[nc];
        if (evt.state !== "pending") {
          nc++;
          continue;
        }
        // Skip rests — use hand-filtered midi when in LH/RH mode
        const missActiveMidi = handMode === "lh" ? evt.lhMidi : handMode === "rh" ? evt.rhMidi : evt.allMidi;
        if (missActiveMidi.length === 0) {
          evt.state = "skipped";
          nc++;
          continue;
        }
        if (elapsed > evt.targetTimeMs + timingWindowMs) {
          // Color only the active hand's SVG elements for misses
          const missEls = handMode === "lh" ? [evt.bassSvgEl].filter(Boolean)
                        : handMode === "rh" ? [evt.trebleSvgEl].filter(Boolean)
                        : evt.svgEls;
          console.log(
            `[MISS] m${evt.meas} beat=${evt.beat} midi=[${missActiveMidi}]`,
            `| targetTime=${Math.round(evt.targetTimeMs)}ms`,
            `| windowEnd=${Math.round(evt.targetTimeMs + timingWindowMs)}ms`,
            `| expired at=${Math.round(elapsed)}ms`,
            `| late by=${Math.round(elapsed - evt.targetTimeMs)}ms`
          );
          evt.state = "missed";
          colorBeatEls({ svgEls: missEls }, "#dc2626");
          if (onBeatMiss) onBeatMiss(evt);
          nc++;
        } else {
          break;
        }
      }
      nextCheckRef.current = nc;

      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [playbackState, svgReady, bpm, timingWindowMs, audioElement, firstPassStart]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      {/* Viewport — clips the scrolling SVG */}
      <div
        ref={viewportRef}
        onClick={onTap}
        className="relative overflow-hidden bg-white rounded-lg border border-border cursor-pointer"
        style={{ height: SCROLL_GEOMETRY.staffHeight + 4 }}
      >
        {/* Target zone (subtle blue tint) */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: 0,
            width: `${SCROLL_GEOMETRY.targetLinePct * 100}%`,
            backgroundColor: "rgba(37, 99, 235, 0.04)",
          }}
        />

        {/* Target line (blue, 2px) */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-10"
          style={{
            left: `${SCROLL_GEOMETRY.targetLinePct * 100}%`,
            width: 2,
            backgroundColor: "#2563eb",
          }}
        />

        {/* Scroll layer — translated by rAF */}
        <div ref={scrollLayerRef} style={{ willChange: "transform" }} />
      </div>
    </div>
  );
}
