// ============================================================================
// supabase/functions/_shared/tools/sam-measure-stats.ts
//
// get_sam_measure_stats — tier 1. "Which measures do I miss, am I early or
// late, and what am I hitting instead."
//
// Reads sam_session_events, the per-beat telemetry. Every rule it applies is
// written down in docs/sam-scoring-definitions.md and on the table's own
// comments; the short form rides in the tool description (SAM_SCORING_RULES).
//
// THE TWO THINGS THIS TOOL IS CAREFUL ABOUT
//
// 1. NOT COUNTING ONE FUMBLE TWICE. Extras never enter attempts or hit rate,
//    and a wrong note is credited once per pass per pitch per measure.
//
// 2. SEPARATING CALIBRATION FROM ERROR. The mean offset is latency plus aim
//    plus genuine rushing, all added together, and a constant offset shifts
//    every note equally. The INTERVALS between struck notes are immune to it:
//    if the gaps are right, the playing is steady however large the offset.
//    So the mean is reported as calibration and the interval ratio as the
//    error. See `timing` in the result.
//
// Database access ONLY through ctx.db.
// ============================================================================

import { defineTool, clampLimit, envelope } from "../platform.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Most recent sessions read. Enough for months of work on one passage. */
export const MAX_SESSIONS = 30;
/** Hard ceiling on rows fetched; reported when it bites. */
export const ROW_CAP = 20000;
const PAGE = 1000;

/** A measure needs this many scored beats before it is ranked as weak. */
export const MIN_ATTEMPTS_FOR_RANKING = 8;
/** A wrong note is a pattern, not noise, at this many distinct passes. */
export const WRONG_NOTE_MIN_PASSES = 3;
/** A session needs this many usable gaps before its interval stats are shown. */
export const MIN_INTERVALS_PER_SESSION = 12;
/** A pass needs this many timed beats before drift is measured across it. */
export const MIN_BEATS_FOR_DRIFT = 9;

const PT_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
});
const ptDay = (iso: string) => PT_DATE.format(new Date(iso));

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fail(message: string): Error {
  return new Error(`get_sam_measure_stats: ${message}`);
}
function dbFail(what: string, error: { message?: string; code?: string }): Error {
  return fail(`${what} failed: ${error.message ?? "(no message)"}${error.code ? ` [${error.code}]` : ""}`);
}

function wholeNumber(name: string, v: unknown, min: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || (v as number) < min) {
    throw fail(`\`${name}\` must be a whole number of ${min} or more, got ${JSON.stringify(v)}.`);
  }
  return v as number;
}
function ptDate(name: string, v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !DATE_RE.test(v) ||
      new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw fail(`\`${name}\` must be a Pacific date "YYYY-MM-DD", got ${JSON.stringify(v)}.`);
  }
  return v;
}

// --- small statistics ---------------------------------------------------------

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// --- session eligibility ------------------------------------------------------

/**
 * A session counts when a keyboard was attached and something was played.
 * Sessions before 2026-09-16 carry neither marker and are excluded: their
 * accuracy is unmeasurable anyway.
 */
export function sessionIsUsable(s: Row): boolean {
  const summary = s.summary || {};
  if (summary.midi?.everConnected !== true) return false;
  const notes = summary.notesPlayed;
  if (typeof notes === "number" && notes <= 0) return false;
  return true;
}

/**
 * Milliseconds per quarter-note beat for a session, from the tempo it was
 * played at — bpm scaled by playback speed, the tempo actually heard.
 * Null when the tempo is unknown or moved during the sitting, which makes
 * every derived gap unreliable.
 */
export function msPerQuarter(s: Row): number | null {
  const settings = s.settings || {};
  const tempo = s.summary?.tempo;
  const bpm = typeof tempo?.end === "number" ? tempo.end : settings.bpm;
  if (typeof bpm !== "number" || !(bpm > 0)) return null;
  // A sitting that changed tempo cannot have one gap length.
  if (tempo && typeof tempo.min === "number" && typeof tempo.max === "number" && tempo.min !== tempo.max) {
    return null;
  }
  if (!tempo) return null; // pre-tempo sessions: not verifiable, so not used
  const speed = typeof settings.playbackSpeed === "number" && settings.playbackSpeed > 0
    ? settings.playbackSpeed : 100;
  return 60000 / (bpm * (speed / 100));
}

