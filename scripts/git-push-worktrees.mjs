#!/usr/bin/env node
// gitpush — bring a worktree's work into main and push it.
//
// Alex runs this, from the main checkout. No CLI thread runs it; see
// scripts/lib/git-flow.mjs.
//
// Usage:  node scripts/git-push-worktrees.mjs
//
// It lists the main checkout and every open worktree, each with its branch, what
// it has claimed, what is unpushed and whether it is dirty. Alex picks one,
// several, or all, and chooses a mode for each.
//
// For a worktree:
//
//   Finish      commit its claimed changes, merge into main, push, release ALL
//               its claims, remove the worktree, delete the branch.
//
//   Checkpoint  commit only the paths Alex names — normally the migration and
//               function files for a step he has just deployed — merge, push,
//               and release only the db: claims he names. The worktree stays,
//               and everything else in it stays uncommitted.
//
// For the main checkout there is nothing to merge — the work is already on main
// — so the two modes are about what happens to the claims:
//
//   Push only   commit by the gitcom rules if anything has changed, push, and
//               KEEP the claims, because the project is still going.
//
//   Finish      the same, then release everything main holds.
//
// Main needs to be here at all because a lot of work never uses a worktree. Solo
// work in the main checkout had no way through gitpush, which meant main's
// claims could only ever be released by hand, and they quietly piled up.
//
// ---------------------------------------------------------------------------
// WHY CHECKPOINT EXISTS
// ---------------------------------------------------------------------------
//
// A push can trigger a deploy. Halfway-done front-end work must not ride along
// with a database step that is finished and live. Checkpoint is how the two come
// apart: it stages named paths only, so the rest of the worktree cannot reach
// main by accident.
//
// This is also the only place file claims are released. A thread never releases
// its own — see .claude/CLAUDE.md — because a claim released while the file
// still has uncommitted changes lets a second thread claim it, which is the
// collision the whole system exists to prevent.

import {
  isDbItem,
  partitionByClaims,
  readState,
  removeClaims,
  resolveRepo,
} from "./lib/claims-core.mjs";
import {
  ask,
  changedFiles,
  choose,
  commitsAhead,
  confirm,
  describeFile,
  git,
  gitLive,
  heading,
  listWorktrees,
  say,
  selectByClaims,
  stageAndCommit,
  stop,
  tryGit,
  unpushed,
} from "./lib/git-flow.mjs";

const BASE = "main";

/** Claims and reservations held by one worktree name. */
function heldBy(state, owner) {
  return {
    files: state.claims
      .filter((c) => c.owner === owner && !isDbItem(c.item))
      .map((c) => c.item),
    db: state.claims
      .filter((c) => c.owner === owner && isDbItem(c.item))
      .map((c) => c.item),
  };
}

function summarise(tree, state) {
  const owner = tree.isMain ? "main" : tree.name;
  const { files, db } = heldBy(state, owner);
  const dirty = changedFiles(tree.path);
  // A worktree's work is measured against main; main's against its upstream,
  // since there is nothing for main to merge into.
  const ahead = tree.isMain
    ? unpushed(tree.path)
    : { commits: commitsAhead("HEAD", BASE, tree.path), hasUpstream: true };
  return { ...tree, owner, files, db, dirty, ahead };
}

function showTree(w, index) {
  say(`\n  [${index}] ${w.owner}${w.isMain ? "   (the main checkout)" : ""}`);
  say(`      path    ${w.path}`);
  say(`      branch  ${w.branch ?? "(detached)"}`);
  if (w.isMain) {
    say(
      w.ahead.hasUpstream
        ? `      unpushed ${w.ahead.commits.length} commit(s) vs ${w.ahead.upstream}`
        : `      unpushed (this branch tracks nothing)`,
    );
  } else {
    say(`      commits ${w.ahead.commits.length} not yet in ${BASE}`);
  }
  say(`      changes ${w.dirty.length} uncommitted`);
  say(`      claims  ${w.files.length ? w.files.join(", ") : "none"}`);
  if (w.db.length) say(`      db      ${w.db.join(", ")}`);
}

/** Stage named paths in a worktree and commit them. Returns false to stop. */
function commitIn(w, paths, message) {
  if (!paths.length) {
    say("  Nothing to stage — skipping the commit, the branch may already be ready.");
    return true;
  }
  if (!gitLive(["add", "--", ...paths], w.path)) {
    say("  git add failed.");
    return false;
  }
  if (!gitLive(["commit", "-m", message], w.path)) {
    say("  git commit failed. Staged files are still staged.");
    return false;
  }
  return true;
}

/** Merge a worktree's branch into main and push. Returns false to stop. */
function mergeAndPush(w, root) {
  if (!gitLive(["merge", "--no-ff", w.branch, "-m", `Merge ${w.branch}`], root)) {
    const conflicts = tryGit(["diff", "--name-only", "--diff-filter=U"], root);
    say("\n  The merge stopped.");
    if (conflicts.ok && conflicts.stdout) {
      say("  Conflicting files:");
      for (const f of conflicts.stdout.split(/\r?\n/)) say(`    ${f}`);
    }
    say(`  To back out:  git -C "${root}" merge --abort`);
    return false;
  }
  if (!gitLive(["push"], root)) {
    say("\n  The push failed. The merge is in main locally but not pushed.");
    return false;
  }
  return true;
}

