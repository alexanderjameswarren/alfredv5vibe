import { test } from "node:test";
import assert from "node:assert/strict";
import * as g from "./gmail.ts";
import * as p from "./parse.ts";

// Fixtures: headers from the step 3 recon (.scratch/gmail_capture-h3w), in their
// original order, signatures and bodies left out.
const H = (pairs) => pairs.map(([Name, Value]) => ({ Name, Value }));

const SENDERS = [
  { email: "alex.warren@secorus.com", safe_sender: true, approved_forwarder: true },
  { email: "alexanderjameswarren@gmail.com", safe_sender: true, approved_forwarder: true },
  { email: "enhdesigns@gmail.com", safe_sender: true, approved_forwarder: true },
];

const GMAIL_PASS = (hash) =>
  `mx.google.com; dkim=pass header.i=@gmail.com header.s=20260707 header.b=${hash}; arc=pass (i=1); spf=pass (google.com: domain of alexanderjameswarren@gmail.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=alexanderjameswarren@gmail.com; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com; dara=neutral header.i=@secorus.com`;

// A: self-forward secorus → alfred@ (one message, SENT, no delivery headers).
const SELF_FORWARD = {
  source: "gmail-script", gmail_id: "g-a", label_ids: ["SENT", "Label_7"], labels: ["forwarded"],
  headers: H([
    ["Date", "Thu, 29 Oct 2026 10:46:39 -0700"],
    ["Message-ID", "<CAPTC2PiY2VvJZRB_zTJAawTzwHPk1rBW2iE3rd7vpr+cu9vzCQ@mail.gmail.com>"],
    ["Subject", "GCAP3 A self-forward"],
    ["From", "Alex Warren <alex.warren@secorus.com>"],
    ["To", "Alexander Warren <alfred@secorus.com>"],
  ]),
};

// B: gmail.com → alfred+jobs@.
const PLUS_TAG = {
  source: "gmail-script", gmail_id: "g-b", label_ids: ["INBOX", "UNREAD"], labels: [],
  headers: H([
    ["Delivered-To", "alfred+jobs@secorus.com"],
    ["ARC-Authentication-Results", `i=2; ${GMAIL_PASS("RK7wbEX0")}`],
    ["Return-Path", "<alexanderjameswarren@gmail.com>"],
    ["Received-SPF", "pass (google.com: domain of alexanderjameswarren@gmail.com designates 209.85.220.41 as permitted sender) client-ip=209.85.220.41;"],
    ["Authentication-Results", GMAIL_PASS("RK7wbEX0")],
    ["ARC-Authentication-Results", "i=1; mx.google.com; arc=none"],
    ["From", "Alex Warren <alexanderjameswarren@gmail.com>"],
    ["Date", "Thu, 29 Oct 2026 10:52:27 -0700"],
    ["Message-ID", "<CANfcfa6LT=6-BO54EiSup_OEyygu1vXpiMJOaKR2equRNK4ZXg@mail.gmail.com>"],
    ["Subject", "GCAP3 B plus tag"],
    ["To", "alfred+jobs@secorus.com"],
  ]),
};

// C: hand forward gmail.com → alex.warren+alfred@ (dara=fail, ignored).
const HAND_FORWARD = {
  source: "gmail-script", gmail_id: "g-c", label_ids: ["INBOX"], labels: ["forwarded"],
  headers: H([
    ["Delivered-To", "alex.warren+alfred@secorus.com"],
    ["Return-Path", "<alexanderjameswarren@gmail.com>"],
    ["Authentication-Results", GMAIL_PASS("bKxC5hjT").replace("dara=neutral", "dara=fail")],
    ["ARC-Authentication-Results", "i=1; mx.google.com; arc=none"],
    ["From", "Alex Warren <alexanderjameswarren@gmail.com>"],
    ["Message-ID", "<CANfcfa6eo-9FABfYcC4GZT-xXa1HmxkwU1rCakbQOiKSUC8HCg@mail.gmail.com>"],
    ["Subject", "GCAP3 C manual forward"],
    ["To", "Alfred <alex.warren+alfred@secorus.com>"],
  ]),
};

