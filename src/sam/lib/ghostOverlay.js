// Ghost overlay — draws what the simplifier removed, faintly, under the score.
//
// Two invariants inherited from drawFingeringOverlay, and for the same reasons:
//   1. It NEVER touches VexFlow elements. Everything goes into its own
//      <g class="sam-ghost-overlay">, so playback recolouring cannot interfere
//      with it and it cannot interfere with the real notes.
//   2. Coordinates are RENDER-space. The SVG has a viewBox, so the browser
//      scales this layer with the score for free.
//
// THE TWO HANDS ARE DIFFERENT PROBLEMS, and the spec (§4.2) is explicit about
// why, so they are drawn from different sources:
//
//   RH — a true per-note diff. Event count is invariant and the top note is
//   guaranteed retained, so index alignment is exact and a parent note absent
//   from the child at the same index is a REMOVED note. Only those are drawn;
//   ghosting a note the child still has would say nothing. x comes from the
//   real event's own geometry, since it is the same event.
//
//   LH — no index correspondence at all. Quantization replaces the array
//   wholesale, so a pitch in both is a different event at a different onset
//   with a different duration. Per §4.2 the comparison is positional only:
//   every parent LH note is drawn at its beat offset, and nothing is claimed
//   about provenance.
//
// POSITIONING. An LH ghost has no VexFlow note of its own, so its x cannot come
// from buildGeometry — that only reports events the child actually has. It is
// derived from the formula applyTimeProportionalLayout places every real note
// with:
//
//     x_anchor = xOffset + (beat / durationQ) * measWidth
//
// which is pure. `x_anchor` is a note's LEFT edge while buildGeometry reports
// notehead CENTRES, so a ghost is drawn centred at `x_anchor + rx` with a real
// notehead's half-width — same span as a real note at that beat, by
// construction, with no constant to keep in sync.

import { getEventBeats } from "./measureUtils";

const SVG_NS = "http://www.w3.org/2000/svg";
const OVERLAY_CLASS = "sam-ghost-overlay";
const EPS = 1e-6;

// A VexFlow 4 notehead is roughly 10.2 × 7.2 render-space px. Matching those
// dimensions is what makes `x_anchor + rx` land on the real centre line.
export const GHOST = {
  rx: 5.1,
  ry: 3.6,
  fill: "#000000",
  opacity: 0.28,
  // A coincident ghost — same beat AND same pitch as a real note — is invisible
  // when drawn as a filled dot, because it lands exactly behind the real
  // notehead. It is drawn as a halo instead. See drawCoincident.
  haloRx: 8.2,
  haloRy: 6.4,
  haloStroke: 1.3,
};

/**
 * Walk one hand, returning every sounding note with its beat offset.
 * Tuplet events scale by normal/actual, via the shared duration helper.
 */
export function handNotesWithBeats(events) {
  const out = [];
  let beat = 0;
  for (const evt of events || []) {
    for (const n of evt?.notes || []) out.push({ beat, midi: n.midi, name: n.name });
    beat += getEventBeats(evt) || 0;
  }
  return out;
}

/**
 * Did this measure's LH change at all?
 *
 * When it did not, there is nothing to ghost: every parent note is still there,
 * and drawing them would ring every notehead in the bar to say "unchanged".
 * That is not hypothetical — two of the four calibration songs never transform
 * the LH, so without this every one of their 680 and 1127 LH notes would get a
 * halo and the layer would be pure noise.
 *
 * Compared on (beat, pitch) rather than on the raw events: that is exactly what
 * a ghost expresses, so two hands agreeing on it have nothing to show.
 */
export function lhUnchanged(parentMeasure, childMeasure) {
  const p = handNotesWithBeats(parentMeasure?.lh);
  const c = handNotesWithBeats(childMeasure?.lh);
  if (p.length !== c.length) return false;
  return p.every((n, i) => n.midi === c[i].midi && Math.abs(n.beat - c[i].beat) < EPS);
}

/**
 * Parent RH notes the child no longer has, by event index (spec §4.2).
 * @returns {Array<{index:number, midi:number, name:string}>}
 */
export function removedRhNotes(parentMeasure, childMeasure) {
  const out = [];
  const parentRh = parentMeasure?.rh || [];
  const childRh = childMeasure?.rh || [];
  for (let i = 0; i < parentRh.length; i++) {
    const child = childRh[i];
    // Index alignment is guaranteed by invariant 6 for simplifier output. If a
    // pair ever disagrees, skip rather than align by guesswork.
    if (!child) continue;
    const kept = new Set((child.notes || []).map((n) => n.midi));
    for (const n of parentRh[i].notes || []) {
      if (!kept.has(n.midi)) out.push({ index: i, midi: n.midi, name: n.name });
    }
  }
  return out;
}

/**
 * Staff line for a pitch, via VexFlow's own key-property mapping rather than a
 * re-implementation of clef arithmetic. Cached per (clef, key).
 */
function makeLineResolver(VF) {
  const cache = new Map();
  return (clef, vexKey) => {
    const k = `${clef}:${vexKey}`;
    if (cache.has(k)) return cache.get(k);
    let line = null;
    try {
      line = new VF.StaveNote({ clef, keys: [vexKey], duration: "q" }).getKeyProps()[0].line;
    } catch {
      // Unparseable key — skip this ghost rather than throwing mid-draw.
    }
    cache.set(k, line);
    return line;
  };
}

function toVexKey(note) {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d+)$/.exec(note.name || "");
  return m ? `${m[1].toLowerCase()}${m[2] || ""}/${m[3]}` : null;
}

