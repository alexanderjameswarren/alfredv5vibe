import test from "node:test";
import assert from "node:assert/strict";
import { parseDefineTools, snapshotObjects, tableProblems } from "./inventory.mjs";

const SNAPSHOT = [
  'CREATE TABLE IF NOT EXISTS "public"."items" (',
  'CREATE TABLE IF NOT EXISTS "platform"."registry" (',
  'CREATE OR REPLACE VIEW "public"."wb_true_cost" WITH ("security_invoker"=\'true\') AS',
].join("\n");
const OBJECTS = snapshotObjects(SNAPSHOT);

const tool = (props) => `export const t = defineTool({\n${props}\n  handler: async () => ({ x: "}" }),\n});\n`;
const problems = (src) => tableProblems(parseDefineTools(src), OBJECTS, "f.ts");

test("snapshot: public bare, platform qualified, views count", () => {
  assert.deepEqual([...OBJECTS].sort(), ["items", "platform.registry", "wb_true_cost"]);
});

test("reads name and tables, comments and tier between", () => {
  const src = tool(`  name: "get_x",\n  tier: 1,\n  // through an RPC\n  tables: {\n    reads: ["items", 'wb_true_cost'],\n    writes: [],\n  },`);
  const [t] = parseDefineTools(src);
  assert.equal(t.name, "get_x");
  assert.deepEqual(t.tables, { reads: ["items", "wb_true_cost"], writes: [] });
  assert.deepEqual(problems(src), []);
});

test("several calls, each with its line", () => {
  const src = tool('  name: "a",\n  tables: { reads: ["items"], writes: [] },') + tool('  name: "b",\n  tables: { reads: [], writes: ["items"] },');
  assert.deepEqual(parseDefineTools(src).map((t) => [t.name, t.line]), [["a", 1], ["b", 6]]);
});

test("missing tables", () => {
  assert.match(problems(tool('  name: "get_x",\n  tier: 1,'))[0], /get_x: no tables before the handler/);
});

test("tables after the handler counts as missing", () => {
  const src = 'defineTool({ name: "x", handler: async () => 1, tables: { reads: [], writes: [] } });';
  assert.match(problems(src)[0], /no tables before the handler/);
});

test("non-literal arrays and missing keys", () => {
  assert.match(problems(tool('  name: "x",\n  tables: { reads: READS, writes: [] },'))[0], /tables.reads is not a literal array/);
  assert.match(problems(tool('  name: "x",\n  tables: { reads: [name], writes: [] },'))[0], /not a literal array/);
  assert.match(problems(tool('  name: "x",\n  tables: TABLES,'))[0], /not an object literal/);
  assert.match(problems(tool('  name: "x",\n  tables: { reads: [] },'))[0], /tables.writes is missing/);
});

test("unknown table names", () => {
  const out = problems(tool('  name: "x",\n  tables: { reads: ["made_up"], writes: ["registry"] },'));
  assert.equal(out.length, 2);
  assert.match(out[0], /reads made_up, which is not in the schema snapshot/);
  assert.match(out[1], /writes registry/); // platform names need their schema
});

test('"*" only in reads', () => {
  assert.deepEqual(problems(tool('  name: "get_records",\n  tables: { reads: ["*", "platform.registry"], writes: [] },')), []);
  assert.match(problems(tool('  name: "x",\n  tables: { reads: [], writes: ["*"] },'))[0], /allowed only in reads/);
});
