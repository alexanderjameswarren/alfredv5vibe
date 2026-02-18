import React, { useEffect, useRef, useState } from "react";
import { noteToVexKey, noteAccidental, getBeamGroups, colorBeatEls, getMeasureWidth, getFormatWidth } from "../lib/vexflowHelpers";

const TARGET_LINE_PCT = 0.15; // 15% from left edge
const STAFF_H = 310;
const NUM_COPIES = 3;

// Duration → quarter-note beat values (for voice format tick tracking)
const DURATION_BEATS = {
  w: 4, hd: 3, h: 2, qd: 1.5, q: 1, "8d": 0.75, "8": 0.5, "16": 0.25, "32": 0.125,
};

// Pad a voice event array with rests so durations sum to 4 beats (4/4 time)
function padVoice(events) {
  let total = 0;
  for (const evt of events) total += DURATION_BEATS[evt.duration] || 1;
  const result = [...events];
  let remaining = 4 - total;
  const restDurs = ["w", "h", "q", "8", "16"];
  const restVals = [4, 2, 1, 0.5, 0.25];
  while (remaining > 0.001) {
    for (let j = 0; j < restDurs.length; j++) {
      if (remaining >= restVals[j] - 0.001) {
        result.push({ duration: restDurs[j], notes: [] });
        remaining -= restVals[j];
        break;
      }
    }
  }
  return result;
}

