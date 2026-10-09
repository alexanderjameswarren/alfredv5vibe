// ============================================================================
// supabase/functions/_shared/tools/dj-drive-mix.ts
//
// Drive Mix: a daily car playlist picked from a song pool by the database.
// Spec: docs/technical-spec-drive_mix-v7r.md §5. Migration 095.
//
//   get_drive_mix_songs        tier 1 — list the pool, with counts by status and slice.
//   create_drive_mix_songs     tier 1 — add up to 50 songs; duplicates skipped and reported.
//   update_drive_mix_songs     tier 2 — tag, re-key, retire or activate songs by id.
//   update_drive_mix_artist    tier 3 — retire or reactivate every song for one artist_key.
//   get_drive_mix_pick         tier 1 — dry run of drive_mix_pick for a date. Writes nothing.
//   get_drive_mix_simulation   tier 1 — drive_mix_simulate for N days. Writes nothing.
//   create_drive_mix_serving   tier 2 — record the video_ids that went to YouTube for a date.
//   create_drive_mix_sweep     tier 1 — drive_mix_sweep: pool history songs as pending.
//   update_drive_mix_thumbs    tier 2 — record Alex's thumbs; the latest thumb wins.
// ============================================================================

import { clampLimit, defineTool, describeDbError, envelope } from "../platform.ts";

export const GENRES = ["pop", "rock", "alternative", "country", "rap", "rnb", "dance", "other"] as const;
export const STATUSES = ["pending", "active", "retired"] as const;
export const SOURCES = ["playlist_seed", "artist_top", "history_sweep", "manual"] as const;
export const SLICES = ["country_rap", "1980s-and-earlier", "2010s-2020s", "1990s-2000s"] as const;
// Mirrors drive_mix_pick's default p_quotas (step 7 migration). Used only to report shortfalls.
export const DEFAULT_QUOTAS: Record<string, number> = {
  country_rap: 6, "1980s-and-earlier": 10, "2010s-2020s": 12, "1990s-2000s": 22,
};

export const THUMBS = ["up", "down"] as const;
// Retired for these reasons, a song comes back on a thumbs up. Any other reason (jazz, holiday...) stays.
export const THUMBS_UP_REVIVES = ["cut by Alex", "cut by Alex (not known)"];
// Mirror drive_mix_pick's defaults.
export const DEFAULT_NEW_SHARE = 0.25;
export const DEFAULT_FAMILIAR_DAYS = 5;
export const DEFAULT_FAMILIAR_GAP_DAYS = 7;
export const DEFAULT_FAMILIAR_SLICES_EXEMPT = ["1980s-and-earlier"];
export const DEFAULT_FAMILIAR_BREAKS_COOLDOWN = true;

const COLUMNS =
  "id, video_id, title, artist, artist_key, decade, genre, status, source, retired_reason, thumbs, thumbs_at, added_at";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 50;
const MAX_PLAYLIST = 200;
export const SIM_SONG_DAYS_MAX = 6000;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function given(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function requireString(T: string, key: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${T}: ${key} is required and must be non-empty text.`);
  return v.trim();
}

export function parseVideoId(T: string, v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!VIDEO_ID.test(s)) {
    throw new Error(`${T}: ${JSON.stringify(v)} is not a YouTube video id (11 characters of A-Z a-z 0-9 _ -).`);
  }
  return s;
}

export function parseDecade(T: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v % 10 !== 0 || v < 1900 || v > 2090) {
    throw new Error(`${T}: decade must be a year ending in 0, e.g. 1980 or 2010. Got ${JSON.stringify(v)}.`);
  }
  return v;
}

export function parseGenre(T: string, v: unknown): string {
  if (!(GENRES as readonly unknown[]).includes(v)) {
    throw new Error(`${T}: genre must be one of ${GENRES.join(", ")}. Got ${JSON.stringify(v)}.`);
  }
  return v as string;
}

function parseEnum(T: string, key: string, v: unknown, allowed: readonly string[]): string {
  if (!allowed.includes(v as string)) {
    throw new Error(`${T}: ${key} must be one of ${allowed.join(", ")}. Got ${JSON.stringify(v)}.`);
  }
  return v as string;
}

export function normaliseArtistKey(T: string, v: unknown): string {
  return requireString(T, "artist_key", v).toLowerCase();
}

/** YYYY-MM-DD that is a real calendar date. */
export function parseDate(T: string, key: string, v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`${T}: ${key} must be a date as YYYY-MM-DD. Got ${JSON.stringify(v)}.`);
  }
  return s;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseIntIn(T: string, key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${T}: ${key} must be a whole number from ${min} to ${max}. Got ${JSON.stringify(v)}.`);
  }
  return v;
}

