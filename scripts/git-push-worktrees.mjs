#!/usr/bin/env node
// gitpush — bring a worktree's work into main and push it.
//
// Alex runs this, from the main checkout. No CLI thread runs it; see
// scripts/lib/git-flow.mjs.
//
// Usage:  node scripts/git-push-worktrees.mjs [checkout] [mode] [options]
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
//               and release the worktree's db: claims, which defaults to all of
//               them. The worktree stays, and everything else in it stays
//               uncommitted, keeping its file claims.
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
  fold,
  isDbItem,
  partitionByClaims,
  readState,
  removeClaims,
  resolveRepo,
} from "./lib/claims-core.mjs";
import { clearMainCode, readMainCode } from "./lib/project-code.mjs";
import {
  ask,
  askMessage,
  askSelection,
  changedFiles,
  choose,
  exclusive,
  parseArgs,
  parseSelection,
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
  UsageError,
} from "./lib/git-flow.mjs";

const BASE = "main";

const USAGE = `gitpush — bring work into main and push it.

  gitpush [checkout] [mode] [options]

  checkout   a worktree name, "main", or its number in the list
  mode       push | finish | checkpoint | skip
               main:     push (keep its claims) | finish (release them)
               worktree: checkpoint (named paths, worktree stays) | finish

  --paths <paths or numbers…>            Checkpoint: what to commit
  --all                                  Checkpoint: every uncommitted path
  --release-db / --keep-db               Checkpoint: the db: claims
  --include-unclaimed all|none|<paths…>  main: changes nobody claimed
  --message, -m "..."                    the commit message
  --help, -h

  Anything not given is asked. The plan and the final yes/no are always shown —
  a parameter answers a question, it does not skip the confirmation.

  gitpush rem-j7p checkpoint --paths supabase/migrations/084_x.sql --release-db`;

/** The command line, resolved. Read by the three mode functions below. */
let OPTS = {};

const MODE_KEYS = { push: "p", finish: "f", checkpoint: "c", skip: "s" };
const MODE_NAME = { p: "push", f: "finish", c: "checkpoint", s: "skip" };

/**
 * Refuse an option the chosen mode will not read.
 *
 * `--release-db` on a Finish, or `--paths` on a Push, is the same failure as a
 * misspelled flag: Alex asked for something specific and nothing would happen.
 * Checked however the mode was chosen, since he can name one on the command
 * line and pick another at the prompt.
 */
function checkOptionsFor(mode, w) {
  if (mode === "s") return;
  const misplaced = [];
  if (mode !== "c") {
    for (const name of ["paths", "all", "release-db", "keep-db"]) {
      if (OPTS[name] !== undefined) misplaced.push(`--${name}`);
    }
  }
  if (!w.isMain && OPTS["include-unclaimed"] !== undefined) {
    misplaced.push("--include-unclaimed");
  }
  if (misplaced.length) {
    stop(
      `\n${misplaced.join(", ")} ${misplaced.length > 1 ? "are" : "is"} not used by ` +
        `${MODE_NAME[mode]}${w.isMain ? " on main" : ` on ${w.owner}`}.\n` +
        `Nothing was changed.`,
      2,
    );
  }
}

/** Turn a mode word into the key the rest of this file uses. */
function modeKey(word, w) {
  const key = MODE_KEYS[String(word).toLowerCase()];
  if (!key) {
    throw new UsageError(`"${word}" is not a mode. Use push, finish, checkpoint or skip.`);
  }
  if (w.isMain && key === "c") {
    throw new UsageError(`Checkpoint is for a worktree. main takes push or finish.`);
  }
  if (!w.isMain && key === "p") {
    throw new UsageError(`Push is for the main checkout. ${w.owner} takes checkpoint or finish.`);
  }
  return key;
}

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
  if (w.lockReason !== null) {
    say(`      LOCKED  ${w.lockReason || "(no reason given)"}`);
  }
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
    staging = selectByClaims({
      owner: "main",
      ...parts,
      include: OPTS["include-unclaimed"],
    });
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
    const message =
      OPTS.message ?? askMessage(readMainCode(ctx) ?? "main", release ? "finish" : "push");
    if (!stageAndCommit(w.path, staging.map((f) => f.path), message)) return "failed";
  }

  if (!gitLive(["push"], w.path)) {
    say("\n  The push failed. Anything committed above is still committed locally.");
    return "failed";
  }

  if (release) {
    const released = removeClaims(ctx, "main");
    say(`\n  Released ${released.length} claim(s): ${released.join(", ") || "none"}`);
    // Finish means this project is done here, so main stops belonging to it and
    // the next tagged prompt is free to set a new one.
    const had = readMainCode(ctx);
    if (clearMainCode(ctx) && had) {
      say(`  Cleared main's project code ("${had}"). The next tagged prompt sets a new one.`);
    }
  } else {
    say(`\n  Claims kept. gitpush Finish is what releases them.`);
  }
  return "done";
}

