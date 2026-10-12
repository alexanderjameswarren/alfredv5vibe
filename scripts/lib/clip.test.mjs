// clip.mjs against a local stand-in for clip-capture: what it sends, and how it
// fails. Nothing here reaches the real function.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeFailure } from "../clip.mjs";

const CLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "clip.mjs");
const REPORT = "Run exactly: bash -c \"echo x > docs/a.md\" && node -e \"require('fs')\"\n";

/** A server answering each POST with the next of `replies`, recording what came in. */
async function stub(replies) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(JSON.parse(raw));
      const [status, body, type = "application/json"] = replies[Math.min(seen.length, replies.length) - 1];
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // Keep-alive sockets would hold the test process open after close().
  const close = (cb) => {
    server.closeAllConnections();
    server.close(cb);
  };
  return { url: `http://127.0.0.1:${server.address().port}/clip-capture`, seen, close };
}

/** Run clip.mjs on a scratch report, outside any repo. */
function push(url, extra = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "clip-test-"));
  const file = path.join(dir, "report.md");
  writeFileSync(file, REPORT);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIP, "--title", "cp and rm (test)", file, ...extra], {
      cwd: dir,
      env: { ...process.env, CLIPBOARD_URL: url, CLIPBOARD_SECRET: "s".repeat(40) },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const OK = [200, { ok: true, clip_id: "c1", inbox_id: "i1", run_tag: null }];

test("the title and report go base64-encoded, never as plain text", async () => {
  const s = await stub([OK]);
  const r = await push(s.url);
  s.close();
  assert.equal(r.code, 0, r.err);
  const sent = s.seen[0];
  assert.equal(sent.page_text, undefined);
  assert.equal(sent.title, undefined);
  assert.equal(Buffer.from(sent.page_text_b64, "base64").toString("utf8"), REPORT);
  assert.equal(Buffer.from(sent.title_b64, "base64").toString("utf8"), "cp and rm (test)");
  assert.doesNotMatch(JSON.stringify(sent), /bash -c|require\(/);
});

test("an HTML 403 from a firewall fails with a plain line, exit 1, no crash", async () => {
  const page = "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>";
  const s = await stub([[403, page, "text/html"]]);
  const r = await push(s.url);
  s.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /\/finish failed \(403\): the answer was an HTML page \("Attention Required! \| Cloudflare"\)/);
  assert.doesNotMatch(r.err, /<!DOCTYPE|Assertion failed/);
});

test("an unreachable server fails cleanly", async () => {
  const s = await stub([OK]);
  const url = s.url;
  await new Promise((r) => s.close(r));
  const r = await push(url);
  assert.equal(r.code, 1);
  assert.match(r.err, /could not reach .*\/finish/);
  assert.doesNotMatch(r.err, /Assertion failed/);
});

test("an older clip-capture: says to deploy, then sends it plain once", async () => {
  const s = await stub([[400, { ok: false, error: "page_text must be a string (it may be empty, but not absent)." }], OK]);
  const r = await push(s.url);
  s.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /npx supabase functions deploy clip-capture/);
  assert.equal(s.seen.length, 2);
  assert.equal(s.seen[1].page_text, REPORT);
});

test("describeFailure: JSON error, HTML title, or the start of the text", () => {
  assert.equal(describeFailure(500, "{}", { error: "boom" }), "/finish failed (500): boom");
  assert.match(describeFailure(403, "<html><title>Nope</title>", null), /HTML page \("Nope"\)/);
  assert.equal(describeFailure(502, "", null), "/finish failed (502): empty response");
});
