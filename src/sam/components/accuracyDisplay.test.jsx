// Accuracy readouts show "—" when the value is null (nothing measured), and
// never 0%, NaN or "null%" (practice plans spec §7.1).

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import StatsBar from "./StatsBar";
import FocusedPlaybackBar from "./FocusedPlaybackBar";

// "Session Accuracy: 75%" -> "75%". StatsBar's playthrough span follows the
// value with a fraction ("0%(0/2)"), so only the value token is taken.
const value = (label) =>
  screen.getByText(new RegExp(`^${label}:`)).textContent.replace(`${label}: `, "").match(/^(—|\d+%)/)?.[0];

function stats(overrides) {
  return {
    accuracyPercent: null,
    avgTimingDeltaMs: 0,
    playthroughAccuracyPercent: null,
    playthroughHits: 0,
    playthroughScored: 0,
    hasPlaythrough: false,
    ...overrides,
  };
}

function noBadText(container) {
  expect(container.textContent).not.toMatch(/NaN|null%|undefined%/);
}

describe("StatsBar", () => {
  test("unmeasured session and playthrough show dashes, no fraction", () => {
    const { container } = render(
      <StatsBar loopCount={2} hitCount={0} missCount={9} playbackState="paused"
        sessionStats={stats({ hasPlaythrough: true, playthroughScored: 9 })} />
    );
    expect(value("Session Accuracy")).toBe("—");
    expect(value("Playthrough Accuracy")).toBe("—");
    expect(container.textContent).not.toMatch(/0%/);
    expect(container.textContent).not.toMatch(/\(0\/9\)/);
    noBadText(container);
  });

  test("measured values show as percentages with the fraction", () => {
    const { container } = render(
      <StatsBar loopCount={1} hitCount={3} missCount={1} playbackState="paused"
        sessionStats={stats({
          accuracyPercent: 75, playthroughAccuracyPercent: 0,
          hasPlaythrough: true, playthroughHits: 0, playthroughScored: 2,
        })} />
    );
    expect(value("Session Accuracy")).toBe("75%");
    expect(value("Playthrough Accuracy")).toBe("0%");
    expect(container.textContent).toMatch(/\(0\/2\)/);
  });
});

describe("FocusedPlaybackBar", () => {
  test("unmeasured values show dashes", () => {
    const { container } = render(
      <FocusedPlaybackBar onPause={() => {}} todayMinutes={0} passesToday={0}
        loopCount={0} hitCount={0} missCount={4}
        accuracyPercent={null} playthroughPercent={null} hasPlaythrough />
    );
    expect(value("Session Accuracy")).toBe("—");
    // The Playthrough badge is the other dash.
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/0%/);
    noBadText(container);
  });

  test("measured values show as percentages", () => {
    render(
      <FocusedPlaybackBar onPause={() => {}} todayMinutes={0} passesToday={0}
        loopCount={0} hitCount={4} missCount={0}
        accuracyPercent={100} playthroughPercent={100} hasPlaythrough />
    );
    expect(value("Session Accuracy")).toBe("100%");
    // The Playthrough badge shows the other 100%.
    expect(screen.getAllByText("100%")).toHaveLength(2);
  });
});
