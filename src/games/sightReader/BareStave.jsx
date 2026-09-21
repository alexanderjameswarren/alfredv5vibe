import React, { useEffect, useRef, useState } from "react";
import { noteAccidental, toVexKeys } from "../../sam/lib/vexflowHelpers";
import {
  CLEF_RANGES,
  ROOTS,
  chordNotes,
  chordRootOctave,
  diatonicOf,
  pitchPool,
} from "./music";
import { CHORD_TYPE_IDS } from "./chordTypes";

// One stave, one clef, one whole note or chord. Nothing else.
//
// No time signature, no brace, no second stave, no ties, no tuplets, no lyrics,
// no fingerings, no geometry capture, no tap handling. This is the third
// VexFlow renderer in a codebase that already has two, and that duplication is
// a real cost taken deliberately: ScoreRenderer.jsx is 795 lines that always
// draw a braced grand staff with a time signature and only accept measure
// arrays, so making it optional would mean threading conditions through tie
// tracking, geometry capture and the fingering and ghost overlays in order to
// use about 5% of it — and the regression risk would land on the live practice
// screens. Nothing in src/sam/ is touched by this file.
//
// VEXFLOW IS A CDN GLOBAL, loaded at public/index.html:44 (4.2.2), and is read
// as `window.Vex?.Flow` exactly as every other consumer reads it. It is never
// imported, it is not in package.json, and it is `undefined` under Jest — which
// is why this component is verified by eye in the browser and the music logic
// behind it is what carries tests.

const STAVE_LINE_COUNT = 5;

// Horizontal layout, in render-space pixels.
//
// The stave is short and the format width deliberately narrow, which is what
// puts the note just after the clef with a small gap. DO NOT x-shift the note
// afterwards to tighten it: the accidental modifier does not travel with an
// x-shift and ends up floating out by the clef, where it reads as a key
// signature — which SAM never draws. Let the formatter place it.
const STAVE_X = 2;
const STAVE_WIDTH = 168;
const FORMAT_WIDTH = 44;
const SVG_WIDTH = STAVE_X + STAVE_WIDTH + 4;

// The stave is drawn at y = 0 and the viewBox is framed around it afterwards.
// VexFlow reserves blank space above the five lines (`space_above_staff_ln`),
// so the y handed to `new VF.Stave()` is NOT where the top line lands — and
// rather than hardcode that offset, the frame is computed from the line
// positions the stave itself reports. A generous canvas so nothing is cropped
// before the viewBox takes over; the viewBox is what actually frames it.
const STAVE_Y = 0;
const RENDER_CANVAS_HEIGHT = 240;

// Room for a notehead's own height plus an accidental's ascender and descender.
// A flat reaches further above its notehead centre than the notehead does, and
// a double flat further still. This is a property of the glyphs, not of the
// pitch pools, so it is the one number here that is a constant rather than
// derived.
const GLYPH_MARGIN_PX = 16;

/**
 * How far past the staff the most extreme prompt reaches, in diatonic steps.
 *
 * DERIVED, NOT HARDCODED. C2 in the bass pool sits four steps below the bottom
 * line and its notehead and ledger line were being drawn outside the viewBox
 * and clipped. Rather than pick a new number by eye, this walks everything the
 * renderer can be asked to draw — every pitch in both pools AND every one of
 * the eighty-four chords in both clefs — and measures the worst overshoot. Widen
 * a pool in music.js and the window follows on its own.
 *
 * ONE SYMMETRIC VALUE, shared by both clefs. The pools are near-symmetric
 * already (treble reaches four steps above and three below, bass the mirror of
 * that, and no chord exceeds two either way), so taking the single worst case
 * costs a few pixels and buys the thing that matters: identical geometry in
 * both clefs. If the window or the stave position changed with the clef, the
 * stave would visibly jump between prompts — distracting in a drill where the
 * clef alternates constantly.
 *
 * Runs once at module load: fifty-odd pool pitches and 168 chords, all pure.
 */
function deriveOvershootSteps() {
  let worst = 0;

  for (const clef of ["treble", "bass"]) {
    const bottomLine = diatonicOf(CLEF_RANGES[clef].staffLo);
    const topLine = diatonicOf(CLEF_RANGES[clef].staffHi);

    // Everything this renderer can be asked to draw in this clef, gathered
    // before measuring rather than measured inside the walk — a closure over
    // the running maximum would be a function declared in a loop.
    const drawable = pitchPool(clef).map((pitch) => pitch.name);
    for (const root of ROOTS) {
      for (const quality of CHORD_TYPE_IDS) {
        const octave = chordRootOctave(root, quality, clef);
        for (const note of chordNotes(root, quality, octave)) drawable.push(note.name);
      }
    }

    for (const name of drawable) {
      const position = diatonicOf(name);
      worst = Math.max(worst, position - topLine, bottomLine - position);
    }
  }

  return worst;
}

