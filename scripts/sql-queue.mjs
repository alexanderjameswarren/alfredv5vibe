#!/usr/bin/env node
// Queue a migration or SQL file for approval by a link (Switchboard 2.0, spec 8.1).
//
//   node scripts/sql-queue.mjs <file.sql> [--project <code>]
//
// The project code is this worktree's name; the main checkout must pass --project. Prints the action id and the
// headline. Exit 0 queued, 1 refused.

import { resolveCheckout } from "./lib/claims-core.mjs";
import { describeResult, queueFile, readQueueSettings } from "./lib/sql-queue.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--project");
const project = at >= 0 ? args.splice(at, 2)[1] : resolveCheckout(process.env.CLAUDE_PROJECT_DIR, process.cwd()).owner;

if (args.length !== 1) {
  console.error("usage: node scripts/sql-queue.mjs <file.sql> [--project <code>]");
  process.exit(2);
}
const out = await queueFile({ file: args[0], project }, readQueueSettings());
console.log(describeResult(out));
// Not process.exit(): straight after an HTTPS fetch on Windows it trips a libuv assertion and exits 127.
process.exitCode = out.ok ? 0 : 1;
