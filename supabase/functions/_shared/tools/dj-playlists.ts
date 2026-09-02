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

// What the MCP tool accepts. Its purpose is bounding a payload that a MODEL
// composed and that came through a conversation.
const TRACKS_CAP = 300;

// What the bulk import endpoint accepts. Nothing on that path passes through a
// model: a script reads YouTube and POSTs straight here.
//
// 🛑 THIS IS THE SECOND CAP, AND IT IS THE ONE THAT WOULD HAVE BEEN MISSED.
// Raising only the READ ceiling (CONTENTS_BULK_CAP, Workshop side) would have
// let a 379-track playlist be fetched and then refused HERE with "379 tracks
// exceeds the cap of 300" — moving the failure from read to write, where it
// looks like a different problem with a different cause. Two limits governed
// one operation and only one of them had fired. See spec §11.22.
const BULK_TRACKS_CAP = 500;
const VALID_KIND = ["concert", "artist", "jazz", "discovery", "utility"];

// Statuses that describe a SPECIFIC show and therefore cannot be undated.
// Mirrors the dj_concerts_undated_status CHECK added in migration 010 — see the
// note at the guard that uses it for why this is duplicated deliberately.
const DATED_ONLY_STATUS = ["interested", "committed"];
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

export interface PreparedPlaylist {
  ytPlaylistId: string;
  name: string;
  kind: string;
  tracks: TrackInputArg[];
  concertIdGiven: boolean;
  concertId: string | null;
}

/**
 * Validate and normalise the arguments of a playlist record.
 *
 * ⚠️ SHARED BY THE WRITE AND THE DRY RUN, AND THAT IS THE POINT. A separate
 * estimator would agree with the write right up until it didn't — the same
 * argument `prepareRows` carries in dj-courier.ts, and the same reason the bulk
 * import endpoint calls the real tool rather than a direct PostgREST write.
 * A dry run that validated differently from the write would report a clean plan
 * for a batch that then fails halfway.
 *
 * Throws on any validation failure. Every check here runs BEFORE the caller
 * touches the database, so a rejection means nothing was written.
 */
export function preparePlaylistInput(
  args: Record<string, unknown>,
  toolName: string,
  tracksCap: number = TRACKS_CAP,
): PreparedPlaylist {
  const ytPlaylistId = args.yt_playlist_id as string | undefined;
  const name = args.name as string | undefined;
  const kind = args.kind as string | undefined;
  const tracks = (args.tracks as TrackInputArg[] | undefined) ?? [];

  if (!ytPlaylistId) throw new Error(`${toolName}: \`yt_playlist_id\` is required.`);
  if (!name) throw new Error(`${toolName}: \`name\` is required.`);
  if (!kind || !VALID_KIND.includes(kind)) {
    throw new Error(`${toolName}: \`kind\` must be one of ${VALID_KIND.join(", ")}.`);
  }
  if (!Array.isArray(tracks)) {
    throw new Error(`${toolName}: \`tracks\` must be an array.`);
  }
  if (tracks.length > tracksCap) {
    throw new Error(
      `${toolName}: ${tracks.length} tracks exceeds the cap of ${tracksCap}. ` +
        `Nothing was written.`,
    );
  }

  const concertIdGiven = args.concert_id !== undefined;
  const concertId = (args.concert_id as string | null | undefined) ?? null;
  if (concertId && kind !== "concert") {
    // Mirrors the dj_playlists_concert_link CHECK, but fails with a sentence
    // rather than a constraint name.
    throw new Error(
      `${toolName}: \`concert_id\` may only be set when kind is 'concert'.`,
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
    //
    // ⚠️ KEYED ON POSITION AND video_id, NEVER ON yt_set_video_id. Live data
    // confirmed spec §5's warning: two different playlists were found holding
    // the SAME set_video_id string for DIFFERENT songs. A dedupe keyed on that
    // handle would silently collapse unrelated tracks.
    const posKey = `${t?.role}|${t?.position}`;
    if (seen.has(posKey)) errors.push(`${at}: duplicate (role, position) ${posKey}.`);
    seen.add(posKey);

    // ⚠️ THERE IS DELIBERATELY NO (role, video_id) DUPLICATE CHECK — migration
    // 012 removed it, on both sides. A playlist may legitimately hold the same
    // song twice: Family party, Awesome, 5K, Yoga and Archived Weezer all do,
    // and this check is what failed all five in the Phase 6b dry run. Position
    // is the identity; a SLOT cannot be claimed twice and that is the invariant
    // that matters. Cram still forbids duplicates, enforced by the partial index
    // dj_playlist_tracks_cram_track_uniq rather than re-stated here.
  });
  if (errors.length > 0) {
    const shown = errors.slice(0, 20);
    const more = errors.length - shown.length;
    throw new Error(
      `${toolName}: ${errors.length} validation error(s). No rows written:\n` +
        shown.join("\n") + (more > 0 ? `\n(+${more} more)` : ""),
    );
  }

  return { ytPlaylistId, name, kind, tracks, concertIdGiven, concertId };
}

