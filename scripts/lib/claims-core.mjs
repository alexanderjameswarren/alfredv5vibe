// Shared core of the claims system: where the file lives, what an item means,
// what counts as a conflict, and how to write under a lock.
//
// Two very different callers use this and MUST agree on every answer:
//
//   scripts/claims.mjs          — the CLI that grants claims
//   .claude/hooks/claims-guard.mjs — the PreToolUse hook that enforces them
//
// If those two ever disagreed about, say, whether `src/sam/` covers
// `src/sam/lib/x.js`, the guard would wave through an edit the claimer thought
// it had reserved. That is the bug this module exists to make impossible, so
// the rules live here once and neither caller reimplements them.
//
// Nothing here calls process.exit or prints. It throws ClaimsError and lets the
// caller decide what that means — the CLI exits, the hook blocks a tool call.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { OUTBOX_FILE, SENDER_SCRIPT, kickSender, queueEvents } from "./overwatch-post.mjs";
import { readMainCode } from "./project-code.mjs";
import {
  CHANGES_DIR,
  FROM_INPUT,
  copyDestination,
  expandLocal,
  expandVars,
  parseAssignment,
  shellWords,
  splitCommand,
  stripHeredocs,
  unreadable,
  writeIndicators,
} from "./shell-parse.mjs";

const HEREDOC_OP = /<<(?!<)/;

// Re-exported so existing callers (the guard, the tests) keep one import.
export {
  copyDestination,
  runText,
  scanRedirects,
  shellWords,
  splitCommand,
  splitPayloads,
  writeIndicator,
  writeIndicators,
} from "./shell-parse.mjs";

export const CLAIMS_FILE = "alfred-claims.json";
export const BLOCKS_FILE = "alfred-claim-blocks.json";
export const LOCK_DIR = "alfred-claims.lock";
export const LOCK_TIMEOUT_MS = 10_000;
export const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;

// Windows paths are case-insensitive, so `src/alfred.jsx` and `src/Alfred.jsx`
// are the same file and must be the same claim.
const IGNORE_CASE = process.platform === "win32";

export class ClaimsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "no-git" | "bad-item" | "unreadable" | "locked"
  }
}

// ---------------------------------------------------------------------------
// where we are
// ---------------------------------------------------------------------------

/**
 * Repo root, this checkout's git dir, the shared git dir, and the owner name —
 * in ONE `git` call.
 *
 * The single call matters: the guard hook runs before every tool call, and on
 * Windows each spawn of git costs more than everything else here put together.
 *
 * Owner: in a linked worktree `--git-dir` is <common>/worktrees/<name> while
 * `--git-common-dir` is <common>; in the main checkout they are the same path.
 * That test does not care where the worktree folder sits on disk, so it keeps
 * working if Claude Code ever moves them out of `.claude/worktrees/`.
 */
export function resolveRepo(cwd = process.cwd()) {
  let out;
  try {
    out = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    throw new ClaimsError("no-git", "Not in a git repository (or git is not on PATH).");
  }

  const [root, gitDir, commonDir] = out.trim().split(/\r?\n/);
  if (!root || !gitDir || !commonDir) {
    throw new ClaimsError("no-git", "Could not read the git layout for this folder.");
  }

  const isWorktree = path.resolve(gitDir) !== path.resolve(commonDir);
  return {
    root,
    dir: commonDir,
    file: path.join(commonDir, CLAIMS_FILE),
    // CLAIMS_BLOCKS_FILE is for tests that drive the guard against this repo.
    blocksFile: process.env.CLAIMS_BLOCKS_FILE
      ? path.resolve(process.env.CLAIMS_BLOCKS_FILE)
      : path.join(commonDir, BLOCKS_FILE),
    // Overwatch's outbox, only where the sender exists and the blocks file is the real one, so a test's
    // scratch repo or redirected blocks file never queues events for the live database.
    outboxFile: !process.env.CLAIMS_BLOCKS_FILE && existsSync(path.join(root, SENDER_SCRIPT))
      ? path.join(commonDir, OUTBOX_FILE)
      : null,
    owner: isWorktree ? path.basename(root) : "main",
    isWorktree,
    // The main checkout holds the common .git; null for a bare repo.
    mainRoot: path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null,
  };
}

/**
 * From a worktree, the main-relative form of a path in the main checkout or in
 * another worktree, or null. Those were "outside the repo" and allowed, so a
 * worktree session could write main's files (switchboard_guard, bug 3).
 * Exempt paths (`.git/`, `.clip/`, …) are not foreign.
 */
export function foreignPath(p, ctx) {
  if (!ctx.isWorktree || !ctx.mainRoot) return null;
  const abs = path.resolve(ctx.root, nativePath(p));
  if (fold(abs) === fold(path.resolve(ctx.root)) || toRepoRelative(abs, ctx.root) !== null) return null;
  const rel = toRepoRelative(abs, ctx.mainRoot);
  if (rel === null || isExempt(rel)) return null;
  // Same debris rule as repoPathsIn: a real target's folder exists.
  return existsSync(abs) || existsSync(path.dirname(abs)) ? rel : null;
}

/** "main" or "the <name> worktree", for a path foreignPath returned. */
export const foreignWhere = (rel) => {
  const wt = worktreeOf(rel);
  return wt === null ? "the main checkout" : wt ? `the ${wt} worktree` : "the worktrees folder";
};

/**
 * The session's checkout: its project dir first, then its cwd.
 *
 * The hooks used the cwd alone, and the cwd moves with every `cd`: a session
 * that had cd'd to $TEMP had its edits to repo files allowed as "not a git
 * repo" (found 2026-10-01). CLAUDE_PROJECT_DIR is where the session was opened,
 * which a `cd` cannot change. Throws ClaimsError("no-git") only if neither is a repo.
 */
