import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// lib.js is plain Apps Script (no modules): run it in a context and read its globals.
const lib = vm.createContext({});
vm.runInContext(readFileSync(new URL("./lib.js", import.meta.url), "utf8"), lib);

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");

test("search label names", () => {
  assert.equal(lib.searchLabelName("alfred/jobs"), "alfred-jobs");
  assert.equal(lib.searchLabelName("forwarded/rejected"), "forwarded-rejected");
  assert.equal(lib.searchLabelName("Alfred/Big Ideas"), "alfred-big-ideas");
});

test("query: every alfred/ child, both exclusions, start date, no in:inbox", () => {
  const q = lib.buildQuery(["INBOX", "alfred", "alfred/jobs", "alfred/wb", "forwarded", "alfredo", "x/alfred/y"],
    "2026-10-29T12:00:00-07:00");
  assert.equal(q, "after:1793300400 -label:forwarded -label:forwarded-rejected {label:alfred label:alfred-jobs label:alfred-wb}");
  assert.ok(!/in:inbox/.test(q));
});

test("query with no alfred labels yet still names alfred", () => {
  assert.match(lib.buildQuery([], "2026-11-01"), /\{label:alfred\}$/);
});

test("bad START_DATE throws", () => {
  assert.throws(() => lib.buildQuery([], ""), /START_DATE/);
  assert.throws(() => lib.buildQuery([], "soon"), /START_DATE/);
});

// API-shaped message: the recon self-forward (SENT, no delivery headers).
const SELF = {
  id: "18f0a", threadId: "18f0a", labelIds: ["SENT", "Label_9"],
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "MIME-Version", value: "1.0" },
      { name: "Date", value: "Thu, 29 Oct 2026 10:46:39 -0700" },
      { name: "Message-ID", value: "<CAPTC2PiY2VvJZRB_zTJAawTzwHPk1rBW2iE3rd7vpr+cu9vzCQ@mail.gmail.com>" },
      { name: "Subject", value: "GCAP3 A self-forward" },
      { name: "From", value: "Alex Warren <alex.warren@secorus.com>" },
      { name: "To", value: "Alexander Warren <alfred@secorus.com>" },
      { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; d=secorus.com" },
      { name: "X-X-Forwarded-For", value: "a@b.com alfred@secorus.com" },
    ],
    parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: b64("hello"), size: 5 } },
        { mimeType: "text/html", body: { data: b64("<p>hello</p>"), size: 12 } },
      ] },
      { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x", size: 1234 } },
    ],
  },
};

test("headers kept in order, unwanted ones dropped, renamed forwarding kept", () => {
  const names = lib.pickHeaders(SELF.payload.headers).map((h) => h.Name);
  assert.deepEqual(names, ["Date", "Message-ID", "Subject", "From", "To", "X-X-Forwarded-For"]);
});

test("payload", () => {
  const p = lib.buildPayload(SELF, { Label_9: "forwarded", SENT: "SENT" }, "hello", "alex.warren@secorus.com", true);
  assert.equal(p.source, "gmail-script");
  assert.equal(p.gmail_id, "18f0a");
  assert.deepEqual(Array.from(p.label_ids), ["SENT", "Label_9"]);
  assert.deepEqual(Array.from(p.labels), ["SENT", "forwarded"]);
  assert.equal(p.gmail_link, "https://mail.google.com/mail/u/?authuser=alex.warren%40secorus.com#all/18f0a");
  assert.equal(p.text_body, "hello");
  assert.deepEqual(JSON.parse(JSON.stringify(p.attachments)), [{ name: "a.pdf", type: "application/pdf", size: 1234 }]);
  assert.equal(p.dry_run, true);
});

test("body part: plain first, html fallback, none", () => {
  const plain = lib.findBodyPart(SELF.payload);
  assert.equal(Buffer.from(plain.data, "base64url").toString(), "hello");
  assert.equal(plain.html, false);
  const htmlOnly = { mimeType: "text/html", body: { data: b64("<p>hi</p>") } };
  assert.equal(lib.findBodyPart(htmlOnly).html, true);
  assert.equal(lib.findBodyPart({ mimeType: "multipart/mixed", parts: [] }), null);
  assert.equal(lib.htmlToText("<p>a &amp; b</p><br>c<style>x{}</style>"), "a & b\n\nc");
});