// ---------------------------------------------------------------------------
// record_dj_playlist — tier 2
// ---------------------------------------------------------------------------

// ⚠️ ONE HANDLER, TWO CEILINGS. The body is identical for both callers — the
// only thing that differs is how many tracks may arrive, which is a property of
// WHERE the payload came from, not of what recording a playlist means. A second
// copy of this handler would diverge from the first the moment either changed.
const makeRecordHandler = (toolName: string, tracksCap: number) =>
  async (args: Record<string, unknown>, ctx: { db: any }) => {
    const { ytPlaylistId, name, kind, tracks, concertIdGiven } =
      preparePlaylistInput(args, toolName, tracksCap);

    // --- Playlist row. Read-then-write rather than upsert: user_id carries a
    // DEFAULT rather than being supplied, so naming it in an ON CONFLICT target
    // is fragile. Two round trips, no ambiguity.
    // concert_id is selected too — the re-record path below needs to know what
    // the row ALREADY links to, not just whether it exists.
    const { data: found, error: findErr } = await ctx.db
      .from("dj_playlists")
      .select("id, concert_id")
      .eq("yt_playlist_id", ytPlaylistId)
      .maybeSingle();
    if (findErr) throw new Error(`record_dj_playlist: playlist lookup failed: ${findErr.message}`);

    // ⚠️ ABSENT AND EXPLICITLY NULL ARE DIFFERENT INSTRUCTIONS. `??` COLLAPSES THEM.
    //
    // Re-recording an existing playlist runs an UPDATE with these fields, so
    // `concert_id: args.concert_id ?? null` wrote NULL whenever the caller
    // simply did not mention it. A bulk importer that reads YouTube contents
    // and calls this per playlist has no reason to mention it — and would have
    // silently unlinked 18 concert playlists in one pass. `dj_playlists
    // .concert_id` is ON DELETE SET NULL, so nothing would have complained; the
    // links would just be gone, and only a later "why is Section 1 empty?"
    // would surface it.
    //
    // The correct idiom was already in this object, on `cram_cap`, three lines
    // down. Two fields did not get it — spec §11.14's "a constraint written in
    // two places is enforced in one", inside a single function literal.
    //
    // So: OMIT a field and the stored value is untouched. Pass it EXPLICITLY as
    // null and it is cleared. Both are now expressible, which they were not.
    const fields = {
      yt_playlist_id: ytPlaylistId,
      name,
      kind,
      ...(concertIdGiven ? { concert_id: args.concert_id as string | null } : {}),
      ...(args.description !== undefined
        ? { description: args.description as string | null }
        : {}),
      ...(args.cram_cap !== undefined ? { cram_cap: args.cram_cap as number } : {}),
      last_synced_at: new Date().toISOString(),
    };

    // ⚠️ A CASE CREATED BY THE FIX ABOVE, AND THEREFORE HANDLED BY IT.
    // Now that an omitted concert_id means "leave it alone", a playlist can be
    // re-recorded under a NEW kind while still carrying its old concert link —
    // reclassifying "I Heart Radio Concert" from concert to artist, say. The
    // dj_playlists_concert_link CHECK refuses that, but as a raw constraint
    // name. Say it in a sentence, and name the fix: clearing is now something
    // the caller can actually ask for.
    const inheritedConcertId = (found?.concert_id as string | null | undefined) ?? null;
    if (!concertIdGiven && inheritedConcertId && kind !== "concert") {
      throw new Error(
        `record_dj_playlist: this playlist is already linked to concert ` +
          `${inheritedConcertId}, and kind '${kind}' cannot hold a concert link. ` +
          `Re-recording leaves an unmentioned concert_id untouched, so the link ` +
          `would survive the kind change. Pass \`concert_id: null\` explicitly to ` +
          `clear it in the same call.`,
      );
    }

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
      // ⚠️ ARBITRATES ON POSITION, NOT ON track_id (migration 012). The slot is
      // the identity: the row at body position 3 becomes whatever track sits at
      // position 3 now. Keying on track_id is what forbade the same song twice.
      //
      // This also requires the position constraint to be IMMEDIATE — PostgreSQL
      // refuses a deferrable unique constraint as an ON CONFLICT arbiter. 012
      // made it immediate and proves the arbiter with a real upsert, because
      // asserting the constraint's shape says nothing about whether Postgres
      // will accept it.
      const { data, error } = await ctx.db
        .from("dj_playlist_tracks")
        .upsert(rows, { onConflict: "playlist_id,role,position" })
        .select("id");
      if (error) throw new Error(`record_dj_playlist: membership write failed: ${error.message}`);
      membershipWritten = (data ?? []).length;
    }

    // --- Drift. MEMBERSHIP IS UPSERT-ONLY: NOTHING HERE EVER DELETES A ROW.
    //
    // ⚠️ THAT MAKES THE RECORDED BODY ABLE TO GROW BUT NEVER SHRINK. A track
    // removed from the YouTube playlist keeps its dj_playlist_tracks row
    // forever, and every later re-record leaves it in place. The Supabase copy
    // then over-reports the body, and §12's weekly diff would compare setlists
    // against a playlist that has songs the playlist does not have.
    //
    // Deleting them here would be the wrong fix at the wrong tier: this tool is
    // tier 2, and silently dropping membership on a re-record is precisely the
    // destructive-by-omission shape the concert_id bug above already was. So
    // drift is REPORTED and not acted on — visible, and the caller's call.
    //
    // A `prune: true` parameter is the eventual answer. It is deliberately NOT
    // added here: input_schema changes are manifest changes, and a manifest
    // change costs a connector reconnect and a fresh conversation. It belongs in
    // the next batched deploy, not smuggled into a bugfix.
    let staleRows = 0;
    let staleSample: Array<Record<string, unknown>> = [];
    if (tracks.length > 0) {
      const { data: existing, error: staleErr } = await ctx.db
        .from("dj_playlist_tracks")
        .select("id, role, position, track_id")
        .eq("playlist_id", playlistId);
      if (staleErr) {
        throw new Error(
          `record_dj_playlist: membership was written, but the drift check failed: ` +
            `${staleErr.message}. The write stands; re-run to re-check.`,
        );
      }
      // ⚠️ KEYED ON (role, position), NOT ON track_id — migration 012. With
      // duplicates allowed, one track_id can occupy several slots, so a
      // track-keyed comparison would treat every row holding a still-present
      // track as current and MISS a genuinely dropped slot. Position is the
      // identity; a recorded slot absent from the payload is the stale one.
      const sent = new Set(tracks.map((t) => `${t.role}|${t.position}`));
      const orphans = (existing ?? []).filter(
        (r: Record<string, unknown>) => !sent.has(`${r.role}|${r.position}`),
      );
      staleRows = orphans.length;
      staleSample = orphans.slice(0, 10);
    }

    return {
      playlist_id: playlistId,
      yt_playlist_id: ytPlaylistId,
      playlist_created: playlistCreated,
      // "untouched" and "0 rows written" are different facts and were previously
      // indistinguishable — omitting `tracks` and passing `tracks: []` both
      // reported membership_rows_written: 0.
      membership_mode: tracks.length > 0 ? "upserted" : "untouched",
      tracks_seen: resolved.videoIds.length,
      tracks_created: resolved.createdVideoIds.length,
      canonical_links_made: resolved.linked.length,
      canonical_links: resolved.linked.slice(0, 50),
      membership_rows_written: membershipWritten,
      // Recorded rows this payload did NOT contain. Non-zero means the Supabase
      // copy holds songs the YouTube playlist no longer does. Nothing was
      // deleted — see the note above.
      stale_rows: staleRows,
      stale_sample: staleSample,
      by_role: {
        body: tracks.filter((t) => t.role === "body").length,
        cram: tracks.filter((t) => t.role === "cram").length,
      },
    };
  };

