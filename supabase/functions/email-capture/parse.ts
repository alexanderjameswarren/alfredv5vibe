// email-capture parse — the pure logic of the email-capture Edge Function.
//
// No Deno APIs, no imports, no I/O, so parse.test.mjs can run it under node --test.
// Spec: docs/technical-spec-email-capture.md.

// --- Webhook secret ---

/** Constant-time string compare, so the token can't be guessed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SecretVerdict = "ok" | "missing_config" | "bad_token";

/**
 * Checks the `token` query parameter against the configured secret.
 * `missing_config` means the function has no secret set: the caller answers
 * 500 so Postmark retries, rather than accepting mail unauthenticated.
 */
export function checkWebhookToken(url: string, secret: string | undefined): SecretVerdict {
  if (!secret) return "missing_config";
  const token = new URL(url).searchParams.get("token") ?? "";
  return safeEqual(token, secret) ? "ok" : "bad_token";
}

// --- Dedupe ---

export interface PostmarkHeader {
  Name: string;
  Value: string;
}

/** First header with this name, case-insensitive. */
export function getHeader(headers: PostmarkHeader[] | null | undefined, name: string): string | null {
  const want = name.toLowerCase();
  const h = (headers ?? []).find((x) => x?.Name?.toLowerCase() === want);
  return h ? h.Value : null;
}

/**
 * The mail's own Message-Id, without angle brackets. Gmail auto-forwards keep
 * the original's, so it catches the same mail forwarded twice; a hand forward
 * has its own new one.
 */
export function originalMessageId(headers: PostmarkHeader[] | null | undefined): string | null {
  const raw = getHeader(headers, "Message-Id");
  const id = raw?.trim().replace(/^<|>$/g, "").trim();
  return id || null;
}

/** Postgres unique_violation: the dedupe index caught a second delivery. */
export function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505";
}

// --- User Mapping ---
// Maps the To address pattern to a user email for lookup in auth.users
// When email arrives at alex.warren+elise+alfred@secorus.com → Elise
// When email arrives at alex.warren+alfred@secorus.com → Alex
// When email arrives at recipes@secorus.com → Alex, tagged as the recipes address
// When email arrives at alfred@secorus.com → Alex
//
// A capture address decides WHOSE inbox a capture lands in (D2). Only a trusted
// auto-forward with no capture address falls back to FORWARDER_USERS.
//
// `captureAddress` is optional. When a mapping sets it, the value is written to
// the inbox row's source_metadata as `capture_address`, so enrichment can tell
// which address the mail came in on — a recipes@ capture is a recipe.
//
// Every pattern carries /i, so addresses match case-insensitively.
export interface UserMapping {
  pattern: RegExp;
  userEmail: string;
  label: string;
  captureAddress?: string;
}

