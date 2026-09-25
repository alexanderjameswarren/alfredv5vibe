import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import InboxListCard from "./InboxListCard";

const CONTEXTS = [
  { id: "ctx-alfred", name: "Alfred" },
  { id: "ctx-recipes", name: "Recipes" },
];

function setup(over = {}) {
  const onOpen = jest.fn();
  const onProcess = jest.fn();
  const onCopy = jest.fn();
  const onDiscard = jest.fn();
  const utils = render(
    <InboxListCard
      inboxItem={{
        id: "inbox-1",
        capturedText: "Retire the ai-enrich edge function",
        sourceType: "mcp",
        aiStatus: "enriched",
        createdAt: "2026-09-24T09:10:00.000Z",
        ...over,
      }}
      contexts={CONTEXTS}
      onOpen={onOpen}
      onProcess={onProcess}
      onCopy={onCopy}
      onDiscard={onDiscard}
    />,
  );
  return { onOpen, onProcess, onCopy, onDiscard, ...utils };
}

const processBtn = () => screen.queryByRole("button", { name: /Process/ });
const copyBtn = () => screen.queryByRole("button", { name: /Copy/ });
const trashBtn = () => screen.getByRole("button", { name: "Discard" });

describe("what every card shows", () => {
  it("the capture, the source in words, the time and the status", () => {
    setup();
    expect(screen.getByText("Retire the ai-enrich edge function")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText(/at \d{1,2}:\d{2}/)).toBeInTheDocument();
    expect(screen.getByText("Enriched")).toBeInTheDocument();
  });

  it("clamps the title to two lines rather than letting a paragraph own the list", () => {
    setup({ capturedText: "x ".repeat(400) });
    // A Tailwind class, not an inline style, precisely so this is assertable: jsdom
    // discards `-webkit-line-clamp` from an inline style, so the earlier version of
    // this could not be checked at all.
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("line-clamp-2");
  });

  it("titles at the Schedule cards' weight, not bolder — Step 22", () => {
    // It was `font-bold`, which made a list of captures read heavier than every other
    // list in the app. The Schedule card is the reference, and the guard below reads it
    // out of Alfred.jsx so the two cannot drift apart silently.
    setup();
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("font-medium");
    expect(screen.getByRole("heading", { level: 3 })).not.toHaveClass("font-bold");
  });

  it("matches the Schedule card's title weight, read from the source", () => {
    // 🛑 If `EventCard`'s title weight ever changes, this fails and says so, rather than
    // leaving the inbox quietly out of step with the screen it was styled after.
    const alfred = fs.readFileSync(path.join(__dirname, "Alfred.jsx"), "utf8");
    expect(alfred).toContain(
      'className="flex items-start gap-1.5 font-medium text-foreground hover:text-primary"',
    );
  });

  it("a trash can, whatever else it offers", () => {
    // Disposing of a capture you can already read should not require opening a form —
    // Step 5b's reasoning, unchanged.
    for (const over of [{}, { aiStatus: "not_started" }, { sourceType: "task", aiStatus: "not_started" }]) {
      const { unmount } = setup(over);
      expect(trashBtn()).toBeInTheDocument();
      unmount();
    }
  });
});

describe("the status line", () => {
  it("reads Enriched for both enrichment states", () => {
    setup({ aiStatus: "re_enriched" });
    expect(screen.getByText("Enriched")).toBeInTheDocument();
  });

  it("reads Not enriched for an ordinary capture", () => {
    setup({ aiStatus: "not_started" });
    expect(screen.getByText("Not enriched")).toBeInTheDocument();
  });

  it("reads Needs a Claude session for a task", () => {
    // Same column as the line above, and a different honest reading of it: an
    // unenriched capture waits for nothing in particular, a task waits for a session.
    setup({ sourceType: "task", aiStatus: "not_started" });
    expect(screen.getByText("Needs a Claude session")).toBeInTheDocument();
    expect(screen.queryByText("Not enriched")).not.toBeInTheDocument();
  });
});

describe("the preview line", () => {
  it("shows the context by name, not by id", () => {
    setup({ suggestItem: true, suggestedContextId: "ctx-recipes" });
    expect(screen.getByText("Recipes")).toBeInTheDocument();
    expect(screen.queryByText("ctx-recipes")).not.toBeInTheDocument();
  });

  it("says what triage would create", () => {
    setup({ suggestItem: true, suggestIntent: true });
    expect(screen.getByText("New item")).toBeInTheDocument();
    expect(screen.getByText("New intention")).toBeInTheDocument();
  });

  it("shows only what is actually suggested", () => {
    setup({ suggestIntent: true });
    expect(screen.queryByText("New item")).not.toBeInTheDocument();
    expect(screen.getByText("New intention")).toBeInTheDocument();
  });

  it("shows a date, formatted from its parts so it cannot slip a day", () => {
    // `new Date("2026-10-01")` parses as UTC midnight and renders as Sep 30 in every
    // negative-offset zone.
    setup({ suggestIntent: true, suggestedEventDate: "2026-10-01" });
    expect(screen.getByText("Thu, Oct 1")).toBeInTheDocument();
  });

  it("ignores an unparseable date rather than rendering Invalid Date", () => {
    setup({ suggestIntent: true, suggestedEventDate: "next Tuesday" });
    expect(screen.queryByText(/Invalid/)).not.toBeInTheDocument();
  });

  it("shows the tags", () => {
    setup({ suggestItem: true, suggestedTags: ["mexican", "duck"] });
    expect(screen.getByText("mexican")).toBeInTheDocument();
    expect(screen.getByText("duck")).toBeInTheDocument();
  });

  it("is absent on an unenriched row, which has nothing to preview", () => {
    setup({ aiStatus: "not_started", suggestedContextId: "ctx-alfred", suggestedTags: ["ui"] });
    expect(screen.queryByText("Alfred")).not.toBeInTheDocument();
    expect(screen.queryByText("ui")).not.toBeInTheDocument();
  });

  it("is absent on an enriched row that suggests nothing to preview", () => {
    setup();
    expect(screen.queryByText("New item")).not.toBeInTheDocument();
  });
});

