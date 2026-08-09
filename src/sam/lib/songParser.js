// MusicXML → Sam internal JSON parser
//
// Three-phase architecture (spec §3.6, spec §3.3):
//   Phase A — parse every measure into an intermediate voice-map form
//             (Map<`staff:voice`, [{onset, dur, notes, rest, tuplet?, ...}]>);
//             tally voice → staff note counts across the whole song
//   Phase B — compute song-level hand assignment: for each voice number,
//             pick the majority staff; FLAG if <60% majority; single-staff
//             source falls back to a per-note midi<60 rule
//   Phase C — reassign each voice's events to its majority hand's staff,
//             then run mergeStaff per hand and lower the timeline back into
//             SAM voice format via durations.fromTimeline
//
// Every consumer of the parsed song object sees the same shape as before:
//   { title, artist, defaultBpm, key, timeSignature, measures: [{ number,
//     rh, lh, timeSignature }] } plus an optional parseWarnings array on
//   the song for import-time surfacing (spec §M6 wires it into the UI).
//
// The old per-measure buildVoice codepath is deleted, not patched — it made
// hand assignment per-note and could not represent cross-staff voices per
// spec §3.6. mergeStaff (this file's port from tools/sam-tools/lib/xmlTruth.js)
// replaces it, with two deviations from the reference documented at the
// call site: (a) tuplet is carried onto each segment so fromTimeline can
// reconstruct token+ratio, and (b) the tie chain is corrected so N-way
// splits don't produce orphan `end`s.

import {
  beatsToTokens,
  fromTimeline,
  sumEvents,
  ONSET_EPS,
} from "./durations.js";
import { resolvePlaybackOrder } from "./playbackOrder.js";

const EPS = ONSET_EPS;

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchToMidi(step, alter, octave) {
  return (parseInt(octave, 10) + 1) * 12 + STEP_SEMITONES[step] + (parseInt(alter, 10) || 0);
}

function noteName(step, alter) {
  const a = parseInt(alter, 10) || 0;
  const acc = { 1: "#", 2: "##", "-1": "b", "-2": "bb" }[a] || "";
  return step + acc;
}

const KEY_NAMES = {
  "-7": "Cb major", "-6": "Gb major", "-5": "Db major", "-4": "Ab major",
  "-3": "Eb major", "-2": "Bb major", "-1": "F major", "0": "C major",
  "1": "G major", "2": "D major", "3": "A major", "4": "E major",
  "5": "B major", "6": "F# major", "7": "C# major",
};

// M6 — tier-A pitch-affecting notations the parser does not currently
// implement. Their presence is detected per measure in Phase A; Phase B
// emits a single parseWarning per tag per song naming which measures
// contained it. Only <mordent> and <inverted-mordent> are corpus-
// reachable today (Bach Invention); the rest are defensive so future
// fixtures don't produce silent drops.
//
// Kept in sync with tools/sam-tools/lib/xmlTruth.js NOTATION_TIERS.A
// (post spec §5 amendment 2026-08-05: octave-shift and arpeggiate
// removed from tier A after empirical verification).
const UNHANDLED_PITCH_TAGS = [
  "transpose", "trill-mark", "mordent", "inverted-mordent",
  "turn", "inverted-turn", "tremolo", "glissando", "slide", "cue",
];

// M7 — CARRIED notations. Parser stores per-measure presence + position
// (measure.notations list) and emits a parseWarning per tag naming
// each so validate.js's Group B check clears the tier-B/C finding.
// Full data extraction (pedal on/off state, dynamic value, articulation
// per note) is deferred to when a renderer needs it — spec §5 says
// CARRY = "store on the measure/event", presence records that we saw
// the tag and know its beat position, which is enough for the tag
// itself not to be silently lost. Excludes <arpeggiate>/<non-arpeggiate>
// (tier B, timing but no CARRY store yet — those still fire Group B
// unless a warning is emitted; M8 wires arpeggiate onset staggering).
const CARRIED_NOTATION_TAGS = [
  // Tier B (timing) — fermata is the corpus-reachable one
  "fermata", "metronome", "measure-style",
  "arpeggiate", "non-arpeggiate",
  // Tier C (tone/articulation)
  "pedal", "staccato", "staccatissimo", "accent", "strong-accent",
  "tenuto", "detached-legato", "dynamics", "wedge", "slur",
];

// M7 — <kind> textContent → chord-symbol suffix. music21 export uses
// full words ("major", "minor", "seventh"); MuseScore export sets the
// short suffix on the `text` attribute of <kind>. Prefer the attribute
// when present (that's the composer's intended display); otherwise
// derive from the textContent via this map.
const KIND_TEXT_TO_SUFFIX = {
  major: "", minor: "m", "augmented": "aug", "diminished": "dim",
  "dominant": "7", "major-seventh": "maj7", "minor-seventh": "m7",
  "diminished-seventh": "dim7", "augmented-seventh": "aug7",
  "half-diminished": "m7b5", "major-minor": "mM7",
  "suspended-fourth": "sus4", "suspended-second": "sus2",
  "major-sixth": "6", "minor-sixth": "m6",
  "dominant-ninth": "9", "major-ninth": "maj9", "minor-ninth": "m9",
  "power": "5", "none": "",
};

function buildChordSymbol(harmonyEl) {
  const rootStep = harmonyEl.querySelector("root root-step")?.textContent;
  if (!rootStep) return null;
  const alter = parseInt(harmonyEl.querySelector("root root-alter")?.textContent, 10) || 0;
  const accid = alter === 1 ? "#" : alter === -1 ? "b" : alter === 2 ? "##" : alter === -2 ? "bb" : "";
  const kindEl = harmonyEl.querySelector("kind");
  const kindAttr = kindEl?.getAttribute("text");
  // Attribute wins when present, even if it's "" (an explicit blank
  // means "no suffix", i.e., a major chord). null/undefined means
  // "attribute not set" — fall through to text-content map.
  const suffix = kindAttr != null
    ? kindAttr
    : (KIND_TEXT_TO_SUFFIX[kindEl?.textContent ?? "major"] ?? "");
  const bassStep = harmonyEl.querySelector("bass bass-step")?.textContent;
  const bassAlter = parseInt(harmonyEl.querySelector("bass bass-alter")?.textContent, 10) || 0;
  const bassAccid = bassAlter === 1 ? "#" : bassAlter === -1 ? "b" : "";
  const bass = bassStep ? `/${bassStep}${bassAccid}` : "";
  return `${rootStep}${accid}${suffix}${bass}`;
}

