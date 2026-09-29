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

import {
  covers,
  fold,
  isDbItem,
  readState,
  resolveRepo,
} from "./lib/claims-core.mjs";
import {
  ask,
  changedFiles,
  choose,
  confirm,
  gitLive,
  heading,
  say,
  stop,
} from "./lib/git-flow.mjs";

/** Who holds this path, if anyone: an owner name or null. */
function holderOf(state, rel) {
  const hit = state.claims.find(
    (c) =>
      !isDbItem(c.item) && (fold(c.item) === fold(rel) || covers(c.item, rel)),
  );
  return hit ? hit.owner : null;
}

function describe(f) {
  const label = f.untracked ? "new" : f.status.trim();
  return `${label.padEnd(3)} ${f.path}`;
}

function main() {
  const flags = process.argv.slice(2);
  const mIndex = flags.indexOf("-m");
  let message = mIndex >= 0 ? flags[mIndex + 1] : null;

  const ctx = resolveRepo();
  const state = readState(ctx.file);
  const changed = changedFiles(ctx.root);

  heading(`gitcom — ${ctx.owner}`);
  say(`Checkout: ${ctx.root}`);

  if (!changed.length) stop("Nothing has changed. Nothing to commit.", 0);

  const mine = [];
  const others = [];
  const unclaimed = [];
  for (const f of changed) {
    const holder = holderOf(state, f.path);
    if (holder === ctx.owner) mine.push(f);
    else if (holder) others.push({ ...f, holder });
    else unclaimed.push(f);
  }

  if (mine.length) {
    say(`\nClaimed by ${ctx.owner} — will be committed:`);
    for (const f of mine) say(`  ${describe(f)}`);
  } else {
    say(`\n${ctx.owner} has no changed files among its claims.`);
  }

  if (others.length) {
    say("\nClaimed by another thread — WILL NOT be committed:");
    for (const f of others) say(`  ${describe(f)}   (${f.holder})`);
  }

  // Unclaimed changes are usually Alex's own hand edits sitting in the tree.
  // They are his to decide about, one at a time if he wants.
  const extra = [];
  if (unclaimed.length) {
    say("\nChanged but claimed by nobody:");
    for (const f of unclaimed) say(`  ${describe(f)}`);
    say("\nThese are probably your own edits. Include them in this commit?");
    const pick = choose("  all / none / select", [
      { key: "a", label: "all" },
      { key: "n", label: "none" },
      { key: "s", label: "select" },
    ]);
    if (pick === null) stop("Cancelled. Nothing staged, nothing committed.", 0);
    if (pick === "a") extra.push(...unclaimed);
    if (pick === "s") {
      for (const f of unclaimed) {
        if (confirm(`  include ${f.path}?`)) extra.push(f);
      }
    }
  }

  const staging = [...mine, ...extra];
  if (!staging.length) stop("Nothing selected. Nothing staged, nothing committed.", 0);

  heading("About to commit");
  for (const f of staging) say(`  ${describe(f)}`);
  if (others.length) {
    say(`\n  (${others.length} file(s) left alone — another thread holds them)`);
  }

  if (!message) {
    message = ask("\nCommit message: ").trim();
    if (!message) stop("No message. Nothing staged, nothing committed.", 0);
  }
  say(`\nMessage: ${message}`);

  if (!confirm(`\nStage these ${staging.length} file(s) and commit?`)) {
    stop("Cancelled. Nothing staged, nothing committed.", 0);
  }

  // Explicit paths after `--`, never `git add .`.
  const paths = staging.map((f) => f.path);
  if (!gitLive(["add", "--", ...paths], ctx.root)) {
    stop("git add failed. Nothing was committed.", 1);
  }
  if (!gitLive(["commit", "-m", message], ctx.root)) {
    stop(
      "git commit failed. The files above are staged — `git reset` unstages them.",
      1,
    );
  }

  say(`\nCommitted ${paths.length} file(s) as ${ctx.owner}.`);
  say("Claims are unchanged: gitpush releases them once this is merged and pushed.");
}

main();
