// Ground truth computed directly from MusicXML.
// Deliberately independent of songParser.js — this is the oracle, not a rewrite.

import { JSDOM } from "jsdom";

// Widened from 1e-9 during the M2 validator changes. The tighter value
// worked for the fixtures at hand but was uncomfortably close to accumulated
// triplet-of-triplet drift (three onsets at 1/3 in double precision drift
// on the order of 1e-15; twelve accumulate further). 1e-6 is generous
// enough that Moonlight-style textures never trip false negatives on the
// boundary check while remaining far tighter than any real duration unit
// (smallest is 1/64 = 0.015625). The SAM parser port's ONSET_EPS lives in
// durations.js and matches; keep the two in sync.
const EPS = 1e-6;
const near = (a, b) => Math.abs(a - b) < 1e-6;

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchToMidi(step, alter, octave) {
  return (parseInt(octave, 10) + 1) * 12 + STEP_SEMITONES[step] + (parseInt(alter, 10) || 0);
}

function noteName(step, alter) {
  const a = parseInt(alter, 10) || 0;
  const acc = { 1: "#", 2: "##", "-1": "b", "-2": "bb" }[a] || "";
  return step + acc;
}

const text = (el, sel) => el.querySelector(sel)?.textContent ?? null;

/**
 * Parse one <measure> into per-voice event timelines.
 * MusicXML <duration> is ALREADY tuplet-scaled sounding time — that is the
 * authority. <type> is only the visual glyph, which is exactly the trap
 * songParser.js falls into.
 */
function parseMeasure(measEl, state) {
  const attrs = measEl.querySelector("attributes");
  if (attrs) {
    const d = text(attrs, "divisions");
    if (d) state.divisions = parseInt(d, 10);
    const t = attrs.querySelector("time");
    if (t) {
      state.beats = parseInt(text(t, "beats"), 10) || state.beats;
      state.beatType = parseInt(text(t, "beat-type"), 10) || state.beatType;
      const sym = t.getAttribute("symbol");
      state.symbol = sym === "cut" || sym === "common" ? sym : null;
    }
    const k = attrs.querySelector("key");
    if (k) {
      state.fifths = parseInt(text(k, "fifths"), 10) || 0;
      state.mode = text(k, "mode");
    }
  }

  const div = state.divisions;
  const voices = new Map(); // "staff:voice" -> [{onset, dur, notes, tuplet, tie, lyric, grace}]
  const flags = {
    graceNotes: 0,
    tupletNotes: 0,
    tupletRatios: new Set(),
    crossStaffVoices: new Set(),
    unpitched: 0,
  };

  let cursor = 0;
  let lastKey = null;
  let lastOnset = 0;

  for (const el of Array.from(measEl.children)) {
    if (el.tagName === "backup") {
      cursor -= (parseInt(text(el, "duration"), 10) || 0) / div;
      continue;
    }
    if (el.tagName === "forward") {
      cursor += (parseInt(text(el, "duration"), 10) || 0) / div;
      continue;
    }
    if (el.tagName !== "note") continue;

    const isGrace = el.querySelector("grace") !== null;
    if (isGrace) {
      flags.graceNotes += 1;
      continue; // zero duration; recorded as a flag only
    }

    const isChord = el.querySelector("chord") !== null;
    const isRest = el.querySelector("rest") !== null;
    const dur = (parseInt(text(el, "duration"), 10) || 0) / div;
    const staff = text(el, "staff") || "1";
    const voice = text(el, "voice") || "1";
    const key = `${staff}:${voice}`;

    // Cross-staff = the SAME voice number appearing on more than one staff in
    // this measure, which means one notated line reaches across the grand staff.
    // Do NOT infer this from the voice number itself: MuseScore uses 1-4/5-8,
    // but music21's writer emits voice 2 on staff 2, so a range test produces a
    // false positive on every measure of any music21-generated file.
    if (!flags.voicesByNumber) flags.voicesByNumber = new Map();
    if (!flags.voicesByNumber.has(voice)) flags.voicesByNumber.set(voice, new Set());
    flags.voicesByNumber.get(voice).add(staff);

    const tm = el.querySelector("time-modification");
    let tuplet = null;
    if (tm) {
      const actual = parseInt(text(tm, "actual-notes"), 10) || 0;
      const normal = parseInt(text(tm, "normal-notes"), 10) || 0;
      if (actual && normal) {
        tuplet = { actual, normal };
        flags.tupletNotes += 1;
        flags.tupletRatios.add(`${actual}:${normal}`);
      }
    }

    let note = null;
    if (!isRest) {
      const p = el.querySelector("pitch");
      if (p) {
        const step = text(p, "step") || "C";
        const alter = text(p, "alter") || "0";
        const octave = text(p, "octave") || "4";
        note = {
          midi: pitchToMidi(step, alter, octave),
          name: noteName(step, alter) + octave,
        };
        const tieStart = el.querySelector('tie[type="start"]');
        const tieStop = el.querySelector('tie[type="stop"]');
        if (tieStart && tieStop) note.tie = "both";
        else if (tieStart) note.tie = "start";
        else if (tieStop) note.tie = "end";
      } else {
        flags.unpitched += 1;
      }
    }

    if (!voices.has(key)) voices.set(key, []);
    const list = voices.get(key);

    if (isChord && lastKey === key && list.length > 0) {
      // Chord member: attaches to the previous event, does not advance the cursor.
      if (note) list[list.length - 1].notes.push(note);
    } else {
      list.push({
        onset: cursor,
        dur,
        notes: note ? [note] : [],
        rest: isRest,
        tuplet,
        lyric: text(el, "lyric > text"),
      });
      lastOnset = cursor;
      cursor += dur;
      lastKey = key;
    }
  }

  for (const [voice, staves] of flags.voicesByNumber ?? []) {
    if (staves.size > 1) flags.crossStaffVoices.add(`voice ${voice} on staves ${[...staves].join("+")}`);
  }

  const measureLen = (state.beats * 4) / state.beatType;

  const voiceSummary = {};
  for (const [key, evs] of voices) {
    const sounded = evs.reduce((s, e) => s + e.dur, 0);
    const end = evs.length ? Math.max(...evs.map((e) => e.onset + e.dur)) : 0;
    const start = evs.length ? Math.min(...evs.map((e) => e.onset)) : 0;
    voiceSummary[key] = {
      events: evs.length,
      sounded,
      start,
      end,
      fillsMeasure: near(start, 0) && near(end, measureLen),
    };
  }

  return {
    timeSignature: { beats: state.beats, beatType: state.beatType, ...(state.symbol ? { symbol: state.symbol } : {}) },
    measureLen,
    fifths: state.fifths,
    mode: state.mode,
    divisions: div,
    voices,
    voiceSummary,
    flags,
  };
}

