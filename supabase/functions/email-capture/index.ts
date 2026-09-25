// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";

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
// This is a backstop, not the main gate. Gmail filters already route only these
// senders to the capture addresses, so in normal operation nothing reaches this
// check that would fail it. It exists because the endpoint has no shared secret
// (see the note on [functions.email-capture] in config.toml): anyone who learns
// the URL and an address shape could post a row into the inbox, and this turns
// that from "any stranger" into "any stranger who can also forge one of three
// From addresses".
//
// Forging a From header is easy, so this is a speed bump rather than
// authentication. If real protection is ever wanted, put a shared secret in the
// Postmark webhook URL — that is the cheap fix, and this list is not it.
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

// --- Helper: Clean up forwarded email text ---
function cleanEmailText(subject: string, textBody: string): string {
  let text = textBody || "";

  // Remove common forwarding headers
  text = text.replace(/^-+\s*Forwarded message\s*-+\s*/im, "");
  text = text.replace(/^From:.*$/im, "");
  text = text.replace(/^Date:.*$/im, "");
  text = text.replace(/^Subject:.*$/im, "");
  text = text.replace(/^To:.*$/im, "");
  text = text.replace(/^Cc:.*$/im, "");

  // Remove Gmail forwarding artifacts
  text = text.replace(/^>+\s*/gm, ""); // quoted lines
  text = text.replace(/\n{3,}/g, "\n\n"); // collapse multiple newlines

  text = text.trim();

  // Combine subject + body if both are meaningful
  const cleanSubject = subject
    ?.replace(/^(Fwd?|Fw):\s*/i, "") // strip Fwd: prefix
    ?.replace(/^(Re):\s*/i, "")       // strip Re: prefix
    ?.trim();

  if (cleanSubject && text) {
    return `${cleanSubject}\n\n${text}`;
  } else if (cleanSubject) {
    return cleanSubject;
  } else {
    return text || "(empty email)";
  }
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

  // Build captured_text from subject + body
  const capturedText = cleanEmailText(payload.Subject, payload.TextBody);

  // Build source_metadata. `capture_address` is added only for mappings that
  // name one, so rows from the existing addresses keep exactly the shape they
  // have always had.
  const sourceMetadata: Record<string, unknown> = {
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
    // has been enriched yet — ai_status says so, and ai-enrich fills them in.
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

  // Return 200 — ai-enrich will be triggered manually via the UI Enrich button
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
