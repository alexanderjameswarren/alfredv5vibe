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
import { getEventBeats } from "./measureUtils";

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
  for (const evt of events) total += getEventBeats(evt) || 1;
  // Tuplet members contribute 1/3 (or 1/5, etc.) beats each, and 1/3 has no
  // exact float representation. Round the running total to a sensible
  // precision so the residual doesn't end up as e.g. 3.9999999 or 0.0001.
  total = Math.round(total * 1000) / 1000;
  const result = [...events];
  let remaining = targetBeats - total;
  const restDurs = ["w", "h", "q", "8", "16"];
  const restVals = [4, 2, 1, 0.5, 0.25];
  while (remaining > 0.001) {
    let pushed = false;
    for (let j = 0; j < restDurs.length; j++) {
      if (remaining >= restVals[j] - 0.001) {
        result.push({ duration: restDurs[j], notes: [] });
        remaining -= restVals[j];
        pushed = true;
        break;
      }
    }
    // Safety break: a residual smaller than the smallest rest duration
    // (e.g., a stray triplet fragment) can't be padded with any available
    // rest. Drop out rather than spinning forever; the leftover beat
    // accounts for < 1/16 of a quarter and is visually negligible.
    if (!pushed) break;
  }
  return result;
}

// Minimum tie span (render-space px) so that very-tight back-to-back notes
// (e.g., consecutive 16ths whose noteheads sit ~one notehead-width apart) still
// produce a readable arc rather than a degenerate near-zero-width bezier. This
// is cosmetic widening: the tie's endpoints no longer attach strictly to the
// notehead edges for narrow ties. The alternative is invisible ties, which is
// worse. Wider ties (anything ≥ this span naturally) are unaffected.
//
// 25 render-space px ≈ 31 display px at SCORE_SCALE = 1.25 — visible as an
// unambiguous arc rather than a tiny chevron. Empirically, several "should-be-
// wide" cross-barline ties were also coming out with natural span ≤ 0 (likely
// because VexFlow's getTieRightX/getTieLeftX include the note's `width` term
// in a way that overlaps with the next note's left bound), so this also covers
// those cases.
const MIN_TIE_SPAN_PX = 25;

// Section label engraving (Verse 1 / Chorus / Bridge / etc.). Drawn as raw
// SVG <text> in render-space units — matches how measure numbers and chord
// labels are rendered today; the outer viewBox scales everything together.
const SECTION_FONT_SIZE = 12;
const SECTION_LINE_HEIGHT = 14;
const SECTION_OFFSET_ABOVE_STAFF = 16;
const SECTION_X_INSET = 2;
// Empirical char-width ratio for sans-serif at the section font size — used
// for a greedy word-wrap that avoids the cost of per-substring SVG metrics.
const SECTION_CHAR_WIDTH_RATIO = 0.55;

function wrapSectionText(text, maxWidth, fontSize) {
  const approxCharWidth = fontSize * SECTION_CHAR_WIDTH_RATIO;
  const maxChars = Math.max(1, Math.floor(maxWidth / approxCharWidth));
  if (text.length <= maxChars) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [text];
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= maxChars) current += " " + word;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Draw a section label (e.g. "Verse 1") above one measure.
 *
 *   svgParent   — SVG element to append the <text> nodes into. In scoreRender
 *                 this is the per-measure `<g>` wrapper; in ScoreRenderer it's
 *                 the root `<svg>`. Both consume render-space coordinates.
 *   xOffset     — left edge of the measure (render space)
 *   measWidth   — width of the measure (render space) — used for wrap width
 *   staffTopY   — Y of the top staff line (render space)
 *   sectionText — string, or nullish to no-op
 *
 * Multiple wrapped lines stack upward so the bottom line sits closest to the
 * staff and the label grows away from it — the staff-relative baseline stays
 * stable regardless of label length.
 */
