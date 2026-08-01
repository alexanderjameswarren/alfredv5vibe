import { useState, useEffect, useMemo } from "react";
import { supabase } from "../../supabaseClient";
import {
  ptDateKey,
  dateKeyMinusDays,
  ptDayNameFromKey,
} from "./practiceTimeFormat";

// Shared practice-stats hook.
//
// One Supabase fetch serves every consumer that needs practice numbers on the
// landing page or in the StatsBar. All derived aggregates share a single pass
// over the fetched `sessions` list — see the `derived` useMemo below.
//
// Args:
//   currentSongId  — used only to derive `perSongTotalSeconds`. Changing it
//                    does NOT refetch; per-song total is looked up in the
//                    already-computed perSongTotals map.
//   refetchSignal  — any value; when it changes, the hook refetches. Wired
//                    to a counter bumped by `usePracticeSession.endSession`
//                    so a session end refreshes everything.
//
// Returns:
//   sevenDayTotals       — 7 items, index 0 = today, ordered most-recent-first.
//                          Each: { dateISO, dayLabel, minutes }.
//   todayMinutes         — convenience alias for sevenDayTotals[0].minutes.
//   perSongTotalSeconds  — raw seconds for currentSongId across all time.
//                          Display formatting happens in the consumer.
//   perSongTotals        — Map<song_id, seconds> across every song with at
//                          least one ended session. Landing-page rows do
//                          O(1) lookups off this.
//   lastPracticedBySong  — Map<song_id, ISO started_at> — the most recent
//                          practice start per song. Effectively free because
//                          `sessions` arrives ordered started_at desc, so
//                          the first occurrence of each song_id IS its most
//                          recent practice.
//   loading              — true during the initial fetch and any refetch.
//
// Duration is derived from `ended_at - started_at`, not from the
// `sam_sessions.duration_seconds` column. That column exists in the schema
// but is never populated by usePracticeSession.endSession (which writes
// only ended_at/summary/events), so every row has duration_seconds NULL.
// Timestamp arithmetic is the only source of truth today. See progress-
// sam-landing-redesign.md Notes for the full write-path trace.

export default function usePracticeStats({ currentSongId, refetchSignal = 0 } = {}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from("sam_sessions")
      .select("song_id, started_at, ended_at")
      .not("ended_at", "is", null)
      .order("started_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[Sam] usePracticeStats fetch failed:", error);
          setSessions([]);
        } else {
          setSessions(data || []);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refetchSignal]);

  // Single pass over sessions. Builds three parallel aggregates:
  //   buckets              — PT-day-key → seconds (drives sevenDayTotals)
  //   perSongTotals        — song_id → total seconds
  //   lastPracticedBySong  — song_id → most-recent started_at (first
  //                          occurrence wins since input is started_at desc)
  //
  // NULL-ended is filtered at SQL; we still guard against zero/negative-
  // duration rows defensively so a corrupt row can't crash the pass or
  // produce negative totals.
  const derived = useMemo(() => {
    const buckets = new Map();
    const perSongTotals = new Map();
    const lastPracticedBySong = new Map();
    for (const s of sessions) {
      const startMs = new Date(s.started_at).getTime();
      const endMs = new Date(s.ended_at).getTime();
      if (!(endMs > startMs)) continue;
      const secs = (endMs - startMs) / 1000;

      const dayKey = ptDateKey(s.started_at);
      buckets.set(dayKey, (buckets.get(dayKey) || 0) + secs);

      perSongTotals.set(
        s.song_id,
        (perSongTotals.get(s.song_id) || 0) + secs
      );

      if (!lastPracticedBySong.has(s.song_id)) {
        lastPracticedBySong.set(s.song_id, s.started_at);
      }
    }
    return { buckets, perSongTotals, lastPracticedBySong };
  }, [sessions]);

  const sevenDayTotals = useMemo(() => {
    const todayKey = ptDateKey(new Date());
    const out = [];
    for (let i = 0; i < 7; i++) {
      const key = dateKeyMinusDays(todayKey, i);
      const secs = derived.buckets.get(key) || 0;
      out.push({
        dateISO: key,
        dayLabel: i === 0 ? "Today" : ptDayNameFromKey(key),
        minutes: Math.round(secs / 60),
      });
    }
    return out;
  }, [derived]);

  const todayMinutes = sevenDayTotals[0]?.minutes ?? 0;

  // Kept as a first-class return value for the existing StatsBar consumers;
  // now a Map lookup rather than a re-scan of sessions.
  const perSongTotalSeconds = currentSongId
    ? derived.perSongTotals.get(currentSongId) ?? 0
    : 0;

  return {
    sevenDayTotals,
    todayMinutes,
    perSongTotalSeconds,
    perSongTotals: derived.perSongTotals,
    lastPracticedBySong: derived.lastPracticedBySong,
    loading,
  };
}
