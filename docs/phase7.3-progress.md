# Phase 7.3 Progress: Email Capture (Postmark)

**Started**: 2026-02-21
**Last Updated**: 2026-02-21
**Status**: 🟡 In Progress

---

## Steps

| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Postmark account + inbound settings configured | ✅ Complete | Webhook URL set, approval pending |
| 2 | Secorus forwarding rules configured | ✅ Complete | +alfred and +elise+alfred forward to Postmark |
| 3 | Create email-capture Edge Function | ⬜ Not Started | Claude CLI |
| 4 | Deploy email-capture function | ⬜ Not Started | Terminal command |
| 5 | Test with Postmark Check button | ⬜ Not Started | Verify webhook receives test payload |
| 6 | Test end-to-end: forward email → inbox record | ⬜ Not Started | Manual test |

---

## Notes & Decisions

- Inbound only — no Postmark approval needed for receiving, but submitted approval anyway for future use
- User mapping: To address prefix determines user (alex.warren+alfred@ = Alex, alex.warren+elise+alfred@ = Elise)
- ai-enrich NOT auto-triggered — user clicks Enrich button manually from inbox UI
- No raw email content in webhook payload — parsed JSON is sufficient
- captured_text = Subject + TextBody (stripped of forwarding cruft)
- source_metadata stores: from, subject, messageId, date, originalRecipient
