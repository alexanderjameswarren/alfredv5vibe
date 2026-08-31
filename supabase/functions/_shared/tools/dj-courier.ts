// DJ courier write tools — the Supabase half of the §2 courier loop.
//
//   record_dj_plays     — tier 1. Tracks AND plays in one call.
//   create_platform_run — tier 1. Stamp a job run (including failed ones).
//   get_platform_runs   — tier 1 read. Newest run for an app+job; gap detection.
//
// Workshop reads YouTube and writes nothing; Claude carries the data here and
// this file writes it. Platform contract (mcp-platform skill + spec §8):
// database access ONLY via `ctx.db`. This file does NOT import a Supabase
// client. Every field a handler reads appears in the input schema registered
// alongside it in mcp/index.ts.
//
// Two invariants worth stating at the top, because both are load-bearing and
// neither is obvious from the code alone:
//
// 1. dj_tracks is INSERT-ONLY. Nothing here ever updates a track row. That is
//    what makes hand-curated canonical grouping safe by construction — a
//    re-poll of a known track changes nothing at all. The cost is spec §4.1.2:
//    match_key and canonical_track_id are written once, so improving the
//    normaliser later does NOT regroup existing tracks. That is a backfill
//    migration, not a deploy.
//
// 2. Play dedupe is a DATABASE guarantee, not application arithmetic. We send
//    every occurrence 1..N and let the unique index on
//    (user_id, track_id, played_on, occurrence, source) absorb the ones we
//    already hold. Re-running the same sync inserts zero rows because Postgres
//    says so, not because a count was computed correctly.
//
//    That key was (…, played_bucket, …) until phase 2b, where it proved broken
//    in BOTH directions: a play's label changes as it ages, so one play minted a
//    fresh row at each stage; and two different plays days apart both arrive
//    labelled "Today", so the second was silently dropped. See spec §4.3 — the
//    key is inseparable from INGESTIBLE_BUCKETS below.

import { clampLimit, defineTool } from "../platform.ts";
import { resolveTrackIds } from "./dj-tracks.ts";
import {
  buildMatchKey,
  canonicalArtist,
  ISO_DATE_RE,
  resolvePlayDate,
  VALID_PRECISION,
  VALID_SOURCE,
} from "./dj-normalise.ts";

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

// A day of listening is ~50 plays; one full YouTube history page is ~200.
// 500 is comfortable headroom. Over the cap we REJECT rather than truncate:
// for a write, a silently-dropped tail is far worse than a failed call, since
// the caller would stamp a successful run over an incomplete import.
const PLAYS_CAP = 500;

// The dedupe key. Must match the unique index on dj_plays exactly, or PostgREST
// rejects the upsert outright ("no unique or exclusion constraint matching the
// ON CONFLICT specification") — a loud failure, which is the right kind.
const PLAYS_CONFLICT_TARGET = "user_id,track_id,played_on,occurrence,source";

// Buckets the poll is allowed to WRITE — spec §4.3.
//
// Coarse buckets resolve through the §4.2 ladder to poll_date − 2 and − 9, and
// those move EVERY DAY: a play sitting in "This week" resolves to one date on
// Thursday and another on Friday, so it re-inserts under any date-based key.
// Today and Yesterday are the only labels that resolve to a stable date — a
// play seen as Today on Tuesday and as Yesterday on Wednesday resolves to
// Tuesday both times, so it dedupes across the transition instead of
// duplicating.
//
// The key and this restriction are ONE mechanism; neither is correct without
// the other. Enforced here rather than left to the caller precisely because
// phase 5's scheduled task would otherwise have to remember it forever.
const INGESTIBLE_BUCKETS = new Set(["Today", "Yesterday"]);

