// email-capture Gmail branch — pure logic for mail posted by the Apps Script in
// alex.warren@secorus.com. No Deno APIs, no I/O, so gmail.test.mjs runs it under node --test.
// Spec: docs/technical-spec-gmail-capture.md.

import {
  buildCapture,
  domainOf,
  findCaptureHit,
  forwardHops,
  getHeader,
  googleForwardHop,
  normaliseSenderAddress,
  originalMessageId,
  type OriginalHeaders,
  type PostmarkHeader,
  safeEqual,
  type SecretVerdict,
  type UserMapping,
  USER_MAPPINGS,
} from "./parse.ts";

// --- Secret ---

/** The x-capture-secret header against GMAIL_CAPTURE_SECRET. */
export function checkCaptureSecret(header: string | null, secret: string | undefined): SecretVerdict {
  if (!secret) return "missing_config";
  return safeEqual(header ?? "", secret) ? "ok" : "bad_token";
}

// --- Payload ---

export interface GmailAttachment {
  name: string;
  type: string;
  size: number;
}

export interface GmailPayload {
  source: "gmail-script";
  gmail_id: string;
  thread_id?: string;
  gmail_link?: string;
  label_ids?: string[];
  labels?: string[];
  headers: PostmarkHeader[];
  text_body?: string;
  attachments?: GmailAttachment[];
  dry_run?: boolean;
}

/** The parts of the payload the function cannot work without. */
export function payloadProblem(p: unknown): string | null {
  const x = p as Partial<GmailPayload> | null;
  if (!x || typeof x !== "object") return "body is not an object";
  if (typeof x.gmail_id !== "string" || !x.gmail_id) return "gmail_id missing";
  if (!Array.isArray(x.headers)) return "headers missing";
  return null;
}

// --- Senders (email_capture_senders) ---

export interface CaptureSender {
  email: string;
  safe_sender: boolean;
  approved_forwarder: boolean;
}

function findSender(senders: CaptureSender[], address: string): CaptureSender | undefined {
  const a = address.trim().toLowerCase();
  return senders.find((s) => s.email.toLowerCase() === a);
}

// --- Addresses ---

/** Every bare address in an address-list header, lower-case. */
export function addressesIn(value: string | null | undefined): string[] {
  return ((value ?? "").match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? []).map((a) => a.toLowerCase());
}

/** To, Cc, then Gmail's own (first) Delivered-To: where a capture address can show. */
export function recipientAddresses(headers: PostmarkHeader[]): string[] {
  return [
    ...addressesIn(getHeader(headers, "To")),
    ...addressesIn(getHeader(headers, "Cc")),
    ...addressesIn(getHeader(headers, "Delivered-To")),
  ];
}

// --- Sender authentication ---

export interface AuthSummary {
  dmarc: string | null;
  dmarc_from: string | null;
  dkim: { result: string; domain: string }[];
  spf: string | null;
}

/**
 * Google's verdict on this delivery: the FIRST Authentication-Results, and only when its
 * authserv-id is mx.google.com. Google prepends its own, so a sender's copy sits lower.
 * A self-sent message has none.
 */
export function googleAuthResults(headers: PostmarkHeader[]): AuthSummary | null {
  const raw = getHeader(headers, "Authentication-Results");
  if (!raw) return null;
  const [servId, ...rest] = raw.split(";");
  if (servId.trim().toLowerCase() !== "mx.google.com") return null;
  // Comments go first: arc=pass (… dmarc=pass …) reports an earlier hop, not this one.
  const results = rest.join(";").replace(/\([^)]*\)/g, " ");
  const dmarc = /\bdmarc=(\w+)/i.exec(results);
  const dkim = [...results.matchAll(/\bdkim=(\w+)\s+header\.(?:i|d)=@?([^\s;]+)/gi)]
    .map((m) => ({ result: m[1].toLowerCase(), domain: m[2].toLowerCase() }));
  return {
    dmarc: dmarc?.[1].toLowerCase() ?? null,
    dmarc_from: /\bheader\.from=([^\s;]+)/i.exec(results)?.[1].toLowerCase() ?? null,
    dkim,
    spf: /\bspf=(\w+)/i.exec(results)?.[1].toLowerCase() ?? null,
  };
}

