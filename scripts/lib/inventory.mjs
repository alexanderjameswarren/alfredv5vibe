// Inventory: the pure parts. Reads defineTool calls and the schema snapshot as
// text; nothing here runs Deno. Used by supabase/functions/mcp/tables.test.mjs
// now and by scripts/inventory.mjs (Overwatch Step 44).

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
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
    const tool = { name: null, line: lineAt(src, at), offset: at, tier: null, tables: null, error: null };
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
        const plain = /^[^,{}[\]\n]*/.exec(src.slice(i))[0]; // tier and other plain values
        if (key[1] === "tier" && /^\d+$/.test(plain.trim())) tool.tier = Number(plain.trim());
        i += plain.length;
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

// ---------------------------------------------------------------------------
// The rebuild (Overwatch Step 44): parts and open work in the exact shape
// replace_platform_inventory takes. Everything here works on text; scripts/inventory.mjs reads the files.
// ---------------------------------------------------------------------------

export const fingerprint = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);

/** App ids seeded by `insert into public.apps` in the migrations. */
export function appIdsFromMigrations(texts) {
  const ids = new Set();
  for (const text of texts) {
    for (const block of text.matchAll(/insert into public\.apps\b[\s\S]*?(?:on conflict|;)/gi)) {
      for (const m of block[0].matchAll(/\(\s*'([a-z][a-z0-9_]*)',\s*'/g)) ids.add(m[1]);
    }
  }
  return ids;
}

// First match wins, so drive_mix is tested before dj and wb before the Overwatch words ("project").
const APP_RULES = [
  [(t) => t.has("wb") || t.has("money") || t.has("warren"), "warren_buffet"],
  [(t, s) => /drive[_-]mix/.test(s), "drive_mix"],
  [(t) => t.has("sam"), "sam"],
  [(t) => t.has("ken"), "ken"],
  [(t) => t.has("dj"), "dj"],
  [(t) => t.has("job") || t.has("jobs"), "jobs"],
  [(t, s) => t.has("overwatch") || t.has("friction") || t.has("activity") || t.has("project")
    || /claim_blocks|app_profile|seen_releases|platform_inventory|open_work|finish_summar/.test(s), "overwatch"],
  // Step 60: the screens /timer and /games, and anything of Switchboard's (tools/claude-sessions).
  [(t) => t.has("timer"), "timer"],
  [(t) => t.has("games") || t.has("game"), "games"],
  [(t, s) => t.has("switchboard") || /claude[_-]sessions/.test(s), "switchboard"],
];

/** The app a part belongs to, from the words in its name; `fallback` when none match. Only ids in `apps`. */
export function appFor(name, apps, fallback = "alfred") {
  const s = name.toLowerCase();
  const tokens = new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  const hit = APP_RULES.find(([test]) => test(tokens, s))?.[1] ?? fallback;
  return hit && apps.has(hit) ? hit : null;
}

/** Tool names registered in mcp/index.ts. */
export const registeredTools = (indexText) =>
  new Set([...indexText.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

/** Tool parts from the tool source files ({ path, text }); unregistered tools are left out. */
export function toolParts(files, registered, apps, lastChanged = new Map()) {
  const parts = [];
  const problems = [];
  const found = new Set();
  for (const { path: file, text } of files) {
    const tools = parseDefineTools(text);
    tools.forEach((t, i) => {
      if (t.error || !t.name) {
        problems.push(`${file}:${t.line} ${t.name ?? "(no name)"}: ${t.error ?? "no name"}`);
        return;
      }
      found.add(t.name);
      if (!registered.has(t.name)) return;
      parts.push({
        kind: "tool",
        name: t.name,
        app_id: appFor(t.name, apps),
        reads: t.tables.reads.filter((n) => n !== ANY_TABLE),
        writes: t.tables.writes,
        reads_any: t.tables.reads.includes(ANY_TABLE),
        location: file,
        fingerprint: fingerprint(text.slice(t.offset, tools[i + 1]?.offset ?? text.length)),
        last_changed_project: changedBy(lastChanged, file),
        details: { tier: t.tier, line: t.line },
      });
    });
  }
  for (const name of registered) if (!found.has(name)) problems.push(`registered tool ${name} has no defineTool`);
  return { parts, problems };
}

/** Registered tool names a text mentions, in name order. */
export const toolsMentioned = (text, toolNames) =>
  [...toolNames].filter((n) => new RegExp(`\\b${n}\\b`).test(text)).sort();

const TOOL_LIKE = /\b(?:get|search|create|update|upsert|record|log|mark|set|archive|place|load|append|tag|split|reprocess|propose|bulk|acknowledge|unconfirm|check|dry_run)_[a-z][a-z0-9_]*\b/g;

/**
 * Names in a text shaped like tool names (get_x, create_x, …) that are not registered tools: a skill or prompt
 * calling a tool that is gone or misspelt. Some are SQL functions or RPCs; the weekly audit judges which.
 */
export function unknownToolNames(text, toolNames) {
  const known = new Set(toolNames);
  return [...new Set(text.match(TOOL_LIKE) ?? [])].filter((n) => !known.has(n)).sort();
}

/** Reads and writes of the tools a skill or prompt mentions. */
function tablesOf(names, toolsByName) {
  const reads = new Set();
  const writes = new Set();
  for (const n of names) {
    for (const r of toolsByName.get(n)?.reads ?? []) reads.add(r);
    for (const w of toolsByName.get(n)?.writes ?? []) writes.add(w);
  }
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

/** A skill part from .claude/skills/<name>/SKILL.md. */
export function skillPart(file, text, toolsByName, apps, lastChanged = new Map()) {
  const name = path.basename(path.dirname(file));
  const tools = toolsMentioned(text, toolsByName.keys());
  return {
    kind: "skill", name, app_id: appFor(name, apps), ...tablesOf(tools, toolsByName),
    location: file, fingerprint: fingerprint(text), last_changed_project: changedBy(lastChanged, file),
    details: {
      version: /Skill version:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[a-z]?)/.exec(text)?.[1] ?? null, tools,
      unknown_tools: unknownToolNames(text, toolsByName.keys()),
    },
  };
}

/** A task prompt part from docs/**\/*task-prompt*.md. */
export function taskPromptPart(file, text, toolsByName, apps, lastChanged = new Map()) {
  const name = path.basename(file, ".md");
  const tools = toolsMentioned(text, toolsByName.keys());
  return {
    kind: "task_prompt", name: file, app_id: appFor(name, apps), ...tablesOf(tools, toolsByName),
    location: file, fingerprint: fingerprint(text), last_changed_project: changedBy(lastChanged, file),
    details: {
      version: /PROMPT VERSION:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[a-z]?)/.exec(text)?.[1] ?? null,
      history: file.startsWith("docs/history/"), tools, unknown_tools: unknownToolNames(text, toolsByName.keys()),
    },
  };
}

/** An edge function part from its folder's files ({ path, text }). */
export function edgeFunctionPart(folder, files, apps, lastChanged = new Map()) {
  const name = path.basename(folder);
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const newest = sorted.map((f) => lastChanged.get(f.path)).filter(Boolean)
    .sort((a, b) => a.order - b.order)[0]?.code ?? null;
  return {
    kind: "edge_function", name, app_id: appFor(name, apps), reads: [], writes: [], location: folder,
    fingerprint: fingerprint(sorted.map((f) => `${f.path}\n${f.text}`).join("\n")), last_changed_project: newest,
    details: { files: sorted.map((f) => f.path.slice(folder.length + 1)) },
  };
}

const qualified = (schema, name) => (schema === "public" ? name : `${schema}.${name}`);

/** The body of a function in the snapshot, up to the next function or ALTER. */
function functionBody(text, schema, name) {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION "${schema}"."${name}"(`);
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const end = rest.search(/\nCREATE OR REPLACE FUNCTION |\nALTER FUNCTION /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Tables a function body writes: insert into, update, delete from, among the snapshot's objects. */
export function functionWrites(body, objects) {
  const out = new Set();
  for (const m of body.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
    const n = qualified(m[1] ?? "public", m[2]);
    if (objects.has(n)) out.add(n);
  }
  return [...out].sort();
}

// An assignment to NEW.<column>, with := or plpgsql's =, where a statement starts, so `if new.id = old.id` is not one.
const ASSIGNS_NEW = /(?:^|;|\bbegin\b|\bthen\b|\belse\b)\s*new\s*\.\s*"?\w+"?\s*:?=(?![=>])/im;

/** Table, view and trigger parts from the schema snapshot. */
export function snapshotParts(text, apps) {
  const objects = snapshotObjects(text);
  const parts = [];
  const location = "supabase/schema-snapshot.sql";
  for (const m of text.matchAll(/CREATE (TABLE(?: IF NOT EXISTS)?|(?:OR REPLACE )?VIEW) "(\w+)"\."(\w+)"[\s\S]*?;\n/g)) {
    const name = qualified(m[2], m[3]);
    parts.push({
      kind: "table", name, app_id: m[2] === "public" ? appFor(m[3], apps) : null, reads: [], writes: [],
      location, fingerprint: fingerprint(m[0]), last_changed_project: null,
      details: { schema: m[2], view: m[1].endsWith("VIEW") },
    });
  }
  const re = /CREATE (?:OR REPLACE )?TRIGGER "(\w+)" (.+?) ON "(\w+)"\."(\w+)" .*?EXECUTE FUNCTION "(\w+)"\."(\w+)"\(/g;
  for (const m of text.matchAll(re)) {
    const table = qualified(m[3], m[4]);
    const body = functionBody(text, m[5], m[6]);
    // A function that assigns to NEW changes the row it fires on, so it writes its own table too.
    const writes = functionWrites(body, objects);
    if (ASSIGNS_NEW.test(body) && !writes.includes(table)) writes.push(table);
    parts.push({
      kind: "trigger", name: `${table}.${m[1]}`, app_id: m[3] === "public" ? appFor(m[4], apps) : null,
      reads: [table], writes: writes.sort(),
      location, fingerprint: fingerprint(m[0]), last_changed_project: null,
      details: { timing: m[2], function: qualified(m[5], m[6]) },
    });
  }
  return parts;
}

/** Screen parts: the routes in src/viewPaths.js (VIEW_TO_PATH entries and exported *_PATH constants). */
export function screenParts(text, apps, lastChanged = new Map()) {
  const routes = new Map();
  const add = (p, how) => routes.set(p, [...(routes.get(p) ?? []), how]);
  const map = /VIEW_TO_PATH = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
  for (const m of map.matchAll(/^\s*"?([\w-]+)"?:\s*"(\/[^"]*)"/gm)) add(m[2], `view:${m[1]}`);
  for (const m of text.matchAll(/^export const (\w+_PATH) = "(\/[^"]*)"/gm)) add(m[2], m[1]);
  const file = "src/viewPaths.js";
  return [...routes].sort(([a], [b]) => a.localeCompare(b)).map(([route, how]) => ({
    kind: "screen", name: route, app_id: appFor(route, apps), reads: [], writes: [], location: file,
    fingerprint: fingerprint(`${route} ${how.join(" ")}`), last_changed_project: changedBy(lastChanged, file),
    details: { from: how },
  }));
}

/** Spec, progress and review docs: the files open work is read from. */
export const isWorkDoc = (file) =>
  /^docs\/(history\/)?[^/]+\.md$/.test(file) && /(^|[-_.])(progress|spec|review)([-_.]|$)/.test(path.basename(file, ".md"));

const CHECKBOX = /^\s*(?:[-*+]|\d+\.)\s+\[ \]\s*/;
const BULLET = /^\s*(?:[-*+]|\d+\.)\s+/;
const DONE_BOX = /^\s*(?:[-*+]|\d+\.)\s+\[[xX]\]/;
const DEFERRED = /\bdeferred\b/i;
const PHASE_OR_STEP = /\b(?:phase|step)s?\b/i;
const NOT_FIXED = /\bnot (?:yet )?fixed\b|\bunfixed\b/i;
const FOLLOW_UP = /\bfollow-?ups?\b/i;
/** A heading such as "## Later", "## 6. Later phase" or "## Later, not Phase 3". */
const LATER_HEADING = /^(?:\d+\.\s*)?Later\b/i;

/**
 * Open work in one doc. Code blocks are skipped. Everywhere: deferred phases or steps, "not fixed" notes,
 * and the bullets under a "Later" heading (recorded as deferred_phase, since the table has no other kind).
 * Unchecked boxes count everywhere except docs/history/, where only unchecked follow-ups do: a finished
 * project's leftover boxes are noise (Alex, 2026-10-27).
 */
export function openWork(file, text) {
  const code = /^(?:progress|technical-spec|review)-([a-z0-9_-]{1,40})\.md$/.exec(path.basename(file))?.[1] ?? null;
  const history = file.startsWith("docs/history/");
  const out = [];
  let fenced = false;
  let laterLevel = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1].length;
      if (laterLevel !== null && level <= laterLevel) laterLevel = null;
      if (LATER_HEADING.test(heading[2].trim())) laterLevel = level;
    }
    const inLater = laterLevel !== null && !heading && BULLET.test(raw) && !DONE_BOX.test(raw);
    const box = CHECKBOX.test(raw);
    const kind = box && !history ? "checkbox"
      : box && FOLLOW_UP.test(raw) ? "checkbox"
      : DEFERRED.test(raw) && PHASE_OR_STEP.test(raw) ? "deferred_phase"
      : NOT_FIXED.test(raw) ? "not_fixed"
      : inLater ? "deferred_phase" : null;
    if (kind) out.push({ file, line: i + 1, kind, text: raw.trim().slice(0, 500), project_code: code });
  });
  return out;
}

/** The project code in a commit subject: "<code>: …" or "Merge worktree-<code>". */
export function projectFromSubject(subject) {
  const m = /^Merge worktree-([a-z0-9_-]{1,40})\b/.exec(subject) ?? /^([a-z0-9_-]{1,40}):\s/.exec(subject);
  return m ? m[1] : null;
}

/**
 * The newest commit per file from `git log --name-only --format=%x1e%s` (newest first): { code, order },
 * where code is the project its subject names (or null) and order counts back from the newest commit.
 */
export function lastChangedFromLog(log) {
  const out = new Map();
  log.split("\x1e").slice(1).forEach((record, order) => {
    const [subject, ...files] = record.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const code = projectFromSubject(subject ?? "");
    for (const f of files) if (!out.has(f)) out.set(f, { code, order });
  });
  return out;
}

const changedBy = (lastChanged, file) => lastChanged.get(file)?.code ?? null;

// ---------------------------------------------------------------------------
// The whole rebuild from a checkout (npm run inventory and gitpush). Reads files; git is read only.
// ---------------------------------------------------------------------------

/** Every file under a repo folder, as repo paths with forward slashes. */
function filesUnder(root, dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(path.join(root, dir))) walk(dir);
  return out.sort();
}

function gitLog(root) {
  try {
    return execFileSync("git", ["log", "--name-only", "--format=%x1e%s"], {
      cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** { parts, open_work, problems } for the checkout at `root`. */
export function buildInventory(root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  const lastChanged = lastChangedFromLog(gitLog(root));
  const apps = appIdsFromMigrations(filesUnder(root, "supabase/migrations").filter((f) => f.endsWith(".sql")).map(read));
  const registered = registeredTools(read(`${FUNCTIONS_DIR}/mcp/index.ts`));

  const tools = toolParts(toolSourceFiles(root).map((p) => ({ path: p, text: read(p) })), registered, apps, lastChanged);
  const toolsByName = new Map(tools.parts.map((t) => [t.name, t]));
  const problems = [...tools.problems];

  const skills = fs.readdirSync(path.join(root, ".claude/skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, ".claude/skills", e.name, "SKILL.md")))
    .map((e) => skillPart(`.claude/skills/${e.name}/SKILL.md`, read(`.claude/skills/${e.name}/SKILL.md`), toolsByName, apps, lastChanged));
  for (const s of skills) if (!s.details.version) problems.push(`skill ${s.name}: no "Skill version:" line`);

  const prompts = filesUnder(root, "docs").filter((f) => /task-prompt[^/]*\.md$/.test(f))
    .map((f) => taskPromptPart(f, read(f), toolsByName, apps, lastChanged));
  for (const p of prompts) if (!p.details.version && !p.details.history) problems.push(`task prompt ${p.name}: no PROMPT VERSION`);

  const functions = fs.readdirSync(path.join(root, FUNCTIONS_DIR), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => {
      const folder = `${FUNCTIONS_DIR}/${e.name}`;
      return edgeFunctionPart(folder, filesUnder(root, folder).map((p) => ({ path: p, text: read(p) })), apps, lastChanged);
    });

  const snapshot = snapshotParts(read("supabase/schema-snapshot.sql"), apps);
  const screens = screenParts(read("src/viewPaths.js"), apps, lastChanged);

  const { parts, dropped } = dedupeParts([...tools.parts, ...skills, ...functions, ...prompts, ...snapshot, ...screens]);
  for (const d of dropped) problems.push(`duplicate ${d}: the later one was left out`);

  const open_work = filesUnder(root, "docs").filter(isWorkDoc).flatMap((f) => openWork(f, read(f)));
  return { parts, open_work, problems };
}

/** Parts that share a kind and name: the later ones are dropped and reported. */
export function dedupeParts(parts) {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const p of parts) {
    const key = `${p.kind} ${p.name}`;
    if (seen.has(key)) dropped.push(key);
    else {
      seen.add(key);
      kept.push(p);
    }
  }
  return { parts: kept, dropped };
}