// --- the interval analysis ----------------------------------------------------

export interface Interval { ratio: number; expectedMs: number }

/**
 * Gaps between consecutively struck notes, against the gaps the score asks for.
 *
 * `rows` must be ONE session's rows in playing order. A pair is used only when
 * both beats were actually struck (a non-null offset), they are adjacent in the
 * sequence — so a miss or an unmatched beat between them breaks the chain — and
 * they sit in the same measure and the same loop iteration. Staying inside one
 * measure is what makes this safe: the gap comes from `beat`, a quarter-note
 * position within the measure, so no time signature, repeat or barline enters
 * the arithmetic. Tuplets are already fractional quarter positions.
 *
 * ratio = actual gap / expected gap. Below 1 means the notes came faster than
 * the score asks (genuine rushing); above 1, slower. A constant offset cancels:
 * actual = expected - (delta_now - delta_before).
 */
export function intervalsFor(rows: Row[], msPerBeat: number): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.timing_delta_ms == null || b.timing_delta_ms == null) continue;
    if (a.loop_iteration !== b.loop_iteration) continue;
    if (a.measure_number !== b.measure_number) continue;
    const quarters = Number(b.beat) - Number(a.beat);
    if (!(quarters > 0)) continue;
    const expectedMs = quarters * msPerBeat;
    if (!(expectedMs > 0)) continue;
    const actualMs = expectedMs - (Number(b.timing_delta_ms) - Number(a.timing_delta_ms));
    if (!(actualMs > 0)) continue; // notes out of order: not an interval
    out.push({ ratio: actualMs / expectedMs, expectedMs });
  }
  return out;
}

/**
 * Entries: the notes he comes IN on, as opposed to notes played mid-phrase.
 *
 * Live evidence says these are different skills and mixing them corrupts both
 * numbers: he is 120–225 ms late on entries and near zero mid-phrase, and
 * Pastorale's "worst" measures by hit rate are m37 (the last bar) and m1 —
 * exit and entry effects, not difficulty.
 *
 * A struck beat is an ENTRY when it is the first struck beat of a pass, or
 * when the beat struck before it sat a bar or more earlier. Measure distance
 * stands in for the rest: two or more measures back cannot be less than a full
 * bar of silence whatever the time signature, and needs no beats-per-bar. That
 * makes this deliberately CONSERVATIVE — a short rest inside a bar is not
 * called an entry — so mid-phrase figures may still carry a few soft entries,
 * but nothing mid-phrase is wrongly thrown out.
 *
 * Marks `rows` in place with `__entry`. Rows must be ONE session's, in playing
 * order. A measure range filter makes earlier measures invisible, so the first
 * beat inside the range reads as an entry: correct for a snippet, which is
 * what he practises, and stated in the tool description.
 */
export function markEntries(rows: Row[]): void {
  let prevLoop: unknown = Symbol("none");
  let prevMeasure = 0;
  for (const r of rows) {
    if (r.result === "extra") continue;
    const struck = r.timing_delta_ms != null;
    const loop = r.loop_iteration ?? 0;
    if (loop !== prevLoop) {          // first beat of a pass
      if (struck) { r.__entry = true; prevLoop = loop; prevMeasure = Number(r.measure_number); continue; }
      // Nothing struck yet in this pass: the entry is still ahead.
      prevLoop = loop; prevMeasure = 0;
      continue;
    }
    if (!struck) continue;            // a miss does not reset the phrase, it breaks it
    r.__entry = prevMeasure === 0 || Number(r.measure_number) - prevMeasure >= 2;
    prevMeasure = Number(r.measure_number);
  }
}

/** Mean, median and count for a set of offsets, or nulls when there are none. */
function offsetStats(xs: number[]) {
  return {
    mean_offset_ms: xs.length ? round(mean(xs)!) : null,
    median_offset_ms: xs.length ? round(median(xs)!) : null,
    timed_beats: xs.length,
  };
}

/**
 * Does the offset grow across a pass? A constant offset cannot: it is the same
 * at the end as at the start. Returned in milliseconds, last third minus first
 * third, so NEGATIVE means the playing fell further behind as the pass went on.
 */
