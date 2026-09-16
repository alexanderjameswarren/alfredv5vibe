import { useState, useEffect } from "react";
import { supabase } from "../../supabaseClient";
import { ptDateKey } from "./practiceTimeFormat";

// Per-snippet passes and practice time, keyed by snippet id, for the numbers
// shown on each row of the snippet panel (M4.1).
//
// Returns a plain lookup rather than a list: the panel already has its snippets,
// already orders them `created_at` descending, and already decides which of the
// live and archived lists to show. This supplies numbers for whatever it
// renders and makes no decision about ordering or visibility — that separation
// is what lets archived rows use the same numbers in the same format, with the
// panel's existing "View archived snippets" toggle staying the only filter.
//
// LAZY. Nothing is fetched until `enabled` is true, which the panel sets only
// while it is open. A closed snippet panel costs no queries.
//
// READ-ONLY, for the fourth milestone running: it only ever SELECTs. It
// resolves nothing, adopts nothing, and selects no snippet, so counting cannot
// turn Full Song into a snippet.
//
// "Today" is `ptDateKey`, the same Pacific-day boundary M2 and M3 use and the
// same one behind "Today: xx minutes". Still exactly one definition of today.
//
// Practice time is derived as `ended_at - started_at`, matching
// `usePracticeStats` — `sam_sessions.duration_seconds` exists in the schema but
// is never populated, so timestamp arithmetic is the only source of truth.
// Sessions with a null `ended_at` were abandoned and contribute nothing.
export default function useSnippetPracticeSummary({ songId, enabled }) {
  const [byId, setById] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!songId || !enabled) {
      setById({});
      return undefined;
    }

    let cancelled = false;
    setLoading(true);

    Promise.all([
      supabase
        .from("sam_passes")
        .select("snippet_id, completed_at")
        .eq("song_id", songId)
        .not("snippet_id", "is", null),
      supabase
        .from("sam_sessions")
        .select("snippet_id, started_at, ended_at")
        .eq("song_id", songId)
        .not("snippet_id", "is", null)
        .not("ended_at", "is", null),
    ])
      .then(([passRes, sessionRes]) => {
        if (cancelled) return;

        const firstError = passRes.error || sessionRes.error;
        if (firstError) {
          console.error("[Sam] Snippet practice summary fetch failed:", firstError);
          setById({});
          setLoading(false);
          return;
        }

        const todayKey = ptDateKey(new Date());
        const out = {};

        const bucketFor = (id) => {
          if (!out[id]) {
            out[id] = {
              passesToday: 0,
              passesTotal: 0,
              practiceTodaySeconds: 0,
              practiceTotalSeconds: 0,
            };
          }
          return out[id];
        };

        for (const p of passRes.data || []) {
          const b = bucketFor(p.snippet_id);
          b.passesTotal += 1;
          if (ptDateKey(p.completed_at) === todayKey) b.passesToday += 1;
        }

        for (const se of sessionRes.data || []) {
          const startMs = new Date(se.started_at).getTime();
          const endMs = new Date(se.ended_at).getTime();
          // Guard corrupt rows rather than letting one produce negative totals.
          if (!(endMs > startMs)) continue;
          const seconds = (endMs - startMs) / 1000;
          const b = bucketFor(se.snippet_id);
          b.practiceTotalSeconds += seconds;
          // Bucketed by when the sitting STARTED, matching `usePracticeStats`,
          // so a session spanning midnight lands on one day in both displays.
          if (ptDateKey(se.started_at) === todayKey) b.practiceTodaySeconds += seconds;
        }

        setById(out);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [songId, enabled]);

  return { byId, loading };
}
