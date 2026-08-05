// Runs the real songParser.js against a score and diffs its output against
// ground truth from xmlTruth.js. Classifies every divergence by defect type.

import { JSDOM } from "jsdom";
import { buildTruth, TIER_OF } from "./xmlTruth.js";
import { tokenToBeats, sumEvents, measureBeats, beatsToToken } from "./durations.js";

// songParser.js expects a browser global.
const shim = new JSDOM("", { contentType: "text/html" });
globalThis.DOMParser = shim.window.DOMParser;

const { parseMusicXML } = await import("../vendor/songParser.js");

export const DEFECTS = {
  VOICE_COLLISION: "voice_collision",
  TUPLET_SCALING: "tuplet_scaling",
  MEASURE_OVERFLOW: "measure_overflow",
  MEASURE_UNDERFLOW: "measure_underflow",
  UNFLATTENED_REPEAT: "unflattened_repeat",
  UNRESOLVED_NAVIGATION: "unresolved_navigation",
  GAP_FILL_INEXACT: "gap_fill_inexact",
  UNKNOWN_DURATION: "unknown_duration",
  ORPHAN_TIE: "orphan_tie",
  NOTES_UNSORTED: "notes_unsorted",
  GRACE_DROPPED: "grace_dropped",
  CROSS_STAFF: "cross_staff",
  CONTENT_DIVERGENCE: "content_divergence",
  HAND_ASSIGNMENT_MISMATCH: "hand_assignment_mismatch",
  KEY_MODE_WRONG: "key_mode_wrong",
  PARSE_ERROR: "parse_error",
  ANACRUSIS: "anacrusis",
  INCOMPLETE_MEASURE: "incomplete_measure",
  UNHANDLED_PITCH: "unhandled_notation_pitch",
  UNHANDLED_TIMING: "unhandled_notation_timing",
  UNHANDLED_TONE: "unhandled_notation_tone",
  DISCARDED_METADATA: "discarded_metadata",
  TEMPO_CHANGES_LOST: "tempo_changes_lost",
};

