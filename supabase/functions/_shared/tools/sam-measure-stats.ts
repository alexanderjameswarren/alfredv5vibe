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

const EVENT_COLS = "session_id, measure_number, beat, result, played_notes, timing_delta_ms, loop_iteration";

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

    // --- per measure ---------------------------------------------------------
    interface Acc {
      measure: number;
      hit: number; miss: number; partial: number; extra: number;
      timings: number[];
      sessions: Set<string>; days: Set<string>; passes: Set<string>;
      wrong: Map<number, Set<string>>;   // pitch -> distinct passes it appeared in
    }
    const acc = new Map<number, Acc>();
    const get = (m: number): Acc => {
      let a = acc.get(m);
      if (!a) {
        a = { measure: m, hit: 0, miss: 0, partial: 0, extra: 0, timings: [],
              sessions: new Set(), days: new Set(), passes: new Set(), wrong: new Map() };
        acc.set(m, a);
      }
      return a;
    };

    for (const r of rows) {
      const s = byId.get(r.session_id);
      if (!s) continue;
      const a = get(r.measure_number);
      const pass = `${r.session_id}:${r.loop_iteration ?? 0}`;
      if (r.result === "extra") {
        a.extra++;
      } else {
        a[r.result as "hit" | "miss" | "partial"]++;
        a.sessions.add(r.session_id);
        a.days.add(s.pt_day);
        a.passes.add(pass);
        if (r.timing_delta_ms != null) a.timings.push(Number(r.timing_delta_ms));
      }
      // Wrong notes: an extra's stray key, or the keys struck at a missed beat.
      // Counted once per pitch per pass, so hammering one wrong key is one.
      if (r.result === "extra" || r.result === "miss") {
        for (const pitch of (r.played_notes ?? []) as number[]) {
          if (!a.wrong.has(pitch)) a.wrong.set(pitch, new Set());
          a.wrong.get(pitch)!.add(pass);
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
        const wrongNotes = [...a.wrong.entries()]
          .map(([pitch, passes]) => ({ midi: pitch, passes: passes.size }))
          .filter((w) => w.passes >= WRONG_NOTE_MIN_PASSES)
          .sort((x, y) => y.passes - x.passes);
        return {
          measure: a.measure,
          printed_measure: printed.get(a.measure) ?? null,
          attempts: a.hit + a.miss + a.partial,
          hit_rate_percent: scored ? Math.round((a.hit * 100) / scored) : null,
          results: { hit: a.hit, miss: a.miss, partial: a.partial, extra: a.extra },
          timing: {
            mean_offset_ms: a.timings.length ? round(mean(a.timings)!) : null,
            median_offset_ms: a.timings.length ? round(median(a.timings)!) : null,
            timed_beats: a.timings.length,
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
    for (const s of sessions) {
      const sRows = rows.filter((r) => r.session_id === s.id && r.result !== "extra");
      if (!sRows.length) continue;
      const timings = sRows.filter((r) => r.timing_delta_ms != null).map((r) => Number(r.timing_delta_ms));
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

    const rankable = measures.filter((m) => m.attempts >= MIN_ATTEMPTS_FOR_RANKING && m.hit_rate_percent != null);
    const timed = measures.filter((m) => m.timing.timed_beats >= MIN_ATTEMPTS_FOR_RANKING);

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
          .sort((a, b) => a.hit_rate_percent! - b.hit_rate_percent!)
          .slice(0, 5)
          .map((m) => ({ measure: m.measure, printed_measure: m.printed_measure, hit_rate_percent: m.hit_rate_percent, attempts: m.attempts })),
        most_late: [...timed]
          .sort((a, b) => a.timing.mean_offset_ms! - b.timing.mean_offset_ms!)
          .slice(0, 3)
          .map((m) => ({ measure: m.measure, mean_offset_ms: m.timing.mean_offset_ms, timed_beats: m.timing.timed_beats })),
        most_early: [...timed]
          .sort((a, b) => b.timing.mean_offset_ms! - a.timing.mean_offset_ms!)
          .slice(0, 3)
          .map((m) => ({ measure: m.measure, mean_offset_ms: m.timing.mean_offset_ms, timed_beats: m.timing.timed_beats })),
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
        skipped,
        per_session: perSession,
      },
    };
  },
});
