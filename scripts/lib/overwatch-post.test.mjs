// Overwatch Step 7: block events into the outbox, and the sender that drains it. No network: fetch is faked.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { blockEvents, queueBlockEvents, recordBlocks, resolveRepo } from "./claims-core.mjs";
import {
  OUTBOX_CAP,
  kickSender,
  readLines,
  readSettings,
  sendGroups,
  sendOutbox,
  sendingFile,
  senderLock,
  senderLog,
  takeSenderLock,
} from "./overwatch-post.mjs";

const T0 = "2026-10-24T10:00:00.000Z";
const T1 = "2026-10-24T10:01:00.000Z";
const NOW = new Date("2026-10-24T10:05:00.000Z");
const rec = (o = {}) => ({
  waiter: "wtA", waiter_code: "wta-x1y", item: "src/a.js", holder: "wtB", holder_code: "wtb-z9q",
  holder_item: "src/", via: "guard", run_tag: null, blocked_at: T0, last_seen: T0, ...o,
});

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "overwatch-post-"));
  const file = path.join(dir, "alfred-claims.json");
  writeFileSync(file, JSON.stringify({ claims: [{ item: "src/", owner: "wtB", claimed_at: T0 }], reservations: [] }));
  return {
    dir,
    ctx: { dir, root: dir, file, blocksFile: path.join(dir, "blocks.json"), outboxFile: path.join(dir, "outbox.jsonl") },
  };
}
const events = (ctx) => readLines(ctx.outboxFile).map((l) => JSON.parse(l));
const noLock = (fn) => fn();

test("blockEvents: new, repeat, clear, and nothing for an unchanged record", () => {
  assert.deepEqual(blockEvents([], [rec()], NOW).map((e) => [e.event, e.at]), [["new", T0]]);
  assert.deepEqual(blockEvents([rec()], [rec({ last_seen: T1 })], NOW).map((e) => [e.event, e.at]), [["repeat", T1]]);
  assert.deepEqual(blockEvents([rec()], [], NOW).map((e) => [e.event, e.at]), [["clear", NOW.toISOString()]]);
  assert.deepEqual(blockEvents([rec()], [rec()], NOW), []);
  const [e] = blockEvents([], [rec({ run_tag: "wta-x1y-s2-ab12" })], NOW);
  assert.deepEqual(e, {
    event: "new", waiter_code: "wta-x1y", holder_code: "wtb-z9q", item: "src/a.js",
    run_tag: "wta-x1y-s2-ab12", blocked_at: T0, at: T0,
  });
});

test("recordBlocks queues new then repeat; a released holder queues a clear", () => {
  const { ctx } = scratch();
  const hits = [{ item: "src/a.js", holders: [{ owner: "wtB", item: "src/" }] }];
  const prev = process.env.OVERWATCH_SENDER;
  process.env.OVERWATCH_SENDER = "off";
  try {
    recordBlocks(ctx, { waiter: "wtA", hits, via: "check", now: new Date(T0) });
    recordBlocks(ctx, { waiter: "wtA", hits, via: "guard", now: new Date(T1) });
    writeFileSync(ctx.file, JSON.stringify({ claims: [], reservations: [] }));
    recordBlocks(ctx, { waiter: "wtA", hits: [], via: "check", now: NOW });
  } finally {
    if (prev === undefined) delete process.env.OVERWATCH_SENDER;
    else process.env.OVERWATCH_SENDER = prev;
  }
  assert.deepEqual(events(ctx).map((e) => [e.event, e.blocked_at, e.at]), [
    ["new", T0, T0],
    ["repeat", T0, T1],
    ["clear", T0, NOW.toISOString()],
  ]);
});

test("no outbox, nothing queued; a broken outbox path never throws", () => {
  const { ctx } = scratch();
  queueBlockEvents({ ...ctx, outboxFile: null }, [], [rec()]);
  assert.equal(existsSync(ctx.outboxFile), false);
  assert.doesNotThrow(() => queueBlockEvents({ ...ctx, outboxFile: path.join(ctx.dir, "no", "such", "x") }, [], [rec()]));
});

