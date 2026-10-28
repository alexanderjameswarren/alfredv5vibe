// The render effect with a song that needs extra room, using the real
// scoreRender module. Only VexFlow is faked: every call answers with another
// stand-in, except the few things the component touches as real DOM.
import React from "react";
import { render } from "@testing-library/react";
import ScoreRenderer from "./ScoreRenderer";
import { SCORE_SCALE } from "../lib/samConstants";

function anything() {
  const fn = function stub() {};
  return new Proxy(fn, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* empty() {};
      if (k === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
    construct: () => anything(),
  });
}

function fakeVexFlow(resizes) {
  const NS = "http://www.w3.org/2000/svg";
  return new Proxy({}, {
    get: (t, k) => {
      if (k !== "Renderer") return anything();
      function Renderer(container) {
        const svg = document.createElementNS(NS, "svg");
        container.appendChild(svg);
        this.resize = (w, h) => resizes.push(h);
        this.getContext = () => new Proxy({}, {
          get: (c, m) => {
            if (m === "svg") return svg;
            if (m === "openGroup") return () => svg.appendChild(document.createElementNS(NS, "g"));
            return () => anything();
          },
        });
      }
      Renderer.Backends = { SVG: 1 };
      return Renderer;
    },
  });
}

const q = (name, midi, extra) => ({ duration: "w", notes: [{ name, midi, ...extra }] });
const measure = (rh, lh) => ({ number: 1, timeSignature: { beats: 4, beatType: 4 }, rh: [rh], lh: [lh] });

let resizes;
beforeEach(() => {
  resizes = [];
  window.Vex = { Flow: fakeVexFlow(resizes) };
});
afterEach(() => { delete window.Vex; });

test("a normal song keeps the old height", () => {
  render(<ScoreRenderer measures={[measure(q("C5", 72), q("C3", 48))]} />);
  expect(resizes).toEqual([430 * SCORE_SCALE]);
});

// Room above and label placement are measured from what VexFlow draws, and
// this stand-in draws nothing; ScoreRenderer.labels.vexflow.test.jsx covers
// them with real VexFlow.
test("a song with C8, D8 and markings renders without throwing", () => {
  const rh = q("C8", 108, { tremolo: { type: "single", marks: 3 } });
  const lh = q("D8", 110, { unscored: true, gliss: { kind: "slide", type: "start" } });
  const { container } = render(<ScoreRenderer measures={[measure(rh, lh)]} />);
  expect(resizes).toEqual([430 * SCORE_SCALE]);
  expect(container.querySelector("text").getAttribute("y")).toBe("38"); // eslint-disable-line testing-library/no-node-access
});
