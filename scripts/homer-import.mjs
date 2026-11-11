#!/usr/bin/env node
// Homer: load the Kindle export into Homer through public.homer_import_batch (homer-h4k phase C).
//
//   node scripts/homer-import.mjs [--dir <homer-analysis folder>] [--apply] [--allow-refused]
//
// Dry run by default: every batch is sent with p_dry_run = true and nothing is saved. With --apply each batch is
// dry-run first and applied only if nothing was refused (--allow-refused applies anyway). The data goes straight from
// disk to the database and never passes through a model. Device owners already in homer_devices are read first and
// win over the built-in labels. Implied finishes (completion 'implied') need the s10 migration to be applied.
//
// Token: set HOMER_TOKEN to your Supabase access token, copied in the browser console on the Alfred tab:
//   for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i);
//     if(/^sb-.*-auth-token$/.test(k)){const v=JSON.parse(localStorage.getItem(k));
//     copy(v.access_token||v.currentSession.access_token);console.log('copied');}}
// It is read from the environment and never printed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan, packBatches, batchRows, parseCsv, planFinishes, readsToClose } from "./lib/homer-import.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const dir = opt("--dir", "C:\\Users\\Alex\\Downloads\\homer-analysis");
const apply = flag("--apply");
const allowRefused = flag("--allow-refused");

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, "..", "src", "supabaseClient.js"), "utf8");
const url = clientSrc.match(/supabaseUrl\s*=\s*'([^']+)'/)?.[1];
const anonKey = clientSrc.match(/supabaseAnonKey\s*=\s*'([^']+)'/)?.[1];
const token = process.env.HOMER_TOKEN;

function find(root, name) {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) { const hit = find(p, name); if (hit) return hit; }
    else if (entry === name) return p;
  }
  return null;
}
const csvFile = (path) => parseCsv(readFileSync(path, "utf8"));
const exportDir = join(dir, "export");
const need = (name) => {
  const p = find(exportDir, name);
  if (!p) throw new Error(`${name} not found under ${exportDir}`);
  return p;
};

async function get(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Owners confirmed in Homer since the first import (device_id -> reader key). Empty on a first run.
async function dbOwners() {
  const readers = new Map((await get("homer_readers?select=id,key")).map((r) => [r.id, r.key]));
  const devices = await get("homer_devices?select=device_id,reader_id&reader_id=not.is.null");
  return new Map(devices.filter((d) => readers.has(d.reader_id)).map((d) => [d.device_id, readers.get(d.reader_id)]));
}

async function call(batch, dryRun) {
  const res = await fetch(`${url}/rest/v1/rpc/homer_import_batch`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_batch: batch, p_dry_run: dryRun }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const flat = (r) => ({ id: r.id, started_on: r.started_on, finished_on: r.finished_on,
  asin: r.homer_books?.asin ?? null, reader: r.homer_readers?.key ?? null });

/**
 * After an import: open clip or chat reads whose book now has a finished export read by the same reader are closed
 * with that finish, so they stop blocking a new clip read. The dry run only counts them (database + this plan).
 */
async function closeOpenReads(plan, write) {
  const raw = await get("homer_reads?select=id,book_id,started_on,finished_on,homer_books(asin),homer_readers(key)" +
    "&finished_on=is.null&source=in.(clip,chat)&reader_id=not.is.null");
  if (raw.length === 0) return [];
  const open = raw.map(flat);
  const books = [...new Set(raw.map((r) => r.book_id))];
  const exported = (await get("homer_reads?select=id,started_on,finished_on,homer_books(asin),homer_readers(key)" +
    `&source=eq.export&finished_on=not.is.null&reader_id=not.is.null&book_id=in.(${books.join(",")})`)).map(flat);
  const close = readsToClose(open, [...exported, ...planFinishes(plan)]);
  if (!write) return close;
  for (const c of close) {
    const res = await fetch(`${url}/rest/v1/homer_reads?id=eq.${c.id}&finished_on=is.null`, {
      method: "PATCH",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ finished_on: c.finished_on }),
    });
    if (!res.ok) throw new Error(`closing read ${c.id}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return close;
}

const line = (c) => Object.entries(c).map(([k, v]) => `${k} +${v.inserted} ~${v.updated} =${v.unchanged} x${v.refused}`).join("  ");

async function main() {
  if (!url || !anonKey) throw new Error("could not read the Supabase URL and anon key from src/supabaseClient.js");
  if (!token) throw new Error("set HOMER_TOKEN first (see the top of this file)");

  const ownershipDir = join(exportDir, "Digital.Content.Ownership");
  const ownershipItems = readdirSync(ownershipDir).filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(readFileSync(join(ownershipDir, f), "utf8")));
  const owners = await dbOwners();
  console.log(`Owners from Homer: ${owners.size} devices${owners.size ? "" : " (none yet, so the built-in labels are used)"}.`);
  const plan = buildPlan({
    dbOwners: owners,
    deviceRows: csvFile(join(dir, "devices.csv")),
    finishedRows: csvFile(join(dir, "finished_books.csv")),
    sessionRows: csvFile(need("Kindle.Devices.ReadingSession.csv")),
    relIndexRows: csvFile(need("Kindle.UnifiedLibraryIndex.CustomerRelationshipIndex.1.1.csv")),
    authorRows: csvFile(need("Kindle.UnifiedLibraryIndex.CustomerAuthorNameRelationship.1.1.csv")),
    ownershipItems,
  });
  const batches = packBatches(plan);
  console.log(`Plan: ${plan.readers.length} readers, ${plan.devices.length} devices, ${plan.series.length} series, ` +
    `${plan.books.length} books, ${plan.reads.length} reads (${plan.reads.filter((r) => r.finished_on).length} finished, ` +
    `${plan.notes.implied_finishes} implied) in ${batches.length} batches. ` +
    `Notes: ${JSON.stringify(plan.notes.unplaced_finishes.length)} finishes with no device, ` +
    `${plan.notes.untitled_books} untitled books.`);
  console.log(apply ? "Mode: APPLY (each batch dry-run first)" : "Mode: dry run (nothing is saved; add --apply to write)");

  for (const [i, b] of batches.entries()) {
    const dry = await call(b, true);
    console.log(`Batch ${i + 1}/${batches.length} (${batchRows(b)} rows) dry run: ${line(dry.counts)}`);
    for (const r of dry.refused) console.log(`  refused ${r.kind} ${r.key}: ${r.reason}`);
    if (!apply) continue;
    if (dry.refused.length && !allowRefused) {
      console.log(`Stopped before applying batch ${i + 1}: ${dry.refused.length} rows refused. Fix them, or rerun with --allow-refused.`);
      process.exitCode = 1;
      return;
    }
    const done = await call(b, false);
    console.log(`Batch ${i + 1}/${batches.length} applied: ${line(done.counts)}`);
  }
  const closed = await closeOpenReads(plan, apply);
  console.log(`${apply ? "Closed" : "Would close"} ${closed.length} open clip or chat read(s) that the export shows finished` +
    (closed.length ? `: ${closed.map((c) => `${c.asin} (${c.reader}, ${c.finished_on})`).join(", ")}.` : "."));
  console.log("Done. Shared rows (readers, devices, series) repeat across batches, so a dry run counts them as new in each.");
}

main().catch((e) => {
  console.error(`homer-import: ${e.message}`);
  // Not process.exit(): straight after an HTTPS fetch on Windows it trips a libuv assertion.
  process.exitCode = 1;
});
