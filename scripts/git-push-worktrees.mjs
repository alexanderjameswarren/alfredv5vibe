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
  withLock,
} from "./lib/claims-core.mjs";
import { collectFinishSummary, queueOverwatch, sendPlanLine, sendsFor } from "./lib/finish-summary.mjs";
import { buildInventory } from "./lib/inventory.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { clearMainCode, readMainCode } from "./lib/project-code.mjs";
import {
  SNAPSHOT_PATH,
  commitWithSnapshot,
  mergeBranch,
  readSnapshotThrough,
  snapshotDecision,
  worktreeMergeWithSnapshot,
} from "./lib/schema-snapshot.mjs";
import {
  addPaths,
  ask,
  askMessage,
  askSelection,
  changedFiles,
  choose,
  exclusive,
  expandPathWords,
  applyDocsMove,
  docsClashRefusal,
  docsMovePaths,
  forceDecision,
  leftBehindRefusal,
  planDocsMove,
  withoutMoved,
  findCheckout,
  finishFromInside,
  misplacedOptions,
  modeKey,
  parseArgs,
  parseSelection,
  pickCheckouts,
  removeEmptyDir,
  resultExit,
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
  --no-snapshot                          Checkpoint: skip the schema snapshot (no Docker);
                                         its label stays behind until a push with a migration
  --include-unclaimed all|none|<paths…>  main: changes nobody claimed
  --message, -m "..."                    the commit message
  --dry-run                              show the plan, then stop: nothing changes
  --pretend-migration <n>                with --dry-run: plan as if migration n were included
  --help, -h

  Anything not given is asked. The plan and the final yes/no are always shown —
  a parameter answers a question, it does not skip the confirmation.

  gitpush rem-j7p checkpoint --paths supabase/migrations/084_x.sql --release-db`;

/** The command line, resolved. Read by the three mode functions below. */
let OPTS = {};

/**
 * Refuse an option the chosen mode will not read.
 *
 * `--release-db` on a Finish, or `--paths` on a Push, is the same failure as a
 * misspelled flag: Alex asked for something specific and nothing would happen.
 * Checked however the mode was chosen, since he can name one on the command
 * line and pick another at the prompt.
 */
function checkOptionsFor(mode, w) {
  const refusal = misplacedOptions(mode, w, OPTS);
  if (refusal) stop(refusal, 2);
  if (OPTS["no-snapshot"] && mode !== "c" && mode !== "s") {
    stop(`--no-snapshot is for a worktree Checkpoint only, not ${w.isMain ? "main" : `a Finish of ${w.owner}`}.\nNothing was changed.`, 2);
  }
}

/** Refuse a Finish run from inside the worktree it removes, before anything is asked. */
function checkFinishFrom(mode, w, mainPath) {
  const refusal = mode === "f" ? finishFromInside(w, { cwd: process.cwd(), mainPath }) : null;
  if (refusal) stop(refusal, 1);
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
  // A count, not the list: main held 30 claims here and the paths filled the
  // screen, pushing the question itself out of view.
  say(
    w.files.length
      ? `      claims  ${w.files.length} — claims.mjs status for the list`
      : `      claims  none`,
  );
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
  if (!addPaths(w.path, paths)) {
    say("  git add failed.");
    return false;
  }
  if (!gitLive(["commit", "-m", message], w.path)) {
    say("  git commit failed. Staged files are still staged.");
    return false;
  }
  return true;
}

/** Run npm run schema:snapshot's script in a checkout, labelled through at least `newest`. */
function runSnapshot(cwd, newest) {
  say(`\n  Regenerating ${SNAPSHOT_PATH} (needs Docker)…`);
  const through = Number.isInteger(newest) ? ["--through", String(newest)] : [];
  const r = spawnSync(process.execPath, [path.join(cwd, "scripts", "schema-snapshot.mjs"), ...through], {
    cwd,
    stdio: "inherit",
  });
  return r.status === 0
    ? { ok: true }
    : { ok: false, message: "the schema snapshot failed (see above), so nothing was committed." };
}

/** Merge a worktree's branch into main and push: { merged, pushed }. */
function mergeAndPush(w, root, includeSnapshot = false) {
  if (!mergeBranch((args) => gitLive(args, root), w.branch, includeSnapshot)) {
    const conflicts = tryGit(["diff", "--name-only", "--diff-filter=U"], root);
    say("\n  The merge stopped.");
    if (conflicts.ok && conflicts.stdout) {
      say("  Conflicting files:");
      for (const f of conflicts.stdout.split(/\r?\n/)) say(`    ${f}`);
    }
    say(`  To back out:  git -C "${root}" merge --abort`);
    return { merged: false, pushed: false };
  }
  if (!gitLive(["push"], root)) {
    say("\n  The push failed. The merge is in main locally but not pushed.");
    return { merged: true, pushed: false };
  }
  return { merged: true, pushed: true };
}

/** Every path a worktree's merge would bring into main: its commits plus `toCommit`. */
function mergedPaths(w, toCommit) {
  const r = tryGit(["diff", "--name-only", `${BASE}...HEAD`], w.path);
  const committed = r.ok && r.stdout ? r.stdout.split(/\r?\n/) : [];
  const pretend = OPTS["pretend-migration"];
  const fake = pretend ? [`supabase/migrations/${pretend}_dry_run.sql`] : [];
  return [...new Set([...committed, ...toCommit, ...fake])];
}

/** Keep main's current snapshot so a failure after regenerating can put it back. */
function snapshotKeeper(root) {
  const file = path.join(root, SNAPSHOT_PATH);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  return () => (before === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, before));
}

/**
 * After a push into main: queue the rebuilt inventory, and on a Finish the finish summary, for the detached sender
 * (spec 5.4). Anything that goes wrong here is said and ignored; the push has already happened.
 */
function afterPush(w, mode, result, ctx, { upstreamBefore = null, mainCode = null } = {}) {
  const sends = sendsFor({ mode, result });
  if (!sends.inventory) return;
  const events = [];
  const queued = [];
  try {
    const inv = buildInventory(ctx.root);
    events.push({ _kind: "inventory", parts: inv.parts, open_work: inv.open_work });
    queued.push(`the inventory (${inv.parts.length} parts, ${inv.open_work.length} open-work lines)`);
  } catch (err) {
    say(`\n  Overwatch: the inventory could not be rebuilt (${err.message}); nothing else is affected.`);
  }
  if (sends.summary) {
    const code = w.isMain ? mainCode : w.owner;
    const isMerge = !w.isMain && tryGit(["rev-parse", "--verify", "--quiet", "HEAD^2"], ctx.root).ok;
    const s = !code ? { error: "main has no project code" }
      : !w.isMain && !isMerge ? { error: "main's HEAD is not a merge commit" }
      : collectFinishSummary({
        git: (args) => tryGit(args, ctx.root),
        readFile: (p) => (fs.existsSync(path.join(ctx.root, p)) ? fs.readFileSync(path.join(ctx.root, p), "utf8") : null),
        projectCode: code,
        branch: w.branch,
        base: w.isMain ? upstreamBefore : "HEAD^1",
      });
    if (s.row) {
      events.push({ _kind: "finish_summary", summary: s.row });
      queued.push(`a finish summary for ${s.row.merge_commit.slice(0, 7)} (${s.row.paths.length} paths)`);
    } else {
      say(`\n  Overwatch: no finish summary (${s.error}).`);
    }
  }
  const q = queueOverwatch(ctx, events, { lock: (fn) => withLock(ctx, () => { fn(); return null; }) });
  if (q.error) say(`\n  Overwatch: nothing queued (${q.error}).`);
  else if (q.queued) {
    say(`\n  Overwatch: queued ${queued.join(" and ")}. The sender runs in the background; its log is`);
    say(`    ${ctx.outboxFile}.log`);
  }
}

/** --dry-run stops at the plan, before the yes/no and before anything changes. */
function dryRunStop() {
  if (!OPTS["dry-run"]) return false;
  say("\n--dry-run: stopping here. Nothing was committed, merged, pushed or released.");
  return true;
}

/** The plan line, and the worktree merge run with the snapshot when it is needed. */
function snapshotPlan(w, root, toCommit) {
  const through = readSnapshotThrough(root);
  const decision = snapshotDecision(mergedPaths(w, toCommit), through, { skip: !!OPTS["no-snapshot"] });
  if (decision.run) {
    say(`Snapshot regenerate ${SNAPSHOT_PATH} in main, into the merge commit, through migration ${decision.newest} — ${decision.reason}.`);
  } else if (decision.skipped) {
    say(`Snapshot skipped — ${decision.reason}.`);
  }
}

function mergeWorktree(w, ctx, toCommit, commitWorktree) {
  const result = worktreeMergeWithSnapshot(mergedPaths(w, toCommit), {
    through: readSnapshotThrough(ctx.root),
    skip: !!OPTS["no-snapshot"],
    runSnapshot: (newest) => runSnapshot(ctx.root, newest),
    restoreSnapshot: snapshotKeeper(ctx.root),
    commitWorktree,
    merge: (includeSnapshot) => mergeAndPush(w, ctx.root, includeSnapshot),
  });
  if (result.message) say(`\n  Stopped: ${result.message} Main and ${w.owner} are unchanged.`);
  return result.ok;
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

  // Finish closes main's project: its docs go to docs/history/, as a worktree's do.
  const code = release ? readMainCode(ctx) : null;
  const docs = code ? planDocsMove(code, w.path, w.path) : { moves: [], missing: [], clashes: [] };
  const clash = docsClashRefusal(docs, `main (${code})`);
  if (clash) stop(clash, 1);
  const dirty = withoutMoved(w.dirty, docs.moves);

  let staging = [];
  if (dirty.length) {
    const state = readState(ctx.file);
    const parts = partitionByClaims(state, "main", dirty);
    staging = selectByClaims({
      owner: "main",
      ...parts,
      include: OPTS["include-unclaimed"],
    });
  } else {
    say(`\nNothing ${docs.moves.length ? "else " : ""}is uncommitted here.`);
  }

  const all = [...w.files, ...w.db];
  heading("About to");
  if (staging.length) {
    say(`Commit  ${staging.length} file(s):`);
    for (const f of staging) say(`          ${describeFile(f)}`);
  } else if (!docs.moves.length) {
    say("Commit  nothing — no changes selected.");
  }
  for (const m of docs.moves) say(`Move    ${m.from} → ${m.to}  (in the same commit)`);
  for (const f of docs.missing) say(`  No ${f} here — nothing to move for it.`);
  if (release && !code) say(`  main has no project code, so there are no project docs to move.`);
  const through = readSnapshotThrough(w.path);
  const pretend = OPTS["pretend-migration"];
  const snap = snapshotDecision(
    [...staging.map((f) => f.path), ...(pretend ? [`supabase/migrations/${pretend}_dry_run.sql`] : [])],
    through,
  );
  if (snap.run) say(`Snapshot regenerate ${SNAPSHOT_PATH} into the same commit — ${snap.reason}.`);
  if (dryRunStop()) return "cancelled";
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
  say(sendPlanLine(release ? "f" : "p"));

  if (!confirm("\nDo all of that?")) return "cancelled";

  let toCommit = staging.map((f) => f.path);
  if (docs.moves.length) {
    try {
      applyDocsMove(w.path, docs.moves);
    } catch (err) {
      say(`\n  Could not move the docs: ${err.message}`);
      return "failed";
    }
    toCommit = [...new Set([...toCommit, ...docsMovePaths(docs.moves, changedFiles(w.path))])];
    say(`\n  Moved ${docs.moves.length} doc(s) into docs/history/.`);
  }

  if (toCommit.length) {
    const message =
      OPTS.message ?? askMessage(readMainCode(ctx) ?? "main", release ? "finish" : "push");
    // A commit carrying a newer migration takes the regenerated snapshot with it;
    // if the snapshot fails, nothing is committed.
    const result = commitWithSnapshot(toCommit, {
      through,
      runSnapshot: (newest) => runSnapshot(w.path, newest),
      commit: (paths) => stageAndCommit(w.path, paths, message),
    });
    if (result.message) say(`\n  Stopped: ${result.message}`);
    if (!result.ok) return "failed";
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
  if (gitLive(["worktree", "remove", w.path], ctx.root)) return clearLeftover(w);

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

  // --force deletes uncommitted work too, so only when git status is clean.
  const forcing = forceDecision(changedFiles(w.path));
  say(`\n  Plain removal refused. ${forcing.why}`);
  if (!forcing.force) {
    say(`\n  Not forcing. The merge, the push and the claim release all succeeded;`);
    say(`  commit those with gitcom in the worktree, or delete them, then remove it:`);
    say(`    git -C "${winPath(ctx.root)}" worktree remove "${winPath(w.path)}"`);
    say(`    git -C "${winPath(ctx.root)}" branch -d ${w.branch}`);
    return false;
  }
  say(`  Trying --force.`);
  if (gitLive(["worktree", "remove", "--force", w.path], ctx.root)) return clearLeftover(w);

  // git can fail after emptying the folder, when only the folder itself is held
  // open. If it is empty or gone now, only git's own record is left to prune.
  const left = removeEmptyDir(w.path);
  if (left === "removed" || left === "gone") {
    say(`\n  The folder is ${left === "gone" ? "gone" : "empty and now removed"}; pruning git's record of it.`);
    if (gitLive(["worktree", "prune"], ctx.root)) return true;
  }

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

