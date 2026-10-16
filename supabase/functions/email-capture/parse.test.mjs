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

// --- Trusted auto-forward. Real data: input A (Idealist alert, 2026-10-07). ---
const PM = "22edead6c8585c5cdd11b72d6d1b3e01";
const caf = (local, domain) => `${local}+caf_=${PM}=inbound.postmarkapp.com@${domain}`;
const postmarkSpf = (envelope, domain, result = "pass") =>
  `${result} (${domain}: Sender is authorized to use '${envelope}' in 'mfrom' identity (mechanism 'include:dc-aa8e722993._spfm.secorus.com' matched)) receiver=p-pm-inboundg04a-aws-useast1a; identity=mailfrom; envelope-from="${envelope}"; helo=mail-yw1-f178.google.com; client-ip=209.85.128.178`;
const GOOGLE_SPF =
  "pass (google.com: domain of pm_bounces@pm-bounces.idealist.org designates 104.245.209.235 as permitted sender) client-ip=104.245.209.235;";

function forwardHeaders(local, domain, { spf, xff, extra = [] } = {}) {
  const envelope = caf(local, domain);
  return [
    { Name: "Return-Path", Value: `<${envelope}>` },
    { Name: "Received", Value: "by p-pm-inboundg04a-aws-useast1a.inbound.postmarkapp.com (Postfix, from userid 996)" },
    { Name: "Received-SPF", Value: spf ?? postmarkSpf(envelope, domain) },
    { Name: "X-Forwarded-To", Value: `${PM}@inbound.postmarkapp.com` },
    { Name: "X-Forwarded-For", Value: xff ?? `${local}@${domain} ${PM}@inbound.postmarkapp.com` },
    { Name: "Delivered-To", Value: `${local}@${domain}` },
    ...extra,
    { Name: "Received-SPF", Value: GOOGLE_SPF },
    { Name: "Message-Id", Value: "<3f518020-2e8f-4e57-803e-5a4cd8a2e406@mtasv.net>" },
  ];
}
const INPUT_A = forwardHeaders("alex.warren", "secorus.com");
const IDEALIST_TO = ["alex.warren@secorus.com", "alex.warren@secorus.com", `${PM}@inbound.postmarkapp.com`];

test("input A: trusted, maps to Alex", () => {
  assert.deepEqual(p.checkAutoForward(INPUT_A), { trusted: true, account: "alex.warren@secorus.com" });
  const d = p.decideCapture("no-reply@idealist.org", IDEALIST_TO, INPUT_A);
  assert.equal(d.accept, true);
  assert.equal(d.userEmail, "alexanderjameswarren@gmail.com");
  assert.equal(d.via, "forward");
  assert.equal(d.captureAddress, undefined);
});

test("stranger's Return-Path with forged X-Forwarded-For: rejected", () => {
  const h = forwardHeaders("stranger", "gmail.com", {
    xff: `alex.warren@secorus.com ${PM}@inbound.postmarkapp.com`,
  });
  const d = p.decideCapture("no-reply@idealist.org", IDEALIST_TO, h);
  assert.deepEqual(d, { accept: false, reason: "sender_not_allowed:forwarder_not_allowed", domain: "idealist.org" });
});

test("injected second Postmark-looking SPF: rejected", () => {
  const fake = { Name: "Received-SPF", Value: postmarkSpf(caf("alex.warren", "secorus.com"), "secorus.com") };
  const h = forwardHeaders("alex.warren", "secorus.com", { extra: [fake] });
  assert.equal(p.checkAutoForward(h).reason, "second_postmark_spf");
  assert.equal(p.decideCapture("no-reply@idealist.org", IDEALIST_TO, h).accept, false);
});

test("Postmark SPF not first: rejected", () => {
  const h = INPUT_A.filter((x) => x.Name !== "Received-SPF");
  h.splice(1, 0, { Name: "Received-SPF", Value: GOOGLE_SPF });
  h.push({ Name: "Received-SPF", Value: postmarkSpf(caf("alex.warren", "secorus.com"), "secorus.com") });
  assert.equal(p.checkAutoForward(h).reason, "first_spf_not_postmark");
});

test("SPF not pass: rejected", () => {
  for (const result of ["softfail", "fail", "neutral", "none"]) {
    const h = forwardHeaders("alex.warren", "secorus.com", {
      spf: postmarkSpf(caf("alex.warren", "secorus.com"), "secorus.com", result),
    });
    assert.equal(p.checkAutoForward(h).reason, "spf_not_pass", result);
  }
});

