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
  confirm,
  git,
  gitLive,
  heading,
  listWorktrees,
  say,
  stop,
  tryGit,
  unpushed,
} from "./lib/git-flow.mjs";

const BASE = "origin/main";
const CODE = /^[a-z0-9][a-z0-9-]{1,40}$/;

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

function main() {
  const code = (process.argv[2] ?? "").trim();

  heading("gitnewtree");

  if (!code) {
    stop(
      "Usage: gitnewtree <project-code>\n\n" +
        "The project code names the worktree folder and the branch, and it is what\n" +
        "the prompt guard checks a run tag against — so use the project part of the\n" +
        "run tag you will be working under, e.g. `gitnewtree claims-wq7`.",
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
  const mainTree = listWorktrees().find((t) => t.isMain);
  if (!mainTree) stop("Could not find the main checkout in `git worktree list`.");
  const root = mainTree.path;
  if (here.isWorktree) say(`Run from a worktree; branching from the main checkout.`);

  const worktreePath = path.join(root, ".claude", "worktrees", code);
  const branch = `worktree-${code}`;

  if (existsSync(worktreePath)) stop(`Already exists: ${worktreePath}`);
  if (tryGit(["rev-parse", "--verify", branch], root).ok) {
    stop(`Branch ${branch} already exists. Pick another code, or delete it first.`);
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
  if (confirm("\nRun `npm install` in the new worktree now? (a few minutes)")) {
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