// ---------------------------------------------------------------------------
// M3 — short-measure classification + rest padding.
//
// These live at module scope, exported, and take only primitives — no parser
// state, no side effects — so they can be unit-tested in isolation. Spec
// §3.7 gives four verdicts:
//
//   full                      sum ≈ mLen. No action.
//   overflow                  sum > mLen. FLAG, refuse to truncate.
//   anacrusis-pickup          m1 short (implicit=yes OR just short). NEVER pad.
//   anacrusis-borrowed        A later short measure where sum + pickup = mLen
//                             (the borrowed partner at a repeat seam). NEVER pad.
//   incomplete                Anything else short. Pad with trailing rest.
//
// Padding an anacrusis (either variety) inserts silence at the repeat seam
// and drifts every subsequent audio_offset_ms — hence the loud rule.
// ---------------------------------------------------------------------------

const CLASSIFY_EPS = 1e-9;

/**
 * Classify a short measure. See spec §3.7. Pure — no dependency on parser
 * state; test with hand-constructed numbers.
 *
 * @param {number} measureNumber   1-indexed play-order measure number
 * @param {number} sumBeats        sum of event durations on this hand
 * @param {number} mLen            measure length in beats (from time sig)
 * @param {number|null} pickupBeats  song-level pickup length; null = no anacrusis
 * @param {boolean} isImplicit     did the source mark <measure implicit="yes">
 * @returns {"full"|"overflow"|"anacrusis-pickup"|"anacrusis-borrowed"|"incomplete"}
 */
export function classifyShortMeasure(measureNumber, sumBeats, mLen, pickupBeats, isImplicit) {
  const short = mLen - sumBeats;
  if (Math.abs(short) < CLASSIFY_EPS) return "full";
  if (short < -CLASSIFY_EPS) return "overflow";
  // Short. Anacrusis wins over incomplete in all cases where it applies.
  if (measureNumber === 1 && (isImplicit || short > CLASSIFY_EPS)) {
    return "anacrusis-pickup";
  }
  if (pickupBeats !== null && pickupBeats > CLASSIFY_EPS &&
      Math.abs(sumBeats + pickupBeats - mLen) < CLASSIFY_EPS) {
    return "anacrusis-borrowed";
  }
  return "incomplete";
}

/**
 * Append trailing rest events summing to `extraBeats`. Uses `beatsToTokens`'
 * greedy-largest-first decomposition so a 2.5-beat gap becomes ["h", "8"],
 * not two "qd" tokens. Returns `null` when the beat value can't be
 * expressed in the SAM vocabulary (unreachable for M3's corpus but caller
 * must handle).
 *
 * @param {Array} events            existing voice events (not mutated)
 * @param {number} extraBeats       beats of rest to append
 * @returns {Array|null}            new event array, or null on failure
 */
export function padWithRests(events, extraBeats) {
  if (extraBeats <= CLASSIFY_EPS) return events;
  const tokens = beatsToTokens(extraBeats);
  if (!tokens || tokens.length === 0) return null;
  const rests = tokens.map((t) => ({ duration: t, notes: [] }));
  return [...(events || []), ...rests];
}

