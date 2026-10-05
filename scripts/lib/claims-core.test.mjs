import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claimsCommandApproval,
  covers,
  DB_CLAIM_STALE_MS,
  heldBy,
  holderOf,
  holdersOf,
  isChained,
  isExempt,
  isLoneScriptCommand,
  normaliseItem,
  overlaps,
  parseClaimsCommand,
  resolveCheckout,
  resolveRepo,
  scanRedirects,
  splitCommand,
  staleDbClaims,
  writeCheck,
  writeIndicator,
  worktreeOf,
} from "./claims-core.mjs";

const run = (sub, rest = "") => `node scripts/claims.mjs ${sub} ${rest}`.trim();

// ---------------------------------------------------------------------------
// folder claims
// ---------------------------------------------------------------------------

const claimsOf = (...pairs) => ({
  claims: pairs.map(([owner, item]) => ({ owner, item })),
  reservations: [],
});

test("a folder covers itself without its slash, and everything under it", () => {
  assert.ok(covers("src/items/", "src/items/a.jsx"));
  assert.ok(covers("src/items/", "src/items/sub/deep.jsx"));
  assert.ok(covers("src/items/", "src/items"));
  assert.ok(!covers("src/items/", "src/items-old/a.jsx"));
  assert.ok(!covers("src/items/", "src/items-old"));
  assert.ok(!covers("src/items", "src/items/a.jsx"));
});

test("overlap runs both ways", () => {
  assert.ok(overlaps("src/items/foo.jsx", "src/items/"));
  assert.ok(overlaps("src/inbox/", "src/inbox/x.jsx"));
  assert.ok(overlaps("src/inbox", "src/inbox/"));
  assert.ok(!overlaps("src/items/", "src/items-old/"));
});

test("heldBy and holdersOf share one rule", () => {
  const state = claimsOf(["A", "src/items/"], ["B", "src/inbox/x.jsx"]);
  assert.ok(heldBy(state, "src/items/sub/deep.jsx", "A"));
  assert.ok(heldBy(state, "src/items", "A"));
  assert.ok(!heldBy(state, "src/items/foo.jsx", "B"));
  assert.ok(!heldBy(state, "src/items-old/a.jsx", "A"));
  assert.deepEqual(holdersOf(state, "src/items/foo.jsx").map((c) => c.owner), ["A"]);
  assert.equal(holderOf(state, "src/inbox/x.jsx"), "B");
  assert.deepEqual(holdersOf(state, "src/items-old/a.jsx"), []);
});

test("case folds on Windows", { skip: process.platform !== "win32" }, () => {
  const state = claimsOf(["A", "src/items/"]);
  assert.ok(heldBy(state, "SRC/Items/foo.jsx", "A"));
  assert.equal(holdersOf(state, "Src/ITEMS/x.jsx").length, 1);
});

test("nothing holds a path inside a worktree", () => {
  assert.equal(worktreeOf(".claude/worktrees/wtB/src/a.js"), "wtB");
  assert.equal(worktreeOf(".claude/worktrees"), "");
  assert.equal(worktreeOf("src/a.js"), null);
  assert.ok(!heldBy(claimsOf(["main", ".claude/"]), ".claude/worktrees/wtB/src/a.js", "main"));
});

