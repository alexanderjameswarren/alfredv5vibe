import { useCallback, useEffect, useState } from "react";

/**
 * Publish the height of Alfred's bottom dock as a CSS variable.
 *
 * Clipboard Step 17b, fixed in 17c.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * Six pinned action footers used to be positioned `sticky bottom-28 sm:bottom-32`
 * — 112px, or 128px above `sm` — and the content wrapper reserved a matching
 * `pb-28 sm:pb-32`. Both numbers were a guess at the dock's height. The dock is
 * about 61px on a phone and 81px above `sm`, so every footer floated roughly 50px
 * too high and the page scrolled visibly through the daylight underneath.
 *
 * There is no correct constant, which is why this measures instead. The dock is ONE
 * fixed container holding the Undo message stacked on the Capture bar, and its
 * height changes: the capture textarea grows with what you type up to 50vh, the
 * Undo message appears and disappears, the padding changes at the `sm` breakpoint,
 * and a long undo message wraps. A per-screen offset is the same guess repeated six
 * times, which is how five of the six came to share a number wrong for all of them.
 *
 * ── 🛑 WHY THIS RETURNS A CALLBACK REF AND NOT A useRef ──────────────────────
 *
 * The first version took a `ref` and measured it in `useEffect(..., [ref])`. That
 * silently never worked, and the way it failed is worth stating because it looks
 * correct:
 *
 *   Alfred has five early returns before the dock is rendered — `authLoading`,
 *   `!user`, `!dataLoaded`, the SAM view and the Timer view. EVERY cold load goes
 *   through at least one of them. So on the render where the effect first ran,
 *   `ref.current` was null and the effect returned early. A ref object is stable
 *   for the life of the component, so the dependency array never changed and THE
 *   EFFECT NEVER RAN AGAIN. `--dock-h` was never published and every screen used
 *   the CSS fallback forever.
 *
 * A fallback that is merely close is worse than no feature here: it was smaller
 * than the real dock, so footers sat tucked behind the capture bar, the content
 * padding under-reserved, and the last section of a long page could not be scrolled
 * clear of the bar at all.
 *
 * A callback ref has no such gap. React calls it with the node the moment the dock
 * mounts — however many renders later that is — and with null when it goes. The
 * node is held in STATE so the observer effect re-runs on both.
 *
 * ── How it degrades ──────────────────────────────────────────────────────────
 *
 * `--dock-h` has a fallback in index.css for the frame before the first
 * measurement. `ResizeObserver` is feature-detected: without it the height is still
 * measured on mount and on window resize, which covers everything except the
 * textarea growing as you type.
 *
 * @returns {Function} A ref callback. Put it on the dock: `<div ref={setDockNode}>`.
 */
export function useDockHeight() {
  // State, not a ref: attaching and detaching the dock has to re-run the effect
  // below, and only a state change can do that. A state setter is stable, so using
  // it as the ref callback does not re-attach on every render.
  const [node, setNode] = useState(null);

  // Wrapped so callers get a stable function with a name that reads like what it
  // is at the call site.
  const setDockNode = useCallback((next) => setNode(next), []);

  useEffect(() => {
    if (!node || typeof document === "undefined") return;

    const root = document.documentElement;

    const publish = () => {
      // getBoundingClientRect, not offsetHeight: the dock's children include a
      // textarea whose height is set in fractional pixels by the grow handler, and
      // offsetHeight rounds. Half a pixel of rounding is a half-pixel seam of page
      // content showing through under a footer.
      const height = node.getBoundingClientRect().height;
      // 0 means not laid out yet — mid-mount, or hidden. Publishing it would drop
      // every footer to the bottom of the viewport, behind the capture bar.
      // Leaving the previous value (or the CSS fallback) is the better wrong answer.
      if (height > 0) root.style.setProperty("--dock-h", `${height}px`);
    };

    publish();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(publish);
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", publish);
    return () => window.removeEventListener("resize", publish);
  }, [node]);

  // Deliberately NOT cleared when the dock unmounts. The screens without a dock —
  // SAM, the Timer, the auth and loading screens — have no pinned footers and no
  // content padding that reads it, so a stale value affects nothing; clearing it
  // would only put the fallback back in play for a frame on the way back.

  return setDockNode;
}
