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

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FUNCTIONS_DIR,
  appIdsFromMigrations,
  dedupeParts,
  edgeFunctionPart,
  isWorkDoc,
  lastChangedFromLog,
  openWork,
  registeredTools,
  screenParts,
  skillPart,
  snapshotParts,
  taskPromptPart,
  toolParts,
  toolSourceFiles,
} from "./lib/inventory.mjs";
import { resolveRepo, withLock } from "./lib/claims-core.mjs";
import { SENDER_SCRIPT, queueEvents } from "./lib/overwatch-post.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = ".scratch/inventory.json";
const say = (s) => console.log(s);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Every file under a repo folder, as repo paths with forward slashes. */
function filesUnder(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  return out.sort();
}

function gitLog() {
  try {
    return execFileSync("git", ["log", "--name-only", "--format=%x1e%s"], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function build() {
  const lastChanged = lastChangedFromLog(gitLog());
  const apps = appIdsFromMigrations(filesUnder("supabase/migrations").filter((f) => f.endsWith(".sql")).map(read));
  const registered = registeredTools(read(`${FUNCTIONS_DIR}/mcp/index.ts`));

  const tools = toolParts(toolSourceFiles(ROOT).map((p) => ({ path: p, text: read(p) })), registered, apps, lastChanged);
  const toolsByName = new Map(tools.parts.map((t) => [t.name, t]));
  const problems = [...tools.problems];

  const skills = fs.readdirSync(path.join(ROOT, ".claude/skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, ".claude/skills", e.name, "SKILL.md")))
    .map((e) => skillPart(`.claude/skills/${e.name}/SKILL.md`, read(`.claude/skills/${e.name}/SKILL.md`), toolsByName, apps, lastChanged));
  for (const s of skills) if (!s.details.version) problems.push(`skill ${s.name}: no "Skill version:" line`);

  const prompts = filesUnder("docs").filter((f) => /task-prompt[^/]*\.md$/.test(f))
    .map((f) => taskPromptPart(f, read(f), toolsByName, apps, lastChanged));
  for (const p of prompts) if (!p.details.version && !p.details.history) problems.push(`task prompt ${p.name}: no PROMPT VERSION`);

  const functions = fs.readdirSync(path.join(ROOT, FUNCTIONS_DIR), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => {
      const folder = `${FUNCTIONS_DIR}/${e.name}`;
      return edgeFunctionPart(folder, filesUnder(folder).map((p) => ({ path: p, text: read(p) })), apps, lastChanged);
    });

  const snapshot = snapshotParts(read("supabase/schema-snapshot.sql"), apps);
  const screens = screenParts(read("src/viewPaths.js"), apps, lastChanged);

  const { parts, dropped } = dedupeParts([...tools.parts, ...skills, ...functions, ...prompts, ...snapshot, ...screens]);
  for (const d of dropped) problems.push(`duplicate ${d}: the later one was left out`);

  const open_work = filesUnder("docs").filter(isWorkDoc).flatMap((f) => openWork(f, read(f)));
  return { parts, open_work, problems };
}

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

const result = build();
const payload = { generated_at: new Date().toISOString(), parts: result.parts, open_work: result.open_work };
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  fs.mkdirSync(path.join(ROOT, path.dirname(OUT)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUT), `${JSON.stringify({ ...payload, problems: result.problems }, null, 2)}\n`);
  summary(result);
  if (process.argv.includes("--send")) send(payload);
}

/** Queue the payload as one `inventory` event, then run the sender here so its result is shown. */
function send({ parts, open_work }) {
  const ctx = resolveRepo(ROOT);
  if (!ctx.outboxFile) {
    say("\nNot sent: this checkout has no Overwatch outbox (CLAIMS_BLOCKS_FILE is set, or the sender is missing).");
    process.exitCode = 1;
    return;
  }
  const line = JSON.stringify({ _kind: "inventory", parts, open_work });
  withLock(ctx, () => {
    queueEvents(ctx.outboxFile, [{ _kind: "inventory", parts, open_work }]);
    return null;
  });
  say(`\nQueued the inventory (${(Buffer.byteLength(line) / 1024).toFixed(0)} KB). Sending…`);
  const r = spawnSync(process.execPath, [path.join(ROOT, SENDER_SCRIPT)], { cwd: ROOT, stdio: "inherit" });
  say(`Details in ${ctx.outboxFile}.log`);
  if (r.status !== 0) process.exitCode = 1;
}
