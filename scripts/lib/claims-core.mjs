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

export const CLAIMS_FILE = "alfred-claims.json";
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
    owner: isWorktree ? path.basename(root) : "main",
    isWorktree,
  };
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

const DB_ITEM = /^db:(deploy|(table|fn):[A-Za-z0-9_.-]+)$/;

export const isDbItem = (item) => item.startsWith("db:");
export const isFolderItem = (item) => item.endsWith("/");
export const fold = (s) => (IGNORE_CASE ? s.toLowerCase() : s);

/**
 * Normalise one item into its stored form, or throw ClaimsError("bad-item").
 *
 * Database items pass through as written. Everything else is a path: absolute
 * paths are made repo-relative, backslashes become slashes, and a trailing
 * slash is kept because that is what makes it a folder claim.
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
  if (isFolder) rel += "/";
  return rel;
}

/**
 * Repo-relative form of an absolute path, or null if it is outside the repo.
 * The guard uses this rather than normaliseItem because "outside the repo" is
 * an ordinary, allowed answer there, not an error.
 */
export function toRepoRelative(p, root) {
  const rel = path.relative(root, path.resolve(root, p)).split(path.sep).join("/");
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

/** Is this repo-relative path exempt from claiming? */
export function isExempt(rel) {
  const p = fold(rel);
  return EXEMPT_PREFIXES.some((prefix) => p.startsWith(fold(prefix)));
}

/** Does folder `f` contain path `p`? */
export function covers(f, p) {
  if (!isFolderItem(f)) return false;
  return fold(p).startsWith(fold(f));
}

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

/** Does `owner` hold `item`, directly or through a folder claim? */
export function heldBy(state, item, owner) {
  return state.claims.some(
    (c) =>
      c.owner === owner && (fold(c.item) === fold(item) || covers(c.item, item)),
  );
}

// ---------------------------------------------------------------------------
// shell commands that write
// ---------------------------------------------------------------------------
//
// The gap this closes, found on 2026-09-28: a session was asked to add a comment
// to src/utils/recurrence.js and did it entirely in the shell —
//
//   { printf '...'; cat src/utils/recurrence.js; } > /tmp/rec.$$ \
//     && mv /tmp/rec.$$ src/utils/recurrence.js
//
// The guard only looked at Edit/Write and at Supabase deploys, so it allowed
// this without a word. Note that the redirect target was /tmp — an
// "is anything redirected into the repo?" check would have missed it too. The
// repo file was clobbered by `mv`, so destinations of mv/cp count as writes.

/**
 * Shell and PowerShell constructs that change a file, as [regex, label].
 * The label is what the block message shows, so it names the construct rather
 * than whatever characters happened to match.
 */
const WRITE_INDICATORS = [
  // Redirection, but not fd duplication (2>&1, >&2) and not the bit bucket.
  // `> /dev/null` is on the end of half the commands we run and never writes
  // anything; counting it made `claims.mjs status >/dev/null` a "write".
  // `=>` and `->` are arrows in inline JS, not redirects.
  [/(?:^|[^0-9&>=-])>>\s*(?!\/dev\/null\b|NUL\b)[^&\s]/, ">> redirection"],
  [/(?:^|[^0-9&>=-])>(?!>)\s*(?!\/dev\/null\b|NUL\b)[^&\s]/, "> redirection"],
  [/\btee\b/, "tee"],
  [/\b(?:mv|cp|rsync|install|ln)\b/, "mv/cp"],
  [/\b(?:rm|rmdir|unlink|shred|truncate|touch|mkdir)\b/, "rm/touch/mkdir"],
  [/\b(?:sed|perl|ruby)\b[^|]*\s-i\b/, "in-place sed/perl"],
  [/\bdd\b[^|]*\bof=/, "dd of="],
  [/\b(?:patch|git\s+apply)\b/, "patch"],
  [/\bwrite(?:File)?(?:Sync)?\s*\(/i, "writeFileSync"],
  [/\bopen\s*\([^)]*['"][wax]/, "open(...,'w')"],
  [/\b(?:Set|Add|Clear)-Content\b/i, "Set-Content"],
  [/\bOut-File\b/i, "Out-File"],
  [/\b(?:New|Copy|Move|Remove|Rename)-Item\b/i, "New/Copy/Move/Remove-Item"],
  [/\bSet-ItemProperty\b/i, "Set-ItemProperty"],
];

/** A label for the first write construct this command matches, or null. */
export function writeIndicator(command) {
  const c = String(command);
  for (const [re, label] of WRITE_INDICATORS) {
    if (re.test(c)) return label;
  }
  return null;
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
export function repoPathsIn(command, root) {
  const tokens = String(command).split(/[\s"'`|&;()<>{}]+/);
  const found = new Set();

  for (const raw of tokens) {
    const token = raw.replace(/^[=~]+/, "").trim();
    if (!token || token.startsWith("-") || token.includes("://")) continue;

    // A bare word is not a path — `npm test` must not resolve to <root>/test.
    const hasExtension = /\.[A-Za-z0-9]{1,6}$/.test(token);
    // Backslash only counts with a drive letter or a real extension: `printf
    // "x\n"` leaves the token `x\n`, which is an escape sequence, not a path.
    const looksLikePath =
      token.includes("/") ||
      /^[A-Za-z]:[\\/]/.test(token) ||
      (token.includes("\\") && hasExtension);
    if (!looksLikePath && !hasExtension) continue;

    let rel;
    try {
      rel = toRepoRelative(token, root);
    } catch {
      continue;
    }
    if (!rel || isExempt(rel)) continue;

    // Drop the debris that survives tokenising. A path with a slash needs its
    // parent folder to exist, which every real write target has — that removes
    // `s/a/b/` out of `sed -i "s/a/b/" src/x.js`. A BARE filename has to exist
    // outright, because its "parent" is the repo root, which always does — that
    // removes `console.log` and `claims.mjs` out of surrounding prose and code.
    const abs = path.resolve(root, rel);
    try {
      const ok = rel.includes("/")
        ? existsSync(abs) || existsSync(path.dirname(abs))
        : existsSync(abs);
      if (!ok) continue;
    } catch {
      continue;
    }
    found.add(rel);
  }
  return [...found];
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
 */
export function removeClaims(ctx, owner, match = () => true) {
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
    return state;
  });
  return removed;
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
export function withLock(ctx, fn, { onStale } = {}) {
  const lock = path.join(ctx.dir, LOCK_DIR);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

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
          `Could not get the claims lock within ${LOCK_TIMEOUT_MS / 1000}s: ${lock}\n` +
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
