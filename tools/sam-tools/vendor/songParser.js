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
  tokenToBeats,
  beatsToToken,
  beatsToTokens,
  fromTimeline,
  sumEvents,
  ONSET_EPS,
} from "./durations.js";

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
  };

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

    if (flags.fallbackFired) songFlags.fallbackFiredMeasures += 1;
    songFlags.graceTotal += flags.graceCount;
    if (flags.tupletsPresent) songFlags.tupletMeasures += 1;

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
      isImplicit: flags.isImplicit,
      timeSignature: {
        beats: state.beats,
        beatType: state.beatType,
        ...(state.symbol ? { symbol: state.symbol } : {}),
      },
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
      rh,
      lh,
      measureLen: mi.measureLen,
      isImplicit: mi.isImplicit,
      timeSignature: mi.timeSignature,
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
  // classifyShortMeasure above for the rule table.
  // -------------------------------------------------------------------------
  const measures = rawMeasures.map((m) => {
    const out = { number: m.number, rh: m.rh, lh: m.lh, timeSignature: m.timeSignature };
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

  return {
    title,
    artist,
    defaultBpm,
    key: KEY_NAMES[String(keyFifths)] || "C major",
    timeSignature: `${state.beats}/${state.beatType}`,
    measures,
    ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
  };
}
