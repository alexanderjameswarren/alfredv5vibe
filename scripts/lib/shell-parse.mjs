// Shell-command parsing for the guards: which commands write, where a
// redirection goes, how a command splits into parts, and its words.
//
// Pure text in, answers out. No claims, no repo paths, no filesystem — those
// stay in claims-core.mjs (`writeCheck`, `repoPathsIn`), which builds on this.
// Moved out of claims-core in switchboard2-h8r step 0.1 so the plan guard can
// share it.

// Windows paths are case-insensitive; the same rule as claims-core's `fold`.
const IGNORE_CASE = process.platform === "win32";
const fold = (s) => (IGNORE_CASE ? s.toLowerCase() : s);

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

// A third element is the kind, when it is not "command". A copy writes only its
// destination, so its source is not checked; mv deletes its source, so both are.
const COMMAND_INDICATORS = [
  [word("tee"), "tee"],
  [word("mv"), "mv/cp"],
  [word("cp|rsync|install|ln"), "mv/cp", "copy"],
  [word("rm|rmdir|unlink|shred|truncate|touch|mkdir"), "rm/touch/mkdir"],
  [/(?<![-\w])(?:sed|perl|ruby)\b[^|;&\n]*\s-i\b/, "in-place sed/perl"],
  [/(?<![-\w])dd\b[^|;&\n]*\bof=/, "dd of="],
  [word(String.raw`patch|git\s+apply`), "patch"],
  [/(?<![-\w])find\b[^|;&\n]*\s-delete\b/, "find -delete"],
  [/\bwrite(?:File)?(?:Sync)?\s*\(/i, "writeFileSync"],
  // The mode is its own argument: `open('app.py')` reads, `open(p, 'w')` writes.
  [/\bopen(?:Sync)?\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]/, "open(...,'w')"],
  // Script writes besides writeFileSync (switchboard2-h8r 0.1): node's fs, python's os, shutil, pathlib.
  [/\b(?:appendFile|copyFile|cp|rename|unlink|rm|rmdir|mkdir|truncate|symlink|link)Sync\s*\(/, "fs write"],
  [/\.(?:appendFile|copyFile|rename|unlink|rmdir|mkdir|truncate|symlink|rm|cp)\s*\(/, "fs write"],
  [/\bcreateWriteStream\s*\(/, "fs write"],
  [/\.(?:write_text|write_bytes|touch|symlink_to|hardlink_to)\s*\(/, "fs write"],
  [/\bshutil\.(?:copy\w*|move|rmtree)\s*\(/, "fs write"],
  [/\bos\.(?:remove|unlink|rename|replace|rmdir|removedirs|makedirs|mkdir|truncate|symlink|link)\s*\(/, "fs write"],
  // A shell started from code can write anything, so the paths it names count.
  [/\bchild_process\b|\b(?:execSync|execFileSync|spawnSync)\s*\(|\bos\.(?:system|popen)\s*\(|\bsubprocess\.\w+\s*\(/, "shell from code"],
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

// ---------------------------------------------------------------------------
// quoted arguments and the payloads of shell wrappers
// ---------------------------------------------------------------------------
//
// A quoted argument is data, not a command: `clip.mjs --title "bash -c cp
// blocked"` was blocked as a cp. But a quoted payload handed to a wrapper —
// `bash -c "…"`, `powershell -Command "…"`, `node -e "…"` — is run, so it is
// judged as a command of its own.

const WRAPPERS = /^(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|node|python3?|py|perl|ruby|deno|bun)$/;
const SHELL_WRAPPERS = /^(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd)$/;
const PAYLOAD_FLAG = /^(?:-[a-z]*[ce]|-p|--eval|--print|-command|\/c|\/k)$/i;
const EVAL_WORDS = /^(?:eval|iex|invoke-expression)$/i;
// Quoted values these flags take are programs to run (`rg --pre 'x'`, `git -c
// core.pager='x'`, `find -exec`), so they are read as they are, not blanked.
const RUNS_FLAG = /^(?:--pre|-O|--open-files-in-pager|-c|-exec|-execdir|-ok|--exec)$/;
const RUNS_PREFIX = /^(?:-O|--pre=|--open-files-in-pager=|.*(?:pager|editor|command|cmd|exec|program)=)$/i;
const programOf = (w) => w.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");

/**
 * The text a command actually runs: everything outside quoted arguments, plus
 * each wrapper payload, one per line. `grep "claims.mjs claim" x` runs no claim;
 * `bash -c "node scripts/claims.mjs claim x"` does.
 */
export function runText(command, depth = 0) {
  const { masked, payloads } = splitPayloads(command);
  if (depth > 3) return String(command);
  return [masked, ...payloads.map((p) => runText(p.text, depth + 1))].join("\n");
}

/**
 * Where a cp, rsync, install or ln part writes: `-t DIR`, else its last operand.
 * Null when that cannot be told — fewer than two operands, or the part goes on
 * past a redirect or pipe — and the caller then falls back to every path.
 */
export function copyDestination(part) {
  const sinks = /\d?>&\d|\d?>>?\s*(?:\/dev\/null|nul|\$null)(?=\s|$)/gi;
  if (/[<>|]/.test(splitPayloads(part).masked.replace(sinks, ""))) return null;
  const words = shellWords(part.replace(sinks, ""));
  // At command position only: `npm install a b` is not a copy to b.
  let at = 0;
  while (at < words.length && (/^(?:sudo|command|time|env)$/.test(words[at]) || /^\w+=/.test(words[at]))) at += 1;
  if (!/^(?:cp|rsync|install|ln)$/.test(programOf(words[at] ?? ""))) return null;
  const args = words.slice(at + 1);
  // rsync's -t keeps times; for the others it names the target folder.
  for (let i = 0; programOf(words[at]) !== "rsync" && i < args.length; i += 1) {
    const a = args[i];
    if (a === "-t" || a === "--target-directory") return args[i + 1] ?? null;
    const m = /^(?:--target-directory=|-t)(.+)$/.exec(a);
    if (m) return m[1];
  }
  const operands = args.filter((a) => !a.startsWith("-"));
  return operands.length >= 2 ? operands[operands.length - 1] : null;
}

/**
 * `{ masked, payloads }`: the command with quoted argument text blanked out,
 * and the wrapper payloads found, each `{ text, shell, code }` (`code` for an
 * interpreter's source rather than a shell's). Left as written: a quoted
 * program name, and double quotes holding `$(…)` or backticks, which run.
 */
export function splitPayloads(command) {
  const s = String(command);
  const payloads = [];
  let masked = "";
  let words = [];
  let cur = "";
  const endWord = () => {
    if (cur) words.push(cur);
    cur = "";
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if ((c === "\\" || c === "`") && (s[i + 1] === '"' || s[i + 1] === "'")) {
      masked += c + s[i + 1];
      cur += s[i + 1];
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let inner = "";
      for (; j < s.length && s[j] !== c; j += 1) {
        if (c === '"' && (s[j] === "\\" || s[j] === "`") && s[j + 1] === '"') {
          inner += '"';
          j += 1;
          continue;
        }
        inner += s[j];
      }
      const whole = cur === "";
      const prev = words[words.length - 1] ?? "";
      const wrapper = words.map(programOf).find((w) => WRAPPERS.test(w));
      const payload = whole && ((wrapper && PAYLOAD_FLAG.test(prev)) || EVAL_WORDS.test(prev));
      const runs = c === '"' && /\$\(|`/.test(inner);
      const keep =
        !payload && (runs || (whole && words.length === 0) || RUNS_FLAG.test(prev) || RUNS_PREFIX.test(cur));
      if (payload) {
        payloads.push({
          text: inner,
          // cmd's del/copy/move/rd/md are PowerShell's DOS aliases too.
          shell: /^(?:pwsh|powershell|cmd)$/.test(wrapper ?? "") ? "powershell" : "bash",
          code: !!wrapper && !SHELL_WRAPPERS.test(wrapper),
        });
      }
      masked += c + (keep ? inner : inner.replace(/[^\n]/g, " ")) + (j < s.length ? c : "");
      cur += keep ? inner : "_";
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      if (c === "\n") words = [];
    } else if (/[;|&(){}]/.test(c)) {
      endWord();
      words = [];
    } else {
      cur += c;
    }
    masked += c;
  }
  return { masked, payloads };
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
export function expandVars(target) {
  return String(target)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, n) => process.env[n] ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => process.env[n] ?? m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => process.env[n] ?? m)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => process.env[n] ?? m);
}

/**
 * Everything that says this command writes, redirections first. `code` is an
 * interpreter's source (`node -e "…"`): its quotes are its own, so it is read
 * as it is, and it has no shell redirections — `x > 1`, `a >= b` and `=>` are
 * operators. In bash, heredoc bodies are taken out first; a body that runs comes
 * back as a payload.
 */
export function writeIndicators(command, shell = "bash", { code = false } = {}) {
  const found = [];
  const heredocs = !code && shell !== "powershell" ? stripHeredocs(command) : { text: command, bodies: [] };
  const text = heredocs.text;
  const redirects = code
    ? []
    : scanRedirects(text, shell).filter((r) => !NULL_SINKS.has(fold(r.target)));
  if (redirects.length) {
    found.push({
      label: `${redirects[0].op} redirection`,
      kind: "redirect",
      targets: redirects.map((r) => r.target),
    });
  }
  // PowerShell has no heredocs, and a `<<` there still reads the text as it is.
  const { masked, payloads } =
    code || (shell === "powershell" && /<</.test(text)) ? { masked: text, payloads: [] } : splitPayloads(text);
  for (const body of heredocs.bodies) {
    if (body.runs) payloads.push({ text: body.text, shell: body.runs === "code" ? "bash" : body.runs, code: body.runs === "code" });
  }
  // Redirections above are read from the whole command; write words only from
  // the elements that are not read-only programs, outside quoted arguments.
  const c = writableText(masked, shell);
  const indicators =
    shell === "powershell"
      ? [...COMMAND_INDICATORS, PS_ALIAS_INDICATOR]
      : COMMAND_INDICATORS;
  for (const [re, label, kind = "command"] of indicators) {
    if (re.test(c)) found.push({ label, kind });
  }
  for (const [re, label, destRe] of EXTRACT_INDICATORS) {
    if (re.test(c)) found.push({ label, kind: "extract", destRe });
  }
  for (const payload of payloads) {
    const inner = writeIndicators(payload.text, payload.shell, { code: payload.code });
    if (inner.length) found.push({ label: inner[0].label, kind: "payload", payload });
  }
  return found;
}

/** A label for the first write construct this command matches, or null. */
export function writeIndicator(command, shell = "bash") {
  return writeIndicators(command, shell)[0]?.label ?? null;
}

// ---------------------------------------------------------------------------
// heredocs
// ---------------------------------------------------------------------------
//
// A heredoc body is input, not command text: `cat > "$TEMP/n.md" <<'EOF'` with
// "rm" and a repo path in the note was blocked as an rm of that path. Bodies
// come out before anything is scanned. A body that an interpreter or shell reads
// as its program (`node - <<EOF`, `bash <<EOF`, `cat <<EOF | python -`) runs, so
// it is kept and judged as a payload.

const CODE_RUNNERS = /^(?:node|deno|bun|python3?|py|perl|ruby)$/;
const LEADERS = /^(?:sudo|command|time|env|exec|nohup)$/;

/** "code", "bash", "powershell" or null: what reads a heredoc body handed to `segment`. */
function bodyRunner(segment) {
  const words = shellWords(segment).filter((w) => !/^\w+=/.test(w));
  while (words.length && LEADERS.test(programOf(words[0]))) words.shift();
  if (!words.length) return null;
  const program = programOf(words[0]);
  // A script file argument means the body is that script's stdin, not code.
  const operands = words.slice(1).filter((w) => !w.startsWith("-") || w === "-");
  if (operands.some((w) => w !== "-")) return null;
  if (CODE_RUNNERS.test(program)) return "code";
  if (SHELL_WRAPPERS.test(program)) return /^(?:pwsh|powershell|cmd)$/.test(program) ? "powershell" : "bash";
  return null;
}

/** Heredoc operators on one line, outside quotes: `{ at, delim, dash }` each. */
function heredocOps(line) {
  const ops = [];
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== "<" || line[i + 1] !== "<" || line[i + 2] === "<" || line[i - 1] === "<") continue;
    const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"]+))/.exec(line.slice(i));
    if (!m) continue;
    ops.push({ at: i, end: i + m[0].length, dash: m[1] === "-", delim: m[2] ?? m[3] ?? m[4] });
    i += m[0].length - 1;
  }
  return ops;
}

/**
 * `{ text, bodies }`: the command with every heredoc body and terminator line
 * removed (the `<<EOF` operator stays), and each body as `{ text, runs }`, where
 * `runs` is "code", "bash", "powershell", or null for plain input.
 */
export function stripHeredocs(command) {
  const lines = String(command).split("\n");
  const kept = [];
  const bodies = [];
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    kept.push(line);
    for (const op of heredocOps(line)) {
      const before = line.slice(0, op.at).split(/;|&&|\|\||\$\(|[|(]/).pop();
      const pipedTo = /^\s*\|\s*([^|;&]*)/.exec(line.slice(op.end).replace(/^[^|;&]*?(?=\|)/, ""));
      const runs = bodyRunner(before) ?? (pipedTo ? bodyRunner(pipedTo[1]) : null);
      const body = [];
      for (n += 1; n < lines.length; n += 1) {
        const l = op.dash ? lines[n].replace(/^\t+/, "") : lines[n];
        if (l === op.delim) break;
        body.push(lines[n]);
      }
      bodies.push({ text: body.join("\n"), runs });
    }
  }
  return { text: kept.join("\n"), bodies };
}

/** `cd` and its kin: relative paths in later parts no longer mean what they say. */
export const CHANGES_DIR = /(?<![-\w])(?:cd|pushd|popd|chdir)\b(?!-)|\b(?:Set|Push|Pop)-Location\b|^\s*sl\b/i;
/** Parts whose real arguments arrive on stdin. */
export const FROM_INPUT = /(?<![-\w])(?:xargs|read|parallel)\b(?!-)/;

/** A variable left unexpanded, or a substitution, so its paths cannot be read. */
export function unreadable(text) {
  const t = String(text).replace(/\$(?:null|true|false)\b/gi, "");
  return /\$\(|`|\$[\w{]|%[A-Za-z_]\w*%/.test(t);
}

/** `NAME=value` (bash) or `$NAME = value` (PowerShell) as a whole part, or null. */
export function parseAssignment(part, shell) {
  const re =
    shell === "powershell"
      ? /^\$([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`;&|]*))$/
      : /^(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s"'`;&|]*))$/;
  const m = re.exec(part.trim());
  if (!m) return null;
  return { name: m[1], value: m[2] ?? m[3] ?? m[4], literal: m[3] !== undefined };
}

/** Replace `$NAME` and `${NAME}` set earlier in the same command. */
export function expandLocal(text, vars) {
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
 * A command split into words the way a shell would: quotes group, and a
 * backslash or PowerShell backtick before a space escapes it. Any other
 * backslash is a Windows path separator and stays.
 *
 * `,` separates too, for PowerShell, whose path parameters take arrays:
 * `Remove-Item -Path src\a.js,src\b.js` is two paths in one token otherwise.
 */
export function shellWords(command) {
  const s = String(command);
  const words = [];
  let cur = "";
  let started = false;
  const end = () => {
    if (started) words.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== c; j += 1) {
        // Inside double quotes, \" and `" are a literal quote.
        if (c === '"' && (s[j] === "\\" || s[j] === "`") && s[j + 1] === '"') j += 1;
        cur += s[j];
      }
      started = true;
      i = j;
      continue;
    }
    if ((c === "\\" || c === "`") && /[ \t()'"]/.test(s[i + 1] ?? "")) {
      cur += s[i + 1];
      started = true;
      i += 1;
      continue;
    }
    if (/[\s|&;,()<>{}`]/.test(c)) {
      end();
      continue;
    }
    cur += c;
    started = true;
  }
  end();
  return words;
}
