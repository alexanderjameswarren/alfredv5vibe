#!/usr/bin/env node
// npm run schema:snapshot — dump the live database's structure (no data) to
// supabase/schema-snapshot.sql. gitpush runs it whenever a commit carries a
// migration newer than the snapshot; run it by hand to refresh at any time.
//
//   npm run schema:snapshot
//   npm run schema:snapshot -- --decide <paths…>   what gitpush would decide, no Docker
//   --through <n>   gitpush only: label the snapshot through n when that is newer than
//                   this checkout's own migrations (a worktree's, before it is merged)
//
// Nothing is saved unless the dump is non-trivial and holds the known tables.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_BYTES,
  SNAPSHOT_PATH,
  headerLine,
  highestMigration,
  inspectDump,
  readSnapshotThrough,
  snapshotDecision,
  snapshotLabel,
} from "./lib/schema-snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKER_EXE = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
const DOCKER_WAIT_MS = 120_000;

const say = (s) => console.log(s);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (cmd, opts = {}) =>
  spawnSync(cmd, { shell: true, cwd: ROOT, stdio: "inherit", ...opts });
const dockerUp = () => run("docker info", { stdio: "ignore" }).status === 0;

function fail(message) {
  console.error(`\nschema:snapshot — ${message} Nothing was saved.`);
  process.exit(1);
}

function ensureDocker() {
  if (dockerUp()) return true;
  say("Docker is not running — starting Docker Desktop.");
  if (run("docker desktop start", { stdio: "ignore" }).status !== 0) {
    if (!fs.existsSync(DOCKER_EXE)) return false;
    spawn(DOCKER_EXE, [], { detached: true, stdio: "ignore" }).unref();
  }
  const until = Date.now() + DOCKER_WAIT_MS;
  let next = 0;
  while (Date.now() < until) {
    if (dockerUp()) return true;
    if (Date.now() >= next) {
      say(`  waiting for Docker… (${Math.round((until - Date.now()) / 1000)}s left)`);
      next = Date.now() + 15_000;
    }
    sleep(3000);
  }
  return false;
}

function dumpTo(file, cli) {
  fs.rmSync(file, { force: true });
  const r = run(`${cli} db dump --linked --schema public,platform -f "${file}"`);
  return r.status === 0 && fs.existsSync(file) && fs.statSync(file).size >= MIN_BYTES;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--decide") {
    const through = readSnapshotThrough(ROOT);
    const d = snapshotDecision(args.slice(1), through);
    say(`${d.run ? "WOULD RUN" : "would skip"} the snapshot: ${d.reason}.`);
    return;
  }

  const at = args.indexOf("--through");
  const given = at >= 0 ? Number(args[at + 1]) : null;
  if (at >= 0 && !Number.isInteger(given)) fail(`--through needs a migration number, got ${JSON.stringify(args[at + 1])}.`);

  if (!ensureDocker()) fail("Docker did not become ready within 2 minutes.");

  const tmp = path.join(os.tmpdir(), `schema-snapshot-${process.pid}.sql`);
  if (!dumpTo(tmp, "supabase")) {
    say("\nThe installed Supabase CLI failed — retrying with npx supabase@latest.");
    if (!dumpTo(tmp, "npx -y supabase@latest")) {
      fs.rmSync(tmp, { force: true });
      fail(`the dump failed or came back under ${MIN_BYTES} bytes.`);
    }
  }

  const text = fs.readFileSync(tmp, "utf8");
  fs.rmSync(tmp, { force: true });
  const { counts, missing } = inspectDump(text);
  if (missing.length) fail(`the dump is missing known tables: ${missing.join(", ")}.`);

  const through = snapshotLabel(highestMigration(ROOT), given);
  fs.writeFileSync(path.join(ROOT, SNAPSHOT_PATH), `${headerLine(stamp(), through)}\n${text}`);
  say(`\nSaved ${SNAPSHOT_PATH} (through migration ${through}).`);
  for (const [schema, n] of Object.entries(counts)) say(`  ${schema}: ${n} tables`);
  say("  known tables: all present");
}

main();
