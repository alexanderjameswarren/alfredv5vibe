// wb-sync-core — the pure logic of the wb-sync Edge Function.
//
// No Deno APIs, no imports, no I/O: everything here takes plain values and
// returns plain values, so wb-sync-core.test.mjs can run it under node --test.
// Spec: docs/history/technical-spec-warren_buffet-w7b.md sections 6 and 7;
// processing: docs/technical-spec-warren_buffet_p2-m4t.md section 5.

export const APP = "warren_buffet";
export const JOB = "wb-sync";
export const EXECUTOR = "alfred";
export const TIME_ZONE = "America/Los_Angeles";

// 89, not 90: asking for exactly 90 days earns SimpleFIN's cap message.
export const MAX_LOOKBACK_DAYS = 89;
// Re-fetch this many days before the last good run, for late-posting changes.
export const OVERLAP_DAYS = 10;

const DAY_MS = 86_400_000;

export type SnapshotSource = "sync" | "manual" | "import";

/** YYYY-MM-DD in America/Los_Angeles. */
export function localDate(at: Date, timeZone = TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Later of (now − 89 days) and (last ok run − 10 days). */
export function chooseWindowStart(now: Date, lastOkStartedAt: Date | null): Date {
  const cap = new Date(now.getTime() - MAX_LOOKBACK_DAYS * DAY_MS);
  if (!lastOkStartedAt) return cap;
  const overlap = new Date(lastOkStartedAt.getTime() - OVERLAP_DAYS * DAY_MS);
  return overlap > cap ? overlap : cap;
}

export function toUnixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/** SimpleFIN timestamps are unix seconds; 0 or absent means none (pending rows). */
export function unixToIso(value: unknown): string | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * The request for one run. Deno's fetch refuses URLs with embedded
 * credentials, so they move into a Basic auth header. Never log either value.
 */
export function buildRequest(accessUrl: string, startDate: Date): { url: string; authorization: string } {
  const u = new URL(accessUrl);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  if (!user || !pass) throw new Error("SIMPLEFIN_ACCESS_URL has no embedded credentials.");
  u.username = "";
  u.password = "";
  const base = u.toString().replace(/\/+$/, "");
  const url = `${base}/accounts?start-date=${toUnixSeconds(startDate)}&pending=1`;
  return { url, authorization: `Basic ${btoa(`${user}:${pass}`)}` };
}

/** Replace every occurrence of each secret (and its parts) with [redacted]. */
export function redact(message: string, secrets: Array<string | null | undefined>): string {
  let out = message;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join("[redacted]");
  }
  return out;
}

/** The secret plus its credential parts, for redact(). */
export function secretParts(accessUrl: string | null | undefined): string[] {
  if (!accessUrl) return [];
  const parts = [accessUrl];
  try {
    const u = new URL(accessUrl);
    for (const p of [u.username, u.password, decodeURIComponent(u.username), decodeURIComponent(u.password)]) {
      if (p) parts.push(p);
    }
  } catch {
    // Unparseable: the whole string is still redacted.
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Date-range notices are informational: "exceeds recommended range of 45 days",
 * "more than 90 days requested", and future rewordings. Matched by pattern —
 * a "date range" mention, or a day count plus a range/limit word — so a plain
 * "not updated in 5 days" connection problem still counts as blocking.
 */
const DAY_COUNT = /\b\d+[\s-]*days?\b/i;
const RANGE_WORD = /\b(range|exceed\w*|cap|capped|limit\w*|recommended|requested)\b/i;

export function isInformational(message: string): boolean {
  return /\bdate[\s-]+range\b/i.test(message) || (DAY_COUNT.test(message) && RANGE_WORD.test(message));
}

/** SimpleFIN `errors` are strings; newer servers add `errlist` objects with `msg`. */
export function errorMessages(body: { errors?: unknown; errlist?: unknown }): string[] {
  const out: string[] = [];
  const add = (e: unknown) => {
    if (typeof e === "string") out.push(e);
    else if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      const m = o.msg ?? o.message;
      if (typeof m === "string") out.push(m);
    }
  };
  if (Array.isArray(body.errors)) body.errors.forEach(add);
  if (Array.isArray(body.errlist)) body.errlist.forEach(add);
  return [...new Set(out.map((m) => m.trim()).filter(Boolean))];
}

export function classifyErrors(messages: string[]): { informational: string[]; blocking: string[] } {
  const informational: string[] = [];
  const blocking: string[] = [];
  for (const m of messages) (isInformational(m) ? informational : blocking).push(m);
  return { informational, blocking };
}

export function runStatus(blocking: string[]): "ok" | "partial" {
  return blocking.length > 0 ? "partial" : "ok";
}

// ---------------------------------------------------------------------------
// Mapping SimpleFIN objects to rows
// ---------------------------------------------------------------------------

/** Last four digits from a name like "Checking (1234)" or "Card ...1234". */
export function parseLast4(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const m = /(?:^|\D)(\d{4})\)?\s*$/.exec(name.trim());
  return m ? m[1] : null;
}

