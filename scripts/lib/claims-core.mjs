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
 * Commands that change a file wherever they appear, as [regex, label].
 *
 * `(?<![-\w])` is the fix for a real and repeated false positive: `\bln\b`
 * matched the `-ln` of `git grep -ln`, because `\b` sits happily between `-` and
 * a letter. A write command is a WORD, never the tail of a flag, so a hyphen in
 * front disqualifies it. Same story for `--install`.
 *
 * `(?!-)` is the same rule from the other side: `install\b` matched the path
 * `tools/claude-sessions/install-shortcuts.ps1` and blocked a claim as a copy.
 *
 * `[^|;&\n]*` in the in-place rule stops it reaching across a command
 * separator. `sed -n '1,5p' a.js ; grep -i x b.js` used to read as an in-place
 * sed, because the old `[^|]*` happily crossed the `;` to find `grep`'s `-i`.
 *
 * Quotes are NOT stripped before these are matched, deliberately:
 * `sh -c "mv a b"` really does move a file.
 */
// A write word inside a path is not the command either: `d.patch`, `ui/touch/`,
// `touch.js` (switchboard_guard). `rm.exe` still counts.
const word = (alternatives) =>
  new RegExp(String.raw`(?<![-\w.])(?:${alternatives})\b(?!-|/|\.(?!exe\b)\w)`);

