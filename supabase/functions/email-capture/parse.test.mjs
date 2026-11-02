import { test } from "node:test";
import assert from "node:assert/strict";
import * as p from "./parse.ts";

test("safeEqual", () => {
  assert.equal(p.safeEqual("s3cret", "s3cret"), true);
  assert.equal(p.safeEqual("s3cre", "s3cret"), false);
  assert.equal(p.safeEqual("s3creT", "s3cret"), false);
});

test("original message id", () => {
  assert.equal(p.originalMessageId([{ Name: "Message-Id", Value: "<3f518020@mtasv.net>" }]), "3f518020@mtasv.net");
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

// --- Google's forwarding hop. Real data: Amazon → Alex's gmail → alfred@, 2026-10-16;
// decision headers in order. Google renamed the gmail.com hop's X-Forwarded-For. ---
const AMZ_BOUNCE = "20261016010908d2dc51738dab49aa88175a2f13c0p0na-c2fajtwl31sk4m@bounces.amazon.com";
const AMZ_DKIM = "dkim=pass header.i=@amazon.com header.s=v52wzeq2nhi2ivaga2mkkcxigoeqeycs header.b=mve1oZ9+;       dkim=pass header.i=@amazonses.com header.s=224i4yxa5dv7c2xz3womw6peuasteono header.b=Bu2cuxKR;";
const AMZ_DMARC = "dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=amazon.com";
const AMZ_INTO_ALFRED = `mx.google.com;       ${AMZ_DKIM}       arc=pass (i=2 spf=pass spfdomain=bounces.amazon.com dkim=pass dkdomain=amazon.com dkim=pass dkdomain=amazonses.com dmarc=pass fromdomain=amazon.com);       spf=pass (google.com: domain of alexanderjameswarren+caf_=alfred=secorus.com@gmail.com designates 209.85.220.41 as permitted sender) smtp.mailfrom="alexanderjameswarren+caf_=alfred=secorus.com@gmail.com";       ${AMZ_DMARC};       dara=neutral header.i=@secorus.com`;
const AMZ_INTO_GMAIL = `mx.google.com;       ${AMZ_DKIM}       spf=pass (google.com: domain of ${AMZ_BOUNCE} designates 54.240.15.176 as permitted sender) smtp.mailfrom=20261016010908d2dc51738dab49aa88175a2f13c0p0na-C2FAJTWL31SK4M@bounces.amazon.com;       ${AMZ_DMARC}`;
const REAL_AMAZON = [
  { Name: "Delivered-To", Value: "alfred@secorus.com" },
  { Name: "ARC-Authentication-Results", Value: `i=3; ${AMZ_INTO_ALFRED}` },
  { Name: "Authentication-Results", Value: AMZ_INTO_ALFRED },
  { Name: "ARC-Authentication-Results", Value: `i=2; ${AMZ_INTO_GMAIL}` },
  { Name: "X-Forwarded-To", Value: "alfred@secorus.com" },
  { Name: "X-X-Forwarded-For", Value: "alexanderjameswarren@gmail.com alfred@secorus.com" },
  { Name: "Delivered-To", Value: "alexanderjameswarren@gmail.com" },
  { Name: "ARC-Authentication-Results", Value: `i=1; ${AMZ_INTO_GMAIL}` },
];

test("real Amazon auto-forward: Google's hop and the renamed header", () => {
  assert.deepEqual(p.googleForwardHop(REAL_AMAZON), { account: "alexanderjameswarren@gmail.com", to: "alfred@secorus.com" });
  assert.deepEqual(p.forwardHops(REAL_AMAZON), [{ account: "alexanderjameswarren@gmail.com", to: "alfred@secorus.com" }]);
});

const cafTo = (local, domain, capture) => `${local}+caf_=${capture.replace("@", "=")}@${domain}`;
const googleAr = (mailfrom, i) =>
  `${i ? `i=${i}; ` : ""}mx.google.com;\r\n       dkim=pass header.i=@amazon.com;\r\n       spf=pass (google.com: domain of ${mailfrom} designates 209.85.220.41 as permitted sender) smtp.mailfrom="${mailfrom}";\r\n       dmarc=pass (p=QUARANTINE) header.from=amazon.com`;

test("X-X-X-Forwarded-For counts as a hop", () => {
  const h = [{ Name: "X-X-X-Forwarded-For", Value: "Stranger@Gmail.com alfred@secorus.com" }];
  assert.deepEqual(p.forwardHops(h), [{ account: "stranger@gmail.com", to: "alfred@secorus.com" }]);
});

test("sender-written auth results below Google's: ignored", () => {
  const forged = cafTo("alexanderjameswarren", "gmail.com", "alfred@secorus.com");
  const h = [
    { Name: "Authentication-Results", Value: googleAr("stranger@other.example") },
    { Name: "Authentication-Results", Value: googleAr(forged) },
    { Name: "ARC-Authentication-Results", Value: googleAr(forged, 9) },
  ];
  assert.equal(p.googleForwardHop(h), null);
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
  reason: "sender_not_allowed",
  fromAddress: "alex.warren@other.example",
  captureAddress: "alfred@secorus.com",
  gmailLink: "https://mail.google.com/mail/u/?authuser=x#all/g1",
  gmailId: "g1",
};

test("notice: text, metadata, no messageId key", () => {
  const n = p.buildNotice(REJ, new Date("2026-10-13T21:00:00Z"));
  assert.equal(
    n.capturedText,
    "Email blocked from alex.warren@other.example: the sender is not on the list and it is not an approved auto-forward. " +
      "Open it in Gmail: https://mail.google.com/mail/u/?authuser=x#all/g1 (labelled forwarded/rejected; remove the label to check it again).",
  );
  assert.deepEqual(n.sourceMetadata, {
    rejected: true,
    reason: "sender_not_allowed",
    from_address: "alex.warren@other.example",
    gmail_link: REJ.gmailLink,
    gmail_id: "g1",
    notice_day: "2026-10-13",
    capture_address: "alfred@secorus.com",
  });
  assert.equal("messageId" in n.sourceMetadata, false);
});

test("notice: no link", () => {
  const n = p.buildNotice({ reason: "sender_not_allowed", fromAddress: "" }, new Date());
  assert.match(n.capturedText, /^Email blocked from \(no sender\): .* It is in your secorus Gmail inbox \(labelled forwarded\/rejected;/);
  assert.equal("gmail_link" in n.sourceMetadata, false);
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

test("alfred@ mapping still last", () => {
  assert.equal(p.findCaptureHit(["alex.warren+elise+alfred@secorus.com"]).mapping.label, "Elise");
  assert.equal(p.findCaptureHit(["alfred@secorus.com"]).mapping.label, "Alex");
  assert.equal(p.findCaptureHit(["recipes@secorus.com"]).mapping.captureAddress, "recipes");
  assert.equal(p.findCaptureHit(["someone@else.example"]), null);
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
    "-- \nThanks,\n\nAlex​",
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
