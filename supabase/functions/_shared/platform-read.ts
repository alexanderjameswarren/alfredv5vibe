// Shared read options for every MCP list tool: limit, offset, ids, include,
// archived, no_context, long-value previews and a response-size cap.
// See docs/technical-spec-mcp-read-access.md.
//
// Pure: no imports, no database. Tools pass in the table's read settings (from
// public.platform_read_settings()) and apply the result to their own ctx.db
// query, so this module is testable under plain Node.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50; // same ceiling as clampLimit in platform.ts
export const PREVIEW_CHARS = 200;
export const HEAVY_VALUE_CHARS = 1000;
export const MAX_RESPONSE_CHARS = 60000;

export type ArchivedFilter = "exclude" | "include" | "only";

export interface ReadSettings {
  table: string;
  /** Readable columns. The RPC has already removed secret columns. */
  columns: { name: string; type: string }[];
  /** Repeated here so shapeRows can strip them a second time. */
  secret_columns?: string[];
  /** Columns left out of list reads, returned only when fetching by ids. */
  heavy_columns?: string[];
  has_context_id: boolean;
  has_archived: boolean;
  has_status: boolean;
}

export interface ReadOptions {
  limit: number;
  offset: number;
  ids: string[] | null;
  include: string[];
  /** null when the table has no `archived` column. */
  archived: ArchivedFilter | null;
  no_context: boolean;
}

export interface ReadMeta {
  truncated: boolean;
  limit_applied: number;
  total?: number;
  next_offset?: number;
  notes?: string[];
}

function fail(param: string, message: string): never {
  throw new Error(`${param}: ${message}`);
}

/**
 * Validate the shared options. `allowedIncludes` is per tool. Errors are
 * operational (the caller fixes the argument and retries), so they name the
 * parameter and carry no do-not-retry wording.
 */
export function parseReadOptions(
  args: Record<string, unknown>,
  settings: ReadSettings,
  allowedIncludes: string[] = [],
): ReadOptions {
  let ids: string[] | null = null;
  if (args.ids !== undefined && args.ids !== null) {
    if (!Array.isArray(args.ids) || args.ids.length === 0) {
      fail("ids", "must be a non-empty array of record ids");
    }
    if (args.ids.length > MAX_LIMIT) fail("ids", `at most ${MAX_LIMIT} per call`);
    if (!args.ids.every((v) => typeof v === "string" && v.trim() !== "")) {
      fail("ids", "every id must be a non-empty string");
    }
    ids = [...new Set(args.ids as string[])];
  }

  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined && args.limit !== null) {
    const n = args.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      fail("limit", "must be a whole number of 1 or more");
    }
    limit = Math.min(n, MAX_LIMIT);
  }
  if (ids) limit = ids.length;

  let offset = 0;
  if (args.offset !== undefined && args.offset !== null) {
    const n = args.offset;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      fail("offset", "must be a whole number of 0 or more");
    }
    if (ids && n > 0) fail("offset", "cannot be combined with ids");
    offset = n;
  }

  let include: string[] = [];
  if (args.include !== undefined && args.include !== null) {
    if (!Array.isArray(args.include)) fail("include", "must be an array");
    const bad = (args.include as unknown[]).filter(
      (v) => typeof v !== "string" || !allowedIncludes.includes(v),
    );
    if (bad.length > 0) {
      fail(
        "include",
        `unknown value ${JSON.stringify(bad[0])}. ` +
          (allowedIncludes.length > 0
            ? `Allowed: ${allowedIncludes.join(", ")}.`
            : "This tool has no includes."),
      );
    }
    include = [...new Set(args.include as string[])];
  }

  let archived: ArchivedFilter | null = null;
  if (args.archived !== undefined && args.archived !== null) {
    if (!settings.has_archived) fail("archived", `${settings.table} has no archived column`);
    if (args.archived !== "exclude" && args.archived !== "include" && args.archived !== "only") {
      fail("archived", 'must be "exclude", "include" or "only"');
    }
    archived = args.archived;
  } else if (settings.has_archived) {
    // Fetching by ids returns the records asked for, archived or not.
    archived = ids ? "include" : "exclude";
  }

  let no_context = false;
  if (args.no_context !== undefined && args.no_context !== null) {
    if (typeof args.no_context !== "boolean") fail("no_context", "must be true or false");
    if (args.no_context && !settings.has_context_id) {
      fail("no_context", `${settings.table} has no context_id column`);
    }
    if (args.no_context && args.context_id) {
      fail("no_context", "cannot be combined with context_id");
    }
    no_context = args.no_context;
  }

  return { limit, offset, ids, include, archived, no_context };
}

