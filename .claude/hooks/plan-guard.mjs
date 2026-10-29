#!/usr/bin/env node
// PreToolUse plan guard: refuse anything outside the step's declared scope
// (switchboard2-h8r 0.5, spec 6.2).
//
// The prompt hook records each tagged prompt's "Scope of this step" block in
// .clip/scope.json. This hook reads it before every edit and shell command and
// refuses an undeclared create, update or delete, a deploy target not listed,
// and SQL that names a table not listed. The claims guard runs beside it and
// still decides who may touch a file; this decides what this step may do.
//
// No scope recorded at all (a session from before this hook, or no tagged
// prompt yet): allow, there is no plan to hold it to. A tagged prompt with no
// block records an empty scope, and then nothing outside .clip/ may change.
// PLAN_GUARD=off turns it off for a session, said out loud and logged.
//
// Exit 0 allows; exit 2 blocks and shows stderr. Decisions go to the claims
// guard's log, so the two read as one story.
//
// Owns: enforcing .clip/scope.json; its "plan <tag>" log lines, which
// clip.mjs --scope reads. Writes no scope: prompt-check.mjs records it.
// Uses: scripts/lib/plan-scope.mjs (the rules) and scripts/lib/claims-core.mjs
// (checkout, repo paths, exempt folders, shell write checks).

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isExempt, isLoneScriptCommand, repoPathsIn, resolveCheckout, toRepoRelative, writeCheck } from "../../scripts/lib/claims-core.mjs";
import { deleteParts, judgeDelete, judgeDeploy, judgeWrite, readScope, scopeFile } from "../../scripts/lib/plan-scope.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Map([["Bash", "bash"], ["PowerShell", "powershell"]]);
const LOG_RELATIVE = ".clip/claims-guard.log";
const LOG_MAX_BYTES = 256 * 1024;

const entry = { tool: "?", root: null, cwd: null, tag: null };

function log(decision, detail) {
  try {
    const root = entry.root ?? entry.cwd ?? process.cwd();
    const file = process.env.CLAIMS_GUARD_LOG ? path.resolve(process.env.CLAIMS_GUARD_LOG) : path.join(root, LOG_RELATIVE);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_MAX_BYTES) return;
    } catch {
      /* new log */
    }
    appendFileSync(file, `${new Date().toISOString()}  ${decision.padEnd(6)} ${entry.tool}  plan ${entry.tag ?? "-"}  ${detail}\n`, "utf8");
  } catch {
    // Logging must never be the reason a call fails.
  }
}

function allow(detail) {
  log("ALLOW", detail);
  process.exit(0);
}

function block(reason, record) {
  log("BLOCK", reason);
  const s = record.scope;
  const list = (xs) => (xs.length ? xs.join(", ") : "nothing");
  process.stderr.write(
    `🛑 PLAN GUARD: this is outside the scope declared for ${record.run_tag}.\n\n` +
      `  ${reason}\n\n` +
      (record.found
        ? `  Declared:  create: ${list(s.create)}\n` +
          `             update: ${list(s.update)}\n` +
          `             delete: ${list(s.delete)}\n` +
          `             deploy: ${list(s.deploy)}\n` +
          `             SQL:    ${list(s.sql)}\n\n`
        : "") +
      `STOP. Do not try this another way. Tell Alex what you need and why. He widens the\n` +
      `scope by sending a tagged prompt (a follow-up step) whose scope block includes it.\n`,
  );
  process.exit(2);
}

function main() {
  if (process.env.PLAN_GUARD === "off") {
    process.stderr.write("plan-guard: PLAN_GUARD=off — not enforcing the step's scope this session.\n");
    allow("PLAN_GUARD=off");
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  } catch {
    allow("unparseable payload");
  }
  entry.tool = payload?.tool_name ?? "?";
  entry.cwd = payload?.cwd ?? process.cwd();
  const input = payload?.tool_input ?? {};
  const shell = SHELL_TOOLS.get(entry.tool);
  if (!EDIT_TOOLS.has(entry.tool) && !shell) allow("not an edit or a command");

  let ctx;
  try {
    ctx = resolveCheckout(process.env.CLAUDE_PROJECT_DIR, entry.cwd);
  } catch {
    allow("not a git repo");
  }
  entry.root = ctx.root;
  const record = readScope(scopeFile(ctx.root));
  if (!record) allow("no scope recorded");
  entry.tag = record.run_tag;

  if (!shell) {
    const p = input.notebook_path ?? input.file_path;
    if (!p) allow("no path");
    const rel = toRepoRelative(p, ctx.root);
    if (rel === null) allow("outside the repo");
    if (isExempt(rel)) allow(`exempt: ${rel}`);
    const text =
      entry.tool === "Write" ? input.content
      : entry.tool === "Edit" ? input.new_string
      : entry.tool === "MultiEdit" ? (input.edits ?? []).map((e) => e.new_string).join("\n")
      : null;
    const reason = judgeWrite(record, rel, existsSync(path.resolve(ctx.root, rel)), text ?? null);
    if (reason) block(reason, record);
    allow(`in scope: ${rel}`);
  }

  const command = String(input.command ?? "");
  const deploy = judgeDeploy(record, command);
  if (deploy) block(deploy, record);

  const deleted = new Set();
  for (const part of deleteParts(command, shell)) for (const rel of repoPathsIn(part, ctx.root)) deleted.add(rel);
  if (deleted.size) {
    const reason = judgeDelete(record, [...deleted]);
    if (reason) block(reason, record);
  }

  const redirectsOnly = isLoneScriptCommand(command.trim());
  const write = writeCheck(command, ctx.root, shell, { redirectsOnly });
  for (const rel of write?.paths ?? []) {
    if (deleted.has(rel)) continue;
    const reason = judgeWrite(record, rel, existsSync(path.resolve(ctx.root, rel)));
    if (reason) block(`${reason} (via ${write.indicator})`, record);
  }
  allow(command ? "command in scope" : "empty command");
}

main();
