# Gmail capture (Apps Script)

Runs in alex.warren@secorus.com every 5 minutes. Finds mail labelled `alfred` or
`alfred/<child>` (not `forwarded`, not `forwarded/rejected`, after `START_DATE`),
posts each message to the `email-capture` Edge Function, then labels it:
`forwarded` (captured or duplicate) or `forwarded/rejected` (+ unread, + inbox).
Anything else (5xx, network) changes nothing and is retried next run.

Spec: docs/technical-spec-gmail-capture.md.

## Files

- `Code.js` — Gmail advanced service, UrlFetch, labels, triggers.
- `lib.js` — pure logic; `lib.test.mjs` runs it under `node --test`.
- `appsscript.json` — Gmail advanced service, scopes, America/Los_Angeles.
- `.clasp.json` — script id only. `.claspignore` pushes the three files above.

## Script Properties

| Property | Value |
|---|---|
| `CAPTURE_URL` | `https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/email-capture` |
| `CAPTURE_SECRET` | same value as the `GMAIL_CAPTURE_SECRET` function secret |
| `START_DATE` | ISO date-time; mail before it is ignored |
| `DRY_RUN` | `true`: send `dry_run`, change no labels |
| `TEST_QUERY` | optional, `dryRun()` only: a Gmail query to try instead of the real one |

## Entry points

- `run` — the trigger target.
- `dryRun` — always a dry run; logs each verdict.
- `installTrigger` / `removeTrigger` — the 5-minute trigger.

## Deploy

From this folder: `npx @google/clasp@2.4.2 push`.
