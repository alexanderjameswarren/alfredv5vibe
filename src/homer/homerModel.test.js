import { groupQueue, historyCards, kindleLinks, quietRows, quietView, seriesLink, unionAuthors, UNSORTED } from "./homerModel";

test("series link: dp page by series ASIN, else an encoded Kindle-store search", () => {
  expect(seriesLink("He Who Fights with Monsters", "B0GGDLNK6B")).toBe("https://www.amazon.com/dp/B0GGDLNK6B");
  expect(seriesLink("Cradle & Co: Book #1?", null))
    .toBe("https://www.amazon.com/s?k=Cradle%20%26%20Co%3A%20Book%20%231%3F&i=digital-text");
});

const S1 = { id: "s1", name: "TEST Saga", series_asin: "BTESTS0001" };
const S2 = { id: "s2", name: "TEST Other", series_asin: null };
const rd = (asin, pos, series, finished_on, started_on, completion = null, hours = 1) =>
  ({ finished_on, started_on, completion, hours, homer_books: { asin, title: `T ${asin}`, series_position: pos, homer_series: series } });

test("history: one card per series, newest first, standalone last", () => {
  const cards = historyCards([
    rd("A2", 2, S1, "2026-03-01", "2026-02-01"), rd("A1", "1.00", S1, "2026-01-10", "2026-01-01"),
    rd("B1", 1, S2, null, "2026-05-01"), rd("X1", null, null, "2026-09-01", "2026-08-01"),
  ]);
  expect(cards.map((c) => c.name)).toEqual(["TEST Other", "TEST Saga", "Standalone"]);
  expect(cards[1].books.map((b) => b.asin)).toEqual(["A1", "A2"]);
  expect(cards[1]).toMatchObject({ read: 2, finished: 2, latest: "2026-03-01", link: "https://www.amazon.com/dp/BTESTS0001" });
  expect(cards[0]).toMatchObject({ read: 1, finished: 0, link: "https://www.amazon.com/s?k=TEST%20Other&i=digital-text" });
  expect(cards[2].link).toBeNull();
});

const authored = (asin, pos, series, author) => ({ finished_on: "2026-01-01", started_on: null, completion: null, hours: 1,
  homer_books: { asin, title: asin, author, series_position: pos, homer_series: series } });

test("history: header is the author union, series author first, then by first appearance", () => {
  const SA = { id: "sa", name: "TEST Authored", series_asin: "BTESTS0009", author: "Jane Doe" };
  const [card] = historyCards([
    authored("A3", 3, SA, "Jane Doe, Second Writer"), authored("A2", 2, SA, "First Guest, jane  doe"),
    authored("A1", 1, SA, "Jane Doe"),
  ]);
  expect(card.author).toBe("Jane Doe, First Guest, Second Writer");
  expect(unionAuthors(["A, B", "b", " C ,a"])).toEqual(["A", "B", "C"]);
});

test("history: a book line shows its authors only when its set differs; always on Standalone", () => {
  const SA = { id: "sa", name: "TEST Duo", series_asin: "BTESTS0010", author: "Victor Molotov" };
  const [card, solo] = historyCards([
    authored("A1", 1, SA, "Victor Molotov, Igor Almazov"), authored("A2", 2, SA, "igor almazov,victor molotov"),
    authored("A3", 3, SA, "Victor Molotov"), authored("X1", null, null, "Solo Author"),
  ]);
  expect(card.author).toBe("Victor Molotov, Igor Almazov");
  const own = (asin) => card.books.find((b) => b.asin === asin).ownAuthor;
  expect(own("A1")).toBeNull();
  expect(own("A2")).toBeNull();
  expect(own("A3")).toBe("Victor Molotov");
  expect(solo).toMatchObject({ standalone: true, author: null });
  expect(solo.books[0].ownAuthor).toBe("Solo Author");
});

