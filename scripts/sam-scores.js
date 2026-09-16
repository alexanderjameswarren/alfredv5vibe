/* eslint-disable */
//
// SAM difficulty scores — paste into the BROWSER CONSOLE, on the tab where SAM
// is open and you are logged in. Analyzer port M4.
//
//   1. Open the app and sign in.
//   2. Open DevTools → Console.
//   3. Paste this whole file.
//   4. Run one of:
//        await samScores.backfill()          every non-archived song
//        await samScores.compute("<id>")     one song
//        await samScores.twice("<id>")       compute, then again: the second
//                                            call must be `fresh` with
//                                            measures_read 0
//
// Each call goes to the sam-scores Edge Function with your own session, so RLS
// confines it to your songs. `fresh` means the stored scores were already
// current: nothing was read and nothing was written. No service-role key.

(function () {
  const SUPABASE_URL = "https://zuqjyfqnvhddnchhpbcz.supabase.co";
  const ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo";

  function accessToken() {
    // supabase-js v2 key format: sb-<project-ref>-auth-token
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^sb-.*-auth-token$/.test(k)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k));
        const tok = v?.access_token || v?.currentSession?.access_token;
        if (tok) return tok;
      } catch (_) {}
    }
    throw new Error("No Supabase session in localStorage. Sign in to SAM on this origin first.");
  }

  const headers = () => ({
    apikey: ANON_KEY,
    Authorization: `Bearer ${accessToken()}`,
    "Content-Type": "application/json",
  });

  async function compute(songId) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sam-scores`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ song_id: songId }),
    });
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) return { song_id: songId, status: "ERROR", error: body.error ?? `HTTP ${res.status}` };
    return body;
  }

  async function listSongs() {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sam_songs?archived=eq.false&select=id,title&order=title`,
      { headers: headers() }
    );
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  const row = (title, r) => ({
    title,
    status: r.status,
    measures_read: r.measures_read ?? "",
    rows_written: r.rows_written ?? "",
    computed_from_edited_at: r.computed_from_edited_at ?? "",
    error: r.error ?? "",
  });

  window.samScores = {
    async compute(songId) {
      const r = await compute(songId);
      console.table([row(songId, r)]);
      return r;
    },

    async twice(songId) {
      const first = await compute(songId);
      const second = await compute(songId);
      console.table([row("1st call", first), row("2nd call", second)]);
      const ok = second.status === "fresh" && second.measures_read === 0 && second.rows_written === 0;
      console.log(
        ok ? "%cPASS%c second call was a no-op (fresh, 0 measures read, 0 rows written)"
           : "%cFAIL%c second call was NOT a no-op",
        ok ? "color:#0a0;font-weight:bold" : "color:#c00;font-weight:bold",
        ""
      );
      return { first, second };
    },

    // One song at a time: each request stays small, and one failure does not
    // stop the rest.
    async backfill() {
      const songs = await listSongs();
      const results = [];
      for (const s of songs) {
        const r = await compute(s.id);
        results.push(row(s.title, r));
        console.log(`${r.status.padEnd(11)} ${s.title}`);
      }
      console.table(results);
      const count = (st) => results.filter((x) => x.status === st).length;
      console.log(
        `%c${songs.length} songs%c — computed ${count("computed")}, fresh ${count("fresh")}, ` +
          `no-measures ${count("no-measures")}, cleared ${count("cleared")}, errors ${count("ERROR")}`,
        "font-weight:bold",
        ""
      );
      return results;
    },
  };

  console.log("samScores ready: backfill() · compute(id) · twice(id)");
})();