test("envelope-from differs from Return-Path: rejected", () => {
  const h = forwardHeaders("alex.warren", "secorus.com", {
    spf: postmarkSpf(caf("stranger", "gmail.com"), "gmail.com"),
  });
  assert.equal(p.checkAutoForward(h).reason, "envelope_mismatch");
});

test("X-Forwarded-For naming another account: rejected", () => {
  const h = forwardHeaders("alex.warren", "secorus.com", { xff: "enhdesigns@gmail.com x@y" });
  assert.equal(p.checkAutoForward(h).reason, "xff_mismatch");
});

test("plain Return-Path, no SPF, no headers: not trusted", () => {
  assert.equal(p.checkAutoForward([{ Name: "Return-Path", Value: "<bounce@idealist.org>" }]).reason, "return_path_not_caf");
  assert.equal(p.checkAutoForward([{ Name: "Return-Path", Value: `<${caf("alex.warren", "secorus.com")}>` }]).reason, "no_spf");
  assert.equal(p.checkAutoForward(undefined).reason, "no_return_path");
});

const ELISE = forwardHeaders("enhdesigns", "gmail.com");

test("Elise auto-forward, no capture address: maps to Elise", () => {
  const d = p.decideCapture("hello@shop.example", ["enhdesigns@gmail.com"], ELISE);
  assert.equal(d.accept, true);
  assert.equal(d.userEmail, "enhdesigns@gmail.com");
  assert.equal(d.label, "Elise");
});

// Real data: .scratch payloads 2026-10-13 (hand forwards through the secorus
// filter). Domain of the non-allowlisted account anonymised.
const viaSecorus = (deliveredTo) => [
  ...forwardHeaders("alex.warren", "secorus.com").filter((h) => h.Name !== "Delivered-To"),
  { Name: "Delivered-To", Value: deliveredTo },
];

test("payload katieporter: capture address, From not allowlisted → rule 1 reject", () => {
  const d = p.decideCapture("alex.warren@other.example", ["alfred@secorus.com", "alfred@secorus.com"],
    viaSecorus("alfred@secorus.com"));
  assert.deepEqual(d, {
    accept: false,
    reason: "capture_address_sender_not_allowed",
    domain: "other.example",
    captureHit: "alfred@secorus.com",
  });
});

test("payload alexanderjames: accepted, maps to Alex", () => {
  const d = p.decideCapture("alexanderjameswarren@gmail.com",
    ["alex.warren+alfred@secorus.com", '"Alfred" <alex.warren+alfred@secorus.com>'],
    viaSecorus("alex.warren+alfred@secorus.com"));
  assert.equal(d.accept, true);
  assert.equal(d.userEmail, "alexanderjameswarren@gmail.com");
  assert.equal(d.via, "from");
});

test("stranger Bcc'ing a capture address: Delivered-To catches it", () => {
  const d = p.decideCapture("x@other.example", ["someone@else.example"], viaSecorus("recipes@secorus.com"));
  assert.equal(d.reason, "capture_address_sender_not_allowed");
});

test("capture address in Cc counts", () => {
  const d = p.decideCapture("x@other.example", ["a@b.example", "alfred@secorus.com"], viaSecorus("alex.warren@secorus.com"));
  assert.equal(d.reason, "capture_address_sender_not_allowed");
});

test("stranger's own Gmail rule forwarding in: rule 2 reject", () => {
  const h = [
    ...forwardHeaders("alex.warren", "secorus.com"),
    { Name: "X-Forwarded-For", Value: "stranger@gmail.com alex.warren@secorus.com" },
  ];
  const d = p.decideCapture("news@shop.example", ["stranger@gmail.com"], h);
  assert.equal(d.accept, false);
  assert.equal(d.reason, "forwarded_by_unknown_account");
  assert.equal(d.domain, "gmail.com");
});

test("Elise to recipes@ through the secorus filter: Alex, recipes", () => {
  const d = p.decideCapture("enhdesigns@gmail.com", ["recipes@secorus.com"], viaSecorus("recipes@secorus.com"));
  assert.equal(d.accept, true);
  assert.equal(d.userEmail, "alexanderjameswarren@gmail.com");
  assert.equal(d.captureAddress, "recipes");
});