test("resolveRepo gives no outbox in a repo without the sender, or with CLAIMS_BLOCKS_FILE set", () => {
  const here = resolveRepo(process.cwd());
  assert.ok(here.outboxFile?.endsWith("alfred-overwatch-outbox.jsonl"));
  const prev = process.env.CLAIMS_BLOCKS_FILE;
  process.env.CLAIMS_BLOCKS_FILE = path.join(tmpdir(), "x.json");
  try {
    assert.equal(resolveRepo(process.cwd()).outboxFile, null);
  } finally {
    if (prev === undefined) delete process.env.CLAIMS_BLOCKS_FILE;
    else process.env.CLAIMS_BLOCKS_FILE = prev;
  }
});

test("kickSender: off switch, a fresh sender lock, and the detached spawn", () => {
  const { ctx } = scratch();
  const calls = [];
  const spawnImpl = (cmd, args, opts) => (calls.push({ args, opts }), { unref() {} });
  assert.equal(kickSender(ctx, { env: { OVERWATCH_SENDER: "off" }, spawnImpl }), false);
  assert.equal(kickSender(ctx, { env: {}, spawnImpl }), true);
  assert.ok(calls[0].args[0].endsWith(path.join("scripts", "overwatch-post.mjs")));
  assert.equal(calls[0].opts.detached, true);
  writeFileSync(senderLock(ctx.outboxFile), "1");
  assert.equal(kickSender(ctx, { env: {}, spawnImpl }), false);
  assert.equal(kickSender(ctx, { env: {}, spawnImpl: () => { throw new Error("no node"); } }), false);
});

test("takeSenderLock: one at a time, a stale lock taken over", () => {
  const { ctx } = scratch();
  const release = takeSenderLock(ctx.outboxFile);
  assert.ok(release);
  assert.equal(takeSenderLock(ctx.outboxFile), null);
  assert.ok(takeSenderLock(ctx.outboxFile, Date.now() + 10 * 60_000), "stale");
  release();
});

function fakeFetch(answers) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    const a = answers.shift() ?? { status: 200, body: { ok: true, inserted: 1, updated: 0, unchanged: 0, rejected: [] } };
    if (a.throws) throw new Error(a.throws);
    return { status: a.status, json: async () => a.body };
  };
  return { impl, seen };
}
const settings = { url: "https://example.invalid/overwatch-ingest", secret: "s".repeat(40) };
const fill = (ctx, n) =>
  writeFileSync(ctx.outboxFile, Array.from({ length: n }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");

test("sendOutbox: a good send empties the outbox; rejected events are logged and dropped", async () => {
  const { ctx } = scratch();
  fill(ctx, 3);
  const f = fakeFetch([{ status: 200, body: { ok: true, inserted: 2, updated: 0, unchanged: 0, rejected: [{ index: 1, error: "bad" }] } }]);
  const s = await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings, fetchImpl: f.impl });
  assert.equal(f.seen[0].kind, "claim_block");
  assert.equal(f.seen[0].events.length, 3);
  assert.deepEqual([s.sent, s.inserted, s.dropped, s.kept], [3, 2, 1, 0]);
  assert.equal(existsSync(ctx.outboxFile), false);
  assert.equal(existsSync(sendingFile(ctx.outboxFile)), false);
  assert.match(readFileSync(senderLog(ctx.outboxFile), "utf8"), /rejected \{"i":1\}: bad/);
});

test("sendOutbox: batches of 200; a 500 keeps that batch and the rest", async () => {
  const { ctx } = scratch();
  fill(ctx, 450);
  const f = fakeFetch([{ status: 200, body: { ok: true, inserted: 200, rejected: [] } }, { status: 500, body: { ok: false, error: "db" } }]);
  const s = await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings, fetchImpl: f.impl });
  assert.deepEqual(f.seen.map((b) => b.events.length), [200, 200]);
  assert.deepEqual([s.sent, s.kept], [200, 250]);
  assert.equal(readLines(ctx.outboxFile).length, 250);
  assert.deepEqual(JSON.parse(readLines(ctx.outboxFile)[0]), { i: 200 });
});