export const recordDjPlaylistTool = defineTool({
  name: "record_dj_playlist",
  tier: 2,
  handler: makeRecordHandler("record_dj_playlist", TRACKS_CAP),
});

// DELIBERATELY NOT AN MCP TOOL, exactly like dry_run_dj_playlist. It exists only
// behind POST /mcp/import-playlist, where the payload never enters a model's
// context.
//
// ⚠️ A SEPARATE NAMED TOOL RATHER THAN A HIDDEN PARAMETER ON THE FIRST ONE. An
// undocumented arg that raises a limit reads as a backdoor, and the next person
// adding a caller would not know which ceiling they were entitled to. This is
// visible in the source, absent from the manifest, and costs no reconnect.
export const recordDjPlaylistBulkTool = defineTool({
  name: "record_dj_playlist_bulk",
  tier: 2,
  handler: makeRecordHandler("record_dj_playlist_bulk", BULK_TRACKS_CAP),
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
    if (!status || !VALID_STATUS.includes(status)) {
      throw new Error(
        `create_dj_concert: \`status\` must be one of ${VALID_STATUS.join(", ")}.`,
      );
    }

    // `starts_on` is OPTIONAL since migration 010. Undated rows carry the
    // library import's history (shows whose date is lost) and the standing
    // watchlist (undated `screening` — an act worth seeing whenever they tour,
    // which the planned Vegas scanner later fills in).
    if (startsOn && !ISO_DATE_RE.test(startsOn)) {
      throw new Error(
        "create_dj_concert: `starts_on` must be YYYY-MM-DD when given. " +
          "Omit it entirely for a show whose date is not known — do not pass an " +
          "approximate one, because a guessed date is indistinguishable from a " +
          "checked one once written.",
      );
    }

    // ⚠️ THIS DUPLICATES dj_concerts_undated_status ON PURPOSE, AND THE
    // DUPLICATION IS THE POINT (spec §11.14 — a constraint written in two places
    // is a constraint that will be enforced in one). The database is still the
    // real gate: if this check is ever wrong or removed, the CHECK refuses the
    // write anyway. What it buys is the MESSAGE. Without it the caller gets
    // `new row for relation "dj_concerts" violates check constraint
    // "dj_concerts_undated_status"`, which names the constraint and explains
    // nothing — and the natural next move on reading it is to invent a date,
    // which is the exact failure the nullable column existed to prevent.
    if (!startsOn && DATED_ONLY_STATUS.includes(status)) {
      throw new Error(
        `create_dj_concert: status '${status}' needs a \`starts_on\`. ` +
          `'interested' and 'committed' both mean a SPECIFIC show, so they cannot ` +
          `be undated. If you know the date, pass it. If you do not, the right ` +
          `status is 'screening' — undated screening is the standing watchlist ` +
          `(an act worth seeing whenever they tour), which is a different and ` +
          `perfectly recordable thing. Do NOT approximate the date to get past ` +
          `this: 'screening' undated is accurate, and a guessed date is not.`,
      );
    }

    const endsOn = (args.ends_on as string | null | undefined) ?? null;
    if (endsOn) {
      if (!ISO_DATE_RE.test(endsOn)) {
        throw new Error("create_dj_concert: `ends_on` must be YYYY-MM-DD.");
      }
      // ⚠️ Caught here rather than left to the database: dj_concerts_date_range
      // is `ends_on IS NULL OR ends_on >= starts_on`, which with a NULL
      // starts_on evaluates to NULL and therefore PASSES. A residency with an
      // end and no beginning would be stored happily and read as nonsense.
      if (!startsOn) {
        throw new Error(
          "create_dj_concert: `ends_on` was given without `starts_on`. A " +
            "residency runs starts_on..ends_on, so an end date with no start is " +
            "not a range. Pass both, or neither.",
        );
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

    // ⚠️ DUPLICATE GUARD. Nothing stopped a second row for the same act on the
    // same night, and that is exactly how someone "fixing" a wrong date creates
    // a duplicate instead of correcting one — which is what happened to
    // Weezer's 2026-10-15 before update_dj_concert existed. Refused with the
    // id of the row that already covers it, so the remedy is obvious.
    //
    // Only checked for a DATED concert: two undated rows for one artist are
    // legitimate (a lost historical show and a standing watchlist entry are
    // different facts), and there is no date to collide on.
    if (startsOn) {
      const { data: clash, error: clashErr } = await ctx.db
        .from("dj_concerts")
        .select("id, status, tour_name")
        .eq("artist_id", artistId)
        .eq("starts_on", startsOn)
        .maybeSingle();
      if (clashErr) {
        throw new Error(`create_dj_concert: duplicate check failed: ${clashErr.message}`);
      }
      if (clash) {
        const c = clash as { id: string; status: string };
        throw new Error(
          `create_dj_concert: ${artistName} already has a concert on ${startsOn} ` +
            `(${c.id}, status '${c.status}'). REFUSED — nothing was written. If the ` +
            `date or status is wrong, CHANGE that row with update_dj_concert; a ` +
            `second row would leave two records of one night and nothing saying ` +
            `which is real. If they genuinely played twice that day, record the ` +
            `second in \`notes\` on the existing row.`,
        );
      }
    }

    const { data, error } = await ctx.db
      .from("dj_concerts")
      .insert({
        artist_id: artistId,
        venue_id: (args.venue_id as string | null | undefined) ?? null,
        tour_name: (args.tour_name as string | null | undefined) ?? null,
        starts_on: startsOn ?? null,
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

// ---------------------------------------------------------------------------
// dry_run_dj_playlist — tier 1, and DELIBERATELY NOT AN MCP TOOL
// ---------------------------------------------------------------------------
//
// It exists only behind POST /mcp/import-playlist?mode=dry_run, where the
// payload is read from YouTube by a script and never passes through a model's
// context. Registering it would add a manifest entry with no caller — and every
// manifest change costs a connector reconnect. Same call as dry_run_dj_plays.
//
// ⚠️ IT VALIDATES THROUGH preparePlaylistInput, THE SAME FUNCTION THE WRITE
// USES. A dry run with its own validation would report a clean plan for a batch
// that then fails halfway through — and the failure would land after the
// playlist row had already been updated.
//
// It LOOKS UP tracks and never creates them, so a dry run leaves dj_tracks
// exactly as it found it.
export const dryRunDjPlaylistTool = defineTool({
  name: "dry_run_dj_playlist",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    // The bulk ceiling: this tool is reachable only from the import endpoint,
    // so a dry run that refused what the confirm accepts would be useless.
    const { ytPlaylistId, name, kind, tracks, concertIdGiven, concertId } =
      preparePlaylistInput(args, "dry_run_dj_playlist", BULK_TRACKS_CAP);

    const { data: found, error: findErr } = await ctx.db
      .from("dj_playlists")
      .select("id, name, kind, concert_id")
      .eq("yt_playlist_id", ytPlaylistId)
      .maybeSingle();
    if (findErr) throw new Error(`dry_run_dj_playlist: playlist lookup failed: ${findErr.message}`);

    const existing = found as
      | { id: string; name: string; kind: string; concert_id: string | null }
      | null;

    // --- Tracks: look up, NEVER create.
    const videoIds = [...new Set(tracks.map((t) => t.video_id!))];
    const known = new Map<string, string>();
    for (let i = 0; i < videoIds.length; i += 100) {
      const slice = videoIds.slice(i, i + 100);
      const { data, error } = await ctx.db
        .from("dj_tracks").select("id, video_id").in("video_id", slice);
      if (error) throw new Error(`dry_run_dj_playlist: track lookup failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; video_id: string }>) {
        known.set(r.video_id, r.id);
      }
    }

    // --- Recorded membership, and what this payload would leave behind.
    let recordedBody = 0, recordedCram = 0, predictedStale = 0;
    let staleSample: Array<Record<string, unknown>> = [];
    if (existing?.id) {
      const { data: rows, error: memErr } = await ctx.db
        .from("dj_playlist_tracks")
        .select("id, role, position, track_id")
        .eq("playlist_id", existing.id);
      if (memErr) throw new Error(`dry_run_dj_playlist: membership read failed: ${memErr.message}`);
      const recorded = (rows ?? []) as Array<Record<string, unknown>>;
      recordedBody = recorded.filter((r) => r.role === "body").length;
      recordedCram = recorded.filter((r) => r.role === "cram").length;

      if (tracks.length > 0) {
        // Same keying as the write — (role, position). See the note there.
        const sent = new Set(tracks.map((t) => `${t.role}|${t.position}`));
        const orphans = recorded.filter((r) => !sent.has(`${r.role}|${r.position}`));
        predictedStale = orphans.length;
        staleSample = orphans.slice(0, 10);
      }
    }

    return {
      yt_playlist_id: ytPlaylistId,
      name,
      kind,
      playlist_exists: Boolean(existing),
      would: existing ? "update" : "create",
      // Renames and reclassifications are surfaced rather than applied quietly:
      // a bulk import that silently renamed 34 playlists would be very hard to
      // notice and very annoying to undo.
      name_change: existing && existing.name !== name
        ? { from: existing.name, to: name } : null,
      kind_change: existing && existing.kind !== kind
        ? { from: existing.kind, to: kind } : null,
      concert_id_current: existing?.concert_id ?? null,
      concert_id_action: !concertIdGiven
        ? "untouched"
        : concertId === null ? "would CLEAR" : "would set",
      tracks_in_payload: tracks.length,
      membership_mode: tracks.length > 0 ? "would upsert" : "untouched",
      recorded_now: { body: recordedBody, cram: recordedCram },
      tracks_known: videoIds.filter((v) => known.has(v)).length,
      tracks_would_create: videoIds.filter((v) => !known.has(v)).length,
      // ⚠️ On a FIRST import this must be 0. A playlist recorded with total: 0
      // has nothing to be stale against, so a non-zero reading here means the
      // payload disagrees with rows that already exist — investigate before
      // confirming.
      predicted_stale_rows: predictedStale,
      predicted_stale_sample: staleSample,
      wrote: false,
    };
  },
});

// ---------------------------------------------------------------------------
// classifyRead — is this playlist read complete, clipped, or short?
// ---------------------------------------------------------------------------
//
// 🛑 EXTRACTED FROM THE ENDPOINT BECAUSE IT SHIPPED WRONG AND NOTHING COULD TEST
// IT. Living inline in index.ts, it was reachable only over HTTP, so no test
// exercised it and two bugs went out together:
//
//   1. It compared against a hardcoded 200 while the bulk path fetched 400, so
//      every read over 200 read as clipped. A THIRD site that only *read* the
//      cap — the enumeration of enforcers (read cap, TRACKS_CAP) missed it
//      because it enforces nothing.
//   2. ⚠️ WORSE: IT CHECKED THE CAP BEFORE CHECKING COMPLETENESS. `read == library`
//      is the DEFINITION of a complete read and needs no cap at all, but the cap
//      branch ran first and won. Elise's fun list read 379 of 379 and was
//      reported as clipped — a message that contradicted its own numbers in the
//      same sentence, and then asserted "the rest is unreachable" and ordered a
//      skip (§11.20, twice in one project).
//
// Fixing only (1) would leave (2): a 400-track playlist read completely at a
// 400 ceiling would still be called clipped. COMPLETENESS IS CHECKED FIRST AND
// THE CAP IS NEVER CONSULTED WHEN read == library.

export type ReadVerdict =
  | { kind: "complete" }
  | { kind: "over_read"; message: string }
  | { kind: "clipped_by_cap"; message: string }
  | { kind: "shortfall"; shortfall: number; note: string };

export function classifyRead(
  libraryCount: number,
  readCount: number,
  readCap: number,
): ReadVerdict {
  // FIRST, AND WITHOUT REFERENCE TO ANY CAP. If the read returned what the
  // library says exists, it is complete — whatever ceiling was used, and even
  // if the read landed exactly on it.
  if (readCount === libraryCount) return { kind: "complete" };

  if (readCount > libraryCount) {
    return {
      kind: "over_read",
      message:
        `STOP: the read returned ${readCount} tracks but YouTube's library count ` +
        `is ${libraryCount}. More is not better here — the two numbers come from ` +
        `the same source, and disagreeing means one of them is not describing ` +
        `this playlist. Nothing was written.`,
    };
  }

  // Only now is the cap relevant: the read is short, and the question is whether
  // the ceiling is why.
  if (readCount >= readCap) {
    return {
      kind: "clipped_by_cap",
      message:
        `STOP: YouTube reports ${libraryCount} tracks and the read returned ` +
        `${readCount}, stopping at the ${readCap}-track ceiling this caller used. ` +
        `The remainder was not fetched. Nothing was written. Either re-read with a ` +
        `higher ceiling, or SKIP this playlist — a partial body is worse than no ` +
        `body, because it records a playlist that looks complete and is not, and ` +
        `§12's weekly diff would compare setlists against it.`,
    };
  }

  return {
    kind: "shortfall",
    shortfall: libraryCount - readCount,
    note:
      `${readCount} of ${libraryCount} — ${libraryCount - readCount} entr(y/ies) ` +
      `counted by YouTube but not serialised (deleted or private). Not a ceiling ` +
      `hit: the read stopped below ${readCap}. This is everything obtainable.`,
  };
}
