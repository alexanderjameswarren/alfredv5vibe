#!/usr/bin/env node
// gitcom — commit this thread's claimed files, and nothing else by accident.
//
// Alex runs this. No CLI thread runs it; see scripts/lib/git-flow.mjs.
//
// Usage:  node scripts/git-commit-claimed.mjs [-m "message"]
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
  say,
  selectByClaims,
  stageAndCommit,
  stop,
} from "./lib/git-flow.mjs";

function main() {
  const argv = process.argv.slice(2);
  const mIndex = argv.indexOf("-m");
  let message = mIndex >= 0 ? argv[mIndex + 1] : null;

  const ctx = resolveRepo();
  const state = readState(ctx.file);

  heading(`gitcom — ${ctx.owner}`);
  say(`Checkout: ${ctx.root}`);

  const changed = changedFiles(ctx.root);
  if (!changed.length) stop("Nothing has changed. Nothing to commit.", 0);

  const parts = partitionByClaims(state, ctx.owner, changed);
  const staging = selectByClaims({ owner: ctx.owner, ...parts });
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
