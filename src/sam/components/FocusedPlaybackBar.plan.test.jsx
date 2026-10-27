// The tempo alert on the playing bar (sam_tempo spec).

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import FocusedPlaybackBar from "./FocusedPlaybackBar";

function bar(planTempo) {
  return render(
    <FocusedPlaybackBar onPause={() => {}} todayMinutes={0} passesToday={0} loopCount={1}
      hitCount={0} missCount={0} accuracyPercent={null} playthroughPercent={null}
      hasPlaythrough={false} planTempo={planTempo} />
  );
}
const alert = () => screen.queryByTestId("plan-tempo-alert");

test("slower: solid red, below plan goal", () => {
  bar({ status: "slower", planBpm: 60, heard: 55 });
  expect(alert()).toHaveTextContent("Below plan goal: 60");
  expect(alert()).toHaveClass("bg-red-700", "text-white");
  expect(alert()).toHaveAttribute("role", "status");
});

test("faster: blue, faster than plan", () => {
  bar({ status: "faster", planBpm: 60, heard: 66 });
  expect(alert()).toHaveTextContent("Faster than plan (60)");
  expect(alert()).toHaveClass("border-blue-700", "text-blue-800");
});

test("on plan, no item, a warm-up rung, or nothing passed: no alert", () => {
  for (const planTempo of [
    { status: "on", planBpm: 60, heard: 60 },
    { status: "none", planBpm: null, heard: 60 },
    { status: "warmup", planBpm: 60, heard: 42 },
    null,
  ]) {
    const { unmount } = bar(planTempo);
    expect(alert()).not.toBeInTheDocument();
    unmount();
  }
});

test("it sits in the top row beside Pause, not over the score", () => {
  bar({ status: "slower", planBpm: 60, heard: 55 });
  // eslint-disable-next-line testing-library/no-node-access
  expect(alert().parentElement).toBe(screen.getByRole("button", { name: /Pause/ }).parentElement);
});
