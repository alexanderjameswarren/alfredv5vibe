// VexFlow 4.2.2 helper functions — MIDI ↔ VexFlow conversion
// VexFlow is loaded via CDN as a global: window.Vex.Flow

const NOTE_NAMES = ['c','c','d','d','e','f','f','g','g','a','a','b'];
const ACCIDENTALS = [null,'#',null,'#',null,null,'#',null,'#',null,'#',null];
const DISPLAY_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// MIDI number → VexFlow key string: 69 → "a/4" (always sharps)
export function midiToVexKey(midi) {
  return NOTE_NAMES[midi % 12] + '/' + (Math.floor(midi / 12) - 1);
}

// MIDI number → accidental: 73 → "#", 60 → null (always sharps)
export function midiAccidental(midi) {
  return ACCIDENTALS[midi % 12];
}

// Parse note name like "Eb4", "C#4", "Bb4", "C4" → { letter, accidental, octave }
function parseNoteName(name) {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2})?(\d+)$/.exec(name);
  if (!m) return null;
  return { letter: m[1].toLowerCase(), accidental: m[2] || null, octave: m[3] };
}

// Note object → VexFlow key: { name: "Eb4" } → "eb/4", falls back to MIDI
export function noteToVexKey(note) {
  if (note.name) {
    const parsed = parseNoteName(note.name);
    if (parsed) return `${parsed.letter}${parsed.accidental || ''}/${parsed.octave}`;
  }
  return midiToVexKey(note.midi);
}

// Note object → accidental string or null: { name: "Eb4" } → "b"
export function noteAccidental(note) {
  if (note.name) {
    const parsed = parseNoteName(note.name);
    if (parsed) return parsed.accidental;
  }
  return midiAccidental(note.midi);
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

// Fixed measure width — scaled by time signature duration relative to 4/4.
const DEFAULT_MEASURE_WIDTH = 300;
export function getMeasureWidth(timeSig, isFirst, fixedWidth) {
  const base = fixedWidth || DEFAULT_MEASURE_WIDTH;
  const durationQ = timeSig ? (timeSig.beats / timeSig.beatType) * 4 : 4;
  const scaled = base * (durationQ / 4);
  // Enforce minimum width so VexFlow can render notes without overlap
  const clamped = Math.max(scaled, 100);
  return clamped + (isFirst ? CLEF_EXTRA : 0);
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
  for (const el of beatEvent.svgEls) {
    const targets = el.tagName === 'g'
      ? el.querySelectorAll('path, line, rect, ellipse, polygon')
      : [el];
    for (const t of targets) {
      t.style.fill = color;
      t.style.stroke = color;
    }
  }
}
