// Block records: claims.mjs and the guard, run for real against a scratch main
// checkout ("main") and a scratch worktree ("wtB") made with fs, no git commands.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addBlocks, blockLoops, liveBlocks, removeClaims, resolveRepo, yieldDecision } from "./claims-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(ROOT, "scripts", "claims.mjs");
const GUARD = path.join(ROOT, ".claude", "hooks", "claims-guard.mjs");
const NOTICE = path.join(ROOT, ".claude", "hooks", "block-notice.mjs");
const REAL = resolveRepo(ROOT);

const snapshot = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const fwd = (p) => p.replace(/\\/g, "/");

function scratch() {
  const base = mkdtempSync(path.join(tmpdir(), "claim-blocks-"));
  const main = path.join(base, "main");
  const wt = path.join(main, ".claude", "worktrees", "wtB");
  const wtGit = path.join(main, ".git", "worktrees", "wtB");
  mkdirSync(path.join(main, ".git", "objects"), { recursive: true });
  mkdirSync(path.join(main, ".git", "refs"), { recursive: true });
  writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/wtB\n");
  writeFileSync(path.join(wtGit, "commondir"), "../..\n");
  writeFileSync(path.join(wtGit, "gitdir"), `${fwd(path.join(wt, ".git"))}\n`);
  for (const r of [main, wt]) {
    mkdirSync(path.join(r, "src", "items"), { recursive: true });
    for (const f of ["src/a.js", "src/b.js", "src/items/x.js"]) writeFileSync(path.join(r, f), "x");
  }
  writeFileSync(path.join(wt, ".git"), `gitdir: ${fwd(wtGit)}\n`);
  const file = path.join(main, ".git", "alfred-claims.json");
  const blocksFile = path.join(main, ".git", "alfred-claim-blocks.json");
  const env = { ...process.env, CLAIMS_GUARD: "", CLAIMS_BLOCKS_FILE: "", CLAIMS_PROJECT_FILE: "" };

  const seed = (...pairs) =>
    writeFileSync(
      file,
      JSON.stringify({
        claims: pairs.map(([owner, item]) => ({ item, owner, claimed_at: new Date().toISOString() })),
        reservations: [],
      }),
    );
  const blocks = () => (existsSync(blocksFile) ? JSON.parse(readFileSync(blocksFile, "utf8")).blocks : []);
  const cli = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const edit = (cwd, rel) => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(cwd, rel), content: "y" }, cwd }),
      env: { ...env, CLAUDE_PROJECT_DIR: cwd, CLAIMS_GUARD_LOG: path.join(base, "guard.log") },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stderr };
  };
  const notice = (cwd, { bound } = {}) => {
    const binding = path.join(base, "binding.json");
    if (bound) writeFileSync(binding, JSON.stringify({ code: bound }));
    const r = spawnSync(process.execPath, [NOTICE], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd, prompt: "go" }),
      env: { ...env, CLAUDE_PROJECT_DIR: cwd, CLAIMS_PROJECT_FILE: binding },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
  };
  return { main, wt, file, seed, blocks, cli, edit, notice, ctx: () => resolveRepo(main) };
}

const before = { claims: snapshot(REAL.file), blocks: snapshot(REAL.blocksFile) };
test.after(() => {
  assert.equal(snapshot(REAL.file), before.claims, "the real claims file was written to");
  assert.equal(snapshot(REAL.blocksFile), before.blocks, "the real blocks file was written to");
});

const shape = (b) => [b.waiter, b.item, b.holder, b.holder_item, b.via];

test("check records a block without changing its output or exit", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"]);
  const r = s.cli(s.wt, "check", "src/a.js", "src/b.js");
  assert.equal(r.code, 1);
  assert.equal(r.out, "CONFLICT  src/a.js — main holds src/a.js\nfree      src/b.js\n\n1 conflict. Stop and ask Alex — do not edit these.\n");
  assert.deepEqual(s.blocks().map(shape), [["wtB", "src/a.js", "main", "src/a.js", "check"]]);
  assert.equal(s.blocks()[0].holder_code, "main");
});

test("a refused claim records a block and claims nothing", () => {
  const s = scratch();
  s.seed(["main", "src/items/"]);
  const claimsBefore = readFileSync(s.file, "utf8");
  const r = s.cli(s.wt, "claim", "src/items/x.js", "src/b.js");
  assert.equal(r.code, 1);
  assert.equal(readFileSync(s.file, "utf8"), claimsBefore);
  assert.deepEqual(s.blocks().map(shape), [["wtB", "src/items/x.js", "main", "src/items/", "claim"]]);
});

