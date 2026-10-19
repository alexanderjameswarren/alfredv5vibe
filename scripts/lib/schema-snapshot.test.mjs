import test from "node:test";
import assert from "node:assert/strict";
import {
  SNAPSHOT_PATH,
  commitWithSnapshot,
  headerLine,
  inspectDump,
  mergeBranch,
  migrationNumber,
  snapshotDecision,
  snapshotThrough,
  worktreeMergeWithSnapshot,
} from "./schema-snapshot.mjs";

const MIG = "supabase/migrations/139_add_thing.sql";

// Records what was committed and whether the snapshot ran; no Docker involved.
function harness({ snapshotOk = true } = {}) {
  const calls = { snapshot: 0, committed: null };
  return {
    calls,
    deps: {
      through: 138,
      runSnapshot: () => {
        calls.snapshot += 1;
        return snapshotOk ? { ok: true } : { ok: false, message: "boom" };
      },
      commit: (paths) => {
        calls.committed = paths;
        return true;
      },
    },
  };
}

test("runs and commits the snapshot with a newer migration", () => {
  const { calls, deps } = harness();
  const r = commitWithSnapshot([MIG, "src/a.js"], deps);
  assert.equal(r.ok, true);
  assert.equal(calls.snapshot, 1);
  assert.deepEqual(calls.committed, [MIG, "src/a.js", SNAPSHOT_PATH]);
});

test("skips with no migration in the commit", () => {
  const { calls, deps } = harness();
  commitWithSnapshot(["src/a.js"], deps);
  assert.equal(calls.snapshot, 0);
  assert.deepEqual(calls.committed, ["src/a.js"]);
});

test("skips when the migration is not newer", () => {
  const { calls, deps } = harness();
  commitWithSnapshot(["supabase/migrations/138_old.sql"], deps);
  assert.equal(calls.snapshot, 0);
});

test("stops without committing when the snapshot fails", () => {
  const { calls, deps } = harness({ snapshotOk: false });
  const r = commitWithSnapshot([MIG], deps);
  assert.equal(r.ok, false);
  assert.equal(r.message, "boom");
  assert.equal(calls.committed, null);
});

test("pending and non-migration paths have no number", () => {
  assert.equal(migrationNumber("supabase/migrations/_pending_main_x.sql"), null);
  assert.equal(migrationNumber("supabase/schema-snapshot.sql"), null);
  assert.equal(migrationNumber("supabase\\migrations\\084_x.sql"), 84);
});

test("header round-trips its migration number", () => {
  assert.equal(snapshotThrough(`${headerLine("2026-10-19 08:35", 138)}\nCREATE…`), 138);
  assert.equal(snapshotThrough(""), 0);
  assert.equal(snapshotDecision([MIG], 0).run, true);
});

// Fake git in main: records every command, fails the ones in `failing`.
function fakeGit(failing = []) {
  const log = [];
  const run = (args) => {
    log.push(args.join(" "));
    return !failing.includes(args[0]);
  };
  return { log, run };
}

// A worktree merge with stand-ins for every side effect.
function worktreeRun({ paths, snapshotOk = true, gitFails = [] }) {
  const calls = { snapshot: 0, restored: 0, worktreeCommits: 0 };
  const git = fakeGit(gitFails);
  const result = worktreeMergeWithSnapshot(paths, {
    through: 138,
    runSnapshot: () => {
      calls.snapshot += 1;
      return snapshotOk ? { ok: true } : { ok: false, message: "no docker" };
    },
    restoreSnapshot: () => (calls.restored += 1),
    commitWorktree: () => (calls.worktreeCommits += 1, true),
    merge: (withSnap) => {
      const merged = mergeBranch(git.run, "worktree-x", withSnap);
      return { merged, pushed: merged };
    },
  });
  return { result, calls, log: git.log };
}

test("worktree: a newer migration puts the snapshot in the merge commit", () => {
  const { result, calls, log } = worktreeRun({ paths: [MIG] });
  assert.equal(result.ok, true);
  assert.equal(calls.snapshot, 1);
  assert.deepEqual(log, [
    "merge --no-ff --no-commit worktree-x",
    `add -- ${SNAPSHOT_PATH}`,
    "commit -m Merge worktree-x",
  ]);
});

test("worktree: no newer migration merges as before, no snapshot", () => {
  const { calls, log } = worktreeRun({ paths: ["src/a.js", "supabase/migrations/100_old.sql"] });
  assert.equal(calls.snapshot, 0);
  assert.deepEqual(log, ["merge --no-ff worktree-x -m Merge worktree-x"]);
});

test("worktree: a failed snapshot leaves main and the worktree untouched", () => {
  const { result, calls, log } = worktreeRun({ paths: [MIG], snapshotOk: false });
  assert.equal(result.ok, false);
  assert.equal(result.message, "no docker");
  assert.equal(calls.worktreeCommits, 0);
  assert.deepEqual(log, []);
});

test("worktree: a failed merge commit aborts the merge and restores the snapshot", () => {
  const { result, calls, log } = worktreeRun({ paths: [MIG], gitFails: ["commit"] });
  assert.equal(result.ok, false);
  assert.equal(log.at(-1), "merge --abort");
  assert.equal(calls.restored, 1);
});

test("inspectDump counts tables per schema and finds missing ones", () => {
  const { counts, missing } = inspectDump(
    'CREATE TABLE IF NOT EXISTS "public"."items" (\nCREATE TABLE "platform"."registry" (',
  );
  assert.deepEqual(counts, { public: 1, platform: 1 });
  assert.ok(missing.includes("public.reminders"));
  assert.ok(!missing.includes("public.items"));
});