// platform_runs.status CHECK vocabulary. 'partial' means it ran and wrote
// something but not everything — which is what a run with an unfillable gap
// records, since the days beyond yesterday are unreachable from the live API.
const VALID_RUN_STATUS = ["ok", "failed", "auth_expired", "partial"];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface PlayInput {
  video_id?: string;
  title?: string;
  artists?: string[];
  album?: string | null;
  duration_seconds?: number | null;
  played_bucket?: string;
  played_on?: string;
  precision?: string;
  occurrence?: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// record_dj_plays — tier 1
// ---------------------------------------------------------------------------

export const recordDjPlaysTool = defineTool({
  name: "record_dj_plays",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const plays = args.plays as PlayInput[] | undefined;
    const pollDate = args.poll_date as string | undefined;
    const source = (args.source as string | undefined) ?? "poll";

    if (!Array.isArray(plays) || plays.length === 0) {
      throw new Error("record_dj_plays: `plays` must be a non-empty array.");
    }
    if (plays.length > PLAYS_CAP) {
      // Reject, never truncate — see PLAYS_CAP.
      throw new Error(
        `record_dj_plays: ${plays.length} plays exceeds the per-call cap of ` +
          `${PLAYS_CAP}. Nothing was written. Split into batches of ${PLAYS_CAP} ` +
          `or fewer and call once per batch.`,
      );
    }
    if (!VALID_SOURCE.includes(source)) {
      throw new Error(
        `record_dj_plays: invalid source "${source}"; must be one of ${VALID_SOURCE.join(", ")}.`,
      );
    }
    if (pollDate !== undefined && !ISO_DATE_RE.test(pollDate)) {
      throw new Error(
        `record_dj_plays: poll_date "${pollDate}" must be YYYY-MM-DD.`,
      );
    }

    // --- Normalise every play up front. Reject the whole batch on any
    // problem, with all problems listed, so the caller fixes them in one pass
    // rather than iterating. Nothing is written until this passes.
    const errors: string[] = [];
    let albumsDiscarded = 0;
    const prepared: Array<{
      video_id: string;
      title: string;
      artist: string | null;
      album: string | null;
      duration_seconds: number | null;
      match_key: string | null;
      played_on: string;
      precision: string;
      played_bucket: string | null;
      occurrence: number;
    }> = [];

    plays.forEach((p, i) => {
      const at = `plays[${i}]`;
      if (!p || typeof p !== "object") {
        errors.push(`${at}: not an object.`);
        return;
      }
      if (!p.video_id || typeof p.video_id !== "string") {
        errors.push(`${at}: \`video_id\` is required.`);
        return;
      }
      if (!p.title || typeof p.title !== "string") {
        errors.push(`${at}: \`title\` is required.`);
        return;
      }

      let playedOn: string;
      let precision: string;
      if (p.played_on !== undefined || p.precision !== undefined) {
        // Explicit-date path (Takeout, manual).
        if (!p.played_on || !ISO_DATE_RE.test(p.played_on)) {
          errors.push(`${at}: \`played_on\` must be YYYY-MM-DD when given.`);
          return;
        }
        if (!p.precision || !VALID_PRECISION.includes(p.precision)) {
          errors.push(
            `${at}: \`precision\` must be one of ${VALID_PRECISION.join(", ")} when played_on is given.`,
          );
          return;
        }
        playedOn = p.played_on;
        precision = p.precision;
      } else {
        // Bucket path (poll).
        if (!p.played_bucket) {
          errors.push(
            `${at}: needs either \`played_bucket\` (with a top-level poll_date) or an explicit \`played_on\` + \`precision\`.`,
          );
          return;
        }
        if (!pollDate) {
          errors.push(`${at}: \`played_bucket\` given but top-level \`poll_date\` is missing.`);
          return;
        }
        if (!INGESTIBLE_BUCKETS.has(p.played_bucket)) {
          errors.push(
            `${at}: bucket "${p.played_bucket}" cannot be written. The poll ingests ` +
              `precise buckets only (Today, Yesterday) — coarse buckets resolve to a date ` +
              `relative to poll_date, so that date MOVES every day and the same play ` +
              `re-inserts under a new one (spec §4.3). Read coarse buckets for gap ` +
              `detection; import older history from Takeout, which carries real ` +
              `timestamps. Filter these out of \`plays\` and re-invoke.`,
          );
          return;
        }
        try {
          const r = resolvePlayDate(p.played_bucket, pollDate);
          playedOn = r.played_on;
          precision = r.precision;
        } catch (e) {
          errors.push(`${at}: ${(e as Error).message}`);
          return;
        }
      }

      // played_bucket is DIAGNOSTIC ONLY now — it is not in the dedupe key, so
      // a null is harmless and an explicit-date row keeps an honest null rather
      // than a date stuffed into a column that means "what YouTube said".
      //
      // (Before phase 2b the key included played_bucket, and because Postgres
      // treats NULLs as DISTINCT in a unique index, a null bucket defeated
      // dedupe entirely — so this defaulted to the ISO date to plug that hole.
      // Keying on played_on removes the need and the misleading value with it.)
      const bucket = p.played_bucket ?? null;

      const occurrence = p.occurrence ?? 1;
      if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > 32767) {
        errors.push(`${at}: \`occurrence\` must be a positive integer (smallint).`);
        return;
      }

      const artists = Array.isArray(p.artists)
        ? p.artists.filter((a): a is string => typeof a === "string" && a.length > 0)
        : [];

      // The poll NEVER writes album. YouTube's history feed reports what was
      // listened THROUGH, not what the track is FROM: playing a mix stamps the
      // mix name on every track in it — 30 of the first 31 rows said "Summer
      // Jazz: Herbie Hancock", including Wayne Shorter and Jackie McLean — and
      // it arrives with a real MPREb_ browse id, so it is structurally
      // indistinguishable from a genuine album.
      //
      // Nulled rather than flagged: the feed is not giving a low-confidence
      // album, it is giving a different thing, and a flag would preserve a
      // value nobody should read. And because dj_tracks is insert-only, any
      // detection rule would have to be correct at insert time from this batch
      // alone — the cross-artist signal that reveals a mix is retrospective, so
      // every miss would be permanent.
      //
      // Discards are counted and returned, so this is visible rather than
      // silent. dj_albums must come from a real lookup or Takeout.
      const albumIn = p.album ?? null;
      if (source === "poll" && albumIn !== null) albumsDiscarded++;

      prepared.push({
        video_id: p.video_id,
        title: p.title,
        // The stored column gets the canonical primary too — it is what an
        // artist-level query reads, and it is where the split actually
        // hurt: nothing was mis-GROUPED (match_key is artist|title, and 0
        // same-title pairs existed), but 'when did I last hear Red
        // Garland' read two different strings for one act.
        artist: artists.length > 0
          ? [canonicalArtist(artists[0]), ...artists.slice(1)].join(", ")
          : null,
        album: source === "poll" ? null : albumIn,
        duration_seconds: p.duration_seconds ?? null,
        match_key: buildMatchKey(artists, p.title),
        played_on: playedOn,
        precision,
        played_bucket: bucket,
        occurrence,
      });
    });

    if (errors.length > 0) {
      const shown = errors.slice(0, 20);
      const more = errors.length - shown.length;
      throw new Error(
        `record_dj_plays: ${errors.length} validation error(s). No rows written. ` +
          `Fix these and re-invoke:\n` + shown.join("\n") +
          (more > 0 ? `\n(+${more} more)` : ""),
      );
    }

    // --- Track identity + canonical grouping. Shared with record_dj_playlist
    // via dj-tracks.ts — one implementation, because a divergence between two
    // copies would silently group one import path differently from the other
    // and dj_tracks is insert-only, so the rows could never be corrected.
    const { idByVideoId, videoIds, createdVideoIds, linked, artistDisagreements } =
      await resolveTrackIds(
      prepared.map((p) => ({
        video_id: p.video_id,
        title: p.title,
        artist: p.artist,
        album: p.album,
        duration_seconds: p.duration_seconds,
        match_key: p.match_key,
      })),
      ctx,
      "record_dj_plays",
    );

    // --- Plays. Send every occurrence; the unique index absorbs what we hold.
    const playRows = prepared.map((p) => ({
      track_id: idByVideoId.get(p.video_id)!,
      played_on: p.played_on,
      precision: p.precision,
      played_bucket: p.played_bucket,
      occurrence: p.occurrence,
      source,
    }));

    // Per-bucket accounting — see NO_BUCKET / buildByBucket below for why this
    // is measured here rather than left to the caller.
    const NO_BUCKET = "(no bucket)";
    const submittedByBucket: Record<string, number> = {};
    for (const p of prepared) {
      const k = p.played_bucket ?? NO_BUCKET;
      submittedByBucket[k] = (submittedByBucket[k] ?? 0) + 1;
    }

    let inserted = 0;
    const insertedByBucket: Record<string, number> = {};
    for (const batch of chunk(playRows, 200)) {
      const { data, error } = await ctx.db
        .from("dj_plays")
        .upsert(batch, {
          onConflict: PLAYS_CONFLICT_TARGET,
          ignoreDuplicates: true,
        })
        // played_bucket comes back so inserts can be attributed to a bucket.
        // Counting them any other way would mean inferring which rows landed.
        .select("id, played_bucket");
      if (error) throw new Error(`record_dj_plays: play insert failed: ${error.message}`);
      for (const row of (data ?? []) as Array<{ played_bucket: string | null }>) {
        const k = row.played_bucket ?? NO_BUCKET;
        insertedByBucket[k] = (insertedByBucket[k] ?? 0) + 1;
      }
      inserted += (data ?? []).length;
    }

    // EVERY ingestible bucket is reported, INCLUDING ONES WITH submitted: 0.
    //
    // That zero is the whole point. A run on 2026-08-28 wrote 30 Today rows and
    // no Yesterday rows; the Yesterday rows appeared two hours later. Either the
    // first run never submitted its Yesterday bucket, or the plays were not in
    // the feed yet — and the stored row counts could not tell those apart. A run
    // that silently skips a bucket looks identical to a run where the bucket was
    // genuinely empty.
    //
    // Omitting absent buckets would reproduce exactly that ambiguity, so an
    // unsubmitted bucket has to appear as an explicit 0 rather than not appear.
    // And these counts come from the WRITE, not from the caller's memory of what
    // it sent, so a platform_runs stamp built from them cannot record something
    // the caller merely believes.
    const byBucket: Record<string, { submitted: number; inserted: number; already_held: number }> = {};
    for (const k of [...INGESTIBLE_BUCKETS, ...Object.keys(submittedByBucket)]) {
      if (byBucket[k]) continue;
      const sub = submittedByBucket[k] ?? 0;
      const ins = insertedByBucket[k] ?? 0;
      byBucket[k] = { submitted: sub, inserted: ins, already_held: sub - ins };
    }

    const dates = prepared.map((p) => p.played_on).sort();

    return {
      tracks_seen: videoIds.length,
      tracks_created: createdVideoIds.length,
      tracks_already_known: videoIds.length - createdVideoIds.length,
      canonical_links_made: linked.length,
      // Returned so grouping decisions can be reviewed — auto-linking is only
      // ever on EXACT normalised match_key equality (spec §4.1.3).
      canonical_links: linked.slice(0, 50),
      // Same video, two artist spellings = two vocabularies disagreeing about
      // one act. Empty is the normal case; ANY entry means a new alias-map
      // candidate. Phase 5's task prompt must read this into the run stamp —
      // a signal nobody looks at is the shape this project keeps finding.
      artist_disagreements: artistDisagreements,
      plays_submitted: playRows.length,
      plays_inserted: inserted,
      plays_already_held: playRows.length - inserted,
      // Per bucket, with unsubmitted buckets present as explicit zeros.
      by_bucket: byBucket,
      // Visible, not silent: the poll never stores album (spec §9).
      // POLICY counter, not a filter-quality signal — the poll discards EVERY
      // album unconditionally, so this always equals the number of submitted
      // plays that carried one. It reports how much was dropped; it can never
      // show whether the rule is working. Do not read it as a test result.
      albums_discarded: albumsDiscarded,
      covered_from: dates[0] ?? null,
      covered_to: dates[dates.length - 1] ?? null,
      source,
    };
  },
});

