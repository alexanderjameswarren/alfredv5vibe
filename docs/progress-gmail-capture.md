# Gmail capture — progress (gmail_capture-h3w)

Spec: docs/technical-spec-gmail-capture.md.

| Step | What | DB items | Status |
|---|---|---|---|
| 1 | Plan, claims check | — | done 2026-10-29 |
| 2 | Claim; spec and progress docs | — | done 2026-10-29 |
| 3 | Gmail recon: self-forward fires filter a; alfred+jobs@ delivered; save 4–6 "Show original" headers to .scratch/ | — | done 2026-10-29; 5 raw messages in .scratch/gmail_capture-h3w/ (job-board skipped) |
| 4 | Migration `email_capture_senders` + seed; conformance | db:table:email_capture_senders | 185 written 2026-10-29; drift check: gitsync brought nothing (main = origin/main 010453b); awaiting Alex's run |
| 5 | Function Gmail branch (gmail.ts), tests, deploy, dry run | db:deploy | part 1 (code, tests) done 2026-10-29: gmail 22/22, parse 57/57, deno check clean; migration 185 checkpointed (ef98e9d). Part 2 done 2026-10-29: drift check clean (sync brought only the 185 snapshot); GMAIL_CAPTURE_SECRET set; v27 deployed 18:39 UTC; live dry runs: Life Time captured via forward, alfred+jobs captured (jobs), stranger rejected, wrong secret 401, Postmark no-token 401; nothing inserted |
| 6 | Apps Script, tests, clasp setup and push, dry run on real forwards | — | |
| 7 | Cutover: rename labels, filters, START_DATE, trigger | — | |
| 8 | Postmark removal: forwarding address, Postmark branch, redeploy | db:deploy | |
| 9 | Finish (gitpush Finish) | — | |

## Decisions (2026-10-29)

- D1 Rejected marker: `forwarded/rejected`; search excludes `label:forwarded` and `label:forwarded-rejected`.
- D2 Elise: enhdesigns@gmail.com only, safe sender and approved forwarder.
- D3 New table `email_capture_senders`, not `allowed_emails`.
- D4 clasp. One-time setup (clasp login as alex.warren@secorus.com, Apps Script API on) listed as to-dos at step 6.
- D5 alfred@ and recipes@ are aliases of alex.warren@; alfred@, recipes@, alex.warren+alfred@ treated alike, recipes kept separable.
- D6 Filters a and b as in the spec; plus-tag filters are new.
- D7 Interval 5 minutes. Trust decided in the function, not the script.

## Findings

- alex.warren+elise+alfred@ is still in USER_MAPPINGS (→ Elise's user) but no filter catches it.
- Step 3 recon (headers only):
  - Self-forward secorus → alfred@: one message, SENT + `forwarded`, no INBOX (Alex's
    screenshot). Raw has no Delivered-To, Received or Authentication-Results. Trusted
    only by the SENT rule; the script must not look at INBOX.
  - gmail.com → alfred+jobs@: delivered; To and Delivered-To are both
    `alfred+jobs@secorus.com`. AR: dkim=pass @gmail.com, dmarc=pass header.from=gmail.com.
    USER_MAPPINGS does not match it today: alfred+<tag> mapping added to step 5.
  - gmail.com hand forward (sent to alex.warren+alfred@): Delivered-To matches; AR
    dkim=pass, spf=pass, dmarc=pass header.from=gmail.com; `dara=fail` (ignore). Safe-sender rule accepts.
  - gmail.com auto-forward (Life Time): Return-Path and AR smtp.mailfrom
    `alexanderjameswarren+caf_=alfred=secorus.com@gmail.com`, spf=pass; topmost
    ARC-AR i=3 carries the same. X-Forwarded-For `alexanderjameswarren@gmail.com
    alfred@secorus.com`, X-Forwarded-To `alfred@secorus.com`, not renamed (no Postmark
    hop). googleForwardHop → account alexanderjameswarren@gmail.com, to alfred@secorus.com.
  - Step 5 dry runs with the real Message-IDs answered `duplicate (original_message_id)`:
    the Life Time mail and GCAP3 B had already come in through Postmark. So filter a
    also catches alfred+jobs@ (plus-tag mail will carry `alfred` and `alfred/jobs`;
    routing takes the child label), and Postmark-era dedupe works.
  - Elise (2026-10-27, hand forward to alfred@): AR dkim=pass @gmail.com, spf=pass
    enhdesigns@gmail.com, dmarc=pass header.from=gmail.com. Safe-sender rule accepts. No
    Elise auto-forward sample; that path is the same code as the Life Time one.
