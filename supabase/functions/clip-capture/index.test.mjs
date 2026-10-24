// clip-capture writes run_tag, repo and branch onto the clips row (Overwatch Step 4).
// Reads the source, as mcp/index.test.mjs does, since the function only runs under Deno.
// Run: node --test supabase/functions/clip-capture/index.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "index.ts"), "utf-8");
const MIGRATIONS = join(HERE, "..", "..", "migrations");
const TAG_PATTERN = "^[a-z0-9_-]{1,40}$";

test("the clips insert carries run_tag, repo and branch", () => {
  const m = SRC.match(/\.from\("clips"\)\s*\.insert\(\{([\s\S]*?)\}\)\s*\.select/);
  assert.ok(m, "clips insert not found");
  assert.match(m[1], /run_tag: runTag,/);
  assert.match(m[1], /^\s*repo,$/m);
  assert.match(m[1], /^\s*branch,$/m);
});

test("the inbox row still carries them for get_recent_clips", () => {
  assert.ok(SRC.includes("...(runTag ? { run_tag: runTag } : {})"));
  assert.ok(SRC.includes("...(repo ? { repo } : {})"));
  assert.ok(SRC.includes("...(branch ? { branch } : {})"));
});

test("function and migration use the same run tag pattern", () => {
  assert.ok(SRC.includes(`/${TAG_PATTERN}/.test(body.run_tag`), "function pattern changed");
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith("clips_run_tag.sql"));
  assert.ok(file, "clips run_tag migration not found");
  const sql = readFileSync(join(MIGRATIONS, file), "utf-8");
  assert.ok(sql.includes(`run_tag ~ '${TAG_PATTERN}'`), "migration check differs");
});
