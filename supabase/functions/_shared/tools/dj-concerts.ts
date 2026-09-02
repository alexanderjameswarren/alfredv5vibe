// DJ concerts (read + update) and the preference log.
//
//   get_dj_concerts     — tier 1. The read that did not exist.
//   update_dj_concert   — tier 2. The write that did not exist.
//   record_dj_feedback  — tier 1. Append-only preference.
//
// ⚠️ create_dj_concert LIVES IN dj-playlists.ts, not here. It was written
// alongside record_dj_playlist and moving it would be churn for no gain; the
// duplicate guard added to it references this file's reasoning.
//
// ============================================================================
// WHY THESE EXIST: dj_concerts WAS WRITE-ONCE THROUGH MCP
// ============================================================================
// Until 2026-09-01 nothing could list concert rows and nothing could change one.
// Every row was frozen at the status it was born with. Smashing Pumpkins was
// `screening` for a show on 2026-10-30 and could never become `attended`; Foo
// Fighters was `committed` for 2026-09-26 and could never be closed out.
//
// ⚠️ THAT IS NOT A DEGRADED WEEKLY JOB, IT IS AN ABSENT ONE. §12.8's Section 1
// exists to ASK "did you go?" and record the answer. Asking a question whose
// answer cannot be written down is theatre. The read gap was the visible half;
// the write gap was the one that mattered.

import { defineTool, clampLimit } from "../platform.ts";

const CONCERT_COLS =
  "id, artist_id, venue_id, tour_name, starts_on, ends_on, status, notes, created_at";

