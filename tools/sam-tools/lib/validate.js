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
  // MEASURE_UNDERFLOW removed 2026-08-05 — dead entry, never `add`-ed.
  // Superseded by ANACRUSIS (spec §3.7-legitimate short) and
  // INCOMPLETE_MEASURE (parser bug — hand actually short). Leaving the
  // name in the enum invites accidental reuse.
  UNFLATTENED_REPEAT: "unflattened_repeat",
  UNRESOLVED_NAVIGATION: "unresolved_navigation",
  GAP_FILL_INEXACT: "gap_fill_inexact",
  UNKNOWN_DURATION: "unknown_duration",
  ORPHAN_TIE: "orphan_tie",
  // Narrowed volta-seam sibling of ORPHAN_TIE (Alex, 2026-08-05).
  // Fires ONLY when the orphaned tie start satisfies all three:
  //   (1) it's on the FINAL EVENT of the source measure,
  //   (2) the source measure plays multiple times, and
  //   (3) the next-played source measure differs across plays.
  // That triangulates the exact "second ending doesn't close the tie
  // held into the first ending" pattern (Entertainer m35→mX2, m87→mX4).
  // Anything else stays ORPHAN_TIE at higher severity — a genuine
  // mid-measure drop or a real tie authoring bug still blocks.
  VOLTA_SEAM_TIE: "volta_seam_tie",
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
  //
  // M4 playback-order routing (Alex, 2026-08-05):
  //   Truth has always computed `truth.playback.order` (0-based indices
  //   into truth.measures, one per playback measure). Pre-M4 the parser
  //   didn't flatten, so the validator compared parsed[i] to
  //   truth.measures[i] by source index. Post-M4 the parser emits
  //   playback order; we route the truth side through playback.order so
  //   parsed[i] compares against the source measure it's actually
  //   playing.
  //
  //   When parsed.length !== truth.playback.order.length, parser and
  //   truth disagree on flattening — that IS a real M4 finding, not a
  //   bug to reconcile. In that case fall back to identity indexing so
  //   the mutation-test path (pre-M4 parser + this validator) still
  //   validates per-measure content correctly against the source
  //   measures it emitted.
  const flatteningMismatch = parsed.measures.length !== truth.playback.order.length;

  if (parsed.measures.length === truth.measureCount && truth.playback.hasRepeats) {
    // Parser emitted the source measures as-is; expected N played
    // measures but got the source count. Pre-M4 semantics.
    add(
      DEFECTS.UNFLATTENED_REPEAT, null, null,
      `${truth.measureCount} written measures parsed as-is; playback order is ${truth.playback.order.length} measures`
    );
  } else if (flatteningMismatch) {
    // Both flatten but the counts disagree — parser and truth resolve
    // playback differently. One side has a repeat/volta/D.S. handling
    // bug the other doesn't.
    add(
      DEFECTS.UNFLATTENED_REPEAT, null, null,
      `parser emitted ${parsed.measures.length} measures; truth playback order has ${truth.playback.order.length} — parser and truth disagree on flattening`
    );
  }
  // M5 (Alex, 2026-08-05): unresolved_navigation fires ONLY when parser
  // and truth resolve navigation to a different playback shape. The
  // pre-M5 check fired unconditionally on truth.hasNavigation and was
  // parser-independent — unsatisfiable by any parser change, same
  // failure mode as the pre-M2 cross_staff check. This is a correctness
  // check, not an informational demote: it catches implementation
  // DRIFT between the parser's playbackOrder.js and truth's
  // xmlTruth.js copy of the same algorithm. It does not catch design
  // error in the navigation rule itself — that requires a human read of
  // the flattened sequence against the source. Same caveat as §3.6's
  // truth mirror.
  //
  // Skip when parser and truth already disagree on length —
  // unflattened_repeat's second branch reported that at the song level.
  // Also skip when there's no navigation to worry about (repeats-only
  // scores get their shape verified by unflattened_repeat's length
  // check and the per-measure content walk).
  if (!flatteningMismatch && truth.playback.hasNavigation) {
    for (let i = 0; i < parsed.measures.length; i++) {
      const parserSrc = String(parsed.measures[i].sourceMeasure);
      const truthIdx = truth.playback.order[i];
      const truthSrc = String(truth.measures[truthIdx].sourceAttribute);
      if (parserSrc !== truthSrc) {
        add(DEFECTS.UNRESOLVED_NAVIGATION, i + 1, null,
          `play position ${i + 1}: parser plays source ${parserSrc}, ` +
          `truth expects ${truthSrc} — navigation resolved differently ` +
          `(marks: ${truth.playback.navMarks.map((n) => `m${n.measure}:${n.marks.join("+")}`).join(" ")})`);
        break;
      }
    }
  }
  // fifths is trustworthy; <mode> is not. Flag only when the source
  // contradicts itself. Purely a source-quality signal — parser design
  // uses fifths only, ignores mode (KEY_NAMES table in songParser.js:51
  // always emits "major"). Severity 5 (informational) as of M6; not
  // clearable by parser change.
  if (truth.mode && truth.fifths < 0 && truth.mode === "major") {
    add(DEFECTS.KEY_MODE_WRONG, null, null,
      `source declares mode=${truth.mode} at fifths=${truth.fifths}; ` +
      `parser correctly uses fifths only, so display name may not match ` +
      `the composer's intent. Source-quality signal, not a parser defect.`);
  }

  // ---- Unhandled notations (Alex M6 redesign, 2026-08-05) --------------
  //
  // The pre-M6 check fired one finding per truth-side notation occurrence,
  // parser-independent — unsatisfiable by any parser change. Redesigned
  // by evidence type into three groups (no self-certification manifest):
  //
  //   GROUP A — alters sounding content. Truth models the transformation
  //     so parser divergence surfaces as content_divergence on real
  //     evidence. No tier finding needed for these tags.
  //
  //     EMPTY for this corpus as of 2026-08-05 (Alex). Attempted
  //     to include <octave-shift> and <transpose> here, but empirical
  //     pitch inspection of Für Elise m80-83 and Entertainer m36-37
  //     showed MusicXML <pitch> already encodes sounding pitch —
  //     <octave-shift> is a DISPLAY element (engraved-lower-under-
  //     8va-bracket), same family as <time symbol="cut">. Applying
  //     the transformation double-transposes and runs off the piano.
  //     Spec §5 amended: octave-shift is CARRY (renderer stores it),
  //     not HANDLE. Mechanism kept for a future notation that
  //     genuinely alters sounding pitch; nothing currently uses it.
  //     If a <transpose> song appears, truth should emit a distinct
  //     "cannot verify" finding rather than guess — never apply an
  //     unverified pitch shift to the reference.
  //
  //   GROUP C — handled, doesn't alter pitch. Parser exposes an
  //     output field (measure.chord for <harmony>, measure.section for
  //     <rehearsal>, parsed.tempos for <sound tempo>). Check the field
  //     is populated on every source measure where the notation
  //     appears. Field-presence, not warning-presence — no way for a
  //     parser to self-certify by lying.
  //
  //   GROUP B — not implemented. Everything else. Parser adds a
  //     parseWarnings[] entry naming the tag when it encounters one.
  //     No warning + notation in truth → silent drop, fire the tier
  //     finding. Correctly-handled tags never enter this group (they
  //     move to A or C), so no false positives from lack of warning.
  //     <octave-shift> and <transpose> currently fall through to
  //     Group B — parser must warn (or CARRY the marker to move
  //     them to Group C later).
  const GROUP_A_TAGS = new Set();
  const GROUP_C_TAGS = new Set(["harmony", "rehearsal"]);
  const GROUP_C_FIELDS = { harmony: "chord", rehearsal: "section" };
  const TIER_DEFECT = {
    A: DEFECTS.UNHANDLED_PITCH,
    B: DEFECTS.UNHANDLED_TIMING,
    C: DEFECTS.UNHANDLED_TONE,
    D: DEFECTS.DISCARDED_METADATA,
  };
  // First-play lookup: find the first play position that plays a given
  // source index (0-based). Used by Group C to attribute the metadata
  // finding to a specific parser measure without double-reporting when
  // the same source plays twice via a repeat.
  const firstPlayOfSource = (sourceIdx0Based) => {
    const i = truth.playback.order.indexOf(sourceIdx0Based);
    return i === -1 ? null : i;
  };
  for (const [tag, sourceMeasureList] of truth.notations.perMeasure) {
    if (GROUP_A_TAGS.has(tag)) {
      // Truth applies the transformation; parser divergence surfaces via
      // content_divergence. No standalone finding here.
      continue;
    }
    if (GROUP_C_TAGS.has(tag)) {
      const field = GROUP_C_FIELDS[tag];
      const defect = TIER_DEFECT[TIER_OF[tag]] || DEFECTS.DISCARDED_METADATA;
      for (const sourceNumOneBased of sourceMeasureList) {
        const playIdx = firstPlayOfSource(sourceNumOneBased - 1);
        if (playIdx == null) continue; // volta-skipped, never played
        const pm = parsed.measures[playIdx];
        if (pm && pm[field] == null) {
          add(defect, sourceNumOneBased, null,
            `<${tag}> in source m${sourceNumOneBased} not preserved as ` +
            `measure.${field} (parser dropped source metadata)`);
        }
      }
      continue;
    }
    // Group B: parseWarnings gate. Fires when notation present in truth
    // AND parser did not emit a parseWarning naming the tag.
    const warnings = parsed.parseWarnings || [];
    const warned = warnings.some((w) => w.includes(`<${tag}>`));
    if (!warned) {
      const defect = TIER_DEFECT[TIER_OF[tag]];
      add(defect, null, null,
        `<${tag}> x${sourceMeasureList.length} — ` +
        `m${sourceMeasureList.slice(0, 8).join(", ")}` +
        `${sourceMeasureList.length > 8 ? ", +" + (sourceMeasureList.length - 8) + " more" : ""} ` +
        `(no parseWarning acknowledging this tag)`);
    }
  }

  // ---- Tempo (Alex M6 redesign, 2026-08-05) -----------------------------
  //
  // Compare the SET of distinct tempo values (sorted, stringified) between
  // truth and parser — not just counts. A parser that emits the correct
  // number of wrong tempos must still fail. Falls back to counting
  // parsed.defaultBpm as the single tempo when parser hasn't upgraded to
  // per-measure tempos (spec §M7), so the check stays lenient during
  // parser migration.
  if (truth.notations.distinctTempos.length > 1) {
    const truthTempoSet = [...truth.notations.distinctTempos]
      .map((t) => Number(t))
      .sort((a, b) => a - b)
      .join(",");
    // Parser exposes the flat tempo timeline at parsed.playback.tempos
    // (moved there 2026-08-06 to co-live with the other playback-record
    // fields; the pre-move top-level `parsed.tempos` no longer exists).
    // Fall back to defaultBpm-as-single-tempo when the parser hasn't
    // emitted a tempo list yet — keeps this check lenient for older
    // parser versions during migration.
    const parsedTempos = parsed.playback?.tempos;
    const parsedTempoList = parsedTempos && parsedTempos.length > 0
      ? parsedTempos.map((t) => Number(t.bpm ?? t))
      : [Number(parsed.defaultBpm)];
    const parsedTempoSet = [...new Set(parsedTempoList)]
      .sort((a, b) => a - b)
      .join(",");
    if (truthTempoSet !== parsedTempoSet) {
      add(DEFECTS.TEMPO_CHANGES_LOST, null, null,
        `truth distinct tempos [${truthTempoSet}]; ` +
        `parser distinct tempos [${parsedTempoSet}] — parser ` +
        `${parsedTempos ? "emitted the wrong set" : "keeps only defaultBpm"}`);
    }
  }

  // ---- Per measure ---------------------------------------------------------
  //
  // Routing (M4): route truth via playback.order when lengths agree;
  // fall back to source-index identity when they don't (parser hasn't
  // flattened, or parser and truth disagree — the length-mismatch
  // finding above surfaced that; the fallback keeps per-measure content
  // validation meaningful against the source measures parser emitted).
  const truthAt = flatteningMismatch
    ? (i) => truth.measures[i]
    : (i) => truth.measures[truth.playback.order[i]];
  const sourceIdxAt = flatteningMismatch
    ? (i) => i
    : (i) => truth.playback.order[i];
  const nCompare = flatteningMismatch
    ? Math.min(parsed.measures.length, truth.measures.length)
    : Math.min(parsed.measures.length, truth.playback.order.length);

  // Anacrusis: MuseScore marks it implicit="yes"; otherwise infer from a short m1.
  // A later short measure whose length + pickup = one bar is the borrowed partner
  // at a repeat seam (Fur Elise m1 + m9). Neither may be padded.
  let pickup = null;
  if (truth.measures.length) {
    const m0 = truth.measures[0];
    const s0 = sumEvents(parsed.measures[0]?.rh ?? []);
    if (truth.implicitFirst || (s0 !== null && s0 < m0.measureLen - 1e-6)) pickup = s0;
  }
  const pickupSourceIdx = truth.playback.order[0] ?? 0;

  // First-play dedup for INFORMATIONAL classes only (Alex, 2026-08-05):
  //   Anacrusis, grace_dropped, cross_staff are properties of the WRITTEN
  //   score — one finding per source measure. Being a pickup is a source
  //   attribute; replaying the pickup doesn't create a new pickup.
  //   Deduping by source keeps "anacrusis stays at 4" a stable invariant
  //   across every later milestone; per-play counting would make it a
  //   function of repeat structure instead.
  //
  //   CONTENT checks (firstDivergence, per-hand sums / tuplet_scaling /
  //   voice_collision / measure_overflow / incomplete_measure, tie
  //   integrity, unknown_duration, gap_fill_inexact, notes_unsorted) DO
  //   run on every playback — a flattener bug that corrupts the second
  //   pass but not the first has to be visible.
  const seenSourceForInfo = new Set();

  for (let i = 0; i < nCompare; i++) {
    const pm = parsed.measures[i];
    const tm = truthAt(i);
    const mNum = i + 1;
    const sourceIdx = sourceIdxAt(i);
    const firstPlay = !seenSourceForInfo.has(sourceIdx);
    if (firstPlay) seenSourceForInfo.add(sourceIdx);
    const mLen = measureBeats(pm.timeSignature);

    // grace_dropped is Group B (Alex M6 redesign): fire only when
    // truth has grace notes AND parser did not warn about them.
    // Correctly-handled grace notes (post-M6, if parser preserves)
    // would clear the warning gate by emitting a parseWarning; a
    // parser that fully renders grace notes (no drop) can either
    // still warn (informational) or emit a new tag we'd add to Group A.
    if (tm.flags.graceNotes > 0 && firstPlay) {
      const warnings = parsed.parseWarnings || [];
      const warnedGrace = warnings.some((w) => w.includes("<grace>") || w.includes("grace note"));
      if (!warnedGrace) {
        add(DEFECTS.GRACE_DROPPED, mNum, null,
          `${tm.flags.graceNotes} grace note(s) silently dropped ` +
          `(no parseWarning acknowledging grace notes)`);
      }
    }
    // Informational only — cross-staff engraving is expected input under
    // spec §3.6 (Moonlight's arpeggio convention, Beethoven's cross-staff
    // lines), NOT a defect. The correct parser handles it via song-level
    // per-voice hand assignment. Any actual routing mistake surfaces below
    // as CROSS_STAFF-labeled content_divergence (sum matches) or as
    // MEASURE_OVERFLOW / INCOMPLETE_MEASURE (sum fails). Kept at severity 5.
    if (firstPlay) {
      for (const key of tm.flags.crossStaffVoices) {
        add(DEFECTS.CROSS_STAFF, mNum, null,
          `${key} — cross-staff engraving present (§3.6: expected input, informational only)`);
      }
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
            // Classify by SOURCE property, not play-order (M4). The
            // pickup branch used to gate on `mNum === 1`; under
            // flattening the pickup replays at other mNums (Für Elise
            // parsed[9] = source 0 replay). Route the pickup check
            // through sourceIdx so the classification survives repeats,
            // then use firstPlay to dedup the anacrusis finding
            // (informational — one per source measure).
            //
            // INCOMPLETE_MEASURE is a content check and does NOT
            // dedup — a genuinely short measure inside a repeat fires
            // on every play, so a flattener bug that broke the sum
            // only on the second pass would still be visible.
            const isPickupSource = sourceIdx === pickupSourceIdx;
            let kind = "incomplete";
            if (pickup !== null && isPickupSource && Math.abs(short - (mLen - pickup)) < 1e-6) {
              kind = "pickup";
            } else if (pickup !== null && Math.abs(sum + pickup - mLen) < 1e-6) {
              kind = "borrowed";
            }
            if (kind === "pickup" && firstPlay) {
              add(DEFECTS.ANACRUSIS, mNum, hand, `pickup of ${round(sum)} of ${mLen} — keep short, do NOT pad`);
            } else if (kind === "borrowed" && firstPlay) {
              add(DEFECTS.ANACRUSIS, mNum, hand,
                `${round(sum)} of ${mLen}; + pickup ${round(pickup)} = one full bar — borrowed partner, do NOT pad`);
            } else if (kind === "incomplete") {
              add(DEFECTS.INCOMPLETE_MEASURE, mNum, hand,
                `sums to ${round(sum)} of ${mLen}` +
                (Math.abs(srcSum - sum) < 1e-6 ? " — source is short; pad with trailing rest" : ""));
            }
            // pickup/borrowed on non-first-play: informational dedup —
            // silently skip so the count is source-stable.
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
  //
  // Tracks per-midi start context (stack of {playIdx, sourceIdx,
  // isLastEvent}) so end-of-song orphans can be classified. The stack
  // handles the rare case of a midi opened, opened again, then closed
  // once — pop the most recent start. Dedup at classification time (one
  // finding per (midi, hand)) matches the pre-narrowing behaviour so
  // Entertainer's 5 raw orphans still surface as 3 findings.
  //
  // Narrowed volta-seam classifier (Alex, 2026-08-05): a tie start
  // orphaned at end-of-song classifies as VOLTA_SEAM_TIE (informational)
  // iff EVERY open instance of that midi was in a source measure that
  //   (1) has multiple play positions in playback.order, AND
  //   (2) whose next-played source differs across those plays, AND
  //   (3) the start itself was the FINAL event of its measure's hand.
  // Otherwise it stays ORPHAN_TIE (severity 3 — still capable of
  // blocking). A single genuine mid-measure orphan on ANY midi keeps
  // that midi at ORPHAN_TIE even if other instances of the same midi
  // are seams.
  const sourceNextsByPlay = new Map(); // sourceIdx -> [nextSourceIdx per play]
  for (let i = 0; i < parsed.measures.length; i++) {
    const src = parsed.measures[i].sourceMeasure;
    const next = i + 1 < parsed.measures.length ? parsed.measures[i + 1].sourceMeasure : null;
    if (!sourceNextsByPlay.has(src)) sourceNextsByPlay.set(src, []);
    sourceNextsByPlay.get(src).push(next);
  }
  const hasVoltaSeam = (src) => {
    const nexts = sourceNextsByPlay.get(src) || [];
    if (nexts.length < 2) return false;
    return new Set(nexts).size > 1;
  };
  for (const hand of ["rh", "lh"]) {
    const open = new Map(); // midi -> [{playIdx, sourceIdx, isLastEvent, nextSource}]
    for (let pi = 0; pi < parsed.measures.length; pi++) {
      const m = parsed.measures[pi];
      const events = m[hand] || [];
      for (let ei = 0; ei < events.length; ei++) {
        const e = events[ei];
        const starts = new Set();
        const ends = new Set();
        for (const n of e.notes) {
          if (n.tie === "start" || n.tie === "both") starts.add(n.midi);
          if (n.tie === "end" || n.tie === "both") ends.add(n.midi);
        }
        for (const midi of ends) {
          const stack = open.get(midi);
          if (!stack || stack.length === 0) {
            add(DEFECTS.ORPHAN_TIE, m.number, hand, `tie end with no start (midi ${midi})`);
          } else {
            stack.pop();
          }
        }
        for (const s of starts) {
          if (!open.has(s)) open.set(s, []);
          open.get(s).push({
            playIdx: pi,
            sourceIdx: m.sourceMeasure,
            isLastEvent: ei === events.length - 1,
            nextSource: pi + 1 < parsed.measures.length ? parsed.measures[pi + 1].sourceMeasure : null,
          });
        }
      }
    }
    for (const [midi, stack] of open) {
      if (stack.length === 0) continue;
      const allSeams = stack.every(
        (ctx) => ctx.isLastEvent && hasVoltaSeam(ctx.sourceIdx)
      );
      if (allSeams) {
        // Every open instance of this midi is a volta seam — report
        // as informational with the specific seams named.
        const seamNotes = stack.map(
          (ctx) => `printed m${ctx.sourceIdx}→m${ctx.nextSource ?? "(end)"}`
        );
        add(DEFECTS.VOLTA_SEAM_TIE, null, hand,
          `tie start (midi ${midi}) not closed at volta seam${seamNotes.length > 1 ? "s" : ""}: ` +
          `${seamNotes.join(", ")} — second ending does not close the tie held into the ` +
          `first ending; source-authoring choice, not a parser defect`);
      } else {
        add(DEFECTS.ORPHAN_TIE, null, hand, `tie start never closed (midi ${midi})`);
      }
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