// Life Time mail auto-forwarded by Alex's gmail.com rule into alfred@.
const CAF = "alexanderjameswarren+caf_=alfred=secorus.com@gmail.com";
const AUTO_FORWARD = {
  source: "gmail-script", gmail_id: "g-d", label_ids: ["INBOX"], labels: ["forwarded"],
  headers: H([
    ["Delivered-To", "alfred@secorus.com"],
    ["ARC-Authentication-Results", `i=3; mx.google.com; dkim=pass header.i=@t.lifetime.life header.s=scph0224 header.b=mtqrDUQA; arc=pass (i=2 spf=pass spfdomain=bounce.lifetime.life dkim=pass dkdomain=t.lifetime.life dmarc=pass fromdomain=lifetime.life); spf=pass (google.com: domain of ${CAF} designates 209.85.220.41 as permitted sender) smtp.mailfrom="${CAF}"; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=lifetime.life; dara=neutral header.i=@secorus.com`],
    ["Return-Path", `<${CAF}>`],
    ["Received-SPF", `pass (google.com: domain of ${CAF} designates 209.85.220.41 as permitted sender) client-ip=209.85.220.41;`],
    ["Authentication-Results", `mx.google.com; dkim=pass header.i=@t.lifetime.life header.s=scph0224 header.b=mtqrDUQA; arc=pass (i=2 spf=pass spfdomain=bounce.lifetime.life dkim=pass dkdomain=t.lifetime.life dmarc=pass fromdomain=lifetime.life); spf=pass (google.com: domain of ${CAF} designates 209.85.220.41 as permitted sender) smtp.mailfrom="${CAF}"; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=lifetime.life; dara=neutral header.i=@secorus.com`],
    ["ARC-Authentication-Results", "i=2; mx.google.com; dkim=pass header.i=@t.lifetime.life header.s=scph0224 header.b=mtqrDUQA; spf=pass smtp.mailfrom=\"msprvs1=2076289UcOFyj=bounces-280172-1785@bounce.lifetime.life\"; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=lifetime.life"],
    ["X-Forwarded-To", "alfred@secorus.com"],
    ["X-Forwarded-For", "alexanderjameswarren@gmail.com alfred@secorus.com"],
    ["Delivered-To", "alexanderjameswarren@gmail.com"],
    ["Return-Path", "<msprvs1=2076289UcOFyj=bounces-280172-1785@bounce.lifetime.life>"],
    ["To", "\"Alex Warren\" <alexanderjameswarren@gmail.com>"],
    ["Message-ID", "<FC.67.11939.95243EA6@i-0caf141b90c26113f.mta1vrest.sd.prd.sparkpost>"],
    ["From", "\"Life Time\" <noreply@t.lifetime.life>"],
  ]),
};

// Elise's hand forward to alfred@ (2026-10-27).
const ELISE = {
  source: "gmail-script", gmail_id: "g-e", label_ids: ["INBOX"], labels: ["forwarded"],
  headers: H([
    ["Delivered-To", "alfred@secorus.com"],
    ["Return-Path", "<enhdesigns@gmail.com>"],
    ["Authentication-Results", "mx.google.com; dkim=pass header.i=@gmail.com header.s=20251104 header.b=PvnSlaSy; arc=pass (i=1); spf=pass (google.com: domain of enhdesigns@gmail.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=enhdesigns@gmail.com; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com; dara=neutral header.i=@secorus.com"],
    ["From", "Elise Warren <enhdesigns@gmail.com>"],
    ["Message-ID", "<CALGYBwRc8PZUFFUGowwK0bS+=bVb0muKGrcYAD-k_iC+H7fdhw@mail.gmail.com>"],
    ["To", "Alexander Warren <alfred@secorus.com>"],
  ]),
};

const STRANGER = {
  source: "gmail-script", gmail_id: "g-f", label_ids: ["INBOX"], labels: ["alfred"],
  headers: H([
    ["Delivered-To", "alfred@secorus.com"],
    ["Authentication-Results", "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=someone@example.com; dmarc=pass header.from=example.com"],
    ["From", "Someone <someone@example.com>"],
    ["To", "alfred@secorus.com"],
  ]),
};

test("secret", () => {
  assert.equal(g.checkCaptureSecret("s3cret", "s3cret"), "ok");
  assert.equal(g.checkCaptureSecret("nope", "s3cret"), "bad_token");
  assert.equal(g.checkCaptureSecret(null, "s3cret"), "bad_token");
  assert.equal(g.checkCaptureSecret("x", undefined), "missing_config");
});

test("payload problems", () => {
  assert.equal(g.payloadProblem(SELF_FORWARD), null);
  assert.match(g.payloadProblem({ headers: [] }), /gmail_id/);
  assert.match(g.payloadProblem({ gmail_id: "x" }), /headers/);
  assert.match(g.payloadProblem(null), /object/);
});

test("address lists", () => {
  assert.deepEqual(g.addressesIn('"W, A" <A@x.com>, b@y.org; Alfred <alfred+jobs@secorus.com>'),
    ["a@x.com", "b@y.org", "alfred+jobs@secorus.com"]);
  assert.deepEqual(g.addressesIn(null), []);
});