test("a stranger's mail auto-forwarded to recipes@: rule 1 reject", () => {
  const d = p.decideCapture("hello@cooking.example", ["recipes@secorus.com"], ELISE);
  assert.equal(d.reason, "capture_address_sender_not_allowed");
});

// Rule 1(b): an earlier Gmail hop into a capture address. Earlier hops sit
// below the secorus → Postmark hop, as Gmail prepends each new hop.
const earlierHop = (account, captureAddress) => [
  ...viaSecorus(captureAddress),
  { Name: "X-Forwarded-To", Value: captureAddress },
  { Name: "X-Forwarded-For", Value: `${account} ${captureAddress}` },
  { Name: "Delivered-To", Value: account },
];

test("1(b): Alex's Gmail rule forwarding LifeTime to alfred@ → Alex, auto-forwarded", () => {
  const d = p.decideCapture("noreply@lifetime.example", ["alexanderjameswarren@gmail.com"],
    earlierHop("alexanderjameswarren@gmail.com", "alfred@secorus.com"));
  assert.equal(d.accept, true);
  assert.equal(d.userEmail, "alexanderjameswarren@gmail.com");
  assert.equal(d.via, "forward");
  assert.equal(d.captureAddress, undefined);
});

test("1(b): Elise's rule forwarding NYT Cooking to recipes@ → Alex, recipes", () => {
  const d = p.decideCapture("cooking@nytimes.example", ["enhdesigns@gmail.com"],
    earlierHop("enhdesigns@gmail.com", "recipes@secorus.com"));
  assert.equal(d.accept, true);
  assert.equal(d.userEmail, "alexanderjameswarren@gmail.com");
  assert.equal(d.captureAddress, "recipes");
  assert.equal(d.via, "forward");
});

test("1(b): a stranger's earlier hop into recipes@ → rejected", () => {
  const d = p.decideCapture("cooking@nytimes.example", ["stranger@gmail.com"],
    earlierHop("stranger@gmail.com", "recipes@secorus.com"));
  assert.equal(d.accept, false);
  assert.equal(d.reason, "forwarded_by_unknown_account");
});

test("1(b): forged hop naming Alex but forwarded elsewhere → rejected", () => {
  const h = [
    ...viaSecorus("alfred@secorus.com"),
    { Name: "X-Forwarded-For", Value: "alexanderjameswarren@gmail.com other@else.example" },
  ];
  const d = p.decideCapture("noreply@lifetime.example", ["alexanderjameswarren@gmail.com"], h);
  assert.equal(d.reason, "capture_address_sender_not_allowed");
});

test("1(b): the secorus → Postmark hop alone never counts", () => {
  const d = p.decideCapture("x@other.example", ["alfred@secorus.com"], viaSecorus("alfred@secorus.com"));
  assert.equal(d.reason, "capture_address_sender_not_allowed");
});