describe("the action button", () => {
  it("is Process for an enriched row suggesting an item", () => {
    setup({ suggestItem: true });
    expect(processBtn()).toBeInTheDocument();
    expect(copyBtn()).not.toBeInTheDocument();
  });

  it("is Process for an enriched row suggesting an intention", () => {
    setup({ suggestIntent: true });
    expect(processBtn()).toBeInTheDocument();
  });

  it("is absent when an enriched row suggests neither", () => {
    // Process files the suggestions; with no item and no intention it would archive the
    // row having created nothing.
    setup({ suggestedContextId: "ctx-alfred", suggestedTags: ["ui"] });
    expect(processBtn()).not.toBeInTheDocument();
    expect(copyBtn()).not.toBeInTheDocument();
  });

  it("is absent on an unenriched row, however it looks", () => {
    setup({ aiStatus: "not_started", suggestItem: true });
    expect(processBtn()).not.toBeInTheDocument();
  });

  it("is Copy for a task", () => {
    setup({ sourceType: "task", aiStatus: "not_started" });
    expect(copyBtn()).toBeInTheDocument();
    expect(processBtn()).not.toBeInTheDocument();
  });

  it("prefers Process over Copy if a task ever were enriched with suggestions", () => {
    // Cannot happen through create_inbox_item, which never marks a task enriched — but
    // if it did, filing it is the more useful of the two and only one button fits.
    setup({ sourceType: "task", aiStatus: "enriched", suggestItem: true });
    expect(processBtn()).toBeInTheDocument();
    expect(copyBtn()).not.toBeInTheDocument();
  });
});

describe("what the taps do", () => {
  it("opens the detail page when the card is tapped", () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByText("Retire the ai-enrich edge function"));
    expect(onOpen).toHaveBeenCalledWith("inbox-1");
  });

  it("processes without opening anything", () => {
    // Every control has to stop the click reaching the card, which is the link.
    const { onProcess, onOpen } = setup({ suggestItem: true });
    fireEvent.click(processBtn());
    expect(onProcess).toHaveBeenCalledWith("inbox-1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("copies without opening anything", () => {
    const { onCopy, onOpen } = setup({ sourceType: "task", aiStatus: "not_started" });
    fireEvent.click(copyBtn());
    expect(onCopy).toHaveBeenCalledWith("inbox-1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("discards without opening anything", () => {
    const { onDiscard, onOpen } = setup();
    fireEvent.click(trashBtn());
    expect(onDiscard).toHaveBeenCalledWith("inbox-1");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("the shared pieces are not rebuilt elsewhere", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const self = read("InboxListCard.jsx");
  // Every Alfred screen file. sam/ and games/ are separate surfaces with their own lists.
  const others = fs
    .readdirSync(__dirname)
    .filter((f) => /\.jsx$/.test(f) && !/\.test\.jsx$/.test(f) && f !== "InboxListCard.jsx")
    .map((f) => [f, read(f)]);

  it("has one call site", () => {
    expect(read("Alfred.jsx").split("<InboxListCard").length - 1).toBe(1);
  });

  it("owns the row shell", () => {
    // The WHOLE class list. The opening fragment is shared with the Schedule and item
    // cards on purpose — what must not be copied is this row's own shape.
    const shell = "gap-3 sm:gap-4 px-4 py-3.5 bg-card border border-border rounded-lg";
    expect(self).toContain(shell);
    for (const [f, src] of others) expect([f, src.includes(shell)]).toEqual([f, false]);
  });

  it("owns the chip", () => {
    const chip = "px-2 py-0.5 bg-secondary text-foreground text-xs";
    expect(self).toContain(chip);
    for (const [f, src] of others) expect([f, src.includes(chip)]).toEqual([f, false]);
  });

  it("owns the preview marks", () => {
    // The label plus its tone. A second screen writing either one has copied the line.
    for (const mark of ["New item", "New intention"]) {
      expect(self).toContain(mark);
      for (const [f, src] of others) expect([f, src.includes(mark)]).toEqual([f, false]);
    }
  });
});