// Node stand-ins for Utilities: bytes are signed like Java's, as Apps Script hands them over.
const U = {
  fromBytes: (bytes, charset) => Buffer.from(Int8Array.from(bytes).buffer).toString(charset.toLowerCase() === "iso-8859-1" ? "latin1" : "utf8"),
  fromBase64WebSafe: (s, charset) => {
    assert.match(s, /^[A-Za-z0-9_-]*={0,2}$/);
    assert.equal(s.length % 4, 0, "padded before decoding");
    return Buffer.from(s, "base64url").toString(charset.toLowerCase() === "iso-8859-1" ? "latin1" : "utf8");
  },
};

test("body decode: web-safe unpadded base64 string", () => {
  const data = "Q2Fmw6kgwr0gfj8-IQ"; // "Café ½ ~?>!": a "-" and two "=" missing
  assert.equal(lib.decodeBodyPart({ data, html: false, charset: "UTF-8" }, U), "Café ½ ~?>!");
});

test("body decode: bytes, as the Apps Script Gmail service returns them", () => {
  const bytes = Array.from(new Int8Array(Buffer.from("Café", "utf8")));
  assert.ok(bytes.some((b) => b < 0));
  assert.equal(lib.decodeBodyPart({ data: bytes, html: false, charset: "UTF-8" }, U), "Café");
  const html = Array.from(new Int8Array(Buffer.from("<p>a &amp; b</p>", "utf8")));
  assert.equal(lib.decodeBodyPart({ data: html, html: true, charset: "UTF-8" }, U), "a & b");
  assert.equal(lib.decodeBodyPart(null, U), "");
});

test("charset from the part's Content-Type", () => {
  const part = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }],
    body: { data: Array.from(new Int8Array(Buffer.from("Café", "latin1"))) } };
  const found = lib.findBodyPart(part);
  assert.equal(found.charset, "ISO-8859-1");
  assert.equal(lib.decodeBodyPart(found, U), "Café");
  assert.equal(lib.charsetOf({ headers: [] }), "UTF-8");
});

test("base64 padding", () => {
  assert.equal(lib.padBase64("aGk"), "aGk=");
  assert.equal(lib.padBase64("aGVsbG8"), "aGVsbG8=");
  assert.equal(lib.padBase64("aGVsbG8h"), "aGVsbG8h");
});

test("same Message-ID twice in one run is skipped", () => {
  const seen = {};
  assert.equal(lib.seenThisRun(seen, "<A@x>"), false);
  assert.equal(lib.seenThisRun(seen, " <a@X> "), true);
  assert.equal(lib.seenThisRun(seen, "<b@x>"), false);
  assert.equal(lib.seenThisRun(seen, null), false);
  assert.equal(lib.seenThisRun(seen, null), false);
});

test("action by verdict", () => {
  assert.equal(lib.actionFor(200, '{"status":"captured"}'), "forwarded");
  assert.equal(lib.actionFor(200, '{"status":"duplicate"}'), "forwarded");
  assert.equal(lib.actionFor(200, '{"status":"rejected"}'), "rejected");
  assert.equal(lib.actionFor(500, '{"status":"error"}'), "none");
  assert.equal(lib.actionFor(401, "Unauthorized"), "none");
  assert.equal(lib.actionFor(200, "not json"), "none");
  assert.equal(lib.actionFor(200, "null"), "none");
});

test("dry-run line carries no content", () => {
  assert.equal(lib.dryRunLine("m1", 200, '{"status":"captured","via":"forward","source_app":"jobs","captured_text_preview":"secret"}', "A <x@Gmail.com>"),
    "m1 | captured | forward | jobs | gmail.com");
  assert.equal(lib.dryRunLine("m2", 200, '{"status":"rejected","reason":"sender_not_allowed"}', "s@example.com"),
    "m2 | rejected | sender_not_allowed | - | example.com");
  assert.equal(lib.dryRunLine("m3", 500, "boom", null), "m3 | HTTP 500 | - | - | ?");
});

test("label changes", () => {
  const ids = { forwarded: "L1", rejected: "L2" };
  assert.deepEqual(JSON.parse(JSON.stringify(lib.labelChange("forwarded", ids))), { addLabelIds: ["L1"], removeLabelIds: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(lib.labelChange("rejected", ids))), { addLabelIds: ["L2", "UNREAD", "INBOX"], removeLabelIds: [] });
  assert.equal(lib.labelChange("none", ids), null);
});
