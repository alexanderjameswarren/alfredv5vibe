// Reading the durable record back — plays, and managed playlists.
//
//   get_dj_plays — tier 1. Two modes:
//     plays        raw rows in a window, newest first
//     familiarity  distinct-days per canonical group, LEAST FAMILIAR FIRST
//
//   get_dj_managed_playlists — tier 1. Two modes:
//     list         what this system manages, with per-role track counts
//     tracks       one playlist's recorded membership, in RENDERED order
//
// ⚠️ get_dj_managed_playlists reads SUPABASE. Workshop's similarly-named
// `get_dj_playlists` reads YOUTUBE. They return plausible-but-different data,
// so picking the wrong one is a wrong answer that looks right (spec §11.2) —
// each tool's description names the other explicitly for that reason.
//
// Built because there was no way to read dj_plays at all: diagnosing a sync
// discrepancy meant opening the SQL editor, and phase 5 needs this structurally
// — gap detection has to know what is already stored, and the Friday review
// cannot review history it cannot query.
//
// ⚠️ FAMILIARITY IS DISTINCT DAYS, NOT PLAY COUNT. Spec §5 was rewritten when
// phase 2b established that YouTube's feed carries one entry per track per
// bucket, so repeats do not stack and true counts are unobtainable by polling.
// The field is named `distinct_days` so the mistake cannot be made again, and
// `play_rows` rides alongside so the difference stays visible.

import { clampLimit, defineTool } from "../platform.ts";
import { isVariantCut, normalisePart } from "./dj-normalise.ts";

// The caller's enumerated subject. Bounded so the scan below is bounded.
const VIDEO_IDS_CAP = 50;

// Hard ceiling on rows scanned for an aggregate. Exceeding it ERRORS.
//
// Truncation that shortens an answer is fine; truncation that CORRUPTS one is
// not. A clamped 50-row scan of a track's history yields a distinct_days that
// is simply wrong, with nothing in the response to indicate it — the caller
// sorts by it and gets a confidently incorrect cram order. Same reasoning as
// record_dj_plays rejecting over 500 plays rather than writing a partial batch.
const SCAN_CAP = 5000;

// §12.10(b)'s definition of a learned song, named once and used by BOTH the
// stale check and the COMPLETE check. Two constants that both mean "learned" is
// a constraint written twice, and it would be enforced in one.
const LEARNED_DISTINCT_DAYS = 5;

const IN_CHUNK = 100;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_SOURCE = ["poll", "takeout", "manual"];

const PLAY_COLS =
  "id, track_id, played_on, precision, played_bucket, occurrence, source, observed_at";
// `album` is here because a field nobody can READ is a field nobody can CHECK.
// The poll deliberately never stores it (spec §9) — and that decision could not
// be verified through any tool, so confirming it meant opening the SQL editor.
const TRACK_COLS = "id, video_id, title, artist, album, canonical_track_id";

interface TrackRow {
  id: string;
  video_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  canonical_track_id: string | null;
}

