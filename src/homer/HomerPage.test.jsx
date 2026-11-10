import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import HomerPage, { HISTORY_PAGE } from "./HomerPage";
import * as api from "./homerApi";

jest.mock("./homerApi", () => ({
  ...jest.requireActual("./homerApi"),
  getActivePlan: jest.fn(),
  getQueue: jest.fn(),
  getGenres: jest.fn(),
  getQuietSeries: jest.fn(),
  getReads: jest.fn(),
}));

const empty = () => {
  api.getActivePlan.mockResolvedValue(null);
  api.getQueue.mockResolvedValue([]);
  api.getGenres.mockResolvedValue([]);
  api.getQuietSeries.mockResolvedValue([]);
  api.getReads.mockResolvedValue([]);
};

const read = (i, seriesId = `s${i}`, asin = `B${i}`) => ({
  finished_on: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, started_on: "2025-12-01", completion: "automatic", hours: 2,
  homer_books: { asin, title: `TEST Book ${i}`, series_position: 1,
    homer_series: { id: seriesId, name: `TEST Series ${i}`, series_asin: `BS${i}` } },
});

test("reading history: collapsed cards, expand on tap, show more past 20", async () => {
  empty();
  api.getReads.mockResolvedValue(Array.from({ length: HISTORY_PAGE + 3 }, (_, i) => read(i)));
  render(<HomerPage />);
  // Newest first: series 22 has the latest date; 0, 1 and 2 are the oldest and start hidden.
  const header = await screen.findByText("TEST Series 22");
  expect(screen.queryByText("TEST Series 0")).not.toBeInTheDocument();
  expect(screen.queryByText("TEST Book 22")).not.toBeInTheDocument();
  fireEvent.click(header.closest("button"));
  expect(screen.getByText("TEST Book 22")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(HISTORY_PAGE - 1);
  fireEvent.click(screen.getByText(/Show more \(3 more\)/));
  expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(HISTORY_PAGE + 2);
});

test("authors: the union on the card header and quiet row; a book line only when its set differs", async () => {
  empty();
  api.getActivePlan.mockResolvedValue({ id: "p1", version: 1 });
  const series = { id: "s1", name: "TEST Saga", series_asin: "BS1", author: "Jane Doe" };
  const b = (asin, pos, author) => ({ finished_on: "2026-01-02", started_on: null, completion: "automatic", hours: 1,
    homer_books: { asin, title: `TEST ${asin}`, author, series_position: pos, homer_series: series } });
  api.getReads.mockResolvedValue([b("B1", 1, "Jane Doe, Guest Writer"), b("B2", 2, "Jane Doe")]);
  api.getQuietSeries.mockResolvedValue([{ series_id: "s1", series_name: "TEST Saga", verdict: "liked", is_quiet: true }]);
  render(<HomerPage />);
  await screen.findAllByText("TEST Saga");
  expect(screen.getAllByText("Jane Doe, Guest Writer")).toHaveLength(2); // quiet row and card header
  fireEvent.click(screen.getAllByText("TEST Saga")[1].closest("button"));
  expect(screen.getAllByText("Jane Doe, Guest Writer")).toHaveLength(2); // B1 matches the header: not repeated
  expect(screen.getByText("Jane Doe")).toBeInTheDocument(); // B2 differs: shown
});

test("a quiet series links to its series page", async () => {
  empty();
  api.getActivePlan.mockResolvedValue({ id: "p1", version: 1 });
  api.getReads.mockResolvedValue([read(1, "s1")]);
  api.getQuietSeries.mockResolvedValue([{ series_id: "s1", series_name: "TEST Series 1", verdict: "liked", is_quiet: true }]);
  render(<HomerPage />);
  await screen.findAllByText("TEST Series 1");
  const links = screen.getAllByText("Series").map((a) => a.getAttribute("href"));
  expect(links).toEqual(["https://www.amazon.com/dp/BS1", "https://www.amazon.com/dp/BS1"]);
});

test("no plan and an empty queue say so in plain words", async () => {
  empty();
  render(<HomerPage />);
  expect(await screen.findByText(/Homer's plan is set up during calibration/)).toBeInTheDocument();
  expect(screen.getByText(/Nothing in the queue yet/)).toBeInTheDocument();
  expect(screen.getByText(/Series appear here once Homer's plan exists/)).toBeInTheDocument();
});

test("queue items show KU, status, why and both Kindle links", async () => {
  empty();
  api.getActivePlan.mockResolvedValue({ id: "p1", version: 1 });
  api.getGenres.mockResolvedValue([{ id: "g1", name: "Urban magic", sort_order: 1 }]);
  api.getQueue.mockResolvedValue([{ id: "q1", genre_id: "g1", title: "TEST Book", author: "A. Writer", asin: "B0TEST0001",
    why: "Like Mob Sorcery", on_kindle_unlimited: true, status: "maybe_later", position: 1 }]);
  render(<HomerPage />);
  expect(await screen.findByText("TEST Book")).toBeInTheDocument();
  expect(screen.getByText("Urban magic")).toBeInTheDocument();
  expect(screen.getByText("Kindle Unlimited")).toBeInTheDocument();
  expect(screen.getByText("Maybe later")).toBeInTheDocument();
  expect(screen.getByText("Open in Kindle")).toHaveAttribute("href", "https://read.amazon.com/?asin=B0TEST0001");
  expect(screen.getByText("Amazon page")).toHaveAttribute("href", "https://www.amazon.com/dp/B0TEST0001");
  expect(screen.getByText("No series has gone quiet.")).toBeInTheDocument();
});

test("quiet series: behind, upcoming and pick it up again", async () => {
  empty();
  api.getActivePlan.mockResolvedValue({ id: "p1", version: 1 });
  api.getQuietSeries.mockResolvedValue([
    { series_id: "s1", series_name: "TEST Behind", verdict: "liked", is_quiet: true, last_finished_position: 3,
      last_finished_title: "Three", last_read_on: "2025-01-01", days_since: 400, books_behind: 2, is_caught_up: false },
    { series_id: "s2", series_name: "TEST Tired", verdict: "tired", is_quiet: true, tired_gap_passed: true,
      upcoming_position: 9, upcoming_release_date: "2026-12-30" },
    { series_id: "s3", series_name: "TEST Recent", verdict: "liked", is_quiet: false },
  ]);
  render(<HomerPage />);
  expect(await screen.findByText("TEST Behind")).toBeInTheDocument();
  expect(screen.getByText(/2 books behind/)).toBeInTheDocument();
  expect(screen.getByText("Pick it up again?")).toBeInTheDocument();
  expect(screen.getByText(/Book 9 coming Dec 30, 2026/)).toBeInTheDocument();
  expect(screen.queryByText("TEST Recent")).not.toBeInTheDocument();
});
