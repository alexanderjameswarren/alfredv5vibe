// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";

// clip-capture — the Chrome extension's and the CLI's way into Alfred.
//
// Spec: docs/technical-spec-clipboard.md sections 3.3 and 4.1.
//
// ---------------------------------------------------------------------------
// 🛑 A SERVER-TO-SERVER EXCEPTION, LIKE email-capture AND notify-dispatch
// ---------------------------------------------------------------------------
//
// This is NOT an MCP tool. There is no `defineTool`, no `ctx.db`, no tier gate,
// and nothing from `_shared/platform.ts`. The platform rule that a tool reaches
// the database only through `ctx.db` does not apply, because there is no tool
// and no user token to build a scoped client from:
//
//   - The caller is a Chrome extension or a shell script. Neither holds a
//     Supabase session. Spec decision 5 rules out a pasted login token because
//     those expire in about an hour, and rules out the email-capture pattern
//     because that has no secret at all.
//   - So authentication is a dedicated long-lived shared secret in
//     `x-clipboard-secret`, checked with the length-check plus `timingSafeEqual`
//     pattern from notify-dispatch, BEFORE any other work.
//   - And the client is the SERVICE ROLE, which bypasses RLS. That is required
//     twice over: to mint signed upload links, and to write rows on Alex's
//     behalf when no `auth.uid()` exists.
//
// ⚠️ BECAUSE RLS IS BYPASSED, EVERY WRITE BELOW MUST SET user_id EXPLICITLY,
// from CLIPBOARD_USER_ID. Nothing else will scope it. Same burden notify-dispatch
// carries, for the same reason.
//
// ⚠️ verify_jwt = false, DECLARED IN config.toml BEFORE THE FIRST DEPLOY. The
// CLI defaults the flag to TRUE when nothing declares it, and that flag has
// silently reset on redeploy in this project before. A reset here would 401
// every clip with no error anywhere the extension could show. Re-check after
// every deploy.
//
// ---------------------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------------------
//
//   POST /clip-capture/start   { slice_count }
//     -> { clip_id, uploads: [{ path, signed_url, token }] }
//
//     Mints a clip id and one single-use upload link per slice. WRITES NOTHING
//     TO THE DATABASE. Spec decision 7 (SAM's rule): upload first, record
//     second, so no row ever points at a file that is not there. A clip id
//     whose slices are never uploaded simply never becomes a row.
//
//     The extension uploads each slice with a plain PUT to `signed_url`:
//       fetch(signed_url, { method: "PUT", body: blob,
//                           headers: { "Content-Type": "image/jpeg" } })
//
//   POST /clip-capture/finish  { clip_id, source, url, title, page_text, links,
//                                slice_paths, page_width, page_height,
//                                screenshot_truncated, screenshot_note,
//                                capture_mode, run_tag, repo, branch,
//                                captured_at }
//     -> { clip_id, inbox_id, ... }
//
//     Verifies every listed slice is really in storage, then writes the clip
//     row, the inbox row, and the link between them. If any slice is missing it
//     fails and writes nothing.
//
//   CLI clips skip `start` entirely and POST straight to `finish` with
//   source "cli" and no slices.
//
// Oversized page text and link lists are truncated HERE, not refused — losing a
// clip because a page was large would be worse than clipping most of it. The
// row's `text_truncated` flag then tells Claude the text is incomplete.

const BUCKET = "clipboard";

/** Spec 3.2 and 4.1: two-digit slice numbering, 0 to 24 slices. */
const MAX_SLICES = 24;

/** Spec 3.1. Bytes, not characters — see truncateUtf8. */
const MAX_PAGE_TEXT_BYTES = 1024 * 1024;

/** Spec 3.1. */
const MAX_LINKS = 1000;

const VALID_SOURCES = ["clipboard", "cli"];

// ---------------------------------------------------------------------------
// Responses and CORS
// ---------------------------------------------------------------------------

/**
 * CORS headers for the caller's origin.
 *
 * The extension's origin is `chrome-extension://<id>`, and the id is not known
 * until the extension is loaded (Step 6), so the origin is reflected rather
 * than hard-coded — for chrome-extension origins only.
 *
 * ⚠️ THIS IS NOT THE SECURITY BOUNDARY AND MUST NOT BE READ AS ONE. CORS is a
 * rule browsers apply to themselves; curl, a script, and anything that is not a
 * browser ignore it entirely. `x-clipboard-secret` is what actually guards this
 * function. CORS is here only so the extension's fetch is not blocked.
 */
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = origin.startsWith("chrome-extension://") ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-clipboard-secret",
    "Access-Control-Max-Age": "86400",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

