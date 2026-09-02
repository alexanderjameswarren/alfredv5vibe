// dj_artists — read and upsert. The Phase 7 gate.
//
// The table has existed since Block A and had NO TOOLS AT ALL until now: mbid
// could be neither read nor written, and Phase 7 keys entirely on it. That is
// the same finding every phase in this project has produced first — the data
// model runs ahead of the tool surface, and the gap is invisible until
// something needs to cross it.
//
// ⚠️ dj_artists is NOT insert-only. Unlike dj_tracks, nothing here is written
// once and frozen: an artist's mbid, tags and notes are exactly the kind of
// thing that gets corrected as better information arrives. So upsert is the
// right shape here and would be the wrong shape there, and the difference is
// not stylistic - it is whether the column is an IDENTITY or an ANNOTATION.

import { clampLimit, defineTool } from "../platform.ts";

const MBID_LEN = 36;

interface ArtistRow {
  id: string;
  name: string;
  mbid: string | null;
  yt_channel_id: string | null;
  tags: string[] | null;
  notes: string | null;
  last_explored_at: string | null;
}

const COLS = "id, name, mbid, yt_channel_id, tags, notes, last_explored_at";

// ---------------------------------------------------------------------------
// get_dj_artists — tier 1 read
// ---------------------------------------------------------------------------

export const getDjArtistsTool = defineTool({
  name: "get_dj_artists",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const name = args.name as string | undefined;
    const missingMbid = args.missing_mbid === true;
    const limit = clampLimit(args.limit as number | undefined);

    // ⚠️ COUNTED, BECAUSE THIS TOOL TRUNCATES AND USED TO DO IT IN SILENCE.
    // Measured 2026-09-02: 22 artist rows exist, the default limit is 20, and an
    // unfiltered call returned exactly 20 with nothing to say so — Weezer fell
    // off the end alphabetically, after Styx. A job that lists artists once and
    // iterates therefore skips everything after "S", and the mbid it needs for
    // the setlist diff is simply absent rather than reported missing. `count`
    // costs one extra clause and is what lets the envelope raise the truncation
    // note the house style already defines.
    let q = ctx.db.from("dj_artists").select(COLS, { count: "exact" });
    // Exact match first, so "Live" the band cannot be reached by a fuzzy search
    // that also matches "Live at the Apollo" - the same class of wrong-match the
    // mbid rule exists to prevent one layer up.
    if (name) q = q.ilike("name", name);
    if (missingMbid) q = q.is("mbid", null);
    q = q.order("name", { ascending: true }).limit(limit);

    const { data, error, count } = await q;
    if (error) throw new Error(`get_dj_artists: ${error.message}`);
    const rows = (data ?? []) as ArtistRow[];
    const total = count ?? rows.length;
    const truncated = rows.length < total;

    return {
      data: {
        artists: rows,
        returned: rows.length,
        total,
        limit_applied: limit,
        without_mbid: rows.filter((r) => !r.mbid).length,
        reading:
          "`mbid` is the MusicBrainz id and it is what setlist.fm keys on. An " +
          "artist with mbid null CANNOT have setlists read: name search matches " +
          "the wrong band, so get_dj_setlists refuses names outright. Use " +
          "`missing_mbid: true` to find the gaps. An empty result for a name you " +
          "expected means the artist row does not exist yet, NOT that it has no " +
          "mbid - those need different fixes, so check `returned` before " +
          "concluding anything about mbid. " +
          "⚠️ COMPARE `returned` AGAINST `total`. This list is ordered by name " +
          "and cut at the limit, so a short read drops the END OF THE ALPHABET - " +
          "not a random sample. Iterating one unfiltered call is how Weezer goes " +
          "missing while every row it needs is present in the table.",
      },
      // Raises the house truncation note (platform.ts): "results truncated to N
      // of M". Without it a clamped read and a complete one are byte-identical.
      meta: truncated
        ? { truncated: true, total, limit_applied: limit, count: rows.length }
        : {},
    };
  },
});

// ---------------------------------------------------------------------------
// upsert_dj_artist — tier 2
// ---------------------------------------------------------------------------
//
// Tier 2, not tier 1: it can UPDATE an existing row. Creating an artist is
// append-only and would be tier 1 on its own, but one tool that can do either
// takes the higher tier - the blast radius of the worst thing it can do, which
// is overwriting an mbid that was right.

