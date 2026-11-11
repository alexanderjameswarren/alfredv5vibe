// ============================================================================
// supabase/functions/_shared/tools/homer.ts
//
// Homer (reading tracker and what-to-read-next) — Claude's tools. Spec:
// docs/homer-spec-homer-h4k.md phase D; method in .claude/skills/homer/SKILL.md.
//
// Reads (tier 1, s15): get_homer_plan, get_homer_readers, get_homer_devices,
// get_homer_books, search_homer_books, get_homer_series, get_homer_reads,
// get_homer_taste_profiles, get_homer_genres, get_homer_queue, get_homer_quiet_series.
//
// The rules Alex tunes live in the plan row; these tools hold none. Database access
// ONLY through ctx.db, under RLS. Lists go through readTable, or finishRead for an
// RPC's rows. A per-reader tool takes `reader` (a key), default "alex".
// ============================================================================

import { defineTool, finishRead, readTable, requireSettings } from "../platform.ts";
import type { Context } from "../platform.ts";
import { parseReadOptions } from "../platform-read.ts";
import type { ReadOptions } from "../platform-read.ts";
import { dbError, fail, optionalDate, ptDate } from "./claude-notifications.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Query = any;
type Row = Record<string, unknown>;

export const DEFAULT_READER = "alex";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const VERDICTS = ["loved", "liked", "tired", "didnt_click", "never"];
export const QUEUE_STATUS = ["queued", "maybe_later", "reading", "read", "never"];
export const READ_SOURCES = ["export", "clip", "chat"];
export const OWNER_STATUS = ["confirmed", "proposed", "unknown"];
export const SERIES_INCLUDES = ["books", "taste_profile", "genres", "availability"];

const PLAN_COLS = "id, status, version, instructions, settings, change_summary, supersedes_plan_id, written_by, " +
  "ended_at, created_at";

function optionalUuid(tool: string, name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !UUID_RE.test(v)) throw fail(tool, `\`${name}\` must be a UUID, got ${JSON.stringify(v)}.`);
  return v;
}

function optionalText(tool: string, name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim() === "") throw fail(tool, `\`${name}\` must be non-empty text.`);
  return v.trim();
}

function oneOf(tool: string, name: string, v: unknown, allowed: string[]): string[] | null {
  if (v === undefined || v === null) return null;
  const list = Array.isArray(v) ? v : [v];
  const bad = list.find((x) => typeof x !== "string" || !allowed.includes(x));
  if (bad !== undefined || list.length === 0) {
    throw fail(tool, `\`${name}\` must be one of ${allowed.join(", ")} (or a list of them), got ${JSON.stringify(v)}.`);
  }
  return list as string[];
}

/** % and _ are wildcards in ilike; a name or search word is matched literally. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const likeText = (s: string) => `%${escapeLike(s)}%`;

/** Every reader (a handful), as id -> key. */
async function readerKeys(db: Db, tool: string): Promise<Map<string, string>> {
  const { data, error } = await db.from("homer_readers").select("id, key");
  if (error) throw dbError(tool, "readers lookup", error);
  return new Map(((data ?? []) as Row[]).map((r) => [r.id as string, r.key as string]));
}

/** The reader's id for a key; an unknown key names the readers there are. */
async function readerId(db: Db, tool: string, key: unknown): Promise<string> {
  const k = key === undefined || key === null ? DEFAULT_READER : key;
  if (typeof k !== "string" || k.trim() === "") throw fail(tool, "`reader` must be a reader key such as \"alex\".");
  const keys = await readerKeys(db, tool);
  for (const [id, rk] of keys) if (rk === k) return id;
  throw fail(tool, `reader "${k}" not found. Readers: ${[...keys.values()].join(", ") || "(none yet)"}.`);
}

/** RPC rows through the shared tail: filtered in JS, paged by the shared options, shaped by finishRead. */
async function finishRpcRows(
  ctx: Context, tool: string, args: Row, rows: Row[], idKey: string, includes: string[],
  attach?: (rows: Row[], opts: ReadOptions) => Promise<{ rows: Row[]; notes?: string[] }>,
) {
  const settings = await requireSettings(ctx, tool, "homer_series");
  const opts = parseReadOptions(args, settings, includes);
  const chosen = opts.ids ? rows.filter((r) => opts.ids!.includes(r[idKey] as string)) : rows;
  const page = chosen.slice(opts.offset, opts.offset + opts.limit);
  return await finishRead({
    rows: page, total: chosen.length, opts, settings,
    attach: attach ? (r, o) => attach(r, o) : undefined,
  });
}

// ---------------------------------------------------------------------------
// get_homer_plan — tier 1
// ---------------------------------------------------------------------------

export const getHomerPlanTool = defineTool({
  name: "get_homer_plan",
  tables: { reads: ["homer_plans"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_plan";
    if (args.history === true) {
      return await readTable(ctx, {
        tool, table: "homer_plans", args,
        order: [{ column: "version", ascending: false }],
        omit: ["settings", "instructions"],
        fullText: ["change_summary"],
      });
    }
    const planId = optionalUuid(tool, "plan_id", args.plan_id);
    let q = ctx.db.from("homer_plans").select(PLAN_COLS);
    q = planId ? q.eq("id", planId) : q.eq("status", "active");
    const { data, error } = await q.maybeSingle();
    if (error) throw dbError(tool, "plan lookup", error);
    if (!data && planId) throw fail(tool, `plan ${planId} not found.`);
    return { plan: (data as Row | null) ?? null };
  },
});

// ---------------------------------------------------------------------------
// get_homer_readers / get_homer_devices — tier 1
// ---------------------------------------------------------------------------

export const getHomerReadersTool = defineTool({
  name: "get_homer_readers",
  tables: { reads: ["homer_readers"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) =>
    await readTable(ctx, { tool: "get_homer_readers", table: "homer_readers", args,
      order: [{ column: "key", ascending: true }] }),
});

export const getHomerDevicesTool = defineTool({
  name: "get_homer_devices",
  tables: { reads: ["homer_devices", "homer_readers"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_devices";
    const status = oneOf(tool, "owner_status", args.owner_status, OWNER_STATUS);
    const owner = args.reader === undefined || args.reader === null ? null : await readerId(ctx.db, tool, args.reader);
    const keys = await readerKeys(ctx.db, tool);
    return await readTable(ctx, {
      tool, table: "homer_devices", args,
      filter: (q: Query) => {
        let out = q;
        if (status) out = out.in("owner_status", status);
        if (owner) out = out.eq("reader_id", owner);
        return out;
      },
      order: [{ column: "last_session", ascending: false, nullsFirst: false }, { column: "id", ascending: true }],
      attach: async (rows) => ({
        rows: rows.map((r) => ({ ...r, reader: keys.get(r.reader_id as string) ?? null,
          proposed_reader: keys.get(r.proposed_reader_id as string) ?? null })),
      }),
    });
  },
});

// ---------------------------------------------------------------------------
// get_homer_books / search_homer_books — tier 1
// ---------------------------------------------------------------------------

/** Adds each book's series name. */
async function withSeriesNames(db: Db, tool: string, rows: Row[]): Promise<Row[]> {
  const ids = [...new Set(rows.map((r) => r.series_id).filter(Boolean))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, series_name: null }));
  const { data, error } = await db.from("homer_series").select("id, name").in("id", ids);
  if (error) throw dbError(tool, "series lookup", error);
  const names = new Map(((data ?? []) as Row[]).map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...r, series_name: names.get(r.series_id) ?? null }));
}

