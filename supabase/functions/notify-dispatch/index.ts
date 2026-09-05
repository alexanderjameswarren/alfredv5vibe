// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import webpush from "web-push";
import { createECDH, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "jsr:@supabase/supabase-js@2";
// The deep link is built with the SAME function the app routes on. Imported
// rather than reimplemented: a hand-copied path here would silently stop
// matching the day viewPaths.js changes, and the failure would be a
// notification that opens the wrong screen — the exact class of drift this
// project has been bitten by twice. Verified to load under Deno 2.1.4.
import { executionPath } from "../../../src/viewPaths.js";

// notify-dispatch — send the notifications that have come due.
//
// Called by pg_cron via pg_net once a minute. NOT an MCP tool: no defineTool,
// no ctx.db, nothing in _shared/platform.ts. It is a standalone function like
// push-send, and it is the second in this project deployed with JWT
// verification OFF.
//
// 🛑 THAT MAKES THIS A PUBLIC URL THAT SENDS PUSH NOTIFICATIONS. The shared
// secret is the only thing standing in front of it, so it is checked FIRST,
// before the body is read, before the database is touched, before anything.
//
// ⚠️ `verify_jwt = false` has reset silently on redeploy in this project.
// Re-check it after every deploy — see the post-deploy step in
// docs/progress-notification-chains.md.
//
// Unlike push-send, this runs with the SERVICE ROLE: cron has no user token, so
// there is no JWT to build a request-scoped client from and RLS cannot do the
// scoping. That is the ai-enrich precedent, and it puts the burden here: every
// query below MUST filter by the step's own user_id, because nothing else will.

const STEPS_TABLE = "notification_steps";
const SUBS_TABLE = "push_subscriptions";
const EXECUTIONS_TABLE = "executions";

// A bounded read. A minute's worth of due steps is normally a handful; a
// runaway query returning thousands would blow the function's time budget and
// send a flood. Anything beyond this waits for the next tick sixty seconds
// later, which is the right kind of degradation.
const MAX_STEPS_PER_RUN = 200;

// A step whose user has no push_subscriptions row at all. Out of the send
// queue so it is not retried every minute forever, but not terminal — ticking
// it in the UI still advances the chain. See src/utils/notificationSteps.js.
const NO_SUBSCRIPTION = "no_subscription";

// Permanently dead endpoints — the subscription is gone, not failing. Any other
// status is transient and must leave the row alone. Same rule as push-send.
const DEAD_STATUS = new Set([404, 410]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Constant-time secret comparison; false for absent or wrong-length input. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak length
  // through the error path — compare lengths first and bail uniformly.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Load and verify the VAPID configuration.
 *
 * Same keypair assertion as push-send: the public half is derivable from the
 * private half, so a mismatched pair is caught here as one clear error rather
 * than as a 403 from the push service with nothing pointing at the cause.
 */
function loadVapid() {
  const subject = Deno.env.get("VAPID_SUBJECT");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");

  const missing = [
    ["VAPID_SUBJECT", subject],
    ["VAPID_PUBLIC_KEY", publicKey],
    ["VAPID_PRIVATE_KEY", privateKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing edge function secret(s): ${missing.join(", ")}`);
  }

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey!, "base64url"));
  const derived = ecdh.getPublicKey().toString("base64url");
  if (derived !== publicKey) {
    throw new Error(
      "VAPID keypair mismatch: VAPID_PUBLIC_KEY is not the public half of " +
        "VAPID_PRIVATE_KEY. The browser subscribed against " +
        "REACT_APP_VAPID_PUBLIC_KEY, so all three must be the same pair.",
    );
  }

  webpush.setVapidDetails(subject!, publicKey!, privateKey!);
}

interface StepRow {
  id: string;
  execution_id: string;
  user_id: string;
  seq: number;
  text: string;
  due_at: string;
}

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
}

Deno.serve(async (req) => {
  // ── 1. The gate. Nothing above this line touches state. ──────────────────
  const expected = Deno.env.get("NOTIFY_DISPATCH_SECRET");
  if (!expected) {
    // Fail closed. A missing secret must never mean "let everyone in".
    console.error("[dispatch] NOTIFY_DISPATCH_SECRET is not set — refusing all requests.");
    return json({ error: "Dispatcher is not configured." }, 503);
  }
  if (!secretMatches(req.headers.get("x-dispatch-secret"), expected)) {
    // Deliberately terse: an unauthenticated caller learns nothing about
    // whether the header was absent, malformed, or simply wrong.
    return json({ error: "Unauthorized" }, 401);
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const startedAt = new Date();
  const nowIso = startedAt.toISOString();

  try {
    loadVapid();
  } catch (err) {
    console.error("[dispatch] VAPID configuration error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── 2. Which steps have come due? ────────────────────────────────────────
  const { data: dueSteps, error: stepsError } = await db
    .from(STEPS_TABLE)
    .select("id, execution_id, user_id, seq, text, due_at")
    .eq("state", "scheduled")
    .lte("due_at", nowIso)
    .order("due_at", { ascending: true })
    .limit(MAX_STEPS_PER_RUN);

  if (stepsError) {
    console.error("[dispatch] Could not read due steps:", stepsError);
    return json({ error: `Could not read due steps: ${stepsError.message}` }, 500);
  }
  if (!dueSteps || dueSteps.length === 0) {
    return json({ checked_at: nowIso, due: 0, sent: 0, failed: 0, results: [] });
  }

  // ── 3. Drop steps whose execution is not active. ─────────────────────────
  //
  // Done as a second query rather than as a PostgREST embed: notification_steps
  // has no foreign key to executions (execution_id is a plain text column
  // matching Alfred's legacy text keys), and embedding requires one.
  //
  // This is what makes PAUSING work with no state on the step rows at all — a
  // paused execution simply stops matching here, and its steps sit untouched
  // until it is resumed.
  const executionIds = [...new Set((dueSteps as StepRow[]).map((s) => s.execution_id))];
  const { data: activeExecutions, error: execError } = await db
    .from(EXECUTIONS_TABLE)
    .select("id")
    .in("id", executionIds)
    .eq("status", "active");

  if (execError) {
    console.error("[dispatch] Could not read executions:", execError);
    return json({ error: `Could not read executions: ${execError.message}` }, 500);
  }

  const activeIds = new Set((activeExecutions ?? []).map((e: { id: string }) => e.id));
  const steps = (dueSteps as StepRow[]).filter((s) => activeIds.has(s.execution_id));
  const skippedInactive = dueSteps.length - steps.length;

  if (steps.length === 0) {
    return json({
      checked_at: nowIso,
      due: dueSteps.length,
      skipped_inactive: skippedInactive,
      sent: 0,
      failed: 0,
      results: [],
    });
  }

  // ── 4. Subscriptions, by user. ───────────────────────────────────────────
  //
  // Keyed on the step's OWN user_id — the reason that column is denormalised
  // onto the step. Under the service role nothing else constrains this query,
  // so this filter is the whole of the authorisation.
  const userIds = [...new Set(steps.map((s) => s.user_id))];
  const { data: subsData, error: subsError } = await db
    .from(SUBS_TABLE)
    .select("id, user_id, endpoint, p256dh, auth_key")
    .in("user_id", userIds);

  if (subsError) {
    console.error("[dispatch] Could not read subscriptions:", subsError);
    return json({ error: `Could not read subscriptions: ${subsError.message}` }, 500);
  }

  const subsByUser = new Map<string, SubRow[]>();
  for (const sub of (subsData ?? []) as SubRow[]) {
    const list = subsByUser.get(sub.user_id) ?? [];
    list.push(sub);
    subsByUser.set(sub.user_id, list);
  }

  // ── 5. Send. ─────────────────────────────────────────────────────────────
  const results = [];

  for (const step of steps) {
    const subs = subsByUser.get(step.user_id) ?? [];
    if (subs.length === 0) {
      // No device to send to, ever — this user has no subscription at all.
      //
      // Taken OUT of the send queue rather than left `scheduled`. Left
      // scheduled it would be retried every sixty seconds forever and would
      // eat into the 200-per-run cap; a household member who never subscribes
      // accumulates a permanent backlog that crowds out real steps.
      //
      // `no_subscription` is out of the queue but NOT terminal: ticking the
      // step in the UI still advances the chain normally. Undeliverable is not
      // undoable.
      const { error: markError } = await db
        .from(STEPS_TABLE)
        .update({ state: NO_SUBSCRIPTION })
        .eq("id", step.id)
        .eq("state", "scheduled");
      if (markError) {
        console.error(`[dispatch] Could not mark step ${step.id} ${NO_SUBSCRIPTION}:`, markError);
      }

      results.push({
        step_id: step.id,
        seq: step.seq,
        sent: false,
        state: NO_SUBSCRIPTION,
        reason: "no push subscriptions for this user",
        endpoints: [],
      });
      continue;
    }

    // A relative path, resolved by the service worker against its own origin.
    // No APP_BASE_URL secret, and no way to send a link to the wrong host.
    const url = executionPath(step.execution_id);
    const payload = JSON.stringify({
      title: "Alfred",
      body: step.text,
      // Per execution, not per step: a later step replaces an earlier unread
      // one for the same run rather than stacking up on the watch.
      tag: `alfred-exec-${step.execution_id}`,
      url,
    });

    const endpoints = await Promise.all(
      subs.map(async (sub) => {
        const tail = `…${sub.endpoint.slice(-20)}`;
        try {
          const res = await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
            payload,
            { TTL: 3600 },
          );
          return { endpoint_tail: tail, status: res?.statusCode ?? 201, ok: true, removed: false };
        } catch (err) {
          const e = err as { statusCode?: number; body?: string; message?: string };
          const status = typeof e.statusCode === "number" ? e.statusCode : null;

          let removed = false;
          if (status !== null && DEAD_STATUS.has(status)) {
            const { error: delError } = await db.from(SUBS_TABLE).delete().eq("id", sub.id);
            if (!delError) removed = true;
            else console.error(`[dispatch] Could not delete dead subscription ${sub.id}:`, delError);
          }

          return {
            endpoint_tail: tail,
            status,
            ok: false,
            removed,
            error: e.message ?? String(err),
            ...(e.body ? { service_body: String(e.body).slice(0, 200) } : {}),
          };
        }
      }),
    );

    // At least one endpoint succeeding counts as sent. Cross-device
    // deduplication is out of scope; what matters is that the step is not
    // retried every sixty seconds forever because one stale device failed.
    const anySucceeded = endpoints.some((e) => e.ok);

    if (anySucceeded) {
      const { error: markError } = await db
        .from(STEPS_TABLE)
        .update({ state: "sent", sent_at: new Date().toISOString() })
        .eq("id", step.id)
        // Only from `scheduled`. If a concurrent run or a user action already
        // moved this row, leave it — this is what stops a slow run and the next
        // tick from both claiming the same step.
        .eq("state", "scheduled");
      if (markError) {
        console.error(`[dispatch] Sent step ${step.id} but could not mark it sent:`, markError);
      }
    }

    results.push({
      step_id: step.id,
      seq: step.seq,
      execution_id: step.execution_id,
      text: step.text,
      url,
      sent: anySucceeded,
      endpoints,
    });
  }

  const sent = results.filter((r) => r.sent).length;
  const summary = {
    checked_at: nowIso,
    duration_ms: Date.now() - startedAt.getTime(),
    due: dueSteps.length,
    skipped_inactive: skippedInactive,
    considered: steps.length,
    sent,
    failed: steps.length - sent,
    results,
  };

  // Logged as well as returned: pg_net stores the response body, but the
  // function's own logs are where this is read when the response is not.
  console.log(`[dispatch] due=${dueSteps.length} inactive=${skippedInactive} sent=${sent} failed=${steps.length - sent}`);

  return json(summary);
});
