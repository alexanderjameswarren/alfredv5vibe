import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import OriginalCapture from "./OriginalCapture";
import { COLLAPSE_LINES } from "./utils/capturedClip";

const LONG = Array.from({ length: COLLAPSE_LINES + 4 }, (_, i) => `line ${i + 1}`).join("\n");
const showAll = () => screen.queryByRole("button", { name: /Show all/ });

describe("OriginalCapture", () => {
  it("shows the capture under a heading", () => {
    render(<OriginalCapture capturedText="Call the plumber, ask for Dave." />);
    expect(screen.getByText("Original capture")).toBeInTheDocument();
    expect(screen.getByText("Call the plumber, ask for Dave.")).toBeInTheDocument();
  });

  it("renders nothing without a capture", () => {
    const { container } = render(<OriginalCapture capturedText={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a capture that is only whitespace", () => {
    // An expression, not a JSX string attribute: the latter does not read `\n` as a newline.
    const { container } = render(<OriginalCapture capturedText={"   \n  "} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Show all only when the capture is long", () => {
    render(<OriginalCapture capturedText="One line." />);
    expect(showAll()).not.toBeInTheDocument();
  });

  it("clamps a long capture, then reveals it in place", () => {
    render(<OriginalCapture capturedText={LONG} />);
    const block = screen.getByText(/line 1/);
    expect(block).toHaveStyle({ overflow: "hidden" });
    fireEvent.click(showAll());
    expect(block).not.toHaveStyle({ overflow: "hidden" });
    // Always in the DOM, so a browser find reaches it either way.
    expect(block).toHaveTextContent("line 10");
    fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
    expect(block).toHaveStyle({ overflow: "hidden" });
  });

  it("offers no way to edit the capture", () => {
    render(<OriginalCapture capturedText="Call the plumber." />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("both detail views show it", () => {
  const alfred = fs.readFileSync(path.join(__dirname, "Alfred.jsx"), "utf8");

  it("renders on the item view and the intention view, and nowhere else", () => {
    expect(alfred.split("<OriginalCapture").length - 1).toBe(2);
  });

  it("resolves the capture from sourceInboxId, out of the archived rows", () => {
    // `inboxItems` is the LIVE list and triage archives the row, so resolving from it
    // would find nothing for every record that has a capture.
    expect(alfred).toContain("allInboxItems.find((i) => i.id === record.sourceInboxId)");
  });
});
