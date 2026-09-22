import React, { useEffect, useRef, useState } from "react";
import { colorBeatEls, getMeasureWidth } from "../lib/vexflowHelpers";
import { getMeasDurationQ } from "../lib/measureUtils";
import { renderCopy, playClick } from "../lib/scoreRender";
import { buildNoteTimeline } from "../lib/noteTimeline";
import { playNote, midiToFreq, getMasterBus } from "../lib/synthVoice";
import { drawFingeringOverlay } from "../lib/fingeringOverlay";
import { SCROLL_GEOMETRY, METRONOME_GAIN, SCORE_SCALE } from "../lib/samConstants";
import { sweepUnplayedTail } from "../lib/passTail";
import { restStartIndex, contentEndTime } from "../lib/contentEnd";

// The teleport log, off the teleport frame (2026-09-19).
//
// The loop restart is the busiest frame in the run — the schedule is rebuilt,
// every copy recoloured, a pass banked — and the work lands as lateness on the
// first notes of the new pass. Formatting a log inside it was pure waste, so
// the numbers are copied out cheaply here and printed once the frame is done.
// A macrotask, not a microtask: a promise would still run before paint.
function logTeleportLater(elapsed, audioSyncOffset, anchor0, beatEvents) {
  const first4 = beatEvents.slice(0, 4).map((e) => ({
    meas: e.meas, beat: e.beat, state: e.state,
    musicalBeat: e.musicalBeat, targetTimeMs: Math.round(e.targetTimeMs),
  }));
  const anchor = anchor0 ? { beatPos: anchor0.beatPos, audioMs: anchor0.audioMs } : null;
  setTimeout(() => {
    console.log("[Teleport] elapsed:", Math.round(elapsed),
      "anchor0:", anchor,
      "audioSyncOffset:", Math.round(audioSyncOffset ?? NaN),
      "first 4 reset events:", first4);
  }, 0);
}