/**
 * The main checkout: commit by the gitcom rules, push, and either keep the
 * claims (the project is still going) or release them (it is done).
 *
 * Nothing is merged — the work is already on main — so the whole difference
 * between the two modes is what happens to the claims afterwards.
 */
function doMain(w, ctx, release) {
  heading(`${release ? "Finish" : "Push only"} — main checkout`);

  let staging = [];
  if (w.dirty.length) {
    const state = readState(ctx.file);
    const parts = partitionByClaims(state, "main", w.dirty);
    const picked = selectByClaims({ owner: "main", ...parts });
    if (picked === null) return "cancelled";
    staging = picked;
  } else {
    say("\nNothing is uncommitted here.");
  }

  const all = [...w.files, ...w.db];
  heading("About to");
  if (staging.length) {
    say(`Commit  ${staging.length} file(s):`);
    for (const f of staging) say(`          ${describeFile(f)}`);
  } else {
    say("Commit  nothing — no changes selected.");
  }
  say(
    w.ahead.hasUpstream
      ? `Push    ${w.branch} to ${w.ahead.upstream}.`
      : `Push    ${w.branch} (it tracks nothing yet, so this may need -u).`,
  );
  say(
    release
      ? `Release all ${all.length} claim(s) main holds${all.length ? `: ${all.join(", ")}` : ""}.`
      : `Keep    all ${all.length} claim(s) main holds — the project is still going.`,
  );

  if (!confirm("\nDo all of that?")) return "cancelled";

  if (staging.length) {
    const message = ask("Commit message: ").trim();
    if (!message) return "cancelled";
    if (!stageAndCommit(w.path, staging.map((f) => f.path), message)) return "failed";
  }

  if (!gitLive(["push"], w.path)) {
    say("\n  The push failed. Anything committed above is still committed locally.");
    return "failed";
  }

  if (release) {
    const released = removeClaims(ctx, "main");
    say(`\n  Released ${released.length} claim(s): ${released.join(", ") || "none"}`);
  } else {
    say(`\n  Claims kept. gitpush Finish is what releases them.`);
  }
  return "done";
}

function doFinish(w, ctx) {
  heading(`Finish — ${w.owner}`);

  // Finish commits what this worktree claimed and has changed. Anything it did
  // not claim is left where it is; gitcom is where unclaimed files get decided.
  const claimedChanges = w.dirty.filter((f) =>
    w.files.some((item) => f.path === item || (item.endsWith("/") && f.path.startsWith(item))),
  );
  const leftBehind = w.dirty.filter((f) => !claimedChanges.includes(f));

  say(`Commit  ${claimedChanges.length} claimed change(s):`);
  for (const f of claimedChanges) say(`          ${f.status.trim()} ${f.path}`);
  if (leftBehind.length) {
    say(`\n  Leaving ${leftBehind.length} unclaimed change(s) uncommitted:`);
    for (const f of leftBehind) say(`          ${f.status.trim()} ${f.path}`);
    say("  Run gitcom in that worktree first if they should go too.");
  }
  say(`\nMerge   ${w.branch} into ${BASE}, then push.`);
  say(`Release all ${w.files.length + w.db.length} claim(s) held by ${w.owner}.`);
  say(`Remove  the worktree, then delete branch ${w.branch}.`);

  if (!confirm("\nDo all of that?")) return "cancelled";

  if (claimedChanges.length) {
    const message = ask("Commit message: ").trim();
    if (!message) return "cancelled";
    if (!commitIn(w, claimedChanges.map((f) => f.path), message)) return "failed";
  }
  if (!mergeAndPush(w, ctx.root)) return "failed";

  const released = removeClaims(ctx, w.owner);
  say(`\n  Released ${released.length} claim(s): ${released.join(", ") || "none"}`);

  // Worktree removal is last: if it fails, the work is already safely in main.
  if (!gitLive(["worktree", "remove", w.path], ctx.root)) {
    say(`\n  Could not remove the worktree — uncommitted changes, probably.`);
    say(`  The merge and push succeeded and the claims are released.`);
    say(`  To force it:  git worktree remove --force "${w.path}"`);
    return "partial";
  }
  if (!gitLive(["branch", "-d", w.branch], ctx.root)) {
    say(`\n  Branch ${w.branch} not deleted — it may hold commits not in ${BASE}.`);
    say(`  To force it:  git branch -D ${w.branch}`);
    return "partial";
  }
  return "done";
}

