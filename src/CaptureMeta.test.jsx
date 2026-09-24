import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { friendlyDate, sourceLabel, SourceIcon } from "./CaptureMeta";

// The SOURCE vocabulary: how a capture arrived. Six values now, since Step 20 added
// `task` for a scheduled run.
//
// ⚠️ `inbox.source_type` has no check constraint and no enum, so a writer that
// forgets to come here is not an error anywhere — the row just renders as "typed by
// hand". These tests exist because that failure is silent.

describe("sourceLabel", () => {
  it("names every source the app writes", () => {
    expect(sourceLabel("manual")).toBe("Capture");
    expect(sourceLabel("mcp")).toBe("Claude");
    expect(sourceLabel("task")).toBe("Task");
    expect(sourceLabel("email")).toBe("Email");
    expect(sourceLabel("clipboard")).toBe("Clipboard");
    expect(sourceLabel("cli")).toBe("CLI");
  });

  it("distinguishes a scheduled task from a live conversation", () => {
    // The reason `task` is a source and not more `mcp`: a task row arrives
    // unenriched, so the list has to say so and offer something different to do.
    expect(sourceLabel("task")).not.toBe(sourceLabel("mcp"));
  });

  it("falls back to Capture for anything unrecognised", () => {
    expect(sourceLabel("something-new")).toBe("Capture");
    expect(sourceLabel(null)).toBe("Capture");
    expect(sourceLabel(undefined)).toBe("Capture");
  });
});

describe("SourceIcon", () => {
  const iconFor = (sourceType) => {
    const { container, unmount } = render(<SourceIcon sourceType={sourceType} />);
    const svg = container.querySelector("svg");
    const name = svg ? svg.getAttribute("class") : null;
    unmount();
    return name;
  };

  it("gives every source its own glyph", () => {
    const sources = ["manual", "mcp", "task", "email", "clipboard", "cli"];
    const glyphs = sources.map(iconFor);
    for (const g of glyphs) expect(g).toBeTruthy();
    // Distinct: two sources sharing an icon would make the meta line ambiguous.
    expect(new Set(glyphs).size).toBe(sources.length);
  });

  it("gives a task its own glyph rather than reusing Claude's", () => {
    expect(iconFor("task")).not.toBe(iconFor("mcp"));
  });

  it("labels the glyph with the stored value, for a hover", () => {
    render(<SourceIcon sourceType="task" />);
    expect(screen.getByTitle("Source: task")).toBeInTheDocument();
  });

  it("renders an unrecognised source as the manual pencil, visibly rather than blank", () => {
    // Quietly wrong beats invisible: a missing icon would read as a rendering bug
    // instead of as a source nobody has taught this file about.
    expect(iconFor("something-new")).toBe(iconFor("manual"));
    render(<SourceIcon sourceType="something-new" />);
    expect(screen.getByTitle("Source: something-new")).toBeInTheDocument();
  });
});

describe("friendlyDate", () => {
  it("names today and yesterday rather than dating them", () => {
    expect(friendlyDate(new Date().toISOString())).toMatch(/^Today at /);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(friendlyDate(yesterday.toISOString())).toMatch(/^Yesterday at /);
  });

  it("gives anything older a weekday and a date", () => {
    const old = new Date();
    old.setDate(old.getDate() - 10);
    const out = friendlyDate(old.toISOString());
    expect(out).not.toMatch(/^Today|^Yesterday/);
    expect(out).toMatch(/at \d{1,2}:\d{2}/);
  });
});
