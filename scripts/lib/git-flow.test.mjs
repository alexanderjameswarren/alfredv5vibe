// The answer parser, the default commit message, and the prompts that used to
// throw an answer away.
//
// The interactive ones are driven for real, as a child process with a scripted
// stdin, because what is being tested is precisely what happens when the typed
// answer is empty — and that is a property of the loop, not of the parser.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import {
  applyDocsMove,
  docsClashRefusal,
  docsMovePaths,
  forceDecision,
  leftBehindRefusal,
  planDocsMove,
  withoutMoved,
  defaultMessage,
  exclusive,
  expandPathWords,
  findCheckout,
  finishFromInside,
  isInside,
  misplacedOptions,
  modeKey,
  parseArgs,
  parseSelection,
  pathsToAdd,
  pickCheckouts,
  refusalBanner,
  removeEmptyDir,
  resolveUnclaimed,
  resultExit,
  today,
  UsageError,
} from "./git-flow.mjs";

// What changedFiles returns after `git mv old.js new.js`, `git rm gone.js`,
// one staged edit, one half-staged edit, an unstaged deletion and a new file.
const STAGED_MV = [
  { path: "old.js", status: "R ", untracked: false, renamedFrom: true },
  { path: "new.js", status: "R ", untracked: false },
  { path: "moved.js", status: "RM", untracked: false },
  { path: "was.js", status: "RM", untracked: false, renamedFrom: true },
  { path: "gone.js", status: "D ", untracked: false },
  { path: "staged.js", status: "M ", untracked: false },
  { path: "half.js", status: "MM", untracked: false },
  { path: "deleted.js", status: " D", untracked: false },
  { path: "fresh.js", status: "??", untracked: true },
];

test("a staged git mv: neither end needs adding, unless edited since", () => {
  const all = STAGED_MV.map((f) => f.path);
  assert.deepEqual(pathsToAdd(STAGED_MV, all), ["moved.js", "half.js", "deleted.js", "fresh.js"]);
});