/** Same domain, or one a subdomain of the other (relaxed alignment). */
function aligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** dmarc=pass for the From domain, else dkim=pass aligned with it. `dara=` is not read. */
export function senderAuthenticated(from: string, auth: AuthSummary | null): boolean {
  if (!auth) return false;
  const domain = domainOf(from);
  if (auth.dmarc === "pass" && auth.dmarc_from === domain) return true;
  return auth.dkim.some((d) => d.result === "pass" && aligned(d.domain, domain));
}

// --- Decision ---

// Mail with no capture address was labelled in Alex's own mailbox: his inbox.
export const MAILBOX_USER = { userEmail: "alexanderjameswarren@gmail.com", label: "Alex" };

export type GmailVia = "no_capture_address" | "sent" | "safe_sender" | "forward";

export type GmailDecision =
  | {
    accept: true;
    userEmail: string;
    label: string;
    via: GmailVia;
    captureAddress?: string;
    captureHit?: string;
    forwarder?: string;
  }
  | { accept: false; reason: string; domain: string; captureHit?: string };

/**
 * The trust rule, in order (spec "Edge Function changes"):
 * 1. no capture address among To/Cc/Delivered-To → trusted, Alex's inbox;
 * 2. SENT among the Gmail label ids → trusted (only this mailbox sends it);
 * 3. a forwarding hop naming an account that is not an approved forwarder → reject;
 * 4. From is a safe sender and Google's results pass for it → accept;
 * 5. an approved forwarder's hop into a capture address → accept;
 * 6. reject.
 */
export function decideGmail(p: GmailPayload, senders: CaptureSender[]): GmailDecision {
  const headers = p.headers ?? [];
  const recipients = recipientAddresses(headers);
  const hit = findCaptureHit(recipients);
  if (!hit) return { accept: true, ...MAILBOX_USER, via: "no_capture_address" };

  const m: UserMapping = hit.mapping;
  const base = { userEmail: m.userEmail, label: m.label, captureAddress: m.captureAddress, captureHit: hit.address };
  if ((p.label_ids ?? []).includes("SENT")) return { accept: true, ...base, via: "sent" };

  const isForwarder = (a: string) => !!findSender(senders, a)?.approved_forwarder;
  const stranger = forwardHops(headers).find((h) => !isForwarder(h.account));
  if (stranger) {
    return { accept: false, reason: "forwarded_by_unknown_account", domain: domainOf(stranger.account), captureHit: hit.address };
  }

  const from = normaliseSenderAddress(getHeader(headers, "From") ?? "");
  if (findSender(senders, from)?.safe_sender) {
    if (senderAuthenticated(from, googleAuthResults(headers))) return { accept: true, ...base, via: "safe_sender" };
  }

  const captures = new Set(recipients.filter((a) => findCaptureHit([a])));
  const intoCapture = (h: { account: string; to: string } | null) => !!h && captures.has(h.to) && isForwarder(h.account);
  const google = googleForwardHop(headers);
  const hop = intoCapture(google) ? google : forwardHops(headers).find(intoCapture);
  if (hop) return { accept: true, ...base, via: "forward", forwarder: hop.account };

  const known = findSender(senders, from)?.safe_sender;
  return {
    accept: false,
    reason: known ? "sender_not_authenticated" : "sender_not_allowed",
    domain: domainOf(from),
    captureHit: hit.address,
  };
}

// --- Routing ---

// alfred/<child> label or alfred+<tag>@ → apps.id. Unknown children set no app.
export const APP_BY_TAG: Record<string, string> = {
  jobs: "jobs",
  wb: "warren_buffet",
  arnold: "arnold",
};

