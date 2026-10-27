// Inventory: the pure parts. Reads defineTool calls and the schema snapshot as
// text; nothing here runs Deno. Used by supabase/functions/mcp/tables.test.mjs
// now and by scripts/inventory.mjs (Overwatch Step 44).

import fs from "node:fs";
import path from "node:path";

export const FUNCTIONS_DIR = "supabase/functions";
/** In reads only: a generic reader such as get_records, which reads any registered table. */
export const ANY_TABLE = "*";
const OPEN = "defineTool({";

/** Every table and view the snapshot creates: public ones bare, others schema-qualified. */
export function snapshotObjects(text) {
  const names = new Set();
  const re = /CREATE (?:TABLE(?: IF NOT EXISTS)?|(?:OR REPLACE )?VIEW) "(\w+)"\."(\w+)"/g;
  for (const m of text.matchAll(re)) names.add(m[1] === "public" ? m[2] : `${m[1]}.${m[2]}`);
  return names;
}

const lineAt = (src, i) => src.slice(0, i).split("\n").length;

/** Past spaces and comments. */
function skip(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) {
      const n = src.indexOf("\n", i);
      i = n < 0 ? src.length : n + 1;
    } else if (src.startsWith("/*", i)) {
      const n = src.indexOf("*/", i + 2);
      i = n < 0 ? src.length : n + 2;
    } else {
      return i;
    }
  }
}

/** A quoted string literal at i: { value, end }, or null. */
function readString(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'") return null;
  let value = "";
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j++) {
    if (src[j] === "\\") value += src[++j];
    else if (src[j] === q) return { value, end: j + 1 };
    else value += src[j];
  }
  return null;
}

/** A literal array of strings at i: { values, end }, or null. */
function readArray(src, i) {
  if (src[i] !== "[") return null;
  const values = [];
  i = skip(src, i + 1);
  while (src[i] !== "]") {
    const s = readString(src, i);
    if (!s) return null;
    values.push(s.value);
    i = skip(src, s.end);
    if (src[i] === ",") i = skip(src, i + 1);
    else if (src[i] !== "]") return null;
  }
  return { values, end: i + 1 };
}

const keyAt = (src, i) => /^(\w+)\s*:/.exec(src.slice(i, i + 64));

/** `{ reads: [...], writes: [...] }` at i: { tables, end } or { error }. */
function readTables(src, i) {
  if (src[i] !== "{") return { error: "tables is not an object literal" };
  const tables = {};
  i = skip(src, i + 1);
  while (src[i] !== "}") {
    const key = keyAt(src, i);
    if (!key || !["reads", "writes"].includes(key[1])) return { error: "tables may hold only reads and writes" };
    const arr = readArray(src, skip(src, i + key[0].length));
    if (!arr) return { error: `tables.${key[1]} is not a literal array of strings` };
    tables[key[1]] = arr.values;
    i = skip(src, arr.end);
    if (src[i] === ",") i = skip(src, i + 1);
    else if (src[i] !== "}") return { error: "tables is malformed" };
  }
  for (const k of ["reads", "writes"]) if (!tables[k]) return { error: `tables.${k} is missing` };
  return { tables, end: i + 1 };
}

/**
 * Every defineTool call in one source file: { name, line, tables, error }. Only the
 * properties before handler or propose are read, so `tables` must come before them.
 */
export function parseDefineTools(src) {
  const tools = [];
  for (let at = src.indexOf(OPEN); at >= 0; at = src.indexOf(OPEN, at + OPEN.length)) {
    const tool = { name: null, line: lineAt(src, at), tables: null, error: null };
    let i = skip(src, at + OPEN.length);
    while (i < src.length && src[i] !== "}") {
      const key = keyAt(src, i);
      if (!key || key[1] === "handler" || key[1] === "propose") break;
      i = skip(src, i + key[0].length);
      if (key[1] === "name") {
        const s = readString(src, i);
        if (!s) {
          tool.error = "name is not a string literal";
          break;
        }
        tool.name = s.value;
        i = s.end;
      } else if (key[1] === "tables") {
        const t = readTables(src, i);
        if (t.error) {
          tool.error = t.error;
          break;
        }
        tool.tables = t.tables;
        i = t.end;
      } else {
        i += /^[^,{}[\]\n]*/.exec(src.slice(i))[0].length; // tier and other plain values
      }
      i = skip(src, i);
      if (src[i] === ",") i = skip(src, i + 1);
    }
    if (!tool.tables && !tool.error) tool.error = "no tables before the handler";
    tools.push(tool);
  }
  return tools;
}

/** One line per problem with the tools' declared tables; empty when all is well. */
export function tableProblems(tools, objects, file) {
  const out = [];
  for (const t of tools) {
    const where = `${file}:${t.line} ${t.name ?? "(no name)"}`;
    if (t.error) {
      out.push(`${where}: ${t.error}`);
      continue;
    }
    for (const n of t.tables.reads) {
      if (n !== ANY_TABLE && !objects.has(n)) out.push(`${where}: reads ${n}, which is not in the schema snapshot`);
    }
    for (const n of t.tables.writes) {
      if (n === ANY_TABLE) out.push(`${where}: "${ANY_TABLE}" is allowed only in reads`);
      else if (!objects.has(n)) out.push(`${where}: writes ${n}, which is not in the schema snapshot`);
    }
  }
  return out;
}

/** The .ts files under supabase/functions that call defineTool, tests left out, as repo paths. */
export function toolSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith(".ts") && !/\.test\./.test(rel) && fs.readFileSync(path.join(root, rel), "utf8").includes(OPEN)) {
        out.push(rel);
      }
    }
  };
  walk(FUNCTIONS_DIR);
  return out.sort();
}
