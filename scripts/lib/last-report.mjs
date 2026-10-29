// .clip/last-report.json: the run tag and time of the last report clip.mjs
// pushed from a checkout. Read by Switchboard (tools/claude-sessions).
// Also the report's required sections, and the scope-vs-changes comparison.

import path from "node:path";
import { writeAtomic } from "./session-status.mjs";
import { covers } from "./plan-scope.mjs";
import { projectOfTag } from "./project-code.mjs";

export const LAST_REPORT_RELATIVE = ".clip/last-report.json";
export const REPORT_RELATIVE = ".clip/last-report.md";

/** True when `file` is the checkout's own .clip/last-report.md: only that push is "the report". */
export function isCheckoutReport(root, file) {
  if (!root || !file) return false;
  return path.resolve(file).toLowerCase() === path.resolve(root, REPORT_RELATIVE).toLowerCase();
}

/** Write the record; returns it, or null on any failure. Never throws. */
export function writeLastReport(root, { runTag, title, pushedAt = new Date() } = {}, file) {
  try {
    const record = {
      run_tag: runTag || null,
      title: title ?? null,
      pushed_at: pushedAt.toISOString(),
    };
    writeAtomic(file ?? path.join(root, LAST_REPORT_RELATIVE), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report sections (switchboard2-h8r 0.6, spec 6.2)
// ---------------------------------------------------------------------------

const SECTIONS = [
  { name: "Scope vs changes", heading: /^\s*(?:#{1,4}\s*|\*\*)Scope vs changes\b/im, body: null },
  { name: "Next step's scope", heading: /^\s*(?:#{1,4}\s*|\*\*)Next step['’]s scope\b/im, body: /^\s*-\s*(?:create|update|delete|deploy|sql)\s*:/im },
];

/** The required sections a report lacks. A next-step heading needs its block lines after it. */
export function missingSections(text) {
  const t = String(text ?? "");
  return SECTIONS.filter(({ heading, body }) => {
    const m = heading.exec(t);
    if (!m) return true;
    return body ? !body.test(t.slice(m.index + m[0].length)) : false;
  }).map((s) => s.name);
}

/** Repo paths from `git status --porcelain -z`; a rename gives both paths. */
export function changedFromStatus(z) {
  const parts = String(z ?? "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    out.push(p.slice(3));
    if (/^[RC]/.test(p)) out.push(parts[++i]);
  }
  return out.filter(Boolean);
}

/** Paths the plan guard allowed an edit tool to change under this run tag, from its log. */
export function touchedFromLog(log, runTag) {
  const re = /^\S+\s+ALLOW\s+\S+\s+plan (\S+)\s+in scope: (.+?)\s*$/;
  const out = new Set();
  for (const line of String(log ?? "").split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && m[1] === runTag) out.add(m[2]);
  }
  return [...out];
}

/**
 * The step's declared scope against what changed. `touched`: this run's edits
 * (guard log). `changed`: git status, which also holds earlier steps' uncommitted work.
 * undeclared: touched, not declared. untouched: declared entries nothing matched.
 * carried: changed, not declared and not touched this run.
 */
export function scopeVsChanges({ record, changed = [], touched = [] }) {
  const s = record?.found ? record.scope : { create: [], update: [], delete: [] };
  const progress = projectOfTag(record?.run_tag ?? "") ? `docs/progress-${projectOfTag(record.run_tag)}.md` : null;
  const declaredList = [...s.create, ...s.update, ...s.delete];
  const declared = (rel) => covers(declaredList, rel) || (record?.found && rel === progress);
  const touchedSet = new Set(touched.map((p) => p.toLowerCase()));
  const all = [...new Set([...touched, ...changed])];
  return {
    undeclared: touched.filter((p) => !declared(p)),
    untouched: declaredList.filter((e) => !all.some((p) => covers([e], p))),
    carried: changed.filter((p) => !declared(p) && !touchedSet.has(p.toLowerCase())),
  };
}

/** The "Scope vs changes" report section, as markdown. */
export function formatScopeVsChanges(result, record) {
  const lines = ["## Scope vs changes"];
  if (!result || !record) return `${lines[0]}\nNo scope recorded for this checkout, so there is nothing to compare.\n`;
  if (!record.found) lines.push(`The prompt for ${record.run_tag} declared no scope block.`);
  const { undeclared, untouched, carried } = result;
  if (!undeclared.length && !untouched.length) lines.push(`Matches the scope declared for ${record.run_tag}.`);
  if (undeclared.length) lines.push(`- Changed, not declared: ${undeclared.join(", ")}`);
  if (untouched.length) lines.push(`- Declared, not touched: ${untouched.join(", ")}`);
  if (carried.length) lines.push(`- Uncommitted from earlier steps, not in this scope: ${carried.join(", ")}`);
  return `${lines.join("\n")}\n`;
}
