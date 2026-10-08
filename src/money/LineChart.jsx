import React from "react";
import { formatDay, formatMoney, toNumber } from "./moneyFormat";

const W = 600;
const PAD = { top: 12, right: 8, bottom: 22, left: 8 };

/** Scale points into the SVG box. Exported for tests. */
export function chartGeometry(points, height) {
  const ys = points.map((p) => p.y);
  let min = Math.min(...ys);
  let max = Math.max(...ys);
  if (min === max) { min -= 1; max += 1; }
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => PAD.top + (1 - (v - min) / (max - min)) * innerH;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  const zeroY = min < 0 && max > 0 ? y(0) : null;
  return { path, min, max, zeroY, lastX: x(points.length - 1), lastY: y(points[points.length - 1].y) };
}

/**
 * A plain line chart in inline SVG, scaled to its container's width.
 * @param {Array<{day: string, value: number|string}>} data  oldest first
 */
export default function LineChart({ data, height = 180, label, valueFormat = formatMoney }) {
  const points = (data || [])
    .map((d) => ({ day: d.day, y: toNumber(d.value) }))
    .filter((p) => p.y !== null);

  if (points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        Not enough history to draw a chart yet.
      </p>
    );
  }

  const g = chartGeometry(points, height);
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full h-auto text-primary"
        role="img"
        aria-label={`${label}: ${valueFormat(first.y)} on ${formatDay(first.day)} to ${valueFormat(last.y)} on ${formatDay(last.day)}`}
      >
        {g.zeroY !== null && (
          <line x1={PAD.left} x2={W - PAD.right} y1={g.zeroY} y2={g.zeroY}
            className="text-border" stroke="currentColor" strokeDasharray="4 4" />
        )}
        <path d={g.path} fill="none" stroke="currentColor" strokeWidth="2"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <circle cx={g.lastX} cy={g.lastY} r="3" fill="currentColor" />
      </svg>
      <figcaption className="flex justify-between text-xs text-muted-foreground mt-1 tabular-nums">
        <span>{formatDay(first.day)}</span>
        <span>
          low {valueFormat(Math.min(...points.map((p) => p.y)))} · high {valueFormat(Math.max(...points.map((p) => p.y)))}
        </span>
        <span>{formatDay(last.day)}</span>
      </figcaption>
    </figure>
  );
}