function doCheckpoint(w, ctx) {
  heading(`Checkpoint — ${w.owner}`);
  say("Only the paths you name are committed. Everything else stays in the worktree.");

  if (!w.dirty.length) {
    say("\nNothing is uncommitted in this worktree.");
  } else {
    say("\nUncommitted here:");
    w.dirty.forEach((f, i) => say(`  [${i + 1}] ${f.status.trim()} ${f.path}`));
  }

  const picked = ask("\nPaths to commit (numbers or paths, space separated): ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const n = Number(token);
      return Number.isInteger(n) && w.dirty[n - 1] ? w.dirty[n - 1].path : token;
    });

  if (!picked.length) return "cancelled";

  const unknown = picked.filter((p) => !w.dirty.some((f) => f.path === p));
  if (unknown.length) {
    say(`\nNot changed in this worktree: ${unknown.join(", ")}`);
    if (!confirm("Carry on without them?")) return "cancelled";
  }
  const paths = picked.filter((p) => !unknown.includes(p));
  if (!paths.length) return "cancelled";

  let dbToRelease = [];
  if (w.db.length) {
    say(`\n${w.owner} holds these database claims:`);
    w.db.forEach((item, i) => say(`  [${i + 1}] ${item}`));
    const answer = ask(
      "Release which? (numbers, 'all', or enter for none): ",
    ).trim();
    if (answer.toLowerCase() === "all") dbToRelease = [...w.db];
    else if (answer) {
      dbToRelease = answer
        .split(/\s+/)
        .map((t) => (w.db[Number(t) - 1] ? w.db[Number(t) - 1] : t))
        .filter((item) => w.db.includes(item));
    }
  }

  heading("About to");
  say(`Commit  ${paths.length} path(s): ${paths.join(", ")}`);
  say(`Merge   ${w.branch} into ${BASE}, then push.`);
  say(
    `Release ${dbToRelease.length} database claim(s)${dbToRelease.length ? `: ${dbToRelease.join(", ")}` : ""}.`,
  );
  say(`Keep    the worktree and every file claim ${w.owner} holds.`);

  if (!confirm("\nDo all of that?")) return "cancelled";

  const message = ask("Commit message: ").trim();
  if (!message) return "cancelled";
  if (!commitIn(w, paths, message)) return "failed";
  if (!mergeAndPush(w, ctx.root)) return "failed";

  if (dbToRelease.length) {
    const released = removeClaims(ctx, w.owner, (item) =>
      dbToRelease.includes(item),
    );
    say(`\n  Released ${released.join(", ")}`);
  }
  say(`\n  ${w.owner} keeps its file claims. The worktree is still open.`);
  return "done";
}

function main() {
  const ctx = resolveRepo();

  heading("gitpush");
  if (ctx.isWorktree) {
    stop(
      `Run gitpush from the main checkout, not from inside a worktree —\n` +
        `it merges worktree branches into ${BASE}, which lives there.`,
    );
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], ctx.root);
  if (branch !== BASE) {
    stop(`The main checkout is on "${branch}", not ${BASE}. Switch first.`);
  }

  const state = readState(ctx.file);
  // Main is always listed, first: work that never used a worktree still has to
  // get pushed and still has claims that need releasing.
  const trees = listWorktrees().map((t) => summarise(t, state));

  say(`\n${trees.length} checkout(s):`);
  trees.forEach((w, i) => showTree(w, i + 1));

  const pick = ask(
    "\nWhich? (numbers space separated, 'all', or enter to cancel): ",
  ).trim();
  if (!pick) stop("Cancelled. Nothing changed.", 0);

  const chosen =
    pick.toLowerCase() === "all"
      ? trees
      : pick
          .split(/\s+/)
          .map((t) => trees[Number(t) - 1])
          .filter(Boolean);

  if (!chosen.length) stop("Nothing recognised in that. Nothing changed.", 0);

  // One at a time, stopping at the first problem: a half-done merge queue is
  // much harder to reason about than one that stopped where it broke.
  for (const w of chosen) {
    if (!w.branch) {
      stop(`${w.owner} has a detached HEAD — no branch to work with. Stopping.`);
    }

    const mode = w.isMain
      ? choose(`\nmain: push / finish / skip`, [
          { key: "p", label: "push" },
          { key: "f", label: "finish" },
          { key: "s", label: "skip" },
        ])
      : choose(`\n${w.owner}: finish / checkpoint / skip`, [
          { key: "f", label: "finish" },
          { key: "c", label: "checkpoint" },
          { key: "s", label: "skip" },
        ]);

    if (mode === null || mode === "s") {
      say(`  Skipped ${w.owner}.`);
      continue;
    }

    let result;
    if (w.isMain) result = doMain(w, ctx, mode === "f");
    else result = mode === "f" ? doFinish(w, ctx) : doCheckpoint(w, ctx);

    if (result === "failed") {
      stop(`\nStopped at ${w.owner}. Nothing further was attempted.`, 1);
    }
    if (result === "cancelled") say(`  Cancelled ${w.owner}. Nothing changed for it.`);
    if (result === "partial") {
      stop(`\n${w.owner} is merged and pushed but not fully cleaned up. Stopping.`, 1);
    }
  }

  say("\nDone.");
}

main();
