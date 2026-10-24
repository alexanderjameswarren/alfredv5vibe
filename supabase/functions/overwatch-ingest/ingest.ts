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

/** The body: { kind: "claim_block", events: [...] }. Bad events are reported, good ones still apply. */
export function parseBody(body: unknown):
  | { ok: true; events: BlockEvent[]; rejected: { index: number; error: string }[] }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object." };
  const b = body as Record<string, unknown>;
  if (b.kind !== "claim_block") {
    return { ok: false, error: `unknown kind ${JSON.stringify(b.kind)}. This function accepts only "claim_block" for now.` };
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
  return { ok: true, events, rejected };
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
