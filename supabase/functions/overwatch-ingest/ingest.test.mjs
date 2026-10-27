// overwatch-ingest: the pure event logic, plus source checks on index.ts (it only runs under Deno).
// Run: node --experimental-strip-types --test supabase/functions/overwatch-ingest/ingest.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isRefusal, parseBody, parseEvent, plan, MAX_EVENTS, MAX_PARTS } from "./ingest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const T0 = "2026-10-24T10:00:00.000Z";
const T1 = "2026-10-24T10:05:00.000Z";
const T2 = "2026-10-24T10:09:00.000Z";
const ev = (o = {}) => ({
  event: "new", waiter_code: "sam_glance-p7k", holder_code: "overwatch-q4n",
  item: "scripts/claims.mjs", run_tag: "sam_glance-p7k-s3-ab12", blocked_at: T0, at: T0, ...o,
});
const row = (o = {}) => ({
  waiter_code: "sam_glance-p7k", holder_code: "overwatch-q4n", item: "scripts/claims.mjs",
  run_tag: "sam_glance-p7k-s3-ab12", blocked_at: "2026-10-24T10:00:00+00:00",
  last_seen_at: "2026-10-24T10:00:00+00:00", repeat_count: 0, cleared_at: null, ...o,
});
const parsed = (o) => {
  const r = parseEvent(ev(o));
  assert.ok(r.ok, r.error);
  return r.event;
};

test("a good event parses, timestamps normalised", () => {
  const e = parsed({ blocked_at: "2026-10-24T03:00:00-07:00", at: "2026-10-24T03:00:00-07:00" });
  assert.equal(e.blocked_at, T0);
  assert.equal(e.item, "scripts/claims.mjs");
});

test("bad events are refused with a reason", () => {
  const bad = [
    [{ event: "open" }, /event must be one of/],
    [{ waiter_code: "Bad Code" }, /waiter_code must match/],
    [{ holder_code: "sam_glance-p7k" }, /are the same/],
    [{ item: "" }, /item must be/],
    [{ run_tag: "Not A Tag" }, /run_tag must match/],
    [{ blocked_at: "yesterday" }, /blocked_at must be a timestamp/],
    [{ at: "2026-10-24T09:00:00Z" }, /at is before blocked_at/],
  ];
  for (const [o, re] of bad) {
    const r = parseEvent(ev(o));
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(r.error, re);
  }
  assert.equal(parseEvent(ev({ run_tag: null })).ok, true);
});

test("the body takes claim_block only, and a bad event does not sink the batch", () => {
  assert.match(parseBody({ kind: "bogus", events: [ev()] }).error, /accepts claim_block, inventory, finish_summary/);
  assert.match(parseBody({ kind: "claim_block", events: [] }).error, /non-empty/);
  assert.match(parseBody({ kind: "claim_block", events: Array(MAX_EVENTS + 1).fill(ev()) }).error, /at most/);
  const r = parseBody({ kind: "claim_block", events: [ev(), ev({ event: "nope" }), ev({ event: "clear", at: T1 })] });
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.rejected.map((x) => x.index), [1]);
});

test("new inserts an episode; a resent new changes nothing", () => {
  const p = plan(null, parsed());
  assert.equal(p.op, "insert");
  assert.equal(p.row.repeat_count, 0);
  assert.equal(p.row.cleared_at, null);
  assert.deepEqual(plan(row(), parsed()), { op: "none" });
});

test("repeat bumps the count and last_seen_at, never backwards", () => {
  assert.deepEqual(plan(row(), parsed({ event: "repeat", at: T1 })).patch, { repeat_count: 1, last_seen_at: T1 });
  const late = row({ last_seen_at: "2026-10-24T10:09:00+00:00", repeat_count: 4 });
  assert.deepEqual(plan(late, parsed({ event: "repeat", at: T1 })).patch, { repeat_count: 5 });
  assert.equal(plan(null, parsed({ event: "repeat", at: T1 })).row.repeat_count, 1);
});

test("clear stamps cleared_at once", () => {
  assert.deepEqual(plan(row(), parsed({ event: "clear", at: T2 })).patch, { cleared_at: T2, last_seen_at: T2 });
  assert.deepEqual(plan(row({ cleared_at: T1 }), parsed({ event: "clear", at: T2 })), { op: "none" });
  const p = plan(null, parsed({ event: "clear", at: T2 }));
  assert.equal(p.row.cleared_at, T2);
});

test("a run tag learned later fills an empty one", () => {
  assert.deepEqual(plan(row({ run_tag: null }), parsed()).patch, { run_tag: "sam_glance-p7k-s3-ab12" });
});

