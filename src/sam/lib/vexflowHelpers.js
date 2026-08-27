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

// Group consecutive 8th/16th notes for beaming.
// When parallel `events` are passed, tuplet boundaries break the beam:
// every `position: "start"` opens a fresh group and every `position: "end"`
// closes it. This keeps each tuplet visually distinct rather than fusing
// adjacent triplets into one long beam.
export function getBeamGroups(vexNotes, events = null) {
  const groups = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 2) groups.push(cur);
    cur = [];
  };
  for (let i = 0; i < vexNotes.length; i++) {
    const note = vexNotes[i];
    const d = note.getDuration();
    const isRest = note.getNoteType?.() === 'r';
    const tupPos = events?.[i]?.tuplet?.position;
    if (tupPos === 'start') flush();
    // Beam only real notes — rests have getDuration() === '8'/'16' too but
    // shouldn't extend the beam (standard engraving breaks the beam at a rest).
    if (!isRest && (d === '8' || d === '16')) {
      cur.push(note);
    } else {
      flush();
    }
    if (tupPos === 'end') flush();
  }
  flush();
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

// ---------------------------------------------------------------------------
// M5 — one notehead per staff position.
//
// The continuation rule (see noteDuplicates.js) deliberately keeps same-pitch
// pairs in the data: one voice holding a tied note while another strikes that
// pitch fresh. Moonlight m60 `C#4 + C#4:end` and Someone Like You m27
// `F#4 + F#4:end` are the corpus cases, and playback depends on both copies
// being there.
//
// Correct engraving still draws ONE notehead. Handing VexFlow two identical
// keys makes it draw two, displacing one sideways off the staff line — the
// smear that prompted this whole investigation. So the render layer collapses
// them, and the data is left exactly as it is.
//
// Collapsing keys on the VEXFLOW KEY, not on `midi`: an enharmonic pair
// (C#4 and Db4, both midi 61) sits on two different staff lines and is two
// noteheads, correctly. Same key string means same notehead position, which is
// the only thing that matters here.
// ---------------------------------------------------------------------------

/**
 * @param notes  an event's notes[]
 * @returns {{ keys: string[], heads: object[], keyIndexFor: number[] }}
 *   `keys`        — deduped VexFlow key strings, in first-appearance order.
 *   `heads`       — the first note object at each key, for accidentals.
 *   `keyIndexFor` — parallel to `notes`: which key index each note renders on.
 *                   Two notes sharing a notehead share an index.
 */
export function toVexKeys(notes) {
  const keys = [];
  const heads = [];
  const keyIndexFor = [];
  const seen = new Map();

  for (const n of notes || []) {
    const key = noteToVexKey(n);
    const existing = seen.get(key);
    if (existing !== undefined) {
      keyIndexFor.push(existing);
      continue;
    }
    seen.set(key, keys.length);
    keyIndexFor.push(keys.length);
    keys.push(key);
    heads.push(n);
  }

  return { keys, heads, keyIndexFor };
}

/**
 * Tie endpoints for one event, addressed by RENDERED key index.
 *
 * Deduped: when two notes collapse onto one notehead and both carry the same
 * tie direction, that is one tie, not two. Feeding VexFlow's StaveTie the same
 * index twice draws the arc twice.
 */
export function tieEndpoints(notes, keyIndexFor) {
  const starts = [];
  const ends = [];
  const seenStart = new Set();
  const seenEnd = new Set();

  (notes || []).forEach((n, i) => {
    const keyIdx = keyIndexFor[i];
    if (keyIdx === undefined) return;
    const id = `${keyIdx}:${n.midi}`;
    if ((n.tie === "start" || n.tie === "both") && !seenStart.has(id)) {
      seenStart.add(id);
      starts.push({ keyIdx, midi: n.midi });
    }
    if ((n.tie === "end" || n.tie === "both") && !seenEnd.has(id)) {
      seenEnd.add(id);
      ends.push({ keyIdx, midi: n.midi });
    }
  });

  return { starts, ends };
}
