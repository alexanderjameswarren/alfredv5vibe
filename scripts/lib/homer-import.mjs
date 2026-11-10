// Homer import (homer-h4k phase C): turns the Kindle export and the s1 analysis into batches for
// public.homer_import_batch. Pure functions only; scripts/homer-import.mjs does the file reading and the HTTP.

export const MAX_BATCH_ROWS = 500;
export const MIN_SESSION_MS = 60_000;
export const SESSION_CAP_MS = 4 * 3600_000;
export const MIN_READ_MS = 30 * 60_000; // a (book, device) pair below this is noise unless it holds the finish
// A completed book is finished on every device with at least this share of the most-read device's hours, and this many.
export const FINISH_SHARE = 0.35;
export const FINISH_MIN_MS = 3600_000;
const NA = new Set(["", "Not Available", "Not Applicable"]);

export const READERS = [
  { key: "alex", name: "Alex" },
  { key: "elise", name: "Elise" },
  { key: "vasti", name: "Vasti" },
];

// Alex's labels (s3). Matched on the start of the device id.
export const DEVICE_OWNERS = [
  ["77750d31", "alex"], ["93aac836", "alex"], ["G6G3KM01", "alex"],
  ["33de64f8", "elise"], ["3e016c89", "elise"],
  ["ADCA140A", "vasti"],
];

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export const clean = (v) => (v == null || NA.has(String(v).trim()) ? null : String(v).trim());
export const normalizeDeviceId = (id) => String(id ?? "").replace(/"/g, "").trim();

export function ownerFor(deviceId, owners = DEVICE_OWNERS) {
  const hits = owners.filter(([prefix]) => deviceId.startsWith(prefix));
  return hits.length === 1 ? hits[0][1] : null;
}

// "Thousand Li, A B07VXJFRFV" -> { name: "A Thousand Li", series_asin: "B07VXJFRFV" }
export function splitSeriesTitle(raw) {
  const t = clean(raw);
  if (!t) return null;
  const m = t.match(/^(.*?)[\s ]+([A-Z0-9]{10})$/);
  let name = (m ? m[1] : t).trim();
  const art = name.match(/^(.*), (The|A|An)$/);
  if (art) name = `${art[2]} ${art[1]}`;
  return { name, series_asin: m ? m[2] : null };
}

// "Lin, Sarah" -> "Sarah Lin"; anything else unchanged. A trailing " B0..." is dropped.
export function flipAuthor(raw) {
  const a = clean(String(raw ?? "").split(" ")[0]);
  if (!a) return null;
  const m = a.match(/^([^,]+), ([^,]+)$/);
  return m ? `${m[2]} ${m[1]}` : a;
}

const authorKey = (a) => a.toLowerCase().replace(/\s+/g, "");

// Every "Author Name" row for an ASIN, in file order, flipped, de-duplicated (case and spaces ignored), joined ", ".
export function authorsByAsin(authorRows) {
  const lists = new Map();
  for (const row of authorRows) {
    const asin = clean(row.ASIN);
    const name = flipAuthor(row["Author Name"]);
    if (!asin || !name) continue;
    const list = lists.get(asin) ?? [];
    if (!list.some((n) => authorKey(n) === authorKey(name))) list.push(name);
    lists.set(asin, list);
  }
  return new Map([...lists].map(([asin, list]) => [asin, list.join(", ")]));
}

const ORIGIN_ORDER = [
  ["Purchase", "purchase"], ["KindleUnlimited", "kindle_unlimited"], ["Prime", "prime_reading"],
  ["Sample", "sample"], ["PublicLibraryLending", "library"],
];
export function acquisitionFor(origins) {
  if (!origins || origins.length === 0) return null;
  for (const [origin, bucket] of ORIGIN_ORDER) if (origins.includes(origin)) return bucket;
  return "other";
}

export function originsByAsin(ownershipItems) {
  const out = new Map();
  for (const o of ownershipItems) {
    const asin = o?.resource?.ASIN;
    if (!asin) continue;
    const list = out.get(asin) ?? [];
    for (const r of o.rights ?? []) if (r?.origin?.originType) list.push(r.origin.originType);
    out.set(asin, list);
  }
  return out;
}

const day = (ts) => (clean(ts) ? ts.slice(0, 10) : null);
const hours = (ms) => Math.round((ms / 3600_000) * 10) / 10;

// One entry per (asin, device): first and last qualifying day, capped ms, and raw ms for picking a finish device.
export function aggregateSessions(sessionRows) {
  const pairs = new Map();
  for (const r of sessionRows) {
    const asin = clean(r.ASIN);
    const device = normalizeDeviceId(r.device_serial_number);
    if (!asin || !device) continue;
    const key = `${asin}|${device}`;
    const p = pairs.get(key) ?? { asin, device, first: null, last: null, ms: 0, rawMs: 0, contentType: clean(r.content_type) };
    const ms = Number(clean(r.total_reading_millis) ?? NaN);
    const d = day(r.start_timestamp) ?? day(r.end_timestamp);
    if (Number.isFinite(ms) && d) {
      p.rawMs += ms;
      if (ms >= MIN_SESSION_MS) {
        p.ms += Math.min(ms, SESSION_CAP_MS);
        if (!p.first || d < p.first) p.first = d;
        if (!p.last || d > p.last) p.last = d;
      }
    }
    pairs.set(key, p);
  }
  return pairs;
}

// finishedRows: finished_books.csv. A completed book is finished on every device with hours >= FINISH_SHARE of its
// most-read device and >= FINISH_MIN_MS, dated that device's last read day. If no device qualifies, the old rule
// applies: the main device, or else the device with the most raw time, dated the completion date.
export function buildReads(pairs, finishedRows) {
  const byAsin = new Map();
  for (const p of pairs.values()) byAsin.set(p.asin, [...(byAsin.get(p.asin) ?? []), p]);
  // One completion per book: the latest row (a book finished twice keeps the later date and its flag).
  const done = new Map();
  for (const f of finishedRows) {
    const asin = clean(f.asin);
    if (!asin) continue;
    const prev = done.get(asin);
    if (!prev || f.completed_date > prev.completed_date) done.set(asin, f);
  }
  const finish = new Map();
  const unplaced = [];
  for (const [asin, f] of done) {
    const completion = String(f.flag || "").toLowerCase() || null;
    const devs = byAsin.get(asin) ?? [];
    const top = Math.max(0, ...devs.map((p) => p.ms));
    const qualified = devs.filter((p) => p.ms >= FINISH_MIN_MS && p.ms >= FINISH_SHARE * top);
    for (const p of qualified) finish.set(`${asin}|${p.device}`, { date: p.last, completion });
    if (qualified.length) continue;
    let device = clean(f.main_device_id);
    if (!device) {
      const cands = devs.filter((p) => p.rawMs > 0).sort((a, b) => b.rawMs - a.rawMs);
      device = cands[0]?.device ?? null;
    }
    if (!device) { unplaced.push(asin); continue; }
    finish.set(`${asin}|${normalizeDeviceId(device)}`, { date: f.completed_date, completion });
  }
  const reads = [];
  const lastOn = new Map();
  const seen = new Set();
  for (const p of pairs.values()) {
    const key = `${p.asin}|${p.device}`;
    const fin = finish.get(key);
    if (!fin && p.ms < MIN_READ_MS) continue;
    seen.add(key);
    let started = p.first;
    if (fin && (!started || started > fin.date)) started = fin.date;
    const import_key = `export:${p.asin}:${p.device}`;
    lastOn.set(import_key, p.last);
    reads.push({
      import_key,
      asin: p.asin,
      device_id: p.device,
      started_on: started,
      finished_on: fin?.date ?? null,
      hours: hours(p.ms),
      completion: fin?.completion ?? null,
    });
  }
  for (const key of finish.keys()) if (!seen.has(key)) unplaced.push(key.split("|")[0]);
  return { reads, unplaced, lastOn };
}

// Implied finishes (s10): per reader (or per device when it has no owner), in any series where they have reads on
// 2+ different books, every unfinished read becomes finished on that device's last read day, completion 'implied'.
// A lone book 1, books with no series, and existing finishes are left as they are. Returns the count implied.
export function applyImpliedFinishes(reads, bookBy, ownerOf, lastOn) {
  const groups = new Map();
  for (const r of reads) {
    const b = bookBy.get(r.asin);
    const sk = b && (b.series_asin ?? (b.series_name ? `name:${b.series_name.toLowerCase()}` : null));
    if (!sk) continue;
    const who = ownerOf.get(r.device_id) ?? `device:${r.device_id}`;
    const k = `${who}|${sk}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let implied = 0;
  for (const rs of groups.values()) {
    if (new Set(rs.map((r) => r.asin)).size < 2) continue;
    for (const r of rs) {
      const last = lastOn.get(r.import_key);
      if (r.finished_on || !last) continue;
      r.finished_on = last;
      if (!r.started_on || r.started_on > last) r.started_on = last;
      r.completion = "implied";
      implied++;
    }
  }
  return implied;
}

// dbOwners: Map(device_id -> reader key) read from homer_devices. A database owner wins and is not re-sent (the RPC
// keeps it, with its reason); otherwise the built-in label is sent. ownerOf holds the owner either way, for grouping.
export function buildDevices(deviceRows, owners = DEVICE_OWNERS, dbOwners = new Map()) {
  return deviceRows.map((d) => {
    const id = normalizeDeviceId(d.device_id);
    const fromDb = dbOwners.get(id) ?? null;
    const owner = fromDb ? null : ownerFor(id, owners);
    return {
      device_id: id,
      family: clean(d.device_family),
      friendly_name: clean(d.friendly_name),
      owner,
      owner_reason: owner ? "Labelled by Alex (homer-h4k s3)" : null,
      first_session: clean(d.first_session),
      last_session: clean(d.last_session),
      sessions: Number(clean(d.sessions_60s_plus) ?? 0),
      hours: Number(clean(d.reading_hours) ?? 0),
    };
  });
}

// inputs: { deviceRows, finishedRows, sessionRows, relIndexRows, authorRows, ownershipItems, dbOwners? }
export function buildPlan(inputs) {
  const dbOwners = inputs.dbOwners ?? new Map();
  const pairs = aggregateSessions(inputs.sessionRows);
  const { reads, unplaced, lastOn } = buildReads(pairs, inputs.finishedRows);
  const devices = buildDevices(inputs.deviceRows, DEVICE_OWNERS, dbOwners);
  const ownerOf = new Map(devices.map((d) => [d.device_id, dbOwners.get(d.device_id) ?? d.owner]).filter(([, o]) => o));
  const deviceIds = new Set(devices.map((d) => d.device_id));
  const keptReads = reads.filter((r) => deviceIds.has(r.device_id));

  const asins = new Set(keptReads.map((r) => r.asin));
  const titles = new Map();
  const put = (a, t) => { if (clean(a) && clean(t) && !titles.has(a)) titles.set(a, clean(t)); };
  for (const f of inputs.finishedRows) put(f.asin, f.title);
  for (const r of inputs.relIndexRows) put(r.ASIN, r["Product Name"]);
  for (const o of inputs.ownershipItems) put(o?.resource?.ASIN, o?.resource?.["Product Name"]);

  const authors = authorsByAsin(inputs.authorRows);

  const seriesOf = new Map();
  for (const r of inputs.relIndexRows) {
    const s = splitSeriesTitle(r["Series Title"]);
    if (!s || !clean(r.ASIN) || seriesOf.has(r.ASIN)) continue;
    const pos = clean(r["Position In Collection"]);
    seriesOf.set(r.ASIN, { ...s, author: flipAuthor(r["Series Author"]), position: pos && !Number.isNaN(Number(pos)) ? Number(pos) : null });
  }

  const contentType = new Map();
  for (const p of pairs.values()) if (!contentType.has(p.asin)) contentType.set(p.asin, p.contentType);
  const origins = originsByAsin(inputs.ownershipItems);

  const series = new Map();
  const books = [];
  for (const asin of [...asins].sort()) {
    const s = seriesOf.get(asin);
    if (s) {
      const k = s.series_asin ?? `name:${s.name.toLowerCase()}`;
      if (!series.has(k)) series.set(k, { name: s.name, series_asin: s.series_asin, author: s.author });
    }
    books.push({
      asin,
      title: titles.get(asin) ?? `Unknown title (${asin})`,
      author: authors.get(asin) ?? null,
      series_asin: s?.series_asin ?? null,
      series_name: s && !s.series_asin ? s.name : null,
      series_position: s?.position ?? null,
      acquired: acquisitionFor(origins.get(asin)),
      content_type: contentType.get(asin) ?? null,
    });
  }
  const implied = applyImpliedFinishes(keptReads, new Map(books.map((b) => [b.asin, b])), ownerOf, lastOn);
  return {
    readers: READERS,
    devices,
    series: [...series.values()],
    books,
    reads: keptReads,
    ownerOf,
    notes: {
      implied_finishes: implied,
      unplaced_finishes: unplaced,
      reads_on_unknown_devices: reads.length - keptReads.length,
      untitled_books: books.filter((b) => b.title.startsWith("Unknown title")).length,
    },
  };
}

const seriesKey = (s) => s.series_asin ?? `name:${s.name.toLowerCase()}`;

// Self-contained batches: each carries the readers, devices, series and books its reads need, so every batch
// dry-runs on its own. Shared rows repeat across batches and come back "unchanged" once applied.
export function packBatches(plan, max = MAX_BATCH_ROWS) {
  const bookBy = new Map(plan.books.map((b) => [b.asin, b]));
  const deviceBy = new Map(plan.devices.map((d) => [d.device_id, d]));
  const seriesBy = new Map(plan.series.map((s) => [seriesKey(s), s]));
  const fresh = () => ({ readers: [...plan.readers], devices: [], series: [], books: [], reads: [], _d: new Set(), _s: new Set(), _b: new Set() });
  const size = (b) => b.readers.length + b.devices.length + b.series.length + b.books.length + b.reads.length;
  const batches = [];
  let cur = fresh();
  // The first batch holds every device, so all owners are set before any read lands.
  for (const d of plan.devices) { cur.devices.push(d); cur._d.add(d.device_id); }
  const reads = [...plan.reads].sort((a, b) => a.asin.localeCompare(b.asin) || a.device_id.localeCompare(b.device_id));
  for (const r of reads) {
    const need = [];
    const book = bookBy.get(r.asin);
    const sk = book && (book.series_asin ?? (book.series_name ? `name:${book.series_name.toLowerCase()}` : null));
    if (!cur._d.has(r.device_id)) need.push(["devices", deviceBy.get(r.device_id), "_d", r.device_id]);
    if (sk && !cur._s.has(sk)) need.push(["series", seriesBy.get(sk), "_s", sk]);
    if (book && !cur._b.has(r.asin)) need.push(["books", book, "_b", r.asin]);
    if (size(cur) + need.length + 1 > max) {
      batches.push(cur);
      cur = fresh();
      need.length = 0;
      if (deviceBy.has(r.device_id)) need.push(["devices", deviceBy.get(r.device_id), "_d", r.device_id]);
      if (sk) need.push(["series", seriesBy.get(sk), "_s", sk]);
      if (book) need.push(["books", book, "_b", r.asin]);
    }
    for (const [kind, row, set, key] of need) if (row) { cur[kind].push(row); cur[set].add(key); }
    cur.reads.push(r);
  }
  if (size(cur) > plan.readers.length) batches.push(cur);
  return batches.map(({ _d, _s, _b, ...b }) => b);
}

export const batchRows = (b) => Object.values(b).reduce((n, list) => n + list.length, 0);
