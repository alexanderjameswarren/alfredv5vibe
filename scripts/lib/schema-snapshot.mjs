// Schema snapshot: the pure parts, shared by scripts/schema-snapshot.mjs and
// gitpush. Nothing here runs Docker or the Supabase CLI.

import fs from "node:fs";
import path from "node:path";

export const SNAPSHOT_PATH = "supabase/schema-snapshot.sql";
export const MIGRATIONS_DIR = "supabase/migrations";
export const MIN_BYTES = 10_000;
export const KNOWN_TABLES = [
  "public.reminders",
  "public.notes",
  "public.apps",
  "public.items",
  "public.inbox",
  "platform.registry",
];

// Numbered migrations only: `_pending_` files have no number yet.
const MIGRATION_RE = /^supabase\/migrations\/(\d+)_[^/]+\.sql$/;

export function migrationNumber(p) {
  const m = MIGRATION_RE.exec(p.replace(/\\/g, "/"));
  return m ? Number(m[1]) : null;
}

/** Highest numbered migration file in a checkout, or 0. */
export function highestMigration(root) {
  const dir = path.join(root, MIGRATIONS_DIR);
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .map((f) => migrationNumber(`${MIGRATIONS_DIR}/${f}`))
    .filter((n) => n !== null)
    .reduce((a, b) => Math.max(a, b), 0);
}

export function headerLine(date, through) {
  return `-- schema snapshot ${date}, through migration ${through} (supabase db dump --linked --schema public,platform)`;
}

/** The "through migration N" a snapshot's first line records, or 0 if none. */
export function snapshotThrough(text) {
  const first = (text ?? "").split(/\r?\n/, 1)[0];
  const m = /through migration (\d+)/.exec(first);
  return m ? Number(m[1]) : 0;
}

export function readSnapshotThrough(root) {
  const file = path.join(root, SNAPSHOT_PATH);
  return fs.existsSync(file) ? snapshotThrough(fs.readFileSync(file, "utf8")) : 0;
}

/**
 * Should a commit of `paths` regenerate the snapshot? Only when it carries a
 * numbered migration newer than the one the snapshot was taken through, and
 * `skip` (--no-snapshot) is not set.
 */
export function snapshotDecision(paths, through, { skip = false } = {}) {
  const nums = paths.map(migrationNumber).filter((n) => n !== null);
  if (!nums.length) return { run: false, reason: "no migration in this commit" };
  const newest = Math.max(...nums);
  if (newest <= through) {
    return { run: false, newest, reason: `migration ${newest} is not newer than the snapshot (${through})` };
  }
  if (skip) {
    return {
      run: false, skipped: true, newest,
      reason: `--no-snapshot: migration ${newest} is newer than the snapshot (${through}), which stays behind until a push that carries a migration`,
    };
  }
  return { run: true, newest, reason: `migration ${newest} is newer than the snapshot (${through})` };
}

/**
 * The "through migration N" a new snapshot records. gitpush regenerates before a
 * worktree merge, when main's own folder does not yet hold the merged migration,
 * so the newest merged number is passed in and the larger one wins.
 */
export function snapshotLabel(highestInCheckout, newestMerged) {
  return Math.max(highestInCheckout, Number.isInteger(newestMerged) ? newestMerged : 0);
}

/**
 * Regenerate the snapshot if the commit needs it, then commit. `commit` is
 * called only when there is nothing to do or the snapshot succeeded, so a
 * failed snapshot leaves nothing committed. `runSnapshot(newest)` gets the label.
 */
export function commitWithSnapshot(paths, { through, runSnapshot, commit }) {
  const decision = snapshotDecision(paths, through);
  if (!decision.run) return { ok: commit(paths), decision };
  const result = runSnapshot(decision.newest);
  if (!result.ok) return { ok: false, decision, message: result.message };
  const withSnap = paths.includes(SNAPSHOT_PATH) ? paths : [...paths, SNAPSHOT_PATH];
  return { ok: commit(withSnap), decision };
}

/**
 * Merge a worktree branch into main. With the snapshot, the merge stops before
 * committing so the regenerated file joins the merge commit; any failure after
 * that aborts the merge. `run(args)` runs one git command in main, true on success.
 */
export function mergeBranch(run, branch, includeSnapshot) {
  const msg = `Merge ${branch}`;
  if (!includeSnapshot) return run(["merge", "--no-ff", branch, "-m", msg]);
  if (!run(["merge", "--no-ff", "--no-commit", branch])) return false;
  if (run(["add", "--", SNAPSHOT_PATH]) && run(["commit", "-m", msg])) return true;
  run(["merge", "--abort"]);
  return false;
}

/**
 * A worktree Checkpoint or Finish, snapshot first. The snapshot runs BEFORE the
 * worktree commits anything, so if it fails nothing has moved anywhere. If the
 * worktree commit or the merge fails afterwards, main's snapshot file is put back.
 * `merge(includeSnapshot)` returns { merged, pushed }; `skip` is --no-snapshot.
 */
export function worktreeMergeWithSnapshot(
  mergedPaths,
  { through, runSnapshot, restoreSnapshot, commitWorktree, merge, skip = false },
) {
  const decision = snapshotDecision(mergedPaths, through, { skip });
  if (decision.run) {
    const snap = runSnapshot(decision.newest);
    if (!snap.ok) return { ok: false, decision, message: snap.message };
  }
  if (!commitWorktree()) {
    if (decision.run) restoreSnapshot();
    return { ok: false, decision };
  }
  const { merged, pushed } = merge(decision.run);
  if (!merged && decision.run) restoreSnapshot();
  return { ok: merged && pushed, decision };
}

/** Table counts per schema, and which known tables are missing, from dump text. */
export function inspectDump(text) {
  const counts = {};
  const found = new Set();
  const re = /CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?\."?(\w+)"?/g;
  for (const m of text.matchAll(re)) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    found.add(`${m[1]}.${m[2]}`);
  }
  return { counts, missing: KNOWN_TABLES.filter((t) => !found.has(t)) };
}
