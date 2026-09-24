import React, { useState } from "react";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useDockHeight } from "./useDockHeight";

// The dock's height is published as `--dock-h` and read by every pinned footer and
// by the content padding. The hard-coded offsets are gone, so a missing measurement
// is not a cosmetic shortfall — it is footers tucked behind the capture bar and the
// last section of a long page unable to scroll clear of it.
//
// The test that matters most is "measures a dock that mounts on a LATER render".
// That is the Step 17c bug: Alfred has five early returns before the dock exists, so
// the first version's effect ran once against a null ref and, with a stable ref in
// its dependency array, never ran again.

function stubHeight(px) {
  return jest
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function () {
      return { height: px, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
}

function dockVar() {
  return document.documentElement.style.getPropertyValue("--dock-h");
}

/** A dock that is present from the first render. */
function Harness() {
  const setDockNode = useDockHeight();
  return <div ref={setDockNode} data-testid="dock" />;
}

/**
 * Alfred's actual shape: an early return that renders no dock at all, then the real
 * tree once the data has loaded.
 */
function LateHarness({ ready }) {
  const setDockNode = useDockHeight();
  if (!ready) return <div>loading…</div>;
  return <div ref={setDockNode} data-testid="dock" />;
}

describe("useDockHeight", () => {
  let observers;
  let originalRO;

  beforeEach(() => {
    document.documentElement.style.removeProperty("--dock-h");
    observers = [];
    originalRO = global.ResizeObserver;
    global.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
      fire() {
        act(() => this.callback());
      }
    };
  });

  afterEach(() => {
    global.ResizeObserver = originalRO;
    jest.restoreAllMocks();
  });

  it("publishes the measured height on mount", () => {
    stubHeight(81);
    render(<Harness />);
    expect(dockVar()).toBe("81px");
  });

  it("measures a dock that mounts on a LATER render", () => {
    // 🛑 THE STEP 17C BUG. Every cold load of Alfred passes through an early return
    // — authLoading, no user, data not loaded, the SAM view, the Timer view — so the
    // dock does not exist on the render an effect first runs against. A ref-based
    // version saw null, gave up, and never looked again, leaving every screen on the
    // CSS fallback for the rest of the session.
    stubHeight(81);
    const { rerender } = render(<LateHarness ready={false} />);
    expect(dockVar()).toBe("");

    rerender(<LateHarness ready />);
    expect(dockVar()).toBe("81px");
  });

  it("re-measures when the dock comes back after going away", () => {
    // Navigating to SAM or the Timer unmounts the dock; coming back mounts a new
    // node, which may be a different height than the one that left.
    const rect = stubHeight(81);
    const { rerender } = render(<LateHarness ready />);
    expect(dockVar()).toBe("81px");

    rerender(<LateHarness ready={false} />);
    rect.mockImplementation(function () {
      return { height: 61, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
    rerender(<LateHarness ready />);
    expect(dockVar()).toBe("61px");
  });

  it("publishes fractional pixels rather than rounding them", () => {
    // The capture textarea's grow handler sets a fractional height. Rounding it
    // leaves a half-pixel seam of page content showing under a footer.
    stubHeight(77.5);
    render(<Harness />);
    expect(dockVar()).toBe("77.5px");
  });

  it("republishes when the dock changes size", () => {
    // Which it does constantly: the capture textarea grows as you type, and the Undo
    // message comes and goes.
    const rect = stubHeight(61);
    render(<Harness />);
    expect(dockVar()).toBe("61px");

    rect.mockImplementation(function () {
      return { height: 140, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
    observers[0].fire();
    expect(dockVar()).toBe("140px");
  });

  it("never publishes zero", () => {
    // Mid-mount or hidden. Publishing 0 would drop every pinned footer to the bottom
    // of the viewport, behind the capture bar.
    stubHeight(0);
    render(<Harness />);
    expect(dockVar()).toBe("");
  });

  it("keeps the last good value rather than replacing it with zero", () => {
    const rect = stubHeight(61);
    render(<Harness />);
    rect.mockImplementation(function () {
      return { height: 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
    observers[0].fire();
    expect(dockVar()).toBe("61px");
  });

  it("stops observing when unmounted", () => {
    stubHeight(61);
    const { unmount } = render(<Harness />);
    unmount();
    expect(observers[0].disconnected).toBe(true);
  });

  it("leaves the last measurement in place when the dock unmounts", () => {
    // The screens without a dock have no pinned footers and no padding reading this,
    // so clearing it would only put the fallback back in play for a frame on return.
    stubHeight(81);
    const { rerender } = render(<LateHarness ready />);
    rerender(<LateHarness ready={false} />);
    expect(dockVar()).toBe("81px");
  });

  it("still measures without ResizeObserver, on mount and on resize", () => {
    // Feature-detected rather than assumed: without it the textarea growing is
    // missed, but the footer is still positioned correctly on arrival.
    delete global.ResizeObserver;
    const rect = stubHeight(61);
    render(<Harness />);
    expect(dockVar()).toBe("61px");

    rect.mockImplementation(function () {
      return { height: 90, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(dockVar()).toBe("90px");
  });

  it("hands back a stable callback, so it does not re-attach every render", () => {
    // If the ref callback changed identity per render, React would detach and
    // re-attach the dock constantly and the observer would be torn down with it.
    const seen = new Set();
    function Counter() {
      const setDockNode = useDockHeight();
      const [, force] = useState(0);
      seen.add(setDockNode);
      return (
        <div ref={setDockNode}>
          <button onClick={() => force((n) => n + 1)}>re-render</button>
        </div>
      );
    }
    stubHeight(61);
    const { getByText } = render(<Counter />);
    act(() => {
      getByText("re-render").click();
    });
    act(() => {
      getByText("re-render").click();
    });
    expect(seen.size).toBe(1);
  });
});
