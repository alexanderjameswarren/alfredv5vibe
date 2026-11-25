// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "jsr:@supabase/supabase-js@2";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import { type Deps, handle } from "./core.ts";

// switchboard-run-pages: the Switchboard 3 run and code review pages' server (sb3_pages-h6v B2, s12). Routes, checks
// and replies are in core.ts. A SERVER-TO-SERVER EXCEPTION like switchboard-runner: not an MCP tool, no defineTool.
//
// Alex's routes call the 250 functions with a client built from his JWT, so RLS and the link rules decide. The service
// role is used only for the one write 250 reserves for it here: the code review answer. ⚠️ THE SERVICE ROLE BYPASSES
// RLS: it is narrowed to CLIPBOARD_USER_ID's rows. The desktop helper never calls this function (option A, s12): the
// evidence and the sample go through switchboard-runner to switchboard_record_run_evidence and
// switchboard_store_run_sample.
// ⚠️ verify_jwt is false in config.toml, as switchboard-runner's: every route checks the JWT itself, and answers 401
// with this function's own body. After every deploy a POST to /preview without a JWT must come back 401
// {"ok":false,"error":"unauthorized"}.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const userClient = (jwt: string) =>
  createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });

function deps(): Deps {
  const db = createServiceClient();
  const userId = Deno.env.get("CLIPBOARD_USER_ID") ?? "";
  const must = <T>(res: { data: T | null; error: { message: string } | null }): T | null => {
    if (res.error) throw new Error(res.error.message);
    return res.data;
  };
  return {
    userId,
    authUser: async (jwt) => {
      const { data, error } = await userClient(jwt).auth.getUser(jwt);
      return error || !data?.user ? null : data.user.id;
    },
    rpcAsUser: async (jwt, fn, args) => {
      const { data, error } = await userClient(jwt).rpc(fn, args);
      return { data, error: error ? { message: error.message, code: error.code } : null };
    },
    answerReview: async (reviewId, { status, acks, answer }) => {
      const row = must(await db.from("switchboard_code_reviews").select("answers, acks, updated_at").eq("id", reviewId)
        .eq("user_id", userId).eq("status", "open").maybeSingle()) as { answers: unknown[]; acks: Record<string, unknown>; updated_at: string } | null;
      if (!row) return false;
      // Only while open and unchanged since read (updated_at): of two answers at once, the second changes nothing, so
      // no answer is lost. Earlier ticks are kept, with this visit's on top.
      const updated = must(await db.from("switchboard_code_reviews")
        .update({ status, acks: { ...(row.acks ?? {}), ...acks }, answers: [...(row.answers ?? []), answer],
                  answered_at: answer.at, updated_at: new Date().toISOString() })
        .eq("id", reviewId).eq("user_id", userId).eq("status", "open").eq("updated_at", row.updated_at)
        .select("id")) as { id: string }[] | null;
      return Boolean(updated?.length);
    },
  };
}

Deno.serve(async (req) => {
  try {
    return await handle(req, deps());
  } catch (e) {
    console.error("[switchboard-run-pages]", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ ok: false, error: "the run pages function hit an error; see its logs." }), {
      status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
