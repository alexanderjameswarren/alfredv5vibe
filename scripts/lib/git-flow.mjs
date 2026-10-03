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
import { existsSync, readdirSync, readSync, rmdirSync } from "node:fs";
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

/**
 * Delete `dir` only if it is empty. Windows can leave a removed worktree's
 * folder behind, empty, while something holds a handle on it, and Switchboard
 * shows a row for every folder in .claude\worktrees.
 * Returns "gone", "removed", "not-empty" or "busy".
 */
export function removeEmptyDir(dir) {
  if (!existsSync(dir)) return "gone";
  if (readdirSync(dir).length) return "not-empty";
  try {
    rmdirSync(dir);
    return "removed";
  } catch {
    return "busy";
  }
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
      if (old) files.push({ path: old, status: `${x}${y}`, untracked: false, renamedFrom: true });
    }
    files.push({ path: p, status: `${x}${y}`, untracked: x === "?" });
  }
  return files;
}

/**
 * Which of `paths` still need `git add`, given `files` from changedFiles.
 *
 * Not a rename's old name, and not a path with nothing unstaged (status column
 * two a space): after `git mv a b`, `a` is in neither the index nor the tree,
 * so `git add -- a` fails "pathspec did not match" and gitcom and gitpush
 * stopped. A staged `git rm` failed the same way. Both are already staged, so
 * the commit takes them anyway. A path not in `files` is kept, for git to judge.
 */
export function pathsToAdd(files, paths) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return paths.filter((p) => {
    const f = byPath.get(p);
    if (!f) return true;
    return !f.renamedFrom && (f.untracked || f.status[1] !== " ");
  });
}

/**
 * `git add` the paths that need it in `cwd`. True on success, including when
 * everything was already staged.
 */