// Real data: .scratch/amazon-autoforward.json, 2026-10-16 (Amazon → Alex's
// gmail → alfred@ → Postmark). Its decision headers, in payload order; DKIM,
// ARC seals and Received lines left out. Google renamed the gmail.com hop's
// X-Forwarded-For to X-X-Forwarded-For on the second forward.
const AMZ_BOUNCE = "20261016010908d2dc51738dab49aa88175a2f13c0p0na-c2fajtwl31sk4m@bounces.amazon.com";
const AMZ_DKIM = "dkim=pass header.i=@amazon.com header.s=v52wzeq2nhi2ivaga2mkkcxigoeqeycs header.b=mve1oZ9+;       dkim=pass header.i=@amazonses.com header.s=224i4yxa5dv7c2xz3womw6peuasteono header.b=Bu2cuxKR;";
const AMZ_DMARC = "dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=amazon.com";
const AMZ_INTO_ALFRED = `mx.google.com;       ${AMZ_DKIM}       arc=pass (i=2 spf=pass spfdomain=bounces.amazon.com dkim=pass dkdomain=amazon.com dkim=pass dkdomain=amazonses.com dmarc=pass fromdomain=amazon.com);       spf=pass (google.com: domain of alexanderjameswarren+caf_=alfred=secorus.com@gmail.com designates 209.85.220.41 as permitted sender) smtp.mailfrom="alexanderjameswarren+caf_=alfred=secorus.com@gmail.com";       ${AMZ_DMARC};       dara=neutral header.i=@secorus.com`;
const AMZ_INTO_GMAIL = `mx.google.com;       ${AMZ_DKIM}       spf=pass (google.com: domain of ${AMZ_BOUNCE} designates 54.240.15.176 as permitted sender) smtp.mailfrom=20261016010908d2dc51738dab49aa88175a2f13c0p0na-C2FAJTWL31SK4M@bounces.amazon.com;       ${AMZ_DMARC}`;
const REAL_AMAZON = [
  { Name: "Return-Path", Value: "<alex.warren+caf_=22edead6c8585c5cdd11b72d6d1b3e01=inbound.postmarkapp.com@secorus.com>" },
  { Name: "Received-SPF", Value: postmarkSpf(caf("alex.warren", "secorus.com"), "secorus.com") },
  { Name: "ARC-Authentication-Results", Value: `i=4; ${AMZ_INTO_ALFRED}` },
  { Name: "X-Forwarded-To", Value: `${PM}@inbound.postmarkapp.com` },
  { Name: "X-Forwarded-For", Value: `alex.warren@secorus.com ${PM}@inbound.postmarkapp.com` },
  { Name: "Delivered-To", Value: "alfred@secorus.com" },
  { Name: "ARC-Authentication-Results", Value: `i=3; ${AMZ_INTO_ALFRED}` },
  { Name: "Received-SPF", Value: "pass (google.com: domain of alexanderjameswarren+caf_=alfred=secorus.com@gmail.com designates 209.85.220.41 as permitted sender) client-ip=209.85.220.41;" },
  { Name: "Authentication-Results", Value: AMZ_INTO_ALFRED },
  { Name: "ARC-Authentication-Results", Value: `i=2; ${AMZ_INTO_GMAIL}` },
  { Name: "X-Forwarded-To", Value: "alfred@secorus.com" },
  { Name: "X-X-Forwarded-For", Value: "alexanderjameswarren@gmail.com alfred@secorus.com" },
  { Name: "Delivered-To", Value: "alexanderjameswarren@gmail.com" },
  { Name: "ARC-Authentication-Results", Value: `i=1; ${AMZ_INTO_GMAIL}` },
  { Name: "Received-SPF", Value: `pass (google.com: domain of ${AMZ_BOUNCE} designates 54.240.15.176 as permitted sender) client-ip=54.240.15.176;` },
  { Name: "Message-ID", Value: "<010001a142417607-848bcd2a-be19-438c-bf23-2bd73d3c542c-000000@email.amazonses.com>" },
];
const AMAZON_TO = ["alexanderjameswarren@gmail.com", "alexanderjameswarren@gmail.com"];
const without = (headers, name) => headers.filter((h) => h.Name !== name);

test("real Amazon auto-forward: accepted, Alex, auto-forwarded", () => {
  assert.deepEqual(p.googleForwardHop(REAL_AMAZON), { account: "alexanderjameswarren@gmail.com", to: "alfred@secorus.com" });
  assert.deepEqual(p.decideCapture("store-news@amazon.com", AMAZON_TO, REAL_AMAZON), {
    accept: true,
    userEmail: "alexanderjameswarren@gmail.com",
    label: "Alex",
    captureAddress: undefined,
    via: "forward",
  });
});

test("real Amazon: either signal alone accepts", () => {
  const authOnly = without(REAL_AMAZON, "X-X-Forwarded-For");
  assert.equal(p.decideCapture("store-news@amazon.com", AMAZON_TO, authOnly).via, "forward");
  const headerOnly = without(without(REAL_AMAZON, "ARC-Authentication-Results"), "Authentication-Results");
  assert.equal(p.googleForwardHop(headerOnly), null);
  assert.equal(p.decideCapture("store-news@amazon.com", AMAZON_TO, headerOnly).via, "forward");
});

const cafTo = (local, domain, capture) => `${local}+caf_=${capture.replace("@", "=")}@${domain}`;
const googleAr = (mailfrom, i) =>
  `${i ? `i=${i}; ` : ""}mx.google.com;\r\n       dkim=pass header.i=@amazon.com;\r\n       spf=pass (google.com: domain of ${mailfrom} designates 209.85.220.41 as permitted sender) smtp.mailfrom="${mailfrom}";\r\n       dmarc=pass (p=QUARANTINE) header.from=amazon.com`;

