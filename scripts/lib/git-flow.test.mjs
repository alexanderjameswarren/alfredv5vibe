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
import {
  defaultMessage,
  exclusive,
  parseArgs,
  parseSelection,
  resolveUnclaimed,
  today,
  UsageError,
} from "./git-flow.mjs";

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
  assert.match(r.out, /stdin closed/);
});