function fail(req: Request, status: number, error: string, extra: Record<string, unknown> = {}) {
  return json(req, { ok: false, error, ...extra }, status);
}

// ---------------------------------------------------------------------------
// Secret check — the whole of this function's authentication
// ---------------------------------------------------------------------------

/**
 * Constant-time secret comparison; false for absent or wrong-length input.
 *
 * Lifted from notify-dispatch deliberately, including the length pre-check:
 * `timingSafeEqual` THROWS on a length mismatch, and that throw would itself
 * leak the expected length through the error path.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `{user_id}/{clip_id}/slice-01.jpg` — spec 3.2. */
function slicePath(userId: string, clipId: string, index: number): string {
  return `${userId}/${clipId}/slice-${String(index).padStart(2, "0")}.jpg`;
}

/**
 * Truncate to a BYTE budget without splitting a character in half.
 *
 * `text.slice(n)` counts UTF-16 code units, which is not bytes: one emoji is
 * two units and four bytes. So this measures in bytes, cuts the byte array, and
 * lets a non-fatal TextDecoder turn any half-character at the boundary into
 * U+FFFD, which is then stripped. The result is always valid UTF-8 at or under
 * the cap.
 */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const cut = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes));
  return { text: cut.replace(/�$/, ""), truncated: true };
}

/**
 * Clean the link list: keep only usable `{text, href}` pairs, de-duplicate on
 * href, cap the count.
 *
 * `dropped` counts links lost to the CAP only — de-duplication is not loss, so
 * three links with two distinct hrefs give links_stored 2 and links_dropped 0.
 * This is the number a `links_truncated` column would be derived from.
 *
 * ⚠️ LINK TRUNCATION IS SILENT IN THE DATA MODEL. There is no `links_truncated`
 * column (spec 3.1 defines flags for text and screenshots only), so the count
 * dropped is reported in this call's response and nowhere else. A page with
 * more than 1,000 links is rare and the first 1,000 are the ones near the top,
 * but if "Claude missed a listing on a huge board" ever comes up, this is the
 * reason to look at first.
 */
function normaliseLinks(raw: unknown): { links: Array<{ text: string; href: string }>; dropped: number } {
  if (!Array.isArray(raw)) return { links: [], dropped: 0 };
  const seen = new Set<string>();
  const out: Array<{ text: string; href: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const href = (entry as { href?: unknown }).href;
    if (typeof href !== "string" || href.length === 0) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    if (out.length >= MAX_LINKS) continue;
    const textValue = (entry as { text?: unknown }).text;
    out.push({
      text: typeof textValue === "string" ? textValue.trim().slice(0, 500) : "",
      href,
    });
  }
  return { links: out, dropped: Math.max(0, seen.size - out.length) };
}

function asOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/** An ISO timestamp we are willing to store, or null to let the row default. */
function asTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// POST /start
// ---------------------------------------------------------------------------

async function handleStart(
  req: Request,
  client: ReturnType<typeof createServiceClient>,
  userId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const sliceCount = body.slice_count;
  if (
    typeof sliceCount !== "number" ||
    !Number.isInteger(sliceCount) ||
    sliceCount < 0 ||
    sliceCount > MAX_SLICES
  ) {
    return fail(
      req,
      400,
      `slice_count must be an integer from 0 to ${MAX_SLICES} (got ${JSON.stringify(sliceCount)}).`,
    );
  }

  // The id is minted here and the row is written by /finish. Nothing is
  // recorded yet, so an abandoned start costs nothing but a few unused links.
  const clipId = crypto.randomUUID();

  const uploads: Array<{ path: string; signed_url: string; token: string }> = [];
  for (let i = 1; i <= sliceCount; i++) {
    const path = slicePath(userId, clipId, i);
    const { data, error } = await client.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      return fail(
        req,
        500,
        `could not create an upload link for ${path}: ${error?.message ?? "no data returned"}`,
        { clip_id: clipId, created_links: uploads.length },
      );
    }
    uploads.push({ path, signed_url: data.signedUrl, token: data.token });
  }

  return json(req, {
    ok: true,
    clip_id: clipId,
    uploads,
    // Said explicitly because it is the contract the extension depends on:
    // nothing exists server-side until /finish succeeds.
    note:
      "Upload each slice with PUT to its signed_url (Content-Type: image/jpeg), " +
      "then POST /finish with the same clip_id and the paths you uploaded. " +
      "No database row exists until /finish.",
  });
}

