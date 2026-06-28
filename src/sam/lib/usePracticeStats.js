import { useState, useEffect, useMemo } from "react";
import { supabase } from "../../supabaseClient";
import { ptDateKey, ptDayName } from "./practiceTimeFormat";

// Shared practice-stats hook.
//
// One Supabase fetch serves both `PracticeWeekSnapshot` (main page) and
// `PracticeTimeIndicator` (StatsBar). Both consumers call this hook with the
// same `refetchSignal` so a session-end bump refreshes everything from one
// network round-trip.
//
// Args:
//   currentSongId  — used only to derive `perSongTotalSeconds`. Changing it
//                    does NOT refetch; per-song total is filtered in memory.
//   refetchSignal  — any value; when it changes, the hook refetches. Wired
//                    in M5 to a counter bumped by `usePracticeSession.endSession`.
//
// Returns:
//   sevenDayTotals       — 7 items, index 0 = today, ordered most-recent-first.
//                          Each: { dateISO, dayLabel, minutes }.
//   todayMinutes         — convenience alias for sevenDayTotals[0].minutes.
//   perSongTotalSeconds  — raw seconds for currentSongId across all time.
//                          Display formatting happens in the consumer.
//   loading              — true during the initial fetch and any refetch.

/**
 * Subtract `daysBack` calendar days from a YYYY-MM-DD key, returning a new
 * YYYY-MM-DD key. Uses UTC date arithmetic on the calendar components, so
 * DST transitions don't shift the result.
 */
function dateKeyMinusDays(key, daysBack) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - daysBack));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Day name for a YYYY-MM-DD key, asking `ptDayName` about UTC noon on that
 * calendar date. Noon UTC is mid-morning PT (PDT or PST), comfortably away
 * from the midnight boundary in either direction.
 */
function dayNameFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return ptDayName(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
}

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

  // Bucket by PT day key → seconds. NULL-ended is filtered at SQL; we still
  // guard against zero/negative-duration rows defensively.
  const buckets = useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      const startMs = new Date(s.started_at).getTime();
      const endMs = new Date(s.ended_at).getTime();
      if (!(endMs > startMs)) continue;
      const key = ptDateKey(s.started_at);
      map.set(key, (map.get(key) || 0) + (endMs - startMs) / 1000);
    }
    return map;
  }, [sessions]);

  const sevenDayTotals = useMemo(() => {
    const todayKey = ptDateKey(new Date());
    const out = [];
    for (let i = 0; i < 7; i++) {
      const key = dateKeyMinusDays(todayKey, i);
      const secs = buckets.get(key) || 0;
      out.push({
        dateISO: key,
        dayLabel: i === 0 ? "Today" : dayNameFromKey(key),
        minutes: Math.round(secs / 60),
      });
    }
    return out;
  }, [buckets]);

  const todayMinutes = sevenDayTotals[0]?.minutes ?? 0;

  const perSongTotalSeconds = useMemo(() => {
    if (!currentSongId) return 0;
    let total = 0;
    for (const s of sessions) {
      if (s.song_id !== currentSongId) continue;
      const startMs = new Date(s.started_at).getTime();
      const endMs = new Date(s.ended_at).getTime();
      if (endMs > startMs) total += (endMs - startMs) / 1000;
    }
    return total;
  }, [sessions, currentSongId]);

  return { sevenDayTotals, todayMinutes, perSongTotalSeconds, loading };
}