/** Comma-separated select list: never secret columns; heavy ones only by ids. */
export function selectColumns(settings: ReadSettings, opts: { byIds: boolean }): string {
  const secret = new Set(settings.secret_columns ?? []);
  const heavy = new Set(opts.byIds ? [] : settings.heavy_columns ?? []);
  return settings.columns
    .map((c) => c.name)
    .filter((n) => !secret.has(n) && !heavy.has(n))
    .join(", ");
}

/** The PostgREST builder methods the helper needs; supabase-js satisfies it. */
export interface FilterableQuery {
  in(column: string, values: unknown[]): this;
  eq(column: string, value: unknown): this;
  is(column: string, value: null | boolean): this;
  range(from: number, to: number): this;
}

/** Push every shared filter into the query, before the page window. */
export function applyReadOptions<Q extends FilterableQuery>(query: Q, opts: ReadOptions): Q {
  let q = query;
  if (opts.ids) q = q.in("id", opts.ids);
  if (opts.archived === "exclude") q = q.eq("archived", false);
  else if (opts.archived === "only") q = q.eq("archived", true);
  if (opts.no_context) q = q.is("context_id", null);
  return q.range(opts.offset, opts.offset + opts.limit - 1);
}

function cutMarker(length: number): string {
  return `… [cut: ${length} chars; fetch by ids for full text]`;
}

/**
 * List reads preview long values: text over PREVIEW_CHARS is cut and marked,
 * and any other value whose JSON is over HEAVY_VALUE_CHARS is replaced by a
 * marker (the fallback for heavy jsonb that pg_stats did not flag). Reads by
 * ids come back whole. Secret keys are removed either way.
 */
export function shapeRows(
  rows: Record<string, unknown>[],
  settings: ReadSettings,
  opts: { byIds: boolean; fullText?: string[] },
): { rows: Record<string, unknown>[]; previewed: number } {
  const secret = new Set(settings.secret_columns ?? []);
  // Columns a tool's callers have always read whole (e.g. inbox.captured_text for enrichment).
  const full = new Set(opts.fullText ?? []);
  let previewed = 0;
  const out = rows.map((row) => {
    const shaped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (secret.has(key)) continue;
      if (opts.byIds || full.has(key) || value === null || value === undefined) {
        shaped[key] = value;
      } else if (typeof value === "string") {
        if (value.length > PREVIEW_CHARS) {
          shaped[key] = value.slice(0, PREVIEW_CHARS) + cutMarker(value.length);
          previewed++;
        } else {
          shaped[key] = value;
        }
      } else if (typeof value === "object") {
        const size = JSON.stringify(value).length;
        if (size > HEAVY_VALUE_CHARS) {
          shaped[key] = `[omitted: ${size} chars of json; fetch by ids]`;
          previewed++;
        } else {
          shaped[key] = value;
        }
      } else {
        shaped[key] = value;
      }
    }
    return shaped;
  });
  return { rows: out, previewed };
}

/**
 * Drop trailing rows until the payload (as the MCP wrapper prints it) fits.
 * The first row is always kept, so a single large record fetched by id still
 * arrives; the note says it is over the cap.
 */