export default function ScrollEngine({ measures, bpm, playbackState, onBeatEvents, onLoopCount, onBeatMiss, onContentEnd, restMeasureCount = 0, scrollStateExtRef, onTap, measureWidth, metronome = "off", audioCtx = null, firstPassStart = 0, loop = true, onEnded, timingWindowMs = 300, audioElement = null, audioAnchors = [], audioEndMs = null, handMode = "both", onScrollStart = null, fingerings = {}, scorePlayback = "off" }) {
  const viewportRef = useRef(null);
  const scrollLayerRef = useRef(null);
  const rafRef = useRef(null);
  const scrollStateRef = useRef(null);
  const beatEventsRef = useRef([]);
  const copyWidthRef = useRef(0);
  const nextCheckRef = useRef(0);
  const hasLoopedRef = useRef(false);
  // One "the music is over" signal per pass — see restStartIdx below.
  const contentEndFiredRef = useRef(false);
  const geometryRef = useRef([]);
  const labelElsRef = useRef([]);
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
    const allGeometry = [];
    const allLabelEls = [];
    for (let c = 0; c < numCopies; c++) {
      const xStart = 10 + c * singleCopyWidth;
      const { beatMeta, geometry, labelEls } = renderCopy(VF, ctx, measures, c, xStart, measureWidth, measDurations, measStartBeats);
      copyBeatCounts.push(beatMeta.length);
      allBeatMeta.push(...beatMeta);
      allGeometry.push(...geometry);
      allLabelEls.push(...labelEls);
    }
    // Store for the fingering-overlay effect (drawn per copy so badges/rings
    // ride along as each copy scrolls through the target line).
    geometryRef.current = allGeometry;
    labelElsRef.current = allLabelEls;

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
        // Copy-relative score position (full-playback spec D2). Unlike
        // musicalBeat, this is never rewritten by the loop teleport, so it
        // stays a valid join key for the note timeline on every pass.
        beatPos: meta.beatPos,
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

  // Fingering overlay (spec §5 / Step 3). Drawn as a separate SVG layer inside
  // the scroll layer, so it scrolls with the notes and is immune to the note
  // recoloring the animation loop performs (the ring never flickers). Runs after
  // each SVG rebuild (svgReady) and whenever the resolved fingerings change.
  useEffect(() => {
    if (!svgReady) return;
    const svg = scrollLayerRef.current?.querySelector("svg");
    if (!svg) return;
    drawFingeringOverlay(svg, geometryRef.current, fingerings || {}, { collisionEls: labelElsRef.current });
  }, [fingerings, svgReady]);

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
    contentEndFiredRef.current = false;

    // WHERE THE MUSIC ENDS AND THE RESTING BEGINS (2026-09-20).
    //
    // A looped snippet with rest measures used to bank its pass only at the
    // teleport, a whole bar after the last note — so the pass counter and the
    // plan line sat still while he was already resting. `restStartIdx` is the
    // index, within one copy, of the first beat of the first appended rest
    // bar; crossing it is the moment the playthrough is musically over.
    //
    // Null when nothing was appended, and the credit stays at the teleport.
    const restStartIdx = loop
      ? restStartIndex(events, measures, restMeasureCount, events.length / numCopies)
      : null;

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

    // Score-playback mode, captured once for this run (spec D5). NOT a dep of
    // this effect — adding it would restart playback from the top on toggle,
    // and StatsBar is unmounted while playing so it cannot change mid-run
    // anyway. Same capture treatment as audioCtx.
    //
    // "lh" / "rh" supersede spec D7 ("v1 ignores handMode") at the user's
    // request. This is deliberately INDEPENDENT of the snippet's handMode:
    // that one selects which hand the player is scored on, this one selects
    // which hand the synth sounds. Keeping them separate is what makes the
    // useful combination possible — practise RH against a synth LH.
    const SCORE_MODES = ["full", "lh", "rh"];
    const scoreMode = SCORE_MODES.includes(scorePlayback) ? scorePlayback : "off";
    const scoreOn = scoreMode !== "off";
    // "full" means both hands; otherwise the mode names the hand to sound.
    const handSounds = (hand) => scoreMode === "full" || scoreMode === hand;

    // --- Full playback: resolve the note timeline against the beat events ---
    // Spec D2: onsets are NEVER computed from msPerBeat. Each note's onset is
    // the targetTimeMs of the beat event sharing its beat position, so the
    // synth is pinned to the same geometry the scroll uses and cannot drift.
    // Only durations are new information.
    let schedule = [];
    let nextNoteIdx = 0;
    let pendingNotes = [];

    // The tick map rounds within-measure onsets to 3dp (scoreRender.js
    // `Math.round(tick * 1000) / 1000`), so beatPos carries that rounding while
    // the timeline's onsetBeats does not. Join on the SAME rounding — exact
    // equality misses every triplet onset by ~3.3e-5 (966 notes across the
    // fixture corpus: all of Moonlight, Für Elise, Someone Like You).
    const joinKey = (b) => Math.round(b * 1000) / 1000;

    const timeline = scoreOn ? buildNoteTimeline(measures) : null;

    // Hand filter applied once here rather than inside rebuildSchedule: the
    // schedule is rebuilt on every loop teleport, and re-filtering the same
    // notes three times per wrap is wasted work. Every timeline note already
    // carries `hand`, so this is the whole of the LH/RH implementation —
    // onsets, durations and tie resolution are hand-agnostic and unchanged.
    const soundingNotes = timeline
      ? timeline.notes.filter((n) => handSounds(n.hand))
      : [];

    // Rebuilt rather than shifted at each loop teleport: the teleport
    // recomputes every event's targetTimeMs, and re-reading those values is
    // what guarantees the schedule can never drift away from the beat events
    // it was derived from.
    function rebuildSchedule() {
      if (!timeline) return;
      const beatsPerCopyLocal = events.length / numCopies;
      const out = [];
      // Every copy is joined separately: beatPos is copy-RELATIVE and therefore
      // identical across copies, but each copy's targetTimeMs is a different
      // pass. One shared map would collide and collapse all three onto copy 0.
      for (let c = 0; c < numCopies; c++) {
        const byBeatPos = new Map();
        for (let i = 0; i < beatsPerCopyLocal; i++) {
          const evt = events[c * beatsPerCopyLocal + i];
          if (!evt) continue;
          const k = joinKey(evt.beatPos);
          if (!byBeatPos.has(k)) byBeatPos.set(k, evt);
        }
        for (const n of soundingNotes) {
          const evt = byBeatPos.get(joinKey(n.onsetBeats));
          if (!evt) continue; // unmatched onsets are reported below, not played
          out.push({
            onsetMs: evt.targetTimeMs,
            durationMs: n.durationBeats * msPerBeat,
            midi: n.midi,
            hand: n.hand,
            meas: evt.meas,
          });
        }
      }
      out.sort((a, b) => a.onsetMs - b.onsetMs);
      schedule = out;
      nextNoteIdx = 0;
    }

    // Fade-then-stop rather than a bare stop(0): cutting a ringing oscillator
    // dead puts a step discontinuity through the bus and clicks audibly. 15ms
    // is inaudible as a fade and far inside the "silent within ~100ms" budget.
    const STOP_FADE_S = 0.015;
    function stopPendingNotes() {
      if (!pendingNotes.length) return;
      const now = audioCtx ? audioCtx.currentTime : 0;
      for (const n of pendingNotes) {
        try {
          const g = n.gain.gain;
          if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(now);
          else {
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
          }
          g.linearRampToValueAtTime(0, now + STOP_FADE_S);
          // A note still inside the lookahead has not started yet; stopping
          // before its start time means it never sounds at all, which is what
          // we want on a pause.
          n.osc.stop(now + STOP_FADE_S + 0.005);
        } catch {
          // already stopped or the context went away — nothing to unwind
        }
      }
      pendingNotes = [];
    }

    if (scoreOn) {
      rebuildSchedule();

      // Each copy contributes the same set of matched notes, so the per-copy
      // count against the SOUNDING note count is the unmatched tally. Compared
      // against soundingNotes, not timeline.notes — otherwise every hand-
      // filtered run would report the other hand as unmatched.
      const perCopy = schedule.length / numCopies;
      console.log("[ScorePlayback] scheduled", {
        mode: scoreMode,
        timelineNotes: timeline.notes.length,
        soundingNotes: soundingNotes.length,
        scheduledPerCopy: perCopy,
        copies: numCopies,
        unmatchedOnsets: soundingNotes.length - perCopy,
        firstOnsetMs: schedule.length ? Math.round(schedule[0].onsetMs) : null,
        lastOnsetMs: schedule.length ? Math.round(schedule[schedule.length - 1].onsetMs) : null,
        warnings: timeline.warnings,
      });
      if (soundingNotes.length !== perCopy) {
        console.warn(
          "[ScorePlayback] some onsets did not join to a beat event and will not sound:",
          soundingNotes.length - perCopy
        );
      }
      window.samNoteTimeline = timeline.notes;
      window.samSchedule = schedule;
    }

    // Console handle for interactive checks. Installed regardless of mode: it
    // needs only the AudioContext, which exists by now because the transport
    // handlers call ensureAudioContext() before flipping to "playing".
    if (audioCtx) {
      window.samSynth = {
        audioCtx,
        playNote,
        midiToFreq,
        masterBus: getMasterBus(audioCtx),
        /** One note, now. `samSynth.note(60)` → middle C for 1s. */
        note: (midi, durationS = 1, velocity = 1) =>
          playNote(audioCtx, audioCtx.currentTime + 0.05, midi, durationS, velocity),
        /** Simultaneous stack. `samSynth.chord([60,64,67,72])`. */
        chord: (midis, durationS = 1, velocity = 1) => {
          const at = audioCtx.currentTime + 0.05;
          return midis.map((m) => playNote(audioCtx, at, m, durationS, velocity));
        },
      };
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

    // Where the score sits when the run is frozen. `frozenAtMs` is a content
    // time, so this is the ordinary scroll formula with `elapsed` pinned.
    function applyFrozenTransform(state) {
      scrollLayer.style.transform =
        `translateX(${-(state.originPx + state.frozenAtMs * state.pxPerMs)}px)`;
    }

    function frame() {
      const state = scrollStateRef.current;
      if (!state) return;
      const now = performance.now();

      // --- PRACTICE FREEZE (2026-09-22) ---------------------------------
      //
      // Practice mode stops the scroll the moment the grader marks a note
      // incorrect. SamPlayer sets `state.frozenAtMs` from inside the grader to
      // the stuck beat's own `targetTimeMs`, and that one number does both
      // jobs the spec asks for: it puts the beat EXACTLY on the play line —
      // pulling the score back for a missed note, whose window only expired
      // after the scroll had already gone past it — and it is the time the run
      // will resume from, because with backing audio off `elapsed` is a pure
      // function of `scrollStartT`.
      //
      // Everything that would advance the run is skipped: the loop teleport,
      // the metronome, the synth, the miss scanner and the end-of-range
      // credit. The transform is still written every frame so the score holds
      // its position against anything else that might touch it, and the rAF
      // keeps running so step 4's resume is seen on the very next frame.
      //
      // `elapsed` is still published, because Pause reads it to work out which
      // measure to come back to.
      if (state.frozenAtMs != null) {
        state.elapsed = state.frozenAtMs;
        state.elapsedAtMs = now;
        applyFrozenTransform(state);
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

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
      // The wall-clock instant this frame's `elapsed` was computed. The matcher
      // adds the time since, so a keystroke is timed to when it ARRIVED rather
      // than to the last frame boundary — see elapsedAt() in noteMatching.js.
      state.elapsedAtMs = now;

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

        // THE TAIL OF THE OUTGOING PASS, BEFORE ANYTHING ELSE (2026-09-19).
        //
        // The reset further down puts every beat back to "pending" with a
        // fresh targetTimeMs. A beat of the pass that just ended which was
        // never played, and whose grace window had not yet expired, was
        // therefore recycled WITHOUT ever being recorded — the last note of a
        // pass could escape the miss count entirely. The scanner runs later in
        // this same frame, by which time the evidence is gone.
        //
        // So sweep copy 0 — the pass that just finished — first. Anything
        // still pending there will never be played: the pass is over.
        //
        // This runs BEFORE onLoopCount for the same reason creditPass does:
        // onLoopCount banks the pass row and rotates the per-playthrough
        // counters, so a miss raised after it would be credited to the pass
        // that has not started yet.
        sweepUnplayedTail(beatEventsRef.current, beatEventsRef.current.length / 3, handMode, onBeatMiss);

        // With no rest bars the teleport IS the end of the music, so the pass
        // is banked here exactly as it always was. With rest bars it was
        // already banked when the music stopped, a bar ago.
        //
        // Before onLoopCount either way: that rotates the per-playthrough
        // counters, and the pass row needs the ones belonging to the
        // playthrough that just finished.
        if (restStartIdx == null && onContentEnd) onContentEnd(loopCount);
        contentEndFiredRef.current = false;

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
        // The teleport log used to live here, mapping over every event object
        // inside the frame. It is deferred to a macrotask now (2026-09-19):
        // this frame is the busiest in the run, and the work it does shows up
        // as lateness on the first notes of the new pass. Values are captured
        // cheaply; the formatting happens after the frame is over.
        logTeleportLater(elapsed, state.audioSyncOffset, audioAnchors[0], beatEventsRef.current);
        // Copy 0 is back at the target line after teleport — scan from its start
        nextCheckRef.current = 0;

        // Mirror that reset for the note schedule. Unlike nextMetroBeatIdx —
        // which is deliberately NOT reset, because its grid is a function of
        // continuous `elapsed` — the note cursor indexes score content, which
        // has just wrapped. Every targetTimeMs was recomputed above, so the
        // schedule is rebuilt from the new values and the cursor returns to 0.
        // Pending notes are stopped first: a whole note from the tail of the
        // outgoing pass would otherwise ring across the loop point.
        if (scoreOn) {
          stopPendingNotes();
          rebuildSchedule();
        }
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

      // --- Score playback: schedule notes via the same lookahead ------------
      // Structurally identical to the metronome above: compare in content-time,
      // convert to wall-time at the audioCtx boundary with `/ rate`. The only
      // difference is that the tick grid is replaced by the onset-sorted
      // schedule, so a single monotonic cursor walks it (spec D3).
      // The hand filter is already baked into `schedule` — nothing to do here.
      if (scoreOn && audioCtx) {
        const LOOKAHEAD_MS = 100;

        while (nextNoteIdx < schedule.length) {
          const n = schedule[nextNoteIdx];
          if (n.onsetMs > elapsed + LOOKAHEAD_MS) break;
          if (n.onsetMs >= elapsed) {
            const delayS = (n.onsetMs - elapsed) / 1000;
            // BOTH the delay and the duration take the `/ rate` divisor. Without
            // it on the duration, held notes run long at reduced speed and the
            // piece turns into a smear instead of stretching.
            const nodes = playNote(
              audioCtx,
              audioCtx.currentTime + delayS / rate,
              n.midi,
              n.durationMs / 1000 / rate
            );
            if (nodes) {
              pendingNotes.push({
                osc: nodes.osc,
                gain: nodes.gain,
                endMs: n.onsetMs + n.durationMs,
              });
            }
          }
          nextNoteIdx++;
        }

        // Drop finished notes so a long piece doesn't accumulate thousands of
        // entries. endMs is content-time, the same clock `elapsed` is on.
        if (pendingNotes.length) {
          pendingNotes = pendingNotes.filter((p) => p.endMs > elapsed);
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
          // A practice stop is raised from inside that callback, and it freezes
          // the run at THIS beat. Anything further down the scan belongs to
          // time the run is no longer at — at a fast tempo, or after a long
          // frame, two windows can expire together and the second would
          // otherwise be marked missed for a bar the player never reached.
          if (state.frozenAtMs != null) break;
        } else {
          break;
        }
      }
      nextCheckRef.current = nc;

      // Frozen during this frame's scan: snap to the stuck beat now rather
      // than a frame later, and skip the end-of-range credit below — the run
      // has stopped, and nothing about it is finished.
      if (state.frozenAtMs != null) {
        applyFrozenTransform(state);
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      // --- The music is over: bank the pass now, not a bar later -------------
      //
      // AFTER miss detection on purpose. The scanner has just resolved
      // everything due this frame, so by the time this fires the outgoing
      // pass's counters are final and the row written here is identical to
      // the one the teleport used to write.
      //
      // The trigger is the LATER of two instants: the first rest beat's own
      // target, and the last musical beat's target plus the matching window.
      // The second matters when the final note is short — at a fast tempo its
      // grace can outlast the barline, and crediting before it expired could
      // miss a hit that was still allowed to arrive.
      if (restStartIdx != null && !contentEndFiredRef.current) {
        const creditAt = contentEndTime(evts, restStartIdx, timingWindowMs);
        if (creditAt != null && elapsed >= creditAt) {
          contentEndFiredRef.current = true;
          if (onContentEnd) onContentEnd(loopCount + 1);
        }
      }

      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Cancelling the rAF stops SCHEDULING, but notes already handed to the
      // audio clock keep sounding on their own — a whole note scheduled 2s out
      // would ring straight through a pause. The metronome needed no such
      // teardown because a 40ms click cannot outlive the gesture that made it.
      stopPendingNotes();
    };
    // restMeasureCount is here because it decides where the music ends, and
    // so where a pass is credited; it changes only when the loaded range does.
  }, [playbackState, svgReady, bpm, timingWindowMs, audioElement, firstPassStart, restMeasureCount]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      {/* Viewport — clips the scrolling SVG */}
      <div
        ref={viewportRef}
        onClick={onTap}
        className="relative overflow-hidden bg-white rounded-lg border border-border cursor-pointer"
        style={{ height: SCROLL_GEOMETRY.staffHeight * SCORE_SCALE + 4 }}
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
