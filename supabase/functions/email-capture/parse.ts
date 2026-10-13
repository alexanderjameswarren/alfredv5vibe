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