test("normaliseItem: slashes, folders, ambiguity and worktrees", () => {
  const root = mkdtempSync(path.join(tmpdir(), "claims-norm-"));
  mkdirSync(path.join(root, "src", "items"), { recursive: true });
  writeFileSync(path.join(root, "Makefile"), "");
  assert.equal(normaliseItem("src/items/", root), "src/items/");
  assert.equal(normaliseItem("src/items", root), "src/items/");
  assert.equal(normaliseItem("src\\items\\", root), "src/items/");
  assert.equal(normaliseItem(path.join(root, "src", "items"), root), "src/items/");
  assert.equal(normaliseItem("src/new/", root), "src/new/");
  assert.equal(normaliseItem("src/items/new.jsx", root), "src/items/new.jsx");
  assert.equal(normaliseItem("Makefile", root), "Makefile");
  assert.equal(normaliseItem("db:deploy", root), "db:deploy");
  assert.throws(() => normaliseItem("src/new", root), /add a trailing slash: src\/new\//);
  assert.throws(() => normaliseItem(".claude/worktrees/wtB/src/a.js", root), /another thread's worktree/);
  assert.throws(() => normaliseItem(".claude/worktrees/", root), /another thread's worktree/);
});

// ---------------------------------------------------------------------------
// reading a claims.mjs command
// ---------------------------------------------------------------------------

test("parses the subcommand and its items", () => {
  assert.deepEqual(parseClaimsCommand(run("claim", "src/a.js src/b.js")), {
    sub: "claim",
    items: ["src/a.js", "src/b.js"],
  });
  assert.deepEqual(parseClaimsCommand(run("status")), { sub: "status", items: [] });
  assert.equal(parseClaimsCommand("npm test"), null);
});

test("flag values are not items", () => {
  const c = run("claim", 'src/a.js --run-tag x-s1-ab12 --note "db:deploy later"');
  assert.deepEqual(parseClaimsCommand(c).items, ["src/a.js"]);
  assert.deepEqual(parseClaimsCommand(run("release", "--all")).items, []);
});

// ---------------------------------------------------------------------------
// which commands still ask
// ---------------------------------------------------------------------------

test("claiming files and folders is silent", () => {
  for (const items of ["src/a.js", "src/sam/ docs/x.md", "db:table:inbox db:fn:mcp"]) {
    assert.equal(claimsCommandApproval(run("claim", items), "main"), null, items);
  }
});

test("claiming db:deploy asks", () => {
  assert.equal(claimsCommandApproval(run("claim", "db:deploy"), "main"), "claim db:deploy");
  assert.equal(
    claimsCommandApproval(run("claim", "supabase/x.ts db:deploy"), "main"),
    "claim db:deploy",
  );
});

test("reserve never asks, not even for db:deploy", () => {
  // A reservation is a note about a later step. It blocks nothing, so there is
  // nothing for Alex to decide.
  assert.equal(claimsCommandApproval(run("reserve", 'db:deploy --step "Step 9"'), "main"), null);
});

test("cleanup asks for another thread, not for this one", () => {
  assert.equal(claimsCommandApproval(run("cleanup", "ghost-thread"), "main"), "cleanup ghost-thread");
  assert.equal(claimsCommandApproval(run("cleanup", "main"), "main"), null);
  assert.equal(claimsCommandApproval(run("cleanup", "MAIN"), "main"), null);
});

test("a command whose items are computed asks, because it cannot be read", () => {
  assert.ok(claimsCommandApproval("node scripts/claims.mjs claim $(cat list.txt)", "main"));
  assert.ok(claimsCommandApproval("node scripts/claims.mjs claim `echo db:deploy`", "main"));
});

test("status, check and release never ask", () => {
  for (const c of [run("status"), run("check", "db:deploy"), run("release", "--all")]) {
    assert.equal(claimsCommandApproval(c, "main"), null, c);
  }
});

// ---------------------------------------------------------------------------
// chaining — the only thing between a compound command and a silent db:deploy
// ---------------------------------------------------------------------------

test("a chained claim is recognised however it is joined", () => {
  const claim = run("claim", "src/a.js db:deploy");
  assert.ok(isChained(`${run("check", "src/a.js")} && ${claim}`));
  assert.ok(isChained(`${claim} || echo failed`));
  assert.ok(isChained(`${claim} ; echo done`));
  assert.ok(isChained(`${claim} | tee log`));
  assert.ok(isChained(`echo hi\n${claim}`));
  assert.ok(!isChained(claim));
});

// ---------------------------------------------------------------------------
// stale database claims
// ---------------------------------------------------------------------------

const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test("only db: claims go stale, and only after an hour", () => {
  const state = {
    claims: [
      { item: "db:deploy", owner: "main", claimed_at: at(DB_CLAIM_STALE_MS + 60_000) },
      { item: "db:fn:mcp", owner: "main", claimed_at: at(5 * 60_000) },
      { item: "src/a.js", owner: "main", claimed_at: at(13 * 3_600_000) },
    ],
    reservations: [],
  };
  assert.deepEqual(
    staleDbClaims(state).map((c) => c.item),
    ["db:deploy"],
  );
});

test("an unreadable timestamp is not reported as stale", () => {
  const state = {
    claims: [{ item: "db:deploy", owner: "main", claimed_at: "not a date" }],
    reservations: [],
  };
  assert.deepEqual(staleDbClaims(state), []);
});

// ---------------------------------------------------------------------------
// what counts as a write
// ---------------------------------------------------------------------------
//
// The real repo root, because repoPathsIn only keeps a token whose file or
// parent folder actually exists — that is what stops `console.log` and prose
// reading as paths.

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** The repo paths this command would write, or null if it writes none. */
const writes = (command) => writeCheck(command, ROOT)?.paths ?? null;

test("redirections are found outside quotes only", () => {
  assert.deepEqual(scanRedirects("git diff > out.txt"), [{ op: ">", target: "out.txt" }]);
  assert.deepEqual(scanRedirects("cmd >> log.txt"), [{ op: ">>", target: "log.txt" }]);
  assert.deepEqual(scanRedirects('cmd > "my file.txt"'), [
    { op: ">", target: "my file.txt" },
  ]);
  // A leading fd is a real redirect; duplication onto another stream is not.
  assert.deepEqual(scanRedirects("cmd 2> errors.txt"), [{ op: ">", target: "errors.txt" }]);
  assert.deepEqual(scanRedirects("cmd 2>&1"), []);
  assert.deepEqual(scanRedirects("cmd >&2"), []);
  // Quoted, and therefore not a redirect at all.
  assert.deepEqual(scanRedirects("sed 's/a/>b/' file"), []);
  assert.deepEqual(scanRedirects('grep "a > b" file'), []);
  // Arrows in inline JS.
  assert.deepEqual(scanRedirects("node -p \"[1].map(x => x)\""), []);
});

test("the false positives that started this: none of them writes", () => {
  // `-ln` is a flag, not the `ln` command. Blocked three times while planning.
  assert.equal(writeIndicator('git grep -ln "run_tag" -- supabase/'), null);
  // `-i` belongs to grep, and a `;` is a command boundary the sed rule must not
  // cross. This was read as an in-place sed on 2026-09-30.
  assert.equal(
    writeIndicator("sed -n '1,5p' scripts/claims.mjs ; grep -i foo scripts/clip.mjs"),
    null,
  );
  // A `>` inside a replacement, not a redirect.
  assert.equal(writeIndicator("sed -e 's/=.*/=<redacted>/' .env.production.local"), null);
  assert.equal(writeIndicator("ls -la scripts/ 2>&1"), null);
  // Sinks.
  assert.equal(writeIndicator("node scripts/claims.mjs status > /dev/null"), null);
  assert.equal(writeIndicator("echo hi > NUL"), null);
});

test("a redirect out of the repo is not a write to the repo", () => {
  // Reads a repo file, writes somewhere else. Blocked before this change.
  assert.equal(writes('git diff scripts/claims.mjs > "$TEMP/d.txt"'), null);
  assert.equal(writes("git diff scripts/claims.mjs > /tmp/d.txt"), null);
  assert.equal(writes("node scripts/claims.mjs status >> /tmp/claims.log"), null);
  // Still recognised as a write in the abstract — it is only the destination
  // that makes it none of the claims system's business.
  assert.equal(writeIndicator("git diff > /tmp/d.txt"), "> redirection");
});

test("a redirect into the repo is still a write, and only the target counts", () => {
  assert.deepEqual(writes("git diff scripts/claims.mjs > docs/out.md"), ["docs/out.md"]);
  assert.deepEqual(writes("cat scripts/clip.mjs >> docs/out.md"), ["docs/out.md"]);
  // Exempt paths need no claim.
  assert.equal(writes("echo hi > .clip/last-report.md"), null);
});

test("mv, cp, tee and sed -i stay strict: every repo path the command names", () => {
  for (const command of [
    "mv /tmp/x scripts/claims.mjs",
    "cp scripts/clip.mjs scripts/claims.mjs",
    "cat /tmp/x | tee scripts/claims.mjs",
    "sed -i 's/a/b/' scripts/claims.mjs",
    'sh -c "mv /tmp/x scripts/claims.mjs"',
  ]) {
    assert.ok(writes(command)?.includes("scripts/claims.mjs"), command);
  }
});

// ---------------------------------------------------------------------------
// PowerShell — the same rules, a different syntax
// ---------------------------------------------------------------------------

/** The repo paths this PowerShell command would write, or null. */
const psWrites = (command) => writeCheck(command, ROOT, "powershell")?.paths ?? null;
const psIndicator = (command) => writeIndicator(command, "powershell");

test("PowerShell cmdlets are writes, with -Path and -Destination read", () => {
  for (const command of [
    "Move-Item -Path C:\\tmp\\x -Destination src\\Alfred.jsx",
    "Copy-Item -LiteralPath src\\App.js -Destination src\\Alfred.jsx",
    "Set-Content -Path src\\Alfred.jsx -Value 'x'",
    "Add-Content src\\Alfred.jsx 'x'",
    "'x' | Out-File -FilePath src\\Alfred.jsx",
    "New-Item -ItemType File -Force src\\Alfred.jsx",
    "Remove-Item -Force src\\Alfred.jsx",
    "Rename-Item src\\Alfred.jsx src\\Other.jsx",
    "'x' | Tee-Object -FilePath src\\Alfred.jsx",
  ]) {
    assert.ok(psWrites(command)?.includes("src/Alfred.jsx"), command);
  }
});

test("PowerShell's -Name:Value parameter form still yields the path", () => {
  assert.ok(
    psWrites("Move-Item -Path:C:\\tmp\\x -Destination:src\\Alfred.jsx")?.includes(
      "src/Alfred.jsx",
    ),
  );
});

test("PowerShell array parameters are split on the comma", () => {
  const paths = psWrites("Remove-Item -Path src\\Alfred.jsx,src\\App.js");
  assert.ok(paths.includes("src/Alfred.jsx"));
  assert.ok(paths.includes("src/App.js"));
});

test("an extensionless backslash path is still a path", () => {
  assert.ok(psWrites("Remove-Item -Recurse -Force src\\sam\\lib")?.includes("src/sam/lib"));
});

test("PowerShell aliases count, but only at a command position", () => {
  for (const command of [
    "mi C:\\tmp\\x src\\Alfred.jsx",
    "ci src\\App.js src\\Alfred.jsx",
    "ni -ItemType File src\\Alfred.jsx",
    "sc src\\Alfred.jsx 'x'",
    "ac src\\Alfred.jsx 'x'",
    "del src\\Alfred.jsx",
    "move C:\\tmp\\x src\\Alfred.jsx",
    "copy src\\App.js src\\Alfred.jsx",
    "Get-Content src\\App.js | sc src\\Alfred.jsx",
  ]) {
    assert.ok(psWrites(command)?.includes("src/Alfred.jsx"), command);
  }
  // Mid-sentence, the same two letters are not a cmdlet.
  assert.equal(psIndicator("Get-Content src\\App.js -TotalCount 5"), null);
  assert.equal(psIndicator("Select-String -Pattern ci -Path src\\App.js"), null);
});

test("the project's own test command is not a copy", () => {
  // `CI=true …` starts with what a loose, case-insensitive `ci` would match.
  // It is Bash, so the aliases do not apply at all — and must not.
  assert.equal(writeIndicator("CI=true npx react-scripts test --watchAll=false"), null);
});

test("PowerShell redirection follows the same outside-the-repo rule", () => {
  assert.deepEqual(psWrites("Get-Content src\\App.js > docs\\out.md"), ["docs/out.md"]);
  assert.equal(psWrites("Get-Content src\\App.js > $env:TEMP\\out.md"), null);
  assert.equal(psIndicator("Get-Content src\\App.js 2>$null"), null);
  assert.equal(psIndicator("Get-Content src\\App.js > NUL"), null);
  // `*>` is PowerShell's all-streams redirect, and it does write a file.
  assert.deepEqual(psWrites("Get-Content src\\App.js *> docs\\out.md"), ["docs/out.md"]);
});

test("a Windows path's backslashes are not escapes", () => {
  // With Bash rules, the `\"` would swallow the closing quote and the redirect
  // would vanish. PowerShell escapes with a backtick, so it must not.
  assert.deepEqual(scanRedirects('Get-Content "C:\\tmp\\" > out.md', "powershell"), [
    { op: ">", target: "out.md" },
  ]);
});

test("the Move-Item form of the 2026-09-28 breach is blocked too", () => {
  // The same trick in PowerShell: build it outside the repo, then move it over
  // a repo file. The redirect out of the repo is allowed on its own; the
  // Move-Item is what catches it, exactly as `mv` does in Bash.
  const breach =
    "Get-Content src\\utils\\recurrence.js | Set-Content $env:TEMP\\rec.js; " +
    "Move-Item -Force $env:TEMP\\rec.js src\\utils\\recurrence.js";
  const result = writeCheck(breach, ROOT, "powershell");
  assert.ok(result);
  assert.ok(result.paths.includes("src/utils/recurrence.js"));
});

test("the 2026-09-28 breach command is still blocked", () => {
  // The one that got through: it redirected to /tmp — which the rule above now
  // allows on its own — and then moved the result over a repo file.
  const breach =
    "{ printf '// note\\n'; cat src/utils/recurrence.js; } > /tmp/rec.$$ " +
    "&& mv /tmp/rec.$$ src/utils/recurrence.js";
  const result = writeCheck(breach, ROOT);
  assert.equal(result.indicator, "mv/cp");
  assert.ok(result.paths.includes("src/utils/recurrence.js"));
});

// ---------------------------------------------------------------------------
// switchboard_fixes: three false positives
// ---------------------------------------------------------------------------

test("an exempt folder named on its own is exempt", () => {
  assert.ok(isExempt(".git") && isExempt(".clip") && isExempt(".CLIP"));
  assert.ok(!isExempt(".github/workflows/x.yml"));
  assert.ok(!isExempt(".gitignore"));
  assert.equal(writes("cp -r .git /c/tmp/x"), null);
  assert.equal(writes("cd .clip && rm notification-hook-input.log"), null);
  assert.equal(writes("rm -rf .clip"), null);
});

test("a write word followed by a hyphen is part of a name", () => {
  assert.equal(writeIndicator("cat tools/claude-sessions/install-shortcuts.ps1"), null);
  assert.equal(writeIndicator("cat docs/rm-notes.md patch-1.diff tee-off.txt"), null);
  assert.equal(writeIndicator("install -m 644 a b"), "mv/cp");
  assert.equal(writeIndicator("/bin/mv a b"), "mv/cp");
});

test("a lone claims command is judged on redirections only", () => {
  const claim = run("claim", "tools/claude-sessions/install-shortcuts.ps1 scripts/git-sync.mjs");
  assert.ok(isLoneScriptCommand(claim));
  assert.equal(writeCheck(claim, ROOT, "bash", { redirectsOnly: true }), null);
  assert.ok(isLoneScriptCommand(`${run("check", "tools/mv/")} 2>&1`));
  assert.deepEqual(
    writeCheck(`${run("status")} > src/App.js`, ROOT, "bash", { redirectsOnly: true }).paths,
    ["src/App.js"],
  );
});

test("anything more than a lone claims command is judged in full", () => {
  for (const c of [
    `node -e "require('fs').writeFileSync('src/App.js','')" scripts/claims.mjs claim x`,
    `${run("claim", "x")} & mv src/App.js /tmp/a`,
    `${run("claim", "x")}; cp a src/App.js`,
    `${run("claim", "$(echo x)")}`,
    `${run("claim", "x")} | tee src/App.js`,
    `echo; ${run("claim", "x")}`,
    `bash -c "rm src/App.js" scripts/clip.mjs`,
    `cat .clip/last-report.md | node scripts/clip.mjs --title "x"`,
  ]) {
    assert.equal(isLoneScriptCommand(c), false, c);
  }
});

test("a lone clip.mjs push with cp, mv and rm in its title writes nothing", () => {
  const push =
    'node scripts/clip.mjs --tag a-s1-ab12 --title "cp the docs, mv the spec, rm the probe" ' +
    ".clip/last-report.md";
  assert.ok(writeCheck(push, ROOT), "judged in full, the title reads as a write");
  assert.ok(isLoneScriptCommand(push));
  assert.equal(writeCheck(push, ROOT, "bash", { redirectsOnly: true }), null);
  // Still a write when it is wrapped in a shell that runs the quoted text.
  assert.ok(writeCheck('bash -c "rm src/App.js"', ROOT));
});

// ---------------------------------------------------------------------------
// switchboard_smoke: only the parts that write are judged
// ---------------------------------------------------------------------------

const SCRATCH = "C:/Users/Alex/AppData/Local/Temp/claude/x/scratchpad/sb";

test("commands split at ; && || and newlines, outside quotes and groups", () => {
  assert.deepEqual(splitCommand("a; b && c || d\ne"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(splitCommand("a | b"), ["a | b"]);
  assert.deepEqual(splitCommand('echo "x; y" && z'), ['echo "x; y"', "z"]);
  assert.deepEqual(splitCommand("{ a; b; } > f && c"), ["{ a; b; } > f", "c"]);
  assert.deepEqual(splitCommand("& 'C:/x.exe' a; b", "powershell"), ["& 'C:/x.exe' a", "b"]);
});

test("this morning's command: a write outside the repo, a read inside it", () => {
  const command =
    `S="${SCRATCH}"; rm -rf "$S"; mkdir -p "$S"; ` +
    `git archive HEAD tools/claude-sessions | tar -x -C "$S"; ` +
    `cd "$S/tools/claude-sessions" && "/c/Program Files/AutoHotkey/v2/AutoHotkey64.exe" ` +
    `//ErrorStdOut smoke-test.ahk 2>&1 | cat; echo "exit \${PIPESTATUS[0]}"`;
  assert.equal(writes(command), null);
});

test("a pipeline stays whole, so xargs still sees the path", () => {
  assert.deepEqual(writes("echo src/App.js | xargs rm"), ["src/App.js"]);
});

test("a write in one part still names its own repo paths", () => {
  assert.deepEqual(writes("git status; rm src/App.js"), ["src/App.js"]);
  assert.deepEqual(writes("git log scripts/clip.mjs; rm -rf /tmp/x"), null);
});

test("a variable set earlier in the command is expanded", () => {
  assert.deepEqual(writes("F=src/App.js; rm $F"), ["src/App.js"]);
  assert.deepEqual(writes('F="src/App.js" && echo hi > "$F"'), ["src/App.js"]);
});

test("unreadable writing parts fall back to the whole command", () => {
  for (const command of [
    "cat scripts/clip.mjs; cd /tmp && rm x", // after a cd
    "git log scripts/clip.mjs; rm $NOT_SET_ANYWHERE_X", // an unresolved variable
    "git log scripts/clip.mjs; rm $(cat /tmp/list)", // a substitution
    "git log scripts/clip.mjs; rm `cat /tmp/list`", // backticks
    "echo scripts/clip.mjs > /tmp/list; xargs rm < /tmp/list", // arguments from stdin
    "cat <<EOF > /tmp/x\nscripts/clip.mjs\nEOF\nrm /tmp/y", // a heredoc
  ]) {
    assert.ok(writes(command)?.includes("scripts/clip.mjs"), command);
  }
  assert.deepEqual(psWrites("Get-Content scripts\\clip.mjs; Set-Location src; Remove-Item App.js"), [
    "scripts/clip.mjs",
  ]);
});

test("tar -x, unzip and find -delete are writes", () => {
  assert.equal(writeIndicator("tar -xzf /tmp/a.tgz"), "tar -x");
  assert.equal(writeIndicator("tar xzf /tmp/a.tgz"), "tar -x");
  assert.equal(writeIndicator("tar --extract -f /tmp/a.tar"), "tar -x");
  assert.equal(writeIndicator("unzip /tmp/a.zip"), "unzip");
  assert.equal(writeIndicator("find src -name '*.bak' -delete"), "find -delete");
  // Reads.
  assert.equal(writeIndicator("tar -tf /tmp/a.tar"), null);
  assert.equal(writeIndicator("tar -czf /tmp/a.tgz --exclude=x src"), null);
  assert.equal(writeIndicator("unzip -l /tmp/a.zip"), null);
  assert.equal(writeIndicator("find src -name '*.bak'"), null);
});

test("tar -x and unzip are judged on their destination when they name one", () => {
  assert.equal(writes(`git archive HEAD scripts | tar -x -C "${SCRATCH}"`), null);
  assert.deepEqual(writes("git archive HEAD scripts | tar -x -C src"), ["src"]);
  assert.deepEqual(writes(`unzip ${SCRATCH}/a.zip -d src`), ["src"]);
  assert.equal(writes(`unzip src.zip -d ${SCRATCH}`), null);
  // No destination: strict, every repo path in the part.
  assert.deepEqual(writes("tar -xf /tmp/a.tar src/App.js"), ["src/App.js"]);
  assert.deepEqual(writes("find src/sam -name '*.bak' -delete"), ["src/sam"]);
});

test("the checkout comes from the project dir, then the cwd", () => {
  const outside = tmpdir();
  assert.equal(resolveCheckout(ROOT, outside).root, resolveRepo(ROOT).root);
  assert.equal(resolveCheckout(undefined, ROOT).owner, resolveRepo(ROOT).owner);
  assert.equal(resolveCheckout(outside, ROOT).root, resolveRepo(ROOT).root);
  assert.throws(() => resolveCheckout(undefined, outside), (e) => e.code === "no-git");
});
