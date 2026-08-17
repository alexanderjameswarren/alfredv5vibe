// The created-at caption must appear on EVERY tab, not just All songs.
//
// It previously lived only on the grouped All-songs row, right-aligned and
// `hidden sm:inline` — so three of four tabs never showed it and the fourth
// hid it below the `sm` breakpoint. These tests pin the fix in place: the
// caption is part of the one shared metadata line, so a future edit that
// re-splits the two row components fails here rather than in the UI.

import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
// Imported here rather than via a global setupTests.js — this is the only
// suite in the project that needs the DOM matchers.
import "@testing-library/jest-dom";
import BrowseTabs from "./BrowseTabs";
import { SORT_VALUES } from "../lib/samSort";

const song = (over = {}) => ({
  id: "s1",
  title: "Someone Like You",
  song_type: "original",
  parent_song_id: null,
  difficulty_tier: null,
  created_at: "2019-03-03T22:14:00Z", // 2:14 PM PST on Mar 3
  archived: false,
  lastPracticedAt: null,
  totalSeconds: 0,
  familyRootId: null,
  familyRootTitle: null,
  ...over,
});

const ROOT = song();
const DRILL = song({ id: "s2", title: "Arpeggios", song_type: "drill", created_at: "2019-03-03T22:41:00Z" });
const NEWBIE = song({ id: "s3", title: "The Scientist", created_at: "2019-04-01T17:00:00Z" });

const PLAYED = song({
  id: "s4",
  title: "Say It Ain't So",
  lastPracticedAt: "2019-03-10T18:00:00Z",
  totalSeconds: 2700,
  created_at: "2019-03-03T22:14:00Z",
});

function renderTabs(over = {}) {
  return render(
    <BrowseTabs
      families={[{ root: ROOT, simplified: [], drills: [DRILL] }]}
      familiesByRootId={new Map()}
      allSongsFlat={[ROOT, DRILL]}
      newSongsFlat={[NEWBIE]}
      drillsFlat={[DRILL]}
      archivedFamilies={[]}
      archivedCount={0}
      loading={false}
      onLoad={() => {}}
      onEdit={() => {}}
      onArchive={() => {}}
      onRestore={() => {}}
      onAddClick={() => {}}
      {...over}
    />
  );
}

const rowFor = (title) => screen.getByText(title).closest("div.bg-card");

// Row titles in the order they appear, for the tab currently shown.
const visibleTitles = () =>
  Array.from(document.querySelectorAll("div.bg-card .font-medium")).map((n) =>
    n.textContent.trim()
  );

const setSort = (label) =>
  fireEvent.change(screen.getByLabelText(/sort by/i), {
    target: { value: label },
  });

// The direction button labels itself with the action AND the current state,
// so this doubles as the assertion that the label stays accurate.
const dirButton = () =>
  screen.getByRole("button", { name: /^Sort (a|de)scending — currently/ });
const flipDir = () => fireEvent.click(dirButton());
const currentDir = () =>
  /currently ascending/.test(dirButton().getAttribute("aria-label")) ? "asc" : "desc";

describe("BrowseTabs — created-at caption", () => {
  test.each([
    ["Recent", "Someone Like You"],
    ["New", "The Scientist"],
    ["All songs", "Someone Like You"],
    ["Drills", "Arpeggios"],
  ])("%s tab shows when the song was added", (tabName, title) => {
    renderTabs();
    fireEvent.click(screen.getByRole("button", { name: tabName }));
    expect(
      within(rowFor(title)).getByText(/· added \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/)
    ).toBeInTheDocument();
  });

  test("the caption carries a clock time so same-day rows are distinguishable", () => {
    renderTabs();
    // Recent lists both; they were created 27 minutes apart on the same date.
    expect(within(rowFor("Someone Like You")).getByText(/added Mar 3, 2019, 2:14 PM/)).toBeInTheDocument();
    expect(within(rowFor("Arpeggios")).getByText(/added Mar 3, 2019, 2:41 PM/)).toBeInTheDocument();
  });

  test("an unplayed song reads 'never played' and still shows when it was added", () => {
    renderTabs();
    expect(
      within(rowFor("Someone Like You")).getByText(
        "never played · added Mar 3, 2019, 2:14 PM"
      )
    ).toBeInTheDocument();
  });

  test("a played song keeps last-practiced and duration, with created appended", () => {
    renderTabs({ allSongsFlat: [PLAYED] });
    expect(
      within(rowFor("Say It Ain't So")).getByText(
        "Mar 10, 2019 · 45 min · added Mar 3, 2019, 2:14 PM"
      )
    ).toBeInTheDocument();
  });

  test("a missing created_at omits the caption rather than rendering 'added null'", () => {
    renderTabs({ allSongsFlat: [song({ id: "s9", title: "No Date", created_at: null })] });
    const row = rowFor("No Date");
    expect(within(row).getByText("never played")).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/added/);
  });

  test("the caption is not hidden behind a responsive breakpoint", () => {
    // The old All-songs caption used `hidden sm:inline`, which is why it never
    // appeared on a phone. The shared line must carry no such class.
    renderTabs();
    fireEvent.click(screen.getByRole("button", { name: "All songs" }));
    const caption = within(rowFor("Someone Like You")).getByText(/· added /);
    expect(caption.className).not.toMatch(/hidden/);
  });
});