test("alfred+tag maps to Alex and swallows no other mapping", () => {
  assert.equal(p.findMapping(["alfred+jobs@secorus.com"]).label, "Alex");
  assert.equal(p.findMapping(["alex.warren+elise+alfred@secorus.com"]).label, "Elise");
  assert.equal(p.findMapping(["recipes@secorus.com"]).captureAddress, "recipes");
});

test("self-forward: SENT, no auth headers, captured", () => {
  const d = g.decideGmail(SELF_FORWARD, SENDERS);
  assert.deepEqual([d.accept, d.via, d.label, d.captureHit], [true, "sent", "Alex", "alfred@secorus.com"]);
  assert.equal(g.googleAuthResults(SELF_FORWARD.headers), null);
});

test("self-forward without SENT is rejected", () => {
  const d = g.decideGmail({ ...SELF_FORWARD, label_ids: ["INBOX"] }, SENDERS);
  assert.deepEqual([d.accept, d.reason], [false, "sender_not_authenticated"]);
});

test("alfred+jobs from gmail.com: safe sender, routed to jobs", () => {
  const d = g.decideGmail(PLUS_TAG, SENDERS);
  assert.deepEqual([d.accept, d.via, d.captureHit], [true, "safe_sender", "alfred+jobs@secorus.com"]);
  const row = g.buildGmailRow(PLUS_TAG, d);
  assert.equal(row.sourceApp, "jobs");
  assert.equal(row.sourceMetadata.alfred_tag, "jobs");
});

test("label beats plus tag; unknown child sets no app", () => {
  const rcpt = ["alfred+jobs@secorus.com"];
  assert.deepEqual(g.routeApp(["forwarded", "alfred/wb"], rcpt), { app: "warren_buffet", tag: "wb" });
  assert.deepEqual(g.routeApp(["alfred/arnold"], []), { app: "arnold", tag: "arnold" });
  assert.deepEqual(g.routeApp(["alfred/recipes"], rcpt), { app: null, tag: "recipes" });
  assert.deepEqual(g.routeApp(["alfred"], []), { app: null, tag: null });
});

test("Life Time auto-forward: accepted via gmail.com forwarder", () => {
  const d = g.decideGmail(AUTO_FORWARD, SENDERS);
  assert.deepEqual([d.accept, d.via, d.forwarder, d.captureHit],
    [true, "forward", "alexanderjameswarren@gmail.com", "alfred@secorus.com"]);
  const row = g.buildGmailRow(AUTO_FORWARD, d);
  assert.equal(row.sourceMetadata.auto_forwarded, true);
  assert.equal(row.sourceMetadata.from, "noreply@t.lifetime.life");
});

test("auto-forward by an account that is not an approved forwarder is rejected", () => {
  const senders = SENDERS.map((s) => ({ ...s, approved_forwarder: false }));
  const d = g.decideGmail(AUTO_FORWARD, senders);
  assert.deepEqual([d.accept, d.reason], [false, "forwarded_by_unknown_account"]);
});

test("hand forwards: Alex and Elise accepted as safe senders", () => {
  const a = g.decideGmail(HAND_FORWARD, SENDERS);
  assert.deepEqual([a.accept, a.via, a.captureHit], [true, "safe_sender", "alex.warren+alfred@secorus.com"]);
  const e = g.decideGmail(ELISE, SENDERS);
  assert.deepEqual([e.accept, e.via, e.label], [true, "safe_sender", "Alex"]);
});

test("Elise accepted only while her row says safe_sender", () => {
  const senders = SENDERS.filter((s) => s.email !== "enhdesigns@gmail.com");
  assert.equal(g.decideGmail(ELISE, senders).reason, "sender_not_allowed");
});

test("stranger to alfred@ rejected even with passing DMARC", () => {
  const d = g.decideGmail(STRANGER, SENDERS);
  assert.deepEqual([d.accept, d.reason, d.domain, d.captureHit], [false, "sender_not_allowed", "example.com", "alfred@secorus.com"]);
});

test("forged safe sender: DMARC fails → rejected", () => {
  const forged = { ...HAND_FORWARD, headers: HAND_FORWARD.headers.map((h) =>
    h.Name === "Authentication-Results"
      ? { ...h, Value: "mx.google.com; spf=softfail smtp.mailfrom=evil@bad.example; dmarc=fail header.from=gmail.com" }
      : h) };
  assert.equal(g.decideGmail(forged, SENDERS).reason, "sender_not_authenticated");
});

test("stranger's X-Forwarded-For into alfred@ rejected", () => {
  const xff = { ...STRANGER, headers: [...STRANGER.headers, { Name: "X-Forwarded-For", Value: "bad@evil.example alfred@secorus.com" }] };
  assert.equal(g.decideGmail(xff, SENDERS).reason, "forwarded_by_unknown_account");
});