export function drawSectionLabel(svgParent, xOffset, measWidth, staffTopY, sectionText) {
  if (!sectionText) return;
  const lines = wrapSectionText(sectionText, measWidth, SECTION_FONT_SIZE);
  const bottomBaselineY = staffTopY - SECTION_OFFSET_ABOVE_STAFF;
  for (let i = 0; i < lines.length; i++) {
    const lineY = bottomBaselineY - (lines.length - 1 - i) * SECTION_LINE_HEIGHT;
    const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    textEl.setAttribute("x", xOffset + SECTION_X_INSET);
    textEl.setAttribute("y", lineY);
    textEl.setAttribute("font-size", SECTION_FONT_SIZE);
    textEl.setAttribute("font-family", "sans-serif");
    textEl.setAttribute("fill", "black");
    textEl.textContent = lines[i];
    svgParent.appendChild(textEl);
  }
}

// Draw ties between consecutive notes with matching tie:start → tie:end.
// Hoisted from inside renderCopy so the dependencies on VF/ctx are explicit.
// For narrow ties, expand symmetrically via render_options.{first,last}_x_shift
// so the apex stays centered between the noteheads while the arc is readable.
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
      const tie = new VF.StaveTie({
        first_note: first.vexNote,
        last_note: second.vexNote,
        first_indices: firstIndices,
        last_indices: lastIndices,
      });

      // VexFlow's getTieRightX/getTieLeftX add `width/2` to the position,
      // where `width` is the formatter's allocated tickable width — often
      // much larger than the visible notehead (e.g., the last note in a
      // voice gets the remaining measure space). That pushes the tie
      // endpoints well past the actual noteheads. Anchor directly to the
      // visual notehead edges via VexFlow's own getNoteHeadBeginX /
      // getNoteHeadEndX helpers, which use `getAbsoluteX() + x_shift` and
      // therefore land at the actual rendered notehead bounds.
      const firstNote = first.vexNote;
      const lastNote = second.vexNote;
      const visualFirstX = firstNote.getNoteHeadEndX();
      const visualLastX = lastNote.getNoteHeadBeginX();
      const span = visualLastX - visualFirstX;

      // VexFlow's renderTie will still call getTieRightX/getTieLeftX
      // internally for first_x_px / last_x_px. Use first_x_shift /
      // last_x_shift to shove the rendered endpoints back to where we want.
      const builtinFirstX = firstNote.getTieRightX();
      const builtinLastX = lastNote.getTieLeftX();
      let firstShift = visualFirstX - builtinFirstX;
      let lastShift = visualLastX - builtinLastX;

      // Cosmetic widening for narrow ties (consecutive 16ths, etc.) so the
      // arc remains readable rather than collapsing to a near-zero-width
      // bezier. Push both endpoints outward symmetrically from the now-
      // correct midpoint between the actual noteheads.
      if (span < MIN_TIE_SPAN_PX) {
        const extra = MIN_TIE_SPAN_PX - span;
        firstShift -= extra / 2;
        lastShift += extra / 2;
      }

      tie.render_options.first_x_shift = firstShift;
      tie.render_options.last_x_shift = lastShift;

      tie.setContext(ctx).draw();
    }
  }
}