export const USER_MAPPINGS: UserMapping[] = [
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
// Mail is accepted from these addresses, or as a trusted Gmail auto-forward BY
// one of them (checkAutoForward). The main gate is the webhook token; forging
// a From header is easy, so this list is a filter, not authentication.
export const FROM_ALLOWLIST: string[] = [
  "alexanderjameswarren@gmail.com",
  "alex.warren@secorus.com",
  "enhdesigns@gmail.com",
];

// Forwarding account → whose inbox, when no capture address matches (D2).
export const FORWARDER_USERS: Record<string, { userEmail: string; label: string }> = {
  "alexanderjameswarren@gmail.com": { userEmail: "alexanderjameswarren@gmail.com", label: "Alex" },
  "alex.warren@secorus.com": { userEmail: "alexanderjameswarren@gmail.com", label: "Alex" },
  "enhdesigns@gmail.com": { userEmail: "enhdesigns@gmail.com", label: "Elise" },
};

/** Bare lower-case address from `Name <a@b>` or `a@b`. */
export function normaliseSenderAddress(from: string): string {
  const angled = from.match(/<([^>]+)>/);
  return (angled ? angled[1] : from).trim().toLowerCase();
}

export function isSenderAllowed(sender: string): boolean {
  return FROM_ALLOWLIST.some((allowed) => allowed.toLowerCase() === sender);
}

export function domainOf(address: string | null | undefined): string {
  const at = (address ?? "").lastIndexOf("@");
  return at === -1 ? "(none)" : (address as string).slice(at + 1).replace(/>.*$/, "").toLowerCase();
}

/** First capture-address mapping, trying each address in order. */
export function findMapping(addresses: string[]): UserMapping | null {
  for (const address of addresses) {
    for (const mapping of USER_MAPPINGS) {
      if (mapping.pattern.test(address)) return mapping;
    }
  }
  return null;
}

// --- Trusted Gmail auto-forward ---

export type ForwardVerdict =
  | { trusted: true; account: string }
  | { trusted: false; reason: string; domain?: string };

const POSTMARK_RECEIVER = /\breceiver=p-pm-inbound/i;

/**
 * A mail from any sender, auto-forwarded by an allowlisted Gmail account.
 * Trusted only when Postmark's own SPF line — the first Received-SPF, the only
 * one naming a Postmark receiver — passes for a +caf_ Return-Path whose
 * account is allowlisted. X-Forwarded-For is a cross-check, never enough alone.
 * Spec: docs/technical-spec-email-capture.md, "Trusted auto-forward".
 */
export function checkAutoForward(headers: PostmarkHeader[] | null | undefined): ForwardVerdict {
  const returnPath = (getHeader(headers, "Return-Path") ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
  if (!returnPath) return { trusted: false, reason: "no_return_path" };

  const caf = /^([^@+\s]+)\+caf_=[^@\s]+@([^@\s]+)$/.exec(returnPath);
  if (!caf) return { trusted: false, reason: "return_path_not_caf", domain: domainOf(returnPath) };
  const account = `${caf[1]}@${caf[2]}`;
  if (!isSenderAllowed(account)) {
    return { trusted: false, reason: "forwarder_not_allowed", domain: caf[2] };
  }

  const spf = (headers ?? [])
    .filter((h) => h?.Name?.toLowerCase() === "received-spf")
    .map((h) => h.Value ?? "");
  if (!spf.length) return { trusted: false, reason: "no_spf", domain: caf[2] };
  const first = spf[0];
  if (!POSTMARK_RECEIVER.test(first)) return { trusted: false, reason: "first_spf_not_postmark", domain: caf[2] };
  if (spf.slice(1).some((v) => POSTMARK_RECEIVER.test(v))) {
    return { trusted: false, reason: "second_postmark_spf", domain: caf[2] };
  }
  if (!/^\s*pass\b/i.test(first)) return { trusted: false, reason: "spf_not_pass", domain: caf[2] };
  if (!/\bidentity=mailfrom\b/i.test(first)) return { trusted: false, reason: "spf_not_mailfrom", domain: caf[2] };
  const envelope = /\benvelope-from="?([^";\s]+)"?/i.exec(first)?.[1]?.toLowerCase();
  if (envelope !== returnPath) return { trusted: false, reason: "envelope_mismatch", domain: caf[2] };

  const xff = getHeader(headers, "X-Forwarded-For");
  if (xff && xff.trim().split(/\s+/)[0].toLowerCase() !== account) {
    return { trusted: false, reason: "xff_mismatch", domain: caf[2] };
  }
  return { trusted: true, account };
}

// --- Accept or not, and whose inbox ---

export type CaptureDecision =
  | {
    accept: true;
    userEmail: string;
    label: string;
    captureAddress?: string;
    via: "from" | "forward";
  }
  | { accept: false; reason: string; domain: string; captureHit?: string };

/** The first capture address among the recipients, and its mapping. */
export function findCaptureHit(addresses: string[]): { address: string; mapping: UserMapping } | null {
  for (const address of addresses) {
    for (const mapping of USER_MAPPINGS) {
      if (mapping.pattern.test(address)) return { address: normaliseSenderAddress(address), mapping };
    }
  }
  return null;
}

/** Every X-Forwarded-For hop: `<forwarding account> <forwarded-to>`. */
export function forwardHops(headers: PostmarkHeader[] | null | undefined): { account: string; to: string }[] {
  return (headers ?? [])
    .filter((h) => h?.Name?.toLowerCase() === "x-forwarded-for")
    .map((h) => {
      const [account = "", to = ""] = (h.Value ?? "").trim().toLowerCase().split(/\s+/);
      return { account, to };
    })
    .filter((hop) => hop.account);
}

/** First address of every X-Forwarded-For header: the accounts that forwarded it. */
export function forwardingAccounts(headers: PostmarkHeader[] | null | undefined): string[] {
  return forwardHops(headers).map((hop) => hop.account);
}

/**
 * `recipients`: ToFull, To, CcFull, Cc, in order. Gmail's own Delivered-To (the
 * first one; a sender's would sit lower) is added last, so a capture address in
 * Bcc still counts.
 *
 * Rule 1: a capture address is a recipient → accept if (a) the From is
 *   allowlisted, or (b) an earlier hop's X-Forwarded-For shows an allowlisted
 *   account forwarding to that same capture address (option A, decided risk:
 *   the header can be faked; see the spec).
 * Rule 2: otherwise a trusted auto-forward (checkAutoForward) is accepted.
 * Either way, any X-Forwarded-For naming a non-allowlisted account rejects.
 * Rejections carry a reason and one domain, never content or a full address.
 */
