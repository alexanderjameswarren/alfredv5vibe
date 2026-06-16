// Pure VexFlow rendering helpers extracted from ScrollEngine.
// No React, no refs — these mutate the SVG attached to the provided
// VexFlow context. ScrollEngine drives them from its initial-render effect
// and from the metronome scheduler.
import {
  noteToVexKey,
  noteAccidental,
  getBeamGroups,
  getMeasureWidth,
  getFormatWidth,
} from "./vexflowHelpers";

// Duration → quarter-note beat values (for voice format tick tracking)
export const DURATION_BEATS = {
  w: 4, hd: 3, h: 2, qd: 1.5, q: 1, "8d": 0.75, "8": 0.5, "16": 0.25, "32": 0.125,
};

// VexFlow's StaveNote constructor does not parse the "d" suffix for dotted
// durations — it must be attached as a separate Dot modifier. SAM's beat
// math (see DURATION_BEATS) handles dotted durations natively; this helper
// bridges the two layers for rendering.
//
// Supports multi-dot durations (e.g., "hdd" = double-dotted half = 3.5 beats),
// though SAM doesn't currently produce these. Future-proof.
//
// For rest sites that append "r" to the duration, callers MUST pass the
// pre-suffix duration (e.g., "qd", not "qdr") — otherwise the trailing "r"
// hides the dot from this parser.
export function parseDuration(d) {
  let base = d;
  let dots = 0;
  while (base.endsWith("d")) {
    dots++;
    base = base.slice(0, -1);
  }
  return { base, dots };
}

// Pad a voice event array with rests so durations sum to targetBeats
export function padVoice(events, targetBeats = 4) {
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

// Draw ties between consecutive notes with matching tie:start → tie:end.
// Hoisted from inside renderCopy so the dependencies on VF/ctx are explicit.
export function drawStaveTies(VF, ctx, tieInfos) {
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

// Renders a single copy of the score into the given VexFlow context.
// Returns { beatMeta[], copyWidth } for that copy.
export function renderCopy(VF, ctx, measures, copyIdx, xStart, measureWidth, measDurations, measStartBeats) {
  const TREBLE_Y = 40;
  const BASS_Y = 210;

  const measureWidths = measures.map((m) => getMeasureWidth(m.timeSignature, false, measureWidth));
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
    const durationQ = measDurations[measIdx];

    if (measure.rh || measure.lh) {
      // === Voice format: independent RH/LH voices ===
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
        if (!tickMap.has(rt)) tickMap.set(rt, { allMidi: [], rhMidi: [], lhMidi: [], trebleIdx: null, bassIdx: null });
        const entry = tickMap.get(rt);
        entry.trebleIdx = i;
        const notes = evt.notes || [];
        const allTieEnd = notes.length > 0 && notes.every((n) => n.tie === "end");
        if (!allTieEnd) notes.forEach((n) => { entry.allMidi.push(n.midi); entry.rhMidi.push(n.midi); });
        tick += DURATION_BEATS[evt.duration] || 1;
      });

      tick = 0;
      lhEvents.forEach((evt, i) => {
        const rt = Math.round(tick * 1000) / 1000;
        if (!tickMap.has(rt)) tickMap.set(rt, { allMidi: [], rhMidi: [], lhMidi: [], trebleIdx: null, bassIdx: null });
        const entry = tickMap.get(rt);
        entry.bassIdx = i;
        const notes = evt.notes || [];
        const allTieEnd = notes.length > 0 && notes.every((n) => n.tie === "end");
        if (!allTieEnd) notes.forEach((n) => { entry.allMidi.push(n.midi); entry.lhMidi.push(n.midi); });
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
          musicalBeatInCopy: measStartBeats[measIdx] + t,
          allMidi: entry.allMidi.sort((a, b) => a - b),
          rhMidi: entry.rhMidi.sort((a, b) => a - b),
          lhMidi: entry.lhMidi.sort((a, b) => a - b),
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
        const rhMidi = (beat.rh || []).map((n) => n.midi).sort((a, b) => a - b);
        const lhMidi = (beat.lh || []).map((n) => n.midi).sort((a, b) => a - b);

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
          musicalBeatInCopy: measStartBeats[measIdx] + (beat.beat - 1),
          allMidi,
          rhMidi,
          lhMidi,
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
      .format([trebleVoice, bassVoice], getFormatWidth(measWidth, false));

    // 4.5. Reposition notes to time-proportional X across the FULL measure width.
    // Using the full measure width (not just usableWidth) ensures that the visual
    // note spacing exactly matches the scroll speed. This is critical because
    // targetTimeMs is computed from the note's visual position (xPx), so the
    // pixel spacing must be proportional to time.
    const BARLINE_PAD = 0;
    const repositionWidth = measWidth;
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
      let correctX = xOffset + BARLINE_PAD + (trebleTicks[i] / durationQ) * repositionWidth;
      if (trebleTicks[i] === 0) correctX += accPad(note);
      note.setXShift(correctX - note.getAbsoluteX());
    });
    bassNotes.forEach((note, i) => {
      note.setStave(bass);
      let correctX = xOffset + BARLINE_PAD + (bassTicks[i] / durationQ) * repositionWidth;
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
    const LYRIC_Y = TREBLE_Y + 115; // Fixed y position for all lyrics
    trebleNotes.forEach((note, i) => {
      const groupEl = ctx.openGroup("sam-note", `t-${copyIdx}-${measIdx}-${i}`);
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
    measNumEl.setAttribute("fill", "var(--muted-foreground)");
    measNumEl.textContent = measure.number;
    measGroupEl.appendChild(measNumEl);

    // Chord label underneath measure number
    if (measure.chord) {
      const chordEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      chordEl.setAttribute("x", xOffset + 5);
      chordEl.setAttribute("y", TREBLE_Y + 18);
      chordEl.setAttribute("font-size", "20");
      chordEl.setAttribute("font-family", "serif");
      chordEl.setAttribute("fill", "var(--foreground)");
      chordEl.textContent = measure.chord;
      measGroupEl.appendChild(chordEl);
    }

    beatMetaOffset += measBeatCount;
    xOffset += measWidth;
  });

  drawStaveTies(VF, ctx, tieTracker.treble);
  drawStaveTies(VF, ctx, tieTracker.bass);

  return { beatMeta, copyWidth };
}

// Play a short click sound at the given audioContext time
export function playClick(audioCtx, when, gainValue = 0.3) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = 800;
  gain.gain.setValueAtTime(gainValue, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(when);
  osc.stop(when + 0.04);
}
