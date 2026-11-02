// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import {
  domainOf,
  getHeader,
  isUniqueViolation,
  NOTICE_USER_EMAIL,
  noticesEnabled,
  normaliseSenderAddress,
  type NoticeStore,
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

// USER_MAPPINGS and the capture text live in parse.ts, the trust rule in gmail.ts,
// both pure, so parse.test.mjs and gmail.test.mjs cover them.

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
// answers 200, so the script still labels the message rejected.
async function noticeForRejection(
  reason: string,
  fromAddress: string,
  captureAddress: string | undefined,
  gmail: { gmailLink?: string; gmailId?: string },
): Promise<void> {
  try {
    const serviceClient = createServiceClient();
    const userId = await lookupUserId(NOTICE_USER_EMAIL, serviceClient);
    if (!userId) return;
    const outcome = await sendRejectionNotice(
      noticeStore(serviceClient, userId),
      { reason, fromAddress, captureAddress, ...gmail },
      new Date(),
      noticesEnabled(Deno.env.get("EMAIL_CAPTURE_NOTICES")),
    );
    console.log(`[email-capture] Rejection notice: ${outcome}`);
  } catch (e) {
    console.error("[email-capture] Rejection notice failed:", e instanceof Error ? e.message : e);
  }
}

// --- Gmail capture (gmail_capture-h3w) ---
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

async function handleGmail(req: Request, secretHeader: string | null): Promise<Response> {
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
      await noticeForRejection(decision.reason, from, decision.captureHit, {
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

  return await handleGmail(req, req.headers.get("x-capture-secret"));
});
