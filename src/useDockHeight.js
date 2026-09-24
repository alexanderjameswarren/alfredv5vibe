import { useEffect } from "react";

/**
 * Publish the height of Alfred's bottom dock as a CSS variable — Clipboard
 * Step 17b.
 *
 * ── The bug this replaces ────────────────────────────────────────────────────
 *
 * Six pinned action footers were positioned with `sticky bottom-28 sm:bottom-32`
 * — 112px, or 128px above `sm`. Those numbers were chosen to mirror the content
 * wrapper's `pb-28 sm:pb-32`, and both were a guess at how tall the dock is.
 *
 * The dock is about 61px on a phone and 77px above `sm`. So every pinned footer
 * floated roughly 50px too high, and the page scrolled visibly through the strip
 * of daylight underneath it — which is exactly what it looked like: an action bar
 * hovering, with content sliding behind and under it.
 *
 * ── Why a measurement rather than better numbers ─────────────────────────────
 *
 * Because there is no correct number. The dock is ONE fixed container holding the
 * Undo message stacked on the Capture bar, and its height changes:
 *
 *   * the capture textarea grows with what you type, up to 50vh
 *   * the Undo message appears and disappears
 *   * its padding changes at the `sm` breakpoint
 *   * a long undo message wraps to two lines at narrow widths
 *
 * Any constant is wrong in at least three of those states, and a per-screen
 * offset is the same guess repeated six times — which is how five of the six came
 * to share a number that was wrong for all of them. One measurement, published
 * once, is read by every footer and by the content padding, so they cannot
 * disagree with each other or with the bar.
 *
 * ── How it degrades ──────────────────────────────────────────────────────────
 *
 * `--dock-h` has a fallback in index.css, so a footer is positioned sensibly
 * before the first measurement and in any environment where measuring fails.
 * `ResizeObserver` is feature-detected: without it the height is still measured
 * on mount and on window resize, which covers everything except the textarea
 * growing as you type.
 *
 * @param {{current: HTMLElement|null}} ref - The dock element.
 */
export function useDockHeight(ref) {
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof document === "undefined") return;

    const root = document.documentElement;

    const publish = () => {
      // getBoundingClientRect, not offsetHeight: the dock's children include a
      // textarea whose height is set in fractional pixels by the grow handler,
      // and offsetHeight rounds. Half a pixel of rounding is a half-pixel seam
      // of page content showing through under the footer.
      const height = node.getBoundingClientRect().height;
      // 0 means not laid out yet — mid-mount, or hidden. Publishing it would
      // drop every footer to the bottom of the viewport for a frame. Leaving the
      // previous value (or the CSS fallback) is the better wrong answer.
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
  }, [ref]);
}
