// VexFlow 4.2.2 helper functions — MIDI ↔ VexFlow conversion
// VexFlow is loaded via CDN as a global: window.Vex.Flow

const NOTE_NAMES = ['c','c','d','d','e','f','f','g','g','a','a','b'];
const ACCIDENTALS = [null,'#',null,'#',null,null,'#',null,'#',null,'#',null];
const DISPLAY_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// MIDI number → VexFlow key string: 69 → "a/4"
export function midiToVexKey(midi) {
  return NOTE_NAMES[midi % 12] + '/' + (Math.floor(midi / 12) - 1);
}

// MIDI number → accidental: 73 → "#", 60 → null
export function midiAccidental(midi) {
  return ACCIDENTALS[midi % 12];
}

// MIDI number → display name: 69 → "A4", 73 → "C#5"
export function midiDisplayName(midi) {
  return DISPLAY_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

// MIDI number → clef: 59 → "bass", 60 → "treble"
export function midiToClef(midi) {
  return midi < 60 ? 'bass' : 'treble';
}

// Group consecutive 8th/16th notes for beaming
export function getBeamGroups(vexNotes) {
  const groups = [];
  let cur = [];
  for (let i = 0; i < vexNotes.length; i++) {
    const d = vexNotes[i].getDuration();
    if (d === '8' || d === '16') {
      cur.push(vexNotes[i]);
    } else {
      if (cur.length >= 2) groups.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) groups.push(cur);
  return groups;
}

// Layout constants
export const CLEF_EXTRA = 80; // extra width on first measure for clef + time sig

// Compute measure width based on note density.
// Measures with more voice events get more space; sparse measures get less.
const NOTE_PX = 50;
const MIN_MEASURE_WIDTH = 160;
export function getMeasureWidth(measure, isFirst) {
  const rhCount = (measure.rh || []).length;
  const lhCount = (measure.lh || []).length;
  // For legacy beats format, use beats array length
  const beatsCount = (measure.beats || []).length;
  const maxEvents = Math.max(rhCount, lhCount, beatsCount, 1);
  const width = Math.max(maxEvents * NOTE_PX, MIN_MEASURE_WIDTH);
  return width + (isFirst ? CLEF_EXTRA : 0);
}

// Formatter justification width — accounts for clef/time sig on first measure
export function getFormatWidth(measWidth, isFirst) {
  return isFirst ? measWidth - 100 : measWidth - 30;
}

// Color all SVG elements for a beat event
// beatEvent: { svgEls: SVGElement[] }
// color: CSS color string, e.g. '#16a34a' (green), '#dc2626' (red)
export function colorBeatEls(beatEvent, color) {
  if (!beatEvent?.svgEls) return;
  beatEvent.svgEls.forEach((el) => {
    // Each svgEl is a <g> group — color all child paths/rects/lines
    const children = el.querySelectorAll('*');
    children.forEach((child) => {
      child.setAttribute('fill', color);
      child.setAttribute('stroke', color);
    });
  });
}