const COMMAND_INDICATORS = [
  [word("tee"), "tee"],
  [word("mv|cp|rsync|install|ln"), "mv/cp"],
  [word("rm|rmdir|unlink|shred|truncate|touch|mkdir"), "rm/touch/mkdir"],
  [/(?<![-\w])(?:sed|perl|ruby)\b[^|;&\n]*\s-i\b/, "in-place sed/perl"],
  [/(?<![-\w])dd\b[^|;&\n]*\bof=/, "dd of="],
  [word(String.raw`patch|git\s+apply`), "patch"],
  [/(?<![-\w])find\b[^|;&\n]*\s-delete\b/, "find -delete"],
  [/\bwrite(?:File)?(?:Sync)?\s*\(/i, "writeFileSync"],
  [/\bopen\s*\([^)]*['"][wax]/, "open(...,'w')"],
  // PowerShell cmdlets match in EITHER shell: `bash -c 'powershell -c "Set-Content …"'`
  // writes a file just as surely as running it in a PowerShell window does. The
  // names are distinctive enough that matching them anywhere costs nothing.
  [/\b(?:Set|Add|Clear)-Content\b/i, "Set-Content"],
  [/\b(?:Out-File|Tee-Object|Export-(?:Csv|Clixml))\b/i, "Out-File"],
  [/\b(?:New|Copy|Move|Remove|Rename)-Item\b/i, "New/Copy/Move/Remove-Item"],
  [/\bSet-Item(?:Property)?\b/i, "Set-ItemProperty"],
];

/**
 * Commands that unpack into a folder they name, as [regex, label, destination].
 * With the destination given, only it counts; without one, they are strict.
 * `unzip -l/-v/-t/-p/-Z` only list or print, so they are not writes.
 */
const DEST = String.raw`\s*("[^"]*"|'[^']*'|[^\s|;&<>()]+)`;
const EXTRACT_INDICATORS = [
  [
    /(?<![-\w])tar\b(?!-)(?:\s+[A-Za-z]*x[A-Za-z]*\s|[^|;&\n]*\s(?:-[A-Za-z]*x[A-Za-z]*\b|--extract\b|--get\b))/,
    "tar -x",
    new RegExp(String.raw`(?<![-\w])tar\b[^|;&\n]*\s(?:-C|--directory=?)` + DEST),
  ],
  [
    /(?<![-\w])unzip\b(?!-)(?![^|;&\n]*\s-[lvtpZ]\b)/,
    "unzip",
    new RegExp(String.raw`(?<![-\w])unzip\b[^|;&\n]*\s-d` + DEST),
  ],
  // `git diff --output=<file>` writes the diff to that file.
  [
    /(?<![-\w])git\b[^|;&\n]*\s(?:diff|log|show)\b[^|;&\n]*\s--output\b/,
    "git --output",
    new RegExp(String.raw`(?<![-\w])--output(?:=|\s)` + DEST),
  ],
];

/**
 * Programs that only read, so words in their arguments are search text, not
 * commands: `grep -n "rmdir"` and `git status -- '*touch*'` were both blocked as
 * writes (switchboard_guard, 2026-10-06). Lower case, without `.exe`.
 */
const READ_ONLY = new Set([
  "grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "wc", "ls",
  "select-string", "sls", "get-content", "gc", "type", "get-childitem", "gci", "dir",
]);
const READ_ONLY_GIT = new Set(["grep", "log", "diff", "show", "status", "blame"]);
/** Flags that make one of those run a program (`rg --pre`, `git grep -O`) or write (`--output`). */
const UNSAFE_FLAG = /^(?:--pre\b|-O|--open-files-in-pager\b|--output\b)/;

/** `$(…)`, backticks or an unquoted `(` outside single quotes: something else runs. */
function runsSomething(element, shell) {
  const escape = shell === "powershell" ? "`" : "\\";
  let quote = null;
  for (let i = 0; i < element.length; i += 1) {
    const ch = element[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "$" && element[i + 1] === "(") return true;
    if (ch === "`" && shell !== "powershell") return true;
    if (ch === escape) {
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") return true;
  }
  return false;
}

/** Is this pipeline element a read-only program with nothing in it that runs or writes? */
function isReadOnly(element, shell) {
  if (runsSomething(element, shell)) return false;
  const tokens = element.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  if (tokens.some((t) => UNSAFE_FLAG.test(t))) return false;
  const program = tokens[0].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  if (program !== "git") return READ_ONLY.has(program);
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "-C") i += 1;
    else if (t === "-c") return false; // config can name a program to run
    else if (!t.startsWith("-")) return READ_ONLY_GIT.has(t.toLowerCase());
  }
  return false;
}

/** The command with its read-only pipeline elements left out, one element per line. */
function writableText(command, shell) {
  return splitCommand(command, shell, { pipes: true })
    .filter((element) => !isReadOnly(element, shell))
    .join("\n");
}

/**
 * PowerShell's short aliases for the cmdlets above — `mi`, `ci`, `ni`, `sc`, and
 * the DOS-era ones (`del`, `copy`, `move`, `rd`).
 *
 * ⚠️ THESE ARE ONLY APPLIED TO A POWERSHELL COMMAND, AND ONLY AT A COMMAND
 * POSITION, because they are short enough to be anything. `ci` is Copy-Item at
 * the front of a pipeline element and two letters of prose anywhere else, and
 * `CI=true npx react-scripts test` — the project's own test command — starts
 * with what a case-insensitive `\bci\b` would happily call a copy.
 *
 * `mv`, `cp`, `rm` and `rmdir` are PowerShell aliases too, but they are in the
 * list above already and are distinctive enough not to need anchoring.
 */
const PS_ALIASES = [
  "mi", "ci", "cpi", "ri", "ni", "rni", "ren", "sc", "ac", "clc", "sp",
  "move", "copy", "del", "erase", "rd", "md",
];
const PS_ALIAS_INDICATOR = [
  new RegExp(String.raw`(?:^|[;&|(){}\n])\s*(?:${PS_ALIASES.join("|")})\b`, "i"),
  "PowerShell alias (mi/ci/ni/sc/del…)",
];

/**
 * Targets that swallow output rather than writing a file.
 * `$null` is PowerShell's bit bucket, and `2>$null` is on the end of half the
 * PowerShell we run.
 */
const NULL_SINKS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "nul",
  "con",
  "$null",
]);

/**
 * Every `>` and `>>` redirection in a command, with its target.
 *
 * Hand-scanned rather than matched with a regex because the thing that has to
 * be got right — **is this `>` inside quotes?** — is exactly what a regex cannot
 * see. A `sed` substitution that puts a `>` in its replacement text was read as
 * a redirect into the repo and blocked, and so was every other command with a
 * `>` inside a pattern or a message. State is one character: which quote we are
 * in, if any.
 *
 * Skipped: fd duplication (`2>&1`, `>&2`), which redirects a stream at another
 * stream and never touches a file, and the `=>` and `->` of inline JS.
 * A leading fd number IS honoured — `cmd 2> errors.txt` writes errors.txt, and
 * so does PowerShell's `*>`.
 *
 * ⚠️ THE ESCAPE CHARACTER IS NOT THE SAME IN BOTH SHELLS, and getting it wrong
 * loses the quote state, which loses a redirect. Bash escapes with `\`;
 * PowerShell escapes with a backtick and treats `\` as an ordinary character —
 * which it must, since every Windows path is full of them.
 */
