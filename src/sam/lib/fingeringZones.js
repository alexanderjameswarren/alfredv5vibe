// Fingering tap zones + selection feedback (edit view only).
//
// Entry on the Surface can't rely on precise notehead taps — at 4 measures per
// system the eighth-note spacing falls below a 44px touch target. So taps resolve
// via a Voronoi partition on x over the RH events: the whole RH band is tiled
// into zones whose boundaries are the midpoints between adjacent note x values,
// with the first/last zone running out to the system edges. Every tap in the band
// therefore lands on the nearest note — there are no horizontal dead zones and no
// precision requirement (spec "Tap zones").
//
// Zones live in the SVG (render-space, viewBox-scaled), so the browser does the
// hit-testing and coordinate mapping — including the edit view's horizontal
// scroll — for free. Rests get zones too, but tapping one is a no-op with a brief
// "no note here" shake.

const SVG_NS = "http://www.w3.org/2000/svg";
const ZONE_LAYER_CLASS = "sam-fingering-zones";
const SELECT_LAYER_CLASS = "sam-fingering-selection";

// Vertical band around the RH (treble) stave, render-space px (spec).
const BAND_ABOVE = 24; // above staveTop
const BAND_BELOW = 12; // below staveBottom

// Selection ring — dashed, bolder, and larger than the (solid, faint) fingering
// ring so a selected-and-fingered note reads as two distinct marks.
const SELECT_RING = { radius: 11, stroke: 2, dash: "3 2" };

function rhSorted(entries) {
  return (entries || [])
    .filter((e) => e.hand === "rh")
    .slice()
    .sort((a, b) => a.x - b.x);
}

// Voronoi-on-x partition. Returns { band, zones:[{x0,x1,entry}] } or null if
// there are no RH events. `rightEdge` is the system's right bound (render-space).
export function buildZones(entries, rightEdge) {
  const rh = rhSorted(entries);
  if (rh.length === 0) return null;

  const band = {
    top: rh[0].staveTop - BAND_ABOVE,
    height: rh[0].staveBottom + BAND_BELOW - (rh[0].staveTop - BAND_ABOVE),
  };

  const zones = rh.map((entry, i) => {
    // Midpoints to neighbors; first/last run to the system edges so a tap past
    // the outermost note still resolves to it.
    const x0 = i === 0 ? 0 : (rh[i - 1].x + entry.x) / 2;
    const x1 = i === rh.length - 1 ? Math.max(rightEdge, entry.x) : (entry.x + rh[i + 1].x) / 2;
    return { x0, x1, entry };
  });

  return { band, zones };
}

// Build (or tear down) the active tap-zone layer. When `active` is false, or
// there are no RH events, any existing layer is removed and normal score
// gestures resume. Idempotent.
//
//   onSelect(coord) — called with { measureNum, rhIndex, noteIndex:0 } on a note tap
export function syncZoneLayer(svgRoot, entries, { active, onSelect } = {}) {
  if (!svgRoot) return null;
  svgRoot.querySelectorAll(`g.${ZONE_LAYER_CLASS}`).forEach((g) => g.remove());
  if (!active) return null;

  const rightEdge = svgRoot.viewBox?.baseVal?.width || 0;
  const built = buildZones(entries, rightEdge);
  if (!built) return null;

  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", ZONE_LAYER_CLASS);

  for (const { x0, x1, entry } of built.zones) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", x0);
    rect.setAttribute("y", built.band.top);
    rect.setAttribute("width", Math.max(0, x1 - x0));
    rect.setAttribute("height", built.band.height);
    // Faint violet wash so the active band is visible ("tap here"); adjacent
    // zones share the fill so it reads as one band, not a grid.
    rect.setAttribute("fill", "var(--fingering-accent)");
    rect.setAttribute("fill-opacity", "0.05");
    rect.style.cursor = "pointer";

    // Swallow pointer/click so the tap doesn't reach the score container's
    // gesture handlers (suppressing other gestures while the mode is on).
    rect.addEventListener("pointerdown", (e) => e.stopPropagation());
    rect.addEventListener("pointerup", (e) => e.stopPropagation());
    rect.addEventListener("click", (e) => {
      e.stopPropagation();
      if (entry.isRest) {
        shakeNoNote(layer, entry.x, built.band.top);
        return;
      }
      // Default to the top notehead (melody note) — 0 for single-note events.
      const noteIndex = Math.max(0, entry.noteheadYs.length - 1);
      onSelect?.({ measureNum: entry.measureNum, rhIndex: entry.index, noteIndex });
    });

    layer.appendChild(rect);
  }

  svgRoot.appendChild(layer);
  return layer;
}

// Draw (or clear) the selection ring on the currently selected note. `selection`
// is { measureNum, rhIndex, noteIndex } or null. Idempotent.
export function drawSelectionRing(svgRoot, entries, selection) {
  if (!svgRoot) return null;
  svgRoot.querySelectorAll(`g.${SELECT_LAYER_CLASS}`).forEach((g) => g.remove());
  if (!selection) return null;

  const entry = (entries || []).find(
    (e) => e.hand === "rh" && e.measureNum === selection.measureNum && e.index === selection.rhIndex
  );
  if (!entry || entry.isRest) return null;

  const noteIndex = selection.noteIndex ?? 0;
  const cy = entry.noteheadYs[noteIndex] ?? entry.noteheadYs[entry.noteheadYs.length - 1];
  if (cy == null) return null;

  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", SELECT_LAYER_CLASS);
  layer.setAttribute("pointer-events", "none");

  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", entry.x);
  ring.setAttribute("cy", cy);
  ring.setAttribute("r", SELECT_RING.radius);
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "var(--fingering-accent)");
  ring.setAttribute("stroke-width", SELECT_RING.stroke);
  ring.setAttribute("stroke-dasharray", SELECT_RING.dash);
  layer.appendChild(ring);

  svgRoot.appendChild(layer);
  return layer;
}

// Brief "no note here" feedback when a rest zone is tapped: a transient label
// that shakes horizontally and fades, then removes itself.
function shakeNoNote(layer, x, bandTop) {
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", x);
  text.setAttribute("y", bandTop - 2);
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-size", "9");
  text.setAttribute("font-family", "sans-serif");
  text.setAttribute("fill", "var(--muted-foreground)");
  text.setAttribute("pointer-events", "none");
  text.textContent = "no note here";
  layer.appendChild(text);

  const remove = () => text.remove();
  try {
    const anim = text.animate(
      [
        { transform: "translateX(0)", opacity: 1 },
        { transform: "translateX(-3px)" },
        { transform: "translateX(3px)" },
        { transform: "translateX(-2px)" },
        { transform: "translateX(0)", opacity: 0 },
      ],
      { duration: 450, easing: "ease-out" }
    );
    anim.onfinish = remove;
    anim.oncancel = remove;
  } catch {
    // WAAPI/transform unsupported — still clear the label shortly after.
    setTimeout(remove, 450);
  }
}
