// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import { buildCapture, checkWebhookToken } from "./parse.ts";

// --- User Mapping ---
// Maps the To address pattern to a user email for lookup in auth.users
// When email arrives at alex.warren+elise+alfred@secorus.com → Elise
// When email arrives at alex.warren+alfred@secorus.com → Alex
// When email arrives at recipes@secorus.com → Alex, tagged as the recipes address
// When email arrives at alfred@secorus.com → Alex
//
// The recipient decides WHOSE inbox a capture lands in. It does not decide
// whether the mail is accepted at all — that is FROM_ALLOWLIST, below.
//
// `captureAddress` is optional. When a mapping sets it, the value is written to
// the inbox row's source_metadata as `capture_address`, so enrichment can tell
// which address the mail came in on — a recipes@ capture is a recipe. Mappings
// without it produce rows exactly as before.
//
// Every pattern carries /i, so addresses match case-insensitively.
interface UserMapping {
  pattern: RegExp;
  userEmail: string;
  label: string;
  captureAddress?: string;
}

const USER_MAPPINGS: UserMapping[] = [
  // Order matters — more specific patterns first
  {
    pattern: /alex\.warren\+elise\+alfred@secorus\.com/i,
    label: "Elise",
    userEmail: "enhdesigns@gmail.com",
  },
  {
    pattern: /alex\.warren\+alfred@secorus\.com/i,
    label: "Alex",
    userEmail: "alexanderjameswarren@gmail.com",
  },
  {
    pattern: /recipes@secorus\.com/i,
    label: "Alex",
    userEmail: "alexanderjameswarren@gmail.com",
    captureAddress: "recipes",
  },
  // ⚠️ MUST STAY LAST. Every pattern here is an unanchored substring test,
  // and "alfred@secorus.com" is a substring of "alex.warren+alfred@secorus.com"
  // and of "alex.warren+elise+alfred@secorus.com". Move this entry up and it
  // swallows both plus-tag addresses — which would silently file Elise's mail
  // under Alex. It is harmless today only because it is last.
  {
    pattern: /alfred@secorus\.com/i,
    label: "Alex",
    userEmail: "alexanderjameswarren@gmail.com",
  },
];

// --- Sender Allowlist ---
// Mail is accepted only from these addresses. Matched case-insensitively
// against the sender, so add entries in whatever case reads best.
//
// This is a backstop, not the main gate. The main gate is the `token` in the
// Postmark webhook URL (EMAIL_CAPTURE_SECRET), checked first. Behind it, Gmail
// filters already route only these senders to the capture addresses.
//
// Forging a From header is easy, so this list is a filter, not authentication.
const FROM_ALLOWLIST: string[] = [
  "alexanderjameswarren@gmail.com",
  "alex.warren@secorus.com",
  "enhdesigns@gmail.com",
];

/**
 * Pull the bare email address out of a From value.
 *
 * Postmark gives a clean address in FromFull.Email, which is what the caller
 * passes first. The fallback parses the raw From header, which may arrive as
 * `Alex Warren <alex@example.com>` rather than a bare address — comparing that
 * whole string against the allowlist would reject a sender who is on it.
 */
function normaliseSenderAddress(from: string): string {
  const angled = from.match(/<([^>]+)>/);
  return (angled ? angled[1] : from).trim().toLowerCase();
}

function isSenderAllowed(sender: string): boolean {
  return FROM_ALLOWLIST.some((allowed) => allowed.toLowerCase() === sender);
}

// --- Helper: Resolve user_id from To address ---
async function resolveUserId(
  toAddress: string,
  serviceClient: ReturnType<typeof createServiceClient>
): Promise<{ userId: string; label: string; captureAddress?: string } | null> {
  for (const mapping of USER_MAPPINGS) {
    if (mapping.pattern.test(toAddress)) {
      // Look up user by email in auth.users
      const { data: { users }, error } = await serviceClient.auth.admin.listUsers();
      if (error) {
        console.error("[email-capture] Error listing users:", error.message);
        return null;
      }

      const user = users.find(
        (u) => u.email?.toLowerCase() === mapping.userEmail.toLowerCase()
      );

      if (user) {
        return {
          userId: user.id,
          label: mapping.label,
          captureAddress: mapping.captureAddress,
        };
      } else {
        console.error(`[email-capture] No auth user found for email: ${mapping.userEmail}`);
        return null;
      }
    }
  }

  console.error(`[email-capture] No mapping found for To address: ${toAddress}`);
  return null;
}

// --- Postmark Webhook JSON shape (relevant fields) ---
interface PostmarkInboundPayload {
  From: string;
  FromName: string;
  FromFull: { Email: string; Name: string };
  To: string;
  ToFull: Array<{ Email: string; Name: string; MailboxHash: string }>;
  Cc: string;
  Subject: string;
  TextBody: string;
  HtmlBody: string;
  Date: string;
  MessageID: string;
  OriginalRecipient: string;
  Tag: string;
  StrippedTextReply: string;
}

