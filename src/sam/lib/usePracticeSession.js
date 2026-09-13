import { useState, useRef, useCallback } from "react";
import { supabase } from "../../supabaseClient";

const EMPTY_STATS = {
  hits: 0,
  misses: 0,
  partials: 0,
  totalBeats: 0,
  accuracyPercent: 0,
  avgTimingDeltaMs: 0,
  playthroughAccuracyPercent: 0,
  playthroughHits: 0,
  playthroughMisses: 0,
  playthroughScored: 0,
  playthroughLoop: 0,
  hasPlaythrough: false,
};

function newPlaythrough(loop) {
  return { loop, hits: 0, misses: 0, partials: 0, totalBeats: 0 };
}

// Accuracy counts hits against hits+misses; partials sit outside the ratio.
// Same rule for a pass as for the whole session, so the two numbers on screen
// are directly comparable.
function accuracyOf(c) {
  const total = c.hits + c.misses;
  return total > 0 ? Math.round((c.hits / total) * 100) : 0;
}

// Which pass the "Playthrough Accuracy" readout describes: the one in progress
// once it has a scored beat, otherwise the last completed one. That second case
// covers the moment just after a loop wraps and the gap between a pause or stop
// and the next note — a clean pass stays on screen instead of blanking to 0%.
function playthroughStats(current, last) {
  const p = current.hits + current.misses > 0 ? current : last || current;
  return {
    playthroughAccuracyPercent: accuracyOf(p),
    playthroughHits: p.hits,
    playthroughMisses: p.misses,
    playthroughScored: p.hits + p.misses,
    playthroughLoop: p.loop,
    hasPlaythrough: p.hits + p.misses > 0,
  };
}

export default function usePracticeSession({ onSessionEnded } = {}) {
  const [stats, setStats] = useState(EMPTY_STATS);

  const sessionIdRef = useRef(null);
  const songIdRef = useRef(null);
  const eventsRef = useRef([]);
  const timingDeltasRef = useRef([]);
  const countersRef = useRef({ hits: 0, misses: 0, partials: 0, totalBeats: 0 });
  const loopCountRef = useRef(0);

  // Per-playthrough counters. `playthroughRef` is the pass in progress;
  // `lastPlaythroughRef` is the most recently completed one, kept so the
  // displayed number doesn't blank out the instant a loop wraps (and so a
  // clean 100% pass is still on screen after the wrap, on pause and on stop).
  // `playthroughLogRef` accumulates finished passes for the session summary.
  const playthroughRef = useRef(newPlaythrough(0));
  const lastPlaythroughRef = useRef(null);
  const playthroughLogRef = useRef([]);

  // Fires after a session's ended_at update resolves in Supabase. Held in a
  // ref so consumers can pass an inline arrow without retriggering the
  // `useCallback` deps — same pattern as `lyricEditRef` in ScoreRenderer.
  const onSessionEndedRef = useRef(onSessionEnded);
  onSessionEndedRef.current = onSessionEnded;

  const startSession = useCallback(async ({ songId, snippetId, settings }) => {
    // Reset in-memory state
    eventsRef.current = [];
    timingDeltasRef.current = [];
    countersRef.current = { hits: 0, misses: 0, partials: 0, totalBeats: 0 };
    loopCountRef.current = 0;
    playthroughRef.current = newPlaythrough(0);
    lastPlaythroughRef.current = null;
    playthroughLogRef.current = [];
    sessionIdRef.current = null;
    songIdRef.current = songId || null;
    setStats(EMPTY_STATS);

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

    // Update running counters — session-wide and for the pass in progress
    const c = countersRef.current;
    const p = playthroughRef.current;
    c.totalBeats++;
    p.totalBeats++;
    if (result === "hit") { c.hits++; p.hits++; }
    else if (result === "partial") { c.partials++; p.partials++; }
    else { c.misses++; p.misses++; } // "miss" or "wrong"

    if (timingDeltaMs != null) {
      timingDeltasRef.current.push(timingDeltaMs);
    }

    const avgTiming = timingDeltasRef.current.length > 0
      ? Math.round(timingDeltasRef.current.reduce((a, b) => a + b, 0) / timingDeltasRef.current.length)
      : 0;

    setStats({
      hits: c.hits,
      misses: c.misses,
      partials: c.partials,
      totalBeats: c.totalBeats,
      accuracyPercent: accuracyOf(c),
      avgTimingDeltaMs: avgTiming,
      ...playthroughStats(p, lastPlaythroughRef.current),
    });
  }, []);

  // ScrollEngine calls this on every loop wrap (and with 0 when a run starts),
  // which is the only playthrough boundary there is: at the wrap it resets
  // every beat event to pending, so no scoring from the outgoing pass arrives
  // afterwards.
  const setLoopIteration = useCallback((n) => {
    if (n === loopCountRef.current) return;
    const finished = playthroughRef.current;
    if (finished.hits + finished.misses > 0) {
      lastPlaythroughRef.current = { ...finished };
      playthroughLogRef.current.push({
        loop: finished.loop,
        hits: finished.hits,
        misses: finished.misses,
        partials: finished.partials,
        totalBeats: finished.totalBeats,
        accuracyPercent: accuracyOf(finished),
      });
    }
    loopCountRef.current = n;
    playthroughRef.current = newPlaythrough(n);
    setStats((prev) => ({
      ...prev,
      ...playthroughStats(playthroughRef.current, lastPlaythroughRef.current),
    }));
  }, []);

  const endSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      console.warn("[Sam] No session to end");
      return;
    }

    const c = countersRef.current;
    const avgTiming = timingDeltasRef.current.length > 0
      ? Math.round(timingDeltasRef.current.reduce((a, b) => a + b, 0) / timingDeltasRef.current.length)
      : 0;

    // The pass in progress when the run ended counts as a playthrough too —
    // a session that never wrapped still has one worth recording.
    const inProgress = playthroughRef.current;
    const playthroughs = [...playthroughLogRef.current];
    if (inProgress.hits + inProgress.misses > 0) {
      playthroughs.push({
        loop: inProgress.loop,
        hits: inProgress.hits,
        misses: inProgress.misses,
        partials: inProgress.partials,
        totalBeats: inProgress.totalBeats,
        accuracyPercent: accuracyOf(inProgress),
      });
    }

    const summary = {
      totalBeats: c.totalBeats,
      hits: c.hits,
      misses: c.misses,
      partials: c.partials,
      accuracyPercent: accuracyOf(c),
      avgTimingDeltaMs: avgTiming,
      loopCount: loopCountRef.current,
      playthroughs,
      bestPlaythroughAccuracyPercent: playthroughs.length
        ? Math.max(...playthroughs.map((p) => p.accuracyPercent))
        : null,
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

        // Fire the post-end hook (e.g. practice-stats refetch) as soon as the
        // ended_at row update lands — the event fan-out below is independent
        // and shouldn't block downstream consumers.
        try {
          onSessionEndedRef.current?.();
        } catch (cbErr) {
          console.error("[Sam] onSessionEnded callback threw:", cbErr);
        }

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
