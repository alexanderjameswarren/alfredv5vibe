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
 * Commands that change a file wherever they appear, as [regex, label].
 *
 * `(?<![-\w])` is the fix for a real and repeated false positive: `\bln\b`
 * matched the `-ln` of `git grep -ln`, because `\b` sits happily between `-` and
 * a letter. A write command is a WORD, never the tail of a flag, so a hyphen in
 * front disqualifies it. Same story for `--install`.
 *
 * `[^|;&\n]*` in the in-place rule stops it reaching across a command
 * separator. `sed -n '1,5p' a.js ; grep -i x b.js` used to read as an in-place
 * sed, because the old `[^|]*` happily crossed the `;` to find `grep`'s `-i`.
 *
 * Quotes are NOT stripped before these are matched, deliberately:
 * `sh -c "mv a b"` really does move a file.
 */
const COMMAND_INDICATORS = [
  [/(?<![-\w])tee\b/, "tee"],
  [/(?<![-\w])(?:mv|cp|rsync|install|ln)\b/, "mv/cp"],
  [/(?<![-\w])(?:rm|rmdir|unlink|shred|truncate|touch|mkdir)\b/, "rm/touch/mkdir"],
  [/(?<![-\w])(?:sed|perl|ruby)\b[^|;&\n]*\s-i\b/, "in-place sed/perl"],
  [/(?<![-\w])dd\b[^|;&\n]*\bof=/, "dd of="],
  [/(?<![-\w])(?:patch|git\s+apply)\b/, "patch"],
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
  const c = String(command);
  const indicators =
    shell === "powershell"
      ? [...COMMAND_INDICATORS, PS_ALIAS_INDICATOR]
      : COMMAND_INDICATORS;
  for (const [re, label] of indicators) {
    if (re.test(c)) found.push({ label, kind: "command" });
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
 */
export function writeCheck(command, root, shell = "bash") {
  const found = writeIndicators(command, shell);
  if (!found.length) return null;

  const strict = found.find((f) => f.kind === "command");
  if (strict) {
    const paths = repoPathsIn(command, root);
    return paths.length ? { indicator: strict.label, paths } : null;
  }

  const redirect = found[0];
  const paths = new Set();
  for (const target of redirect.targets) {
    let rel = null;
    try {
      rel = toRepoRelative(expandVars(target), root);
    } catch {
      continue;
    }
    if (rel && !isExempt(rel)) paths.add(rel);
  }
  return paths.size ? { indicator: redirect.label, paths: [...paths] } : null;
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

/** Who holds this repo-relative path, if anyone: an owner name or null. */
export function holderOf(state, rel) {
  const hit = state.claims.find(
    (c) =>
      !isDbItem(c.item) && (fold(c.item) === fold(rel) || covers(c.item, rel)),
  );
  return hit ? hit.owner : null;
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