export function capResponse<T>(
  rows: T[],
  maxChars: number = MAX_RESPONSE_CHARS,
): { rows: T[]; cutForSize: number; oversizedFirst: boolean } {
  let kept = rows.length;
  while (kept > 1 && JSON.stringify(rows.slice(0, kept), null, 2).length > maxChars) {
    kept--;
  }
  const oversizedFirst = kept === 1 && rows.length > 0 &&
    JSON.stringify(rows.slice(0, 1), null, 2).length > maxChars;
  return { rows: rows.slice(0, kept), cutForSize: rows.length - kept, oversizedFirst };
}

/**
 * Envelope meta for one page. `total` is the pre-page count over the same
 * filters (count: "exact"); without it, a full page is assumed to have more.
 */
export function pageMeta(input: {
  opts: ReadOptions;
  returned: number;
  total?: number | null;
  cutForSize?: number;
  oversizedFirst?: boolean;
  previewed?: number;
  omittedHeavy?: string[];
}): ReadMeta {
  const { opts, returned } = input;
  const total = input.total ?? undefined;
  const cutForSize = input.cutForSize ?? 0;
  const notes: string[] = [];

  const more = total !== undefined
    ? total > opts.offset + returned
    : returned + cutForSize >= opts.limit || cutForSize > 0;
  const truncated = !opts.ids && more;

  if (cutForSize > 0) {
    notes.push(
      `${cutForSize} more row(s) on this page were left out to stay under the ` +
        `${MAX_RESPONSE_CHARS}-character response cap.`,
    );
  }
  if (input.oversizedFirst) {
    notes.push(`The first row alone is over the ${MAX_RESPONSE_CHARS}-character response cap.`);
  }
  if (input.previewed) {
    notes.push(
      `${input.previewed} long value(s) were cut to a preview; fetch those records by ids for the full text.`,
    );
  }
  if (input.omittedHeavy && input.omittedHeavy.length > 0 && !opts.ids) {
    notes.push(`Heavy columns left out of list reads: ${input.omittedHeavy.join(", ")}. Fetch by ids to get them.`);
  }

  const meta: ReadMeta = { truncated, limit_applied: opts.limit };
  if (total !== undefined) meta.total = total;
  if (truncated) meta.next_offset = opts.offset + returned;
  if (opts.ids && cutForSize > 0) {
    // A by-ids read has no next page; say which ids to ask for again.
    notes.push("Ask again for the ids that are missing from this result.");
  }
  if (notes.length > 0) meta.notes = notes;
  return meta;
}

/**
 * The text block the MCP wrapper puts above the data. Returns null when there
 * is nothing to say. `shown` is the number of rows in the payload.
 */
export function truncationNote(
  meta: { truncated?: boolean; total?: number; next_offset?: number; notes?: string[] },
  shown: number | string,
): string | null {
  const lines: string[] = [];
  if (meta.truncated) {
    const ofClause = meta.total !== undefined ? `of ${meta.total}` : "(more available)";
    const next = meta.next_offset !== undefined ? ` Next page: offset=${meta.next_offset}.` : "";
    lines.push(
      `NOTE: results truncated to ${shown} ${ofClause}.${next} ` +
        `Narrow the query or request a specific subset.`,
    );
  }
  for (const n of meta.notes ?? []) lines.push(`NOTE: ${n}`);
  return lines.length > 0 ? lines.join("\n") + "\n\n" : null;
}

/** JSON-schema fragments so every tool describes the shared options alike. */
export const READ_OPTION_SCHEMAS = {
  limit: { type: "number", description: `Rows per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
  offset: { type: "number", description: "Rows to skip; the truncation NOTE gives the offset of the next page." },
  ids: {
    type: "array",
    items: { type: "string" },
    description: `Fetch these records (max ${MAX_LIMIT}) with full text and heavy columns.`,
  },
  archived: {
    type: "string",
    enum: ["exclude", "include", "only"],
    description: 'Archived rows: "exclude" (default), "include" or "only".',
  },
  no_context: { type: "boolean", description: "Only records with no context." },
} as const;
