// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";

// --- User Mapping ---
// Maps the To address pattern to a user email for lookup in auth.users
// When email arrives at alex.warren+elise+alfred@secorus.com → Elise
// When email arrives at alex.warren+alfred@secorus.com → Alex
interface UserMapping {
  pattern: RegExp;
  userEmail: string;
  label: string;
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
];

// --- Helper: Resolve user_id from To address ---
async function resolveUserId(
  toAddress: string,
  serviceClient: ReturnType<typeof createServiceClient>
): Promise<{ userId: string; label: string } | null> {
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
        return { userId: user.id, label: mapping.label };
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

  // Build source_metadata
  const sourceMetadata = {
    from: payload.From,
    fromName: payload.FromName,
    subject: payload.Subject,
    messageId: payload.MessageID,
    date: payload.Date,
    originalRecipient: toAddress,
    to: payload.To,
  };

  // Insert inbox record
  const inboxRecord = {
    id: crypto.randomUUID(),
    created_at: Date.now(),
    archived: false,
    triaged_at: null,
    captured_text: capturedText,
    user_id: userResult.userId,
    source_type: "email",
    source_metadata: sourceMetadata,
    ai_status: "not_started",
    // All suggested_* fields left as defaults (null/false/[])
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