function drawDot(layer, cx, cy, opacity) {
  const el = document.createElementNS(SVG_NS, "ellipse");
  el.setAttribute("class", "sam-ghost-note");
  el.setAttribute("cx", cx);
  el.setAttribute("cy", cy);
  el.setAttribute("rx", GHOST.rx);
  el.setAttribute("ry", GHOST.ry);
  el.setAttribute("fill", GHOST.fill);
  el.setAttribute("fill-opacity", opacity);
  layer.appendChild(el);
}

/**
 * A ghost that lands exactly on a real note, drawn as a halo around it.
 *
 * The alternative was nudging it aside, but both nudges assert something false:
 * a horizontal one implies an onset the note does not have, a vertical one
 * implies a pitch it does not have. A halo sits at the true position and keeps
 * the contour geometrically exact — the eye reads dot, dot, halo, dot without a
 * gap and without a displacement.
 */
function drawHalo(layer, cx, cy, opacity) {
  const el = document.createElementNS(SVG_NS, "ellipse");
  el.setAttribute("class", "sam-ghost-note sam-ghost-coincident");
  el.setAttribute("cx", cx);
  el.setAttribute("cy", cy);
  el.setAttribute("rx", GHOST.haloRx);
  el.setAttribute("ry", GHOST.haloRy);
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", GHOST.fill);
  el.setAttribute("stroke-width", GHOST.haloStroke);
  el.setAttribute("stroke-opacity", opacity);
  layer.appendChild(el);
}

/**
 * Draw the ghost layer. Idempotent — removes any prior layer first, so callers
 * can re-invoke on every opacity tick without leaking elements.
 *
 * @param {SVGElement} svgRoot
 * @param {object} opts
 * @param {Array}  opts.layout - per measure { measureNum, xOffset, measWidth, durationQ, treble, bass }
 * @param {Array}  opts.geometry - buildGeometry entries for the child
 * @param {Array}  opts.parentMeasures - parent measures, sliced identically
 * @param {Array}  opts.childMeasures - the measures actually rendered
 * @param {object} opts.VF - window.Vex.Flow
 * @param {string} opts.hands - "both" | "rh" | "lh"
 * @param {number} opts.opacity
 * @returns {{lh:number, rh:number, coincident:number}|null}
 */
export function drawGhostOverlay(svgRoot, opts = {}) {
  if (!svgRoot) return null;
  svgRoot.querySelectorAll(`g.${OVERLAY_CLASS}`).forEach((g) => g.remove());

  const {
    layout, geometry, parentMeasures, childMeasures, VF,
    hands = "both", opacity = GHOST.opacity,
  } = opts;
  if (!layout?.length || !parentMeasures?.length || !VF) return null;

  const showLh = hands === "both" || hands === "lh";
  const showRh = hands === "both" || hands === "rh";
  if (!showLh && !showRh) return null;

  const lineOf = makeLineResolver(VF);
  const layoutOf = new Map(layout.map((l) => [l.measureNum, l]));
  const childOf = new Map((childMeasures || []).map((m) => [m.number, m]));
  // RH ghosts sit at their real event's x, so they need that event's geometry.
  const geoOf = new Map(
    (geometry || []).map((g) => [`${g.measureNum}:${g.hand}:${g.index}`, g])
  );

  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", OVERLAY_CLASS);
  layer.setAttribute("pointer-events", "none");

  const tally = { lh: 0, rh: 0, coincident: 0 };

  for (const measure of parentMeasures) {
    const geo = layoutOf.get(measure.number);
    // A measure the child does not have cannot be positioned. Safe to skip only
    // because the caller has already asserted the two slices line up.
    if (!geo) continue;
    const child = childOf.get(measure.number);

    // An unchanged LH has nothing to ghost. The RH needs no equivalent guard:
    // it only ever draws REMOVED notes, so an unchanged RH contributes none.
    if (showLh && geo.bass && !lhUnchanged(measure, child)) {
      // Which (beat, pitch) pairs the child's LH also has — those ghosts land
      // exactly on a real notehead and are drawn as halos.
      const childLh = handNotesWithBeats(child?.lh);
      const coincides = (beat, midi) =>
        childLh.some((c) => c.midi === midi && Math.abs(c.beat - beat) < EPS);

      for (const note of handNotesWithBeats(measure.lh)) {
        const key = toVexKey(note);
        if (!key) continue;
        const line = lineOf("bass", key);
        if (line == null) continue;

        const cx = geo.xOffset + (note.beat / geo.durationQ) * geo.measWidth + GHOST.rx;
        const cy = geo.bass.getYForNote(line);

        if (coincides(note.beat, note.midi)) {
          drawHalo(layer, cx, cy, opacity);
          tally.coincident++;
        } else {
          drawDot(layer, cx, cy, opacity);
        }
        tally.lh++;
      }
    }

    if (showRh && geo.treble) {
      for (const note of removedRhNotes(measure, child)) {
        const key = toVexKey(note);
        if (!key) continue;
        const line = lineOf("treble", key);
        if (line == null) continue;

        // Same event, so the real note's own x is the truthful position.
        const entry = geoOf.get(`${measure.number}:rh:${note.index}`);
        if (!entry) continue;

        drawDot(layer, entry.x, geo.treble.getYForNote(line), opacity);
        tally.rh++;
      }
    }
  }

  if (tally.lh + tally.rh === 0) return null;
  svgRoot.appendChild(layer);
  return tally;
}
