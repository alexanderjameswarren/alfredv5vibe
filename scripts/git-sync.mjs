#!/usr/bin/env node
// gitsync — merge local main into this worktree's branch.
//
// Alex runs this, inside a worktree, before a database step. No CLI thread runs
// it; see scripts/lib/git-flow.mjs.
//
// Usage:  node scripts/git-sync.mjs
//
// ---------------------------------------------------------------------------
// WHY LOCAL main AND NOT origin/main
// ---------------------------------------------------------------------------
//
// `claude --worktree` branches from origin/main. Anything Alex has committed
// locally but not pushed is invisible to a new worktree, so a worktree can be
// behind main from the moment it exists. gitsync closes that gap, which is why
// it merges local `main` rather than `origin/main` — the protocol's Step 0 (push
// main before starting a worktree) keeps the two close, and this catches the
// rest.
//
// There should be no conflict: two threads never hold the same file. If there is
// one, that is worth knowing about, so this stops and says so rather than
// tidying it away.

import { readState, resolveRepo } from "./lib/claims-core.mjs";
import {
  changedFiles,
  commitsAhead,
  confirm,
  git,
  gitLive,
  heading,
  parseArgs,
  say,
  stop,
  tryGit,
  UsageError,
} from "./lib/git-flow.mjs";

const BASE = "main";

// gitsync asks exactly one question — the final "merge?" — and the rule for
// these commands is that a parameter answers a question but never skips the
// confirmation. So there is nothing here for a parameter to answer, and there
// is deliberately no --yes: it would be the one flag that removes the
// confirmation rather than pre-filling it.
const USAGE = `gitsync — merge local main into this worktree's branch.

  gitsync [--help]

  It asks one question, the final yes/no, and that one is always asked.
  Run it from inside a worktree; it refuses in the main checkout.`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { help: { kind: "bool", alias: "h" } });
  } catch (err) {
    if (err instanceof UsageError) stop(`${err.message}\n\n${USAGE}`, 2);
    throw err;
  }
  if (args.options.help) stop(USAGE, 0);

  const ctx = resolveRepo();

  heading(`gitsync — ${ctx.owner}`);
  say(`Checkout: ${ctx.root}`);

  if (!ctx.isWorktree) {
    stop(
      `This is the main checkout, not a worktree. There is nothing to merge\n` +
        `${BASE} into — run gitsync from inside a worktree.`,
    );
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], ctx.root);
  if (branch === BASE) {
    stop(`This worktree is on ${BASE} itself. Nothing to do.`);
  }
  say(`Branch:   ${branch}`);

  const incoming = commitsAhead(BASE, "HEAD", ctx.root);
  if (!incoming.length) {
    stop(`Already up to date with ${BASE}. Nothing to merge.`, 0);
  }

  say(`\n${incoming.length} commit(s) on ${BASE} that this branch does not have:`);
  for (const line of incoming.slice(0, 20)) say(`  ${line}`);
  if (incoming.length > 20) say(`  … and ${incoming.length - 20} more`);

  // A merge into a dirty tree can fail halfway, so Alex sees the state first.
  const dirty = changedFiles(ctx.root);
  if (dirty.length) {
    say(`\nThis worktree has ${dirty.length} uncommitted change(s):`);
    for (const f of dirty.slice(0, 15)) say(`  ${f.status.trim()} ${f.path}`);
    if (dirty.length > 15) say(`  … and ${dirty.length - 15} more`);
    say("\nGit will refuse the merge if it would overwrite any of them.");
    say("Committing first (gitcom) is usually the cleaner move.");
  }

  // Worth knowing which files could collide, given claims are supposed to
  // guarantee they cannot.
  const state = readState(ctx.file);
  const held = state.claims
    .filter((c) => c.owner === ctx.owner && !c.item.startsWith("db:"))
    .map((c) => c.item);
  if (held.length) {
    say(`\n${ctx.owner} holds: ${held.join(", ")}`);
  }

  if (!confirm(`\nMerge ${BASE} into ${branch}?`)) {
    stop("Cancelled. Nothing merged.", 0);
  }

  if (!gitLive(["merge", BASE], ctx.root)) {
    const conflicts = tryGit(
      ["diff", "--name-only", "--diff-filter=U"],
      ctx.root,
    );
    heading("Merge stopped");
    if (conflicts.ok && conflicts.stdout) {
      say("Conflicting files:");
      for (const f of conflicts.stdout.split(/\r?\n/)) say(`  ${f}`);
      say(
        `\nTwo threads should never hold the same file, so this is worth looking at\n` +
          `before resolving it. To back out: git -C "${ctx.root}" merge --abort`,
      );
    } else {
      say(`The merge failed. To back out: git -C "${ctx.root}" merge --abort`);
    }
    process.exit(1);
  }

  say(`\nMerged ${BASE} into ${branch}.`);
  say("Now re-check for drift before the database step: if anything that came in");
  say("touches the same tables or function, re-plan that step.");
}

main();
