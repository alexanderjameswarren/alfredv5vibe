#!/usr/bin/env node
// gitnewtree <project-code> — start a project in its own worktree.
//
// Alex runs this. No CLI thread runs it; see scripts/lib/git-flow.mjs.
//
// Usage:  node scripts/git-new-worktree.mjs claims-wq7
//
// It is the front door for protocol Step 0, doing in one command what was four
// manual ones:
//
//   refuse if main has uncommitted or unpushed work   (Step 0, enforced)
//   fetch, then branch worktree-<code> from origin/main
//   copy everything .worktreeinclude names
//   open it in a new VS Code window
//   say whether dependencies need installing, and offer to do it
//
// `claude --worktree <name>` still works and does most of this. The differences
// are the ones that cost time in the Step 7 dry run: it does not check Step 0, so
// a worktree could branch from a stale origin/main; the folder name is the
// project code the prompt guard checks against, so it wants to be deliberate;
// and it leaves you to notice that node_modules was not copied.

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRepo } from "./lib/claims-core.mjs";
import {
  changedFiles,
  commitsAhead,
  confirm,
  exclusive,
  gitLive,
  heading,
  listWorktrees,
  parseArgs,
  say,
  stop,
  tryGit,
  unpushed,
  UsageError,
} from "./lib/git-flow.mjs";

const BASE = "origin/main";
const CODE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const USAGE = `gitnewtree — start a project in its own worktree.

  gitnewtree <project-code> [options]

  --install                  run npm install in the new worktree, without asking
  --no-install               skip it, without asking
  --help, -h

  The project code names the folder, the branch and the claims owner, and is
  what the prompt guard checks a run tag against. The plan and the final yes/no
  are always shown.`;

