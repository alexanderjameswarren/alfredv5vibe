// Folder claims end to end: claims.mjs and the guard, run for real against a
// scratch main checkout and a scratch worktree made with fs (no git commands).
// Owner A is the scratch main ("main"); owner B is the scratch worktree ("wtB").

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepo } from "./claims-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(ROOT, "scripts", "claims.mjs");
const GUARD = path.join(ROOT, ".claude", "hooks", "claims-guard.mjs");
const REAL_CLAIMS = resolveRepo(ROOT).file;
const REAL_LOG = path.join(ROOT, ".clip", "claims-guard.log");

const snapshot = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const fwd = (p) => p.replace(/\\/g, "/");

function scratch() {
  const base = mkdtempSync(path.join(tmpdir(), "folder-claims-"));
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
    for (const d of ["src/items/sub", "src/inbox", "src/items-old"]) {
      mkdirSync(path.join(r, d), { recursive: true });
    }
    for (const f of ["src/items/foo.jsx", "src/items/sub/deep.jsx", "src/inbox/x.jsx", "src/items-old/a.jsx"]) {
      writeFileSync(path.join(r, f), "x");
    }
  }
  writeFileSync(path.join(wt, ".git"), `gitdir: ${fwd(wtGit)}\n`);
  const file = path.join(main, ".git", "alfred-claims.json");
  const log = path.join(base, "guard.log");

  const seed = (...pairs) =>
    writeFileSync(
      file,
      JSON.stringify({
        claims: pairs.map(([owner, item]) => ({ item, owner, claimed_at: new Date().toISOString() })),
        reservations: [],
      }),
    );
  const items = () => JSON.parse(readFileSync(file, "utf8")).claims.map((c) => c.item);
  const cli = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const guard = (cwd, tool, input) => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CLAIMS_GUARD_LOG: log, CLAIMS_GUARD: "" },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stderr };
  };
  const edit = (cwd, rel) => guard(cwd, "Write", { file_path: path.join(cwd, rel), content: "y" });
  const sh = (cwd, command, tool = "Bash") => guard(cwd, tool, { command });
  return { main, wt, seed, items, cli, edit, sh, guard };
}

const before = { claims: snapshot(REAL_CLAIMS), log: snapshot(REAL_LOG) };
test.after(() => {
  assert.equal(snapshot(REAL_CLAIMS), before.claims, "the real claims file was written to");
  assert.equal(snapshot(REAL_LOG), before.log, "the real guard log was written to");
});

const ALLOW = 0;
const BLOCK = 2;
const CONFLICT = 1;

test("a-c: the holder edits and creates anything under its folder", () => {
  const s = scratch();
  s.seed(["main", "src/items/"]);
  assert.equal(s.edit(s.main, "src/items/foo.jsx").code, ALLOW, "a");
  assert.equal(s.edit(s.main, "src/items/brand-new.jsx").code, ALLOW, "b");
  assert.equal(s.edit(s.main, "src/items/sub/deep.jsx").code, ALLOW, "c");
  assert.equal(s.edit(s.main, "src/items/newsub/new.jsx").code, ALLOW, "c, new subfolder");
  assert.equal(s.sh(s.main, "touch src/items/sub/t.jsx").code, ALLOW, "c, shell");
});

test("the holder's shell writes may name the folder itself", () => {
  const s = scratch();
  s.seed(["main", "src/items/"]);
  for (const c of ["cp /c/x.dll src/items/", "mkdir -p src/items", "tar -xf /c/x.tgz -C src/items"]) {
    assert.equal(s.sh(s.main, c).code, ALLOW, c);
  }
  assert.equal(s.sh(s.main, "Copy-Item C:\\x.dll src\\items\\", "PowerShell").code, ALLOW);
  assert.equal(s.sh(s.main, "mkdir -p src/items-old").code, BLOCK, "a sibling is not covered");
});