// Renders a single copy of the score into the given VexFlow context.
// Returns { beatMeta[], copyWidth } for that copy.
function renderCopy(VF, ctx, measures, copyIdx, xStart, measureWidth) {
  const TREBLE_Y = 40;
  const BASS_Y = 170;

  const measureWidths = measures.map(() => getMeasureWidth(null, false, measureWidth));
  const copyWidth = measureWidths.reduce((a, b) => a + b, 0);

  const beatMeta = [];
  let beatMetaOffset = 0;
  let xOffset = xStart;

  // Track notes with tie properties across all measures (for cross-barline ties)
  const tieTracker = { treble: [], bass: [] };

  measures.forEach((measure, measIdx) => {
    const measWidth = measureWidths[measIdx];

    // Snapshot SVG child count before drawing this measure
    const svgEl = ctx.svg;
    const childCountBefore = svgEl.childElementCount;

    const treble = new VF.Stave(xOffset, TREBLE_Y, measWidth);
    const bass = new VF.Stave(xOffset, BASS_Y, measWidth);

    treble.setContext(ctx).draw();
    bass.setContext(ctx).draw();

    new VF.StaveConnector(treble, bass)
      .setType(VF.StaveConnector.type.SINGLE_LEFT)
      .setContext(ctx)
      .draw();

    // Build VexFlow notes and beat metadata
    const trebleNotes = [];
    const bassNotes = [];
    let trebleIdxMap = null; // null = 1:1 mapping (legacy)
    let bassIdxMap = null;
    let measBeatCount = 0;
    let trebleTicks = [];
    let bassTicks = [];

    if (measure.rh || measure.lh) {
      // === Voice format: independent RH/LH voices ===
      const rhEvents = padVoice(measure.rh || []);
      const lhEvents = padVoice(measure.lh || []);

      // Build treble StaveNotes from RH voice events
      for (const evt of rhEvents) {
        const notes = evt.notes || [];
        if (notes.length > 0) {
          const keys = notes.map((n) => noteToVexKey(n));
          const sn = new VF.StaveNote({ clef: "treble", keys, duration: evt.duration });
          notes.forEach((n, ki) => {
            const acc = noteAccidental(n);
            if (acc) sn.addModifier(new VF.Accidental(acc), ki);
          });
          trebleNotes.push(sn);
          // Track tie info for cross-barline tie rendering
          const starts = [];
          const ends = [];
          notes.forEach((n, ki) => {
            if (n.tie === "start" || n.tie === "both") starts.push({ keyIdx: ki, midi: n.midi });
            if (n.tie === "end" || n.tie === "both") ends.push({ keyIdx: ki, midi: n.midi });
          });
          if (starts.length > 0 || ends.length > 0) {
            tieTracker.treble.push({ vexNote: sn, starts, ends });
          }
        } else {
          trebleNotes.push(new VF.StaveNote({
            clef: "treble", keys: ["b/4"], duration: evt.duration + "r",
          }));
        }
      }

      // Build bass StaveNotes from LH voice events
      for (const evt of lhEvents) {
        const notes = evt.notes || [];
        if (notes.length > 0) {
          const keys = notes.map((n) => noteToVexKey(n));
          const sn = new VF.StaveNote({ clef: "bass", keys, duration: evt.duration });
          notes.forEach((n, ki) => {
            const acc = noteAccidental(n);
            if (acc) sn.addModifier(new VF.Accidental(acc), ki);
          });
          bassNotes.push(sn);
          // Track tie info for cross-barline tie rendering
          const starts = [];
          const ends = [];
          notes.forEach((n, ki) => {
            if (n.tie === "start" || n.tie === "both") starts.push({ keyIdx: ki, midi: n.midi });
            if (n.tie === "end" || n.tie === "both") ends.push({ keyIdx: ki, midi: n.midi });
          });
          if (starts.length > 0 || ends.length > 0) {
            tieTracker.bass.push({ vexNote: sn, starts, ends });
          }
        } else {
          bassNotes.push(new VF.StaveNote({
            clef: "bass", keys: ["d/3"], duration: evt.duration + "r",
          }));
        }
      }

      // Interleave both hands by tick position for beat metadata
      const tickMap = new Map();
      trebleIdxMap = [];
      bassIdxMap = [];

      let tick = 0;
      rhEvents.forEach((evt, i) => {
        const rt = Math.round(tick * 1000) / 1000;
        if (!tickMap.has(rt)) tickMap.set(rt, { allMidi: [], trebleIdx: null, bassIdx: null });
        const entry = tickMap.get(rt);
        entry.trebleIdx = i;
        const notes = evt.notes || [];
        const allTieEnd = notes.length > 0 && notes.every((n) => n.tie === "end");
        if (!allTieEnd) notes.forEach((n) => entry.allMidi.push(n.midi));
        tick += DURATION_BEATS[evt.duration] || 1;
      });

      tick = 0;
      lhEvents.forEach((evt, i) => {
        const rt = Math.round(tick * 1000) / 1000;
        if (!tickMap.has(rt)) tickMap.set(rt, { allMidi: [], trebleIdx: null, bassIdx: null });
        const entry = tickMap.get(rt);
        entry.bassIdx = i;
        const notes = evt.notes || [];
        const allTieEnd = notes.length > 0 && notes.every((n) => n.tie === "end");
        if (!allTieEnd) notes.forEach((n) => entry.allMidi.push(n.midi));
        tick += DURATION_BEATS[evt.duration] || 1;
      });

      const sortedTicks = [...tickMap.keys()].sort((a, b) => a - b);
      sortedTicks.forEach((t, localIdx) => {
        const entry = tickMap.get(t);
        if (entry.trebleIdx !== null) trebleIdxMap[entry.trebleIdx] = localIdx;
        if (entry.bassIdx !== null) bassIdxMap[entry.bassIdx] = localIdx;

        beatMeta.push({
          meas: measure.number,
          beat: t + 1,
          musicalBeatInCopy: measIdx * 4 + t,
          allMidi: entry.allMidi.sort((a, b) => a - b),
          trebleNote: entry.trebleIdx !== null ? trebleNotes[entry.trebleIdx] : null,
          bassNote: entry.bassIdx !== null ? bassNotes[entry.bassIdx] : null,
          trebleSvgEl: null,
          bassSvgEl: null,
        });
      });

      measBeatCount = sortedTicks.length;

      // Tick onset positions for time-proportional repositioning
      let tt = 0;
      for (const evt of rhEvents) { trebleTicks.push(tt); tt += DURATION_BEATS[evt.duration] || 1; }
      tt = 0;
      for (const evt of lhEvents) { bassTicks.push(tt); tt += DURATION_BEATS[evt.duration] || 1; }
    } else {
      // === Legacy beats format ===
      measure.beats.forEach((beat) => {
        const rhNotes = (beat.rh || []).filter((n) => n.midi >= 60);
        const lhNotes = (beat.lh || []).filter((n) => n.midi < 60);
        const rhBassNotes = (beat.rh || []).filter((n) => n.midi < 60);
        const lhTrebleNotes = (beat.lh || []).filter((n) => n.midi >= 60);

        const trebleGroup = [...rhNotes, ...lhTrebleNotes];
        const bassGroup = [...lhNotes, ...rhBassNotes];

        const allMidi = [
          ...trebleGroup.map((n) => n.midi),
          ...bassGroup.map((n) => n.midi),
        ].sort((a, b) => a - b);

        let trebleNote;
        if (trebleGroup.length > 0) {
          const keys = trebleGroup.map((n) => noteToVexKey(n));
          trebleNote = new VF.StaveNote({ clef: "treble", keys, duration: beat.duration || "q" });
          trebleGroup.forEach((n, ki) => {
            const acc = noteAccidental(n);
            if (acc) trebleNote.addModifier(new VF.Accidental(acc), ki);
          });
        } else {
          trebleNote = new VF.StaveNote({ clef: "treble", keys: ["b/4"], duration: (beat.duration || "q") + "r" });
        }
        trebleNotes.push(trebleNote);

        let bassNote;
        if (bassGroup.length > 0) {
          const keys = bassGroup.map((n) => noteToVexKey(n));
          bassNote = new VF.StaveNote({ clef: "bass", keys, duration: beat.duration || "q" });
          bassGroup.forEach((n, ki) => {
            const acc = noteAccidental(n);
            if (acc) bassNote.addModifier(new VF.Accidental(acc), ki);
          });
        } else {
          bassNote = new VF.StaveNote({ clef: "bass", keys: ["d/3"], duration: (beat.duration || "q") + "r" });
        }
        bassNotes.push(bassNote);

        beatMeta.push({
          meas: measure.number,
          beat: beat.beat,
          musicalBeatInCopy: measIdx * 4 + (beat.beat - 1),
          allMidi,
          trebleNote,
          bassNote,
          trebleSvgEl: null,
          bassSvgEl: null,
        });
      });

      measBeatCount = measure.beats.length;
      trebleTicks = measure.beats.map(b => b.beat - 1);
      bassTicks = trebleTicks;
    }

    // 1. Set staves before formatting so VexFlow can compute note head
    //    dimensions during preFormat (required for accidental positioning)
    trebleNotes.forEach((note) => note.setStave(treble));
    bassNotes.forEach((note) => note.setStave(bass));

    // 2. Create voices and add tickables
    const trebleVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
      .setStrict(false)
      .addTickables(trebleNotes);
    const bassVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
      .setStrict(false)
      .addTickables(bassNotes);

    // 3. Create beams (after addTickables, before draw — suppresses flags)
    const trebleBeams = getBeamGroups(trebleNotes).map((g) => new VF.Beam(g));
    const bassBeams = getBeamGroups(bassNotes).map((g) => new VF.Beam(g));

    // 4. Format — align rhythmic positions across both staves
    new VF.Formatter()
      .joinVoices([trebleVoice])
      .joinVoices([bassVoice])
      .format([trebleVoice, bassVoice], getFormatWidth(measWidth, false));

    // 4.5. Reposition notes to time-proportional X (constant scroll speed = constant time spacing)
    const noteStartX = treble.getNoteStartX();
    const usableWidth = treble.getNoteEndX() - noteStartX;
    const ACC_W = { '#': 11, 'b': 9, 'n': 8, '##': 14, 'bb': 14 };
    const accPad = (note) => {
      let w = 0;
      for (const mod of note.getModifiers()) {
        if (mod.type in ACC_W) w = Math.max(w, ACC_W[mod.type]);
      }
      return w > 0 ? w + 3 : 0;
    };
    trebleNotes.forEach((note, i) => {
      note.setStave(treble);
      let correctX = noteStartX + (trebleTicks[i] / 4) * usableWidth;
      if (trebleTicks[i] === 0) correctX += accPad(note);
      note.setXShift(correctX - note.getAbsoluteX());
    });
    bassNotes.forEach((note, i) => {
      note.setStave(bass);
      let correctX = noteStartX + (bassTicks[i] / 4) * usableWidth;
      if (bassTicks[i] === 0) correctX += accPad(note);
      note.setXShift(correctX - note.getAbsoluteX());
    });

    // 4.6. Patch getModifierStartXY to include note's time-proportional x_shift.
    // VexFlow's default returns getAbsoluteX() (formatter position) without x_shift,
    // so accidentals would render at the pre-repositioned X instead of next to the notehead.
    const patchModXY = (note) => {
      const _orig = note.getModifierStartXY;
      note.getModifierStartXY = function(pos, idx, opts) {
        const pt = _orig.call(this, pos, idx, opts);
        pt.x += this.getXShift();
        return pt;
      };
    };
    trebleNotes.forEach(patchModXY);
    bassNotes.forEach(patchModXY);

    // 5. Draw treble notes individually, each wrapped in SVG <g> group
    trebleNotes.forEach((note, i) => {
      const groupEl = ctx.openGroup("sam-note", `t-${copyIdx}-${measIdx}-${i}`);
      note.setStave(treble);
      note.setContext(ctx);
      note.draw();
      ctx.closeGroup();
      const bmIdx = trebleIdxMap !== null ? trebleIdxMap[i] : i;
      if (bmIdx !== undefined && beatMeta[beatMetaOffset + bmIdx]) {
        beatMeta[beatMetaOffset + bmIdx].trebleSvgEl = groupEl;
      }
    });

    // Draw bass notes individually
    bassNotes.forEach((note, i) => {
      const groupEl = ctx.openGroup("sam-note", `b-${copyIdx}-${measIdx}-${i}`);
      note.setStave(bass);
      note.setContext(ctx);
      note.draw();
      ctx.closeGroup();
      const bmIdx = bassIdxMap !== null ? bassIdxMap[i] : i;
      if (bmIdx !== undefined && beatMeta[beatMetaOffset + bmIdx]) {
        beatMeta[beatMetaOffset + bmIdx].bassSvgEl = groupEl;
      }
    });

    // 6. Draw beams after notes
    trebleBeams.forEach((b) => b.setContext(ctx).draw());
    bassBeams.forEach((b) => b.setContext(ctx).draw());

    // Wrap all SVG elements added during this measure into a single <g> group.
    // VexFlow appends stave lines directly to the SVG root, so ctx.openGroup
    // doesn't capture them. This manual approach grabs everything.
    const measGroupEl = document.createElementNS("http://www.w3.org/2000/svg", "g");
    measGroupEl.setAttribute("class", "sam-measure");
    measGroupEl.setAttribute("id", `measure-${copyIdx}-${measIdx}`);
    while (svgEl.childElementCount > childCountBefore) {
      measGroupEl.appendChild(svgEl.children[childCountBefore]);
    }
    svgEl.appendChild(measGroupEl);

    // Measure number above treble staff
    const measNumEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    measNumEl.setAttribute("x", xOffset + 5);
    measNumEl.setAttribute("y", TREBLE_Y - 2);
    measNumEl.setAttribute("font-size", "10");
    measNumEl.setAttribute("font-family", "monospace");
    measNumEl.setAttribute("fill", "#999");
    measNumEl.textContent = measure.number;
    measGroupEl.appendChild(measNumEl);

    // Chord label underneath measure number
    if (measure.chord) {
      const chordEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      chordEl.setAttribute("x", xOffset + 5);
      chordEl.setAttribute("y", TREBLE_Y + 18);
      chordEl.setAttribute("font-size", "20");
      chordEl.setAttribute("font-family", "serif");
      chordEl.setAttribute("fill", "#333");
      chordEl.textContent = measure.chord;
      measGroupEl.appendChild(chordEl);
    }

    beatMetaOffset += measBeatCount;
    xOffset += measWidth;
  });

  // Draw ties between consecutive notes with matching tie:start → tie:end
  function drawStaveTies(tieInfos) {
    for (let i = 0; i < tieInfos.length - 1; i++) {
      const first = tieInfos[i];
      const second = tieInfos[i + 1];
      if (first.starts.length === 0 || second.ends.length === 0) continue;

      const firstIndices = [];
      const lastIndices = [];
      for (const s of first.starts) {
        for (const e of second.ends) {
          if (s.midi === e.midi) {
            firstIndices.push(s.keyIdx);
            lastIndices.push(e.keyIdx);
          }
        }
      }

      if (firstIndices.length > 0) {
        new VF.StaveTie({
          first_note: first.vexNote,
          last_note: second.vexNote,
          first_indices: firstIndices,
          last_indices: lastIndices,
        }).setContext(ctx).draw();
      }
    }
  }
  drawStaveTies(tieTracker.treble);
  drawStaveTies(tieTracker.bass);

  return { beatMeta, copyWidth };
}

