# Email capture fixes — progress (email_capture-f4m)

Spec: docs/technical-spec-email-capture.md.

| Step | What | Status |
|---|---|---|
| 1 | Plan, claims, docs | done 2026-10-13 |
| 2 | Postmark payload (input A) + diag query (input B) | done 2026-10-13 |
| 3 | Text clean-up + webhook secret (parse.ts, index.ts, config.toml comment) | v18 18:25 UTC; test failed on row 59ecd744 (forward of a forward: second signature and inner block left in, outer block's headers recorded). Fixed: signature stripped repeatedly and tolerantly, every block's headers removed, innermost block → original_*. v19 deployed 18:41 UTC (verify_jwt false, no-token → 401); awaiting retest |
| 4 | Dedupe index + 23505 handling + original_message_id | – |
| 5 | Trusted auto-forward acceptance, forwarder → user | – |
| 6 | Finish (gitpush Finish) | – |

## Decisions

- D1 webhook secret: yes.
- D2 capture address decides the user; forwarding account only when none matches.
- D3 hand re-forwards allowed; only MessageID and original_message_id dedupe.
- D4 keep stripping `>` quote markers.

## Findings

- Enrichment: not a bug. The hourly task reads email rows and skips job alerts by
  design (`skipped_jobs: 3`); all 5 email rows since 10-10 are job-related. The
  schedule's `notes` still say "typed captures (source_type manual)" — stale.
- Input B: no Postmark MessageID clashes; 5 email rows lack messageId; inbox
  indexes are only inbox_pkey, idx_inbox_archived, idx_inbox_user.
- db:deploy was held by warren_buffet_p2-m4t at plan time (2026-10-13); free and
  claimed by this thread for the step 3 deploy, held until the Checkpoint.
- Step 3 drift check: gitsync to 9b5dfb7 brought only Warren Buffet step 8a
  (mcp, wb tools, migrations 124–125); nothing touches email-capture or inbox.
- EMAIL_CAPTURE_SECRET is set; the Postmark webhook URL carries `?token=`.
