#!/usr/bin/env node
// npm run inventory — rebuild the platform inventory from the repo: tools, skills, edge functions, task prompts,
// tables, views, triggers and screens, plus the open work written down in docs/. Writes the payload that
// replace_platform_inventory takes to .scratch/inventory.json (git-ignored) and prints a summary.
//
//   npm run inventory             summary, payload saved
//   npm run inventory -- --json   the payload on stdout instead
//   npm run inventory -- --send   also queue it as an `inventory` event in the Overwatch outbox and run the sender
//
// Only --send touches the network, through scripts/overwatch-post.mjs and overwatch-ingest. Git is read only.
// gitpush queues the same payload after every merge into main (scripts/lib/finish-summary.mjs).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./lib/inventory.mjs";
import { resolveRepo, withLock } from "./lib/claims-core.mjs";
import { SENDER_SCRIPT, queueEvents } from "./lib/overwatch-post.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = ".scratch/inventory.json";
const say = (s) => console.log(s);

function summary({ parts, open_work, problems }) {
  const count = (list, key) => list.reduce((m, x) => m.set(x[key], (m.get(x[key]) ?? 0) + 1), new Map());
  say(`Inventory: ${parts.length} parts, ${open_work.length} open-work lines. Saved to ${OUT}.\n`);
  say("Parts by kind:");
  for (const [k, n] of [...count(parts, "kind")].sort()) say(`  ${k.padEnd(14)} ${n}`);
  const reader = parts.filter((p) => p.reads_any).map((p) => p.name);
  if (reader.length) say(`  (reads any table: ${reader.join(", ")})`);

  say("\nOpen work by kind:");
  for (const [k, n] of [...count(open_work, "kind")].sort()) say(`  ${k.padEnd(14)} ${n}`);
  say("\nOpen work by file, most first:");
  for (const [f, n] of [...count(open_work, "file")].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    say(`  ${String(n).padStart(4)}  ${f}`);
  }

  say(problems.length ? `\nCould not use ${problems.length}:` : "\nEverything parsed.");
  for (const p of problems) say(`  ${p}`);
}

/** Queue the payload as one `inventory` event, then run the sender here so its result is shown. */
function send({ parts, open_work }) {
  const ctx = resolveRepo(ROOT);
  if (!ctx.outboxFile) {
    say("\nNot sent: this checkout has no Overwatch outbox (CLAIMS_BLOCKS_FILE is set, or the sender is missing).");
    process.exitCode = 1;
    return;
  }
  const event = { _kind: "inventory", parts, open_work };
  withLock(ctx, () => {
    queueEvents(ctx.outboxFile, [event]);
    return null;
  });
  say(`\nQueued the inventory (${(Buffer.byteLength(JSON.stringify(event)) / 1024).toFixed(0)} KB). Sending…`);
  const r = spawnSync(process.execPath, [path.join(ROOT, SENDER_SCRIPT)], { cwd: ROOT, stdio: "inherit" });
  say(`Details in ${ctx.outboxFile}.log`);
  if (r.status !== 0) process.exitCode = 1;
}

const result = buildInventory(ROOT);
const payload = { generated_at: new Date().toISOString(), parts: result.parts, open_work: result.open_work };
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  fs.mkdirSync(path.join(ROOT, path.dirname(OUT)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUT), `${JSON.stringify({ ...payload, problems: result.problems }, null, 2)}\n`);
  summary(result);
  if (process.argv.includes("--send")) send(payload);
}