export function addPaths(cwd, paths) {
  const toAdd = pathsToAdd(changedFiles(cwd), paths);
  if (toAdd.length < paths.length) {
    say(`  Already staged, not re-added: ${paths.filter((p) => !toAdd.includes(p)).join(", ")}`);
  }
  // Explicit paths after `--`, never `git add .`.
  return !toAdd.length || gitLive(["add", "--", ...toAdd], cwd);
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
      // lockReason is null when unlocked, "" when locked with no reason given.
      current = { path: line.slice(9), branch: null, detached: false, lockReason: null };
      trees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached" && current) {
      current.detached = true;
    } else if (line === "locked" && current) {
      current.lockReason = "";
    } else if (line.startsWith("locked ") && current) {
      current.lockReason = line.slice(7).trim();
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

/**
 * Commits this checkout has that its upstream does not.
 * `hasUpstream` is false when the branch does not track anything, which is a
 * different situation from having nothing to push and is reported as such.
 */
export function unpushed(cwd) {
  const up = tryGit(["rev-parse", "--abbrev-ref", "@{u}"], cwd);
  if (!up.ok) return { hasUpstream: false, commits: [] };
  return { hasUpstream: true, upstream: up.stdout, commits: commitsAhead("HEAD", "@{u}", cwd) };
}

// ---------------------------------------------------------------------------
// committing by the claim rules
// ---------------------------------------------------------------------------

/** One changed file, as gitcom and gitpush both print it. */
export function describeFile(f) {
  const label = f.untracked ? "new" : f.status.trim();
  return `${label.padEnd(3)} ${f.path}`;
}

/**
 * Show the three buckets and ask about the unclaimed ones.
 *
 * Returns the files to stage — empty if he picked "none", which the callers
 * report as nothing selected rather than as a cancel. Shared so that
 * committing in the main checkout through gitpush follows exactly the same
 * rules as gitcom — "same rules" being a promise that is only true if it is
 * literally the same code.
 */
export function selectByClaims({ owner, mine, others, unclaimed, include }) {
  if (mine.length) {
    say(`\nClaimed by ${owner} — will be committed:`);
    for (const f of mine) say(`  ${describeFile(f)}`);
  } else {
    say(`\n${owner} has no changed files among its claims.`);
  }

  if (others.length) {
    say("\nClaimed by another thread — WILL NOT be committed:");
    for (const f of others) say(`  ${describeFile(f)}   (${f.holder})`);
  }

  // Unclaimed changes are usually Alex's own hand edits sitting in the tree.
  // They are his to decide about, one at a time if he wants.
  const extra = [];
  if (unclaimed.length) {
    say("\nChanged but claimed by nobody:");
    for (const f of unclaimed) say(`  ${describeFile(f)}`);
    // Answered on the command line, so it is reported rather than asked. The
    // plan below still prints, and the final yes/no is still asked.
    if (include !== undefined) {
      const chosen = resolveUnclaimed(include, unclaimed);
      say(
        chosen.length
          ? `\n--include-unclaimed: adding ${chosen.length} of them:`
          : "\n--include-unclaimed: adding none of them.",
      );
      for (const f of chosen) say(`  ${describeFile(f)}`);
      return [...mine, ...chosen];
    }

    say("\nThese are probably your own edits. Include them in this commit?");
    // No `blank` default: enter re-asks. This used to cancel the whole run,
    // which is the single most expensive blank answer in these scripts — it
    // came before the commit message and the final yes/no.
    const pick = choose("  all / none / select", [
      { key: "a", label: "all" },
      { key: "n", label: "none" },
      { key: "s", label: "select" },
    ]);
    if (pick === "a") extra.push(...unclaimed);
    if (pick === "s") {
      for (const f of unclaimed) {
        if (confirm(`  include ${f.path}?`)) extra.push(f);
      }
    }
  }

  return [...mine, ...extra];
}

/** Stage named paths and commit them. Returns false to stop. */
export function stageAndCommit(cwd, paths, message) {
  if (!addPaths(cwd, paths)) {
    say("  git add failed. Nothing was committed.");
    return false;
  }
  if (!gitLive(["commit", "-m", message], cwd)) {
    say("  git commit failed. The files are staged — `git reset` unstages them.");
    return false;
  }
  return true;
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
  const line = readLineSync();
  // Several prompts below re-ask on a blank answer instead of cancelling. With
  // no stdin — a closed pipe, a non-interactive shell — a re-asking loop would
  // spin forever on the empty string it keeps being handed, so EOF is told
  // apart from someone pressing enter, and it ends the run rather than the
  // question.
  if (line === null) stop("\nstdin closed with nothing typed. Nothing was changed.", 1);
  return line.trim();
}

/**
 * Read one line from stdin, synchronously. Null at end of input.
 *
 * Node has no sync readline, so this reads fd 0 a byte at a time to the newline.
 * Fine here: it is a human typing, a handful of characters, a few times a run.
 */
function readLineSync() {
  const buf = Buffer.alloc(1);
  let line = "";
  let read = false;
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
    read = true;
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    if (ch !== "\r") line += ch;
  }
  return read ? line : null;
}

// ---------------------------------------------------------------------------
// reading the command line
// ---------------------------------------------------------------------------

/** A bad command line. Callers print the message and the usage, and stop. */
export class UsageError extends Error {}

/**
 * Parse argv against a small option spec.
 *
 * Kinds: `bool` (`--all`), `value` (`--message "..."`, `--message=...`), and
 * `list` (`--paths a b c`), which takes everything up to the next `-token`.
 *
 * **An unknown option is an error, never a shrug.** These commands merge and
 * push; a typo in `--relese-db` that is quietly ignored would mean claims held
 * for another thirteen hours with nothing to show why, and a plan that no
 * longer describes what will happen.
 */
