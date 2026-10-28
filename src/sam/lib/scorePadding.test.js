import { scorePadding, noteHeadY, shapeBox, placeBarLabels, topRoomFor, growSvgTop, SCORE_PAD_CAP } from "./scoreRender";
import { struckMidi } from "./measureUtils";

const PRACTICE = { trebleY: 40, bassY: 210, height: 350 };
const n = (name, midi, extra = {}) => ({ name, midi, ...extra });
const ev = (x) => ({ duration: "q", notes: [x] });
const song = (rh, lh = []) => [{ rh: rh.map(ev), lh: lh.map(ev) }];
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs, parent) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
};

test("staff lines land where VexFlow draws them", () => {
  expect(noteHeadY(n("F5", 77), "treble", 40)).toBe(80);
  expect(noteHeadY(n("E4", 64), "treble", 40)).toBe(120);
  expect(noteHeadY(n("A3", 57), "bass", 210)).toBe(250);
  expect(noteHeadY(n("G2", 43), "bass", 210)).toBe(290);
});

test("a normal song gets no extra room between or below", () => {
  expect(scorePadding(song([n("C6", 84), n("C4", 60)], [n("C2", 36), n("C4", 60)]), PRACTICE))
    .toEqual({ gap: 0, bottom: 0 });
});

test("a very high left-hand note opens the gap, capped", () => {
  expect(scorePadding(song([], [n("D8", 110)]), PRACTICE).gap).toBe(30);
  expect(scorePadding(song([n("C1", 24)], [n("D8", 110)]), PRACTICE).gap).toBe(SCORE_PAD_CAP);
});

test("low bass notes add room below", () => {
  expect(scorePadding(song([], [n("A0", 21)]), PRACTICE).bottom).toBe(10);
});

test("shape boxes read path data, absolute and relative, arcs included", () => {
  expect(shapeBox(svgEl("path", { d: "M10 20L30 5", "stroke-width": 2 }))).toEqual({ x0: 9, y0: 4, x1: 31, y1: 21 });
  expect(shapeBox(svgEl("path", { d: "m10 20l5 -15" })).y0).toBeCloseTo(4.5);
  expect(shapeBox(svgEl("path", { d: "M18 85 A2 2 0 0 0 14 85" })).y0).toBeCloseTo(82.5);
});

test("only the label with a shape under it moves, just above that shape", () => {
  const svg = svgEl("svg", { viewBox: "0 0 600 350" });
  const a = svgEl("text", { x: 5, y: 38, "font-size": 10 }, svg); a.textContent = "7";
  const b = svgEl("text", { x: 305, y: 38, "font-size": 10 }, svg); b.textContent = "8";
  const section = svgEl("text", { x: 2, y: 22 }, svg);
  svgEl("path", { d: "M8 30L8 70", "stroke-width": 0 }, svg); // a stem under bar 7's label
  svgEl("path", { d: "M400 10L400 70", "stroke-width": 0 }, svg); // high, but not under bar 8's label
  const { lifted, minY } = placeBarLabels(svg, [{ el: a, followers: [section] }, { el: b }], new Set([a, b, section]));
  expect(lifted).toEqual([0]);
  expect(a.getAttribute("y")).toBe("26"); // 30 - 2 clear - 2 descent
  expect(section.getAttribute("y")).toBe("10");
  expect(b.getAttribute("y")).toBe("38");
  expect(minY).toBe(10); // the stem at x=400
});

test("room above is added only when something starts above the top", () => {
  expect(topRoomFor(10)).toBe(0);
  expect(topRoomFor(-0.5)).toBe(10);
  expect(topRoomFor(-43.7)).toBe(50);
  const svg = svgEl("svg", { viewBox: "0 0 100 350", height: 437.5 });
  growSvgTop(svg, 50, 1.25);
  expect(svg.getAttribute("viewBox")).toBe("0 -50 100 400");
  expect(svg.getAttribute("height")).toBe("500");
});

test("unscored notes are not asked for", () => {
  expect(struckMidi({ notes: [n("D8", 110, { unscored: true }), n("E6", 88)] })).toEqual([88]);
});