// Time-proportional layout helper for one staff's notes. Repositions each
// note via setXShift so its X reflects the tick onset within the measure
// rather than the formatter's packed positions, then patches the position-
// query methods (getModifierStartXY, getTieRightX, getTieLeftX) to include
// the resulting x_shift. VexFlow's defaults DON'T include x_shift for
// LEFT/ABOVE/BELOW modifier positions (accidentals end up at the wrong X)
// and don't include it for getTieRightX/getTieLeftX (ties attach at the
// clustered formatter positions instead of the visual noteheads).
//
// IMPORTANT: VexFlow's getModifierStartXY for POSITION.RIGHT ALREADY
// includes `this.x_shift` (see stavenote.ts:826). We must NOT add it again
// or modifiers like Dot (which uses POSITION.RIGHT) end up double-shifted.
// The conditional below excludes RIGHT from the patch for that reason.
//
// MODIFIER_POSITION_RIGHT = 2 is the value of VF.Modifier.Position.RIGHT in
// VexFlow 4.x's Position enum. Hardcoded to avoid passing VF through this
// helper; cross-check if the VexFlow major version changes.
const MODIFIER_POSITION_RIGHT = 2;
// Walk a voice's events + their parallel StaveNotes, group consecutive
// tuplet members (start → middle... → end), and wrap each complete group
// in a VF.Tuplet object. Returns an array of Tuplets ready to be drawn.
//
// Robustness: a "start" position closes any previously-open group; a group
// auto-finalizes once it reaches `actual` members (handles the case where
// the importer assigned a stop+start note's position to "start" of the new
// group, leaving the previous group's explicit "end" marker missing).
// Stray middle/end events without an open group are ignored — malformed
// data should not crash the renderer.
//
// The returned tuplets observe their notes' final positions at draw time,
// so they can be constructed before or after formatting — drawing must
// happen after format() so the underlying notes are positioned.
export function buildTuplets(VF, events, notes) {
  const tuplets = [];
  let group = null;
  let meta = null;

  const finalize = () => {
    if (group && meta && group.length >= meta.actual) {
      // Drop the bracket when every member is beamable ('8' / '16') — the
      // beam already groups them visually, and VexFlow's bracket tip pokes
      // left of the first note, bleeding past the barline when a tuplet
      // starts at the leading edge of a measure. Mirrors `getBeamGroups`'
      // beamable set; longer durations (q, h) keep the bracket.
      const beamed = group.every((n) => {
        const d = n.getDuration();
        return d === "8" || d === "16";
      });
      tuplets.push(new VF.Tuplet(group, {
        num_notes: meta.actual,
        notes_occupied: meta.normal,
        bracketed: !beamed,
      }));
    }
    group = null;
    meta = null;
  };

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    const note = notes[i];
    if (!evt?.tuplet) {
      finalize();
      continue;
    }
    if (evt.tuplet.position === "start") {
      finalize();
      group = [note];
      meta = evt.tuplet;
    } else if (group) {
      group.push(note);
      if (evt.tuplet.position === "end" || group.length >= meta.actual) {
        finalize();
      }
    }
  }
  finalize();
  return tuplets;
}

export function applyTimeProportionalLayout({ notes, ticks, durationQ, xOffset, measWidth, stave }) {
  const BARLINE_PAD = 0;
  const ACC_W = { '#': 11, 'b': 9, 'n': 8, '##': 14, 'bb': 14 };
  const accPad = (note) => {
    let w = 0;
    for (const mod of note.getModifiers()) {
      if (mod.type in ACC_W) w = Math.max(w, ACC_W[mod.type]);
    }
    return w > 0 ? w + 3 : 0;
  };

  notes.forEach((note, i) => {
    note.setStave(stave);
    let correctX = xOffset + BARLINE_PAD + (ticks[i] / durationQ) * measWidth;
    if (ticks[i] === 0) correctX += accPad(note);
    note.setXShift(correctX - note.getAbsoluteX());
  });

  notes.forEach((note) => {
    const _origMod = note.getModifierStartXY;
    note.getModifierStartXY = function(pos, idx, opts) {
      const pt = _origMod.call(this, pos, idx, opts);
      if (pos !== MODIFIER_POSITION_RIGHT) pt.x += this.getXShift();
      return pt;
    };
    const _origTieRight = note.getTieRightX;
    note.getTieRightX = function() {
      return _origTieRight.call(this) + this.getXShift();
    };
    const _origTieLeft = note.getTieLeftX;
    note.getTieLeftX = function() {
      return _origTieLeft.call(this) + this.getXShift();
    };
  });
}

