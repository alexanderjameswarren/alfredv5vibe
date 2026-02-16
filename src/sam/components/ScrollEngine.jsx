import React, { useEffect, useRef, useState } from "react";
import { midiToVexKey, midiAccidental, getBeamGroups, colorBeatEls, getMeasureWidth, getFormatWidth } from "../lib/vexflowHelpers";

const SCROLL_PX_PER_BEAT = 100; // pixels per beat for scroll speed
const TARGET_LINE_PCT = 0.15; // 15% from left edge
const STAFF_H = 280;
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
function renderCopy(VF, ctx, measures, copyIdx, xStart) {
  const TREBLE_Y = 10;
  const BASS_Y = 140;

  const measureWidths = measures.map((m, i) => getMeasureWidth(m, i === 0));
  const copyWidth = measureWidths.reduce((a, b) => a + b, 0);

  const beatMeta = [];
  let beatMetaOffset = 0;
  let xOffset = xStart;

  // Track notes with tie properties across all measures (for cross-barline ties)
  const tieTracker = { treble: [], bass: [] };

  measures.forEach((measure, measIdx) => {
    const isFirst = measIdx === 0;
    const measWidth = measureWidths[measIdx];

    const treble = new VF.Stave(xOffset, TREBLE_Y, measWidth);
    const bass = new VF.Stave(xOffset, BASS_Y, measWidth);

    if (isFirst) {
      treble.addClef("treble").addTimeSignature("4/4");
      bass.addClef("bass").addTimeSignature("4/4");
    }

    treble.setContext(ctx).draw();
    bass.setContext(ctx).draw();

    if (isFirst) {
      new VF.StaveConnector(treble, bass)
        .setType(VF.StaveConnector.type.BRACE)
        .setContext(ctx)
        .draw();
    }

    new VF.StaveConnector(treble, bass)
      .setType(VF.StaveConnector.type.SINGLE_LEFT)
      .setContext(ctx)
      .draw();

    // Measure number above treble staff
    const svg = ctx.svg;
    const measNumEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    measNumEl.setAttribute("x", xOffset + 5);
    measNumEl.setAttribute("y", TREBLE_Y - 2);
    measNumEl.setAttribute("font-size", "10");
    measNumEl.setAttribute("font-family", "monospace");
    measNumEl.setAttribute("fill", "#999");
    measNumEl.textContent = measure.number;
    svg.appendChild(measNumEl);

    // Build VexFlow notes and beat metadata
    const trebleNotes = [];
    const bassNotes = [];
    let trebleIdxMap = null; // null = 1:1 mapping (legacy)
    let bassIdxMap = null;
    let measBeatCount = 0;

    if (measure.rh || measure.lh) {
      // === Voice format: independent RH/LH voices ===
      const rhEvents = padVoice(measure.rh || []);
      const lhEvents = padVoice(measure.lh || []);

      // Build treble StaveNotes from RH voice events
      for (const evt of rhEvents) {
        const notes = evt.notes || [];
        if (notes.length > 0) {
          const keys = notes.map((n) => midiToVexKey(n.midi));
          const sn = new VF.StaveNote({ clef: "treble", keys, duration: evt.duration });
          notes.forEach((n, ki) => {
            const acc = midiAccidental(n.midi);
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
          const keys = notes.map((n) => midiToVexKey(n.midi));
          const sn = new VF.StaveNote({ clef: "bass", keys, duration: evt.duration });
          notes.forEach((n, ki) => {
            const acc = midiAccidental(n.midi);
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
          const keys = trebleGroup.map((n) => midiToVexKey(n.midi));
          trebleNote = new VF.StaveNote({ clef: "treble", keys, duration: beat.duration || "q" });
          trebleGroup.forEach((n, ki) => {
            const acc = midiAccidental(n.midi);
            if (acc) trebleNote.addModifier(new VF.Accidental(acc), ki);
          });
        } else {
          trebleNote = new VF.StaveNote({ clef: "treble", keys: ["b/4"], duration: (beat.duration || "q") + "r" });
        }
        trebleNotes.push(trebleNote);

        let bassNote;
        if (bassGroup.length > 0) {
          const keys = bassGroup.map((n) => midiToVexKey(n.midi));
          bassNote = new VF.StaveNote({ clef: "bass", keys, duration: beat.duration || "q" });
          bassGroup.forEach((n, ki) => {
            const acc = midiAccidental(n.midi);
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
    }

    // 1. Create voices and add tickables
    const trebleVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
      .setStrict(false)
      .addTickables(trebleNotes);
    const bassVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
      .setStrict(false)
      .addTickables(bassNotes);

    // 2. Create beams (after addTickables, before draw — suppresses flags)
    const trebleBeams = getBeamGroups(trebleNotes).map((g) => new VF.Beam(g));
    const bassBeams = getBeamGroups(bassNotes).map((g) => new VF.Beam(g));

    // 3. Format — align rhythmic positions across both staves
    new VF.Formatter()
      .joinVoices([trebleVoice])
      .joinVoices([bassVoice])
      .format([trebleVoice, bassVoice], getFormatWidth(measWidth, isFirst));

    // 4. Draw treble notes individually, each wrapped in SVG <g> group
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

    // 5. Draw beams after notes
    trebleBeams.forEach((b) => b.setContext(ctx).draw());
    bassBeams.forEach((b) => b.setContext(ctx).draw());

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

const GRACE_MS = 300; // ms after target line before marking a beat as missed

export default function ScrollEngine({ measures, bpm, playing, onBeatEvents, onLoopCount, onBeatMiss, scrollStateExtRef, onTap }) {
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

    // Calculate single copy width to size the SVG
    const singleMeasureWidths = measures.map((m, i) => getMeasureWidth(m, i === 0));
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
      const { beatMeta } = renderCopy(VF, ctx, measures, c, xStart);
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
        musicalBeat: copyIdx * totalMusicalBeatsPerCopy + meta.musicalBeatInCopy,
        allMidi: meta.allMidi,
        xPx,
        state: "pending",
        svgEls,
      };
    });

    beatEventsRef.current = events;
    console.log('[ScrollEngine] Beat events:', events.length, 'Sample:', events.slice(0, 10).map(e => ({
      meas: e.meas, beat: e.beat, allMidi: e.allMidi,
      musicalBeat: e.musicalBeat
    })));
    if (onBeatEvents) onBeatEvents(events);
    setSvgReady(true);

    return () => {
      setSvgReady(false);
    };
  }, [measures]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animation loop with seamless looping
  useEffect(() => {
    if (!playing || !svgReady) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (scrollLayerRef.current) {
        scrollLayerRef.current.style.transform = "translateX(0px)";
      }
      scrollStateRef.current = null;
      if (scrollStateExtRef) scrollStateExtRef.current = null;
      return;
    }

    const viewport = viewportRef.current;
    const scrollLayer = scrollLayerRef.current;
    if (!viewport || !scrollLayer) return;

    const viewportWidth = viewport.clientWidth;
    const targetX = viewportWidth * TARGET_LINE_PCT;
    const msPerBeat = 60000 / bpm;
    const pxPerMs = SCROLL_PX_PER_BEAT / msPerBeat;
    const copyWidth = copyWidthRef.current;

    // Start so first beat approaches from off-screen right
    const firstBeatX = beatEventsRef.current[0]?.xPx || 0;
    const originPx = firstBeatX - viewportWidth;

    // Approach time: ms for the first beat to travel from off-screen to the target line
    const approachMs = (viewportWidth - targetX) / pxPerMs;

    // Compute targetTimeMs for every beat event from musical position
    const events = beatEventsRef.current;
    for (let i = 0; i < events.length; i++) {
      events[i].targetTimeMs = approachMs + events[i].musicalBeat * msPerBeat;
    }

    let loopCount = 0;
    nextCheckRef.current = 0;

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
      // Copy 2 starts at world x = 10 + copyWidth.
      // Screen position = worldX - scrollOffset.
      // When copy 2's start crosses the target line, jump BACK by copyWidth
      // so copy 1 (identical content) takes its place on screen.
      const rawScrollOffset = state.originPx + elapsed * state.pxPerMs;
      const copy2ScreenX = (10 + copyWidth) - rawScrollOffset;
      if (copy2ScreenX <= targetX) {
        state.originPx -= copyWidth;
        loopCount++;
        if (onLoopCount) onLoopCount(loopCount);

        // Reset beat states, colors, and targetTimeMs for copy 1
        const beatsPerCopy = beatEventsRef.current.length / NUM_COPIES;
        const totalMusicalBeats = measures.length * 4;
        const passOffset = (loopCount + 2) * totalMusicalBeats;
        for (let i = 0; i < beatsPerCopy; i++) {
          const evt = beatEventsRef.current[i];
          if (evt) {
            evt.state = "pending";
            colorBeatEls(evt, "#000000");
            evt.musicalBeat = passOffset + (evt.musicalBeat % totalMusicalBeats);
            evt.targetTimeMs = approachMs + evt.musicalBeat * msPerBeat;
          }
        }
        nextCheckRef.current = 0;
      }

      // Compute final scroll offset (may have been adjusted by teleport)
      const scrollOffset = state.originPx + elapsed * state.pxPerMs;
      scrollLayer.style.transform = `translateX(${-scrollOffset}px)`;

      // --- Miss detection: forward-scan from nextCheck (time-based) ---
      const evts = beatEventsRef.current;
      let nc = nextCheckRef.current;

      while (nc < evts.length) {
        const evt = evts[nc];
        if (evt.state !== "pending") {
          nc++;
          continue;
        }
        if (elapsed > evt.targetTimeMs + GRACE_MS) {
          // Beat's timing window has passed
          if (evt.allMidi.length > 0) {
            console.log('[ScrollEngine] MISS:', evt.meas, evt.beat, 'elapsed:', Math.round(elapsed), 'target:', Math.round(evt.targetTimeMs));
            evt.state = "missed";
            colorBeatEls(evt, "#dc2626");
            if (onBeatMiss) onBeatMiss(evt);
          } else {
            // Rest beat — skip silently
            evt.state = "skipped";
          }
          nc++;
        } else {
          // This beat hasn't passed yet — stop scanning
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
  }, [playing, svgReady, bpm]); // eslint-disable-line react-hooks/exhaustive-deps

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