/**
 * After a successful `git worktree remove`, delete the folder if Windows left it
 * behind empty (switchboard_stale: it kept a "no status" row in Switchboard).
 * The worktree itself is gone either way, so this never fails the Finish.
 */
function clearLeftover(w) {
  const left = removeEmptyDir(w.path);
  if (left === "removed") say(`\n  Removed the empty folder git left behind.`);
  if (left === "busy" || left === "not-empty") {
    say(`\n  git removed the worktree but its folder is still there (${left}).`);
    say(`  Close whatever has it open, then:  Remove-Item -Recurse -Force "${winPath(w.path)}"`);
  }
  return true;
}

const winPath = (p) => p.replace(/\//g, "\\");

function doFinish(w, ctx) {
  heading(`Finish — ${w.owner}`);

  // The project's spec and progress go to docs/history/ in the Finish commit.
  // A same-named file already there is refused now, before anything changes.
  const docs = planDocsMove(w.owner, w.path, ctx.root);
  const clash = docsClashRefusal(docs, w.owner);
  if (clash) stop(clash, 1);

  // Finish commits what this worktree claimed and has changed. Anything it did
  // not claim is left where it is; gitcom is where unclaimed files get decided.
  // The docs it moves are listed once, as moves, whoever claimed them.
  const dirty = withoutMoved(w.dirty, docs.moves);
  const claimedChanges = dirty.filter((f) =>
    w.files.some((item) => f.path === item || (item.endsWith("/") && f.path.startsWith(item))),
  );
  const leftBehind = dirty.filter((f) => !claimedChanges.includes(f));
  // Anything left uncommitted dies with the worktree, so it is refused now.
  const kept = leftBehindRefusal(w.owner, leftBehind);
  if (kept) stop(kept, 1);

  say(`Commit  ${claimedChanges.length} claimed change(s):`);
  for (const f of claimedChanges) say(`          ${f.status.trim()} ${f.path}`);
  for (const m of docs.moves) say(`Move    ${m.from} → ${m.to}  (in the same commit)`);
  for (const f of docs.missing) say(`  No ${f} here — nothing to move for it.`);
  say(`\nMerge   ${w.branch} into ${BASE}, then push.`);
  snapshotPlan(w, ctx.root, claimedChanges.map((f) => f.path));
  say(`Release all ${w.files.length + w.db.length} claim(s) held by ${w.owner}.`);
  say(`Remove  the worktree, then delete branch ${w.branch}.`);
  say(sendPlanLine("f"));
  if (dryRunStop()) return "cancelled";

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
  // A terminal inside the worktree was refused before this: checkFinishFrom.

  if (!confirm("\nClosed? Do all of that?")) return "cancelled";

  const claimedPaths = claimedChanges.map((f) => f.path);
  const message =
    claimedPaths.length || docs.moves.length ? OPTS.message ?? askMessage(w.owner, "finish") : null;

  // The docs move is part of the worktree commit, so it runs only after the
  // snapshot (if one is needed) has succeeded.
  const commitWorktree = () => {
    let toCommit = claimedPaths;
    if (docs.moves.length) {
      try {
        applyDocsMove(w.path, docs.moves);
      } catch (err) {
        say(`\n  Could not move the docs: ${err.message}`);
        return false;
      }
      toCommit = [...new Set([...toCommit, ...docsMovePaths(docs.moves, changedFiles(w.path))])];
      say(`\n  Moved ${docs.moves.length} doc(s) into docs/history/.`);
    }
    return toCommit.length ? commitIn(w, toCommit, message) : true;
  };
  if (!mergeWorktree(w, ctx, claimedPaths, commitWorktree)) return "failed";

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
    // A folder names every changed file under it.
    const sel = parseSelection(OPTS.paths, w.dirty.length);
    const named = expandPathWords([...sel.words, ...sel.bad], w.dirty);
    if (named.unknown.length) {
      throw new UsageError(`--paths: not changed in ${w.owner}: ${named.unknown.join(", ")}`);
    }
    picked = sel.all
      ? w.dirty.map((f) => f.path)
      : [...sel.indexes.map((n) => w.dirty[n - 1].path), ...named.paths];
    say(`\n--paths: ${picked.length} path(s).`);
  } else {
    const chosen = askSelection(
      "\nPaths to commit (numbers, ranges like 1-3, paths, or 'all'): ",
      w.dirty,
      `Commit all ${w.dirty.length} path(s) listed above?`,
    );
    if (chosen === null) return "cancelled";

    const typed = expandPathWords([...chosen.words, ...chosen.bad], w.dirty);
    if (!chosen.all && typed.unknown.length) {
      say(`\nNot changed in this worktree: ${typed.unknown.join(", ")}`);
      if (!confirm("Carry on without them?")) return "cancelled";
    }
    picked = chosen.all
      ? chosen.picked.map((f) => f.path)
      : [...chosen.picked.map((f) => f.path), ...typed.paths];
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
  snapshotPlan(w, ctx.root, paths);
  say(
    `Release ${dbToRelease.length} database claim(s)${dbToRelease.length ? `: ${dbToRelease.join(", ")}` : ""}.`,
  );
  const dbKept = w.db.filter((item) => !dbToRelease.includes(item));
  if (dbKept.length) {
    say(`        KEEPING ${dbKept.join(", ")} — re-claim at the next step instead.`);
  }
  say(`Keep    the worktree and every file claim ${w.owner} holds.`);
  say(sendPlanLine("c"));
  if (dryRunStop()) return "cancelled";

  if (!confirm("\nDo all of that?")) return "cancelled";

  const message = OPTS.message ?? askMessage(w.owner, "checkpoint");
  if (!mergeWorktree(w, ctx, paths, () => commitIn(w, paths, message))) return "failed";

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
        "no-snapshot": { kind: "bool" },
        "include-unclaimed": { kind: "list" },
        "dry-run": { kind: "bool" },
        "pretend-migration": { kind: "value" },
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
  const pretend = args.options["pretend-migration"];
  if (pretend !== undefined && (!args.options["dry-run"] || !/^\d+$/.test(pretend))) {
    stop("--pretend-migration takes a number and only works with --dry-run.\nNothing was changed.", 2);
  }
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

  const [wantedCheckout, wantedMode] = args.positionals;

  // Checked BEFORE the listing is printed. A refusal buried under thirty lines
  // of checkout detail reads as though something happened; on its own it reads
  // as the command not having run, which is what it is.
  let named = null;
  if (wantedCheckout) {
    const found = findCheckout(wantedCheckout, summarised);
    if (found.refusal) stop(found.refusal, 2);
    named = found.checkout;
    if (wantedMode) {
      // Throws a UsageError for checkpoint-on-main and push-on-a-worktree,
      // caught below, before a single line of the listing is printed.
      const mode = modeKey(wantedMode, named);
      checkOptionsFor(mode, named);
      checkFinishFrom(mode, named, ctx.root);
    }
  }

  say(`\n${summarised.length} checkout(s):`);
  summarised.forEach((w, i) => showTree(w, i + 1));

  let chosen;
  if (named) {
    chosen = [named];
    say(`\nChosen on the command line: ${named.owner}`);
  } else {
    // The one blank answer that still cancels, because the prompt says so and
    // because this is the question before anything has been decided — there is
    // no earlier answer for it to throw away.
    const picked = pickCheckouts(
      ask("\nWhich? (numbers, ranges, names, 'all', or enter to cancel): "),
      summarised,
    );
    if (picked.cancel) stop(picked.cancel, 0);
    if (picked.refusal) stop(picked.refusal, 2);
    if (picked.unrecognised.length) say(`\n  Not a checkout here: ${picked.unrecognised.join(", ")}`);
    chosen = picked.chosen;
  }

  const done = [];

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
    checkFinishFrom(mode, w, ctx.root);

    // Read before the run: a main Finish clears the code, and its push moves the upstream.
    const upstream = w.isMain && mode === "f" ? tryGit(["rev-parse", "@{u}"], w.path) : null;
    const mainCode = w.isMain ? readMainCode(ctx) : null;

    let result;
    if (w.isMain) result = doMain(w, ctx, mode === "f");
    else result = mode === "f" ? doFinish(w, ctx) : doCheckpoint(w, ctx);
    afterPush(w, mode, result, ctx, { upstreamBefore: upstream?.ok ? upstream.stdout : null, mainCode });

    const remaining = chosen.slice(chosen.indexOf(w) + 1).map((t) => t.owner);
    const end = resultExit(result, w.owner, { done, remaining });
    if (end) stop(end.message, end.code);
    done.push(w.owner);
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