const VALID_STATUS = [
  "screening", "interested", "committed", "attended", "missed", "rejected",
];
// Mirrors dj_concerts_undated_status (migration 010). See create_dj_concert for
// why this is duplicated on purpose rather than left to the constraint.
const DATED_ONLY_STATUS = ["interested", "committed"];
const VALID_SENTIMENT = ["love", "like", "neutral", "dislike", "curious"];
const VALID_SOURCE = ["chat", "weekly_review", "manual", "import"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// get_dj_concerts — tier 1
// ---------------------------------------------------------------------------

export const getDjConcertsTool = defineTool({
  name: "get_dj_concerts",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const LIMIT = clampLimit(args.limit as number | undefined);
    const mode = (args.mode as string | undefined) ?? "list";
    if (mode !== "list" && mode !== "needs_status" && mode !== "undecided") {
      throw new Error(
        "get_dj_concerts: `mode` must be 'list', 'needs_status' or 'undecided'.",
      );
    }

    let q = ctx.db.from("dj_concerts").select(CONCERT_COLS);

    if (mode === "undecided") {
      // -------------------------------------------------------------------
      // §12.8's "I never decided" signal — ADDED 016, because it had no field
      // -------------------------------------------------------------------
      // `needs_status` asks "did you go?" and correctly cannot see these: an
      // undated row is neither past nor upcoming. So a standing `screening` row
      // against a playlist nobody plays was invisible forever.
      //
      // 🛑 THE 2026-09-02 RUN SURFACED THESE BY HAND, AND THAT IS THE DEFECT
      // THIS MODE FIXES. There was no field for the question, so the report
      // reached for `went_quiet` — which is a CHANGE detector for Section 4 and
      // does not fire for Oasis (two touch days inside the recent window). Oasis
      // is one of the two cases §12.8 names by name. It was then surfaced by
      // applying "runs low and last_run_on old" with thresholds chosen by eye,
      // which exist in no file and would be chosen differently next week.
      //
      // ⚠️ SO THERE IS NO THRESHOLD HERE AT ALL, DELIBERATELY. The population is
      // tiny (two rows on 2026-09-02) and SELF-CLEARING: answering "still
      // interested?" moves the row out of `screening` and it never returns. A
      // filter would be inventing a cutoff to shrink a list that is already
      // short, and §11.7's "fires on the normal case" risk does not apply to a
      // section that empties itself the moment it is read.
      //
      // The engagement numbers are joined so the caller never picks a threshold
      // either: `quiet_for_days` orders the list, and the raw metrics are there
      // to say WHY in one line.
      q = q.is("starts_on", null).eq("status", "screening");
    } else if (mode === "needs_status") {
      // §12.8 Section 1: the show has happened and the status still says it
      // hasn't been decided.
      //
      // ⚠️ COMPARES starts_on DIRECTLY. Migration 010's column comment is
      // explicit: NULL < today is NULL, so undated rows fall out of this filter
      // by construction — which is correct, because an undated `screening` row
      // is a standing WATCHLIST entry for an act worth seeing whenever they
      // tour, not a show that has been and gone. Coalescing this column to a
      // sentinel date would sweep the entire watchlist into "did you go?".
      q = q.lt("starts_on", new Date().toISOString().slice(0, 10))
           .in("status", ["screening", "interested", "committed"]);
    } else {
      if (args.status !== undefined) {
        const wanted = Array.isArray(args.status)
          ? (args.status as string[]) : [args.status as string];
        for (const s of wanted) {
          if (!VALID_STATUS.includes(s)) {
            throw new Error(
              `get_dj_concerts: '${s}' is not a status. One of ${VALID_STATUS.join(", ")}.`,
            );
          }
        }
        q = q.in("status", wanted);
      }
      if (args.artist_id !== undefined) q = q.eq("artist_id", args.artist_id as string);
      if (args.from_date !== undefined) q = q.gte("starts_on", args.from_date as string);
      if (args.to_date !== undefined) q = q.lte("starts_on", args.to_date as string);
      if (args.undated === true) q = q.is("starts_on", null);
    }

    const { data, error } = await q
      .order("starts_on", { ascending: false, nullsFirst: false })
      .limit(LIMIT);
    if (error) throw new Error(`get_dj_concerts: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    // Artist names, joined here so a concert row is legible without a second
    // call. Same argument as create_dj_concert resolving the artist by name:
    // making the caller carry uuids between calls is a mapping step that can
    // silently pair a concert with the wrong act.
    const artistIds = [...new Set(rows.map((r) => r.artist_id as string))];
    const names = new Map<string, string>();
    if (artistIds.length > 0) {
      const { data: arts, error: aErr } = await ctx.db
        .from("dj_artists").select("id, name").in("id", artistIds);
      if (aErr) throw new Error(`get_dj_concerts: artist lookup failed: ${aErr.message}`);
      for (const a of (arts ?? []) as Array<{ id: string; name: string }>) {
        names.set(a.id, a.name);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const daysBetween = (from: string, to: string) =>
      Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

    // ⚠️ TYPED WIDE ON PURPOSE. `undecided` bolts the engagement fields onto
    // these rows below, and an inferred narrow type would reject the widened
    // object literal at compile time — which the .mjs suites cannot catch,
    // because Node STRIPS types rather than checking them.
    let concerts: Array<Record<string, unknown>> = rows.map((r) => {
      const startsOn = r.starts_on as string | null;
      const when = startsOn === null
        ? "undated"
        : startsOn < today ? "past" : "upcoming";
      return {
        ...r,
        artist_name: names.get(r.artist_id as string) ?? null,
        // Stated rather than left to the reader: an undated row is neither past
        // nor upcoming, and callers doing their own date maths get this wrong.
        when,
        days_until: when === "upcoming" ? daysBetween(today, startsOn!) : null,
        // -----------------------------------------------------------------
        // ADDED 016 — §12.8's OTHER invisible decision, and it has a DEADLINE
        // -----------------------------------------------------------------
        // Smashing Pumpkins sat at `screening` for a show on 2026-10-30, 58 days
        // out, on 2026-09-02. Nothing asks about it: `needs_status` fires only
        // once the date has PASSED, so the question surfaces on the first day it
        // can no longer be answered.
        //
        // ⚠️ THIS IS NOT THE `undecided` MODE'S ROW AND MUST NOT BE MERGED WITH
        // IT. §12.8 is explicit that the first run got this wrong by reading the
        // dated row as if it were a watchlist entry. An undated screening asks
        // "still interested?" in Section 1; a DATED screening with the date
        // approaching is a Section 2 line about a show he is probably going to —
        // Smashing Pumpkins has 10 runs in 90 days. Same status word, two
        // different sentences, and the shared word is what merges them.
        decision_pending: when === "upcoming" && r.status === "screening",
      };
    });

    // --- undecided: join the engagement numbers so nobody re-derives them ---
    let engagementNote: string | null = null;
    if (mode === "undecided" && concerts.length > 0) {
      const ids = concerts.map((c) => c.id as string);
      const { data: pls, error: pErr } = await ctx.db
        .from("dj_playlists").select("id, name, concert_id").in("concert_id", ids);
      if (pErr) {
        throw new Error(`get_dj_concerts: playlist lookup failed: ${pErr.message}`);
      }
      const playlists = (pls ?? []) as Array<
        { id: string; name: string; concert_id: string }
      >;
      const engByPlaylist = new Map<string, Record<string, unknown>>();
      if (playlists.length > 0) {
        const { data: eng, error: eErr } = await ctx.db.rpc(
          "dj_playlist_engagement",
          { p_playlist_ids: playlists.map((p) => p.id), p_window_days: 90 },
        );
        if (eErr) {
          // Operational and retryable — no do-not-retry wording, per the
          // platform error contract.
          throw new Error(
            `get_dj_concerts: engagement failed: ${eErr.message}. If this says ` +
              `the function does not exist, migration 016 is not applied yet.`,
          );
        }
        for (const e of (eng ?? []) as Array<Record<string, unknown>>) {
          engByPlaylist.set(e.playlist_id as string, e);
        }
      }
      concerts = concerts.map((c) => {
        const pl = playlists.find((p) => p.concert_id === c.id);
        const e = pl ? engByPlaylist.get(pl.id) : undefined;
        const lastTouched = (e?.last_touched_on as string | null) ?? null;
        // ⚠️ NEVER-TOUCHED FALLS BACK TO THE ROW'S OWN AGE, NOT TO A NULL THAT
        // SORTS ANYWHERE. A watchlist entry created 90 days ago and never played
        // is the STRONGEST case for asking, and a null would float it to
        // whichever end the sort happens to put nulls.
        const since = lastTouched ?? ((c.created_at as string)?.slice(0, 10) ?? today);
        return {
          ...c,
          playlist_name: pl?.name ?? null,
          runs: (e?.runs as number | null) ?? null,
          last_run_on: (e?.last_run_on as string | null) ?? null,
          touch_days: (e?.touch_days as number | null) ?? null,
          touch_days_recent: (e?.touch_days_recent as number | null) ?? null,
          last_touched_on: lastTouched,
          went_quiet: (e?.went_quiet as boolean | null) ?? null,
          quiet_for_days: daysBetween(since, today),
          never_touched: lastTouched === null,
        };
      });
      concerts.sort((a, b) =>
        (b.quiet_for_days as number) - (a.quiet_for_days as number)
      );
      engagementNote =
        "Engagement is joined at a fixed 90-day window. `quiet_for_days` counts " +
        "from `last_touched_on`, or from the concert row's own creation date " +
        "when the playlist has NEVER been touched (`never_touched: true`) — a " +
        "watchlist entry that has sat unplayed since it was created is the " +
        "strongest case for asking, and a null would sort arbitrarily.";
    }

    return {
      mode,
      concerts,
      returned: concerts.length,
      limit_applied: LIMIT,
      ...(engagementNote ? { engagement_note: engagementNote } : {}),
      reading:
        "`starts_on` may be NULL, and that is legitimate in two shapes " +
        "(migration 010): a historical show whose date is lost, and an undated " +
        "`screening` row — a standing watchlist entry for an act worth seeing " +
        "whenever they tour. ⚠️ UNDATED ROWS ARE NEITHER PAST NOR UPCOMING and " +
        "are excluded from `needs_status` by construction; use `mode=undecided` " +
        "for the ones that need a decision, or `undated: true` for the raw " +
        "watchlist. `interested` and `committed` cannot be undated at all. " +
        "🛑 THREE DIFFERENT QUESTIONS, AND THE SHARED WORD 'screening' MERGES " +
        "THEM IF YOU LET IT. `needs_status` = the date has passed, 'did you " +
        "go?'. `mode=undecided` = undated screening, 'still interested?'. " +
        "`decision_pending` = a DATED screening still ahead, 'you have " +
        "not decided and the show is in `days_until` days' — that one belongs " +
        "in the upcoming-concerts section, not the watchlist, because it is a " +
        "show he is probably going to (§12.8 records the first run getting " +
        "exactly this wrong for Smashing Pumpkins). " +
        "⚠️ `decision_pending` FIRES BEFORE THE DEADLINE; `needs_status` fires " +
        "only after it. A screening row with a future date is answerable now " +
        "and unanswerable later, so nothing else will ever raise it. " +
        "To change a status use update_dj_concert — this table was " +
        "write-once through MCP until 2026-09-01 and asking 'did you go?' " +
        "without a write path is theatre.",
    };
  },
});

// ---------------------------------------------------------------------------
// update_dj_concert — tier 2
// ---------------------------------------------------------------------------
//
// Tier 2: it updates an existing row and the audit trigger makes it reversible.
// Not tier 3 — a status change is the ordinary, expected operation this table
// exists for, and gating the weekly job's whole purpose behind a confirmation
// would make Section 1 two round trips to answer one question.

export const updateDjConcertTool = defineTool({
  name: "update_dj_concert",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const id = args.concert_id as string | undefined;
    if (!id) throw new Error("update_dj_concert: `concert_id` is required.");

    const { data: before, error: findErr } = await ctx.db
      .from("dj_concerts").select(CONCERT_COLS).eq("id", id).maybeSingle();
    if (findErr) throw new Error(`update_dj_concert: lookup failed: ${findErr.message}`);
    if (!before) {
      throw new Error(
        `update_dj_concert: no concert with id ${id}. Nothing was written. Use ` +
          `get_dj_concerts to find it — this tool will not create a row, because ` +
          `a typo'd id that silently created a second concert is exactly how a ` +
          `wrong date gets duplicated instead of corrected.`,
      );
    }
    // ⚠️ SNAPSHOTTED, NOT ALIASED. `changed` below is computed AFTER the update
    // runs, so it must compare against values captured BEFORE it. Holding a
    // reference works only as long as the client hands back a fresh object on
    // every read — true of PostgREST today, and not something this handler
    // should depend on. Without the copy, a client that returns a cached row
    // would report every update as changing nothing.
    const prev = { ...(before as Record<string, unknown>) };

    // ⚠️ ABSENT vs EXPLICIT NULL, as in record_dj_playlist. `??` would collapse
    // them and a status-only update would blank starts_on.
    const patch: Record<string, unknown> = {};
    for (const k of ["status", "starts_on", "ends_on", "tour_name", "notes", "venue_id"]) {
      if (args[k] !== undefined) patch[k] = args[k];
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(
        "update_dj_concert: nothing to change. Pass at least one of status, " +
          "starts_on, ends_on, tour_name, notes, venue_id.",
      );
    }

    if (patch.status !== undefined && !VALID_STATUS.includes(patch.status as string)) {
      throw new Error(
        `update_dj_concert: \`status\` must be one of ${VALID_STATUS.join(", ")}.`,
      );
    }
    for (const k of ["starts_on", "ends_on"]) {
      const v = patch[k];
      if (v !== undefined && v !== null && !ISO_DATE_RE.test(String(v))) {
        throw new Error(`update_dj_concert: \`${k}\` must be YYYY-MM-DD or null.`);
      }
    }

    // The resulting row, not the patch — a status change and a date change can
    // arrive in separate calls, so validity has to be judged on the OUTCOME.
    const after = { ...prev, ...patch };
    const finalStart = after.starts_on as string | null;
    const finalStatus = after.status as string;
    const finalEnd = after.ends_on as string | null;

    if (!finalStart && DATED_ONLY_STATUS.includes(finalStatus)) {
      throw new Error(
        `update_dj_concert: status '${finalStatus}' needs a \`starts_on\`, and ` +
          `this row would have none. 'interested' and 'committed' both mean a ` +
          `SPECIFIC show. Pass starts_on in the same call, or use 'screening' — ` +
          `undated screening is the standing watchlist and is accurate. Do NOT ` +
          `approximate the date to get past this.`,
      );
    }
    if (finalEnd && !finalStart) {
      // dj_concerts_date_range is `ends_on IS NULL OR ends_on >= starts_on`,
      // which with a NULL starts_on evaluates to NULL and PASSES. The database
      // cannot catch this one.
      throw new Error(
        "update_dj_concert: this row would have an `ends_on` and no `starts_on`. " +
          "A residency runs starts_on..ends_on; an end with no beginning is not a " +
          "range.",
      );
    }
    if (finalEnd && finalStart && finalEnd < finalStart) {
      throw new Error(
        `update_dj_concert: ends_on (${finalEnd}) is before starts_on (${finalStart}).`,
      );
    }

    const { data, error } = await ctx.db
      .from("dj_concerts").update(patch).eq("id", id).select(CONCERT_COLS).single();
    if (error) throw new Error(`update_dj_concert: ${error.message}`);

    const changed = Object.fromEntries(
      Object.keys(patch)
        .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(patch[k]))
        .map((k) => [k, { from: prev[k], to: patch[k] }]),
    );

    return {
      concert: data,
      changed,
      // ⚠️ SURFACED, NOT WRITTEN. The column comment on dj_concerts.status is
      // explicit: "missed = did not go BUT still want to see them", and the
      // lingering want is a fact about the ARTIST, so it belongs in dj_feedback
      // (§13.3). This tool does not write it — a second write smuggled into a
      // status change is the kind of thing nobody remembers happened — but
      // silently dropping the half that makes `missed` actionable would repeat
      // the gap §13.3 was written about.
      feedback_owed: (patch.status === "missed")
        ? {
          reason:
            "status is now 'missed', which per the column comment means did NOT " +
            "go but STILL WANT to see them. That want is a fact about the " +
            "artist, not about this night, and it is not recorded yet.",
          suggested_call: {
            tool: "record_dj_feedback",
            artist_id: prev.artist_id,
            sentiment: "curious",
            note: "Missed them live; still want to see them.",
          },
        }
        : null,
    };
  },
});

