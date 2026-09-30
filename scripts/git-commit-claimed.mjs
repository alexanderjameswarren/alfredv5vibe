#!/usr/bin/env node
// gitcom — commit this thread's claimed files, and nothing else by accident.
//
// Alex runs this. No CLI thread runs it; see scripts/lib/git-flow.mjs.
//
// Usage:  node scripts/git-commit-claimed.mjs [options]
//
// Every question it asks can be answered on the command line, so claude.ai can
// hand Alex one line to paste. What is not given is still asked. The plan and
// the final yes/no happen either way — a parameter answers a question, it does
// not skip the confirmation.
//
// ---------------------------------------------------------------------------
// WHAT REPLACED WHAT
// ---------------------------------------------------------------------------
//
// The old `gitcom` was four lines: prompt for a message, `git add .`, commit.
// That sweep put Alex's own uncommitted work into two of my commits — once a
// skill file and a rename, once an edit to an edge function — and neither was
// visible until the commit existed. Rule 1 of .claude/CLAUDE.md came out of it.
//
// This version stages paths one at a time, by name, and decides about each one
// from the claims file:
//
//   claimed by me       staged
//   claimed by another  never staged, and said out loud
//   claimed by nobody   Alex is asked, all at once or file by file
//
// The middle case is the point. Another thread's half-finished file cannot
// reach main through my commit, however tempting the diff looks.
//
// The three-way split and the prompt live in claims-core and git-flow, because
// gitpush commits in the main checkout the same way and "the same rules" is
// only true when it is the same code.

import { partitionByClaims, readState, resolveRepo } from "./lib/claims-core.mjs";
import { codeOfCheckout } from "./lib/project-code.mjs";
import {
  askMessage,
  changedFiles,
  confirm,
  describeFile,
  heading,
  parseArgs,
  say,
  selectByClaims,
  stageAndCommit,
  stop,
  UsageError,
} from "./lib/git-flow.mjs";

const USAGE = `gitcom — commit this thread's claimed, changed files.

  gitcom [options]

  --include-unclaimed all|none|<paths…>   what to do with changes nobody claimed
  --message, -m "..."                     the commit message
  --help, -h

  Anything not given is asked. The plan and the final yes/no are always shown.
  A blank message uses  <project-code>: commit <date>.`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), {
      "include-unclaimed": { kind: "list" },
      message: { kind: "value", alias: "m" },
      help: { kind: "bool", alias: "h" },
    });
  } catch (err) {
    if (err instanceof UsageError) stop(`${err.message}\n\n${USAGE}`, 2);
    throw err;
  }
  if (args.options.help) stop(USAGE, 0);

  let message = args.options.message ?? null;

  const ctx = resolveRepo();
  const state = readState(ctx.file);

  heading(`gitcom — ${ctx.owner}`);
  say(`Checkout: ${ctx.root}`);

  const changed = changedFiles(ctx.root);
  if (!changed.length) stop("Nothing has changed. Nothing to commit.", 0);

  const parts = partitionByClaims(state, ctx.owner, changed);
  let staging;
  try {
    staging = selectByClaims({
      owner: ctx.owner,
      ...parts,
      include: args.options["include-unclaimed"],
    });
  } catch (err) {
    if (err instanceof UsageError) stop(`\n${err.message}`, 2);
    throw err;
  }
  if (!staging.length) {
    stop("Nothing selected. Nothing staged, nothing committed.", 0);
  }

  heading("About to commit");
  for (const f of staging) say(`  ${describeFile(f)}`);
  if (parts.others.length) {
    say(`\n  (${parts.others.length} file(s) left alone — another thread holds them)`);
  }

  if (!message) {
    message = askMessage(codeOfCheckout(ctx).code, "commit");
  }
  say(`\nMessage: ${message}`);

  if (!confirm(`\nStage these ${staging.length} file(s) and commit?`)) {
    stop("Cancelled. Nothing staged, nothing committed.", 0);
  }

  if (!stageAndCommit(ctx.root, staging.map((f) => f.path), message)) {
    process.exit(1);
  }

  say(`\nCommitted ${staging.length} file(s) as ${ctx.owner}.`);
  say("Claims are unchanged: gitpush releases them once this is merged and pushed.");
}

main();
