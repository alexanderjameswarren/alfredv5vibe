import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import TransportControls, { resolveResumeMeasure } from "./TransportControls";

describe("resolveResumeMeasure", () => {
  const range = { min: 3, max: 8 };
  test("a number in range is used", () => expect(resolveResumeMeasure("5", 4, range)).toBe(5));
  test("clamps to the range", () => {
    expect(resolveResumeMeasure("1", 4, range)).toBe(3);
    expect(resolveResumeMeasure("20", 4, range)).toBe(8);
  });
  test("empty or junk falls back to the paused measure", () => {
    expect(resolveResumeMeasure("", 4, range)).toBe(4);
    expect(resolveResumeMeasure("abc", 4, range)).toBe(4);
    expect(resolveResumeMeasure(null, null, range)).toBeNull();
  });
});

const base = { playbackState: "paused", songDbId: "s", onResume: () => {}, onRestart: () => {}, onStop: () => {} };

test("paused: the measure box sits after Resume, with the printed number when it differs", () => {
  const onChange = jest.fn();
  const printedFor = (n) => (n === 10 ? "2" : null);
  const { rerender } = render(
    <TransportControls {...base} resumeAt={{ value: "6", onChange, min: 1, max: 12, printedFor }} />);
  expect(screen.getByLabelText("Resume at measure")).toHaveValue(6);
  expect(screen.queryByTestId("resume-printed")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Resume at measure"), { target: { value: "10" } });
  expect(onChange).toHaveBeenCalledWith("10");
  rerender(<TransportControls {...base} resumeAt={{ value: "10", onChange, min: 1, max: 12, printedFor }} />);
  expect(screen.getByTestId("resume-printed")).toHaveTextContent("(2)");
});

test("the box is the BPM box's kind: numeric keypad, full width, 44px, whole value selected on focus", () => {
  render(<TransportControls {...base} vertical resumeAt={{ value: "12", onChange: () => {}, min: 1, max: 40 }} />);
  const el = screen.getByLabelText("Resume at measure");
  expect(el).toHaveAttribute("type", "number");
  expect(el).toHaveAttribute("inputmode", "numeric");
  expect(el).toHaveClass("w-full", "min-h-[44px]");
  const select = jest.spyOn(el, "select");
  fireEvent.focus(el);
  expect(select).toHaveBeenCalled();
});

test("Enter in the box resumes; other keys do not", () => {
  const onResume = jest.fn();
  render(<TransportControls {...base} onResume={onResume} resumeAt={{ value: "12", onChange: () => {}, min: 1, max: 40 }} />);
  const el = screen.getByLabelText("Resume at measure");
  fireEvent.keyDown(el, { key: "5" });
  expect(onResume).not.toHaveBeenCalled();
  fireEvent.keyDown(el, { key: "Enter" });
  expect(onResume).toHaveBeenCalledTimes(1);
});

test("no measure box unless paused", () => {
  render(<TransportControls {...base} playbackState="stopped" onPlay={() => {}}
    resumeAt={{ value: "6", onChange: () => {}, min: 1, max: 12 }} />);
  expect(screen.queryByLabelText("Resume at measure")).not.toBeInTheDocument();
});
