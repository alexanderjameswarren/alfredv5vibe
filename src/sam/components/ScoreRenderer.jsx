import React, { useEffect, useRef } from "react";
import { midiToVexKey, midiAccidental, getBeamGroups } from "../lib/vexflowHelpers";

// Layout constants
const BEAT_PX = 150;
const TREBLE_Y = 10;
const BASS_Y = 140;
const STAFF_H = 280;
const CLEF_EXTRA = 80; // extra width on first measure for clef + time sig

export default function ScoreRenderer({ measures, onBeatEvents, onTap }) {
  const containerRef = useRef(null);
  const pointerRef = useRef(null);

  useEffect(() => {
    if (!measures || measures.length === 0) return;

    const VF = window.Vex?.Flow;
    if (!VF) {
      console.error("VexFlow not loaded");
      return;
    }

    const container = containerRef.current;
    container.innerHTML = "";

    // Calculate total width
    const measureWidths = measures.map((_, i) =>
      BEAT_PX * 4 + (i === 0 ? CLEF_EXTRA : 0)
    );
    const totalWidth = measureWidths.reduce((a, b) => a + b, 0) + 20;

    // Create renderer
    const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
    renderer.resize(totalWidth, STAFF_H);
    const ctx = renderer.getContext();

    // Track beat metadata for position extraction
    const beatMeta = [];
    let beatMetaOffset = 0;

    let xOffset = 10;

    measures.forEach((measure, measIdx) => {
      const isFirst = measIdx === 0;
      const measWidth = measureWidths[measIdx];

      // Create staves
      const treble = new VF.Stave(xOffset, TREBLE_Y, measWidth);
      const bass = new VF.Stave(xOffset, BASS_Y, measWidth);

      if (isFirst) {
        treble.addClef("treble").addTimeSignature("4/4");
        bass.addClef("bass").addTimeSignature("4/4");
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

      // Build VexFlow notes for treble and bass from measure beats
      const trebleNotes = [];
      const bassNotes = [];

      measure.beats.forEach((beat) => {
        const rhNotes = (beat.rh || []).filter((n) => n.midi >= 60);
        const lhNotes = (beat.lh || []).filter((n) => n.midi < 60);
        const rhBassNotes = (beat.rh || []).filter((n) => n.midi < 60);
        const lhTrebleNotes = (beat.lh || []).filter((n) => n.midi >= 60);

        const trebleGroup = [...rhNotes, ...lhTrebleNotes];
        const bassGroup = [...lhNotes, ...rhBassNotes];

        // Collect all MIDI numbers for this beat
        const allMidi = [
          ...trebleGroup.map((n) => n.midi),
          ...bassGroup.map((n) => n.midi),
        ].sort((a, b) => a - b);

        // Treble voice note
        let trebleNote;
        if (trebleGroup.length > 0) {
          const keys = trebleGroup.map((n) => midiToVexKey(n.midi));
          const dur = beat.duration || "q";
          trebleNote = new VF.StaveNote({ clef: "treble", keys, duration: dur });
          trebleGroup.forEach((n, ki) => {
            const acc = midiAccidental(n.midi);
            if (acc) trebleNote.addModifier(new VF.Accidental(acc), ki);
          });
        } else {
          const dur = (beat.duration || "q") + "r";
          trebleNote = new VF.StaveNote({ clef: "treble", keys: ["b/4"], duration: dur });
        }
        trebleNotes.push(trebleNote);

        // Bass voice note
        let bassNote;
        if (bassGroup.length > 0) {
          const keys = bassGroup.map((n) => midiToVexKey(n.midi));
          const dur = beat.duration || "q";
          bassNote = new VF.StaveNote({ clef: "bass", keys, duration: dur });
          bassGroup.forEach((n, ki) => {
            const acc = midiAccidental(n.midi);
            if (acc) bassNote.addModifier(new VF.Accidental(acc), ki);
          });
        } else {
          const dur = (beat.duration || "q") + "r";
          bassNote = new VF.StaveNote({ clef: "bass", keys: ["d/3"], duration: dur });
        }
        bassNotes.push(bassNote);

        // Store metadata for post-render extraction
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

      // Create beams BEFORE drawing (gotcha #15)
      const trebleBeamGroups = getBeamGroups(trebleNotes);
      const bassBeamGroups = getBeamGroups(bassNotes);
      const trebleBeams = trebleBeamGroups.map((g) => new VF.Beam(g));
      const bassBeams = bassBeamGroups.map((g) => new VF.Beam(g));

      // Create voices for formatting (non-strict mode — gotcha #20)
      const trebleVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
        .setStrict(false)
        .addTickables(trebleNotes);
      const bassVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
        .setStrict(false)
        .addTickables(bassNotes);

      // Format (positions notes) — but DON'T use voice.draw()
      new VF.Formatter()
        .joinVoices([trebleVoice])
        .joinVoices([bassVoice])
        .format([trebleVoice, bassVoice], measWidth - 30);

      // Draw treble notes individually, each wrapped in an SVG <g> group
      trebleNotes.forEach((note, i) => {
        const groupEl = ctx.openGroup("sam-note", `t-${measIdx}-${i}`);
        note.setStave(treble);
        note.setContext(ctx);
        note.draw();
        ctx.closeGroup();
        beatMeta[beatMetaOffset + i].trebleSvgEl = groupEl;
      });

      // Draw bass notes individually, each wrapped in an SVG <g> group
      bassNotes.forEach((note, i) => {
        const groupEl = ctx.openGroup("sam-note", `b-${measIdx}-${i}`);
        note.setStave(bass);
        note.setContext(ctx);
        note.draw();
        ctx.closeGroup();
        beatMeta[beatMetaOffset + i].bassSvgEl = groupEl;
      });

      // Draw beams after notes
      trebleBeams.forEach((b) => b.setContext(ctx).draw());
      bassBeams.forEach((b) => b.setContext(ctx).draw());

      beatMetaOffset += measure.beats.length;
      xOffset += measWidth;
    });

    // Extract beat positions and SVG elements
    const beatEvents = beatMeta.map((meta, globalIdx) => {
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

    if (onBeatEvents) {
      onBeatEvents(beatEvents);
    }
  }, [measures, onBeatEvents]);

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
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      className="overflow-x-auto bg-gray-50 rounded-lg border border-gray-200 p-2 cursor-pointer"
    />
  );
}