// ---------------------------------------------------------------------------
// mergeStaff — port from tools/sam-tools/lib/xmlTruth.js
//
// Segmentation algorithm is IDENTICAL to the reference (bounds are the
// union of all onsets/ends on the target staff; segments are consecutive
// bound pairs; a source event covering a segment contributes its notes,
// with continuation fragments marked with tie: "end" and further
// combinations for cross-boundary chains).
//
// Two intentional deviations from the reference implementation:
//   1. tuplet carry — segments inherit the tuplet marker from the first
//      covering source event that has one (rests count, since triplet-rests
//      carry <time-modification> too). Required for SAM's token-vocabulary
//      output — a triplet-eighth segment of 0.333 beats can only be
//      reconstructed as {duration:"8", tuplet:{3,2}} if the ratio is on
//      the segment.
//   2. tie chain — corrected per Alex's table (2026-08-05):
//        first fragment: source-left tie, or "start" if N>1
//        middle:         "both"
//        last fragment:  source-right tie, or "end" if N>1
//      xmlTruth's reference wrote `tie:"end"` on every continuation and
//      preserved source's tie on the first fragment, which produces
//      `[no tie][end][end]` for a three-way split — no start, two orphan
//      ends. The reference in xmlTruth has been corrected to match.
//
// Exported so the same code can be unit-tested and reused by the
// simplification pipeline later.
// ---------------------------------------------------------------------------
export function mergeStaff(voices, staff, measureLen) {
  const staffVoices = [...voices.entries()].filter(([k]) => k.startsWith(`${staff}:`));
  if (staffVoices.length === 0) {
    return [{ onset: 0, dur: measureLen, notes: [], rest: true }];
  }

  // Bounds start at 0 only. `measureLen` is NOT seeded — that would
  // silently pad short source content (Prelude m43, Für Elise m1/m9
  // pickup) with a trailing rest, making the measure sum to mLen and
  // hiding it from the validator's incomplete_measure / anacrusis
  // detection. Padding an anacrusis is worse: it inserts a beat of
  // silence at the repeat seam (spec §3.7). M3 does explicit padding
  // when it's the correct call. Matches xmlTruth's mergeStaff exactly.
  const bounds = new Set([0]);
  for (const [, evs] of staffVoices) {
    for (const e of evs) {
      if (e.onset > -EPS && e.onset < measureLen + EPS) bounds.add(e.onset);
      const end = e.onset + e.dur;
      if (end > -EPS && end < measureLen + EPS) bounds.add(end);
    }
  }
  const points = [...bounds].sort((a, b) => a - b);

  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const t0 = points[i];
    const t1 = points[i + 1];
    if (t1 - t0 < EPS) continue;

    const notes = [];
    let carriedTuplet = null;
    let carriedVoice;

    for (const [, evs] of staffVoices) {
      for (const e of evs) {
        if (e.onset <= t0 + EPS && e.onset + e.dur >= t1 - EPS) {
          if (e.tuplet && !carriedTuplet) {
            carriedTuplet = { actual: e.tuplet.actual, normal: e.tuplet.normal };
          }
          if (e.rest || e.notes.length === 0) continue;

          if (carriedVoice === undefined && e.voice !== undefined) carriedVoice = e.voice;

          const isFirst = e.onset > t0 - EPS && e.onset < t0 + EPS;
          const isLast = e.onset + e.dur > t1 - EPS && e.onset + e.dur < t1 + EPS;
          for (const n of e.notes) {
            const sourceLeft = n.tie === "end" || n.tie === "both";
            const sourceRight = n.tie === "start" || n.tie === "both";
            const leftTie = !isFirst || sourceLeft;
            const rightTie = !isLast || sourceRight;
            let tie;
            if (leftTie && rightTie) tie = "both";
            else if (leftTie) tie = "end";
            else if (rightTie) tie = "start";
            const { tie: _oldTie, ...rest } = n;
            notes.push({ ...rest, ...(tie ? { tie } : {}) });
          }
        }
      }
    }
    const seg = { onset: t0, dur: t1 - t0, notes, rest: notes.length === 0 };
    if (carriedTuplet) seg.tuplet = carriedTuplet;
    if (carriedVoice !== undefined) seg.voice = carriedVoice;
    out.push(seg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase A — parse one measure into intermediate voice-map form.
// Mutates `state` (divisions, timeSig, key) so subsequent measures inherit.
// Returns { voices, measureLen, flags }.
// ---------------------------------------------------------------------------

function parseMeasureIntermediate(measEl, state, options) {
  const attrs = measEl.querySelector("attributes");
  if (attrs) {
    const d = attrs.querySelector("divisions");
    if (d) state.divisions = parseInt(d.textContent, 10);
    const t = attrs.querySelector("time");
    if (t) {
      state.beats = parseInt(t.querySelector("beats")?.textContent, 10) || state.beats;
      state.beatType = parseInt(t.querySelector("beat-type")?.textContent, 10) || state.beatType;
      const sym = t.getAttribute("symbol");
      state.symbol = sym === "cut" || sym === "common" ? sym : null;
    }
    const k = attrs.querySelector("key");
    if (k) {
      const fifths = parseInt(k.querySelector("fifths")?.textContent, 10);
      if (!isNaN(fifths)) state.fifths = fifths;
    }
  }

  const div = state.divisions;
  const measureLen = (state.beats * 4) / state.beatType;
  const voices = new Map();
  const flags = {
    fallbackFired: false,
    graceCount: 0,
    tupletsPresent: false,
    // `<measure implicit="yes">` — MusicXML's explicit pickup marker.
    // Spec §3.7: either implicit=yes OR a short m1 makes the measure an
    // anacrusis. Captured here so the M3 padding pass can distinguish
    // anacrusis (never pad) from an incomplete final measure (pad).
    isImplicit: measEl.getAttribute("implicit") === "yes",
    // M6 — tier-A pitch-affecting notations we don't currently handle.
    // Detect their presence per measure so the song-level Phase B step
    // can emit a parseWarning mentioning each tag it saw. Validator's
    // Group B gate reads parseWarnings for `<${tag}>` substrings, so
    // the warning tag must be emitted literally with the angle brackets.
    unhandledPitchTags: new Set(),
    // M7 — <harmony>, <rehearsal>, <sound tempo>, CARRIED notations.
    // Extracted with beat offsets (in quarter-note beats) so a future
    // renderer/playback engine has full positional context. Under
    // playback flattening, each play position gets a copy of these
    // (spec §3.4).
    chord: null,      // first <harmony> chord symbol in this source measure (dedup by content)
    section: null,    // first <rehearsal> text in this source measure
    tempos: [],       // [{beatOffset, bpm}] — sampled playback tempo track (see §5 amendment: NOT notated markings)
    carriedTags: new Set(), // tag names present in this measure (from CARRIED_NOTATION_TAGS)
  };
  for (const tag of UNHANDLED_PITCH_TAGS) {
    if (measEl.querySelector(tag)) flags.unhandledPitchTags.add(tag);
  }
  // M7 CARRIED tags — one presence scan for the whole measure subtree.
  // These attach to notes (<note><notations><fermata>, <slur>, articulations)
  // or directions (<direction-type><pedal>, <dynamics>, <wedge>). Whichever
  // scope they appear in, presence is what CARRY records; beat-position and
  // per-note attachment are deferred until a renderer needs them.
  for (const tag of CARRIED_NOTATION_TAGS) {
    if (measEl.querySelector(tag)) flags.carriedTags.add(tag);
  }

  // M7 chord dedup: track chord strings already recorded in this measure.
  // Handles music21 round-trips that double every <harmony> element.
  const seenChords = new Set();
  let cursor = 0;
  let lastKey = null;

  for (const el of Array.from(measEl.children)) {
    if (el.tagName === "backup") {
      cursor -= (parseInt(el.querySelector("duration")?.textContent, 10) || 0) / div;
      continue;
    }
    if (el.tagName === "forward") {
      cursor += (parseInt(el.querySelector("duration")?.textContent, 10) || 0) / div;
      continue;
    }
    // M7 — <harmony> at its position in the child stream. Dedup by
    // built symbol string per measure so two identical <harmony>
    // elements (music21 round-trip) collapse to one; two DISTINCT
    // chords in one measure both record but only the first becomes
    // measure.chord (single-field per spec §M7; per-beat chord
    // changes within a measure are a future feature).
    if (el.tagName === "harmony") {
      const sym = buildChordSymbol(el);
      if (sym && !seenChords.has(sym)) {
        seenChords.add(sym);
        if (flags.chord == null) flags.chord = sym;
      }
      continue;
    }
    // M7 — <direction> can contain <rehearsal>, <sound tempo>,
    // <pedal>, <dynamics>, <wedge>, etc. Extract each into the
    // appropriate field. beatOffset is the current cursor (already
    // in quarter-note beats since dur was pre-divided by div).
    if (el.tagName === "direction") {
      const dt = el.querySelector("direction-type");
      // <rehearsal> — first per measure
      const reh = dt?.querySelector("rehearsal");
      if (reh && flags.section == null) flags.section = reh.textContent;
      // <sound tempo> — recorded with beat offset. Also handles the
      // less-common bare <sound tempo> outside <direction> (below).
      const sound = el.querySelector("sound[tempo]");
      if (sound) {
        const bpm = parseFloat(sound.getAttribute("tempo"));
        if (!isNaN(bpm) && bpm > 0) {
          flags.tempos.push({ beatOffset: cursor, bpm });
        }
      }
      // CARRIED tags at direction scope already caught by the top-level
      // querySelector loop above (line ~334).
      continue;
    }
    // Bare <sound tempo> outside a <direction> — rare but possible.
    if (el.tagName === "sound" && el.getAttribute("tempo")) {
      const bpm = parseFloat(el.getAttribute("tempo"));
      if (!isNaN(bpm) && bpm > 0) flags.tempos.push({ beatOffset: cursor, bpm });
      continue;
    }
    if (el.tagName !== "note") continue;

    const isGrace = el.querySelector("grace") !== null;
    if (isGrace) {
      flags.graceCount += 1;
      continue;
    }

    const isChord = el.querySelector("chord") !== null;
    const isRest = el.querySelector("rest") !== null;
    const dur = (parseInt(el.querySelector("duration")?.textContent, 10) || 0) / div;
    const voice = el.querySelector("voice")?.textContent || "1";
    let staff = el.querySelector("staff")?.textContent || options.forceStaff || "1";

    let noteObj = null;
    if (!isRest) {
      const p = el.querySelector("pitch");
      if (p) {
        const step = p.querySelector("step")?.textContent || "C";
        const alter = p.querySelector("alter")?.textContent || "0";
        const octave = p.querySelector("octave")?.textContent || "4";
        const midi = pitchToMidi(step, alter, octave);
        const name = noteName(step, alter) + octave;
        const tieStart = el.querySelector('tie[type="start"]');
        const tieStop = el.querySelector('tie[type="stop"]');
        let tie;
        if (tieStart && tieStop) tie = "both";
        else if (tieStart) tie = "start";
        else if (tieStop) tie = "end";
        noteObj = { midi, name };
        if (tie) noteObj.tie = tie;
        // M/spec §6 — RH fingering cue. Rides on the note object through
        // mergeStaff + fromTimeline; parseMusicXML lifts it into a parallel
        // fingerings[] array and strips it before emitting (never inline in
        // the measure objects, spec §1). 1–5 only.
        const fingeringEl = el.querySelector("notations > technical > fingering");
        if (fingeringEl) {
          const fv = parseInt(fingeringEl.textContent, 10);
          if (fv >= 1 && fv <= 5) noteObj.fingering = fv;
        }
      }
    }

    // Single-staff fallback (spec §3.6, retained but FLAGGED). Fires only
    // when the source has one staff AND we're not in the two-parts-as-two-
    // staves configuration. Rests can't be routed by pitch — pin them to
    // staff "1" and let neighbouring notes determine placement.
    if (options.numStaves === 1 && !options.useTwoParts) {
      if (!isRest && noteObj) {
        staff = noteObj.midi < 60 ? "2" : "1";
        flags.fallbackFired = true;
      } else {
        staff = "1";
      }
    }

    const timeModEl = el.querySelector("time-modification");
    let tuplet;
    if (timeModEl) {
      const actual = parseInt(timeModEl.querySelector("actual-notes")?.textContent, 10) || 0;
      const normal = parseInt(timeModEl.querySelector("normal-notes")?.textContent, 10) || 0;
      if (actual > 0 && normal > 0) {
        // Reject nested tuplets: multiple <tuplet> markers with distinct
        // `number` attributes. Same-number pairs (start+stop on one note)
        // are fine — they mark adjacent same-level tuplets, not nesting.
        const tupletMarkers = el.querySelectorAll("notations > tuplet");
        if (tupletMarkers.length > 1) {
          const numbers = new Set(
            Array.from(tupletMarkers).map((m) => m.getAttribute("number") || "1")
          );
          if (numbers.size > 1) {
            throw new Error(
              `Nested tuplets not supported (measure ${options.measureNumber}, ` +
              `position ${cursor}). SAM only supports single-level tuplets.`
            );
          }
        }
        tuplet = { actual, normal };
        flags.tupletsPresent = true;
      }
    }

    let lyric;
    const lyricEl = el.querySelector("lyric");
    if (lyricEl) {
      const syllabic = lyricEl.querySelector("syllabic")?.textContent;
      const textVal = lyricEl.querySelector("text")?.textContent || "";
      lyric = (syllabic === "begin" || syllabic === "middle") ? textVal + "-" : textVal;
    }

    const key = `${staff}:${voice}`;
    if (!voices.has(key)) voices.set(key, []);
    const list = voices.get(key);

    if (isChord && !isRest && lastKey === key && list.length > 0) {
      // Chord member — attaches to previous event. Cursor doesn't advance.
      if (noteObj) list[list.length - 1].notes.push(noteObj);
    } else {
      const evt = {
        onset: cursor,
        dur,
        notes: noteObj ? [noteObj] : [],
        rest: isRest,
        voice,
      };
      if (tuplet) evt.tuplet = tuplet;
      if (lyric !== undefined) evt.lyric = lyric;
      list.push(evt);
      cursor += dur;
      lastKey = key;
    }
  }

  return { voices, measureLen, flags };
}

// ---------------------------------------------------------------------------
// Phase B — song-level hand assignment.
// For each voice number, pick the staff with the most notes. FLAG when
// no staff has ≥60%. Corpus low is 67% (spec §3.6); the threshold exists
// to catch pathological / generated scores, not real music.
// ---------------------------------------------------------------------------

function computeHandAssignment(voiceStaffTallies, parseWarnings) {
  const assignment = new Map();
  for (const [voice, staffCounts] of voiceStaffTallies) {
    let bestStaff = null;
    let bestCount = 0;
    let totalCount = 0;
    for (const [staff, count] of staffCounts) {
      totalCount += count;
      if (count > bestCount) {
        bestStaff = staff;
        bestCount = count;
      }
    }
    if (totalCount === 0) {
      assignment.set(voice, "1");
      continue;
    }
    const majority = bestCount / totalCount;
    if (majority < 0.6) {
      const dist = [...staffCounts.entries()]
        .map(([s, c]) => `staff ${s}: ${c}`)
        .join(", ");
      parseWarnings.push(
        `voice ${voice}: staff distribution [${dist}] has ` +
        `${(majority * 100).toFixed(0)}% majority (below 60% threshold) — ` +
        `assigning to staff ${bestStaff} anyway (best effort)`
      );
    }
    assignment.set(voice, bestStaff);
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// Phase C helpers — apply assignment then run mergeStaff + fromTimeline.
// ---------------------------------------------------------------------------

function applyHandAssignment(intermediateVoices, assignment) {
  const out = new Map();
  for (const [key, evs] of intermediateVoices) {
    const [origStaff, voice] = key.split(":");
    const assignedStaff = assignment.get(voice) || origStaff;
    const newKey = `${assignedStaff}:${voice}`;
    const existing = out.get(newKey) || [];
    existing.push(...evs);
    out.set(newKey, existing);
  }
  // Cross-staff case (§3.6): a voice's events arrive here split across the
  // origStaff dimension. After rekeying, re-sort by onset so mergeStaff
  // sees a monotonic timeline for each voice.
  for (const [, evs] of out) {
    evs.sort((a, b) => a.onset - b.onset);
  }
  return out;
}

function mergeAndConvert(assignedVoices, staff, measureLen, parseWarnings, mNum, hand) {
  const timeline = mergeStaff(assignedVoices, staff, measureLen);
  // Adapt mergeStaff's output shape ({onset, dur, ...}) to what
  // fromTimeline expects ({onsetBeats, durBeats, ...}) — same values,
  // different keys. Two names because mergeStaff mirrors xmlTruth's shape
  // and durations.fromTimeline mirrors spec §3.3.
  const adapted = timeline.map((seg) => ({
    onsetBeats: seg.onset,
    durBeats: seg.dur,
    notes: seg.notes,
    rest: seg.rest,
    ...(seg.tuplet ? { tuplet: seg.tuplet } : {}),
    ...(seg.voice !== undefined ? { voice: seg.voice } : {}),
  }));
  const voiceEvents = fromTimeline(adapted, parseWarnings, `m${mNum} ${hand}`);

  // Sort notes[] ascending by midi in every event with more than one note.
  // mergeStaff appends notes in source-voice-encounter order, which is not
  // always pitch-ascending for cross-voice chord unions. Sorting here keeps
  // mergeStaff itself general (its ordering is meaningful for tie-tracking
  // upstream) and satisfies the M2 notes_unsorted → 0 exit criterion.
  for (const e of voiceEvents) {
    if (e.notes && e.notes.length > 1) {
      e.notes.sort((a, b) => a.midi - b.midi);
    }
  }
  return voiceEvents;
}

// ---------------------------------------------------------------------------
// Main parser entry point.
// ---------------------------------------------------------------------------

export function parseMusicXML(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("Invalid XML");

  // --- Metadata ---
  const title =
    doc.querySelector("work > work-title")?.textContent ||
    doc.querySelector("movement-title")?.textContent ||
    "Untitled";
  const artist =
    doc.querySelector('identification > creator[type="composer"]')?.textContent || null;

  let defaultBpm = 68;
  const allSounds = doc.querySelectorAll("sound[tempo]");
  if (allSounds.length > 0) {
    defaultBpm = Math.round(parseFloat(allSounds[0].getAttribute("tempo"))) || 68;
  }

  // --- Parts & staves ---
  const parts = doc.querySelectorAll("part");
  if (parts.length === 0) throw new Error("No parts found in MusicXML");

  const firstPart = parts[0];
  const stavesEl = firstPart.querySelector("attributes > staves");
  const numStaves = stavesEl ? parseInt(stavesEl.textContent, 10) : 1;
  const useTwoParts = numStaves === 1 && parts.length >= 2;
  const usePerNoteFallback = numStaves === 1 && !useTwoParts;

  const measureEls = firstPart.querySelectorAll("measure");
  const secondPartMeasures = useTwoParts ? parts[1].querySelectorAll("measure") : null;

  const state = { divisions: 1, beats: 4, beatType: 4, symbol: null, fifths: 0 };
  const parseWarnings = [];

  // -------------------------------------------------------------------------
  // PHASE A — per-measure parse into intermediate voice-map form;
  //           tally voice → staff note counts for song-level assignment.
  // -------------------------------------------------------------------------
  const measureIntermediates = [];
  const voiceStaffTallies = new Map();
  const songFlags = {
    fallbackFiredMeasures: 0,
    graceTotal: 0,
    tupletMeasures: 0,
    // M6 — per-tag list of source measure numbers where each tier-A
    // pitch-affecting notation was seen. Aggregated per song by Phase B
    // into a single parseWarning per tag.
    unhandledPitchTagMeasures: new Map(),
    // M7 — per-tag list of source measure numbers for each CARRIED
    // tag (tier-B/C notations we store the presence of, without full
    // data extraction). Phase B emits one parseWarning per tag mentioning
    // the tag literally so validate.js's Group B check clears the finding.
    carriedTagMeasures: new Map(),
  };

  measureEls.forEach((measEl, measIdx) => {
    const measureNumber = measIdx + 1;
    const { voices, measureLen, flags } = parseMeasureIntermediate(
      measEl, state,
      { numStaves, useTwoParts, measureNumber, forceStaff: "1" }
    );

    // useTwoParts: append part 2 under forced staff "2". Snapshot the state
    // so part 2's <attributes> can't corrupt part 1's running state (divisions
    // occasionally differs per part in generated scores).
    if (useTwoParts && secondPartMeasures && secondPartMeasures[measIdx]) {
      const part2State = { ...state };
      const { voices: part2Voices } = parseMeasureIntermediate(
        secondPartMeasures[measIdx], part2State,
        { numStaves, useTwoParts, measureNumber, forceStaff: "2" }
      );
      for (const [key, evs] of part2Voices) {
        const [, voice] = key.split(":");
        const newKey = `2:${voice}`;
        const existing = voices.get(newKey) || [];
        existing.push(...evs);
        voices.set(newKey, existing);
      }
    }

    // source_measure: preserve the raw <measure number="…"> attribute
    // verbatim. MusicXML defines the attribute as CDATA (any string),
    // and non-numeric values are standard: MuseScore emits X1..X4 for
    // ending brackets, other editions use 12a/12b. The DB column is
    // TEXT (spec §4.1 amended 2026-08-05 after Alex caught the
    // integer-column error), so the raw attribute round-trips
    // faithfully through fanOut → recompile. The Stopped UI already
    // uses `String(sourceMeasure) !== String(number)` so it renders
    // "m91 (X2)" for non-numeric values without special casing.
    //
    // Computed BEFORE the songFlags aggregation below so warning
    // measure lists can reference printed numbers (spec §M8).
    const sourceRaw = measEl.getAttribute("number");
    const sourceMeasure = sourceRaw !== null && sourceRaw !== "" ? sourceRaw : null;

    if (flags.fallbackFired) songFlags.fallbackFiredMeasures += 1;
    songFlags.graceTotal += flags.graceCount;
    if (flags.tupletsPresent) songFlags.tupletMeasures += 1;
    // M8 — aggregate warnings by SOURCE measure number (the raw
    // `<measure number>` attribute value), NOT by Phase A's 1-based
    // array index. For songs where the two coincide (any score whose
    // source measures start at "1" — every corpus fixture except Für
    // Elise), no observable change. For Für Elise (pickup source
    // starts at "0"), the pre-M8 warnings were off by one from the
    // printed number throughout ("<pedal> at m3" pointed at a bar
    // labeled "2" in MuseScore). Fall back to array index when
    // sourceMeasure is null (missing attribute — never seen in
    // corpus, but defensive).
    const reportNum = sourceMeasure != null ? sourceMeasure : measureNumber;
    for (const tag of flags.unhandledPitchTags) {
      if (!songFlags.unhandledPitchTagMeasures.has(tag)) {
        songFlags.unhandledPitchTagMeasures.set(tag, []);
      }
      songFlags.unhandledPitchTagMeasures.get(tag).push(reportNum);
    }
    for (const tag of flags.carriedTags) {
      if (!songFlags.carriedTagMeasures.has(tag)) {
        songFlags.carriedTagMeasures.set(tag, []);
      }
      songFlags.carriedTagMeasures.get(tag).push(reportNum);
    }

    // Tally only in the multi-staff single-part case, where cross-staff
    // voices genuinely need song-level assignment. usePerNoteFallback and
    // useTwoParts have per-note / per-part staff already authoritative;
    // running Phase B on those would undo it.
    if (!usePerNoteFallback && !useTwoParts) {
      for (const [key, evs] of voices) {
        const [staff, voice] = key.split(":");
        const noteCount = evs.filter((e) => !e.rest && e.notes.length > 0).length;
        if (noteCount === 0) continue;
        if (!voiceStaffTallies.has(voice)) voiceStaffTallies.set(voice, new Map());
        const staffCounts = voiceStaffTallies.get(voice);
        staffCounts.set(staff, (staffCounts.get(staff) || 0) + noteCount);
      }
    }

    measureIntermediates.push({
      voices,
      measureLen,
      number: measureNumber,
      sourceMeasure,
      isImplicit: flags.isImplicit,
      timeSignature: {
        beats: state.beats,
        beatType: state.beatType,
        ...(state.symbol ? { symbol: state.symbol } : {}),
      },
      // M7 — carried through to the final measure object per playback.
      // chord/section: single fields, first-in-source per measure.
      // tempos: full list with beat offsets. carriedTags: presence set.
      chord: flags.chord,
      section: flags.section,
      tempos: flags.tempos,
      carriedTags: [...flags.carriedTags].sort(),
    });
  });

  // -------------------------------------------------------------------------
  // PHASE B — song-level hand assignment.
  // -------------------------------------------------------------------------
  const voiceHandAssignment =
    (usePerNoteFallback || useTwoParts)
      ? null
      : computeHandAssignment(voiceStaffTallies, parseWarnings);

  if (songFlags.fallbackFiredMeasures > 0) {
    parseWarnings.push(
      `single-staff source: midi<60 → LH fallback used in ` +
      `${songFlags.fallbackFiredMeasures} measure(s) (spec §3.6 — no <staff> ` +
      `present, per-note midi-based routing)`
    );
  }
  if (songFlags.graceTotal > 0) {
    parseWarnings.push(
      `${songFlags.graceTotal} grace note(s) dropped from parsed output ` +
      `(M6 will retain and FLAG these; for now they carry no beat)`
    );
  }
  // M6 — one parseWarning per tier-A pitch-affecting tag seen. The
  // literal `<${tag}>` substring in each message is what validate.js's
  // Group B check reads to recognise "acknowledged" (see validate.js
  // notation loop comment). Bach Invention emits mordent + inverted-
  // mordent under the current corpus; the rest are defensive.
  // M8 — "printed m" prefix names the numbering scheme (source
  // attribute), so a Für Elise reader knows m0 = the pickup.
  for (const [tag, measureList] of songFlags.unhandledPitchTagMeasures) {
    const preview = measureList.slice(0, 8).join(", ");
    const more = measureList.length > 8 ? `, +${measureList.length - 8} more` : "";
    parseWarnings.push(
      `<${tag}>: ${measureList.length} occurrence(s) at printed m${preview}${more} — ` +
      `parser does not apply this ornament; pitches shown are the written ` +
      `notes only. Sounding pitches may differ from performed audio.`
    );
  }
  // M7 — one parseWarning per CARRIED tag seen. Distinct message from
  // M6's UNHANDLED warnings: these tags ARE preserved (as presence on
  // measure.carriedTags), just without full data extraction. The
  // literal `<${tag}>` substring in each message is what validate.js's
  // Group B check reads. Corpus-reachable: fermata, pedal, dynamics,
  // wedge, slur, staccato, accent, tenuto (varies per song).
  for (const [tag, measureList] of songFlags.carriedTagMeasures) {
    const preview = measureList.slice(0, 8).join(", ");
    const more = measureList.length > 8 ? `, +${measureList.length - 8} more` : "";
    parseWarnings.push(
      `<${tag}>: ${measureList.length} occurrence(s) at printed m${preview}${more} — ` +
      `carried on measure.carriedTags (presence recorded; full data ` +
      `extraction deferred until a renderer needs it, spec §M7).`
    );
  }

  // M8 — parseWarningsStructured mirrors parseWarnings in structured
  // form so the import UI can compose its own sentences without
  // substring-matching on prose. Emitted alongside (not replacing) the
  // raw strings: validator's Group B check reads the strings, DB
  // storage keeps both. Kinds: 'ornament' (M6 tier-A), 'carried'
  // (M7 tier-B/C), 'grace' (aggregated song-level), 'hand-assignment'
  // (§3.6 low-majority), 'truncated' (padWithRests null),
  // 'overflow' (measure sum > mLen), 'single-staff-fallback'
  // (§3.6 no <staff>). (The old 'non-numeric-source' warning was
  // removed 2026-08-05 when source_measure column became TEXT — the
  // raw attribute now round-trips faithfully so the warning was noise.)
  // measures[] carries PRINTED source measure numbers; empty when the
  // warning is song-level rather than per-measure.
  const parseWarningsStructured = [];
  if (songFlags.graceTotal > 0) {
    parseWarningsStructured.push({
      tag: "grace", kind: "grace", count: songFlags.graceTotal, measures: [],
    });
  }
  if (songFlags.fallbackFiredMeasures > 0) {
    parseWarningsStructured.push({
      tag: "single-staff-fallback", kind: "hand-assignment",
      count: songFlags.fallbackFiredMeasures, measures: [],
    });
  }
  for (const [tag, measureList] of songFlags.unhandledPitchTagMeasures) {
    parseWarningsStructured.push({
      tag, kind: "ornament", count: measureList.length, measures: [...measureList],
    });
  }
  for (const [tag, measureList] of songFlags.carriedTagMeasures) {
    parseWarningsStructured.push({
      tag, kind: "carried", count: measureList.length, measures: [...measureList],
    });
  }
  // Note: 'truncated' / 'overflow' entries would be pushed from Phase
  // C2 when it emits those warnings. Corpus doesn't hit either path
  // today; adding here would just be dead code.

  // -------------------------------------------------------------------------
  // PHASE C1 — apply assignment, mergeStaff per hand, lower to voice format.
  // Produces UNPADDED voice events per hand per measure. Padding is a
  // separate post-merge pass (Phase C2) because it needs song-level pickup
  // context, and because seeding it back into mergeStaff's bounds set is
  // exactly the bug that swallowed Prelude m43 in M2 (spec §M3 comment).
  // -------------------------------------------------------------------------
  const keyFifths = state.fifths;
  const rawMeasures = measureIntermediates.map((mi) => {
    const assignedVoices = voiceHandAssignment
      ? applyHandAssignment(mi.voices, voiceHandAssignment)
      : mi.voices;

    const rh = mergeAndConvert(assignedVoices, "1", mi.measureLen, parseWarnings, mi.number, "rh");
    const lh = mergeAndConvert(assignedVoices, "2", mi.measureLen, parseWarnings, mi.number, "lh");

    return {
      number: mi.number,
      sourceMeasure: mi.sourceMeasure,
      rh,
      lh,
      measureLen: mi.measureLen,
      isImplicit: mi.isImplicit,
      timeSignature: mi.timeSignature,
      // M7 fields — carried through Phase C untouched.
      chord: mi.chord,
      section: mi.section,
      tempos: mi.tempos,
      carriedTags: mi.carriedTags,
    };
  });

  // -------------------------------------------------------------------------
  // Song-level pickup detection (spec §3.7).
  // Pickup exists iff m1 is implicit OR its RH sums short. RH is the
  // reference hand — matching the validator's convention in validate.js:
  //   `truth.implicitFirst || (s0 !== null && s0 < mLen - 1e-6)`
  // For Für Elise: implicitFirst=true, m1 RH sum 0.5, pickup = 0.5.
  // For Prelude: implicitFirst=false, m1 RH sum = mLen (3), pickup = null.
  // -------------------------------------------------------------------------
  let pickup = null;
  if (rawMeasures.length > 0) {
    const m1 = rawMeasures[0];
    const m1RhSum = sumEvents(m1.rh);
    if (m1RhSum !== null) {
      const m1IsShort = m1RhSum < m1.measureLen - CLASSIFY_EPS;
      if (m1.isImplicit || m1IsShort) {
        pickup = m1RhSum;
      }
    }
  }

  // -------------------------------------------------------------------------
  // PHASE C2 — classify each hand and pad the ones that are genuinely
  // incomplete. Never pad anacrusis (m1 pickup or borrowed partner). See
  // classifyShortMeasure above for the rule table. Runs BEFORE playback
  // flattening so a source measure that gets played twice is padded once
  // and the padded events are reused on every play-pass.
  // -------------------------------------------------------------------------
  const sourceMeasures = rawMeasures.map((m) => {
    const out = {
      number: m.number,
      sourceMeasure: m.sourceMeasure,
      rh: m.rh,
      lh: m.lh,
      timeSignature: m.timeSignature,
      // M7 fields carried through Phase C2 unchanged; Phase D will
      // then copy them into every play position.
      chord: m.chord,
      section: m.section,
      tempos: m.tempos,
      carriedTags: m.carriedTags,
    };
    for (const hand of ["rh", "lh"]) {
      const sum = sumEvents(out[hand]);
      if (sum === null) continue;
      const clazz = classifyShortMeasure(m.number, sum, m.measureLen, pickup, m.isImplicit);
      if (clazz === "incomplete") {
        const padded = padWithRests(out[hand], m.measureLen - sum);
        if (padded === null) {
          parseWarnings.push(
            `m${m.number} ${hand}: short by ${(m.measureLen - sum).toFixed(4)} ` +
            `beats not decomposable into rest tokens; leaving unpadded`
          );
        } else {
          out[hand] = padded;
        }
      } else if (clazz === "overflow") {
        parseWarnings.push(
          `m${m.number} ${hand}: sum ${sum.toFixed(4)} exceeds mLen ` +
          `${m.measureLen} — refusing to truncate (spec §M3)`
        );
      }
      // "full", "anacrusis-pickup", "anacrusis-borrowed": leave as-is
    }
    return out;
  });

  // -------------------------------------------------------------------------
  // PHASE D — flatten repeats, voltas, and D.S./coda navigation into
  // playback order (spec §M4). `number` becomes 1-indexed play order;
  // `sourceMeasure` remains the raw <measure number> attribute value from
  // the source, so any consumer can distinguish "48th played measure" from
  // "printed measure 48". A source measure that plays twice appears twice
  // in `measures` — its events are the same object references both times
  // (Phase C2 output shared), so downstream mutations must not assume
  // uniqueness. Idempotent by construction: a workshop-produced pre-flat
  // score has no repeat/ending markers, so resolvePlaybackOrder returns
  // the identity order and this pass is a straight remap.
  // -------------------------------------------------------------------------
  const playback = resolvePlaybackOrder([...measureEls]);
  const measures = playback.order.map((sourceIdx, playIdx) => {
    const src = sourceMeasures[sourceIdx];
    return {
      number: playIdx + 1,
      sourceMeasure: src.sourceMeasure,
      rh: src.rh,
      lh: src.lh,
      timeSignature: src.timeSignature,
      // Under repeat/D.S., the same source measure plays multiple
      // times and each play gets the same chord/section (spec §3.4).
      chord: src.chord,
      section: src.section,
      // tempos and carriedTags REMOVED from per-measure output
      // (Alex, 2026-08-06). tempos now lives at song.playback.tempos
      // as a flat playback-ordered timeline (built below from the
      // per-source tempo lists + playback.order); no per-measure
      // consumer needed the array copy, and sam_song_measures has
      // no column, so persisting per-row would need a schema change
      // for no reader. carriedTags is parse-time-only — Phase B's
      // parseWarnings already carries per-tag presence at song
      // level, and no per-measure consumer reads the array.
    };
  });

  // Song-level flat tempo timeline (spec §5 amendment: SAMPLED
  // PLAYBACK tempo track, NOT notated markings — MuseScore's
  // interpolated rall./rit. samples with words="S" are included
  // verbatim). Each entry: {playIndex (0-based), beatOffset (from
  // measure start, in quarter-note beats), bpm}. Under flattening,
  // tempo marks on a repeated source measure appear multiple times —
  // once per play position — matching what the audio would do.
  // Built from sourceMeasures (which still holds per-source tempo
  // lists) + playback.order rather than measures[i] (which no longer
  // carries `tempos`).
  const flatTempos = [];
  for (let playIdx = 0; playIdx < playback.order.length; playIdx++) {
    const src = sourceMeasures[playback.order[playIdx]];
    for (const t of src.tempos || []) {
      flatTempos.push({ playIndex: playIdx, beatOffset: t.beatOffset, bpm: t.bpm });
    }
  }

  // -------------------------------------------------------------------------
  // RH fingering cues (spec §6). Each note carried its <fingering> through the
  // pipeline; lift them into a parallel array keyed by PLAY-ORDER
  // (measureNum, rhIndex, noteIndex), then strip the inline field so emitted
  // measures carry no fingering (spec §1). Notes are pitch-sorted by
  // mergeAndConvert, so noteIndex is the low→high pitch rank the overlay uses.
  //
  //   - RH only: the table is rh_index-keyed; LH cues are dropped (but still
  //     stripped from the output below).
  //   - Onset only: a tie-split note repeats its fingering on every fragment;
  //     take just the onset (skip tie 'end'/'both') so one press = one row.
  //   - Play order: under flattening a repeated source measure yields an
  //     independent row at each play position (spec §2).
  // Collect fully before stripping (note objects are shared across play
  // positions, so a repeated measure must be read at each `number` first).
  // -------------------------------------------------------------------------
  const fingerings = [];
  for (const m of measures) {
    (m.rh || []).forEach((evt, rhIndex) => {
      (evt.notes || []).forEach((n, noteIndex) => {
        if (n.fingering == null) return;
        if (n.tie === "end" || n.tie === "both") return; // tie continuation, not the onset
        fingerings.push({ measureNum: m.number, rhIndex, noteIndex, finger: n.fingering });
      });
    });
  }
  for (const m of measures) {
    for (const hand of ["rh", "lh"]) {
      for (const evt of (m[hand] || [])) {
        for (const n of (evt.notes || [])) {
          if ("fingering" in n) delete n.fingering;
        }
      }
    }
  }

  return {
    title,
    artist,
    defaultBpm,
    // M7 — fifths is the integer ground truth (-7..+7). key is the
    // derived display string kept for backward compat with the six
    // existing consumers (SongLoader.jsx writes, MCP create_sam_song,
    // tool-handlers reads). No consumer today wants the integer, so
    // the sam_songs.fifths INTEGER column is deferred until one
    // appears — see progress-doc "Deferred stored-state changes".
    // Simplification pipeline's accidentals metric is the likely
    // first reader.
    fifths: keyFifths,
    key: KEY_NAMES[String(keyFifths)] || "C major",
    timeSignature: `${state.beats}/${state.beatType}`,
    measures,
    // M4 open item, landed 2026-08-05. Repeat/navigation structure
    // resolved at parse time and exposed on the song so SongLoader can
    // persist it to sam_songs.generation_notes.playback. Consumers can
    // reconstruct the authored source's structural shape (repeats,
    // ending brackets, D.S./coda/segno positions) without re-parsing
    // the MusicXML. Spec §3.4 rationale: recordings frequently skip
    // the repeats — an unflattened variant needs the structure the
    // measures array can't carry.
    //
    // 2026-08-06 addition: `tempos` moved here from top-level
    // `song.tempos`. Same content (SAMPLED PLAYBACK track per §5
    // amendment, NOT notated markings) — it now co-lives with the
    // other "record of what the source said" fields inside the
    // playback slot, so a single spread into
    // generation_notes.playback carries the full playback context.
    playback: {
      sourceCount: measureEls.length,
      implicitFirst: measureEls[0]?.getAttribute("implicit") === "yes",
      playOrder: playback.order,
      structure: playback.structure,
      tempos: flatTempos,
    },
    ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
    ...(parseWarningsStructured.length > 0 ? { parseWarningsStructured } : {}),
    ...(fingerings.length > 0 ? { fingerings } : {}),
  };
}
