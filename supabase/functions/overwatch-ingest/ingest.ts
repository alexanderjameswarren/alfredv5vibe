// Pure logic for overwatch-ingest: no Deno, no network, no database, so node --test can run it.
// index.ts does the secret check, the reads and the writes.

export const MAX_EVENTS = 200;
const CODE_RE = /^[a-z0-9_-]{1,40}$/;
const EVENTS = ["new", "repeat", "clear"] as const;

export type BlockEvent = {
  event: "new" | "repeat" | "clear";
  waiter_code: string;
  holder_code: string;
  item: string;
  run_tag: string | null;
  blocked_at: string;
  at: string;
};

export type BlockRow = {
  waiter_code: string;
  holder_code: string;
  item: string;
  run_tag: string | null;
  blocked_at: string;
  last_seen_at: string;
  repeat_count: number;
  cleared_at: string | null;
};

export type Plan =
  | { op: "insert"; row: BlockRow }
  | { op: "update"; patch: Partial<BlockRow> }
  | { op: "none" };

function iso(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** One event from the wire, or the reason it is refused. */
export function parseEvent(raw: unknown): { ok: true; event: BlockEvent } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "event must be an object" };
  const e = raw as Record<string, unknown>;
  if (!EVENTS.includes(e.event as BlockEvent["event"])) {
    return { ok: false, error: `event must be one of ${EVENTS.join(", ")}` };
  }
  for (const k of ["waiter_code", "holder_code"]) {
    if (typeof e[k] !== "string" || !CODE_RE.test(e[k] as string)) return { ok: false, error: `${k} must match ${CODE_RE}` };
  }
  if (e.waiter_code === e.holder_code) return { ok: false, error: "waiter_code and holder_code are the same" };
  if (typeof e.item !== "string" || !e.item.trim() || e.item.length > 500) {
    return { ok: false, error: "item must be a path of 1 to 500 characters" };
  }
  const runTag = e.run_tag ?? null;
  if (runTag !== null && (typeof runTag !== "string" || !CODE_RE.test(runTag))) {
    return { ok: false, error: `run_tag must match ${CODE_RE} or be null` };
  }
  const blockedAt = iso(e.blocked_at);
  const at = iso(e.at);
  if (!blockedAt) return { ok: false, error: "blocked_at must be a timestamp" };
  if (!at) return { ok: false, error: "at must be a timestamp" };
  if (at < blockedAt) return { ok: false, error: "at is before blocked_at" };
  return {
    ok: true,
    event: {
      event: e.event as BlockEvent["event"],
      waiter_code: e.waiter_code as string,
      holder_code: e.holder_code as string,
      item: (e.item as string).trim(),
      run_tag: runTag as string | null,
      blocked_at: blockedAt,
      at,
    },
  };
}

export const KINDS = ["claim_block", "inventory", "finish_summary"] as const;
export const MAX_PARTS = 5000;
export const MAX_OPEN_WORK = 5000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const strList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * `{ kind: "inventory", parts, open_work }`: checked for shape only; replace_platform_inventory checks every value
 * and refuses the whole send if one is wrong, so the old inventory stays.
 */
export function parseInventory(b: Obj):
  | { ok: true; kind: "inventory"; parts: Obj[]; open_work: Obj[] }
  | { ok: false; error: string } {
  const { parts, open_work } = b;
  if (!Array.isArray(parts) || parts.length === 0) return { ok: false, error: "parts must be a non-empty array." };
  if (parts.length > MAX_PARTS) return { ok: false, error: `at most ${MAX_PARTS} parts; got ${parts.length}.` };
  if (!Array.isArray(open_work)) return { ok: false, error: "open_work must be an array." };
  if (open_work.length > MAX_OPEN_WORK) return { ok: false, error: `at most ${MAX_OPEN_WORK} open_work lines; got ${open_work.length}.` };
  const badPart = parts.findIndex((p) =>
    !isObj(p) || typeof p.kind !== "string" || typeof p.name !== "string"
    || (p.reads !== undefined && !strList(p.reads)) || (p.writes !== undefined && !strList(p.writes)));
  if (badPart >= 0) return { ok: false, error: `parts[${badPart}] needs kind and name as text, and reads and writes as lists of text.` };
  const badLine = open_work.findIndex((w) =>
    !isObj(w) || typeof w.file !== "string" || !Number.isInteger(w.line) || typeof w.kind !== "string" || typeof w.text !== "string");
  if (badLine >= 0) return { ok: false, error: `open_work[${badLine}] needs file, line (a whole number), kind and text.` };
  return { ok: true, kind: "inventory", parts: parts as Obj[], open_work: open_work as Obj[] };
}

export type SummaryRow = {
  project_code: string;
  branch: string | null;
  merge_commit: string;
  finished_at: string;
  diff_stat: Obj;
  migrations: string[];
  tools: string[];
  skills: string[];
  functions: string[];
  task_prompts: string[];
  paths: string[];
};

const LISTS = ["migrations", "tools", "skills", "functions", "task_prompts", "paths"] as const;

