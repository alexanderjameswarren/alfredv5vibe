# Technical spec: standalone reminders

Owner thread: `rem-j7p`. Progress: [progress-reminders.md](progress-reminders.md).

## Why

Push notifications already work, but only as `notification_steps` chains inside
an execution (`execution_id` is NOT NULL). This adds **standalone reminders**: a
one-off notification at a fixed time, which Claude can create through MCP.

Android suppresses notifications and makes them too easy to dismiss, so **every
reminder is backed by something visible in Alfred**: an inbox item or an
intention.

## Decision: a separate table, not notification_steps

`notification_steps` is shaped like a chain: `seq`, an offset from the element
before it, and a `waiting` state. A one-off reminder has none of that. Do not
loosen `notification_steps`. Add a new table, `reminders`. The existing
one-minute dispatcher reads both tables.

## Table: public.reminders

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | default gen_random_uuid() |
| user_id | uuid not null | default auth.uid(), references auth.users |
| text | text not null | Notification body. Copied when the reminder is created, so it still fires if the linked row changes or disappears. |
| due_at | timestamptz not null | Absolute time to fire. |
| state | text not null | default 'scheduled'; one of scheduled, sent, cancelled, no_subscription. Same meanings as in notification_steps. |
| cancel_reason | text null | One of manual, inbox_discarded. Null unless state is cancelled. |
| sent_at | timestamptz null | Set on delivery. Together with state 'sent', it stops the reminder firing again. |
| inbox_id | text null | FK to inbox(id) **on delete set null**, the same as `source_inbox_id` on items, intents and events (068). |
| intent_id | text null | No FK, matching the legacy text ids. |
| created_by | text not null | default 'app'; one of app, claude. |
| created_at, updated_at | timestamptz | default now(). A BEFORE UPDATE trigger stamps updated_at. |

- Check: no more than one of `inbox_id` and `intent_id` is set.
- Check: `cancel_reason` is null unless `state = 'cancelled'`.
- Indexes: `(state, due_at)` for the dispatcher, plus partial indexes on `inbox_id` and `intent_id` for the app's lookups.
- COMMENT on the table and on every column.
- The migration ends with `platform.register_table('public.reminders', p_policy_mode => 'owner', …)`.

### Inbox rows are archived, not deleted

Triage archives with 'processed' (Clipboard Step 14). The trash can archives
with 'discarded'. So an inbox row outlives its processing, which is why
`inbox_id` gets a real foreign key.

## Function: public.create_reminder

`create_reminder(p_text, p_due_at, p_inbox_id, p_intent_id, p_created_by)` returns the new `reminders` row.

- SECURITY INVOKER, so RLS and the audit actor (the `x-actor` header) apply.
  Execute is granted to `authenticated` only.
- It rejects:
  - an empty text
  - a null or past due_at
  - both links set at once
  - a link to an inbox row or intention the caller cannot see
  - a call with no signed-in user
- If no link is given, it inserts an inbox row in the same transaction:
  - `id = gen_random_uuid()::text`
  - `captured_text = text`
  - `source_type` is 'mcp' when the creator is claude, and 'manual' otherwise
- A timestamp given without a UTC offset is rejected in the tool rather than in
  SQL, because Postgres would silently read it in the session time zone.

## Dispatcher: notify-dispatch

- Extend the existing one-minute sender.
- It picks up reminders where `state = 'scheduled'` and `due_at <= now()`.
- It sends each one to that user's `push_subscriptions`, then marks it:
  - 'sent', with `sent_at`, when a device took it
  - 'no_subscription' when the user has no subscription
- The update runs only from 'scheduled', the same guard the steps use.
- The reminders have their own cap per run, so they cannot crowd out steps.
- Where a tap on the notification goes:
  - with `intent_id` set: `intentionDetailPath(intent_id)`
  - otherwise with `inbox_id` set: `inboxDetailPath(inbox_id)`
  - otherwise: `/inbox`
- Both path helpers are imported from `src/viewPaths.js`.

## Intention deep link

Add an `/intentions/detail/:id` route (`intentionDetailPath` and
`intentionIdFromPath`) to `src/viewPaths.js`, and make `src/Alfred.jsx` open the
intention when the app loads cold on that path. The existing inbox detail route
is the model to follow.

## MCP tools

All three use `defineTool`, reach the database only through `ctx.db`, and return
bare data.

- **create_reminder**, tier 1.
  - Params: `text` (required); `due_at` (required, ISO 8601 **with** an offset;
    reject a time with no offset and reject a time in the past); optional
    `inbox_id` or `intent_id`, but not both.
  - Calls the database function with created_by 'claude'. With no link, the
    function creates the backing inbox item.
  - Returns the reminder, including `inbox_id` or `intent_id`.
  - The description says Alex is in America/Los_Angeles.
- **get_reminders**, tier 1.
  - Default: state 'scheduled', soonest first.
  - Optional filters: `state` (one of the four states, or `all`), `inbox_id`,
    `intent_id`. Any state other than scheduled sorts most recent first.
  - `clampLimit`.
- **update_reminder**, tier 2, by id.
  - Change `text`.
  - Change `due_at`. This goes through the same validation as create, sets
    state back to 'scheduled', and clears `sent_at` and `cancel_reason`.
  - Or cancel: state 'cancelled', cancel_reason 'manual'.

## App changes

- **Processing into an intention:** move the item's reminders over (set
  intent_id, clear inbox_id).
- **Processing into anything else:** leave the reminders firing, with inbox_id
  kept, because the row still exists.
- **Discarding** (the trash can, archive_reason 'discarded'): cancel the item's
  scheduled reminders with cancel_reason 'inbox_discarded'.
- **Reversing a discard** (Undo, or Put back in Recently archived): restore to
  'scheduled' the reminders with cancel_reason 'inbox_discarded' whose due_at
  is still in the future, and clear cancel_reason.
- **Inbox detail and intention detail** show the pending reminder time, in
  Pacific time.
