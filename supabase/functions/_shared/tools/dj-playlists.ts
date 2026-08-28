// DJ playlist + concert records — the Supabase side of phase 3.
//
//   record_dj_playlist — tier 2. dj_playlists + dj_playlist_tracks in one call.
//   create_dj_concert  — tier 2. dj_artists (upsert by name) + dj_concerts.
//
// Both resolve foreign keys server-side, for the same reason record_dj_plays
// does: the alternative is Claude carrying uuids back across a conversation and
// re-associating them by hand, which is a mapping step that can silently pair a
// track with the wrong row.
//
// Track identity comes from the SHARED resolver in dj-tracks.ts, never from a
// local copy. Canonical grouping must be identical across every import path
// (spec §4.1), and because dj_tracks is insert-only a divergence between two
// implementations could never be corrected afterwards (§4.1.2).

import { defineTool } from "../platform.ts";
import { resolveTrackIds, toTrackInput } from "./dj-tracks.ts";

const TRACKS_CAP = 300;
const VALID_KIND = ["concert", "artist", "jazz", "discovery"];
const VALID_ROLE = ["cram", "body"];
const VALID_REASON = ["new_setlist", "neglected", "manual", "import"];
const VALID_STATUS = [
  "screening", "interested", "committed", "attended", "missed", "rejected",
];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TrackInputArg {
  video_id?: string;
  title?: string;
  artists?: string[];
  album?: string | null;
  duration_seconds?: number | null;
  role?: string;
  position?: number;
  yt_set_video_id?: string | null;
  added_reason?: string | null;
}

// ---------------------------------------------------------------------------
// record_dj_playlist — tier 2
// ---------------------------------------------------------------------------