export function driftFor(rows: Row[]): number | null {
  const timed = rows.filter((r) => r.timing_delta_ms != null).map((r) => Number(r.timing_delta_ms));
  if (timed.length < MIN_BEATS_FOR_DRIFT) return null;
  const third = Math.floor(timed.length / 3);
  const first = mean(timed.slice(0, third));
  const last = mean(timed.slice(-third));
  return first == null || last == null ? null : last - first;
}

// --- the tool -----------------------------------------------------------------

const EVENT_COLS =
  "session_id, measure_number, beat, result, played_notes, expected_notes, timing_delta_ms, loop_iteration";

/**
 * The pitches on this row that were NOT asked for at this beat.
 *
 * A failing chord records every key struck, the right ones included. Listing
 * those as "wrong notes" is how Pastorale m34 came to report 55, 62 and 60 —
 * three pitches that are IN that beat's chord — as its top mistakes. A pitch
 * is wrong only when the beat did not expect it; the overlap is the part he
 * got right, and it is silently dropped here.
 *
 * `extra` rows have no expected notes by definition (they attached to no
 * beat), so every pitch on one is wrong.
 */
export function wrongPitches(row: Row): number[] {
  const played = (row.played_notes ?? []) as number[];
  if (!played.length) return [];
  const expected = new Set<number>((row.expected_notes ?? []) as number[]);
  return expected.size ? played.filter((p) => !expected.has(p)) : played;
}

/**
 * A loop iteration he sat out: every beat of the measure a miss with nothing
 * struck at all. Misses are raised on elapsed time without consulting MIDI, so
 * a loop left running while he resets his hands records a full measure of them
 * and sinks the hit rate. AL m15–16 read 202 loop iterations against 23–29
 * real passes for exactly this reason.
 *
 * Deliberately strict: ONE key struck anywhere in the measure makes it an
 * attempt, however badly it went. This only removes cycles with no playing in
 * them at all, never bad playing.
 */
export function isSatOut(rows: Row[]): boolean {
  let scored = 0;
  for (const r of rows) {
    if (r.result === "extra") return false; // a stray key is still playing
    scored++;
    if (r.result !== "miss") return false;
    if (((r.played_notes ?? []) as number[]).length) return false;
  }
  return scored > 0;
}

