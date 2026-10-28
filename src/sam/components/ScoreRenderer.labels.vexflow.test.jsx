// Bar-number labels against what REAL VexFlow draws, in both views. The
// stand-in VexFlow in ScoreRenderer.padding.test.jsx draws nothing, which is
// how two broken label rules got through. Shapes are read straight from the
// SVG with a reader written here, not the app's own (scoreRender.shapeBox).
//
// Needs VexFlow 4.2.2 (the version index.html loads): `npm i -D vexflow@4.2.2`,
// or VEXFLOW_PATH pointing at its build/cjs/vexflow.js. Skipped without it.
import React from "react";
import { render, act } from "@testing-library/react";
import ScoreRenderer from "./ScoreRenderer";
import ScrollEngine from "./ScrollEngine";
import bars from "../lib/__fixtures__/notation/label-bars.json";

function loadVexFlow() {
  try {
    return require(process.env.VEXFLOW_PATH || "vexflow"); // eslint-disable-line global-require
  } catch {
    return null;
  }
}
const Vex = loadVexFlow();
const maybe = Vex ? describe : describe.skip;

// [x0, y0, x1, y1] of a drawn shape; arcs padded by their radius.
function extents(el) {
  const n = (a) => parseFloat(el.getAttribute(a)) || 0;
  const tag = el.tagName.toLowerCase();
  if (tag === "rect") return [n("x"), n("y"), n("x") + n("width"), n("y") + n("height")];
  if (tag === "text") {
    const s = parseFloat(el.getAttribute("font-size")) || 10;
    return [n("x"), n("y") - s, n("x") + el.textContent.length * s * 0.6, n("y") + s * 0.25];
  }
  if (tag !== "path") return null;
  const xs = [], ys = [];
  let cx = 0, cy = 0;
  for (const seg of (el.getAttribute("d") || "").split(/(?=[MLCQZHVA])/)) {
    const c = seg[0];
    const v = (seg.slice(1).match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
    if (c === "H") cx = v[v.length - 1];
    else if (c === "V") cy = v[v.length - 1];
    else if (c === "A") {
      const r = Math.max(v[0], v[1]);
      [cx, cy] = [v[5], v[6]];
      xs.push(cx - r, cx + r); ys.push(cy - r, cy + r);
      continue;
    } else if (v.length >= 2) {
      for (let i = 0; i + 1 < v.length; i += 2) { xs.push(v[i]); ys.push(v[i + 1]); }
      [cx, cy] = [v[v.length - 2], v[v.length - 1]];
      continue;
    }
    xs.push(cx); ys.push(cy);
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
}

function labelProblems(svg) {
  const viewTop = Number(svg.getAttribute("viewBox").split(/\s+/)[1]);
  const isText = (el) => el.tagName.toLowerCase() === "text";
  const shapes = [...svg.querySelectorAll("path, rect, line")].map(extents).filter(Boolean);
  const labels = [...svg.querySelectorAll("text")].filter((t) => isText(t) && t.getAttribute("font-family") === "monospace");
  const problems = [];
  for (const l of labels) {
    const x0 = parseFloat(l.getAttribute("x"));
    const base = parseFloat(l.getAttribute("y"));
    const box = [x0, base - 10, x0 + l.textContent.length * 6.02, base + 2];
    const hits = shapes.filter((s) => s[2] > box[0] && s[0] < box[2] && s[3] > box[1] && s[1] < box[3]);
    if (hits.length) problems.push(`${l.textContent} overlaps ${hits.length} shape(s)`);
    if (box[1] < viewTop) problems.push(`${l.textContent} clipped`);
  }
  const top = Math.min(...shapes.map((s) => s[1]));
  if (top < viewTop) problems.push(`music clipped at the top (${top.toFixed(1)} < ${viewTop})`);
  return { problems, labels };
}

maybe("bar labels with real VexFlow", () => {
  beforeAll(() => { window.Vex = Vex; });
  afterAll(() => { delete window.Vex; });

  const views = {
    browse: (measures) => <ScoreRenderer measures={measures} measureWidth={300} />,
    practice: (measures) => <ScrollEngine measures={measures} bpm={80} playbackState="stopped" measureWidth={300} loop={false} />,
  };
  for (const [song, measures] of Object.entries(bars).filter(([k]) => !k.startsWith("_"))) {
    for (const [view, el] of Object.entries(views)) {
      test(`${song}, ${view}: no label overlaps or is clipped`, async () => {
        let container;
        await act(async () => { ({ container } = render(el(measures))); });
        const { problems, labels } = labelProblems(container.querySelector("svg")); // eslint-disable-line testing-library/no-node-access
        expect(labels.length).toBe(measures.length);
        expect(problems).toEqual([]);
      });
    }
  }

  test("a bar with nothing under its label keeps today's spot", async () => {
    const plain = [{ number: 1, timeSignature: { beats: 4, beatType: 4 }, rh: [{ duration: "w", notes: [{ midi: 72, name: "C5" }] }], lh: [{ duration: "w", notes: [{ midi: 48, name: "C3" }] }] }];
    let container;
    await act(async () => { ({ container } = render(<ScoreRenderer measures={plain} measureWidth={300} />)); });
    const svg = container.querySelector("svg"); // eslint-disable-line testing-library/no-node-access
    expect(svg.querySelector("text").getAttribute("y")).toBe("38"); // eslint-disable-line testing-library/no-node-access
    expect(svg.getAttribute("viewBox").split(/\s+/)[1]).toBe("0");
  });
});
