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
  const songIdRef = useRef(null);
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
    songIdRef.current = songId || null;
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

    const events = eventsRef.current;
    const songId = songIdRef.current;

    // Fire-and-forget update
    supabase
      .from("sam_sessions")
      .update({
        ended_at: now,
        summary,
        events,
      })
      .eq("id", sessionId)
      .then(async ({ error }) => {
        if (error) {
          console.error("[Sam] Failed to end session:", error);
          return;
        }
        console.log("[Sam] Session ended:", sessionId, summary);

        // Fan out events to sam_session_events
        if (!songId || events.length === 0) return;

        try {
          // Batch-fetch measure IDs for this song
          const { data: measureRows, error: measError } = await supabase
            .from("sam_song_measures")
            .select("id, number")
            .eq("song_id", songId);

          if (measError) {
            console.error("[Sam] Failed to fetch measure IDs:", measError);
            return;
          }

          const measureIdMap = {};
          for (const row of measureRows || []) {
            measureIdMap[row.number] = row.id;
          }

          const eventRows = events.map((evt) => ({
            session_id: sessionId,
            song_id: songId,
            measure_number: evt.measure,
            beat: evt.beat,
            result: evt.result,
            played_notes: evt.playedNotes,
            expected_notes: evt.expectedNotes,
            timing_delta_ms: evt.timingDeltaMs,
            loop_iteration: evt.loopIteration,
            measure_id: measureIdMap[evt.measure] || null,
          }));

          // Insert in batches of 500
          const BATCH_SIZE = 500;
          for (let i = 0; i < eventRows.length; i += BATCH_SIZE) {
            const batch = eventRows.slice(i, i + BATCH_SIZE);
            const { error: insertError } = await supabase
              .from("sam_session_events")
              .insert(batch);

            if (insertError) {
              console.error("[Sam] Failed to insert session events:", insertError);
              return;
            }
          }

          console.log(`[Sam] Session events fan-out complete: ${eventRows.length} events`);
        } catch (e) {
          console.error("[Sam] Session events fan-out failed:", e);
        }
      });

    sessionIdRef.current = null;
    songIdRef.current = null;
  }, []);

  return { startSession, endSession, recordEvent, setLoopIteration, stats };
}