function parseQuotas(T: string, v: unknown): Record<string, number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${T}: quotas must be an object of slice -> share, e.g. ${JSON.stringify(DEFAULT_QUOTAS)}.`);
  }
  let sum = 0;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    parseEnum(T, "quotas key", k, SLICES);
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      throw new Error(`${T}: quotas.${k} must be a number, 0 or more. Got ${JSON.stringify(n)}.`);
    }
    sum += n;
  }
  if (sum === 0) throw new Error(`${T}: quotas must not all be zero.`);
  return v as Record<string, number>;
}

/**
 * Quotas as drive_mix_pick applies them: proportions scaled to `count` by
 * largest remainder, ties to the earlier slice in SLICES. Mirrors the SQL in
 * the step 7 migration; counts that already sum to `count` come back unchanged.
 */
export function scaleQuotas(quotas: Record<string, number>, count: number): Record<string, number> {
  const total = SLICES.reduce((a, s) => a + (quotas[s] ?? 0), 0);
  const parts = SLICES.map((s, o) => {
    const exact = ((quotas[s] ?? 0) * count) / total;
    return { s, o, f: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let spare = count - parts.reduce((a, p) => a + p.f, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || a.o - b.o)) {
    if (spare-- > 0) p.f += 1;
  }
  return Object.fromEntries(parts.map((p) => [p.s, p.f]));
}

/** drive_mix_pick's default artist cap: 2 at 50 songs, 7 at 170. */
export function defaultArtistCap(count: number): number {
  return Math.ceil(count / 25);
}

/** The pick/simulation params shared by both tools, as drive_mix_pick arguments. Omitted = SQL default. */
function pickParams(T: string, args: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (given(args.count)) p.p_count = parseIntIn(T, "count", args.count, 1, MAX_PLAYLIST);
  if (given(args.artist_cap)) p.p_artist_cap = parseIntIn(T, "artist_cap", args.artist_cap, 1, 50);
  if (given(args.quotas)) p.p_quotas = parseQuotas(T, args.quotas);
  if (given(args.cooldown_days)) p.p_cooldown_days = parseIntIn(T, "cooldown_days", args.cooldown_days, 0, 30);
  if (given(args.new_share)) {
    const v = args.new_share;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`${T}: new_share must be a number from 0 to 1, e.g. 0.25. Got ${JSON.stringify(v)}.`);
    }
    p.p_new_share = v;
  }
  if (given(args.familiar_days)) p.p_familiar_days = parseIntIn(T, "familiar_days", args.familiar_days, 1, 365);
  if (given(args.familiar_gap_days)) {
    p.p_familiar_gap_days = parseIntIn(T, "familiar_gap_days", args.familiar_gap_days, 0, 60);
  }
  if (given(args.familiar_slices_exempt)) {
    const v = args.familiar_slices_exempt;
    if (!Array.isArray(v)) throw new Error(`${T}: familiar_slices_exempt must be a list of slices, e.g. ["1980s-and-earlier"], or [] for none.`);
    p.p_familiar_slices_exempt = [...new Set(v.map((s) => parseEnum(T, "familiar_slices_exempt", s, SLICES)))];
  }
  if (given(args.familiar_breaks_cooldown)) {
    if (typeof args.familiar_breaks_cooldown !== "boolean") {
      throw new Error(`${T}: familiar_breaks_cooldown must be true or false.`);
    }
    p.p_familiar_breaks_cooldown = args.familiar_breaks_cooldown;
  }
  return p;
}

/** drive_mix_pick's new-song cap: floor(share x count), 12 of 50 at 0.25. */
export function newSongCap(share: number, count: number): number {
  return Math.floor(share * count + 1e-9);
}

/** Slice a song counts in, as drive_mix_pick decides it. null = untagged. */
export function sliceOf(decade: number | null, genre: string | null): string | null {
  if (genre === "country" || genre === "rap") return "country_rap";
  if (decade === null) return null;
  if (decade <= 1980) return "1980s-and-earlier";
  if (decade <= 2000) return "1990s-2000s";
  return "2010s-2020s";
}

/** Slices that came up short of their quota in a pick's rows. */
export function shortfalls(rows: { slice: string }[], quotas: Record<string, number>) {
  const got: Record<string, number> = {};
  for (const r of rows) got[r.slice] = (got[r.slice] ?? 0) + 1;
  return Object.entries(quotas)
    .filter(([s, q]) => (got[s] ?? 0) < q)
    .map(([slice, quota]) => ({ slice, quota, filled: got[slice] ?? 0 }));
}

// ---------------------------------------------------------------------------
// get_drive_mix_songs — tier 1
// ---------------------------------------------------------------------------

async function headCount(T: string, q: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const { count, error } = await q;
  if (error) throw new Error(`${T}: ${error.message}`);
  return count ?? 0;
}

export const getDriveMixSongsTool = defineTool({
  name: "get_drive_mix_songs",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_drive_mix_songs";
    const status = given(args.status) ? parseEnum(T, "status", args.status, STATUSES) : null;
    const source = given(args.source) ? parseEnum(T, "source", args.source, SOURCES) : null;
    const artist = given(args.artist) ? normaliseArtistKey(T, args.artist) : null;
    const untagged = args.untagged === true;
    const thumbs = given(args.thumbs) ? parseEnum(T, "thumbs", args.thumbs, THUMBS) : null;
    const LIMIT = clampLimit(args.limit as number | undefined);

    let q = ctx.db.from("drive_mix_songs").select(COLUMNS, { count: "exact" });
    if (status) q = q.eq("status", status);
    if (source) q = q.eq("source", source);
    if (artist) q = q.eq("artist_key", artist);
    if (untagged) q = q.or("decade.is.null,genre.is.null");
    if (thumbs) q = q.eq("thumbs", thumbs);
    const { data, error, count } = await q
      .order("artist_key", { ascending: true })
      .order("title", { ascending: true })
      .limit(LIMIT);
    if (error) throw new Error(`${T}: ${error.message}`);

    // Pool-wide counts, independent of the filters above.
    const all = () => ctx.db.from("drive_mix_songs").select("id", { count: "exact", head: true });
    const eligible = () => all().eq("status", "active").not("decade", "is", null).not("genre", "is", null)
      .or("thumbs.is.null,thumbs.neq.down");
    const notCR = (q: any) => q.not("genre", "in", "(country,rap)");
    const [pending, active, retired, up, down, cr, s80, s9000, s1020] = await Promise.all([
      headCount(T, all().eq("status", "pending")),
      headCount(T, all().eq("status", "active")),
      headCount(T, all().eq("status", "retired")),
      headCount(T, all().eq("thumbs", "up")),
      headCount(T, all().eq("thumbs", "down")),
      headCount(T, eligible().in("genre", ["country", "rap"])),
      headCount(T, notCR(eligible()).lte("decade", 1980)),
      headCount(T, notCR(eligible()).gte("decade", 1990).lte("decade", 2000)),
      headCount(T, notCR(eligible()).gte("decade", 2010)),
    ]);
    const bySlice = {
      country_rap: cr, "1980s-and-earlier": s80, "1990s-2000s": s9000, "2010s-2020s": s1020,
    };

    const rows = data ?? [];
    const total = count ?? rows.length;
    return envelope(
      {
        songs: rows,
        matched: total,
        pool: { by_status: { pending, active, retired }, by_thumbs: { up, down }, active_eligible_by_slice: bySlice },
      },
      { count: rows.length, limit_applied: LIMIT, truncated: total > rows.length, total },
    );
  },
});

// ---------------------------------------------------------------------------
// create_drive_mix_songs — tier 1
// ---------------------------------------------------------------------------
// Appends to the pool. A song arrives active only when decade and genre are
// both supplied; otherwise pending, for the daily task to tag.

export const createDriveMixSongsTool = defineTool({
  name: "create_drive_mix_songs",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_drive_mix_songs";
    const source = given(args.source) ? parseEnum(T, "source", args.source, SOURCES) : "manual";
    if (!Array.isArray(args.songs) || args.songs.length === 0 || args.songs.length > MAX_BATCH) {
      throw new Error(`${T}: songs must be a list of 1 to ${MAX_BATCH} songs. Nothing was added.`);
    }

    const skipped: { video_id: string; reason: string }[] = [];
    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const [i, raw] of (args.songs as unknown[]).entries()) {
      const S = `${T}: songs[${i}]`;
      if (typeof raw !== "object" || raw === null) throw new Error(`${S} must be an object. Nothing was added.`);
      const s = raw as Record<string, unknown>;
      const videoId = parseVideoId(S, s.video_id);
      const row: Record<string, unknown> = {
        video_id: videoId,
        title: requireString(S, "title", s.title),
        artist: requireString(S, "artist", s.artist),
        source,
      };
      if (given(s.artist_key)) row.artist_key = normaliseArtistKey(S, s.artist_key);
      if (given(s.decade)) row.decade = parseDecade(S, s.decade);
      if (given(s.genre)) row.genre = parseGenre(S, s.genre);
      row.status = given(row.decade) && given(row.genre) ? "active" : "pending";
      if (seen.has(videoId)) {
        skipped.push({ video_id: videoId, reason: "repeated in this call" });
        continue;
      }
      seen.add(videoId);
      rows.push(row);
    }

    const ids = rows.map((r) => r.video_id as string);
    const { data: existing, error: readError } = await ctx.db
      .from("drive_mix_songs")
      .select("video_id, status")
      .in("video_id", ids);
    if (readError) throw new Error(`${T}: ${readError.message}`);
    const already = new Map((existing ?? []).map((e: { video_id: string; status: string }) => [e.video_id, e.status]));
    const fresh = rows.filter((r) => {
      const st = already.get(r.video_id as string);
      if (st) skipped.push({ video_id: r.video_id as string, reason: `already in the pool (${st})` });
      return !st;
    });

    let added: unknown[] = [];
    if (fresh.length > 0) {
      const { data, error } = await ctx.db.from("drive_mix_songs").insert(fresh).select(COLUMNS);
      if (error) throw new Error(describeDbError(T, error));
      added = data ?? [];
    }
    return { added, skipped };
  },
});

// ---------------------------------------------------------------------------
// update_drive_mix_songs — tier 2
// ---------------------------------------------------------------------------
// One patch applied to every id. Activating needs decade and genre on each row
// (from the patch or already set); leaving retired clears retired_reason.

function parseIds(T: string, v: unknown, what = "ids"): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BATCH) {
    throw new Error(`${T}: ${what} must be a list of 1 to ${MAX_BATCH} song ids. Nothing was changed.`);
  }
  for (const id of v) {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error(`${T}: ${JSON.stringify(id)} is not a song id. Nothing was changed.`);
  }
  return [...new Set(v as string[])];
}

export const updateDriveMixSongsTool = defineTool({
  name: "update_drive_mix_songs",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_drive_mix_songs";
    const ids = parseIds(T, args.ids);
    const patch: Record<string, unknown> = {};
    if (given(args.decade)) patch.decade = parseDecade(T, args.decade);
    if (given(args.genre)) patch.genre = parseGenre(T, args.genre);
    if (given(args.artist_key)) patch.artist_key = normaliseArtistKey(T, args.artist_key);
    if (given(args.status)) patch.status = parseEnum(T, "status", args.status, STATUSES);
    if (given(args.retired_reason)) {
      if (patch.status !== "retired") {
        throw new Error(`${T}: retired_reason needs status 'retired' in the same call. Nothing was changed.`);
      }
      patch.retired_reason = requireString(T, "retired_reason", args.retired_reason);
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(`${T}: nothing to change — pass decade, genre, artist_key, status or retired_reason.`);
    }
    if (patch.status === "active" || patch.status === "pending") patch.retired_reason = null;

    const { data: current, error: readError } = await ctx.db
      .from("drive_mix_songs")
      .select("id, title, decade, genre, status")
      .in("id", ids);
    if (readError) throw new Error(`${T}: ${readError.message}`);
    const found = new Map((current ?? []).map((r: { id: string }) => [r.id, r]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`${T}: no pool song with id ${missing.join(", ")}. Nothing was changed.`);

    if (patch.status === "active") {
      const untagged = (current as { id: string; title: string; decade: number | null; genre: string | null }[])
        .filter((r) => (patch.decade ?? r.decade) == null || (patch.genre ?? r.genre) == null);
      if (untagged.length) {
        throw new Error(
          `${T}: cannot activate songs without both decade and genre: ` +
            untagged.map((r) => `${r.title} (${r.id})`).join(", ") + ". Nothing was changed.",
        );
      }
    }

    const { data, error } = await ctx.db.from("drive_mix_songs").update(patch).in("id", ids).select(COLUMNS);
    if (error) throw new Error(describeDbError(T, error));
    return data ?? [];
  },
});

// ---------------------------------------------------------------------------
// update_drive_mix_artist — tier 3
// ---------------------------------------------------------------------------
// propose and handler share artistPlan, so the approved list is the written one.

const ARTIST_READ_CAP = 500;

type ArtistSong = { id: string; title: string; artist: string; decade: number | null; genre: string | null; status: string };

export async function artistPlan(T: string, args: Record<string, unknown>, ctx: { db: any }) {
  const artistKey = normaliseArtistKey(T, args.artist_key);
  const action = parseEnum(T, "action", args.action, ["retire", "reactivate"]);
  let reason: string | null = null;
  if (action === "retire") reason = requireString(T, "retired_reason", args.retired_reason);
  else if (given(args.retired_reason)) throw new Error(`${T}: retired_reason only goes with action 'retire'.`);

  const { data, error } = await ctx.db
    .from("drive_mix_songs")
    .select("id, title, artist, decade, genre, status")
    .eq("artist_key", artistKey)
    .order("title", { ascending: true })
    .limit(ARTIST_READ_CAP + 1);
  if (error) throw new Error(`${T}: ${error.message}`);
  const songs = (data ?? []) as ArtistSong[];
  if (songs.length === 0) {
    throw new Error(`${T}: no pool songs with artist_key '${artistKey}'. Check get_drive_mix_songs; nothing to do.`);
  }
  if (songs.length > ARTIST_READ_CAP) throw new Error(`${T}: more than ${ARTIST_READ_CAP} songs for '${artistKey}'; refusing a change that large.`);

  const affected = action === "retire"
    ? songs.filter((s) => s.status !== "retired")
    : songs.filter((s) => s.status === "retired");
  if (affected.length === 0) {
    throw new Error(`${T}: every song for '${artistKey}' is already ${action === "retire" ? "retired" : "not retired"}. Nothing to do.`);
  }
  const toActive = action === "reactivate" ? affected.filter((s) => s.decade != null && s.genre != null) : [];
  const toPending = action === "reactivate" ? affected.filter((s) => s.decade == null || s.genre == null) : [];
  return { artistKey, action, reason, affected, toActive, toPending };
}

export const updateDriveMixArtistTool = defineTool({
  name: "update_drive_mix_artist",
  tier: 3,
  propose: async (args: Record<string, unknown>, ctx) => {
    const p = await artistPlan("update_drive_mix_artist", args, ctx);
    const list = (xs: ArtistSong[]) => xs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, status: s.status }));
    return {
      text: p.action === "retire"
        ? `Retire ${p.affected.length} song(s) by '${p.artistKey}' (reason: ${p.reason}).`
        : `Reactivate ${p.affected.length} song(s) by '${p.artistKey}': ${p.toActive.length} to active, ` +
          `${p.toPending.length} to pending (missing decade or genre).`,
      songs: list(p.affected),
    };
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_drive_mix_artist";
    const p = await artistPlan(T, args, ctx);
    const write = async (ids: string[], patch: Record<string, unknown>) => {
      if (ids.length === 0) return [];
      const { data, error } = await ctx.db.from("drive_mix_songs").update(patch).in("id", ids).select(COLUMNS);
      if (error) throw new Error(describeDbError(T, error));
      return data ?? [];
    };
    const updated = p.action === "retire"
      ? await write(p.affected.map((s) => s.id), { status: "retired", retired_reason: p.reason })
      : [
        ...(await write(p.toActive.map((s) => s.id), { status: "active", retired_reason: null })),
        ...(await write(p.toPending.map((s) => s.id), { status: "pending", retired_reason: null })),
      ];
    return { artist_key: p.artistKey, action: p.action, updated };
  },
});

// ---------------------------------------------------------------------------
// get_drive_mix_pick — tier 1
// ---------------------------------------------------------------------------

export const getDriveMixPickTool = defineTool({
  name: "get_drive_mix_pick",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_drive_mix_pick";
    const date = given(args.date) ? parseDate(T, "date", args.date) : todayUtc();
    const params = { p_date: date, ...pickParams(T, args) };
    const { data, error } = await ctx.db.rpc("drive_mix_pick", params);
    if (error) throw new Error(describeDbError(T, error));
    const rows = (data ?? []) as {
      slice: string; video_id: string; carried?: boolean; cooling?: boolean; familiar?: boolean; new_over_cap?: boolean;
    }[];
    const p = params as Record<string, unknown>;
    const count = (p.p_count as number) ?? 50;
    const quotas = scaleQuotas((p.p_quotas as Record<string, number>) ?? DEFAULT_QUOTAS, count);
    const newShare = (p.p_new_share as number) ?? DEFAULT_NEW_SHARE;
    return {
      date,
      requested: count,
      returned: rows.length,
      quotas_used: quotas,
      artist_cap_used: (p.p_artist_cap as number) ?? defaultArtistCap(count),
      familiar_days_used: (p.p_familiar_days as number) ?? DEFAULT_FAMILIAR_DAYS,
      familiar_gap_days_used: (p.p_familiar_gap_days as number) ?? DEFAULT_FAMILIAR_GAP_DAYS,
      familiar_slices_exempt_used: (p.p_familiar_slices_exempt as string[]) ?? DEFAULT_FAMILIAR_SLICES_EXEMPT,
      familiar_breaks_cooldown_used: (p.p_familiar_breaks_cooldown as boolean) ?? DEFAULT_FAMILIAR_BREAKS_COOLDOWN,
      new_cap: newSongCap(newShare, count),
      new_songs: rows.filter((r) => r.familiar === false).length,
      new_over_cap: rows.filter((r) => r.new_over_cap).length,
      cooling_breaks: rows.filter((r) => r.familiar && r.cooling).length,
      carried_over: rows.filter((r) => r.carried).length,
      cooling_used: rows.filter((r) => r.cooling).length,
      short_by: Math.max(0, count - rows.length),
      slice_shortfalls: shortfalls(rows, quotas),
      video_ids: rows.map((r) => r.video_id),
      songs: rows,
    };
  },
});

// ---------------------------------------------------------------------------
// get_drive_mix_simulation — tier 1
// ---------------------------------------------------------------------------

export const getDriveMixSimulationTool = defineTool({
  name: "get_drive_mix_simulation",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_drive_mix_simulation";
    const params: Record<string, unknown> = { ...pickParams(T, args) };
    if (given(args.start)) params.p_start = parseDate(T, "start", args.start);
    if (given(args.days)) params.p_days = parseIntIn(T, "days", args.days, 1, 120);
    if (given(args.heard_per_day)) params.p_heard_per_day = parseIntIn(T, "heard_per_day", args.heard_per_day, 0, MAX_PLAYLIST);
    const LIMIT = clampLimit(args.limit as number | undefined);
    // About 0.8 ms per song-day; the authenticated role's 8s statement_timeout ends the call.
    const days = (params.p_days as number) ?? 60;
    const count = (params.p_count as number) ?? 50;
    if (days * count > SIM_SONG_DAYS_MAX) {
      throw new Error(
        `${T}: ${days} days x ${count} songs = ${days * count} song-days, over the limit of ${SIM_SONG_DAYS_MAX} ` +
          `(the database stops a call at 8 seconds). Nothing was run. Lower days or count and call again, ` +
          `e.g. 60 days at 100 songs, or 30 days at 200.`,
      );
    }

    const { data, error } = await ctx.db.rpc("drive_mix_simulate", params);
    if (error) throw new Error(describeDbError(T, error));
    const sim = (data ?? {}) as Record<string, unknown>;
    const songs = (sim.songs ?? []) as unknown[];
    const artists = (sim.artists ?? []) as unknown[];
    const truncated = songs.length > LIMIT || artists.length > LIMIT;
    return envelope(
      {
        ...sim,
        songs: songs.slice(0, LIMIT),
        artists: artists.slice(0, LIMIT),
        songs_total: songs.length,
        artists_total: artists.length,
      },
      { limit_applied: LIMIT, truncated, total: Math.max(songs.length, artists.length) },
    );
  },
});

// ---------------------------------------------------------------------------
// create_drive_mix_serving — tier 2
// ---------------------------------------------------------------------------
// Records what went to YouTube, as given. Never re-runs the picker: a re-pick
// would differ in exactly the case the record is for. One serving per date.

export const createDriveMixServingTool = defineTool({
  name: "create_drive_mix_serving",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_drive_mix_serving";
    const date = given(args.date) ? parseDate(T, "date", args.date) : todayUtc();
    if (!Array.isArray(args.video_ids) || args.video_ids.length === 0 || args.video_ids.length > MAX_PLAYLIST) {
      throw new Error(`${T}: video_ids must be the list sent to YouTube, 1 to ${MAX_PLAYLIST} ids, in playlist order. Nothing was recorded.`);
    }
    const videoIds = (args.video_ids as unknown[]).map((v) => parseVideoId(T, v));
    const dupes = videoIds.filter((v, i) => videoIds.indexOf(v) !== i);
    if (dupes.length) throw new Error(`${T}: video_ids repeats ${[...new Set(dupes)].join(", ")}. Nothing was recorded.`);

    const { data: prior, error: priorError } = await ctx.db
      .from("drive_mix_servings")
      .select("id")
      .eq("served_on", date)
      .limit(1);
    if (priorError) throw new Error(`${T}: ${priorError.message}`);
    if ((prior ?? []).length > 0) {
      throw new Error(`${T}: ${date} already has a serving recorded. A date gets one serving; nothing was recorded.`);
    }

    const { data: pool, error: poolError } = await ctx.db
      .from("drive_mix_songs")
      .select("id, video_id, status")
      .in("video_id", videoIds);
    if (poolError) throw new Error(`${T}: ${poolError.message}`);
    const byVideo = new Map((pool ?? []).map((s: { id: string; video_id: string; status: string }) => [s.video_id, s]));
    const bad = videoIds
      .map((v) => {
        const s = byVideo.get(v);
        return !s ? `${v} (not in the pool)` : s.status !== "active" ? `${v} (${s.status})` : null;
      })
      .filter(Boolean);
    if (bad.length) {
      throw new Error(`${T}: every video_id must be an active pool song. Not: ${bad.join(", ")}. Nothing was recorded.`);
    }

    const rows = videoIds.map((v, i) => ({ served_on: date, position: i + 1, song_id: byVideo.get(v)!.id, video_id: v }));
    const { error } = await ctx.db.from("drive_mix_servings").insert(rows);
    if (error) throw new Error(describeDbError(T, error));
    return { date, recorded: rows.length, video_ids: videoIds };
  },
});

// ---------------------------------------------------------------------------
// create_drive_mix_sweep — tier 1
// ---------------------------------------------------------------------------

export const createDriveMixSweepTool = defineTool({
  name: "create_drive_mix_sweep",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_drive_mix_sweep";
    const LIMIT = clampLimit(args.limit as number | undefined);
    const { data, error } = await ctx.db.rpc("drive_mix_sweep");
    if (error) throw new Error(describeDbError(T, error));
    const rows = (data ?? []) as unknown[];
    return envelope(
      { added: rows.length, songs: rows.slice(0, LIMIT) },
      { limit_applied: LIMIT, truncated: rows.length > LIMIT, total: rows.length },
    );
  },
});

// ---------------------------------------------------------------------------
// update_drive_mix_thumbs — tier 2
// ---------------------------------------------------------------------------
// Latest thumb wins: a thumb older than the song's thumbs_at is skipped, so
// replaying old feedback cannot undo a newer thumb. "clear" keeps thumbs_at.

type Thumb = { video_id: string; thumbs: "up" | "down" | null; at: string };

/** One thumb per video_id, the latest by `at` (a tie goes to the later entry). */
export function parseThumbs(T: string, v: unknown, now = new Date()): Thumb[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PLAYLIST) {
    throw new Error(`${T}: thumbs must be a list of 1 to ${MAX_PLAYLIST} {video_id, thumbs, at}. Nothing was changed.`);
  }
  const latest = new Map<string, Thumb>();
  for (const [i, raw] of v.entries()) {
    const S = `${T}: thumbs[${i}]`;
    if (typeof raw !== "object" || raw === null) throw new Error(`${S} must be an object. Nothing was changed.`);
    const r = raw as Record<string, unknown>;
    const videoId = parseVideoId(S, r.video_id);
    const value = parseEnum(S, "thumbs", r.thumbs, ["up", "down", "clear"]);
    let at = now.toISOString();
    if (given(r.at)) {
      const d = typeof r.at === "string" ? new Date(r.at) : new Date(NaN);
      if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 86_400_000) {
        throw new Error(`${S}: at must be an ISO timestamp, not in the future. Got ${JSON.stringify(r.at)}. Nothing was changed.`);
      }
      at = d.toISOString();
    }
    const prior = latest.get(videoId);
    if (!prior || at >= prior.at) {
      latest.set(videoId, { video_id: videoId, thumbs: value === "clear" ? null : value as "up" | "down", at });
    }
  }
  return [...latest.values()];
}

type ThumbRow = {
  id: string; video_id: string; title: string; status: string; retired_reason: string | null;
  decade: number | null; genre: string | null; thumbs: string | null; thumbs_at: string | null;
};

export const updateDriveMixThumbsTool = defineTool({
  name: "update_drive_mix_thumbs",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_drive_mix_thumbs";
    const thumbs = parseThumbs(T, args.thumbs);

    const { data: pool, error: readError } = await ctx.db
      .from("drive_mix_songs")
      .select("id, video_id, title, status, retired_reason, decade, genre, thumbs, thumbs_at")
      .in("video_id", thumbs.map((t) => t.video_id));
    if (readError) throw new Error(`${T}: ${readError.message}`);
    const byVideo = new Map(((pool ?? []) as ThumbRow[]).map((r) => [r.video_id, r]));

    const skipped: { video_id: string; reason: string }[] = [];
    const revived: { video_id: string; title: string; status: string }[] = [];
    const groups = new Map<string, { patch: Record<string, unknown>; at: string; ids: string[] }>();
    for (const t of thumbs) {
      const row = byVideo.get(t.video_id);
      if (!row) {
        skipped.push({ video_id: t.video_id, reason: "not in the pool" });
        continue;
      }
      if (row.thumbs_at && new Date(row.thumbs_at).getTime() > new Date(t.at).getTime()) {
        skipped.push({ video_id: t.video_id, reason: `older than the thumb recorded at ${row.thumbs_at}` });
        continue;
      }
      const patch: Record<string, unknown> = { thumbs: t.thumbs, thumbs_at: t.at };
      if (t.thumbs === "up" && row.status === "retired" && THUMBS_UP_REVIVES.includes(row.retired_reason ?? "")) {
        patch.status = row.decade != null && row.genre != null ? "active" : "pending";
        patch.retired_reason = null;
        revived.push({ video_id: row.video_id, title: row.title, status: patch.status as string });
      }
      const key = JSON.stringify(patch);
      if (!groups.has(key)) groups.set(key, { patch, at: t.at, ids: [] });
      groups.get(key)!.ids.push(row.id);
    }

    const updated: unknown[] = [];
    for (const g of groups.values()) {
      // Re-checked in the write, so a newer thumb landing meanwhile is not overwritten.
      const { data, error } = await ctx.db.from("drive_mix_songs").update(g.patch)
        .in("id", g.ids)
        .or(`thumbs_at.is.null,thumbs_at.lte."${g.at}"`)
        .select("id, video_id, title, status, thumbs, thumbs_at");
      if (error) throw new Error(describeDbError(T, error));
      updated.push(...(data ?? []));
    }
    return { recorded: updated.length, updated, revived, skipped };
  },
});