// ---------------------------------------------------------------------------
// create_platform_run — tier 1
// ---------------------------------------------------------------------------

export const createPlatformRunTool = defineTool({
  name: "create_platform_run",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const app = args.app as string | undefined;
    const job = args.job as string | undefined;
    const executor = args.executor as string | undefined;
    const status = args.status as string | undefined;

    if (!app) throw new Error("create_platform_run: `app` is required.");
    if (!job) throw new Error("create_platform_run: `job` is required.");
    if (!executor) throw new Error("create_platform_run: `executor` is required.");
    if (!status) throw new Error("create_platform_run: `status` is required.");

    // ONE clock for both timestamps.
    //
    // Previously started_at was omitted (so Postgres filled it with now()
    // AFTER the round trip) while finished_at defaulted to new Date() HERE,
    // before it. The result was finished_at ~278ms EARLIER than started_at —
    // a run that ended before it began, and a negative duration for anything
    // downstream that subtracts them (phase 5's gap logic, phase 9's sync
    // history page). Two clocks and two moments, neither of them wrong on its
    // own.
    //
    // Both defaults now come from the same instant in this function. The
    // trade-off is that rows written here use the Edge runtime's clock rather
    // than the database's; skew between them is small and this is
    // observability data, so internal coherence matters more than agreeing
    // with rows some other path wrote.
    //
    // For a REAL duration, pass started_at — the caller knows when it began.
    // Omitting it means "I don't know when this started", and equal
    // timestamps are the honest answer to that, not a negative interval.
    const now = new Date().toISOString();
    const startedAt = (args.started_at as string | undefined) ?? now;
    const finishedAt = (args.finished_at as string | undefined) ?? now;
    if (finishedAt < startedAt) {
      throw new Error(
        `create_platform_run: finished_at (${finishedAt}) is before started_at ` +
          `(${startedAt}). Nothing was written. A run cannot end before it begins — ` +
          `pass both timestamps from the same clock, or omit both.`,
      );
    }

    const row = {
      app,
      job,
      executor,
      status,
      host: (args.host as string | null | undefined) ?? null,
      started_at: startedAt,
      finished_at: finishedAt,
      covered_from: (args.covered_from as string | null | undefined) ?? null,
      covered_to: (args.covered_to as string | null | undefined) ?? null,
      details: (args.details as Record<string, unknown> | undefined) ?? {},
      error_message: (args.error_message as string | null | undefined) ?? null,
      notified_at: (args.notified_at as string | null | undefined) ?? null,
    };

    const { data, error } = await ctx.db
      .from("platform_runs")
      .insert(row)
      .select("id, app, job, executor, status, started_at, finished_at, covered_from, covered_to")
      .single();
    // CHECK constraints on app / executor / status do the validating — a typo
    // fails loudly here rather than creating a row no staleness query matches.
    if (error) throw new Error(`create_platform_run: ${error.message}`);
    return data;
  },
});