test("a repeat keeps one record and its first time", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"]);
  s.cli(s.wt, "check", "src/a.js");
  const first = s.blocks()[0].blocked_at;
  s.cli(s.wt, "claim", "src/a.js");
  assert.equal(s.blocks().length, 1);
  assert.equal(s.blocks()[0].blocked_at, first);
  assert.equal(s.blocks()[0].via, "claim");
});

test("the guard records a block and still blocks", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"], ["wtB", "src/b.js"]);
  assert.equal(s.edit(s.wt, "src/a.js").code, 2);
  assert.deepEqual(s.blocks().map(shape), [["wtB", "src/a.js", "main", "src/a.js", "guard"]]);
  // An unheld file is not a block.
  assert.equal(s.edit(s.main, "src/b.js").code, 2);
  assert.equal(s.edit(s.wt, "src/items/x.js").code, 2);
  assert.equal(s.blocks().length, 2);
  assert.equal(s.blocks()[1].waiter, "main");
});

test("status lists live blocks", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  assert.match(s.cli(s.main, "status").out, /Blocks[^\n]*\n {2}wtB waits for src\/a\.js — held by main {2}\[/);
});

test("the holder releasing clears it, and the waiter can then claim", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"], ["main", "src/b.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  assert.equal(s.blocks().length, 1);
  s.cli(s.main, "release", "src/a.js");
  assert.equal(s.blocks().length, 0);
  assert.equal(s.cli(s.wt, "claim", "src/a.js").code, 0);
});

test("readers ignore a record whose holder let go behind its back", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  s.seed(); // older code rewrote the claims file and never touched blocks
  assert.equal(s.blocks().length, 1);
  assert.doesNotMatch(s.cli(s.main, "status").out, /Blocks/);
});

test("a finish drops the waiter's records; a checkpoint does not", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"], ["wtB", "src/b.js"], ["wtB", "db:deploy"]);
  s.cli(s.wt, "claim", "src/a.js");
  const ctx = { ...s.ctx(), owner: "wtB" };
  removeClaims(ctx, "wtB", (item) => item.startsWith("db:"));
  assert.equal(s.blocks().length, 1);
  removeClaims(ctx, "wtB");
  assert.equal(s.blocks().length, 0);
});

test("cleanup of the waiter drops its records", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"], ["wtB", "src/b.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  s.cli(s.main, "cleanup", "wtB");
  assert.equal(s.blocks().length, 0);
});

test("yield refuses when git cannot compare the file", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  const r = s.cli(s.main, "yield", "src/a.js");
  assert.equal(r.code, 1);
  assert.match(r.out, /Not yielded: .*has changes \(git could not compare it\)/);
  assert.equal(s.blocks().length, 1);
});

test("yieldDecision", () => {
  const claim = (owner, item) => ({ owner, item });
  const state = { claims: [claim("h", "src/a.js"), claim("h", "src/items/")], reservations: [] };
  const blocks = addBlocks([], {
    waiter: "w",
    hits: [
      { item: "src/a.js", holders: [claim("h", "src/a.js")] },
      { item: "src/items/x.js", holders: [claim("h", "src/items/")] },
    ],
    via: "claim",
  });
  const d = (item, changed = "", owner = "h") => yieldDecision({ state, blocks, owner, item, changed });

  assert.equal(d("src/a.js").ok, true);
  assert.match(d("src/a.js", "differs from main").reason, /has changes/);
  assert.match(d("src/items/x.js").reason, /no thread is waiting/);
  assert.match(d("src/items/").reason, /not a folder/);
  assert.match(d("src/a.js", "", "w").reason, /no thread is waiting/);

  const folderBlock = addBlocks([], {
    waiter: "w",
    hits: [{ item: "src/items/x.js", holders: [claim("h", "src/items/x.js")] }],
    via: "claim",
  });
  const viaFolder = yieldDecision({ state, blocks: folderBlock, owner: "h", item: "src/items/x.js", changed: "" });
  assert.match(viaFolder.reason, /folder claim/);
});

// The notice hook. It runs no git, so it cannot tell changed from unchanged: it
// gives both rules and leaves the call to yield. A folder-held file is the one
// it can call changed up front.