test("d-e: another thread cannot claim or edit inside a held folder", () => {
  const s = scratch();
  s.seed(["main", "src/items/"]);
  const d = s.cli(s.wt, "claim", "src/items/foo.jsx");
  assert.equal(d.code, CONFLICT);
  assert.match(d.out, /CONFLICT\s+src\/items\/foo\.jsx — main holds src\/items\//);
  assert.deepEqual(s.items(), ["src/items/"]);
  const e = s.edit(s.wt, "src/items/sub/deep.jsx");
  assert.equal(e.code, BLOCK);
  assert.match(e.out, /main holds src\/items\//);
  assert.equal(s.sh(s.wt, "cp /c/x.dll src/items/").code, BLOCK);
});

test("f: nobody claims a folder over another thread's file", () => {
  const s = scratch();
  s.seed(["wtB", "src/inbox/x.jsx"]);
  const f = s.cli(s.main, "claim", "src/inbox/");
  assert.equal(f.code, CONFLICT);
  assert.match(f.out, /wtB holds src\/inbox\/x\.jsx/);
  assert.equal(s.cli(s.main, "claim", "src/inbox").code, CONFLICT, "without the slash too");
});

test("g: check reports both directions", () => {
  const s = scratch();
  s.seed(["main", "src/items/"], ["wtB", "src/inbox/x.jsx"]);
  assert.equal(s.cli(s.wt, "check", "src/items/foo.jsx").code, CONFLICT);
  assert.equal(s.cli(s.main, "check", "src/inbox/").code, CONFLICT);
  assert.equal(s.cli(s.main, "check", "src/inbox").code, CONFLICT);
});

test("an existing folder claimed without its slash is a folder claim", () => {
  const s = scratch();
  s.seed();
  assert.equal(s.cli(s.main, "claim", "src/items").code, 0);
  assert.deepEqual(s.items(), ["src/items/"]);
  assert.equal(s.edit(s.main, "src/items/foo.jsx").code, ALLOW);
  assert.equal(s.cli(s.wt, "check", "src/items/foo.jsx").code, CONFLICT);
});

test("a missing, extensionless path is refused, not saved as a file", () => {
  const s = scratch();
  s.seed();
  const r = s.cli(s.main, "claim", "src/newfolder");
  assert.equal(r.code, 2);
  assert.match(r.out, /add a trailing slash: src\/newfolder\//);
  assert.deepEqual(s.items(), []);
  assert.equal(s.cli(s.main, "claim", "src/newfolder/").code, 0);
  assert.deepEqual(s.items(), ["src/newfolder/"]);
});

test("backslashes", () => {
  const s = scratch();
  s.seed();
  s.cli(s.main, "claim", "src\\items\\");
  assert.deepEqual(s.items(), ["src/items/"]);
  const abs = path.join(s.main, "src", "items", "sub", "deep.jsx").replace(/\//g, "\\");
  assert.equal(s.guard(s.main, "Write", { file_path: abs }).code, ALLOW);
  assert.equal(s.cli(s.wt, "check", "src\\items\\foo.jsx").code, CONFLICT);
});

test("letter case", { skip: process.platform !== "win32" }, () => {
  const s = scratch();
  s.seed(["main", "src/items/"]);
  assert.equal(s.edit(s.main, "SRC/Items/foo.jsx").code, ALLOW);
  assert.equal(s.cli(s.wt, "check", "src/ITEMS/foo.jsx").code, CONFLICT);
  const e = s.edit(s.wt, "Src/Items/foo.jsx");
  assert.equal(e.code, BLOCK);
  assert.match(e.out, /main holds src\/items\//, "the message uses the same rule");
});

test("a shared-prefix sibling is not covered", () => {
  const s = scratch();
  s.seed(["main", "src/items/"]);
  assert.match(s.edit(s.wt, "src/items-old/a.jsx").out, /Nobody holds it/);
  assert.match(s.cli(s.wt, "check", "src/items-old/a.jsx").out, /free\s+src\/items-old\/a\.jsx/);
  assert.equal(s.cli(s.wt, "claim", "src/items-old/").code, 0);
});

test("worktree paths versus the main checkout", () => {
  const s = scratch();
  s.seed(["wtB", "src/items/"]);
  assert.equal(s.edit(s.wt, "src/items/sub/deep.jsx").code, ALLOW);
  assert.match(s.cli(s.wt, "check", path.join(s.wt, "src/items/foo.jsx")).out, /yours/);
  assert.equal(s.cli(s.main, "check", "src/items/foo.jsx").code, CONFLICT);
  assert.equal(s.edit(s.main, "src/items/foo.jsx").code, BLOCK);

  // main reaching into B's worktree
  const c = s.cli(s.main, "check", path.join(s.wt, "src/items/foo.jsx"));
  assert.equal(c.code, 2);
  assert.match(c.out, /another thread's worktree/);
  assert.equal(s.cli(s.main, "claim", ".claude/worktrees/wtB/src/items/").code, 2);
  const e = s.edit(s.main, ".claude/worktrees/wtB/src/items/foo.jsx");
  assert.equal(e.code, BLOCK);
  assert.match(e.out, /inside the wtB worktree/);

  // even a claim on .claude/ does not reach into a worktree
  s.seed(["main", ".claude/"]);
  assert.equal(s.edit(s.main, ".claude/worktrees/wtB/src/items/foo.jsx").code, BLOCK);
  assert.equal(s.sh(s.main, "touch .claude/worktrees/wtB/src/items/foo.jsx").code, BLOCK);
  assert.deepEqual(s.items(), [".claude/"]);
});
