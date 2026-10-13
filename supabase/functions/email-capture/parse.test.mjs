import { test } from "node:test";
import assert from "node:assert/strict";
import * as p from "./parse.ts";

const URL_BASE = "https://x.supabase.co/functions/v1/email-capture";

test("token ok", () => {
  assert.equal(p.checkWebhookToken(`${URL_BASE}?token=s3cret`, "s3cret"), "ok");
});

test("token wrong, missing, or prefix", () => {
  assert.equal(p.checkWebhookToken(`${URL_BASE}?token=nope`, "s3cret"), "bad_token");
  assert.equal(p.checkWebhookToken(URL_BASE, "s3cret"), "bad_token");
  assert.equal(p.checkWebhookToken(`${URL_BASE}?token=s3cre`, "s3cret"), "bad_token");
});

test("no secret configured", () => {
  assert.equal(p.checkWebhookToken(`${URL_BASE}?token=x`, undefined), "missing_config");
  assert.equal(p.checkWebhookToken(`${URL_BASE}?token=`, ""), "missing_config");
});

// Real data: input A, Idealist alert auto-forwarded 2026-10-07.
const HEADERS = [
  { Name: "Return-Path", Value: "<alex.warren+caf_=22edead6c8585c5cdd11b72d6d1b3e01=inbound.postmarkapp.com@secorus.com>" },
  { Name: "X-Forwarded-For", Value: "alex.warren@secorus.com 22edead6c8585c5cdd11b72d6d1b3e01@inbound.postmarkapp.com" },
  { Name: "Message-Id", Value: "<3f518020-2e8f-4e57-803e-5a4cd8a2e406@mtasv.net>" },
];

test("original message id", () => {
  assert.equal(p.originalMessageId(HEADERS), "3f518020-2e8f-4e57-803e-5a4cd8a2e406@mtasv.net");
  assert.equal(p.originalMessageId([{ Name: "MESSAGE-ID", Value: " <a@b> " }]), "a@b");
  assert.equal(p.originalMessageId([{ Name: "Message-Id", Value: "<>" }]), null);
  assert.equal(p.originalMessageId(undefined), null);
  assert.equal(p.originalMessageId([]), null);
});

test("getHeader first match", () => {
  const h = [{ Name: "Received-SPF", Value: "one" }, { Name: "received-spf", Value: "two" }];
  assert.equal(p.getHeader(h, "Received-SPF"), "one");
  assert.equal(p.getHeader(h, "X-None"), null);
});

test("unique violation", () => {
  assert.equal(p.isUniqueViolation({ code: "23505" }), true);
  assert.equal(p.isUniqueViolation({ code: "23502" }), false);
  assert.equal(p.isUniqueViolation(null), false);
});

test("subject prefixes", () => {
  assert.equal(p.cleanSubject("Fwd: New Jobs Alert"), "New Jobs Alert");
  assert.equal(p.cleanSubject("FW: Fwd: Re: Lunch"), "Lunch");
  assert.equal(p.cleanSubject("Fw:Dinner"), "Dinner");
  assert.equal(p.cleanSubject("Forward planning"), "Forward planning");
  assert.equal(p.cleanSubject(undefined), "");
});

test("signature stripped only at the end", () => {
  assert.equal(p.stripSignature("Body\n\n-- \nThanks,\n\nAlex"), "Body");
  assert.equal(p.stripSignature("Body\n--\nThanks,\nAlex\n"), "Body");
  const mid = "-- \nThanks,\n\nAlex\n\nMore text";
  assert.equal(p.stripSignature(mid), mid);
  assert.equal(p.stripSignature("Thanks,\nAlex"), "Thanks,\nAlex");
});

const FORWARD = [
  "Note to self",
  "",
  "---------- Forwarded message ---------",
  "From: EA Opportunities <",
  "eaopportunitiesboard@centreforeffectivealtruism.org>",
  "Date: Mon, Oct 12, 2026 at 10:50 AM",
  "Subject: 118 new opportunities",
  "To: <alex.warren@secorus.com>",
  "",
  "Hello! Weekly newsletter.",
  "From: this line is body text",
  "",
  "-- ",
  "Thanks,",
  "",
  "Alex",
].join("\r\n");

test("forwarded block parsed and removed", () => {
  const { original, text } = p.extractForwardedBlock(FORWARD.replace(/\r\n/g, "\n"));
  assert.deepEqual(original, {
    original_from: "EA Opportunities <eaopportunitiesboard@centreforeffectivealtruism.org>",
    original_date: "Mon, Oct 12, 2026 at 10:50 AM",
    original_subject: "118 new opportunities",
    original_to: "<alex.warren@secorus.com>",
  });
  assert.ok(!text.includes("Forwarded message"));
  assert.ok(text.includes("From: this line is body text"));
});

