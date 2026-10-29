// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import {
  buildCapture,
  checkWebhookToken,
  decideCapture,
  domainOf,
  getHeader,
  isUniqueViolation,
  NOTICE_USER_EMAIL,
  noticesEnabled,
  normaliseSenderAddress,
  originalMessageId,
  type NoticeStore,
  type PostmarkHeader,
  sendRejectionNotice,
} from "./parse.ts";
import {
  buildGmailRow,
  type CaptureSender,
  checkCaptureSecret,
  decideGmail,
  type EmailRowStore,
  findDuplicate,
  type GmailPayload,
  payloadProblem,
} from "./gmail.ts";

// USER_MAPPINGS, FROM_ALLOWLIST and the trusted auto-forward check live in
// parse.ts, pure, so parse.test.mjs covers them.

// --- Helper: auth user id for a mapped user email ---
async function lookupUserId(
  userEmail: string,
  serviceClient: ReturnType<typeof createServiceClient>
): Promise<string | null> {
  const { data: { users }, error } = await serviceClient.auth.admin.listUsers();
  if (error) {
    console.error("[email-capture] Error listing users:", error.message);
    return null;
  }
  const user = users.find((u) => u.email?.toLowerCase() === userEmail.toLowerCase());
  if (!user) {
    console.error(`[email-capture] No auth user found for a mapped user (${domainOf(userEmail)})`);
    return null;
  }
  return user.id;
}

// --- Postmark Webhook JSON shape (relevant fields) ---
interface PostmarkInboundPayload {
  From: string;
  FromName: string;
  FromFull: { Email: string; Name: string };
  To: string;
  ToFull: Array<{ Email: string; Name: string; MailboxHash: string }>;
  Cc: string;
  CcFull: Array<{ Email: string; Name: string; MailboxHash: string }>;
  Subject: string;
  TextBody: string;
  HtmlBody: string;
  Date: string;
  MessageID: string;
  OriginalRecipient: string;
  Tag: string;
  StrippedTextReply: string;
  Headers: PostmarkHeader[];
}