test("history: a single-author series is unchanged", () => {
  const SA = { id: "sa", name: "TEST Solo", series_asin: null, author: "Sarah Lin" };
  const [card] = historyCards([authored("A1", 1, SA, "Sarah Lin"), authored("A2", 2, SA, "sarah lin")]);
  expect(card.author).toBe("Sarah Lin");
  expect(card.books.every((b) => b.ownAuthor === null)).toBe(true);
});

test("history: a book on two devices shows once, latest date, most finished status, hours summed", () => {
  const [card] = historyCards([
    rd("A1", 1, S1, "2026-01-05", "2026-01-01", "implied", 2),
    rd("A1", 1, S1, null, "2026-02-01", null, 1.5),
    rd("A2", 2, S1, "2026-03-01", "2026-02-20", "implied"),
    rd("A2", 2, S1, "2026-02-25", "2026-02-20", "automatic"),
  ]);
  expect(card.books).toHaveLength(2);
  expect(card.books[0]).toMatchObject({ status: "implied", date: "2026-02-01", hours: 3.5 });
  expect(card.books[1]).toMatchObject({ status: "finished", date: "2026-03-01" });
});

test("kindle links from the ASIN", () => {
  expect(kindleLinks("B0ABC12345")).toEqual([
    { label: "Open in Kindle", href: "https://read.amazon.com/?asin=B0ABC12345" },
    { label: "Amazon page", href: "https://www.amazon.com/dp/B0ABC12345" },
  ]);
  expect(kindleLinks(null)).toEqual([]);
});

test("queue grouped by genre sort order, by position, unsorted last, empty genres hidden", () => {
  const genres = [{ id: "g2", name: "Cozy", sort_order: 1 }, { id: "g1", name: "Progression", sort_order: 2 },
    { id: "g3", name: "Empty", sort_order: 3 }];
  const items = [
    { id: "a", genre_id: "g1", position: 2 }, { id: "b", genre_id: "g1", position: "1.5" },
    { id: "c", genre_id: null, position: 1 }, { id: "d", genre_id: "gone", position: 0 }, { id: "e", genre_id: "g2", position: 9 },
  ];
  const out = groupQueue(items, genres);
  expect(out.map((g) => g.name)).toEqual(["Cozy", "Progression", UNSORTED]);
  expect(out[1].items.map((i) => i.id)).toEqual(["b", "a"]);
  expect(out[2].items.map((i) => i.id)).toEqual(["d", "c"]);
});

test("quiet list: quiet liked/loved, tired only past the gap", () => {
  const rows = [
    { series_id: 1, verdict: "liked", is_quiet: true },
    { series_id: 2, verdict: "loved", is_quiet: false },
    { series_id: 3, verdict: "tired", is_quiet: true, tired_gap_passed: false },
    { series_id: 4, verdict: "tired", is_quiet: true, tired_gap_passed: true },
  ];
  expect(quietRows(rows).map((r) => r.series_id)).toEqual([1, 4]);
});

test("quiet view: behind only from books_behind, upcoming never as available", () => {
  const v = quietView({ series_name: "Solo", verdict: "liked", last_finished_position: "7.00", last_finished_title: "Solo 7",
    last_read_on: "2025-06-01", days_since: 162, books_behind: "0", is_caught_up: true,
    upcoming_position: "8.00", upcoming_release_date: "2026-12-30", next_position: null });
  expect(v.lastBook).toBe("Book 7: Solo 7");
  expect(v.behind).toBeNull();
  expect(v.caughtUp).toBe(true);
  expect(v.upcoming).toMatch(/^Book 8 coming Dec 30, 2026$/);
  expect(quietView({ books_behind: 1 }).behind).toBe("1 book behind");
  expect(quietView({ books_behind: "3.00" }).behind).toBe("3 books behind");
  expect(quietView({ books_behind: null, next_position: 4 }).behind).toBeNull();
  expect(quietView({ verdict: "tired", tired_gap_passed: true }).pickUp).toBe(true);
});
