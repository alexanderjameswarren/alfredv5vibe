#!/usr/bin/env node
// npm run inventory — rebuild the platform inventory from the repo: tools, skills, edge functions, task prompts,
// tables, views, triggers and screens, plus the open work written down in docs/. Writes the payload that
// replace_platform_inventory takes to .scratch/inventory.json (git-ignored) and prints a summary.
//
//   npm run inventory             summary, payload saved
//   npm run inventory -- --json   the payload on stdout instead
//   npm run inventory -- --send   also queue it as an `inventory` event in the Overwatch outbox and run the sender
//   npm run inventory -- --send-summary <commit> --project <code>
//                                 instead, queue a `finish_summary` for that commit against its first parent (a
//                                 merge into main, as gitpush Finish sends it) and run the sender
//
// Only --send touches the network, through scripts/overwatch-post.mjs and overwatch-ingest. Git is read only.
// gitpush queues the same payload after every merge into main (scripts/lib/finish-summary.mjs).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./lib/inventory.mjs";
import { branchFromSubject, collectFinishSummary, parseSendSummaryArgs } from "./lib/finish-summary.mjs";
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

/** Queue one event, then run the sender here so its result is shown. */
function sendEvent(event, label) {
  const ctx = resolveRepo(ROOT);
  if (!ctx.outboxFile) {
    say("\nNot sent: this checkout has no Overwatch outbox (CLAIMS_BLOCKS_FILE is set, or the sender is missing).");
    process.exitCode = 1;
    return;
  }
  withLock(ctx, () => {
    queueEvents(ctx.outboxFile, [event]);
    return null;
  });
  say(`\nQueued ${label} (${(Buffer.byteLength(JSON.stringify(event)) / 1024).toFixed(0)} KB). Sending…`);
  const r = spawnSync(process.execPath, [path.join(ROOT, SENDER_SCRIPT)], { cwd: ROOT, stdio: "inherit" });
  say(`Details in ${ctx.outboxFile}.log`);
  if (r.status !== 0) process.exitCode = 1;
}

const send = ({ parts, open_work }) => sendEvent({ _kind: "inventory", parts, open_work }, "the inventory");

/** --send-summary: the finish summary of one commit against its first parent, read from git only. */
function sendSummary({ commit, project }) {
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
  };
  const subject = git(["show", "-s", "--format=%s", commit]);
  if (!subject.ok) {
    say(`No commit ${commit} here.`);
    process.exitCode = 2;
    return;
  }
  const s = collectFinishSummary({
    git,
    readFile: (p) => {
      const r = git(["show", `${commit}:${p}`]);
      return r.ok ? r.stdout : null;
    },
    projectCode: project,
    branch: branchFromSubject(subject.stdout),
    base: `${commit}^1`,
    head: commit,
  });
  if (!s.row) {
    say(`No finish summary for ${commit}: ${s.error}.`);
    process.exitCode = 1;
    return;
  }
  const r = s.row;
  say(`Finish summary for ${r.merge_commit.slice(0, 7)} ("${subject.stdout}"), project ${r.project_code}, branch ${r.branch ?? "none"}`);
  say(`  finished_at   ${r.finished_at}`);
  say(`  diff_stat     ${r.diff_stat.files} files, +${r.diff_stat.insertions} -${r.diff_stat.deletions}`);
  for (const k of ["migrations", "tools", "skills", "functions", "task_prompts"]) {
    say(`  ${k.padEnd(13)} ${r[k].length ? r[k].join(", ") : "none"}`);
  }
  say(`  paths         ${r.paths.length}`);
  sendEvent({ _kind: "finish_summary", summary: r }, `the finish summary for ${r.merge_commit.slice(0, 7)}`);
}

const summaryArgs = parseSendSummaryArgs(process.argv.slice(2));
if (summaryArgs?.error) {
  say(summaryArgs.error);
  process.exit(2);
}
if (summaryArgs) {
  sendSummary(summaryArgs);
  process.exit();
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