export function validate(xmlString, label) {
  const findings = [];
  const add = (defect, measure, hand, detail) =>
    findings.push({ defect, measure, hand, detail });

  const truth = buildTruth(xmlString);

  let parsed;
  try {
    parsed = parseMusicXML(xmlString);
  } catch (err) {
    add(DEFECTS.PARSE_ERROR, null, null, err.message);
    return { label, truth, parsed: null, findings, summary: summarise(findings) };
  }

  // ---- Song-level ----------------------------------------------------------
  if (truth.playback.hasRepeats && parsed.measures.length === truth.measureCount) {
    add(
      DEFECTS.UNFLATTENED_REPEAT, null, null,
      `${truth.measureCount} written measures parsed as-is; playback order is ${truth.playback.order.length} measures`
    );
  }
  if (truth.playback.hasNavigation) {
    add(
      DEFECTS.UNRESOLVED_NAVIGATION, null, null,
      truth.playback.navMarks.map((n) => `m${n.measure}:${n.marks.join("+")}`).join(" ")
    );
  }
  // fifths is trustworthy; <mode> is not. Flag only when the source contradicts itself.
  if (truth.mode && truth.fifths < 0 && truth.mode === "major") {
    add(DEFECTS.KEY_MODE_WRONG, null, null,
      `source declares mode=${truth.mode} at fifths=${truth.fifths}; label may be the relative major`);
  }

  // ---- Unhandled notations -------------------------------------------------
  // songParser.js reads none of these. Nothing that affects playback should be
  // dropped silently, so each is reported at the severity of its impact.
  const TIER_DEFECT = {
    A: DEFECTS.UNHANDLED_PITCH,
    B: DEFECTS.UNHANDLED_TIMING,
    C: DEFECTS.UNHANDLED_TONE,
    D: DEFECTS.DISCARDED_METADATA,
  };
  for (const [tag, list] of truth.notations.perMeasure) {
    const defect = TIER_DEFECT[TIER_OF[tag]];
    add(defect, null, null, `<${tag}> x${list.length} — m${list.slice(0, 8).join(", ")}${list.length > 8 ? ", +" + (list.length - 8) : ""}`);
  }
  if (truth.notations.distinctTempos.length > 1) {
    add(DEFECTS.TEMPO_CHANGES_LOST, null, null,
      `${truth.notations.tempos.length} tempo marks (${truth.notations.distinctTempos.length} distinct: ` +
      `${truth.notations.distinctTempos.slice(0, 8).join(", ")}); parser keeps only the first`);
  }

  // ---- Per measure ---------------------------------------------------------
  const nCompare = Math.min(parsed.measures.length, truth.measures.length);

  // Anacrusis: MuseScore marks it implicit="yes"; otherwise infer from a short m1.
  // A later short measure whose length + pickup = one bar is the borrowed partner
  // at a repeat seam (Fur Elise m1 + m9). Neither may be padded.
  let pickup = null;
  if (truth.measures.length) {
    const m0 = truth.measures[0];
    const s0 = sumEvents(parsed.measures[0]?.rh ?? []);
    if (truth.implicitFirst || (s0 !== null && s0 < m0.measureLen - 1e-6)) pickup = s0;
  }

  for (let i = 0; i < nCompare; i++) {
    const pm = parsed.measures[i];
    const tm = truth.measures[i];
    const mNum = i + 1;
    const mLen = measureBeats(pm.timeSignature);

    if (tm.flags.graceNotes > 0) {
      add(DEFECTS.GRACE_DROPPED, mNum, null, `${tm.flags.graceNotes} grace note(s) silently dropped`);
    }
    // Informational only — cross-staff engraving is expected input under
    // spec §3.6 (Moonlight's arpeggio convention, Beethoven's cross-staff
    // lines), NOT a defect. The correct parser handles it via song-level
    // per-voice hand assignment. Any actual routing mistake surfaces below
    // as CROSS_STAFF-labeled content_divergence (sum matches) or as
    // MEASURE_OVERFLOW / INCOMPLETE_MEASURE (sum fails). Kept at severity 5.
    for (const key of tm.flags.crossStaffVoices) {
      add(DEFECTS.CROSS_STAFF, mNum, null,
        `${key} — cross-staff engraving present (§3.6: expected input, informational only)`);
    }

    for (const [hand, staff] of [["rh", "1"], ["lh", "2"]]) {
      const events = pm[hand];
      const expected = hand === "rh" ? tm.rh : tm.lh;

      for (const e of events) {
        if (tokenToBeats(e.duration) === null) {
          add(DEFECTS.UNKNOWN_DURATION, mNum, hand, `token "${e.duration}"`);
        }
      }

      const sum = sumEvents(events);
      if (sum === null) continue;

      const multivoice = (tm.staffVoices[staff] || []).length > 1;
      // TUPLET_SCALING fires whenever the source contains a
      // <time-modification> and the (tuplet-aware) sum still doesn't match
      // the measure. sumEvents (see durations.js) already multiplies by
      // normal/actual per spec §4.2, so a parser that carries the marker
      // on every affected event AND doesn't misroute those events between
      // staves will sum correctly and skip this class. The remaining
      // failures split three ways: parser dropped the marker entirely;
      // parser has partial coverage (a chord-member or cross-staff note
      // lost its marker in buildVoice); or a cross-staff routing puts the
      // wrong notes on this hand. All three are legitimate tuplet-related
      // handling issues, so all three stay TUPLET_SCALING with a hint at
      // which sub-case looks likely.
      const parserHasTuplet = events.some((e) => e.tuplet);
      const truthHasTuplet = [...tm.voices.entries()].some(
        ([k, evs]) => k.startsWith(`${staff}:`) && evs.some((e) => e.tuplet)
      );

      if (Math.abs(sum - mLen) > 1e-6) {
        // A measure can carry more than one defect; report each independently
        // so a fix for one doesn't mask the other.
        if (truthHasTuplet) {
          const hint = parserHasTuplet
            ? "parser has partial tuplet coverage or cross-staff misrouting"
            : "parser dropped the tuplet marker";
          add(DEFECTS.TUPLET_SCALING, mNum, hand,
            `sums to ${round(sum)} of ${mLen} after tuplet ratio applied; ${hint}`);
        }
        if (multivoice) {
          add(DEFECTS.VOICE_COLLISION, mNum, hand,
            `sums to ${round(sum)} of ${mLen}; ${tm.staffVoices[staff].join(" + ")} flattened serially`);
        }
        if (!truthHasTuplet && !multivoice) {
          if (sum > mLen) {
            add(DEFECTS.MEASURE_OVERFLOW, mNum, hand, `sums to ${round(sum)} of ${mLen}`);
          } else {
            const src = [...tm.voices.entries()].filter(([k]) => k.startsWith(`${staff}:`));
            const srcSum = src.reduce((s, [, evs]) => s + evs.reduce((a, e) => a + e.dur, 0), 0);
            const short = mLen - sum;
            if (pickup !== null && mNum === 1 && Math.abs(short - (mLen - pickup)) < 1e-6) {
              add(DEFECTS.ANACRUSIS, mNum, hand, `pickup of ${round(sum)} of ${mLen} — keep short, do NOT pad`);
            } else if (pickup !== null && Math.abs(sum + pickup - mLen) < 1e-6) {
              add(DEFECTS.ANACRUSIS, mNum, hand,
                `${round(sum)} of ${mLen}; + pickup ${round(pickup)} = one full bar — borrowed partner, do NOT pad`);
            } else {
              add(DEFECTS.INCOMPLETE_MEASURE, mNum, hand,
                `sums to ${round(sum)} of ${mLen}` +
                (Math.abs(srcSum - sum) < 1e-6 ? " — source is short; pad with trailing rest" : ""));
            }
          }
        }
      } else {
        // Sum matches mLen (tuplet-aware). Run the divergence walk
        // unconditionally — the flags below only decide what to CALL the
        // finding, never whether to look for one. Silent voice-collision,
        // silent tuplet-scaling, silent cross-staff misrouting all show
        // up here as real divergence. Correctly-handled measures pass this
        // gate cleanly.
        const div = firstDivergence(events, expected);
        if (div.status === "divergent" || div.status === "inconclusive") {
          const reason = div.status === "inconclusive"
            ? `inconclusive divergence check: ${div.reason}`
            : `SILENT (sum passes, content differs). ${div.note} at beat ${round(div.beat)}: parser=${div.got}, truth=${div.want}`;
          const hasCrossStaff = tm.flags.crossStaffVoices.size > 0;
          // Label priority: tuplet-handling first (most specific to §3.2 /
          // §4.2), then cross-staff (§3.6), then voice-flattening, then
          // catch-all content_divergence. A measure with more than one flag
          // gets the most-specific label; classes are for triage, not
          // taxonomy — the divergence itself is the signal.
          //
          // Multi-label detail: append every OTHER applicable cause to the
          // detail text so a measure whose root cause is cross-staff
          // misrouting is diagnosable even when the finding gets labeled
          // tuplet_scaling. Priority chooses the class; the parenthetical
          // preserves the full triage picture.
          let defect, primaryCause;
          if (truthHasTuplet) { defect = DEFECTS.TUPLET_SCALING; primaryCause = "tuplet"; }
          else if (hasCrossStaff) { defect = DEFECTS.CROSS_STAFF; primaryCause = "cross-staff"; }
          else if (multivoice) { defect = DEFECTS.VOICE_COLLISION; primaryCause = "multivoice"; }
          else { defect = DEFECTS.CONTENT_DIVERGENCE; primaryCause = null; }
          const otherCauses = [
            truthHasTuplet && primaryCause !== "tuplet" ? "tuplet" : null,
            hasCrossStaff && primaryCause !== "cross-staff" ? "cross-staff" : null,
            multivoice && primaryCause !== "multivoice" ? "multivoice" : null,
          ].filter(Boolean);
          const suffix = otherCauses.length > 0 ? ` (also: ${otherCauses.join(", ")})` : "";
          add(defect, mNum, hand, reason + suffix);
        }
      }

      // Rest gap-fill that cannot be expressed as one token.
      for (const e of events) {
        if (e.notes.length === 0 && tokenToBeats(e.duration) !== null) {
          const b = tokenToBeats(e.duration);
          if (beatsToToken(b) === null) {
            add(DEFECTS.GAP_FILL_INEXACT, mNum, hand, `rest "${e.duration}"`);
          }
        }
      }

      // notes[] not ascending by midi — breaks any "top note" rule.
      for (const e of events) {
        if (e.notes.length > 1) {
          const midis = e.notes.map((n) => n.midi);
          if (Math.max(...midis) !== midis[midis.length - 1]) {
            add(DEFECTS.NOTES_UNSORTED, mNum, hand, `[${midis.join(",")}]`);
            break;
          }
        }
      }
    }
  }

  // ---- Tie integrity across the whole song --------------------------------
  for (const hand of ["rh", "lh"]) {
    let open = new Set();
    for (const m of parsed.measures) {
      for (const e of m[hand]) {
        const starts = new Set();
        const ends = new Set();
        for (const n of e.notes) {
          if (n.tie === "start" || n.tie === "both") starts.add(n.midi);
          if (n.tie === "end" || n.tie === "both") ends.add(n.midi);
        }
        for (const midi of ends) {
          if (!open.has(midi)) {
            add(DEFECTS.ORPHAN_TIE, m.number, hand, `tie end with no start (midi ${midi})`);
          }
        }
        open = new Set([...open].filter((x) => !ends.has(x)));
        for (const s of starts) open.add(s);
      }
    }
    for (const midi of open) {
      add(DEFECTS.ORPHAN_TIE, null, hand, `tie start never closed (midi ${midi})`);
    }
  }

  // ---- Hand-assignment cross-check ---------------------------------------
  // Reconstruct the parser's per-voice hand assignment from its output and
  // compare against truth.handAssignment (independently computed by
  // xmlTruth.js from the same XML). Fire HAND_ASSIGNMENT_MISMATCH when they
  // disagree — that's a bug in one side's §3.6 implementation, invisible to
  // any per-measure divergence check because both parser and truth would
  // route in a self-consistent but wrong way.
  //
  // Also fires when the parser emits a single voice number on more than one
  // hand across the song. Under §3.6 a voice belongs to exactly one hand;
  // seeing it on both means the parser's assignment leaked.
  if (truth.handAssignment && truth.handAssignment.size > 0) {
    const parserVoiceHands = new Map();  // voice -> Map<hand, note_count>
    for (const m of parsed.measures) {
      for (const [hand, events] of [["rh", m.rh], ["lh", m.lh]]) {
        for (const e of events || []) {
          if (e.voice === undefined) continue;
          if (!e.notes || e.notes.length === 0) continue;
          if (!parserVoiceHands.has(e.voice)) parserVoiceHands.set(e.voice, new Map());
          const handCounts = parserVoiceHands.get(e.voice);
          handCounts.set(hand, (handCounts.get(hand) || 0) + 1);
        }
      }
    }
    for (const [voice, handCounts] of parserVoiceHands) {
      if (handCounts.size > 1) {
        const dist = [...handCounts.entries()].map(([h, c]) => `${h}: ${c}`).join(", ");
        add(DEFECTS.HAND_ASSIGNMENT_MISMATCH, null, null,
          `voice ${voice}: parser emits notes on both hands (${dist}) — assignment leaked`);
      }
    }
    for (const [voice, info] of truth.handAssignment) {
      const parserHands = parserVoiceHands.get(voice);
      if (!parserHands || parserHands.size === 0) continue;
      const parserHand = [...parserHands.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (parserHand !== info.hand) {
        add(DEFECTS.HAND_ASSIGNMENT_MISMATCH, null, null,
          `voice ${voice}: parser → ${parserHand}, truth → ${info.hand} ` +
          `(truth majority staff ${info.staff} at ${(info.majority * 100).toFixed(0)}%)`);
      }
    }
  }

  return { label, truth, parsed, findings, summary: summarise(findings) };
}

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * Compare a parser voice array against a truth timeline.
 *
 * Return shape (contract):
 *   { status: "clean" }
 *   { status: "inconclusive", reason }   // hit an unknown token; cannot decide
 *   { status: "divergent", beat, got, want, note }
 *
 * Callers may gate a finding on `status !== "clean"`; do NOT treat
 * "inconclusive" as "clean". An unknown token upstream should have already
 * fired UNKNOWN_DURATION, but if it slips through, "inconclusive" surfaces
 * that this measure was not actually verified.
 *
 * Bidirectional: any onset in either side that lacks a matching-content
 * partner in the other is a divergence. Empty notes[] (rest) at an onset
 * truth doesn't have is still a divergence — silence-in-wrong-places is
 * as wrong as pitches-in-wrong-places. Event counts are compared first so
 * segmentation differences surface before we walk beat-by-beat.
 *
 * Parser beat math is tuplet-aware (multiply by normal/actual) so onset
 * positions align with truth's sounded-time onsets from mergeStaff.
 */
function firstDivergence(events, expected) {
  const eps = 1e-6;

  const got = [];
  let beat = 0;
  for (const e of events) {
    const b = tokenToBeats(e.duration);
    if (b === null) {
      return { status: "inconclusive", reason: `unknown duration token "${e.duration}"` };
    }
    const scaled = e.tuplet ? (b * e.tuplet.normal) / e.tuplet.actual : b;
    got.push({
      beat,
      notes: e.notes.map((n) => n.midi).sort((x, y) => x - y),
    });
    beat += scaled;
  }

  const want = expected.map((e) => ({
    beat: e.onset,
    notes: e.notes.map((n) => n.midi).sort((x, y) => x - y),
  }));

  // want → got direction (parser missing onsets truth expects)
  for (const w of want) {
    const g = got.find((x) => Math.abs(x.beat - w.beat) < eps);
    if (!g) {
      return {
        status: "divergent",
        beat: w.beat,
        got: "(no event at this beat)",
        want: `[${w.notes.join(",")}]`,
        note: "parser missing onset present in truth",
      };
    }
    if (g.notes.join(",") !== w.notes.join(",")) {
      return {
        status: "divergent",
        beat: w.beat,
        got: `[${g.notes.join(",")}]`,
        want: `[${w.notes.join(",")}]`,
        note: "notes at shared onset differ",
      };
    }
  }

  // got → want direction (parser emitting onsets truth doesn't have).
  //
  // Trailing-silence exception (spec §M3, Alex 2026-08-05):
  //   Truth models sounding content and hand assignment. It does NOT model
  //   representational padding — trailing rests the parser appends to
  //   satisfy SAM's storage invariant that per-hand sums equal measureLen.
  //   A parser onset past truth's last onset with EMPTY NOTES is legitimate
  //   representational padding (Prelude m43: parser [q chord, h rest] vs
  //   truth [q chord]); it MUST NOT fire divergence.
  //
  //   Guard: this narrowing only exempts trailing rests. A parser onset
  //   past truth's last with NON-empty notes still fires (parser has extra
  //   sounding content). A mid-timeline rest inserted where truth has a
  //   note still fires (caught by the want → got direction's pitch check
  //   above, which sees an onset with truth-notes present but got-notes
  //   empty).
  //
  //   Wrong-padding safety: if the parser wrongly pads an anacrusis (e.g.,
  //   Für Elise m1 padded to 1.5), this check reads clean — but validate.js's
  //   independent §3.7 classifier sees sum == mLen and no longer fires the
  //   anacrusis finding. The corpus anacrusis count then drops from 4 and
  //   the exit criterion catches it. Traced end-to-end 2026-08-05.
  const lastWantBeat = want.length > 0 ? Math.max(...want.map((w) => w.beat)) : 0;
  for (const g of got) {
    const w = want.find((x) => Math.abs(x.beat - g.beat) < eps);
    if (w) continue;
    if (g.beat > lastWantBeat - eps && g.notes.length === 0) continue;
    return {
      status: "divergent",
      beat: g.beat,
      got: g.notes.length === 0 ? "(rest)" : `[${g.notes.join(",")}]`,
      want: "(no event at this beat)",
      note: "parser has onset absent from truth",
    };
  }
  return { status: "clean" };
}

function summarise(findings) {
  const counts = {};
  const measures = {};
  for (const f of findings) {
    counts[f.defect] = (counts[f.defect] || 0) + 1;
    if (f.measure != null) {
      (measures[f.defect] ||= new Set()).add(f.measure);
    }
  }
  const out = {};
  for (const k of Object.keys(counts)) {
    out[k] = {
      count: counts[k],
      measures: measures[k] ? [...measures[k]].sort((a, b) => a - b) : [],
    };
  }
  return out;
}
