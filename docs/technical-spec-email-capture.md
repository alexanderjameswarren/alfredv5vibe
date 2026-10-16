# Email capture fixes — technical spec (email_capture-f4m)

Alfred record: intention mv46b90ch3dxe50ylsg.

## Flow

Gmail filter → Postmark inbound (`22edead6…@inbound.postmarkapp.com`) → Edge
Function `email-capture` (verify_jwt off) → `inbox` row, `source_type email`,
`ai_status not_started`. Enrichment is the hourly Claude task `inbox_enrich_hourly`
using the alfred-enrich skill, not ai-enrich.

## Gates, in order

1. **Webhook secret.** `?token=` in the Postmark webhook URL, compared in constant
   time with the `EMAIL_CAPTURE_SECRET` function secret. Wrong/missing → 401;
   secret not set → 500. Both make Postmark retry, so nothing is lost while
   config catches up.
2. **Sender** — see "Who gets in". Otherwise 200, no capture row, no retry, and
   a rejection notice in Alex's inbox.
3. **User.** A capture address (USER_MAPPINGS: the two plus-tags, recipes@,
   alfred@) decides the user, as before. Only when none matches does the
   forwarding account decide (D2).
4. **Dedupe** (step 4). Unique per user on the Postmark `MessageID`; the original
   `Message-ID` header is also stored and checked. A duplicate gets 200
   `duplicate`, so Postmark stops.

## Who gets in (step 5c, v22)

v21 trusted every caf_ forward. But every capture reaches Postmark through the
secorus account's own filter, so every mail carried `alex.warren+caf_…@secorus.com`
and a passing Postmark SPF line, and v21 accepted mail from anyone (proven with a
hand-forward from a non-allowlisted account, 2026-10-13).

Payload comparison (two hand-forwards vs input A): Return-Path, Postmark's SPF
line, one X-Forwarded-For (`alex.warren@secorus.com <postmark>`) and one
X-Forwarded-To at the same positions in all three. Cc empty, Bcc is Postmark.
The difference is Gmail's first `Delivered-To`: the capture address on a mail
sent to one, `alex.warren@secorus.com` on input A.

`decideCapture`, in order:

