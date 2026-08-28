// Shared track identity + canonical grouping. Used by BOTH record_dj_plays and
// record_dj_playlist.
//
// This lives in one place on purpose. Canonical grouping is the piece that must
// be identical across every import path (spec §4.1) — and because dj_tracks is
// insert-only, a divergence between two copies of this logic would not error,
// it would silently group one path's tracks differently from the other's, with
// no way to correct the rows afterwards (§4.1.2). Duplicating it is exactly the
// failure the spec warns about, so there is one implementation and both callers
// take it.

import { buildMatchKey } from "./dj-normalise.ts";

// PostgREST `.in()` builds a query string; keep each one short.
const IN_CHUNK = 100;

export interface TrackInput {
  video_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_seconds: number | null;
  match_key: string | null;
}

export interface TrackRow {
  id: string;
  video_id: string;
  title: string;
  match_key: string | null;
  canonical_track_id: string | null;
}

export interface CanonicalLink {
  video_id: string;
  title: string;
  match_key: string;
  canonical_track_id: string;
  canonical_video_id: string | null;
  canonical_title: string | null;
}

export interface ResolveResult {
  idByVideoId: Map<string, string>;
  videoIds: string[];
  createdVideoIds: string[];
  linked: CanonicalLink[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Build a TrackInput from raw fields, deriving match_key. `album` is the
 * caller's decision — the poll passes null (spec §9), other sources may not. */
export function toTrackInput(
  video_id: string,
  title: string,
  artists: string[],
  album: string | null,
  duration_seconds: number | null,
): TrackInput {
  return {
    video_id,
    title,
    artist: artists.length > 0 ? artists.join(", ") : null,
    album,
    duration_seconds,
    match_key: buildMatchKey(artists, title),
  };
}

/**
 * Insert any unknown tracks and return video_id -> dj_tracks.id for all of them.
 *
 * INSERT-ONLY throughout: an existing row is never updated, which is what makes
 * hand-curated canonical grouping safe from any automated caller.
 *
 * `label` prefixes error messages with the calling tool's name.
 */
export async function resolveTrackIds(
  prepared: TrackInput[],
  ctx: { db: { from: (t: string) => any } },
  label: string,
): Promise<ResolveResult> {
  // --- Track identity. One row per distinct video_id in this batch.
  const byVideoId = new Map<string, typeof prepared[number]>();
  for (const p of prepared) if (!byVideoId.has(p.video_id)) byVideoId.set(p.video_id, p);
  const videoIds = [...byVideoId.keys()];

  // Which do we already hold? RLS scopes this to the caller.
  const existing = new Map<string, TrackRow>();
  // canonical id -> what that row actually IS, so a link can be reported as
  // "X linked to Y" rather than "X linked to <uuid>".
  const canonicalIdentity = new Map<string, { video_id: string; title: string }>();
  const noteIdentity = (row: TrackRow) =>
    canonicalIdentity.set(row.id, { video_id: row.video_id, title: row.title });
  for (const ids of chunk(videoIds, IN_CHUNK)) {
    const { data, error } = await ctx.db
      .from("dj_tracks")
      .select("id, video_id, title, match_key, canonical_track_id")
      .in("video_id", ids);
    if (error) throw new Error(`${label}: track lookup failed: ${error.message}`);
    for (const row of (data ?? []) as TrackRow[]) {
      existing.set(row.video_id, row);
      noteIdentity(row);
    }
  }

  const newVideoIds = videoIds.filter((v) => !existing.has(v));

  // --- Canonical resolution for the new tracks.
  //
  // The earliest-inserted member of a match_key group is canonical, and
  // canonical_track_id is set ONLY at insert, never re-pointed. If a
  // remaster was seen first, the clean version points at the remaster —
  // fine. Grouping is what matters, not which member is nominally canonical.
  const newKeys = [
    ...new Set(
      newVideoIds
        .map((v) => byVideoId.get(v)!.match_key)
        .filter((k): k is string => !!k),
    ),
  ];

  // Existing group leaders, oldest first so the first seen per key wins.
  const canonicalByKey = new Map<string, string>();
  for (const keys of chunk(newKeys, IN_CHUNK)) {
    const { data, error } = await ctx.db
      .from("dj_tracks")
      .select("id, video_id, title, match_key, canonical_track_id, created_at")
      .in("match_key", keys)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`${label}: match_key lookup failed: ${error.message}`);
    for (const row of (data ?? []) as Array<TrackRow & { created_at: string }>) {
      noteIdentity(row);
      if (!row.match_key || canonicalByKey.has(row.match_key)) continue;
      // Point at the group's canonical, not at a variant.
      canonicalByKey.set(row.match_key, row.canonical_track_id ?? row.id);
    }
  }

  // New tracks whose key has no existing leader: the first in batch order
  // becomes the leader (inserted with canonical_track_id null); the rest
  // point at it. Two waves, because wave 2 needs wave 1's generated ids.
  const leadersInBatch = new Map<string, string>(); // match_key -> video_id
  const waveLeader: string[] = [];
  const waveVariant: string[] = [];
  for (const v of newVideoIds) {
    const key = byVideoId.get(v)!.match_key;
    if (!key) { waveLeader.push(v); continue; }           // no key: stands alone
    if (canonicalByKey.has(key)) { waveVariant.push(v); continue; }
    if (!leadersInBatch.has(key)) {
      leadersInBatch.set(key, v);
      waveLeader.push(v);
    } else {
      waveVariant.push(v);
    }
  }

  const trackRow = (videoId: string, canonicalId: string | null) => {
    const p = byVideoId.get(videoId)!;
    return {
      video_id: p.video_id,
      title: p.title,
      artist: p.artist,
      album: p.album,
      duration_seconds: p.duration_seconds,
      match_key: p.match_key,
      canonical_track_id: canonicalId,
    };
  };

  // ignoreDuplicates: insert-only. A concurrent writer that got there first
  // keeps its row; we never overwrite one.
  const insertTracks = async (rows: Record<string, unknown>[]) => {
    for (const batch of chunk(rows, 200)) {
      const { error } = await ctx.db
        .from("dj_tracks")
        .upsert(batch, { onConflict: "user_id,video_id", ignoreDuplicates: true });
      if (error) throw new Error(`${label}: track insert failed: ${error.message}`);
    }
  };

  if (waveLeader.length > 0) {
    await insertTracks(waveLeader.map((v) => trackRow(v, null)));
    // Re-select rather than trusting the upsert's return shape — with
    // ignoreDuplicates a conflicting row comes back absent, and we need the
    // id either way.
    for (const ids of chunk(waveLeader, IN_CHUNK)) {
      const { data, error } = await ctx.db
        .from("dj_tracks")
        .select("id, video_id, title, match_key, canonical_track_id")
        .in("video_id", ids);
      if (error) throw new Error(`${label}: leader re-read failed: ${error.message}`);
      for (const row of (data ?? []) as TrackRow[]) {
        existing.set(row.video_id, row);
        noteIdentity(row);
        if (row.match_key && !canonicalByKey.has(row.match_key)) {
          canonicalByKey.set(row.match_key, row.canonical_track_id ?? row.id);
        }
      }
    }
  }

  const linked: Array<{
    video_id: string;
    title: string;
    match_key: string;
    canonical_track_id: string;
    canonical_video_id: string | null;
    canonical_title: string | null;
  }> = [];
  if (waveVariant.length > 0) {
    const rows = waveVariant.map((v) => {
      const p = byVideoId.get(v)!;
      const canonicalId = canonicalByKey.get(p.match_key!)!;
      const target = canonicalIdentity.get(canonicalId);
      linked.push({
        video_id: p.video_id,
        title: p.title,
        match_key: p.match_key!,
        canonical_track_id: canonicalId,
        // Reviewing "X was linked to <uuid>" is fine at n=1 and useless at
        // Takeout volume. Name what it was linked TO.
        canonical_video_id: target?.video_id ?? null,
        canonical_title: target?.title ?? null,
      });
      return trackRow(v, canonicalId);
    });
    await insertTracks(rows);
  }

  // --- Final id map. Everything must resolve now.
  const idByVideoId = new Map<string, string>();
  for (const ids of chunk(videoIds, IN_CHUNK)) {
    const { data, error } = await ctx.db
      .from("dj_tracks")
      .select("id, video_id")
      .in("video_id", ids);
    if (error) throw new Error(`${label}: final track read failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; video_id: string }>) {
      idByVideoId.set(row.video_id, row.id);
    }
  }
  const unresolved = videoIds.filter((v) => !idByVideoId.has(v));
  if (unresolved.length > 0) {
    throw new Error(
      `${label}: ${unresolved.length} track(s) could not be resolved after ` +
        `insert (e.g. ${unresolved.slice(0, 3).join(", ")}). No plays were written.`,
    );
  }

    return { idByVideoId, videoIds, createdVideoIds: newVideoIds, linked };
  }