const winPath = (p) => p.replace(/\//g, "\\");

/** Windows paths, compared the way Windows means them. */
const samePath = (a, b) =>
  path.resolve(a).replace(/\\/g, "/").toLowerCase() ===
  path.resolve(b).replace(/\\/g, "/").toLowerCase();

/**
 * The git-ignored files .worktreeinclude asks for, resolved against main.
 *
 * `claude --worktree` does this itself; `git worktree add` does not, so this
 * reimplements the same matching: every pattern is handed to `git ls-files
 * --others --ignored --exclude-standard`, which is the list of files git is
 * deliberately not tracking.
 */
function filesToCopy(root) {
  const file = path.join(root, ".worktreeinclude");
  if (!existsSync(file)) return [];
  const patterns = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const found = new Set();
  for (const pattern of patterns) {
    const r = tryGit(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--", pattern],
      root,
    );
    if (!r.ok || !r.stdout) continue;
    for (const f of r.stdout.split(/\r?\n/).filter(Boolean)) found.add(f);
  }
  return [...found];
}

/**
 * "<code>" already has a live worktree. Say so and offer to open its window.
 *
 * Never exits non-zero: the worktree existing is the answer to the question
 * asked, not a failure, and the window is the thing actually wanted.
 */
function openExisting(tree, code, expectedPath) {
  heading(`"${code}" already has a worktree`);
  say(`Folder:   ${winPath(tree.path)}`);
  say(`Branch:   ${tree.branch ?? "(detached)"}`);
  if (tree.lockReason !== null) {
    say(`Locked:   ${tree.lockReason || "(git gave no reason)"}`);
  }
  const dirty = changedFiles(tree.path);
  say(
    dirty.length
      ? `Changes:  ${dirty.length} uncommitted file(s) in it`
      : `Changes:  none, its working tree is clean`,
  );
  if (!samePath(tree.path, expectedPath)) {
    say(`\nIt is not where gitnewtree puts worktrees — expected ${winPath(expectedPath)}.`);
  }

  say(
    `\nThe folder name is the project code and the claims owner, so there is no\n` +
      `other name "${code}" could use: this worktree is where its work belongs.\n` +
      `Nothing has been created or changed.`,
  );

  if (confirm(`\nOpen its VS Code window?`)) {
    const opened = spawnSync("code", ["-n", tree.path], { stdio: "ignore", shell: true });
    say(
      opened.status === 0
        ? `\nOpened ${winPath(tree.path)}`
        : `\nCould not run \`code\` — open it by hand:\n  ${winPath(tree.path)}`,
    );
  } else {
    say(`\n  Later:  code -n "${winPath(tree.path)}"`);
  }

  say(`\nIn that window:  gitsync  to bring main in.`);
  say(`When it is done:  gitpush  →  ${code}  →  Finish`);
  process.exit(0);
}

/**
 * A folder or a branch called "<code>" is left over, but git has no worktree.
 *
 * Nothing is deleted here. A leftover branch can be the only copy of work a
 * Finish never reached, so the commands are printed for Alex to read and run —
 * `branch -d` first, because its refusal is what protects that work.
 */
function leftovers({ code, worktreePath, branch, root, folderLeft, branchLeft }) {
  const ahead = branchLeft ? commitsAhead(branch, BASE, root) : [];

  heading(`"${code}" has leftovers, but no worktree`);
  say(`\`git worktree list\` has no entry for it, so there is no window to open.`);
  say(`In the way:`);
  if (folderLeft) say(`  folder  ${winPath(worktreePath)}`);
  if (branchLeft) {
    say(
      `  branch  ${branch}` +
        (ahead.length
          ? `  —  ${ahead.length} commit(s) that ${BASE} does not have`
          : `  —  nothing ${BASE} does not already have`),
    );
    for (const line of ahead.slice(0, 8)) say(`            ${line}`);
    if (ahead.length > 8) say(`            … and ${ahead.length - 8} more`);
  }

  say(
    `\nThe name cannot change — it is the project code and the claims owner — so\n` +
      `clear the leftovers and run gitnewtree again. Nothing was created or changed.`,
  );

  say(`\nTo clear it:`);
  say(``);
  if (folderLeft) {
    say(`    Remove-Item -Recurse -Force "${winPath(worktreePath)}"`);
    say(`    git -C "${winPath(root)}" worktree prune`);
  }
  if (branchLeft) say(`    git -C "${winPath(root)}" branch -d ${branch}`);
  say(``);

  if (ahead.length) {
    say(`  \`branch -d\` will refuse while those ${ahead.length} commit(s) live only there.`);
    say(`  Read them first:  git -C "${winPath(root)}" log ${branch} --oneline`);
    say(`  Then merge them, or throw them away with:`);
    say(`    git -C "${winPath(root)}" branch -D ${branch}`);
    say(``);
  }
  // gitpush only lists live worktrees, so it cannot release the claims of an
  // owner whose worktree is already gone. `cleanup` is the one that can.
  say(`  Check whether "${code}" still holds claims:  node scripts/claims.mjs status`);
  say(`  gitpush cannot release them once the worktree is gone — that is`);
  say(`    node scripts/claims.mjs cleanup ${code}`);
  say(`  and only once you are sure that work is in ${BASE}.`);

  say(`\nThen:  gitnewtree ${code}`);
  process.exit(1);
}

function main() {
  let args;
  try {
    args = parseArgs(
      process.argv.slice(2),
      {
        install: { kind: "bool" },
        "no-install": { kind: "bool" },
        help: { kind: "bool", alias: "h" },
      },
      { positionals: 1 },
    );
    exclusive(args.options, ["install", "no-install"]);
  } catch (err) {
    if (err instanceof UsageError) stop(`${err.message}\n\n${USAGE}`, 2);
    throw err;
  }
  if (args.options.help) stop(USAGE, 0);

  const code = (args.positionals[0] ?? "").trim();
  // undefined means "ask", which is what it has always done.
  const install = args.options.install ? true : args.options["no-install"] ? false : undefined;

  heading("gitnewtree");

  if (!code) {
    stop(
      `${USAGE}\n\n` +
        "Use the project part of the run tag you will be working under, e.g.\n" +
        "`gitnewtree claims-wq7`.",
      2,
    );
  }
  if (!CODE.test(code)) {
    stop(
      `"${code}" is not a usable project code.\n` +
        "Lower case letters, digits and hyphens, 2 to 41 characters.",
      2,
    );
  }

  // Always act on the main checkout, wherever this was run from.
  const here = resolveRepo();
  const trees = listWorktrees();
  const mainTree = trees.find((t) => t.isMain);
  if (!mainTree) stop("Could not find the main checkout in `git worktree list`.");
  const root = mainTree.path;
  if (here.isWorktree) say(`Run from a worktree; branching from the main checkout.`);

  const worktreePath = path.join(root, ".claude", "worktrees", code);
  const branch = `worktree-${code}`;

  // --- is "<code>" already taken? -------------------------------------------
  // The folder name is the project code AND the claims owner, so there is no
  // second name to fall back to. "Pick another code" was the wrong answer, and
  // git's own error for a path that exists is worse. Two different situations
  // hide behind one raw failure, so they are told apart and answered here.
  const existing = trees.find(
    (t) => !t.isMain && (samePath(t.path, worktreePath) || t.branch === branch),
  );
  if (existing) openExisting(existing, code, worktreePath);

  const folderLeft = existsSync(worktreePath);
  const branchLeft = tryGit(["rev-parse", "--verify", branch], root).ok;
  if (folderLeft || branchLeft) {
    leftovers({ code, worktreePath, branch, root, folderLeft, branchLeft });
  }

  // --- protocol Step 0 -------------------------------------------------------
  // A worktree branches from origin/main, so anything sitting in main that is
  // not pushed is invisible to it. Enforced here rather than remembered.
  const dirty = changedFiles(root);
  const ahead = unpushed(root);
  if (dirty.length || ahead.commits.length) {
    heading("Main is not ready (protocol Step 0)");
    if (dirty.length) {
      say(`${dirty.length} uncommitted change(s) in the main checkout:`);
      for (const f of dirty.slice(0, 12)) say(`  ${f.status.trim()} ${f.path}`);
      if (dirty.length > 12) say(`  … and ${dirty.length - 12} more`);
    }
    if (ahead.commits.length) {
      say(`\n${ahead.commits.length} commit(s) not pushed:`);
      for (const line of ahead.commits.slice(0, 12)) say(`  ${line}`);
    }
    stop(
      `\nA worktree branches from ${BASE}, so none of that would be in it.\n\n` +
        `Run  gitpush  first — pick main, then Push — and try again.`,
    );
  }

  const copying = filesToCopy(root);

  heading("About to");
  say(`Fetch   from origin.`);
  say(`Create  worktree  ${worktreePath}`);
  say(`        branch    ${branch}  from ${BASE}`);
  say(
    copying.length
      ? `Copy    ${copying.length} file(s) named by .worktreeinclude:\n          ${copying.join("\n          ")}`
      : `Copy    nothing — .worktreeinclude matched no files.`,
  );
  say(`Open    a new VS Code window on it.`);
  if (install !== undefined) {
    say(install ? `Install dependencies (--install).` : `Skip    npm install (--no-install).`);
  }

  if (!confirm("\nDo all of that?")) stop("Cancelled. Nothing created.", 0);

  if (!gitLive(["fetch", "origin"], root)) stop("git fetch failed. Nothing created.");
  if (!gitLive(["worktree", "add", "-b", branch, worktreePath, BASE], root)) {
    stop("Could not create the worktree. Nothing else was done.");
  }

  // --- copy the machine-local files -----------------------------------------
  let copied = 0;
  for (const rel of copying) {
    const from = path.join(root, rel);
    const to = path.join(worktreePath, rel);
    try {
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      copied += 1;
    } catch (err) {
      say(`  Could not copy ${rel}: ${err.message}`);
    }
  }
  say(`\n  Copied ${copied} of ${copying.length} file(s) from .worktreeinclude.`);

  // --- dependencies ----------------------------------------------------------
  // node_modules is deliberately not copied — it is large, and native modules do
  // not always survive being moved. So it has to be installed, and this is the
  // moment to say so rather than at the first failing `npm start`.
  heading("Dependencies");
  say("node_modules is not copied into a worktree, so it is not there yet.");
  say("Nothing that needs it will run until it is installed.");
  const doInstall =
    install === undefined
      ? confirm("\nRun `npm install` in the new worktree now? (a few minutes)")
      : install;
  if (doInstall) {
    say("");
    const r = spawnSync("npm", ["install"], {
      cwd: worktreePath,
      stdio: "inherit",
      shell: true,
    });
    say(r.status === 0 ? "\n  npm install finished." : "\n  npm install failed — run it by hand.");
  } else {
    say(`\n  Later:  cd "${worktreePath.replace(/\//g, "\\")}" ; npm install`);
  }
  say("  tools/sam-tools and workshop/.venv have their own installs, if you need them.");

  // --- open it ---------------------------------------------------------------
  const opened = spawnSync("code", ["-n", worktreePath], { stdio: "ignore", shell: true });
  if (opened.status === 0) {
    say(`\nOpened a new VS Code window on ${worktreePath}`);
  } else {
    say(`\nCould not run \`code\` — open it by hand:`);
    say(`  ${worktreePath.replace(/\//g, "\\")}`);
  }

  heading("Ready");
  say(`Project code:  ${code}`);
  say(`Branch:        ${branch}`);
  say(`Claims owner:  ${code}   (the folder name)`);
  say(
    `\nPrompts for this project carry a run tag starting "${code}-". The prompt guard\n` +
      `blocks anything else pasted into that window, and blocks "${code}-" prompts pasted\n` +
      `anywhere else.`,
  );
  say(`\nWhen it is done:  gitpush  →  ${code}  →  Finish`);
}

main();