test("a path git did not list is left for git to judge", () => {
  assert.deepEqual(pathsToAdd(STAGED_MV, ["old.js", "elsewhere.js"]), ["elsewhere.js"]);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLOW = path.join(HERE, "git-flow.mjs").replace(/\\/g, "/");

/** Run a snippet against git-flow with `keys` typed at its prompts. */
function withInput(keys, body) {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { ask, askMessage, askSelection, choose, confirm, parseSelection } from "file:///${FLOW}";\n${body}`,
    ],
    { input: keys.map((k) => `${k}\n`).join(""), encoding: "utf8" },
  );
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

test("all, in either spelling", () => {
  for (const answer of ["a", "all", "ALL", "  a  "]) {
    assert.equal(parseSelection(answer, 5).all, true, answer);
  }
});

test("numbers, ranges and mixtures", () => {
  assert.deepEqual(parseSelection("1 3", 5).indexes, [1, 3]);
  assert.deepEqual(parseSelection("1-4", 5).indexes, [1, 2, 3, 4]);
  // Backwards reads the same way round.
  assert.deepEqual(parseSelection("4-1", 5).indexes, [1, 2, 3, 4]);
  assert.deepEqual(parseSelection("1,2,3", 5).indexes, [1, 2, 3]);
  // Deduped and ordered, however it was typed.
  assert.deepEqual(parseSelection("3 1-2 3", 5).indexes, [1, 2, 3]);

  const mixed = parseSelection("1-3 7 src/x.js", 8);
  assert.deepEqual(mixed.indexes, [1, 2, 3, 7]);
  assert.deepEqual(mixed.words, ["src/x.js"]);
});

test("out of range is reported, not quietly dropped", () => {
  const sel = parseSelection("2 9 20-30", 5);
  assert.deepEqual(sel.indexes, [2]);
  assert.deepEqual(sel.bad, ["9", "20-30"]);
  // A range that only partly fits keeps the part that does.
  assert.deepEqual(parseSelection("3-9", 5).indexes, [3, 4, 5]);
});

// git status -uall: a new folder arrives file by file; a deletion keeps its path.
const DIRTY = [
  { path: "supabase/functions/mcp/index.ts", status: " M" },
  { path: "supabase/functions/mcp/tables.test.mjs", status: "??" },
  { path: "supabase/functions/overwatch-ingest/index.ts", status: "??" },
  { path: "supabase/functions/overwatch-ingest/ingest.ts", status: "??" },
  { path: "docs/old/notes.md", status: " D" },
  { path: "docs/old/keep.md", status: " M" },
  { path: "scripts/claims.mjs", status: " M" },
];

test("--paths: a folder with modified files", () => {
  assert.deepEqual(expandPathWords(["supabase/functions/mcp"], DIRTY), {
    paths: ["supabase/functions/mcp/index.ts", "supabase/functions/mcp/tables.test.mjs"],
    unknown: [],
  });
});

test("--paths: a new folder, file by file, with or without the slash", () => {
  const want = ["supabase/functions/overwatch-ingest/index.ts", "supabase/functions/overwatch-ingest/ingest.ts"];
  assert.deepEqual(expandPathWords(["supabase/functions/overwatch-ingest"], DIRTY).paths, want);
  assert.deepEqual(expandPathWords(["supabase\\functions\\overwatch-ingest\\"], DIRTY).paths, want);
});

test("--paths: a folder holding a deletion takes it", () => {
  assert.deepEqual(expandPathWords(["docs/old/"], DIRTY).paths, ["docs/old/notes.md", "docs/old/keep.md"]);
});

test("--paths: an unchanged folder is refused, and a prefix is not a folder", () => {
  assert.deepEqual(expandPathWords(["src/overwatch"], DIRTY), { paths: [], unknown: ["src/overwatch"] });
  assert.deepEqual(expandPathWords(["supabase/functions/overwatch"], DIRTY).unknown, ["supabase/functions/overwatch"]);
});

test("--paths: folders and files mixed, files as before, no duplicates", () => {
  const r = expandPathWords(["scripts/claims.mjs", "supabase/functions/mcp", "supabase/functions/mcp/index.ts", "typo.js"], DIRTY);
  assert.deepEqual(r.paths, ["scripts/claims.mjs", "supabase/functions/mcp/index.ts", "supabase/functions/mcp/tables.test.mjs"]);
  assert.deepEqual(r.unknown, ["typo.js"]);
});

test("a path is not a range, and a comma in one is not a separator", () => {
  assert.deepEqual(parseSelection("src/x-1.js", 5).words, ["src/x-1.js"]);
  assert.deepEqual(parseSelection("docs/a,b.md", 5).words, ["docs/a,b.md"]);
  assert.deepEqual(parseSelection("supabase/migrations/084_x.sql", 3).words, [
    "supabase/migrations/084_x.sql",
  ]);
});

test("blank is its own answer, not all and not cancel", () => {
  const sel = parseSelection("   ", 5);
  assert.equal(sel.blank, true);
  assert.equal(sel.all, false);
  assert.deepEqual(sel.indexes, []);
});

test("the default commit message", () => {
  const d = new Date(2026, 8, 30);
  assert.equal(defaultMessage("claims-followup", "checkpoint", d), "claims-followup: checkpoint 2026-09-30");
  assert.equal(defaultMessage("rem-j7p", "finish", d), "rem-j7p: finish 2026-09-30");
  assert.equal(defaultMessage(null, "commit", d), "main: commit 2026-09-30");
  // Local, not UTC: late evening still belongs to that day.
  assert.equal(today(new Date(2026, 8, 30, 23, 30)), "2026-09-30");
});

test("a blank commit message uses the default", () => {
  const r = withInput([""], `console.log(JSON.stringify(askMessage("rem-j7p", "checkpoint")));`);
  assert.match(r.out, /"rem-j7p: checkpoint \d{4}-\d{2}-\d{2}"/);
});

test("a typed commit message wins", () => {
  const r = withInput(["084 reminders"], `console.log(JSON.stringify(askMessage("rem-j7p", "checkpoint")));`);
  assert.match(r.out, /"084 reminders"/);
});

test("choose re-asks on blank instead of cancelling", () => {
  const r = withInput(["", "", "n"], `console.log("PICK=" + choose("q", [{key:"a",label:"all"},{key:"n",label:"none"}]));`);
  assert.match(r.out, /PICK=n/);
  // Said out loud each time, rather than silently swallowed.
  assert.equal(r.out.match(/not an answer here/g)?.length, 2);
});

test("choose takes a default where the caller declares one", () => {
  const r = withInput([""], `console.log("PICK=" + choose("q", [{key:"f",label:"Finish"},{key:"s",label:"Skip"}], { blank: "s" }));`);
  assert.match(r.out, /PICK=s/);
});

test("a blank path list asks before it cancels", () => {
  const items = `[{path:"a.js"},{path:"b.js"}]`;
  // enter, then "n" to the "commit all?" question — cancels, but he said so.
  const no = withInput(["", "n"], `console.log("GOT=" + JSON.stringify(askSelection("q: ", ${items}, "Commit all 2?")));`);
  assert.match(no.out, /Commit all 2\?/);
  assert.match(no.out, /GOT=null/);

  // enter, then "y" — everything, which is what the old blank silently refused.
  const yes = withInput(["", "y"], `console.log("GOT=" + JSON.stringify(askSelection("q: ", ${items}, "Commit all 2?")));`);
  assert.match(yes.out, /"all":true/);
  assert.match(yes.out, /a\.js/);
  assert.match(yes.out, /b\.js/);
});

test("a path list takes ranges and literal paths together", () => {
  const items = `[{path:"a.js"},{path:"b.js"},{path:"c.js"}]`;
  const r = withInput(["1-2 docs/x.md"], `console.log("GOT=" + JSON.stringify(askSelection("q: ", ${items}, "all?")));`);
  assert.match(r.out, /a\.js/);
  assert.match(r.out, /b\.js/);
  assert.doesNotMatch(r.out, /c\.js/);
  assert.match(r.out, /docs\/x\.md/);
});

// ---------------------------------------------------------------------------
// the command line
// ---------------------------------------------------------------------------

const PUSH_OPTS = {
  paths: { kind: "list" },
  all: { kind: "bool" },
  "release-db": { kind: "bool" },
  "keep-db": { kind: "bool" },
  "include-unclaimed": { kind: "list" },
  message: { kind: "value", alias: "m" },
};

const parse = (line, opts = PUSH_OPTS, positionals = 2) =>
  parseArgs(line.split(" ").filter(Boolean), opts, { positionals });

test("the shape claude.ai will hand over", () => {
  const { positionals, options } = parseArgs(
    ["rem-j7p", "checkpoint", "--paths", "supabase/migrations/084_x.sql", "--release-db"],
    PUSH_OPTS,
    { positionals: 2 },
  );
  assert.deepEqual(positionals, ["rem-j7p", "checkpoint"]);
  assert.deepEqual(options.paths, ["supabase/migrations/084_x.sql"]);
  assert.equal(options["release-db"], true);
});

test("a list takes several values and stops at the next flag", () => {
  const { options } = parse("w1 checkpoint --paths a.sql b.ts --release-db");
  assert.deepEqual(options.paths, ["a.sql", "b.ts"]);
  assert.equal(options["release-db"], true);
});

test("a value can be given either way, and messages keep their spaces", () => {
  assert.equal(parseArgs(["--message", "084 reminders"], PUSH_OPTS).options.message, "084 reminders");
  assert.equal(parseArgs(["--message=084 reminders"], PUSH_OPTS).options.message, "084 reminders");
  assert.equal(parseArgs(["-m", "hi"], PUSH_OPTS).options.message, "hi");
});

test("an unknown option is an error, never ignored", () => {
  // The one that matters: a typo'd --release-db would hold db claims for hours.
  assert.throws(() => parse("w1 checkpoint --relese-db"), UsageError);
  assert.throws(() => parse("w1 checkpoint --paths"), UsageError);
  assert.throws(() => parseArgs(["--message"], PUSH_OPTS), UsageError);
  assert.throws(() => parse("--all=yes"), UsageError);
  // A third positional is an error too, not a silently dropped word.
  assert.throws(() => parse("w1 checkpoint extra"), UsageError);
});

test("contradictory pairs are refused", () => {
  assert.throws(() => exclusive(parse("w1 c --all --paths a.sql").options, ["paths", "all"]), UsageError);
  assert.throws(
    () => exclusive(parse("w1 c --release-db --keep-db").options, ["release-db", "keep-db"]),
    UsageError,
  );
  assert.equal(exclusive(parse("w1 c --keep-db").options, ["release-db", "keep-db"]), "keep-db");
  assert.equal(exclusive({}, ["release-db", "keep-db"]), null);
});

test("--include-unclaimed resolves, and a path that is not there is an error", () => {
  const unclaimed = [{ path: "a.js" }, { path: "b.js" }];
  assert.deepEqual(resolveUnclaimed(["all"], unclaimed), unclaimed);
  assert.deepEqual(resolveUnclaimed(["none"], unclaimed), []);
  assert.deepEqual(resolveUnclaimed(["b.js"], unclaimed), [{ path: "b.js" }]);
  assert.throws(() => resolveUnclaimed(["c.js"], unclaimed), UsageError);
});

test("stdin closing ends the run instead of spinning the re-ask loop", () => {
  // No input at all: the loops below would otherwise be handed "" forever.
  const r = withInput([], `choose("q", [{key:"a",label:"all"}]); console.log("REACHED");`);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /REACHED/);
  assert.match(r.err, /STOPPED[\s\S]*stdin closed/);
});

/** Run a snippet with git-flow's stop() and friends in scope. */
function flow(body) {
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { stop } from "file:///${FLOW}";\n${body}`],
    { input: "", encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

test("a refusal: banner on stderr, non-zero, nothing on stdout", () => {
  const r = flow(`stop("Not today.", 2); console.log("Done.");`);
  assert.equal(r.code, 2);
  assert.equal(r.out, "");
  assert.match(r.err, /━+\n  🛑 STOPPED[^\n]*\n━+\n  Not today\.\n━+/);
  assert.equal(flow(`stop("x");`).code, 1);
});

test("a chosen cancel: plain line on stdout, exit 0, no banner, no Done", () => {
  const r = flow(`stop("Cancelled. Nothing changed.", 0); console.log("Done.");`);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.match(r.out, /^\nCancelled\. Nothing changed\.\n$/);
});

test("the banner is red only when asked", () => {
  assert.doesNotMatch(refusalBanner("x"), /\x1b/);
  assert.match(refusalBanner("x", { color: true }), /\x1b\[1;31m/);
});

const TREES = [
  { owner: "main", isMain: true, path: "C:/r" },
  { owner: "wt-a", isMain: false, path: "C:/r/.claude/worktrees/wt-a" },
  { owner: "wt-b", isMain: false, path: "C:/r/.claude/worktrees/wt-b" },
];

test("findCheckout: by name or number; a stranger or a mode word is refused", () => {
  assert.equal(findCheckout("WT-A", TREES).checkout, TREES[1]);
  assert.equal(findCheckout("3", TREES).checkout, TREES[2]);
  assert.match(findCheckout("nope", TREES).refusal, /"nope" is not a checkout[\s\S]*Open: main, wt-a, wt-b/);
  assert.match(findCheckout("finish", TREES).refusal, /It is a mode/);
  assert.ok(findCheckout("9", TREES).refusal);
});

test("pickCheckouts: blank cancels, nothing recognised refuses, the rest is chosen", () => {
  assert.ok(pickCheckouts("", TREES).cancel);
  assert.match(pickCheckouts("zz 9", TREES).refusal, /Nothing recognised in "zz 9"/);
  const p = pickCheckouts("1 wt-b zz", TREES);
  assert.deepEqual(p.chosen.map((t) => t.owner), ["main", "wt-b"]);
  assert.deepEqual(p.unrecognised, ["zz"]);
  assert.equal(pickCheckouts("all", TREES).chosen.length, 3);
});

test("modeKey and misplacedOptions refuse what does not fit", () => {
  assert.equal(modeKey("Finish", TREES[1]), "f");
  assert.throws(() => modeKey("checkpoint", TREES[0]), UsageError);
  assert.throws(() => modeKey("push", TREES[1]), UsageError);
  assert.throws(() => modeKey("go", TREES[1]), UsageError);
  assert.match(misplacedOptions("f", TREES[1], { paths: ["a"] }), /--paths is not used by finish on wt-a/);
  assert.match(misplacedOptions("p", TREES[0], { all: true, "keep-db": true }), /--all, --keep-db are not used/);
  assert.equal(misplacedOptions("c", TREES[1], { paths: ["a"] }), null);
  assert.equal(misplacedOptions("s", TREES[1], { paths: ["a"] }), null);
});

test("finish from inside the worktree is refused, by checkout or by directory", () => {
  const opts = (cwd) => ({ cwd, mainPath: "C:/r" });
  const r = finishFromInside({ ...TREES[1], isCurrent: true }, opts("C:/elsewhere"));
  assert.match(r, /inside wt-a[\s\S]*cd "C:\\r"[\s\S]*gitpush wt-a finish/);
  assert.ok(finishFromInside(TREES[1], opts("C:/r/.claude/worktrees/wt-a/src/deep")));
  assert.equal(finishFromInside(TREES[1], opts("C:/r")), null);
  assert.equal(finishFromInside(TREES[1], opts("C:/r/.claude/worktrees/wt-ab")), null);
  assert.equal(finishFromInside({ ...TREES[0], isCurrent: true }, opts("C:/r")), null);
});

test("isInside ignores case on Windows and trailing slashes", { skip: process.platform !== "win32" }, () => {
  assert.ok(isInside("c:\\R\\.Claude\\worktrees\\WT-A\\", "C:/r/.claude/worktrees/wt-a"));
});

test("resultExit: failure and partial refuse; a cancel exits 0 and stops the run", () => {
  assert.equal(resultExit("failed", "wt-a").code, 1);
  assert.equal(resultExit("partial", "wt-a").code, 1);
  assert.equal(resultExit("done", "wt-a"), null);
  const c = resultExit("cancelled", "wt-b", { done: ["wt-a"], remaining: ["main"] });
  assert.equal(c.code, 0);
  assert.match(c.message, /^Cancelled wt-b\. Nothing changed for it\.\nAlready done before it: wt-a\.\nNot attempted: main\.$/);
});

test("--paths keeps each argv token whole, spaces and all", () => {
  const w7b = "docs/progress-warren_buffet-w7b (1).md";
  const { options } = parseArgs(["--paths", w7b, "2", "src/a.js"], { paths: { kind: "list" } });
  const sel = parseSelection(options.paths, 3);
  assert.deepEqual(sel.words, [w7b, "src/a.js"]);
  assert.deepEqual(sel.indexes, [2]);
  assert.deepEqual(parseSelection(["1,3"], 3).indexes, [1, 3]);
  assert.ok(parseSelection([" ", ""], 3).blank);
});

test("a typed answer can quote a path with spaces", () => {
  const sel = parseSelection(`1 "docs/a (1).md" 'b c.md' d.md`, 3);
  assert.deepEqual(sel.words, ["docs/a (1).md", "b c.md", "d.md"]);
  assert.deepEqual(sel.indexes, [1]);
});

/** A throwaway main checkout and worktree, plain folders: the docs move is fs only. */
function closeout({ spec = true, progress = true, inMain = [], inTree = [] } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "closeout-"));
  const main = path.join(base, "main");
  const tree = path.join(main, ".claude", "worktrees", "proj-x1y");
  for (const r of [main, tree]) mkdirSync(path.join(r, "docs", "history"), { recursive: true });
  if (spec) writeFileSync(path.join(tree, "docs", "technical-spec-proj-x1y.md"), "spec");
  if (progress) writeFileSync(path.join(tree, "docs", "progress-proj-x1y.md"), "progress");
  for (const f of inMain) writeFileSync(path.join(main, f), "old");
  for (const f of inTree) writeFileSync(path.join(tree, f), "old");
  return { main, tree };
}

test("planDocsMove: both docs go to docs/history/ under the same names", () => {
  const { main, tree } = closeout();
  assert.deepEqual(planDocsMove("proj-x1y", tree, main), {
    moves: [
      { from: "docs/technical-spec-proj-x1y.md", to: "docs/history/technical-spec-proj-x1y.md" },
      { from: "docs/progress-proj-x1y.md", to: "docs/history/progress-proj-x1y.md" },
    ],
    missing: [],
    clashes: [],
  });
});

test("planDocsMove: a missing doc is reported, not refused", () => {
  const { main, tree } = closeout({ spec: false });
  const plan = planDocsMove("proj-x1y", tree, main);
  assert.deepEqual(plan.missing, ["docs/technical-spec-proj-x1y.md"]);
  assert.equal(plan.moves.length, 1);
  assert.deepEqual(plan.clashes, []);
});

test("planDocsMove: a same-named history file in main or the worktree is a clash", () => {
  const inMain = closeout({ inMain: ["docs/history/progress-proj-x1y.md"] });
  assert.deepEqual(planDocsMove("proj-x1y", inMain.tree, inMain.main).clashes, ["docs/history/progress-proj-x1y.md"]);
  const inTree = closeout({ inTree: ["docs/history/technical-spec-proj-x1y.md"] });
  assert.deepEqual(planDocsMove("proj-x1y", inTree.tree, inTree.main).clashes, [
    "docs/history/technical-spec-proj-x1y.md",
  ]);
});

/** A worktree whose docs are named for people, not after the code. */
function taggedCloseout(code = "restructure_p5-h7m") {
  const { main, tree } = closeout({ spec: false, progress: false });
  writeFileSync(path.join(tree, "docs", "technical-spec-restructure-p5.md"), `# Spec\n\nProject code: ${code}\n`);
  writeFileSync(path.join(tree, "docs", "progress-restructure-p5.md"), `# Progress\r\n\r\n**Project code:** \`${code}\`\r\n`);
  writeFileSync(path.join(tree, "docs", "notes.md"), "Project code: restructure_p5-h7m-old\nmentions restructure_p5-h7m\n");
  writeFileSync(path.join(tree, "docs", "history", "old.md"), `Project code: ${code}\n`);
  return { main, tree };
}

test("planDocsMove: finds docs by their Project code line when names differ", () => {
  const { main, tree } = taggedCloseout();
  assert.deepEqual(planDocsMove("restructure_p5-h7m", tree, main), {
    moves: [
      { from: "docs/progress-restructure-p5.md", to: "docs/history/progress-restructure-p5.md" },
      { from: "docs/technical-spec-restructure-p5.md", to: "docs/history/technical-spec-restructure-p5.md" },
    ],
    missing: [],
    clashes: [],
  });
});

test("planDocsMove: a tagged doc and a name-based doc both move", () => {
  const { main, tree } = taggedCloseout("proj-x1y");
  writeFileSync(path.join(tree, "docs", "progress-proj-x1y.md"), "untagged");
  const plan = planDocsMove("proj-x1y", tree, main);
  assert.deepEqual(plan.moves.map((m) => m.from), [
    "docs/progress-restructure-p5.md",
    "docs/technical-spec-restructure-p5.md",
    "docs/progress-proj-x1y.md",
  ]);
  assert.deepEqual(plan.missing, []);
});

test("planDocsMove: no tagged doc falls back to names, reporting the missing", () => {
  const { main, tree } = taggedCloseout();
  const plan = planDocsMove("other-a1b", tree, main);
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.missing, ["docs/technical-spec-other-a1b.md", "docs/progress-other-a1b.md"]);
});

test("planDocsMove: a tagged doc clashes with a same-named history file", () => {
  const { main, tree } = taggedCloseout();
  writeFileSync(path.join(main, "docs", "history", "progress-restructure-p5.md"), "old");
  assert.deepEqual(planDocsMove("restructure_p5-h7m", tree, main).clashes, ["docs/history/progress-restructure-p5.md"]);
});

test("applyDocsMove moves the files, making docs/history/ if needed", () => {
  const { main, tree } = closeout();
  rmSync(path.join(tree, "docs", "history"), { recursive: true });
  const { moves } = planDocsMove("proj-x1y", tree, main);
  applyDocsMove(tree, moves);
  assert.ok(!existsSync(path.join(tree, "docs", "progress-proj-x1y.md")));
  assert.ok(existsSync(path.join(tree, "docs", "history", "progress-proj-x1y.md")));
  assert.ok(existsSync(path.join(tree, "docs", "history", "technical-spec-proj-x1y.md")));
});

test("docsMovePaths stages the new paths, and an old one only if git lists it", () => {
  const moves = [
    { from: "docs/a.md", to: "docs/history/a.md" },
    { from: "docs/b.md", to: "docs/history/b.md" },
  ];
  // a.md was committed, so its removal shows; b.md never was, so it is just gone.
  const changed = [
    { path: "docs/a.md", status: " D" },
    { path: "docs/history/a.md", status: "??" },
    { path: "docs/history/b.md", status: "??" },
  ];
  assert.deepEqual(docsMovePaths(moves, changed), ["docs/history/a.md", "docs/history/b.md", "docs/a.md"]);
});

test("Finish lists the docs it moves as moves only, never as left behind", () => {
  const { main, tree } = closeout();
  const plan = planDocsMove("proj-x1y", tree, main);
  const dirty = [
    { path: "docs/technical-spec-proj-x1y.md", status: "??" },
    { path: "docs/progress-proj-x1y.md", status: "??" },
    { path: "src/a.js", status: " M" },
  ];
  assert.deepEqual(withoutMoved(dirty, plan.moves).map((f) => f.path), ["src/a.js"]);
});

test("main's Finish plans its docs in its own checkout, by its project code", () => {
  const { tree } = closeout();
  // A main checkout is just a root with the docs in it; both roots are the same.
  const plan = planDocsMove("proj-x1y", tree, tree);
  assert.equal(plan.moves.length, 2);
  assert.equal(docsClashRefusal(plan, "main (proj-x1y)"), null);
  writeFileSync(path.join(tree, "docs", "history", "progress-proj-x1y.md"), "old");
  const clash = docsClashRefusal(planDocsMove("proj-x1y", tree, tree), "main (proj-x1y)");
  assert.match(clash, /docs\/history\/progress-proj-x1y\.md[\s\S]*Nothing was changed for main \(proj-x1y\)\./);
});

test("Finish refuses anything it would leave uncommitted, naming it", () => {
  assert.equal(leftBehindRefusal("wt-a", []), null);
  const r = leftBehindRefusal("wt-a", [{ path: "notes.txt", status: "??" }]);
  assert.match(r, /wt-a has 1 change\(s\) Finish would not commit:\n  \?\? notes\.txt/);
  assert.match(r, /gitcom[\s\S]*Nothing was changed for wt-a\./);
});

test("--force only when git status is clean, and it says why", () => {
  const clean = forceDecision([]);
  assert.equal(clean.force, true);
  assert.match(clean.why, /ignored files/);
  const dirty = forceDecision([{ path: "notes.txt", status: "??" }]);
  assert.equal(dirty.force, false);
  assert.match(dirty.why, /would delete work:\n    \?\? notes\.txt/);
});

// gitpush itself, only on command lines it refuses while parsing — before it runs any git at all.
const GITPUSH = path.join(HERE, "..", "git-push-worktrees.mjs");
const gitpush = (...args) => {
  const r = spawnSync(process.execPath, [GITPUSH, ...args], {
    input: "",
    encoding: "utf8",
    cwd: os.tmpdir(),
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
};

test("gitpush: a bad command line is a loud refusal with exit 2", () => {
  const r = gitpush("--paths", "a.js", "--all");
  assert.equal(r.code, 2);
  assert.match(r.err, /STOPPED[\s\S]*--paths/);
  assert.doesNotMatch(r.out, /Done\./);
});

test("gitpush: --help is plain and exits 0", () => {
  const r = gitpush("--help");
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.match(r.out, /gitpush — bring work into main/);
});

test("removeEmptyDir deletes only an empty folder", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "gitflow-"));
  try {
    const empty = path.join(base, "empty");
    const full = path.join(base, "full");
    mkdirSync(empty);
    mkdirSync(full);
    writeFileSync(path.join(full, "x.txt"), "x");
    assert.equal(removeEmptyDir(empty), "removed");
    assert.equal(existsSync(empty), false);
    assert.equal(removeEmptyDir(empty), "gone");
    assert.equal(removeEmptyDir(full), "not-empty");
    assert.equal(existsSync(path.join(full, "x.txt")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