/** The app: an alfred/<child> label first, then an alfred+<tag>@ recipient. */
export function routeApp(labels: string[], recipients: string[]): { app: string | null; tag: string | null } {
  for (const l of labels) {
    const child = /^alfred\/([^/]+)/i.exec(l)?.[1]?.toLowerCase();
    if (child) return { app: APP_BY_TAG[child] ?? null, tag: child };
  }
  for (const r of recipients) {
    const tag = /^alfred\+([^@]+)@secorus\.com$/i.exec(r)?.[1]?.toLowerCase();
    if (tag) return { app: APP_BY_TAG[tag] ?? null, tag };
  }
  return { app: null, tag: null };
}

// --- Dedupe ---

export interface EmailRowStore {
  /** Id of an email row of this user whose source_metadata[key] = value; throws on a read error. */
  findEmailRow(userId: string, key: string, value: string): Promise<string | null>;
}

/**
 * The Gmail id (this path's messageId), then the original Message-ID, which also
 * catches mail already captured through Postmark. A failed lookup never blocks.
 */
export async function findDuplicate(
  store: EmailRowStore,
  userId: string,
  sourceMetadata: Record<string, unknown>,
): Promise<{ reason: string; inboxId: string } | null> {
  const keys: [string, string][] = [["gmail_id", "messageId"], ["original_message_id", "original_message_id"]];
  for (const [reason, key] of keys) {
    const value = sourceMetadata[key];
    if (typeof value !== "string" || !value) continue;
    try {
      const inboxId = await store.findEmailRow(userId, key, value);
      if (inboxId) return { reason, inboxId };
    } catch (e) {
      console.error(`[email-capture:gmail] ${key} lookup failed:`, e instanceof Error ? e.message : e);
    }
  }
  return null;
}

// --- Inbox row ---

/** captured_text, source_metadata and source_app for an accepted message. */
export function buildGmailRow(
  p: GmailPayload,
  d: Extract<GmailDecision, { accept: true }>,
): { capturedText: string; sourceMetadata: Record<string, unknown>; sourceApp: string | null; original: OriginalHeaders } {
  const h = p.headers ?? [];
  const subject = getHeader(h, "Subject") ?? "";
  const fromRaw = getHeader(h, "From") ?? "";
  const { capturedText, original } = buildCapture(subject, p.text_body ?? "");
  const route = routeApp(p.labels ?? [], recipientAddresses(h));
  const auth = googleAuthResults(h);
  const fromName = /^\s*"?([^"<]*?)"?\s*</.exec(fromRaw)?.[1]?.trim() ?? "";

  const sourceMetadata: Record<string, unknown> = {
    ...original,
    source: "gmail",
    from: normaliseSenderAddress(fromRaw),
    fromName,
    subject,
    date: getHeader(h, "Date"),
    to: getHeader(h, "To"),
    // messageId carries the Gmail id, so the (user_id, messageId) unique index dedupes it.
    messageId: p.gmail_id,
    gmail_id: p.gmail_id,
    thread_id: p.thread_id ?? null,
    gmail_link: p.gmail_link ?? null,
    labels: p.labels ?? [],
    sent: (p.label_ids ?? []).includes("SENT"),
    attachments: p.attachments ?? [],
    auth: auth ? { dmarc: auth.dmarc, dkim: auth.dkim, spf: auth.spf } : null,
    trust: d.via,
  };
  if (route.tag) sourceMetadata.alfred_tag = route.tag;
  if (d.captureAddress) sourceMetadata.capture_address = d.captureAddress;
  if (d.captureHit) sourceMetadata.capture_hit = d.captureHit;
  if (d.forwarder) {
    sourceMetadata.forwarder = d.forwarder;
    sourceMetadata.auto_forwarded = true;
  }
  const omid = originalMessageId(h);
  if (omid) sourceMetadata.original_message_id = omid;

  return { capturedText, sourceMetadata, sourceApp: route.app, original };
}