const GRACE_MS = 150; // ms after target time before marking a beat as missed

// Play a short click sound at the given audioContext time
function playClick(audioCtx, when) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = 800;
  gain.gain.setValueAtTime(0.3, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(when);
  osc.stop(when + 0.04);
}

export default function ScrollEngine({ measures, bpm, playbackState, onBeatEvents, onLoopCount, onBeatMiss, scrollStateExtRef, onTap, measureWidth, metronomeEnabled = false, audioCtx = null, firstPassStart = 0 }) {
  const viewportRef = useRef(null);
  const scrollLayerRef = useRef(null);
  const rafRef = useRef(null);
  const scrollStateRef = useRef(null);
  const beatEventsRef = useRef([]);
  const copyWidthRef = useRef(0);
  const nextCheckRef = useRef(0);
  const [svgReady, setSvgReady] = useState(false);

  // Render 3 copies of the score SVG into the scroll layer
  useEffect(() => {
    if (!measures || measures.length === 0) return;

    const VF = window.Vex?.Flow;
    if (!VF) return;

    const scrollLayer = scrollLayerRef.current;
    scrollLayer.innerHTML = "";

    // Calculate single copy width — all measures uniform, no clef/time sig
    const singleMeasureWidths = measures.map(() => getMeasureWidth(null, false, measureWidth));
    const singleCopyWidth = singleMeasureWidths.reduce((a, b) => a + b, 0);
    const totalWidth = singleCopyWidth * NUM_COPIES + 20;

    copyWidthRef.current = singleCopyWidth;

    const renderer = new VF.Renderer(scrollLayer, VF.Renderer.Backends.SVG);
    renderer.resize(totalWidth, STAFF_H);
    const ctx = renderer.getContext();

    // Render 3 identical copies
    const allBeatMeta = [];
    const copyBeatCounts = [];
    for (let c = 0; c < NUM_COPIES; c++) {
      const xStart = 10 + c * singleCopyWidth;
      const { beatMeta } = renderCopy(VF, ctx, measures, c, xStart, measureWidth);
      copyBeatCounts.push(beatMeta.length);
      allBeatMeta.push(...beatMeta);
    }

    // Build beat events from all copies
    const beatsPerMeasure = 4; // 4/4 time
    const totalMusicalBeatsPerCopy = measures.length * beatsPerMeasure;
    let copyOffset = 0;
    let copyIdx = 0;
    const events = allBeatMeta.map((meta, globalIdx) => {
      // Track which copy this event belongs to
      while (copyIdx < copyBeatCounts.length - 1 && globalIdx >= copyOffset + copyBeatCounts[copyIdx]) {
        copyOffset += copyBeatCounts[copyIdx];
        copyIdx++;
      }
      const refNote = meta.trebleNote || meta.bassNote;
      const xPx = refNote ? refNote.getAbsoluteX() : 0;
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
        xPx,
        state: "pending",
        svgEls,
      };
    });

    beatEventsRef.current = events;
    if (onBeatEvents) onBeatEvents(events);
    setSvgReady(true);

    return () => {
      setSvgReady(false);
    };
  }, [measures, measureWidth]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const targetX = viewportWidth * TARGET_LINE_PCT;
    const msPerBeat = 60000 / bpm;
    const effectiveMeasureWidth = getMeasureWidth(null, false, measureWidth);
    const pxPerBeat = effectiveMeasureWidth / 4; // 4 beats per measure in 4/4
    const pxPerMs = pxPerBeat / msPerBeat;
    const copyWidth = copyWidthRef.current;

    const events = beatEventsRef.current;

    // Reset from previous session: clear colors, states, and stale musicalBeat values.
    // musicalBeat is modified by teleport, so it must be restored to its original
    // copy-relative value before recomputing approachMs / targetTimeMs.
    const beatsPerCopy = events.length / NUM_COPIES;
    const totalMusicalBeatsPerCopy = measures.length * 4;
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

    // Find the first beat at the firstPassStart measure (for resume-from-measure)
    let startEvtIdx = 0;
    if (firstPassStart > 0 && measures[firstPassStart]) {
      const startMeasNum = measures[firstPassStart].number;
      const beatsPerCopy = events.length / NUM_COPIES;
      for (let i = 0; i < beatsPerCopy; i++) {
        if (events[i].meas >= startMeasNum) {
          startEvtIdx = i;
          break;
        }
      }
    }

    // Origin: position so that the startEvtIdx beat approaches from off-screen right
    const startBeatX = events[startEvtIdx]?.xPx || events[0]?.xPx || 0;
    const originPx = startBeatX - viewportWidth;

    // Approach time adjusted for the start offset so that
    // targetTimeMs = approachMs + musicalBeat * msPerBeat matches the geometric scroll position.
    // The start beat (musicalBeat = S) reaches targetX at elapsed = baseApproach,
    // so approachMs = baseApproach - S * msPerBeat.
    const baseApproachMs = (viewportWidth - targetX) / pxPerMs;
    const startMusicalBeat = events[startEvtIdx]?.musicalBeat || 0;
    const approachMs = baseApproachMs - startMusicalBeat * msPerBeat;

    // Compute targetTimeMs for every beat event from musical position
    for (let i = 0; i < events.length; i++) {
      events[i].targetTimeMs = approachMs + events[i].musicalBeat * msPerBeat;
    }

    // Mark beats before the start as skipped (not checked for miss or MIDI match)
    for (let i = 0; i < startEvtIdx; i++) {
      events[i].state = "skipped";
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
    const audioBaseTime = audioCtx ? audioCtx.currentTime : 0;

    scrollStateRef.current = {
      scrollStartT: performance.now(),
      originPx,
      pxPerMs,
      targetX,
      copyWidth,
    };
    if (scrollStateExtRef) scrollStateExtRef.current = scrollStateRef.current;

    if (onLoopCount) onLoopCount(0);

    function frame() {
      const state = scrollStateRef.current;
      if (!state) return;

      const now = performance.now();
      const elapsed = now - state.scrollStartT;

      // Check for seamless loop teleport BEFORE computing final offset.
      // Copy 1 starts at world x = 10 + copyWidth.
      // Screen position = worldX - scrollOffset.
      // When copy 1's start crosses the target line, jump BACK by copyWidth
      // so copy 0 (identical content, freshly reset) takes its place later.
      const rawScrollOffset = state.originPx + elapsed * state.pxPerMs;
      const copy1ScreenX = (10 + copyWidth) - rawScrollOffset;
      if (copy1ScreenX <= targetX) {
        state.originPx -= copyWidth;
        loopCount++;
        if (onLoopCount) onLoopCount(loopCount);

        // Reset ALL copies: copy 0 = current pass, copy 1 = next, copy 2 = after that
        const beatsPerCopy = beatEventsRef.current.length / NUM_COPIES;
        const totalMusicalBeats = measures.length * 4;
        for (let c = 0; c < NUM_COPIES; c++) {
          const passOffset = (loopCount + c) * totalMusicalBeats;
          for (let i = 0; i < beatsPerCopy; i++) {
            const evt = beatEventsRef.current[c * beatsPerCopy + i];
            if (evt) {
              evt.state = "pending";
              evt._logged = false;
              colorBeatEls(evt, "#000000");
              evt.musicalBeat = passOffset + evt.baseBeat;
              evt.targetTimeMs = approachMs + evt.musicalBeat * msPerBeat;
            }
          }
        }
        console.log('[Teleport] elapsed:', Math.round(elapsed),
          'first 3 reset events:',
          beatEventsRef.current.slice(0, 3).map(e => ({
            meas: e.meas, beat: e.beat,
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
      if (metronomeEnabled && audioCtx) {
        const LOOKAHEAD_MS = 100;
        while (true) {
          const tickElapsedMs = metroStartMs + nextMetroBeatIdx * msPerBeat;
          if (tickElapsedMs > elapsed + LOOKAHEAD_MS) break;
          if (tickElapsedMs >= elapsed) {
            const delayS = (tickElapsedMs - elapsed) / 1000;
            playClick(audioCtx, audioBaseTime + (elapsed / 1000) + delayS);
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
        // Skip rests immediately — don't block scanner behind padding rests
        if (evt.allMidi.length === 0) {
          evt.state = "skipped";
          nc++;
          continue;
        }
        if (elapsed > evt.targetTimeMs + GRACE_MS) {
          evt.state = "missed";
          colorBeatEls(evt, "#dc2626");
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
  }, [playbackState, svgReady, bpm]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      {/* Viewport — clips the scrolling SVG */}
      <div
        ref={viewportRef}
        onClick={onTap}
        className="relative overflow-hidden bg-gray-50 rounded-lg border border-gray-200 cursor-pointer"
        style={{ height: STAFF_H + 4 }}
      >
        {/* Target zone (subtle blue tint) */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: 0,
            width: `${TARGET_LINE_PCT * 100}%`,
            backgroundColor: "rgba(37, 99, 235, 0.04)",
          }}
        />

        {/* Target line (blue, 2px) */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none z-10"
          style={{
            left: `${TARGET_LINE_PCT * 100}%`,
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
