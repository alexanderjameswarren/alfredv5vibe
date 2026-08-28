/* eslint-disable */
//
// platform_runs admin — paste into the BROWSER CONSOLE, on the tab where
// Alfred is open and you are logged in.
//
//   1. Open the app and sign in.
//   2. DevTools → Console → paste this whole file.
//   3. Run:  runsList()                          — show recent runs
//            runsDelete({ job: "phase2a_smoke" }) — DRY RUN, shows what would go
//            runsDelete({ job: "phase2a_smoke", apply: true })  — actually delete
//
// It needs no credentials: supabase-js persists the session in localStorage on
// this origin, so we borrow that access token and talk to PostgREST with plain
// fetch. RLS scopes everything to you.
//
// Why this exists at all: there is deliberately no delete tool for
// platform_runs. It is an append-only observability log — §4.5 leans on the
// ABSENCE of a row as the signal that a job never ran, so a tool that can make
// rows disappear would undermine the one mechanism the design depends on.
// Removing a test row is a rare, human-initiated act, which is what a console
// script is for.
//
// runsDelete is DRY RUN by default and requires an explicit filter — it will
// refuse to run unfiltered, so a stray call cannot empty the log.

(function () {
  const SUPABASE_URL = "https://zuqjyfqnvhddnchhpbcz.supabase.co";
  const ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo";

  function accessToken() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^sb-.*-auth-token$/.test(k)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k));
        const tok = v?.access_token || v?.currentSession?.access_token;
        if (tok) return tok;
      } catch (_) {}
    }
    throw new Error(
      "No Supabase session in localStorage. Sign in on this origin first."
    );
  }

  async function req(pathAndQuery, init = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      ...init,
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${accessToken()}`,
        ...(init.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  function filterToQuery({ app, job, status, id }) {
    const parts = [];
    if (id) parts.push(`id=eq.${encodeURIComponent(id)}`);
    if (app) parts.push(`app=eq.${encodeURIComponent(app)}`);
    if (job) parts.push(`job=eq.${encodeURIComponent(job)}`);
    if (status) parts.push(`status=eq.${encodeURIComponent(status)}`);
    return parts;
  }

  window.runsList = async function runsList(filter = {}) {
    const parts = filterToQuery(filter);
    parts.push("order=started_at.desc", `limit=${filter.limit || 25}`);
    const rows = await req(`platform_runs?${parts.join("&")}`);
    console.table(
      rows.map((r) => ({
        id: r.id,
        app: r.app,
        job: r.job,
        status: r.status,
        started_at: r.started_at,
        // The 2a smoke row predates the one-clock fix and will show a negative
        // duration here. That is the bug being demonstrated, not a new one.
        duration_ms:
          r.started_at && r.finished_at
            ? new Date(r.finished_at) - new Date(r.started_at)
            : null,
        covered: [r.covered_from, r.covered_to].filter(Boolean).join(" → ") || null,
      }))
    );
    return rows;
  };

  window.runsDelete = async function runsDelete(filter = {}) {
    const { apply = false } = filter;
    const parts = filterToQuery(filter);
    if (parts.length === 0) {
      throw new Error(
        "runsDelete needs at least one of: id, app, job, status. Refusing to " +
          "delete the whole run log."
      );
    }
    const doomed = await req(`platform_runs?${parts.join("&")}`);
    if (doomed.length === 0) {
      console.log("Nothing matches that filter.");
      return [];
    }
    console.table(
      doomed.map((r) => ({ id: r.id, app: r.app, job: r.job, status: r.status, started_at: r.started_at }))
    );
    if (!apply) {
      console.log(
        `%cDRY RUN%c — ${doomed.length} row(s) would be deleted. ` +
          `Re-run with { ...filter, apply: true } to do it.`,
        "color:#c60;font-weight:bold",
        ""
      );
      return doomed;
    }
    await req(`platform_runs?${parts.join("&")}`, { method: "DELETE" });
    console.log(
      `%cDELETED%c ${doomed.length} row(s).`,
      "color:#c00;font-weight:bold",
      ""
    );
    return doomed;
  };

  console.log(
    "platform_runs admin loaded. runsList() | runsDelete({job:'phase2a_smoke'}) " +
      "| runsDelete({job:'phase2a_smoke', apply:true})"
  );
})();