test("sendOutbox: no network or no settings keeps everything; a 400 drops the batch", async () => {
  const { ctx } = scratch();
  fill(ctx, 2);
  await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings, fetchImpl: fakeFetch([{ throws: "offline" }]).impl });
  assert.equal(readLines(ctx.outboxFile).length, 2);
  await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings: { url: "", secret: "" } });
  assert.equal(readLines(ctx.outboxFile).length, 2);
  const s = await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings, fetchImpl: fakeFetch([{ status: 400, body: { error: "bad body" } }]).impl });
  assert.deepEqual([s.dropped, s.kept], [2, 0]);
  assert.equal(existsSync(ctx.outboxFile), false);
});

test("sendGroups: block events batch; an inventory or summary goes alone, in order", () => {
  const inv = { _kind: "inventory", parts: [{ kind: "tool", name: "x" }], open_work: [] };
  const g = sendGroups([{ i: 0 }, { i: 1 }, inv, { i: 2 }, { _kind: "finish_summary", summary: { merge_commit: "abc1234" } }]);
  assert.deepEqual(g.map((x) => [x.body.kind, x.items.length]),
    [["claim_block", 2], ["inventory", 1], ["claim_block", 1], ["finish_summary", 1]]);
  assert.deepEqual(g[1].body, { kind: "inventory", parts: [{ kind: "tool", name: "x" }], open_work: [] });
});

test("sendOutbox: an inventory is posted whole; a 500 on it keeps it and what follows", async () => {
  const { ctx } = scratch();
  writeFileSync(ctx.outboxFile, [{ i: 0 }, { _kind: "inventory", parts: [{ kind: "tool", name: "x" }], open_work: [] }, { i: 1 }]
    .map((e) => JSON.stringify(e)).join("\n") + "\n");
  const f = fakeFetch([{ status: 200, body: { ok: true, inserted: 1, rejected: [] } }, { status: 500, body: { ok: false, error: "db" } }]);
  const s = await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings, fetchImpl: f.impl });
  assert.deepEqual(f.seen.map((b) => b.kind), ["claim_block", "inventory"]);
  assert.deepEqual([s.sent, s.kept], [1, 2]);
  assert.equal(JSON.parse(readLines(ctx.outboxFile)[0])._kind, "inventory");
  const again = await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings,
    fetchImpl: fakeFetch([{ status: 200, body: { ok: true, parts: 1, open_work: 0 } }, { status: 200, body: { ok: true, inserted: 1, rejected: [] } }]).impl });
  assert.deepEqual([again.sent, again.kept], [2, 0]);
  assert.match(readFileSync(senderLog(ctx.outboxFile), "utf8"), /inventory sent: \{"parts":1,"open_work":0\}/);
});

test("sendOutbox: a leftover .sending file goes first, and the outbox is capped", async () => {
  const { ctx } = scratch();
  writeFileSync(sendingFile(ctx.outboxFile), `${JSON.stringify({ i: "left" })}\n`);
  fill(ctx, 1);
  const f = fakeFetch([]);
  await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings, fetchImpl: f.impl });
  assert.deepEqual(f.seen[0].events, [{ i: "left" }, { i: 0 }]);

  fill(ctx, OUTBOX_CAP + 5);
  const s = await sendOutbox({ outbox: ctx.outboxFile, withLock: noLock, settings: { url: "", secret: "" } });
  assert.equal(readLines(ctx.outboxFile).length, OUTBOX_CAP);
  assert.equal(s.dropped, 5);
});

test("readSettings: environment first, then the registry; a short secret counts as unset", () => {
  const reg = { OVERWATCH_INGEST_URL: "https://reg", OVERWATCH_INGEST_SECRET: "r".repeat(40) };
  assert.deepEqual(readSettings({}, (n) => reg[n]), { url: "https://reg", secret: "r".repeat(40) });
  assert.equal(readSettings({ OVERWATCH_INGEST_URL: "https://env" }, (n) => reg[n]).url, "https://env");
  assert.equal(readSettings({ OVERWATCH_INGEST_SECRET: "short" }, () => null).secret, "");
});