export function parseArgs(argv, options, { positionals = 0 } = {}) {
  const byName = new Map();
  for (const [name, def] of Object.entries(options)) {
    byName.set(name, name);
    if (def.alias) byName.set(def.alias, name);
  }

  const out = {};
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      rest.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : null;
    const name = byName.get(flag.replace(/^--?/, ""));
    if (!name) throw new UsageError(`Unknown option: ${flag}`);
    const def = options[name];

    if (def.kind === "bool") {
      if (inline !== null) throw new UsageError(`${flag} takes no value.`);
      out[name] = true;
      continue;
    }

    if (def.kind === "list") {
      const values = inline !== null ? [inline] : [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) values.push(argv[(i += 1)]);
      if (!values.length) throw new UsageError(`${flag} needs at least one value.`);
      out[name] = [...(out[name] ?? []), ...values];
      continue;
    }

    const value = inline !== null ? inline : argv[(i += 1)];
    if (value === undefined) throw new UsageError(`${flag} needs a value.`);
    out[name] = value;
  }

  if (rest.length > positionals) {
    throw new UsageError(`Unexpected argument: ${rest[positionals]}`);
  }
  return { positionals: rest, options: out };
}

/** Refuse a pair of options that contradict each other. */
export function exclusive(options, names) {
  const given = names.filter((n) => options[n] !== undefined);
  if (given.length > 1) {
    throw new UsageError(`${given.map((n) => `--${n}`).join(" and ")} cannot both be given.`);
  }
  return given[0] ?? null;
}

/**
 * Resolve an `--include-unclaimed` value against the unclaimed files.
 *
 * `all`, `none`, or paths. A path that is not in the list is an error rather
 * than a silent miss: it is almost always a typo or a stale copy-paste, and the
 * alternative is a commit quietly missing a file Alex asked for by name.
 */
export function resolveUnclaimed(value, unclaimed) {
  const words = Array.isArray(value) ? value : [value];
  if (words.length === 1 && /^(a|all)$/i.test(words[0])) return [...unclaimed];
  if (words.length === 1 && /^(n|none)$/i.test(words[0])) return [];

  const picked = [];
  const missing = [];
  for (const word of words) {
    const hit = unclaimed.find((f) => f.path === word);
    if (hit) picked.push(hit);
    else missing.push(word);
  }
  if (missing.length) {
    throw new UsageError(
      `--include-unclaimed: not an unclaimed change here: ${missing.join(", ")}`,
    );
  }
  return picked;
}

// ---------------------------------------------------------------------------
// reading an answer
// ---------------------------------------------------------------------------

const ALL_WORD = /^(a|all)$/i;
const NUMERIC = /^\d+(?:-\d+)?$/;

/**
 * One typed answer to a "which of these?" question.
 *
 * Accepts `a`/`all`, single numbers, ranges (`1-4`, and `4-1` the same way),
 * and anything else as a literal word — a path, or a checkout name. Mixtures
 * work: `1-3 7 src/x.js`.
 *
 *   blank    nothing was typed. Never means "everything" and never means
 *            "cancel" on its own — the caller asks a second, explicit question.
 *   indexes  1-based, deduped, in order, every one within `count`.
 *   words    tokens that are not numbers, for the caller to resolve.
 *   bad      numbers and ranges outside `count`, kept rather than dropped so a
 *            typo is answered instead of silently doing something smaller.
 *
 * Commas split only when every part is numeric, so `1,2,3` works without
 * breaking a path that happens to contain one.
 */
export function parseSelection(answer, count = 0) {
  const text = String(answer ?? "").trim();
  if (!text) return { blank: true, all: false, indexes: [], words: [], bad: [] };

  const tokens = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const parts = raw.split(",").filter(Boolean);
    if (parts.length > 1 && parts.every((p) => NUMERIC.test(p))) tokens.push(...parts);
    else tokens.push(raw);
  }

  let all = false;
  const indexes = [];
  const words = [];
  const bad = [];
  const inRange = (n) => n >= 1 && n <= count;

  for (const token of tokens) {
    if (ALL_WORD.test(token)) {
      all = true;
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      let from = Number(range[1]);
      let to = Number(range[2]);
      if (from > to) [from, to] = [to, from];
      const hits = [];
      for (let n = from; n <= to; n += 1) if (inRange(n)) hits.push(n);
      if (hits.length) indexes.push(...hits);
      else bad.push(token);
      continue;
    }
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (inRange(n)) indexes.push(n);
      else bad.push(token);
      continue;
    }
    words.push(token);
  }

  return {
    blank: false,
    all,
    indexes: [...new Set(indexes)].sort((a, b) => a - b),
    words,
    bad,
  };
}

