#!/usr/bin/env node
// Queue a migration or SQL file for approval by a link (Switchboard 2.0, spec 8.1).
//
//   node scripts/sql-queue.mjs <file.sql> --describe "<one sentence>" [--expect <n,unknown,...>] [--test] [--project <code>]
//
// --describe says in plain words what the SQL does, for example "Inserts 12 Arnold workout rows into arnold_workouts".
// --expect gives the rows each insert, update and delete should touch, in order, or "unknown". It's required when there
// are any, and the dry run blocks Approve if a number is wrong. --test queues a test: one undone run, never an Approve.
// The project code is this worktree's name; the main checkout must pass --project. Prints the action id and the
// headline. Exit 0 queued, 1 refused.

import { resolveCheckout } from "./lib/claims-core.mjs";
import { describeResult, queueFile, readQueueSettings } from "./lib/sql-queue.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--project");
const project = at >= 0 ? args.splice(at, 2)[1] : resolveCheckout(process.env.CLAUDE_PROJECT_DIR, process.cwd()).owner;
const said = args.indexOf("--describe");
const description = said >= 0 ? args.splice(said, 2)[1] : undefined;
const counts = args.indexOf("--expect");
const expect = counts >= 0 ? args.splice(counts, 2)[1] ?? "" : undefined;
const testAt = args.indexOf("--test");
const isTest = testAt >= 0;
if (isTest) args.splice(testAt, 1);

if (args.length !== 1) {
  console.error('usage: node scripts/sql-queue.mjs <file.sql> --describe "<one sentence>" [--expect <n,unknown,...>] [--test] [--project <code>]');
  process.exit(2);
}
const out = await queueFile({ file: args[0], project, description, expect, test: isTest }, readQueueSettings());
console.log(describeResult(out));
// Not process.exit(): straight after an HTTPS fetch on Windows it trips a libuv assertion and exits 127.
process.exitCode = out.ok ? 0 : 1;
