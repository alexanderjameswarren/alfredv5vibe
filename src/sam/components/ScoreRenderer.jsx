import React, { useEffect, useRef, useState } from "react";
import { noteToVexKey, noteAccidental, getBeamGroups, getMeasureWidth, getFormatWidth } from "../lib/vexflowHelpers";
import { measureDurationQ } from "../lib/measureUtils";

// Layout constants
const TREBLE_Y = 40;
const BASS_Y = 210;
const STAFF_H = 350;
const LYRIC_Y = TREBLE_Y + 115; // Fixed y position for all lyrics

// Duration → quarter-note beat values (for voice format tick tracking)
const DURATION_BEATS = {
  w: 4, hd: 3, h: 2, qd: 1.5, q: 1, "8d": 0.75, "8": 0.5, "16": 0.25, "32": 0.125,
};

// Pad a voice event array with rests so durations sum to targetBeats
function padVoice(events, targetBeats = 4) {
  let total = 0;
  for (const evt of events) total += DURATION_BEATS[evt.duration] || 1;
  const result = [...events];
  let remaining = targetBeats - total;
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

    // Create renderer
    const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
    renderer.resize(totalWidth, STAFF_H);
    const ctx = renderer.getContext();

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
            const sn = new VF.StaveNote({ clef: "treble", keys, duration: evt.duration });
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
            const keys = trebleGroup.map((n) => noteToVexKey(n));
            const dur = beat.duration || "q";
            trebleNote = new VF.StaveNote({ clef: "treble", keys, duration: dur });
            trebleGroup.forEach((n, ki) => {
              const acc = noteAccidental(n);
              if (acc) trebleNote.addModifier(new VF.Accidental(acc), ki);
            });
          } else {
            const dur = (beat.duration || "q") + "r";
            trebleNote = new VF.StaveNote({ clef: "treble", keys: ["b/4"], duration: dur });
          }
          trebleNotes.push(trebleNote);

          let bassNote;
          if (bassGroup.length > 0) {
            const keys = bassGroup.map((n) => noteToVexKey(n));
            const dur = beat.duration || "q";
            bassNote = new VF.StaveNote({ clef: "bass", keys, duration: dur });
            bassGroup.forEach((n, ki) => {
              const acc = noteAccidental(n);
              if (acc) bassNote.addModifier(new VF.Accidental(acc), ki);
            });
          } else {
            const dur = (beat.duration || "q") + "r";
            bassNote = new VF.StaveNote({ clef: "bass", keys: ["d/3"], duration: dur });
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

        // Collect lyric positions for editing controls
        if (rhEvt && rhEvt.lyric) {
          lyricPositions.push({
            x: note.getAbsoluteX(),
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
      const xPx = refNote ? refNote.getAbsoluteX() : 0;

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