// --- sorting ---------------------------------------------------------------

// Three songs chosen so that all THREE orderings are different from each
// other. If any two coincided, a comparator that confused them would still
// pass. The pairwise-distinct test below guards that property of the data.
//
//   title   Apple, Mango, Zebra
//   added   Zebra, Apple, Mango   (newest first)
//   played  Mango, Zebra, Apple   (most recent first)
const APPLE = song({
  id: "a", title: "Apple",
  created_at: "2019-05-01T17:00:00Z",
  lastPracticedAt: "2019-07-01T17:00:00Z",
});
const MANGO = song({
  id: "m", title: "Mango",
  created_at: "2019-01-01T17:00:00Z",
  lastPracticedAt: "2019-09-01T17:00:00Z",
});
const ZEBRA = song({
  id: "z", title: "Zebra",
  created_at: "2019-08-01T17:00:00Z",
  lastPracticedAt: "2019-08-01T17:00:00Z",
});
const TRIO = [APPLE, MANGO, ZEBRA];

describe("BrowseTabs — sorting", () => {
  test("the control offers exactly the three promised orders", () => {
    renderTabs();
    const labels = Array.from(
      screen.getByLabelText(/sort by/i).querySelectorAll("option")
    ).map((o) => o.textContent);
    expect(labels).toEqual(["Last played", "Title", "Date added"]);
  });

  test("the default leaves the list in its previous last-played order", () => {
    renderTabs({ allSongsFlat: TRIO });
    expect(visibleTitles()).toEqual(["Mango", "Zebra", "Apple"]);
  });

  test.each([
    ["title", ["Apple", "Mango", "Zebra"]],
    ["added", ["Zebra", "Apple", "Mango"]],
    ["played", ["Mango", "Zebra", "Apple"]],
  ])("sorting by %s reorders the rows", (key, expected) => {
    renderTabs({ allSongsFlat: TRIO });
    setSort(key);
    expect(visibleTitles()).toEqual(expected);
  });

  test("the three orders are pairwise distinct on this data", () => {
    // Guards the fixture, not the code: if two orders ever coincide, the
    // cases above stop distinguishing the comparators they name.
    renderTabs({ allSongsFlat: TRIO });
    const seen = SORT_VALUES.map((key) => {
      setSort(key);
      return visibleTitles().join("|");
    });
    expect(new Set(seen).size).toBe(3);
  });

  test("the selection carries across tabs", () => {
    renderTabs({ allSongsFlat: TRIO, drillsFlat: TRIO });
    setSort("title");
    fireEvent.click(screen.getByRole("button", { name: "Drills" }));
    expect(screen.getByLabelText(/sort by/i)).toHaveValue("title");
    expect(visibleTitles()).toEqual(["Apple", "Mango", "Zebra"]);
  });

  test("All songs sorts FAMILIES and leaves members in their given order", () => {
    const root = song({ id: "r", title: "Root song" });
    const other = song({ id: "o", title: "Aardvark" });
    renderTabs({
      families: [
        {
          root,
          simplified: [
            song({ id: "v1", title: "Variant B" }),
            song({ id: "v2", title: "Variant A" }),
          ],
          drills: [],
          lastPracticedAt: null,
        },
        { root: other, simplified: [], drills: [], lastPracticedAt: null },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "All songs" }));
    setSort("title");
    // Families reordered by root title; the two variants keep tier order,
    // which is NOT alphabetical — that is the point.
    expect(visibleTitles()).toEqual([
      "Aardvark", "Root song", "Variant B", "Variant A",
    ]);
  });

  test("never-played songs sort last, not first", () => {
    renderTabs({
      allSongsFlat: [
        song({ id: "n", title: "Never played", lastPracticedAt: null }),
        song({ id: "p", title: "Played once", lastPracticedAt: "2019-01-01T17:00:00Z" }),
      ],
    });
    expect(visibleTitles()).toEqual(["Played once", "Never played"]);
  });

  test("sorting leaves the created-at caption intact", () => {
    renderTabs({ allSongsFlat: TRIO });
    setSort("added");
    expect(
      within(rowFor("Apple")).getByText(/· added May 1, 2019, 10:00 AM$/)
    ).toBeInTheDocument();
  });
});