// ── Fingering geometry contract ──────────────────────────────────────────
// Pure extraction of per-event render geometry from already-formatted VexFlow
// StaveNotes. NO drawing, NO layout decisions, NO side effects — it only reads
// positions the formatter (and the time-proportional pass) have already set.
//
// Both renderers call this against their OWN formatted output: ScoreRenderer.jsx
// (edit/stopped view, where fingering entry happens) and renderCopy (playback
// view). They format at different widths, so the x/y values differ between
// views; what is stable is the STRUCTURE — one entry per event, in event order,
// carrying (measureNum, hand, index). Fingerings render in BOTH views (entry in
// the edit screen, cueing at the piano during playback), which is why this is a
// shared helper rather than logic inside either renderer.
//
// Entry shape (the contract the multi-voice rewrite must preserve; adding a
// `voice` field later is expected and fine):
//   { measureNum, hand, index, x, staveTop, staveBottom, noteheadYs[], isRest }
//   index      — position in `notes`; for voice-format events this equals the
//                rh_index / lh_index (padding rests occupy the tail indices)
//   x          — notehead center x, render-space, including the time-
//                proportional x_shift
//   noteheadYs — one y per notehead, ordered LOW pitch → HIGH pitch, so
//                note_index 0 is the lowest notehead; empty for rests
//
// `notes` must be 1:1 with the hand's event array (as both renderers build it),
// so the array index carries straight through to `index`.
export function buildGeometry({ measureNum, hand, stave, notes }) {
  // 5-line staff: line 0 is the top line, line 4 the bottom. These bound the
  // badge placement and tap-zone vertical extent in later steps.
  const staveTop = stave.getYForLine(0);
  const staveBottom = stave.getYForLine(4);

  return notes.map((note, index) => {
    const isRest = note.isRest();

    // Notehead center x. getNoteHeadBeginX/EndX already fold in getAbsoluteX() +
    // x_shift (see drawStaveTies), so they track the visually-rendered notehead
    // rather than the formatter's clustered position. Rests have no notehead —
    // use the tickable's shifted x.
    const x = isRest
      ? note.getAbsoluteX() + note.getXShift()
      : (note.getNoteHeadBeginX() + note.getNoteHeadEndX()) / 2;

    // One y per notehead, low pitch → high pitch. SVG y grows downward, so a
    // lower pitch sits at a LARGER y: sort descending to put the lowest notehead
    // first (note_index 0).
    const noteheadYs = isRest
      ? []
      : noteheadYsFor(note, stave).slice().sort((a, b) => b - a);

    return { measureNum, hand, index, x, staveTop, staveBottom, noteheadYs, isRest };
  });
}

// Per-notehead Y values for a StaveNote. Prefer VexFlow's own getYs() (populated
// once the note has been drawn / preformatted); fall back to deriving each y
// from its key line via the stave when getYs() isn't ready. The fallback keeps
// buildGeometry safe to call straight after format(), without a draw pass.
function noteheadYsFor(note, stave) {
  try {
    const ys = note.getYs();
    if (ys && ys.length) return ys;
  } catch {
    // getYs() throws when ys haven't been computed yet — fall through.
  }
  return note.getKeyProps().map((kp) => stave.getYForNote(kp.line));
}