/**
 * Ask which of `items` to act on, and never throw the answer away.
 *
 * A blank answer used to cancel the whole run — after every other question had
 * been answered — which is the trap this step exists to close. Now it asks one
 * more question, with the consequence spelled out, and cancelling is something
 * Alex says rather than something that happens to him.
 *
 * Returns { all, picked, words, bad }, or null if he chose to cancel.
 */
export function askSelection(question, items, blankQuestion) {
  const everything = () => ({ all: true, picked: [...items], words: [], bad: [] });

  for (;;) {
    const sel = parseSelection(ask(question), items.length);

    if (sel.blank) {
      // Nothing to offer, so there is nothing to re-ask about.
      if (!items.length) return null;
      say("");
      return confirm(`  Nothing typed. ${blankQuestion}`) ? everything() : null;
    }
    if (sel.all) return everything();
    if (sel.indexes.length || sel.words.length || sel.bad.length) {
      return {
        all: false,
        picked: sel.indexes.map((n) => items[n - 1]),
        words: sel.words,
        bad: sel.bad,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// the default commit message
// ---------------------------------------------------------------------------

/** Today, local. A commit made at 23:00 belongs to that day, not to UTC's. */
export function today(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `claims-followup: checkpoint 2026-09-30` */
export function defaultMessage(code, mode, d = new Date()) {
  return `${code || "main"}: ${mode} ${today(d)}`;
}

/**
 * Ask for a commit message, falling back to the default.
 *
 * A blank message used to cancel the run, in three of gitpush's four modes
 * AFTER the final yes/no had already been answered. A message is the one thing
 * here with an obvious right default, so blank now means "use it".
 */
export function askMessage(code, mode) {
  const fallback = defaultMessage(code, mode);
  say(`\n  Enter on its own uses:  ${fallback}`);
  return ask("Commit message: ") || fallback;
}

/** Yes or no, defaulting to NO. Anything but y/yes is no. */
export function confirm(question) {
  const answer = ask(`${question} [y/N] `).toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * One of `choices`, keyed by first letter or spelled out in full.
 *
 * A choice can carry a `hint`, and then every option is spelled out on its own
 * line before the prompt. These are decisions about pushing and about releasing
 * claims, taken once in a while — "f/c/s" is not something to have to remember.
 *
 * **A blank answer re-asks.** It used to return null, which every caller read as
 * "cancel the whole run" — so pressing enter at the wrong moment threw away
 * everything already answered. A caller that genuinely has a sensible default
 * passes `blank` and says so in the question; nobody gets to cancel by accident.
 */
export function choose(question, choices, { blank } = {}) {
  const keys = choices.map((c) => c.key);
  if (choices.some((c) => c.hint)) {
    say(question);
    for (const c of choices) {
      say(`  ${c.key}  ${c.label}${c.hint ? ` — ${c.hint}` : ""}`);
    }
    question = " ";
  }
  for (;;) {
    const answer = ask(`${question} [${keys.join("/")}] `).toLowerCase().trim();
    if (!answer) {
      if (blank !== undefined) return blank;
      say(`  Enter on its own is not an answer here. Pick one of ${keys.join(", ")}.`);
      continue;
    }
    const hit = choices.find(
      (c) => c.key.toLowerCase() === answer || c.label.toLowerCase() === answer,
    );
    if (hit) return hit.key;
    say(`  Not one of ${keys.join(", ")}.`);
  }
}

/** Stop, with a reason. Nothing has been changed by the time this is called. */
export function stop(message, code = 1) {
  say(`\n${message}`);
  process.exit(code);
}