export function resolveCheckout(projectDir, cwd = process.cwd()) {
  if (projectDir) {
    try {
      return resolveRepo(projectDir);
    } catch {
      /* not a repo, or gone: fall back to the cwd */
    }
  }
  return resolveRepo(cwd);
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

const DB_ITEM = /^db:(deploy|(table|fn):[A-Za-z0-9_.-]+)$/;

export const isDbItem = (item) => item.startsWith("db:");
export const isFolderItem = (item) => item.endsWith("/");
export const fold = (s) => (IGNORE_CASE ? s.toLowerCase() : s);

/**
 * The worktree a repo-relative path reaches into, or null.
 *
 * From the main checkout, `.claude/worktrees/x/src/a.js` is thread x's copy of
 * `src/a.js`. As a path string it overlaps nothing x holds, so it could be
 * claimed and edited from main with no conflict (folder_claims, 2026-10-05).
 */
const WORKTREES = ".claude/worktrees/";
export function worktreeOf(rel) {
  const p = fold(rel);
  if (`${p}/` === WORKTREES) return "";
  if (!p.startsWith(WORKTREES)) return null;
  return rel.slice(WORKTREES.length).split("/")[0];
}

/**
 * Normalise one item into its stored form, or throw ClaimsError("bad-item").
 *
 * Database items pass through as written. Everything else is a path: absolute
 * paths are made repo-relative, backslashes become slashes, and a trailing
 * slash is kept because that is what makes it a folder claim.
 *
 * A folder named without its slash used to be stored as a FILE claim, which
 * covered nothing inside it. Now an existing folder gets its slash, and a path
 * that does not exist and has no extension is refused as ambiguous.
 */
export function normaliseItem(raw, root) {
  const item = String(raw).trim();
  if (!item) throw new ClaimsError("bad-item", "empty item");

  if (isDbItem(item)) {
    if (!DB_ITEM.test(item)) {
      throw new ClaimsError(
        "bad-item",
        `not a valid database item: ${item} (use db:table:<name>, db:fn:<name> or db:deploy)`,
      );
    }
    return item;
  }

  const isFolder = /[\\/]$/.test(item);
  const abs = path.resolve(root, item);
  let rel = path.relative(root, abs).split(path.sep).join("/");

  if (rel === "" || rel === ".") {
    throw new ClaimsError("bad-item", "refusing to claim the whole repo");
  }
  if (rel.startsWith("../")) {
    throw new ClaimsError("bad-item", `outside the repo: ${item}`);
  }
  const wt = worktreeOf(rel);
  if (wt !== null) {
    throw new ClaimsError(
      "bad-item",
      `inside another thread's worktree: ${item}\n` +
        (wt ? `Claim it from the ${wt} worktree, as a path relative to that worktree.` : ""),
    );
  }
  if (isFolder) return `${rel}/`;

  let isDir = false;
  let exists = false;
  try {
    const st = statSync(abs);
    exists = true;
    isDir = st.isDirectory();
  } catch {
    /* does not exist yet */
  }
  if (isDir) return `${rel}/`;
  if (!exists && !/\.[^./]+$/.test(rel.split("/").pop())) {
    throw new ClaimsError(
      "bad-item",
      `${item} does not exist and has no file extension, so it is unclear whether it is a file or a folder.\n` +
        `If it is meant as a folder, add a trailing slash: ${rel}/`,
    );
  }
  return rel;
}

/**
 * Git Bash spells C:\x as /c/x. Read literally on Windows, that is C:\c\x, outside
 * every checkout, so a shell write by that spelling went unchecked (switchboard_guard).
 */
export const nativePath = (p) =>
  IGNORE_CASE ? String(p).replace(/^\/([A-Za-z])\//, "$1:/") : String(p);

/**
 * Repo-relative form of an absolute path, or null if it is outside the repo.
 * The guard uses this rather than normaliseItem because "outside the repo" is
 * an ordinary, allowed answer there, not an error.
 */
export function toRepoRelative(p, root) {
  const rel = path.relative(root, path.resolve(root, nativePath(p))).split(path.sep).join("/");
  if (rel === "" || rel === "." || rel.startsWith("../")) return null;
  return rel;
}

// ---------------------------------------------------------------------------
// exempt paths
// ---------------------------------------------------------------------------

/**
 * Paths no thread ever has to claim, because coordinating them is meaningless.
 *
 * `.clip/` is the one that forced this. Claims are path STRINGS in one shared
 * file, but `.clip/last-report.md` is a different file in every worktree — each
 * thread writes its own copy to report to Alex. Without this list the first
 * thread to claim it would lock every other thread out of reporting, over a
 * file they never actually share.
 *
 * The rest are generated or machine-local: nobody's work is lost if two threads
 * both write them, and each worktree has its own.
 */
export const EXEMPT_PREFIXES = [
  ".clip/", // per-worktree report staging for scripts/clip.mjs
  ".git/", // including the claims file itself
  "node_modules/",
  "tools/sam-tools/node_modules/",
  "workshop/.venv/",
  "build/",
  "coverage/",
  "supabase/.temp/", // machine-local Supabase link state
];

/**
 * Is this repo-relative path exempt from claiming?
 *
 * The folder named on its own counts too: `cp -r .git …` and `cd .clip && rm x`
 * were blocked as writes to `.git` and `.clip`, which have no trailing slash.
 */
export function isExempt(rel) {
  const p = fold(rel);
  return EXEMPT_PREFIXES.some(
    (prefix) => p.startsWith(fold(prefix)) || `${p}/` === fold(prefix),
  );
}

/**
 * Does folder `f` contain path `p`? The folder itself, named without its slash,
 * counts: a shell write gives `cp x src/items/` as `src/items`, and that was
 * blocked under a claim on `src/items/`.
 */
export function covers(f, p) {
  if (!isFolderItem(f)) return false;
  const pf = fold(p);
  return pf.startsWith(fold(f)) || `${pf}/` === fold(f);
}

/** Does a claim on `item` hold `p`: the same item, or a folder containing it? */
export const holds = (item, p) => fold(item) === fold(p) || covers(item, p);

/** Two items overlap if they are the same, or one folder contains the other. */
export function overlaps(a, b) {
  if (fold(a) === fold(b)) return true;
  if (isDbItem(a) || isDbItem(b)) return false;
  return covers(a, b) || covers(b, a);
}

/** Claims overlapping `item`, split into this owner's and everyone else's. */
export function inspect(state, item, owner) {
  const hits = state.claims.filter((c) => overlaps(c.item, item));
  return {
    mine: hits.filter((c) => c.owner === owner),
    theirs: hits.filter((c) => c.owner !== owner),
    reserved: state.reservations.filter(
      (r) => r.owner !== owner && overlaps(r.item, item),
    ),
  };
}

/**
 * Does `owner` hold `item`, directly or through a folder claim? Never for a
 * path inside a worktree: a claim on `.claude/` must not reach another thread's
 * files.
 */
export function heldBy(state, item, owner) {
  if (worktreeOf(item) !== null) return false;
  return state.claims.some((c) => c.owner === owner && holds(c.item, item));
}

// ---------------------------------------------------------------------------
// shell commands that write
// ---------------------------------------------------------------------------
//
// The parsing (write words, redirections, payloads, splitting) lives in
// shell-parse.mjs. What is left here needs the repo: which paths a write hits.

/**
 * What this command would write inside the repo: `{ indicator, paths }`, or
 * null if it writes nothing the claims system cares about.
 *
 * ⚠️ TWO DIFFERENT RULES, AND THE DIFFERENCE IS ALEX'S DECISION OF 2026-09-30:
 * keep `mv`, `cp`, `tee` and `sed -i` strict, and relax only a plain `>` or `>>`
 * whose target resolves outside the repo.
 *
 * **A redirection names its own destination**, unambiguously, so when that is
 * the only way the command writes, only the destination is checked. That is
 * what makes `git diff src/x.js > "$TEMP/d.txt"` legal: it reads a repo file and
 * writes somewhere else entirely.
 *
 * **Anything else falls back to every repo path the command mentions**, because
 * shell is not parseable for real and the 2026-09-28 breach proved it: that
 * command redirected to `/tmp` — outside the repo, and allowed under the rule
 * above — and then `mv`'d the result over `src/utils/recurrence.js`. The `mv` is
 * what catches it, and the `mv` is why the strict rule cannot be narrowed to
 * destinations too.
 *
 * **Both rules apply per part, not per command** (switchboard_smoke, 2026-10-05):
 * `rm -rf "$S"; git archive HEAD tools/claude-sessions | tar -x -C "$S"` was
 * blocked because the `rm` made the `git archive` argument count. The command is
 * split at `;`, `&&`, `||` and newlines (see `splitCommand`) and only the parts
 * that write are judged, with `NAME=value` from earlier parts expanded. A writing
 * part that cannot be read on its own falls back to the whole command: after a
 * `cd`, with an unresolved variable, `$(…)` or backticks, or arguments from
 * `xargs`/`read`. A heredoc anywhere does too.
 *
 * `redirectsOnly` is for a lone claims.mjs or clip.mjs command (see
 * `isLoneScriptCommand`), whose arguments are never run.
 *
 * `checkout` (a resolveRepo result) also collects `foreign`: the paths, relative
 * to main, that a worktree's command would write in main or another worktree.
 */
export function writeCheck(command, root, shell = "bash", { redirectsOnly = false, checkout = null, code = false } = {}) {
  const kinds = (c) =>
    writeIndicators(c, shell, { code }).filter((f) => !redirectsOnly || f.kind === "redirect");
  if (!kinds(command).length) return null;

  const paths = new Set();
  const foreign = new Set();
  const outside = (p) => {
    const rel = checkout ? foreignPath(p, checkout) : null;
    if (rel) foreign.add(rel);
  };
  const add = (p) => {
    let rel = null;
    try {
      rel = toRepoRelative(p, root);
      if (rel === null) outside(p);
    } catch {
      return;
    }
    if (rel && !isExempt(rel)) paths.add(rel);
  };
  const vars = new Map();
  let strictLabel = null;
  let redirectLabel = null;
  let afterCd = false;
  // Bash heredoc bodies are input, not command text (switchboard2-h8r 0.1). The
  // parts are read without them; a body that runs is judged as its own command.
  // PowerShell has no heredocs, so a `<<` there still means the whole command.
  const bash = shell !== "powershell" && !code;
  const heredocs = bash ? stripHeredocs(command) : { text: command, bodies: [] };
  let whole = !bash && /<</.test(command);
  for (const body of heredocs.bodies) {
    if (!body.runs) continue;
    const inner = writeCheck(body.text, root, body.runs === "code" ? "bash" : body.runs, {
      checkout,
      code: body.runs === "code",
    });
    if (!inner) continue;
    strictLabel ??= inner.indicator;
    for (const rel of inner.paths) paths.add(rel);
    for (const rel of inner.foreign) foreign.add(rel);
    // After a cd the body's relative paths mean something else.
    if (CHANGES_DIR.test(heredocs.text)) whole = true;
  }

  for (const raw of whole ? [] : splitCommand(heredocs.text, shell)) {
    const assigned = parseAssignment(raw, shell);
    if (assigned) {
      const value = assigned.literal ? assigned.value : expandVars(expandLocal(assigned.value, vars));
      if (unreadable(value)) vars.delete(assigned.name);
      else vars.set(assigned.name, value);
      continue;
    }
    if (CHANGES_DIR.test(raw)) afterCd = true;
    const local = expandLocal(raw, vars);
    const all = kinds(local);
    if (!all.length) continue;
    const part = expandVars(local);

    // A wrapper's payload is a command of its own, judged by these same rules.
    const payloads = all.filter((f) => f.kind === "payload");
    if (payloads.length) {
      if (afterCd || FROM_INPUT.test(part) || unreadable(part)) {
        strictLabel ??= payloads[0].label;
        whole = true;
        break;
      }
      for (const { payload } of payloads) {
        const inner = writeCheck(payload.text, root, payload.shell, { checkout, code: payload.code });
        if (!inner) continue;
        strictLabel ??= inner.indicator;
        for (const rel of inner.paths) paths.add(rel);
        for (const rel of inner.foreign) foreign.add(rel);
      }
    }
    const found = all.filter((f) => f.kind !== "payload");
    if (!found.length) continue;

    const strong =
      found.find((f) => f.kind === "command") ??
      found.find((f) => f.kind === "extract") ??
      found.find((f) => f.kind === "copy");
    if (!strong) {
      redirectLabel ??= found[0].label;
      for (const target of found[0].targets) add(expandVars(target));
      continue;
    }
    strictLabel ??= strong.label;
    // A write fed by a heredoc (`xargs rm <<EOF`, `patch <<EOF`) takes its paths from the body.
    if (afterCd || FROM_INPUT.test(part) || unreadable(part) || HEREDOC_OP.test(part)) {
      whole = true;
      break;
    }
    if (strong.kind === "copy") {
      // Only where it copies TO is written. Unreadable, it is strict like the rest.
      const to = copyDestination(part);
      if (to !== null) {
        if (!to.startsWith("~")) add(to);
        for (const r of found.filter((f) => f.kind === "redirect"))
          for (const target of r.targets) add(expandVars(target));
        continue;
      }
    }
    const dest = strong.kind === "extract" ? strong.destRe.exec(part)?.[1].replace(/^["']|["']$/g, "") : null;
    if (dest && path.resolve(root, dest) !== path.resolve(root)) {
      add(dest);
      for (const r of found.filter((f) => f.kind === "redirect"))
        for (const target of r.targets) add(expandVars(target));
    } else {
      for (const rel of repoPathsIn(part, root, outside)) paths.add(rel);
    }
  }

  if (whole) {
    const all = kinds(command);
    strictLabel ??= all.find((f) => f.kind !== "redirect")?.label;
    if (strictLabel) for (const rel of repoPathsIn(command, root, outside)) paths.add(rel);
    else for (const target of all[0].targets) add(expandVars(target));
  }
  return paths.size || foreign.size
    ? { indicator: strictLabel ?? redirectLabel, paths: [...paths], foreign: [...foreign] }
    : null;
}

/**
 * Every repo path a command mentions.
 *
 * Deliberately looks at the WHOLE command rather than trying to work out which
 * argument is the destination. Shell is too flexible to parse for real — the
 * failure above went through a temp file and a `mv`, and quoting, heredocs,
 * `$()` and `-c "..."` payloads all hide arguments from any simple parser. So
 * the rule is: if the command writes at all, every repo file it names has to be
 * claimed.
 *
 * The cost is false positives — `git diff src/x.js > /tmp/d` names a repo file
 * in a writing command and gets blocked even though it only reads it. That is
 * the trade we want: the answer is to claim the file, which is the habit the
 * system is asking for anyway, and CLAIMS_GUARD=off is there for the rest.
 */
export function repoPathsIn(command, root, onOutside = null) {
  const found = new Set();
  const visit = (text, depth, report) => {
    // Past a few levels of quotes-in-quotes, fall back to splitting on everything.
    const words = depth > 3 ? String(text).split(/[\s"'`|&;,()<>{}]+/) : shellWords(text);
    for (const word of words) {
      const kind = pathWord(word, root, report, found);
      // A quoted word that is not a repo path may be a payload — `bash -c "cp
      // a.js b.js"`, `node -e "fs.writeFileSync('src/a.js')"` — with the paths
      // inside it. Its fragments are searched for repo paths only: a piece of
      // an outside path is not one.
      if (kind !== "repo" && /[\s"'`(),;|&<>{}]/.test(word)) visit(word, depth + 1, kind === "outside" ? null : report);
    }
  };
  visit(command, 0, onOutside);
  return [...found];
}

/**
 * Add `raw` to `found` if it is a repo path. Returns "repo", "outside" (named a
 * path outside this checkout) or "none".
 */
function pathWord(raw, root, onOutside, found) {
  // PowerShell writes a parameter as `-Name:Value`, and a quoted `--file="x"`
  // arrives as `--file=x`, so a path can hide inside something like a flag.
  const sep = raw.startsWith("-") ? raw.search(/[:=]/) : -1;
  const unflagged = sep > 0 ? raw.slice(sep + 1) : raw;
  const token = unflagged.replace(/^[=~]+/, "").trim();
  if (!token || token.startsWith("-") || token.includes("://")) return "none";

  // A bare word is not a path — `npm test` must not resolve to <root>/test.
  const hasExtension = /\.[A-Za-z0-9]{1,6}$/.test(token);
  // A backslash counts on its own, because PowerShell paths are full of them
  // and plenty have no extension: `Remove-Item -Recurse .claude\worktrees\x`.
  // The debris that lets in — `printf "x\n"`, a `\d+` out of a regex — is
  // caught by the existence check below, which is what it is there for.
  const looksLikePath =
    token.includes("/") || /^[A-Za-z]:[\\/]/.test(token) || token.includes("\\");
  if (!looksLikePath && !hasExtension) return "none";

  let rel;
  try {
    rel = toRepoRelative(token, root);
  } catch {
    return "none";
  }
  // Outside this checkout: the caller decides whether it is someone else's.
  if (rel === null && looksLikePath) {
    if (onOutside) onOutside(token);
    return "outside";
  }
  if (!rel) return "none";
  if (isExempt(rel)) return "repo";

  // Drop the debris that survives tokenising. A path with a slash needs its
  // parent folder to exist, which every real write target has — that removes
  // `s/a/b/` out of `sed -i "s/a/b/" src/x.js`. A BARE filename has to exist
  // outright, because its "parent" is the repo root, which always does — that
  // removes `console.log` and `claims.mjs` out of surrounding prose and code.
  const real = (r) => {
    const abs = path.resolve(root, r);
    try {
      return r.includes("/") ? existsSync(abs) || existsSync(path.dirname(abs)) : existsSync(abs);
    } catch {
      return false;
    }
  };
  if (!real(rel)) {
    // A diff names its files `a/<path>` and `b/<path>` (`git apply <<EOF`, `patch`).
    const unprefixed = /^[ab]\/(.+)$/.exec(rel)?.[1];
    if (!unprefixed || isExempt(unprefixed) || !real(unprefixed)) return "none";
    rel = unprefixed;
  }
  found.add(rel);
  return "repo";
}

// ---------------------------------------------------------------------------
// claims.mjs commands, as the guard reads them
// ---------------------------------------------------------------------------
//
// The guard used to raise Alex's permission prompt for every `claim`, `reserve`
// and `cleanup`, by matching the subcommand alone. He got several per project
// and approved them without reading, which is worse than no prompt at all: it
// taught him that these prompts do not need reading, so the one that mattered
// would have gone through the same way.
//
// Two commands still ask. Claiming `db:deploy` is the one claim that can lead to
// a Supabase deploy, and clearing ANOTHER thread's claims is the one command
// that can undo work this thread is not responsible for. Everything else is
// covered twice over already: Alex approved the plan that named the files, and
// the guard still refuses an edit to a file this thread has not claimed.

/** Flags of claims.mjs that take a value, so the value is not read as an item. */
const VALUE_FLAGS = new Set(["--owner", "--run-tag", "--note", "--step"]);

/** Shell substitution, which hides a command's real arguments from this parser. */
const SUBSTITUTION = /\$\(|\$\{|`/;

/**
 * Is this command chained onto another one?
 *
 * A claim must stand alone. Permission rules are prefix matches, and it is not
 * documented whether Claude Code splits a compound command before matching them
 * — so `claims.mjs check x && claims.mjs claim y db:deploy` might match the
 * pre-approved `check` rule and claim db:deploy without ever asking Alex. The
 * guard applies this AFTER stripping a `cd <this checkout> &&` prefix, which is
 * the one chain that cannot change which claims file is written or by whom.
 */
export function isChained(command) {
  return /(?:&&|\|\||[;|]|\n)/.test(String(command));
}

/** Split a command into tokens, honouring single and double quotes. */
function tokenise(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(command))) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/**
 * What a `node scripts/claims.mjs …` command asks for: `{ sub, items }`, or
 * null if this command is not one.
 */
export function parseClaimsCommand(command) {
  const tokens = tokenise(command);
  const at = tokens.findIndex((t) => /(?:^|[\\/])claims\.mjs$/.test(t));
  if (at === -1) return null;

  const sub = tokens[at + 1];
  if (!sub || sub.startsWith("-")) return null;

  const items = [];
  for (let i = at + 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (VALUE_FLAGS.has(token)) {
      i += 1; // skip the flag's value, so --note "db:deploy" is not an item
      continue;
    }
    if (token.startsWith("-")) continue;
    items.push(token);
  }
  return { sub, items };
}

/**
 * Is this exactly one `node scripts/claims.mjs …` or `node scripts/clip.mjs …`,
 * and nothing else?
 *
 * Then its arguments are item names, a title and a file to read, none of them
 * ever run, so a command word among them (`install-shortcuts.ps1`, a title
 * saying "cp") writes nothing, and only a redirection can. It must START with
 * node and the script, so `node -e "<write>" scripts/claims.mjs claim x` does
 * not qualify, and it may hold no separator, substitution or subshell. A lone
 * `&` is refused too: isChained does not count it, and `claim x & mv a b` runs
 * both. Takes the command after the own-checkout `cd` strip.
 */
export function isLoneScriptCommand(command) {
  const c = String(command).trim();
  if (!/^node\s+(?:\.[\\/])?scripts[\\/](?:claims|clip)\.mjs(?:\s|$)/.test(c)) return false;
  // `2>&1` and `>&2` are the one harmless use of `&`.
  return !/[&|;\n`$()<]/.test(c.replace(/\d?>&\d/g, ""));
}

/**
 * A short reason this claims command needs Alex's approval, or null.
 *
 * `owner` is this thread, so `cleanup` on itself — which is `release --all` by
 * another name — does not ask, while `cleanup` on anyone else does.
 */
export function claimsCommandApproval(command, owner) {
  const parsed = parseClaimsCommand(command);
  if (!parsed) return null;

  // A command whose arguments are computed cannot be read, and a rule that
  // cannot read the arguments cannot say db:deploy is not among them.
  if (SUBSTITUTION.test(String(command))) return "claims command it cannot read";

  const { sub, items } = parsed;
  if (sub === "claim" && items.some((i) => fold(i) === "db:deploy")) {
    return "claim db:deploy";
  }
  if (sub === "cleanup" && items.length && fold(items[0]) !== fold(owner)) {
    return `cleanup ${items[0]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// stale database claims
// ---------------------------------------------------------------------------

/**
 * How long a `db:` claim may be held before `status` complains.
 *
 * A database claim is meant to live for minutes: claim it at the step that
 * deploys, release it once that step is checkpointed into main. One was held for
 * thirteen hours and blocked another thread's deploy the whole time, and nothing
 * anywhere said so.
 */
export const DB_CLAIM_STALE_MS = 60 * 60 * 1000;

/** Database claims held longer than DB_CLAIM_STALE_MS. */
export function staleDbClaims(state, now = Date.now()) {
  return state.claims.filter(
    (c) => isDbItem(c.item) && now - Date.parse(c.claimed_at) > DB_CLAIM_STALE_MS,
  );
}

/** Every claim on this repo-relative path, directly or through a folder. */
export function holdersOf(state, rel) {
  return state.claims.filter((c) => !isDbItem(c.item) && holds(c.item, rel));
}

/** Who holds this repo-relative path, if anyone: an owner name or null. */
export function holderOf(state, rel) {
  return holdersOf(state, rel)[0]?.owner ?? null;
}

/**
 * Split changed files three ways by who has claimed them.
 *
 * Both gitcom and gitpush's main-checkout path decide what to stage from this,
 * so the rule lives here once: another owner's file is never staged, and an
 * unclaimed file is Alex's to decide about.
 */
export function partitionByClaims(state, owner, files) {
  const mine = [];
  const others = [];
  const unclaimed = [];
  for (const f of files) {
    const holder = holderOf(state, f.path);
    if (holder === owner) mine.push(f);
    else if (holder) others.push({ ...f, holder });
    else unclaimed.push(f);
  }
  return { mine, others, unclaimed };
}

/**
 * Everything one owner holds, claims and reservations, as plain item strings.
 */
export function itemsHeldBy(state, owner) {
  return [
    ...state.claims.filter((c) => c.owner === owner).map((c) => c.item),
    ...state.reservations.filter((r) => r.owner === owner).map((r) => r.item),
  ];
}

/**
 * Drop an owner's claims and reservations, returning what went.
 *
 * `match` narrows it — gitpush Checkpoint passes one that only takes `db:*`,
 * because a checkpoint puts the database work in main while the front-end work
 * stays in the worktree and keeps its claims.
 *
 * This is the release path for FILE claims: a thread never releases its own,
 * gitpush does it here once the work is merged and pushed. See .claude/CLAUDE.md.
 *
 * Without `match` it is a Finish, so the owner's own block records as a waiter go too.
 */
export function removeClaims(ctx, owner, match) {
  const finishing = match === undefined;
  match ??= () => true;
  const removed = [];
  withLock(ctx, (state) => {
    for (const c of state.claims) {
      if (c.owner === owner && match(c.item)) removed.push(c.item);
    }
    state.claims = state.claims.filter(
      (c) => !(c.owner === owner && match(c.item)),
    );
    state.reservations = state.reservations.filter(
      (r) => !(r.owner === owner && match(r.item)),
    );
    pruneBlocksLocked(ctx, state, finishing ? owner : null);
    return state;
  });
  return removed;
}

// ---------------------------------------------------------------------------
// block records
// ---------------------------------------------------------------------------
//
// When a thread hits a path another thread holds — `check`, a refused `claim`,
// or the guard blocking an edit — it is written down here, so Switchboard can
// show it and the holder can be told. Nothing here grants or refuses anything.
//
// A separate file, not a key in the claims file: every `writeState`, including
// the copies in worktrees that have not synced, writes only claims and
// reservations, and would silently drop a key it did not know.

/** Read the blocks file. Missing or broken reads as empty: a lost record is harmless. */
export function readBlocks(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed.blocks) ? parsed.blocks : [];
  } catch {
    return [];
  }
}

export function writeBlocks(file, blocks) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ blocks }, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** An owner's project code: the folder name for a worktree, main's bound code for main. */
export function codeOfOwner(ctx, owner) {
  return owner === "main" ? (readMainCode(ctx) ?? "main") : owner;
}

/**
 * Records still in force: the holder still holds a claim overlapping the path.
 * That one test covers "the waiter got it" and "the holder let go", and readers
 * apply it themselves, so a write from older code can never leave one showing.
 */
export function liveBlocks(blocks, state) {
  return blocks.filter((b) =>
    state.claims.some((c) => c.owner === b.holder && !isDbItem(c.item) && overlaps(c.item, b.item)),
  );
}

/**
 * Loops among live blocks: threads that wait on each other, directly or round a
 * longer ring. Returns { inLoop(waiter, holder), loops: [[owner, …], …] }.
 * An edge waiter→holder is in a loop when the waiter is reachable back from the holder.
 * Switchboard's status.ahk (BlockLoops) mirrors this rule; keep the two in step.
 */
export function blockLoops(live) {
  const next = new Map();
  for (const b of live) {
    if (!next.has(b.waiter)) next.set(b.waiter, new Set());
    next.get(b.waiter).add(b.holder);
  }
  const reaches = (from, to) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      for (const n of next.get(stack.pop()) ?? []) {
        if (n === to) return true;
        if (!seen.has(n)) seen.add(n), stack.push(n);
      }
    }
    return false;
  };
  const inLoop = (waiter, holder) => next.get(waiter)?.has(holder) === true && reaches(holder, waiter);
  const loops = [];
  const placed = new Set();
  for (const owner of [...next.keys()].sort()) {
    if (placed.has(owner) || !reaches(owner, owner)) continue;
    const ring = [...next.keys()].filter((o) => o === owner || (reaches(owner, o) && reaches(o, owner))).sort();
    ring.forEach((o) => placed.add(o));
    loops.push(ring);
  }
  return { inLoop, loops };
}

const sameBlock = (a, b) =>
  a.waiter === b.waiter && a.holder === b.holder && fold(a.item) === fold(b.item);

/**
 * Add a record for each (path, holder claim), keeping the first `blocked_at`.
 * Pure: returns the new list. `hits` is [{ item, holders: [claim, …] }].
 */
export function addBlocks(blocks, { waiter, hits, via, runTag = null, codeOf = (o) => o, now = new Date() }) {
  const out = blocks.slice();
  const stamp = now.toISOString();
  for (const { item, holders } of hits) {
    for (const c of holders) {
      if (c.owner === waiter || isDbItem(c.item)) continue;
      const rec = {
        waiter,
        waiter_code: codeOf(waiter),
        item,
        holder: c.owner,
        holder_code: codeOf(c.owner),
        holder_item: c.item,
        via,
        run_tag: runTag,
        blocked_at: stamp,
        last_seen: stamp,
      };
      const at = out.findIndex((b) => sameBlock(b, rec));
      if (at === -1) out.push(rec);
      else out[at] = { ...out[at], holder_item: c.item, via, last_seen: stamp };
    }
  }
  return out;
}

/**
 * What changed between two block lists, as Overwatch events (spec 4.5): `new` for a record that appeared,
 * `repeat` for one seen again, `clear` for one gone. Pure.
 */
export function blockEvents(before, after, now = new Date()) {
  const ev = (b, event, at) => ({
    event,
    waiter_code: b.waiter_code,
    holder_code: b.holder_code,
    item: b.item,
    run_tag: b.run_tag ?? null,
    blocked_at: b.blocked_at,
    at,
  });
  const out = [];
  for (const a of after) {
    const b = before.find((x) => sameBlock(x, a));
    if (!b) out.push(ev(a, "new", a.blocked_at));
    else if (a.last_seen !== b.last_seen) out.push(ev(a, "repeat", a.last_seen));
  }
  for (const b of before) {
    if (!after.some((a) => sameBlock(a, b))) out.push(ev(b, "clear", now.toISOString()));
  }
  return out;
}

/** Inside the lock: queue the events for Overwatch and start the sender. Never throws. */
export function queueBlockEvents(ctx, before, after, now = new Date()) {
  if (!ctx.outboxFile) return;
  try {
    const events = blockEvents(before, after, now);
    if (!events.length) return;
    queueEvents(ctx.outboxFile, events);
    kickSender(ctx);
  } catch {
    /* a lost event is acceptable; a failed claim or edit is not */
  }
}

/** Inside the lock: drop dead records, and a finished waiter's own. Writes only on change. */
export function pruneBlocksLocked(ctx, state, finishedWaiter = null) {
  if (!ctx.blocksFile) return;
  const before = readBlocks(ctx.blocksFile);
  const after = liveBlocks(before, state).filter((b) => b.waiter !== finishedWaiter);
  if (after.length !== before.length) {
    writeBlocks(ctx.blocksFile, after);
    queueBlockEvents(ctx, before, after);
  }
}

/**
 * Record blocks under the lock. Best-effort by design: the callers are `check`
 * and the guard, whose output and decision must not change, so this never throws.
 */
export function recordBlocks(ctx, args, { timeoutMs } = {}) {
  try {
    withLock(
      ctx,
      (state) => {
        const before = readBlocks(ctx.blocksFile);
        const next = liveBlocks(addBlocks(before, { codeOf: (o) => codeOfOwner(ctx, o), ...args }), state);
        writeBlocks(ctx.blocksFile, next);
        queueBlockEvents(ctx, before, next, args.now);
        return null; // the claims file is untouched
      },
      { timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * What the block-notice hook tells a holding thread, or "" when nobody waits on it.
 * Pure: no git, so it cannot know which files are changed — it gives both rules
 * and lets `yield` decide.
 */
export function holderNotice({ blocks, state, owner, codeOf = (o) => o }) {
  const live = liveBlocks(blocks, state);
  const mine = live.filter((b) => b.holder === owner);
  if (!mine.length) return "";
  const { inLoop } = blockLoops(live);
  const mutual = [...new Set(mine.filter((b) => inLoop(b.waiter, owner)).map((b) => b.waiter))];
  const me = codeOf(owner);
  const isMain = owner === "main";
  // Mapped now, not from the record: main may have been bound since.
  const waiterOf = (b) => codeOf(b.waiter);

  const files = mine.map((b) => {
    const folder = isFolderItem(b.holder_item)
      ? `\n    You hold it through the folder claim ${b.holder_item}, so it cannot be yielded: treat it as changed.`
      : "";
    return `  - ${waiterOf(b)} is waiting on ${b.item} (blocked since ${b.blocked_at}).${folder}`;
  });
  const merge = isMain
    ? `     - the command: there is NO single-file merge from the main checkout. \`gitpush main push\`\n` +
      `       carries everything main has claimed and changed, not just this file. Say so plainly.`
    : `     - the exact command: \`gitpush ${owner} checkpoint --paths <file>\`. After it, the file matches\n` +
      `       main and the claim can be released with \`node scripts/claims.mjs yield <file>\`.`;

  return [
    `CLAIM BLOCK NOTICE — another project is waiting on files this thread (${me}) holds:`,
    ...files,
    ``,
    `Do NOT change your plan for this prompt because of this. Do the work you were asked to do,`,
    `and handle each file above as follows.`,
    ``,
    `1. Unchanged (no difference from main, nothing staged, uncommitted or untracked): run`,
    `   \`node scripts/claims.mjs yield <file>\` on its own, and say in your report that you released`,
    `   it. yield checks those conditions itself; if it refuses, the file counts as changed.`,
    `   If the permission system denies the command, do not retry it or try another way: say in`,
    `   your report that the file is unchanged and Alex can run the yield command himself.`,
    `2. Changed, or yield refused: KEEP the claim. Never merge it and never yield it. Your report says:`,
    `   - the file has changes, and whether they are finished now or will be once testing passes;`,
    `   - which project is waiting on it;`,
    `   - the merge impact, assuming the merge goes straight to production (Vercel deploys main):`,
    `     - exactly which paths the checkpoint would carry;`,
    `     - whether main would still build and run with only those paths: imports, new components,`,
    `       helpers, database columns, functions or migrations the file depends on that are not in main;`,
    `     - what Alex would see change in the live app;`,
    merge,
    `3. Either way, the report has one line per file starting "Blocking:", for example`,
    `   Blocking: ${waiterOf(mine[0])} waits for ${mine[0].item}`,
    ``,
    `The waiting thread must run gitsync before it edits a freed file.`,
    ...(mutual.length
      ? [
          ``,
          `DEADLOCK: ${mutual.map((w) => codeOf(w)).join(", ")} ${mutual.length === 1 ? "is" : "are"} waiting on you, and you are`,
          `waiting on ${mutual.length === 1 ? "it" : "them"} too (directly or round a ring), so neither side can go first by claiming.`,
          `Say in your report that this is a deadlock. Whichever thread's change is ready first reports its merge impact,`,
          `so Alex can checkpoint it and free the file for the other.`,
        ]
      : []),
  ].join("\n");
}

/**
 * Whether `yield` may release `item` for `owner`: { ok, reason, blocks }.
 * Pure; `changed` is the git answer, worked out by the caller.
 */
export function yieldDecision({ state, blocks, owner, item, changed }) {
  if (isDbItem(item) || isFolderItem(item)) {
    return { ok: false, reason: "yield takes one file, not a folder or a database item." };
  }
  const waiting = liveBlocks(blocks, state).filter(
    (b) => b.holder === owner && fold(b.holder_item) === fold(item),
  );
  if (!waiting.length) {
    return { ok: false, reason: `no thread is waiting on ${item} held by ${owner}.` };
  }
  const exact = state.claims.some((c) => c.owner === owner && fold(c.item) === fold(item));
  if (!exact) {
    return {
      ok: false,
      reason: `${owner} holds ${item} through a folder claim, which cannot be yielded. Treat it as changed.`,
      blocks: waiting,
    };
  }
  if (changed) {
    return {
      ok: false,
      reason: `${item} has changes (${changed}). Keep the claim and report the merge impact.`,
      blocks: waiting,
    };
  }
  return { ok: true, blocks: waiting };
}

/**
 * How this checkout's copy of `rel` differs from main, as a short reason, or "".
 * Worktree: against local `main`. Main checkout: against `origin/main`, else HEAD.
 * A git error counts as changed, so a broken check never frees a file.
 */
export function fileChanges(ctx, rel) {
  const git = (args) =>
    execFileSync("git", args, { cwd: ctx.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let base = "main";
  if (!ctx.isWorktree) {
    try {
      git(["rev-parse", "--verify", "--quiet", "origin/main"]);
      base = "origin/main";
    } catch {
      base = "HEAD";
    }
  }
  try {
    if (git(["diff", "--name-only", base, "--", rel]).trim()) return `differs from ${base}`;
    const st = git(["status", "--porcelain", "--untracked-files=all", "--", rel]).trim();
    if (st) return st.startsWith("??") ? "untracked" : "uncommitted or staged";
    return "";
  } catch {
    return "git could not compare it";
  }
}

// ---------------------------------------------------------------------------
// the claims file
// ---------------------------------------------------------------------------

export function emptyState() {
  return { claims: [], reservations: [] };
}

/**
 * Read the claims file.
 *
 * A missing file is normal — nobody has claimed anything yet — and comes back
 * as empty state with `existed: false`, because the two callers treat that
 * differently: the CLI happily creates it, the guard refuses to let an edit
 * through on a claims system that is not running yet.
 *
 * A file that exists but does not parse is never treated as empty. Starting
 * over would silently drop every live claim and let two threads edit the same
 * file, so it throws.
 */
export function readState(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ...emptyState(), existed: false };
    throw new ClaimsError("unreadable", `cannot read ${file}: ${err.message}`);
  }
  if (!text.trim()) return { ...emptyState(), existed: true };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ClaimsError(
      "unreadable",
      `claims file is not valid JSON: ${file}\n${err.message}`,
    );
  }
  return {
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    reservations: Array.isArray(parsed.reservations) ? parsed.reservations : [],
    existed: true,
  };
}

/** Write via a temp file in the same folder, so a crash cannot truncate it. */
export function writeState(file, state) {
  const tmp = `${file}.tmp-${process.pid}`;
  const out = { claims: state.claims, reservations: state.reservations };
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// locking
// ---------------------------------------------------------------------------

// The lock we currently hold, if any. `process.exit()` skips `finally`, and
// callers do exit from inside the lock, so releasing it is also wired to the
// exit event — otherwise one bad claims file would wedge every later command
// behind a lock nobody owned.
let heldLock = null;
process.on("exit", releaseHeldLock);

function releaseHeldLock() {
  if (!heldLock) return;
  const lock = heldLock;
  heldLock = null;
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    /* nothing useful to do while exiting */
  }
}

/**
 * Run `fn(state)` with the lock held; whatever it returns is saved.
 *
 * mkdir is atomic on every platform we care about, so the folder itself is the
 * lock. The state is re-read INSIDE the lock, which is the whole point: a
 * thread that checked before waiting sees the other thread's claim now.
 *
 * `onStale` is called when a lock older than LOCK_STALE_MS is cleared away, so
 * the caller can say so in its own voice.
 */
export function withLock(ctx, fn, { onStale, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const lock = path.join(ctx.dir, LOCK_DIR);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lock);
      heldLock = lock;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released while we looked
      }
      if (age > LOCK_STALE_MS) {
        onStale?.(age);
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          /* another thread got there first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new ClaimsError(
          "locked",
          `Could not get the claims lock within ${timeoutMs / 1000}s: ${lock}\n` +
            `Another thread is mid-write. Try again; if it never clears, delete that folder.`,
        );
      }
      sleep(LOCK_RETRY_MS);
    }
  }

  try {
    const state = readState(ctx.file);
    const next = fn(state);
    if (next) writeState(ctx.file, next);
  } finally {
    releaseHeldLock();
  }
}

function sleep(ms) {
  // Synchronous on purpose: everything else here is synchronous, and the wait
  // is bounded at 10 seconds.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
