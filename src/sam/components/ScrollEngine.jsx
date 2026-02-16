import React, { useEffect, useRef, useState } from "react";
import { midiToVexKey, midiAccidental, getBeamGroups, colorBeatEls } from "../lib/vexflowHelpers";

const BEAT_PX = 150;
const TARGET_LINE_PCT = 0.15; // 15% from left edge
const STAFF_H = 280;
const NUM_COPIES = 3;

// Renders a single copy of the score into the given VexFlow context.
// Returns { beatMeta[], copyWidth } for that copy.
function renderCopy(VF, ctx, measures, copyIdx, xStart) {
  const CLEF_EXTRA = 80;
  const TREBLE_Y = 10;
  const BASS_Y = 140;

  const measureWidths = measures.map((_, i) =>
    BEAT_PX * 4 + (i === 0 ? CLEF_EXTRA : 0)
  );
  const copyWidth = measureWidths.reduce((a, b) => a + b, 0);

  const beatMeta = [];
  let beatMetaOffset = 0;
  let xOffset = xStart;

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

    const trebleNotes = [];
    const bassNotes = [];

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
        allMidi,
        trebleNote,
        bassNote,
        trebleSvgEl: null,
        bassSvgEl: null,
      });
    });

    const trebleBeamGroups = getBeamGroups(trebleNotes);
    const bassBeamGroups = getBeamGroups(bassNotes);
    const trebleBeams = trebleBeamGroups.map((g) => new VF.Beam(g));
    const bassBeams = bassBeamGroups.map((g) => new VF.Beam(g));

    const trebleVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
      .setStrict(false)
      .addTickables(trebleNotes);
    const bassVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
      .setStrict(false)
      .addTickables(bassNotes);

    new VF.Formatter()
      .joinVoices([trebleVoice])
      .joinVoices([bassVoice])
      .format([trebleVoice, bassVoice], measWidth - 30);

    trebleNotes.forEach((note, i) => {
      const groupEl = ctx.openGroup("sam-note", `t-${copyIdx}-${measIdx}-${i}`);
      note.setStave(treble);
      note.setContext(ctx);
      note.draw();
      ctx.closeGroup();
      beatMeta[beatMetaOffset + i].trebleSvgEl = groupEl;
    });

    bassNotes.forEach((note, i) => {
      const groupEl = ctx.openGroup("sam-note", `b-${copyIdx}-${measIdx}-${i}`);
      note.setStave(bass);
      note.setContext(ctx);
      note.draw();
      ctx.closeGroup();
      beatMeta[beatMetaOffset + i].bassSvgEl = groupEl;
    });

    trebleBeams.forEach((b) => b.setContext(ctx).draw());
    bassBeams.forEach((b) => b.setContext(ctx).draw());

    beatMetaOffset += measure.beats.length;
    xOffset += measWidth;
  });

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
    const CLEF_EXTRA = 80;
    const singleMeasureWidths = measures.map((_, i) =>
      BEAT_PX * 4 + (i === 0 ? CLEF_EXTRA : 0)
    );
    const singleCopyWidth = singleMeasureWidths.reduce((a, b) => a + b, 0);
    const totalWidth = singleCopyWidth * NUM_COPIES + 20;

    copyWidthRef.current = singleCopyWidth;

    const renderer = new VF.Renderer(scrollLayer, VF.Renderer.Backends.SVG);
    renderer.resize(totalWidth, STAFF_H);
    const ctx = renderer.getContext();

    // Render 3 identical copies
    const allBeatMeta = [];
    for (let c = 0; c < NUM_COPIES; c++) {
      const xStart = 10 + c * singleCopyWidth;
      const { beatMeta } = renderCopy(VF, ctx, measures, c, xStart);
      allBeatMeta.push(...beatMeta);
    }

    // Build beat events from all copies
    const events = allBeatMeta.map((meta, globalIdx) => {
      const xPx = meta.trebleNote.getAbsoluteX();
      const svgEls = [];
      if (meta.trebleSvgEl) svgEls.push(meta.trebleSvgEl);
      if (meta.bassSvgEl) svgEls.push(meta.bassSvgEl);
      return {
        globalIdx,
        meas: meta.meas,
        beat: meta.beat,
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
    const pxPerMs = BEAT_PX / (60000 / bpm);
    const copyWidth = copyWidthRef.current;

    // Start so first beat approaches from off-screen right
    const firstBeatX = beatEventsRef.current[0]?.xPx || 0;
    const originPx = firstBeatX - viewportWidth;

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

        // Reset beat states and colors for copy 1 (which is now the active copy again)
        const beatsPerCopy = beatEventsRef.current.length / NUM_COPIES;
        for (let i = 0; i < beatsPerCopy; i++) {
          const evt = beatEventsRef.current[i];
          if (evt) {
            evt.state = "pending";
            colorBeatEls(evt, "#000000");
          }
        }
        nextCheckRef.current = 0;
      }

      // Compute final scroll offset (may have been adjusted by teleport)
      const scrollOffset = state.originPx + elapsed * state.pxPerMs;
      scrollLayer.style.transform = `translateX(${-scrollOffset}px)`;

      // --- Miss detection: forward-scan from nextCheck ---
      const events = beatEventsRef.current;
      const gracePx = GRACE_MS * state.pxPerMs;
      let nc = nextCheckRef.current;

      while (nc < events.length) {
        const evt = events[nc];
        if (evt.state !== "pending") {
          nc++;
          continue;
        }
        const screenX = evt.xPx - scrollOffset;
        if (screenX < state.targetX - gracePx) {
          // Beat has scrolled past the timing window
          if (evt.allMidi.length > 0) {
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