test("no block, text untouched", () => {
  const body = "From: someone\nDate: today\nhello";
  assert.deepEqual(p.extractForwardedBlock(body), { original: {}, text: body });
});

test("buildCapture: hand forward", () => {
  const { capturedText, original } = p.buildCapture("Fwd: 118 new opportunities", FORWARD);
  assert.equal(
    capturedText,
    "118 new opportunities\n\nNote to self\n\nHello! Weekly newsletter.\nFrom: this line is body text",
  );
  assert.equal(original.original_subject, "118 new opportunities");
});

// Real data: inbox row 59ecd744 (forward of a forward), 2026-10-13.
const SIG = "-- \nThanks,\n\nAlex";
const TAIL =
  'If you’re using Gmail, our emails may be delivered to your "Promotions"\n' +
  'tab. To prevent this, you can manually drag our emails into your "Primary"\ntab.';
const OUTER = [
  "---------- Forwarded message ---------",
  "From: Alex Warren <alex.warren@secorus.com>",
  "Date: Tue, Oct 13, 2026 at 11:21 AM",
  "Subject: Fwd: New Jobs Alert",
  "To: <alex.warren+alfred@secorus.com>",
  "",
].join("\n");
const INNER = [
  "---------- Forwarded message ---------",
  "From: Job Board Team (80,000 Hours) <alerts@jobs.80000hours.org>",
  "Date: Tue, Oct 13, 2026 at 10:30 AM",
  "Subject: New Jobs Alert",
  "To: <alex.warren@secorus.com>",
  "",
  "17 new roles that match your alert",
  "",
].join("\n");
const DOUBLE = `${OUTER}\n${INNER}\n${TAIL}\n\n${SIG}\n\n${SIG}\n`;
const BODY = `17 new roles that match your alert\n\n${TAIL}`;

test("double forward: innermost headers, both blocks and both signatures gone", () => {
  const { capturedText, original } = p.buildCapture("Fwd: Fwd: New Jobs Alert", DOUBLE);
  assert.equal(capturedText, `New Jobs Alert\n\n${BODY}`);
  assert.deepEqual(original, {
    original_from: "Job Board Team (80,000 Hours) <alerts@jobs.80000hours.org>",
    original_date: "Tue, Oct 13, 2026 at 10:30 AM",
    original_subject: "New Jobs Alert",
    original_to: "<alex.warren@secorus.com>",
  });
});

test("double forward, one signature", () => {
  const { capturedText } = p.buildCapture("Fwd: New Jobs Alert", `${OUTER}\n${INNER}\n${TAIL}\n\n${SIG}`);
  assert.equal(capturedText, `New Jobs Alert\n\n${BODY}`);
});

test("double forward, CRLF", () => {
  const { capturedText, original } = p.buildCapture("Fwd: New Jobs Alert", DOUBLE.replace(/\n/g, "\r\n"));
  assert.equal(capturedText, `New Jobs Alert\n\n${BODY}`);
  assert.equal(original.original_subject, "New Jobs Alert");
});

test("single forward", () => {
  const { capturedText, original } = p.buildCapture("Fwd: New Jobs Alert", `${INNER}\n${TAIL}\n\n${SIG}`);
  assert.equal(capturedText, `New Jobs Alert\n\n${BODY}`);
  assert.equal(original.original_from, "Job Board Team (80,000 Hours) <alerts@jobs.80000hours.org>");
});

test("signature variants", () => {
  for (const sig of [
    "--\nThanks,\nAlex",
    "-- \r\nThanks,\r\n\r\nAlex\r\n\r\n",
    "-- \n\nThanks, \n\n\nAlex  \n",
    "-- \nThanks,\n\nAlex​",
  ]) {
    assert.equal(p.stripSignature(`Body\n\n${sig}`), "Body", JSON.stringify(sig));
  }
});

test("endings of rows 8a5d0cb7, 8be781af, d80ffeec", () => {
  for (const end of [
    'always want to do this.',
    "<https://login.mailchimp.com/signup/email-referral/?aid=52b028e7f799cca137ef74763>",
    'tab. To prevent this, you can manually drag our emails into your "Primary"\ntab.',
  ]) {
    assert.equal(p.stripSignature(`${end}\n\n${SIG}`), end);
  }
});

test("buildCapture: quote markers stripped, empty cases", () => {
  assert.equal(p.buildCapture("Hi", "> quoted\n>> deeper").capturedText, "Hi\n\nquoted\ndeeper");
  assert.equal(p.buildCapture("Fwd: Only subject", "").capturedText, "Only subject");
  assert.equal(p.buildCapture("", "-- \nThanks,\nAlex").capturedText, "(empty email)");
});
