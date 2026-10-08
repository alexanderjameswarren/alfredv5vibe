import React from "react";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import ScoreRenderer, { computeFitScale, FIT_MIN_SCALE } from "./ScoreRenderer";
import { SCORE_SCALE } from "../lib/samConstants";

const NATURAL = 430 * SCORE_SCALE; // the stopped score's full height

describe("computeFitScale", () => {
  test("never scales up", () => {
    expect(computeFitScale(2000)).toBe(1);
    expect(computeFitScale(NATURAL)).toBe(1);
  });
  test("shrinks to fit", () => {
    expect(computeFitScale(NATURAL * 0.8)).toBeCloseTo(0.8);
  });
  test("stops at the minimum; the page scrolls instead", () => {
    expect(FIT_MIN_SCALE).toBe(0.6);
    expect(computeFitScale(100)).toBe(FIT_MIN_SCALE);
    expect(computeFitScale(0)).toBe(FIT_MIN_SCALE);
  });
});

describe("ScoreRenderer fitHeight", () => {
  // A 640px window with the score's frame starting 120px down, 22.5px of frame
  // around the SVG, and nothing under it in its column.
  beforeEach(() => {
    Object.defineProperty(document.documentElement, "clientHeight", { value: 640, configurable: true });
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect() {
      if (this.hasAttribute("data-fit-scale")) return { top: 131, bottom: 131 + NATURAL, height: NATURAL };
      if (this.classList.contains("overflow-x-auto")) return { top: 120, bottom: 120 + NATURAL + 22.5, height: NATURAL + 22.5 };
      return { top: 0, bottom: 120 + NATURAL + 22.5, height: 120 + NATURAL + 22.5 };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const holder = (container) => container.querySelector("[data-fit-scale]"); // eslint-disable-line testing-library/no-node-access

  test("fits the whole system into what is left of the window", () => {
    const { container } = render(<ScoreRenderer measures={[]} fitHeight />);
    // 640 - 120 top - 8 page padding - 22.5 frame = 489.5 of 537.5.
    const scale = Number(holder(container).getAttribute("data-fit-scale"));
    expect(scale).toBeCloseTo(489.5 / NATURAL);
    expect(holder(container).style.zoom).toBe(String(scale));
  });

  test("off (tray open): full size, no zoom", () => {
    const { container } = render(<ScoreRenderer measures={[]} fitHeight={false} />);
    expect(holder(container)).toHaveAttribute("data-fit-scale", "1");
    expect(holder(container)).not.toHaveAttribute("style");
  });

  test("a tall window: unchanged from today", () => {
    Object.defineProperty(document.documentElement, "clientHeight", { value: 1400, configurable: true });
    const { container } = render(<ScoreRenderer measures={[]} fitHeight />);
    expect(holder(container)).toHaveAttribute("data-fit-scale", "1");
    expect(holder(container)).not.toHaveAttribute("style");
  });
});
