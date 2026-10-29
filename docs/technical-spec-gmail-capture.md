# Gmail capture — technical spec (gmail_capture-h3w)

Replaces the Postmark inbound integration (free tier 100/month; ~300 expected) with
a Google Apps Script in alex.warren@secorus.com that posts labelled mail to the
existing `email-capture` Edge Function. Earlier design: docs/technical-spec-email-capture.md.
Progress: docs/progress-gmail-capture.md.

## Flow

Gmail filter (or Alex by hand) applies `alfred` / `alfred/<app>` → Apps Script, every
5 minutes → `email-capture` (Gmail branch) → `inbox` row → script labels the message
`forwarded` (captured) or `forwarded/rejected` (rejected).

## Addresses

alfred@secorus.com and recipes@secorus.com are **aliases** of alex.warren@secorus.com.
Capture addresses: alfred@, recipes@, alex.warren+alfred@, alex.warren+elise+alfred@,
and any alfred+<tag>@. Plus tags on the alias are delivered (step 3: To and
Delivered-To both show `alfred+jobs@secorus.com`). USER_MAPPINGS today has no
alfred+<tag>@ entry (`/alfred@secorus\.com/` does not match it), so step 5 adds
`/alfred\+[^@]+@secorus\.com/i` → Alex, above the catch-all. When no `alfred/<child>`
label is present, the plus tag sets the app through the same map.
alfred@, recipes@ and alex.warren+alfred@ are treated alike;
recipes@ keeps its `capture_address: recipes` metadata so it can get its own handling
later (one entry in USER_MAPPINGS). alex.warren+elise+alfred@ is still in USER_MAPPINGS
(routes to Elise's user), but no current filter catches it.

## Labels

| Label | Meaning | Set by |
|---|---|---|
| `alfred` | send to Alfred, no app | filters, Alex |
| `alfred/<app>` | send to Alfred, sets `inbox.source_app` | filters, Alex |
| `forwarded` | captured (or duplicate); never check again | script |
| `forwarded/rejected` | rejected; left unread in the inbox | script |

- App map: `jobs` → `jobs`, `wb` → `warren_buffet`, `arnold` → `arnold`. `source_app`
  has a foreign key to `apps`, so an unmapped child sets no app (the label is still
  recorded).
- Search, rebuilt each run: `after:<START_DATE> -label:forwarded -label:forwarded-rejected
  {label:alfred label:alfred-<child> …}`, the children being every label whose name
  starts `alfred/`. Gmail's `label:x` does not include children, so both exclusions
  are needed. Removing `forwarded/rejected` makes the script check a message again.
- Never `in:inbox`: a self-forward never reaches the inbox (step 3). Label search
  finds it in Sent. No fallback search: filter a fired on the self-forward.
- `forwarded/rejected` is created by the script, only after the cutover rename,
  otherwise the rename would move it to `alfred/rejected` and the search would pick it up.

## Apps Script (`apps-script/gmail-capture/`)

- Pushed with clasp (`.clasp.json` holds the script id only). `lib.js` holds the pure
  logic and is tested under `node --test`; `Code.js` is the Gmail and UrlFetch glue.
- Message level through the Gmail advanced service, not GmailApp threads (GmailApp
  labels whole threads).
- Sent copy (step 3): a self-forward to an alias is ONE message, labelled SENT and
  `forwarded`, with no INBOX, no Delivered-To, no Received and no
  Authentication-Results. It is the only copy, so it is captured. Never filter on
  INBOX. Dedupe by Gmail id, and by RFC Message-ID within a run.
- Raw headers are unfolded (continuation lines joined) before posting.
- Script Properties: `CAPTURE_URL`, `CAPTURE_SECRET`, `START_DATE`, `DRY_RUN` (`true`:
  send dry_run, change no labels), `TEST_QUERY` (optional, `dryRun()` only). Never in code.
- Reads each message with `Messages.get(format: full)`: headers come unfolded from the
  API; body is the first text/plain part, else text/html stripped; at most 40 per run;
  a script lock stops overlapping runs. Scopes: gmail.modify, external_request, scriptapp.
- Trigger: time-based, every 5 minutes.
- Per verdict: `captured` / `duplicate` → add `forwarded`. `rejected` → add
  `forwarded/rejected`, add UNREAD and INBOX (filter a marks read). 5xx or network error → nothing,
  retried next run.
- `dryRun()` posts with `dry_run: true` and logs decisions without inserting.

## Payload (Gmail branch)

POST with header `x-capture-secret` (function secret `GMAIL_CAPTURE_SECRET`):
`source: "gmail-script"`, `gmail_id`, `thread_id`, `gmail_link`, `label_ids`,
`labels` (names), `sent` (bool), `headers` (`[{Name, Value}]`, in order: From, To, Cc,
Date, Subject, Message-ID, Delivered-To, Return-Path, Authentication-Results,
ARC-Authentication-Results, X-Forwarded-For/To and renamed X-…-Forwarded-*),
`text_body`, `attachments` (`[{name, type, size}]`, never content), `dry_run`.

Answer: `{ status: "captured" | "duplicate" | "rejected", reason?, inbox_id? }`, 200
for all three. Rejection reasons: `forwarded_by_unknown_account`, `sender_not_authenticated`
(on the list, Google's checks failed), `sender_not_allowed`. Duplicate reasons: `gmail_id`,
`original_message_id`. A dry run answers the same, plus `via`, `forwarder`, `source_app`
and a text preview, and writes nothing (no row, no notice). 401 wrong secret; 500 secret
unset, senders unreadable, user unmapped or insert failed (the script retries); 400 bad body.
Code: `supabase/functions/email-capture/gmail.ts` (pure), `index.ts` `handleGmail`.

## Edge Function changes

- Branch by auth: `x-capture-secret` → Gmail branch; `?token=` → Postmark branch,
  unchanged until removal.
- Trust (`gmail.ts`, pure, tested):
  1. No capture address in To/Cc/Delivered-To → trusted (only Alex can label).
  2. `sent` (SENT in the Gmail API label ids) → trusted. A self-forward carries no
     authentication headers at all, so this rule is its only way in.
  3. Any X-Forwarded-For (renamed too) naming a non-approved forwarder → reject.
  4. From is a safe sender and the first `Authentication-Results` with authserv-id
     `mx.google.com` shows `dmarc=pass` with `header.from` = the From domain (else
     `dkim=pass` with `header.i`/`header.d` aligned) → accept. `dara=` is ignored (it
     read `fail` on a passing hand forward). No such header and not SENT → reject.
  5. Auto-forward by an approved forwarder: `googleForwardHop` (spf=pass `+caf_`
     mailfrom into that capture address) or an X-Forwarded-For hop into it → accept.
  6. Else reject; a rejection notice links to Gmail instead of Postmark.
- Senders come from `email_capture_senders`, not the hard-coded lists.
- User: USER_MAPPINGS as now (capture address decides; D2).
- Dedup: `source_metadata.messageId` = Gmail id (the migration 126 unique index covers
  it, no inbox change); `original_message_id` check as now catches mail already captured
  through Postmark.
- Metadata: from, fromName, forwarder, date, subject, labels, attachments, auth results
  (dmarc/dkim/spf), gmail_link, capture_address, auto_forwarded, original_*.

## Table `email_capture_senders`

New, not `allowed_emails`: a row there grants Alfred sign-in and the table is exempt
shared reference data; a forwarder must never get a login, and senders need two roles.

Columns: `id`, `user_id` (owner), `email` (unique, lower-case), `safe_sender`,
`approved_forwarder`, `label`, `notes`, timestamps. `register_table` (owner policy),
explicit grants, no anon, `check_platform_conformance`.

Seed: alex.warren@secorus.com, alexanderjameswarren@gmail.com, enhdesigns@gmail.com
(Elise) — each safe sender and approved forwarder.

## Elise

enhdesigns@gmail.com only. Hand forwards pass as a safe sender; auto-forwards as an
approved forwarder. Her auto-forward confirmation code to alfred@ will be rejected and
left unread; that is expected.

## Cutover order

1. Step 3 recon (done): filter a fires on a self-forward; alfred+jobs@ is delivered.
2. Migration run; conformance.
3. Function deployed with the Gmail branch; Postmark still live.
4. Script pushed; Script Properties set; dry run on real forwards (hand and auto).
5. Rename `forwarded` → `alfred` (forwarded/jobs etc. move to alfred/…). Filters a and
   b now say `alfred`.
6. Filter b: change to `alfred/jobs` explicitly. Filters a and b: drop the Postmark forward.
7. New plus-tag filters.
8. START_DATE = cutover time; trigger on. Script creates `forwarded` and
   `forwarded/rejected`.
9. Watch a few days.
10. Remove the Postmark forwarding address in secorus settings.
11. Remove the Postmark branch, `?token=`, `EMAIL_CAPTURE_SECRET` and hard-coded lists;
    redeploy.
12. Delete the Postmark inbound server.

## Filter checklist

**Secorus (alex.warren@secorus.com)**

| Filter | Match | Action after cutover |
|---|---|---|
| a | `{to:alfred@secorus.com to:recipes@secorus.com to:alex.warren+alfred@secorus.com deliveredto:alfred@secorus.com deliveredto:recipes@secorus.com}` | mark as read, apply `alfred`; **no forward** |
| b | `{idealist.org alerts@jobs.80000hours.org team@probablygood.org jobalerts-noreply@linkedin.com eaopportunitiesboard@centreforeffectivealtruism.org}` | apply `alfred/jobs` (set explicitly: the rename leaves it `alfred`); **no forward** |
| new | `to:alfred+jobs@secorus.com` | apply `alfred/jobs`, never send to Spam |
| new | `to:alfred+wb@secorus.com` | apply `alfred/wb`, never send to Spam |
| new | `to:alfred+arnold@secorus.com` | apply `alfred/arnold`, never send to Spam |
| optional | `to:alex.warren+elise+alfred@secorus.com` | apply `alfred` (code maps it to Elise; nothing catches it today) |

Settings → Forwarding: remove the Postmark address at step 10.

**Personal gmail.com (alexanderjameswarren@gmail.com)**

- Auto-forward filters to alfred@secorus.com: unchanged.
- No filter forwards straight to Postmark; change any that does to alfred@.
- alfred@secorus.com stays a verified forwarding address.
