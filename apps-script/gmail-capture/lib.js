// Gmail capture — pure logic, shared by Code.js in Apps Script and lib.test.mjs under node.
// Function declarations and var only: Apps Script shares one global scope, and the test
// loads this file with node:vm, which exposes only those.
// Spec: docs/technical-spec-gmail-capture.md.

var CAPTURE_LABEL = "alfred";
var DONE_LABEL = "forwarded";
var REJECTED_LABEL = "forwarded/rejected";
var MAX_BODY_CHARS = 100000;

/** A label name as Gmail search spells it: lower case, "/" and spaces become "-". */
function searchLabelName(name) {
  return String(name).toLowerCase().replace(/[\s/]+/g, "-");
}

/** Every label that means "send to Alfred": alfred itself and any alfred/<child>. */
function captureLabels(labelNames) {
  var out = [CAPTURE_LABEL];
  (labelNames || []).forEach(function (n) {
    if (String(n).toLowerCase().indexOf(CAPTURE_LABEL + "/") === 0 && out.indexOf(n) === -1) out.push(n);
  });
  return out;
}

/** Epoch seconds from START_DATE (ISO date or date-time). Throws on a bad value. */
function startSeconds(startDate) {
  var ms = Date.parse(startDate);
  if (!startDate || isNaN(ms)) throw new Error("START_DATE is missing or not a date: " + startDate);
  return Math.floor(ms / 1000);
}

/**
 * The search, rebuilt each run. label:x does not include x's children, so both
 * forwarded and forwarded-rejected are excluded, and every alfred/ child is listed.
 * No in:inbox: a self-forward never reaches the inbox.
 */
function buildQuery(labelNames, startDate) {
  var labels = captureLabels(labelNames).map(function (n) { return "label:" + searchLabelName(n); });
  return "after:" + startSeconds(startDate) +
    " -label:" + searchLabelName(DONE_LABEL) +
    " -label:" + searchLabelName(REJECTED_LABEL) +
    " {" + labels.join(" ") + "}";
}

var KEPT_HEADER = /^(from|to|cc|date|subject|message-id|delivered-to|return-path|authentication-results|arc-authentication-results|received-spf|(x-)+forwarded-(for|to))$/i;

/** The headers the function reads, in their original order, as { Name, Value }. */
function pickHeaders(headers) {
  return (headers || [])
    .filter(function (h) { return h && KEPT_HEADER.test(h.name); })
    .map(function (h) { return { Name: h.name, Value: String(h.value || "") }; });
}

/** First header value with this name, case-insensitive (API shape: { name, value }). */
function headerValue(headers, name) {
  var want = name.toLowerCase();
  for (var i = 0; i < (headers || []).length; i++) {
    if (headers[i] && String(headers[i].name).toLowerCase() === want) return headers[i].value;
  }
  return null;
}

/** Walks a Gmail API payload's parts, depth first. */
function eachPart(part, fn) {
  if (!part) return;
  fn(part);
  (part.parts || []).forEach(function (p) { eachPart(p, fn); });
}

/** The charset from a part's Content-Type header, default UTF-8. */
function charsetOf(part) {
  var ct = headerValue(part && part.headers, "Content-Type") || "";
  var m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
  return m ? m[1] : "UTF-8";
}

/** The first text/plain body, else the first text/html, else null. */
function findBodyPart(payload) {
  var plain = null;
  var html = null;
  eachPart(payload, function (p) {
    if (p.filename) return;
    if (!p.body || !p.body.data) return;
    if (!plain && p.mimeType === "text/plain") plain = p;
    if (!html && p.mimeType === "text/html") html = p;
  });
  var part = plain || html;
  return part ? { data: part.body.data, html: !plain, charset: charsetOf(part) } : null;
}

/** base64url with its padding restored, for Utilities.base64DecodeWebSafe. */
function padBase64(data) {
  var s = String(data || "");
  return s + "===".slice((s.length + 3) % 4);
}

/**
 * Body text from findBodyPart's result. The Apps Script Gmail service hands
 * body.data over as bytes, already decoded; the REST API gives a base64url string.
 * Both are handled. `u` supplies fromBytes(bytes, charset) and fromBase64WebSafe(s, charset).
 */
function decodeBodyPart(part, u) {
  if (!part || !part.data) return "";
  var text = typeof part.data === "string"
    ? u.fromBase64WebSafe(padBase64(part.data), part.charset)
    : u.fromBytes(part.data, part.charset);
  return part.html ? htmlToText(text) : text;
}

/** Rough text from HTML, for mail with no text/plain part. */
function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Attachment metadata only: name, type, size. Never content. */
function attachmentsOf(payload) {
  var out = [];
  eachPart(payload, function (p) {
    if (p.filename) out.push({ name: p.filename, type: p.mimeType || "", size: (p.body && p.body.size) || 0 });
  });
  return out;
}

function gmailLink(account, id) {
  return "https://mail.google.com/mail/u/?authuser=" + encodeURIComponent(account) + "#all/" + id;
}

/**
 * The POST body for one message. `msg` is a Gmail API message (format full);
 * `labelNameById` maps label ids to names; `bodyText` is the decoded body.
 */
function buildPayload(msg, labelNameById, bodyText, account, dryRun) {
  var ids = msg.labelIds || [];
  return {
    source: "gmail-script",
    gmail_id: msg.id,
    thread_id: msg.threadId,
    gmail_link: gmailLink(account, msg.id),
    label_ids: ids,
    labels: ids.map(function (i) { return labelNameById[i]; }).filter(Boolean),
    headers: pickHeaders(msg.payload && msg.payload.headers),
    text_body: String(bodyText || "").slice(0, MAX_BODY_CHARS),
    attachments: attachmentsOf(msg.payload),
    dry_run: !!dryRun,
  };
}

/** True if a message with this RFC Message-ID was already handled this run; records it. */
function seenThisRun(seen, messageId) {
  if (!messageId) return false;
  var key = String(messageId).trim().toLowerCase();
  if (seen[key]) return true;
  seen[key] = true;
  return false;
}

/**
 * What to do with the message after the POST: "forwarded" (captured or duplicate),
 * "rejected", or "none" (anything else, including 5xx and network errors: retried next run).
 */
function actionFor(httpCode, bodyText) {
  if (httpCode !== 200) return "none";
  var body;
  try { body = JSON.parse(bodyText); } catch (e) { return "none"; }
  if (!body) return "none";
  if (body.status === "captured" || body.status === "duplicate") return "forwarded";
  if (body.status === "rejected") return "rejected";
  return "none";
}

/** One dry-run log line, no content: id | status | via or reason | app | sender domain. */
function dryRunLine(id, httpCode, bodyText, from) {
  var body = null;
  try { body = JSON.parse(bodyText); } catch (e) { /* not JSON */ }
  var domain = (String(from || "").match(/@([^>\s]+)/) || [])[1] || "?";
  if (httpCode !== 200 || !body) return [id, "HTTP " + httpCode, "-", "-", domain].join(" | ");
  return [id, body.status, body.via || body.reason || "-", body.source_app || "-", domain.toLowerCase()].join(" | ");
}

/** Labels to add for an action, given label ids for forwarded and forwarded/rejected. */
function labelChange(action, ids) {
  if (action === "forwarded") return { addLabelIds: [ids.forwarded], removeLabelIds: [] };
  if (action === "rejected") return { addLabelIds: [ids.rejected, "UNREAD", "INBOX"], removeLabelIds: [] };
  return null;
}
