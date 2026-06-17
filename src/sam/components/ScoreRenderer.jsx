import React, { useEffect, useRef, useState } from "react";
import { noteToVexKey, noteAccidental, getBeamGroups, getMeasureWidth, getFormatWidth } from "../lib/vexflowHelpers";
import { measureDurationQ } from "../lib/measureUtils";
import {
  parseDuration,
  padVoice,
  drawStaveTies,
  applyTimeProportionalLayout,
  DURATION_BEATS,
} from "../lib/scoreRender";
import { CLEF_EXTRA } from "../lib/vexflowHelpers";
import { SCORE_SCALE } from "../lib/samConstants";

// Layout constants
// Stopped view leaves extra room between the staves for lyrics + the lyric-edit
// arrow controls (←→ above, ⇐⇒ below). ScrollEngine/playback uses a tighter
// layout because it doesn't render the arrow controls.
const TREBLE_Y = 40;
const BASS_Y = 290;                // was 210; +80 of inter-stave room
const STAFF_H = 430;                // was 350; matches BASS_Y bump
const LYRIC_Y = TREBLE_Y + 145;     // centered between staves with the new gap

export default function ScoreRenderer({ measures, onBeatEvents, onTap, measureWidth, lyricPlacements, onLyricEdit, onAudioOffsetChange, showAudioOffset = false }) {
  const containerRef = useRef(null);
  const pointerRef = useRef(null);
  const lyricEditRef = useRef(null);
  const offsetEditorRef = useRef(null);
  const showEditorRef = useRef(null);
  lyricEditRef.current = onLyricEdit; // always fresh

  const [editor, setEditor] = useState({ visible: false, x: 0, measureNum: null, value: "" });

  showEditorRef.current = (measure, xOffset) => {
    setEditor({
      visible: true,
      x: xOffset,
      measureNum: measure.number,
      value: measure.audioOffsetMs != null ? String(measure.audioOffsetMs) : "",
    });
  };

  function commitEditor() {
    const v = (editor.value ?? "").toString().trim();
    const parsed = v === "" ? null : parseInt(v, 10);
    const finalVal = Number.isNaN(parsed) ? null : parsed;
    if (onAudioOffsetChange && editor.measureNum != null) {
      onAudioOffsetChange(editor.measureNum, finalVal);
    }
    setEditor((prev) => ({ ...prev, visible: false }));
  }

  function cancelEditor() {
    setEditor((prev) => ({ ...prev, visible: false }));
  }

  useEffect(() => {
    if (!measures || measures.length === 0) return;

    const VF = window.Vex?.Flow;
    if (!VF) {
      console.error("VexFlow not loaded");
      return;
    }

    const container = containerRef.current;
    container.innerHTML = "";

    // Calculate total width — fixed width per measure
    const measureWidths = measures.map((m, i) => getMeasureWidth(m.timeSignature, i === 0, measureWidth));
    const totalWidth = measureWidths.reduce((a, b) => a + b, 0) + 20;

    // Create renderer. The SVG is sized to display pixels (× SCORE_SCALE) and
    // ctx is pre-scaled so every VexFlow draw call lands at the right display
    // position. Internal/render-space coordinates stay unchanged.
    const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
    renderer.resize(totalWidth * SCORE_SCALE, STAFF_H * SCORE_SCALE);
    const ctx = renderer.getContext();
    ctx.scale(SCORE_SCALE, SCORE_SCALE);

    const svg = container.querySelector("svg");

    if (showAudioOffset) {
      const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
      styleEl.textContent = `.sam-meas-btn-bg{fill:rgba(0,0,0,0.04);stroke:var(--border);stroke-width:0.5}.sam-meas-btn:hover .sam-meas-btn-bg{fill:rgba(0,0,0,0.08)}`;
      svg.prepend(styleEl);
    }

    // Track beat metadata for position extraction
    const beatMeta = [];
    let beatMetaOffset = 0;

    let xOffset = 10;

    // Track notes with tie properties across all measures (for cross-barline ties)
    const tieTracker = { treble: [], bass: [] };
    const lyricPositions = []; // [{x, measureNum, rhIndex}] for editing controls

    measures.forEach((measure, measIdx) => {
      const isFirst = measIdx === 0;
      const measWidth = measureWidths[measIdx];

      // Create staves
      const treble = new VF.Stave(xOffset, TREBLE_Y, measWidth);
      const bass = new VF.Stave(xOffset, BASS_Y, measWidth);

      if (isFirst) {
        const firstTs = measures[0]?.timeSignature || { beats: 4, beatType: 4 };
        const tsStr = `${firstTs.beats}/${firstTs.beatType}`;
        treble.addClef("treble").addTimeSignature(tsStr);
        bass.addClef("bass").addTimeSignature(tsStr);
      }

      treble.setContext(ctx).draw();
      bass.setContext(ctx).draw();

      // Brace connector on first measure
      if (isFirst) {
        new VF.StaveConnector(treble, bass)
          .setType(VF.StaveConnector.type.BRACE)
          .setContext(ctx)
          .draw();
      }

      // Bar-line connector on every measure
      new VF.StaveConnector(treble, bass)
        .setType(VF.StaveConnector.type.SINGLE_LEFT)
        .setContext(ctx)
        .draw();

      // Hyperlink-style click behavior wired to open the audio-offset editor
      const capturedXOffset = xOffset;
      const capturedMeasure = measure;
      const capturedIdx = measIdx;
      function attachOffsetEditOpen(el) {
        el.setAttribute("cursor", "pointer");
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          showEditorRef.current?.(capturedMeasure, capturedXOffset, capturedIdx);
        });
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
        el.addEventListener("pointerup", (e) => e.stopPropagation());
      }

      // Measure number (with optional audio-offset badge) above treble staff
      const measNumEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      measNumEl.setAttribute("x", xOffset + 5);
      measNumEl.setAttribute("y", TREBLE_Y - 2);
      measNumEl.setAttribute("font-size", "10");
      measNumEl.setAttribute("font-family", "monospace");
      measNumEl.setAttribute("fill", showAudioOffset ? "var(--primary)" : "var(--muted-foreground)");
      measNumEl.textContent =
        showAudioOffset && measure.audioOffsetMs != null
          ? `${measure.number} ⚓${measure.audioOffsetMs}`
          : String(measure.number);

      if (showAudioOffset) {
        // Wrap in a group with a subtle button-style background rect.
        // Append text first so getBBox() returns its rendered size, then
        // insert the rect behind it.
        const measGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        measGroup.setAttribute("class", "sam-meas-btn");
        attachOffsetEditOpen(measGroup);
        measGroup.appendChild(measNumEl);
        svg.appendChild(measGroup);

        const bbox = measNumEl.getBBox();
        const padX = 3, padY = 1;
        const bgEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        bgEl.setAttribute("x", bbox.x - padX);
        bgEl.setAttribute("y", bbox.y - padY);
        bgEl.setAttribute("width", bbox.width + 2 * padX);
        bgEl.setAttribute("height", bbox.height + 2 * padY);
        bgEl.setAttribute("rx", 2);
        bgEl.setAttribute("class", "sam-meas-btn-bg");
        measGroup.insertBefore(bgEl, measNumEl);
      } else {
        svg.appendChild(measNumEl);
      }

      // Chord label underneath measure number
      if (measure.chord) {
        const chordEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        chordEl.setAttribute("x", xOffset + (isFirst ? 80 : 5));
        chordEl.setAttribute("y", TREBLE_Y + 18);
        chordEl.setAttribute("font-size", "20");
        chordEl.setAttribute("font-family", "serif");
        chordEl.setAttribute("fill", "var(--foreground)");
        chordEl.textContent = measure.chord;
        svg.appendChild(chordEl);
      }

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
        const durationQ = measureDurationQ(measure.timeSignature);
        const rhEvents = padVoice(measure.rh || [], durationQ);
        const lhEvents = padVoice(measure.lh || [], durationQ);

        // Build treble StaveNotes from RH voice events
        for (const evt of rhEvents) {
          const notes = evt.notes || [];
          if (notes.length > 0) {
            const keys = notes.map((n) => noteToVexKey(n));
            const { base, dots } = parseDuration(evt.duration);
            const sn = new VF.StaveNote({ clef: "treble", keys, duration: base });
            for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([sn]);
            notes.forEach((n, ki) => {
              const acc = noteAccidental(n);
              if (acc) sn.addModifier(new VF.Accidental(acc), ki);
            });
            // Add lyric if present
            if (evt.lyric) {
              sn.addModifier(
                new VF.Annotation(evt.lyric).setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM),
                0
              );
            }
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
            const { base, dots } = parseDuration(evt.duration);
            const rest = new VF.StaveNote({
              clef: "treble", keys: ["b/4"], duration: base + "r",
            });
            for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([rest]);
            trebleNotes.push(rest);
          }
        }

        // Build bass StaveNotes from LH voice events
        for (const evt of lhEvents) {
          const notes = evt.notes || [];
          if (notes.length > 0) {
            const keys = notes.map((n) => noteToVexKey(n));
            const { base, dots } = parseDuration(evt.duration);
            const sn = new VF.StaveNote({ clef: "bass", keys, duration: base });
            for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([sn]);
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
            const { base, dots } = parseDuration(evt.duration);
            const rest = new VF.StaveNote({
              clef: "bass", keys: ["d/3"], duration: base + "r",
            });
            for (let i = 0; i < dots; i++) VF.Dot.buildAndAttach([rest]);
            bassNotes.push(rest);
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
            allMidi: entry.allMidi.sort((a, b) => a - b),
            trebleNote: entry.trebleIdx !== null ? trebleNotes[entry.trebleIdx] : null,
            bassNote: entry.bassIdx !== null ? bassNotes[entry.bassIdx] : null,
            trebleSvgEl: null,
            bassSvgEl: null,
          });
        });

        measBeatCount = sortedTicks.length;

        // Tick onset positions for time-proportional repositioning (mirrors
        // the per-voice tick stream that drove the build loops above).
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

          const { base: beatBase, dots: beatDots } = parseDuration(beat.duration || "q");

          let trebleNote;
          if (trebleGroup.length > 0) {
            const keys = trebleGroup.map((n) => noteToVexKey(n));
            trebleNote = new VF.StaveNote({ clef: "treble", keys, duration: beatBase });
            for (let i = 0; i < beatDots; i++) VF.Dot.buildAndAttach([trebleNote]);
            trebleGroup.forEach((n, ki) => {
              const acc = noteAccidental(n);
              if (acc) trebleNote.addModifier(new VF.Accidental(acc), ki);
            });
          } else {
            trebleNote = new VF.StaveNote({ clef: "treble", keys: ["b/4"], duration: beatBase + "r" });
            for (let i = 0; i < beatDots; i++) VF.Dot.buildAndAttach([trebleNote]);
          }
          trebleNotes.push(trebleNote);

          let bassNote;
          if (bassGroup.length > 0) {
            const keys = bassGroup.map((n) => noteToVexKey(n));
            bassNote = new VF.StaveNote({ clef: "bass", keys, duration: beatBase });
            for (let i = 0; i < beatDots; i++) VF.Dot.buildAndAttach([bassNote]);
            bassGroup.forEach((n, ki) => {
              const acc = noteAccidental(n);
              if (acc) bassNote.addModifier(new VF.Accidental(acc), ki);
            });
          } else {
            bassNote = new VF.StaveNote({ clef: "bass", keys: ["d/3"], duration: beatBase + "r" });
            for (let i = 0; i < beatDots; i++) VF.Dot.buildAndAttach([bassNote]);
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

        measBeatCount = measure.beats.length;
        trebleTicks = measure.beats.map((b) => b.beat - 1);
        bassTicks = trebleTicks;
      }

      // 1. Set staves before formatting so VexFlow can compute note head
      //    dimensions during preFormat (required for accidental positioning)
      trebleNotes.forEach((note) => note.setStave(treble));
      bassNotes.forEach((note) => note.setStave(bass));

      // 2. Create voices and add tickables
      const ts = measure.timeSignature || { beats: 4, beatType: 4 };
      const trebleVoice = new VF.Voice({ num_beats: ts.beats, beat_value: ts.beatType })
        .setStrict(false)
        .addTickables(trebleNotes);
      const bassVoice = new VF.Voice({ num_beats: ts.beats, beat_value: ts.beatType })
        .setStrict(false)
        .addTickables(bassNotes);

      // 3. Create beams (after addTickables, before draw — suppresses flags)
      const trebleBeams = getBeamGroups(trebleNotes).map((g) => new VF.Beam(g));
      const bassBeams = getBeamGroups(bassNotes).map((g) => new VF.Beam(g));

      // 4. Format — align rhythmic positions across both staves
      new VF.Formatter()
        .joinVoices([trebleVoice])
        .joinVoices([bassVoice])
        .format([trebleVoice, bassVoice], getFormatWidth(measWidth, isFirst));

      // 4.5/4.6. Time-proportional layout + position-query patches so the
      // stopped view matches scrollEngine playback exactly (consistent notehead
      // positions and correct tie attachment).
      //
      // On the first measure the stave occupies the leading CLEF_EXTRA pixels
      // with the clef + time signature; shift the note region right by that
      // amount and shrink the available width so notes don't overlap the
      // 4/4. (ScrollEngine doesn't hit this because it renders staves without
      // clefs / time-signatures.)
      const layoutDurationQ = measureDurationQ(measure.timeSignature);
      const layoutXOffset = xOffset + (isFirst ? CLEF_EXTRA : 0);
      const layoutMeasWidth = measWidth - (isFirst ? CLEF_EXTRA : 0);
      applyTimeProportionalLayout({
        notes: trebleNotes, ticks: trebleTicks, durationQ: layoutDurationQ,
        xOffset: layoutXOffset, measWidth: layoutMeasWidth, stave: treble,
      });
      applyTimeProportionalLayout({
        notes: bassNotes, ticks: bassTicks, durationQ: layoutDurationQ,
        xOffset: layoutXOffset, measWidth: layoutMeasWidth, stave: bass,
      });

      // 5. Draw treble notes individually, each wrapped in an SVG <g> group
      trebleNotes.forEach((note, i) => {
        const groupEl = ctx.openGroup("sam-note", `t-${measIdx}-${i}`);
        note.setStave(treble);
        note.setContext(ctx);
        note.draw();
        ctx.closeGroup();

        // Fix lyric annotation y position to a constant baseline
        const rhEvt = (measure.rh || [])[i];
        if (rhEvt && rhEvt.lyric) {
          // Find the annotation text element (VexFlow renders annotations as <text> elements)
          const textElements = groupEl.querySelectorAll("text");
          for (const textEl of textElements) {
            // Annotation text is typically the last text element and contains the lyric
            if (textEl.textContent === rhEvt.lyric) {
              textEl.setAttribute("y", LYRIC_Y);
              // Increase font size by 20% (from default ~10pt to ~12pt)
              textEl.setAttribute("font-size", "12pt");
              break;
            }
          }
        }

        // Collect lyric positions for editing controls. Use the visual X
        // (formatter + time-proportional xShift), not the bare formatter X —
        // otherwise the arrows hang at the pre-repositioned spot instead of
        // tracking the syllable.
        if (rhEvt && rhEvt.lyric) {
          lyricPositions.push({
            x: note.getAbsoluteX() + note.getXShift(),
            measureNum: measure.number,
            rhIndex: i,
          });
        }

        const bmIdx = trebleIdxMap !== null ? trebleIdxMap[i] : i;
        if (bmIdx !== undefined && beatMeta[beatMetaOffset + bmIdx]) {
          beatMeta[beatMetaOffset + bmIdx].trebleSvgEl = groupEl;
        }
      });

      // Draw bass notes individually
      bassNotes.forEach((note, i) => {
        const groupEl = ctx.openGroup("sam-note", `b-${measIdx}-${i}`);
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

      beatMetaOffset += measBeatCount;
      xOffset += measWidth;
    });

    // Tie rendering (with narrow-tie widening for sixteenth-density ties)
    // is shared with scoreRender.js — single source of truth so the stopped
    // view and the scroll engine produce identical output.
    drawStaveTies(VF, ctx, tieTracker.treble);
    drawStaveTies(VF, ctx, tieTracker.bass);

    // Lyric editing arrow controls (stopped mode only)
    if (lyricPlacements && lyricEditRef.current && lyricPositions.length > 0) {
      // Add CSS for hover
      const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
      styleEl.textContent = `.sam-arrow{opacity:0.3;cursor:pointer;user-select:none;fill:var(--muted-foreground)}.sam-arrow:hover{opacity:0.9}`;
      svg.prepend(styleEl);

      // Build lookup: measureNum-rhIndex → [word_orders]
      const lyricLookup = {};
      for (const lp of lyricPlacements) {
        if (lp.measure_num == null) continue;
        const key = `${lp.measure_num}-${lp.rh_index}`;
        if (!lyricLookup[key]) lyricLookup[key] = [];
        lyricLookup[key].push(lp.word_order);
      }

      function addArrow(text, x, y, fontSize, onClick) {
        const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
        el.setAttribute("x", x);
        el.setAttribute("y", y);
        el.setAttribute("font-size", fontSize);
        el.setAttribute("text-anchor", "middle");
        el.setAttribute("class", "sam-arrow");
        el.textContent = text;
        el.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        svg.appendChild(el);
      }

      for (const pos of lyricPositions) {
        const key = `${pos.measureNum}-${pos.rhIndex}`;
        const wordOrders = lyricLookup[key];
        if (!wordOrders || wordOrders.length === 0) continue;

        const x = pos.x;
        // Single-step arrows above syllable (above 12pt text ~16px cap height)
        addArrow("\u2190", x - 8, LYRIC_Y - 18, "14px", () => lyricEditRef.current?.onPullBack(wordOrders));
        addArrow("\u2192", x + 8, LYRIC_Y - 18, "14px", () => lyricEditRef.current?.onPushForward(wordOrders));
        // Cascade arrows below syllable
        addArrow("\u21D0", x - 9, LYRIC_Y + 18, "15px", () => lyricEditRef.current?.onCascadePullBack(wordOrders));
        addArrow("\u21D2", x + 9, LYRIC_Y + 18, "15px", () => lyricEditRef.current?.onCascadePushForward(wordOrders));
      }
    }

    // Extract beat positions and SVG elements
    const beatEvents = beatMeta.map((meta, globalIdx) => {
      const refNote = meta.trebleNote || meta.bassNote;
      // VexFlow's getAbsoluteX is render-space; downstream consumers (e.g.
      // ScrollEngine's loop teleport via xPx) treat this as display pixels.
      const xPx = refNote ? refNote.getAbsoluteX() * SCORE_SCALE : 0;

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

    if (onBeatEvents) {
      onBeatEvents(beatEvents);
    }
  }, [measures, onBeatEvents, measureWidth, lyricPlacements, showAudioOffset]);

  function handlePointerDown(e) {
    pointerRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  }

  function handlePointerUp(e) {
    if (!pointerRef.current || !onTap) return;
    const dt = Date.now() - pointerRef.current.t;
    const dx = Math.abs(e.clientX - pointerRef.current.x);
    const dy = Math.abs(e.clientY - pointerRef.current.y);
    pointerRef.current = null;
    if (dt < 300 && dx < 10 && dy < 10) {
      onTap();
    }
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      className="relative overflow-x-auto bg-white rounded-lg border border-border p-2 cursor-pointer"
    >
      <div ref={containerRef} />
      {editor.visible && (
        <div
          ref={offsetEditorRef}
          style={{ position: "absolute", left: editor.x, top: 0, zIndex: 10 }}
          className="bg-card border border-border rounded p-1 shadow-md"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] text-muted-foreground mb-0.5 whitespace-nowrap">
            m.{editor.measureNum} audio offset ms
          </div>
          <input
            type="number"
            value={editor.value}
            placeholder="audio ms"
            autoFocus
            onChange={(e) => setEditor((prev) => ({ ...prev, value: e.target.value }))}
            onBlur={commitEditor}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEditor();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEditor();
              }
            }}
            className="w-24 px-2 py-1 border border-border rounded text-xs"
          />
        </div>
      )}
    </div>
  );
}