const OVERSHOOT_STEPS = deriveOvershootSteps();

/**
 * @param {object} props
 * @param {"treble"|"bass"} props.clef
 * @param {{duration: string, notes: Array<{midi: number, name: string}>}} props.event
 *   One VoiceEvent in SAM's own shape. `notes` of length 1 is a single note;
 *   more than one is a chord.
 */
export default function BareStave({ clef, event }) {
  const containerRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !event?.notes?.length) return;

    const VF = window.Vex?.Flow;
    if (!VF) {
      // The script tag did not load — offline, blocked, or the CDN is down.
      // A readable fallback rather than a thrown error and a blank tab: the
      // answer text and the Next button below are still usable, so the page
      // should degrade rather than die.
      setFailed(true);
      return;
    }
    setFailed(false);

    container.innerHTML = "";

    const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
    renderer.resize(SVG_WIDTH, RENDER_CANVAS_HEIGHT);
    const ctx = renderer.getContext();

    // One stave, one clef. No `addTimeSignature` and no StaveConnector — the
    // two calls that would turn this back into a score.
    const stave = new VF.Stave(STAVE_X, STAVE_Y, STAVE_WIDTH);
    stave.addClef(clef);
    stave.setContext(ctx).draw();

    // `toVexKeys` dedupes by VexFlow key string and hands back `heads` — the
    // first note at each distinct key — so a chord can never stack two
    // accidentals on one notehead. Reused rather than re-derived, so this
    // renderer and the two in src/sam/ cannot disagree about how a pitch is
    // spelled. `clef` is load-bearing on StaveNote: it decides which line each
    // key lands on, so a bass prompt drawn with the default treble clef would
    // put every note in the wrong place.
    const { keys, heads } = toVexKeys(event.notes);
    const staveNote = new VF.StaveNote({ clef, keys, duration: event.duration });

    // Accidentals attach to their notehead as modifiers, never as a key
    // signature. `addKeySignature` is called nowhere in SAM and is not called
    // here. Same idiom as ScoreRenderer.jsx:274.
    heads.forEach((note, keyIndex) => {
      const accidental = noteAccidental(note);
      if (accidental) staveNote.addModifier(new VF.Accidental(accidental), keyIndex);
    });

    // Non-strict, so the voice does not have to add up to a bar. There is no
    // bar here — there is no time signature to be measured against.
    const voice = new VF.Voice({ num_beats: 4, beat_value: 4 });
    voice.setStrict(false);
    voice.addTickables([staveNote]);

    new VF.Formatter().joinVoices([voice]).format([voice], FORMAT_WIDTH);
    voice.draw(ctx, stave);

    // Frame the drawing around where the five lines actually landed.
    //
    // The staff spans eight diatonic steps from bottom line to top line (E4 up
    // to F5 is E-F-G-A-B-C-D-E-F), so the pixels-per-step falls out of the line
    // span rather than assuming VexFlow's 10px default line spacing. Equal
    // space above and below means the stave is exactly centred, and because
    // OVERSHOOT_STEPS is a single value across both clefs, the frame is
    // identical for treble and bass — the stave does not move when the clef
    // changes.
    const topLineY = stave.getYForLine(0);
    const bottomLineY = stave.getYForLine(STAVE_LINE_COUNT - 1);
    const lineSpan = bottomLineY - topLineY;
    const stepPx = lineSpan / ((STAVE_LINE_COUNT - 1) * 2);
    const space = OVERSHOOT_STEPS * stepPx + GLYPH_MARGIN_PX;

    // Size to the container rather than to the fixed pixel count VexFlow
    // writes, so the stave scales with the phone it is being read on. The
    // viewBox keeps the drawing's own coordinates intact; only the box it is
    // painted into changes.
    const svg = container.querySelector("svg");
    if (svg) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute(
        "viewBox",
        `0 ${topLineY - space} ${SVG_WIDTH} ${lineSpan + space * 2}`
      );
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.width = "100%";
      svg.style.height = "auto";
      svg.style.display = "block";
      // The viewBox is sized to contain every prompt, so nothing should ever
      // reach past it — but overflow is left visible so that if something one
      // day does, it shows up as a note hanging over the edge rather than as a
      // silently half-drawn notehead, which is the failure this geometry was
      // written to fix.
      svg.style.overflow = "visible";
    }
  }, [clef, event]);

  if (failed) {
    return (
      <div className="p-4 text-sm text-muted-foreground bg-card border border-border rounded-lg">
        Notation could not be drawn — VexFlow did not load. Check the connection
        and reload.
      </div>
    );
  }

  return <div ref={containerRef} className="w-full" aria-hidden="true" />;
}