describe("BrowseTabs — sort direction", () => {
  test("the arrow is a real button, not decoration", () => {
    renderTabs({ allSongsFlat: TRIO });
    expect(dirButton().tagName).toBe("BUTTON");
    expect(dirButton()).toHaveAttribute("type", "button");
  });

  test("clicking it reverses the list", () => {
    renderTabs({ allSongsFlat: TRIO });
    expect(visibleTitles()).toEqual(["Mango", "Zebra", "Apple"]);
    flipDir();
    expect(visibleTitles()).toEqual(["Apple", "Zebra", "Mango"]);
  });

  test("clicking twice returns to where it started", () => {
    renderTabs({ allSongsFlat: TRIO });
    const start = visibleTitles();
    flipDir();
    flipDir();
    expect(visibleTitles()).toEqual(start);
  });

  test("it starts descending for dates and ascending for title", () => {
    renderTabs({ allSongsFlat: TRIO });
    expect(currentDir()).toBe("desc");
    setSort("title");
    expect(currentDir()).toBe("asc");
    expect(visibleTitles()).toEqual(["Apple", "Mango", "Zebra"]);
    flipDir();
    expect(visibleTitles()).toEqual(["Zebra", "Mango", "Apple"]);
  });

  test("choosing a new field resets direction to that field's natural one", () => {
    renderTabs({ allSongsFlat: TRIO });
    setSort("title");
    flipDir(); // title, Z→A
    expect(currentDir()).toBe("desc");
    setSort("played");
    // Not carried over: last played opens most-recent-first, as it should.
    expect(currentDir()).toBe("desc");
    expect(visibleTitles()).toEqual(["Mango", "Zebra", "Apple"]);

    setSort("title");
    expect(currentDir()).toBe("asc");
  });

  test("the label names the action and the current state", () => {
    renderTabs({ allSongsFlat: TRIO });
    expect(dirButton()).toHaveAttribute(
      "aria-label",
      "Sort ascending — currently descending"
    );
    flipDir();
    expect(dirButton()).toHaveAttribute(
      "aria-label",
      "Sort descending — currently ascending"
    );
  });

  test("never-played songs stay last when the direction is flipped", () => {
    renderTabs({
      allSongsFlat: [
        song({ id: "n", title: "Never played", lastPracticedAt: null }),
        song({ id: "b", title: "Bravo", lastPracticedAt: "2019-02-01T17:00:00Z" }),
        song({ id: "a", title: "Alpha", lastPracticedAt: "2019-01-01T17:00:00Z" }),
      ],
    });
    expect(visibleTitles()).toEqual(["Bravo", "Alpha", "Never played"]);
    flipDir();
    expect(visibleTitles()).toEqual(["Alpha", "Bravo", "Never played"]);
  });

  test("the direction applies on the All songs tab too", () => {
    renderTabs({
      families: [
        { root: song({ id: "b", title: "Beta" }), simplified: [], drills: [], lastPracticedAt: null },
        { root: song({ id: "a", title: "Alpha" }), simplified: [], drills: [], lastPracticedAt: null },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "All songs" }));
    setSort("title");
    expect(visibleTitles()).toEqual(["Alpha", "Beta"]);
    flipDir();
    expect(visibleTitles()).toEqual(["Beta", "Alpha"]);
  });

  test("the direction carries across tabs", () => {
    renderTabs({ allSongsFlat: TRIO, drillsFlat: TRIO });
    flipDir();
    fireEvent.click(screen.getByRole("button", { name: "Drills" }));
    expect(currentDir()).toBe("asc");
    expect(visibleTitles()).toEqual(["Apple", "Zebra", "Mango"]);
  });
});