/** SimpleFIN sends numbers as strings; keep them as strings so no float rounding. */
export function money(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

type Obj = Record<string, unknown>;

export interface Owner {
  user_id: string;
  context_id: string;
}

export function mapAccount(a: Obj, owner: Owner, syncedAt: string) {
  const org = (a.org ?? {}) as Obj;
  const name = typeof a.name === "string" && a.name.trim() ? a.name : "(unnamed account)";
  return {
    ...owner,
    source: "simplefin",
    external_id: String(a.id),
    institution: (org.name as string) ?? (org.domain as string) ?? null,
    name,
    last4: parseLast4(name),
    currency: typeof a.currency === "string" && /^[A-Z]{3}$/.test(a.currency) ? a.currency : "USD",
    last_synced_at: syncedAt,
  };
}

export function mapSnapshot(a: Obj, accountId: string, owner: Owner, asOf: string) {
  return {
    ...owner,
    account_id: accountId,
    as_of: asOf,
    balance: money(a.balance) ?? "0",
    available_balance: money(a["available-balance"]),
    reported_at: unixToIso(a["balance-date"]),
    source: "sync" as SnapshotSource,
  };
}

export function mapTransaction(t: Obj, accountId: string, owner: Owner, seenAt: string) {
  return {
    ...owner,
    account_id: accountId,
    external_id: String(t.id),
    posted_at: unixToIso(t.posted),
    transacted_at: unixToIso(t.transacted_at),
    amount: money(t.amount) ?? "0",
    description: (t.description as string) ?? null,
    payee: (t.payee as string) ?? null,
    memo: (t.memo as string) ?? null,
    mcc: t.extra && typeof t.extra === "object" ? (((t.extra as Obj).mcc as string) ?? null) : null,
    pending: t.pending === true,
    raw: t,
    last_seen_at: seenAt,
  };
}

/** JSON with object keys sorted, so jsonb (which reorders keys) compares equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Obj;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sameTime = (a: unknown, b: unknown) =>
  (a == null && b == null) || (a != null && b != null && new Date(a as string).getTime() === new Date(b as string).getTime());
const sameNumber = (a: unknown, b: unknown) =>
  (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
const sameText = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * Did any stored field change? last_seen_at is bookkeeping and never counts.
 * Timestamps and numerics are compared by value, since Postgres returns them
 * in a different text form than SimpleFIN sends.
 */
export function transactionChanged(stored: Obj, incoming: ReturnType<typeof mapTransaction>): boolean {
  return !(
    sameTime(stored.posted_at, incoming.posted_at) &&
    sameTime(stored.transacted_at, incoming.transacted_at) &&
    sameNumber(stored.amount, incoming.amount) &&
    sameText(stored.description, incoming.description) &&
    sameText(stored.payee, incoming.payee) &&
    sameText(stored.memo, incoming.memo) &&
    sameText(stored.mcc, incoming.mcc) &&
    stored.pending === incoming.pending &&
    canonicalJson(stored.raw) === canonicalJson(incoming.raw)
  );
}

export function mapHolding(h: Obj, accountId: string, owner: Owner, asOf: string) {
  return {
    ...owner,
    account_id: accountId,
    as_of: asOf,
    external_id: String(h.id),
    symbol: (h.symbol as string) ?? null,
    description: (h.description as string) ?? null,
    shares: money(h.shares),
    market_value: money(h.market_value),
    cost_basis: money(h.cost_basis),
    purchase_price: money(h.purchase_price),
    currency: (h.currency as string) || null,
  };
}

// ---------------------------------------------------------------------------
// Rules that protect stored data
// ---------------------------------------------------------------------------

/** Spec §6.2: never overwrite today's manual or import row. */
export function filterSnapshotsForUpsert<T extends { account_id: string }>(
  planned: T[],
  existingToday: Array<{ account_id: string; source: string }>,
): { write: T[]; skipped: number } {
  const protectedIds = new Set(existingToday.filter((r) => r.source !== "sync").map((r) => r.account_id));
  const write = planned.filter((p) => !protectedIds.has(p.account_id));
  return { write, skipped: planned.length - write.length };
}

export interface StoredPending {
  id: string;
  account_id: string;
  external_id: string;
  transacted_at: string | null;
  posted_at: string | null;
  first_seen_at: string;
}

/**
 * Spec §6.4: delete a pending row only when this fetch covered its account and
 * its date, and did not return it. Accounts absent from the response are left
 * alone (a broken connection must not wipe pending rows). A run with blocking
 * errors deletes nothing: SimpleFIN errors are not per account, and a broken
 * bank can still list its account with no transactions. Posted rows never
 * reach here: the caller passes pending rows only.
 */
export function pendingRowsToDelete(
  storedPending: StoredPending[],
  returnedIdsByAccount: Map<string, Set<string>>,
  windowStart: Date,
  hasBlockingErrors = false,
): string[] {
  if (hasBlockingErrors) return [];
  const ids: string[] = [];
  for (const row of storedPending) {
    const returned = returnedIdsByAccount.get(row.account_id);
    if (!returned) continue;
    if (returned.has(row.external_id)) continue;
    const dated = row.transacted_at ?? row.posted_at ?? row.first_seen_at;
    if (new Date(dated) < windowStart) continue;
    ids.push(row.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Inbox alerts (Step 4)
// ---------------------------------------------------------------------------

/** Header that turns a run into a simulated blocking error. Honoured only after the secret gate. */
export const SIMULATE_HEADER = "x-wb-sync-simulate";
export const SIMULATE_VALUE = "blocking-error";
export const SIMULATED_MESSAGE = "SIMULATED: Example Bank connection needs attention (wb-sync test).";

/** Remove anything that looks like a link. Alerts carry no URLs at all. */
export function stripUrls(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link removed]");
}

/**
 * Stable identity for "the same problem": case, spacing and numbers ignored,
 * so "not updated in 3 days" and "in 4 days" stay one open alert.
 */
export function errorKey(message: string): string {
  const norm = message.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  // FNV-1a, 32-bit: short, deterministic, no crypto needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `wb-sync:${h.toString(16).padStart(8, "0")}`;
}

export interface AlertInput {
  /** Already redacted. */
  message: string;
  /** null for a SimpleFIN `errors` entry on a partial run. */
  failureKind: string | null;
}

export interface Alert {
  key: string;
  title: string;
  text: string;
  failureKind: string | null;
}

/** One plain-language line, then what SimpleFIN or the sync actually said. */
export function alertFor(input: AlertInput, institutions: string[], runId: string, runDate: string): Alert {
  const said = stripUrls(input.message).trim();
  let title: string;
  if (input.failureKind === null) {
    const lower = said.toLowerCase();
    const inst = institutions
      .filter((n) => n && n.trim().length >= 3)
      .sort((a, b) => b.length - a.length)
      .find((n) => lower.includes(n.trim().toLowerCase()));
    title = inst
      ? `${inst.trim()} connection needs attention in SimpleFIN`
      : "A bank connection needs attention in SimpleFIN";
  } else if (input.failureKind === "auth") {
    title = "SimpleFIN refused the money sync's access — the access URL may need renewing";
  } else if (input.failureKind === "config") {
    title = "The money sync is missing a setting";
  } else {
    title = "The daily money sync failed";
  }
  const source = input.failureKind === null ? "SimpleFIN said" : "The sync said";
  const text =
    `${title}\n\n${source}: "${said}"\n\n` +
    `wb-sync run ${runId} on ${runDate}. This item stays the only alert for this problem while it is open; ` +
    `archive it once the connection is fixed.`;
  return { key: errorKey(input.message), title, text, failureKind: input.failureKind };
}

// ── Phase 2 processing (docs/technical-spec-warren_buffet_p2-m4t.md §5) ──────

/** Transactions per wb_process_transactions call. */
export const PROCESS_CHUNK = 100;

export function chunks<T>(rows: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export function txnKey(accountId: string, externalId: string): string {
  return `${accountId}|${externalId}`;
}

/**
 * Ids to process: the upserted rows this run inserted or changed (by
 * account|external key), then any row never processed. Deduped, in that order.
 */
export function idsToProcess(
  upserted: Array<{ id: string; account_id: string; external_id: string }>,
  touchedKeys: Set<string>,
  unprocessedIds: string[],
): string[] {
  const out = new Set<string>();
  for (const r of upserted) if (touchedKeys.has(txnKey(r.account_id, r.external_id))) out.add(r.id);
  for (const id of unprocessedIds) out.add(id);
  return [...out];
}

export interface ProcessTotals {
  processed: number;
  paired: number;
  transfer_candidates: number;
  rule_tags: number;
  errors: string[];
}

export function emptyProcessTotals(): ProcessTotals {
  return { processed: 0, paired: 0, transfer_candidates: 0, rule_tags: 0, errors: [] };
}

/** Adds one wb_process_transactions result, or its error, to the totals. */
export function addProcessResult(totals: ProcessTotals, result: Obj | null, error: string | null): ProcessTotals {
  if (error) return { ...totals, errors: [...totals.errors, error] };
  const n = (k: string) => (typeof result?.[k] === "number" ? (result[k] as number) : 0);
  return {
    processed: totals.processed + n("processed"),
    paired: totals.paired + n("paired"),
    transfer_candidates: totals.transfer_candidates + n("transfer_candidates"),
    rule_tags: totals.rule_tags + n("rule_tags"),
    errors: totals.errors,
  };
}

/** Alerts to create: one per distinct key, none whose key already has an open item. */
export function planAlerts(alerts: Alert[], openKeys: Set<string>): Alert[] {
  const seen = new Set(openKeys);
  const out: Alert[] = [];
  for (const a of alerts) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    out.push(a);
  }
  return out;
}