- **Any** `X-Forwarded-For` whose first address is not allowlisted → reject
  `forwarded_by_unknown_account` (a stranger's own Gmail rule forwarding in).
- **Rule 1.** A capture address in ToFull, To, CcFull, Cc, or Gmail's first
  `Delivered-To` (so Bcc counts) → accept if (a) the From is allowlisted, or
  (b) (step 5d, v23, option A) an `X-Forwarded-For` hop names an allowlisted
  account and forwards to that same capture address — an earlier Gmail rule,
  since the capture address's own hop forwards to Postmark. (b) rows carry
  `auto_forwarded: true`; the capture address still decides the user (D2).
  Else reject `capture_address_sender_not_allowed`.
- **Rule 1(b) fix, 2026-10-16 (email_capture_fix-r2w).** A real Amazon
  auto-forward (Alex's gmail → alfred@ → Postmark) was blocked: on the second
  forward Google **renames** the earlier hop's `X-Forwarded-For` to
  `X-X-Forwarded-For` (beside `X-Forwarded-To: alfred@secorus.com`), so only the
  secorus → Postmark hop kept the plain name. (b) now accepts either:
  1. **Preferred:** Google's results for the delivery into the capture mailbox —
     `Authentication-Results` / `ARC-Authentication-Results` with authserv-id
     `mx.google.com`, `spf=pass`, and `smtp.mailfrom` =
     `<allowlisted local>+caf_=<capture local>=<capture domain>@<allowlisted domain>`
     whose capture address is the one rule 1 hit. Why preferred: Google writes it
     from the connecting IP, only Google's servers pass SPF for gmail.com, and
     Gmail builds the +caf_ envelope from the forwarding account and target, so a
     stranger's mail cannot produce it. Only results headers down to the first
     `Authentication-Results` are read: Google prepends its own, so a copy written
     by the sender sits lower and is ignored (`googleForwardHop`).
  2. A forwarding header under any number of `X-` prefixes (`X-Forwarded-For`,
     `X-X-Forwarded-For`, …) naming an allowlisted account and that capture
     address — still the option A decided risk below.
  The stranger check (first bullet) reads renamed headers too. Elise's
  `enhdesigns+caf_=recipes=secorus.com@gmail.com` works the same way.
- **Decided risk, 2026-10-13:** rule 1(b) trusts an X-Forwarded-For header that
  a stranger could write into their own message, so a stranger who knows an
  allowlisted address and a capture address can get a row in. Alex accepted
  this to allow Gmail rules forwarding into alfred@ and recipes@.
- **Rule 2.** Otherwise a trusted auto-forward (below) → the forwarding
  account's user. Else `sender_not_allowed:<why>` or `no_mapping`.

Still not caught: a forged From of an allowlisted address sent to a capture
address. The payloads show Google's own `Authentication-Results` (dkim/spf
for the From domain) at a fixed position, so a From-authentication check is
possible later; not built.

## Rejection notices (step 5c)

Every rejection after the secret check also writes one inbox row for Alex:
`source_type email`, `captured_text` "Email blocked from <from>: <reason>. View
it in Postmark: https://account.postmarkapp.com/servers/18272581/streams/inbound/messages/<MessageID>
(also still in your secorus Gmail inbox)." — never the subject or body.
`source_metadata`: `rejected: true`, `reason`, `from_address`, `capture_address`
(if any), `postmark_message_id`, `notice_day` (Pacific). No `messageId` key, so
the dedupe index never sees a notice. At most one per `from_address` per Pacific
day; later ones only log. Switch: function secret `EMAIL_CAPTURE_NOTICES=off`
turns them off; unset or anything else is on. A failed notice is logged and
never changes the 200.

## Trusted auto-forward (step 5)

Built against a real dropped payload (Idealist alert, 2026-10-07). Gmail keeps
the original From and To; the forwarding account shows only in the envelope.

Trust a mail as forwarded by account `<local>@<domain>` only when all hold:

- `Return-Path` is `<local>+caf_=<postmark local>=inbound.postmarkapp.com@<domain>`
  and `<local>@<domain>` is on FROM_ALLOWLIST.
- The **first** `Received-SPF` in `Headers` is Postmark's: it carries
  `receiver=p-pm-inbound…` and `identity=mailfrom`, starts `pass (<domain>:`, and
  its `envelope-from` equals the Return-Path address.
- No later `Received-SPF` also claims a `receiver=p-pm-inbound…`. Postmark writes
  its own above everything the sender supplied, so a second one is an injection:
  refuse. Google's own lower line (`pass (google.com: …`, no Postmark receiver)
  is ignored.

Why a stranger can't forge it: the endpoint now needs the secret, so only
Postmark can post; Postmark computes SPF from the connecting IP, and only
Google's servers pass SPF for gmail.com/secorus.com; Gmail sets the +caf_
envelope from the forwarding account itself, so a stranger's Gmail produces their
own address. X-Forwarded-For/To are cross-checks only, never trusted alone.

What still gets through: anything the account's own Gmail filters forward
(a lookalike that matches a filter). If the check is wrong, the exposure is one
junk row, the same as a forged From before the secret.

Forwarder → user: alex.warren@secorus.com and alexanderjameswarren@gmail.com →
Alex; enhdesigns@gmail.com (Return-Path `enhdesigns+caf_=…@gmail.com`) → Elise.

Built in step 5 as `checkAutoForward` / `decideCapture` in parse.ts. If an
X-Forwarded-For is present, its first address must be the forwarding account.
Rows accepted via a forward carry
`source_metadata.auto_forwarded: true`. Every rejection logs one line,
`Rejected: <reason> (domain <d>)`, e.g. `sender_not_allowed:forwarder_not_allowed`
or `sender_not_allowed:spf_not_pass` — no content, no full addresses.

## Dedupe (step 4)

- Partial unique index on `inbox (user_id, (source_metadata->>'messageId'))
  where source_type = 'email'`. Rows with no messageId (5 exist) are not indexed:
  a null expression never conflicts. Input B showed no clashes, so no cleanup.
- Insert error 23505 → 200 `{ duplicate: true }`; two deliveries at the same
  moment resolve in the index.
- `source_metadata.original_message_id` from the `Message-ID` header; the code
  checks it per user before insert. It catches the same mail auto-forwarded
  twice. Hand re-forwards get a new Message-ID and stay allowed (D3).

## Captured text (step 3)

`parse.ts`, pure and tested under `node --test`.

- Name: every leading `Fwd:`/`FW:`/`Fw:`/`Re:` stripped, stacked ones too.
  `source_metadata.subject` keeps the raw subject.
- Body: Gmail's "Forwarded message" block is removed and its From/Date/Subject/
  To/Cc go to `source_metadata.original_from/_date/_subject/_to/_cc` (wrapped
  lines rejoined). `>` quote markers stripped (D4). The trailing signature
  `-- / Thanks, / Alex` is stripped only at the very end. Nothing else.
- Change from before: a `From:`/`Date:` line outside a forwarded block is no
  longer deleted.

## Unchanged

USER_MAPPINGS and its order, `capture_address: recipes`, Elise's plus-tag, the
200-no-row answer for unknown senders, `ai_status not_started`.
