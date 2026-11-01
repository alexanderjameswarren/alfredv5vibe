// sql-queue: settings, the request it sends, and what it prints. Nothing here reaches the real function.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeResult, queueFile, readQueueSettings } from "./sql-queue.mjs";

const SECRET = "s".repeat(40);
const SETTINGS = { url: "https://x/functions/v1/switchboard-runner/queue", secret: SECRET };
const sqlFile = (text = "select 1;\n", name = "a.sql") => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "sqlq-")), name);
  writeFileSync(file, text);
  return file;
};
const answering = (status, body) => {
  const calls = [];
  const fetchFn = async (url, init) => (calls.push({ url, init }), { status, json: async () => body });
  return { fetchFn, calls };
};

test("settings: environment, then registry; the URL follows the clipboard's", () => {
  const reg = { SWITCHBOARD_QUEUE_SECRET: "r".repeat(40), CLIPBOARD_URL: "https://reg/functions/v1/clip-capture" };
  assert.deepEqual(readQueueSettings({}, (n) => reg[n]), { url: "https://reg/functions/v1/switchboard-runner/queue", secret: "r".repeat(40) });
  assert.equal(readQueueSettings({ SWITCHBOARD_QUEUE_SECRET: SECRET }, () => null).secret, SECRET);
  assert.equal(readQueueSettings({ SWITCHBOARD_QUEUE_URL: "https://own/q" }, () => null).url, "https://own/q");
  assert.equal(readQueueSettings({ SWITCHBOARD_QUEUE_SECRET: "short" }, () => null).secret, "");
});

test("queue: sends the file's SQL and the project, with the key in a header", async () => {
  const { fetchFn, calls } = answering(200, { ok: true, action_id: "a1", headline: "H" });
  const out = await queueFile({ file: sqlFile("select 1;\n"), project: "p-x", description: " Reads 1. " }, SETTINGS, fetchFn);
  assert.deepEqual(out, { ok: true, action_id: "a1", headline: "H" });
  assert.equal(calls[0].url, SETTINGS.url);
  assert.equal(calls[0].init.headers["x-switchboard-queue-secret"], SECRET);
  assert.deepEqual(JSON.parse(calls[0].init.body), { project_code: "p-x", sql: "select 1;\n", description: "Reads 1." });
});

test("queue: refuses before any request", async () => {
  const { fetchFn, calls } = answering(200, {});
  const description = "Reads 1.";
  const cases = [
    [{ file: sqlFile(), project: "p-x", description }, { ...SETTINGS, secret: "" }, /SWITCHBOARD_QUEUE_SECRET/],
    [{ file: sqlFile(), project: "p-x", description }, { ...SETTINGS, url: "" }, /URL/],
    [{ file: sqlFile("x", "a.txt"), project: "p-x", description }, SETTINGS, /\.sql/],
    [{ file: sqlFile("  \n"), project: "p-x", description }, SETTINGS, /empty/],
    [{ file: "missing.sql", project: "p-x", description }, SETTINGS, /cannot read/],
    [{ file: sqlFile(), project: "main", description }, SETTINGS, /--project/],
    [{ file: sqlFile(), project: "p-x" }, SETTINGS, /--describe/],
    [{ file: sqlFile(), project: "p-x", description: "   " }, SETTINGS, /--describe/],
    [{ file: sqlFile(), project: "p-x", description: "two\nlines" }, SETTINGS, /--describe/],
    [{ file: sqlFile(), project: "p-x", description: "x".repeat(301) }, SETTINGS, /--describe/],
  ];
  for (const [args, settings, re] of cases) {
    const out = await queueFile(args, settings, fetchFn);
    assert.equal(out.ok, false);
    assert.match(out.error, re);
  }
  assert.equal(calls.length, 0);
});

test("queue: a refusal or network failure never carries the secret", async () => {
  const refused = answering(422, { ok: false, error: "goes to the SQL editor", reasons: ["vacuum"] });
  const out = await queueFile({ file: sqlFile(), project: "p-x", description: "Reads 1." }, SETTINGS, refused.fetchFn);
  assert.equal(out.ok, false);
  assert.deepEqual(out.reasons, ["vacuum"]);
  const broken = await queueFile({ file: sqlFile(), project: "p-x", description: "Reads 1." }, SETTINGS, async () => { throw new Error(`fail ${SECRET}`); });
  assert.equal(broken.ok, false);
  assert.ok(!JSON.stringify(broken).includes(SECRET));
});

test("the command exits 0 when queued and 1 when refused, cleanly, and never prints the key", async () => {
  let answer = { ok: true, action_id: "a1", headline: "H" };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const script = path.resolve(import.meta.dirname, "..", "sql-queue.mjs");
  const run = (extra = ["--describe", "Reads 1."]) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, sqlFile(), "--project", "p-x", ...extra], {
      env: { ...process.env, SWITCHBOARD_QUEUE_SECRET: SECRET, SWITCHBOARD_QUEUE_URL: `http://127.0.0.1:${server.address().port}/q` },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
  try {
    const queued = await run();
    assert.equal(queued.code, 0, queued.out);
    assert.match(queued.out, /a1/);
    assert.doesNotMatch(queued.out, /Assertion failed/);
    assert.ok(!queued.out.includes(SECRET));
    answer = { ok: false, error: "nope" };
    const refused = await run();
    assert.equal(refused.code, 1, refused.out);
    assert.doesNotMatch(refused.out, /Assertion failed/);
    answer = { ok: true, action_id: "a2", headline: "H" };
    const undescribed = await run([]);
    assert.equal(undescribed.code, 1, undescribed.out);
    assert.match(undescribed.out, /--describe/);
  } finally {
    server.close();
  }
});

test("print: id and headline, or the refusal; never the secret", () => {
  const ok = describeResult({ ok: true, action_id: "a1", headline: "H" });
  assert.match(ok, /a1/);
  assert.match(ok, /H/);
  const no = describeResult({ ok: false, error: "nope", reasons: ["vacuum t"] });
  assert.match(no, /nope/);
  assert.match(no, /vacuum t/);
});
