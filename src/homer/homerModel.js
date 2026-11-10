// Pure shaping for the Homer tab. No React, no Supabase.

export const UNSORTED = "Not sorted yet";

const STATUS = { queued: "Queued", maybe_later: "Maybe later", reading: "Reading", read: "Read", never: "Never" };
const VERDICT = { loved: "Loved", liked: "Liked", tired: "Tired" };

export const statusLabel = (s) => STATUS[s] || s || "";
export const verdictLabel = (v) => VERDICT[v] || v || "";

/** Both Kindle links, built from the ASIN and never stored. */
export function kindleLinks(asin) {
  if (!asin) return [];
  const a = encodeURIComponent(asin);
  return [
    { label: "Open in Kindle", href: `https://read.amazon.com/?asin=${a}` },
    { label: "Amazon page", href: `https://www.amazon.com/dp/${a}` },
  ];
}

/** Queue items grouped by genre in sort order; items with no (live) genre go last under "Not sorted yet". */
export function groupQueue(items, genres) {
  const known = new Set(genres.map((g) => g.id));
  const groups = genres.map((g) => ({ id: g.id, name: g.name, items: [] }));
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const unsorted = { id: "unsorted", name: UNSORTED, items: [] };
  const byPos = [...items].sort((a, b) => Number(a.position) - Number(b.position));
  for (const it of byPos) (known.has(it.genre_id) ? byId[it.genre_id] : unsorted).items.push(it);
  return [...groups, unsorted].filter((g) => g.items.length);
}

/** A series page: its dp page when the series has an ASIN, else a Kindle-store search for its name. */
export function seriesLink(name, seriesAsin) {
  if (seriesAsin) return `https://www.amazon.com/dp/${encodeURIComponent(seriesAsin)}`;
  return `https://www.amazon.com/s?k=${encodeURIComponent(name || "")}&i=digital-text`;
}

// Status of one book for the reader: the most finished of its reads. Amazon's finish beats implied beats started.
const RANK = { finished: 3, implied: 2, started: 1 };
const readStatus = (r) => (!r.finished_on ? "started" : r.completion === "implied" ? "implied" : "finished");
export const STATUS_LABEL = { finished: "finished", implied: "finished (implied)", started: "started" };
const readDate = (r) => r.finished_on || r.started_on || null;
const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
// Authors are stored comma-separated ("Victor Molotov, Igor Almazov"); compared ignoring case and spaces.
const authorKey = (a) => a.toLowerCase().replace(/\s+/g, "");
export const splitAuthors = (s) => String(s || "").split(",").map((a) => a.trim()).filter(Boolean);
const authorSet = (s) => new Set(splitAuthors(s).map(authorKey));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Every author across the strings, first appearance wins, de-duplicated ignoring case and spaces. */
export function unionAuthors(strings) {
  const out = [];
  const seen = new Set();
  for (const name of strings.flatMap(splitAuthors)) {
    if (seen.has(authorKey(name))) continue;
    seen.add(authorKey(name));
    out.push(name);
  }
  return out;
}

/**
 * Reading history: one card per series (Standalone last), newest latest-read first. A book read on several
 * devices shows once, with its latest date, its most finished status and the hours summed.
 */
export function historyCards(reads) {
  const books = new Map();
  for (const r of reads) {
    const b = r.homer_books;
    if (!b?.asin) continue;
    const s = readStatus(r);
    const cur = books.get(b.asin);
    if (!cur) {
      books.set(b.asin, { asin: b.asin, title: b.title, author: b.author || null, position: num(b.series_position),
        series: b.homer_series || null, status: s, date: readDate(r), hours: num(r.hours) || 0 });
      continue;
    }
    if (RANK[s] > RANK[cur.status]) cur.status = s;
    cur.date = later(cur.date, readDate(r));
    cur.hours += num(r.hours) || 0;
  }
  const cards = new Map();
  for (const b of books.values()) {
    const key = b.series?.id || "standalone";
    const c = cards.get(key) || { id: key, name: b.series?.name || "Standalone", seriesAsin: b.series?.series_asin || null,
      seriesAuthor: b.series?.author || null, standalone: !b.series, books: [], latest: null };
    c.books.push({ ...b, hours: Math.round(b.hours * 10) / 10 });
    c.latest = later(c.latest, b.date);
    cards.set(key, c);
  }
  const byPos = (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || String(a.title).localeCompare(String(b.title));
  const out = [...cards.values()].map((c) => {
    const books = c.books.sort(byPos);
    // Header: the series author first, then every other book author in order of first appearance (series order).
    const header = c.standalone ? [] : unionAuthors([c.seriesAuthor, ...books.map((b) => b.author)]);
    const headerSet = authorSet(header.join(", "));
    return {
      ...c,
      author: header.length ? header.join(", ") : null,
      // A book line names its authors only when its set differs from the header's; always on Standalone.
      books: books.map((b) => ({
        ...b,
        ownAuthor: b.author && (c.standalone || !sameSet(authorSet(b.author), headerSet)) ? b.author : null,
      })),
      read: books.length,
      finished: books.filter((b) => b.status !== "started").length,
      link: c.standalone ? null : seriesLink(c.name, c.seriesAsin),
    };
  });
  return out.sort((a, b) => (a.standalone - b.standalone) || String(b.latest || "").localeCompare(String(a.latest || "")));
}

/** "12" or "2.5": positions are numeric(6,2) and arrive as numbers or strings. */
export const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const pos = (v) => String(num(v));

export function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Which series the "gone quiet" list shows: a liked or loved series past quiet_after_days, and a tired series
 * only once its tired gap has passed (then as "Pick it up again?").
 */
export function quietRows(rows) {
  return rows.filter((r) => (r.verdict === "tired" ? r.tired_gap_passed === true : r.is_quiet === true));
}

/** The lines one quiet row shows. Behind counts come only from books_behind; upcoming books are never "to read". */
export function quietView(r) {
  const behind = num(r.books_behind);
  const last = r.last_finished_position !== null && r.last_finished_position !== undefined
    ? `Book ${pos(r.last_finished_position)}${r.last_finished_title ? `: ${r.last_finished_title}` : ""}`
    : r.last_finished_title || null;
  return {
    title: r.series_name,
    verdict: verdictLabel(r.verdict),
    lastBook: last,
    lastRead: r.last_read_on ? `last read ${shortDate(r.last_read_on)}` : null,
    daysSince: r.days_since === null || r.days_since === undefined ? null : `${r.days_since} days ago`,
    behind: behind && behind > 0 ? `${pos(behind)} book${behind === 1 ? "" : "s"} behind` : null,
    caughtUp: r.is_caught_up === true,
    pickUp: r.verdict === "tired" && r.tired_gap_passed === true,
    upcoming: num(r.upcoming_position)
      ? `Book ${pos(r.upcoming_position)} coming${r.upcoming_release_date ? ` ${shortDate(r.upcoming_release_date)}` : ""}`
      : null,
  };
}