export const recordDjPlaylistTool = defineTool({
  name: "record_dj_playlist",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const ytPlaylistId = args.yt_playlist_id as string | undefined;
    const name = args.name as string | undefined;
    const kind = args.kind as string | undefined;
    const tracks = (args.tracks as TrackInputArg[] | undefined) ?? [];

    if (!ytPlaylistId) throw new Error("record_dj_playlist: `yt_playlist_id` is required.");
    if (!name) throw new Error("record_dj_playlist: `name` is required.");
    if (!kind || !VALID_KIND.includes(kind)) {
      throw new Error(
        `record_dj_playlist: \`kind\` must be one of ${VALID_KIND.join(", ")}.`,
      );
    }
    if (!Array.isArray(tracks)) {
      throw new Error("record_dj_playlist: `tracks` must be an array.");
    }
    if (tracks.length > TRACKS_CAP) {
      throw new Error(
        `record_dj_playlist: ${tracks.length} tracks exceeds the cap of ${TRACKS_CAP}. ` +
          `Nothing was written.`,
      );
    }

    const concertId = (args.concert_id as string | null | undefined) ?? null;
    if (concertId && kind !== "concert") {
      // Mirrors the dj_playlists_concert_link CHECK, but fails with a sentence
      // rather than a constraint name.
      throw new Error(
        "record_dj_playlist: `concert_id` may only be set when kind is 'concert'.",
      );
    }

    // --- Validate every track before writing anything.
    const errors: string[] = [];
    const seen = new Set<string>();
    tracks.forEach((t, i) => {
      const at = `tracks[${i}]`;
      if (!t?.video_id) errors.push(`${at}: \`video_id\` is required.`);
      if (!t?.title) errors.push(`${at}: \`title\` is required.`);
      if (!t?.role || !VALID_ROLE.includes(t.role)) {
        errors.push(`${at}: \`role\` must be 'cram' or 'body'.`);
      }
      if (!Number.isInteger(t?.position)) {
        errors.push(`${at}: \`position\` must be an integer.`);
      }
      if (t?.added_reason && !VALID_REASON.includes(t.added_reason)) {
        errors.push(`${at}: \`added_reason\` must be one of ${VALID_REASON.join(", ")}.`);
      }
      // (role, position) and (role, track_id) are both UNIQUE in the table.
      // Catch collisions here so the caller gets "you sent two body rows at
      // position 3" rather than a constraint name.
      const posKey = `${t?.role}|${t?.position}`;
      if (seen.has(posKey)) errors.push(`${at}: duplicate (role, position) ${posKey}.`);
      seen.add(posKey);
      const trackKey = `${t?.role}|${t?.video_id}`;
      if (seen.has(trackKey)) {
        errors.push(
          `${at}: duplicate (role, video_id) ${trackKey}. A track may hold one row ` +
            `per ZONE — the same song in both cram and body is legitimate, twice in ` +
            `the same zone is not.`,
        );
      }
      seen.add(trackKey);
    });
    if (errors.length > 0) {
      const shown = errors.slice(0, 20);
      const more = errors.length - shown.length;
      throw new Error(
        `record_dj_playlist: ${errors.length} validation error(s). No rows written:\n` +
          shown.join("\n") + (more > 0 ? `\n(+${more} more)` : ""),
      );
    }

    // --- Playlist row. Read-then-write rather than upsert: user_id carries a
    // DEFAULT rather than being supplied, so naming it in an ON CONFLICT target
    // is fragile. Two round trips, no ambiguity.
    const { data: found, error: findErr } = await ctx.db
      .from("dj_playlists")
      .select("id")
      .eq("yt_playlist_id", ytPlaylistId)
      .maybeSingle();
    if (findErr) throw new Error(`record_dj_playlist: playlist lookup failed: ${findErr.message}`);

    const fields = {
      yt_playlist_id: ytPlaylistId,
      name,
      kind,
      concert_id: concertId,
      description: (args.description as string | null | undefined) ?? null,
      ...(args.cram_cap !== undefined ? { cram_cap: args.cram_cap as number } : {}),
      last_synced_at: new Date().toISOString(),
    };

    let playlistId: string;
    let playlistCreated = false;
    if (found?.id) {
      playlistId = found.id as string;
      const { error } = await ctx.db.from("dj_playlists").update(fields).eq("id", playlistId);
      if (error) throw new Error(`record_dj_playlist: playlist update failed: ${error.message}`);
    } else {
      const { data, error } = await ctx.db
        .from("dj_playlists").insert(fields).select("id").single();
      if (error) throw new Error(`record_dj_playlist: playlist insert failed: ${error.message}`);
      playlistId = (data as { id: string }).id;
      playlistCreated = true;
    }

    // --- Track identity via the shared resolver.
    let resolved = { idByVideoId: new Map<string, string>(), videoIds: [] as string[], createdVideoIds: [] as string[], linked: [] as unknown[] };
    if (tracks.length > 0) {
      resolved = await resolveTrackIds(
        tracks.map((t) =>
          toTrackInput(
            t.video_id!,
            t.title!,
            Array.isArray(t.artists) ? t.artists.filter((a) => typeof a === "string") : [],
            // album is the caller's call here: a playlist entry resolved by
            // search carries a real album, unlike the history feed (spec §9).
            t.album ?? null,
            t.duration_seconds ?? null,
          )
        ),
        ctx,
        "record_dj_playlist",
      ) as typeof resolved;
    }

    // --- Membership. Conflict on (playlist_id, role, track_id) UPDATES rather
    // than ignoring, so re-recording a playlist refreshes position and the
    // yt_set_video_id cache — which has to be refreshed on every read anyway.
    // The (playlist_id, role, position) unique constraint is DEFERRABLE
    // INITIALLY DEFERRED, so a wholesale reorder does not trip it mid-statement.
    let membershipWritten = 0;
    if (tracks.length > 0) {
      const rows = tracks.map((t) => ({
        playlist_id: playlistId,
        track_id: resolved.idByVideoId.get(t.video_id!)!,
        role: t.role!,
        position: t.position!,
        yt_set_video_id: t.yt_set_video_id ?? null,
        added_reason: t.added_reason ?? null,
      }));
      const missing = rows.filter((r) => !r.track_id);
      if (missing.length > 0) {
        throw new Error(
          `record_dj_playlist: ${missing.length} track(s) could not be resolved to ` +
            `dj_tracks rows. No membership was written.`,
        );
      }
      const { data, error } = await ctx.db
        .from("dj_playlist_tracks")
        .upsert(rows, { onConflict: "playlist_id,role,track_id" })
        .select("id");
      if (error) throw new Error(`record_dj_playlist: membership write failed: ${error.message}`);
      membershipWritten = (data ?? []).length;
    }

    return {
      playlist_id: playlistId,
      yt_playlist_id: ytPlaylistId,
      playlist_created: playlistCreated,
      tracks_seen: resolved.videoIds.length,
      tracks_created: resolved.createdVideoIds.length,
      canonical_links_made: resolved.linked.length,
      canonical_links: resolved.linked.slice(0, 50),
      membership_rows_written: membershipWritten,
      by_role: {
        body: tracks.filter((t) => t.role === "body").length,
        cram: tracks.filter((t) => t.role === "cram").length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// create_dj_concert — tier 2
// ---------------------------------------------------------------------------

export const createDjConcertTool = defineTool({
  name: "create_dj_concert",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const artistName = args.artist_name as string | undefined;
    const startsOn = args.starts_on as string | undefined;
    const status = args.status as string | undefined;

    if (!artistName) throw new Error("create_dj_concert: `artist_name` is required.");
    if (!startsOn || !ISO_DATE_RE.test(startsOn)) {
      throw new Error("create_dj_concert: `starts_on` is required, as YYYY-MM-DD.");
    }
    if (!status || !VALID_STATUS.includes(status)) {
      throw new Error(
        `create_dj_concert: \`status\` must be one of ${VALID_STATUS.join(", ")}.`,
      );
    }
    const endsOn = (args.ends_on as string | null | undefined) ?? null;
    if (endsOn) {
      if (!ISO_DATE_RE.test(endsOn)) {
        throw new Error("create_dj_concert: `ends_on` must be YYYY-MM-DD.");
      }
      if (endsOn < startsOn) {
        throw new Error(
          `create_dj_concert: ends_on (${endsOn}) is before starts_on (${startsOn}). ` +
            `A residency runs starts_on..ends_on; leave ends_on null for a single night.`,
        );
      }
    }

    // --- Artist. dj_concerts.artist_id is NOT NULL with ON DELETE RESTRICT, so
    // a concert cannot exist without one. Resolved by name here rather than
    // making the caller create it separately — the FK is an implementation
    // detail of the schema, not something a caller should have to sequence.
    const { data: foundArtist, error: artistErr } = await ctx.db
      .from("dj_artists")
      .select("id, name")
      .eq("name", artistName)
      .maybeSingle();
    if (artistErr) throw new Error(`create_dj_concert: artist lookup failed: ${artistErr.message}`);

    let artistId: string;
    let artistCreated = false;
    if (foundArtist?.id) {
      artistId = foundArtist.id as string;
    } else {
      const { data, error } = await ctx.db
        .from("dj_artists")
        .insert({
          name: artistName,
          tags: (args.artist_tags as string[] | undefined) ?? [],
        })
        .select("id")
        .single();
      if (error) throw new Error(`create_dj_concert: artist insert failed: ${error.message}`);
      artistId = (data as { id: string }).id;
      artistCreated = true;
    }

    const { data, error } = await ctx.db
      .from("dj_concerts")
      .insert({
        artist_id: artistId,
        venue_id: (args.venue_id as string | null | undefined) ?? null,
        tour_name: (args.tour_name as string | null | undefined) ?? null,
        starts_on: startsOn,
        ends_on: endsOn,
        status,
        notes: (args.notes as string | null | undefined) ?? null,
      })
      .select("id, artist_id, tour_name, starts_on, ends_on, status, notes")
      .single();
    if (error) throw new Error(`create_dj_concert: ${error.message}`);

    return {
      ...(data as Record<string, unknown>),
      artist_name: artistName,
      artist_created: artistCreated,
      // dj_venues is not written by this tool yet — venue_id is accepted if the
      // caller already has one. Room-quality notes (spec §9) need a venue tool
      // of their own; until then, put the location in `notes`.
      venue_note: (args.venue_id ? "venue linked" : "no venue linked — record the location in `notes` for now"),
    };
  },
});