test("labelled mail not sent to a capture address is trusted", () => {
  const job = {
    source: "gmail-script", gmail_id: "g-g", label_ids: ["INBOX"], labels: ["alfred/jobs"],
    headers: H([["Delivered-To", "alex.warren@secorus.com"], ["From", "LinkedIn <jobalerts-noreply@linkedin.com>"], ["To", "alex.warren@secorus.com"]]),
  };
  const d = g.decideGmail(job, SENDERS);
  assert.deepEqual([d.accept, d.via, d.label], [true, "no_capture_address", "Alex"]);
  assert.equal(g.buildGmailRow(job, d).sourceApp, "jobs");
});

test("auth results: only Google's topmost, comments ignored, dkim alignment", () => {
  const top = g.googleAuthResults(AUTO_FORWARD.headers);
  assert.deepEqual([top.dmarc, top.dmarc_from, top.spf], ["pass", "lifetime.life", "pass"]);
  assert.equal(g.googleAuthResults(H([["Authentication-Results", "evil.example; dmarc=pass header.from=gmail.com"]])), null);
  const dkimOnly = { dmarc: null, dmarc_from: null, spf: null, dkim: [{ result: "pass", domain: "mail.secorus.com" }] };
  assert.equal(g.senderAuthenticated("alex.warren@secorus.com", dkimOnly), true);
  assert.equal(g.senderAuthenticated("alex.warren@secorus.com", { ...dkimOnly, dkim: [{ result: "pass", domain: "other.com" }] }), false);
});

test("row metadata", () => {
  const d = g.decideGmail(SELF_FORWARD, SENDERS);
  const row = g.buildGmailRow({ ...SELF_FORWARD, thread_id: "t1", gmail_link: "https://mail.google.com/x",
    attachments: [{ name: "a.pdf", type: "application/pdf", size: 10 }] }, d);
  const m = row.sourceMetadata;
  assert.equal(m.messageId, "g-a");
  assert.equal(m.gmail_id, "g-a");
  assert.equal(m.source, "gmail");
  assert.equal(m.sent, true);
  assert.equal(m.trust, "sent");
  assert.equal(m.from, "alex.warren@secorus.com");
  assert.equal(m.fromName, "Alex Warren");
  assert.equal(m.gmail_link, "https://mail.google.com/x");
  assert.equal(m.attachments.length, 1);
  assert.equal(m.original_message_id, "CAPTC2PiY2VvJZRB_zTJAawTzwHPk1rBW2iE3rd7vpr+cu9vzCQ@mail.gmail.com");
  assert.equal(m.auth, null);
  assert.ok(row.capturedText.startsWith("GCAP3 A self-forward"));
});

function fakeRows(rows, failKey) {
  return {
    async findEmailRow(userId, key, value) {
      if (key === failKey) throw new Error("boom");
      return rows.find((r) => r.user_id === userId && r.meta[key] === value)?.id ?? null;
    },
  };
}

test("duplicate Gmail id reported as duplicate", async () => {
  const store = fakeRows([{ id: "row1", user_id: "u1", meta: { messageId: "g-a" } }]);
  assert.deepEqual(await g.findDuplicate(store, "u1", { messageId: "g-a" }), { reason: "gmail_id", inboxId: "row1" });
  assert.equal(await g.findDuplicate(store, "u2", { messageId: "g-a" }), null);
});

test("mail already captured through Postmark: duplicate by original Message-ID", async () => {
  const store = fakeRows([{ id: "pm1", user_id: "u1", meta: { messageId: "postmark-uuid", original_message_id: "m@x" } }]);
  assert.deepEqual(await g.findDuplicate(store, "u1", { messageId: "g-new", original_message_id: "m@x" }),
    { reason: "original_message_id", inboxId: "pm1" });
});

test("a failed lookup never blocks", async () => {
  const store = fakeRows([], "messageId");
  assert.equal(await g.findDuplicate(store, "u1", { messageId: "g-a" }), null);
});

test("rejection notice links to Gmail", () => {
  const n = p.buildNotice({ reason: "sender_not_allowed", fromAddress: "someone@example.com", postmarkMessageId: "",
    gmailLink: "https://mail.google.com/mail/u/?authuser=alex.warren@secorus.com#all/g-f", gmailId: "g-f" },
  new Date("2026-10-29T18:00:00Z"));
  assert.match(n.capturedText, /Open it in Gmail: https:\/\/mail\.google\.com/);
  assert.match(n.capturedText, /not on the list/);
  assert.equal(n.sourceMetadata.gmail_id, "g-f");
  assert.equal("postmark_message_id" in n.sourceMetadata, false);
});
