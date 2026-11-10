import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv, normalizeDeviceId, ownerFor, splitSeriesTitle, flipAuthor, acquisitionFor, originsByAsin,
  aggregateSessions, buildReads, buildDevices, buildPlan, packBatches, batchRows, MAX_BATCH_ROWS,
} from "./homer-import.mjs";

test("parseCsv handles quotes, commas, BOM and CRLF", () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n3,\r\n');
  assert.deepEqual(rows, [{ a: "x, y", b: 'say "hi"' }, { a: "3", b: "" }]);
});

test("device ids lose stray quotes", () => {
  assert.equal(normalizeDeviceId('"d56241cd9'), "d56241cd9");
});

test("owners by prefix; others unknown", () => {
  assert.equal(ownerFor("77750d319d75430a858bb048ef0286e2"), "alex");
  assert.equal(ownerFor("3e016c898cfb45fcaf56f9b6b49fa9cf"), "elise");
  assert.equal(ownerFor("ADCA140AE0000000000000000000000"), "vasti");
  assert.equal(ownerFor("G6G3KM0150000000"), "alex");
  assert.equal(ownerFor("ecc0585f659240f1b2535009546fd963"), null);
});

test("series title split and article moved", () => {
  assert.deepEqual(splitSeriesTitle("Thousand Li, A B07VXJFRFV"), { name: "A Thousand Li", series_asin: "B07VXJFRFV" });
  assert.deepEqual(splitSeriesTitle("Street Cultivation B086YRRJ97"), { name: "Street Cultivation", series_asin: "B086YRRJ97" });
  assert.deepEqual(splitSeriesTitle("No Asin Here"), { name: "No Asin Here", series_asin: null });
  assert.equal(splitSeriesTitle("Not Available"), null);
});

test("authors flipped", () => {
  assert.equal(flipAuthor("Lin, Sarah"), "Sarah Lin");
  assert.equal(flipAuthor("Wong, Tao B07VXJFRFV"), "Tao Wong");
  assert.equal(flipAuthor("SeanS3r3s"), "SeanS3r3s");
  assert.equal(flipAuthor("Not Available"), null);
});

test("acquisition priority", () => {
  assert.equal(acquisitionFor(["KindleUnlimited", "Purchase"]), "purchase");
  assert.equal(acquisitionFor(["Sample", "KindleUnlimited"]), "kindle_unlimited");
  assert.equal(acquisitionFor(["Prime"]), "prime_reading");
  assert.equal(acquisitionFor(["Sample"]), "sample");
  assert.equal(acquisitionFor(["PublicLibraryLending"]), "library");
  assert.equal(acquisitionFor(["Comixology"]), "other");
  assert.equal(acquisitionFor([]), null);
  const m = originsByAsin([{ resource: { ASIN: "B1" }, rights: [{ origin: { originType: "Sample" } }] },
    { resource: { ASIN: "B1" }, rights: [{ origin: { originType: "Purchase" } }] }]);
  assert.deepEqual(m.get("B1"), ["Sample", "Purchase"]);
});

const s = (asin, device, start, ms, ct = "E-Book") =>
  ({ ASIN: asin, device_serial_number: device, start_timestamp: start, end_timestamp: start, total_reading_millis: String(ms), content_type: ct });

test("sessions: 60 s floor, 4 h cap, first and last day", () => {
  const p = aggregateSessions([
    s("B1", '"D1', "2026-01-02T10:00:00Z", 30_000),
    s("B1", "D1", "2026-01-03T10:00:00Z", 5 * 3600_000),
    s("B1", "D1", "2026-01-05T10:00:00Z", 120_000),
    s("B1", "D1", "Not Available", ""),
  ]).get("B1|D1");
  assert.equal(p.first, "2026-01-03");
  assert.equal(p.last, "2026-01-05");
  assert.equal(p.ms, 4 * 3600_000 + 120_000);
  assert.equal(p.rawMs, 30_000 + 5 * 3600_000 + 120_000);
});