function booksRead(tool: string, ctx: Context, args: Row, extra: (q: Query) => Query) {
  const asin = optionalText(tool, "asin", args.asin);
  const seriesId = optionalUuid(tool, "series_id", args.series_id);
  return readTable(ctx, {
    tool, table: "homer_books", args,
    filter: (q: Query) => {
      let out = extra(q);
      if (asin) out = out.eq("asin", asin);
      if (seriesId) out = out.eq("series_id", seriesId);
      return out;
    },
    order: [{ column: "series_id", ascending: true }, { column: "series_position", ascending: true },
      { column: "title", ascending: true }],
    attach: async (rows) => ({ rows: await withSeriesNames(ctx.db, tool, rows) }),
  });
}

export const getHomerBooksTool = defineTool({
  name: "get_homer_books",
  tables: { reads: ["homer_books", "homer_series"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => await booksRead("get_homer_books", ctx, args, (q) => q),
});

export const searchHomerBooksTool = defineTool({
  name: "search_homer_books",
  tables: { reads: ["homer_books", "homer_series"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "search_homer_books";
    const text = optionalText(tool, "text", args.text);
    const author = optionalText(tool, "author", args.author);
    if (!text && !author) throw fail(tool, "pass `text` (words in the title) or `author`.");
    return await booksRead(tool, ctx, args, (q) => {
      let out = q;
      if (text) out = out.ilike("title", likeText(text));
      if (author) out = out.ilike("author", likeText(author));
      return out;
    });
  },
});

// ---------------------------------------------------------------------------
// get_homer_series — tier 1 (homer_series_verdicts, plus includes for calibration)
// ---------------------------------------------------------------------------

async function seriesAttach(db: Db, tool: string, rows: Row[], include: string[], readerIdValue: string) {
  const ids = rows.map((r) => r.series_id as string);
  const cols = "id, author, notes" +
    (include.includes("availability")
      ? ", available_position, upcoming_position, upcoming_release_date, availability_checked_on, availability_source"
      : "");
  const series = await db.from("homer_series").select(cols).in("id", ids);
  if (series.error) throw dbError(tool, "series lookup", series.error);
  const byId = new Map(((series.data ?? []) as Row[]).map((s) => [s.id, s]));

  const books = new Map<string, Row[]>();
  if (include.includes("books")) {
    const { data, error } = await db.from("homer_books").select("id, asin, title, author, series_id, series_position")
      .in("series_id", ids).order("series_position", { ascending: true });
    if (error) throw dbError(tool, "books lookup", error);
    for (const b of (data ?? []) as Row[]) {
      const { series_id, ...rest } = b;
      books.set(series_id as string, [...(books.get(series_id as string) ?? []), rest]);
    }
  }
  const profiles = new Map<string, Row>();
  if (include.includes("taste_profile")) {
    const { data, error } = await db.from("homer_taste_profiles").select("id, series_id, description, scores, plan_id, updated_at")
      .eq("reader_id", readerIdValue).in("series_id", ids);
    if (error) throw dbError(tool, "taste profiles lookup", error);
    for (const p of (data ?? []) as Row[]) profiles.set(p.series_id as string, p);
  }
  const genres = new Map<string, Row[]>();
  if (include.includes("genres")) {
    const links = await db.from("homer_genre_series").select("genre_id, series_id, is_example").in("series_id", ids);
    if (links.error) throw dbError(tool, "genre links lookup", links.error);
    const gids = [...new Set(((links.data ?? []) as Row[]).map((l) => l.genre_id))];
    const names = new Map<unknown, Row>();
    if (gids.length > 0) {
      const g = await db.from("homer_genres").select("id, name, status, archived_at").in("id", gids);
      if (g.error) throw dbError(tool, "genres lookup", g.error);
      for (const row of (g.data ?? []) as Row[]) if (!row.archived_at) names.set(row.id, row);
    }
    for (const l of (links.data ?? []) as Row[]) {
      const g = names.get(l.genre_id);
      if (!g) continue;
      genres.set(l.series_id as string, [...(genres.get(l.series_id as string) ?? []),
        { genre_id: g.id, name: g.name, status: g.status, is_example: l.is_example }]);
    }
  }
  return rows.map((r) => {
    const s = byId.get(r.series_id) ?? {};
    const { id: _id, ...fields } = s as Row;
    return {
      ...r, ...fields,
      ...(include.includes("books") ? { books: books.get(r.series_id as string) ?? [] } : {}),
      ...(include.includes("taste_profile") ? { taste_profile: profiles.get(r.series_id as string) ?? null } : {}),
      ...(include.includes("genres") ? { genres: genres.get(r.series_id as string) ?? [] } : {}),
    };
  });
}

export const getHomerSeriesTool = defineTool({
  name: "get_homer_series",
  tables: {
    reads: ["homer_series", "homer_readers", "homer_plans", "homer_reads", "homer_books", "homer_verdicts",
      "homer_taste_profiles", "homer_genre_series", "homer_genres"],
    writes: [],
  },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_series";
    const key = (args.reader as string | undefined) ?? DEFAULT_READER;
    const rid = await readerId(ctx.db, tool, key);
    const verdicts = oneOf(tool, "verdict", args.verdict, VERDICTS);
    const name = optionalText(tool, "name", args.name)?.toLowerCase() ?? null;
    if (args.is_default !== undefined && typeof args.is_default !== "boolean") {
      throw fail(tool, "`is_default` must be true or false.");
    }
    const { data, error } = await ctx.db.rpc("homer_series_verdicts", { p_reader_key: key });
    if (error) throw dbError(tool, "homer_series_verdicts", error);
    const rows = ((data ?? []) as Row[]).filter((r) =>
      (!verdicts || verdicts.includes(r.verdict as string)) &&
      (args.is_default === undefined || r.is_default === args.is_default) &&
      (!name || String(r.series_name ?? "").toLowerCase().includes(name)));
    return await finishRpcRows(ctx, tool, args, rows, "series_id", SERIES_INCLUDES,
      async (page, opts) => ({ rows: await seriesAttach(ctx.db, tool, page, opts.include, rid) }));
  },
});

// ---------------------------------------------------------------------------
// get_homer_reads — tier 1
// ---------------------------------------------------------------------------

/** The PostgREST or() for a date range on finished_on, or started_on for unfinished reads. */
export function readRange(from: string | null, to: string | null): string | null {
  if (!from && !to) return null;
  const bound = (col: string) => [from && `${col}.gte.${from}`, to && `${col}.lte.${to}`].filter(Boolean).join(",");
  return `and(${bound("finished_on")}),and(finished_on.is.null,${bound("started_on")})`;
}

export const getHomerReadsTool = defineTool({
  name: "get_homer_reads",
  tables: { reads: ["homer_reads", "homer_readers", "homer_books", "homer_series"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_reads";
    const readerArg = args.reader ?? DEFAULT_READER;
    const rid = readerArg === "any" || readerArg === "none" ? null : await readerId(ctx.db, tool, readerArg);
    const sources = oneOf(tool, "source", args.source, READ_SOURCES);
    const bookId = optionalUuid(tool, "book_id", args.book_id);
    const seriesId = optionalUuid(tool, "series_id", args.series_id);
    const from = optionalDate(tool, "date_from", args.date_from);
    const to = optionalDate(tool, "date_to", args.date_to);
    if (args.finished !== undefined && typeof args.finished !== "boolean") throw fail(tool, "`finished` must be true or false.");
    let seriesBooks: string[] | null = null;
    if (seriesId) {
      const { data, error } = await ctx.db.from("homer_books").select("id").eq("series_id", seriesId);
      if (error) throw dbError(tool, "series books lookup", error);
      seriesBooks = ((data ?? []) as Row[]).map((b) => b.id as string);
      if (seriesBooks.length === 0) seriesBooks = ["00000000-0000-0000-0000-000000000000"];
    }
    const keys = await readerKeys(ctx.db, tool);
    return await readTable(ctx, {
      tool, table: "homer_reads", args,
      filter: (q: Query) => {
        let out = q;
        if (rid) out = out.eq("reader_id", rid);
        if (readerArg === "none") out = out.is("reader_id", null);
        if (sources) out = out.in("source", sources);
        if (bookId) out = out.eq("book_id", bookId);
        if (seriesBooks) out = out.in("book_id", seriesBooks);
        if (args.finished === true) out = out.not("finished_on", "is", null);
        if (args.finished === false) out = out.is("finished_on", null);
        // A read is in the range when it finished in it, or (unfinished) started in it. One or(): two would clash.
        const range = readRange(from, to);
        if (range) out = out.or(range);
        return out;
      },
      order: [{ column: "finished_on", ascending: false, nullsFirst: false },
        { column: "started_on", ascending: false, nullsFirst: false }, { column: "id", ascending: true }],
      attach: async (rows) => {
        const ids = [...new Set(rows.map((r) => r.book_id))];
        const { data, error } = await ctx.db.from("homer_books").select("id, asin, title, author, series_id, series_position")
          .in("id", ids);
        if (error) throw dbError(tool, "books lookup", error);
        const books = await withSeriesNames(ctx.db, tool, (data ?? []) as Row[]);
        const byId = new Map(books.map((b) => [b.id, b]));
        return {
          rows: rows.map((r) => {
            const b = byId.get(r.book_id) ?? {};
            return { ...r, reader: keys.get(r.reader_id as string) ?? null, asin: b.asin ?? null, title: b.title ?? null,
              author: b.author ?? null, series_id: b.series_id ?? null, series_name: b.series_name ?? null,
              series_position: b.series_position ?? null };
          }),
        };
      },
    });
  },
});

// ---------------------------------------------------------------------------
// get_homer_taste_profiles — tier 1
// ---------------------------------------------------------------------------

export const getHomerTasteProfilesTool = defineTool({
  name: "get_homer_taste_profiles",
  tables: { reads: ["homer_taste_profiles", "homer_readers", "homer_series"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_taste_profiles";
    const rid = await readerId(ctx.db, tool, args.reader);
    const seriesId = optionalUuid(tool, "series_id", args.series_id);
    return await readTable(ctx, {
      tool, table: "homer_taste_profiles", args,
      filter: (q: Query) => (seriesId ? q.eq("reader_id", rid).eq("series_id", seriesId) : q.eq("reader_id", rid)),
      order: [{ column: "updated_at", ascending: false }, { column: "id", ascending: true }],
      fullText: ["description", "scores"],
      attach: async (rows) => ({ rows: await withSeriesNames(ctx.db, tool, rows) }),
    });
  },
});

// ---------------------------------------------------------------------------
// get_homer_genres — tier 1
// ---------------------------------------------------------------------------

export const getHomerGenresTool = defineTool({
  name: "get_homer_genres",
  tables: { reads: ["homer_genres", "homer_genre_series", "homer_series"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_genres";
    const status = oneOf(tool, "status", args.status, ["proposed", "accepted"]);
    return await readTable(ctx, {
      tool, table: "homer_genres", args,
      filter: (q: Query) => {
        let out = args.include_archived === true || (args.ids as unknown[] | undefined) ? q : q.is("archived_at", null);
        if (status) out = out.in("status", status);
        return out;
      },
      order: [{ column: "sort_order", ascending: true, nullsFirst: false }, { column: "name", ascending: true }],
      fullText: ["description"],
      attach: async (rows) => {
        const ids = rows.map((r) => r.id);
        const links = await ctx.db.from("homer_genre_series").select("genre_id, series_id, is_example").in("genre_id", ids);
        if (links.error) throw dbError(tool, "genre series lookup", links.error);
        const named = await withSeriesNames(ctx.db, tool, (links.data ?? []) as Row[]);
        return {
          rows: rows.map((r) => ({
            ...r,
            series: named.filter((l) => l.genre_id === r.id)
              .map((l) => ({ series_id: l.series_id, name: l.series_name, is_example: l.is_example })),
          })),
        };
      },
    });
  },
});

// ---------------------------------------------------------------------------
// get_homer_queue — tier 1
// ---------------------------------------------------------------------------

export const getHomerQueueTool = defineTool({
  name: "get_homer_queue",
  tables: { reads: ["homer_queue_items", "homer_readers", "homer_genres"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_queue";
    const rid = await readerId(ctx.db, tool, args.reader);
    const status = oneOf(tool, "status", args.status, QUEUE_STATUS);
    const genreId = optionalUuid(tool, "genre_id", args.genre_id);
    if (genreId && args.unsorted === true) throw fail(tool, "pass `genre_id` or `unsorted`, not both.");
    return await readTable(ctx, {
      tool, table: "homer_queue_items", args,
      filter: (q: Query) => {
        let out = q.eq("reader_id", rid);
        if (args.include_archived !== true && !args.ids) out = out.is("archived_at", null);
        if (status) out = out.in("status", status);
        if (genreId) out = out.eq("genre_id", genreId);
        if (args.unsorted === true) out = out.is("genre_id", null);
        return out;
      },
      order: [{ column: "genre_id", ascending: true, nullsFirst: false }, { column: "position", ascending: true },
        { column: "id", ascending: true }],
      fullText: ["why"],
      attach: async (rows) => {
        const gids = [...new Set(rows.map((r) => r.genre_id).filter(Boolean))];
        const names = new Map<unknown, unknown>();
        if (gids.length > 0) {
          const { data, error } = await ctx.db.from("homer_genres").select("id, name").in("id", gids);
          if (error) throw dbError(tool, "genres lookup", error);
          for (const g of (data ?? []) as Row[]) names.set(g.id, g.name);
        }
        return { rows: rows.map((r) => ({ ...r, genre_name: r.genre_id ? names.get(r.genre_id) ?? null : null })) };
      },
    });
  },
});

// ---------------------------------------------------------------------------
// get_homer_quiet_series — tier 1 (homer_quiet_series)
// ---------------------------------------------------------------------------

export const getHomerQuietSeriesTool = defineTool({
  name: "get_homer_quiet_series",
  tables: { reads: ["homer_plans", "homer_readers", "homer_reads", "homer_books", "homer_series", "homer_verdicts"],
    writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_homer_quiet_series";
    const key = (args.reader as string | undefined) ?? DEFAULT_READER;
    await readerId(ctx.db, tool, key);
    const { data, error } = await ctx.db.rpc("homer_quiet_series", { p_reader_key: key });
    if (error) throw dbError(tool, "homer_quiet_series", error);
    // only_quiet: what the Homer tab's "gone quiet" list shows (tired series only once past their gap).
    const rows = ((data ?? []) as Row[]).filter((r) => args.only_quiet !== true ||
      (r.verdict === "tired" ? r.tired_gap_passed === true : r.is_quiet === true));
    return await finishRpcRows(ctx, tool, args, rows, "series_id", []);
  },
});

// ===========================================================================
// Writes (s15b)
// ===========================================================================

export const LIKE_VERDICTS = ["loved", "liked", "tired", "didnt_click"];
export const MAX_QUEUE_ITEMS = 20;
const ACQUIRED = ["purchase", "kindle_unlimited", "prime_reading", "sample", "library", "other"];

function requireUuid(tool: string, name: string, v: unknown): string {
  const id = optionalUuid(tool, name, v);
  if (!id) throw fail(tool, `\`${name}\` is required.`);
  return id;
}

function requireText(tool: string, name: string, v: unknown): string {
  const t = optionalText(tool, name, v);
  if (!t) throw fail(tool, `\`${name}\` is required.`);
  return t;
}

/** A number > 0, null to clear, undefined to leave alone. */
function positiveOrNull(tool: string, name: string, v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw fail(tool, `\`${name}\` must be a number above 0, or null.`);
  return v;
}

/** A date "YYYY-MM-DD", null to clear, undefined to leave alone. */
function dateOrNull(tool: string, name: string, v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return optionalDate(tool, name, v);
}

function oneValue(tool: string, name: string, v: unknown, allowed: string[]): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) throw fail(tool, `\`${name}\` must be one of ${allowed.join(", ")}.`);
  return v;
}

/** Exactly one of series_id, book_id or author: the subject of a verdict. */
function verdictSubject(tool: string, args: Row): { kind: string; column: string; value: string } {
  const given = [
    args.series_id !== undefined && args.series_id !== null ? { kind: "series", column: "series_id", value: requireUuid(tool, "series_id", args.series_id) } : null,
    args.book_id !== undefined && args.book_id !== null ? { kind: "book", column: "book_id", value: requireUuid(tool, "book_id", args.book_id) } : null,
    args.author !== undefined && args.author !== null ? { kind: "author", column: "author", value: requireText(tool, "author", args.author) } : null,
  ].filter(Boolean) as { kind: string; column: string; value: string }[];
  if (given.length !== 1) throw fail(tool, "pass exactly one of `series_id`, `book_id` or `author`.");
  return given[0];
}

async function findVerdict(db: Db, tool: string, readerIdValue: string, s: { kind: string; column: string; value: string }) {
  let q = db.from("homer_verdicts").select("id, verdict, note, set_by").eq("reader_id", readerIdValue).eq("subject_kind", s.kind);
  q = s.kind === "author" ? q.ilike("author", escapeLike(s.value)) : q.eq(s.column, s.value);
  const { data, error } = await q.maybeSingle();
  if (error) throw dbError(tool, "verdict lookup", error);
  return (data as Row | null) ?? null;
}

/** Insert or update the reader's verdict on a subject (the unique indexes are partial, so no upsert). */
async function writeVerdict(db: Db, tool: string, readerIdValue: string, s: { kind: string; column: string; value: string },
  existing: Row | null, fields: { verdict: string; note?: string | null; set_by: string }) {
  const row = { verdict: fields.verdict, set_by: fields.set_by, ...(fields.note !== undefined ? { note: fields.note } : {}) };
  const res = existing
    ? await db.from("homer_verdicts").update(row).eq("id", existing.id).select().single()
    : await db.from("homer_verdicts").insert({ reader_id: readerIdValue, subject_kind: s.kind, [s.column]: s.value, ...row })
      .select().single();
  if (res.error) throw dbError(tool, "verdict write", res.error);
  return res.data as Row;
}

/** A readable name for a verdict's subject: the series name, the book title, or the author. */
async function subjectName(db: Db, tool: string, s: { kind: string; value: string }): Promise<string> {
  if (s.kind === "author") return s.value;
  const table = s.kind === "series" ? "homer_series" : "homer_books";
  const { data, error } = await db.from(table).select(s.kind === "series" ? "id, name" : "id, title").eq("id", s.value).maybeSingle();
  if (error) throw dbError(tool, `${s.kind} lookup`, error);
  if (!data) throw fail(tool, `${s.kind} ${s.value} not found.`);
  return ((data as Row).name ?? (data as Row).title) as string;
}

// ---------------------------------------------------------------------------
// create_homer_book — tier 1 (through homer_import_batch, the one upsert path)
// ---------------------------------------------------------------------------

export const createHomerBookTool = defineTool({
  name: "create_homer_book",
  tables: { reads: ["homer_books", "homer_series"], writes: ["homer_books", "homer_series"] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_homer_book";
    const asin = requireText(tool, "asin", args.asin);
    const title = requireText(tool, "title", args.title);
    const author = optionalText(tool, "author", args.author);
    const seriesAsin = optionalText(tool, "series_asin", args.series_asin);
    const seriesName = optionalText(tool, "series_name", args.series_name);
    const position = positiveOrNull(tool, "series_position", args.series_position) ?? null;
    const acquired = oneValue(tool, "acquired", args.acquired, ACQUIRED) ?? null;
    if (position !== null && !seriesAsin && !seriesName) throw fail(tool, "`series_position` needs `series_asin` or `series_name`.");

    const existing = await ctx.db.from("homer_books").select("id, asin, title, author, series_id, series_position").eq("asin", asin).maybeSingle();
    if (existing.error) throw dbError(tool, "book lookup", existing.error);
    if (existing.data) return { created: false, book: existing.data, note: "Homer already has this ASIN; nothing was changed." };

    // An existing series is referenced, never re-sent, so a slightly different name can't rename it.
    const series: Row[] = [];
    if (seriesAsin || seriesName) {
      let q = ctx.db.from("homer_series").select("id");
      q = seriesAsin ? q.eq("series_asin", seriesAsin) : q.is("series_asin", null).ilike("name", escapeLike(seriesName!));
      const found = await q.maybeSingle();
      if (found.error) throw dbError(tool, "series lookup", found.error);
      if (!found.data) {
        if (!seriesName) throw fail(tool, `series ${seriesAsin} is new to Homer: pass \`series_name\` too.`);
        series.push({ name: seriesName, series_asin: seriesAsin, author });
      }
    }
    const book = { asin, title, author, series_asin: seriesAsin, series_name: seriesAsin ? null : seriesName,
      series_position: position, acquired };
    const { data, error } = await ctx.db.rpc("homer_import_batch", { p_batch: { series, books: [book] }, p_dry_run: false });
    if (error) throw dbError(tool, "homer_import_batch", error);
    const refused = ((data as Row)?.refused ?? []) as Row[];
    if (refused.length > 0) {
      throw fail(tool, `refused: ${refused.map((r) => `${r.kind} ${r.key}: ${r.reason}`).join("; ")}`);
    }
    const out = await ctx.db.from("homer_books").select("id, asin, title, author, series_id, series_position, acquired").eq("asin", asin).maybeSingle();
    if (out.error) throw dbError(tool, "book read-back", out.error);
    return { created: true, book: out.data, series_created: series.length > 0 };
  },
});

// ---------------------------------------------------------------------------
// create_homer_read — tier 1 (a read from chat or the weekly clip)
// ---------------------------------------------------------------------------

export const createHomerReadTool = defineTool({
  name: "create_homer_read",
  tables: { reads: ["homer_books", "homer_readers", "homer_reads"], writes: ["homer_reads"] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_homer_read";
    const asin = requireText(tool, "asin", args.asin);
    const source = oneValue(tool, "source", args.source, ["chat", "clip"]) ?? "chat";
    const started = optionalDate(tool, "started_on", args.started_on);
    const finished = optionalDate(tool, "finished_on", args.finished_on);
    const hours = args.hours === undefined || args.hours === null ? null : positiveOrNull(tool, "hours", args.hours);
    if (started && finished && finished < started) throw fail(tool, "`finished_on` can't be before `started_on`.");
    if (!started && !finished) throw fail(tool, "pass `started_on`, `finished_on` or both.");
    const rid = await readerId(ctx.db, tool, args.reader);

    const book = await ctx.db.from("homer_books").select("id, title").eq("asin", asin).maybeSingle();
    if (book.error) throw dbError(tool, "book lookup", book.error);
    if (!book.data) throw fail(tool, `Homer has no book with ASIN ${asin}. Add it with create_homer_book first, then record the read.`);

    // An open clip or chat read is finished with update_homer_read, not duplicated. (An open export read is left
    // alone: the next import would overwrite a finish written onto it.)
    const open = await ctx.db.from("homer_reads").select("id, source, started_on").eq("book_id", (book.data as Row).id)
      .eq("reader_id", rid).is("finished_on", null).in("source", ["chat", "clip"]);
    if (open.error) throw dbError(tool, "open read lookup", open.error);
    const openRows = (open.data ?? []) as Row[];
    if (openRows.length > 0) {
      throw fail(tool, `"${(book.data as Row).title}" already has an open ${openRows[0].source} read (id ${openRows[0].id}, started ` +
        `${openRows[0].started_on ?? "unknown"}). Finish or fix it with update_homer_read instead.`);
    }
    const row = { book_id: (book.data as Row).id, reader_id: rid, started_on: started, finished_on: finished, hours, source,
      import_key: `${source}:${finished ?? started}:${asin}` };
    const { data, error } = await ctx.db.from("homer_reads").insert(row).select().single();
    if (error) {
      if (error.code === "23505") throw fail(tool, `a ${source} read of this book on ${finished ?? started} is already recorded.`);
      throw dbError(tool, "read insert", error);
    }
    return data;
  },
});

// ---------------------------------------------------------------------------
// create_homer_queue_items — tier 1 (verified suggestions only)
// ---------------------------------------------------------------------------

export const createHomerQueueItemsTool = defineTool({
  name: "create_homer_queue_items",
  tables: { reads: ["homer_readers", "homer_queue_items"], writes: ["homer_queue_items"] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_homer_queue_items";
    const items = args.items;
    if (!Array.isArray(items) || items.length === 0) throw fail(tool, "`items` must be a non-empty array.");
    if (items.length > MAX_QUEUE_ITEMS) throw fail(tool, `at most ${MAX_QUEUE_ITEMS} items per call.`);
    const rid = await readerId(ctx.db, tool, args.reader);
    // Every item is checked before anything is written; the insert is one statement, so all or nothing.
    const rows = (items as Row[]).map((it, i) => {
      const at = `items[${i}]`;
      const verified = optionalDate(tool, `${at}.verified_on`, it.verified_on);
      if (!verified) throw fail(tool, `${at}: \`verified_on\` is required. Check the book exists (web search) before queueing it.`);
      const ku = it.on_kindle_unlimited;
      if (ku !== undefined && ku !== null && typeof ku !== "boolean") throw fail(tool, `${at}.on_kindle_unlimited must be true or false.`);
      const kuOn = optionalDate(tool, `${at}.ku_checked_on`, it.ku_checked_on);
      if (ku !== undefined && ku !== null && !kuOn) throw fail(tool, `${at}: \`on_kindle_unlimited\` needs \`ku_checked_on\`.`);
      return {
        reader_id: rid, title: requireText(tool, `${at}.title`, it.title), author: optionalText(tool, `${at}.author`, it.author),
        asin: optionalText(tool, `${at}.asin`, it.asin), kind: oneValue(tool, `${at}.kind`, it.kind, ["book", "series", "pick_up_again"]) ?? "book",
        genre_id: optionalUuid(tool, `${at}.genre_id`, it.genre_id), series_id: optionalUuid(tool, `${at}.series_id`, it.series_id),
        book_id: optionalUuid(tool, `${at}.book_id`, it.book_id), why: optionalText(tool, `${at}.why`, it.why),
        on_kindle_unlimited: ku ?? null, ku_checked_on: kuOn, verified_on: verified,
        status: oneValue(tool, `${at}.status`, it.status, QUEUE_STATUS) ?? "queued", created_by: "claude",
      } as Row;
    });
    // Appended at the end of each genre's live queue.
    const genres = [...new Set(rows.map((r) => r.genre_id))];
    const last = new Map<unknown, number>();
    for (const g of genres) {
      let q = ctx.db.from("homer_queue_items").select("position").eq("reader_id", rid).is("archived_at", null);
      q = g ? q.eq("genre_id", g) : q.is("genre_id", null);
      const { data, error } = await q.order("position", { ascending: false }).limit(1);
      if (error) throw dbError(tool, "queue position lookup", error);
      last.set(g, Number(((data ?? []) as Row[])[0]?.position ?? 0));
    }
    for (const r of rows) {
      const next = (last.get(r.genre_id) ?? 0) + 1;
      last.set(r.genre_id, next);
      r.position = next;
    }
    const { data, error } = await ctx.db.from("homer_queue_items").insert(rows).select();
    if (error) {
      if (error.code === "23505") throw fail(tool, "one of these ASINs is already a live queue item for this reader; nothing was added.");
      throw dbError(tool, "queue insert", error);
    }
    return data;
  },
});

// ---------------------------------------------------------------------------
// update_homer_device — tier 2 (propose or confirm an owner)
// ---------------------------------------------------------------------------

export const updateHomerDeviceTool = defineTool({
  name: "update_homer_device",
  tables: { reads: ["homer_devices", "homer_readers"], writes: ["homer_devices"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_homer_device";
    const deviceId = requireText(tool, "device_id", args.device_id);
    const propose = args.propose_owner;
    const confirm = args.confirm_owner;
    if ((propose === undefined || propose === null) === (confirm === undefined || confirm === null)) {
      throw fail(tool, "pass exactly one of `propose_owner` or `confirm_owner` (a reader key).");
    }
    const reason = optionalText(tool, "owner_reason", args.owner_reason);
    const found = await ctx.db.from("homer_devices").select("id, reader_id, proposed_reader_id").eq("device_id", deviceId).maybeSingle();
    if (found.error) throw dbError(tool, "device lookup", found.error);
    if (!found.data) throw fail(tool, `device ${deviceId} not found.`);
    const keys = await readerKeys(ctx.db, tool);
    let patch: Row;
    if (propose !== undefined && propose !== null) {
      const rid = await readerId(ctx.db, tool, propose);
      if ((found.data as Row).reader_id) {
        throw fail(tool, `device ${deviceId} is already confirmed as ${keys.get((found.data as Row).reader_id as string)}. ` +
          "Use confirm_owner to change a confirmed owner.");
      }
      patch = { proposed_reader_id: rid, ...(reason ? { owner_reason: reason } : {}) };
    } else {
      // Confirming sets the owner and clears the proposal; the database moves the device's reads to the reader.
      patch = { reader_id: await readerId(ctx.db, tool, confirm), proposed_reader_id: null, ...(reason ? { owner_reason: reason } : {}) };
    }
    const { data, error } = await ctx.db.from("homer_devices").update(patch).eq("id", (found.data as Row).id).select().single();
    if (error) throw dbError(tool, "device update", error);
    const row = data as Row;
    return { ...row, reader: keys.get(row.reader_id as string) ?? null, proposed_reader: keys.get(row.proposed_reader_id as string) ?? null };
  },
});

// ---------------------------------------------------------------------------
// update_homer_series — tier 2 (notes and availability)
// ---------------------------------------------------------------------------

export const AVAILABILITY_FIELDS = ["available_position", "upcoming_position", "upcoming_release_date",
  "availability_checked_on", "availability_source"];

export const updateHomerSeriesTool = defineTool({
  name: "update_homer_series",
  tables: { reads: ["homer_series"], writes: ["homer_series"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_homer_series";
    const id = requireUuid(tool, "series_id", args.series_id);
    const patch: Row = {};
    if (args.notes !== undefined) patch.notes = args.notes === null ? null : requireText(tool, "notes", args.notes);
    const avail = positiveOrNull(tool, "available_position", args.available_position);
    const up = positiveOrNull(tool, "upcoming_position", args.upcoming_position);
    const release = dateOrNull(tool, "upcoming_release_date", args.upcoming_release_date);
    const checked = dateOrNull(tool, "availability_checked_on", args.availability_checked_on);
    if (avail !== undefined) patch.available_position = avail;
    if (up !== undefined) patch.upcoming_position = up;
    if (release !== undefined) patch.upcoming_release_date = release;
    if (args.availability_source !== undefined) {
      patch.availability_source = args.availability_source === null ? null : requireText(tool, "availability_source", args.availability_source);
    }
    if (Object.keys(patch).length === 0 && checked === undefined) throw fail(tool, "nothing to change.");
    if (typeof avail === "number" && typeof up === "number" && up <= avail) {
      throw fail(tool, "`upcoming_position` must be after `available_position`: an announced book is never already out.");
    }
    if (release && up === null) throw fail(tool, "`upcoming_release_date` needs an `upcoming_position`.");
    // An availability check is dated: today unless given.
    const touched = AVAILABILITY_FIELDS.some((f) => f !== "availability_checked_on" && f in patch);
    if (checked !== undefined) patch.availability_checked_on = checked;
    else if (touched) patch.availability_checked_on = ptDate();
    const { data, error } = await ctx.db.from("homer_series").update(patch).eq("id", id).select().maybeSingle();
    if (error) throw dbError(tool, "series update", error);
    if (!data) throw fail(tool, `series ${id} not found.`);
    return data;
  },
});

// ---------------------------------------------------------------------------
// update_homer_read — tier 2
// ---------------------------------------------------------------------------

export const updateHomerReadTool = defineTool({
  name: "update_homer_read",
  tables: { reads: ["homer_reads", "homer_readers"], writes: ["homer_reads"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_homer_read";
    const id = requireUuid(tool, "read_id", args.read_id);
    const patch: Row = {};
    const started = dateOrNull(tool, "started_on", args.started_on);
    const finished = dateOrNull(tool, "finished_on", args.finished_on);
    if (started !== undefined) patch.started_on = started;
    if (finished !== undefined) patch.finished_on = finished;
    if (args.hours !== undefined) patch.hours = args.hours === null ? null : positiveOrNull(tool, "hours", args.hours);
    if (args.reader !== undefined) patch.reader_id = await readerId(ctx.db, tool, args.reader);
    if (args.completion !== undefined) {
      patch.completion = args.completion === null ? null : oneValue(tool, "completion", args.completion, ["manual"]);
    }
    if (finished === null && args.completion === undefined) patch.completion = null; // un-finishing drops the completion
    if (Object.keys(patch).length === 0) throw fail(tool, "nothing to change.");
    const cur = await ctx.db.from("homer_reads").select("id, source, started_on, finished_on").eq("id", id).maybeSingle();
    if (cur.error) throw dbError(tool, "read lookup", cur.error);
    if (!cur.data) throw fail(tool, `read ${id} not found.`);
    const s = (patch.started_on !== undefined ? patch.started_on : (cur.data as Row).started_on) as string | null;
    const f = (patch.finished_on !== undefined ? patch.finished_on : (cur.data as Row).finished_on) as string | null;
    if (s && f && f < s) throw fail(tool, "the finish can't be before the start.");
    const { data, error } = await ctx.db.from("homer_reads").update(patch).eq("id", id).select().single();
    if (error) throw dbError(tool, "read update", error);
    const datesChanged = ["started_on", "finished_on", "hours", "completion"].some((k) => k in patch);
    return (cur.data as Row).source === "export" && datesChanged
      ? { read: data, note: "This is an export read: the next import re-run resets its dates, hours and completion from the export. The reader is kept." }
      : { read: data };
  },
});

// ---------------------------------------------------------------------------
// update_homer_verdict — tier 2 (never goes through create_homer_never)
// ---------------------------------------------------------------------------

export const updateHomerVerdictTool = defineTool({
  name: "update_homer_verdict",
  tables: { reads: ["homer_verdicts", "homer_readers"], writes: ["homer_verdicts"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_homer_verdict";
    if (args.verdict === "never") throw fail(tool, "a never is set only with create_homer_never, when Alex says it.");
    const verdict = oneValue(tool, "verdict", args.verdict, LIKE_VERDICTS);
    if (!verdict) throw fail(tool, `\`verdict\` is required: one of ${LIKE_VERDICTS.join(", ")}.`);
    const subject = verdictSubject(tool, args);
    const rid = await readerId(ctx.db, tool, args.reader);
    const existing = await findVerdict(ctx.db, tool, rid, subject);
    if (existing?.verdict === "never") {
      throw fail(tool, "this is a never. Only Alex lifts one: use create_homer_never with lift: true and the new verdict.");
    }
    const note = args.note === undefined ? undefined : args.note === null ? null : requireText(tool, "note", args.note);
    return await writeVerdict(ctx.db, tool, rid, subject, existing, { verdict, note, set_by: "claude" });
  },
});

// ---------------------------------------------------------------------------
// update_homer_taste_profile — tier 2 (scores checked early against the active plan)
// ---------------------------------------------------------------------------

export const updateHomerTasteProfileTool = defineTool({
  name: "update_homer_taste_profile",
  tables: { reads: ["homer_taste_profiles", "homer_readers", "homer_plans"], writes: ["homer_taste_profiles"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_homer_taste_profile";
    const seriesId = requireUuid(tool, "series_id", args.series_id);
    const rid = await readerId(ctx.db, tool, args.reader);
    const patch: Row = {};
    if (args.description !== undefined) patch.description = args.description === null ? null : requireText(tool, "description", args.description);
    if (args.scores !== undefined) {
      if (args.scores === null || typeof args.scores !== "object" || Array.isArray(args.scores)) {
        throw fail(tool, "`scores` must be an object keyed by the plan's scale keys.");
      }
      const plan = await ctx.db.from("homer_plans").select("settings").eq("status", "active").maybeSingle();
      if (plan.error) throw dbError(tool, "plan lookup", plan.error);
      if (!plan.data) throw fail(tool, "there is no Homer plan yet, so there are no scales to score against. Save plan v1 first.");
      const check = await ctx.db.rpc("homer_scores_problem", { p_scores: args.scores, p_settings: (plan.data as Row).settings });
      if (check.error) throw dbError(tool, "homer_scores_problem", check.error);
      if (check.data) throw fail(tool, `scores refused: ${check.data}.`);
      patch.scores = args.scores;
    }
    if (Object.keys(patch).length === 0) throw fail(tool, "pass `description`, `scores` or both.");
    const cur = await ctx.db.from("homer_taste_profiles").select("id").eq("reader_id", rid).eq("series_id", seriesId).maybeSingle();
    if (cur.error) throw dbError(tool, "profile lookup", cur.error);
    const res = cur.data
      ? await ctx.db.from("homer_taste_profiles").update(patch).eq("id", (cur.data as Row).id).select().single()
      : await ctx.db.from("homer_taste_profiles").insert({ reader_id: rid, series_id: seriesId, ...patch }).select().single();
    if (res.error) throw dbError(tool, "profile write", res.error);
    return res.data;
  },
});

// ---------------------------------------------------------------------------
// update_homer_genre — tier 2 (the genre, then its series)
// ---------------------------------------------------------------------------

export const updateHomerGenreTool = defineTool({
  name: "update_homer_genre",
  tables: { reads: ["homer_genres", "homer_genre_series"], writes: ["homer_genres", "homer_genre_series"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_homer_genre";
    const genreId = optionalUuid(tool, "genre_id", args.genre_id);
    const name = optionalText(tool, "name", args.name);
    if (!genreId && !name) throw fail(tool, "pass `genre_id` to edit a genre, or `name` to create one (or find it by name).");
    const patch: Row = {};
    if (name && genreId) patch.name = name;
    if (args.description !== undefined) patch.description = args.description === null ? null : requireText(tool, "description", args.description);
    const status = oneValue(tool, "status", args.status, ["proposed", "accepted"]);
    if (status) patch.status = status;
    if (args.sort_order !== undefined) {
      if (typeof args.sort_order !== "number" || !Number.isInteger(args.sort_order)) throw fail(tool, "`sort_order` must be a whole number.");
      patch.sort_order = args.sort_order;
    }
    if (args.archived === true) patch.archived_at = new Date().toISOString();
    if (args.archived === false) patch.archived_at = null;
    const series = args.series;
    if (series !== undefined && (!Array.isArray(series) || series.length > 50)) throw fail(tool, "`series` must be an array of at most 50.");
    const links = ((series ?? []) as Row[]).map((s, i) => ({
      series_id: requireUuid(tool, `series[${i}].series_id`, s.series_id),
      is_example: s.is_example === undefined ? false : s.is_example === true,
    }));

    let genre: Row;
    if (genreId) {
      const res = Object.keys(patch).length > 0
        ? await ctx.db.from("homer_genres").update(patch).eq("id", genreId).select().maybeSingle()
        : await ctx.db.from("homer_genres").select().eq("id", genreId).maybeSingle();
      if (res.error) throw dbError(tool, "genre write", res.error);
      if (!res.data) throw fail(tool, `genre ${genreId} not found.`);
      genre = res.data as Row;
    } else {
      const found = await ctx.db.from("homer_genres").select().is("archived_at", null).ilike("name", escapeLike(name!)).maybeSingle();
      if (found.error) throw dbError(tool, "genre lookup", found.error);
      const res = found.data
        ? (Object.keys(patch).length > 0
          ? await ctx.db.from("homer_genres").update(patch).eq("id", (found.data as Row).id).select().single()
          : { data: found.data, error: null })
        : await ctx.db.from("homer_genres").insert({ name, status: "proposed", ...patch }).select().single();
      if (res.error) throw dbError(tool, "genre write", res.error);
      genre = res.data as Row;
    }

    // Series are added or have is_example changed. Removing one isn't offered: the link rows have no archived_at,
    // and a tier-2 tool never hard-deletes.
    if (links.length > 0) {
      const { error } = await ctx.db.from("homer_genre_series")
        .upsert(links.map((l) => ({ genre_id: genre.id, ...l })), { onConflict: "genre_id,series_id" });
      if (error) {
        throw fail(tool, `the genre was saved (id ${genre.id}, "${genre.name}"), but its series were NOT: ` +
          `${dbError(tool, "series links", error).message}. Fix the series and call again with genre_id.`);
      }
    }
    const all = await ctx.db.from("homer_genre_series").select("series_id, is_example").eq("genre_id", genre.id);
    if (all.error) throw dbError(tool, "series links read-back", all.error);
    return { ...genre, series: all.data ?? [] };
  },
});

// ---------------------------------------------------------------------------
// update_homer_queue_item — tier 2 (status, genre, move, drop)
// ---------------------------------------------------------------------------

export const updateHomerQueueItemTool = defineTool({
  name: "update_homer_queue_item",
  tables: { reads: ["homer_queue_items"], writes: ["homer_queue_items"] },
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_homer_queue_item";
    const id = requireUuid(tool, "item_id", args.item_id);
    const cur = await ctx.db.from("homer_queue_items").select("id, reader_id, genre_id, position, archived_at").eq("id", id).maybeSingle();
    if (cur.error) throw dbError(tool, "item lookup", cur.error);
    if (!cur.data) throw fail(tool, `queue item ${id} not found.`);
    const item = cur.data as Row;
    const patch: Row = {};
    const status = oneValue(tool, "status", args.status, QUEUE_STATUS);
    if (status) patch.status = status;
    if (args.genre_id !== undefined) patch.genre_id = args.genre_id === null ? null : requireUuid(tool, "genre_id", args.genre_id);
    if (args.drop === true) patch.archived_at = new Date().toISOString();
    if (args.restore === true) patch.archived_at = null;
    if (args.drop === true && args.restore === true) throw fail(tool, "pass `drop` or `restore`, not both.");

    const after = optionalUuid(tool, "after_id", args.after_id);
    const before = optionalUuid(tool, "before_id", args.before_id);
    if (after && before) throw fail(tool, "pass `after_id` or `before_id`, not both.");
    if (after || before) {
      const genre = patch.genre_id !== undefined ? patch.genre_id : item.genre_id;
      let q = ctx.db.from("homer_queue_items").select("id, position").eq("reader_id", item.reader_id).is("archived_at", null).neq("id", id);
      q = genre ? q.eq("genre_id", genre) : q.is("genre_id", null);
      const { data, error } = await q.order("position", { ascending: true });
      if (error) throw dbError(tool, "queue lookup", error);
      patch.position = movePosition((data ?? []) as Row[], after, before, tool);
    }
    if (Object.keys(patch).length === 0) throw fail(tool, "nothing to change.");
    const { data, error } = await ctx.db.from("homer_queue_items").update(patch).eq("id", id).select().single();
    if (error) throw dbError(tool, "item update", error);
    return data;
  },
});

/** The new position between two neighbours in a genre's live queue (sorted by position, the moved item excluded). */
export function movePosition(others: Row[], after: string | null, before: string | null, tool = "update_homer_queue_item"): number {
  const pos = others.map((o) => Number(o.position));
  const i = others.findIndex((o) => o.id === (after ?? before));
  if (i < 0) throw fail(tool, `${after ? "after_id" : "before_id"} is not a live item in the same genre's queue.`);
  if (after) return i + 1 < pos.length ? (pos[i] + pos[i + 1]) / 2 : pos[i] + 1;
  return i > 0 ? (pos[i - 1] + pos[i]) / 2 : pos[i] - 1;
}

// ---------------------------------------------------------------------------
// create_homer_plan — tier 3 (supersedes the active plan, via create_homer_plan())
// ---------------------------------------------------------------------------

/** Shared by propose and handler: the draft is checked the way the database will check it. */
async function checkPlan(db: Db, tool: string, args: Row) {
  const instructions = requireText(tool, "instructions", args.instructions);
  const settings = args.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) throw fail(tool, "`settings` must be an object.");
  const writtenBy = oneValue(tool, "written_by", args.written_by, ["alex", "claude"]) ?? "claude";
  const summary = optionalText(tool, "change_summary", args.change_summary);
  const problem = await db.rpc("homer_plan_settings_problem", { p: settings });
  if (problem.error) throw dbError(tool, "homer_plan_settings_problem", problem.error);
  if (problem.data) throw fail(tool, `settings refused: ${problem.data}.`);
  const active = await db.from("homer_plans").select(PLAN_COLS).eq("status", "active").maybeSingle();
  if (active.error) throw dbError(tool, "plan lookup", active.error);
  if (active.data && !summary) {
    throw fail(tool, `a \`change_summary\` (what changed and why) is required when replacing version ${(active.data as Row).version}.`);
  }
  return { instructions, settings: settings as Row, writtenBy, summary, active: (active.data as Row | null) ?? null };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A readable before-and-after of two plan drafts: scales by key, the other settings by name, the instructions. */
export function planDiff(old: Row | null, next: { instructions: string; settings: Row }) {
  if (!old) return { first_plan: true, settings: next.settings, instructions: next.instructions };
  const os = (old.settings ?? {}) as Row;
  const ns = next.settings;
  const scalesOld = new Map(((os.scales ?? []) as Row[]).map((s) => [s.key, s]));
  const scalesNew = new Map(((ns.scales ?? []) as Row[]).map((s) => [s.key, s]));
  const scales = {
    added: [...scalesNew.keys()].filter((k) => !scalesOld.has(k)).map((k) => scalesNew.get(k)),
    removed: [...scalesOld.keys()].filter((k) => !scalesNew.has(k)),
    changed: [...scalesNew.keys()].filter((k) => scalesOld.has(k) && !same(scalesOld.get(k), scalesNew.get(k)))
      .map((k) => ({ key: k, was: scalesOld.get(k), now: scalesNew.get(k) })),
    order_changed: same([...scalesOld.keys()].filter((k) => scalesNew.has(k)), [...scalesNew.keys()].filter((k) => scalesOld.has(k)))
      ? false : true,
  };
  const keys = [...new Set([...Object.keys(os), ...Object.keys(ns)])].filter((k) => k !== "scales");
  const settings = keys.filter((k) => !same(os[k], ns[k])).map((k) => ({ key: k, was: os[k] ?? null, now: ns[k] ?? null }));
  return {
    replaces_version: old.version,
    instructions_changed: old.instructions !== next.instructions,
    ...(old.instructions !== next.instructions ? { instructions_was: old.instructions, instructions_now: next.instructions } : {}),
    scales, settings,
  };
}

export const createHomerPlanTool = defineTool({
  name: "create_homer_plan",
  tables: { reads: ["homer_plans"], writes: ["homer_plans"] },
  tier: 3,
  propose: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_homer_plan";
    const c = await checkPlan(ctx.db, tool, args);
    return { change_summary: c.summary, written_by: c.writtenBy, diff: planDiff(c.active, c) };
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_homer_plan";
    const c = await checkPlan(ctx.db, tool, args);
    const { data, error } = await ctx.db.rpc("create_homer_plan", {
      p_instructions: c.instructions, p_settings: c.settings, p_change_summary: c.summary, p_written_by: c.writtenBy,
    });
    if (error) throw dbError(tool, "create_homer_plan", error);
    return { plan: data };
  },
});

// ---------------------------------------------------------------------------
// create_homer_never — tier 3 (sets a never, or with lift: true lifts one; set_by alex)
// ---------------------------------------------------------------------------

async function checkNever(db: Db, tool: string, args: Row) {
  const subject = verdictSubject(tool, args);
  const rid = await readerId(db, tool, args.reader);
  const lift = args.lift === true;
  const replacing = lift && args.verdict !== "never" ? oneValue(tool, "verdict", args.verdict, LIKE_VERDICTS) : undefined;
  if (lift && !replacing) throw fail(tool, `lifting a never needs the replacing \`verdict\`: one of ${LIKE_VERDICTS.join(", ")}.`);
  if (!lift && args.verdict !== undefined && args.verdict !== "never") {
    throw fail(tool, "without lift, this tool only sets never. Use update_homer_verdict for other verdicts.");
  }
  const existing = await findVerdict(db, tool, rid, subject);
  if (lift && existing?.verdict !== "never") throw fail(tool, "there is no never to lift on this subject.");
  if (!lift && existing?.verdict === "never") throw fail(tool, "this is already a never.");
  const name = await subjectName(db, tool, subject);
  const note = args.note === undefined ? undefined : args.note === null ? null : requireText(tool, "note", args.note);
  return { subject, rid, lift, replacing, existing, name, note, readerKey: (args.reader as string | undefined) ?? DEFAULT_READER };
}

export const createHomerNeverTool = defineTool({
  name: "create_homer_never",
  tables: { reads: ["homer_verdicts", "homer_readers", "homer_series", "homer_books"], writes: ["homer_verdicts"] },
  tier: 3,
  propose: async (args: Record<string, unknown>, ctx) => {
    const c = await checkNever(ctx.db, "create_homer_never", args);
    const what = `${c.subject.kind} "${c.name}"`;
    return {
      text: c.lift
        ? `Lift the never on ${what} for ${c.readerKey}: it becomes "${c.replacing}" and can be suggested again. Set by Alex.`
        : `Never suggest ${what} to ${c.readerKey} again (was: ${c.existing?.verdict ?? "no stored verdict"}). Only Alex can lift it. Set by Alex.`,
      note: c.note ?? c.existing?.note ?? null,
    };
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const c = await checkNever(ctx.db, "create_homer_never", args);
    return await writeVerdict(ctx.db, "create_homer_never", c.rid, c.subject, c.existing,
      { verdict: c.lift ? c.replacing! : "never", note: c.note, set_by: "alex" });
  },
});