// --- Main Handler ---

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Webhook secret, before anything else. Both failures answer non-2xx so a
  // genuine Postmark delivery is retried, not lost, while config catches up.
  const tokenVerdict = checkWebhookToken(req.url, Deno.env.get("EMAIL_CAPTURE_SECRET"));
  if (tokenVerdict === "missing_config") {
    console.error("[email-capture] EMAIL_CAPTURE_SECRET is not set");
    return new Response("Not configured", { status: 500 });
  }
  if (tokenVerdict === "bad_token") {
    console.warn("[email-capture] Rejected: missing or wrong token");
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse Postmark webhook payload
  let payload: PostmarkInboundPayload;
  try {
    payload = await req.json();
  } catch (e) {
    console.error("[email-capture] Failed to parse JSON:", e);
    return new Response("Invalid JSON", { status: 400 });
  }

  // Log for debugging
  console.log(`[email-capture] Received email from: ${payload.From}, subject: ${payload.Subject}`);

  // Extract the To address for user mapping
  // For Secorus forwarding: ToFull and To have the correct address
  // OriginalRecipient is Postmark's inbound address, so check it last
  console.log(`[email-capture] DEBUG - OriginalRecipient: ${payload.OriginalRecipient}`);
  console.log(`[email-capture] DEBUG - ToFull: ${JSON.stringify(payload.ToFull)}`);
  console.log(`[email-capture] DEBUG - To: ${payload.To}`);
  console.log(`[email-capture] DEBUG - From: ${payload.From}`);
  console.log(`[email-capture] DEBUG - Subject: ${payload.Subject}`);

  const toAddress =
    payload.ToFull?.[0]?.Email ||  // Check this first for Secorus forwarding
    payload.To ||                   // Fallback
    payload.OriginalRecipient ||    // Last resort
    "";

  console.log(`[email-capture] To address for mapping: ${toAddress}`);

  // Refuse unknown senders before doing any work. This sits ahead of user
  // resolution on purpose: a rejected sender should not cost a listUsers call,
  // and must never reach the insert.
  //
  // 200, not 4xx. Postmark retries a failure, and there is nothing transient
  // about a sender who is not on the list — a 4xx here would buy a retry storm
  // and an identical rejection each time. Same reasoning as the
  // unmappable-recipient response below.
  const sender = normaliseSenderAddress(payload.FromFull?.Email || payload.From || "");
  if (!isSenderAllowed(sender)) {
    console.warn(
      `[email-capture] Rejected: sender not on allowlist. From: ${sender || "(empty)"}, To: ${toAddress || "(empty)"}`
    );
    return new Response(JSON.stringify({
      success: false,
      error: "Sender not allowed",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Create service client (no user session available for webhooks)
  const serviceClient = createServiceClient();

  // Resolve user
  const userResult = await resolveUserId(toAddress, serviceClient);
  if (!userResult) {
    console.error(`[email-capture] Could not resolve user for: ${toAddress}`);
    // Return 200 so Postmark doesn't retry — this is a config issue, not transient
    return new Response(JSON.stringify({
      success: false,
      error: `Could not map email recipient to a user: ${toAddress}`,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[email-capture] Mapped to user: ${userResult.label} (${userResult.userId})`);

  // Build captured_text from subject + body. The forwarded block's headers come
  // back as `original`, so they land in source_metadata instead of being lost.
  const { capturedText, original } = buildCapture(payload.Subject, payload.TextBody);

  // Build source_metadata. `capture_address` and the original_* keys are added
  // only when present. `subject` stays raw, Fwd: and all.
  const sourceMetadata: Record<string, unknown> = {
    ...original,
    from: payload.From,
    fromName: payload.FromName,
    subject: payload.Subject,
    messageId: payload.MessageID,
    date: payload.Date,
    originalRecipient: toAddress,
    to: payload.To,
  };

  if (userResult.captureAddress) {
    sourceMetadata.capture_address = userResult.captureAddress;
  }

  // Insert inbox record
  const inboxRecord = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    archived: false,
    triaged_at: null,
    captured_text: capturedText,
    user_id: userResult.userId,
    source_type: "email",
    source_metadata: sourceMetadata,
    ai_status: "not_started",
    // All suggested_* fields left as defaults (null/false/empty). Nothing here
    // has been enriched yet — ai_status says so, and the hourly alfred-enrich
    // task fills them in.
    //
    // `suggested_tags` is sent explicitly rather than left to the column
    // default, so the shape of a fresh capture is readable here rather than in
    // the schema. It needs no normalising because there is nothing to
    // normalise, and it survived the jsonb -> text[] cutover (062) untouched:
    // an empty JS array is what PostgREST wants for either type.
    suggest_item: false,
    suggest_intent: false,
    suggest_event: false,
    suggested_tags: [],
  };

  const { data, error } = await serviceClient
    .from("inbox")
    .insert(inboxRecord)
    .select()
    .single();

  if (error) {
    console.error("[email-capture] Failed to insert inbox record:", error.message);
    // Return 500 so Postmark retries
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[email-capture] Inbox record created: ${data.id} for ${userResult.label}`);

  // Return 200 — enrichment is the hourly alfred-enrich task, not this function
  return new Response(JSON.stringify({
    success: true,
    inbox_id: data.id,
    user: userResult.label,
    captured_text_preview: capturedText.substring(0, 100),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