// ---------------------------------------------------------------------------
// get_platform_runs — tier 1 read
// ---------------------------------------------------------------------------

export const getPlatformRunsTool = defineTool({
  name: "get_platform_runs",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const limit = clampLimit(args.limit as number | undefined);

    // Every filter goes into the query before LIMIT — never filter a capped
    // result in memory.
    let q = ctx.db
      .from("platform_runs")
      .select(
        "id, app, job, executor, host, status, started_at, finished_at, covered_from, covered_to, details, error_message, notified_at",
      )
      .order("started_at", { ascending: false })
      .limit(limit);

    if (args.app) q = q.eq("app", args.app as string);
    if (args.job) q = q.eq("job", args.job as string);
    if (args.status) q = q.eq("status", args.status as string);
    if (args.unnotified_only === true) q = q.is("notified_at", null);

    const { data, error } = await q;
    if (error) throw new Error(`get_platform_runs: ${error.message}`);
    return data ?? [];
  },
});

// ---------------------------------------------------------------------------
// update_platform_run — tier 2
// ---------------------------------------------------------------------------

export const updatePlatformRunTool = defineTool({
  name: "update_platform_run",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const id = args.id as string | undefined;
    if (!id) throw new Error("update_platform_run: `id` is required.");

    const status = args.status as string | undefined;
    const notifiedAt = args.notified_at as string | undefined;
    if (status === undefined && notifiedAt === undefined) {
      throw new Error(
        "update_platform_run: nothing to change — pass `status`, `notified_at`, or both.",
      );
    }
    if (status !== undefined && !VALID_RUN_STATUS.includes(status)) {
      throw new Error(
        `update_platform_run: \`status\` must be one of ${VALID_RUN_STATUS.join(", ")}.`,
      );
    }

    // DELIBERATELY NARROW: status and notified_at only.
    //
    // platform_runs is a LOG, and a log you can rewrite is a log you cannot
    // trust — §11.4 is about records drifting from the thing they describe, and
    // a general "edit any run" tool would make that drift a feature. app, job,
    // executor, covered_from, covered_to, started_at and details are what a run
    // ASSERTS; they are not editable here and are absent from the input schema
    // rather than merely ignored.
    //
    // The one field that genuinely has to change after the fact is notified_at:
    // §6 sets it once a failure has actually been surfaced, which is necessarily
    // after the row exists. Doing that by insert-order instead — notify first,
    // then stamp with notified_at preset — fails exactly where it matters: if
    // the stamp then fails, a notification exists describing a run with no row.

    const { data: before, error: findErr } = await ctx.db
      .from("platform_runs")
      .select("id, app, job, status, notified_at")
      .eq("id", id)
      .maybeSingle();
    if (findErr) throw new Error(`update_platform_run: lookup failed: ${findErr.message}`);
    if (!before) {
      // A typo must not silently no-op. An UPDATE matching zero rows reports
      // success in PostgREST, which is the quietest possible wrong answer.
      throw new Error(
        `update_platform_run: no run with id ${id}. Nothing was changed. ` +
          `Find the id with get_platform_runs.`,
      );
    }

    const patch: Record<string, unknown> = {};
    if (status !== undefined) patch.status = status;
    if (notifiedAt !== undefined) patch.notified_at = notifiedAt;

    const { data, error } = await ctx.db
      .from("platform_runs")
      .update(patch)
      .eq("id", id)
      .select("id, app, job, executor, host, status, started_at, finished_at, covered_from, covered_to, details, error_message, notified_at")
      .single();
    if (error) throw new Error(`update_platform_run: ${error.message}`);

    const prev = before as Record<string, unknown>;
    return {
      run: data,
      // platform_runs is registered with audit OFF (high-volume observability),
      // so this response is the ONLY record that the change happened. Returning
      // before/after keeps the edit visible rather than silent.
      changed: {
        ...(status !== undefined ? { status: { from: prev.status, to: status } } : {}),
        ...(notifiedAt !== undefined
          ? { notified_at: { from: prev.notified_at, to: notifiedAt } }
          : {}),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// platform_schedules — what is SUPPOSED to run
// ---------------------------------------------------------------------------
//
// §4.5: cadence is stored, expected occurrences are NOT materialised.
// Materialising would need a job to create those rows, and that job could fail
// silently — which is the exact problem this table exists to detect. Staleness
// is derived at read time by comparing the due occurrence against platform_runs.

const VALID_APP = ["dj", "sam", "alfred", "workshop"];
const VALID_EXECUTOR = ["workshop", "claude", "alfred"];
const VALID_CADENCE = ["daily", "weekly"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export const createPlatformScheduleTool = defineTool({
  name: "create_platform_schedule",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const app = args.app as string | undefined;
    const job = args.job as string | undefined;
    const executor = args.executor as string | undefined;
    const cadence = args.cadence as string | undefined;

    if (!app || !VALID_APP.includes(app)) {
      throw new Error(`create_platform_schedule: \`app\` must be one of ${VALID_APP.join(", ")}.`);
    }
    if (!job) throw new Error("create_platform_schedule: `job` is required.");
    if (!executor || !VALID_EXECUTOR.includes(executor)) {
      throw new Error(
        `create_platform_schedule: \`executor\` must be one of ${VALID_EXECUTOR.join(", ")}.`,
      );
    }
    if (!cadence || !VALID_CADENCE.includes(cadence)) {
      throw new Error(
        `create_platform_schedule: \`cadence\` must be one of ${VALID_CADENCE.join(", ")}.`,
      );
    }

    const dow = args.day_of_week as number | undefined;
    if (cadence === "weekly") {
      if (dow === undefined || !Number.isInteger(dow) || dow < 0 || dow > 6) {
        throw new Error(
          "create_platform_schedule: cadence 'weekly' requires `day_of_week`, an integer " +
            "0-6 in the Postgres dow convention where 0 = SUNDAY. Note that is not the " +
            "ISO convention, where 1 = Monday.",
        );
      }
    } else if (dow !== undefined && dow !== null) {
      throw new Error(
        "create_platform_schedule: `day_of_week` is only meaningful for cadence 'weekly'.",
      );
    }

    const expectedBy = args.expected_by as string | undefined;
    if (expectedBy !== undefined && !TIME_RE.test(expectedBy)) {
      throw new Error(
        `create_platform_schedule: \`expected_by\` must be HH:MM or HH:MM:SS (got ${JSON.stringify(expectedBy)}).`,
      );
    }
    const grace = args.grace_hours as number | undefined;
    if (grace !== undefined && (!Number.isInteger(grace) || grace < 0 || grace > 32767)) {
      throw new Error("create_platform_schedule: `grace_hours` must be a non-negative integer.");
    }

    const row = {
      app,
      job,
      executor,
      cadence,
      day_of_week: cadence === "weekly" ? dow : null,
      ...(expectedBy !== undefined ? { expected_by: expectedBy } : {}),
      ...(grace !== undefined ? { grace_hours: grace } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled as boolean } : {}),
      notes: (args.notes as string | null | undefined) ?? null,
    };

    // UNIQUE (user_id, app, job): re-seeding the same job updates its definition
    // rather than erroring or duplicating. A schedule is a DEFINITION, not a log
    // — unlike platform_runs, which is append-only and must never be rewritten.
    const { data, error } = await ctx.db
      .from("platform_schedules")
      .upsert(row, { onConflict: "user_id,app,job" })
      .select("id, app, job, executor, cadence, day_of_week, expected_by, grace_hours, enabled, notes, created_at")
      .single();
    if (error) throw new Error(`create_platform_schedule: ${error.message}`);
    return data;
  },
});

export const getPlatformSchedulesTool = defineTool({
  name: "get_platform_schedules",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const limit = clampLimit(args.limit as number | undefined);
    let q = ctx.db
      .from("platform_schedules")
      .select(
        "id, app, job, executor, cadence, day_of_week, expected_by, grace_hours, enabled, notes, created_at",
        { count: "exact" },
      )
      .order("app", { ascending: true })
      .order("job", { ascending: true })
      .limit(limit);
    if (args.app) q = q.eq("app", args.app as string);
    if (args.job) q = q.eq("job", args.job as string);
    if (args.enabled !== undefined) q = q.eq("enabled", args.enabled as boolean);

    const { data, error, count } = await q;
    if (error) throw new Error(`get_platform_schedules: ${error.message}`);
    const rows = data ?? [];
    const total = count ?? rows.length;
    return {
      data: {
        schedules: rows,
        returned: rows.length,
        total,
        limit_applied: limit,
        reading: (
          "These are DEFINITIONS of what should run, not occurrences — expected runs are " +
          "derived at read time, never materialised (spec §4.5). `day_of_week` uses the " +
          "Postgres convention where 0 = SUNDAY, not ISO. `enabled: false` suspends " +
          "staleness checking without deleting the definition, so a paused job neither " +
          "alarms nor has to be reconstructed from memory later. " +
          "⚠️ Staleness is NOT computed here: it needs the newest matching run from " +
          "get_platform_runs AND a timezone to resolve `expected_by` against. Compare " +
          "against dj_plays too, not the run log alone — the log asserts coverage and " +
          "cannot be audited against the data (spec §11.4)."
        ),
      },
      meta: rows.length < total
        ? { truncated: true, total, limit_applied: limit, count: rows.length }
        : {},
    };
  },
});