/**
 * Remove a finished worktree, trying plain then forced, and printing the manual
 * recovery if both fail.
 *
 * Both failures happened for real in the Step 7 dry run: the plain remove
 * refused because a file showed as modified (a line-ending flip, now settled by
 * .gitattributes), and the forced remove then hit "Permission denied" because a
 * VS Code window still had the folder open. Neither costs any work — the merge
 * and push are already done by this point — but the leftover folder and the
 * stale `git worktree list` entry both have to go, and the two commands that do
 * it are not obvious.
 */
function removeWorktree(w, ctx) {
  if (gitLive(["worktree", "remove", w.path], ctx.root)) return true;

  // A LOCKED worktree is a different problem from a busy one, and git says so
  // rather than saying "permission denied". `claude --worktree` locks the tree
  // for as long as its session is alive, so --force will not help until that
  // session exits and the lock is lifted.
  if (w.lockReason !== null) {
    say(`\n  This worktree is LOCKED, so it cannot be removed yet.`);
    say(`    reason: ${w.lockReason || "(git gave no reason)"}`);
    if (/claude/i.test(w.lockReason || "")) {
      say(`\n  That is a Claude Code session still running in it. Exit that session`);
      say(`  — close the window or press Ctrl-C twice — and it may clear by itself.`);
    }
    say(`\n  The merge, the push and the claim release all succeeded. To finish up:`);
    say(``);
    say(`    git -C "${winPath(ctx.root)}" worktree unlock "${winPath(w.path)}"`);
    say(`    git -C "${winPath(ctx.root)}" worktree remove --force "${winPath(w.path)}"`);
    say(`    git -C "${winPath(ctx.root)}" branch -d ${w.branch}`);
    say(``);
    say(`  If the remove still refuses because something has the folder open:`);
    say(`    Remove-Item -Recurse -Force "${winPath(w.path)}"`);
    say(`    git -C "${winPath(ctx.root)}" worktree prune`);
    return false;
  }

  say(`\n  Plain removal refused. Trying --force (the work is already in ${BASE}).`);
  if (gitLive(["worktree", "remove", "--force", w.path], ctx.root)) return true;

  say(`\n  Could not remove the worktree. Something still has the folder open —`);
  say(`  a VS Code window or a terminal sitting in it${w.isCurrent ? ", this one included" : ""}.`);
  say(`\n  The merge, the push and the claim release all succeeded. Only the`);
  say(`  folder is left. Close whatever has it open, then run these two:`);
  say(``);
  say(`    Remove-Item -Recurse -Force "${winPath(w.path)}"`);
  say(`    git -C "${winPath(ctx.root)}" worktree prune`);
  say(``);
  say(`  Then delete the branch:  git branch -d ${w.branch}`);
  return false;
}