test("reads: key, finish placement, 30 min floor, start never after finish", () => {
  const pairs = aggregateSessions([
    s("B1", "D1", "2026-01-10T00:00:00Z", 3600_000),
    s("B1", "D2", "2026-01-11T00:00:00Z", 10 * 60_000),
    s("B2", "D2", "2026-02-01T00:00:00Z", 40_000),
  ]);
  const { reads, unplaced } = buildReads(pairs, [
    { asin: "B1", completed_date: "2026-01-05", flag: "AUTOMATIC", main_device_id: "D1" },
    { asin: "B2", completed_date: "2026-02-02", flag: "MANUAL", main_device_id: "" },
    { asin: "B9", completed_date: "2026-02-02", flag: "MANUAL", main_device_id: "" },
  ]);
  const by = Object.fromEntries(reads.map((r) => [r.import_key, r]));
  assert.deepEqual(Object.keys(by).sort(), ["export:B1:D1", "export:B2:D2"]);
  assert.equal(by["export:B1:D1"].started_on, "2026-01-05");
  assert.equal(by["export:B1:D1"].completion, "automatic");
  assert.equal(by["export:B2:D2"].finished_on, "2026-02-02");
  assert.equal(by["export:B2:D2"].hours, 0);
  assert.deepEqual(unplaced, ["B9"]);
});

test("devices carry owner and reason only when labelled", () => {
  const [a, b] = buildDevices([
    { device_id: "93aac836abc", device_family: "Kindle app", friendly_name: "", first_session: "2026-02-10",
      last_session: "2026-10-28", sessions_60s_plus: "10", reading_hours: "1.5" },
    { device_id: "ffff", device_family: "", friendly_name: "", first_session: "", last_session: "", sessions_60s_plus: "0", reading_hours: "0" },
  ]);
  assert.equal(a.owner, "alex");
  assert.ok(a.owner_reason);
  assert.equal(b.owner, null);
  assert.equal(b.owner_reason, null);
  assert.equal(b.family, null);
});

function fixturePlan(nBooks) {
  const sessionRows = [];
  const relIndexRows = [];
  for (let i = 0; i < nBooks; i++) {
    const asin = `B${String(i).padStart(9, "0")}`;
    sessionRows.push(s(asin, i % 2 ? "D1" : "D2", "2026-01-01T00:00:00Z", 3600_000));
    relIndexRows.push({ ASIN: asin, "Product Name": `Book ${i}`, "Series Title": `Series ${i % 7} S00000000${i % 7}`,
      "Series Author": "Doe, Jane", "Position In Collection": String(i) });
  }
  return buildPlan({
    deviceRows: [{ device_id: "D1" }, { device_id: "D2" }, { device_id: "77750d31x" }],
    finishedRows: [], sessionRows, relIndexRows, authorRows: [{ ASIN: "B000000000", "Author Name": "Doe, Jane" }],
    ownershipItems: [{ resource: { ASIN: "B000000000" }, rights: [{ origin: { originType: "KindleUnlimited" } }] }],
  });
}

test("plan maps books, series and acquisition", () => {
  const plan = fixturePlan(10);
  assert.equal(plan.books.length, 10);
  assert.equal(plan.series.length, 7);
  assert.equal(plan.reads.length, 10);
  const b0 = plan.books.find((b) => b.asin === "B000000000");
  assert.equal(b0.series_asin, "S000000000");
  assert.equal(b0.series_position, 0);
  assert.equal(b0.author, "Jane Doe");
  assert.equal(b0.acquired, "kindle_unlimited");
  assert.equal(plan.devices.find((d) => d.device_id === "77750d31x").owner, "alex");
});

test("batches: at most 500 rows, self-contained, every read once", () => {
  const plan = fixturePlan(700);
  const batches = packBatches(plan);
  assert.ok(batches.length >= 3);
  for (const b of batches) {
    assert.ok(batchRows(b) <= MAX_BATCH_ROWS);
    assert.equal(b.readers.length, 3);
    const books = new Set(b.books.map((x) => x.asin));
    const devs = new Set(b.devices.map((x) => x.device_id));
    const ser = new Set(b.series.map((x) => x.series_asin));
    for (const r of b.reads) {
      assert.ok(books.has(r.asin));
      assert.ok(devs.has(r.device_id));
    }
    for (const bk of b.books) assert.ok(ser.has(bk.series_asin));
  }
  assert.equal(batches[0].devices.length, 3);
  assert.equal(batches.reduce((n, b) => n + b.reads.length, 0), 700);
  assert.equal(new Set(batches.flatMap((b) => b.reads.map((r) => r.import_key))).size, 700);
});
