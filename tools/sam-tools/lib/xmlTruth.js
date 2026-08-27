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
    // <transpose>: NOT modeled here. Empirical evidence from Für Elise
    // and Entertainer (Alex, 2026-08-05) shows MusicXML <pitch> already
    // encodes the SOUNDING pitch — the transformation is a display /
    // engraving concern, and applying it here double-transposes. See
    // spec §5 amendment: transpose is CARRY, not HANDLE. When a
    // corpus fixture with <transpose> arrives, truth should emit a
    // distinct "cannot verify" finding rather than guess at a
    // transformation; never apply an unverified pitch shift to the
    // reference.
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
    // <direction> with <octave-shift>: NOT modeled here. Empirical
    // evidence (Alex, 2026-08-05):
    //   Für Elise idx82 <pitch> values are A5 C6 E6 A6 C7 E7 — under
    //   an octave-shift down/8 bracket. Applying +12 yields A6 C7 E7
    //   A7 C8 E8, which runs off the top of an 88-key piano and
    //   creates a 2-octave discontinuity at the bracket's stop.
    //   The <pitch> values ALREADY encode the sounding pitch;
    //   <octave-shift> describes how the passage is DRAWN (engraved an
    //   octave lower under an 8va bracket to avoid ledger lines),
    //   same family as <time symbol="cut">. See spec §5 amendment.
    //   Applying it double-transposes. If M6/M7 CARRIES the shift for
    //   the renderer, that's a parser output field, not a truth
    //   transformation.
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

/** A note the segmentation says was already sounding — a hold, not a strike. */
const isHeld = (n) => n.tie === "end" || n.tie === "both";

/**
 * Collapse duplicate pitches within one merged segment — the oracle's own
 * statement of what the correct output is.
 *
 * Deliberately NOT a call into songParser's mergeDuplicatePitches. The oracle
 * exists to be able to disagree with the parser; if both sides ran the same
 * predicate, a bug inside it would cancel out and the validator would report
 * clean — including the case that matters most, a legitimate pair wrongly
 * merged. Same rule, independent code, on purpose.
 *
 * The rule: two entries for one `midi` are the same sounding pitch and collapse
 * — UNLESS either is held, which means one voice is sustaining the pitch while
 * another strikes it fresh. Those are two distinct sounding events and both
 * survive (Moonlight m60, Someone Like You m27; the app's noteTimeline.js
 * tie-chain walk depends on it).
 *
 * The held/fresh distinction is derived here from this file's own segmentation
 * — `isFirst`/`isLast` below force a tie onto any fragment whose source event
 * crosses the segment boundary — so nothing about it is imported from the
 * parser.
 *
 * Notes here are {midi, name, tie?}; the oracle reads no other property from
 * the XML. So the union reduces to: keep the first spelling, and keep a "start"
 * if either entry carried one. A spelling disagreement is dropped silently —
 * the oracle is compared on pitch, and it has no warning channel.
 */
