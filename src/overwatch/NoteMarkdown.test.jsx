import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import NoteMarkdown, { parseBlocks } from "./NoteMarkdown";

const renderNote = (text) => render(<MemoryRouter><NoteMarkdown text={text} /></MemoryRouter>);

test("blocks: headings, lists, joined paragraphs", () => {
  expect(parseBlocks("# Tonight\n\nLine one\nline two\n- a\n- b\n1. c\n\nEnd")).toEqual([
    { type: "heading", level: 1, text: "Tonight" },
    { type: "paragraph", text: "Line one line two" },
    { type: "list", ordered: false, items: ["a", "b"] },
    { type: "list", ordered: true, items: ["c"] },
    { type: "paragraph", text: "End" },
  ]);
  expect(parseBlocks("")).toEqual([]);
});

test("renders headings, lists, bold and code", () => {
  renderNote("## Projects\n- **overwatch-q4n** on `s30`");
  expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  expect(screen.getByRole("listitem")).toHaveTextContent("overwatch-q4n on s30");
  expect(screen.getByText("overwatch-q4n").tagName).toBe("STRONG");
  expect(screen.getByText("s30").tagName).toBe("CODE");
});

test("Alfred links stay in the app; others open a new tab", () => {
  renderNote("[the group](https://alfredv5vibe.vercel.app/groups/detail/g1) and https://example.com/x");
  expect(screen.getByRole("link", { name: "the group" })).toHaveAttribute("href", "/groups/detail/g1");
  const out = screen.getByRole("link", { name: "https://example.com/x" });
  expect(out).toHaveAttribute("target", "_blank");
});

test("markup in the text is shown, never run", () => {
  renderNote("<b>not bold</b>");
  expect(screen.getByText("<b>not bold</b>")).toBeInTheDocument();
});
