// What gitpush sends Overwatch after a merge into main (Overwatch Step 47, spec 5.4 and 5.5): the rebuilt inventory
// after every successful push to main (worktree Checkpoint and Finish, main Push and Finish), and on a Finish a
// finish_summaries row for the work it carried. Both are queued in the outbox and sent by the detached sender, so a
// slow or failed send never fails or slows the push. Git is only read here.

import { kickSender, queueEvents } from "./overwatch-post.mjs";
import { parseDefineTools } from "./inventory.mjs";

const MIGRATION = /^supabase\/migrations\/\d+_[^/]+\.sql$/;
const SKILL = /^\.claude\/skills\/[^/]+\/SKILL\.md$/;
const FUNCTION = /^supabase\/functions\/([^_/][^/]*)\//;
const TASK_PROMPT = /^docs\/(?:.+\/)?[^/]*task-prompt[^/]*\.md$/;
const TOOL_SOURCE = /^supabase\/functions\/.+\.ts$/;

/** `git diff --numstat --no-renames` text: { paths, diff_stat }. A binary file counts 0 lines. */
export function parseNumstat(text) {
  const paths = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    paths.push(m[3]);
    if (m[1] !== "-") insertions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }
  return { paths, diff_stat: { files: paths.length, insertions, deletions } };
}

/** The changed paths sorted into what Overwatch tracks. */
export function classifyPaths(paths) {
  const uniq = (xs) => [...new Set(xs)].sort();
  return {
    migrations: uniq(paths.filter((p) => MIGRATION.test(p))),
    skills: uniq(paths.filter((p) => SKILL.test(p))),
    functions: uniq(paths.map((p) => FUNCTION.exec(p)?.[1]).filter(Boolean).map((n) => `supabase/functions/${n}`)),
    task_prompts: uniq(paths.filter((p) => TASK_PROMPT.test(p))),
  };
}

/** Tool names defined in the changed tool files that still exist; `readFile(path)` gives the text or null. */
export function toolsIn(paths, readFile) {
  const names = new Set();
  for (const p of paths) {
    if (!TOOL_SOURCE.test(p) || /\.test\./.test(p)) continue;
    const text = readFile(p);
    if (text == null || !text.includes("defineTool({")) continue;
    for (const t of parseDefineTools(text)) if (t.name) names.add(t.name);
  }
  return [...names].sort();
}

/** The finish_summaries row, as overwatch-ingest's finish_summary kind takes it. */
/**
 * The tables a migration's SQL touches (Step 60): created, altered, inserted into, updated, deleted from, or given a
 * trigger, index or policy. public.x is written x; other schemas stay qualified (platform.registry). Comments are
 * ignored. A pattern search, so dynamic SQL (execute format(...)) is missed.
 */