function collapseSoundingDuplicates(notes) {
  if (notes.length < 2) return notes;

  // Pass 1 — how many FRESH strikes does each pitch have in this segment?
  const freshPerMidi = new Map();
  for (const n of notes) {
    if (isHeld(n)) continue;
    freshPerMidi.set(n.midi, (freshPerMidi.get(n.midi) || 0) + 1);
  }
  let anyCollapsible = false;
  for (const count of freshPerMidi.values()) {
    if (count > 1) { anyCollapsible = true; break; }
  }
  if (!anyCollapsible) return notes;

  // Pass 2 — emit in order, folding each over-counted pitch into its first
  // fresh entry. Held entries and single-strike pitches pass through untouched.
  const out = [];
  const foldedAt = new Map();
  for (const n of notes) {
    if (isHeld(n) || freshPerMidi.get(n.midi) === 1) {
      out.push(n);
      continue;
    }
    const at = foldedAt.get(n.midi);
    if (at === undefined) {
      foldedAt.set(n.midi, out.length);
      out.push({ ...n });
      continue;
    }
    // Only "start" can reach here — "end"/"both" are held and never folded.
    if (n.tie === "start") out[at].tie = "start";
  }
  return out;
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
    // Two voices sounding one pitch is one sounding pitch. Collapse before
    // this becomes an expected event, so the oracle states the correct output
    // rather than reproducing the parser's old defect.
    const sounding = collapseSoundingDuplicates(notes);
    const seg = { onset: t0, dur: t1 - t0, notes: sounding, rest: sounding.length === 0 };
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
 *
 * Tier reclassifications (Alex, 2026-08-05, spec §5 amendment):
 *   octave-shift   A → C   display element (bracket over already-correct
 *                          pitches); MusicXML <pitch> is sounding pitch.
 *                          Empirical evidence: Für Elise idx82's
 *                          A5-C6-E6-A6-C7-E7 would double-transpose off
 *                          the piano if treated as A. Same family as
 *                          <time symbol="cut">.
 *   arpeggiate     A → B   rolled chord — same pitches, staggered onsets.
 *                          Timing change, not pitch change.
 *   non-arpeggiate A → B   same reasoning (explicit-no-roll marker also
 *                          affects the temporal placement expectation).
 *
 * Original tier assignments were made from tag names during the initial
 * notation scan and NOT verified against behaviour. Two were wrong (see
 * above). If a future milestone touches a tier-A tag, verify what it
 * actually does to sounding pitch before implementing anything.
 */
export const NOTATION_TIERS = {
  A: ["transpose", "trill-mark", "mordent", "inverted-mordent",
      "turn", "inverted-turn", "tremolo", "glissando", "slide", "cue"],
  B: ["fermata", "metronome", "measure-style", "arpeggiate", "non-arpeggiate"],
  C: ["octave-shift",
      "pedal", "staccato", "staccatissimo", "accent", "strong-accent", "tenuto", "detached-legato",
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
 * Per-voice engraved-staff note counts across the whole song. A FACT about the
 * source, not a routing decision.
 *
 * M4 removed `computeHandAssignmentTruth`, which used to derive the §3.6
 * assignment here so validate.js could compare it against the parser's. That
 * was the right shape while the rule was "one voice, one hand for the whole
 * song" — but §3.6 is now per-run, and hand assignment is a POLICY with free
 * parameters (the 60% majority threshold, the run length, tie-breaks, what
 * counts as a note). Two independent implementations of a policy do not
 * converge on scores neither has seen; they only agree where both encode the
 * same arbitrary constants, at which point the second one is a copy with
 * different spelling and every future refinement costs a mirroring pass.
 *
 * So the oracle no longer has an opinion about routing. `buildTruth` takes the
 * parser's routing as an input and answers the question that IS a fact —
 * "given that you routed it this way, is the content in each hand right?" —
 * while validate.js checks the routing itself against invariants that hold for
 * any correct assignment. Facts here, policy in the parser's own tests.
 */
function voiceStaffTally(measures) {
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
  return tallies;
}

/**
 * Apply the CALLER'S routing to a measure's voices Map: every voice's events
 * get rekeyed to the staff the routing names, regardless of the original
 * engraved staff. Then re-sort by onset so a cross-staff voice's events
 * (which may have arrived under two different keys) form a monotonic
 * timeline for mergeStaff.
 *
 * `routing` is Map<voice, staff> for THIS measure. A voice the routing does
 * not mention stays on the staff it was engraved on.
 */
function applyAssignmentToMeasure(voices, routing) {
  const out = new Map();
  for (const [key, evs] of voices) {
    const [origStaff, voice] = key.split(":");
    const assignedStaff = (routing && routing.get(voice)) || origStaff;
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

/**
 * @param xmlString      the source MusicXML
 * @param options.routing  OPTIONAL per-measure routing, supplied by the caller:
 *   an array indexed by SOURCE measure (0-based) of Map<voice, staff>. When
 *   present, each measure's voices are rekeyed to the staff the caller names
 *   before mergeStaff runs, so truth's rh/lh describe the content that SHOULD
 *   appear given that routing.
 *
 *   The oracle deliberately does not decide routing itself — see
 *   `voiceStaffTally` above. Omit it and every voice stays on the staff it was
 *   engraved on, which is the right answer for the error path and for callers
 *   that only want the source facts, but is NOT comparable to parser output on
 *   any score with a cross-staff voice.
 */
export function buildTruth(xmlString, options = {}) {
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
    // sourceAttribute is the raw <measure number="…"> string from the
    // XML. Mirror parser.measures[i].sourceMeasure so validate.js can
    // compare playback shape by a key stable across pickup-bearing
    // scores (Für Elise's source starts at "0"; truth's `number` is
    // 1-based array position, which drifts from the raw attribute).
    return { number: idx + 1, sourceAttribute: el.getAttribute("number"), ...parsed, staffVoices };
  });

  // Phase 2: the source-level fact about where each voice was engraved.
  // NOT a routing decision — see voiceStaffTally's comment.
  const tallies = voiceStaffTally(measuresRaw);

  // Phase 3: apply the CALLER's routing, then run mergeStaff per hand.
  // staffVoices stays as computed above — it's the source-level fact, and the
  // cross_staff label depends on it.
  const routing = options.routing || null;
  const measures = measuresRaw.map((m, idx) => {
    const assignedVoices = routing
      ? applyAssignmentToMeasure(m.voices, routing[idx])
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
    voiceStaffTallies: tallies,  // Map<voice, Map<staff, note_count>> — a fact
    routed: Boolean(routing),
    measureCount: measures.length,
    measures,
    playback,
    fifths: measures[0]?.fifths ?? 0,
    mode: measures.find((m) => m.mode)?.mode ?? null,
  };
}