export function decideCapture(
  sender: string,
  recipients: string[],
  headers: PostmarkHeader[] | null | undefined,
): CaptureDecision {
  const deliveredTo = getHeader(headers, "Delivered-To");
  const addresses = [...recipients, ...(deliveredTo ? [deliveredTo] : [])].filter(Boolean);
  const hit = findCaptureHit(addresses);
  const captureHit = hit?.address;

  const stranger = forwardingAccounts(headers).find((a) => !isSenderAllowed(a));
  if (stranger) {
    return { accept: false, reason: "forwarded_by_unknown_account", domain: domainOf(stranger), captureHit };
  }

  const fromAllowed = isSenderAllowed(sender);
  if (hit) {
    const m = hit.mapping;
    if (fromAllowed) {
      return { accept: true, userEmail: m.userEmail, label: m.label, captureAddress: m.captureAddress, via: "from" };
    }
    // (b): the capture address's own filter hop forwards to Postmark, so a hop
    // whose forwarded-to IS the capture address can only be an earlier one.
    const allowedHop = forwardHops(headers).some((hop) => hop.to === hit.address && isSenderAllowed(hop.account));
    if (allowedHop) {
      return { accept: true, userEmail: m.userEmail, label: m.label, captureAddress: m.captureAddress, via: "forward" };
    }
    return { accept: false, reason: "capture_address_sender_not_allowed", domain: domainOf(sender), captureHit };
  }

  const forward = checkAutoForward(headers);
  if (forward.trusted) {
    const user = FORWARDER_USERS[forward.account];
    if (user) return { accept: true, userEmail: user.userEmail, label: user.label, via: "forward" };
  }
  if (!fromAllowed) {
    return {
      accept: false,
      reason: `sender_not_allowed:${forward.trusted ? "no_forwarder_user" : forward.reason}`,
      domain: domainOf(sender),
    };
  }
  return { accept: false, reason: "no_mapping", domain: domainOf(addresses[0]) };
}

// --- Rejection notices ---

export const POSTMARK_INBOUND_URL = "https://account.postmarkapp.com/servers/18272581/streams/inbound/messages/";
export const NOTICE_USER_EMAIL = "alexanderjameswarren@gmail.com";
const NOTICE_TIME_ZONE = "America/Los_Angeles";

/** Plain words for a rejection reason. */
export function plainReason(reason: string): string {
  if (reason === "capture_address_sender_not_allowed") return "the sender is not on the allowlist";
  if (reason === "forwarded_by_unknown_account") return "it was forwarded by an account that is not on the allowlist";
  if (reason === "no_mapping") return "no capture address or forwarding account matched a user";
  if (reason.startsWith("sender_not_allowed")) return "the sender is not on the allowlist and it is not a trusted auto-forward";
  return reason;
}

/** The Pacific calendar day, YYYY-MM-DD: the unit of the one-notice-a-day cap. */
export function noticeDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: NOTICE_TIME_ZONE }).format(now);
}

export interface RejectionInfo {
  reason: string;
  fromAddress: string;
  captureAddress?: string;
  postmarkMessageId: string;
}

/**
 * The notice row's text and metadata. Never the subject or body. The Postmark
 * id is stored as postmark_message_id, not messageId, so the dedupe index
 * (keyed on messageId) never blocks a notice.
 */
export function buildNotice(r: RejectionInfo, now: Date): { capturedText: string; sourceMetadata: Record<string, unknown> } {
  const from = r.fromAddress || "(no sender)";
  const capturedText =
    `Email blocked from ${from}: ${plainReason(r.reason)}. ` +
    `View it in Postmark: ${POSTMARK_INBOUND_URL}${r.postmarkMessageId} (also still in your secorus Gmail inbox).`;
  const sourceMetadata: Record<string, unknown> = {
    rejected: true,
    reason: r.reason,
    from_address: from,
    postmark_message_id: r.postmarkMessageId,
    notice_day: noticeDay(now),
  };
  if (r.captureAddress) sourceMetadata.capture_address = r.captureAddress;
  return { capturedText, sourceMetadata };
}

export interface NoticeStore {
  /** Notices already sent for this from_address on this notice_day. */
  countNotices(fromAddress: string, day: string): Promise<number>;
  insertNotice(capturedText: string, sourceMetadata: Record<string, unknown>): Promise<void>;
}