/** `{ kind: "finish_summary", summary: {...} }`: one finish_summaries row, without reviewed_at. */
export function parseFinishSummary(b: Obj):
  | { ok: true; kind: "finish_summary"; row: SummaryRow }
  | { ok: false; error: string } {
  const s = b.summary;
  if (!isObj(s)) return { ok: false, error: "summary must be an object." };
  if (typeof s.project_code !== "string" || !CODE_RE.test(s.project_code)) {
    return { ok: false, error: `summary.project_code must match ${CODE_RE}` };
  }
  if (typeof s.merge_commit !== "string" || !/^[0-9a-f]{7,40}$/.test(s.merge_commit)) {
    return { ok: false, error: "summary.merge_commit must be a commit hash (7 to 40 hex characters)." };
  }
  const finishedAt = iso(s.finished_at);
  if (!finishedAt) return { ok: false, error: "summary.finished_at must be a timestamp." };
  if (s.branch !== undefined && s.branch !== null && typeof s.branch !== "string") {
    return { ok: false, error: "summary.branch must be text or null." };
  }
  if (s.diff_stat !== undefined && !isObj(s.diff_stat)) return { ok: false, error: "summary.diff_stat must be an object." };
  for (const k of LISTS) {
    if (s[k] !== undefined && !strList(s[k])) return { ok: false, error: `summary.${k} must be a list of text.` };
  }
  const list = (k: (typeof LISTS)[number]) => (s[k] as string[] | undefined) ?? [];
  return {
    ok: true,
    kind: "finish_summary",
    row: {
      project_code: s.project_code,
      branch: (s.branch as string | null | undefined) ?? null,
      merge_commit: s.merge_commit,
      finished_at: finishedAt,
      diff_stat: (s.diff_stat as Obj | undefined) ?? {},
      migrations: list("migrations"),
      tools: list("tools"),
      skills: list("skills"),
      functions: list("functions"),
      task_prompts: list("task_prompts"),
      paths: list("paths"),
    },
  };
}

/** A database refusal that resending cannot fix (bad value, check, duplicate): answered 400, not 500. */
export const isRefusal = (code: unknown) => ["22023", "22P02", "23502", "23505", "23514", "22001"].includes(String(code ?? ""));

/**
 * The body, by kind. A claim_block body: { kind, events: [...] }; bad events are reported, good ones still apply.
 * An inventory or finish_summary body is one event, taken whole or refused.
 */
export function parseBody(body: unknown):
  | { ok: true; kind: "claim_block"; events: BlockEvent[]; rejected: { index: number; error: string }[] }
  | { ok: true; kind: "inventory"; parts: Obj[]; open_work: Obj[] }
  | { ok: true; kind: "finish_summary"; row: SummaryRow }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object." };
  const b = body as Record<string, unknown>;
  if (b.kind === "inventory") return parseInventory(b);
  if (b.kind === "finish_summary") return parseFinishSummary(b);
  if (b.kind !== "claim_block") {
    return { ok: false, error: `unknown kind ${JSON.stringify(b.kind)}. This function accepts ${KINDS.join(", ")}.` };
  }
  if (!Array.isArray(b.events) || b.events.length === 0) return { ok: false, error: "events must be a non-empty array." };
  if (b.events.length > MAX_EVENTS) return { ok: false, error: `at most ${MAX_EVENTS} events per call; got ${b.events.length}.` };
  const events: BlockEvent[] = [];
  const rejected: { index: number; error: string }[] = [];
  b.events.forEach((raw, index) => {
    const r = parseEvent(raw);
    if (r.ok) events.push(r.event);
    else rejected.push({ index, error: r.error });
  });
  return { ok: true, kind: "claim_block", events, rejected };
}

// As times, not strings: the database returns "+00:00" where the wire sends "Z".
const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * What one event does to its episode row. Resending a `new` or a `clear` changes nothing;
 * a resent `repeat` counts again, which is acceptable because repeat_count is information only.
 */
export function plan(existing: BlockRow | null, e: BlockEvent): Plan {
  if (!existing) {
    return {
      op: "insert",
      row: {
        waiter_code: e.waiter_code,
        holder_code: e.holder_code,
        item: e.item,
        run_tag: e.run_tag,
        blocked_at: e.blocked_at,
        last_seen_at: e.at,
        repeat_count: e.event === "repeat" ? 1 : 0,
        cleared_at: e.event === "clear" ? e.at : null,
      },
    };
  }
  const seen = later(existing.last_seen_at, e.at);
  const patch: Partial<BlockRow> = {};
  if (e.event === "repeat") {
    patch.repeat_count = existing.repeat_count + 1;
    if (seen !== existing.last_seen_at) patch.last_seen_at = seen;
  } else if (e.event === "clear") {
    if (existing.cleared_at) return { op: "none" };
    patch.cleared_at = e.at;
    if (seen !== existing.last_seen_at) patch.last_seen_at = seen;
  }
  if (!existing.run_tag && e.run_tag) patch.run_tag = e.run_tag;
  return Object.keys(patch).length ? { op: "update", patch } : { op: "none" };
}
