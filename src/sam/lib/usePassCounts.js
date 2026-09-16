import { useState, useEffect, useCallback } from "react";
import { supabase } from "../../supabaseClient";
import { ptDateKey } from "./practiceTimeFormat";

// Completed-pass counts for the open song: the loaded range's count for the
// playing screen, and the song's own today/total for the paused screen.
//
// Seeded from the database, then kept current by incrementing as passes land.
// Seeding is the point: a counter that started at zero whenever a song opened
// would say "0" after a morning of practice and only ever describe the current
// sitting, which is not what "Completed Passes" means.
//
// "Today" is `ptDateKey` from practiceTimeFormat — the same Pacific-day
// boundary "Today: xx minutes" buckets on. Two definitions of today that
// disagreed by a few hours would be the kind of bug nobody notices and nothing
// fixes, so there is deliberately only the one, used by every count here.
//
// READ-ONLY, and that matters. This hook never creates, adopts or selects a
// snippet — it only ever SELECTs. The snippet panel's defaults are the whole
// song expressed as a range, so a count lookup that resolved an unsaved range
// to a snippet id would quietly convert Full Song into a snippet: the trap
// M1.5, M1.7 and M2 each had to avoid, and it would arrive here a fourth time.
//
// `snippet_id IS NULL` means the whole song, and that is NOT the same question
// as "the loaded range has no id yet":
//
//   snippet === null      → the whole song: rows with a NULL snippet_id
//   snippet with a dbId   → that snippet: rows carrying its id
//   snippet with no dbId  → a range never saved: 0, with no query at all
//
// Collapsing the first and third — the obvious `snippet?.dbId ?? null` — would
// show the song's count against an unsaved range, crediting it with practice it
// never had. The derivation of `rangeTodayCount` below keeps them apart.
export default function usePassCounts({ songId, snippet }) {
  // Whole-song passes: rows where `snippet_id` is null. Kept separately from
  // the loaded range because the paused screen shows the SONG's numbers even
  // while a snippet is loaded — a snippet's passes must never inflate them.
  const [songTodayCount, setSongTodayCount] = useState(0);
  const [songTotalCount, setSongTotalCount] = useState(0);

  // The loaded snippet's passes today. Stays 0 when the loaded range has no
  // saved snippet behind it, which is what that third case above requires.
  const [snippetTodayCount, setSnippetTodayCount] = useState(0);

  const snippetId = snippet?.dbId ?? null;

  useEffect(() => {
    if (!songId) {
      setSongTodayCount(0);
      setSongTotalCount(0);
      return undefined;
    }

    let cancelled = false;

    // Lifetime total — deliberately unbounded by date, and asked for as a
    // `head` count so no rows cross the wire however long the history gets.
    supabase
      .from("sam_passes")
      .select("id", { count: "exact", head: true })
      .eq("song_id", songId)
      .is("snippet_id", null)
      .then(({ count, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[Sam] Song pass total fetch failed:", error);
          return;
        }
        setSongTotalCount(count || 0);
      });

    supabase
      .from("sam_passes")
      .select("completed_at")
      .eq("song_id", songId)
      .is("snippet_id", null)
      .gte("completed_at", todayFetchFloor())
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[Sam] Song pass count fetch failed:", error);
          return;
        }
        setSongTodayCount(countToday(data));
      });

    return () => {
      cancelled = true;
    };
  }, [songId]);

  useEffect(() => {
    if (!songId || !snippetId) {
      setSnippetTodayCount(0);
      return undefined;
    }

    let cancelled = false;

    supabase
      .from("sam_passes")
      .select("completed_at")
      .eq("song_id", songId)
      .eq("snippet_id", snippetId)
      .gte("completed_at", todayFetchFloor())
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[Sam] Snippet pass count fetch failed:", error);
          setSnippetTodayCount(0);
          return;
        }
        setSnippetTodayCount(countToday(data));
      });

    return () => {
      cancelled = true;
    };
  }, [songId, snippetId]);

  // Called when a pass row actually lands, carrying the `snippet_id` that was
  // written. Taking it from the written row rather than from current state is
  // what keeps a snippet pass out of the song's numbers, and is why the paused
  // screen is already correct the moment playback stops: the numbers were
  // updated as each pass landed, not refetched afterwards.
  //
  // Incrementing on success, not on queue, is deliberate — these numbers claim
  // what has been recorded, so a failed write must leave them alone.
  const countPass = useCallback(({ snippetId: recordedSnippetId } = {}) => {
    if (recordedSnippetId) {
      setSnippetTodayCount((n) => n + 1);
      return;
    }
    setSongTodayCount((n) => n + 1);
    setSongTotalCount((n) => n + 1);
  }, []);

  return {
    // Playing screen (M2): today's count for whatever is loaded. With no
    // snippet the loaded range IS the whole song, so this is the same state the
    // paused screen reads — which is what makes the two agree across a stop
    // rather than merely arriving at the same number by different routes.
    rangeTodayCount: snippet ? snippetTodayCount : songTodayCount,
    // Paused screen (M3): the song's own passes, whatever is loaded.
    songTodayCount,
    songTotalCount,
    countPass,
  };
}

// Two days back comfortably covers "today in Pacific time" whatever the UTC
// offset, and keeps the payload to the handful of rows a day this table sees.
// The exact day test is `ptDateKey`; this is only a bound so the query does not
// grow without limit as history accumulates.
function todayFetchFloor() {
  return new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
}

function countToday(rows) {
  const todayKey = ptDateKey(new Date());
  return (rows || []).filter((r) => ptDateKey(r.completed_at) === todayKey).length;
}
