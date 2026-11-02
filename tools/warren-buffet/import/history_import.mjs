/*
Warren Buffet - bank and card history import (spec P4-D2 to P4-D5).

Dry run, the default. Writes nothing anywhere:
    node history_import.mjs <history folder> [--only a.csv,b.csv]
    -> prints counts and dates per account and, if clean, a code for that exact run.

Write (Step 6). Repeats every check, then refuses unless the code still matches:
    node history_import.mjs <history folder> --write --confirm <code> [--only a.csv,b.csv]

The service-role key comes from SUPABASE_SERVICE_ROLE_KEY only and is never written
to a file. Output is counts and dates only: never amounts, descriptions or account numbers.
*/
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ALL_FILES, CNB_FILE, CNB_LAST4, WF_FILES,
  pacificDate, readCnb, readWellsFargo, splitAtCutoff, toRow, withExternalIds,
} from "./history_lib.mjs";

const SUPABASE_URL = "https://zuqjyfqnvhddnchhpbcz.supabase.co";
const KEY_VAR = "SUPABASE_SERVICE_ROLE_KEY";
const ID_CHUNK = 100;
const INSERT_CHUNK = 200;
const PROCESS_CHUNK = 100;

function chunks(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export function rest(key, fetchFn) {
  return async (path, { method = "GET", body, prefer } = {}) => {
    const res = await fetchFn(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      // Code and message only: an error's "details" can quote a whole row.
      const err = await res.json().catch(() => ({}));
      const table = path.split("?")[0];
      throw new Error(`${method} ${table} failed: ${res.status} ${err.code ?? ""} ${err.message ?? ""}`.trim());
    }
    return res.status === 204 ? null : res.json();
  };
}

function parseArgs(argv) {
  const opts = { folder: null, write: false, dryRunFlag: false, confirm: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--dry-run") opts.dryRunFlag = true;
    else if (a === "--confirm") opts.confirm = argv[++i] ?? null;
    else if (a === "--only") opts.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}.`);
    else if (!opts.folder) opts.folder = a;
    else throw new Error("Pass one history folder.");
  }
  if (!opts.folder) throw new Error("Pass the history folder: node history_import.mjs <history folder>");
  if (opts.write && opts.dryRunFlag) throw new Error("Choose --dry-run or --write, not both.");
  if (opts.write && !opts.confirm) throw new Error("--write needs --confirm <code> from a clean dry run of the same files.");
  for (const f of opts.only ?? []) if (!ALL_FILES.includes(f)) throw new Error(`--only names an unknown file: ${f}`);
  if (opts.only && !opts.only.length) throw new Error("--only needs at least one file.");
  return opts;
}

/** Earliest synced day: posted date, or transacted date where a row has no posted date. */
async function firstSyncedDay(db, accountId) {
  const base = `wb_transactions?account_id=eq.${accountId}&source=eq.sync`;
  const posted = await db(`${base}&posted_at=not.is.null&select=posted_at&order=posted_at.asc&limit=1`);
  const unposted = await db(`${base}&posted_at=is.null&transacted_at=not.is.null&select=transacted_at&order=transacted_at.asc&limit=1`);
  const days = [
    ...(posted[0] ? [pacificDate(posted[0].posted_at)] : []),
    ...(unposted[0] ? [pacificDate(unposted[0].transacted_at)] : []),
  ].sort();
  return days[0] ?? null;
}

async function buildPlan(opts, db) {
  const files = (opts.only ?? ALL_FILES).slice().sort((a, b) => ALL_FILES.indexOf(a) - ALL_FILES.indexOf(b));
  const read = [];
  for (const file of files) {
    const path = join(opts.folder, file);
    if (!existsSync(path)) throw new Error(`Missing file: ${file}`);
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    try {
      const wf = WF_FILES.find((f) => f.file === file);
      read.push({ file, bytes, ...(wf ? readWellsFargo(text, wf.last4) : readCnb(text)) });
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
  }

  const accounts = await db(
    `wb_accounts?source=eq.simplefin&last4=in.(${[...WF_FILES.map((f) => f.last4), ...CNB_LAST4].join(",")})` +
    "&select=id,user_id,context_id,last4,history_from",
  );
  const groups = [];
  for (const { file, rows, bad } of read) {
    const fileLast4 = file === CNB_FILE ? CNB_LAST4 : [WF_FILES.find((f) => f.file === file).last4];
    for (const last4 of fileLast4) {
      const matches = accounts.filter((a) => a.last4 === last4);
      if (matches.length !== 1) throw new Error(`Account ending ${last4}: expected 1 match, found ${matches.length}.`);
      const account = matches[0];
      const all = withExternalIds(rows.filter((r) => r.last4 === last4));
      const cutoff = await firstSyncedDay(db, account.id);
      const { keep, skipped } = splitAtCutoff(all, cutoff);
      const present = new Set();
      for (const part of chunks(keep.map((r) => r.external_id), ID_CHUNK)) {
        const found = await db(`wb_transactions?account_id=eq.${account.id}&external_id=in.(${part.join(",")})&select=external_id`);
        found.forEach((x) => present.add(x.external_id));
      }
      const dates = keep.map((r) => r.date).sort();
      groups.push({
        file, last4, account, cutoff, keep, skipped,
        rowsRead: all.length,
        // A CNB bad row has no trusted account, so it is counted on the file's first account.
        bad: last4 === fileLast4[0] ? bad.length : 0,
        earliest: dates[0] ?? null,
        latest: dates[dates.length - 1] ?? null,
        onOrAfterCutoff: cutoff ? keep.filter((r) => r.date >= cutoff).length : 0,
        alreadyPresent: present.size,
      });
    }
  }
  const clean = groups.every((g) => g.bad === 0 && g.onOrAfterCutoff === 0 && g.alreadyPresent === 0);
  // Tied to the file bytes and the cutoffs, so any change to either voids the code.
  const hash = createHash("sha256");
  for (const { file, bytes } of read) hash.update(file).update(bytes);
  for (const g of groups) hash.update(`${g.last4}|${g.cutoff}|${g.keep.length}`);
  return { groups, clean, code: hash.digest("hex").slice(0, 16) };
}

function report(plan, log) {
  for (const g of plan.groups) {
    log(`${g.file} -> account ending ${g.last4}`);
    log(`  cutoff: ${g.cutoff ? `before ${g.cutoff}` : "none (no synced rows; every row)"}`);
    log(`  rows read: ${g.rowsRead}  before cutoff: ${g.keep.length}  skipped: ${g.skipped}  unreadable: ${g.bad}`);
    log(`  earliest: ${g.earliest ?? "none"}  latest: ${g.latest ?? "none"}`);
    log(`  boundary: on or after cutoff ${g.onOrAfterCutoff}, external ids already present ${g.alreadyPresent}`);
  }
  const total = plan.groups.reduce((n, g) => n + g.keep.length, 0);
  log(`TOTAL to import: ${total}`);
}

async function write(plan, db, log) {
  const ids = [];
  for (const g of plan.groups) {
    for (const part of chunks(g.keep.map((r) => toRow(r, g.account)), INSERT_CHUNK)) {
      const rows = await db("wb_transactions?on_conflict=account_id,external_id&select=id", {
        method: "POST", body: part, prefer: "return=representation,resolution=ignore-duplicates",
      });
      ids.push(...rows.map((r) => r.id));
    }
    if (g.earliest && (!g.account.history_from || g.earliest < g.account.history_from)) {
      await db(`wb_accounts?id=eq.${g.account.id}`, { method: "PATCH", body: { history_from: g.earliest } });
    }
    log(`Inserted through account ending ${g.last4}: ${ids.length} rows in total.`);
  }
  let failedChunks = 0;
  for (const part of chunks(ids, PROCESS_CHUNK)) {
    // A failed chunk stays unprocessed, and the next wb-sync run picks it up.
    try { await db("rpc/wb_process_transactions", { method: "POST", body: { ids: part } }); }
    catch { failedChunks++; }
  }
  log(`WRITE DONE. Inserted ${ids.length}. Processing chunks failed: ${failedChunks}.`);
  return ids.length;
}

/** Returns the exit code. Dependencies are passed in so tests never touch a real database. */
export async function run(argv, { env = process.env, fetchFn = fetch, log = console.log } = {}) {
  let key;
  try {
    const opts = parseArgs(argv);
    if (!existsSync(opts.folder)) throw new Error("History folder not found.");
    key = env[KEY_VAR]?.trim();
    if (!key) throw new Error(`${KEY_VAR} is not set. Set it in this terminal session only; never in a file.`);
    log(opts.write ? "MODE: write" : "MODE: dry run (writes nothing)");
    const db = rest(key, fetchFn);
    const plan = await buildPlan(opts, db);
    report(plan, log);
    if (!plan.clean) {
      log("NOT CLEAN. No code issued; --write will refuse.");
      return 1;
    }
    if (!opts.write) {
      log(`DRY RUN CLEAN. Code for these exact files and cutoffs: ${plan.code}`);
      return 0;
    }
    if (opts.confirm !== plan.code) {
      log("REFUSED: this code does not match a clean dry run of these files. Nothing written. Dry-run again.");
      return 1;
    }
    await write(plan, db, log);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${key ? msg.split(key).join("[key]") : msg}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
