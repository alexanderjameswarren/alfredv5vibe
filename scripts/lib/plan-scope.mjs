// The plan guard's rules: a CLI prompt's "Scope of this step" block, and
// whether an action falls inside it (switchboard2-h8r 0.5, spec 6.2).
//
// The prompt hook records the block in .clip/scope.json; the plan guard hook
// reads it before every tool call. Claims say WHO may change a file; the scope
// says what THIS step may do: create, update, delete, deploy, which SQL tables.
// Pure decisions here; the hooks do the reading and writing.

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { splitCommand } from "./shell-parse.mjs";
import { projectOfTag } from "./project-code.mjs";

export const SCOPE_RELATIVE = ".clip/scope.json";
const KEYS = ["create", "update", "delete", "deploy", "sql"];

export const emptyScope = () => ({ create: [], update: [], delete: [], deploy: [], sql: [] });

/** The scope file for a checkout; PLAN_SCOPE_FILE redirects it for tests. */
export function scopeFile(root) {
  return process.env.PLAN_SCOPE_FILE ? path.resolve(process.env.PLAN_SCOPE_FILE) : path.join(root, SCOPE_RELATIVE);
}

export function readScope(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeScope(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** One entry list: comma-separated, "nothing"/"none" empty, notes in brackets and backticks dropped. */
function entries(value, key) {
  const v = value.replace(/`/g, "").trim();
  if (/^(?:nothing|none|n\/a|-|—)?\.?$/i.test(v)) return [];
  return v
    .split(",")
    .map((e) => e.replace(/\s*\([^)]*\)/g, "").trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .map((e) => (key === "sql" ? tableName(e) : e));
}

/**
 * `{ found, scope, estimate }` from a prompt's text. `found` is false when the
 * prompt has no "Scope of this step:" block.
 */
export function parseScope(text) {
  const lines = String(text).split(/\r?\n/);
  const scope = emptyScope();
  let found = false;
  const at = lines.findIndex((l) => /^\s*Scope of this step:\s*$/i.test(l));
  if (at !== -1) {
    for (const line of lines.slice(at + 1)) {
      const m = /^\s*-\s*(create|update|delete|deploy|sql)\s*:\s*(.*)$/i.exec(line);
      if (!m) {
        if (!line.trim()) continue;
        break;
      }
      found = true;
      const key = m[1].toLowerCase();
      scope[key] = entries(m[2], key);
    }
  }
  const estimate = /^\s*Estimated run:\s*(.+?)\s*$/im.exec(String(text))?.[1] ?? null;
  return { found, scope, estimate };
}

/** Does an entry cover this repo path? A folder entry (ending in /) covers everything under it. */
export function covers(list, rel) {
  const p = rel.toLowerCase();
  return list.some((e) => {
    const x = e.toLowerCase();
    return x.endsWith("/") ? p.startsWith(x) : p === x;
  });
}

const progressOf = (record) => {
  const code = projectOfTag(record?.run_tag ?? "");
  return code ? `docs/progress-${code}.md` : null;
};

/** A schema-qualified, quoted or bare table name, as its bare lower-case name. */
function tableName(raw) {
  return raw.replace(/"/g, "").split(".").pop().toLowerCase();
}

const NAME = String.raw`((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)`;
const TABLE_PATTERNS = [
  new RegExp(String.raw`\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\binsert\s+into\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bupdate\s+(?:only\s+)?${NAME}\s+(?:as\s+\w+\s+|\w+\s+)?set\b`, "gi"),
  new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:[\w"]+\s+)?on\s+(?:only\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\bgrant\s+[\w\s,]+?\s+on\s+(?:table\s+)?${NAME}\s+to\b`, "gi"),
];

/** The tables a SQL script changes or grants on, bare and lower case. Comments are ignored. */
export function sqlTables(sql) {
  const text = String(sql).replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Set();
  for (const re of TABLE_PATTERNS) for (const m of text.matchAll(re)) found.add(tableName(m[1]));
  for (const skip of ["function", "schema", "all"]) found.delete(skip);
  return [...found];
}

/**
 * Why writing `rel` is outside the scope, or null. `existed`: the file was there
 * before this write. `sqlText`: the new text, for a .sql file.
 */
export function judgeWrite(record, rel, existed, sqlText = null) {
  if (!record.found) return `no scope block: the prompt for ${record.run_tag} declared no scope, so no file may change`;
  const s = record.scope;
  const progress = progressOf(record);
  const declared = covers(s.create, rel) || (existed && covers(s.update, rel)) || rel === progress;
  if (!declared) return `${existed ? "undeclared update" : "undeclared create"}: ${rel}`;
  if (sqlText !== null && /\.sql$/i.test(rel)) {
    const extra = sqlTables(sqlText).filter((t) => !s.sql.includes(t));
    if (extra.length) return `SQL touches ${extra.join(", ")}, not named under SQL (${s.sql.join(", ") || "none"}): ${rel}`;
  }
  return null;
}

/** Why deleting these repo paths is outside the scope, or null. */
export function judgeDelete(record, rels) {
  if (!record.found) return `no scope block: the prompt for ${record.run_tag} declared no scope, so nothing may be deleted`;
  const extra = rels.filter((r) => !covers(record.scope.delete, r));
  return extra.length ? `undeclared delete: ${extra.join(", ")}` : null;
}

const DELETE_WORD = /(?:^|[\s;&|(])(?:rm|rmdir|unlink|del|erase|rd|ri|Remove-Item|git\s+rm)(?=\s|$)/i;
const READS_ONLY = /^\s*(?:grep|rg|git\s+(?:grep|log|diff|show|status)|cat|ls|Select-String)\b/i;

/** The parts of a command that delete files. Quoted arguments of read-only programs are not deletes. */
export function deleteParts(command, shell = "bash") {
  return splitCommand(command, shell, { pipes: true }).filter((p) => !READS_ONLY.test(p) && DELETE_WORD.test(p));
}

/**
 * What a deploy command deploys, as scope names, or null if it is not a deploy:
 * Supabase function names, "db push", or `sf:<metadata or source dir>`.
 */
export function deployTargets(command) {
  const c = String(command);
  const fn = /\bsupabase\s+functions\s+deploy\b([^;&|\n]*)/.exec(c);
  if (fn) {
    const names = fn[1].trim().split(/\s+/).filter((w) => w && !w.startsWith("-"));
    return names.length ? names : ["(all functions)"];
  }
  if (/\bsupabase\s+db\s+push\b/.test(c)) return ["db push"];
  const sf = /\bsf\s+project\s+deploy\s+(?:start|validate)\b([^;&|\n]*)/.exec(c);
  if (sf) {
    const out = [];
    const re = /(?:--metadata|-m|--source-dir|-d|--manifest|-x)[ =]("[^"]+"|'[^']+'|\S+)/g;
    for (const m of sf[1].matchAll(re)) out.push(`sf:${m[1].replace(/^["']|["']$/g, "")}`);
    return out.length ? out : ["sf:(whole project)"];
  }
  return null;
}

/** Why this deploy is outside the scope, or null (also null for a command that is no deploy). */
export function judgeDeploy(record, command) {
  const targets = deployTargets(command);
  if (!targets) return null;
  if (!record.found) return `no scope block: the prompt for ${record.run_tag} declared no scope, so nothing may be deployed`;
  const extra = targets.filter((t) => !record.scope.deploy.includes(t) && !record.scope.deploy.includes(t.replace(/^sf:/, "")));
  return extra.length ? `undeclared deploy: ${extra.join(", ")}` : null;
}

export { KEYS as SCOPE_KEYS };
