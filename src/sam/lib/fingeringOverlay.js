// Fingering overlay: draw RH fingering badges + notehead rings onto the score.
//
// Pure SVG DOM. Consumes the geometry map from buildGeometry (scoreRender.js) and
// a resolved fingering lookup (resolveFingerings in fingeringsApi.js), and draws
// into a dedicated <g class="sam-fingering-overlay"> appended to the SVG root.
//
// Two invariants from the spec:
//   1. It NEVER touches VexFlow note elements — no setStyle, no notehead-fill
//      mutation. Playback highlighting (colorBeatEls) owns notehead fill; because
//      the ring is a separate element on its own layer, recoloring a note during
//      playback cannot make the ring flicker or vanish (success criterion 5).
//   2. Coordinates and sizes are RENDER-space. Both renderers give their SVG a
//      viewBox (see SVGContext.scale), so the browser scales this layer by the
//      score scale factor for free — the px values below are the spec's "at score
//      scale 1.0" sizes and grow with the scale.
//
// The same function serves the edit view (ScoreRenderer.jsx, one render) and the
// playback view (ScrollEngine.jsx, geometry concatenated across scroll copies).

const SVG_NS = "http://www.w3.org/2000/svg";
const OVERLAY_CLASS = "sam-fingering-overlay";

// Badge (circled numeral above the stave) and ring (around the notehead), in
// render-space px at score scale 1.0 (spec "Visual language").
export const BADGE = {
  radius: 9,
  fontSize: 12,
  aboveStaveTop: 18, // badge center sits this far above staveTop
  collisionNudge: 16, // extra upward shift when over a measure number / chord
  stackGap: 2, // gap between stacked badges when one event has multiple fingerings
};
export const RING = {
  radius: 7,
  stroke: 1.5,
  opacity: 0.45,
};

// Draw the overlay. Idempotent: removes any prior overlay group first, so callers
// can re-invoke on every fingering change without leaking elements.
//
//   svgRoot        — the <svg> element (both renderers' viewBox coordinate space)
//   entries        — geometry entries from buildGeometry (may span scroll copies)
//   resolvedByKey  — { "measureNum:rhIndex:noteIndex": finger } (precedence applied)
//   opts.collisionEls — SVG text elements (measure numbers, chord symbols) whose
//                       x-extent triggers the up-nudge for near-beat-1 badges
//   opts.accent / opts.accentFg — CSS color strings (default to the theme tokens)
export function drawFingeringOverlay(svgRoot, entries, resolvedByKey, opts = {}) {
  const {
    accent = "var(--fingering-accent)",
    accentFg = "var(--fingering-accent-fg)",
    collisionEls = [],
  } = opts;

  if (!svgRoot) return null;
  // Re-render safety: drop a prior overlay before drawing the current one.
  svgRoot.querySelectorAll(`g.${OVERLAY_CLASS}`).forEach((g) => g.remove());

  if (!entries || !resolvedByKey) return null;

  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", OVERLAY_CLASS);
  // Overlay is decorative; taps are handled by the zone layer (Step 4), not here.
  layer.setAttribute("pointer-events", "none");

  // Collision zones: the render-space x-extent of each measure number / chord
  // label. Measured from the live DOM so it stays exact regardless of font
  // metrics or which measure/copy the label belongs to.
  const zones = [];
  for (const el of collisionEls) {
    if (!el) continue;
    try {
      const b = el.getBBox();
      if (b && b.width > 0) zones.push([b.x, b.x + b.width]);
    } catch {
      // Element not measurable (detached / not rendered) — skip it.
    }
  }
  const overlapsLabel = (x) => {
    const left = x - BADGE.radius;
    const right = x + BADGE.radius;
    return zones.some(([x0, x1]) => right >= x0 && left <= x1);
  };

  let drew = 0;
  for (const entry of entries) {
    // Fingerings live on RH notation events only; rests never carry one.
    if (entry.isRest || entry.hand !== "rh") continue;

    // Stack index so two fingerings on one chord event don't overprint.
    let stack = 0;
    for (let noteIndex = 0; noteIndex < entry.noteheadYs.length; noteIndex++) {
      const finger = resolvedByKey[`${entry.measureNum}:${entry.index}:${noteIndex}`];
      if (finger == null) continue;

      // Ring around the fingered notehead.
      drawRing(layer, entry.x, entry.noteheadYs[noteIndex], accent);

      // Badge above the stave, nudged up if it would sit over the measure
      // number / chord symbol at the measure's left edge (near beat 1 only).
      const nudge = overlapsLabel(entry.x) ? BADGE.collisionNudge : 0;
      const badgeY =
        entry.staveTop - BADGE.aboveStaveTop - nudge -
        stack * (BADGE.radius * 2 + BADGE.stackGap);
      drawBadge(layer, entry.x, badgeY, finger, accent, accentFg);

      stack++;
      drew++;
    }
  }

  if (drew === 0) return null; // keep the DOM clean when nothing resolved
  svgRoot.appendChild(layer);
  return layer;
}

function drawRing(layer, cx, cy, accent) {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("class", "sam-fingering-ring");
  c.setAttribute("cx", cx);
  c.setAttribute("cy", cy);
  c.setAttribute("r", RING.radius);
  c.setAttribute("fill", "none");
  c.setAttribute("stroke", accent);
  c.setAttribute("stroke-width", RING.stroke);
  c.setAttribute("stroke-opacity", RING.opacity);
  layer.appendChild(c);
}

function drawBadge(layer, cx, cy, finger, accent, accentFg) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "sam-fingering-badge");

  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", cx);
  circle.setAttribute("cy", cy);
  circle.setAttribute("r", BADGE.radius);
  circle.setAttribute("fill", accent);
  g.appendChild(circle);

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", cx);
  text.setAttribute("y", cy);
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.setAttribute("font-size", BADGE.fontSize);
  text.setAttribute("font-weight", "bold");
  text.setAttribute("font-family", "sans-serif");
  text.setAttribute("fill", accentFg);
  text.textContent = String(finger);
  g.appendChild(text);

  layer.appendChild(g);
}
