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
2. **Sender.** Accepted if the From is on FROM_ALLOWLIST, or (step 5) the mail is a
   trusted Gmail auto-forward by an allowlisted account. Otherwise 200, no row,
   no retry.
3. **User.** A To address matching a capture address (USER_MAPPINGS: the two
   plus-tags, recipes@, alfred@) decides the user, as before. Only when none
   matches does the forwarding account decide (D2).
4. **Dedupe** (step 4). Unique per user on the Postmark `MessageID`; the original
   `Message-ID` header is also stored and checked. A duplicate gets 200
   `duplicate`, so Postmark stops.

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