const winPath = (p) => p.replace(/\//g, "\\");

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

  // Windows will not delete a folder anything still has open, and in the Step 7
  // dry run that was a VS Code window sitting in the worktree. Better asked now
  // than discovered after the merge and push have already happened.
  say(`\n⚠  Exit the Claude session in that worktree and close any VS Code window`);
  say(`   or terminal open on:`);
  say(`     ${w.path}`);
  if (w.lockReason !== null) {
    say(`   git says it is LOCKED: ${w.lockReason || "(no reason given)"}`);
    say(`   A running Claude session holds that lock until it exits.`);
  }
  if (w.isCurrent) {
    say(`   That includes THIS terminal, which is inside it. Removal will fail`);
    say(`   from here — the merge, push and release will still work, and the`);
    say(`   recovery commands will be printed.`);
  }

  if (!confirm("\nClosed? Do all of that?")) return "cancelled";

  if (claimedChanges.length) {
    const message = OPTS.message ?? askMessage(w.owner, "finish");
    if (!commitIn(w, claimedChanges.map((f) => f.path), message)) return "failed";
  }
  if (!mergeAndPush(w, ctx.root)) return "failed";

  const released = removeClaims(ctx, w.owner);
  say(`\n  Released ${released.length} claim(s): ${released.join(", ") || "none"}`);

  // Worktree removal is last: if it fails, the work is already safely in main.
  if (!removeWorktree(w, ctx)) return "partial";

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

  let picked;
  if (OPTS.all) {
    picked = w.dirty.map((f) => f.path);
    say(`\n--all: every one of the ${picked.length} path(s) above.`);
  } else if (OPTS.paths) {
    // Given on the command line, so a path that is not here is a typo, and a
    // typo'd migration path silently dropped is the whole reason this is an
    // error rather than a shrug.
    const sel = parseSelection(OPTS.paths.join(" "), w.dirty.length);
    const named = [...sel.words, ...sel.bad].filter(
      (p) => !w.dirty.some((f) => f.path === p),
    );
    if (named.length) {
      throw new UsageError(`--paths: not changed in ${w.owner}: ${named.join(", ")}`);
    }
    picked = sel.all
      ? w.dirty.map((f) => f.path)
      : [...sel.indexes.map((n) => w.dirty[n - 1].path), ...sel.words];
    say(`\n--paths: ${picked.length} path(s).`);
  } else {
    const chosen = askSelection(
      "\nPaths to commit (numbers, ranges like 1-3, paths, or 'all'): ",
      w.dirty,
      `Commit all ${w.dirty.length} path(s) listed above?`,
    );
    if (chosen === null) return "cancelled";

    const answered = chosen.all
      ? chosen.picked.map((f) => f.path)
      : [...chosen.picked.map((f) => f.path), ...chosen.words, ...chosen.bad];

    const unknown = answered.filter((p) => !w.dirty.some((f) => f.path === p));
    if (unknown.length) {
      say(`\nNot changed in this worktree: ${unknown.join(", ")}`);
      if (!confirm("Carry on without them?")) return "cancelled";
    }
    picked = answered.filter((p) => !unknown.includes(p));
  }

  const paths = [...new Set(picked)];
  if (!paths.length) {
    say("\nNothing to commit.");
    return "cancelled";
  }

  // A database claim belongs to ONE step. Releasing them here is the default
  // rather than the exception because the alternative already happened: a thread
  // kept db:deploy across steps for thirteen hours and blocked another thread's
  // deploy for all of them, and every prompt along the way let it, because
  // "enter for none" was the easy answer.
  let dbToRelease = [...w.db];
  if (w.db.length && OPTS["keep-db"]) {
    dbToRelease = [];
    say(`\n--keep-db: keeping ${w.db.join(", ")}.`);
  } else if (w.db.length && OPTS["release-db"]) {
    say(`\n--release-db: releasing ${w.db.join(", ")}.`);
  } else if (w.db.length) {
    say(`\n${w.owner} holds these database claims:`);
    w.db.forEach((item, i) => say(`  [${i + 1}] ${item}`));
    say("A db: claim belongs to the step that deployed it — re-claim at the next one.");
    const answer = ask("Release which? (enter for ALL, 'none', numbers or ranges): ");
    const sel = parseSelection(answer, w.db.length);
    if (/^none$/i.test(answer)) dbToRelease = [];
    else if (!sel.blank && !sel.all) {
      dbToRelease = [
        ...sel.indexes.map((n) => w.db[n - 1]),
        ...sel.words.filter((t) => w.db.includes(t)),
      ];
    }
  }

  heading("About to");
  say(`Commit  ${paths.length} path(s): ${paths.join(", ")}`);
  say(`Merge   ${w.branch} into ${BASE}, then push.`);
  say(
    `Release ${dbToRelease.length} database claim(s)${dbToRelease.length ? `: ${dbToRelease.join(", ")}` : ""}.`,
  );
  const dbKept = w.db.filter((item) => !dbToRelease.includes(item));
  if (dbKept.length) {
    say(`        KEEPING ${dbKept.join(", ")} — re-claim at the next step instead.`);
  }
  say(`Keep    the worktree and every file claim ${w.owner} holds.`);

  if (!confirm("\nDo all of that?")) return "cancelled";

  const message = OPTS.message ?? askMessage(w.owner, "checkpoint");
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
  let args;
  try {
    args = parseArgs(
      process.argv.slice(2),
      {
        paths: { kind: "list" },
        all: { kind: "bool" },
        "release-db": { kind: "bool" },
        "keep-db": { kind: "bool" },
        "include-unclaimed": { kind: "list" },
        message: { kind: "value", alias: "m" },
        help: { kind: "bool", alias: "h" },
      },
      { positionals: 2 },
    );
    exclusive(args.options, ["paths", "all"]);
    exclusive(args.options, ["release-db", "keep-db"]);
  } catch (err) {
    if (err instanceof UsageError) stop(`${err.message}\n\n${USAGE}`, 2);
    throw err;
  }
  if (args.options.help) stop(USAGE, 0);
  OPTS = args.options;

  const here = resolveRepo();

  heading("gitpush");

  // gitpush works from any terminal, including one inside a worktree. It always
  // operates on the main checkout, which `git worktree list` names first, so
  // there is nothing to remember about which window you happen to be in.
  // (gitcom and gitsync are deliberately the opposite: they act on the checkout
  // you are standing in.)
  const trees = listWorktrees();
  const mainTree = trees.find((t) => t.isMain);
  if (!mainTree) stop("Could not find the main checkout in `git worktree list`.");

  // owner is pinned to main so nothing downstream can accidentally act as the
  // worktree we happened to be launched from. The claims file itself is shared,
  // so ctx.file and ctx.dir are the same wherever this runs.
  const ctx = { ...here, root: mainTree.path, owner: BASE, isWorktree: false };
  if (here.isWorktree) {
    say(`Run from worktree ${here.owner}; operating on the main checkout.`);
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], ctx.root);
  if (branch !== BASE) {
    stop(`The main checkout is on "${branch}", not ${BASE}. Switch first.`);
  }

  const state = readState(ctx.file);
  // Main is always listed, first: work that never used a worktree still has to
  // get pushed and still has claims that need releasing.
  const summarised = trees.map((t) => ({
    ...summarise(t, state),
    // The terminal we were launched from holds a handle on its own folder, so
    // Windows will not let that folder be deleted while we stand in it.
    isCurrent: fold(t.path) === fold(here.root),
  }));

  say(`\n${summarised.length} checkout(s):`);
  summarised.forEach((w, i) => showTree(w, i + 1));

  const [wantedCheckout, wantedMode] = args.positionals;

  let chosen;
  if (wantedCheckout) {
    const hit = summarised.find(
      (t) =>
        t.owner.toLowerCase() === wantedCheckout.toLowerCase() ||
        (/^\d+$/.test(wantedCheckout) && summarised[Number(wantedCheckout) - 1] === t),
    );
    if (!hit) {
      stop(
        `"${wantedCheckout}" is not one of the checkouts above.\n` +
          `Here: ${summarised.map((t) => t.owner).join(", ")}`,
        2,
      );
    }
    chosen = [hit];
    say(`\nChosen on the command line: ${hit.owner}`);
  } else {
    // The one blank answer that still cancels, because the prompt says so and
    // because this is the question before anything has been decided — there is
    // no earlier answer for it to throw away.
    const sel = parseSelection(
      ask("\nWhich? (numbers, ranges, names, 'all', or enter to cancel): "),
      summarised.length,
    );
    if (sel.blank) stop("Cancelled. Nothing changed.", 0);

    const named = [];
    const unrecognised = [...sel.bad];
    for (const word of sel.words) {
      const hit = summarised.find((t) => t.owner.toLowerCase() === word.toLowerCase());
      if (hit) named.push(hit);
      else unrecognised.push(word);
    }
    if (unrecognised.length) say(`\n  Not a checkout here: ${unrecognised.join(", ")}`);

    chosen = sel.all
      ? summarised
      : [...new Set([...sel.indexes.map((n) => summarised[n - 1]), ...named])];

    if (!chosen.length) stop("Nothing recognised in that. Nothing changed.", 0);
  }

  // One at a time, stopping at the first problem: a half-done merge queue is
  // much harder to reason about than one that stopped where it broke.
  for (const w of chosen) {
    if (!w.branch) {
      stop(`${w.owner} has a detached HEAD — no branch to work with. Stopping.`);
    }

    // Checkpoint before Finish, and Push before Finish: the reversible one
    // first, so the destructive choice is never the one under the cursor.
    // `blank: "s"` — enter skips this checkout, which is the harmless answer and
    // is spelled out in the Skip line. It is the one choose() in these scripts
    // with a default, and it has one because a blank here decides nothing.
    const mode = wantedMode
      ? modeKey(wantedMode, w)
      : w.isMain
      ? choose(`\nmain:`, [
          {
            key: "p",
            label: "Push",
            hint: "commit and push main's changes, keeping its claims (the project is still going)",
          },
          {
            key: "f",
            label: "Finish",
            hint: "commit and push, then release all of main's claims (the project is done)",
          },
          { key: "s", label: "Skip", hint: "leave it alone (enter does this too)" },
        ], { blank: "s" })
      : choose(`\n${w.owner}:`, [
          {
            key: "c",
            label: "Checkpoint",
            hint: "merge only the files you name into main and push, while the worktree carries on",
          },
          {
            key: "f",
            label: "Finish",
            hint: "commit its work, merge it into main, push, release its claims, and remove the worktree",
          },
          { key: "s", label: "Skip", hint: "leave it alone (enter does this too)" },
        ], { blank: "s" });

    if (mode === null || mode === "s") {
      say(`  Skipped ${w.owner}.`);
      continue;
    }
    checkOptionsFor(mode, w);

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

try {
  main();
} catch (err) {
  // A bad command line found late — `--paths` naming a file this worktree has
  // not changed, a mode that does not fit the checkout. Nothing has run by then.
  if (err instanceof UsageError) stop(`\n${err.message}\n\nNothing was changed.`, 2);
  throw err;
}