// Renders a single copy of the score into the given VexFlow context.
// Returns { beatMeta[], copyWidth, geometry[], labelEls[] } for that copy.
// `geometry` is this copy's fingering geometry (buildGeometry entries, with this
// copy's x offsets); `labelEls` are the measure-number/chord <text> nodes used by
// the overlay for badge collision. ScrollEngine concatenates them across copies.
export function renderCopy(VF, ctx, measures, copyIdx, xStart, measureWidth, measDurations, measStartBeats) {
  const TREBLE_Y = 40;
  const BASS_Y = 210;

  const measureWidths = measures.map((m) => getMeasureWidth(m.timeSignature, false, measureWidth));
  const copyWidth = measureWidths.reduce((a, b) => a + b, 0);

  const beatMeta = [];
  const geometry = [];
  const labelEls = [];
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
    let voiceTuplets = []; // VF.Tuplet objects (drawn after notes/beams)
    let trebleBeamEvents = null; // parallel events for tuplet-aware beam breaks
    let bassBeamEvents = null;
    const durationQ = measDurations[measIdx];

    if (measure.rh || measure.lh) {
      // === Voice format: independent RH/LH voices ===
      const rhEvents = padVoice(measure.rh || [], durationQ);
      const lhEvents = padVoice(measure.lh || [], durationQ);
      trebleBeamEvents = rhEvents;
      bassBeamEvents = lhEvents;

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
        tick += getEventBeats(evt) || 1;
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
        tick += getEventBeats(evt) || 1;
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
      for (const evt of rhEvents) { trebleTicks.push(tt); tt += getEventBeats(evt) || 1; }
      tt = 0;
      for (const evt of lhEvents) { bassTicks.push(tt); tt += getEventBeats(evt) || 1; }

      // Collect tuplet groups from rhEvents/lhEvents (each parallel to its
      // StaveNote array). Drawing happens after format + note draw below.
      voiceTuplets = [
        ...buildTuplets(VF, rhEvents, trebleNotes),
        ...buildTuplets(VF, lhEvents, bassNotes),
      ];
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

    // 3. Create beams (after addTickables, before draw — suppresses flags).
    //    Parallel events (voice format only) let getBeamGroups break the beam
    //    at tuplet boundaries so adjacent triplets render as separate beams.
    const trebleBeams = getBeamGroups(trebleNotes, trebleBeamEvents).map((g) => new VF.Beam(g));
    const bassBeams = getBeamGroups(bassNotes, bassBeamEvents).map((g) => new VF.Beam(g));

    // 4. Format — align rhythmic positions across both staves
    new VF.Formatter()
      .joinVoices([trebleVoice])
      .joinVoices([bassVoice])
      .format([trebleVoice, bassVoice], getFormatWidth(measWidth, false));

    // 4.5/4.6. Reposition notes to time-proportional X across the FULL measure
    // width AND patch position-query methods so accidentals/ties read the
    // visual position rather than the formatter's clustered X. Using the full
    // measure width (not just usableWidth) keeps visual note spacing in step
    // with scroll speed — targetTimeMs is computed from xPx, so pixel spacing
    // must be proportional to time.
    applyTimeProportionalLayout({
      notes: trebleNotes, ticks: trebleTicks, durationQ, xOffset, measWidth, stave: treble,
    });
    applyTimeProportionalLayout({
      notes: bassNotes, ticks: bassTicks, durationQ, xOffset, measWidth, stave: bass,
    });

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

    // 7. Draw tuplet brackets + labels. Tuplets observe their notes' final
    // positions at draw time, so this must run after format + note draw.
    // Drawn before measGroupEl wrapping so the SVG elements get captured
    // into the measure's <g> alongside notes/beams.
    voiceTuplets.forEach((t) => t.setContext(ctx).draw());

    // Fingering geometry (spec §5) — same shared helper the edit view uses, read
    // after the note draw so notehead positions are final. treble = rh, bass = lh.
    geometry.push(
      ...buildGeometry({ measureNum: measure.number, hand: "rh", stave: treble, notes: trebleNotes }),
      ...buildGeometry({ measureNum: measure.number, hand: "lh", stave: bass, notes: bassNotes }),
    );

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
    // Stopped UI: show source measure in parens when playback flattening
    // has renumbered it (spec §M4). Für Elise m1 pickup is source "0",
    // Entertainer's second half renumbers after repeats. When they match
    // (a normal-form measure) or sourceMeasure is absent (pre-M4 stored
    // song), show the bare number.
    measNumEl.textContent =
      measure.sourceMeasure != null && String(measure.sourceMeasure) !== String(measure.number)
        ? `${measure.number} (${measure.sourceMeasure})`
        : String(measure.number);
    measGroupEl.appendChild(measNumEl);
    labelEls.push(measNumEl); // collision target for fingering badges

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
      labelEls.push(chordEl); // collision target for fingering badges
    }

    // Section label (Verse 1 / Chorus / etc.) above measure number, wrapped
    // to the measure width. Appended into the measure's <g> so it scrolls
    // with the measure and lands in the same hide/show flow as notes/beams.
    drawSectionLabel(measGroupEl, xOffset, measWidth, TREBLE_Y, measure.section);

    beatMetaOffset += measBeatCount;
    xOffset += measWidth;
  });

  drawStaveTies(VF, ctx, tieTracker.treble);
  drawStaveTies(VF, ctx, tieTracker.bass);

  return { beatMeta, copyWidth, geometry, labelEls };
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