/**
 * Merge the voices of one staff into a single serial timeline — the shape SAM
 * stores. Segment boundaries are the union of all onsets; a note that began in
 * an earlier segment reappears as a tied continuation.
 * This is the reference implementation of the parser fix.
 */
export function mergeStaff(voices, staff, measureLen) {
  const staffVoices = [...voices.entries()].filter(([k]) => k.startsWith(`${staff}:`));
  if (staffVoices.length === 0) return [{ onset: 0, dur: measureLen, notes: [], rest: true }];

  // Bounds start at 0 only. `measureLen` is NOT seeded — that seeding
  // silently pads short source content (Prelude m43, Für Elise m1/m9
  // pickup) with a trailing rest, making the measure sum to mLen and
  // preventing the validator's sum-fails branch from firing
  // incomplete_measure / anacrusis. Padding an anacrusis inserts silence
  // at the repeat seam (spec §3.7). M3 does explicit padding when it's
  // the correct call — mergeStaff must not do it implicitly. For full
  // measures, an event ends AT measureLen and gets added below.
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
    // NOTE (2026-08-05, M2): xmlTruth's original mergeStaff dropped the
    // source event's tuplet marker from segments — fine here because
    // xmlTruth works in numeric beats and never converts back to tokens,
    // but the SAM parser port MUST carry it. Without a tuplet on the
    // segment, a triplet-eighth fragment of 0.333 beats has no ratio
    // attached and fromTimeline can't emit {duration:"8", tuplet:{3,2}}.
    // Carry the first tuplet marker seen from any source event covering
    // this segment (rests too — a triplet-rest inherits time-modification
    // in xmlTruth's parseMeasure). The parser port relies on this.
    let carriedTuplet = null;
    for (const [, evs] of staffVoices) {
      for (const e of evs) {
        if (e.onset <= t0 + EPS && e.onset + e.dur >= t1 - EPS) {
          if (e.tuplet && !carriedTuplet) {
            carriedTuplet = { actual: e.tuplet.actual, normal: e.tuplet.normal };
          }
          if (e.rest || e.notes.length === 0) continue;
          // Is this segment the FIRST or LAST fragment of the source event?
          // "first" = source onset aligns with this segment's t0.
          // "last" = source end aligns with this segment's t1.
          // For a note split into N fragments, the tie chain must be:
          //   fragment 0    → left = source-left,           right = (N>1) OR source-right
          //   middle        → left = true,                  right = true
          //   fragment N-1  → left = true,                  right = source-right
          // Combined: left && right → "both"; left → "end"; right → "start".
          //
          // NOTE (2026-08-05): the original xmlTruth mergeStaff wrote
          // `{ tie: "end" }` on every continuation and preserved source's
          // tie on fragment 0 — which produces `[no tie][end][end]` for a
          // three-way split (no start, two orphan ends). Corrected during
          // the M2 port; the SAM parser port uses this same logic.
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
    out.push(seg);
  }
  return out;
}

/** Repeat / volta / D.S.-al-Coda resolution → flattened playback order (0-based source indices). */
export function resolvePlaybackOrder(measEls) {
  const n = measEls.length;
  const info = measEls.map((m) => {
    const endings = [...m.querySelectorAll("ending")].map((e) => ({
      numbers: (e.getAttribute("number") || "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean),
      type: e.getAttribute("type"),
    }));
    const sounds = [...m.querySelectorAll("sound")];
    const attr = (name) => sounds.map((s) => s.getAttribute(name)).find(Boolean) || null;
    return {
      forwardRepeat: !!m.querySelector('repeat[direction="forward"]'),
      backwardRepeat: !!m.querySelector('repeat[direction="backward"]'),
      repeatTimes: parseInt(m.querySelector('repeat[direction="backward"]')?.getAttribute("times") || "2", 10),
      endings,
      segno: !!attr("segno"),
      coda: !!attr("coda"),
      toCoda: !!attr("tocoda"),
      dalSegno: !!attr("dalsegno"),
      daCapo: !!attr("dacapo"),
      fine: !!attr("fine"),
    };
  });

  const segnoIdx = info.findIndex((i) => i.segno);
  const codaIdx = info.findIndex((i) => i.coda);

  const order = [];
  const passCount = new Map(); // backward-repeat index -> times taken
  let i = 0;
  let repeatStart = 0;
  let jumped = false; // have we taken a D.S./D.C. yet
  let honourToCoda = false;
  let guard = 0;

  while (i < n && guard++ < n * 12) {
    const m = info[i];
    if (m.forwardRepeat) repeatStart = i;

    // Volta: skip an ending block whose numbers exclude the current pass.
    const startEnding = m.endings.find((e) => e.type === "start");
    if (startEnding) {
      const pass = (passCount.get(repeatStart) || 0) + 1;
      if (!startEnding.numbers.includes(pass)) {
        // Skip to the end of this ending block.
        let j = i;
        while (j < n && !info[j].endings.some((e) => e.type === "stop" || e.type === "discontinue")) j++;
        i = j + 1;
        continue;
      }
    }

    order.push(i);

    if (honourToCoda && m.toCoda && codaIdx >= 0) {
      i = codaIdx;
      honourToCoda = false;
      continue;
    }
    if (m.fine && jumped) break;

    if (m.backwardRepeat) {
      const taken = passCount.get(repeatStart) || 0;
      if (taken + 1 < m.repeatTimes) {
        passCount.set(repeatStart, taken + 1);
        i = repeatStart;
        continue;
      }
    }

    if (!jumped && (m.dalSegno || m.daCapo)) {
      jumped = true;
      honourToCoda = true;
      i = m.dalSegno && segnoIdx >= 0 ? segnoIdx : 0;
      continue;
    }

    i++;
  }

  return {
    order,
    hasRepeats: info.some((x) => x.forwardRepeat || x.backwardRepeat),
    hasNavigation: info.some((x) => x.segno || x.coda || x.dalSegno || x.daCapo || x.toCoda || x.fine),
    navMarks: info
      .map((x, idx) => ({ idx: idx + 1, ...x }))
      .filter((x) => x.segno || x.coda || x.dalSegno || x.daCapo || x.toCoda || x.fine)
      .map((x) => ({
        measure: x.idx,
        marks: ["segno", "coda", "toCoda", "dalSegno", "daCapo", "fine"].filter((k) => x[k]),
      })),
  };
}

/**
 * Notations that affect how a piano score actually sounds, tiered by severity.
 * A: changes which pitches sound. B: changes timing. C: changes tone/articulation.
 * D: metadata SAM already has a home for and is currently throwing away.
 */
export const NOTATION_TIERS = {
  A: ["octave-shift", "transpose", "arpeggiate", "non-arpeggiate", "trill-mark", "mordent",
      "inverted-mordent", "turn", "inverted-turn", "tremolo", "glissando", "slide", "cue"],
  B: ["fermata", "metronome", "measure-style"],
  C: ["pedal", "staccato", "staccatissimo", "accent", "strong-accent", "tenuto", "detached-legato",
      "dynamics", "wedge", "slur"],
  D: ["harmony", "rehearsal"],
};

export const TIER_OF = (() => {
  const m = {};
  for (const [tier, tags] of Object.entries(NOTATION_TIERS)) for (const t of tags) m[t] = tier;
  return m;
})();

export function scanNotations(doc) {
  const perMeasure = new Map(); // tag -> [measure numbers]
  const measures = [...doc.querySelectorAll("part")][0]?.querySelectorAll("measure") ?? [];
  [...measures].forEach((m, idx) => {
    for (const tag of Object.keys(TIER_OF)) {
      if (m.querySelector(tag)) {
        if (!perMeasure.has(tag)) perMeasure.set(tag, []);
        perMeasure.get(tag).push(idx + 1);
      }
    }
  });
  // Tempo changes: songParser keeps only the first <sound tempo>.
  const tempos = [...doc.querySelectorAll("sound[tempo]")].map((s) => s.getAttribute("tempo"));
  const distinct = [...new Set(tempos)];
  return { perMeasure, tempos, distinctTempos: distinct };
}

/**
 * Independent implementation of spec §3.6's per-voice-per-song hand assignment.
 *
 * The parser has its own copy in src/sam/lib/songParser.js. Truth deliberately
 * does NOT import from there — hand assignment is the judgment call §3.6 is
 * about, and if both sides shared a single function a design error inside it
 * would be invisible (both agree, both report clean). Duration math, pitch
 * extraction, tuplet ratios, voice grouping, merge segmentation, and playback
 * order all stay independent; hand assignment must too. Implementation
 * divergence between the two copies surfaces via HAND_ASSIGNMENT_MISMATCH.
 *
 * Rule (spec §3.6):
 *   Tally each voice NUMBER's <staff> distribution across the whole song.
 *   Assign each voice to its majority staff — every note of that voice
 *   goes there, including notes engraved on the other staff. <60% majority
 *   FLAGs but still picks the best.
 *
 * Returns Map<voiceNumber, { hand, staff, majority, tally }> — the
 * per-voice detail so the reporter can print an assignment line.
 */
function computeHandAssignmentTruth(measures) {
  const tallies = new Map(); // voice -> Map<staff, note_count>
  for (const m of measures) {
    for (const [key, evs] of m.voices) {
      const [staff, voice] = key.split(":");
      const noteCount = evs.filter((e) => !e.rest && e.notes.length > 0).length;
      if (noteCount === 0) continue;
      if (!tallies.has(voice)) tallies.set(voice, new Map());
      const staffCounts = tallies.get(voice);
      staffCounts.set(staff, (staffCounts.get(staff) || 0) + noteCount);
    }
  }
  const out = new Map();
  for (const [voice, staffCounts] of tallies) {
    let bestStaff = null;
    let bestCount = 0;
    let total = 0;
    for (const [staff, count] of staffCounts) {
      total += count;
      if (count > bestCount) {
        bestStaff = staff;
        bestCount = count;
      }
    }
    if (total === 0) continue;
    out.set(voice, {
      hand: bestStaff === "1" ? "rh" : "lh",
      staff: bestStaff,
      majority: bestCount / total,
      tally: Object.fromEntries(staffCounts),
    });
  }
  return out;
}

/**
 * Apply the hand assignment to a measure's voices Map: every voice's events
 * get rekeyed to the voice's assigned staff, regardless of the original
 * engraved staff. Then re-sort by onset so a cross-staff voice's events
 * (which may have arrived under two different keys) form a monotonic
 * timeline for mergeStaff.
 */
function applyAssignmentToMeasure(voices, assignment) {
  const out = new Map();
  for (const [key, evs] of voices) {
    const [origStaff, voice] = key.split(":");
    const info = assignment.get(voice);
    const assignedStaff = info ? info.staff : origStaff;
    const newKey = `${assignedStaff}:${voice}`;
    const existing = out.get(newKey) || [];
    existing.push(...evs);
    out.set(newKey, existing);
  }
  for (const [, evs] of out) {
    evs.sort((a, b) => a.onset - b.onset);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Truth's contract (Alex, 2026-08-05, M3):
//
// Truth models sounding content and hand assignment — the musical decisions.
// It does not model representational padding — silence added to satisfy
// SAM's storage invariants. Where the parser adds silence the source
// doesn't contain, that is a parser-layer concern and the validator
// accounts for it explicitly rather than truth mirroring it.
//
// This is why xmlTruth applies §3.6 hand assignment (musical: changes which
// notes sound in which hand) but does NOT apply §3.7 trailing-rest padding
// (representational: satisfies mLen-sum invariant, changes no sounding
// content). Two independent implementations of "append a rest to reach
// mLen" would agree by construction and buy nothing. `firstDivergence`
// in validate.js has an explicit trailing-silence exception for this.
// ---------------------------------------------------------------------------

export function buildTruth(xmlString) {
  const dom = new JSDOM(xmlString, { contentType: "text/xml" });
  const doc = dom.window.document;

  const title =
    text(doc, "work > work-title") || text(doc, "movement-title") || "Untitled";
  const parts = [...doc.querySelectorAll("part")];
  if (parts.length === 0) throw new Error("No parts found");

  // Detect whether §3.6 applies. Single-staff single-part sources use a
  // per-note midi<60 fallback (spec §3.6 last paragraph); two-parts-as-two-
  // staves has per-part authority. Both skip song-level tally — the parser
  // does the same, and running the tally would confuse voice numbers that
  // collide across parts.
  const firstPart = parts[0];
  const stavesEl = firstPart.querySelector("attributes > staves");
  const numStaves = stavesEl ? parseInt(stavesEl.textContent, 10) : 1;
  const useTwoParts = numStaves === 1 && parts.length >= 2;
  const applyThreeSix = !(numStaves === 1 && !useTwoParts) && !useTwoParts;

  const measEls = [...parts[0].querySelectorAll("measure")];
  const state = { divisions: 1, beats: 4, beatType: 4, symbol: null, fifths: 0, mode: null };

  // Phase 1: parse every measure into the source-shape (voices keyed by
  // per-note staff). This is the raw fact from the XML.
  const measuresRaw = measEls.map((el, idx) => {
    const parsed = parseMeasure(el, state);
    const staffVoices = { 1: [], 2: [] };
    for (const k of parsed.voices.keys()) {
      const [s] = k.split(":");
      if (staffVoices[s]) staffVoices[s].push(k);
    }
    return { number: idx + 1, ...parsed, staffVoices };
  });

  // Phase 2: compute the song-level assignment (independent of the parser's
  // implementation). Skip when §3.6 doesn't apply.
  const handAssignment = applyThreeSix
    ? computeHandAssignmentTruth(measuresRaw)
    : new Map();

  // Phase 3: apply assignment, then run mergeStaff per hand. staffVoices
  // stays as computed above — it's the source-level fact, and the cross_staff
  // label depends on it.
  const measures = measuresRaw.map((m) => {
    const assignedVoices = applyThreeSix
      ? applyAssignmentToMeasure(m.voices, handAssignment)
      : m.voices;
    const rh = mergeStaff(assignedVoices, "1", m.measureLen);
    const lh = mergeStaff(assignedVoices, "2", m.measureLen);
    return { ...m, rh, lh };
  });

  const playback = resolvePlaybackOrder(measEls);
  const implicitFirst = measEls[0]?.getAttribute("implicit") === "yes";
  const notations = scanNotations(doc);

  return {
    implicitFirst,
    notations,
    title,
    partCount: parts.length,
    numStaves,
    useTwoParts,
    applyThreeSix,
    handAssignment,  // Map<voice, { hand, staff, majority, tally }>
    measureCount: measures.length,
    measures,
    playback,
    fifths: measures[0]?.fifths ?? 0,
    mode: measures.find((m) => m.mode)?.mode ?? null,
  };
}