export function migrationTables(sql) {
  const text = (sql ?? "").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const name = String.raw`((?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?)`;
  const patterns = [
    String.raw`create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${name}`,
    String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${name}`,
    String.raw`insert\s+into\s+${name}`,
    String.raw`update\s+(?:only\s+)?${name}\s+(?:as\s+\w+\s+|\w+\s+)?set\b`,
    String.raw`delete\s+from\s+(?:only\s+)?${name}`,
    String.raw`create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+\w+[\s\S]*?\son\s+${name}`,
    String.raw`create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?\w+\s+on\s+${name}`,
    String.raw`create\s+policy\s+\w+\s+on\s+${name}`,
  ];
  const found = new Set();
  for (const p of patterns) {
    for (const m of text.matchAll(new RegExp(p, "gi"))) {
      const t = m[1].replace(/"/g, "").toLowerCase().replace(/^public\./, "");
      if (t !== "set") found.add(t);
    }
  }
  return [...found].sort();
}

export function buildFinishSummary({ projectCode, branch, mergeCommit, finishedAt, numstat, readFile }) {
  const { paths, diff_stat } = parseNumstat(numstat);
  return {
    project_code: projectCode,
    branch: branch ?? null,
    merge_commit: mergeCommit,
    finished_at: finishedAt,
    diff_stat,
    ...classifyPaths(paths),
    tools: toolsIn(paths, readFile),
    paths: [...paths].sort(),
  };
}

/**
 * The summary of `base..head` in the checkout `git` runs in ({ ok, stdout } per call), or { error }.
 * A worktree Finish passes the merge's first parent as base; a main Finish the upstream before the push.
 */
export function collectFinishSummary({ git, readFile, projectCode, branch, base, head = "HEAD" }) {
  const sha = git(["rev-parse", head]);
  if (!sha.ok || !/^[0-9a-f]{7,40}$/.test(sha.stdout.trim())) return { error: `could not read ${head}` };
  if (!base) return { error: "no base commit to compare with" };
  const when = git(["show", "-s", "--format=%cI", head]);
  const diff = git(["diff", "--numstat", "--no-renames", base, head]);
  if (!when.ok || !diff.ok) return { error: "git could not read the merge" };
  const row = buildFinishSummary({
    projectCode, branch, mergeCommit: sha.stdout.trim(), finishedAt: when.stdout.trim(), numstat: diff.stdout, readFile,
  });
  return row.paths.length ? { row } : { error: "nothing changed between the base and the push" };
}

/**
 * What a gitpush run sends: { inventory, summary, reason }. Nothing unless the push went through ("done", or
 * "partial": merged and pushed, the cleanup after it failed); nothing at all with OVERWATCH_SENDER=off.
 * Mode keys as gitpush's: c checkpoint, f finish, anything else a main push; s skip.
 */
export function sendsFor({ mode, result = "done", env = process.env }) {
  if (env.OVERWATCH_SENDER === "off") return { inventory: false, summary: false, reason: "OVERWATCH_SENDER=off" };
  if (!mode || mode === "s") return { inventory: false, summary: false, reason: "skipped" };
  if (result !== "done" && result !== "partial") return { inventory: false, summary: false, reason: `the run ${result}` };
  return { inventory: true, summary: mode === "f", reason: null };
}

/** The plan's line, shown before the yes/no. */
export function sendPlanLine(mode, env = process.env) {
  const s = sendsFor({ mode, env });
  if (!s.inventory) return `Send    nothing to Overwatch (${s.reason}).`;
  return `Send    the rebuilt inventory${s.summary ? " and a finish summary" : ""} to Overwatch, through the outbox, ` +
    "after the push (a failed send never stops this).";
}

/**
 * `--send-summary <commit> --project <code>` from argv (npm run inventory): { commit, project }, null when
 * --send-summary is absent, or { error }.
 */
export function parseSendSummaryArgs(argv) {
  const at = argv.indexOf("--send-summary");
  if (at < 0) return null;
  const commit = argv[at + 1];
  if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) return { error: "--send-summary needs a commit hash (7 to 40 hex characters)." };
  const p = argv.indexOf("--project");
  const project = p >= 0 ? argv[p + 1] : undefined;
  if (!project || !/^[a-z0-9_-]{1,40}$/.test(project)) return { error: "--send-summary needs --project <code>, e.g. --project overwatch-q4n." };
  return { commit: commit.toLowerCase(), project };
}

/** The merged branch named in a merge commit's subject ("Merge worktree-x"), else null. */
export const branchFromSubject = (subject) => /^Merge (worktree-[a-z0-9_-]{1,40})\b/.exec(subject ?? "")?.[1] ?? null;

/** Queue the events and start the detached sender. Never throws: { queued, error }. */
export function queueOverwatch(ctx, events, { lock, queue = queueEvents, kick = kickSender } = {}) {
  if (!events.length) return { queued: 0, error: null };
  if (!ctx.outboxFile) return { queued: 0, error: "this checkout has no Overwatch outbox" };
  try {
    lock(() => queue(ctx.outboxFile, events));
    kick(ctx);
    return { queued: events.length, error: null };
  } catch (err) {
    return { queued: 0, error: err.message };
  }
}
