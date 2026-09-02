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

// ---------------------------------------------------------------------------
// record_dj_artist_tag — tier 2
// ---------------------------------------------------------------------------
//
// 🛑 THIS DOES NOT WRITE dj_artists. IT WRITES dj_artist_tags, WHICH IS A
//    DIFFERENT TABLE ABOUT A DIFFERENT KIND OF THING, AND THE FILE THEY SHARE IS
//    THE ONLY REASON THEY LOOK RELATED.
//
// `dj_artists.name` is an IDENTITY: 22 mbid-keyed concert acts, where a null
// mbid means setlists cannot be read at all. `dj_artist_tags.artist` is a MATCH
// KEY: the exact dj_tracks.artist string, warts included — "Eddie Higgins Trio",
// "Oscar Peterson Trio", and at least one scraped channel byline with a view
// count in it (§14.9). Nothing joins the two (see upsert_dj_artist), and this
// tool must never be the thing that starts.
//
// ⚠️ TIER 2, NOT TIER 1, AND THE REASON IS THE `status` FIELD.
//
// Tier 1 is for appends to append-only tables. This is not one: setting a tag to
// 'rejected', or reversing that, UPDATES an existing row. Per the platform
// taxonomy that is tier 2 — audited, and reversible through
// platform.rollback_audit_entry.
//
// 🛑 AND AN APPEND-ONLY VERSION WOULD HAVE BEEN THE WRONG TOOL ANYWAY. The whole
// argument for curating this list by hand is that a rule gets it wrong (§14.7)
// and that some of these strings are not artists (§14.9). A curated allowlist
// that cannot be UN-curated is not curated — a single mistaken approval would
// need a migration to undo, and the flow this serves is a human saying yes or no
// to a weekly proposal. Getting one wrong has to cost a sentence, not a deploy.
//
// ⚠️ NEVER A HARD DELETE. Rejection is a soft delete and it carries meaning of
// its own: 'rejected' means ASKED AND ANSWERED NO, and dj_tag_candidates
// excludes it so the same name is not proposed every week forever (§11.7).
// Deleting the row would restore exactly that behaviour.
export const recordDjArtistTagTool = defineTool({
  name: "record_dj_artist_tag",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tag = ((args.tag as string | undefined) ?? "jazz").trim();
    if (!tag) throw new Error("record_dj_artist_tag: `tag` cannot be empty.");

    const status = ((args.status as string | undefined) ?? "active").trim();
    if (status !== "active" && status !== "rejected") {
      throw new Error(
        `record_dj_artist_tag: \`status\` must be 'active' or 'rejected' ` +
          `(got ${JSON.stringify(status)}). 'rejected' records that the artist ` +
          `was considered and declined, so the weekly item stops proposing him — ` +
          `it is a decision, not a deletion.`,
      );
    }

    const raw = args.artists ?? args.artist;
    const artists = (Array.isArray(raw) ? raw : [raw])
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim())
      .filter(Boolean);
    if (artists.length === 0) {
      throw new Error(
        "record_dj_artist_tag: pass `artists` (an array) or `artist` (one string).",
      );
    }
    if (artists.length > 50) {
      throw new Error(
        `record_dj_artist_tag: ${artists.length} artists in one call; the cap is 50.`,
      );
    }

    const note = (args.note as string | undefined)?.trim() || null;

    // -----------------------------------------------------------------------
    // 🛑 THE TYPO GUARD, AND IT IS THE WHOLE REASON THIS TOOL IS NOT A THIN
    //    INSERT. Every arm of every tag definition is an EXACT STRING match on
    //    dj_tracks.artist. A tag reading "Eddie Higgins" when the data says
    //    "Eddie Higgins Trio" inserts perfectly, matches nothing, and leaves the
    //    report wrong in precisely the direction §14.13 was about — while the
    //    write reports success.
    //
    // ⚠️ THIS IS THE SAME CHECK MIGRATION 017 GETS FROM ITS JOIN. A tool that
    // skipped it would be a second way in with weaker rules than the first.
    // -----------------------------------------------------------------------
    const { data: known, error: kErr } = await ctx.db
      .from("dj_tracks").select("artist").in("artist", artists);
    if (kErr) {
      throw new Error(`record_dj_artist_tag: artist lookup failed: ${kErr.message}`);
    }
    const seen = new Set(
      ((known ?? []) as Array<{ artist: string }>).map((r) => r.artist),
    );
    const unknown = artists.filter((a) => !seen.has(a));
    if (unknown.length > 0) {
      throw new Error(
        `record_dj_artist_tag: ${unknown.map((u) => JSON.stringify(u)).join(", ")} ` +
          `${unknown.length === 1 ? "does" : "do"} not appear as an artist string ` +
          `in dj_tracks, so ${unknown.length === 1 ? "a tag on it" : "tags on them"} ` +
          `would match nothing and be invisible. NOTHING WAS WRITTEN — a partial ` +
          `write here is worse than none, because the missing rows would look ` +
          `like a decision not to tag them. The string must be copied EXACTLY ` +
          `from get_dj_plays mode=artists: the join is an exact match, and ` +
          `"Eddie Higgins" and "Eddie Higgins Trio" are different artists to it.`,
      );
    }

    // ⚠️ PROVENANCE IS DERIVED HERE, NEVER TAKEN FROM THE CALLER. `source` says
    // whether a row is a FACT (the artist is on a track in a playlist whose kind
    // matches the tag — migration 013's arm, stored) or a JUDGEMENT. That is a
    // property of the data, and a caller asserting it would be able to launder a
    // guess into a fact, which is what `source` exists to prevent.
    const { data: plRows, error: plErr } = await ctx.db
      .from("dj_playlists").select("id").eq("kind", tag);
    if (plErr) {
      throw new Error(`record_dj_artist_tag: playlist lookup failed: ${plErr.message}`);
    }
    const derivable = new Set<string>();
    const plIds = ((plRows ?? []) as Array<{ id: string }>).map((p) => p.id);
    if (plIds.length > 0) {
      const { data: ptRows, error: ptErr } = await ctx.db
        .from("dj_playlist_tracks").select("track_id").in("playlist_id", plIds);
      if (ptErr) {
        throw new Error(
          `record_dj_artist_tag: membership lookup failed: ${ptErr.message}`,
        );
      }
      const trackIds = [
        ...new Set(
          ((ptRows ?? []) as Array<{ track_id: string }>).map((r) => r.track_id),
        ),
      ];
      if (trackIds.length > 0) {
        const { data: tRows, error: tErr } = await ctx.db
          .from("dj_tracks").select("artist").in("id", trackIds);
        if (tErr) {
          throw new Error(`record_dj_artist_tag: track lookup failed: ${tErr.message}`);
        }
        for (const t of (tRows ?? []) as Array<{ artist: string | null }>) {
          if (t.artist) derivable.add(t.artist);
        }
      }
    }

    const now = new Date().toISOString();
    // ⚠️ user_id IS NOT SET HERE. dj_artist_tags.user_id defaults to auth.uid()
    // (migration 018), so the database decides the owner. `ctx.userId` is the
    // UNVERIFIED JWT sub — fine for logging, wrong as an ownership key, and RLS
    // catching a mismatch is a second mechanism rather than a reason to send it.
    const rows = artists.map((artist) => ({
      artist,
      tag,
      status,
      source: derivable.has(artist) ? "playlist" : "manual",
      note,
      decided_at: now,
    }));

    const { data: written, error: wErr } = await ctx.db
      .from("dj_artist_tags")
      .upsert(rows, { onConflict: "user_id,artist,tag" })
      .select("artist, tag, status, source, note, decided_at");
    if (wErr) {
      throw new Error(`record_dj_artist_tag: write failed: ${wErr.message}`);
    }

    const out = (written ?? []) as Array<Record<string, unknown>>;
    return {
      tags: out,
      written: out.length,
      tag,
      status,
      facts: out.filter((r) => r.source === "playlist").length,
      judgements: out.filter((r) => r.source === "manual").length,
      reading:
        "⚠️ `artist` is the EXACT dj_tracks.artist string — a match key, not a " +
        "display name. This is NOT dj_artists, which holds mbid-keyed concert-act " +
        "identities and joins to nothing here. " +
        "⚠️ `source` is DERIVED, never accepted from the caller: 'playlist' means " +
        "the artist is on a track in a playlist whose kind matches the tag, which " +
        "is a fact; 'manual' means a human decided. " +
        "🛑 status 'rejected' is a DECISION, not a deletion — it records that the " +
        "artist was considered and declined, and dj_tag_candidates stops " +
        "proposing him. Reversing it is another call to this tool; nothing here " +
        "hard-deletes, so the audit log can undo any of it.",
    };
  },
});