export function scanRedirects(command, shell = "bash") {
  const s = String(command);
  const escape = shell === "powershell" ? "`" : "\\";
  const found = [];
  let i = 0;
  let quote = null;

  while (i < s.length) {
    const ch = s[i];

    if (quote) {
      // Escapes apply inside double quotes only; inside single quotes both
      // shells treat the character as ordinary.
      if (ch === escape && quote === '"') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === escape) {
      i += 2;
      continue;
    }
    if (ch !== ">") {
      i += 1;
      continue;
    }

    const prev = s[i - 1];
    let j = i + 1;
    let op = ">";
    if (s[j] === ">") {
      op = ">>";
      j += 1;
    }
    if (s[j] === "&" || prev === "=" || prev === "-") {
      i = j + (s[j] === "&" ? 1 : 0);
      continue;
    }

    while (j < s.length && (s[j] === " " || s[j] === "\t")) j += 1;

    let target = "";
    let tq = null;
    while (j < s.length) {
      const c = s[j];
      if (tq) {
        if (c === tq) tq = null;
        else target += c;
        j += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        tq = c;
        j += 1;
        continue;
      }
      if (/[\s|&;<>()]/.test(c)) break;
      target += c;
      j += 1;
    }

    if (target) found.push({ op, target });
    i = j;
  }
  return found;
}

/**
 * Expand environment variables in a redirect target, as the shell would.
 *
 * `> "$TEMP/notes.txt"` was blocked as a write to `supabase/functions/mcp`,
 * because an unexpanded `$TEMP` looks like a repo-relative folder. This reads
 * the same environment the shell has.
 *
 * What stays unexpanded is treated as outside the repo by the caller, and that
 * is sound rather than lazy: a variable this process cannot resolve is one the
 * shell cannot resolve either, so it expands to nothing and the path lands at
 * the filesystem root — never inside the repo.
 */
function expandVars(target) {
  return String(target)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, n) => process.env[n] ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => process.env[n] ?? m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => process.env[n] ?? m)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => process.env[n] ?? m);
}

/** Everything that says this command writes, redirections first. */
export function writeIndicators(command, shell = "bash") {
  const found = [];
  const redirects = scanRedirects(command, shell).filter(
    (r) => !NULL_SINKS.has(fold(r.target)),
  );
  if (redirects.length) {
    found.push({
      label: `${redirects[0].op} redirection`,
      kind: "redirect",
      targets: redirects.map((r) => r.target),
    });
  }
  // Redirections above are read from the whole command; write words only from
  // the elements that are not read-only programs.
  const c = writableText(command, shell);
  const indicators =
    shell === "powershell"
      ? [...COMMAND_INDICATORS, PS_ALIAS_INDICATOR]
      : COMMAND_INDICATORS;
  for (const [re, label] of indicators) {
    if (re.test(c)) found.push({ label, kind: "command" });
  }
  for (const [re, label, destRe] of EXTRACT_INDICATORS) {
    if (re.test(c)) found.push({ label, kind: "extract", destRe });
  }
  return found;
}

