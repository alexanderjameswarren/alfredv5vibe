// Reading the durable listening record back.
//
//   get_dj_plays — tier 1. Two modes:
//     plays        raw rows in a window, newest first
//     familiarity  distinct-days per canonical group, LEAST FAMILIAR FIRST
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

const IN_CHUNK = 100;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_SOURCE = ["poll", "takeout", "manual"];

const PLAY_COLS =
  "id, track_id, played_on, precision, played_bucket, occurrence, source, observed_at";
const TRACK_COLS = "id, video_id, title, artist, canonical_track_id";

interface TrackRow {
  id: string;
  video_id: string;
  title: string;
  artist: string | null;
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
    if (mode !== "plays" && mode !== "familiarity") {
      throw new Error(
        `get_dj_plays: \`mode\` must be 'plays' or 'familiarity' (got ${JSON.stringify(mode)}).`,
      );
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
        let q = ctx.db.from("dj_plays").select(PLAY_COLS).in("track_id", ids);
        q = applyPlayFilters(q);
        const { data, error } = await q;
        if (error) throw new Error(`get_dj_plays: ${error.message}`);
        playRows.push(...((data ?? []) as PlayRow[]));
      }
    } else {
      let q = ctx.db.from("dj_plays").select(PLAY_COLS).limit(SCAN_CAP);
      q = applyPlayFilters(q);
      const { data, error } = await q;
      if (error) throw new Error(`get_dj_plays: ${error.message}`);
      playRows = (data ?? []) as PlayRow[];
      members = await fetchTracksByIds(ctx, [...new Set(playRows.map((r) => r.track_id))]);
      const groupIds = [...new Set(members.map(groupIdOf))];
      members = await fetchGroupMembers(ctx, groupIds);
    }

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
        unknown_video_ids: unknownVideoIds,
        from_date: fromDate ?? null,
        to_date: toDate ?? null,
        reading: (
          "distinct_days is DISTINCT DAYS PLAYED, not a play count — polling " +
          "cannot measure repeats (spec §5). distinct_days 0 with " +
          "days_since_last null means never played; 0 is a fact, null means " +
          "no last play exists. Sorted least-familiar first, which is cram order."
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
    const { data, error } = await ctx.db
      .from("dj_tracks").select(TRACK_COLS).in("canonical_track_id", batch);
    if (error) throw new Error(`get_dj_plays: group member lookup failed: ${error.message}`);
    for (const t of (data ?? []) as TrackRow[]) byId.set(t.id, t);
  }
  return [...byId.values()];
}

async function resolveTrackIdsForVideoIds(ctx: any, videoIds: string[]): Promise<string[]> {
  const seeds = await fetchTracksByVideoIds(ctx, videoIds);
  if (seeds.length === 0) return [];
  const groupIds = [...new Set(seeds.map(groupIdOf))];
  return (await fetchGroupMembers(ctx, groupIds)).map((t) => t.id);
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
      unknown_video_ids: videoIds,
      from_date: fromDate ?? null,
      to_date: toDate ?? null,
      reading:
        "None of these video_ids are known to dj_tracks, so all are zero-played. " +
        "distinct_days 0 is a fact; days_since_last null means never.",
    },
    meta: {},
  };
}