// ---------------------------------------------------------------------------
// get_dj_artist_tags — tier 1
// ---------------------------------------------------------------------------
//
// 🛑 A CURATED LIST YOU CANNOT READ IS A WRITE-ONLY LIST, AND IT WILL ROT.
//
// Until this existed, `dj_artist_tags` could be written by record_dj_artist_tag
// and read only THROUGH dj_artist_activity — which shows `tags` on artists that
// were PLAYED IN THE WINDOW, and nothing else. That left three things invisible:
//
//   * REJECTIONS. The one state whose entire purpose is to be remembered was
//     the one nobody could look at. "What did I already say no to?" had no
//     answer outside the SQL editor, and a decision you cannot review is a
//     decision you will make again differently.
//   * TAGS ON ARTISTS NOT PLAYED RECENTLY. 87 tags exist and 25 of those
//     artists were played in the last 90 days. The other 62 were unreadable.
//   * PROVENANCE. Which rows are derived facts and which are human judgements
//     is what makes a resync safe, and it could not be checked.
//
// ⚠️ THIS IS A REVIEW SURFACE, NOT A REPORTING ONE. It answers "what is on the
// list and who put it there", never "what am I listening to" — that is
// get_dj_plays mode=artists, and keeping the two apart is the whole reason
// §14.19 happened once and should not happen twice.
export const getDjArtistTagsTool = defineTool({
  name: "get_dj_artist_tags",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const LIMIT = clampLimit(args.limit as number | undefined);

    // -----------------------------------------------------------------------
    // mode=review — WHICH TAGS REST ON ALMOST NO EVIDENCE (added 021)
    // -----------------------------------------------------------------------
    // 🛑 THE DERIVED ARM WROTE GARBAGE WITH THE AUTHORITY OF A DERIVATION. After
    // the 018/020 seeds, jazz tags included "Dec 29, 2023", "Anything_F_744",
    // "aron!" and "Cavendish Music" — every one TRUE as a membership statement
    // (the string really is on a track in a jazz playlist) and every one FALSE as
    // the claim the tag makes, which is that this is an act (§14.9).
    //
    // ⚠️ IT MAKES NO CLAIM ABOUT WHICH STRINGS ARE REAL, AND MUST NOT BE READ AS
    // ONE. It returns four facts — tracks, playlists, play rows, days — and
    // orders by them. Nothing inspects the text: every rule that would is a guess
    // about language, and §14.7 records what those cost here.
    if ((args.mode as string | undefined) === "review") {
      const { data, error } = await ctx.db.rpc("dj_tag_review", {
        p_tag: (args.tag as string | undefined) ?? null,
        p_source: (args.source as string | undefined) ?? null,
        p_window_days: (args.window_days as number | undefined) ?? 90,
        p_limit: LIMIT,
      });
      if (error) {
        throw new Error(
          `get_dj_artist_tags: review failed: ${error.message}. If this says the ` +
            `function does not exist, migration 021 has not been applied yet.`,
        );
      }
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      return { data: {
        mode: "review",
        tags: rows,
        returned: rows.length,
        limit_applied: LIMIT,
        reading:
          "🛑 ORDERED WEAKEST EVIDENCE FIRST, AND THAT IS AN ORDERING FOR A HUMAN, " +
          "NEVER A VERDICT. `distinct_tracks`, `distinct_playlists`, `play_rows` " +
          "and `distinct_days` are facts already in the database; NOTHING HERE " +
          "INSPECTS THE STRING. A real act accumulates tracks, playlists and " +
          "plays; a byline scraped onto one upload accumulates one track and " +
          "stops — a factual asymmetry, not a linguistic judgement. " +
          "⚠️ `source: 'playlist'` rows were written as FACTS by the seeds, which " +
          "is exactly why they need reviewing: the derivation knows MEMBERSHIP " +
          "and writes a CLAIM ABOUT AN ACT, and dj_tracks.artist carries scraped " +
          "bylines, upload dates and filename fragments (§14.9). " +
          "🛑 DO NOT REJECT ROWS FROM INSIDE A WEEKLY REVIEW. The cleanup is a " +
          "separate hand-reviewed pass; folding an irreversible judgement about " +
          "a hundred rows into a conversation about concerts is how it gets done " +
          "carelessly.",
      }, meta: { limit_applied: LIMIT } };
    }

    const status = (args.status as string | undefined)?.trim();
    if (status && status !== "active" && status !== "rejected") {
      throw new Error(
        `get_dj_artist_tags: \`status\` must be 'active' or 'rejected' ` +
          `(got ${JSON.stringify(status)}). Omit it to see both — which is the ` +
          `point of the tool: a rejection is a decision, and reviewing the list ` +
          `means seeing what was declined as well as what was kept.`,
      );
    }

    const source = (args.source as string | undefined)?.trim();
    if (source && source !== "playlist" && source !== "manual") {
      throw new Error(
        `get_dj_artist_tags: \`source\` must be 'playlist' or 'manual' ` +
          `(got ${JSON.stringify(source)}).`,
      );
    }

    // ⚠️ COUNTED BEFORE THE LIMIT, NOT AFTER. A clamped list of a curated set is
    // the one place a short read reads as a complete one — "I have tagged 20
    // artists" when the answer is 87 is exactly the §14.5 shape, arriving through
    // a different door.
    let countQ = ctx.db
      .from("dj_artist_tags")
      .select("id", { count: "exact", head: true });
    if (args.tag !== undefined) countQ = countQ.eq("tag", args.tag as string);
    if (status) countQ = countQ.eq("status", status);
    if (source) countQ = countQ.eq("source", source);
    const { count, error: cErr } = await countQ;
    if (cErr) throw new Error(`get_dj_artist_tags: count failed: ${cErr.message}`);

    let q = ctx.db
      .from("dj_artist_tags")
      .select("artist, tag, status, source, note, decided_at, created_at");
    if (args.tag !== undefined) q = q.eq("tag", args.tag as string);
    if (status) q = q.eq("status", status);
    if (source) q = q.eq("source", source);

    // Rejections first when both are shown: they are the rows nobody can see any
    // other way, and burying them under 87 active tags would leave them as
    // invisible as they were before this tool existed.
    //
    // ⚠️ DESCENDING, AND THE ASCENDING VERSION LOOKED CORRECT. 'active' sorts
    // BEFORE 'rejected' alphabetically, so `ascending: true` put the rejections
    // at the bottom — the exact behaviour this ordering exists to prevent, under
    // a comment claiming the opposite. Caught by the test, not by reading it.
    const { data, error } = await q
      .order("status", { ascending: false })
      .order("artist", { ascending: true })
      .limit(LIMIT);
    if (error) throw new Error(`get_dj_artist_tags: ${error.message}`);

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const total = count ?? rows.length;
    return { data: {
      tags: rows,
      returned: rows.length,
      total,
      limit_applied: LIMIT,
      truncated: total > rows.length,
      filters: {
        tag: (args.tag as string | undefined) ?? null,
        status: status ?? null,
        source: source ?? null,
      },
      reading:
        "⚠️ THIS IS THE REVIEW SURFACE FOR THE TAG LIST, not a listening report. " +
        "For what was actually played use get_dj_plays mode=artists. " +
        "🛑 `status: 'rejected'` ROWS ARE DECISIONS, NOT DELETIONS — an artist " +
        "considered and declined, kept so the weekly item stops proposing him " +
        "(§11.7). They are the rows that exist for no other reason than to be " +
        "read back, so they sort first. " +
        "⚠️ `source: 'playlist'` rows are DERIVED — the artist is on a track in a " +
        "playlist whose kind matches the tag, which is migration 013's artist " +
        "arm stored rather than recomputed. They can be re-derived safely. " +
        "`source: 'manual'` rows are human judgements and nothing may overwrite " +
        "them automatically. " +
        "⚠️ `artist` is the EXACT dj_tracks.artist string — a match key, not a " +
        "display name, and NOT dj_artists (§14.1). " +
        "⚠️ COMPARE `returned` AGAINST `total`: this list is ordered and cut at " +
        "the limit, so a short read drops the END of it rather than a sample.",
    }, meta: { truncated: total > rows.length, limit_applied: LIMIT } };
  },
});