test("notice: says nothing with no block, or to the waiter", () => {
  const s = scratch();
  s.seed(["wtB", "src/a.js"]);
  assert.equal(s.notice(s.wt), "");
  s.cli(s.main, "claim", "src/a.js");
  assert.equal(s.notice(s.main), "");
});

test("notice: a worktree holder of a file it may not have changed", () => {
  const s = scratch();
  s.seed(["wtB", "src/a.js"]);
  s.cli(s.main, "claim", "src/a.js");
  const text = s.notice(s.wt, { bound: "rem-k4q" });
  assert.match(text, /this thread \(wtB\) holds:\n {2}- rem-k4q is waiting on src\/a\.js/);
  assert.match(text, /Do NOT change your plan/);
  assert.match(text, /node scripts\/claims\.mjs yield <file>/);
  assert.match(text, /denies the command, do not retry it/);
  assert.match(text, /gitpush wtB checkpoint --paths <file>/);
  assert.match(text, /Blocking: rem-k4q waits for src\/a\.js/);
  assert.doesNotMatch(text, /cannot be yielded/);
});

test("notice: a changed file, held through a folder", () => {
  const s = scratch();
  s.seed(["wtB", "src/items/"]);
  s.cli(s.main, "claim", "src/items/x.js");
  const text = s.notice(s.wt);
  assert.match(text, /folder claim src\/items\/, so it cannot be yielded: treat it as changed/);
  assert.match(text, /KEEP the claim\. Never merge it and never yield it/);
  assert.match(text, /merge impact/);
});

test("notice: main as holder has no single-file merge", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  const text = s.notice(s.main, { bound: "claim_blocks-h3n" });
  assert.match(text, /this thread \(claim_blocks-h3n\) holds:\n {2}- wtB is waiting on src\/a\.js/);
  assert.match(text, /NO single-file merge from the main checkout\. `gitpush main push`/);
  assert.doesNotMatch(text, /checkpoint --paths/);
  assert.match(text, /Blocking: wtB waits for src\/a\.js/);
});

test("blockLoops", () => {
  const bk = (waiter, holder) => ({ waiter, holder, item: `${waiter}-${holder}.js` });
  const two = blockLoops([bk("a", "b"), bk("b", "a"), bk("c", "a")]);
  assert.deepEqual(two.loops, [["a", "b"]]);
  assert.equal(two.inLoop("a", "b") && two.inLoop("b", "a"), true);
  assert.equal(two.inLoop("c", "a"), false);
  const three = blockLoops([bk("a", "b"), bk("b", "c"), bk("c", "a")]);
  assert.deepEqual(three.loops, [["a", "b", "c"]]);
  assert.equal(three.inLoop("c", "a"), true);
  assert.deepEqual(blockLoops([bk("a", "b"), bk("b", "c")]).loops, []);
});

test("a deadlock is marked in status and told to both holders", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"], ["wtB", "src/b.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  s.cli(s.main, "claim", "src/b.js");
  const out = s.cli(s.main, "status").out;
  assert.match(out, /wtB waits for src\/a\.js — held by main {2}\[[^\]]*\] {2}⟲ DEADLOCK/);
  assert.match(out, /⟲ {2}Deadlock: main, wtB are waiting on each other/);
  assert.ok(out.indexOf("Blocks —") > out.lastIndexOf("  claim "), "Blocks come after every claim");
  assert.match(s.notice(s.main), /DEADLOCK: wtB is waiting on you/);
  assert.match(s.notice(s.wt), /DEADLOCK: main is waiting on you/);
});

test("a one-way block is not mutual", () => {
  const s = scratch();
  s.seed(["main", "src/a.js"]);
  s.cli(s.wt, "claim", "src/a.js");
  assert.doesNotMatch(s.notice(s.main), /DEADLOCK/);
  assert.doesNotMatch(s.cli(s.main, "status").out, /DEADLOCK|Deadlock:/);
});

test("liveBlocks", () => {
  const b = addBlocks([], { waiter: "w", hits: [{ item: "src/a.js", holders: [{ owner: "h", item: "src/" }] }], via: "check" });
  assert.equal(liveBlocks(b, { claims: [{ owner: "h", item: "src/" }] }).length, 1);
  assert.equal(liveBlocks(b, { claims: [{ owner: "h", item: "src/b.js" }] }).length, 0);
  assert.equal(liveBlocks(b, { claims: [{ owner: "w", item: "src/a.js" }] }).length, 0);
});
