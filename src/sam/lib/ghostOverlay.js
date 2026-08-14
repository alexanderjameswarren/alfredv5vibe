// Ghost overlay — draws the PARENT song's notes faintly under the simplified
// score, so what the simplifier removed is visible.
//
// M1 scope: left hand only, positioning proof. No annotations, no toggle.
//
// Two invariants inherited from drawFingeringOverlay, and for the same reasons:
//   1. It NEVER touches VexFlow elements. Everything goes into its own
//      <g class="sam-ghost-overlay">, so playback recolouring cannot interfere
//      with it and it cannot interfere with the real notes.
//   2. Coordinates are RENDER-space. The SVG has a viewBox, so the browser
//      scales this layer with the score for free.
//
// POSITIONING. A ghost has no VexFlow note of its own, so its x cannot come
// from buildGeometry — that only reports events the child actually has. It is
// instead derived from the same formula applyTimeProportionalLayout uses to
// place every real note:
//
//     x_anchor = xOffset + (beat / durationQ) * measWidth
//
// which is pure: it depends only on the measure's layout and the beat offset,
// and on nothing VexFlow computes. Beat offsets come from walking the hand's
// event array accumulating tuplet-scaled durations, exactly as the analyzer
// does.
//
// The one subtlety is that x_anchor is a note's LEFT edge, while buildGeometry
// reports notehead CENTRES (it averages getNoteHeadBeginX/EndX). Rather than
// calibrate a half-notehead constant, a ghost is drawn as an ellipse centred at
// `x_anchor + rx` with the same rx as a real notehead's half-width — so the
// ghost occupies the same span as a real note at that beat, by construction.

import { getEventBeats } from "./measureUtils";

const SVG_NS = "http://www.w3.org/2000/svg";
const OVERLAY_CLASS = "sam-ghost-overlay";

// A VexFlow 4 notehead is roughly 10.2 × 7.2 render-space px. Matching those
// dimensions is what makes `x_anchor + rx` land on the real centre line.
export const GHOST = {
  rx: 5.1,
  ry: 3.6,
  fill: "#000000",
  opacity: 0.28,
};

/**
 * Walk one hand, returning every sounding note with its beat offset.
 *
 * @returns {Array<{beat:number, midi:number, name:string}>}
 */
export function handNotesWithBeats(events) {
  const out = [];
  let beat = 0;
  for (const evt of events || []) {
    const notes = evt?.notes || [];
    for (const n of notes) out.push({ beat, midi: n.midi, name: n.name });
    beat += getEventBeats(evt) || 0;
  }
  return out;
}

/**
 * Staff line for a pitch on a given stave, via VexFlow's own key-property
 * mapping rather than a re-implementation of clef arithmetic.
 *
 * Cached per (clef, key) because the mapping is a pure function of those two
 * and a song can repeat one pitch hundreds of times.
 */
function makeLineResolver(VF) {
  const cache = new Map();
  return (clef, vexKey) => {
    const cacheKey = `${clef}:${vexKey}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let line = null;
    try {
      const probe = new VF.StaveNote({ clef, keys: [vexKey], duration: "q" });
      line = probe.getKeyProps()[0].line;
    } catch {
      // Unparseable key — skip this ghost rather than throwing mid-draw.
    }
    cache.set(cacheKey, line);
    return line;
  };
}

// Reuses the same name → VexFlow key conversion the renderers use, so a ghost
// and its real counterpart resolve identically.
function toVexKey(note) {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d+)$/.exec(note.name || "");
  if (m) return `${m[1].toLowerCase()}${m[2] || ""}/${m[3]}`;
  return null;
}

/**
 * Draw the ghost layer. Idempotent — removes any prior layer first.
 *
 * @param {SVGElement} svgRoot
 * @param {Array} layout  - per-measure { measureNum, xOffset, measWidth, durationQ, bass }
 * @param {Array} parentMeasures - the PARENT song's measures, sliced identically
 * @param {object} VF - window.Vex.Flow
 * @param {object} opts - { opacity }
 * @returns {{drawn:number}|null}
 */
export function drawGhostOverlay(svgRoot, layout, parentMeasures, VF, opts = {}) {
  if (!svgRoot) return null;
  svgRoot.querySelectorAll(`g.${OVERLAY_CLASS}`).forEach((g) => g.remove());

  if (!layout?.length || !parentMeasures?.length || !VF) return null;

  const opacity = opts.opacity ?? GHOST.opacity;
  const lineOf = makeLineResolver(VF);
  const byMeasure = new Map(layout.map((l) => [l.measureNum, l]));

  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", OVERLAY_CLASS);
  layer.setAttribute("pointer-events", "none");

  let drawn = 0;
  for (const measure of parentMeasures) {
    const geo = byMeasure.get(measure.number);
    // A measure the child does not have cannot be positioned. Silently skipping
    // is safe here only because the caller has already asserted the two sliced
    // arrays line up — see SamPlayer.
    if (!geo || !geo.bass) continue;

    for (const note of handNotesWithBeats(measure.lh)) {
      const vexKey = toVexKey(note);
      if (!vexKey) continue;
      const line = lineOf("bass", vexKey);
      if (line == null) continue;

      const xAnchor = geo.xOffset + (note.beat / geo.durationQ) * geo.measWidth;
      const cx = xAnchor + GHOST.rx;
      const cy = geo.bass.getYForNote(line);

      const el = document.createElementNS(SVG_NS, "ellipse");
      el.setAttribute("class", "sam-ghost-note");
      el.setAttribute("cx", cx);
      el.setAttribute("cy", cy);
      el.setAttribute("rx", GHOST.rx);
      el.setAttribute("ry", GHOST.ry);
      el.setAttribute("fill", GHOST.fill);
      el.setAttribute("fill-opacity", opacity);
      layer.appendChild(el);
      drawn++;
    }
  }

  if (drawn === 0) return null;
  svgRoot.appendChild(layer);
  return { drawn };
}