export const upsertDjArtistTool = defineTool({
  name: "upsert_dj_artist",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const name = (args.name as string | undefined)?.trim();
    if (!name) throw new Error("upsert_dj_artist: `name` is required.");

    const mbid = args.mbid as string | null | undefined;
    if (mbid !== undefined && mbid !== null && mbid !== "") {
      const m = String(mbid).trim();
      if (m.length !== MBID_LEN || m.split("-").length !== 5) {
        throw new Error(
          `upsert_dj_artist: ${JSON.stringify(m)} is not a MusicBrainz id. Expected ` +
            `36 characters in 8-4-4-4-12 form. Nothing was written. A malformed ` +
            `mbid does not fail loudly later - it 404s at setlist.fm and reads as ` +
            `"this artist has no setlists", which is a different and much more ` +
            `misleading answer.`,
        );
      }
    }

    const { data: before, error: findErr } = await ctx.db
      .from("dj_artists").select(COLS).ilike("name", name).maybeSingle();
    if (findErr) throw new Error(`upsert_dj_artist: lookup failed: ${findErr.message}`);

    const prevForRename = before as ArtistRow | null;

    // ---------------------------------------------------------------------
    // rename_to — an IN-PLACE rename, which is the only kind that is safe
    // ---------------------------------------------------------------------
    //
    // Five artists need respelling before MusicBrainz will resolve them:
    // Killers -> The Killers, Motley Crue -> Mötley Crüe, and similar for
    // Smashing Pumpkins, Goo Goo Dolls and Black Eyed Peas. Doing that by
    // creating a second row would ORPHAN every concert link, because
    // dj_concerts.artist_id points at the id, not the name.
    //
    // ⚠️ AN UPDATE OF `name` KEEPS THE id, SO EVERY LINK SURVIVES. That is the
    // whole reason this is a rename parameter and not "just insert the right
    // spelling and move on".
    //
    // ⚠️ AND IT NEEDS NO SECOND WRITE — CHECKED, NOT ASSUMED. The worry was
    // that renaming would desync the artist alias map. It does not: ARTIST_ALIASES
    // in dj-normalise.ts reconciles TAKEOUT CHANNEL NAMES with YOUTUBE MUSIC
    // METADATA, both of which are play-derived strings feeding match_key and
    // dj_tracks.artist. `dj_artists.name` is a different system entirely and is
    // read only by get_dj_artists, this tool, and create_dj_concert's by-name
    // lookup. Nothing joins the two. Recorded here so the question is not
    // re-opened every time someone renames an artist.
    const renameTo = (args.rename_to as string | undefined)?.trim();
    if (renameTo) {
      if (!prevForRename) {
        throw new Error(
          `upsert_dj_artist: cannot rename "${name}" — no artist by that name ` +
            `exists. Nothing was written. Creating one under the NEW name would ` +
            `look like a successful rename and would leave any concerts still ` +
            `pointing at whatever row you meant to fix.`,
        );
      }
      if (renameTo.toLowerCase() !== name.toLowerCase()) {
        const { data: clash, error: clashErr } = await ctx.db
          .from("dj_artists").select("id, name").ilike("name", renameTo).maybeSingle();
        if (clashErr) {
          throw new Error(`upsert_dj_artist: rename check failed: ${clashErr.message}`);
        }
        // ⚠️ A rename onto an occupied name is a MERGE, and a merge is a
        // decision about which row's concerts, mbid and feedback survive. The
        // unique index on (user_id, name) would refuse it anyway; this refuses
        // it in a sentence, and refuses to guess the merge.
        if (clash && (clash as { id: string }).id !== prevForRename.id) {
          throw new Error(
            `upsert_dj_artist: cannot rename "${name}" to "${renameTo}" — another ` +
              `artist already has that name (${(clash as { id: string }).id}). That ` +
              `is a MERGE, not a rename: two rows with their own concerts, mbid and ` +
              `feedback would have to become one, and which survives is a decision ` +
              `nothing here can make. Nothing was written.`,
          );
        }
      }
    }

    const patch: Record<string, unknown> = { name: renameTo || name };
    for (const k of ["mbid", "yt_channel_id", "notes", "last_explored_at"]) {
      if (args[k] !== undefined) patch[k] = args[k];
    }
    if (args.tags !== undefined) patch.tags = args.tags;

    // ⚠️ OVERWRITING A NON-NULL mbid IS REFUSED unless replace_mbid is passed.
    // Setting one that was missing is routine; CHANGING one that was already
    // there means either the first was wrong or this one is, and silently
    // picking the newer would repoint every future setlist read at a different
    // band with nothing recording that it happened.
    const prev = before as ArtistRow | null;
    if (prev?.mbid && patch.mbid && patch.mbid !== prev.mbid && args.replace_mbid !== true) {
      throw new Error(
        `upsert_dj_artist: "${name}" already has mbid ${prev.mbid} and this call ` +
          `would change it to ${patch.mbid}. REFUSED — nothing was written. One of ` +
          `the two is wrong, and picking the newer silently would repoint every ` +
          `future setlist read at a different band. Verify against MusicBrainz, ` +
          `then pass replace_mbid: true if the new one is right.`,
      );
    }

    let row: ArtistRow;
    if (prev) {
      const { data, error } = await ctx.db
        .from("dj_artists").update(patch).eq("id", prev.id).select(COLS).single();
      if (error) throw new Error(`upsert_dj_artist: update failed: ${error.message}`);
      row = data as ArtistRow;
    } else {
      const { data, error } = await ctx.db
        .from("dj_artists").insert(patch).select(COLS).single();
      if (error) throw new Error(`upsert_dj_artist: insert failed: ${error.message}`);
      row = data as ArtistRow;
    }

    return {
      artist: row,
      created: !prev,
      // dj_artists IS audited, so the audit trigger has the authoritative
      // record. This before/after is for the caller reading the response now.
      changed: prev
        ? Object.fromEntries(
          Object.keys(patch)
            .filter((k) => k !== "name" &&
              JSON.stringify((prev as Record<string, unknown>)[k]) !== JSON.stringify(patch[k]))
            .map((k) => [k, { from: (prev as Record<string, unknown>)[k], to: patch[k] }]),
        )
        : {},
      reading: prev
        ? "Updated an existing artist. `changed` lists only fields that actually differ."
        : "Created a new artist row. Setting `mbid` now avoids a second call later — " +
          "without it, setlist reads are impossible rather than merely degraded.",
    };
  },
});
