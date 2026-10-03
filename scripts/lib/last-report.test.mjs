import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCheckoutReport, writeLastReport } from "./last-report.mjs";

const scratch = () => mkdtempSync(path.join(tmpdir(), "last-report-"));

test("writes tag, title and time atomically", () => {
  const root = scratch();
  const at = new Date("2026-10-02T09:30:00.000Z");
  const r = writeLastReport(root, { runTag: "proj-x-s3-ab12", title: "t", pushedAt: at });
  assert.deepEqual(r, { run_tag: "proj-x-s3-ab12", title: "t", pushed_at: "2026-10-02T09:30:00.000Z" });
  const file = path.join(root, ".clip", "last-report.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), r);
  assert.deepEqual(readdirSync(path.dirname(file)), ["last-report.json"]);
});

test("untagged push records null", () => {
  assert.equal(writeLastReport(scratch(), {}).run_tag, null);
});

test("a failed write returns null", () => {
  const root = scratch();
  mkdirSync(path.join(root, ".clip", "last-report.json"), { recursive: true });
  assert.equal(writeLastReport(root, { runTag: "a-s1-ab12" }), null);
});

test("only the checkout's own last-report.md counts", () => {
  const root = scratch();
  assert.equal(isCheckoutReport(root, path.join(root, ".clip", "last-report.md")), true);
  assert.equal(isCheckoutReport(root, path.join(root, ".clip", "LAST-REPORT.md")), true);
  assert.equal(isCheckoutReport(root, path.join(root, "notes.md")), false);
  assert.equal(isCheckoutReport(root, null), false);
});