test("index.ts checks the secret before reading the body, and scopes every insert", () => {
  const src = readFileSync(join(HERE, "index.ts"), "utf-8");
  const secretAt = src.indexOf('secretMatches(req.headers.get("x-overwatch-secret")');
  assert.ok(secretAt > 0);
  assert.ok(secretAt < src.indexOf("await req.json()"));
  assert.match(src, /Deno\.env\.get\("OVERWATCH_INGEST_SECRET"\)/);
  assert.match(src, /expectedSecret\.length < 32/);
  assert.match(src, /\.insert\(\{ \.\.\.p\.row, user_id: userId \}\)/);
  assert.match(src, /\.eq\("user_id", userId\)/);
});

const part = (o = {}) => ({ kind: "tool", name: "get_items", reads: ["items"], writes: [], ...o });
const line = (o = {}) => ({ file: "docs/progress-x.md", line: 3, kind: "checkbox", text: "- [ ] x", ...o });

test("inventory: parts and open work taken whole", () => {
  const r = parseBody({ kind: "inventory", parts: [part()], open_work: [line()] });
  assert.equal(r.ok, true);
  assert.equal(r.kind, "inventory");
  assert.deepEqual([r.parts.length, r.open_work.length], [1, 1]);
  assert.equal(parseBody({ kind: "inventory", parts: [part()], open_work: [] }).ok, true);
});

test("inventory: refused whole when its shape is wrong", () => {
  assert.match(parseBody({ kind: "inventory", parts: [], open_work: [] }).error, /non-empty/);
  assert.match(parseBody({ kind: "inventory", parts: [part()] }).error, /open_work must be an array/);
  assert.match(parseBody({ kind: "inventory", parts: [part(), part({ name: 7 })], open_work: [] }).error, /parts\[1\]/);
  assert.match(parseBody({ kind: "inventory", parts: [part({ reads: "items" })], open_work: [] }).error, /parts\[0\]/);
  assert.match(parseBody({ kind: "inventory", parts: [part()], open_work: [line({ line: "3" })] }).error, /open_work\[0\]/);
  assert.match(parseBody({ kind: "inventory", parts: Array(MAX_PARTS + 1).fill(part()), open_work: [] }).error, /at most/);
});

const summary = (o = {}) => ({
  project_code: "overwatch-q4n", branch: "worktree-overwatch-q4n", merge_commit: "1303ffd",
  finished_at: T0, diff_stat: { files: 3 }, migrations: ["supabase/migrations/180_x.sql"], ...o,
});

test("finish_summary: one row, lists defaulted, no reviewed_at", () => {
  const r = parseBody({ kind: "finish_summary", summary: summary() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.row, {
    project_code: "overwatch-q4n", branch: "worktree-overwatch-q4n", merge_commit: "1303ffd", finished_at: T0,
    diff_stat: { files: 3 }, migrations: ["supabase/migrations/180_x.sql"], tools: [], skills: [], functions: [],
    task_prompts: [], paths: [],
  });
});

test("finish_summary: refused when a field is wrong", () => {
  assert.match(parseBody({ kind: "finish_summary" }).error, /summary must be an object/);
  assert.match(parseBody({ kind: "finish_summary", summary: summary({ project_code: "Bad Code" }) }).error, /project_code/);
  assert.match(parseBody({ kind: "finish_summary", summary: summary({ merge_commit: "main" }) }).error, /merge_commit/);
  assert.match(parseBody({ kind: "finish_summary", summary: summary({ finished_at: "soon" }) }).error, /finished_at/);
  assert.match(parseBody({ kind: "finish_summary", summary: summary({ tools: "get_items" }) }).error, /tools must be a list/);
});

test("database refusals answer 400, the rest 500", () => {
  assert.equal(isRefusal("23514"), true);
  assert.equal(isRefusal("22023"), true);
  assert.equal(isRefusal("08006"), false);
  assert.equal(isRefusal(undefined), false);
});

test("index.ts scopes the inventory and the summary to the fixed user", () => {
  const src = readFileSync(join(HERE, "index.ts"), "utf-8");
  assert.match(src, /p_user_id: userId/);
  assert.match(src, /\.upsert\(\{ \.\.\.parsed\.row, user_id: userId \}, \{ onConflict: "user_id,merge_commit" \}\)/);
});

test("config.toml declares verify_jwt = false for it", () => {
  const toml = readFileSync(join(HERE, "..", "..", "config.toml"), "utf-8");
  const block = toml.split(/^\[functions\./m).find((b) => b.startsWith("overwatch-ingest]"));
  assert.ok(block, "no [functions.overwatch-ingest] block");
  assert.match(block, /^verify_jwt = false$/m);
  assert.match(block, /entrypoint = "\.\/functions\/overwatch-ingest\/index\.ts"/);
});
