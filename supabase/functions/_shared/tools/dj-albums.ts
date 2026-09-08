// dj_albums — the Jazz thread's memory.
//
// 🛑 THE CANON IS KNOWLEDGE THE MODEL HOLDS, NOT SOMETHING THE LISTENING HISTORY
// CONTAINS. A session can suggest Mingus Ah Um and have no idea it suggested it
// last week. These rows ARE the memory; the model is not. That makes the write
// load-bearing rather than a convenience — a session that suggests without
// recording has silently broken the thing it exists to do.

import { clampLimit, defineTool } from "../platform.ts";
import { resolveTrackIds, toTrackInput } from "./dj-tracks.ts";

const VALID_STATUS = ["proposed", "queued", "listening", "known", "dismissed"];

interface AlbumTrackInput {
  video_id?: string | null;
  title?: string;
  artist?: string | null;
  duration_seconds?: number | null;
  position?: number;
}

// ---------------------------------------------------------------------------
// record_dj_album — tier 2
// ---------------------------------------------------------------------------
//
// Tier 2: it UPDATES an existing album row (status, tags, the track list), which
// is the whole point — an album moves proposed -> queued -> known over time, and
// a dismissal has to be able to overwrite a proposal.
export const recordDjAlbumTool = defineTool({
  name: "record_dj_album",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const title = (args.title as string | undefined)?.trim();
    if (!title) throw new Error("record_dj_album: `title` is required.");

    // -----------------------------------------------------------------------
    // 🛑 `proposed` IS NO LONGER THE DEFAULT, AND THAT IS THE POINT.
    // -----------------------------------------------------------------------
    // The first real album recorded — Bewitched, 13 of 13 heard — landed as
    // 'proposed'. An album Alex finished in August is not an unanswered
    // suggestion, and seeding his other 21 bookmarks would have produced 21 rows
    // claiming the thread had asked about records it has never mentioned. It
    // would then have suggested him albums he already knows.
    //
    // ⚠️ THE SHARPER POINT: A BOOKMARK WAS NEVER PROPOSED. `proposed` means the
    // thread put something forward and is waiting for an answer. A bookmark is
    // Alex's own curation, accepted before anything asked. So PROPOSING IS AN
    // ACT AND MUST BE ASKED FOR — omitting `status` derives it from coverage
    // instead, which is a fact about listening rather than a claim about a
    // conversation that did not happen.
    const statusGiven = args.status !== undefined;
    const status = ((args.status as string | undefined) ?? "queued").trim();
    if (!VALID_STATUS.includes(status)) {
      throw new Error(
        `record_dj_album: \`status\` must be one of ${VALID_STATUS.join(", ")} ` +
          `(got ${JSON.stringify(status)}). 'dismissed' records that the album ` +
          `was suggested and declined — without it a declined album is ` +
          `indistinguishable from one never mentioned, and comes back every week.`,
      );
    }

    const ytAlbumId = (args.yt_album_id as string | undefined)?.trim() || null;
    const rawTracks = (args.tracks as AlbumTrackInput[] | undefined) ?? [];
    if (!Array.isArray(rawTracks)) {
      throw new Error("record_dj_album: `tracks` must be an array when given.");
    }

    // -----------------------------------------------------------------------
    // Upsert the album. Keyed on the YouTube id where there is one.
    // -----------------------------------------------------------------------
    // ⚠️ AN ALBUM WITHOUT A yt_album_id IS LEGITIMATE — the thread can record one
    // from knowledge before it has been resolved on YouTube. The unique index is
    // partial for exactly that reason, so several such rows coexist. It also
    // means those rows cannot be deduped by id, which is accepted: albums arrive
    // one at a time with a human approving each (§023).
    const albumPatch: Record<string, unknown> = {
      title,
      status,
      artist: (args.artist as string | undefined)?.trim() || null,
      yt_album_id: ytAlbumId,
      release_year: (args.release_year as number | undefined) ?? null,
      notes: (args.notes as string | undefined)?.trim() || null,
    };
    if (args.tags !== undefined) albumPatch.tags = args.tags as string[];
    // Stamped SERVER-SIDE. A caller supplying it could back-date a suggestion,
    // and the whole value of this column is that it records when the thread
    // actually asked.
    if (status === "proposed") {
      albumPatch.suggested_on = new Date().toISOString().slice(0, 10);
    }

    let albumId: string;
    let created = false;

    const existing = ytAlbumId
      ? await ctx.db.from("dj_albums").select("id").eq("yt_album_id", ytAlbumId).maybeSingle()
      : { data: null, error: null };
    if (existing.error) {
      throw new Error(`record_dj_album: lookup failed: ${existing.error.message}`);
    }

    if (existing.data) {
      albumId = (existing.data as { id: string }).id;
      const { error } = await ctx.db.from("dj_albums").update(albumPatch).eq("id", albumId);
      if (error) throw new Error(`record_dj_album: update failed: ${error.message}`);
    } else {
      const { data, error } = await ctx.db
        .from("dj_albums").insert(albumPatch).select("id").single();
      if (error) throw new Error(`record_dj_album: insert failed: ${error.message}`);
      albumId = (data as { id: string }).id;
      created = true;
    }

    // -----------------------------------------------------------------------
    // The track list
    // -----------------------------------------------------------------------
    // 🛑 TRACKS WITH NO video_id ARE STORED ANYWAY. YouTube omits it for
    // region-blocked tracks. They are real tracks that lengthen the record and
    // can never match a play — dropping them would shorten the album and make
    // coverage look better than it is. dj_album_coverage counts them in
    // `tracks_total` and excludes them from `tracks_playable`, which is the
    // distinction that keeps the fraction honest.
    let resolvedCount = 0;
    let unresolvable = 0;

    if (rawTracks.length > 0) {
      const withVideo = rawTracks.filter((t) => t.video_id);
      unresolvable = rawTracks.length - withVideo.length;

      if (withVideo.length > 0) {
        // ⚠️ THE SHARED RESOLVER, NOT A LOCAL ONE. It creates dj_tracks rows and
        // canonical groupings, which is what makes "have I heard this music"
        // work: a play of ANY upload of a track counts. A second implementation
        // here would agree with record_dj_playlist until one of them changed
        // (§14.6).
        const prepared = withVideo.map((t) =>
          toTrackInput(
            t.video_id as string,
            t.title ?? "",
            t.artist ? [t.artist] : [],
            title,
            t.duration_seconds ?? null,
          )
        );
        const resolved = await resolveTrackIds(prepared, ctx, "record_dj_album");
        resolvedCount = resolved.idByVideoId.size;
      }

      // Replace the list wholesale: an album's running order is a fact about the
      // album, not an accumulation, and a re-read that returned a corrected list
      // must not leave the old rows behind.
      const { error: delErr } = await ctx.db
        .from("dj_album_tracks").delete().eq("album_id", albumId);
      if (delErr) {
        throw new Error(`record_dj_album: clearing old tracks failed: ${delErr.message}`);
      }

      const rows = rawTracks.map((t, i) => ({
        album_id: albumId,
        video_id: t.video_id ?? null,
        title: t.title ?? "",
        artist: t.artist ?? null,
        duration_seconds: t.duration_seconds ?? null,
        position: t.position ?? i + 1,
      }));
      const { error: insErr } = await ctx.db.from("dj_album_tracks").insert(rows);
      if (insErr) {
        throw new Error(`record_dj_album: track insert failed: ${insErr.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // Derive the status from coverage, when the caller did not state one
    // -----------------------------------------------------------------------
    // ⚠️ THIS CANNOT HAPPEN BEFORE THE WRITE. Coverage is zero until the track
    // list exists, so a derivation attempted earlier would mark every album
    // unheard — including one finished months ago.
    //
    // Only two outcomes are derived, and neither is a judgement:
    //   every playable track heard  -> 'known'    (a fact about listening)
    //   anything else               -> 'queued'   (he bookmarked it; that IS
    //                                              the acceptance)
    // 🛑 'proposed' IS NEVER DERIVED. It asserts that a conversation happened.
    let finalStatus = status;
    let statusDerived = false;
    let coverage: Record<string, unknown> | null = null;

    if (!statusGiven) {
      const { data: cov, error: covErr } = await ctx.db.rpc("dj_album_coverage", {
        p_status: null, p_tag: null, p_limit: 1, p_album_id: albumId,
      });
      if (covErr) {
        throw new Error(
          `record_dj_album: coverage lookup failed: ${covErr.message}. If this ` +
            `says the function does not exist or takes different arguments, ` +
            `migration 025 has not been applied yet.`,
        );
      }
      coverage = ((cov ?? []) as Array<Record<string, unknown>>)[0] ?? null;
      const playable = Number(coverage?.tracks_playable ?? 0);
      const heard = Number(coverage?.tracks_heard ?? 0);
      if (playable > 0 && heard >= playable) {
        finalStatus = "known";
      }
      if (finalStatus !== status) {
        const { error } = await ctx.db
          .from("dj_albums").update({ status: finalStatus }).eq("id", albumId);
        if (error) {
          throw new Error(`record_dj_album: status update failed: ${error.message}`);
        }
      }
      statusDerived = true;
    }

    return {
      album_id: albumId,
      created,
      title,
      status: finalStatus,
      status_derived: statusDerived,
      coverage: coverage
        ? {
          tracks_total: coverage.tracks_total,
          tracks_playable: coverage.tracks_playable,
          tracks_heard: coverage.tracks_heard,
          last_heard_on: coverage.last_heard_on,
        }
        : null,
      tracks_recorded: rawTracks.length,
      tracks_resolved: resolvedCount,
      tracks_without_video_id: unresolvable,
      reading:
        "🛑 `proposed` IS NEVER DERIVED AND MUST BE ASKED FOR. It asserts that " +
        "the thread put this album forward and is waiting for an answer. A " +
        "BOOKMARK WAS NEVER PROPOSED — it is Alex's own curation, accepted " +
        "before anything asked. Omit `status` when recording something he chose " +
        "(it derives 'known' from full coverage, else 'queued'); pass " +
        "'proposed' ONLY when the thread is actually suggesting it. " +
        "🛑 THIS ROW IS THE MEMORY. The canon is knowledge the model holds, not " +
        "something the listening history contains — a later session can suggest " +
        "this album again unless this write happened. " +
        "⚠️ `status` is where it sits in the QUEUE, never how Alex feels about " +
        "it (that is dj_feedback). 'dismissed' means asked and answered no, and " +
        "it is what stops the album being proposed again. " +
        "⚠️ `tracks_without_video_id` ARE STORED, NOT DROPPED. They are real " +
        "tracks that can never match a play; dropping them would shorten the " +
        "album and make coverage look better than it is. " +
        "⚠️ Track ids were resolved through the SHARED resolver, so canonical " +
        "grouping applies and a play of any upload counts toward hearing this " +
        "album.",
    };
  },
});

// ---------------------------------------------------------------------------
// get_dj_albums — tier 1
// ---------------------------------------------------------------------------
export const getDjAlbumsTool = defineTool({
  name: "get_dj_albums",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const LIMIT = clampLimit(args.limit as number | undefined);
    const status = (args.status as string | undefined)?.trim() || null;
    if (status && !VALID_STATUS.includes(status)) {
      throw new Error(
        `get_dj_albums: \`status\` must be one of ${VALID_STATUS.join(", ")}.`,
      );
    }

    const { data, error } = await ctx.db.rpc("dj_album_coverage", {
      p_status: status,
      p_tag: (args.tag as string | undefined)?.trim() || null,
      p_limit: LIMIT,
    });
    if (error) {
      throw new Error(
        `get_dj_albums: ${error.message}. If this says the function does not ` +
          `exist, migration 024 has not been applied yet.`,
      );
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    // ⚠️ COUNTED HERE SO THE CALLER CANNOT MISS IT. An album whose total and
    // playable counts differ has tracks nobody can check, and a reader told
    // only "7 of 7" would believe it finished.
    const partlyUnmeasurable = rows.filter(
      (r) => Number(r.tracks_total ?? 0) !== Number(r.tracks_playable ?? 0),
    ).length;

    return { data: {
      albums: rows,
      returned: rows.length,
      limit_applied: LIMIT,
      filters: { status, tag: (args.tag as string | undefined) ?? null },
      albums_partly_unmeasurable: partlyUnmeasurable,
      reading:
        "🛑 COVERAGE IS `tracks_heard / tracks_playable`, AND IT IS A FRACTION, " +
        "NEVER A BOOLEAN. Albums are 8-12 tracks and three may have been heard; " +
        "'3 of 9' needs no caveat and 'unheard: false' needs a paragraph. " +
        "⚠️ WHEN `tracks_total` EXCEEDS `tracks_playable`, SAY SO. The " +
        "difference is region-blocked tracks with no video_id — real tracks that " +
        "can never match a play. Reporting '7 of 7' on an album whose total is 9 " +
        "tells Alex it is finished when two tracks were never checkable. " +
        "⚠️ COUNTS CANONICAL GROUPS: a play of ANY upload counts, so this " +
        "measures the MUSIC rather than the RECORD. It does not answer 'have I " +
        "sat through this album as an album', and would answer that wrongly. " +
        "⚠️ `status` is queue position, NOT feeling — 'dismissed' means asked " +
        "and answered no, and those must never be proposed again. " +
        "⚠️ `suggested_on` is how a later session knows this was already put " +
        "forward. The canon lives in these rows, not in the model.",
    }, meta: { limit_applied: LIMIT } };
  },
});
