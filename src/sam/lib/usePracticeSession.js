import { useState, useRef, useCallback } from "react";
import { supabase } from "../../supabaseClient";

export default function usePracticeSession() {
  const [stats, setStats] = useState({
    hits: 0,
    misses: 0,
    partials: 0,
    totalBeats: 0,
    accuracyPercent: 0,
    avgTimingDeltaMs: 0,
  });

  const sessionIdRef = useRef(null);
  const eventsRef = useRef([]);
  const timingDeltasRef = useRef([]);
  const countersRef = useRef({ hits: 0, misses: 0, partials: 0, totalBeats: 0 });
  const loopCountRef = useRef(0);

  const startSession = useCallback(async ({ songId, snippetId, settings }) => {
    // Reset in-memory state
    eventsRef.current = [];
    timingDeltasRef.current = [];
    countersRef.current = { hits: 0, misses: 0, partials: 0, totalBeats: 0 };
    loopCountRef.current = 0;
    sessionIdRef.current = null;
    setStats({ hits: 0, misses: 0, partials: 0, totalBeats: 0, accuracyPercent: 0, avgTimingDeltaMs: 0 });

    // Create session row in Supabase (fire-and-forget style — don't block UI)
    if (!songId) {
      console.warn("[Sam] No song DB id yet — session will track locally only");
      return;
    }

    const row = {
      song_id: songId,
      settings: settings || {},
      started_at: new Date().toISOString(),
    };
    if (snippetId) row.snippet_id = snippetId;

    supabase
      .from("sam_sessions")
      .insert(row)
      .select("id")
      .single()
      .then(({ data, error }) => {
        if (error) {
          console.error("[Sam] Failed to create session:", error);
        } else {
          sessionIdRef.current = data.id;
          console.log("[Sam] Session created:", data.id);
        }
      });
  }, []);

  const recordEvent = useCallback(({ beatEvent, played, timingDeltaMs, result, loopIteration }) => {
    const evt = {
      loopIteration: loopIteration ?? loopCountRef.current,
      measure: beatEvent.meas,
      beat: beatEvent.beat,
      expectedNotes: beatEvent.allMidi,
      playedNotes: played || [],
      result,
      timingDeltaMs: timingDeltaMs != null ? Math.round(timingDeltaMs) : null,
    };
    eventsRef.current.push(evt);

    // Update running counters
    const c = countersRef.current;
    c.totalBeats++;
    if (result === "hit") c.hits++;
    else if (result === "partial") c.partials++;
    else c.misses++; // "miss" or "wrong"

    if (timingDeltaMs != null) {
      timingDeltasRef.current.push(timingDeltaMs);
    }

    const total = c.hits + c.misses;
    const accuracy = total > 0 ? Math.round((c.hits / total) * 100) : 0;
    const avgTiming = timingDeltasRef.current.length > 0
      ? Math.round(timingDeltasRef.current.reduce((a, b) => a + b, 0) / timingDeltasRef.current.length)
      : 0;

    setStats({
      hits: c.hits,
      misses: c.misses,
      partials: c.partials,
      totalBeats: c.totalBeats,
      accuracyPercent: accuracy,
      avgTimingDeltaMs: avgTiming,
    });
  }, []);

  const setLoopIteration = useCallback((n) => {
    loopCountRef.current = n;
  }, []);

  const endSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      console.warn("[Sam] No session to end");
      return;
    }

    const c = countersRef.current;
    const total = c.hits + c.misses;
    const avgTiming = timingDeltasRef.current.length > 0
      ? Math.round(timingDeltasRef.current.reduce((a, b) => a + b, 0) / timingDeltasRef.current.length)
      : 0;

    const summary = {
      totalBeats: c.totalBeats,
      hits: c.hits,
      misses: c.misses,
      partials: c.partials,
      accuracyPercent: total > 0 ? Math.round((c.hits / total) * 100) : 0,
      avgTimingDeltaMs: avgTiming,
      loopCount: loopCountRef.current,
    };

    const now = new Date().toISOString();

    // Fire-and-forget update
    supabase
      .from("sam_sessions")
      .update({
        ended_at: now,
        summary,
        events: eventsRef.current,
      })
      .eq("id", sessionId)
      .then(({ error }) => {
        if (error) {
          console.error("[Sam] Failed to end session:", error);
        } else {
          console.log("[Sam] Session ended:", sessionId, summary);
        }
      });

    sessionIdRef.current = null;
  }, []);

  return { startSession, endSession, recordEvent, setLoopIteration, stats };
}
