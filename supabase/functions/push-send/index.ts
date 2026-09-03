// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import webpush from "web-push";
import { createECDH } from "node:crypto";
// Not a Deno global — imported explicitly rather than relying on the edge
// runtime happening to expose it.
import { Buffer } from "node:buffer";
import { createClient } from "jsr:@supabase/supabase-js@2";

// push-send — deliver a Web Push notification to every device the caller has
// subscribed.
//
// This is a standalone edge function, NOT an MCP tool. It is called from the
// browser by a logged-in user, so it is deployed with JWT verification ON and
// builds its client from the caller's own Authorization header: the user's
// token is the auth, and RLS is what confines the query to their rows. There is
// no service-role key here and there must not be — a service client would read
// every user's subscriptions and would need its own filtering to be safe, which
// is exactly the thing RLS already does correctly.
//
// The library is npm:web-push, verified to import and run under Deno 2.1.4
// (matching the edge runtime's generation): VAPID JWT signing, aes128gcm
// payload encryption and the network send all work, and a fake endpoint returns
// a real 410 from FCM.

const TABLE = "push_subscriptions";

const DEFAULT_TITLE = "Alfred";
const DEFAULT_BODY = "Time for: squats";

// Status codes that mean the subscription is permanently gone, not that the
// send failed transiently. Chrome returns 410 when a user clears site data or
// the browser drops the registration; 404 means the endpoint never existed.
// Anything else — a 429, a 5xx, a network blip — is not evidence of death and
// must not delete a row a working phone still depends on.
const DEAD_STATUS = new Set([404, 410]);

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

/**
 * Load and check the VAPID configuration.
 *
 * The keypair assertion is the point. A public key that does not pair with the
 * stored private key is the nastiest failure this system has: web-push signs
 * happily, the send looks fine from here, and the push service rejects it with
 * a 403 whose message says nothing about pairing — or, worse, the browser
 * subscribed against a *different* public key and simply never delivers. Since
 * the public half is derivable from the private half, the two can be compared
 * up front, turning that into one clear error at the first call.
 */
function loadVapid() {
  const subject = Deno.env.get("VAPID_SUBJECT");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");

  const missing = [
    ["VAPID_SUBJECT", subject],
    ["VAPID_PUBLIC_KEY", publicKey],
    ["VAPID_PRIVATE_KEY", privateKey],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing edge function secret(s): ${missing.join(", ")}`);
  }

  let derived: string;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKey!, "base64url"));
    derived = ecdh.getPublicKey().toString("base64url");
  } catch (err) {
    throw new Error(
      `VAPID_PRIVATE_KEY is not a usable P-256 private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (derived !== publicKey) {
    throw new Error(
      "VAPID keypair mismatch: VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY. " +
        `Stored public key starts "${publicKey!.slice(0, 8)}", the private key implies "${derived.slice(0, 8)}". ` +
        "The browser subscribed against REACT_APP_VAPID_PUBLIC_KEY, so all three must be the same pair.",
    );
  }

  webpush.setVapidDetails(subject!, publicKey!, privateKey!);
  return { subject, publicKey, privateKey };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // JWT verification is on, so an unauthenticated request never reaches this
  // code — but the header is still needed to build the client, and a clear
  // message beats a null-deref if that ever changes.
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Missing authorization header" }, 401);
  }

  // Body is optional: an empty POST is the common case from curl.
  let title = DEFAULT_TITLE;
  let body = DEFAULT_BODY;
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.title === "string" && parsed.title) title = parsed.title;
      if (typeof parsed.body === "string" && parsed.body) body = parsed.body;
    }
  } catch {
    // No body, or not JSON. The defaults are the whole point of the defaults.
  }

  try {
    loadVapid();
  } catch (err) {
    // Configuration, not a transient failure — say exactly what is wrong,
    // because this is read on a phone.
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  // Request-scoped client: the caller's token rides on every query, so RLS
  // returns their rows and only their rows. No .eq("user_id", ...) is needed
  // and adding one would imply the filtering lives here rather than in the
  // policy.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: subscriptions, error: readError } = await supabase
    .from(TABLE)
    .select("id, endpoint, p256dh, auth_key");

  if (readError) {
    return json({ error: `Could not read subscriptions: ${readError.message}` }, 500);
  }
  if (!subscriptions || subscriptions.length === 0) {
    return json({
      sent: 0,
      failed: 0,
      removed: 0,
      results: [],
      note: "No push subscriptions for this user — subscribe on the device first.",
    });
  }

  const payload = JSON.stringify({ title, body, tag: "alfred-push" });

  // Sent in parallel: one dead endpoint should not delay the others, and the
  // per-endpoint result is reported either way.
  const results = await Promise.all(
    subscriptions.map(async (row) => {
      const tail = `…${String(row.endpoint).slice(-20)}`;
      try {
        const res = await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth_key },
          },
          payload,
          { TTL: 60 },
        );

        // Success: record that this device was reachable just now.
        const { error: touchError } = await supabase
          .from(TABLE)
          .update({ last_used_at: new Date().toISOString() })
          .eq("endpoint", row.endpoint);

        return {
          endpoint_tail: tail,
          status: res?.statusCode ?? 201,
          ok: true,
          removed: false,
          ...(touchError ? { last_used_at_error: touchError.message } : {}),
        };
      } catch (err) {
        const e = err as { statusCode?: number; body?: string; message?: string };
        const status = typeof e.statusCode === "number" ? e.statusCode : null;

        // Dead endpoint: the row is now garbage and will fail forever. Delete
        // it. Any other failure leaves the row alone — a 429 or a 503 is the
        // push service having a moment, not the phone going away.
        let removed = false;
        let removeError: string | undefined;
        if (status !== null && DEAD_STATUS.has(status)) {
          const { error: delError } = await supabase
            .from(TABLE)
            .delete()
            .eq("endpoint", row.endpoint);
          if (delError) removeError = delError.message;
          else removed = true;
        }

        return {
          endpoint_tail: tail,
          status,
          ok: false,
          removed,
          error: e.message ?? String(err),
          // The push service's own explanation, when it gives one.
          ...(e.body ? { service_body: String(e.body).slice(0, 300) } : {}),
          ...(removeError ? { remove_error: removeError } : {}),
        };
      }
    }),
  );

  const sent = results.filter((r) => r.ok).length;

  // 200 even when individual sends failed: the function did its job and the
  // per-endpoint detail is the answer. A blanket 500 would hide which device
  // failed, which is the one thing worth knowing here.
  return json({
    sent,
    failed: results.length - sent,
    removed: results.filter((r) => r.removed).length,
    title,
    body,
    results,
  });
});