function autoForward(account, capture, { mailfrom, xxff = `${account} ${capture}`, ar = true, extra = [] } = {}) {
  const [local, domain] = account.split("@");
  const envelope = mailfrom ?? cafTo(local, domain, capture);
  return [
    ...forwardHeaders("alex.warren", "secorus.com").filter((h) => h.Name !== "Delivered-To" && h.Name !== "Received-SPF" && h.Name !== "Message-Id"),
    { Name: "Delivered-To", Value: capture },
    ...(ar ? [
      { Name: "ARC-Authentication-Results", Value: googleAr(envelope, 4) },
      { Name: "ARC-Authentication-Results", Value: googleAr(envelope, 3) },
    ] : []),
    { Name: "Return-Path", Value: `<${envelope}>` },
    ...(ar ? [{ Name: "Authentication-Results", Value: googleAr(envelope) }] : []),
    { Name: "X-Forwarded-To", Value: capture },
    ...(xxff ? [{ Name: "X-X-Forwarded-For", Value: xxff }] : []),
    { Name: "Delivered-To", Value: account },
    ...extra,
    { Name: "Authentication-Results", Value: googleAr("bounces@amazon.com") },
    { Name: "Message-Id", Value: "<0100019a@email.amazonses.com>" },
  ];
}
test("real Amazon as Elise → recipes@: Alex, recipes", () => {
  const h = REAL_AMAZON.map((x) => ({
    Name: x.Name,
    Value: x.Value.replaceAll("alexanderjameswarren", "enhdesigns").replaceAll("alfred=secorus.com", "recipes=secorus.com")
      .replaceAll("alfred@secorus.com", "recipes@secorus.com"),
  }));
  assert.equal(p.googleForwardHop(h).account, "enhdesigns@gmail.com");
  const d = p.decideCapture("auto-confirm@amazon.com", ["enhdesigns@gmail.com"], h);
  assert.equal(d.accept, true);
  assert.equal(d.captureAddress, "recipes");
  assert.equal(d.via, "forward");
});

test("auth results alone, no forwarding header: accepted", () => {
  const h = autoForward("alexanderjameswarren@gmail.com", "alfred@secorus.com", { xxff: null });
  assert.equal(p.decideCapture("auto-confirm@amazon.com", [], h).accept, true);
});

test("renamed header alone, no auth results: accepted", () => {
  const h = autoForward("alexanderjameswarren@gmail.com", "alfred@secorus.com", { ar: false });
  assert.equal(p.decideCapture("auto-confirm@amazon.com", [], h).accept, true);
});

test("stranger's gmail.com in the mailfrom: rejected", () => {
  const h = autoForward("stranger@gmail.com", "alfred@secorus.com", { xxff: null });
  assert.equal(p.googleForwardHop(h).account, "stranger@gmail.com");
  assert.equal(p.decideCapture("auto-confirm@amazon.com", [], h).reason, "capture_address_sender_not_allowed");
});

test("mailfrom pointing at another capture address: rejected", () => {
  const h = autoForward("alexanderjameswarren@gmail.com", "alfred@secorus.com", {
    mailfrom: cafTo("alexanderjameswarren", "gmail.com", "recipes@secorus.com"),
    xxff: null,
  });
  assert.equal(p.decideCapture("auto-confirm@amazon.com", [], h).reason, "capture_address_sender_not_allowed");
});

test("renamed X-X-Forwarded-For naming a stranger: rejected", () => {
  const h = autoForward("alexanderjameswarren@gmail.com", "alfred@secorus.com", { xxff: "stranger@gmail.com alfred@secorus.com" });
  const d = p.decideCapture("auto-confirm@amazon.com", [], h);
  assert.equal(d.reason, "forwarded_by_unknown_account");
  assert.equal(d.domain, "gmail.com");
});

test("X-X-X-Forwarded-For counts as a hop", () => {
  const h = [{ Name: "X-X-X-Forwarded-For", Value: "Stranger@Gmail.com alfred@secorus.com" }];
  assert.deepEqual(p.forwardHops(h), [{ account: "stranger@gmail.com", to: "alfred@secorus.com" }]);
});

test("sender-written auth results below Google's: ignored", () => {
  const fake = { Name: "Authentication-Results", Value: googleAr(cafTo("alexanderjameswarren", "gmail.com", "alfred@secorus.com")) };
  const h = [
    ...viaSecorus("alfred@secorus.com"),
    { Name: "Authentication-Results", Value: googleAr("stranger@other.example") },
    fake,
    { Name: "ARC-Authentication-Results", Value: googleAr(cafTo("alexanderjameswarren", "gmail.com", "alfred@secorus.com"), 9) },
  ];
  assert.equal(p.googleForwardHop(h), null);
  assert.equal(p.decideCapture("x@other.example", [], h).reason, "capture_address_sender_not_allowed");
});

