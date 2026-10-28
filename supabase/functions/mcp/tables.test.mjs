// Every defineTool declares the tables it reads and writes, as literal arrays naming
// tables or views in supabase/schema-snapshot.sql (Overwatch spec 5.6). "*" only in reads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDefineTools, snapshotObjects, tableProblems, toolSourceFiles } from "../../../scripts/lib/inventory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OBJECTS = snapshotObjects(fs.readFileSync(path.join(ROOT, "supabase/schema-snapshot.sql"), "utf8"));

test("every defineTool declares real tables", () => {
  const files = toolSourceFiles(ROOT);
  assert.ok(files.length > 0, "no tool files found");
  let tools = 0;
  const problems = [];
  for (const f of files) {
    const parsed = parseDefineTools(fs.readFileSync(path.join(ROOT, f), "utf8"));
    tools += parsed.length;
    problems.push(...tableProblems(parsed, OBJECTS, f));
  }
  assert.deepEqual(problems, [], `${problems.length} tool(s) with bad tables:\n${problems.join("\n")}`);
  assert.ok(tools >= 171, `only ${tools} defineTool calls found`);
});
