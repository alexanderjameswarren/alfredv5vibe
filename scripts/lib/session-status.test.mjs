import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_TYPES, readStatus, stateForNotification, writeSessionStatus } from "./session-status.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "..", "..", ".claude", "hooks", "session-status.mjs");

// A scratch checkout: `.git` is a folder for main, a file for a worktree.
function checkout({ worktree = false, name = "proj-x", binding } = {}) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "status-test-")), name);
  mkdirSync(root);
  if (worktree) writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
  else mkdirSync(path.join(root, ".git"));
  if (binding) writeFileSync(path.join(root, ".git", "alfred-project-code.json"), JSON.stringify({ code: binding }));
  return { root, file: path.join(root, ".clip", "session-status.json") };
}

// The tests must see only the scratch files, even when run from a hooked session.
const { SESSION_STATUS_FILE, CLAIMS_PROJECT_FILE, ...cleanEnv } = process.env;
delete process.env.SESSION_STATUS_FILE;
delete process.env.CLAIMS_PROJECT_FILE;

test("worktree project is the folder name", () => {
  const { root, file } = checkout({ worktree: true, name: "switchboard-k7w" });
  const r = writeSessionStatus(root, "processing", { sessionId: "s1" });
  assert.equal(r.project, "switchboard-k7w");
  assert.equal(r.session_id, "s1");
  assert.deepEqual(readStatus(file), r);
});

test("main project: binding, then last write, then main", () => {
  const bound = checkout({ binding: "rem-j7p" });
  assert.equal(writeSessionStatus(bound.root, "processing").project, "rem-j7p");

  const unbound = checkout();
  assert.equal(writeSessionStatus(unbound.root, "processing").project, "main");
  writeFileSync(unbound.file, JSON.stringify({ state: "waiting", project: "parallel_threads" }));
  assert.equal(writeSessionStatus(unbound.root, "processing").project, "parallel_threads");
});

test("red latches until processing", () => {
  const { root } = checkout();
  assert.equal(writeSessionStatus(root, "approval").red, true);
  assert.equal(writeSessionStatus(root, "waiting").red, true);
  assert.equal(writeSessionStatus(root, "processing").red, false);
  assert.equal(writeSessionStatus(root, "blocked").red, true);
});

test("since holds while the state holds; session_id carries over", () => {
  const { root } = checkout();
  const first = writeSessionStatus(root, "waiting", { sessionId: "abc" });
  const again = writeSessionStatus(root, "waiting");
  assert.equal(again.since, first.since);
  assert.equal(again.session_id, "abc");
});

test("run_tag is set by a tagged write and carried over", () => {
  const { root, file } = checkout({ worktree: true, name: "k7w" });
  assert.equal(writeSessionStatus(root, "processing").run_tag, null);
  assert.equal(writeSessionStatus(root, "processing", { runTag: "k7w-s2-ab12" }).run_tag, "k7w-s2-ab12");
  assert.equal(writeSessionStatus(root, "waiting").run_tag, "k7w-s2-ab12");
  runHook(JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt" }), root);
  assert.equal(readStatus(file).run_tag, "k7w-s2-ab12");
  assert.equal(writeSessionStatus(root, "processing", { runTag: "k7w-s3-cd34" }).run_tag, "k7w-s3-cd34");
});

test("atomic write leaves no temp file", () => {
  const { root, file } = checkout();
  writeSessionStatus(root, "processing");
  assert.deepEqual(readdirSync(path.dirname(file)), ["session-status.json"]);
});

test("onlyIf skips the write", () => {
  const { root, file } = checkout();
  writeSessionStatus(root, "waiting");
  assert.equal(writeSessionStatus(root, "processing", { onlyIf: (p) => p?.state === "approval" }), null);
  assert.equal(readStatus(file).state, "waiting");
});

test("a failed write returns null, never throws", () => {
  const { root, file } = checkout();
  mkdirSync(file, { recursive: true }); // the target is a folder
  assert.equal(writeSessionStatus(root, "processing"), null);
  assert.equal(writeSessionStatus(root, "nonsense"), null);
});

function runHook(input, root) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    env: { ...cleanEnv, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
}

test("Stop hook writes waiting, silently", () => {
  const { root, file } = checkout({ worktree: true, name: "k7w" });
  const run = runHook(JSON.stringify({ hook_event_name: "Stop", session_id: "sid-1" }), root);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
  assert.equal(readStatus(file).state, "waiting");
  assert.equal(readStatus(file).session_id, "sid-1");
});

test("notification mapping", () => {
  for (const t of APPROVAL_TYPES) assert.equal(stateForNotification({ notification_type: t }), "approval");
  assert.equal(stateForNotification({ notification_type: "idle_prompt" }), "waiting");
  assert.equal(stateForNotification({ notification_type: "auth_success", message: "permission" }), null);
  assert.equal(stateForNotification({ message: "Claude needs your permission to use Bash" }), "approval");
  assert.equal(stateForNotification({ message: "Claude is waiting for your input" }), "waiting");
  assert.equal(stateForNotification({ message: "hello" }), null);
});

test("Notification hook: approval sets red, idle writes waiting, other writes nothing", () => {
  const { root, file } = checkout({ worktree: true, name: "k7w" });
  const note = (type) => runHook(JSON.stringify({ hook_event_name: "Notification", notification_type: type }), root);
  assert.equal(note("auth_success").status, 0);
  assert.equal(readStatus(file), null);
  note("permission_prompt");
  assert.equal(readStatus(file).state, "approval");
  assert.equal(readStatus(file).red, true);
  note("idle_prompt");
  assert.equal(readStatus(file).state, "waiting");
  assert.equal(readStatus(file).red, true);
});

test("PostToolUse clears approval only", () => {
  const { root, file } = checkout({ worktree: true, name: "k7w" });
  const post = () => runHook(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "p" }), root);
  post();
  assert.equal(readStatus(file), null);
  writeSessionStatus(root, "approval");
  assert.equal(post().stdout, "");
  assert.equal(readStatus(file).state, "processing");
  assert.equal(readStatus(file).red, false);
  writeSessionStatus(root, "waiting");
  post();
  assert.equal(readStatus(file).state, "waiting");
});

test("transcript_path is recorded, and carried over when the input lacks it", () => {
  const { root, file } = checkout({ worktree: true, name: "k7w" });
  runHook(JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt", transcript_path: "C:\\t\\a.jsonl" }), root);
  assert.equal(readStatus(file).transcript_path, "C:\\t\\a.jsonl");
  runHook(JSON.stringify({ hook_event_name: "Stop" }), root);
  assert.equal(readStatus(file).transcript_path, "C:\\t\\a.jsonl");
  assert.equal(writeSessionStatus(root, "processing", { transcriptPath: "C:\\t\\b.jsonl" }).transcript_path, "C:\\t\\b.jsonl");
});

test("hook exits 0 on garbage or an unwritable file", () => {
  const { root, file } = checkout();
  assert.equal(runHook("not json", root).status, 0);
  mkdirSync(file, { recursive: true });
  assert.equal(runHook(JSON.stringify({ hook_event_name: "Stop" }), root).status, 0);
});