test("spf not pass in Google's results: no hop", () => {
  const h = [{ Name: "Authentication-Results", Value: googleAr(cafTo("alexanderjameswarren", "gmail.com", "alfred@secorus.com")).replace("spf=pass", "spf=softfail") }];
  assert.equal(p.googleForwardHop(h), null);
});

// --- Rejection notices ---

function fakeStore() {
  const rows = [];
  return {
    rows,
    async countNotices(from, day) {
      return rows.filter((r) => r.meta.from_address === from && r.meta.notice_day === day).length;
    },
    async insertNotice(text, meta) {
      rows.push({ text, meta });
    },
  };
}
const REJ = {
  reason: "capture_address_sender_not_allowed",
  fromAddress: "alex.warren@other.example",
  captureAddress: "alfred@secorus.com",
  postmarkMessageId: "eee5fb97-e045-4e06-a0f0-e55fb91d2afa",
};

test("notice: text, metadata, no messageId key", () => {
  const n = p.buildNotice(REJ, new Date("2026-10-13T21:00:00Z"));
  assert.equal(
    n.capturedText,
    "Email blocked from alex.warren@other.example: the sender is not on the allowlist. View it in Postmark: " +
      "https://account.postmarkapp.com/servers/18272581/streams/inbound/messages/eee5fb97-e045-4e06-a0f0-e55fb91d2afa" +
      " (also still in your secorus Gmail inbox).",
  );
  assert.deepEqual(n.sourceMetadata, {
    rejected: true,
    reason: "capture_address_sender_not_allowed",
    from_address: "alex.warren@other.example",
    postmark_message_id: "eee5fb97-e045-4e06-a0f0-e55fb91d2afa",
    notice_day: "2026-10-13",
    capture_address: "alfred@secorus.com",
  });
  assert.equal("messageId" in n.sourceMetadata, false);
});

test("notice: once per sender per Pacific day", async () => {
  const s = fakeStore();
  const morning = new Date("2026-10-13T16:00:00Z");
  assert.equal(await p.sendRejectionNotice(s, REJ, morning, true), "sent");
  assert.equal(await p.sendRejectionNotice(s, REJ, new Date("2026-10-14T06:59:00Z"), true), "capped"); // 23:59 PDT
  assert.equal(await p.sendRejectionNotice(s, { ...REJ, fromAddress: "b@other.example" }, morning, true), "sent");
  assert.equal(await p.sendRejectionNotice(s, REJ, new Date("2026-10-14T07:01:00Z"), true), "sent"); // next day
  assert.equal(s.rows.length, 3);
});

test("notice switch", async () => {
  assert.equal(await p.sendRejectionNotice(fakeStore(), REJ, new Date(), false), "disabled");
  assert.equal(p.noticesEnabled(undefined), true);
  assert.equal(p.noticesEnabled("on"), true);
  assert.equal(p.noticesEnabled(" OFF "), false);
});

test("hand forward from an allowlisted From: unchanged", () => {
  const d = p.decideCapture("alex.warren@secorus.com", ["alex.warren+alfred@secorus.com"], []);
  assert.equal(d.accept, true);
  assert.equal(d.via, "from");
  const elise = p.decideCapture("enhdesigns@gmail.com", ["alex.warren+elise+alfred@secorus.com"], []);
  assert.equal(elise.userEmail, "enhdesigns@gmail.com");
});

test("unknown sender, no forward: rejected with domain only", () => {
  assert.deepEqual(p.decideCapture("spam@bad.example", ["someone@else.example"], []), {
    accept: false,
    reason: "sender_not_allowed:no_return_path",
    domain: "bad.example",
  });
});

test("allowlisted From, no capture address, no forward: no_mapping", () => {
  const d = p.decideCapture("alex.warren@secorus.com", ["someone@else.example"], []);
  assert.deepEqual(d, { accept: false, reason: "no_mapping", domain: "else.example" });
});

test("alfred@ mapping still last", () => {
  assert.equal(p.findMapping(["alex.warren+elise+alfred@secorus.com"]).label, "Elise");
  assert.equal(p.findMapping(["alfred@secorus.com"]).label, "Alex");
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