interface PlayRow {
  id: string;
  track_id: string;
  played_on: string;
  precision: string;
  played_bucket: string | null;
  occurrence: number;
  source: string;
  observed_at: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Paged reads — and the 2026-09-02 wrong answer
// ---------------------------------------------------------------------------
//
// 🛑 POSTGREST CAPS EVERY RESPONSE AT `db-max-rows` AND SAYS SO NOWHERE IN THE
// BODY. There is no error, no flag, no short-count field: the rows simply stop.
// A `.select()` that returns 1000 rows and a `.select()` that returns 1000 of
// 2400 are byte-identical to the caller.
//
// ⚠️ THIS IS NOT A PERFORMANCE DETAIL. It produced a confidently wrong answer.
// Measured 2026-09-02, get_dj_managed_playlists mode=list reported: Smashing
// Pumpkins Concert 0 tracks against a real 15, Motley Crue 0 against 14, Weezer
// 4 against 13 — and the reported body counts across all 41 playlists summed to
// EXACTLY 1000. The read stopped mid-playlist, and every playlist after the cut
// became a zero. A weekly job trusting it says "your concert playlist is empty"
// six weeks before the show.
//
// ⚠️ IT HID BECAUSE ONLY THE FAN-OUT PATH CROSSES THE CAP. mode=tracks reads ONE
// playlist (≤379 rows) and mode=engagement does its arithmetic in SQL, so both
// were right — which made the disagreement look like a question about which mode
// to trust rather than a defect in one of them. Two modes agreeing is not
// corroboration when they share no code path with the third (spec §11.9).
//
// Every unbounded read in this file now goes through here, so the next mode
// added cannot forget.
const PAGE_ROWS = 1000;

// A guard against an unterminated loop, NOT a data limit. Hit, it THROWS: a
// silently short answer is the failure being removed here, and it must not be
// reintroduced by the fix for it.
const MAX_PAGES = 200;

/**
 * Read EVERY row a filter selects, paging past PostgREST's row cap.
 *
 * ⚠️ ORDER IS LOAD-BEARING, NOT COSMETIC. Without a stable sort, consecutive
 * ranges may overlap or skip rows — pagination over an unordered result is a
 * different wrong answer, not a fix. Every table read through here has an `id`
 * primary key, so it is always available.
 *
 * 🛑 TERMINATION IS ON AN EMPTY PAGE, NEVER ON A SHORT ONE, AND THE DIFFERENCE
 * IS THE ENTIRE BUG A SECOND TIME. "Short page means last page" assumes the
 * server returns everything asked for — which is exactly the assumption that
 * failed. Ask for 1000 against a cap of 500 and every page is short, so the
 * loop stops on the first one and reproduces the defect it was written to fix,
 * now wearing pagination. Advancing by the rows ACTUALLY RETURNED costs one
 * empty round-trip at the end and cannot be defeated by a cap this code does
 * not know the value of.
 */
async function selectAllRows<T>(
  ctx: any,
  label: string,
  table: string,
  cols: string,
  filter: (q: any) => any = (q) => q,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await filter(ctx.db.from(table).select(cols))
      .order("id", { ascending: true })
      .range(from, from + PAGE_ROWS - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    if (rows.length === 0) return out;
    out.push(...rows);
    from += rows.length;
  }
  throw new Error(
    `${label}: still returning rows after ${MAX_PAGES} pages (${out.length} read). ` +
      `Refusing to return a partial read — a short answer here is indistinguishable ` +
      `from a complete one, and the caller would act on it.`,
  );
}

/** Group id for familiarity. A null canonical_track_id means this row IS the
 * canonical one — spec §4.1. All familiarity counting groups by this, never by
 * video_id, or a song heard thirty times across three uploads looks like three
 * lightly-played songs and never leaves a cram list. */
const groupIdOf = (t: { id: string; canonical_track_id: string | null }) =>
  t.canonical_track_id ?? t.id;

function daysBetween(fromIso: string, toIso: string): number {
  const [ay, am, ad] = fromIso.split("-").map(Number);
  const [by, bm, bd] = toIso.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

function validateDate(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) {
    throw new Error(`get_dj_plays: \`${name}\` must be YYYY-MM-DD (got ${JSON.stringify(v)}).`);
  }
  return v;
}

export const getDjPlaysTool = defineTool({
  name: "get_dj_plays",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const mode = (args.mode as string | undefined) ?? "plays";
    if (mode !== "plays" && mode !== "familiarity" && mode !== "artists") {
      throw new Error(
        `get_dj_plays: \`mode\` must be 'plays', 'familiarity' or 'artists' ` +
          `(got ${JSON.stringify(mode)}).`,
      );
    }

    // --- artists (migration 015) ------------------------------------------
    //
    // Section 4's headline, and what was actually asked for. The 2026-09-02 run
    // could not answer "a summary by artist" at all: the only artist-level
    // aggregation in the system was dj_jazz_activity, so Section 4 fell back to
    // a 50-row sample of 332 plays and said so.
    //
    // The arithmetic is in SQL for the same reason engagement's is — a second
    // implementation here would agree with the first until one of them changed.
    if (mode === "artists") {
      const windowDays = (args.window_days as number | undefined) ?? 90;
      const artistLimit = clampLimit(args.limit as number | undefined);
      // ADDED 016: optional tag filter, backed by dj_artist_tags. null = every
      // artist, which is the pre-016 behaviour and stays the default.
      const tag = (args.tag as string | undefined)?.trim() || null;
      const { data: act, error: actErr } = await ctx.db.rpc("dj_artist_activity", {
        p_window_days: windowDays,
        p_limit: artistLimit,
        p_tag: tag,
      });
      if (actErr) {
        // Operational, and legitimately retryable once the migration is in — so
        // it carries no do-not-retry wording, per the platform error contract.
        throw new Error(
          `get_dj_plays: artist activity failed: ${actErr.message}. If this says ` +
            `the function does not exist, migration 015 has not been applied yet.`,
        );
      }
      const artistRows = (act ?? []) as Array<Record<string, unknown>>;
      // Untagged artists high in the list are the only visible evidence that the
      // curated tag set is incomplete, so the count travels with the rows rather
      // than being left for the reader to notice.
      const untagged = artistRows.filter(
        (r) => !Array.isArray(r.tags) || (r.tags as unknown[]).length === 0,
      ).length;
      return { data: {
        mode: "artists",
        artists: artistRows,
        returned: artistRows.length,
        window_days: windowDays,
        limit_applied: artistLimit,
        tag_filter: tag,
        untagged_in_result: untagged,
        definition:
          "One row per DISTINCT ARTIST STRING on dj_tracks, over plays in the " +
          "window. `distinct_days` is DISTINCT DAYS PLAYED, not a play count — the " +
          "feed carries one entry per track per bucket, so repeats do not stack " +
          "(§5). `in_any_playlist` says whether that artist appears in any managed " +
          "playlist at all — ⚠️ NOT the same field as get_dj_jazz_activity's " +
          "`in_jazz_playlist`, which asks only about the two jazz playlists. The " +
          "two legitimately disagree for the same artist. " +
          "`tags` comes from dj_artist_tags and `tag` filters on it (null = all).",
        gaps:
          "🛑 THIS IS NOT AN ARTIST IDENTITY AND DOES NOT CLOSE §14.1. Grouping is " +
          "on dj_tracks.artist as an EXACT STRING. (1) SPLITS ARE REAL AND PRESENT: " +
          "'Oscar Peterson Trio' and 'Oscar Peterson' do not unify, nor do 'Hank " +
          "Mobley' and 'Hank Mobley Quartet' — both pairs are in the data (§4.1.4). " +
          "(2) COLLABORATIONS APPEAR UNDER THEIR FULL BILLING, because the column " +
          "holds the joined display string: 'Miles Davis, Cannonball Adderley, Hank " +
          "Jones, Sam Jones' is one row here, not four. (3) SCRAPED BYLINES ARE IN " +
          "THE POPULATION: at least one artist reads 'Jazz and Blues Experience, " +
          "1.7M views' (§14.9) and will appear here looking like an artist. " +
          "⚠️ STATE THIS WITH THE NUMBERS, the same way §14.3 requires of the jazz " +
          "definition. Insert-only means none of it can be cleaned by a deploy.",
      }, meta: {} };
    }
    const fromDate = validateDate(args.from_date, "from_date");
    const toDate = validateDate(args.to_date, "to_date");
    if (fromDate && toDate && fromDate > toDate) {
      throw new Error(
        `get_dj_plays: from_date (${fromDate}) is after to_date (${toDate}).`,
      );
    }
    const source = args.source as string | undefined;
    if (source && !VALID_SOURCE.includes(source)) {
      throw new Error(
        `get_dj_plays: \`source\` must be one of ${VALID_SOURCE.join(", ")}.`,
      );
    }
    const videoIds = args.video_ids as string[] | undefined;
    if (videoIds !== undefined) {
      if (!Array.isArray(videoIds) || !videoIds.every((v) => typeof v === "string")) {
        throw new Error("get_dj_plays: `video_ids` must be an array of strings.");
      }
      if (videoIds.length > VIDEO_IDS_CAP) {
        throw new Error(
          `get_dj_plays: ${videoIds.length} video_ids exceeds the cap of ${VIDEO_IDS_CAP}. ` +
            `Split into smaller calls.`,
        );
      }
    }

    const applyPlayFilters = (q: any) => {
      if (fromDate) q = q.gte("played_on", fromDate);
      if (toDate) q = q.lte("played_on", toDate);
      if (source) q = q.eq("source", source);
      return q;
    };

    // ---------------------------------------------------------------- plays
    if (mode === "plays") {
      const limit = clampLimit(args.limit as number | undefined);
      let q = ctx.db
        .from("dj_plays")
        .select(PLAY_COLS, { count: "exact" })
        .order("played_on", { ascending: false })
        .order("observed_at", { ascending: false })
        .limit(limit);
      q = applyPlayFilters(q);

      let trackIds: string[] | null = null;
      if (videoIds && videoIds.length > 0) {
        trackIds = await resolveTrackIdsForVideoIds(ctx, videoIds);
        if (trackIds.length === 0) {
          return {
            data: {
              mode: "plays", plays: [], returned: 0, total: 0,
              note: "None of the supplied video_ids are known to dj_tracks, so no plays exist for them.",
            },
            meta: {},
          };
        }
        q = q.in("track_id", trackIds);
      }

      const { data, error, count } = await q;
      if (error) throw new Error(`get_dj_plays: ${error.message}`);
      const rows = (data ?? []) as PlayRow[];
      const tracks = await fetchTracksByIds(ctx, [...new Set(rows.map((r) => r.track_id))]);
      const byId = new Map(tracks.map((t) => [t.id, t]));

      const plays = rows.map((r) => ({
        played_on: r.played_on,
        precision: r.precision,
        played_bucket: r.played_bucket,
        occurrence: r.occurrence,
        source: r.source,
        observed_at: r.observed_at,
        track: byId.get(r.track_id) ?? { id: r.track_id },
      }));

      const total = count ?? plays.length;
      return {
        data: {
          mode: "plays",
          plays,
          returned: plays.length,
          total,
          limit_applied: limit,
          from_date: fromDate ?? null,
          to_date: toDate ?? null,
        },
        meta: plays.length < total
          ? { truncated: true, total, limit_applied: limit, count: plays.length }
          : {},
      };
    }

    // ---------------------------------------------------------- familiarity
    //
    // Refuses to run unbounded. Both real consumers are naturally bounded —
    // cram ordering passes a playlist's ~20 tracks, the Friday review passes a
    // 7-day range — and an unbounded aggregate over dj_plays after a Takeout
    // import is exactly the query that would silently exceed the scan cap.
    if (!videoIds?.length && !fromDate && !toDate) {
      throw new Error(
        "get_dj_plays: mode 'familiarity' requires either `video_ids` or a date " +
          "range (`from_date` / `to_date`). An unbounded aggregate would have to " +
          "scan the whole listening history, and a clamped aggregate returns a " +
          "wrong distinct_days rather than a short one.",
      );
    }

    const asOf = validateDate(args.as_of, "as_of") ??
      new Date().toISOString().slice(0, 10);

    // 1. Resolve the subject to canonical groups, INCLUDING sibling variants —
    // a play by any member counts toward the group.
    let seedTracks: TrackRow[] = [];
    const unknownVideoIds: string[] = [];
    if (videoIds?.length) {
      seedTracks = await fetchTracksByVideoIds(ctx, videoIds);
      const known = new Set(seedTracks.map((t) => t.video_id));
      for (const v of videoIds) if (!known.has(v)) unknownVideoIds.push(v);
    }

    let members: TrackRow[] = [];
    if (seedTracks.length > 0) {
      const groupIds = [...new Set(seedTracks.map(groupIdOf))];
      members = await fetchGroupMembers(ctx, groupIds);
    }

    // 2. Scan plays — bounded, and counted BEFORE fetching so an oversized
    // aggregate fails loudly instead of returning a wrong number.
    let countQ = ctx.db.from("dj_plays").select("id", { count: "exact", head: true });
    countQ = applyPlayFilters(countQ);
    const memberIds = members.map((m) => m.id);
    if (videoIds?.length) {
      if (memberIds.length === 0) {
        // Every requested id is unknown: all zeros, no scan needed.
        return zeroOnlyResult(videoIds, asOf, fromDate, toDate);
      }
      countQ = countQ.in("track_id", memberIds);
    }
    const { count: scanCount, error: countErr } = await countQ;
    if (countErr) throw new Error(`get_dj_plays: scan count failed: ${countErr.message}`);
    if ((scanCount ?? 0) > SCAN_CAP) {
      throw new Error(
        `get_dj_plays: this aggregate would scan ${scanCount} rows, over the cap of ` +
          `${SCAN_CAP}. NOTHING was returned — a truncated aggregate would report a ` +
          `distinct_days that is wrong rather than short, and the caller would sort ` +
          `by it. Narrow the date range or pass fewer video_ids.`,
      );
    }

    let playRows: PlayRow[] = [];
    if (videoIds?.length) {
      for (const ids of chunk(memberIds, IN_CHUNK)) {
        playRows.push(...await selectAllRows<PlayRow>(
          ctx, "get_dj_plays", "dj_plays", PLAY_COLS,
          (q) => applyPlayFilters(q.in("track_id", ids)),
        ));
      }
    } else {
      // ⚠️ `.limit(SCAN_CAP)` WAS A CEILING THAT COULD NOT BE REACHED. PostgREST
      // caps the response at db-max-rows (1000) regardless of what the query
      // asks for, so a 3,000-row window passed the count guard above and then
      // silently read a third of itself. The guard measured the right thing and
      // the read did not honour it — spec §11.15, an operation reporting success
      // without verifying its effect. Paged, the cap above is now the real one.
      playRows = await selectAllRows<PlayRow>(
        ctx, "get_dj_plays", "dj_plays", PLAY_COLS, applyPlayFilters,
      );
      members = await fetchTracksByIds(ctx, [...new Set(playRows.map((r) => r.track_id))]);
      const groupIds = [...new Set(members.map(groupIdOf))];
      members = await fetchGroupMembers(ctx, groupIds);
    }

    const out = buildFamiliarity(members, playRows, unknownVideoIds, asOf, videoIds);

    // When the caller enumerated its subject it gets every entry back — a
    // clamped familiarity result would recreate the reconstruction problem the
    // zero-play rule exists to remove. The limit applies to the range form only.
    const enumerated = Boolean(videoIds?.length);
    const limit = enumerated ? out.length : clampLimit(args.limit as number | undefined);
    const shown = out.slice(0, limit);

    return {
      data: {
        mode: "familiarity",
        as_of: asOf,
        groups: shown,
        returned: shown.length,
        total_groups: out.length,
        rows_scanned: playRows.length,
        requested_video_ids: videoIds ?? null,
        requested_count: videoIds?.length ?? null,
        // Renamed from `unknown_video_ids`, which read as a bucket these ids
        // went into INSTEAD of the results — it misled a reader once. They are
        // returned as zero rows AND listed here; this is an annotation.
        unknown_ids_returned_as_zeros: unknownVideoIds,
        // One field a caller can assert on instead of counting.
        all_requested_returned: videoIds ? shown.length >= videoIds.length : null,
        from_date: fromDate ?? null,
        to_date: toDate ?? null,
        reading: (
          "distinct_days is DISTINCT DAYS PLAYED, not a play count — polling " +
          "cannot measure repeats (spec §5). distinct_days 0 with " +
          "days_since_last null means never played; 0 is a fact, null means " +
          "no last play exists. Sorted least-familiar first, which is cram order. " +
          "unknown_ids_returned_as_zeros ANNOTATES the results — those ids are " +
          "included above as zero rows, not excluded. Check all_requested_returned."
        ),
      },
      meta: shown.length < out.length
        ? { truncated: true, total: out.length, limit_applied: limit, count: shown.length }
        : {},
    };
  },
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function fetchTracksByVideoIds(ctx: any, videoIds: string[]): Promise<TrackRow[]> {
  const out: TrackRow[] = [];
  for (const ids of chunk(videoIds, IN_CHUNK)) {
    const { data, error } = await ctx.db.from("dj_tracks").select(TRACK_COLS).in("video_id", ids);
    if (error) throw new Error(`get_dj_plays: track lookup failed: ${error.message}`);
    out.push(...((data ?? []) as TrackRow[]));
  }
  return out;
}

async function fetchTracksByIds(ctx: any, ids: string[]): Promise<TrackRow[]> {
  const out: TrackRow[] = [];
  for (const batch of chunk(ids, IN_CHUNK)) {
    if (batch.length === 0) continue;
    const { data, error } = await ctx.db.from("dj_tracks").select(TRACK_COLS).in("id", batch);
    if (error) throw new Error(`get_dj_plays: track lookup failed: ${error.message}`);
    out.push(...((data ?? []) as TrackRow[]));
  }
  return out;
}

/** Every track in the given canonical groups: the leaders themselves plus any
 * variant pointing at them. A play by any member counts toward the group. */
async function fetchGroupMembers(ctx: any, groupIds: string[]): Promise<TrackRow[]> {
  const byId = new Map<string, TrackRow>();
  for (const t of await fetchTracksByIds(ctx, groupIds)) byId.set(t.id, t);
  for (const batch of chunk(groupIds, IN_CHUNK)) {
    if (batch.length === 0) continue;
    // Paged: one canonical group can have many variants, and a truncated member
    // list undercounts distinct_days for the group it belongs to.
    const variants = await selectAllRows<TrackRow>(
      ctx, "get_dj_plays: group member lookup failed", "dj_tracks", TRACK_COLS,
      (q) => q.in("canonical_track_id", batch),
    );
    for (const t of variants) byId.set(t.id, t);
  }
  return [...byId.values()];
}

async function resolveTrackIdsForVideoIds(ctx: any, videoIds: string[]): Promise<string[]> {
  const seeds = await fetchTracksByVideoIds(ctx, videoIds);
  if (seeds.length === 0) return [];
  const groupIds = [...new Set(seeds.map(groupIdOf))];
  return (await fetchGroupMembers(ctx, groupIds)).map((t) => t.id);
}

/**
 * Aggregate plays into canonical groups, LEAST FAMILIAR FIRST.
 *
 * ⚠️ EXTRACTED SO CRAM ORDER HAS EXACTLY ONE IMPLEMENTATION. This block already
 * carried the comment "this IS cram order (§5)" — and §12.10's cram list needs
 * the same ordering over a playlist's membership. Recomputing it in a second
 * place would put spec §12.10 in two files, which is §11.14 inside one module:
 * the sort would agree today and drift on the next change to either copy.
 *
 * Pure given its inputs. The FETCHING stays with each caller, because
 * get_dj_plays supports a date-range subject and cram mode never does.
 */
export function buildFamiliarity(
  members: TrackRow[],
  playRows: PlayRow[],
  unknownVideoIds: string[],
  asOf: string,
  // Which ids the caller ENUMERATED, echoed back per group as
  // requested_video_ids. Undefined for the date-range subject, and for cram
  // mode, where the subject is a playlist rather than a list of ids.
  videoIds?: string[],
): Array<Record<string, unknown>> {
  // 3. Aggregate by canonical group.
  const trackById = new Map(members.map((t) => [t.id, t]));
  const groups = new Map<string, {
    members: TrackRow[];
    days: Map<string, string[]>;   // played_on -> precisions seen that day
    rows: number;
  }>();
  const ensure = (gid: string) => {
    let g = groups.get(gid);
    if (!g) { g = { members: [], days: new Map(), rows: 0 }; groups.set(gid, g); }
    return g;
  };
  for (const t of members) ensure(groupIdOf(t)).members.push(t);
  for (const r of playRows) {
    const t = trackById.get(r.track_id);
    if (!t) continue;
    const g = ensure(groupIdOf(t));
    g.rows += 1;
    const list = g.days.get(r.played_on) ?? [];
    list.push(r.precision);
    g.days.set(r.played_on, list);
  }

  const requestedFor = new Map<string, string[]>();
  if (videoIds?.length) {
    const wanted = new Set(videoIds);
    for (const t of members) {
      if (!wanted.has(t.video_id)) continue;
      const gid = groupIdOf(t);
      requestedFor.set(gid, [...(requestedFor.get(gid) ?? []), t.video_id]);
    }
  }

  const out = [...groups.entries()].map(([gid, g]) => {
    const canonical = trackById.get(gid) ?? g.members[0];
    const days = [...g.days.keys()].sort();
    // A day is ESTIMATED when every row on it is a coarse-bucket guess.
    // Expected to be 0 — the poll writes only `day` and Takeout writes
    // `exact` — which is precisely why it should be visible if it ever isn't.
    const estimated = days.filter((d) =>
      (g.days.get(d) ?? []).every((p) => p === "week" || p === "fortnight")
    ).length;
    const last = days.length ? days[days.length - 1] : null;
    return {
      canonical_track_id: gid,
      canonical_title: canonical?.title ?? null,
      canonical_video_id: canonical?.video_id ?? null,
      // Exposed for the same reason album was: a field nobody can read is a
      // field nobody can check. The poll and Takeout can disagree on an
      // artist's spelling ("Eddie Higgins Trio" vs "Eddie Higgins"), which
      // silently splits one act into two match_key groups — and familiarity
      // is exactly where that split becomes visible.
      canonical_artist: canonical?.artist ?? null,
      distinct_days: days.length,
      estimated_days: estimated,
      play_rows: g.rows,
      first_played_on: days.length ? days[0] : null,
      last_played_on: last,
      days_since_last: last ? daysBetween(last, asOf) : null,
      member_video_ids: g.members.map((m) => m.video_id).sort(),
      requested_video_ids: requestedFor.get(gid) ?? [],
      known_track: true,
    };
  });

  // ZERO-PLAY TRACKS ARE THE POINT, NOT AN EDGE CASE.
  //
  // familiarity reads dj_plays, so a never-played track produces no row — and
  // those are exactly the songs that belong at the TOP of a cram list, since
  // §5 orders least-familiar first and nothing is less familiar than never
  // heard. Leaving the caller to notice which ids came back missing is
  // reconstruction logic that gets written once, forgotten, and then quietly
  // wrong. A video_id unknown to dj_tracks entirely — a newly discovered
  // setlist song — is included too, with known_track: false.
  for (const v of unknownVideoIds) {
    out.push({
      canonical_track_id: null as unknown as string,
      canonical_title: null,
      canonical_video_id: v,
      canonical_artist: null,
      distinct_days: 0,
      estimated_days: 0,
      play_rows: 0,
      first_played_on: null,
      last_played_on: null,
      days_since_last: null,
      member_video_ids: [v],
      requested_video_ids: [v],
      known_track: false,
    });
  }

  // Least familiar first — this IS cram order (§5). Never-played sort to the
  // top; among equals, the one heard longest ago comes first.
  out.sort((a, b) =>
    a.distinct_days - b.distinct_days ||
    (a.last_played_on ?? "").localeCompare(b.last_played_on ?? "") ||
    (a.canonical_title ?? "").localeCompare(b.canonical_title ?? "")
  );

  return out;
}

function zeroOnlyResult(
  videoIds: string[], asOf: string, fromDate?: string, toDate?: string,
) {
  return {
    data: {
      mode: "familiarity",
      as_of: asOf,
      groups: videoIds.map((v) => ({
        canonical_track_id: null,
        canonical_title: null,
        canonical_video_id: v,
        canonical_artist: null,
        distinct_days: 0,
        estimated_days: 0,
        play_rows: 0,
        first_played_on: null,
        last_played_on: null,
        days_since_last: null,
        member_video_ids: [v],
        requested_video_ids: [v],
        known_track: false,
      })),
      returned: videoIds.length,
      total_groups: videoIds.length,
      rows_scanned: 0,
      requested_video_ids: videoIds,
      requested_count: videoIds.length,
      unknown_ids_returned_as_zeros: videoIds,
      all_requested_returned: true,
      from_date: fromDate ?? null,
      to_date: toDate ?? null,
      reading:
        "None of these video_ids are known to dj_tracks, so all are zero-played. " +
        "They are RETURNED as zero rows above, not omitted. distinct_days 0 is a " +
        "fact; days_since_last null means never.",
    },
    meta: {},
  };
}

// ---------------------------------------------------------------------------
// get_dj_managed_playlists — tier 1
// ---------------------------------------------------------------------------

const PLAYLIST_COLS =
  "id, yt_playlist_id, name, kind, concert_id, description, cram_cap, last_synced_at, created_at";
const MEMBER_COLS =
  "id, playlist_id, track_id, role, position, yt_set_video_id, added_reason, added_at";

interface MemberRow {
  id: string;
  playlist_id: string;
  track_id: string;
  role: string;
  position: number;
  yt_set_video_id: string | null;
  added_reason: string | null;
  added_at: string;
}

/**
 * Spec §5: rendered YouTube order is EVERY CRAM ROW BY POSITION, THEN EVERY
 * BODY ROW BY POSITION. Computed here, once, rather than by each caller.
 *
 * A caller reimplementing this would not error when it diverged — it would diff
 * against the wrong index and propose confidently wrong moves. Same reasoning
 * that made the canonical resolver shared: silent divergence is the failure
 * mode, so there is exactly one implementation.
 *
 * `position` is per-ZONE, so cram 1 and body 1 both exist and are different
 * entries. A track may legitimately hold one row in each zone — that
 * duplication is what makes "clear the cram list" leave the setlist intact —
 * so this must never deduplicate by track.
 */
function withRenderedPositions(
  rows: MemberRow[],
): Array<MemberRow & { rendered_position: number }> {
  const byPos = (a: MemberRow, b: MemberRow) => a.position - b.position;
  const cram = rows.filter((r) => r.role === "cram").sort(byPos);
  const body = rows.filter((r) => r.role === "body").sort(byPos);
  return [...cram, ...body].map((r, i) => ({ ...r, rendered_position: i }));
}

export const getDjManagedPlaylistsTool = defineTool({
  name: "get_dj_managed_playlists",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const mode = (args.mode as string | undefined) ?? "list";
    if (!["list", "tracks", "engagement", "cram"].includes(mode)) {
      throw new Error(
        `get_dj_managed_playlists: \`mode\` must be 'list', 'tracks', ` +
          `'engagement' or 'cram' (got ${JSON.stringify(mode)}).`,
      );
    }

    // --- cram (spec §12.10) ----------------------------------------------
    //
    // ⚠️ THE ORDER IS buildFamiliarity's, NOT A SECOND SORT. That function
    // already returns one row per CANONICAL GROUP, least-familiar-first — which
    // is both §12.10's dedupe and its primary sort. Re-sorting here would be the
    // spec living in two places.
    //
    // §12.10 adds only what familiarity cannot know: the playlist's own body
    // position as a final tie-break, and the two staleness STATES.
    if (mode === "cram") {
      const ytId = args.yt_playlist_id as string | undefined;
      const plId = args.playlist_id as string | undefined;
      if (!ytId && !plId) {
        throw new Error(
          "get_dj_managed_playlists: mode 'cram' requires `yt_playlist_id` or `playlist_id`.",
        );
      }
      let q0 = ctx.db.from("dj_playlists").select(PLAYLIST_COLS);
      q0 = ytId ? q0.eq("yt_playlist_id", ytId) : q0.eq("id", plId as string);
      const { data: pl0, error: e0 } = await q0.maybeSingle();
      if (e0) throw new Error(`get_dj_managed_playlists: ${e0.message}`);
      if (!pl0) throw new Error("get_dj_managed_playlists: no such playlist.");
      const playlist = pl0 as Record<string, unknown>;

      // ⚠️ CONCERT ONLY. §5: "Only kind=concert has a setlist body and therefore
      // a cram block." Returning an order for a jazz or utility playlist would
      // invent a concept that playlist does not have.
      if (playlist.kind !== "concert") {
        throw new Error(
          `get_dj_managed_playlists: cram applies to kind 'concert' only; ` +
            `"${playlist.name}" is '${playlist.kind}'. Only a concert playlist has ` +
            `a cram block (spec §5) — the others are flat.`,
        );
      }

      const membership = await selectAllRows<Record<string, unknown>>(
        ctx,
        "get_dj_managed_playlists: cram membership read failed",
        "dj_playlist_tracks",
        "id, track_id, role, position",
        (q) => q.eq("playlist_id", playlist.id as string),
      );

      const trackIds = [...new Set(membership.map((m) => m.track_id as string))];
      const memberTracks = await fetchTracksByIds(ctx, trackIds);
      const groupIds = [...new Set(memberTracks.map(groupIdOf))];
      const allMembers = await fetchGroupMembers(ctx, groupIds);

      // ⚠️ PAGED, AND THE STAKES ARE HIGHER HERE THAN IN THE COUNTS. A capped
      // plays read yields a distinct_days that is WRONG rather than short, and
      // §12.10 sorts the cram list by it — a well-known song would surface as
      // least familiar with nothing in the response to show why.
      const plays: PlayRow[] = [];
      for (const ids of chunk(allMembers.map((t) => t.id), IN_CHUNK)) {
        plays.push(...await selectAllRows<PlayRow>(
          ctx,
          "get_dj_managed_playlists: cram plays read failed",
          "dj_plays",
          PLAY_COLS,
          (q) => q.in("track_id", ids),
        ));
      }

      const asOf = (args.as_of as string | undefined) ??
        new Date().toISOString().slice(0, 10);
      const fam = buildFamiliarity(allMembers, plays, [], asOf);

      // Group -> the playlist rows that belong to it, so body position can break
      // ties and cram membership can be read off.
      const groupOfTrack = new Map(memberTracks.map((t) => [t.id, groupIdOf(t)]));
      const bodyPos = new Map<string, number>();
      const cramGroups = new Set<string>();
      for (const m of membership) {
        const gid = groupOfTrack.get(m.track_id as string);
        if (!gid) continue;
        if (m.role === "cram") cramGroups.add(gid);
        else {
          const p = m.position as number;
          if (!bodyPos.has(gid) || p < (bodyPos.get(gid) as number)) bodyPos.set(gid, p);
        }
      }

      const inPlaylist = fam.filter((g) =>
        groupIds.includes(g.canonical_track_id as string));
      // Final tie-break only — familiarity's own ordering is preserved above it.
      inPlaylist.sort((a, b) =>
        (a.distinct_days as number) - (b.distinct_days as number) ||
        ((a.last_played_on as string) ?? "").localeCompare((b.last_played_on as string) ?? "") ||
        (bodyPos.get(a.canonical_track_id as string) ?? 1e9) -
        (bodyPos.get(b.canonical_track_id as string) ?? 1e9));

      const cap = (playlist.cram_cap as number) ?? 8;

      // --- §12.10 D: A VARIANT CUT NEVER TAKES A SLOT FROM ITS OWN STUDIO CUT
      //
      // 🛑 THE RULE WORKED AND THE OUTCOME WAS WRONG. Measured 2026-09-02, two of
      // the Foo Fighters playlist's eight cram slots were Marigold: Nirvana's
      // studio original at body position 12, and the 2006 Pantages live cut at
      // 29. They are genuinely different recordings by different artists, so the
      // canonical-group dedupe correctly declined to merge them — and the result
      // was eight slots teaching seven songs.
      //
      // ⚠️ THE FIX REUSES `isVariantCut`, WHICH ALREADY EXISTS, rather than
      // inventing a cram-specific rule. You learn a song from the studio cut, not
      // from a live recording of it, so when two candidates share a title and one
      // of them is a variant, the variant stands down.
      //
      // ⚠️ IT NEVER MERGES TWO STUDIO RECORDINGS, WHICH IS THE WHOLE REASON IT IS
      // SAFE. Deduping on title alone would collapse Weezer's Happy Together onto
      // The Turtles' — a cover and its original are two songs to learn, and one of
      // them would then never be crammed. This rule cannot do that: it only ever
      // drops a cut that is MARKED as a variant, and only when a non-variant
      // sibling is present in the same playlist. A playlist holding only a live
      // cut still crams it.
      //
      // When the tie is NOT a variant tie — two real recordings sharing a title —
      // nothing is suppressed and `duplicate_titles_in_cram` reports it instead.
      // That case is a judgement about this library, not one to make silently.
      const titleKeyOf = (g: Record<string, unknown>) =>
        normalisePart((g.canonical_title as string) ?? "");
      const byTitle = new Map<string, Array<Record<string, unknown>>>();
      for (const g of inPlaylist) {
        const k = titleKeyOf(g);
        if (!k) continue;
        const arr = byTitle.get(k);
        if (arr) arr.push(g);
        else byTitle.set(k, [g]);
      }

      const variantsSuppressed: Array<Record<string, unknown>> = [];
      const candidates = inPlaylist.filter((g) => {
        const siblings = byTitle.get(titleKeyOf(g));
        if (!siblings || siblings.length < 2) return true;
        const studioSiblings = siblings.filter(
          (s) => !isVariantCut(s.canonical_title as string),
        );
        if (studioSiblings.length > 0 && isVariantCut(g.canonical_title as string)) {
          variantsSuppressed.push({
            title: g.canonical_title,
            video_id: g.canonical_video_id,
            distinct_days: g.distinct_days,
            kept_instead: studioSiblings.map((s) => ({
              title: s.canonical_title,
              artist: s.canonical_artist,
              video_id: s.canonical_video_id,
            })),
          });
          return false;
        }
        return true;
      });

      const proposed = candidates.slice(0, cap).map((g, i) => ({
        rank: i,
        canonical_track_id: g.canonical_track_id,
        title: g.canonical_title,
        artist: g.canonical_artist,
        video_id: g.canonical_video_id,
        distinct_days: g.distinct_days,
        days_since_last: g.days_since_last,
        body_position: bodyPos.get(g.canonical_track_id as string) ?? null,
        in_cram_now: cramGroups.has(g.canonical_track_id as string),
      }));

      // The C fallthrough. Two candidates sharing a title where neither is a
      // variant is a real choice about this library — reported, never resolved
      // here, and the entries carry artist and video_id so it is settleable.
      const titleCounts = new Map<string, number>();
      for (const p of proposed) {
        const k = normalisePart((p.title as string) ?? "");
        titleCounts.set(k, (titleCounts.get(k) ?? 0) + 1);
      }
      const duplicateTitlesInCram = [...titleCounts.entries()]
        .filter(([, n]) => n > 1)
        .map(([k]) => ({
          title: proposed.find((p) => normalisePart((p.title as string) ?? "") === k)?.title,
          entries: proposed
            .filter((p) => normalisePart((p.title as string) ?? "") === k)
            .map((p) => ({
              title: p.title, artist: p.artist, video_id: p.video_id,
              distinct_days: p.distinct_days, body_position: p.body_position,
            })),
        }));

      // ⚠️ cram_stale FIRES ON A STATE, NEVER ON SORT DRIFT (§12.10, §11.7). On a
      // playlist being actively listened to, a recomputed top-N differs most
      // weeks; a flag keyed on that would be noise inside a month and then
      // ignored the once it mattered.
      const unlearnedNotCrammed = inPlaylist.filter((g) =>
        (g.distinct_days as number) === 0 &&
        !cramGroups.has(g.canonical_track_id as string));
      const learnedStillCrammed = inPlaylist.filter((g) =>
        (g.distinct_days as number) >= LEARNED_DISTINCT_DAYS &&
        cramGroups.has(g.canonical_track_id as string));
      const cramStale =
        unlearnedNotCrammed.length > 0 || learnedStillCrammed.length > 0;

      // --- ADDED 2026-09-02: COMPLETE — the state §12.10 did not have ---------
      //
      // 🛑 NOT STALE, NOT FRESH. Measured 2026-09-02, the Weezer playlist held
      // thirteen songs whose LEAST familiar had eight distinct days. The ordering
      // was real and its purpose had evaporated: a cram list of songs he already
      // knows. `cram_stale` read false, correctly and uselessly.
      //
      // ⚠️ IT REUSES §12.10(b)'s EXISTING DEFINITION OF LEARNED rather than
      // introducing a second threshold. Two constants both meaning "learned" is a
      // constraint written twice, and it would be enforced in one (§11.14).
      //
      // ⚠️ IT SELF-HEALS, WHICH IS WHY A FLOOR IS SAFE HERE. Accept one song from
      // a §12.2 diff and the playlist stops being complete, because the new song
      // sits at distinct_days 0. The state cannot latch.
      const unlearnedAnywhere = inPlaylist.filter(
        (g) => (g.distinct_days as number) < LEARNED_DISTINCT_DAYS,
      );
      const cramComplete = inPlaylist.length > 0 && unlearnedAnywhere.length === 0;

      return { data: {
        mode: "cram",
        playlist: {
          id: playlist.id, name: playlist.name, kind: playlist.kind,
          cram_cap: cap, concert_id: playlist.concert_id,
        },
        // Nothing to cram when every song is learned. The cram block should be
        // CLEARED, not reordered — which `learned_still_crammed` already says,
        // since under COMPLETE every cram row is by definition a learned one.
        proposed_cram: cramComplete ? [] : proposed,
        cram_complete: cramComplete,
        cram_state: cramComplete ? "complete" : (cramStale ? "stale" : "working"),
        // The floor, always — so "complete" is a CHECKABLE claim rather than an
        // assertion (§11.12). These are the songs that would be crammed next.
        least_familiar: inPlaylist.slice(0, 3).map((g) => ({
          title: g.canonical_title,
          distinct_days: g.distinct_days,
          days_since_last: g.days_since_last,
        })),
        learned_threshold: LEARNED_DISTINCT_DAYS,
        variants_suppressed: variantsSuppressed,
        duplicate_titles_in_cram: duplicateTitlesInCram,
        current_cram_size: cramGroups.size,
        cram_stale: cramStale,
        stale_reasons: {
          unlearned_not_crammed: unlearnedNotCrammed.map((g) => ({
            title: g.canonical_title, distinct_days: 0,
          })),
          learned_still_crammed: learnedStillCrammed.map((g) => ({
            title: g.canonical_title, distinct_days: g.distinct_days,
          })),
        },
        reading:
          "Order is least-familiar-first over CANONICAL GROUPS (§12.10): " +
          "distinct_days ascending, then longest-unheard, then body position as a " +
          "deterministic tie-break so the list does not reshuffle between runs for " +
          "no reason. Groups, not rows — a body may hold the same song more than " +
          "once since migration 012, and without deduping one song could take " +
          "several of the " + cap + " slots with identical familiarity. " +
          "⚠️ `cram_stale` is a STATE, not a sort comparison: it fires when an " +
          "unplayed track holds no cram row, or a track played on " +
          LEARNED_DISTINCT_DAYS + "+ days is still occupying a slot. A flag keyed " +
          "on the order changing would fire most weeks and be ignored by the third " +
          "one. " +
          "⚠️ `cram_complete` means EVERY song in the playlist is learned (" +
          LEARNED_DISTINCT_DAYS + "+ distinct days), so there is nothing to cram " +
          "and any existing cram rows should be cleared. `least_familiar` carries " +
          "the floor so the claim can be checked rather than taken. " +
          "🛑 NEVER REPORT `cram_complete` WITHOUT SETLIST COVERAGE BESIDE IT — " +
          "`in_body` / `distinct_setlist_songs` from diff_dj_setlists. This tool " +
          "cannot compute that and will not imply it: a COMPLETE playlist of 13 " +
          "songs covering 12 of 34 distinct setlist songs means 'you know a third " +
          "of it', and printing 'you know this one' alone would wrong-foot him on " +
          "the night. Complete is a fact about the PLAYLIST, never about the SHOW. " +
          "⚠️ `variants_suppressed` lists cuts that stood down because a studio " +
          "recording of the same title is in the playlist — you learn a song from " +
          "the studio cut. `duplicate_titles_in_cram` is the case that rule does " +
          "NOT resolve: two non-variant recordings sharing a title, reported " +
          "because it is a judgement about this library rather than a tie to break.",
      }, meta: {} };
    }

    // --- engagement (spec §12.9) -----------------------------------------
    //
    // ⚠️ THE ARITHMETIC IS IN SQL, NOT HERE. dj_playlist_engagement (migration
    // 013) owns the definition of `runs`; this mode resolves ids and shapes the
    // answer. A second implementation in TypeScript would agree with the first
    // until one of them changed.
    if (mode === "engagement") {
      const windowDays = (args.window_days as number | undefined) ?? 90;
      let idq = ctx.db.from("dj_playlists").select("id, name, kind, yt_playlist_id");
      if (args.kind !== undefined) idq = idq.eq("kind", args.kind as string);
      if (args.playlist_ids !== undefined) {
        idq = idq.in("id", args.playlist_ids as string[]);
      }
      const { data: pls, error: pErr } = await idq;
      if (pErr) throw new Error(`get_dj_managed_playlists: ${pErr.message}`);
      const rows = (pls ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return { data: { mode: "engagement", playlists: [], returned: 0, window_days: windowDays }, meta: {} };
      }

      // ⚠️ TWO ARGUMENTS, NOT THREE, AND THAT IS DELIBERATE. Migration 015 adds
      // `p_recent_days` WITH A DEFAULT, so this call resolves against the old
      // two-arg function and the new three-arg one alike. Passing the third
      // would break engagement for everyone between this deploy and that
      // migration being applied — a window in which the tool errors while the
      // deploy has been announced as done.
      const { data: eng, error: eErr } = await ctx.db.rpc("dj_playlist_engagement", {
        p_playlist_ids: rows.map((r) => r.id as string),
        p_window_days: windowDays,
      });
      if (eErr) {
        throw new Error(`get_dj_managed_playlists: engagement failed: ${eErr.message}`);
      }
      const byId = new Map<string, Record<string, unknown>>();
      for (const e of (eng ?? []) as Array<Record<string, unknown>>) {
        byId.set(e.playlist_id as string, e);
      }

      const today = new Date().toISOString().slice(0, 10);
      const days = (d: string | null) =>
        d === null ? null
          : Math.round((Date.parse(today) - Date.parse(d)) / 86400000);

      const playlists = rows.map((r) => {
        const e = byId.get(r.id as string) ?? {};
        const runs = (e.runs as number) ?? 0;
        const lastRun = (e.last_run_on as string | null) ?? null;
        const lastTouched = (e.last_touched_on as string | null) ?? null;
        return {
          ...r,
          distinct_groups: e.distinct_groups ?? 0,
          threshold_used: e.threshold ?? null,
          window_days: windowDays,
          runs,
          last_run_on: lastRun,
          days_since_last_run: days(lastRun),
          // ⚠️ CHANGED 2026-09-02: returned ALWAYS, not only when runs is 0. The
          // old rule was written for Section 2, where a run is the headline.
          // Section 4 has no runs to speak of and this is its primary signal —
          // nulling it on the playlists that DO get run hid rotation exactly
          // where rotation is highest.
          last_touched_on: lastTouched,
          days_since_last_touch: days(lastTouched),
          // ROTATION, from migration 015. Undefined until it is applied, and
          // NULL rather than 0 so "not measured yet" cannot be read as "never
          // played" — the same null-vs-zero distinction §12.9 makes deliberately.
          touch_days: (e.touch_days as number | undefined) ?? null,
          touch_days_recent: (e.touch_days_recent as number | undefined) ?? null,
          touch_days_prior: (e.touch_days_prior as number | undefined) ?? null,
          went_quiet: (e.went_quiet as boolean | undefined) ?? null,
        };
      });

      return { data: {
        mode: "engagement",
        playlists,
        returned: playlists.length,
        window_days: windowDays,
        reading:
          "`runs` counts DAYS on which at least `threshold_used` distinct " +
          "canonical groups from the playlist were played — NOT sessions and NOT " +
          "plays. dj_plays buckets by UTC day and the feed carries one entry per " +
          "track per bucket, so two runs in one day are indistinguishable from " +
          "one. threshold_used = clamp(ceil(0.5 * distinct_groups), 4, 20); the " +
          "cap of 20 stops a 379-track playlist needing 190 songs in a day, which " +
          "would be a guarantee of zero rather than a threshold. " +
          "⚠️ `last_touched_on` is the most recent day ANY track from the playlist " +
          "was played — a different statement from a run, and returned ALWAYS. " +
          "🛑 `runs` AND `touch_days` ANSWER DIFFERENT QUESTIONS; DO NOT REPORT THEM " +
          "AS ONE IDEA. `runs` asks 'have I LEARNED this set' and is the CONCERT " +
          "metric. `touch_days` asks 'is this still in ROTATION' and counts days " +
          "with ANY track, no threshold. On 2026-09-02 `runs` read 0 for nineteen " +
          "consecutive non-concert playlists, fourteen of them against the threshold " +
          "cap of 20 — that is a concert metric asked a non-concert question, not a " +
          "library going unused. Use `touch_days` for anything that is not concert " +
          "prep. " +
          "⚠️ `went_quiet` is a CHANGE, not a level: warm before the last " +
          "`recent_days` and silent within them. A cold list ranked by " +
          "`last_touched_on` would print every seasonal playlist every week — " +
          "Christmas jazz is flat-cold in September and must NOT appear. " +
          "⚠️ touch_days / went_quiet are NULL until migration 015 is applied, and " +
          "null means NOT MEASURED, never zero. " +
          "⚠️ A track in two playlists counts toward both.",
      }, meta: {} };
    }

    if (mode === "list") {
      const limit = clampLimit(args.limit as number | undefined);
      let q = ctx.db
        .from("dj_playlists")
        .select(PLAYLIST_COLS, { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(limit);
      if (args.kind) q = q.eq("kind", args.kind as string);
      if (args.concert_id) q = q.eq("concert_id", args.concert_id as string);
      const { data, error, count } = await q;
      if (error) throw new Error(`get_dj_managed_playlists: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;

      // Counts ride along because phase 7 must compare cram against cram_cap
      // BEFORE deciding whether anything may be added — and a second call is a
      // call that gets skipped.
      const ids = rows.map((r) => r.id as string);
      const counts = new Map<string, { body: number; cram: number; total: number }>();
      // ⚠️ DISTINCT SONGS IS NOT ROW COUNT — migration 012. A body may hold the
      // same track more than once (Archived Weezer: 160 rows, ~50 distinct), so
      // "30 tracks" and "30 different songs" stopped being the same statement.
      // Both are reported, because a caller sizing a cram list wants the second
      // and a caller checking against YouTube wants the first.
      const distinct = new Map<string, Set<string>>();
      for (const id of ids) {
        counts.set(id, { body: 0, cram: 0, total: 0 });
        distinct.set(id, new Set<string>());
      }
      for (const batch of chunk(ids, IN_CHUNK)) {
        if (batch.length === 0) continue;
        // ⚠️ PAGED. This is the read that returned exactly 1000 rows for a
        // library holding roughly 2,400 — see selectAllRows. Counting a
        // truncated membership does not produce a short count, it produces a
        // ZERO for every playlist past the cut.
        const mem = await selectAllRows<{ playlist_id: string; role: string; track_id: string }>(
          ctx,
          "get_dj_managed_playlists: membership count failed",
          "dj_playlist_tracks",
          "id, playlist_id, role, track_id",
          (q) => q.in("playlist_id", batch),
        );
        for (const m of mem) {
          const c = counts.get(m.playlist_id);
          if (!c) continue;
          if (m.role === "cram") c.cram += 1;
          else c.body += 1;
          c.total += 1;
          distinct.get(m.playlist_id)!.add(m.track_id);
        }
      }

      const playlists = rows.map((r) => {
        const c = counts.get(r.id as string) ?? { body: 0, cram: 0, total: 0 };
        return {
          ...r,
          track_counts: c,
          distinct_tracks: (distinct.get(r.id as string) ?? new Set()).size,
          cram_headroom: (r.cram_cap as number) - c.cram,
        };
      });
      const total = count ?? playlists.length;
      return {
        data: {
          mode: "list",
          playlists,
          returned: playlists.length,
          total,
          limit_applied: limit,
          note: "This is the SUPABASE record. Workshop's get_dj_playlists reads YouTube.",
        },
        meta: playlists.length < total
          ? { truncated: true, total, limit_applied: limit, count: playlists.length }
          : {},
      };
    }

    // -------------------------------------------------------------- tracks
    const ytId = args.yt_playlist_id as string | undefined;
    const plId = args.playlist_id as string | undefined;
    if (!ytId && !plId) {
      throw new Error(
        "get_dj_managed_playlists: mode 'tracks' requires `yt_playlist_id` or " +
          "`playlist_id`. Either works — Workshop only ever knows the YouTube one.",
      );
    }
    let pq = ctx.db.from("dj_playlists").select(PLAYLIST_COLS);
    pq = ytId ? pq.eq("yt_playlist_id", ytId) : pq.eq("id", plId as string);
    const { data: pl, error: plErr } = await pq.maybeSingle();
    if (plErr) {
      throw new Error(`get_dj_managed_playlists: playlist lookup failed: ${plErr.message}`);
    }
    if (!pl) {
      throw new Error(
        `get_dj_managed_playlists: no managed playlist matches ` +
          `${ytId ? `yt_playlist_id ${ytId}` : `playlist_id ${plId}`}. It may exist on ` +
          `YouTube without ever having been recorded — record_dj_playlist writes this side.`,
      );
    }
    const playlist = pl as Record<string, unknown>;

    const members = await selectAllRows<MemberRow>(
      ctx,
      "get_dj_managed_playlists: membership read failed",
      "dj_playlist_tracks",
      MEMBER_COLS,
      (q) => q.eq("playlist_id", playlist.id as string),
    );

    const tracks = await fetchTracksByIds(ctx, [...new Set(members.map((m) => m.track_id))]);
    const trackById = new Map(tracks.map((t) => [t.id, t]));

    const ordered = withRenderedPositions(members).map((m) => {
      const t = trackById.get(m.track_id);
      return {
        role: m.role,
        position: m.position,
        rendered_position: m.rendered_position,
        video_id: t?.video_id ?? null,
        title: t?.title ?? null,
        artist: t?.artist ?? null,
        album: t?.album ?? null,
        canonical_track_id: t?.canonical_track_id ?? null,
        yt_set_video_id: m.yt_set_video_id,
        added_reason: m.added_reason,
        added_at: m.added_at,
      };
    });

    const cram = ordered.filter((t) => t.role === "cram").length;
    const missingHandles = ordered.filter((t) => !t.yt_set_video_id).length;

    return {
      data: {
        mode: "tracks",
        playlist,
        tracks: ordered,
        counts: {
          body: ordered.length - cram,
          cram,
          total: ordered.length,
          // Rows, then songs. A body may repeat a track (012), so these diverge
          // and the difference is real rather than a bug to reconcile.
          distinct_tracks: new Set(ordered.map((t) => t.video_id)).size,
          missing_set_video_id: missingHandles,
        },
        cram_headroom: (playlist.cram_cap as number) - cram,
        reading: (
          "`rendered_position` is the 0-indexed order YouTube should show: every " +
          "cram row by position, then every body row by position (spec §5). It is " +
          "computed here so callers do not reimplement the rule — compare it " +
          "directly against `position` from Workshop's get_dj_playlists " +
          "mode=contents. `position` here is per-ZONE, so cram 1 and body 1 are " +
          "different entries and one track may legitimately hold a row in each. " +
          "⚠️ `yt_set_video_id` is a CACHE: stale by default, and reused across " +
          "playlists for DIFFERENT songs — refresh it from a live contents read " +
          "before issuing any move or remove."
        ),
      },
      meta: {},
    };
  },
});

// ---------------------------------------------------------------------------
// get_dj_jazz_activity — tier 1
// ---------------------------------------------------------------------------
//
// 🛑 JAZZ IS A PROXY AND THE REPORT MUST SAY SO. Nothing marks a track as jazz:
// dj_tracks has no genre, and dj_artists — which does have tags — holds 22
// mbid-keyed concert acts and joins to nothing (spec §14.1, §14.3).
//
// ⚠️ THE DEFINITION IS PART OF THE FINDING. A jazz summary that does not say
// what counted as jazz invites the reader to assume a genre model exists, and
// the numbers move if the definition does. `definition` ships with the rows for
// that reason, not as decoration.
//
// 🛑 AND ON 2026-09-02 THE DEFINITION STRING WAS ITSELF WRONG, WHICH IS THE
// REASON THIS COMMENT IS LONGER THAN IT LOOKS LIKE IT NEEDS TO BE.
//
// It read: "Membership alone would miss most of it — the heavily-played pianists
// (Herbie Hancock, Red Garland, Oscar Peterson, Bill Evans, Thelonious Monk, Wes
// Montgomery) arrived through PLAYS rather than through either playlist." The
// tool returned TWO of those six. The artist arm derives its artist list FROM
// tracks already in a jazz playlist, so it widens membership from track-level to
// artist-level and cannot reach outside the playlists at all — the four missing
// pianists were unreachable by construction, Monk among them at 20 distinct days
// and 81 distinct groups, more repertoire than any artist in the library.
//
// ⚠️ IT SURVIVED BECAUSE IT WAS PHRASED AS A JUSTIFICATION. A sentence that
// explains WHY a mechanism exists does not invite anyone to check it against
// that mechanism's output. It was a falsifiable claim about what the data means,
// and it was false (§11.5). Migration 016 adds a third arm with a real source
// (dj_artist_tags) so the claim can be true; until the tags are seeded,
// `by_source.tagged` is 0 and this tool answers the OLD, narrower question.
export const getDjJazzActivityTool = defineTool({
  name: "get_dj_jazz_activity",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const windowDays = (args.window_days as number | undefined) ?? 90;
    const LIMIT = clampLimit(args.limit as number | undefined);

    const { data, error } = await ctx.db.rpc("dj_jazz_activity", {
      p_window_days: windowDays,
    });
    if (error) throw new Error(`get_dj_jazz_activity: ${error.message}`);
    const all = (data ?? []) as Array<Record<string, unknown>>;
    const rows = all.slice(0, LIMIT);

    // ⚠️ COVERAGE IS PART OF THE ANSWER, NOT A DIAGNOSTIC. The tag arm is only
    // as complete as the tags, so a small jazz section and a small jazz habit
    // look identical without this. Counted from the rows returned by the tag
    // arm rather than asserted.
    const bySource = { playlist: 0, artist_in_playlist: 0, tagged: 0 } as
      Record<string, number>;
    for (const r of all) {
      const s = String(r.source ?? "");
      if (s in bySource) bySource[s] += 1;
    }

    return { data: {
      artists: rows,
      returned: rows.length,
      total: all.length,
      window_days: windowDays,
      limit_applied: LIMIT,
      truncated: all.length > rows.length,
      by_source: bySource,
      definition:
        "A play counts as jazz if (1) its track is in a kind='jazz' playlist, " +
        "(2) its artist appears on a track in one, or (3) its artist string is " +
        "tagged 'jazz' in dj_artist_tags. `source` on each row says which arm " +
        "caught it, and `by_source` totals them.",
      gaps:
        "⚠️ STATE THESE IN THE REPORT rather than letting the thread infer a " +
        "source that does not exist (spec §14): " +
        "(1) COVERAGE IS ONLY AS GOOD AS THE TAGS. Arms 1 and 2 cannot reach " +
        "outside the two jazz playlists at all — arm 2 is derived FROM tracks " +
        "already in one, so it widens membership from track-level to " +
        "artist-level and no further. An untagged jazz artist in no playlist is " +
        "still invisible. That is now a DATA gap the reader can close, not a " +
        "structural one they cannot; say how many rows came from `tagged`. " +
        "(2) SUBGENRE IS UNAVAILABLE — nothing records it. " +
        "(3) UNPLAYED ALBUMS CANNOT BE COMPUTED — dj_albums has no writer tool " +
        "and no data, so there is nothing to compare listening against. " +
        "(4) EVERY ARM IS AN EXACT STRING MATCH on dj_tracks.artist, so 'Oscar " +
        "Peterson Trio' and 'Oscar Peterson' do not unify (§4.1.4). The tag arm " +
        "shares that property by design and is curated for it. " +
        "⚠️ THIS TOOL CANNOT PROPOSE NEW ARTISTS. It reports what was played and " +
        "what is missing from the data; 'try Andrew Hill' comes from the thread, " +
        "never from listening history — there is no source for it here.",
      reading:
        "`distinct_days` is DISTINCT DAYS PLAYED, not a play count (spec §5). " +
        "⚠️ `in_jazz_playlist` asks ONLY about the two kind='jazz' playlists. It " +
        "is NOT get_dj_plays mode=artists' `in_any_playlist`, which asks about " +
        "every managed playlist — the two legitimately disagree for the same " +
        "artist, and reading them side by side as one idea is a trap. " +
        "⚠️ ADDED 016 AND WORTH THE SPACE: before the tag arm existed, this " +
        "tool's own definition string named six pianists as proof of the artist " +
        "arm and returned two of them. Thelonious Monk — the broadest repertoire " +
        "in the library — was invisible to it. If `by_source.tagged` is 0 the " +
        "tags have not been seeded and this tool is answering the OLD, narrower " +
        "question; say so rather than reporting the numbers bare.",
    }, meta: { truncated: all.length > rows.length } };
  },
});