// ---------------------------------------------------------------------------
// POST /finish
// ---------------------------------------------------------------------------

async function handleFinish(
  req: Request,
  client: ReturnType<typeof createServiceClient>,
  userId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  // --- source ---
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!VALID_SOURCES.includes(source)) {
    return fail(req, 400, `source must be one of ${VALID_SOURCES.join(", ")} (got ${JSON.stringify(body.source)}).`);
  }

  // --- clip id ---
  // A CLI clip skips /start, so it may not bring one; mint it here in that case.
  let clipId = typeof body.clip_id === "string" ? body.clip_id.trim() : "";
  if (clipId.length === 0) {
    if (source !== "cli") {
      return fail(req, 400, "clip_id is required for a clipboard clip — use the one /start returned.");
    }
    clipId = crypto.randomUUID();
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(clipId)) {
    return fail(req, 400, `clip_id must be a uuid (got ${JSON.stringify(body.clip_id)}).`);
  }

  // --- page text ---
  // An empty string is allowed: an image-only page has no text and should still
  // be clippable. Null/absent is not, because the column is NOT NULL.
  if (typeof body.page_text !== "string") {
    return fail(req, 400, "page_text must be a string (it may be empty, but not absent).");
  }
  const { text: pageText, truncated: textTruncated } = truncateUtf8(body.page_text, MAX_PAGE_TEXT_BYTES);

  // --- slices ---
  const rawSlices = body.slice_paths;
  let slicePaths: string[] = [];
  if (rawSlices !== undefined && rawSlices !== null) {
    if (!Array.isArray(rawSlices) || rawSlices.some((p) => typeof p !== "string")) {
      return fail(req, 400, "slice_paths must be an array of strings.");
    }
    slicePaths = rawSlices as string[];
  }
  if (slicePaths.length > MAX_SLICES) {
    return fail(req, 400, `slice_paths holds ${slicePaths.length} entries; the cap is ${MAX_SLICES}.`);
  }
  if (source === "cli" && slicePaths.length > 0) {
    return fail(req, 400, "a cli clip has no screenshot, so slice_paths must be empty.");
  }

  // ⚠️ EVERY PATH MUST SIT UNDER THIS CLIP'S OWN FOLDER. Cheap, and it is what
  // stops a malformed or mischievous caller recording a row that points at
  // somebody else's object — the service role would happily read it, and the
  // read policy on the bucket would never be consulted.
  const prefix = `${userId}/${clipId}/`;
  const strays = slicePaths.filter((p) => !p.startsWith(prefix));
  if (strays.length > 0) {
    return fail(req, 400, `every slice path must start with ${prefix}. Offending: ${strays.slice(0, 3).join(", ")}`);
  }

  // --- verify the slices are really in storage (spec decision 7) ---
  if (slicePaths.length > 0) {
    const { data: listed, error: listError } = await client.storage
      .from(BUCKET)
      .list(`${userId}/${clipId}`, { limit: MAX_SLICES + 1 });
    if (listError) {
      return fail(req, 500, `could not list ${BUCKET}/${userId}/${clipId} to verify the slices: ${listError.message}`);
    }
    const present = new Set((listed ?? []).map((o) => o.name));
    const missing = slicePaths.filter((p) => !present.has(p.slice(prefix.length)));
    if (missing.length > 0) {
      // NOTHING IS WRITTEN. The caller should re-upload and call finish again;
      // the clip id and its upload links are still valid.
      return fail(req, 409, "some slices are not in storage, so nothing was written.", {
        clip_id: clipId,
        missing,
        found: [...present].sort(),
      });
    }
  }

  // --- the rest of the payload ---
  const url = asOptionalText(body.url);
  const titleGiven = asOptionalText(body.title);
  const title = titleGiven ?? url ?? "(untitled)";
  const { links, dropped: linksDropped } = normaliseLinks(body.links);
  const screenshotTruncated = body.screenshot_truncated === true;
  // One sentence from the extension saying what the screenshot actually is, and
  // when it is incomplete, WHY. Stored on the inbox row rather than on `clips`
  // because it needs no schema change and the inbox row is what a conversation
  // reaches first. Capped: it is a sentence or three, and an unbounded string
  // from a client has no business going into a jsonb column unchecked.
  const screenshotNote = typeof body.screenshot_note === "string"
    ? body.screenshot_note.trim().slice(0, 1000)
    : null;

  // 'visible' = one photograph of what was on screen, the silent everyday mode.
  // 'full'    = the whole page, stitched from per-tile captures.
  //
  // Stored as its own field rather than left to be inferred from slice_count,
  // because a one-slice visible capture and a one-slice short page are
  // indistinguishable otherwise — and confusing them means telling Alex a clip
  // shows a whole page when it shows the top of one.
  const captureMode = body.capture_mode === "full" || body.capture_mode === "visible"
    ? body.capture_mode
    : null;

  // --- which CLI run this came from ---------------------------------------
  //
  // Alex often has two or three CLI sessions going at once. "CLI responded" in a
  // claude.ai thread has to find the report from THAT conversation's prompt, not
  // whichever run finished most recently, so every prompt carries a run tag and
  // the report carries it back.
  //
  // ⚠️ VALIDATED HERE TOO, not just in clip.mjs. The script is one caller of a
  // public endpoint; anything reaching this function may have come from
  // somewhere else, and a tag is only useful if it matches exactly. A malformed
  // one is dropped rather than stored, because a stored-but-unmatchable tag
  // looks like a working one.
  const runTag = typeof body.run_tag === "string" && /^[a-z0-9-]{1,40}$/.test(body.run_tag.trim())
    ? body.run_tag.trim()
    : null;

  // Where it ran. Context rather than identity, so these are trimmed and capped
  // and never validated beyond that — a branch name can hold almost anything.
  const repo = typeof body.repo === "string" ? body.repo.trim().slice(0, 120) || null : null;
  const branch = typeof body.branch === "string" ? body.branch.trim().slice(0, 200) || null : null;
  const pageWidth = asOptionalInt(body.page_width);
  const pageHeight = asOptionalInt(body.page_height);
  const capturedAt = asTimestamp(body.captured_at) ?? new Date().toISOString();

  // --- 1. the clip row. slice_count is GENERATED; do not send it. ---
  const { data: clip, error: clipError } = await client
    .from("clips")
    .insert({
      id: clipId,
      user_id: userId,
      source,
      url,
      title,
      page_text: pageText,
      text_truncated: textTruncated,
      links,
      // Set from the count normaliseLinks already computed. De-duplication is
      // NOT truncation — three links with two distinct addresses leave this
      // false — so this is true only when the 1,000 cap actually dropped
      // something. Migration 067 added the column; until now the number was
      // reported in the response and recorded nowhere.
      links_truncated: linksDropped > 0,
      slice_paths: slicePaths,
      screenshot_truncated: screenshotTruncated,
      page_width: pageWidth,
      page_height: pageHeight,
      captured_at: capturedAt,
    })
    .select("id, slice_count")
    .single();

  if (clipError || !clip) {
    return fail(req, 500, `could not write the clip row: ${clipError?.message ?? "no row returned"}`, {
      clip_id: clipId,
    });
  }

  // --- 2. the paired inbox row (spec 3.3) ---
  //
  // Written explicitly rather than leaning on column defaults, matching
  // email-capture: the shape of a fresh capture is readable here instead of in
  // the schema. `id` has no default and the column is text, so it is minted
  // here; `user_id` must be set because there is no auth.uid() under the
  // service role.
  const inboxId = crypto.randomUUID();
  const capturedTextLine = source === "cli"
    ? `CLI report: ${title}`
    : `Clip: ${title}${url ? ` — ${url}` : ""}`;

  const { error: inboxError } = await client.from("inbox").insert({
    id: inboxId,
    user_id: userId,
    archived: false,
    triaged_at: null,
    captured_text: capturedTextLine,
    source_type: source,
    source_metadata: {
      clip_id: clipId,
      url,
      slice_count: slicePaths.length,
      ...(screenshotNote ? { screenshot_note: screenshotNote } : {}),
      ...(captureMode ? { capture_mode: captureMode } : {}),
      ...(runTag ? { run_tag: runTag } : {}),
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
    },
    ai_status: "not_started",
    suggest_item: false,
    suggest_intent: false,
    suggest_event: false,
    suggested_tags: [],
  });

  if (inboxError) {
    // ⚠️ ROLL THE CLIP BACK. A clip with no inbox row is invisible: the inbox is
    // how a clip is ever mentioned to Alex or to Claude, so a clip without one
    // is worse than no clip — it is silent. Deleting it leaves the caller free
    // to retry cleanly.
    //
    // The uploaded slices STAY in storage, orphaned. That is the accepted cost
    // (spec decision 10 defers all deletion), and a retried finish uploads to
    // the same paths anyway.
    const { error: rollbackError } = await client.from("clips").delete().eq("id", clipId);
    return fail(req, 500, `could not write the inbox row, so the clip was rolled back: ${inboxError.message}`, {
      clip_id: clipId,
      rollback: rollbackError ? `FAILED: ${rollbackError.message}` : "clip row deleted",
    });
  }

  // --- 3. link them ---
  const { error: linkError } = await client
    .from("clips")
    .update({ inbox_id: inboxId })
    .eq("id", clipId);

  // Deliberately NOT a failure. Both rows exist and are correct; only the
  // convenience pointer from clip to inbox is missing, and the inbox row's
  // source_metadata.clip_id already carries the link in the other direction, so
  // nothing is unrecoverable. Rolling back two good rows over this would be the
  // worse outcome.
  const warning = linkError
    ? `clip row written but clips.inbox_id could not be set (${linkError.message}). ` +
      `The pair is still linked via inbox.source_metadata.clip_id.`
    : null;

  return json(req, {
    ok: true,
    clip_id: clipId,
    inbox_id: inboxId,
    source,
    slice_count: clip.slice_count,
    text_truncated: textTruncated,
    screenshot_truncated: screenshotTruncated,
    links_stored: links.length,
    links_dropped: linksDropped,
    screenshot_note: screenshotNote,
    capture_mode: captureMode,
    run_tag: runTag,
    repo,
    branch,
    captured_at: capturedAt,
    ...(warning ? { warning } : {}),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  // Preflight first, and WITHOUT a secret check. A browser sends OPTIONS with no
  // custom headers, so demanding the secret here would block the extension
  // before it ever got to send one. The preflight response reveals nothing.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return fail(req, 405, "method not allowed; use POST.");
  }

  // 🛑 THE SECRET, BEFORE ANYTHING ELSE. Before the body is read, before the
  // route is resolved, before the database is touched.
  const expectedSecret = Deno.env.get("CLIPBOARD_SECRET");
  const userId = Deno.env.get("CLIPBOARD_USER_ID");
  if (!expectedSecret || expectedSecret.length < 32) {
    console.error("[clip-capture] CLIPBOARD_SECRET is missing or shorter than 32 characters");
    return fail(req, 500, "server is not configured: CLIPBOARD_SECRET missing or too short.");
  }
  if (!userId) {
    console.error("[clip-capture] CLIPBOARD_USER_ID is not set");
    return fail(req, 500, "server is not configured: CLIPBOARD_USER_ID missing.");
  }

  if (!secretMatches(req.headers.get("x-clipboard-secret"), expectedSecret)) {
    console.warn("[clip-capture] rejected: bad or missing x-clipboard-secret");
    // No detail. A rejection must not say whether the header was absent, the
    // wrong length, or simply wrong.
    return fail(req, 401, "unauthorized");
  }

  // Route on the last path segment. Supabase routes the whole path to the
  // function, so this sees "/clip-capture/start"; a bare "/clip-capture" has no
  // action and is answered with the list of endpoints rather than a bare 404.
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const action = segments[segments.length - 1] ?? "";

  if (action !== "start" && action !== "finish") {
    return fail(req, 404, `unknown endpoint "${action}". Use POST /clip-capture/start or POST /clip-capture/finish.`);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (e) {
    return fail(req, 400, `body must be JSON: ${(e as Error).message}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(req, 400, "body must be a JSON object.");
  }

  const client = createServiceClient();

  try {
    return action === "start"
      ? await handleStart(req, client, userId, body)
      : await handleFinish(req, client, userId, body);
  } catch (e) {
    console.error(`[clip-capture] unhandled error in /${action}:`, e);
    return fail(req, 500, `unhandled error in /${action}: ${(e as Error).message}`);
  }
});