/** A label for the first write construct this command matches, or null. */
export function writeIndicator(command, shell = "bash") {
  return writeIndicators(command, shell)[0]?.label ?? null;
}

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
export function writeCheck(command, root, shell = "bash", { redirectsOnly = false, checkout = null } = {}) {
  const kinds = (c) =>
    writeIndicators(c, shell).filter((f) => !redirectsOnly || f.kind === "redirect");
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
  let whole = /<</.test(command);
  let afterCd = false;

  for (const raw of whole ? [] : splitCommand(command, shell)) {
    const assigned = parseAssignment(raw, shell);
    if (assigned) {
      const value = assigned.literal ? assigned.value : expandVars(expandLocal(assigned.value, vars));
      if (unreadable(value)) vars.delete(assigned.name);
      else vars.set(assigned.name, value);
      continue;
    }
    if (CHANGES_DIR.test(raw)) afterCd = true;
    const local = expandLocal(raw, vars);
    const found = kinds(local);
    if (!found.length) continue;
    const part = expandVars(local);

    const strong = found.find((f) => f.kind === "command") ?? found.find((f) => f.kind === "extract");
    if (!strong) {
      redirectLabel ??= found[0].label;
      for (const target of found[0].targets) add(expandVars(target));
      continue;
    }
    strictLabel ??= strong.label;
    if (afterCd || FROM_INPUT.test(part) || unreadable(part)) {
      whole = true;
      break;
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

/** `cd` and its kin: relative paths in later parts no longer mean what they say. */
const CHANGES_DIR = /(?<![-\w])(?:cd|pushd|popd|chdir)\b(?!-)|\b(?:Set|Push|Pop)-Location\b|^\s*sl\b/i;
/** Parts whose real arguments arrive on stdin. */
const FROM_INPUT = /(?<![-\w])(?:xargs|read|parallel)\b(?!-)/;

/** A variable left unexpanded, or a substitution, so its paths cannot be read. */
function unreadable(text) {
  const t = String(text).replace(/\$(?:null|true|false)\b/gi, "");
  return /\$\(|`|\$[\w{]|%[A-Za-z_]\w*%/.test(t);
}

/** `NAME=value` (bash) or `$NAME = value` (PowerShell) as a whole part, or null. */
function parseAssignment(part, shell) {
  const re =
    shell === "powershell"
      ? /^\$([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`;&|]*))$/
      : /^(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s"'`;&|]*))$/;
  const m = re.exec(part.trim());
  if (!m) return null;
  return { name: m[1], value: m[2] ?? m[3] ?? m[4], literal: m[3] !== undefined };
}

/** Replace `$NAME` and `${NAME}` set earlier in the same command. */
function expandLocal(text, vars) {
  return String(text)
    .replace(/\$\{([A-Za-z_]\w*)\}/g, (m, n) => vars.get(n) ?? m)
    .replace(/\$([A-Za-z_]\w*)(?![\w:])/g, (m, n) => vars.get(n) ?? m);
}

/**
 * Split a command at `;`, `&&`, `||` and newlines that sit outside quotes,
 * brackets and braces. Pipelines stay whole: in `echo x | xargs rm` the path
 * and the write are one part. A single `&` is not a separator, because it is
 * PowerShell's call operator. `pipes` also splits at `|`, into pipeline elements.
 */
export function splitCommand(command, shell = "bash", { pipes = false } = {}) {
  const s = String(command);
  const escape = shell === "powershell" ? "`" : "\\";
  const parts = [];
  let start = 0;
  let i = 0;
  let quote = null;
  let depth = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === escape && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === escape) i += 1;
    else if (ch === "(" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const two = s.slice(i, i + 2);
      const cut =
        two === "&&" || two === "||" ? 2 : ch === ";" || ch === "\n" || (pipes && ch === "|") ? 1 : 0;
      if (cut) {
        parts.push(s.slice(start, i));
        i += cut;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
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
  // `,` is in there for PowerShell, whose path parameters take arrays:
  // `Remove-Item -Path src\a.js,src\b.js` is two paths in one token otherwise.
  const tokens = String(command).split(/[\s"'`|&;,()<>{}]+/);
  const found = new Set();

  for (const raw of tokens) {
    // PowerShell also writes a parameter as `-Name:Value`, so a path can be
    // hiding inside something that looks like a flag and would be skipped.
    const unflagged =
      raw.startsWith("-") && raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    const token = unflagged.replace(/^[=~]+/, "").trim();
    if (!token || token.startsWith("-") || token.includes("://")) continue;

    // A bare word is not a path — `npm test` must not resolve to <root>/test.
    const hasExtension = /\.[A-Za-z0-9]{1,6}$/.test(token);
    // A backslash counts on its own, because PowerShell paths are full of them
    // and plenty have no extension: `Remove-Item -Recurse .claude\worktrees\x`.
    // The debris that lets in — `printf "x\n"`, a `\d+` out of a regex — is
    // caught by the existence check below, which is what it is there for.
    const looksLikePath =
      token.includes("/") || /^[A-Za-z]:[\\/]/.test(token) || token.includes("\\");
    if (!looksLikePath && !hasExtension) continue;

    let rel;
    try {
      rel = toRepoRelative(token, root);
    } catch {
      continue;
    }
    // Outside this checkout: the caller decides whether it is someone else's.
    if (rel === null && onOutside && looksLikePath) onOutside(token);
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