function duplicateResponse(reason: string, inboxId?: string): Response {
  console.log(`[email-capture] Duplicate (${reason}), no row created`);
  return new Response(JSON.stringify({
    success: true,
    duplicate: true,
    reason,
    inbox_id: inboxId ?? null,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Notice rows go to Alex's inbox, in the same table, with no messageId key.
function noticeStore(
  serviceClient: ReturnType<typeof createServiceClient>,
  userId: string,
): NoticeStore {
  return {
    async countNotices(fromAddress, day) {
      const { count, error } = await serviceClient
        .from("inbox")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("source_type", "email")
        .eq("source_metadata->>rejected", "true")
        .eq("source_metadata->>from_address", fromAddress)
        .eq("source_metadata->>notice_day", day);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async insertNotice(capturedText, sourceMetadata) {
      const { error } = await serviceClient.from("inbox").insert({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        archived: false,
        triaged_at: null,
        captured_text: capturedText,
        user_id: userId,
        source_type: "email",
        source_metadata: sourceMetadata,
        ai_status: "not_started",
        suggest_item: false,
        suggest_intent: false,
        suggest_event: false,
        suggested_tags: [],
      });
      if (error) throw new Error(error.message);
    },
  };
}

// A notice is best effort: any failure is logged and the rejection still
// answers 200, so Postmark never retries because of the notice.
async function noticeForRejection(
  reason: string,
  fromAddress: string,
  captureAddress: string | undefined,
  postmarkMessageId: string,
  gmail?: { gmailLink?: string; gmailId?: string },
): Promise<void> {
  try {
    const serviceClient = createServiceClient();
    const userId = await lookupUserId(NOTICE_USER_EMAIL, serviceClient);
    if (!userId) return;
    const outcome = await sendRejectionNotice(
      noticeStore(serviceClient, userId),
      { reason, fromAddress, captureAddress, postmarkMessageId, ...gmail },
      new Date(),
      noticesEnabled(Deno.env.get("EMAIL_CAPTURE_NOTICES")),
    );
    console.log(`[email-capture] Rejection notice: ${outcome}`);
  } catch (e) {
    console.error("[email-capture] Rejection notice failed:", e instanceof Error ? e.message : e);
  }
}

// 200, not 4xx, for every refusal after the token. Postmark retries a failure,
// and nothing about these is transient — a 4xx would buy a retry storm.
function rejectResponse(error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Gmail branch (gmail_capture-h3w) ---
// Called by the Apps Script in alex.warren@secorus.com. Every answer the script
// should act on is 200 with a status; a 5xx means "leave it, retry next run".
// Spec: docs/technical-spec-gmail-capture.md.

function emailRowStore(serviceClient: ReturnType<typeof createServiceClient>): EmailRowStore {
  return {
    async findEmailRow(userId, key, value) {
      const { data, error } = await serviceClient
        .from("inbox")
        .select("id")
        .eq("user_id", userId)
        .eq("source_type", "email")
        .eq(`source_metadata->>${key}`, value)
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0]?.id ?? null;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function handleGmail(req: Request, secretHeader: string): Promise<Response> {
  const verdict = checkCaptureSecret(secretHeader, Deno.env.get("GMAIL_CAPTURE_SECRET"));
  if (verdict === "missing_config") {
    console.error("[email-capture:gmail] GMAIL_CAPTURE_SECRET is not set");
    return new Response("Not configured", { status: 500 });
  }
  if (verdict === "bad_token") {
    console.warn("[email-capture:gmail] Rejected: missing or wrong secret");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: GmailPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ success: false, status: "error", error: "Invalid JSON" }, 400);
  }
  const problem = payloadProblem(payload);
  if (problem) return json({ success: false, status: "error", error: problem }, 400);
  const dryRun = payload.dry_run === true;

  const serviceClient = createServiceClient();
  const { data: senders, error: sendersError } = await serviceClient
    .from("email_capture_senders")
    .select("email, safe_sender, approved_forwarder");
  if (sendersError) {
    console.error("[email-capture:gmail] email_capture_senders read failed:", sendersError.message);
    return json({ success: false, status: "error", error: "senders unavailable" }, 500);
  }

  const decision = decideGmail(payload, (senders ?? []) as CaptureSender[]);
  const from = normaliseSenderAddress(getHeader(payload.headers, "From") ?? "");
  const tag = dryRun ? "Dry run" : "Received";

  if (!decision.accept) {
    console.warn(`[email-capture:gmail] ${tag}: rejected ${decision.reason} (domain ${decision.domain})`);
    if (!dryRun) {
      await noticeForRejection(decision.reason, from, decision.captureHit, "", {
        gmailLink: payload.gmail_link,
        gmailId: payload.gmail_id,
      });
    }
    return json({ success: true, status: "rejected", reason: decision.reason, dry_run: dryRun });
  }
  console.log(`[email-capture:gmail] ${tag}: accepted via ${decision.via} (from domain ${domainOf(from)})`);

  const userId = await lookupUserId(decision.userEmail, serviceClient);
  if (!userId) return json({ success: false, status: "error", error: "Could not map to a user" }, 500);

  const row = buildGmailRow(payload, decision);

  const dup = await findDuplicate(emailRowStore(serviceClient), userId, row.sourceMetadata);
  if (dup) {
    console.log(`[email-capture:gmail] Duplicate (${dup.reason})`);
    return json({ success: true, status: "duplicate", reason: dup.reason, inbox_id: dup.inboxId, dry_run: dryRun });
  }

  if (dryRun) {
    return json({
      success: true,
      status: "captured",
      dry_run: true,
      user: decision.label,
      via: decision.via,
      forwarder: decision.forwarder ?? null,
      capture_address: decision.captureHit ?? null,
      source_app: row.sourceApp,
      captured_text_preview: row.capturedText.substring(0, 100),
    });
  }

  const { data, error } = await serviceClient
    .from("inbox")
    .insert({
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      archived: false,
      triaged_at: null,
      captured_text: row.capturedText,
      user_id: userId,
      source_type: "email",
      source_metadata: row.sourceMetadata,
      source_app: row.sourceApp,
      ai_status: "not_started",
      suggest_item: false,
      suggest_intent: false,
      suggest_event: false,
      suggested_tags: [],
    })
    .select("id")
    .single();

  if (isUniqueViolation(error)) {
    return json({ success: true, status: "duplicate", reason: "gmail_id" });
  }
  if (error) {
    console.error("[email-capture:gmail] Failed to insert inbox record:", error.message);
    return json({ success: false, status: "error", error: error.message }, 500);
  }

  console.log(`[email-capture:gmail] Inbox record created: ${data.id} for ${decision.label}`);
  return json({ success: true, status: "captured", inbox_id: data.id, user: decision.label, source_app: row.sourceApp });
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

  // The Apps Script sends x-capture-secret; Postmark cannot send headers, so
  // its ?token= branch below is untouched.
  const captureSecret = req.headers.get("x-capture-secret");
  if (captureSecret !== null) return await handleGmail(req, captureSecret);

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

  // Recipient candidates, in order. ToFull[0] first for Secorus forwarding;
  // OriginalRecipient is Postmark's inbound address, so it comes last.
  const toAddress =
    payload.ToFull?.[0]?.Email ||
    payload.To ||
    payload.OriginalRecipient ||
    "";
  const recipients = [
    toAddress,
    ...(payload.ToFull ?? []).slice(1).map((t) => t?.Email ?? ""),
    payload.To ?? "",
    ...(payload.CcFull ?? []).map((c) => c?.Email ?? ""),
    payload.Cc ?? "",
  ].filter(Boolean);

  const sender = normaliseSenderAddress(payload.FromFull?.Email || payload.From || "");

  // Logs carry domains and reasons only — no content, no full addresses.
  console.log(
    `[email-capture] Received: from domain ${domainOf(sender)}, to domain ${domainOf(toAddress)}`
  );

  // Rule 1: a capture address among the recipients needs an allowlisted From.
  // Rule 2: otherwise a trusted Gmail auto-forward by an allowlisted account.
  // Spec: docs/technical-spec-email-capture.md, "Who gets in".
  const decision = decideCapture(sender, recipients, payload.Headers);
  if (!decision.accept) {
    console.warn(`[email-capture] Rejected: ${decision.reason} (domain ${decision.domain})`);
    await noticeForRejection(decision.reason, sender, decision.captureHit, payload.MessageID ?? "");
    return rejectResponse(
      decision.reason === "no_mapping" ? "Could not map email recipient to a user" : "Sender not allowed"
    );
  }

  // Create service client (no user session available for webhooks)
  const serviceClient = createServiceClient();

  const userId = await lookupUserId(decision.userEmail, serviceClient);
  if (!userId) {
    // Config issue, not transient
    return rejectResponse("Could not map email recipient to a user");
  }

  console.log(`[email-capture] Mapped to user: ${decision.label} (${userId}) via ${decision.via}`);

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

  if (decision.captureAddress) {
    sourceMetadata.capture_address = decision.captureAddress;
  }
  if (decision.via === "forward") {
    sourceMetadata.auto_forwarded = true;
  }

  // Same mail auto-forwarded twice: same Message-Id, different Postmark
  // MessageID. Checked in code, not indexed; a lookup failure never blocks
  // the capture.
  const originalId = originalMessageId(payload.Headers);
  if (originalId) {
    sourceMetadata.original_message_id = originalId;
    const { data: existing, error: lookupError } = await serviceClient
      .from("inbox")
      .select("id")
      .eq("user_id", userId)
      .eq("source_type", "email")
      .eq("source_metadata->>original_message_id", originalId)
      .limit(1);
    if (lookupError) {
      console.error("[email-capture] original_message_id lookup failed:", lookupError.message);
    } else if (existing?.length) {
      return duplicateResponse("original_message_id", existing[0].id);
    }
  }

  // Insert inbox record
  const inboxRecord = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    archived: false,
    triaged_at: null,
    captured_text: capturedText,
    user_id: userId,
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

  // A Postmark retry of a delivery already stored: the unique index on
  // (user_id, messageId) refuses it. 200 so Postmark stops retrying.
  if (isUniqueViolation(error)) {
    return duplicateResponse("postmark_message_id");
  }

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

  console.log(`[email-capture] Inbox record created: ${data.id} for ${decision.label}`);

  // Return 200 — enrichment is the hourly alfred-enrich task, not this function
  return new Response(JSON.stringify({
    success: true,
    inbox_id: data.id,
    user: decision.label,
    captured_text_preview: capturedText.substring(0, 100),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