/** At most one notice per from_address per Pacific day; returns what it did. */
export async function sendRejectionNotice(
  store: NoticeStore,
  r: RejectionInfo,
  now: Date,
  enabled: boolean,
): Promise<"disabled" | "capped" | "sent"> {
  if (!enabled) return "disabled";
  const notice = buildNotice(r, now);
  const day = notice.sourceMetadata.notice_day as string;
  if ((await store.countNotices(notice.sourceMetadata.from_address as string, day)) > 0) return "capped";
  await store.insertNotice(notice.capturedText, notice.sourceMetadata);
  return "sent";
}

/** EMAIL_CAPTURE_NOTICES=off turns notices off; anything else, or unset, is on. */
export function noticesEnabled(setting: string | undefined): boolean {
  return (setting ?? "").trim().toLowerCase() !== "off";
}

// --- Subject ---

/** Strips every leading Fwd:/FW:/Fw:/Re: prefix, including stacked ones. */
export function cleanSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^(?:fwd?|re)\s*:\s*/i, "").trim();
  } while (s !== prev);
  return s;
}

// --- Signature ---

// Alex's signature: "--", "Thanks,", "Alex", only at the very end. Blank lines,
// CRLF, NBSP and zero-width characters between the lines are tolerated.
const GAP = "[\\s\\u00a0\\u200b\\u200c\\u200d\\ufeff]*";
const SIGNATURE = new RegExp(`(?:^|\\n)--${GAP}\\n${GAP}Thanks,${GAP}\\n${GAP}Alex${GAP}$`);

/** Strips the signature from the end, repeatedly: a forward of a forward carries two. */
export function stripSignature(text: string): string {
  let t = text.replace(/\r\n?/g, "\n");
  let prev;
  do {
    prev = t;
    t = t.replace(SIGNATURE, "").trimEnd();
  } while (t !== prev);
  return t;
}

// --- Gmail forwarded block ---

export interface OriginalHeaders {
  original_from?: string;
  original_date?: string;
  original_subject?: string;
  original_to?: string;
  original_cc?: string;
}

const MARKER = /^-+\s*Forwarded message\s*-+[ \t]*$/im;
const HEADER = /^(From|Date|Subject|To|Cc):\s*(.*)$/i;

/**
 * Removes the header lines of every Gmail "Forwarded message" block and returns
 * the INNERMOST block's From/Date/Subject/To/Cc — in a forward of a forward,
 * that is the real source. No block: the text comes back untouched.
 */
export function extractForwardedBlock(text: string): { original: OriginalHeaders; text: string } {
  let original: OriginalHeaders = {};
  let rest = text;
  for (;;) {
    const one = extractOneBlock(rest);
    if (!one) return { original, text: rest };
    if (Object.keys(one.original).length) original = one.original;
    rest = one.text;
  }
}

/**
 * The first block only: its headers, and the text with the marker and header
 * lines removed. A header Gmail wrapped onto a second line is joined back on.
 */
function extractOneBlock(text: string): { original: OriginalHeaders; text: string } | null {
  const m = MARKER.exec(text);
  if (!m) return null;

  const lines = text.slice(m.index + m[0].length).split("\n");
  if (lines[0] === "") lines.shift(); // the newline that ended the marker line
  const original: Record<string, string> = {};
  let last: string | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    const h = HEADER.exec(line);
    if (h) {
      last = `original_${h[1].toLowerCase()}`;
      original[last] = h[2].trim();
    } else if (last) {
      const sep = original[last].endsWith("<") ? "" : " ";
      original[last] = `${original[last]}${sep}${line.trim()}`.trim();
    } else {
      break;
    }
  }

  const before = text.slice(0, m.index);
  const after = lines.slice(i).join("\n");
  return { original: original as OriginalHeaders, text: `${before}${after}` };
}

// --- Captured text ---

/**
 * Subject + body for the inbox row. Removes the forwarded block, quote markers
 * and the trailing signature, and nothing else.
 */
export function buildCapture(
  subject: string | null | undefined,
  textBody: string | null | undefined,
): { capturedText: string; original: OriginalHeaders } {
  const normalised = (textBody ?? "").replace(/\r\n/g, "\n");
  const { original, text: withoutBlock } = extractForwardedBlock(normalised);

  let text = withoutBlock.replace(/^>+\s*/gm, ""); // quoted lines
  text = stripSignature(text.trim());
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  const name = cleanSubject(subject);
  const capturedText = name && text ? `${name}\n\n${text}` : name || text || "(empty email)";
  return { capturedText, original };
}