export const getSamMeasureStatsTool = defineTool({
  name: "get_sam_measure_stats",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    // --- arguments -----------------------------------------------------------
    const songId = args.song_id;
    if (typeof songId !== "string" || !UUID_RE.test(songId)) {
      throw fail(`\`song_id\` must be a UUID, got ${JSON.stringify(songId)}.`);
    }
    let start = wholeNumber("start_measure", args.start_measure, 1);
    let end = wholeNumber("end_measure", args.end_measure, 1);
    if (start !== undefined && end !== undefined && start > end) {
      throw fail(`\`start_measure\` (${start}) is after \`end_measure\` (${end}).`);
    }
    const snippetId = args.snippet_id === undefined || args.snippet_id === null
      ? undefined
      : (typeof args.snippet_id === "string" && UUID_RE.test(args.snippet_id)
          ? args.snippet_id
          : (() => { throw fail("`snippet_id` must be a UUID."); })());
    const dateFrom = ptDate("date_from", args.date_from);
    const dateTo = ptDate("date_to", args.date_to);
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw fail(`\`date_from\` (${dateFrom}) is after \`date_to\` (${dateTo}).`);
    }
    const LIMIT = clampLimit(args.limit as number | undefined);

    // --- the song, and the snippet's own range -------------------------------
    const { data: song, error: songErr } = await ctx.db
      .from("sam_songs").select("id, title").eq("id", songId).maybeSingle();
    if (songErr) throw dbFail("song lookup", songErr);
    if (!song) throw fail(`song ${songId} not found.`);

    let snippet: Row | null = null;
    if (snippetId) {
      const { data, error } = await ctx.db
        .from("sam_snippets").select("id, song_id, title, start_measure, end_measure")
        .eq("id", snippetId).maybeSingle();
      if (error) throw dbFail("snippet lookup", error);
      if (!data) throw fail(`snippet ${snippetId} not found.`);
      if (data.song_id !== songId) throw fail(`snippet "${data.title}" belongs to a different song.`);
      snippet = data;
      // A snippet's loop appends rest measures whose numbers can collide with
      // real ones, so rows outside its range are excluded outright.
      start = Math.max(start ?? data.start_measure, data.start_measure);
      end = Math.min(end ?? data.end_measure, data.end_measure);
      if (start > end) throw fail(`the requested range lies outside snippet "${data.title}" (m.${data.start_measure}–${data.end_measure}).`);
    }

    // --- the sessions --------------------------------------------------------
    let sq = ctx.db
      .from("sam_sessions")
      .select("id, snippet_id, started_at, ended_at, settings, summary")
      .eq("song_id", songId)
      .not("ended_at", "is", null)
      .order("started_at", { ascending: false });
    if (snippetId) sq = sq.eq("snippet_id", snippetId);
    // Coarse UTC prefilter, deliberately a day wide on each side: a Pacific day
    // runs from 07:00 or 08:00Z to the same hour the NEXT day, so a filter cut
    // to the same calendar date in UTC would drop an evening session. The exact
    // Pacific day is decided in JS below.
    if (dateFrom) sq = sq.gte("started_at", `${addDays(dateFrom, -1)}T00:00:00Z`);
    if (dateTo) sq = sq.lte("started_at", `${addDays(dateTo, 1)}T23:59:59.999Z`);
    const { data: sessionRows, error: sessErr } = await sq.limit(200);
    if (sessErr) throw dbFail("sessions lookup", sessErr);

    const excluded = { no_midi_or_no_notes: 0, outside_dates: 0 };
    const eligible: Row[] = [];
    for (const s of (sessionRows ?? []) as Row[]) {
      const day = ptDay(s.started_at);
      if ((dateFrom && day < dateFrom) || (dateTo && day > dateTo)) { excluded.outside_dates++; continue; }
      if (!sessionIsUsable(s)) { excluded.no_midi_or_no_notes++; continue; }
      eligible.push({ ...s, pt_day: day });
    }
    const sessions = eligible.slice(0, MAX_SESSIONS);
    const sessionsTruncated = eligible.length > sessions.length;

    if (sessions.length === 0) {
      return {
        song: { id: song.id, title: song.title },
        snippet: snippet ? { id: snippet.id, title: snippet.title, start_measure: snippet.start_measure, end_measure: snippet.end_measure } : null,
        range: { start_measure: start ?? null, end_measure: end ?? null, date_from: dateFrom ?? null, date_to: dateTo ?? null },
        sessions: { used: 0, excluded, note: "No session matched with a keyboard attached and notes played, so there is nothing to measure." },
        measures: [],
        rollup: null,
        timing: null,
      };
    }

    // --- the rows ------------------------------------------------------------
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const rows: Row[] = [];
    let rowsTruncated = false;
    for (let offset = 0; offset < ROW_CAP; offset += PAGE) {
      let q = ctx.db
        .from("sam_session_events")
        .select(EVENT_COLS)
        .eq("song_id", songId)
        .in("session_id", [...byId.keys()])
        .order("session_id", { ascending: true })
        .order("loop_iteration", { ascending: true })
        .order("measure_number", { ascending: true })
        .order("beat", { ascending: true });
      if (start !== undefined) q = q.gte("measure_number", start);
      if (end !== undefined) q = q.lte("measure_number", end);
      const { data, error } = await q.range(offset, offset + PAGE - 1);
      if (error) throw dbFail("events lookup", error);
      const page = (data ?? []) as Row[];
      rows.push(...page);
      if (page.length < PAGE) break;
      if (offset + PAGE >= ROW_CAP) { rowsTruncated = true; break; }
    }

    // How much a measure range threw away. The range is applied in SQL, so the
    // discarded rows never arrive and have to be counted separately — without
    // a number here, a snippet's figures look like the whole song's. Null when
    // the row cap bit, because then the two counts are not comparable.
    let rowsOutsideRange: number | null = null;
    if ((start !== undefined || end !== undefined) && !rowsTruncated) {
      const { count, error } = await ctx.db
        .from("sam_session_events")
        .select("session_id", { count: "exact", head: true })
        .eq("song_id", songId)
        .in("session_id", [...byId.keys()]);
      if (error) throw dbFail("row count", error);
      if (typeof count === "number") rowsOutsideRange = Math.max(0, count - rows.length);
    }

    // Entries are decided per session, over that session's rows in playing
    // order, and stamped on the rows before anything is counted.
    const rowsBySession = new Map<string, Row[]>();
    for (const r of rows) {
      const list = rowsBySession.get(r.session_id);
      if (list) list.push(r); else rowsBySession.set(r.session_id, [r]);
    }
    for (const sRows of rowsBySession.values()) markEntries(sRows);

    // --- per measure ---------------------------------------------------------
    // Rows grouped by measure AND pass, so a loop cycle he sat out can be
    // recognised as a whole before any of it is counted.
    const byMeasurePass = new Map<number, Map<string, Row[]>>();
    for (const r of rows) {
      if (!byId.has(r.session_id)) continue;
      const pass = `${r.session_id}:${r.loop_iteration ?? 0}`;
      let m = byMeasurePass.get(r.measure_number);
      if (!m) { m = new Map(); byMeasurePass.set(r.measure_number, m); }
      const list = m.get(pass);
      if (list) list.push(r); else m.set(pass, [r]);
    }

    interface Acc {
      measure: number;
      hit: number; miss: number; partial: number; extra: number;
      // The same three again, over the passes he actually played in.
      attemptedHit: number; attemptedMiss: number;
      satOut: number;
      timings: number[];
      entryTimings: number[]; midTimings: number[];
      sessions: Set<string>; days: Set<string>; passes: Set<string>;
      wrong: Map<number, Set<string>>;   // pitch -> distinct passes it appeared in
    }
    const acc = new Map<number, Acc>();

    for (const [measureNumber, passes] of byMeasurePass) {
      const a: Acc = {
        measure: measureNumber, hit: 0, miss: 0, partial: 0, extra: 0,
        attemptedHit: 0, attemptedMiss: 0, satOut: 0, timings: [],
        entryTimings: [], midTimings: [],
        sessions: new Set(), days: new Set(), passes: new Set(), wrong: new Map(),
      };
      acc.set(measureNumber, a);

      for (const [pass, passRows] of passes) {
        const satOut = isSatOut(passRows);
        if (satOut) a.satOut++;

        for (const r of passRows) {
          const s = byId.get(r.session_id)!;
          if (r.result === "extra") {
            a.extra++;
          } else {
            a[r.result as "hit" | "miss" | "partial"]++;
            // The attempted rate sees only cycles he took part in.
            if (!satOut && r.result === "hit") a.attemptedHit++;
            if (!satOut && r.result === "miss") a.attemptedMiss++;
            a.sessions.add(r.session_id);
            a.days.add(s.pt_day);
            a.passes.add(pass);
            if (r.timing_delta_ms != null) {
              const t = Number(r.timing_delta_ms);
              a.timings.push(t);
              (r.__entry ? a.entryTimings : a.midTimings).push(t);
            }
          }
          // Wrong notes: an extra's stray key, or the keys struck at a missed
          // beat that the beat did not ask for. Counted once per pitch per
          // pass, so hammering one wrong key is one.
          if (r.result === "extra" || r.result === "miss") {
            for (const pitch of wrongPitches(r)) {
              if (!a.wrong.has(pitch)) a.wrong.set(pitch, new Set());
              a.wrong.get(pitch)!.add(pass);
            }
          }
        }
      }
    }

    // Printed numbers, for the measures we actually have.
    const numbers = [...acc.keys()];
    const printed = new Map<number, string | null>();
    if (numbers.length) {
      const { data, error } = await ctx.db
        .from("sam_song_measures").select("number, source_measure")
        .eq("song_id", songId).in("number", numbers);
      if (error) throw dbFail("measures lookup", error);
      for (const m of (data ?? []) as Row[]) printed.set(m.number, m.source_measure ?? null);
    }

    const measures = [...acc.values()]
      .sort((a, b) => a.measure - b.measure)
      .map((a) => {
        const scored = a.hit + a.miss;
        const attemptedScored = a.attemptedHit + a.attemptedMiss;
        const wrongNotes = [...a.wrong.entries()]
          .map(([pitch, passes]) => ({ midi: pitch, passes: passes.size }))
          .filter((w) => w.passes >= WRONG_NOTE_MIN_PASSES)
          .sort((x, y) => y.passes - x.passes);
        return {
          measure: a.measure,
          printed_measure: printed.get(a.measure) ?? null,
          attempts: a.hit + a.miss + a.partial,
          // Two rates, deliberately named apart. hit_rate_all counts every
          // loop cycle, including ones he sat out while the loop ran on;
          // hit_rate_attempted counts only cycles he played in. Both are true;
          // the second is the one that answers "which measures do I miss".
          hit_rate_all: scored ? Math.round((a.hit * 100) / scored) : null,
          hit_rate_attempted: attemptedScored ? Math.round((a.attemptedHit * 100) / attemptedScored) : null,
          sat_out_iterations: a.satOut,
          attempted_iterations: a.passes.size - a.satOut,
          attempted_scored_beats: attemptedScored,
          results: { hit: a.hit, miss: a.miss, partial: a.partial, extra: a.extra },
          timing: {
            ...offsetStats(a.timings),
            // Entries — coming in after a rest or a restart — run far later
            // than notes inside a phrase. Kept apart so neither number is
            // spoiled by the other.
            entry: offsetStats(a.entryTimings),
            mid_phrase: offsetStats(a.midTimings),
          },
          sessions: a.sessions.size,
          days: a.days.size,
          loop_iterations: a.passes.size,
          recurring_wrong_notes: wrongNotes,
        };
      })
      .slice(0, LIMIT);

    // --- timing: calibration vs error ---------------------------------------
    const perSession: Row[] = [];
    const skipped = { tempo_unknown_or_varied: 0, too_few_intervals: 0 };
    const allEntry: number[] = [];
    const allMid: number[] = [];
    for (const s of sessions) {
      const sRows = (rowsBySession.get(s.id) ?? []).filter((r) => r.result !== "extra");
      if (!sRows.length) continue;
      const struck = sRows.filter((r) => r.timing_delta_ms != null);
      const timings = struck.map((r) => Number(r.timing_delta_ms));
      const entryT = struck.filter((r) => r.__entry).map((r) => Number(r.timing_delta_ms));
      const midT = struck.filter((r) => !r.__entry).map((r) => Number(r.timing_delta_ms));
      allEntry.push(...entryT);
      allMid.push(...midT);
      const msBeat = msPerQuarter(s);
      const intervals = msBeat ? intervalsFor(sRows, msBeat) : [];
      const ratios = intervals.map((i) => i.ratio);
      const enough = ratios.length >= MIN_INTERVALS_PER_SESSION;
      if (!msBeat) skipped.tempo_unknown_or_varied++;
      else if (!enough) skipped.too_few_intervals++;

      const passes = [...new Set(sRows.map((r) => `${r.loop_iteration ?? 0}`))];
      const drifts = passes
        .map((p) => driftFor(sRows.filter((r) => `${r.loop_iteration ?? 0}` === p)))
        .filter((d): d is number => d != null);

      perSession.push({
        session_id: s.id,
        day: s.pt_day,
        started_at: s.started_at,
        window_ms: s.settings?.windowMs ?? null,
        bpm: s.summary?.tempo?.end ?? s.settings?.bpm ?? null,
        playback_speed: s.settings?.playbackSpeed ?? null,
        timed_beats: timings.length,
        mean_offset_ms: timings.length ? round(mean(timings)!) : null,
        entry_mean_offset_ms: entryT.length ? round(mean(entryT)!) : null,
        entry_beats: entryT.length,
        mid_phrase_mean_offset_ms: midT.length ? round(mean(midT)!) : null,
        mid_phrase_beats: midT.length,
        interval_ratio_median: enough ? round(median(ratios)!, 3) : null,
        interval_ratio_spread: enough ? round(stdev(ratios) ?? 0, 3) : null,
        usable_intervals: ratios.length,
        drift_ms_per_pass: drifts.length ? round(median(drifts)!) : null,
        tempo_steady: msBeat != null,
      });
    }

    const ratioMedians = perSession.map((p) => p.interval_ratio_median).filter((x): x is number => x != null);
    const offsets = perSession.map((p) => p.mean_offset_ms).filter((x): x is number => x != null);
    const driftAll = perSession.map((p) => p.drift_ms_per_pass).filter((x): x is number => x != null);
    const windows = [...new Set(sessions.map((s) => s.settings?.windowMs ?? null))];

    // Weakness is ranked on the ATTEMPTED rate: a measure is not hard because
    // he stepped away while the loop ran on.
    const rankable = measures.filter(
      (m) => m.attempted_scored_beats >= MIN_ATTEMPTS_FOR_RANKING && m.hit_rate_attempted != null
    );
    // Early/late are ranked on MID-PHRASE offsets only. Ranked on all beats,
    // the list just finds the bars he enters on — the first bar of a snippet,
    // the bar after a rest — which says nothing about how hard they are.
    const timed = measures.filter((m) => m.timing.mid_phrase.timed_beats >= MIN_ATTEMPTS_FOR_RANKING);
    // A measure belongs in the early list only when it was genuinely EARLY.
    // Sorting every measure by offset and taking the top three makes the least
    // late one look early when the whole sitting dragged.
    const early = timed.filter((m) => (m.timing.mid_phrase.mean_offset_ms ?? 0) > 0);
    // deno-lint-ignore no-explicit-any
    const lateEarlyRow = (m: any) => ({
      measure: m.measure,
      mean_offset_ms: m.timing.mid_phrase.mean_offset_ms,
      timed_beats: m.timing.mid_phrase.timed_beats,
      // Shown alongside so the gap between the two is visible at a glance.
      entry_mean_offset_ms: m.timing.entry.mean_offset_ms,
      entry_beats: m.timing.entry.timed_beats,
    });

    return {
      song: { id: song.id, title: song.title },
      snippet: snippet
        ? { id: snippet.id, title: snippet.title, start_measure: snippet.start_measure, end_measure: snippet.end_measure }
        : null,
      range: {
        start_measure: start ?? null, end_measure: end ?? null,
        date_from: dateFrom ?? null, date_to: dateTo ?? null,
        measures_returned: measures.length,
        limit_applied: LIMIT,
        rows_read: rows.length,
        rows_outside_range: rowsOutsideRange,
        ...(rowsOutsideRange != null && rowsOutsideRange > 0
          ? { rows_outside_range_note: `${rowsOutsideRange} rows in these sessions fall outside m.${start ?? 1}–${end ?? "end"} and were excluded${snippet ? ` by snippet "${snippet.title}"` : ""}. A snippet's loop also appends rest measures whose numbers can collide with real ones, which is why the range is applied rather than trusted.` }
          : {}),
        rows_truncated: rowsTruncated,
        ...(rowsTruncated ? { rows_note: `Only the first ${ROW_CAP} rows were read; narrow the measure range or the dates.` } : {}),
      },
      sessions: {
        used: sessions.length,
        truncated: sessionsTruncated,
        ...(sessionsTruncated ? { note: `The ${MAX_SESSIONS} most recent eligible sessions were used, of ${eligible.length}.` } : {}),
        excluded,
        days: [...new Set(sessions.map((s) => s.pt_day))].length,
        window_ms_values: windows,
        windows_differ: windows.length > 1,
        ...(windows.length > 1
          ? { window_warning: "⚠️ These sessions were scored at DIFFERENT matching windows (settings.windowMs), and accuracy is not comparable across them: a tighter window lowers the hit rate on identical playing. Compare only sessions sharing a window, or report the windows alongside the figures." }
          : {}),
      },
      measures,
      rollup: {
        weakest_measures: [...rankable]
          .sort((a, b) => a.hit_rate_attempted! - b.hit_rate_attempted!)
          .slice(0, 5)
          .map((m) => ({
            measure: m.measure, printed_measure: m.printed_measure,
            hit_rate_attempted: m.hit_rate_attempted, hit_rate_all: m.hit_rate_all,
            attempted_scored_beats: m.attempted_scored_beats, sat_out_iterations: m.sat_out_iterations,
          })),
        most_late: [...timed]
          .sort((a, b) => a.timing.mid_phrase.mean_offset_ms! - b.timing.mid_phrase.mean_offset_ms!)
          .slice(0, 3)
          .map(lateEarlyRow),
        most_early: early
          .sort((a, b) => b.timing.mid_phrase.mean_offset_ms! - a.timing.mid_phrase.mean_offset_ms!)
          .slice(0, 3)
          .map(lateEarlyRow),
        ...(early.length === 0 && timed.length > 0
          ? { most_early_note: "No measure was early: every measure with enough mid-phrase beats has a negative mean offset, so this list is EMPTY rather than showing the least late one. Remember that a constant negative offset is calibration (latency and aim) as much as dragging — read interval_ratio before concluding he plays late." }
          : {}),
        timing_ranking_note: `Early and late are ranked on MID-PHRASE offsets only, over measures with at least ${MIN_ATTEMPTS_FOR_RANKING} such beats. Ranked on all beats these lists just find the bars he ENTERS on, which is a different skill from playing them.`,
        most_wrong_notes: measures
          .filter((m) => m.recurring_wrong_notes.length > 0)
          .sort((a, b) => b.recurring_wrong_notes[0].passes - a.recurring_wrong_notes[0].passes)
          .slice(0, 5)
          .map((m) => ({ measure: m.measure, printed_measure: m.printed_measure, wrong_notes: m.recurring_wrong_notes })),
        ranking_note: `Ranked over measures with at least ${MIN_ATTEMPTS_FOR_RANKING} scored beats. A wrong note is listed when it recurs in at least ${WRONG_NOTE_MIN_PASSES} distinct passes, counted once per pitch per pass.`,
      },
      timing: {
        how_to_read:
          "mean_offset_ms is CALIBRATION PLUS ERROR: MIDI and audio latency, where the eye aims against the " +
          "scrolling line, and genuine rushing, all added together. A constant offset shifts every note equally, " +
          "so on its own a large mean says nothing about playing. interval_ratio and drift isolate the error: " +
          "they compare the gaps BETWEEN struck notes, which a constant offset cancels out of.",
        sign: "Offsets: positive = early (rushing), negative = late (dragging).",
        interval_ratio_meaning:
          "actual gap / gap the score asks for. Below 1 = genuinely playing faster than the tempo; above 1 = " +
          "slower; 1.00 = in time whatever the mean offset says. Spread is the standard deviation of those " +
          "ratios: steadiness, where lower is more even.",
        drift_meaning:
          "Offset over one pass, last third minus first third, in ms. NEGATIVE = fell further behind as the pass " +
          "went on. A constant offset cannot produce drift, so this is error, not calibration.",
        thresholds: `A session's interval figures need at least ${MIN_INTERVALS_PER_SESSION} usable gaps; drift needs ${MIN_BEATS_FOR_DRIFT} timed beats in a pass. Gaps are used only between beats that were both struck, adjacent in the sequence (so a miss breaks the chain) and inside one measure and one loop.`,
        overall: {
          mean_offset_ms: offsets.length ? round(mean(offsets)!) : null,
          interval_ratio_median: ratioMedians.length ? round(median(ratioMedians)!, 3) : null,
          drift_ms_per_pass: driftAll.length ? round(median(driftAll)!) : null,
          sessions_with_intervals: ratioMedians.length,
        },
        entries: {
          entry: offsetStats(allEntry),
          mid_phrase: offsetStats(allMid),
          difference_ms: allEntry.length && allMid.length
            ? round(mean(allEntry)! - mean(allMid)!)
            : null,
          what_counts_as_an_entry:
            "The first struck beat of a pass, or one whose previous struck beat sat two or more measures " +
            "back — a rest of at least a full bar, whatever the time signature. Deliberately conservative: a " +
            "short rest inside a bar is not called an entry, so mid_phrase may carry a few soft entries, but " +
            "nothing mid-phrase is wrongly excluded. A measure-range or snippet filter hides earlier bars, so " +
            "the first beat inside the range counts as an entry — correct for a snippet, which is what he " +
            "actually practises.",
          why_it_matters:
            "Coming in after a rest or a restart is a different skill from playing inside a phrase, and the " +
            "two run at very different offsets — mixing them corrupts both numbers. A measure that looks weak " +
            "or late may simply be one he enters on, which is why most_late and most_early rank on mid-phrase " +
            "beats alone.",
        },
        skipped,
        per_session: perSession,
      },
    };
  },
});
