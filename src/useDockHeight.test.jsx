import React, { useRef } from "react";
import { render, act } from "@testing-library/react";
import { useDockHeight } from "./useDockHeight";

// The dock's height is published as `--dock-h` and read by every pinned footer and
// by the content padding. What is pinned here is that one measurement reaches the
// CSS variable, that a height of zero never does, and that the hook survives an
// environment without ResizeObserver — because the old hard-coded offsets are gone
// and a footer with no value to read would sit at the very bottom of the viewport,
// underneath the capture bar.

function Harness({ height }) {
  const ref = useRef(null);
  useDockHeight(ref);
  return <div ref={ref} data-testid="dock" style={{ height }} />;
}

/** jsdom lays nothing out, so heights have to be supplied. */
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
    stubHeight(61);
    render(<Harness height={61} />);
    expect(dockVar()).toBe("61px");
  });

  it("publishes fractional pixels rather than rounding them", () => {
    // The capture textarea's grow handler sets a fractional height. Rounding it
    // leaves a half-pixel seam of page content showing under the footer.
    stubHeight(77.5);
    render(<Harness height={77.5} />);
    expect(dockVar()).toBe("77.5px");
  });

  it("republishes when the dock changes size", () => {
    // Which it does constantly: the capture textarea grows as you type, and the
    // Undo message comes and goes.
    const rect = stubHeight(61);
    render(<Harness height={61} />);
    expect(dockVar()).toBe("61px");

    rect.mockImplementation(function () {
      return { height: 140, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
    observers[0].fire();
    expect(dockVar()).toBe("140px");
  });

  it("never publishes zero", () => {
    // Mid-mount or hidden. Publishing 0 would drop every pinned footer to the
    // bottom of the viewport, behind the capture bar, for a frame.
    stubHeight(0);
    render(<Harness height={0} />);
    expect(dockVar()).toBe("");
  });

  it("keeps the last good value rather than replacing it with zero", () => {
    const rect = stubHeight(61);
    render(<Harness height={61} />);
    rect.mockImplementation(function () {
      return { height: 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
    observers[0].fire();
    expect(dockVar()).toBe("61px");
  });

  it("stops observing when unmounted", () => {
    stubHeight(61);
    const { unmount } = render(<Harness height={61} />);
    unmount();
    expect(observers[0].disconnected).toBe(true);
  });

  it("still measures without ResizeObserver, on mount and on resize", () => {
    // Feature-detected rather than assumed: without it the textarea growing is
    // missed, but the footer is still positioned correctly on arrival.
    delete global.ResizeObserver;
    const rect = stubHeight(61);
    render(<Harness height={61} />);
    expect(dockVar()).toBe("61px");

    rect.mockImplementation(function () {
      return { height: 90, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(dockVar()).toBe("90px");
  });

  it("does nothing at all when there is no element to measure", () => {
    function NoNode() {
      const ref = useRef(null);
      useDockHeight(ref);
      return null;
    }
    render(<NoNode />);
    expect(dockVar()).toBe("");
  });
});