// ---------------------------------------------------------------------------
// record_dj_feedback — tier 1
// ---------------------------------------------------------------------------
//
// Tier 1: dj_feedback is append-only by design — the table comment says "Never
// updated; a changed opinion is a new row" — and an append to an append-only
// table is tier 1 under the platform's own taxonomy.
//
// ⚠️ THE VOCABULARY IS NOT NEW AND MUST NOT BE. `dj_feedback.sentiment` has
// carried a CHECK since Block A: love | like | neutral | dislike | curious. The
// column comment already describes the exact case this tool was requested for:
// "curious means wanting more rather than having judged. For an artist you
// missed live but still want to see, that lingering want is recorded here, not
// on the concert row." Inventing a second vocabulary beside a correct one would
// have been the mistake — checked before writing, per §11.17: the authority was
// queryable and was queried.

export const recordDjFeedbackTool = defineTool({
  name: "record_dj_feedback",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const subjects = ["artist_id", "concert_id", "album_id", "track_id", "venue_id"];
    const given = subjects.filter((k) => args[k] !== undefined && args[k] !== null);
    if (given.length !== 1) {
      // Mirrors dj_feedback_one_subject, but as a sentence. The constraint is a
      // sum of five boolean casts and its violation message is unreadable.
      throw new Error(
        `record_dj_feedback: exactly ONE subject is required, got ${given.length}` +
          (given.length ? ` (${given.join(", ")})` : "") +
          `. Feedback is about one thing: an artist, a concert, an album, a track ` +
          `or a venue. Five nullable keys with one filled is deliberate — it keeps ` +
          `real foreign keys instead of a generic subject_type/subject_id pair.`,
      );
    }

    const sentiment = args.sentiment as string | undefined;
    const note = args.note as string | undefined;
    if (sentiment !== undefined && !VALID_SENTIMENT.includes(sentiment)) {
      throw new Error(
        `record_dj_feedback: \`sentiment\` must be one of ${VALID_SENTIMENT.join(", ")}. ` +
          `'curious' means wanting more rather than having judged — it is the right ` +
          `one for an act you missed live but still want to see.`,
      );
    }
    if (!sentiment && !note) {
      // Mirrors dj_feedback_has_content.
      throw new Error(
        "record_dj_feedback: pass a `sentiment`, a `note`, or both. A feedback row " +
          "with neither records that something happened without recording what.",
      );
    }
    const source = (args.source as string | undefined) ?? "chat";
    if (!VALID_SOURCE.includes(source)) {
      throw new Error(
        `record_dj_feedback: \`source\` must be one of ${VALID_SOURCE.join(", ")}.`,
      );
    }
    const occurredOn = args.occurred_on as string | undefined;
    if (occurredOn !== undefined && !ISO_DATE_RE.test(occurredOn)) {
      throw new Error("record_dj_feedback: `occurred_on` must be YYYY-MM-DD.");
    }

    const row: Record<string, unknown> = { source };
    row[given[0]] = args[given[0]];
    if (sentiment !== undefined) row.sentiment = sentiment;
    if (note !== undefined) row.note = note;
    if (occurredOn !== undefined) row.occurred_on = occurredOn;

    const { data, error } = await ctx.db
      .from("dj_feedback")
      .insert(row)
      .select("id, artist_id, concert_id, album_id, track_id, venue_id, sentiment, note, occurred_on, source, created_at")
      .single();
    if (error) throw new Error(`record_dj_feedback: ${error.message}`);

    return {
      feedback: data,
      subject: given[0],
      reading:
        "Append-only: this row does not replace an earlier opinion, it succeeds " +
        "it. How Alex feels about something is the NEWEST row, which is why " +
        "dj_artists deliberately holds no stance column — there is exactly one " +
        "place that truth lives.",
    };
  },
});
