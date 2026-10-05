import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import PlanGoalLine, { PULSE_MS } from "./PlanGoalLine";

const VIEW = { consecutive: false, accuracy: 90, effectiveBpm: 60, target: 4, filled: 1,
  best: null, done: false, planText: "Plan 1/4" };
const line = () => screen.getByLabelText("Plan goal");

afterEach(() => jest.useRealTimers());

test("no view, no line", () => {
  render(<PlanGoalLine view={null} />);
  expect(screen.queryByLabelText("Plan goal")).not.toBeInTheDocument();
});

test("the pulse fires on a new event only and clears in under a second", () => {
  jest.useFakeTimers();
  const { rerender } = render(<PlanGoalLine view={VIEW} flash={{ kind: "qualified", seq: 3 }} />);
  expect(line()).toHaveAttribute("data-pulse", "none");
  rerender(<PlanGoalLine view={VIEW} flash={{ kind: "broke", seq: 4 }} />);
  expect(line()).toHaveAttribute("data-pulse", "broke");
  expect(line()).toHaveClass("ring-amber-500");
  expect(PULSE_MS).toBeLessThan(1000);
  act(() => { jest.advanceTimersByTime(PULSE_MS); });
  expect(line()).toHaveAttribute("data-pulse", "none");
});

test("done: green line, all dots filled, check", () => {
  render(<PlanGoalLine view={{ ...VIEW, filled: 0, done: true, planText: "Plan ✓" }} />);
  expect(line()).toHaveClass("bg-done", "text-done-foreground");
  expect(screen.getByLabelText("Plan item done")).toBeInTheDocument();
  // eslint-disable-next-line testing-library/no-node-access
  expect(screen.getByTestId("goal-dots").querySelectorAll("[data-mark=filled]")).toHaveLength(4);
});

test("free play: tempo only", () => {
  render(<PlanGoalLine view={{ ...VIEW, accuracy: null }} />);
  expect(line()).toHaveTextContent("60 BPM");
  expect(line()).not.toHaveTextContent("%");
});
