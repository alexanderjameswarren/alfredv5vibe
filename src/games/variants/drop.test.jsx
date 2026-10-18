import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import Drop, { devFlag, resolveChainTap, MAX_PITCH } from "./drop";
import { TILE, noteBounds, tileGeometry } from "../noteTile";

const at = (url) => window.history.pushState({}, "", url);

// Full 5x5 board; bottom row given, the rest a pattern with no 12s.
const boardWith = (bottom) => [
  0, 3, 6, 0, 3,
  6, 0, 3, 6, 0,
  3, 6, 0, 3, 6,
  0, 3, 6, 0, 3,
  ...bottom,
];

const saveRun = (board) =>
  window.localStorage.setItem(
    "alfred.game.drop",
    JSON.stringify({
      board, history: [], armed: null, taps: 0, largestChain: 0,
      bankedClears: 0, searchExhausted: false,
    })
  );

const score = () => screen.getByText("Tiles cleared", { exact: false }).textContent;

describe("ceiling", () => {
  test("a chain tapped at 12 clears whole and counts N", () => {
    const move = resolveChainTap(boardWith([12, 12, 12, 0, 3]), 20);
    expect(move.cleared).toBe(3);
    expect(move.next.slice(20, 23)).toEqual([null, null, null]);
    expect(move.arms).toBe(false);
  });

  test("an 11 tapped next to a 12 climbs to 12", () => {
    const move = resolveChainTap(boardWith([11, 12, 0, 3, 6]), 20);
    expect(move.next[20]).toBe(12);
    expect(move.cleared).toBe(1);
  });

  test("no tap ever produces a tile above 12", () => {
    let highest = 0;
    for (let n = 0; n < 300; n++) {
      const b = Array.from({ length: 25 }, () => Math.floor(Math.random() * (MAX_PITCH + 1)));
      for (let i = 0; i < 25; i++) {
        const move = resolveChainTap(b, i);
        for (const p of move ? move.next : []) if (p != null) highest = Math.max(highest, p);
      }
    }
    expect(highest).toBeLessThanOrEqual(12);
  });

  test("tapping a row of 12s clears it and adds 3 to the score", () => {
    at("/games");
    saveRun(boardWith([12, 12, 12, 0, 3]));
    render(<Drop />);
    fireEvent.click(screen.getAllByLabelText("note 12")[0]);
    expect(score()).toBe("Tiles cleared 3");
    expect(screen.queryAllByLabelText("note 12")).toHaveLength(0);
  });

  test("a save holding pitch 15 loads, clamped to 12", () => {
    at("/games");
    saveRun(boardWith([15, 0, 3, 6, 0]));
    render(<Drop />);
    expect(screen.queryByLabelText("note 15")).toBeNull();
    expect(screen.getAllByLabelText("note 12")).toHaveLength(1);
  });
});

describe("tile drawing", () => {
  test.each(Array.from({ length: 13 }, (_, p) => p))("pitch %i fits its tile", (p) => {
    const { top, bottom } = noteBounds(p, TILE, MAX_PITCH);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(TILE);
  });

  test("default geometry is unchanged for the other variants", () => {
    const g = tileGeometry(TILE);
    expect(g.spacing).toBeCloseTo(TILE / 7);
    expect(g.topLine).toBeCloseTo(0.25 * TILE);
  });
});

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("devFlag", () => {
  test("on with the query string in dev", () => {
    at("/games?notePreview");
    expect(devFlag("notePreview", "development")).toBe(true);
  });

  test("off in production even with the query string", () => {
    at("/games?notePreview");
    expect(devFlag("notePreview", "production")).toBe(false);
  });

  test("off without the query string", () => {
    at("/games");
    expect(devFlag("notePreview", "development")).toBe(false);
  });

  test("remembered for the tab after navigation", () => {
    at("/games?notePreview");
    devFlag("notePreview", "development");
    at("/home");
    expect(devFlag("notePreview", "development")).toBe(true);
  });
});

describe("Drop preview", () => {
  test("renders 13 labelled tiles with the flag", () => {
    at("/games?notePreview");
    render(<Drop />);
    expect(screen.getByText("Dev preview")).toBeTruthy();
    expect(screen.getAllByTestId("note-preview-tile")).toHaveLength(13);
  });

  test("absent without the flag", () => {
    at("/games");
    render(<Drop />);
    expect(screen.queryByText("Dev preview")).toBeNull();
    expect(screen.getByText(/note preview off/)).toBeTruthy();
  });
});
