// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "jsr:@supabase/supabase-js@2";
import { computeSongScores, SongNotFoundError } from "../_shared/samScores.ts";

// sam-scores — bring one song's stored difficulty facts (sam_song_scores) up
// to date. Analyzer port M4; spec docs/technical-spec-analyzer-port.md.
//
//   POST { "song_id": "<uuid>" }
//   -> { song_id, status, scores_version, computed_from_edited_at,
//        measures_read, rows_written }
//
// status: "fresh" (nothing read, nothing written), "computed", "no-measures",
// or "cleared". One song per request: a whole-library backfill is a loop of
// these (scripts/sam-scores.js), which keeps every request well inside the
// edge runtime's CPU budget.
//
// A standalone function, not an MCP tool — the same shape as push-send. JWT
// verification is ON and the client is built from the caller's own
// Authorization header, so RLS confines it to the caller's songs. No
// service-role key, and no tempo: stored rows are tempo-independent.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { song_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON: { \"song_id\": \"<uuid>\" }" }, 400);
  }
  const songId = body?.song_id;
  if (typeof songId !== "string" || !UUID.test(songId)) {
    return json({ error: "song_id must be a UUID" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  try {
    return json(await computeSongScores(supabase, songId));
  } catch (e) {
    if (e instanceof SongNotFoundError) return json({ error: e.message }, 404);
    console.error("[sam-scores]", songId, e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
