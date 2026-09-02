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

      const { data: mem, error: mErr } = await ctx.db
        .from("dj_playlist_tracks")
        .select("track_id, role, position")
        .eq("playlist_id", playlist.id as string);
      if (mErr) throw new Error(`get_dj_managed_playlists: ${mErr.message}`);
      const membership = (mem ?? []) as Array<Record<string, unknown>>;

      const trackIds = [...new Set(membership.map((m) => m.track_id as string))];
      const memberTracks = await fetchTracksByIds(ctx, trackIds);
      const groupIds = [...new Set(memberTracks.map(groupIdOf))];
      const allMembers = await fetchGroupMembers(ctx, groupIds);

      let plays: PlayRow[] = [];
      for (const ids of chunk(allMembers.map((t) => t.id), IN_CHUNK)) {
        const { data, error } = await ctx.db
          .from("dj_plays").select(PLAY_COLS).in("track_id", ids);
        if (error) throw new Error(`get_dj_managed_playlists: ${error.message}`);
        plays.push(...((data ?? []) as PlayRow[]));
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
      const proposed = inPlaylist.slice(0, cap).map((g, i) => ({
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

      // ⚠️ cram_stale FIRES ON A STATE, NEVER ON SORT DRIFT (§12.10, §11.7). On a
      // playlist being actively listened to, a recomputed top-N differs most
      // weeks; a flag keyed on that would be noise inside a month and then
      // ignored the once it mattered.
      const unlearnedNotCrammed = inPlaylist.filter((g) =>
        (g.distinct_days as number) === 0 &&
        !cramGroups.has(g.canonical_track_id as string));
      const learnedStillCrammed = inPlaylist.filter((g) =>
        (g.distinct_days as number) >= 5 &&
        cramGroups.has(g.canonical_track_id as string));

      return { data: {
        mode: "cram",
        playlist: {
          id: playlist.id, name: playlist.name, kind: playlist.kind,
          cram_cap: cap, concert_id: playlist.concert_id,
        },
        proposed_cram: proposed,
        current_cram_size: cramGroups.size,
        cram_stale: unlearnedNotCrammed.length > 0 || learnedStillCrammed.length > 0,
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
          "unplayed track holds no cram row, or a track played on 5+ days is still " +
          "occupying a slot. A flag keyed on the order changing would fire most " +
          "weeks and be ignored by the third one.",
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
          // Shown only when there has never been a run — see §12.9. A bare
          // "never" on a partly-heard playlist is wrong in feel.
          last_touched_on: runs === 0 ? lastTouched : null,
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
          "⚠️ `last_touched_on` is populated ONLY when runs is 0 — it means 'never " +
          "run it, but some of its songs came up', which is a different statement " +
          "from a run. ⚠️ A track in two playlists counts toward both.",
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
        const { data: mem, error: memErr } = await ctx.db
          .from("dj_playlist_tracks")
          .select("playlist_id, role, track_id")
          .in("playlist_id", batch);
        if (memErr) {
          throw new Error(
            `get_dj_managed_playlists: membership count failed: ${memErr.message}`,
          );
        }
        for (const m of (mem ?? []) as Array<{ playlist_id: string; role: string; track_id: string }>) {
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

    const { data: mem, error: memErr } = await ctx.db
      .from("dj_playlist_tracks")
      .select(MEMBER_COLS)
      .eq("playlist_id", playlist.id as string);
    if (memErr) {
      throw new Error(`get_dj_managed_playlists: membership read failed: ${memErr.message}`);
    }
    const members = (mem ?? []) as MemberRow[];

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
// dj_tracks has no genre, its tags are unpopulated, and dj_artists — which does
// have tags — holds 22 concert acts against 1,206 distinct artists in the play
// history (spec §14.1, §14.3). So "jazz" is DERIVED from the two kind='jazz'
// playlists: a play counts if the track is in one, OR its artist appears in one.
//
// ⚠️ THE DEFINITION IS PART OF THE FINDING. A jazz summary that does not say
// what counted as jazz invites the reader to assume a genre model exists, and
// the numbers move if the definition does. `definition` ships with the rows for
// that reason, not as decoration.
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

    return { data: {
      artists: rows,
      returned: rows.length,
      total: all.length,
      window_days: windowDays,
      limit_applied: LIMIT,
      truncated: all.length > rows.length,
      definition:
        "A play counts as jazz if its track is in a kind='jazz' playlist, OR its " +
        "artist appears in one. Membership alone would miss most of it — the " +
        "heavily-played pianists (Herbie Hancock, Red Garland, Oscar Peterson, " +
        "Bill Evans, Thelonious Monk, Wes Montgomery) arrived through PLAYS " +
        "rather than through either playlist.",
      gaps:
        "⚠️ STATE THESE IN THE REPORT rather than letting the thread infer a " +
        "source that does not exist (spec §14): " +
        "(1) SUBGENRE IS UNAVAILABLE — tags live on dj_artists, which covers 22 " +
        "concert acts against 1,206 distinct artists played; dj_tracks has no " +
        "link to it at all. " +
        "(2) UNPLAYED ALBUMS CANNOT BE COMPUTED — dj_albums has no writer tool " +
        "and no data, so there is nothing to compare listening against. " +
        "(3) THE ARTIST ARM IS AN EXACT STRING MATCH, so 'Oscar Peterson Trio' " +
        "and 'Oscar Peterson' do not unify (§4.1.4). " +
        "⚠️ THIS TOOL CANNOT PROPOSE NEW ARTISTS. It reports what was played and " +
        "what is missing from the data; 'try Andrew Hill' comes from the thread, " +
        "never from listening history — there is no source for it here.",
      reading:
        "`distinct_days` is DISTINCT DAYS PLAYED, not a play count (spec §5). " +
        "`in_playlist` false means the artist reached this list through the " +
        "artist arm of the definition rather than through membership — those are " +
        "the plays a membership-only definition would have missed.",
    }, meta: { truncated: all.length > rows.length } };
  },
});
