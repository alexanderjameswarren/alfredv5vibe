// archive_inbox_item handler tests, against a mocked ctx.db (no live database).
//
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/clipboard.test.mjs
//
// Like dj-courier.test.mjs, this reads the real clipboard.ts and apps.ts, swaps the
// imports that cannot resolve under Node for stubs, and imports the result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUBS = [
  "const clampLimit = (n: number | undefined) => Math.min(n ?? 20, 50);",
  "const envelope = (data: any, meta: any = {}) => ({ data, meta });",
  "type Context = any;",
  "const defineTool = (o: any) => o;",
  // get_apps reads through readTable; this file tests archive_inbox_item only (apps.test.mjs covers get_apps).
  "const readTable = () => { throw new Error('readTable is not stubbed in clipboard.test.mjs'); };",
].join("\n");

function probe(file, extra = []) {
  let src = readFileSync(join(HERE, file), "utf-8");
  for (const line of [
    'import { clampLimit, defineTool, envelope, type Context } from "../platform.ts";',
    'import { clampLimit, defineTool, envelope } from "../platform.ts";',
    'import { defineTool, readTable } from "../platform.ts";',
  ]) src = src.replace(line, STUBS);
  for (const [from, to] of extra) src = src.replace(from, to);
  if (src.includes("../platform.ts") || src.includes("jsr:")) {
    throw new Error(`${file} import lines changed — update the stubs in this test.`);
  }
  return src;
}

const dir = mkdtempSync(join(tmpdir(), "clipboard-"));
writeFileSync(join(dir, "apps.ts"), probe("apps.ts"));
writeFileSync(join(dir, "clipboard.probe.ts"), probe("clipboard.ts", [
  ['import { encodeBase64 } from "jsr:@std/encoding/base64";', "const encodeBase64 = (b: any) => '';"],
]));
const { archiveInboxItemTool: tool } = await import(pathToFileURL(join(dir, "clipboard.probe.ts")).href);

/** ctx.db: apps reads for checkSourceApp, and one rpc result. */
function makeDb(rpcResult) {
  const calls = [];
  return {
    calls,
    from: () => ({ select: () => ({ order: async () => ({ data: [{ id: "alfred" }, { id: "jobs" }], error: null }) }) }),
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return rpcResult;
    },
  };
}

const ROW = {
  id: "inbox-1", source_type: "manual", captured_text: "Apply", archived: true,
  triaged_at: "2026-10-19T00:00:00Z", archive_reason: "processed", source_app: "jobs",
  outcome: [{ table: "job_applications", id: "j1" }], linked_back: ["job_applications:j1"],
};

test("one rpc call with the tool's parameters, same result shape", async () => {
  const db = makeDb({ data: ROW, error: null });
  const out = await tool.handler(
    { inbox_id: "inbox-1", outcome: [{ table: "job_applications", id: "j1" }], source_app: "jobs" },
    { db },
  );
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].fn, "archive_inbox_item");
  assert.deepEqual(db.calls[0].args, {
    p_inbox_id: "inbox-1",
    p_args: { archived: true, reason: "processed", outcome: [{ table: "job_applications", id: "j1" }], source_app: "jobs" },
  });
  assert.deepEqual(out.linked_back, ["job_applications:j1"]);
  assert.match(out.result, /^Archived with reason 'processed'/);
});

test("leaves source_app out when not given", async () => {
  const db = makeDb({ data: { ...ROW, linked_back: [] }, error: null });
  await tool.handler({ inbox_id: "inbox-1", reason: "discarded" }, { db });
  assert.deepEqual(db.calls[0].args.p_args, { archived: true, reason: "discarded" });
});

test("un-archive says so", async () => {
  const db = makeDb({ data: { ...ROW, archived: false, linked_back: [] }, error: null });
  const out = await tool.handler({ inbox_id: "inbox-1", archived: false }, { db });
  assert.match(out.result, /^Un-archived/);
});

test("not yours or not there: the same message as before", async () => {
  const db = makeDb({ data: null, error: { code: "P0002", message: "archive_inbox_item: no inbox item x" } });
  await assert.rejects(
    tool.handler({ inbox_id: "inbox-1" }, { db }),
    { message: "archive_inbox_item: no inbox item inbox-1 that you can write to — it may not be yours. Nothing was changed." },
  );
});

test("a database refusal is passed on once-prefixed", async () => {
  const db = makeDb({ data: null, error: { code: "22023", message: "archive_inbox_item: job_applications id x is not a uuid. Nothing was changed." } });
  await assert.rejects(
    tool.handler({ inbox_id: "inbox-1", outcome: [{ table: "job_applications", id: "x" }] }, { db }),
    { message: "archive_inbox_item: job_applications id x is not a uuid. Nothing was changed." },
  );
  const other = makeDb({ data: null, error: { message: "timeout" } });
  await assert.rejects(tool.handler({ inbox_id: "inbox-1" }, { db: other }), { message: "archive_inbox_item: timeout" });
});

test("bad parameters are refused before any call", async () => {
  const db = makeDb({ data: ROW, error: null });
  await assert.rejects(tool.handler({ inbox_id: "inbox-1", reason: "spam" }, { db }), /reason must be/);
  await assert.rejects(tool.handler({ inbox_id: "inbox-1", archived: false, outcome: [{ table: "items", id: "i" }] }, { db }), /cannot go with archived: false/);
  await assert.rejects(tool.handler({ inbox_id: "inbox-1", source_app: "nope" }, { db }), /unknown source_app/);
  assert.equal(db.calls.length, 0);
});
