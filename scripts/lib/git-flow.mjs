// Shared plumbing for the three git commands Alex runs: gitcom, gitsync, gitpush.
//
//   scripts/git-commit-claimed.mjs   gitcom
//   scripts/git-sync.mjs             gitsync
//   scripts/git-push-worktrees.mjs   gitpush
//
// ---------------------------------------------------------------------------
// THESE ARE THE ONLY THINGS IN THIS REPO THAT CHANGE GIT STATE
// ---------------------------------------------------------------------------
//
// Rule 1 of .claude/CLAUDE.md is that no CLI thread runs a state-changing git
// command. These scripts break that rule by design, which is exactly why they
// live here, in the repo, reviewable — and why Alex is the only one who runs
// them, from his own prompt, never a thread.
//
// So every one of them: works out what it would do, prints it in full, and
// waits for a typed yes. Nothing below runs `git add`, `commit`, `merge`,
// `push`, `worktree remove` or `branch -d` without that.
//
// `git add .` appears nowhere. Paths are always passed explicitly after `--`.
// That sweep is what put Alex's unrelated work into two of my commits and is
// the reason the claims system exists.

import { execFileSync, spawnSync } from "node:child_process";
import { readSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// running git
// ---------------------------------------------------------------------------

/** Run git and return its output. Throws if it fails. */
export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Run git and hand back the result without throwing. */
export function tryGit(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

/**
 * Run git with its output going straight to the terminal, for the commands Alex
 * should watch happen — merge, push, commit. Returns true on success.
 */
export function gitLive(args, cwd) {
  say(`\n  $ git ${args.join(" ")}`);
  const r = spawnSync("git", args, { cwd, stdio: "inherit" });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// reading the working tree
// ---------------------------------------------------------------------------

/**
 * Every changed path in a checkout, as { path, status, staged, untracked }.
 *
 * `-z` because paths here include spaces and non-ASCII, and the non-`-z` form
 * quotes and escapes them, which is a second bug waiting to happen. Renames
 * carry two NUL-separated paths; both ends count as changed.
 *
 * `-uall` because git otherwise collapses a wholly-untracked folder to one
 * entry — `.claude/hooks/` instead of `.claude/hooks/claims-guard.mjs` — and a
 * claim on the file inside it would then match nothing, so a claimed new file
 * would be offered as if nobody owned it.
 */
export function changedFiles(cwd) {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
    cwd,
    encoding: "utf8",
  });
  const parts = out.split("\0");
  const files = [];

  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);

    if (x === "R" || x === "C") {
      // "R  new" then a separate NUL-terminated "old".
      const old = parts[i + 1];
      i += 1;
      if (old) files.push({ path: old, status: `${x}${y}`, untracked: false });
    }
    files.push({ path: p, status: `${x}${y}`, untracked: x === "?" });
  }
  return files;
}

/** Is this checkout free of uncommitted changes? */
export function isClean(cwd) {
  return changedFiles(cwd).length === 0;
}

/**
 * Every worktree git knows about, main checkout first.
 * Branch comes from git, never constructed — Claude Code's naming is not a
 * documented pattern.
 */
export function listWorktrees() {
  const out = git(["worktree", "list", "--porcelain"]);
  const trees = [];
  let current = null;

  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: null, detached: false };
      trees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached" && current) {
      current.detached = true;
    }
  }
  // git lists the main checkout first; mark it so callers do not guess.
  if (trees.length) trees[0].isMain = true;
  for (const t of trees) t.name = path.basename(t.path);
  return trees;
}

/** Commits on `from` that `to` does not have yet, newest first. */
export function commitsAhead(from, to, cwd) {
  const r = tryGit(["log", "--oneline", `${to}..${from}`], cwd);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// talking to Alex
// ---------------------------------------------------------------------------

export function say(line = "") {
  process.stdout.write(`${line}\n`);
}

export function heading(title) {
  say(`\n${title}`);
  say("─".repeat(Math.min(title.length, 70)));
}

/** Ask a free-text question. Returns the trimmed answer. */
export function ask(question) {
  // Synchronous on purpose: readline's async API would mean threading await
  // through every caller for no gain, and these scripts are a straight line
  // from question to git command.
  process.stdout.write(question);
  return readLineSync().trim();
}

/**
 * Read one line from stdin, synchronously.
 *
 * Node has no sync readline, so this reads fd 0 a byte at a time to the newline.
 * Fine here: it is a human typing, a handful of characters, a few times a run.
 */
function readLineSync() {
  const buf = Buffer.alloc(1);
  let line = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (err) {
      // Non-blocking stdin hands back EAGAIN when nothing has been typed yet.
      // Wait a tick rather than spinning a core while Alex reads the prompt.
      if (err.code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      if (err.code === "EOF") break;
      throw err;
    }
    if (n === 0) break;
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    if (ch !== "\r") line += ch;
  }
  return line;
}

/** Yes or no, defaulting to NO. Anything but y/yes is no. */
export function confirm(question) {
  const answer = ask(`${question} [y/N] `).toLowerCase();
  return answer === "y" || answer === "yes";
}

/** One of `choices` (keyed by first letter), or null if Alex just hits enter. */
export function choose(question, choices) {
  const keys = choices.map((c) => c.key);
  for (;;) {
    const answer = ask(`${question} [${keys.join("/")}] `).toLowerCase().trim();
    if (!answer) return null;
    const hit = choices.find(
      (c) => c.key.toLowerCase() === answer || c.label.toLowerCase() === answer,
    );
    if (hit) return hit.key;
    say(`  Not one of ${keys.join(", ")}. Enter on its own cancels.`);
  }
}

/** Stop, with a reason. Nothing has been changed by the time this is called. */
export function stop(message, code = 1) {
  say(`\n${message}`);
  process.exit(code);
}
